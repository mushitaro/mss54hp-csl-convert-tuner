/** Synthetic response trajectories, intact-RAW replay, and actual calculator boundary. */
import assert from 'node:assert/strict';
import path from 'node:path';
import { build } from 'esbuild';
const root=path.resolve(import.meta.dirname,'..');
const b=await build({stdin:{contents:`
export * from './src/lib/ve-calculator/dmeResponse';
export * from './src/lib/ve-calculator/operatingEvidence';
export { deriveOperatingCorrection } from './src/lib/ve-calculator/steadyEvidence';
export { VECalculator } from './src/lib/ve-calculator/calculator';
export { APP_CONFIG } from './src/config/constants';
export { isVeComparisonPolicy } from './src/lib/types';`,resolveDir:root,loader:'ts'},bundle:true,platform:'node',format:'esm',write:false,alias:{'@':path.join(root,'src')}});
const m=await import('data:text/javascript;base64,'+Buffer.from(b.outputFiles[0].text).toString('base64'));
const calibration={richMv:510,leanMv:450,trimMin:.7,trimMax:1.3,baOffPositive:1065/1024,baOffNegative:963/1024};
const opts={calibration};
const near=(a,b)=>assert(Math.abs(a-b)<1e-10,`${a} != ${b}`);
let passes=0;
function check(label,fn){fn();passes++;console.log('PASS '+label);}
function point(i,extra={}) {
    const time=1+i*.4, rich=Math.floor(i/2)%2===0;
    const stft=[.8,.78,.8,.82][i%4];
    return {time,rpm:2300+i*5,rawLoad:8,correctedLoad:8,rf:90,vehicleSpeed:50,
        coolantTemp:75,wdk1:20,exhaustTemp:350,tankVent:0,ltft1:1,ltft2:1,
        stft1:stft,stft2:stft+.02,lambdaState1:79,lambdaState2:79,
        lambdaPSteps1:10+Math.floor(i/2),lambdaPSteps2:10+Math.floor(i/2),
        o2Precat1Mv:rich?850:100,o2Precat2Mv:rich?840:110,baFTi:1,
        lambdaReadSource:'ram-response-0401-unverified',lambdaReadTime:time-.16,lambdaReadMs:20,
        rfDirectSource:'ram-0401-unverified',rfKorrDirect:1.2,rfKorrDirectTime:time-.05,rfKorrDirectReadMs:20,
        standardReadTime:time-.25,standardReadMs:20, ...extra};
}
const trace=Array.from({length:30},(_,i)=>point(i));
const annotate=(r,options={})=>m.annotateDmeResponse(r,{...opts,...options});
const candidates=r=>r.filter(p=>p.dmeResponse.reason==='cycle-candidate');

check('two repeatable cycles produce discrete comparison observations during a moving pass',()=>{
    const out=annotate(trace), c=candidates(out);
    assert(c.length>=2);assert(c.length<out.length/4);
    for(const p of c){near(p.dmeResponse.trim,.81);near(p.dmeResponse.kApplied,1.2);assert(p.dmeResponse.meanRpm<p.rpm);}
    for(let i=1;i<out.length;i++)if(out[i-1].veEvidenceEligible)assert(!out[i].veEvidenceEligible);
});
check('a rich-side I ramp never becomes a VE estimate just because time has passed',()=>{
    const ramp=Array.from({length:100},(_,i)=>point(i,{stft1:1-i*.002,stft2:1-i*.002,
        lambdaPSteps1:0,lambdaPSteps2:0,o2Precat1Mv:900,o2Precat2Mv:900}));
    const out=annotate(ramp);assert.equal(candidates(out).length,0);
    assert(out.filter(p=>p.dmeResponse.reason==='integrating-rich').length>90);
    assert.equal(candidates(annotate(trace.slice(0,5))).length,0);
});
check('OFF resets history even when its point would be filtered out of Tune',()=>{
    const r=structuredClone(trace.slice(0,18));
    r[8]={...r[8],baFTi:1.065,lambdaState1:78,lambdaState2:78,stft1:1,stft2:1,lambdaPSteps1:0,lambdaPSteps2:0};
    const out=annotate(r);assert.equal(out[8].dmeResponse.reason,'ba-shutdown');
    assert.equal(candidates(out).length,0);
    const negative=annotate([point(0),point(1,{baFTi:.9,lambdaState1:78})]);
    assert.equal(negative[1].dmeResponse.reason,'ba-shutdown');
});
check('sampled-ON counter decrease invalidates the preceding response',()=>{
    const r=trace.slice(0,17).map((p,i)=>i<8?p:{...p,lambdaPSteps1:p.lambdaPSteps1-13,lambdaPSteps2:p.lambdaPSteps2-13});
    const out=annotate(r);assert.equal(out[8].dmeResponse.reason,'controller-reset');assert.equal(candidates(out).length,0);
});
check('missing bank, unverified origin mismatch, BA activity, clamp and ambiguous switch counts earn no candidate',()=>{
    for(const patch of [{lambdaState2:undefined},{lambdaReadSource:undefined},{rfKorrDirect:undefined},
        {baFTi:1.01},{stft1:.7},{tankVent:1},{ltft2:1.05},{lambdaPSteps1:255},{o2Precat2Mv:900}]) {
        assert.equal(candidates(annotate(trace.map(p=>({...p,...patch})))).length,0,JSON.stringify(patch));
    }
    assert.equal(candidates(annotate(trace.map((p,i)=>({...p,lambdaPSteps1:10+i})))).length,0);
});
check('actual RF transitions and unbracketed reads break evidence; no interpolation across a step',()=>{
    const r=trace.slice(0,18).map((p,i)=>({...p,rfKorrDirect:i<8?1:1.2}));
    assert.equal(annotate(r)[8].dmeResponse.reason,'rf-transition');assert.equal(candidates(annotate(r)).length,0);
    assert.equal(candidates(annotate(trace.map(p=>({...p,rfKorrDirectTime:p.lambdaReadTime})))).length,0);
    assert.equal(candidates(annotate(trace.map(p=>({...p,lambdaReadTime:p.time+1})))).length,0);
});
check('gaps, clock resets and crossed exclusion intervals cannot connect unrelated responses',()=>{
    for(const t of [trace[7].time,trace[7].time+4]) {
        const r=structuredClone(trace.slice(0,18));r[8].time=t;
        assert.equal(annotate(r)[8].dmeResponse.reason,'sample-gap');assert.equal(candidates(annotate(r)).length,0);
    }
    assert.equal(candidates(annotate(trace.slice(0,18),{excludeTimeRanges:[[3.9,4.0]]})).length,0);
});
check('drifting cycle means and wide trajectories remain unresolved',()=>{
    assert.equal(candidates(annotate(trace.map((p,i)=>({...p,stft1:p.stft1+i*.006})))).length,0);
    assert.equal(candidates(annotate(trace.map((p,i)=>({...p,rpm:1600+i*90})))).length,0);
    assert.equal(candidates(annotate(trace.map(p=>({...p,stft2:p.stft2+.08})))).length,0);
});
check('prefix replay equals full replay, ignores stale annotations and never mutates raw',()=>{
    const input=trace.map(p=>({...p,dmeResponse:{reason:'cycle-candidate',trim:9},veEvidenceEligible:true}));
    const before=JSON.stringify(input), out=annotate(input);
    for(let i=1;i<=input.length;i++)assert.deepEqual(annotate(input.slice(0,i)),out.slice(0,i));
    assert.equal(JSON.stringify(input),before);assert.equal(candidates(annotate(input,{calibration:null})).length,0);
    assert.equal(candidates(annotate(input,{calibration:{...calibration,richMv:NaN}})).length,0);
    assert.equal(candidates(annotate(input,{maxGapSec:NaN})).length,0);
});
check('the app path walks raw history before joining retained rows and rejects stale joins',()=>{
    const r=structuredClone(trace.slice(0,18));
    r[8]={...r[8],baFTi:1.065,lambdaState1:78,lambdaState2:78,lambdaPSteps1:0,lambdaPSteps2:0};
    const processed={rawData:r,data:r.map((p,i)=>({...p,rawSampleIndex:i})).filter(p=>p.rawSampleIndex!==8)};
    const o={veCorrectionPolicy:'dme-response',dmeCalibration:calibration,steadyFilterConfig:{enableCorrection:false}};
    const out=m.prepareOperatingEvidence({},processed,o);
    assert.equal(candidates(out).length,0);
    const bad={...point(0),time:999,rawSampleIndex:0,dmeResponse:{reason:'cycle-candidate',trim:9}};
    const stale=m.prepareOperatingEvidence({}, {...processed,data:[bad]},o)[0];
    assert.equal(stale.veEvidenceEligible,false);assert.equal(stale.dmeResponse,undefined);
});
check('BIN thresholds are decoded from the supplied calibration, not fixed in the classifier',()=>{
    const base=new ArrayBuffer(0x8000),v=new DataView(base);
    for(const [address,value] of [[0x4820,510],[0x4822,450],[0x481c,22938],[0x481a,42598],[0x484e,1100],[0x4850,900]])v.setUint16(address,value);
    const c=m.readDmeCalibration(base);assert(c);near(c.baOffPositive,1100/1024);
    assert.equal(m.readDmeCalibration(new ArrayBuffer(3)),null);
});
check('actual calculator consumes cycle mean and direct k; no old dwell/ratio fallback',()=>{
    const calc=new m.VECalculator(),grid=calc.createGrid();
    const out=annotate(trace),options={veCorrectionPolicy:'dme-response',steadyCalibrationHold:null};
    for(const p of out)calc.accumulatePoint(grid,{...p,rfKorr:9,rfKorrGateOpen:true,rfKorrDwellSec:0},null,null,null,999,options);
    const cells=grid.flat(), w=cells.reduce((s,c)=>s+c.weightSum,0), sum=cells.reduce((s,c)=>s+c.sumStftWeighted,0);
    near(w,candidates(out).length);near(sum/w,.81);
    for(const hold of [undefined,'air-model-active']) {
        const held=calc.createGrid();for(const p of out)calc.accumulatePoint(held,p,null,null,null,0,{...options,steadyCalibrationHold:hold});
        assert(held.flat().every(c=>c.weightSum===0));
    }
    const map={xAxis:m.APP_CONFIG.MSS54HP.AXIS_RPM,yAxis:m.APP_CONFIG.MSS54HP.AXIS_LOAD,
        data:m.APP_CONFIG.MSS54HP.AXIS_LOAD.map(()=>m.APP_CONFIG.MSS54HP.AXIS_RPM.map(()=>.7))};
    assert.equal(calc.calculateNewVEMap(map,out,{...options,minCellSamples:1,minCellWeight:0}).newMap?.calibrationStatus,'comparison-only');
    const blocked=calc.calculateNewVEMap(map,out,{...options,writeRfKorr:true});
    assert.equal(blocked.coverage.withAnyData,0);
});
check('planned/applied ratio cancels unchanged RF; changes require both known terms',()=>{
    near(m.deriveOperatingCorrection({trim:.8,kApplied:1.2,kPlanned:1.2,learningRate:1}),.8);
    near(m.deriveOperatingCorrection({trim:.8,kApplied:1.2,kPlanned:1,learningRate:1}),.96);
    assert.equal(m.deriveOperatingCorrection({trim:.8,kApplied:1.2,learningRate:1}),undefined);
    assert(m.isVeComparisonPolicy('dme-response'));assert(!m.isVeComparisonPolicy('legacy-nominal'));
});
console.log(`${passes} DME response checks passed`);
