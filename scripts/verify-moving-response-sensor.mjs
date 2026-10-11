/** Independent integer sensor traces and recorded-calibration decoding. */
import assert from 'node:assert/strict';
import path from 'node:path';
import { build } from 'esbuild';
const root=path.resolve(import.meta.dirname,'..');
const built=await build({stdin:{contents:`export * from './src/lib/ve-calculator/movingResponseSensor';`,resolveDir:root,loader:'ts'},
    bundle:true,platform:'node',format:'esm',write:false});
const m=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64'));
const image=new ArrayBuffer(0x5000),v=new DataView(image),a=m.MOVING_RESPONSE_SENSOR_ADDRESSES;
const word=(at,value)=>v.setUint16(at,value,false);
word(a.offset,0);word(a.slope,1115);word(a.rich,510);word(a.lean,400);
[880,1500,2500,3500].forEach((x,i)=>word(a.rpmAxis+2*i,x));
[308,616,1026,1437].forEach((x,i)=>word(a.rfAxis+2*i,x));
for(let i=0;i<16;i++)word(a.filterValues+2*i,8);
const c=m.readMovingResponseSensorCalibration(image);
assert.deepEqual(c,{richMv:510,leanMv:400,inputMinMv:0,inputMaxMv:1113,maxFilterDivisor:8,tickSec:.01});
assert(Math.abs(m.rawSignLookbackSeconds(400,false,c)-.41)<1e-12);
assert.equal(m.rawSignLookbackSeconds(510,true,c),.44);
assert.equal(m.rawSignLookbackSeconds(875,true,c),.04);
assert.equal(m.rawSignLookbackSeconds(450,true,c),null);
assert.equal(m.rawSignLookbackSeconds(450,false,c),null);
assert.equal(m.rawSignLookbackSeconds(1400,true,c),null);
assert.equal(m.rawSignLookbackSeconds(800,true,{...c,maxFilterDivisor:0}),.01);
assert.equal(m.rawSignLookbackSeconds(800,true,{...c,maxFilterDivisor:NaN}),null);
assert.equal(m.readMovingResponseSensorCalibration(image.slice(0,20)),null);
word(a.rpmAxis+2,880);assert.equal(m.readMovingResponseSensorCalibration(image),null);word(a.rpmAxis+2,1500);
word(a.filterValues+10,12);assert.equal(m.readMovingResponseSensorCalibration(image).maxFilterDivisor,12);
word(a.slope,40000);word(a.offset,10000);assert.equal(m.readMovingResponseSensorCalibration(image),null);
word(a.slope,1115);word(a.offset,0);
assert.equal(m.hasFreshBothThresholdCrossings(12,14),false);
assert.equal(m.hasFreshBothThresholdCrossings(12,15),true);
for(const pair of [[252,255],[255,2],[12,0],[-1,3],[1.5,5]])assert.equal(m.hasFreshBothThresholdCrossings(...pair),false);

let seed=968,checks=0;
const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32;};
// Simulate varying divisors, including the direct-update path, without using
// the helper to generate the observations or choose their labels.
for(let trial=0;trial<100;trial++){
    let y=Math.floor(random()*1114),raw=0;const inputs=[];
    for(let tick=0;tick<2000;tick++){
        if(random()<.1)raw=Math.floor(random()*1114);
        const tau=Math.floor(random()*9),delta=raw-y;
        if(!tau)y=raw;
        else {const magnitude=Math.floor(Math.abs(delta)/tau);y+=(magnitude||+(delta!==0))*Math.sign(delta);}
        inputs.push(raw);
        if(tick<100 || y>400&&y<510)continue;
        const rich=y>=510,window=m.rawSignLookbackSeconds(y,rich,c);
        assert.notEqual(window,null);const n=Math.round(window/.01),recent=inputs.slice(-n);
        assert(recent.some(value=>rich?value>=510:value<=400));checks++;
    }
}
console.log(`PASS sensor IIR occurrence bounds: ${checks} independent observations; calibration, threshold, saturation and invalid-input cases`);
