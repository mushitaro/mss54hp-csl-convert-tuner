/** Run the actual START handler with recording link/storage fakes. No ECU I/O. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import path from 'node:path';
import { build } from 'esbuild';
const root=path.resolve(import.meta.dirname,'..');
const bundle=await build({stdin:{contents:`
    export { freshTuneFilterConfig } from './src/lib/log-engine/tunePolicy';
    export { isVeHistoryPolicy } from './src/lib/types';
    export { APP_CONFIG } from './src/config/constants';`,resolveDir:root,loader:'ts'},
    bundle:true,platform:'node',format:'esm',write:false,alias:{'@':path.join(root,'src')}});
const {freshTuneFilterConfig,isVeHistoryPolicy,APP_CONFIG}=await import('data:text/javascript;base64,'
    +Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const source=fs.readFileSync(new URL('../src/app/page.tsx',import.meta.url),'utf8');
const ast=ts.createSourceFile('page.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const declarations=new Map();
function walk(node) {
    if(ts.isVariableDeclaration(node))declarations.set(node.name.getText(ast),node.initializer);
    ts.forEachChild(node,walk);
}
walk(ast);
function executable(name,deps) {
    const initializer=declarations.get(name);assert.ok(initializer);
    const js=ts.transpileModule(`const ${name}=${initializer.getText(ast)};`,{
        compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None,jsx:ts.JsxEmit.React},
    }).outputText;
    return new Function(...Object.keys(deps),`${js}\nreturn ${name}`)(...Object.values(deps));
}
function harness(change) {
    const calls=[],record={version:1,checkedAt:40,vin:'fixture',mock:false,status:'unresolved',reason:'no-reference'};
    const deps={
        recordingEpochRef:{current:0},logProcess:'VE',LOG_PROFILES:{VE:{label:'VE'}},
        captureRecordingCalibration:async()=>record,recordingCalibrationBuffer:async()=>null,
        sessionDb:{sessions:[],loadBinaries:async()=>null,setProcess:async()=>{}},currentSession:{id:'drive'},
        dmeLink:{mockMode:false,readDataChecksums:async()=>({slave:0,master:0}),
            readLinkState:()=>({identity:{vin:'fixture'},mockMode:false}),
            verifyLogProfile:async()=>{change?.(deps);return {exchanges:['fixture-exchange']};},
            startTuning:()=>calls.push(['poll'])},
        readLogicPatches:()=>{throw Error('unknown reference cannot claim patches');},
        missingPatches:()=>[],bytesPatched:false,bytesTankVentShut:false,featurePreview:true,
        liveExchangesRef:{current:null},finishedRef:{current:true},pendingTabRef:{current:null},
        setRecordingCalibration:r=>calls.push(['reference',r]),setRecordingBinary:b=>calls.push(['binary',b]),
        filterConfig:{veCorrectionPolicy:'dme-response'},isVeHistoryPolicy:()=>true,
        interpolationTable:[{rpm:2000,factor:1.03},{rpm:3000,factor:1.08}],
        logFileState:{setLambdaLimits:v=>calls.push(['limits',v])},liveRun:{start:r=>calls.push(['recovery',r])},
    };
    return {calls,record,deps,invoke:executable('startTune',deps)};
}
const normal=harness();await normal.invoke();
assert.equal(normal.calls.find(x=>x[0]==='reference')[1],normal.record);
assert.equal(normal.calls.find(x=>x[0]==='recovery')[1].recordingCalibration,normal.record);
assert.deepEqual(normal.calls.find(x=>x[0]==='recovery')[1].calculationSnapshot,
    {filterConfig:normal.deps.filterConfig,interpolationTable:normal.deps.interpolationTable});
assert.equal(normal.calls.at(-1)[0],'poll');
assert.equal(normal.calls.find(x=>x[0]==='limits')[1],null);
assert.equal(normal.deps.liveExchangesRef.current[0],'fixture-exchange');
console.log('PASS unknown calibration still records; provenance is attached before polling and crash-recovery creation');
const moving=harness();moving.deps.filterConfig.veCorrectionPolicy='moving-response';await moving.invoke();
assert.equal(moving.calls.find(x=>x[0]==='recovery')[1].recordingCalibration,moving.record);
assert.deepEqual(moving.calls.find(x=>x[0]==='recovery')[1].calculationSnapshot,
    {filterConfig:moving.deps.filterConfig,interpolationTable:moving.deps.interpolationTable});
assert.equal(moving.calls.find(x=>x[0]==='limits')[1],null);
console.log('PASS moving-response START attaches recording provenance and refuses inferred lambda calibration');
for(const mutate of [d=>d.recordingEpochRef.current++,d=>{d.dmeLink.readLinkState=()=>({identity:{vin:'other'},mockMode:false});}]) {
    const h=harness(mutate);await h.invoke();assert.equal(h.calls.length,0);
}
console.log('PASS changing workspace or vehicle during START cannot attach the reference to another drive');
let release,starts=0;const pending=new Promise(r=>release=r);
const deps={startingTuneRef:{current:false},startTune:async()=>{starts++;await pending;}};
const start=executable('handleStartTune',deps),first=start();await start();assert.equal(starts,1);
release();await first;assert.equal(deps.startingTuneRef.current,false);
deps.startTune=async()=>{throw Error('link');};
const failure=executable('handleStartTune',deps);await assert.rejects(failure,/link/);
assert.equal(deps.startingTuneRef.current,false);
console.log('PASS concurrent START clicks are coalesced and a failed start releases the guard');
for(const processed of [null,{data:[]}]) {
    const calls=[];
    const deps={recordingEpochRef:{current:0},filterConfig:{veCorrectionPolicy:'dme-response'},isVeHistoryPolicy:()=>true,
        logFileState:{parseAndSetLog:async(file,limits)=>{assert.equal(limits,null);return processed;}},
        setRecordingCalibration:v=>calls.push(v),setRecordingBinary:v=>calls.push(v),currentMap:null};
    await executable('handleLogUpload',deps)({name:'import.csv'});
    assert.deepEqual(calls,processed?[null,null]:[]);
}
console.log('PASS replacement CSV clears prior provenance; invalid CSV leaves the existing drive intact');

function recoveryHarness() {
    const calls=[],base=new ArrayBuffer(4),recorded=new ArrayBuffer(4);
    const points=[{time:1,rpm:2200,rawLoad:8},{time:2,rpm:2500,rawLoad:9}];
    const map={xAxis:[2000,2500],yAxis:[5,10],data:[[1,1],[1,1]]};
    // Both an unrelated outgoing workspace and an older saved session disagree with this run.
    const session={id:'crashed-drive',tuneSettings:{filterConfig:{veCorrectionPolicy:'steady-retain',minTemp:92},
        interpolationTable:[{rpm:1000,factor:7}],writeRfKorr:true,writeVe:true}};
    const deps={freshTuneFilterConfig,isVeHistoryPolicy,APP_CONFIG,
        filterConfig:{veCorrectionPolicy:'dme-response',minTemp:81},interpolationTable:[{rpm:1000,factor:9}],
        sessionDb:{sessions:[session],loadBinaries:async()=>({baseBinaryBuffer:base})},
        loadLiveRunPoints:async()=>points,resetDerived:()=>calls.push(['reset']),
        recordingCalibrationBuffer:async()=>recorded,
        setRecordingCalibration:r=>calls.push(['recording',r]),setRecordingBinary:b=>calls.push(['recordedBytes',b]),
        setActiveSessionId:id=>calls.push(['active',id]),armedPatchesFromHistory:()=>null,
        storedWriteRfKorr:settings=>settings?.writeRfKorr??false,
        binaryFileState:{loadFromBuffer:async()=>map},liveRun:{adopt:p=>calls.push(['adopt',p])},
        logFileState:{loadRawLog:(...args)=>{calls.push(['load',...args]);return {rawData:points,data:points,rfKorrData:[]};}},
        BinaryParser:class {constructor(buffer){this.buffer=buffer;}readLambdaLimits(){return this.buffer;}},
        bytesAsRun:buffer=>buffer,readEgtTables:()=>null,readRfPtKorrCurves:()=>null,
        veCalcOptionsFor:(...args)=>({inputs:args}),veCalc:{runCalculation:(...args)=>calls.push(['calculate',...args])},
        comparison:{applyDefaultsAfterCalculation:()=>{}},goToTab:tab=>calls.push(['tab',tab]),
        pendingTabRef:{current:null},cancelPendingFilterCompute:()=>calls.push(['cancel']),
        dialogText:()=>({recoverFailed:'recover failed'}),alert:message=>{throw Error(message);},
    };
    return {calls,deps,recorded,base,points,invoke:executable('restoreRun',deps)};
}
for(const policy of ['moving-response','dme-response','legacy-nominal']) {
    const h=recoveryHarness(),config={...freshTuneFilterConfig(),veCorrectionPolicy:policy,minTemp:67};
    const table=[{rpm:1500,factor:1.12},{rpm:3500,factor:1.16}];
    const saved={filterConfig:config,interpolationTable:table},unchanged=JSON.stringify(saved);
    const reference={version:1,status:'fixture'};
    await h.invoke('recovered-run','crashed-drive',reference,saved);
    const loaded=h.calls.find(x=>x[0]==='load'),calc=h.calls.find(x=>x[0]==='calculate')[3].inputs;
    assert.equal(loaded[1],h.points);assert.equal(loaded[3],config);assert.equal(loaded[4],table);
    assert.equal(loaded[5],isVeHistoryPolicy(policy)?h.recorded:h.base);
    assert.equal(calc[0],config);assert.equal(calc[2],true);assert.equal(calc[5],table);assert.equal(calc[6],h.recorded);
    assert.equal(h.calls.find(x=>x[0]==='recording')[1],reference);
    assert.equal(h.calls.find(x=>x[0]==='adopt')[1],h.points);
    assert.equal(JSON.stringify(saved),unchanged);
    assert.equal(h.calls.at(-1)[0],'cancel');
}
console.log('PASS actual recovery filters and calculates with the saved START snapshot and recording calibration, independent of outgoing/saved-session settings');
const old=recoveryHarness();await old.invoke('old-run','crashed-drive');
const oldLoaded=old.calls.find(x=>x[0]==='load'),oldCalc=old.calls.find(x=>x[0]==='calculate')[3].inputs;
assert.deepEqual(oldLoaded[3],freshTuneFilterConfig());
assert.equal(oldLoaded[4],APP_CONFIG.MSS54HP.INTERPOLATION_TABLE);
assert.equal(oldCalc[0],oldLoaded[3]);assert.equal(oldCalc[5],oldLoaded[4]);
assert.equal(old.deps.pendingTabRef.current,'new');
console.log('PASS old recovery records explicitly re-analyze RAW under current Tune defaults without inheriting another session');
