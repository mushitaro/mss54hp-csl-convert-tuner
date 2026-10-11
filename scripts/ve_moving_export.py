"""Export private response inequalities for the browser estimator replay."""
import json,sys
from pathlib import Path
import numpy as np
ROOT=Path(__file__).resolve().parents[1]
prefix=sys.argv[1] if len(sys.argv)>1 else 'command-strict-sensor'
rows=[]
for session in [968,967]:
    d=np.load(ROOT/'archive/ve-moving'/f'{prefix}-{session}.npz')
    for i,x in enumerate(d['x']):
        row=dict(shares=[dict(cell=int(j),weight=float(x[j])) for j in np.flatnonzero(x>0)],
            time=float(d['times'][i]),bank=int(d['bank'][i]),index=i,model='flow-0.25-mix',session=str(session),weight=float(d['weight'][i]))
        if np.isfinite(d['lower'][i]):row['lower']=float(d['lower'][i])
        if np.isfinite(d['upper'][i]):row['upper']=float(d['upper'][i])
        rows.append(row)
(ROOT/'archive/ve-moving'/f'{prefix}-browser.json').write_text(json.dumps(dict(cellCount=d['x'].shape[1],rows=rows)),encoding='utf-8')
print(prefix,len(rows))
