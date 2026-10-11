"""Physical/identifiability regressions for ordinal, moving-path VE bounds."""
import sys
sys.dont_write_bytecode=True
import importlib.util
from pathlib import Path
import numpy as np
from scipy.sparse import csr_matrix
from threadpoolctl import threadpool_limits
from ve_response_bounds import Bands,fit,point_bands,interval_envelope,sample_envelope,weighted_threshold,residuals,controller_duration_bounds
threadpool_limits(1)

# An enrichment answered by I-control approaches, but never crosses, neutral.
# A likelihood rewards moving VE below neutral. The bound estimator must not.
k=1.2;t=np.arange(0,4.3,.1);trim=np.maximum(1/k,1-13*100/32768*t)
q=k*trim
observed=point_bands(np.ones((len(t),1)),q,np.ones(len(t)))
for penalty in [.0001,.04,4.]:
    result=fit(observed,penalty)
    assert np.array_equal(result['factors'],[1.]),result

# For persistent rich with q=.9 the evidence is f<=.9, not f=.5 or zero.
one=point_bands([[1]],[.9],[1])
for penalty in [.0001,.04,4.]:
    result=fit(one,penalty)
    expected=(.9+penalty)/(1+penalty)
    assert abs(result['factors'][0]-expected)<1e-8
    assert result['factors'][0]>=.9
assert np.allclose(fit(point_bands([[1]],[1.1],[0]),.0001)['factors'],[1.099990001],atol=1e-9)

# Exact moving-path evidence: neither cell is held and neither is visited alone.
true=np.array([.85,1.08]);x=np.array([[v,1-v] for v in [.1,.3,.6,.9]])
design=np.repeat(x,2,axis=0);ratio=np.repeat(x@true,2)+np.tile([-.002,.002],len(x))
labels=np.tile([0,1],len(x))
result=fit(point_bands(design,ratio,labels),1e-7)
assert max(abs(result['factors']-true))<.006,result
assert max(abs(residuals(point_bands(design,ratio,labels),result)))<1e-4

# Identical shares cannot distinguish cells. Expose the unresolved direction;
# a prior-picked symmetric answer is not two independently measured cells.
assert np.linalg.matrix_rank(np.tile([.5,.5],(8,1)))==1
r=fit(point_bands(np.tile([.5,.5],(2,1)),[.898,.902],[0,1]),1e-7)
assert abs(r['factors'][0]-r['factors'][1])<1e-9
for candidate in [np.array([.8,1.]),np.array([1.,.8])]:
    assert np.allclose(np.tile([.5,.5],(2,1))@candidate,.9)

# Exact duration quantile for a fixed cell: rich >=60% gives f<=.9.
assert weighted_threshold([.8,.9,1.], [2,4,4], .6, upper=True)==.9
assert weighted_threshold([.8,.9,1.], [2,4,4], .6, upper=False)==.9
assert weighted_threshold([.8,.9,1.], [2,4,4], 1., upper=True)==.8

# One read somewhere in a bracket must not assert that the whole bracket was rich.
assert sample_envelope([[1],[1]],[.8,1.2],True)[0][2]==1.2
assert sample_envelope([[1],[1]],[.8,1.2],False)[0][1]==.8
try:
    point_bands([[1]],[np.nan],[1])
    raise AssertionError('Missing ratio accepted')
except ValueError:pass

# Random known truths under MOVING shares must satisfy every envelope, including
# nonuniform dwell weights and one-sided histories. This catches wrong quantiles.
rng=np.random.default_rng(357)
for _ in range(500):
    count=int(rng.integers(2,25));x=rng.dirichlet([2,2,2],count);true=rng.uniform(.5,1.5,3)
    q=(x@true)*rng.uniform(.8,1.2,count);w=rng.uniform(.01,.2,count)
    rich=float(w[q>=x@true].sum()/w.sum());lean=1-rich
    for row,lower,upper in interval_envelope(x,q,w,rich,lean):
        assert lower-1e-10 <= row@true <= upper+1e-10

# Independently simulated rich/lean/wait/P histories. Executed P steps can have
# the same direction repeatedly; their counter must not be treated as cycles.
ki_pos,ki_neg=16/32768*100,13/32768*100
kp_pos,kp_neg=53*16/32768,33*16/32768
for _ in range(500):
    count=int(rng.integers(10,150));state=rng.integers(0,5,count);gain=rng.uniform(.2,1,count)
    delta=float(np.sum(np.where(state==0,-ki_neg*.01*gain,0)+np.where(state==1,ki_pos*.01*gain,0)
        +np.where(state==3,-kp_neg*gain,0)+np.where(state==4,kp_pos*gain,0)))
    b=controller_duration_bounds(delta,int(np.isin(state,[3,4]).sum()),count*.01,ki_pos,ki_neg,kp_pos,kp_neg)
    assert b['feasible']
    assert b['richMinSeconds'] <= np.isin(state,[0,3]).sum()*.01+1e-9
    assert b['leanMinSeconds'] <= np.isin(state,[1,4]).sum()*.01+1e-9
b=controller_duration_bounds(-kp_neg,1,.5,ki_pos,ki_neg,kp_pos,kp_neg)
assert b['richMinSeconds']==0,'A P jump is not a long rich integral'

# Missing observations and contradictions are not a made-up perfect tune.
try:
    fit(Bands(csr_matrix((0,2)),np.array([]),np.array([]),np.array([]),np.array([])),.04)
    raise AssertionError('Empty evidence accepted')
except ValueError:pass
conflict=point_bands([[1],[1]],[.8,1.2],[1,0]);r=fit(conflict,.04)
assert np.allclose(r['factors'],1.) and np.all(abs(residuals(conflict,r))>.19)

# Profile the actual constrained solver: an unseen cell must retain the complete
# search domain, even when the minimum-change point estimate is exactly 1.
spec=importlib.util.spec_from_file_location('response_bounds_analysis',Path(__file__).with_name('analyze-response-bounds.py'))
analysis=importlib.util.module_from_spec(spec);spec.loader.exec_module(analysis)
unseen=point_bands([[1,0],[1,0]],[.898,.902],[0,1]);estimate=fit(unseen,1e-7)
ranges=analysis.profile(unseen,estimate,[0,1])
assert .89<ranges[0][0]<ranges[0][1]<.91
assert np.allclose(ranges[1],[.3,1.7])
print('PASS 500 moving-history envelopes and 500 DME traces; no false k hill; finite one-sided update; moving-cell recovery; unresolved cells and conflicts retained')
