"""Finite-grid feasibility with time-correlated air shares and fuel bounds.

Sample/switch evidence requires at least one time alternative. Integral-time
evidence requires a weighted minimum duration. A witness is conditional on this
grid and these input intervals; it does not certify a continuous DME trajectory.
"""
import numpy as np
from scipy.sparse import coo_matrix
from scipy.optimize import milp,Bounds,LinearConstraint


def grid_range(observations, cells, nuisance_count, target, fixed=None, time_limit=30.):
    if not observations or cells<1 or nuisance_count<1 or not 0<=target<cells:
        raise ValueError('Nonempty evidence and a valid target are required')
    row=[];col=[];val=[];low=[];high=[];nv=cells+nuisance_count
    def append(coeffs,lo,hi):
        row.extend([len(low)]*len(coeffs));col.extend(coeffs);val.extend(coeffs.values());low.append(lo);high.append(hi)
    for o in observations:
        x=np.asarray(o['x'],float);q=np.asarray(o['q'],float);weights=np.asarray(o['weight'],float)
        if (x.ndim!=2 or x.shape!=(len(q),cells) or len(weights)!=len(q) or not len(q)
            or not np.isfinite(x).all() or np.any(x<0) or not np.allclose(x.sum(1),1)
            or not np.isfinite(q).all() or not np.isfinite(weights).all() or np.any(weights<=0)
            or o['side'] not in ['rich','lean'] or not 0<=o['group']<nuisance_count or o['bank'] not in [1,2]):
            raise ValueError('Invalid finite-grid observation')
        fraction=o.get('fraction')
        if fraction is not None and not 0<fraction<=1:raise ValueError('Invalid duration fraction')
        needed=1. if fraction is None else fraction*weights.sum();terms={}
        direction=1. if o['side']=='rich' else -1.
        for k in range(len(q)):
            z=nv;nv+=1;terms[z]=1. if fraction is None else float(weights[k])
            # x sums to one, factors in [.3,1.7], bank offset in [-.05,.05].
            big=max(0,1.75-q[k]) if direction>0 else max(0,q[k]-.25)
            coeff={int(j):float(direction*x[k,j]) for j in np.flatnonzero(x[k])}
            coeff[cells+o['group']]=direction*(-.5 if o['bank']==1 else .5)
            coeff[z]=big;append(coeff,-np.inf,direction*q[k]+big)
        append(terms,needed,np.inf)
    matrix=coo_matrix((val,(row,col)),shape=(len(low),nv)).tocsc()
    bl=np.r_[np.full(cells,.3),np.full(nuisance_count,-.1),np.zeros(nv-cells-nuisance_count)]
    bu=np.r_[np.full(cells,1.7),np.full(nuisance_count,.1),np.ones(nv-cells-nuisance_count)]
    if fixed is not None:
        if not .3<=fixed<=1.7:raise ValueError('Invalid fixed factor')
        bl[target]=bu[target]=fixed
    answers=[]
    for direction in ([1] if fixed is not None else [1,-1]):
        objective=np.zeros(nv);objective[target]=direction
        result=milp(objective,integrality=np.r_[np.zeros(cells+nuisance_count),np.ones(nv-cells-nuisance_count)],
            bounds=Bounds(bl,bu),constraints=LinearConstraint(matrix,np.array(low),np.array(high)),
            options={'time_limit':time_limit,'mip_rel_gap':1e-6})
        item=dict(status=int(result.status),message=str(result.message),factor=None,witness=None)
        if result.x is not None:
            predicted=matrix@result.x
            violation=max(float(np.max(predicted-np.array(high))),float(np.max(np.array(low)-predicted)),0.)
            if violation>2e-6:raise RuntimeError('Grid witness violated its constraints')
            item.update(factor=float(result.x[target]),witness=result.x[:cells+nuisance_count].tolist(),maximumViolation=violation,
                        dualBound=float(result.mip_dual_bound))
        answers.append(item)
        if result.status==2:break
    return dict(results=answers,observations=len(observations),variables=nv,inequalities=len(low),
                range=[answers[0]['factor'],answers[-1]['factor']] if fixed is None and len(answers)==2 and all(r['status']==0 for r in answers) else None)
