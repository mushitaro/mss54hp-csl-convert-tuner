/** Replay the fixed, quantized #968 output on #967's conditional reconstructed
 * command. #967 has NO measured TI: this is a cross-drive sensitivity check,
 * never a measured-injection validation or an input to refitting the candidate.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { build } from 'esbuild';
const root=path.resolve(import.meta.dirname,'..'),dir=path.join(root,'src/lib/ve-calculator');
const source=fs.readFileSync(path.join(dir,'movingResponseTune.ts'),'utf8')+`
 export { auditModel };
 export * from './movingResponseInputs'; export * from './movingResponseHistory';
 export * from './movingResponsePlan'; export * from './movingResponseSensor'; export * from './egtTables';
 export { BinaryParser } from '@/lib/binary-engine/parser'; export { isFullLoad } from '@/lib/log-engine/lambdaGates';`;
const bundled=await build({stdin:{contents:source,resolveDir:dir,loader:'ts'},bundle:true,platform:'node',format:'esm',write:false,alias:{'@':path.join(root,'src')}});
const m=await import('data:text/javascript;base64,'+Buffer.from(bundled.outputFiles[0].text).toString('base64'));
const read=file=>JSON.parse(fs.readFileSync(path.join(root,file),'utf8'));
const candidatePath='archive/moving-response-tune/8084903e-f8ae-432e-9440-fa61c161c8a7/analysis.json';
const candidate=read(candidatePath),prepared=read('archive/ve-moving/transfer-967-history.json');
const bytes=fs.readFileSync(path.join(root,'archive/dme-response-flash-context/02ef23a7-49da-4c03-b8c2-a6f5b944e7cc/recorded-flash.bin'));
const buffer=bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),cal=m.readMovingResponseCalibration(buffer),egt=m.readEgtTables(buffer),limits=new m.BinaryParser(buffer).readLambdaLimits();
if(!cal||!egt||!limits||!candidate.result.newMap)throw new Error('Missing fixed calibration/candidate');
if(candidate.recordingSha256!==prepared.recordingSha256)throw new Error('Recording calibration mismatch');
const factors=candidate.result.newMap.data.flat().map((v,j)=>v/cal.recordedVe.data.flat()[j]);
const {history,raw,score}=prepared,obs=[];
for(const point of history.points) if(point){const p=raw[point.sourceIndex];point.normalStat=point.normalStat&&!m.isFullLoad(limits,p.wdk1,p.rpm,p.coolantTemp);}
for(let i=0;i<raw.length;i++){
 const p=raw[i];if(!score[i]||(p.llsSt&128)||m.isFullLoad(limits,p.wdk1,p.rpm,p.coolantTemp))continue;
 for(const bank of [1,2]){
  const mv=p['o2Precat'+bank+'Mv'],rich=mv>=cal.richMv;
  if(rich||mv<=cal.leanMv){const age=m.rawSignLookbackSeconds(mv,rich,cal.sensor);
   if(age!==null)obs.push({index:i,bank,rich,start:p.lambdaReadTime-p.lambdaReadMs/2000-age,end:p.lambdaReadTime+p.lambdaReadMs/2000,time:p.lambdaReadTime,kind:'point'});}
  const prior=raw[i-1];if(!prior||!score[i-1]||p.lambdaReadTime-prior.lambdaReadTime>1.5||!m.hasFreshBothThresholdCrossings(prior['lambdaPSteps'+bank],p['lambdaPSteps'+bank]))continue;
  for(const side of [false,true]){const age=m.rawSignLookbackSeconds(side?cal.richMv:cal.leanMv,side,cal.sensor);
   if(age!==null)obs.push({index:i,bank,rich:side,start:prior.lambdaReadTime-prior.lambdaReadMs/2000-age,end:p.lambdaReadTime+p.lambdaReadMs/2000,time:(p.lambdaReadTime+prior.lambdaReadTime)/2,kind:'fresh-switch'});}
 }
}
const summaries=[];
for(const mode of ['retained','gate']){
 const ratios=m.plannedCommandRatios(history,factors,cal,egt,mode);
 for(const model of m.MOVING_MODELS){
  const groups=m.auditModel(history,m.transportCommandHistory(history,model),m.transportCommandHistory(history,model,ratios),obs,model.name+':'+mode,factors);
  summaries.push({mode,model:model.name,before:groups.reduce((s,g)=>s+g.before,0),after:groups.reduce((s,g)=>s+g.after,0),groups:groups.map(g=>({...g,cells:[...g.cells]}))});
 }
}
const out={candidateSourceSha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(root,candidatePath))).digest('hex'),recordingSha256:prepared.recordingSha256,
 candidateMapSha256:crypto.createHash('sha256').update(JSON.stringify(candidate.result.newMap.data)).digest('hex'),
 candidateTarget:candidate.target,factors,targetFactor:factors[289],kind:'conditional-reconstructed-command-no-TI',logSha256:prepared.logSha256,observations:obs.length,
 before:summaries.reduce((s,g)=>s+g.before,0),after:summaries.reduce((s,g)=>s+g.after,0),summaries};
fs.writeFileSync(path.join(root,'archive/ve-moving/transfer-967-fixed-output.json'),JSON.stringify(out,null,2));
console.log(JSON.stringify({...out,summaries:summaries.map(s=>({...s,groups:undefined,worsenedGroups:s.groups.filter(g=>g.after>g.before+1e-10).length}))},null,2));
