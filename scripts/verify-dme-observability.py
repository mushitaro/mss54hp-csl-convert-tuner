"""Verify the independent air-path and constrained-cell audit arithmetic."""
from pathlib import Path
import importlib.util
import sys
import numpy as np
from scipy.special import expit

sys.dont_write_bytecode=True


def module(name,filename):
    spec=importlib.util.spec_from_file_location(name,Path(__file__).with_name(filename))
    m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m


air=module('air_audit','analyze-dme-air-path.py')
profile=module('profile_audit','profile-response-cells.py')

# Six cylinders at 2000 rpm: 100 segment updates/s. The new-input gain .6
# reaches 60%, 84%, 93.6%, rather than waiting .4 seconds.
t=np.arange(5)*.01
v=air.segment_filter(t,np.array([0.,1.,1.,1.,1.]),np.full(5,2000.),np.full(5,.6),.93)
assert np.allclose(v,[0,.6,.84,.936,.9744])
v=air.segment_filter(t,np.array([1.,0.,0.,0.,0.]),np.full(5,2000.),np.full(5,.6),.93)
assert np.allclose(v,[1,.07,.0049,.000343,.00002401])
v=air.segment_filter(t,np.array([0.,1.,np.nan,1.,1.]),np.full(5,2000.),np.full(5,.6),.93)
assert np.isnan(v[2]) and v[3]==1
print('PASS raw filter gain, segment clock, asymmetric response and missing inputs')

# Nonlinear grid geometry: interpolate the coordinates before the lookup when
# reconstructing the input. Interpolating corner lookups is a different model.
x=np.array([1000.,2000.]);y=np.array([0.,10.]);z=np.array([[.2,.4],[.6,1.]])
assert np.allclose(air.lookup(np.array([1500.,500.,2500.]),np.array([5.,-2.,15.]),x,y,z),[.55,.2,1.])
print('PASS table axes, bilinear geometry and clamped edges')

# Constrained refits cannot let a neighbour or optimiser move the pinned cell.
rng=np.random.default_rng(944);w=rng.uniform(0,1,12000)
design=np.c_[w,1-w];bank=rng.choice([-.5,.5],len(w));log_ratio=rng.uniform(-.4,.4,len(w))
truth=np.array([np.log(.8),np.log(1.2),.012])
p=expit((log_ratio-np.log(design@np.exp(truth[:-1]))-bank*truth[-1])/.04)
labels=rng.binomial(1,p)
free,free_loss=profile.constrained_fit(design,log_ratio,bank,labels,None,None,np.zeros(3))
fixed,fixed_loss=profile.constrained_fit(design,log_ratio,bank,labels,0,1.,free)
assert np.max(abs(free-truth))<.025,(free,truth)
assert abs(np.exp(fixed[0])-1)<1e-12 and fixed_loss>free_loss+50
print('PASS known-factor recovery, exact fixed-cell constraint and loss discrimination')

# A missing design column contains exactly zero information. Rich/lean events
# elsewhere cannot determine that cell; its numerical value is merely a prior.
unseen=np.c_[design,np.zeros(len(w))]
fa,_=profile.constrained_fit(unseen,log_ratio,bank,labels,2,.7,np.zeros(4))
fb,_=profile.constrained_fit(unseen,log_ratio,bank,labels,2,1.15,np.zeros(4))
pa=profile.h.predict(unseen,log_ratio,bank,fa)
pb=profile.h.predict(unseen,log_ratio,bank,fb)
assert np.max(abs(pa-pb))<1e-4
print('PASS unsupported-cell alternatives are observationally indistinguishable')

measured=module('measured_lambda','align-measured-lambda.py')
payload=dict(source='Synthetic independent lambda sensor; verification only',unit='lambda',
    syncAnchors=[dict(deviceTime=t,logTimeMin=1.001*t+3-.01,logTimeMax=1.001*t+3+.01) for t in [0.,50.,100.]],
    samples=[dict(deviceTime=25.,bank=1,value=.92,ready=True,valid=True,clipped=False),
             dict(deviceTime=35.,bank=2,value=1.02,ready=True,valid=True,clipped=False),
             dict(deviceTime=40.,bank=1,value=.91,ready=True,valid=True),
             dict(deviceTime=101.,bank=1,value=1.,ready=True,valid=True,clipped=False)])
r=measured.align(payload)
assert len(r['samples'])==2 and len(r['rejected'])==2 and r['combustionTimeAssigned'] is False
assert r['samples'][0]['measuredLambda']==.92
assert r['samples'][0]['sensorLogTimeMin']<=28.025<=r['samples'][0]['sensorLogTimeMax']
assert r['samples'][0]['sensorLogTimeMax']-r['samples'][0]['sensorLogTimeMin']<.021
for bad in [dict(payload,unit='narrowband_mv'),dict(payload,unit='afr'),
            dict(payload,syncAnchors=[dict(deviceTime=t,logTimeMin=v,logTimeMax=v) for t,v in [(0.,0.),(50.,50.),(100.,103.)]])]:
    try:measured.align(bad)
    except ValueError:pass
    else:raise AssertionError('Invalid measurement/clock silently accepted')
afr=dict(payload,unit='afr',stoichiometricAfr=14.)
assert np.isclose(measured.align(afr)['samples'][0]['measuredLambda'],.92/14.)
print('PASS independent lambda/AFR units, bounded clock drift, missing sensor state and inconsistent synchronization')
