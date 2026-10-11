"""Grid constraints must preserve timing and minimum I-duration mass."""
import sys
sys.dont_write_bytecode=True
import numpy as np
from threadpoolctl import threadpool_limits
from ve_response_grid import grid_range
threadpool_limits(1)

def point(x,q,side,bank=1,fraction=None,weight=None):
    return dict(x=x,q=q,side=side,bank=bank,group=0,fraction=fraction,weight=weight or [1]*len(q))

# Both banks remove the free offset. Known factor is in [.70,.74].
obs=[point([[1]],[.70],'lean',bank) for bank in [1,2]]+[point([[1]],[.74],'rich',bank) for bank in [1,2]]
r=grid_range(obs,1,1,0);assert np.allclose(r['range'],[.70,.74])
assert np.allclose(grid_range(obs*3,1,1,0)['range'],r['range'])
assert grid_range(obs,1,1,0,fixed=.973)['results'][0]['status']==2

# Time-decoupled min(x) / max(q) admits a false rich observation. Its two
# time-correlated alternatives both contradict separately observed cell values.
pins=[point([[1,0]],[.5],side) for side in ['rich','lean']]+[point([[0,1]],[1.5],side) for side in ['rich','lean']]
false=point([[1,0],[0,1]],[.4,1.4],'rich')
assert grid_range(pins+[false],2,1,0)['results'][0]['status']==2
possible=point([[1,0],[0,1]],[.6,1.4],'rich')
assert grid_range(pins+[possible],2,1,0)['results'][0]['status']==0

# Merely one crossing is not enough for an I-derived 80% rich duration.
duration=point([[1,0],[0,1]],[.6,1.4],'rich',fraction=.8,weight=[.2,.8])
assert grid_range(pins+[duration],2,1,0)['results'][0]['status']==2
duration['fraction']=.2
assert grid_range(pins+[duration],2,1,0)['results'][0]['status']==0
print('PASS finite-grid timing correlation, duration weights, bank offset, repeated evidence and rejected unsupported factor')
