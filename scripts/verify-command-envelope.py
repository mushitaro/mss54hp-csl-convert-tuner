"""Independent tick-level trajectories test reachable command envelopes."""
import sys
sys.dont_write_bytecode=True
import numpy as np
from ve_command_envelope import trim_envelope,reconstruct_trim

gains=dict(ki_pos=.048828125,ki_neg=.0396728515625,kp_pos=.02587890625,kp_neg=.01611328125,tick=.01)
rng=np.random.default_rng(542401);checked=0
for _ in range(1000):
    # Construct commands with independent arbitrary waits, I increments and P
    # jumps, including same-direction P steps. The bounding code sees only the
    # endpoints and the total count, never the internal events.
    events=rng.choice([0,1,2,3,4],100,p=[.15,.38,.38,.045,.045]);u=[1.];count=[0]
    for e in events:
        delta={0:0.,1:rng.random()*gains['ki_pos']*.01,2:-rng.random()*gains['ki_neg']*.01,
               3:rng.random()*gains['kp_pos'],4:-rng.random()*gains['kp_neg']}[e]
        u.append(u[-1]+delta);count.append(count[-1]+int(e>=3))
    t=np.arange(101)*.01;lo,hi=trim_envelope(t,0.,1.,u[0],u[-1],count[-1],gains)
    assert np.all(lo<=np.array(u)+1e-12) and np.all(hi>=np.array(u)-1e-12)
    checked+=len(t)

# Endpoint data inconsistent with I/P budgets must not be silently linearly
# interpolated. Also do not cross a reset, a saturated count or a long gap.
lo,hi=trim_envelope([.5],0,1,1,1.5,0,gains);assert np.isnan(lo).all() and np.isnan(hi).all()
row=lambda t,u,c:dict(lambdaReadTime=t,lambdaReadMs=20,stft1=u,lambdaState1=1,lambdaPSteps1=c)
for rows in [[row(0,1,3),row(1,1,0)],[row(0,1,255),row(1,1,255)],[row(0,1,0),row(2,1,0)]]:
    lo,hi=reconstruct_trim([.5],rows,1,gains);assert np.isnan(lo).all()
rows=[row(0,1,0),row(1,1,0)]
lo,hi=reconstruct_trim([-.1,.5,1.1],rows,1,gains)
assert np.isnan(lo[[0,2]]).all() and lo[1]<1<hi[1]
print(f'PASS {checked} independently simulated command samples; contradictions, reset, saturation, gaps and extrapolation')
