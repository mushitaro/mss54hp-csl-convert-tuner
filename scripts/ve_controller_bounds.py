"""Information supplied by executed DME P updates between sparse reads.

0401 slave 01d6a2 / 01dc42: an executed P clears its pending bit. Rearming
requires a sign transition. Two executions therefore require BOTH signs in
their enclosing interval, even when the executed P directions are identical.
One execution can be a pending update armed before the interval: no such claim.
Caller must exclude reset, counter saturation/wrap and unknown read windows.
"""
import numpy as np
from scipy.sparse import csr_matrix, hstack, vstack
from scipy.optimize import linprog
from ve_response_bounds import sample_envelope, validate


def switch_envelope(design, ratio, executed_steps):
    if not isinstance(executed_steps,int) or not 0<=executed_steps<255:
        raise ValueError('An unsaturated executed-P counter difference is required')
    if executed_steps<2:
        return []
    return sample_envelope(design,ratio,True)+sample_envelope(design,ratio,False)


def feasible_range(bands, column, nuisance=None, factor_bounds=(.3,1.7), nuisance_bound=.1):
    """Unpenalized conditional identification, without fitted residual allowances.

    Every supplied inequality must hold. Inconsistent evidence is returned as
    infeasible, never silently enlarged until the fitted candidate is feasible.
    A nuisance column must be supplied explicitly (e.g. one bank difference per
    drive). Ranges are feasible-set bounds, not statistical confidence intervals.
    """
    validate(bands)
    if np.any(np.isposinf(bands.lower)) or np.any(np.isneginf(bands.upper)):
        raise ValueError('Impossible infinite bound')
    if not isinstance(column,int) or not 0<=column<bands.design.shape[1]:
        raise ValueError('Invalid target cell')
    if not np.isfinite([*factor_bounds,nuisance_bound]).all() or not 0<factor_bounds[0]<factor_bounds[1] or not nuisance_bound>0:
        raise ValueError('Invalid feasible domain')
    nuisance=np.asarray(bands.bank[:,None] if nuisance is None else nuisance,float)
    if nuisance.ndim!=2 or len(nuisance)!=bands.design.shape[0] or not np.isfinite(nuisance).all():
        raise ValueError('Invalid nuisance design')
    design=hstack([bands.design,csr_matrix(nuisance)]).tocsr()
    upper=np.isfinite(bands.upper);lower=np.isfinite(bands.lower)
    matrix=vstack([design[upper],-design[lower]]).tocsr()
    rhs=np.r_[bands.upper[upper],-bands.lower[lower]]
    objective=np.zeros(design.shape[1]);objective[column]=1.
    bounds=[factor_bounds]*bands.design.shape[1]+[(-nuisance_bound,nuisance_bound)]*nuisance.shape[1]
    answers=[]
    for sign in [1,-1]:
        result=linprog(sign*objective,A_ub=matrix,b_ub=rhs,bounds=bounds,
                       method='highs-ipm',options={'time_limit':20.})
        if result.status==2:
            return dict(status='infeasible',range=None)
        if not result.success:
            raise RuntimeError('Identification solver did not finish: '+result.message)
        if float(np.max(matrix@result.x-rhs))>2e-7:
            raise RuntimeError('Identification witness violates the supplied constraints')
        answers.append(result)
    values=[float(r.x[column]) for r in answers]
    # Keep the active inequalities that certify the upper bound for the audit.
    origin=np.r_[np.flatnonzero(upper),np.flatnonzero(lower)]
    dual=answers[1].ineqlin.marginals
    certificate=[dict(row=int(origin[i]),side='upper' if i<int(upper.sum()) else 'lower',multiplier=float(-dual[i]))
                 for i in np.flatnonzero(abs(dual)>1e-7)]
    return dict(status='feasible',range=values,unchangedAdmissible=values[0]<=1<=values[1],
                upperCertificate=certificate,
                lowerWitness=answers[0].x.tolist(),upperWitness=answers[1].x.tolist())
