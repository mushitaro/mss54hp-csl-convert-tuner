"""Locate concrete contradictory DME-response observations; diagnostics only."""
from pathlib import Path
import argparse,importlib.util,json,sys
import numpy as np
from scipy.sparse import csr_matrix,hstack,eye
from scipy.optimize import linprog
sys.dont_write_bytecode=True
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('commands',ROOT/'scripts/analyze-command-bounds.py')
c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)

def main(directory):
    d=c.m.load(directory.resolve());p,ints,kind=c.prepare(d)
    model=next(m for m in c.m.b.h.HYPOTHESES if m.name=='flow-0.25-mix')
    e=list(c.entries(d,p,ints,model).values());sign=np.array([1 if np.isfinite(r['upper']) else -1 for r in e])
    a=csr_matrix(np.array([r['row'] for r in e])*sign[:,None]);b=np.array([r['upper'] if s==1 else -r['lower'] for r,s in zip(e,sign)])
    nuisance=np.array([-.5 if r['bank']==1 else .5 for r in e])*sign
    a=hstack([a,csr_matrix(nuisance[:,None])]).tocsr();bounds=[(.3,1.7)]*(a.shape[1]-1)+[(-.1,.1)]
    def feasible(ids):
        z=linprog(np.zeros(a.shape[1]),A_ub=a[ids],b_ub=b[ids],bounds=bounds,method='highs',options={'time_limit':20.})
        if z.status not in [0,2]:raise RuntimeError(z.message)
        return z.status==0
    z=linprog(np.r_[np.zeros(a.shape[1]),np.ones(len(e))],A_ub=hstack([a,-eye(len(e))]),b_ub=b,
              bounds=bounds+[(0,None)]*len(e),method='highs',options={'time_limit':60.})
    if not z.success:raise RuntimeError(z.message)
    keys=['time','rpm','rawLoad','coolantTemp','intakeTemp','vehicleSpeed','rfSollDirect','rfKorrDirect','rf','stft1','stft2',
          'baFTi','injection1Ms','injection4Ms','injectionBlankActual','injectionBlankTarget','lambdaState1','lambdaState2',
          'lambdaPSteps1','lambdaPSteps2','o2Precat1Mv','o2Precat2Mv','tankVent','lambdaFreeze','ltft1','ltft2','wdk1','llsSt']
    def detail(i):
        row=e[i];r=d['raw'][row['index']];v={k:row[k] for k in ['id','index','kind','bank','time','lower','upper']};v.update(slack=float(z.x[a.shape[1]+i]),dual=float(z.ineqlin.marginals[i]),raw={k:r.get(k) for k in keys},load=d['points'][row['index']]['load']);return v
    ordered=np.argsort(-z.x[a.shape[1]:]);result=dict(session=d['proof']['session'],constraints=len(e),elasticTotal=float(z.fun),slackRows=[detail(int(i)) for i in ordered if z.x[a.shape[1]+i]>1e-7])
    print(json.dumps({k:v for k,v in result.items() if k!='slackRows'}),flush=True)
    print(json.dumps(result['slackRows'][:20]),flush=True)
    # Any strictly positive minimum elastic objective is certified by these
    # nonzero dual rows and variable bounds. Reduce that set to an IIS.
    ids=np.flatnonzero(abs(z.ineqlin.marginals)>1e-8).tolist()
    if feasible(ids):ids=list(range(len(e)))
    print('dual support',len(ids),flush=True)
    size=max(1,len(ids)//2)
    while size>=1:
        at=0
        while at<len(ids):
            keep=ids[:at]+ids[at+size:]
            if keep and not feasible(keep):ids=keep
            else:at+=size
        print('reduced',size,len(ids),flush=True)
        size//=2
    result['irreducibleConflict']=[detail(i) for i in ids]
    print(json.dumps(result['irreducibleConflict']),flush=True)
    out=ROOT/'archive/ve-conflicts'/directory.name;out.mkdir(parents=True,exist_ok=True)
    (out/'analysis.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
    np.savez_compressed(out/'constraints.npz',a=a.toarray(),b=b,rows=np.array([json.dumps({k:v for k,v in r.items() if k!='row'}) for r in e]))
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('directory',type=Path);main(p.parse_args().directory)
