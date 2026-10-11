"""Private browser-estimator fixture across transport hypotheses; no fuel film.

Film delivery cannot be applied to a nonlambda-command air reference, so those
two prior experimental kernels are deliberately not part of this comparison.
"""
import json
import numpy as np
from ve_moving_command import ROOT,c,build
rows=[]
for directory in [ROOT/'archive/d1/2026-10-11-injection-check/8084903e-f8ae-432e-9440-fa61c161c8a7',ROOT/'archive/d1/2026-10-11-rf-response-check/02ef23a7-49da-4c03-b8c2-a6f5b944e7cc']:
    data=c.m.load(directory);session=data['proof']['session']
    for model in c.m.b.h.HYPOTHESES:
        if model.deposited:continue
        d=build(data,model,True);x=d['x'].toarray()
        for i,v in enumerate(x):
            row=dict(shares=[dict(cell=int(j),weight=float(v[j])) for j in np.flatnonzero(v>0)],time=float(d['times'][i]),bank=int(d['bank'][i]),index=int(d['ids'][i].split(':')[1]),model=model.name,session=str(session),weight=float(d['weight'][i]))
            if np.isfinite(d['lower'][i]):row['lower']=float(d['lower'][i])
            if np.isfinite(d['upper'][i]):row['upper']=float(d['upper'][i])
            rows.append(row)
        print(json.dumps(dict(session=session,model=model.name,rows=len(x))),flush=True)
(ROOT/'archive/ve-moving/command-strict-all-models-browser.json').write_text(json.dumps(dict(cellCount=x.shape[1],rows=rows)),encoding='utf-8')
