/** End-to-end synthetic moving drive; real browser implementation, no solver mocks. */
import assert from 'node:assert/strict';
import path from 'node:path';
import { build } from 'esbuild';
const root=path.resolve(import.meta.dirname,'..');
const bundle=await build({stdin:{contents:`export * from './src/lib/ve-calculator/movingResponseTune';`,resolveDir:root,loader:'ts'},
    bundle:true,platform:'node',format:'esm',write:false,alias:{'@':path.join(root,'src')}});
const m=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
let count=0;const test=(name,fn)=>{fn();count++;console.log('PASS '+name);};
const map={xAxis:[2000,2500],yAxis:[5,10],data:[[1,1],[1,1]]};
const cal={richMv:510,leanMv:400,trimMin:.7,trimMax:1.3,recordedVe:map,
    baOffPositive:1.04,baOffNegative:.94,gains:{positiveI:0,negativeI:0,positiveP:0,negativeP:0,tickSec:.01},
    sensor:{richMv:510,leanMv:400,inputMinMv:0,inputMaxMv:1113,maxFilterDivisor:8,tickSec:.01},
    tiStat:{rpm:[1000,4000],rf:[0,1],values:[[1,1],[1,1]]}};
const egt={rfKorr:{rpm:[1000,4000],delta:[0,100],values:[[1.2,1.2],[1.2,1.2]]},
    tabgModel:{rpm:[1000,4000],rf:[0,1],values:[[600,600],[600,600]]},
    rfKorrMin:{rpm:[1000,4000],values:[.2,.2]},hys:.1,vMin:20};
const options={veCorrectionPolicy:'moving-response',movingCalibration:cal,egt,steadyCalibrationHold:null,
    steadyLambdaLimits:{wotThreshold:{x:[1000,4000],y:[0,120],z:[[100,100],[100,100]]},
        loadThreshold:{x:[1000,4000],y:[100,100]},fMin:.7,fMax:1.3},veLearningRate:1};
function row(i,extra={}){
    const t=1+i*.5,phase=i%60;
    // Revisit one corner after 15 s away. Entry and exit traverse both axes.
    const x=phase<20?0:phase<25?(phase-20)/5:phase<50?1:phase<55?1-(phase-50)/5:0;
    const rpm=2000+500*x,load=5+5*x,pulse=5+2*x;
    return {time:t,rpm,rawLoad:load,stft1:.85,stft2:.85,wdk1:5,llsSt:0,
        coolantTemp:90,tankVent:0,ltft1:1,ltft2:1,vehicleSpeed:40,exhaustTemp:600,
        lambdaState1:1,lambdaState2:1,lambdaPSteps1:0,lambdaPSteps2:0,o2Precat1Mv:800,o2Precat2Mv:800,baFTi:1,
        standardReadTime:t-.4,standardReadMs:10,lambdaReadTime:t-.3,lambdaReadMs:10,lambdaReadSource:'ram-response-0401-unverified',
        injectionReadTime:t-.2,injectionReadMs:10,injectionReadSource:'block19-0401-unverified',
        injection1Ms:pulse*.85,injection2Ms:pulse*.85,injection3Ms:pulse*.85,
        injection4Ms:pulse*.85,injection5Ms:pulse*.85,injection6Ms:pulse*.85,
        injectionStft1:.85,injectionStft2:.85,injectionBlankActual:0,injectionBlankTarget:0,
        rfSollDirect:.5,rfSollDirectTime:t-.1,rfSollDirectReadMs:10,
        rfKorrDirect:1.2,rfKorrDirectTime:t-.05,rfKorrDirectReadMs:10,rfDirectSource:'ram-0401-unverified',...extra};
}
const raw=Array.from({length:240},(_,i)=>row(i));
const run=(r=raw,o=options)=>m.calculateMovingResponseDetails(map,r,o);
test('moving repeated visits produce a bounded quantized update under every transport model',()=>{
    const before=JSON.stringify(raw),{result,diagnostics:d}=run();assert.equal(JSON.stringify(raw),before);
    assert.equal(d.status,'validated');assert(result.newMap);assert(d.constraints>1000);
    assert(d.finalAudit.after<d.finalAudit.before);assert(d.finalAudit.worstIncrease<=1e-11);
    assert(result.newMap.data.flat().some(v=>v<1));
    for(const v of result.newMap.data.flat()){
        assert(v>=.95&&v<=1);assert.equal(Math.round(v*1000),v*1000);
        // Oracle: actual drive has a .75 stoichiometric command ratio; rich .85 observations
        // justify this direction, but cannot identify the complete .25 correction.
        assert(Math.abs(v-.75)<=Math.abs(1-.75));
    }
    assert.equal(result.newMap.calibrationStatus,'moving-validated');
    assert.equal(result.newMap.movingResponseAudit.maxStepPercent,5);
});
test('missing TI and calibration never fall back to multiplied STFT/RF estimates',()=>{
    const old=raw.map(r=>({...r,injectionReadSource:undefined}));
    const a=run(old);assert.equal(a.result.newMap,null);assert.equal(a.diagnostics.status,'no-command-history');
    const b=run(raw,{...options,movingCalibration:null});assert.equal(b.result.newMap,null);
    const c=run(raw,{...options,steadyCalibrationHold:'binary-missing'});assert.equal(c.result.newMap,null);
    const d=run(raw,{...options,movingCalibration:{...cal,recordedVe:{...map,data:[[.9,1],[1,1]]}}});
    assert.equal(d.result.newMap,null);assert.equal(d.diagnostics.status,'calibration-held');
});
test('one continuous visit cannot supply independent repeated-pass support',()=>{
    const r=run(Array.from({length:100},(_,i)=>row(i,{rpm:2200,rawLoad:7})));
    assert.equal(r.result.newMap,null);assert.equal(r.diagnostics.status,'no-supported-update');
});
test('clock gaps cannot be joined into a synthetic response trajectory',()=>{
    const sparse=raw.filter((_,i)=>i%4===0),r=run(sparse);
    assert.equal(r.result.newMap,null);assert.equal(r.diagnostics.historyPoints,0);
});
test('filter exclusions keep chronology but contribute no tuning observations',()=>{
    const r=run(raw,{...options,steadyFilterConfig:{excludeTimeRanges:[[0,1000]]}});
    assert(r.diagnostics.historyPoints>0);assert.equal(r.diagnostics.observationRows,0);assert.equal(r.result.newMap,null);
});
console.log(`${count} moving-response end-to-end checks passed`);
