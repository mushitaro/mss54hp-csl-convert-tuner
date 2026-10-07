import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {BinaryParser} from '../src/lib/binary-engine/parser.ts';
import {BinaryPatcher} from '../src/lib/binary-engine/patcher.ts';
import {VECalculator} from '../src/lib/ve-calculator/calculator.ts';
import {operatingCalibrationHold} from '../src/lib/ve-calculator/operatingPolicy.ts';
import {prepareOperatingEvidence} from '../src/lib/ve-calculator/operatingEvidence.ts';
import {processLogData} from '../src/lib/log-engine/filter.ts';
import {readEgtTables} from '../src/lib/ve-calculator/egtTables.ts';
import {readRfPtKorrCurves,rfPtKorrFor} from '../src/lib/ve-calculator/chargeTemp.ts';
const bytes=readFileSync(new URL('../public/mock/csl-0401-community-patch-v1.partial.bin',import.meta.url));
const base=bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.length);
const patcher=new BinaryPatcher(base);patcher.disableMapCorrection();patcher.setWOTThreshold(true);
const recorded=patcher.getBuffer(),parser=new BinaryParser(recorded),map=parser.getVETable();
map.data=map.data.map(r=>r.map(()=>.8));
const limits=parser.readLambdaLimits(),curves=readRfPtKorrCurves(recorded);
const cfg={enableCorrection:true,enableMinTemp:true,minTemp:65,enableTransient:false,transientWindow:4,rpmStableThreshold:10,tpsStableThreshold:5};
const table=[{rpm:0,factor:1},{rpm:10000,factor:1}];
const options={veCorrectionPolicy:'steady-retain',veLearningRate:1,steadyCalibrationHold:operatingCalibrationHold(recorded),
    steadyLambdaLimits:limits,steadyFilterConfig:cfg,steadyLoadTable:table,egt:readEgtTables(recorded),rfKorrAir:{curves},
    minCellSamples:1,minCellWeight:0};
const make=(trim)=>Array.from({length:65},(_,i)=>{
    const p={time:i*.25,rpm:2400,rawLoad:7.5,wdk1:10,coolantTemp:90,exhaustTemp:420,vehicleSpeed:45,
        stft1:trim,stft2:trim,ltft1:1,ltft2:1,tankVent:0,intakeTemp:20,ambientPressure:960.5};
    return {...p,rf:.8*rfPtKorrFor(p,curves)*1.2*100-.1};
});
const calc=new VECalculator();
const replay=(raw,opts=options)=>{
    const processed=processLogData(raw,'synthetic',cfg,table,limits);
    const annotated=prepareOperatingEvidence(map,processed,opts);
    return {annotated,result:calc.calculateNewVEMap(map,annotated,opts)};
};
assert.equal(operatingCalibrationHold(null),'binary-missing');
assert.equal(options.steadyCalibrationHold,null);
const restored=new BinaryPatcher(recorded);restored.enableMapCorrection();
assert.equal(operatingCalibrationHold(restored.getBuffer()),'air-model-active');
// A valid map-off image with the stock learning window must still be held.
// Use the parser's published constant through the existing patcher rather than guess an offset.
const learningPatcher=new BinaryPatcher(recorded);learningPatcher.setTempThreshold(69);
assert.equal(operatingCalibrationHold(learningPatcher.getBuffer()),'learning-active');
const neutral=replay(make(1));
assert.ok(neutral.annotated.some(p=>p.veEvidenceEligible),'fixture must earn steady evidence');
assert.deepEqual(neutral.result.newMap.data,map.data,'neutral trim and unchanged k must preserve VE');
assert.equal(neutral.result.newMap.calibrationStatus,'comparison-only');
const lean=replay(make(.95));
assert.ok(lean.result.newMap.data.flat().some(v=>v<.8),'valid reduction remains a reduction');
const reduced=replay(make(.95),{...options,veLearningRate:.5});
assert.ok(Math.min(...reduced.result.newMap.data.flat())>Math.min(...lean.result.newMap.data.flat()),'whole-correction gain reduces the step');
for(const hold of [undefined,'binary-missing','air-model-active','learning-active']) {
    const r=replay(make(.95),{...options,steadyCalibrationHold:hold});
    assert.equal(r.result.coverage.withEvidence,0,`held ${hold} must earn no cells`);
}
assert.equal(replay(make(.95),{...options,writeRfKorr:true}).result.coverage.withEvidence,0,'cannot combine retained-table policy with a table write');
assert.equal(replay(make(.95).map(p=>({...p,tankVent:10}))).result.coverage.withEvidence,0);
assert.equal(replay(make(.95).map(p=>({...p,ltft1:1.01}))).result.coverage.withEvidence,0);
const direct=make(.95).map(p=>({...p,rfKorrDirect:42,rfSollDirect:999,rfDirectSource:'ram-0401-unverified'}));
assert.deepEqual(replay(direct).result.newMap,lean.result.newMap,'unverified RAM cannot change a candidate');
for(const n of [1,16,25,40,65]) {
    const prefix=replay(make(.95).slice(0,n)).annotated;
    assert.deepEqual(prefix,lean.annotated.slice(0,n),'full-prefix LIVE and STOP evidence must agree');
}
assert.equal(calc.calculateNewVEMap(map,lean.annotated).newMap.calibrationStatus,undefined,'legacy calculation keeps its original output semantics');
const repeated=[...make(.95),...make(1.05)];
const repeatedResult=replay(repeated).annotated;
assert.equal(repeatedResult[24].stft1,.95,'a later repeated timestamp cannot overwrite an earlier sample');
assert.equal(repeatedResult[65+24].stft1,1.05);
assert.equal(repeatedResult[65].veEvidenceEligible,false,'clock reset breaks evidence');
assert.deepEqual(replay(make(.95),{...options,veMethod:'statistical',directAuthority:.1}).result.newMap,
    lean.result.newMap,'new policy has one gain, eta, rather than stacking legacy authority');
assert.ok(replay(make(.95),{...options,steadyFilterConfig:{...cfg,katsTabgOn:800}}).annotated
    .some(p=>p.veEvidenceEligible),'custom cat-protect entry inherits its matching exit threshold');
console.log('Operating policy: context holds, neutral invariance, direction, gain, missing evidence, RAM isolation, and LIVE/STOP agreement passed.');
