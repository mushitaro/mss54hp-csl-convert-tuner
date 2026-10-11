"""Inequality estimator for moving operating points, without an AFR likelihood.

Each band constrains a nonnegative weighted sum of VE factors. Rich observations
are upper bounds; lean observations are lower bounds. Once a bound is satisfied
it exerts NO further force. Conflicting observations remain explicit residuals.
The minimum-change penalty is selected/checked outside this module, never an
rf_korr exponent. These are conditional air-reference factors, not a BIN writer.
"""
from dataclasses import dataclass
import numpy as np
from scipy.optimize import minimize
from scipy.sparse import csr_matrix, hstack


def controller_duration_bounds(delta, count, duration, ki_pos, ki_neg, kp_pos, kp_neg, tick=.01):
    """Necessary rich/lean durations from d(trim)=integral(I)+sum(P).

    Gains are global maxima from the recording calibration. P steps need not
    alternate. The bound is conditional on no hidden reset/limit change and on
    the caller's observation window covering the ECU updates. Tick is explicit.
    """
    if (not np.isfinite([delta,count,duration,ki_pos,ki_neg,kp_pos,kp_neg,tick]).all()
            or count<0 or int(count)!=count or duration<=0 or ki_pos<=0 or ki_neg<=0
            or kp_pos<0 or kp_neg<0 or tick<=0):
        raise ValueError('Invalid controller interval')
    rich=max(0.,-(delta+count*kp_neg)/ki_neg-tick)
    lean=max(0.,(delta-count*kp_pos)/ki_pos-tick)
    return dict(richMinSeconds=rich,leanMinSeconds=lean,
                richFractionMin=rich/duration,leanFractionMin=lean/duration,
                feasible=rich+lean<=duration+1e-9)


@dataclass(frozen=True)
class Bands:
    design: csr_matrix
    lower: np.ndarray
    upper: np.ndarray
    bank: np.ndarray
    weight: np.ndarray

    def subset(self, keep):
        return Bands(self.design[keep], self.lower[keep], self.upper[keep],
                     self.bank[keep], self.weight[keep])


def weighted_threshold(values, weights, fraction, *, upper):
    """Largest rich upper / smallest lean lower bound with required time mass.

    With rich fraction >= a, P(fuel/reference >= air/reference) >= a.
    Values are ordered high-to-low for rich and low-to-high for lean. Keeping
    the selected value makes ties conservative, including fraction exactly 1.
    """
    values, weights = np.asarray(values, float), np.asarray(weights, float)
    if (values.ndim != 1 or values.shape != weights.shape or not len(values)
            or not np.isfinite(values).all() or not np.isfinite(weights).all()
            or np.any(weights < 0) or weights.sum() <= 0 or not 0 < fraction <= 1):
        raise ValueError('Invalid weighted duration constraint')
    valid = weights > 0
    values, weights = values[valid], weights[valid]
    order = np.argsort(values)
    if upper:
        order = order[::-1]
    pos = np.searchsorted(np.cumsum(weights[order]), fraction * weights.sum(), side='left')
    return float(values[order[min(pos, len(order)-1)]])


def interval_envelope(design, ratio, duration, rich_min, lean_min):
    """Necessary linear constraints for a changing path; never a mean-point vote.

    For positive factors f, min_t X_j(t) f_j <= X(t) f <= max_t X_j(t) f_j.
    Combine these bounds with duration quantiles of measured fuel/reference.
    Constant cell shares are exact. Moving shares create an OUTER relaxation:
    it can lose information, but cannot impose a fixed-cell/dwell assumption.
    Returns (coefficient row, lower, upper) for each informative side.
    """
    x, q, w = np.asarray(design, float), np.asarray(ratio, float), np.asarray(duration, float)
    if (x.ndim != 2 or len(x) != len(q) or len(q) != len(w)
            or not np.isfinite(x).all() or np.any(x < 0)
            or not np.allclose(x.sum(axis=1), 1, atol=1e-8)
            or not np.isfinite(q).all() or np.any(q <= 0)
            or not np.isfinite(w).all() or np.any(w <= 0)
            or not 0 <= rich_min <= 1 or not 0 <= lean_min <= 1
            or rich_min+lean_min > 1+1e-10):
        raise ValueError('Invalid interval history')
    rows = []
    if rich_min > 0:
        lo = x.min(axis=0)
        # An empty intersection of cell supports supplies no upper constraint.
        if np.any(lo):
            rows.append((lo, -np.inf, weighted_threshold(q,w,rich_min,upper=True)))
    if lean_min > 0:
        rows.append((x.max(axis=0), weighted_threshold(q,w,lean_min,upper=False), np.inf))
    return rows


def sample_envelope(design, ratio, rich):
    """A sampled O2 side occurred SOMEWHERE in its read window, not throughout it.

    Duration quantiles must not be applied to a single uncertain-time reading.
    Independent per-cell extrema are an outer relaxation of its possible times.
    """
    x,q=np.asarray(design,float),np.asarray(ratio,float)
    # Share the full history/positivity validation without creating a duration claim.
    interval_envelope(x,q,np.ones(len(q)),0.,0.)
    if rich:
        row=x.min(axis=0)
        return [(row,-np.inf,float(q.max()))] if np.any(row) else []
    return [(x.max(axis=0),float(q.min()),np.inf)]


def point_bands(design, ratio, labels, bank=None, weight=None):
    x, q, y = csr_matrix(design), np.asarray(ratio,float), np.asarray(labels,float)
    if (q.shape != y.shape or len(q) != x.shape[0] or not np.isin(y,[0,1]).all()
            or not np.isfinite(q).all() or np.any(q<=0)):
        raise ValueError('Invalid ordinal observations')
    return Bands(x, np.where(y==0,q,-np.inf), np.where(y==1,q,np.inf),
                 np.zeros(len(q)) if bank is None else np.asarray(bank,float),
                 np.ones(len(q)) if weight is None else np.asarray(weight,float))


def validate(bands):
    rows, cols = bands.design.shape
    if not rows or not cols or not np.isfinite(bands.design.data).all() or np.any(bands.design.data<0):
        raise ValueError('Nonempty nonnegative cell contributions required')
    if any(v.shape != (rows,) for v in [bands.lower,bands.upper,bands.bank,bands.weight]):
        raise ValueError('Band dimensions disagree')
    if (np.isnan(bands.lower).any() or np.isnan(bands.upper).any()
            or np.any(bands.lower>bands.upper) or not np.isfinite(bands.bank).all()
            or not np.isfinite(bands.weight).all() or np.any(bands.weight<=0)
            or np.any(np.isneginf(bands.lower)&np.isposinf(bands.upper))):
        raise ValueError('Invalid bounds or weights')


def fit(bands, penalty, factor_bounds=(.3,1.7), bank_bound=.1):
    """Globally convex squared bound-violation + minimum-change problem.

    Bank imbalance is an additive fraction of the reference air, independent of
    VE cells. It is constant per bank and regularized more strongly than VE.
    No posterior/confidence claim is made by the unique penalized optimum.
    """
    validate(bands)
    if not np.isfinite(penalty) or penalty<=0 or not 0<factor_bounds[0]<1<factor_bounds[1] or not bank_bound>0:
        raise ValueError('Invalid solver controls')
    x=hstack([bands.design,csr_matrix(bands.bank[:,None])]).tocsr()
    prior=np.r_[np.ones(bands.design.shape[1]),0.]
    reg=np.r_[np.full(len(prior)-1,penalty),penalty*(.2/.03)**2]
    def objective(beta):
        value=np.asarray(x@beta).ravel()
        error=value-np.clip(value,bands.lower,bands.upper)
        delta=beta-prior
        loss=.5*np.dot(bands.weight,error**2)+.5*np.dot(reg,delta**2)
        grad=np.asarray(x.T@(bands.weight*error)).ravel()+reg*delta
        return float(loss),grad
    curvature=np.asarray(x.power(2).T@bands.weight).ravel()+reg
    scale=1/np.sqrt(curvature)
    def scaled(theta):
        loss,grad=objective(prior+scale*theta)
        return loss,grad*scale
    bounds=np.array([factor_bounds]*(len(prior)-1)+[(-bank_bound,bank_bound)])
    result=minimize(scaled,np.zeros(len(prior)),jac=True,method='L-BFGS-B',
        bounds=(bounds-prior[:,None])/scale[:,None],
        options={'maxiter':1200,'ftol':1e-12,'gtol':1e-8,'maxcor':20})
    if not result.success:
        raise RuntimeError('Bound estimator did not converge: '+str(result.message))
    beta=prior+scale*result.x
    gradient=objective(beta)[1]
    projected=beta-np.clip(beta-gradient,bounds[:,0],bounds[:,1])
    return dict(factors=beta[:-1],bankOffset=float(beta[-1]),objective=float(result.fun),
                iterations=int(result.nit),projectedGradient=float(np.max(np.abs(projected))))


def residuals(bands, result):
    value=np.asarray(bands.design@result['factors']).ravel()+bands.bank*result['bankOffset']
    return value-np.clip(value,bands.lower,bands.upper)


def evaluate(bands,result):
    err=residuals(bands,result)
    return dict(constraints=len(err),rmsViolation=float(np.sqrt(np.average(err**2,weights=bands.weight))),
                meanAbsoluteViolation=float(np.average(np.abs(err),weights=bands.weight)),
                fractionSatisfied=float(np.average(np.abs(err)<=1e-9,weights=bands.weight)))
