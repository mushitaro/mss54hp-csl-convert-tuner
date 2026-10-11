/** Actual production Tune replay. Reads private D1 export; never flashes a car. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { build } from 'esbuild';
const root=path.resolve(import.meta.dirname,'..');
const directory=path.resolve(process.argv[2]??'');
if(!process.argv[2])throw new Error('Usage: node scripts/analyze-moving-response-tune.mjs <D1-session-directory>');
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
const bundle=await build({stdin:{contents:`export * from './src/lib/ve-calculator/movingResponseTune';
 export * from './src/lib/ve-calculator/movingResponseInputs';
 export * from './src/lib/ve-calculator/egtTables';
 export * from './src/lib/ve-calculator/operatingPolicy';
 export { BinaryParser } from './src/lib/binary-engine/parser';`,resolveDir:root,loader:'ts'},
 bundle:true,platform:'node',format:'esm',write:false,alias:{'@':path.join(root,'src')}});
const m=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const bytes=fs.readFileSync(path.join(derived,'recorded-flash.bin'));
const buffer=bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);
const movingCalibration=m.readMovingResponseCalibration(buffer);assert(movingCalibration);
const map={xAxis:maps.rpm,yAxis:maps.load,data:maps.baseline};
const options={veCorrectionPolicy:'moving-response',veLearningRate:1,movingCalibration,
    egt:m.readEgtTables(buffer),steadyCalibrationHold:m.operatingCalibrationHold(buffer),
    steadyLambdaLimits:new m.BinaryParser(buffer).readLambdaLimits()};
const begin=performance.now();
const {result,diagnostics}=m.calculateMovingResponseDetails(map,source,options);
const elapsedMs=performance.now()-begin;
const r=map.yAxis.indexOf(7.5),c=map.xAxis.indexOf(2400);
const accepted=[];
for(let y=0;y<map.yAxis.length;y++)for(let x=0;x<map.xAxis.length;x++)if(result.acceptedMap[y][x])accepted.push({
    rpm:map.xAxis[x],load:map.yAxis[y],before:map.data[y][x],after:result.newMap.data[y][x],
    percent:(result.correctionMap[y][x]-1)*100,observations:result.hitMap[y][x],
    passes:diagnostics.fit.cells[y*map.xAxis.length+x].passes});
const target={rpm:2400,load:7.5,before:map.data[r][c],after:result.newMap?.data[r][c]??map.data[r][c],
    percent:(result.correctionMap[r][c]-1)*100,observations:result.hitMap[r][c],
    cell:diagnostics.fit?.cells[r*map.xAxis.length+c],reverted:diagnostics.revertedCells.includes(r*map.xAxis.length+c)};
const output={session:proof.session,logSha256:maps.logFileSha256,recordingSha256:proof.recordedCalibration.sha256,
    elapsedMs,target,accepted,coverage:result.coverage,audit:result.newMap?.movingResponseAudit,
    diagnostics,result,sourceHashes:Object.fromEntries(['movingResponseTune','movingResponseHistory','movingResponsePlan','movingResponseFit','movingResponseInputs','movingResponseSensor'].map(name=>[name,hash(path.join(root,'src/lib/ve-calculator',name+'.ts'))]))};
const out=path.join(root,'archive/moving-response-tune',path.basename(directory));fs.mkdirSync(out,{recursive:true});
fs.writeFileSync(path.join(out,'analysis.json'),JSON.stringify(output,null,2));
console.log(JSON.stringify({...output,result:undefined,diagnostics:{...diagnostics,fit:undefined,
    auditFailures:diagnostics.auditFailures.length}},null,2));
