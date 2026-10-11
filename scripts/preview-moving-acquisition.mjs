/** Local, synthetic visual fixture. Runs the production components without a vehicle or database. */
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { build } from 'esbuild';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';

const root = path.resolve(import.meta.dirname, '..');
const folder = path.join(root, 'archive', 'moving-acquisition-ui');
await fs.mkdir(folder, { recursive: true });
const entry = `
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {MapEditor} from './src/components/MapEditor';
import {MovingAcquisitionSummary} from './src/components/MovingAcquisitionSummary';
import {LiveDriveStrip} from './src/components/LiveDriveStrip';
const map={xAxis:[1800,2000,2100,2200,2400,2700,3000,3300,3600,3900],yAxis:[3.2,5,7.5,10,12.5,15,17.5,20,25,30,35,40],data:[]};
map.data=map.yAxis.map((_,r)=>map.xAxis.map((_,c)=>.6+(r+c)*.01));
const states=['unvisited','blocked','collecting','revisited'];
const coverage={observedRows:412,candidateRows:238,cells:map.yAxis.map((_,r)=>map.xAxis.map((_,c)=>{
const state=states[(r+c)%4];return {state,recorded:state==='unvisited'?0:28,candidates:state==='collecting'?8:state==='revisited'?16:0,passes:state==='collecting'?1:state==='revisited'?3:0,reasons:state==='blocked'?{'injection-missing':5,'warming-up':3,'fuel-cut':2,'oxygen-pending':4}:state==='unvisited'?{}:{'fuel-cut':2}};
}))};
const snapshot={sample:{rpm:2400,rawLoad:7.5,time:8},heldSec:8,hz:2,count:412};
const feed={subscribe:()=>()=>{},getSnapshot:()=>snapshot,getServerSnapshot:()=>snapshot};
function App(){const [selected,setSelected]=useState(null),[phase,setPhase]=useState('recording'),[counts,setCounts]=useState(false);return <div style={{height:'100dvh',display:'flex',flexDirection:'column',background:'#000',color:'#c6c6cf'}}>
<div style={{height:36,display:'flex',alignItems:'center',gap:12,padding:'0 8px',flexShrink:0,fontSize:11}}><strong>SYNTHETIC LIVE FIXTURE</strong><button onClick={()=>setCounts(x=>!x)}>{counts?'CURRENT':'MEASUREMENT'}</button><select aria-label="Phase" value={phase} onChange={e=>setPhase(e.target.value)}>{['recording','analyzing','unresolved','error'].map(p=><option key={p}>{p}</option>)}</select></div>
<LiveDriveStrip feed={feed} view="ve" views={['ve']} onViewChange={()=>{}} rpmAxis={map.xAxis} loadAxis={map.yAxis} acquisition={coverage} cues={false}/>
<MovingAcquisitionSummary coverage={coverage} mapData={map} selected={selected} onClose={()=>setSelected(null)} phase={phase}/>
<div style={{minHeight:0,flex:1}}><MapEditor mapData={counts?{...map,data:coverage.cells.map(row=>row.map(cell=>cell.recorded))}:map} liveAcquisition={coverage} valueLabel={counts?'RECORDED':'VE'} valueFormat={counts?String:undefined} onCellSelect={(row,col)=>setSelected({row,col})} selected={selected}/></div>
</div>};
createRoot(document.getElementById('root')).render(<App/>);
`;
await build({ stdin: { contents: entry, loader: 'tsx', resolveDir: root }, bundle: true,
    platform: 'browser', format: 'esm', outfile: path.join(folder, 'fixture.js'), alias: { '@': path.join(root, 'src') },
    define: { 'process.env.NODE_ENV': '"development"' } });
const cssPath = path.join(root, 'src', 'app', 'globals.css');
const css = await postcss([tailwind({ base: root })]).process(await fs.readFile(cssPath, 'utf8'), { from: cssPath });
await fs.writeFile(path.join(folder, 'fixture.css'), css.css);
await fs.writeFile(path.join(folder, 'frame.html'), `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Moving acquisition fixture</title><link rel="stylesheet" href="fixture.css"><body style="margin:0"><div id="root"></div><script type="module" src="fixture.js"></script></body></html>`);
await fs.writeFile(path.join(folder, 'index.html'), `<!doctype html><html><meta charset="utf-8"><title>Moving acquisition comparison</title><body style="margin:0;background:#17171c;color:#dfdfe6;font-family:sans-serif"><h3 style="margin:12px">Production components · synthetic measurements · 683 × 400 / 360 × 640</h3><div style="display:flex;gap:16px;padding:12px;align-items:start"><iframe title="Car display" src="frame.html" width="683" height="400" style="border:0"></iframe><iframe title="Phone" src="frame.html" width="360" height="640" style="border:0"></iframe></div></body></html>`);
console.log(`Prepared synthetic fixture: ${folder}`);
if (process.argv.includes('--serve')) {
    const port = Number(process.env.MOVING_UI_PORT ?? 5056);
    const allowed = new Set(['index.html', 'frame.html', 'fixture.js', 'fixture.css']);
    http.createServer(async (req, res) => {
        const name = new URL(req.url ?? '/', 'http://localhost').pathname.slice(1) || 'index.html';
        if (!allowed.has(name)) { res.writeHead(404); res.end(); return; }
        try {
            const content = await fs.readFile(path.join(folder, name));
            res.setHeader('Content-Type', name.endsWith('.js') ? 'application/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8');
            res.end(content);
        } catch { res.writeHead(404); res.end(); }
    }).listen(port, '127.0.0.1', () => console.log(`http://127.0.0.1:${port}`));
}
