"""Reachable trim envelopes from 0401 slave 01d6a2/01dc42.

An outer bound: P directions/times are not invented, and zero I during a P wait
is allowed. Callers must supply one active, unsaturated, reset-free interval.
Bounds describe possible commands, not statistical errors or measured AFR.
"""
import numpy as np


def trim_envelope(query, start, end, u0, u1, steps, gains,
                  start_radius=0., end_radius=0., query_radius=0.):
    if (not isinstance(steps, (int, np.integer)) or not 0 <= steps < 255
        or not np.isfinite([start,end,u0,u1,start_radius,end_radius,query_radius]).all()
        or end <= start or min(start_radius,end_radius,query_radius)<0):
        raise ValueError('Invalid reset-free controller interval')
    if any(not np.isfinite(gains[k]) or gains[k]<0 for k in ['ki_pos','ki_neg','kp_pos','kp_neg','tick']):
        raise ValueError('Invalid controller gains')
    q=np.asarray(query,dtype=float)
    # A task tick straddling a read can contribute once. Read windows are unions,
    # not an assertion that the RAM values all came from the transaction midpoint.
    before=np.maximum(0,q+query_radius-(start-start_radius))+gains['tick']
    after=np.maximum(0,end+end_radius-(q-query_radius))+gains['tick']
    lo=np.maximum(u0-gains['ki_neg']*before-steps*gains['kp_neg'],
                  u1-gains['ki_pos']*after-steps*gains['kp_pos'])
    hi=np.minimum(u0+gains['ki_pos']*before+steps*gains['kp_pos'],
                  u1+gains['ki_neg']*after+steps*gains['kp_neg'])
    # Outside overlapping acquisition windows the counter budget no longer
    # brackets the query. Never extrapolate a finite confidence-looking bound.
    valid=(q-query_radius>=start+start_radius)&(q+query_radius<=end-end_radius)
    valid &= np.isfinite(q)&(lo<=hi+1e-12)
    return np.where(valid,lo,np.nan),np.where(valid,hi,np.nan)


def reconstruct_trim(query, raw, bank, gains, query_radius=0.):
    times=np.array([r['lambdaReadTime'] for r in raw])
    radius=np.array([r['lambdaReadMs']/2000 for r in raw])
    q=np.asarray(query,float);lower=np.full(len(q),np.nan);upper=lower.copy()
    # A query inside a lambda transaction uses the surrounding two reads, so
    # its unknown sample order cannot falsely spend the same P count twice.
    left=np.searchsorted(times+radius,q-query_radius,side='right')-1
    right=np.searchsorted(times-radius,q+query_radius,side='left')
    for a,b in sorted(set(zip(left,right))):
        if a<0 or b>=len(raw) or not a<b or np.any(np.diff(times[a:b+1])>1.5):continue
        rows=raw[a:b+1];key='lambdaPSteps'+str(bank);uk='stft'+str(bank)
        counts=[r[key] for r in rows]
        if any(not(r['lambdaState'+str(bank)]&1) for r in rows) or min(np.diff(counts))<0 or max(counts)>=255:continue
        ids=np.flatnonzero((left==a)&(right==b))
        lo,hi=trim_envelope(q[ids],times[a],times[b],rows[0][uk],rows[-1][uk],counts[-1]-counts[0],gains,
                            radius[a],radius[b],query_radius)
        lower[ids]=lo;upper[ids]=hi
    return lower,upper
