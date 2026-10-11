"""Direct VE-command-ratio prototype; fixed recorded nonlambda factors.

Both the candidate reference and actual fuel share the observed nonlambda
command B=TI/injectionSTFT. No extra rf_korr restoration is applied.
"""
import json,importlib.util,sys
import numpy as np
from scipy.sparse import csr_matrix
from scipy.optimize import minimize_scalar
from ve_moving_robust import ROOT,c
from ve_moving_local import loss

def build(data,model,sensor=False):
    p,ints,kind=c.prepare(data);raw=data['raw'];col=lambda key:np.array([r[key] for r in raw],float)
    basis=p['air_cells']/p['air_cells'].sum(1)[:,None]
    if kind=='measured-command':
        it=col('injectionReadTime');u=np.c_[col('injectionStft1'),col('injectionStft2')]
        ti=np.c_[np.mean([col('injection'+str(j)+'Ms') for j in [1,2,3]],axis=0),np.mean([col('injection'+str(j)+'Ms') for j in [4,5,6]],axis=0)]
        base=c.m.b.h.interpolate(p['grid'],it,ti/u)
        rpm=c.m.b.h.interpolate(p['grid'],col('standardReadTime'),col('rpm'))
        # The potential command reference is nonzero during fuel cut. Actual
        # fuel_lower/upper already contain the cut fraction from c.prepare.
        base*=rpm[:,None]/120
    else:
        u=c.m.b.h.interpolate(p['grid'],col('lambdaReadTime'),np.c_[col('stft1'),col('stft2')]);base=p['fuel']/u
    entries=[]
    for bank in [1,2]:
        pp={**p,'air_cells':basis*base[:,bank-1,None]}
        if sensor:
            spec=importlib.util.spec_from_file_location('sensor',ROOT/'scripts/analyze-ve-conflicts-sensor.py');ss=importlib.util.module_from_spec(spec);spec.loader.exec_module(ss)
            ee=ss.sensor_entries(data,pp,ints,model,0,1115,strict_controller=True)
        else:ee=c.entries(data,pp,ints,model)
        entries.extend(e for e in ee.values() if e['bank']==bank)
    x=csr_matrix(np.array([e['row'] for e in entries]));t=np.array([e['time'] for e in entries]);clusters=np.floor(t/10).astype(int);weight=1/np.bincount(clusters)[clusters]
    return dict(x=x,times=t,lower=np.array([e['lower'] for e in entries]),upper=np.array([e['upper'] for e in entries]),
        bank=np.array([e['bank'] for e in entries]),weight=weight,ids=[e['id'] for e in entries])

def run():
    dirs=[ROOT/'archive/d1/2026-10-11-injection-check/8084903e-f8ae-432e-9440-fa61c161c8a7',ROOT/'archive/d1/2026-10-11-rf-response-check/02ef23a7-49da-4c03-b8c2-a6f5b944e7cc']
    sensor='--sensor' in sys.argv;prefix='command-strict-sensor' if sensor else 'command'
    output=[];model=next(m for m in c.m.b.h.HYPOTHESES if m.name=='flow-0.25-mix')
    for directory in dirs:
        data=c.m.load(directory);d=build(data,model,sensor);xx=d['x'].toarray();hit=xx[:,289]>.001;rec=[]
        for bank in [0,1,2]:
            keep=hit if bank==0 else hit&(d['bank']==bank)
            t=d['times'][keep];x=np.c_[xx[keep,289],xx[keep].sum(1)-xx[keep,289]];lo=d['lower'][keep];hi=d['upper'][keep];w=d['weight'][keep]
            order=np.argsort(t);t=t[order];x=x[order];lo=lo[order];hi=hi[order];w=w[order]
            groups=np.cumsum(np.r_[0,np.diff(t)>5]);fit=minimize_scalar(lambda v:loss(v,x,lo,hi,w),bounds=(.3,1.7),method='bounded');cases=[]
            for v in [1.,.97,.95,.9,.85,.8,.75,.7,float(fit.x)]:
                passes=[]
                for g in np.unique(groups):
                    mm=groups==g;before=loss(1,x[mm],lo[mm],hi[mm],w[mm]);after=loss(v,x[mm],lo[mm],hi[mm],w[mm])
                    passes.append(dict(start=float(t[mm].min()),end=float(t[mm].max()),rows=int(mm.sum()),before=float(before),after=float(after),change=float(after-before)))
                cases.append(dict(factor=v,loss=float(loss(v,x,lo,hi,w)),improved=sum(p['change']< -1e-9 for p in passes),worse=sum(p['change']>1e-9 for p in passes),passes=passes))
            result=dict(bank=bank,rows=len(x),fit=float(fit.x),cases=cases);rec.append(result)
            print(json.dumps(dict(session=data['proof']['session'],**{k:v for k,v in result.items() if k!='cases'},cases=[{k:v for k,v in case.items() if k!='passes'} for case in cases])),flush=True)
        np.savez_compressed(ROOT/'archive/ve-moving'/(prefix+'-'+str(data['proof']['session'])+'.npz'),x=xx,lower=d['lower'],upper=d['upper'],times=d['times'],bank=d['bank'],weight=d['weight'])
        output.append(dict(session=data['proof']['session'],results=rec))
    (ROOT/'archive/ve-moving'/(prefix+'.json')).write_text(json.dumps(output,indent=2),encoding='utf-8')

if __name__=='__main__':run()
