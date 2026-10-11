"""Test known DME pulse shaping versus linear pulse-as-fuel assumptions."""
from pathlib import Path
import argparse,importlib.util,json,sys
import numpy as np
from scipy.interpolate import RegularGridInterpolator
from scipy.sparse import csr_matrix,hstack,eye
from scipy.optimize import linprog
sys.dont_write_bytecode=True
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('commands',ROOT/'scripts/analyze-command-bounds.py')
c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)

def main(directory):
    d=c.m.load(directory.resolve());p,ints,kind=c.prepare(d)
    model=next(m for m in c.m.b.h.HYPOTHESES if m.name=='flow-0.25-mix')
    image=(ROOT/'archive/dme-response-flash-context'/directory.name/'recorded-flash.bin').read_bytes()
    node=next(n for n in json.loads((ROOT/'public/data/calibration-graph.json').read_text(encoding='utf-8'))['nodes'] if n.get('name')=='KF_TI_N_RF')
    def decode(axis):
        z=node['axes'][axis];size=z['bits']//8;count=z.get('n',z.get('rows',1)*z.get('cols',1))
        v=np.array([int.from_bytes(image[z['addr']+i*size:z['addr']+(i+1)*size],'big') for i in range(count)],float)
        return v/({'x':1,'y':1000,'z':128}[axis])
    x=decode('x');y=decode('y');z=decode('z').reshape(len(y),len(x));interp=RegularGridInterpolator((y,x),z,bounds_error=False)
    raw=d['raw'];col=lambda k:np.array([r[k] for r in raw],float);tt=col('standardReadTime')
    rpm=c.m.b.h.interpolate(p['grid'],tt,col('rpm'));rf=c.m.b.h.interpolate(p['grid'],tt,col('rf')/100)
    fac=interp(np.c_[np.clip(rf,y[0],y[-1]),np.clip(rpm,x[0],x[-1])])
    pp={**p,'fuel_lower':p['fuel_lower']/fac[:,None],'fuel_upper':p['fuel_upper']/fac[:,None]}
    results=[]
    for name,prepared in [('original',p),('pulse-compensation-removed',pp)]:
        ee=list(c.entries(d,prepared,ints,model).values())
        for selection in ['all','point','duration','switch','outside-short-pulse','ba-one','throttle-open']:
            entries=[r for r in ee if selection=='all' or selection==r['kind'] or
                     selection=='outside-short-pulse' and raw[r['index']]['rf']>=15 or
                     selection=='ba-one' and raw[r['index']]['baFTi']==1 or
                     selection=='throttle-open' and raw[r['index']]['wdk1']>=1]
            sign=np.array([1 if np.isfinite(r['upper']) else -1 for r in entries]);a=csr_matrix(np.array([r['row'] for r in entries])*sign[:,None]);b=np.array([r['upper'] if s==1 else -r['lower'] for r,s in zip(entries,sign)])
            nuisance=np.array([-.5 if r['bank']==1 else .5 for r in entries])*sign
            a=hstack([a,csr_matrix(nuisance[:,None])]).tocsr();bounds=[(.3,1.7)]*(a.shape[1]-1)+[(-.1,.1)]
            res=linprog(np.r_[np.zeros(a.shape[1]),np.ones(len(entries))],A_ub=hstack([a,-eye(len(entries))]),b_ub=b,
              bounds=bounds+[(0,None)]*len(entries),method='highs',options={'time_limit':60.})
            out=dict(variant=name,selection=selection,constraints=len(entries),elasticTotal=float(res.fun),
                     violated=[dict(id=entries[i]['id'],slack=float(res.x[a.shape[1]+i])) for i in np.argsort(-res.x[a.shape[1]:]) if res.x[a.shape[1]+i]>1e-7])
            results.append(out);print(json.dumps(out),flush=True)
    out=ROOT/'archive/ve-conflicts'/directory.name;out.mkdir(exist_ok=True,parents=True)
    (out/'input-variants.json').write_text(json.dumps(results,indent=2),encoding='utf-8')
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('directory',type=Path);main(p.parse_args().directory)
