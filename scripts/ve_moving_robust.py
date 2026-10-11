"""Independent moving-history robust update experiment; never writes calibration.

Soft interval residuals measure conditional command/reference mismatch, not AFR.
All observed rich, lean, controller-duration and hidden-switch bounds participate.
"""
from pathlib import Path
import importlib.util,json,sys
import numpy as np
from scipy.sparse import csr_matrix,hstack,vstack,diags
from scipy.optimize import minimize
from threadpoolctl import threadpool_limits
threadpool_limits(1);sys.dont_write_bytecode=True
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('command',ROOT/'scripts/analyze-command-bounds.py')
c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)

def build(d,model):
    p,ints,kind=c.prepare(d)
    ee=list(c.entries(d,p,ints,model).values())
    x=csr_matrix(np.array([e['row'] for e in ee]))
    times=np.array([e['time'] for e in ee]); bank=np.array([-.5 if e['bank']==1 else .5 for e in ee])
    # A chronological 10-second cluster receives one unit of information, so
    # denser recording does not by itself imply stronger independent evidence.
    cluster=np.floor(times/10).astype(int)
    counts=np.bincount(cluster);weights=1/counts[cluster]
    return dict(x=x,lower=np.array([e['lower'] for e in ee]),upper=np.array([e['upper'] for e in ee]),
        times=times,bank=bank,weight=weights,cluster=cluster,ids=[e['id'] for e in ee])

def smooth_matrix(shape,baseline,kind):
    rows=[];n=np.prod(shape)
    for r in range(shape[0]):
        for col in range(shape[1]):
            for dr,dc in [(0,1),(1,0)]:
                if not (0<=r-dr and r+dr<shape[0] and 0<=col-dc and col+dc<shape[1]):continue
                row=np.zeros(n);j=r*shape[1]+col
                row[j]=-2;row[(r-dr)*shape[1]+col-dc]=1;row[(r+dr)*shape[1]+col+dc]=1
                if kind=='absolute':row*=baseline
                rows.append(row)
    return csr_matrix(rows)

def fit(d,baseline,smooth,penalty,mask=None,delta=.025):
    if mask is None:mask=np.ones(len(d['lower']),bool)
    x=d['x'][mask];bank=d['bank'][mask];lo=d['lower'][mask];hi=d['upper'][mask];w=d['weight'][mask]
    xx=hstack([x,csr_matrix(bank[:,None])]).tocsr();n=x.shape[1]
    # Only information-bearing cells move. A smoothness prior never fabricates
    # a recommendation in cells absent from the training data.
    used=np.asarray(x.power(2).T@w).ravel()>.003
    bounds=[(.3,1.7) if u else (1.,1.) for u in used]+[(-.1,.1)]
    def fun(z):
        f=z[:-1];v=xx@z;r=v-np.clip(v,lo,hi);a=np.abs(r);g=np.clip(r,-delta,delta)*w
        loss=np.sum(w*np.where(a<=delta,.5*r*r,delta*(a-.5*delta)))
        s=smooth@f
        loss+=.5*penalty*np.sum(s*s)+.5*1e-5*np.sum((f-1)**2)+.5*.05*z[-1]**2
        grad=np.asarray(xx.T@g).ravel();grad[:-1]+=penalty*np.asarray(smooth.T@s).ravel()+1e-5*(f-1);grad[-1]+=.05*z[-1]
        return loss,grad
    z=minimize(fun,np.r_[np.ones(n),0.],jac=True,bounds=bounds,method='L-BFGS-B',options=dict(maxiter=1000,ftol=1e-12,gtol=1e-8))
    if not z.success:print('FIT_WARN',z.message,flush=True)
    return z.x

def score(d,z,mask=None):
    if mask is None:mask=np.ones(len(d['lower']),bool)
    v=d['x'][mask]@z[:-1]+d['bank'][mask]*z[-1];r=v-np.clip(v,d['lower'][mask],d['upper'][mask]);w=d['weight'][mask]
    return dict(rms=float(np.sqrt(np.average(r*r,weights=w))),mae=float(np.average(np.abs(r),weights=w)),rows=int(mask.sum()))

def run():
    dirs=[ROOT/'archive/d1/2026-10-11-injection-check/8084903e-f8ae-432e-9440-fa61c161c8a7',
        ROOT/'archive/d1/2026-10-11-rf-response-check/02ef23a7-49da-4c03-b8c2-a6f5b944e7cc']
    datas=[c.m.load(p) for p in dirs];maps=datas[0]['maps'];base=np.array(maps['baseline']);flat=base.ravel();n=len(flat)
    target=maps['load'].index(7.5)*len(maps['rpm'])+maps['rpm'].index(2400)
    models=[m for m in c.m.b.h.HYPOTHESES if m.name in ['instant','delay-0.5','flow-0.25','flow-0.25-mix','flow-0.5-mix']]
    records=[]
    for model in models:
        ds=[build(d,model) for d in datas]
        for kind in ['factor','absolute']:
            smooth=smooth_matrix(base.shape,flat,kind)
            for penalty in [.0001,.001,.01,.1]:
                fit968=fit(ds[0],flat,smooth,penalty); fit967=fit(ds[1],flat,smooth,penalty)
                result=dict(model=model.name,kind=kind,penalty=penalty,factor968=float(fit968[target]),factor967=float(fit967[target]),
                    current968=score(ds[0],np.r_[np.ones(n),0.]),current967=score(ds[1],np.r_[np.ones(n),0.]),
                    test967=score(ds[1],fit968),test968=score(ds[0],fit967))
                # Bank imbalance is session-specific: also evaluate a zero-bank
                # transfer, so transporting it cannot hide cell performance.
                fit968[-1]=0.;result['test967ZeroBank']=score(ds[1],fit968)
                result['map968']=(fit968[:-1]*flat).reshape(base.shape).tolist()
                records.append(result);print(json.dumps({k:v for k,v in result.items() if k!='map968'}),flush=True)
    out=ROOT/'archive/ve-moving';out.mkdir(exist_ok=True,parents=True)
    (out/'robust.json').write_text(json.dumps(dict(target=target,results=records),indent=2),encoding='utf-8')

if __name__=='__main__':run()
