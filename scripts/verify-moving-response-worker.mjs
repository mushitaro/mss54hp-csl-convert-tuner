/** Worker transport, cancellation and the actual worker entry are both exercised. */
import assert from 'node:assert/strict';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const root=path.resolve(import.meta.dirname,'..');
const load=async(file,define={})=>{
    const b=await build({entryPoints:[path.join(root,file)],bundle:true,platform:'browser',format:'esm',write:false,
        alias:{'@':path.join(root,'src')},define});
    return import('data:text/javascript;base64,'+Buffer.from(b.outputFiles[0].text).toString('base64'));
};
const workers=[];
globalThis.Worker=class {
    constructor(url,options){this.url=url;this.options=options;workers.push(this);}
    postMessage(request){this.request=structuredClone(request);}
    terminate(){this.terminated=true;}
};
const client=await load('src/lib/ve-calculator/movingResponseWorker.ts',{'import.meta.url':JSON.stringify(pathToFileURL(path.join(root,'src/lib/ve-calculator/movingResponseWorker.ts')).href)});
const request={map:{xAxis:[2000,2500],yAxis:[5,10],data:[[.7,.7],[.7,.7]]},raw:[],
    options:{veCorrectionPolicy:'moving-response',movingCalibration:null,steadyCalibrationHold:'binary-missing'}};
const job=client.startMovingResponseWorker(request),worker=workers.at(-1);
assert.deepEqual(worker.request,request);assert.notEqual(worker.request,request);
assert.equal(worker.options.type,'module');assert(worker.url.href.endsWith('/movingResponse.worker.ts'));
const expected={newMap:null,movingDiagnostics:{status:'calibration-held'}};
worker.onmessage({data:{result:expected}});assert.equal(await job.result,expected);assert(worker.terminated);
const cancel=client.startMovingResponseWorker(request);const cancelledWorker=workers.at(-1);cancel.cancel();
assert.equal(await cancel.result,null);assert(cancelledWorker.terminated);
cancelledWorker.onmessage({data:{result:expected}});assert.equal(await cancel.result,null);
const failed=client.startMovingResponseWorker(request);workers.at(-1).onerror({message:'synthetic worker load failure'});
await assert.rejects(failed.result,/synthetic worker load failure/);assert(workers.at(-1).terminated);
const cloneFail=client.startMovingResponseWorker({...request,options:{callback(){}}});
await assert.rejects(cloneFail.result);assert(workers.at(-1).terminated);
console.log('PASS module Worker transports a cloned recording, terminates, cancels pending work and reports worker/clone failure');
let reply;globalThis.self={postMessage:r=>{reply=structuredClone(r);}};
await load('src/lib/ve-calculator/movingResponse.worker.ts');
self.onmessage({data:request});
assert.equal(reply.result.newMap,null);assert.deepEqual(reply.result.coverage,{withEvidence:0,withAnyData:0,total:4});
assert(reply.result.acceptedMap.every(row=>row.every(v=>v===false)));
console.log('PASS the actual worker entry executes the actual solver and returns a structured-clone-compatible result');
delete globalThis.self;delete globalThis.Worker;
