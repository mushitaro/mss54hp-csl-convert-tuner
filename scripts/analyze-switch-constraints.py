"""Can observed O2 crossings identify cell amounts without a fixed dwell?

Only observed opposite-side pairs with no reset/multiple P steps are used.
Crossings produce conditional fuel=air constraints; their timing is bracketed.
No rich-voltage-to-AFR conversion and no requirement for two cycles in one cell.
"""
import argparse
import importlib.util
import json
from pathlib import Path
import sys
import hashlib
import numpy as np
from scipy.optimize import lsq_linear

sys.dont_write_bytecode=True
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('history_analysis',Path(__file__).with_name('analyze-response-history.py'))
a=importlib.util.module_from_spec(spec);spec.loader.exec_module(a)
h=a.h


def run(directory, nominal=False):
    read=a.old.read
    raw=read(directory/'log.json');raw=raw if isinstance(raw,list) else raw['data']
    session=read(directory/'session.json')
    dd=ROOT/'archive'/('dme-response-flash-context' if nominal else 'dme-response')/directory.name
    maps=read(dd/'maps.json');points=read(dd/'points.json');cal=read(dd/'analysis.json')['calibration']
    if hashlib.sha256((directory/'base.bin').read_bytes()).hexdigest()!=maps['baseSha256'] or maps['baseSha256']!=session['baseSha256']:
        raise ValueError('BASE provenance differs')
    if hashlib.sha256((directory/'log.json').read_bytes()).hexdigest()!=maps['logFileSha256']:
        raise ValueError('Log provenance differs')
    reference=None
    if nominal:
        ns=importlib.util.spec_from_file_location('nominal',Path(__file__).with_name('analyze-nominal-response.py'))
        n=importlib.util.module_from_spec(ns);ns.loader.exec_module(n)
        ti_const,reference=n.reference(directory)
        p=n.prepare_nominal(raw,points,maps,cal,ti_const)
    else:p=a.prepare(raw,points,maps,cal)
    events=[]
    for bank in [0,1]:
        for i in range(1,len(raw)):
            before,after=raw[i-1],raw[i]
            labels=p['labels'][[i-1,i],bank]
            if not np.isfinite(labels).all() or labels[0]==labels[1]:continue
            if not p['score'][i-1] or not p['score'][i]:continue
            delta=after[f'lambdaPSteps{bank+1}']-before[f'lambdaPSteps{bank+1}']
            if not 0<=delta<=1 or after[f'lambdaPSteps{bank+1}']>=255:continue
            lo=before['lambdaReadTime']-before['lambdaReadMs']/2000
            hi=after['lambdaReadTime']+after['lambdaReadMs']/2000
            if hi-lo>1.8:continue
            events.append(dict(bank=bank,index=i,lo=lo,hi=hi,direction='rich-to-lean' if labels[0] else 'lean-to-rich'))
    events.sort(key=lambda e:(e['lo'],e['bank']))
    full={}
    # Prior transfer hypotheses; these are sensitivity scenarios, not selected
    # physical constants. Testing all event times keeps uncertainty visible.
    for boundary in [0.,.5,1.]:
        for model in [h.Hypothesis(f'delay-{d}',delay=d) for d in [0.,.25,.5,1.]]:
            observed=np.array([e['lo']+boundary*(e['hi']-e['lo']) for e in events])
            pp={**p,'observed':observed,'labels':np.ones((len(events),2)),'score':np.ones(len(events),bool)}
            f=a.features(pp,model,'fuel')
            select=np.array([(int(i)%2)==events[int(i)//2]['bank'] for i in f['ids']])
            f={key:value[select] for key,value in f.items()}
            f['ids']=f['ids']//2
            full[(boundary,model.name)]=f
    ids=np.array(sorted(set.intersection(*[set(d['ids']) for d in full.values()])),int)
    if not len(ids):raise ValueError('No common events')
    data={k:a.take(d,ids) for k,d in full.items()}
    used=np.flatnonzero(sum(d['x'].sum(axis=0) for d in data.values())>1e-10)
    output=[]
    for (boundary,name),d in data.items():
        x=d['x'][:,used];target=np.exp(d['z'])
        # Linear positive factors. Keep the prior explicit and vary it instead of
        # pretending the minimum-change solution is a measured cell correction.
        for ridge in [.01,.1,1.]:
            design=np.vstack([x,np.sqrt(ridge)*np.eye(len(used))])
            response=np.r_[target,np.full(len(used),np.sqrt(ridge))]
            fit=lsq_linear(design,response,bounds=(.3,1.7),tol=1e-9,max_iter=500)
            if not fit.success:raise RuntimeError(fit.message)
            cells=[]
            for row,load in enumerate(maps['load']):
                for c,rpm in enumerate(maps['rpm']):
                    if not(7.5<=load<=10 and 2200<=rpm<=2700):continue
                    cell=row*len(maps['rpm'])+c;where=np.flatnonzero(used==cell)
                    if not len(where):cells.append(dict(rpm=rpm,load=load,count=0,factor=None));continue
                    col=int(where[0]);hit=x[:,col]>.01
                    cells.append(dict(rpm=rpm,load=load,count=int(hit.sum()),weight=float(x[:,col].sum()),
                        factor=float(fit.x[col]),maxWeight=float(x[:,col].max()),
                        richToLean=sum(events[j]['direction']=='rich-to-lean' for j in ids[hit]),
                        leanToRich=sum(events[j]['direction']=='lean-to-rich' for j in ids[hit]),
                        rowIndices=[events[j]['index'] for j in ids[hit]]))
            output.append(dict(boundary=boundary,transport=name,ridge=ridge,
                fitRmse=float(np.sqrt(np.mean((x@fit.x-target)**2))),cells=cells))
    result=dict(session=session['seq'],baseSha256=maps['baseSha256'],logFileSha256=maps['logFileSha256'],
        observedCrossings=len(events),commonCrossings=len(ids),scenarios=output,nominalReference=reference,
        scriptSha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        limitations=['Threshold-pair events are interval censored; multiple unobserved O2 excursions remain possible.',
            'Fuel=air at crossing is conditional on the transport/injector model; no true AFR is recorded.',
            'Sensitivity fits use all events to inspect identifiability, not held-out prediction validation.',
            'Factors modify the logged effective-air model, not a validated nominal VE table.',
            'No fixed point, cycle count, or rf_korr dwell gate is imposed.'])
    out=ROOT/'archive'/('nominal-switch-constraints' if nominal else 'switch-constraints')/directory.name;out.mkdir(parents=True,exist_ok=True)
    (out/'analysis.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    (out/'events.json').write_text(json.dumps(dict(events=events,commonIds=ids.tolist())),encoding='utf-8')
    def factor_range(rpm,load):
        values=[c['factor'] for s in output for c in s['cells'] if c['rpm']==rpm and c['load']==load and c['factor'] is not None]
        return [min(values),max(values)] if values else None
    print(json.dumps(dict(events=len(events),common=len(ids),cells=[dict(rpm=rpm,load=load,
        factorRange=factor_range(rpm,load),
        countRange=[min(c['count'] for s in output for c in s['cells'] if c['rpm']==rpm and c['load']==load),
                    max(c['count'] for s in output for c in s['cells'] if c['rpm']==rpm and c['load']==load)])
        for load in [7.5,10] for rpm in [2200,2400,2700]])),flush=True)


if __name__=='__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('session_directory',type=Path)
    p.add_argument('--nominal',action='store_true')
    args=p.parse_args();run(args.session_directory.resolve(),args.nominal)
