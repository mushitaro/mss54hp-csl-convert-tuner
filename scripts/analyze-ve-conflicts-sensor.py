"""Diagnose omission of the DME's nonlinear-voltage pre-cat sensor filter.

This script uses necessary sign-occurrence constraints, not voltage-to-AFR.
The recorded filter divisor is 8. The enclosing voltage range is an explicit
scenario because the full ADC/overlay timing chain is not certified here.
"""
from pathlib import Path
import argparse,importlib.util,json,sys
import numpy as np
from scipy.sparse import csr_matrix,hstack,eye
from scipy.optimize import linprog
sys.dont_write_bytecode=True
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('commands',ROOT/'scripts/analyze-command-bounds.py')
c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)

def max_age(voltage,rich,threshold,minimum=0,maximum=1115):
    # Counterfactual: no classified-raw input for N ticks. The extreme initial
    # state and the closest opposite-side integer input maximize old-sign memory.
    y=maximum if rich else minimum;target=threshold-1 if rich else threshold+1
    for n in range(1,200):
        delta=target-y;step=int(delta/8)
        if not step:step=int(np.sign(delta))
        y+=step
        if (rich and y<voltage) or (not rich and y>voltage):return n*.01
    raise ValueError('Cannot bound occurrence age')

def verify_sensor_occurrence(seed=968):
    """Independent integer-filter simulation, including random held input runs."""
    rng=np.random.default_rng(seed);checks=0
    for trial in range(100):
        voltage=int(rng.integers(0,1116));history=[];value=0
        for tick in range(2000):
            if tick%int(rng.integers(1,40))==0:value=int(rng.integers(0,1116))
            history.append(value);delta=value-voltage;step=int(delta/8)
            voltage+=step if step else int(np.sign(delta))
            if tick<100 or 400<voltage<510:continue
            rich=voltage>=510;threshold=510 if rich else 400
            count=round(max_age(voltage,rich,threshold)/.01)
            recent=history[-count:]
            assert any(x>=threshold for x in recent) if rich else any(x<=threshold for x in recent)
            checks+=1
    return dict(passed=True,checkedObservations=checks,seed=seed)

def sensor_entries(data,p,intervals,model,minimum,maximum,strict_controller=False):
    es={} if strict_controller else {k:v for k,v in c.entries(data,p,intervals,model).items() if v['kind']!='point'}
    transformed=[]
    for key in ['fuel_lower','fuel_upper']:
        ff,aa,_=c.m.b.h.history(p['grid'],p[key],p['air_cells'],p['flow'],model)
        total=aa.sum(1);valid=np.isfinite(ff).all(1)&np.isfinite(aa).all(1)&(total>0)&(ff>0).all(1)
        transformed.append((ff,aa,total,valid))
    dt=float(np.median(np.diff(p['grid'])));cal=data['proof']['calibration']
    requests=[]
    for i,r in enumerate(data['raw']):
        if not p['score'][i]:continue
        for bank in [1,2]:
            label=p['labels'][i,bank-1]
            if not np.isfinite(label):continue
            rich=label==1;threshold=cal['richMv'] if rich else cal['leanMv'];age=max_age(r['o2Precat'+str(bank)+'Mv'],rich,threshold,minimum,maximum)
            end=r['lambdaReadTime']+r['lambdaReadMs']/2000;start=r['lambdaReadTime']-r['lambdaReadMs']/2000-age
            requests.append((i,bank,rich,start,end,'point',age))
        if not strict_controller or not i or not p['score'][i-1]:continue
        prev=data['raw'][i-1]
        if not 0<r['lambdaReadTime']-prev['lambdaReadTime']<=1.5:continue
        for bank in [1,2]:
            counts=[prev['lambdaPSteps'+str(bank)],r['lambdaPSteps'+str(bank)]]
            if not 3<=counts[1]-counts[0] or max(counts)>=255:continue
            for rich in [True,False]:
                threshold=cal['richMv'] if rich else cal['leanMv'];age=max_age(threshold,rich,threshold,minimum,maximum)
                start=prev['lambdaReadTime']-prev['lambdaReadMs']/2000-age;end=r['lambdaReadTime']+r['lambdaReadMs']/2000
                requests.append((i,bank,rich,start,end,'fresh-switch',age))
    for i,bank,rich,start,end,kind,age in requests:
            jj=np.flatnonzero((p['grid']+dt/2>start)&(p['grid']-dt/2<end));ff,aa,total,valid=transformed[1 if rich else 0]
            if not len(jj) or not valid[jj].all():continue
            covered=np.maximum(0,np.minimum(p['grid'][jj]+dt/2,end)-np.maximum(p['grid'][jj]-dt/2,start)).sum()
            if abs(covered-(end-start))>1e-7:continue
            for row,lo,hi in c.m.b.sample_envelope(aa[jj]/total[jj,None],ff[jj,bank-1]/total[jj],rich):
                side='rich' if rich else 'lean';key=f'{kind}:{i}:{bank}:{side}'
                es[key]=dict(id=key,index=i,bank=bank,kind=kind,time=(start+end)/2,row=row,lower=lo,upper=hi,sensorAge=age)
    return es

def main(directory,all_models=False,strict_controller=False):
    d=c.m.load(directory.resolve());p,ints,kind=c.prepare(d);models=c.m.b.h.HYPOTHESES if all_models else [m for m in c.m.b.h.HYPOTHESES if m.name=='flow-0.25-mix'];results=[]
    for model in models:
      for minimum,maximum in [(0,1115)]:
        ee=list(sensor_entries(d,p,ints,model,minimum,maximum,strict_controller).values())
        for selection in ['all','point','controller-only']:
            entries=[r for r in ee if selection=='all' or selection==r['kind'] or selection=='controller-only' and r['kind']!='point']
            if not entries:continue
            sign=np.array([1 if np.isfinite(r['upper']) else -1 for r in entries]);a=csr_matrix(np.array([r['row'] for r in entries])*sign[:,None]);b=np.array([r['upper'] if s==1 else -r['lower'] for r,s in zip(entries,sign)])
            nuisance=np.array([-.5 if r['bank']==1 else .5 for r in entries])*sign
            a=hstack([a,csr_matrix(nuisance[:,None])]).tocsr();bounds=[(.3,1.7)]*(a.shape[1]-1)+[(-.1,.1)]
            res=linprog(np.r_[np.zeros(a.shape[1]),np.ones(len(entries))],A_ub=hstack([a,-eye(len(entries))]),b_ub=b,
              bounds=bounds+[(0,None)]*len(entries),method='highs',options={'time_limit':60.})
            out=dict(model=model.name,selection=selection,constraints=len(entries),elasticTotal=float(res.fun),
                     violated=[dict(id=entries[i]['id'],slack=float(res.x[a.shape[1]+i])) for i in np.argsort(-res.x[a.shape[1]:]) if res.x[a.shape[1]+i]>1e-7])
            results.append(out);print(json.dumps({k:v for k,v in out.items() if k!='violated'}|dict(violated=len(out['violated']))),flush=True)
    out=ROOT/'archive/ve-conflicts'/directory.name;out.mkdir(exist_ok=True,parents=True)
    (out/(('strict-' if strict_controller else '')+('sensor-all.json' if all_models else 'sensor.json'))).write_text(json.dumps(results,indent=2),encoding='utf-8')
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('directory',type=Path,nargs='?');p.add_argument('--all-models',action='store_true');p.add_argument('--strict-controller',action='store_true');p.add_argument('--verify',action='store_true');args=p.parse_args()
    if args.verify:print(json.dumps(verify_sensor_occurrence()))
    elif args.directory:main(args.directory,args.all_models,args.strict_controller)
    else:p.error('a session directory or --verify is required')
