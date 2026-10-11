/** Run the actual START handler with recording link/storage fakes. No ECU I/O. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
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
        logFileState:{setLambdaLimits:v=>calls.push(['limits',v])},liveRun:{start:r=>calls.push(['recovery',r])},
    };
    return {calls,record,deps,invoke:executable('startTune',deps)};
}
const normal=harness();await normal.invoke();
assert.equal(normal.calls.find(x=>x[0]==='reference')[1],normal.record);
assert.equal(normal.calls.find(x=>x[0]==='recovery')[1].recordingCalibration,normal.record);
assert.equal(normal.calls.at(-1)[0],'poll');
assert.equal(normal.calls.find(x=>x[0]==='limits')[1],null);
assert.equal(normal.deps.liveExchangesRef.current[0],'fixture-exchange');
console.log('PASS unknown calibration still records; provenance is attached before polling and crash-recovery creation');
const moving=harness();moving.deps.filterConfig.veCorrectionPolicy='moving-response';await moving.invoke();
assert.equal(moving.calls.find(x=>x[0]==='recovery')[1].recordingCalibration,moving.record);
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
