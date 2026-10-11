/** Final BIN bytes must retain the calibration used to validate a moving VE update. */
import assert from 'node:assert/strict';
import path from 'node:path';
import {build} from 'esbuild';
const root=path.resolve(import.meta.dirname,'..');
globalThis.__movingOutput={states:[],cursor:0};
const bundle=await build({stdin:{contents:`
export {movingResponseOutputHold} from './src/lib/ve-calculator/movingResponseOutput';
export {BinaryPatcher} from './src/lib/binary-engine/patcher';
export {BinaryParser} from './src/lib/binary-engine/parser';
export {useBinaryFile} from './src/hooks/useBinaryFile';
export {correctDataChecksum} from './src/lib/checksum/dmeDataChecksum';
export {APP_CONFIG,EXPERIMENTAL_CONFIG} from './src/config/constants';`,resolveDir:root,loader:'ts'},
    bundle:true,platform:'node',format:'esm',write:false,alias:{'@':path.join(root,'src')},
    plugins:[{name:'react-state',setup(b){b.onResolve({filter:/^react$/},()=>({path:'react',namespace:'fixture'}));
        b.onLoad({filter:/.*/,namespace:'fixture'},()=>({loader:'js',contents:`const s=globalThis.__movingOutput;
        export function useState(v){const i=s.cursor++;if(!(i in s.states))s.states[i]=v;return [s.states[i],x=>s.states[i]=x];}`}));}}]});
const m=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const base=new m.BinaryPatcher(new ArrayBuffer(65536));
base.setVETableData(Array.from({length:24},()=>Array(20).fill(.7)));
base.disableMapCorrection();base.setRfKorrGateFloor(true);base.setWOTThreshold(true);base.applyChecksumCorrection();
const reference=base.getBuffer();const map={...new m.BinaryParser(reference).getVETable(),calibrationStatus:'moving-validated'};
map.data[4][9]=.68;
const built=new m.BinaryPatcher(reference);built.setVETableData(map.data);built.applyChecksumCorrection();
const output=built.getBuffer();
assert.equal(m.movingResponseOutputHold(map,reference,output),null);
assert.match(m.movingResponseOutputHold(map,null,output),/記録時BIN/);
for(const at of [0x4943,0x4a60,0x08fa,0xe90c,0xe5e4,0xd326,0x7000]){
    const wrong=output.slice(0);new Uint8Array(wrong)[at]^=1;m.correctDataChecksum(new Uint8Array(wrong));
    assert.match(m.movingResponseOutputHold(map,reference,wrong),new RegExp('0x'+at.toString(16).toUpperCase().padStart(4,'0')));
}
const shape=output.slice(0);new Uint8Array(shape)[0xd356+2]^=1;m.correctDataChecksum(new Uint8Array(shape));
assert.match(m.movingResponseOutputHold(map,reference,shape),/SHAPE/);
console.log('PASS final bytes reject missing reference, gain/sensor table-shape changes, TI_STAT, RF gate, MAP logic, axes, raw edits and a changed VE');
const independent=new m.BinaryPatcher(output);independent.setWOTThreshold(false);independent.restoreWotFuel();
independent.setWarmupTable(map);independent.applyChecksumCorrection();
assert.equal(m.movingResponseOutputHold(map,reference,independent.getBuffer()),null);
console.log('PASS independent WOT/warmup writes preserve the validated moving VE and recorded correction calibration');

const notices=[];globalThis.alert=t=>notices.push(t);
const render=()=>{globalThis.__movingOutput.cursor=0;return m.useBinaryFile();};
await render().loadFromBuffer(reference,'fixture.bin');
const settings={applyPatch:true,applyTankVentDisable:true,applyRfKorrGateDrop:true,applyWotDisable:true,writeVe:true};
assert(render().buildPatchedBuffer(map,settings,{movingReference:reference}));
assert.equal(render().buildPatchedBuffer(map,settings,{}),null);
assert.equal(render().buildPatchedBuffer(map,{...settings,applyRfKorrGateDrop:false},{movingReference:reference}),null);
assert.equal(render().buildPatchedBuffer(map,{...settings,applyPatch:false},{movingReference:reference}),null);
const shaped=map.data.map(r=>[...r]);shaped[0][0]=.8;
const mask=map.data.map(r=>r.map(()=>false));mask[0][0]=true;
assert.equal(render().buildPatchedBuffer(map,settings,{movingReference:reference,tunedShape:{grid:shaped,shaped:mask}}),null);
assert.equal(notices.length,4);
console.log('PASS the actual shared SAVE/download/WRITE builder enforces the byte guard after all writers');
delete globalThis.alert;delete globalThis.__movingOutput;
