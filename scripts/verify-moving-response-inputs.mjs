/** Browser-side DME inputs: independent I/P histories, chronology, cuts and BASE sensitivities. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
const root=path.resolve(import.meta.dirname,'..');
const bundle=await build({stdin:{contents:`export * from './src/lib/ve-calculator/movingResponseInputs';`,resolveDir:root,loader:'ts'},
    bundle:true,platform:'node',format:'esm',write:false,alias:{'@':path.join(root,'src')}});
const m=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const gains={positiveI:16/32768/.01,negativeI:13/32768/.01,positiveP:53/2048,negativeP:33/2048,tickSec:.01};
const calibration={richMv:510,leanMv:400,trimMin:.7,trimMax:1.3,baOffPositive:1065/1024,baOffNegative:963/1024,gains};
const map={xAxis:[2000,2500],yAxis:[5,10],data:[[.5,.8],[.9,1.1]]};
const w=(mid,radius=0)=>({start:mid-radius,mid,end:mid+radius});
const near=(a,b)=>assert(Math.abs(a-b)<1e-10,`${a} != ${b}`);
let count=0;function check(name,fn){fn();count++;console.log('PASS '+name);}

check('recording BIN gains agree with the disassembly catalog addresses and scales',()=>{
    const nodes=JSON.parse(fs.readFileSync(path.join(root,'public/data/calibration-graph.json'),'utf8')).nodes;
    const names={positiveI:'KF_LA_KI_POS',negativeI:'KF_LA_KI_NEG',positiveP:'KF_LA_KP_POS',negativeP:'KF_LA_KP_NEG'};
    const data=new ArrayBuffer(0x10000),v=new DataView(data);
    for(const [a,b] of [[0x4820,510],[0x4822,400],[0x481c,22938],[0x481a,42598],[0x484e,1100],[0x4850,900]])v.setUint16(a,b);
    v.setUint16(0x4816,0);v.setUint16(0x4818,1115);
    [880,1500,2500,3500].forEach((x,i)=>v.setUint16(0x4a4e+i*2,x));
    [308,616,1026,1437].forEach((x,i)=>v.setUint16(0x4a56+i*2,x));
    for(let i=0;i<16;i++)v.setUint16(0x4a5e+i*2,8);
    for(let i=0;i<18;i++)v.setUint16(0x08be+i*2,500+i*500);
    for(let i=0;i<12;i++)v.setUint16(0x08e2+i*2,i*100);
    for(let i=0;i<216;i++)v.setUint8(0x08fa+i,110+i%18);
    for(let i=0;i<480;i++)v.setUint16(0xd356+i*2,500+i);
    for(const [key,name] of Object.entries(names)){
        const z=nodes.find(n=>n.name===name).axes.z;assert.equal(m.CONTROLLER_GAIN_TABLES[key],z.addr);
        assert.equal(z.bits,8);assert.equal(z.rows*z.cols,36);
        v.setUint8(z.addr+35,{positiveI:16,negativeI:13,positiveP:53,negativeP:33}[key]);
    }
    assert.deepEqual(m.readMovingResponseCalibration(data).gains,gains);
    assert.equal(m.readMovingResponseCalibration(data).tiStat.values[11][17],127/128);
    const bound=m.readMovingResponseCalibration(data).recordedVe;
    assert.equal(bound.data.length,24);assert.equal(bound.data[0].length,20);
    assert.equal(bound.data[0][0],.5);assert.equal(bound.data[23][19],.979);
    assert.equal(m.readMovingResponseCalibration(new ArrayBuffer(100)),null);
});

check('cell contributions predict interpolated map changes, including repeated corner indices',()=>{
    for(const [rpm,load] of [[2200,7],[2000,5],[1900,2],[2600,12],[2500,8]]){
        const shares=m.veCellContributions(map,rpm,load);near(shares.reduce((s,x)=>s+x.share,0),1);
        assert.equal(new Set(shares.map(x=>x.index)).size,shares.length);
        const tx=Math.max(0,Math.min(1,(rpm-2000)/500)),ty=Math.max(0,Math.min(1,(load-5)/5));
        const interpolate=data=>data[0][0]*(1-tx)*(1-ty)+data[0][1]*tx*(1-ty)+data[1][0]*(1-tx)*ty+data[1][1]*tx*ty;
        const factors=[.7,1.2,.9,1.1],changed=map.data.map((r,y)=>r.map((v,x)=>v*factors[y*2+x]));
        near(shares.reduce((s,c)=>s+c.share*factors[c.index],0),interpolate(changed)/interpolate(map.data));
    }
    assert.equal(m.veCellContributions(map,NaN,7),null);
    assert.equal(m.veCellContributions({...map,xAxis:[2500,2000]},2200,7),null);
});

check('reachable bounds contain independently simulated I/P commands with waits and repeated P directions',()=>{
    let seed=542401,checked=0;const random=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/2**32);
    for(let run=0;run<1000;run++){
        const u=[1];let steps=0;
        for(let tick=0;tick<100;tick++){
            const event=random(),size=random();
            const delta=event<.15?0:event<.53?size*gains.positiveI*.01:event<.91?-size*gains.negativeI*.01
                :event<.955?(steps++,size*gains.positiveP):(steps++,-size*gains.negativeP);
            u.push(u.at(-1)+delta);
        }
        for(let tick=0;tick<=100;tick++){
            const range=m.controllerTrimEnvelope(w(tick*.01),{window:w(0),trim:u[0]},{window:w(1),trim:u.at(-1)},steps,gains);
            assert(range);assert(range.lower<=u[tick]+1e-12&&range.upper>=u[tick]-1e-12);checked++;
        }
    }
    assert.equal(checked,101000);
    assert.equal(m.controllerTrimEnvelope(w(.5),{window:w(0),trim:1},{window:w(1),trim:1.5},0,gains),null);
    assert.equal(m.controllerTrimEnvelope(w(-.1),{window:w(0),trim:1},{window:w(1),trim:1},0,gains),null);
});

function row(i,extra={}){
    const t=1+i*.7;return {time:t,rpm:2200+i*20,rawLoad:6+i*.2,stft1:.98,stft2:1.01,
        coolantTemp:90,tankVent:0,ltft1:1,ltft2:1,lambdaState1:1,lambdaState2:1,lambdaPSteps1:0,lambdaPSteps2:0,
        o2Precat1Mv:800,o2Precat2Mv:780,baFTi:1,
        standardReadTime:t-.55,standardReadMs:20,lambdaReadTime:t-.4,lambdaReadMs:20,lambdaReadSource:'ram-response-0401-unverified',
        injectionReadTime:t-.2,injectionReadMs:20,injectionReadSource:'block19-0401-unverified',
        injection1Ms:5,injection2Ms:5.1,injection3Ms:4.9,injection4Ms:4.8,injection5Ms:4.9,injection6Ms:4.7,
        injectionStft1:.98,injectionStft2:1.01,injectionBlankActual:0,injectionBlankTarget:0,
        rfSollDirect:.65,rfSollDirectTime:t-.1,rfSollDirectReadMs:20,
        rfKorrDirect:1.08,rfKorrDirectTime:t-.05,rfKorrDirectReadMs:20,rfDirectSource:'ram-0401-unverified',...extra};
}
const prepare=raw=>m.prepareMovingResponseInputs(map,raw,{calibration});
check('unaltered RAW indices and separate block windows survive OFF, acceleration, missing reads and gaps',()=>{
    const raw=Array.from({length:6},(_,i)=>row(i));raw[2]={...raw[2],lambdaState1:0,injectionBlankActual:6};
    raw[3]={...raw[3],lambdaReadSource:undefined};raw[5]=row(10);
    const before=JSON.stringify(raw),frames=prepare(raw);assert.equal(JSON.stringify(raw),before);
    assert.deepEqual(frames.map(f=>f.index),[0,1,2,3,4,5]);assert.equal(frames[2].evidenceReason,'lambda-off');
    assert(frames[2].injection&&frames[2].standard);assert.equal(frames[3].controller,null);
    assert(frames[5].segment>frames[4].segment);assert.notEqual(frames[1].injection.window.mid,frames[1].controller.window.mid);
    assert.deepEqual(m.injectionCommandFuelMs(frames[2].injection),[0,0]);
    assert.equal(m.injectionCommandFuelMs({...frames[2].injection,actualBlank:2}),null);
    assert.deepEqual(m.injectionCommandFuelMs(frames[1].injection),[5,4.8]);
});
check('a window is bounded only across intact active nonsaturated controller reads',()=>{
    const raw=Array.from({length:4},(_,i)=>row(i)),frames=prepare(raw),query=frames[1].injection.window;
    const estimate=fs=>m.reconstructMovingController(fs,query,0,calibration,{segment:fs[1].segment});
    const range=estimate(frames);assert(range&&range.lower<=.98&&range.upper>=.98);
    for(const patch of [{lambdaState1:0},{lambdaPSteps1:255},{lambdaReadSource:undefined},{stft1:.7}]){
        const changed=structuredClone(raw);changed[2]={...changed[2],...patch};assert.equal(estimate(prepare(changed)),null);
    }
    const reset=structuredClone(raw);reset[1].lambdaPSteps1=5;assert.equal(estimate(prepare(reset)),null);
    const restarted=prepare([...raw,...raw]);
    assert.equal(m.reconstructMovingController(restarted,query,0,calibration,{segment:-1}),null);
    assert(m.reconstructMovingController(restarted,query,0,calibration,{segment:restarted[5].segment}));
});
console.log(`${count} moving-response input checks passed`);
