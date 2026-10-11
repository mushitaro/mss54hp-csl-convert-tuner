"""Diagnose fixed pulse-duration offsets versus one normalized bank offset."""
from pathlib import Path
import argparse,importlib.util,json,sys
import numpy as np
from scipy.sparse import csr_matrix,hstack,eye
from scipy.optimize import linprog
sys.dont_write_bytecode=True
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('sensor',ROOT/'scripts/analyze-ve-conflicts-sensor.py')
s=importlib.util.module_from_spec(spec);spec.loader.exec_module(s);c=s.c

def main(directory):
    d=c.m.load(directory.resolve());p,ints,kind=c.prepare(d);raw=d['raw'];model=next(m for m in c.m.b.h.HYPOTHESES if m.name=='flow-0.25-mix')
    e=list(s.sensor_entries(d,p,ints,model,0,1115,True).values());sign=np.array([1 if np.isfinite(r['upper']) else -1 for r in e])
    a=csr_matrix(np.array([r['row'] for r in e])*sign[:,None]);rhs=np.array([r['upper'] if sg==1 else -r['lower'] for r,sg in zip(e,sign)])
    bank=np.array([-.5 if r['bank']==1 else .5 for r in e]);inv=np.array([1/(d['constant']/1000*raw[r['index']]['rfSollDirect']) for r in e]);both=np.ones(len(e))
    results=[]
    for name,columns,limits in [('constant-bank',[bank],[.1]),('pulse-offsets',[inv,bank*inv],[.4,.4]),('both',[bank,inv,bank*inv],[.1,.4,.4]),('free-banks-per-map',[bank],[1.])]:
        aa=hstack([a,csr_matrix(np.array(columns).T*sign[:,None])]).tocsr();bounds=[(.3,1.7)]*a.shape[1]+[(-v,v) for v in limits]
        res=linprog(np.r_[np.zeros(aa.shape[1]),np.ones(len(e))],A_ub=hstack([aa,-eye(len(e))]),b_ub=rhs,
            bounds=bounds+[(0,None)]*len(e),method='highs',options={'time_limit':60.})
        out=dict(variant=name,constraints=len(e),elasticTotal=float(res.fun),nuisance=res.x[a.shape[1]:aa.shape[1]].tolist(),
            violated=[dict(id=e[i]['id'],slack=float(res.x[aa.shape[1]+i])) for i in np.argsort(-res.x[aa.shape[1]:]) if res.x[aa.shape[1]+i]>1e-7]);results.append(out);print(json.dumps(out),flush=True)
    out=ROOT/'archive/ve-conflicts'/directory.name;out.mkdir(parents=True,exist_ok=True);(out/'pulse-offset-diagnostic.json').write_text(json.dumps(results,indent=2),encoding='utf-8')
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('directory',type=Path);main(p.parse_args().directory)
