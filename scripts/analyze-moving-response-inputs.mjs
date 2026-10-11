/** Replay the browser's input path against separately captured injection STFT. No ECU/BIN output. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { build } from 'esbuild';
const root=path.resolve(import.meta.dirname,'..');
const directory=path.resolve(process.argv[2]??'');
if(!process.argv[2])throw new Error('Usage: node scripts/analyze-moving-response-inputs.mjs <D1-session-directory>');
const derived=path.join(root,'archive/dme-response-flash-context',path.basename(directory));
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const maps=read(path.join(derived,'maps.json')),points=read(path.join(derived,'points.json'));
const proof=read(path.join(derived,'analysis.json')),raw=read(path.join(directory,'log.json'));
assert.equal(hash(path.join(directory,'log.json')),maps.logFileSha256);
assert.equal(hash(path.join(directory,'base.bin')),maps.baseSha256);
assert.equal(hash(path.join(derived,'recorded-flash.bin')),proof.recordedCalibration.sha256);
assert.equal(points.length,raw.length);
const source=raw.map((r,i)=>{assert.equal(r.time,points[i].time);assert.equal(r.rpm,points[i].rpm);return {...r,correctedLoad:points[i].load};});
const bundle=await build({stdin:{contents:`export * from './src/lib/ve-calculator/movingResponseInputs';`,resolveDir:root,loader:'ts'},
    bundle:true,platform:'node',format:'esm',write:false,alias:{'@':path.join(root,'src')}});
const m=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const bytes=fs.readFileSync(path.join(derived,'recorded-flash.bin'));
const calibration=m.readMovingResponseCalibration(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));
assert(calibration);
const frames=m.prepareMovingResponseInputs({xAxis:maps.rpm,yAxis:maps.load,data:maps.baseline},source,{calibration});
const reasons={},checks=[],outside=[];
for(const f of frames){
    reasons[f.evidenceReason]=(reasons[f.evidenceReason]??0)+1;
    if(!f.injection)continue;
    for(const bank of [0,1]){
        const range=m.reconstructMovingController(frames,f.injection.window,bank,calibration,{segment:f.segment});
        if(!range)continue;
        const actual=f.injection.trim[bank],violation=Math.max(0,range.lower-actual,actual-range.upper);
        const row={index:f.index,bank:bank+1,actual,...range,width:range.upper-range.lower,violation};
        checks.push(row);if(violation>1e-12)outside.push(row);
    }
}
const widths=checks.map(r=>r.width).sort((a,b)=>a-b);
const result={session:proof.session,logSha256:maps.logFileSha256,recordingSha256:proof.recordedCalibration.sha256,
    sourceSha256:hash(path.join(root,'src/lib/ve-calculator/movingResponseInputs.ts')),gains:calibration.gains,
    rows:frames.length,segments:new Set(frames.map(f=>f.segment)).size,reasons,
    injectionChecks:checks.length,outside:outside.length,maximumViolation:Math.max(0,...outside.map(r=>r.violation)),
    medianWidth:widths.length?widths[Math.floor(widths.length/2)]:null,focusChecks:checks.filter(r=>r.index>=2670&&r.index<=2686),violations:outside};
const out=path.join(root,'archive/moving-response-inputs');fs.mkdirSync(out,{recursive:true});
fs.writeFileSync(path.join(out,path.basename(directory)+'.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify({...result,focusChecks:undefined,violations:undefined},null,2));
