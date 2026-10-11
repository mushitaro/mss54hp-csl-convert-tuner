"""Normalize independently measured lambda and bound its clock alignment.

Input JSON: source, unit (lambda/afr), stoichiometricAfr if AFR, syncAnchors
[{deviceTime, logTimeMin, logTimeMax}], samples [{deviceTime, bank, value,
ready, valid, clipped}]. Times are seconds; bank is 1 or 2.
Requires at least three synchronization anchors bracketing accepted samples.
Uses an affine clock, never an inferred exhaust delay or a narrowband conversion.
Private output only, no Tune/BIN integration or ECU writes.
"""
import argparse
import hashlib
import itertools
import json
from pathlib import Path
import sys
import numpy as np

ROOT=Path(__file__).resolve().parents[1]


def finite(v):
    return isinstance(v,(float,int)) and not isinstance(v,bool) and np.isfinite(v)


def clock_vertices(anchors):
    if len(anchors)<3:raise ValueError('At least three clock anchors required')
    if any(not all(finite(a.get(k)) for k in ['deviceTime','logTimeMin','logTimeMax']) or a['logTimeMin']>a['logTimeMax'] for a in anchors):
        raise ValueError('Invalid clock anchor interval')
    t=np.array([a['deviceTime'] for a in anchors]);origin=float(np.mean(t));t=t-origin
    if np.any(np.diff(t)<=0):raise ValueError('Clock anchors must be strictly increasing')
    rows=[];bounds=[]
    for tt,anchor in zip(t,anchors):
        rows.extend([[tt,1],[-tt,-1]])
        bounds.extend([anchor['logTimeMax'],-anchor['logTimeMin']])
    # Positive rate; separate low-level sampling uncertainty is supplied in the
    # anchor intervals, not invented from a good-looking least-squares residual.
    rows.append([-1,0]);bounds.append(0.)
    mat=np.array(rows,float);rhs=np.array(bounds,float);vertices=[]
    for i,j in itertools.combinations(range(len(rows)),2):
        pair=mat[[i,j]]
        if abs(np.linalg.det(pair))<1e-12:continue
        point=np.linalg.solve(pair,rhs[[i,j]])
        if point[0]>0 and np.all(mat@point<=rhs+1e-8):vertices.append(point)
    if not vertices:raise ValueError('Clock anchors inconsistent with a positive affine clock')
    return origin,np.unique(np.round(vertices,12),axis=0)


def align(payload):
    if not isinstance(payload.get('source'),str) or not payload['source'].strip():
        raise ValueError('A physical measurement source is required')
    unit=payload.get('unit')
    if unit not in ['lambda','afr']:raise ValueError('Only independently measured lambda or AFR is accepted')
    divisor=1.
    if unit=='afr':
        divisor=payload.get('stoichiometricAfr')
        if not finite(divisor) or divisor<=0:raise ValueError('AFR requires the logger\'s stoichiometric AFR setting')
    anchors=payload.get('syncAnchors',[]);origin,vertices=clock_vertices(anchors)
    minimum,maximum=anchors[0]['deviceTime'],anchors[-1]['deviceTime']
    output=[];rejected=[];previous={}
    for index,sample in enumerate(payload.get('samples',[])):
        bank=sample.get('bank');t=sample.get('deviceTime');value=sample.get('value')
        reason=None
        if bank not in [1,2] or isinstance(bank,bool):reason='bank-unknown'
        elif not finite(t) or not finite(value) or value<=0:reason='invalid-measurement'
        elif t<=previous.get(bank,-np.inf):reason='clock-reset-or-duplicate'
        elif sample.get('ready') is not True or sample.get('valid') is not True or sample.get('clipped') is not False:
            reason='sensor-state-unverified'
        elif not minimum<=t<=maximum:reason='outside-clock-anchors'
        if finite(t) and bank in [1,2] and not isinstance(bank,bool):previous[bank]=max(previous.get(bank,-np.inf),t)
        if reason:rejected.append(dict(index=index,reason=reason));continue
        times=vertices@np.array([t-origin,1.])
        output.append(dict(index=index,bank=bank,measuredLambda=value/divisor,
                           sensorLogTimeMin=float(times.min()),sensorLogTimeMax=float(times.max())))
    return dict(source=payload['source'],unit='lambda',samples=output,rejected=rejected,
                clockRateRange=[float(vertices[:,0].min()),float(vertices[:,0].max())],
                combustionTimeAssigned=False,
                limitations=['Bounds assume the clock is affine between synchronization anchors.',
                    'These are sensor observation times, not combustion times. Exhaust/sensor transport remains separate.',
                    'Independent lambda does not remove uncertainty in DME reads, injector behaviour or table identifiability.',
                    'No VE correction is generated or accepted by Tune.'])


if __name__=='__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('measurement_json',type=Path)
    args=p.parse_args();data=args.measurement_json.read_bytes();result=align(json.loads(data))
    digest=hashlib.sha256(data).hexdigest();result['inputSha256']=digest
    result['scriptSha256']=hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    out=ROOT/'archive/measured-lambda'/digest;out.mkdir(parents=True,exist_ok=True)
    (out/'aligned.json').write_text(json.dumps(result,ensure_ascii=False,indent=2,allow_nan=False),encoding='utf-8')
    print(json.dumps(dict(output=str(out/'aligned.json'),accepted=len(result['samples']),rejected=len(result['rejected']))))
