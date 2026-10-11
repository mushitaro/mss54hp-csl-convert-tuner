/** Independent flux/time checks for the browser moving-response pipeline. */
import assert from 'node:assert/strict';
import path from 'node:path';
import { build } from 'esbuild';
const root=path.resolve(import.meta.dirname,'..');
const bundle=await build({stdin:{contents:`export * from './src/lib/ve-calculator/movingResponseInputs';
export * from './src/lib/ve-calculator/movingResponseHistory';
export * from './src/lib/ve-calculator/movingResponsePlan';`,resolveDir:root,loader:'ts'},
    bundle:true,platform:'node',format:'esm',write:false,alias:{'@':path.join(root,'src')}});
const m=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const near=(a,b)=>assert(Math.abs(a-b)<1e-9,`${a} != ${b}`);
let count=0;const test=(name,fn)=>{fn();count++;console.log('PASS '+name);};
const map={xAxis:[2000,2500],yAxis:[5,10],data:[[1,1],[1,1]]};
const cal={trimMin:.7,trimMax:1.3,gains:{positiveI:0,negativeI:0,positiveP:0,negativeP:0,tickSec:.01},
    tiStat:{rpm:[1000,4000],rf:[0,1],values:[[1,1],[1,1]]}};
function row(i,extra={}){
    const t=1+i*.5;return {time:t,rpm:2200+10*i,rawLoad:7,stft1:.8,stft2:.9,wdk1:5,llsSt:0,
        coolantTemp:90,tankVent:0,ltft1:1,ltft2:1,vehicleSpeed:40,exhaustTemp:600,
        lambdaState1:1,lambdaState2:1,lambdaPSteps1:0,lambdaPSteps2:0,o2Precat1Mv:800,o2Precat2Mv:800,baFTi:1,
        standardReadTime:t-.4,standardReadMs:10,lambdaReadTime:t-.3,lambdaReadMs:10,lambdaReadSource:'ram-response-0401-unverified',
        injectionReadTime:t-.2,injectionReadMs:10,injectionReadSource:'block19-0401-unverified',
        injection1Ms:4,injection2Ms:4,injection3Ms:4,injection4Ms:4.5,injection5Ms:4.5,injection6Ms:4.5,
        injectionStft1:.8,injectionStft2:.9,injectionBlankActual:0,injectionBlankTarget:0,
        rfSollDirect:.5,rfSollDirectTime:t-.1,rfSollDirectReadMs:10,
        rfKorrDirect:1.2,rfKorrDirectTime:t-.05,rfKorrDirectReadMs:10,rfDirectSource:'ram-0401-unverified',...extra};
}
const make=raw=>m.buildCommandHistory(map,raw,m.prepareMovingResponseInputs(map,raw,{calibration:cal}),cal);
const raw=Array.from({length:40},(_,i)=>row(i));
const history=make(raw);
test('actual TI/concurrent trim defines reference without a second RF KORR multiplication',()=>{
    assert(history.points.filter(Boolean).length>100);assert.equal(history.coneFailures,0);
    for(const p of history.points.filter(Boolean)){
        near(p.base[0],5*p.rpm/120);near(p.base[1],5*p.rpm/120);
        near(p.lower[0],p.base[0]*.8);near(p.upper[1],p.base[1]*.9);
        near(p.shares.reduce((s,v)=>s+v.share,0),1);
    }
});
test('fuel blanking retains air reference and zero fuel; partial bank identity stays unknown',()=>{
    const cuts=raw.map((r,i)=>({...r,injectionBlankActual:i>=10&&i<=20?6:0}));
    const h=make(cuts),middle=h.points.filter(p=>p&&p.time>=7&&p.time<=10);
    assert(middle.length>20);for(const p of middle){assert(p.base[0]>0);assert.deepEqual(p.lower,[0,0]);assert.deepEqual(p.upper,[0,0]);}
    // Adjacent injection reads are at 5.3 and 5.8 s. Neither packet locates
    // the transition inside that interval, so a midpoint switch is invented.
    assert(h.points.every((p,i)=>h.start+i*h.step<=5.3||h.start+i*h.step>=5.8||p===null));
    const partial=make(cuts.map(r=>({...r,injectionBlankActual:r.injectionBlankActual?2:0})));
    assert(partial.points.every(p=>!p||p.time<7||p.time>10));
});
test('missing RAW controller reads and impossible observed commands break the physical history',()=>{
    const missing=structuredClone(raw);missing[15].lambdaReadSource=undefined;
    const h=make(missing);assert(h.points.some((p,i)=>p===null&&h.start+i*h.step>7.5&&h.start+i*h.step<8.5));
    const impossible=structuredClone(raw);impossible[15].injectionStft1=1.1;
    const z=make(impossible);assert(z.coneFailures>0);assert(z.maxConeViolation>.2);
    assert(z.points.filter(Boolean).length<history.points.filter(Boolean).length);
});
test('fixed-delay transport moves positive flux and cell coefficients together',()=>{
    const out=m.transportCommandHistory(history,{name:'delay',delay:.5});
    for(let i=0;i<out.length;i++)if(out[i]){
        const p=history.points[i-5];assert(p);
        near([...out[i].cells[0].values()].reduce((s,v)=>s+v,0),p.base[0]);
        near(out[i].lower[0],p.lower[0]);
        assert([...out[i].cells[0].values()].every(v=>v>=0));
    }
});
test('flow delay equals clock residence at a known constant flow',()=>{
    const p={time:0,segment:1,rpm:2000,rfSoll:.3,k:1.2,speed:40,exhaust:600,sourceIndex:0,
        shares:[{index:0,share:1}],base:[10,20],lower:[8,18],upper:[8,18]};
    const h={start:0,step:.1,points:Array.from({length:60},(_,i)=>({...p,time:i*.1,base:[10+i,20+2*i]}))};
    const a=m.transportCommandHistory(h,{name:'time',delay:.5}),b=m.transportCommandHistory(h,{name:'flow',flowDelay:.5});
    for(let i=10;i<55;i++){assert(a[i]&&b[i]);near(a[i].cells[0].get(0),b[i].cells[0].get(0));}
});
const egt={rfKorr:{rpm:[1000,4000],delta:[0,100],values:[[1.2,1.2],[1.2,1.2]]},
    tabgModel:{rpm:[1000,4000],rf:[0,1],values:[[600,600],[600,600]]},
    rfKorrMin:{rpm:[1000,4000],values:[.55,.55]},hys:.1,vMin:20};
test('unchanged map is exactly identity through observed K changes and enter/hold/reset branches',()=>{
    const h=structuredClone(history);h.points=h.points.map((p,i)=>p?{...p,k:1+i%4*.02,rfSoll:[.7,.5,.2][i%3]}:null);
    for(const mode of ['gate','retained']){
        const ratios=m.plannedCommandRatios(h,[1,1,1,1],cal,egt,mode);
        ratios.forEach((r,i)=>h.points[i]?assert.equal(r,1):assert(Number.isNaN(r)));
    }
});
test('planned change includes load-dependent TI_STAT once and preserves observed RF reference',()=>{
    const c={...cal,tiStat:{rpm:[1000,4000],rf:[0,1],values:[[1,1],[2,2]]}};
    const ratios=m.plannedCommandRatios(history,[.95,.95,.95,.95],c,egt,'retained');
    ratios.forEach((r,i)=>{if(history.points[i])near(r,.95*(1+.5*1.2*.95)/(1+.5*1.2));});
});
test('unsupported prior TI_STAT branches cannot substantiate a changed command ratio',()=>{
    const h=structuredClone(history);h.points=h.points.map(p=>p?{...p,normalStat:false}:null);
    const identity=m.plannedCommandRatios(h,[1,1,1,1],cal,egt,'retained');
    const changed=m.plannedCommandRatios(h,[.95,.95,.95,.95],cal,egt,'retained');
    h.points.forEach((p,i)=>{if(p){assert.equal(identity[i],1);assert(Number.isNaN(changed[i]));}});
});
console.log(`${count} moving-response history checks passed`);
