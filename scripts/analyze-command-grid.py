"""Compare sparse-linear fuel and P-aware fuel on identical valid observations."""
from pathlib import Path
import argparse,importlib.util,json,sys,hashlib
import numpy as np
sys.dont_write_bytecode=True
from ve_response_grid import grid_range
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('commands',ROOT/'scripts/analyze-command-bounds.py')
c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)
m=c.m


def observations(data,p,intervals,kind,model,group,column):
    mask=np.isfinite(p['fuel_lower']).all(1)&np.isfinite(p['fuel_upper']).all(1)
    if kind=='linear':
        p={**p,'fuel':np.where(mask[:,None],p['fuel'],np.nan)}
        entries=m.entries(data,p,intervals,model)
        ff,aa,_=m.b.h.history(p['grid'],p['fuel'],p['air_cells'],p['flow'],model)
        fuel={'rich':ff,'lean':ff}
    else:
        entries=c.entries(data,p,intervals,model);fuel={}
        for side,key in [('rich','fuel_upper'),('lean','fuel_lower')]:
            fuel[side],aa,_=m.b.h.history(p['grid'],p[key],p['air_cells'],p['flow'],model)
    total=aa.sum(1);raw=data['raw'];dt=float(np.median(np.diff(p['grid'])));imap={(i['index'],i['bank']):i for i in intervals};out=[]
    for key,e in entries.items():
        if e['row'][column]<=.001:continue
        index,bank=e['index'],e['bank'];r=raw[index];side='rich' if np.isfinite(e['upper']) else 'lean'
        start=r['lambdaReadTime']-r['lambdaReadMs']/2000;end=r['lambdaReadTime']+r['lambdaReadMs']/2000;fraction=None
        if e['kind']!='point':
            start=raw[index-1]['lambdaReadTime']-raw[index-1]['lambdaReadMs']/2000
            if e['kind']=='duration':fraction=min(1,imap[index,bank]['richFractionMin' if side=='rich' else 'leanFractionMin'])
        jj=np.flatnonzero((p['grid']+dt/2>start)&(p['grid']-dt/2<end))
        weight=np.maximum(0,np.minimum(p['grid'][jj]+dt/2,end)-np.maximum(p['grid'][jj]-dt/2,start))
        out.append(dict(id=f"{data['proof']['session']}:{key}",x=aa[jj]/total[jj,None],q=fuel[side][jj,bank-1]/total[jj],
                        weight=weight,fraction=fraction,side=side,bank=bank,group=group))
    return out


def run(directories,model_name,fixed):
    data=[m.load(d.resolve()) for d in directories]
    if any(d['recording']['sha256']!=data[0]['recording']['sha256'] or d['maps']['baseline']!=data[0]['maps']['baseline'] for d in data):
        raise ValueError('Different recording calibration')
    maps=data[0]['maps'];column=maps['load'].index(7.5)*len(maps['rpm'])+maps['rpm'].index(2400);cells=np.array(maps['baseline']).size
    model=next(x for x in m.b.h.HYPOTHESES if x.name==model_name);prepared=[c.prepare(d) for d in data];results=[]
    for kind in ['linear','bounded']:
        groups=[observations(d,p,ints,kind,model,i,column) for i,(d,(p,ints,_)) in enumerate(zip(data,prepared))]
        obs=sorted([o for rows in groups for o in rows],key=lambda o:o['id'])
        result=grid_range(obs,cells,len(data),column,fixed=fixed)
        result.update(kind=kind,model=model_name,ids=[o['id'] for o in obs]);results.append(result)
        print(json.dumps({**{k:v for k,v in result.items() if k not in ['ids','results']},'results':[{k:v for k,v in r.items() if k!='witness'} for r in result['results']]}),flush=True)
    assert results[0]['ids']==results[1]['ids'],'Evidence must match in both cases'
    out=ROOT/'archive/command-bounds';out.mkdir(exist_ok=True,parents=True)
    target=out/(f'grid-{model_name}'+('' if fixed is None else f'-fixed-{fixed}')+'.json')
    target.write_text(json.dumps(dict(results=results,fixedFactor=fixed,
        sources=[dict(logSha256=d['maps']['logFileSha256'],recordingSha256=d['recording']['sha256']) for d in data],
        codeSha256={n:hashlib.sha256((ROOT/'scripts'/n).read_bytes()).hexdigest() for n in c.SOURCE_FILES+['analyze-command-grid.py','ve_response_grid.py']},
        limitations=['Finite 100 ms grid, not continuous-time feasibility.',
            'Fuel, coordinate and transport hypotheses remain conditional; targets and nuisance can co-vary.',
            'P-aware input ranges are outer bounds and need not jointly realize a single DME controller trace.']),indent=2),encoding='utf-8')


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('directories',nargs='+',type=Path)
    p.add_argument('--model',default='flow-0.25-mix');p.add_argument('--fixed',type=float)
    args=p.parse_args();run(args.directories,args.model,args.fixed)
