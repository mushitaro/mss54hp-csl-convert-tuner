"""Numerical checks for the private transient identifiability experiment."""
import importlib.util
import sys
from pathlib import Path
import numpy as np
from scipy.special import expit

sys.dont_write_bytecode = True

path=Path(__file__).with_name('analyze-ve-transient.py')
spec=importlib.util.spec_from_file_location('transient',path)
m=importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

# Smoothly moving 2-D trajectory; each corner contributes and true error has both signs.
# Independent deterministic train/test trajectories and noise, no fixed-point dwell.
def samples(seed,phase):
    rng=np.random.default_rng(seed)
    time=np.arange(9000)*.11
    rpm=2450+245*np.sin(time*.097+phase)
    load=8.75+1.24*np.sin(time*.161+phase*.37)
    x=m.basis(rpm,load,(np.array([2200,2700]),np.array([7.5,10])),np.array([[.6,.9],[1.0,1.3]]))
    assert np.allclose(x.sum(axis=1),1)
    z=.17*np.sin(time*.79+phase)+.06*np.cos(time*.31)
    bank=np.where(np.arange(len(time))%2,-.5,.5)
    design=np.column_stack([x,bank])
    truth=np.array([-.11,.055,-.045,.105,.012])
    y=rng.binomial(1,expit((z-design@truth)/.04))
    return design,z,y,truth

x,z,y,truth=samples(971,0)
estimated=m.fit(x,z,y,regularization=1)
assert np.max(np.abs(estimated-truth))<.012,(estimated,truth)
tx,tz,ty,_=samples(972,1.73)
score=m.metrics(ty,expit((tz-tx@estimated)/.04))
assert score['balancedAccuracy']>.8,score
print('PASS: recover known bidirectional error on moving trajectory; independent trajectory validation')

# Rich-only evidence never finds a finite lower error bound from likelihood alone.
one=np.ones((100,1)); forcing=np.linspace(-.04,.16,100)
loss=[]
for beta in [0,-.1,-.2,-.4]:
    v=(forcing-beta)/.04
    loss.append(np.logaddexp(0,v).sum()-v.sum())
assert np.all(np.diff(loss)<0),loss
print('PASS: one-sided evidence has no finite optimum without a prior')

# Interpolated fuel/position must not cross reset, gap or range boundaries.
t=np.array([0.,.5,1.,3.])
epochs=np.array([0,0,1,1])
_,ok=m.interp(np.array([.25,.75,2.,-.1]),t,np.array([1.,2.,3.,4.]),epochs,np.array([0,0,1,0]))
assert ok.tolist()==[True,False,False,False],ok
print('PASS: reset/gap/out-of-range interpolation rejected')
assert m.metrics([1,1],[.9,.8])['balancedAccuracy'] is None
print('PASS: all-rich subset cannot claim two-class validation')
print({'syntheticMaxLogParameterError':float(np.max(np.abs(estimated-truth))),'syntheticHeldOut':score})
