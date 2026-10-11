/** Execute the real React hook with an estimator spy; validate RAW routing and result ownership. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { build } from 'esbuild';
const root=path.resolve(import.meta.dirname,'..');
const result={newMap:{xAxis:[2000,2500],yAxis:[5,10],data:[[.95,1],[1,1]],calibrationStatus:'moving-validated',
    movingResponseAudit:{version:1,maxStepPercent:5,acceptedCells:1,evidenceRows:4,validationPasses:2,
        maxCommandConeViolation:0,modelNames:['fixture'],beforeLoss:.01,afterLoss:.005}},
    diffMap:[[95,100],[100,100]],hitMap:[[4,0],[0,0]],correctionMap:[[.95,1],[1,1]],weightMap:[[4,0],[0,0]],
    rfKorrMap:[[1,1],[1,1]],rfKorrSpreadMap:[[0,0],[0,0]],tunedUsedMap:[[false,false],[false,false]],
    acceptedMap:[[true,false],[false,false]],realisedMap:[[.95,1],[1,1]],demandMap:[[.93,1],[1,1]],
    rejectMap:[[null,'no-data'],['no-data','no-data']],coverage:{withEvidence:1,withAnyData:1,total:4}};
globalThis.__movingRoute={states:[],refs:[],cursor:0,refCursor:0,calls:[],jobs:[],deferred:false,result};
const bundle=await build({stdin:{contents:`export { useVeCalculation } from './src/hooks/useVeCalculation';
export { useLiveRun } from './src/hooks/useLiveRun';
export { isVeHistoryPolicy, isVeComparisonPolicy } from './src/lib/types';
export { VECalculator } from './src/lib/ve-calculator/calculator';`,resolveDir:root,loader:'ts'},
    bundle:true,platform:'node',format:'esm',write:false,alias:{'@':path.join(root,'src')},plugins:[{name:'hook-harness',setup(b){
        b.onResolve({filter:/^react$/},()=>({path:'react',namespace:'fixture'}));
        b.onResolve({filter:/movingResponseWorker/},()=>({path:'solver',namespace:'fixture'}));
        b.onResolve({filter:/liveRunRepository/},()=>({path:'database',namespace:'fixture'}));
        b.onLoad({filter:/.*/,namespace:'fixture'},a=>({loader:'js',contents:a.path==='react'?`
            const s=globalThis.__movingRoute;
            export function useState(v){const i=s.cursor++;if(!(i in s.states))s.states[i]=v;return [s.states[i],x=>s.states[i]=x];}
            export function useRef(v){const i=s.refCursor++;return s.refs[i]??(s.refs[i]={current:v});}
            export function useEffect(){}
            export function useCallback(fn){return fn;}
            export function useSyncExternalStore(){}`:a.path==='database'?`
            export async function appendLiveChunk(){}
            export async function beginLiveRun(){return 'fixture';}
            export async function endLiveRun(){}`:`
            export function startMovingResponseWorker(request){const s=globalThis.__movingRoute;s.calls.push(request);
                let resolve,reject;const result=new Promise((ok,fail)=>{resolve=ok;reject=fail;});
                const job={result,resolve,reject,cancelled:false,cancel(){this.cancelled=true;resolve(null);}};
                s.jobs.push(job);if(!s.deferred)resolve(s.result);return job;}`}));
    }}]});
const m=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const render=()=>{globalThis.__movingRoute.cursor=0;globalThis.__movingRoute.refCursor=0;return m.useVeCalculation();};
const map={xAxis:[2000,2500],yAxis:[5,10],data:[[1,1],[1,1]]};
const raw=Array.from({length:4},(_,i)=>({time:1+i*.5,rpm:2200+i*50,rawLoad:8,stft1:.8,stft2:.81,
    lambdaState1:i===1?0:1,lambdaState2:i===1?0:1,coolantTemp:90}));
const processed={rawData:raw,data:raw.map((r,i)=>({...r,rawSampleIndex:i})).filter(r=>r.rawSampleIndex!==1),rfKorrData:[],
    validCount:3,droppedCount:1,dropCensus:{}};
const options={veCorrectionPolicy:'moving-response',steadyCalibrationHold:null,movingCalibration:{fixture:true},
    steadyFilterConfig:{enableCorrection:true},steadyLoadTable:[{rpm:0,factor:2},{rpm:10000,factor:2}]};
assert(m.isVeHistoryPolicy('moving-response'));assert(!m.isVeComparisonPolicy('moving-response'));
assert(m.isVeComparisonPolicy('dme-response'));
const legacy=new m.VECalculator();
assert.throws(()=>legacy.calculateNewVEMap(map,raw,options),/intact RAW history/);
assert.throws(()=>legacy.accumulatePoint(legacy.createGrid(),raw[0],null,null,null,0,options),/isolated samples/);
const before=JSON.stringify(raw);await render().runCalculation(map,processed,options);
const call=globalThis.__movingRoute.calls[0];assert.equal(call.raw.length,4);assert.equal(call.raw[1].lambdaState1,0);
assert.deepEqual(call.raw.map(r=>r.rawSampleIndex),[0,1,2,3]);assert(call.raw.every(r=>r.correctedLoad===4));
assert.equal(JSON.stringify(raw),before);assert.equal(call.options.movingCalibration,options.movingCalibration);
const completed=render();assert.equal(completed.newMap,result.newMap);assert.equal(completed.acceptedMap,result.acceptedMap);
assert.equal(completed.hitMap,result.hitMap);assert.equal(completed.demandMap,result.demandMap);
assert.deepEqual(completed.annotatedLog.map(r=>r.rawSampleIndex),[0,2,3]);
console.log('PASS moving Tune consumes intact corrected RAW, preserves filter indices and accepts the simultaneous solver result directly');
completed.appendCalculation(map,processed,options);assert.equal(globalThis.__movingRoute.calls.length,1);
assert.equal(render().newMap,null);assert.equal(render().acceptedMap,null);assert.equal(render().movingPending,true);
assert.equal(render().annotatedLog,processed.data);
render().appendCalculation(map,processed,options);assert.equal(globalThis.__movingRoute.calls.length,1);
await render().runCalculation(map,processed,options);assert.equal(globalThis.__movingRoute.calls.length,2);
assert.equal(render().newMap,result.newMap);assert.equal(render().movingPending,false);
assert.equal(globalThis.__movingRoute.calls.at(-1).raw.length,raw.length);
assert.equal(globalThis.__movingRoute.calls.at(-1).map,map);
console.log('PASS LIVE clears stale calibration without solving; STOP solves the entire recorded RAW against BASE once');
globalThis.__movingRoute.result={...result,newMap:null,acceptedMap:[[false,false],[false,false]],coverage:{withEvidence:0,withAnyData:1,total:4}};
await render().runCalculation(map,processed,{...options,steadyCalibrationHold:'binary-missing',movingCalibration:null});
assert.equal(render().newMap,null);assert.equal(globalThis.__movingRoute.calls.at(-1).options.steadyCalibrationHold,'binary-missing');
console.log('PASS missing calibration cannot retain a stale map or silently fall back to legacy correction');

globalThis.__movingRoute.deferred=true;
const pending=render().runCalculation(map,processed,options);
assert.equal(render().isCalculating,true);assert.equal(render().newMap,null);
const oldJob=globalThis.__movingRoute.jobs.at(-1);
const replacement=render().runCalculation(map,processed,options);
assert(oldJob.cancelled);await pending;
assert.equal(render().isCalculating,true);assert.equal(render().newMap,null);
globalThis.__movingRoute.jobs.at(-1).resolve(result);await replacement;
assert.equal(render().isCalculating,false);assert.equal(render().newMap,result.newMap);
const resetPending=render().runCalculation(map,processed,options);
const resetJob=globalThis.__movingRoute.jobs.at(-1);render().reset();await resetPending;
assert(resetJob.cancelled);assert.equal(render().isCalculating,false);assert.equal(render().newMap,null);
const failed=render().runCalculation(map,processed,options);
globalThis.__movingRoute.jobs.at(-1).reject(new Error('Worker fixture failure'));await failed;
assert.equal(render().movingError,'Worker fixture failure');assert.equal(render().newMap,null);
console.log('PASS replaced/reset workers cannot publish stale maps; pending and worker failures remain visible without a legacy fallback');

// Exercise the page's actual recording flush, where an accidental use of the
// derived map would compound the same recording's correction on every STOP.
const page=fs.readFileSync(path.join(root,'src/app/page.tsx'),'utf8');
const ast=ts.createSourceFile('page.tsx',page,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
let initializer;
const walk=n=>{if(ts.isVariableDeclaration(n)&&n.name.getText(ast)==='flushLiveSamples')initializer=n.initializer;ts.forEachChild(n,walk);};walk(ast);
assert(initializer);
const code=ts.transpileModule(`const flushLiveSamples=${initializer.getText(ast)};`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
const calls=[],deps={liveSamplesRef:{current:raw},currentMap:map,veCalcOptions:options,
    logFileState:{loadRawLog:rows=>({...processed,rawData:rows}),appendRawLog:rows=>({...processed,rawData:rows})},
    veCalc:{runCalculation:async(...args)=>{calls.push(['stop',...args]);},appendCalculation:(...args)=>calls.push(['live',...args])}};
const flush=new Function(...Object.keys(deps),`${code}\nreturn flushLiveSamples;`)(...Object.values(deps));
flush(false,false);await flush(true,true);await flush(true,true);
assert.deepEqual(calls.map(c=>c[0]),['live','stop','stop']);
for(const c of calls){assert.equal(c[1],map);assert.deepEqual(c[2].rawData,raw);assert.equal(c[3],options);}
console.log('PASS actual page LIVE/STOP and repeated STOP retain the recording BASE and complete RAW, never feed back TUNED');
let finishWorker;deps.veCalc.runCalculation=()=>new Promise(resolve=>{finishWorker=resolve;});
let flushFinished=false;const waitingFlush=flush(true,true).then(value=>{flushFinished=true;assert.deepEqual(value.rawData,raw);});
await Promise.resolve();assert.equal(flushFinished,false);finishWorker();await waitingFlush;
assert.equal(flushFinished,true);
console.log('PASS STOP flush waits for the final worker result before reporting completion');

let tabCallback;
const findTab=n=>{if(ts.isCallExpression(n)&&n.expression.getText(ast)==='useEffect'&&n.arguments[0]?.getText(ast).includes('const want = pendingTabRef.current;'))tabCallback=n.arguments[0];ts.forEachChild(n,findTab);};findTab(ast);
assert(tabCallback);
const tabCode=ts.transpileModule(`const resolvePending=${tabCallback.getText(ast)};`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
const tabRef={current:'new'},nav=[];
const resolveTab=(calculating,newMap,correctionMap,error=null)=>new Function('pendingTabRef','TABS','veCalc','newMap','correctionMap','movingAcquisition','setActiveTab','setNarrowPane',`${tabCode}\nreturn resolvePending();`)
    (tabRef,[{id:'new',enabled:!!newMap},{id:'lambda',enabled:!!correctionMap}],{isCalculating:calculating,movingError:error},newMap,correctionMap,null,v=>nav.push(v),()=>{});
resolveTab(true,null,null);assert.equal(tabRef.current,'new');assert.deepEqual(nav,[]);
resolveTab(false,result.newMap,result.correctionMap);assert.equal(tabRef.current,null);assert.deepEqual(nav,['new']);
tabRef.current='new';resolveTab(false,null,result.correctionMap);assert.equal(tabRef.current,null);assert.deepEqual(nav,['new','lambda']);
tabRef.current=null;resolveTab(false,result.newMap,result.correctionMap);assert.deepEqual(nav,['new','lambda']);
console.log('PASS async TUNED navigation waits for the result, shows feedback for zero accepted cells, and respects a manual tab selection');

let configInitializer;
const findConfig=n=>{if(ts.isVariableDeclaration(n)&&n.name.getText(ast)==='handleConfigChange')configInitializer=n.initializer;ts.forEachChild(n,findConfig);};findConfig(ast);
assert(configInitializer);
const configCode=ts.transpileModule(`const handleConfigChange=${configInitializer.getText(ast)};`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
const cfgRef={current:null},cfgTimers={current:null},armed=[];
const configDeps={isArchived:false,filterConfig:{veCorrectionPolicy:'dme-response'},pendingConfigRef:cfgRef,
    binaryFileState:{setWriteVe:v=>armed.push(v)},setPendingConfig:()=>{},filterComputeTimer:cfgTimers,
    setTimeout:()=>1,clearTimeout:()=>{}};
const activate=new Function(...Object.keys(configDeps),`${configCode}\nreturn handleConfigChange;`)(...Object.values(configDeps));
activate({veCorrectionPolicy:'moving-response'});assert.deepEqual(armed,[true]);
activate({veCorrectionPolicy:'moving-response',veLearningRate:.5});assert.deepEqual(armed,[true]);
console.log('PASS the explicit comparison-to-moving transition arms VE once; further moving reprocessing preserves manual disarming');

// Execute the real live scheduler. An idle callback queued just before STOP
// must not issue appendCalculation after the final calculation has started.
Object.assign(globalThis.__movingRoute,{states:[],refs:[],cursor:0,refCursor:0});
const callbacks=[];globalThis.window={requestIdleCallback:fn=>callbacks.push(fn)};
const liveCalls=[];let finishSolve;
const live=m.useLiveRun({flush:(...args)=>{liveCalls.push(args);return new Promise(resolve=>{finishSolve=resolve;});}});
live.start({sessionId:null,mock:true,exchanges:[]});live.addSample(raw[0]);
assert.equal(callbacks.length,1);
const stopping=live.finish();callbacks[0]();
assert.deepEqual(liveCalls,[[true,true]]);
finishSolve(processed);assert.equal(await stopping,processed);
console.log('PASS a queued LIVE idle callback is invalidated before STOP and cannot cancel the final solve');
delete globalThis.window;
delete globalThis.__movingRoute;
