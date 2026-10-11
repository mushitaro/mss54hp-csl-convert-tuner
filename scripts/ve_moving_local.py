"""Pass-cluster validation of a local direction, no output writer or AFR model."""
import json
import numpy as np
from scipy.optimize import minimize_scalar
from ve_moving_robust import ROOT,c,build

def loss(v,x,lo,hi,w):
    r=v*x[:,0]+x[:,1];r=r-np.clip(r,lo,hi);a=np.abs(r);delta=.025
    return np.sum(w*np.where(a<=delta,.5*r*r,delta*(a-.5*delta)))

def run():
    dirs=[ROOT/'archive/d1/2026-10-11-injection-check/8084903e-f8ae-432e-9440-fa61c161c8a7',ROOT/'archive/d1/2026-10-11-rf-response-check/02ef23a7-49da-4c03-b8c2-a6f5b944e7cc']
    dd=[c.m.load(d) for d in dirs];model=next(m for m in c.m.b.h.HYPOTHESES if m.name=='flow-0.25-mix')
    ds=[build(d,model) for d in dd];col=289
    out=[]
    for drive,d in enumerate(ds):
        xx=d['x'].toarray();hit=xx[:,col]>.001;t=d['times'][hit];x=np.c_[xx[hit,col],xx[hit].sum(1)-xx[hit,col]]
        lo=d['lower'][hit];hi=d['upper'][hit];w=d['weight'][hit]
        order=np.argsort(t);t=t[order];x=x[order];lo=lo[order];hi=hi[order];w=w[order]
        groups=np.cumsum(np.r_[0,np.diff(t)>5]);fit=minimize_scalar(lambda v:loss(v,x,lo,hi,w),bounds=(.3,1.7),method='bounded')
        cases=[]
        for v in [1.,.97,.95,.9,.85,.8,.75,.74,.7,fit.x]:
            passes=[]
            for g in np.unique(groups):
                mm=groups==g;before=loss(1,x[mm],lo[mm],hi[mm],w[mm]);after=loss(v,x[mm],lo[mm],hi[mm],w[mm]);
                passes.append(dict(start=float(t[mm].min()),end=float(t[mm].max()),rows=int(mm.sum()),before=float(before),after=float(after),change=float(after-before)))
            cases.append(dict(factor=float(v),loss=float(loss(v,x,lo,hi,w)),improved=sum(p['change']< -1e-9 for p in passes),worse=sum(p['change']>1e-9 for p in passes),passes=passes))
        rec=dict(session=dd[drive]['proof']['session'],fit=float(fit.x),cases=cases);out.append(rec)
        print(json.dumps(dict(session=rec['session'],fit=rec['fit'],cases=[{k:v for k,v in case.items() if k!='passes'} for case in cases])),flush=True)
    (ROOT/'archive/ve-moving/local.json').write_text(json.dumps(out,indent=2),encoding='utf-8')

if __name__=='__main__':run()
