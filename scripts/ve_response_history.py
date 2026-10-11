"""Offline fuel/air history hypotheses. No ECU I/O or calibration writer.

TL is already the DME's corrected air proxy; rf_korr must not be multiplied into
TI again. Fitted cell factors are effective air-model discrepancies, not proved
nominal VE corrections (MAP/PT1 and unlogged air-path states remain confounded).
"""
from dataclasses import dataclass
import numpy as np
from scipy.optimize import minimize
from scipy.sparse import csr_matrix
from scipy.special import expit


@dataclass(frozen=True)
class Hypothesis:
    name: str
    delay: float = 0.
    flow_delay: float = 0.  # residence proxy at 2000 rpm * RF 30%, not measured litres
    mixing: float = 0.
    deposited: float = 0.
    film_tau: float = 0.


HYPOTHESES = [Hypothesis('instant')]
HYPOTHESES += [Hypothesis(f'delay-{d}', delay=d) for d in [.25, .5, 1., 2.]]
HYPOTHESES += [Hypothesis(f'flow-{d}', flow_delay=d) for d in [.25, .5, 1.]]
HYPOTHESES += [Hypothesis(f'flow-{d}-mix', flow_delay=d, mixing=.25) for d in [.25, .5, 1.]]
HYPOTHESES += [Hypothesis('flow-film-fast', flow_delay=.5, mixing=.1, deposited=.2, film_tau=.5),
               Hypothesis('flow-film-slow', flow_delay=.5, mixing=.1, deposited=.4, film_tau=2.)]


def interpolate(query, times, values, max_gap=1.5):
    """Offline interpolation within valid read brackets only. Never extrapolate.

    A future read can close a bracket: this is not a live/causal acquisition API.
    Physical transport below only moves forward. CV embargo covers these brackets.
    """
    query, times, values = map(np.asarray, [query, times, values])
    if len(times) < 2 or not np.isfinite(times).all() or np.any(np.diff(times) <= 0):
        raise ValueError('Read times must be finite and strictly increasing')
    j = np.clip(np.searchsorted(times, query, side='right')-1, 0, len(times)-2)
    width = times[j+1]-times[j]
    good = (query >= times[j]) & (query <= times[j+1]) & (width <= max_gap) & np.isfinite(query)
    f = (query-times[j])/width
    if values.ndim == 2:
        f = f[:, None]
    v = values[j]+f*(values[j+1]-values[j])
    good &= np.isfinite(v) if v.ndim == 1 else np.isfinite(v).all(axis=1)
    v[~good] = np.nan
    return v


def discrete(query, times, values, transition=.5):
    """State boundary is unknown between reads: early/mid/late are sensitivities.

    Partial cylinder cuts remain unknown, rather than assuming which bank was cut.
    Both endpoints must be present; missing state is not treated as 'uncut'.
    """
    if not 0 <= transition <= 1:
        raise ValueError('Transition fraction must be in [0, 1]')
    j = np.clip(np.searchsorted(times, query, side='right')-1, 0, len(times)-2)
    good = (query >= times[j]) & (query <= times[j+1]) & ((times[j+1]-times[j]) <= 1.5)
    good &= np.isfinite(values[j]) & np.isfinite(values[j+1])
    switch = times[j]+transition*(times[j+1]-times[j])
    v = np.where(query < switch, values[j], values[j+1]).astype(float)
    v = np.where(query == times[j], values[j], v)
    v = np.where(query == times[j+1], values[j+1], v)
    v[~good] = np.nan
    return v


def spans(valid):
    ids = np.flatnonzero(valid)
    return np.split(ids, np.flatnonzero(np.diff(ids)>1)+1) if len(ids) else []


def film_flux(fuel_rate, dt, deposited, tau):
    """Exact interval-average one-reservoir balance for piecewise constant input.

    State at first sample assumes equilibrium. Callers discard initial 5*tau.
    Returns delivered rate and end-of-interval stored quantity for mass checks.
    """
    if dt <= 0 or not 0 <= deposited < 1 or (deposited and tau <= 0):
        raise ValueError('Invalid fuel-store parameters')
    if not deposited:
        return fuel_rate.copy(), np.zeros_like(fuel_rate)
    decay = np.exp(-dt/tau)
    store = deposited*tau*fuel_rate[0]
    delivered, stored = np.empty_like(fuel_rate), np.empty_like(fuel_rate)
    for i, fuel in enumerate(fuel_rate):
        after = decay*store+deposited*tau*fuel*(1-decay)
        delivered[i] = fuel+(store-after)/dt
        stored[i] = after
        store = after
    return delivered, stored


def lowpass(values, dt, tau):
    if tau == 0:
        return values.copy()
    gain = -np.expm1(-dt/tau)
    out = values.copy()
    for i in range(1, len(values)):
        out[i] = out[i-1]+gain*(values[i]-out[i-1])
    return out


def transport_time(times, flow, hypothesis):
    """Advect using cumulative *modelled* airflow, retaining changing rpm/load."""
    if not hypothesis.flow_delay:
        return times-hypothesis.delay
    clock = np.r_[0, np.cumsum((flow[:-1]+flow[1:])/2*np.diff(times))]
    if np.any(np.diff(clock) <= 0):
        raise ValueError('Positive flow required for transport')
    volume = hypothesis.flow_delay*2000*30
    return np.interp(clock-volume, clock, times, left=np.nan, right=np.nan)


def history(grid, fuel_rate, air_cells, flow, hypothesis):
    """Transport fuel and modelled air histories before dividing or taking logs.

    An approximate flux-history kernel, not an exhaust gas/sensor simulator.
    Gap/unknown cut resets history; lambda OFF and changes of operating point do
    not erase physical history. No STFT or rf_korr multiplication of final TI.
    """
    dt = float(np.median(np.diff(grid)))
    if not np.allclose(np.diff(grid), dt):
        raise ValueError('Uniform history grid required')
    fuel_out, air_out = np.full_like(fuel_rate, np.nan), np.full_like(air_cells, np.nan)
    source_out = np.full(len(grid), np.nan)
    valid = np.isfinite(fuel_rate).all(axis=1) & np.isfinite(air_cells).all(axis=1) & np.isfinite(flow) & (flow>0)
    for ids in spans(valid):
        if len(ids) < 2:
            continue
        t = grid[ids]
        f, _ = film_flux(fuel_rate[ids], dt, hypothesis.deposited, hypothesis.film_tau)
        source = transport_time(t, flow[ids], hypothesis)
        ft = interpolate(source, t, f)
        at = interpolate(source, t, air_cells[ids])
        good = np.isfinite(ft).all(axis=1) & np.isfinite(at).all(axis=1) & (t-source <= 4.)
        for run in spans(good):
            ff, aa = lowpass(ft[run], dt, hypothesis.mixing), lowpass(at[run], dt, hypothesis.mixing)
            # Reservoir/mixture initial state uncertainty, unrelated to steady rpm.
            ready = (source[run]-t[0] >= 5*hypothesis.film_tau) & (t[run]-t[run[0]] >= 5*hypothesis.mixing)
            target = ids[run[ready]]
            fuel_out[target], air_out[target] = ff[ready], aa[ready]
            source_out[target] = source[run[ready]]
    return fuel_out, air_out, source_out


def predict(design, log_ratio, bank, beta, width=.04):
    air = np.asarray(csr_matrix(design) @ np.exp(beta[:-1])).ravel()
    return expit((log_ratio-np.log(air)-bank*beta[-1])/width)


def fit(design, log_ratio, bank, y, regularization=1., width=.04):
    """Positive cell factors inside transported-air sum; no log-mean shortcut."""
    x = csr_matrix(design)
    penalty = np.r_[np.full(x.shape[1], regularization/.2**2), regularization/.03**2]
    def loss(beta):
        factor = np.exp(beta[:-1]); air = np.asarray(x@factor).ravel()
        v = (log_ratio-np.log(air)-bank*beta[-1])/width
        e = expit(v)-y
        objective = np.logaddexp(0,v).sum()-y@v+.5*np.sum(penalty*beta**2)
        grad = np.r_[-factor*np.asarray(x.T@(e/air)).ravel()/width, -bank@e/width]+penalty*beta
        return objective, grad
    result = minimize(loss, np.zeros(x.shape[1]+1), jac=True, method='L-BFGS-B',
                      bounds=[(-.7,.7)]*x.shape[1]+[(-.1,.1)],
                      options={'maxiter':500,'ftol':1e-9,'gtol':1e-5})
    if not result.success:
        raise RuntimeError(result.message)
    return result.x


def split_masks(folds, times, held_out, eligible=None, embargo=20.):
    """Exclude whole observation rows/banks and neighbours of validation span."""
    if eligible is None:
        eligible = np.ones(len(times), dtype=bool)
    test = eligible & (folds == held_out)
    if not np.any(test):
        raise ValueError('Empty validation fold')
    lo, hi = times[test].min()-embargo, times[test].max()+embargo
    train = eligible & (folds != held_out) & ((times<lo)|(times>hi))
    return train, test
