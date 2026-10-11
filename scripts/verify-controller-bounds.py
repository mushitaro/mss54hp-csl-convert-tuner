"""Check DME-counter information and prior-free, observation-count invariant bounds."""
import sys
sys.dont_write_bytecode=True
import numpy as np
from scipy.sparse import csr_matrix
from threadpoolctl import threadpool_limits
from ve_response_bounds import Bands,point_bands
from ve_controller_bounds import switch_envelope,feasible_range
threadpool_limits(1)

# An old pending P can execute while the entire read interval has one sign.
assert switch_envelope([[1],[1]],[.9,.91],1)==[]
assert len(switch_envelope([[1],[1]],[.9,.91],2))==2
for invalid in [-1,255,2.5]:
    try:switch_envelope([[1]],[1],invalid);raise AssertionError('Invalid P count accepted')
    except ValueError:pass

# Independent discrete replay of the decompiled pending-bit branches. Switching
# back before a delayed P executes can yield two executed P steps of SAME sign.
def controller(signs,wait_pos,wait_neg):
    sign=0;pending=False;wait=0;count=0;counts=[];executed=[]
    for value in signs:
        if sign and value!=sign:
            pending=True;wait=wait_pos if value>0 else wait_neg
        sign=value
        if pending:
            if wait>0:wait-=1
            else:
                count+=1;executed.append(value);pending=False
        counts.append(count)
    return np.array(counts),executed

rng=np.random.default_rng(542401);checked=0;same_direction=0
for _ in range(500):
    signs=rng.choice([-1,1],100);wp=int(rng.integers(0,7));wn=int(rng.integers(0,7))
    count,executed=controller(signs,wp,wn)
    same_direction+=sum(a==b for a,b in zip(executed,executed[1:]))
    for start in range(0,90,3):
        end=start+int(rng.integers(2,11))
        if count[end]-count[start]>=2:
            assert set(signs[start+1:end+1])=={-1,1}
            checked+=1
assert checked>500 and same_direction>0

# Moving shares and uncertain sample timing: both-side envelopes must contain
# every known true factor, including highly nonuniform paths and repeated P signs.
for _ in range(500):
    f=rng.uniform(.5,1.5,4);x=rng.dirichlet([2]*4,10);q=x@f*rng.uniform(.8,1.2,10)
    if not (np.any(q>x@f) and np.any(q<x@f)):continue
    for row,lo,hi in switch_envelope(x,q,2):assert lo-1e-10<=row@f<=hi+1e-10

# Unlike a ridge estimate, the feasible interval must not change when the same
# passage is repeated, nor become a falsely identified near-unity correction
# when the only informative passage is removed.
bands=point_bands([[1,0],[1,0]],[.70,.74],[0,1]);r=feasible_range(bands,0,nuisance=np.zeros((2,0)))
assert r['status']=='feasible' and np.allclose(r['range'],[.70,.74])
dup=point_bands(np.tile([[1,0],[1,0]],(30,1)),np.tile([.70,.74],30),np.tile([0,1],30))
assert np.allclose(feasible_range(dup,0,nuisance=np.zeros((60,0)))['range'],r['range'])
assert np.allclose(feasible_range(bands,1,nuisance=np.zeros((2,0)))['range'],[.3,1.7])

# A data conflict must remain infeasible. Never replace each inequality's bound
# by the current fitted prediction merely to obtain a deceptively narrow range.
conflict=point_bands([[1],[1]],[.8,1.2],[1,0])
assert feasible_range(conflict,0,nuisance=np.zeros((2,0)))['status']=='infeasible'

# Coupled cells: limits are about all feasible maps, not one chosen neighbour.
pair=point_bands([[.5,.5],[.5,.5]],[.898,.902],[0,1]);r=feasible_range(pair,0,nuisance=np.zeros((2,0)))
assert r['range'][0]<.4 and r['range'][1]>1.4
for name in ['lowerWitness','upperWitness']:
    predicted=np.asarray(pair.design@np.array(r[name])).ravel()
    assert np.all(predicted>=pair.lower-1e-8) and np.all(predicted<=pair.upper+1e-8)
print(f'PASS {checked} two-P windows, {same_direction} nonalternating P pairs, 500 moving envelopes; repetition invariance, absent evidence and contradictions')
