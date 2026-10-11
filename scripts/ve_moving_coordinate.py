"""Finite coordinate proposal validated on each affected pass and bank."""
import json,sys
import numpy as np
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]

def rows_loss(pred,lo,hi,weight):
    r=pred-np.clip(pred,lo,hi);a=np.abs(r);delta=.025
    return weight*np.where(a<=delta,.5*r*r,delta*(a-.5*delta))

def main():
    prefix='command-sensor' if '--sensor' in sys.argv else 'command'
    ds=[np.load(ROOT/'archive/ve-moving'/f'{prefix}-{session}.npz') for session in [968,967]]
    x=np.concatenate([d['x'] for d in ds]);lo=np.concatenate([d['lower'] for d in ds]);hi=np.concatenate([d['upper'] for d in ds]);w=np.concatenate([d['weight'] for d in ds]);t=np.concatenate([d['times'] for d in ds]);bank=np.concatenate([d['bank'] for d in ds]);drive=np.concatenate([np.full(len(d['times']),i) for i,d in enumerate(ds)])
    current=x.sum(1);base_loss=rows_loss(current,lo,hi,w);f=np.ones(x.shape[1]);eligible=[];details=[]
    def check(col,v,pred,comparison):
        hit=x[:,col]>1e-9;indices=np.flatnonzero(hit);tc=t[hit];bc=bank[hit];dc=drive[hit]
        candidate=pred[hit]+x[hit,col]*v;after=rows_loss(candidate,lo[hit],hi[hit],w[hit]);change=after-comparison[hit]
        improve=[0,0];groups=[]
        for dr in [0,1]:
            ii=np.flatnonzero(dc==dr);order=ii[np.argsort(tc[ii])];g=np.cumsum(np.r_[0,np.diff(tc[order])>5])
            for k in np.unique(g):
                for b in [1,2]:
                    jj=order[(g==k)&(bc[order]==b)]
                    if not len(jj):continue
                    delta=float(change[jj].sum());groups.append(delta)
                    if delta < -1e-10:improve[b-1]+=1
        return dict(delta=float(change.sum()),worst=max(groups,default=0),improve=improve,valid=min(improve)>=2 and max(groups,default=0)<=1e-10)
    for j in range(x.shape[1]):
        if not np.any(x[:,j]>.001):continue
        candidates=[(v,check(j,v,current,base_loss)) for v in [-.05,.05]]
        v,best=min(candidates,key=lambda z:z[1]['delta'])
        if best['valid']:eligible.append((best['delta'],j,v,best))
    for _,j,v,initial in sorted(eligible):
        losses=rows_loss(current,lo,hi,w);final=check(j,v,current,losses)
        if final['valid']:
            f[j]+=v;current+=x[:,j]*v
        details.append(dict(column=j,step=v,initial=initial,final=final,accepted=final['valid']))
    after=rows_loss(current,lo,hi,w)
    out=dict(prefix=prefix,accepted=int(np.sum(f!=1)),factors=f.tolist(),details=details,before=float(base_loss.sum()),after=float(after.sum()),target=float(f[289]),perDrive=[dict(session=s,before=float(base_loss[drive==i].sum()),after=float(after[drive==i].sum())) for i,s in enumerate([968,967])])
    print(json.dumps({k:v for k,v in out.items() if k not in ['details','factors']}));print('accepted',[(d['column'],d['step']) for d in details if d['accepted']])
    (ROOT/'archive/ve-moving'/(prefix+'-coordinate.json')).write_text(json.dumps(out,indent=2),encoding='utf-8')

if __name__=='__main__':main()
