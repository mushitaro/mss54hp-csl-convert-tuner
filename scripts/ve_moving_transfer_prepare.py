"""Private #967 command-history reconstruction for untouched-drive validation.

#967 has no measured TI. B=A0*k*BA is explicitly a conditional reconstructed
command, never mislabeled as a measured injection history or production input.
"""
import json,numpy as np
from ve_moving_robust import ROOT,c
d=c.m.load(ROOT/'archive/d1/2026-10-11-rf-response-check/02ef23a7-49da-4c03-b8c2-a6f5b944e7cc')
p,intervals,kind=c.prepare(d);raw=d['raw'];col=lambda key:np.array([r[key] for r in raw],float)
h=c.m.b.h;grid=p['grid'];u=h.interpolate(grid,col('lambdaReadTime'),np.c_[col('stft1'),col('stft2')]);base=p['fuel']/u
standard=col('standardReadTime');rpm=h.interpolate(grid,standard,col('rpm'));speed=h.interpolate(grid,standard,col('vehicleSpeed'));exhaust=h.interpolate(grid,standard,col('exhaustTemp'))
rf=h.interpolate(grid,col('rfSollDirectTime'),col('rfSollDirect'));k=h.interpolate(grid,col('rfKorrDirectTime'),col('rfKorrDirect'));basis=p['air_cells']/p['air_cells'].sum(1)[:,None]
valid=np.isfinite(np.c_[base,p['fuel_lower'],p['fuel_upper'],rpm,speed,exhaust,rf,k]).all(1)&np.isfinite(basis).all(1)&(base>0).all(1)
points=[];segment=-1;previous=False
for i,t in enumerate(grid):
    if not valid[i]:points.append(None);previous=False;continue
    if not previous:segment+=1
    previous=True
    source=int(np.clip(np.searchsorted(standard,t)-1,0,len(raw)-2))
    normal=all(not (r['llsSt']&128) for r in raw[source:source+2])
    points.append(dict(time=float(t),segment=segment,rpm=float(rpm[i]),rfSoll=float(rf[i]),k=float(k[i]),speed=float(speed[i]),exhaust=float(exhaust[i]),sourceIndex=source,
        shares=[dict(index=int(j),share=float(basis[i,j])) for j in np.flatnonzero(basis[i]>0)],base=base[i].tolist(),lower=p['fuel_lower'][i].tolist(),upper=p['fuel_upper'][i].tolist(),normalStat=normal))
out=dict(history=dict(points=points,start=float(grid[0]),step=.1,injectionChecks=0,coneFailures=0,maxConeViolation=0),score=p['score'].tolist(),raw=raw,
    calibrationKind=kind,recordingSha256=d['recording']['sha256'],logSha256=d['maps']['logFileSha256'])
(ROOT/'archive/ve-moving/transfer-967-history.json').write_text(json.dumps(out),encoding='utf-8')
print('prepared',int(valid.sum()),'historypoints')
