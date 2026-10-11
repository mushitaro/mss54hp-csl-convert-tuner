"""Local robust update sensitivity, without treating one-sided minima as truth."""
import json
import numpy as np
from scipy.optimize import minimize_scalar
from ve_moving_robust import ROOT,c,build
from ve_moving_local import loss

def run():
    dirs=[ROOT/'archive/d1/2026-10-11-injection-check/8084903e-f8ae-432e-9440-fa61c161c8a7',ROOT/'archive/d1/2026-10-11-rf-response-check/02ef23a7-49da-4c03-b8c2-a6f5b944e7cc']
    dd=[c.m.load(d) for d in dirs];records=[]
    for data in dd:
        for model in c.m.b.h.HYPOTHESES:
            d=build(data,model);xx=d['x'].toarray();hit=xx[:,289]>.001
            for bank in [None,-.5,.5]:
                keep=hit if bank is None else hit&(d['bank']==bank)
                x=np.c_[xx[keep,289],xx[keep].sum(1)-xx[keep,289]];lo=d['lower'][keep];hi=d['upper'][keep];w=d['weight'][keep]
                if not len(x):continue
                fit=minimize_scalar(lambda v:loss(v,x,lo,hi,w),bounds=(.3,1.7),method='bounded')
                current=loss(1,x,lo,hi,w);record=dict(session=data['proof']['session'],model=model.name,bank=bank,rows=len(x),fit=float(fit.x),current=float(current),
                    cases=[dict(factor=f,loss=float(loss(f,x,lo,hi,w)),delta=float(loss(f,x,lo,hi,w)-current)) for f in [.97,.95,.90,.85,.80,.75,.70]])
                records.append(record)
            print(json.dumps({k:v for k,v in records[-3].items() if k!='cases'}),flush=True)
    (ROOT/'archive/ve-moving/sensitivity.json').write_text(json.dumps(records,indent=2),encoding='utf-8')

if __name__=='__main__':run()
