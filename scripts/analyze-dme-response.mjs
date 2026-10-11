/** Read-only comparison of actual application policies; private results, no BIN generation. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { build } from 'esbuild';
const root=path.resolve(import.meta.dirname,'..');
if(![3,5].includes(process.argv.length) || (process.argv.length===5 && process.argv[3]!=='--recorded-flash') || process.argv.includes('--help')) {
    console.log('Usage: node scripts/analyze-dme-response.mjs <exported-session-directory> [--recorded-flash <source-session-directory>]');
    process.exit(process.argv.includes('--help')?0:2);
}
const input=path.resolve(process.argv[2]), read=f=>JSON.parse(fs.readFileSync(path.join(input,f),'utf8'));
const session=read('session.json'), log=read('log.json'), raw=Array.isArray(log)?log:log.data;
if(!Array.isArray(raw) || raw.length!==session.logPointCount)throw new Error('Raw count differs from metadata.');
const binaries=fs.existsSync(path.join(input,'binaries.json'))?read('binaries.json'):{};
const base=binaries.base?Buffer.from(binaries.base,'base64'):fs.readFileSync(path.join(input,'base.bin'));
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
if(sha(base)!==session.baseSha256)throw new Error('BASE identity differs from metadata.');
if(fs.existsSync(path.join(input,'base.bin')) && sha(fs.readFileSync(path.join(input,'base.bin')))!==sha(base))throw new Error('BIN exports disagree.');
const bundle=await build({stdin:{contents:`
export * from './src/lib/ve-calculator/dmeResponse';
export * from './src/lib/ve-calculator/operatingEvidence';
export * from './src/lib/ve-calculator/operatingPolicy';
export { VECalculator } from './src/lib/ve-calculator/calculator';
export { BinaryParser } from './src/lib/binary-engine/parser';
export { readEgtTables } from './src/lib/ve-calculator/egtTables';
export { readRfPtKorrCurves } from './src/lib/ve-calculator/chargeTemp';
export { patchOnImage } from './src/lib/binary-engine/patcher';
export { processLogData } from './src/lib/log-engine/filter';`,resolveDir:root,loader:'ts'},
    bundle:true,platform:'node',format:'esm',write:false,alias:{'@':path.join(root,'src')}});
const m=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
let recordedBytes=base, recordedCalibration=null;
if(process.argv[4]) {
    const source=path.resolve(process.argv[4]);
    const prior=JSON.parse(fs.readFileSync(path.join(source,'session.json'),'utf8'));
    const sourceBase=fs.readFileSync(path.join(source,'base.bin'));
    if(sha(sourceBase)!==prior.baseSha256)throw new Error('Flash source BASE identity differs.');
    if(session.baseOrigin?.kind!=='dme' || prior.baseOrigin?.kind!=='dme' || !session.baseOrigin.vin || session.baseOrigin.vin!==prior.baseOrigin.vin)
        throw new Error('Historical flash requires the same recorded vehicle identity.');
    const flash=prior.flashHistory.filter(f=>f.practice===false && f.at<=session.createdAt).sort((a,b)=>b.at-a.at)[0];
    if(!flash || flash.tuned!==false)throw new Error('Expected an explicit real patch-only flash before this session.');
    recordedBytes=Buffer.from(m.patchOnImage(sourceBase.buffer.slice(sourceBase.byteOffset,sourceBase.byteOffset+sourceBase.byteLength),flash.settings));
    if(sha(recordedBytes)!==flash.sha256)throw new Error('Reconstructed flash SHA-256 does not match the write record.');
    const originalMap=new m.BinaryParser(base.buffer.slice(base.byteOffset,base.byteOffset+base.byteLength)).getVETable();
    const recordedMap=new m.BinaryParser(recordedBytes.buffer.slice(recordedBytes.byteOffset,recordedBytes.byteOffset+recordedBytes.byteLength)).getVETable();
    if(JSON.stringify(originalMap)!==JSON.stringify(recordedMap))throw new Error('Recording VE differs from comparison BASE.');
    recordedCalibration={kind:'hash-verified-recorded-flash',sourceSessionId:prior.id,sourceSeq:prior.seq,at:flash.at,sha256:flash.sha256,
        context:m.operatingCalibrationContext(recordedBytes.buffer.slice(recordedBytes.byteOffset,recordedBytes.byteOffset+recordedBytes.byteLength)),
        limitation:'Historical write evidence, not a contemporaneous ECU readback; assumes no subsequent unrecorded write.'};
}
const ab=recordedBytes.buffer.slice(recordedBytes.byteOffset,recordedBytes.byteOffset+recordedBytes.byteLength), parser=new m.BinaryParser(ab);
const map=parser.getVETable(), settings=session.tuneSettings, cfg=settings?.filterConfig, table=settings?.interpolationTable;
if(!cfg || (cfg.enableCorrection && !Array.isArray(table)))throw new Error('Saved filter/load calibration missing.');
const calc=new m.VECalculator(), options={steadyFilterConfig:cfg,steadyLoadTable:table,
    dmeCalibration:m.readDmeCalibration(ab),steadyCalibrationHold:m.operatingCalibrationHold(ab),
    steadyLambdaLimits:parser.readLambdaLimits(),egt:m.readEgtTables(ab),
    rfKorrAir:{curves:m.readRfPtKorrCurves(ab),assumedPressureMbar:cfg.assumedAmbientPressure},
    rfKorrSource:cfg.rfKorrSource,rfKorrMode:cfg.rfKorrMode,applyRfKorr:cfg.applyRfKorr,
    rfKorrSettleSec:cfg.rfKorrSettleSec,veMethod:cfg.veMethod,directAuthority:cfg.directAuthority,
    minCellSamples:cfg.enableVeCellGate===false?1:cfg.minVeCellSamples,
    minCellWeight:cfg.enableVeCellGate===false?0:cfg.minVeCellWeight,veLearningRate:cfg.veLearningRate};
const processed=m.processLogData(raw,String(session.seq),cfg,table,options.steadyLambdaLimits);
const legacy=m.prepareOperatingTimeline(map,raw,{...options,veCorrectionPolicy:'legacy-nominal'});
const dme=m.prepareOperatingTimeline(map,raw,{...options,veCorrectionPolicy:'dme-response'});
const focus=p=>p.rpm>=2200&&p.rpm<=2700&&p.correctedLoad>=7.5&&p.correctedLoad<=10;
const included=new Set(processed.data.map(p=>p.rawSampleIndex));
const oldPoints=legacy.filter((p,i)=>included.has(i)),newPoints=dme.filter((p,i)=>included.has(i));
// Same sample filters and cell thresholds; legacy here is before optional charge-temperature
// normalization and without jointly writing RF. It is not a replay of a stored TUNED artifact.
const oldMap=calc.calculateNewVEMap(map,oldPoints,{...options,veCorrectionPolicy:'legacy-nominal'});
const newMap=calc.calculateNewVEMap(map,newPoints,{...options,veCorrectionPolicy:'dme-response'});
// Diagnostic only: show whether the response evidence itself is absent, independently of the
// BASE-provenance hold. This does not authorize a calibration or generate any binary.
const responseOnly=calc.calculateNewVEMap(map,newPoints,{...options,veCorrectionPolicy:'dme-response',steadyCalibrationHold:null});
const pointDemands=oldPoints.filter(focus).map(p=>{
    const grid=calc.createGrid();calc.accumulatePoint(grid,p,{source:cfg.rfKorrSource??'rf-ratio',apply:cfg.applyRfKorr!==false},null,null,cfg.rfKorrSettleSec,{...options,veCorrectionPolicy:'legacy-nominal'});
    const cells=grid.flat(),w=cells.reduce((s,c)=>s+c.weightSum,0);
    return w?cells.reduce((s,c)=>s+c.sumStftWeighted,0)/w:null;
}).filter(x=>x!==null).sort((a,b)=>a-b);
const cells=[];
for(let r=0;r<map.yAxis.length;r++)for(let c=0;c<map.xAxis.length;c++) {
    if(map.yAxis[r]>=7.5 && map.yAxis[r]<=10 && map.xAxis[c]>=2200 && map.xAxis[c]<=2700)cells.push({
        rpm:map.xAxis[c],load:map.yAxis[r],legacyDemand:oldMap.demandMap[r][c],legacyAccepted:oldMap.acceptedMap[r][c],
        dmeAccepted:newMap.acceptedMap[r][c],dmeWeight:newMap.weightMap[r][c],dmeDemand:newMap.weightMap[r][c]>0?newMap.demandMap[r][c]:null,
        candidateWeightBeforeCalibrationHold:responseOnly.weightMap[r][c]});
}
const summary={version:m.DME_RESPONSE_VERSION,session:session.seq,baseSha256:sha(base),logSha256:sha(JSON.stringify(raw)),
    calibrationHold:options.steadyCalibrationHold,calibration:options.dmeCalibration,recordedCalibration,
    all:m.summarizeDmeResponse(dme),focus:m.summarizeDmeResponse(dme.filter(focus)),
    focusAfterLegacyFilters:m.summarizeDmeResponse(newPoints.filter(focus)),
    oldFocusPointDemand:{count:pointDemands.length,min:pointDemands[0]??null,median:pointDemands[Math.floor(pointDemands.length/2)]??null,max:pointDemands.at(-1)??null},
    cells,comparisonOnly:true,limits:['BASE is not a current ECU readback.','RAM correspondence and unlogged fuel terms remain unverified.',
        'Candidate means are conditional on comparable trajectories and unchanged RF calibration, not measured nominal VE.',
        'Zero candidates/weight means unresolved; it does not mean zero required correction.','Legacy comparison excludes optional charge-temperature normalization and RF-table writes.']};
const out=path.join(root,'archive',recordedCalibration?'dme-response-flash-context':'dme-response',path.basename(input));fs.mkdirSync(out,{recursive:true});
if(recordedCalibration)fs.writeFileSync(path.join(out,'recorded-flash.bin'),recordedBytes);
// Preserve actual calculator counts, weights and cell verdicts separately. A DME input is a
// completed pair of cycles; it is not a raw log row and not interchangeable with legacy hits.
const packGrid=result=>({hits:result.hitMap,weights:result.weightMap,accepted:result.acceptedMap,
    rejects:result.rejectMap,coverage:result.coverage});
const maps={session:session.seq,baseSha256:sha(base),logSha256:sha(JSON.stringify(raw)),
    logFileSha256:sha(fs.readFileSync(path.join(input,'log.json'))),
    rpm:map.xAxis,load:map.yAxis,baseline:map.data,rawPoints:raw.length,filteredPoints:processed.data.length,
    calibrationHold:options.steadyCalibrationHold,recordedCalibration,comparisonOnly:true,
    settings:{minCellSamples:options.minCellSamples??3,minCellWeight:options.minCellWeight??2.5,
        veMethod:options.veMethod??'direct',rfKorrSettleSec:cfg.rfKorrSettleSec??1},
    legacy:{unit:'raw-sample-corner-hits',...packGrid(oldMap)},
    responseBeforeCalibrationHold:{unit:'two-cycle-estimate-corner-hits',...packGrid(responseOnly)},
    responseWithCalibrationHold:{unit:'two-cycle-estimate-corner-hits',...packGrid(newMap)},
    candidates:newPoints.filter(p=>p.dmeResponse?.reason==='cycle-candidate').map(p=>({
        index:p.rawSampleIndex,firstIndex:p.dmeResponse.cycleStartIndex,
        rpm:p.dmeResponse.meanRpm,load:p.dmeResponse.meanLoad})),
    limits:summary.limits};
fs.writeFileSync(path.join(out,'maps.json'),JSON.stringify(maps,null,2));
fs.writeFileSync(path.join(out,'analysis.json'),JSON.stringify(summary,null,2));
fs.writeFileSync(path.join(out,'points.json'),JSON.stringify(dme.map((p,i)=>({index:i,time:p.time,rpm:p.rpm,load:p.correctedLoad,
    passedLegacyFilter:included.has(i),focus:focus(p),...p.dmeResponse})),null,2));
fs.writeFileSync(path.join(out,'report.txt'),`DME response comparison — session ${session.seq}\n${JSON.stringify(summary,null,2)}\n`);
console.log(JSON.stringify({out,...summary},null,2));
