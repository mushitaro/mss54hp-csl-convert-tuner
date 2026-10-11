"""Independent numerical/property checks; no private log or vehicle required."""
import sys
sys.dont_write_bytecode = True
import importlib.util
from pathlib import Path
import numpy as np
from scipy.special import expit
import ve_response_history as h

# Fuel stored on a step must reappear on release: use the analytical conservation
# identity, independent of the implementation's recurrence.
dt=.05
fuel=np.r_[np.full(20,2.),np.full(50,5.),np.zeros(200)].reshape(-1,1)
delivered,stored=h.film_flux(fuel,dt,.35,.8)
initial=.35*.8*fuel[0]
assert np.allclose(dt*delivered.sum(axis=0)+stored[-1],dt*fuel.sum(axis=0)+initial,atol=1e-10)
assert delivered[20,0]<fuel[20,0] and delivered[70,0]>0
steady=np.full((100,2),3.)
assert np.allclose(h.film_flux(steady,dt,.35,.8)[0],steady)
assert np.array_equal(h.film_flux(fuel,dt,0,0)[0],fuel)
print('PASS fuel reservoir mass conservation, cut-release tail and equilibrium')

# Physical causality: doubling flow halves residence for a constant-flow segment.
t=np.arange(0,8,.05)
model=h.Hypothesis('test',flow_delay=.5)
s=h.transport_time(t,np.full(len(t),2000*30.),model)
s2=h.transport_time(t,np.full(len(t),4000*30.),model)
assert np.allclose(t[30:]-s[30:],.5) and np.allclose(t[30:]-s2[30:],.25)
f=np.column_stack([np.where(t>=3,2.,1.)]*2)
air=np.ones((len(t),1))
fo,ao,_=h.history(t,f,air,np.full(len(t),60000.),model)
assert np.allclose(fo[(t>=1)&(t<3.45)],1)
assert np.allclose(fo[t>3.6],2)
assert np.nanmax(abs(ao-1))<1e-10
print('PASS flow-dependent transport and no fuel response before the stimulus')

# State changes cannot silently become half a cylinder count or extrapolated zeros.
rt=np.array([0.,1.,2.]); values=np.array([0.,6.,0.]);q=np.array([0.,.25,.75,1.,1.75,2.])
assert h.discrete(q,rt,values).tolist()==[0.,0.,6.,6.,0.,0.]
assert h.discrete(rt,rt,values,0).tolist()==values.tolist()
assert h.discrete(rt,rt,values,1).tolist()==values.tolist()
iv=h.interpolate(np.array([-.1,.5,2.,4.]),np.array([0.,1.,3.]),np.array([1.,2.,4.]))
assert np.isnan(iv[[0,2,3]]).all() and iv[1]==1.5
f[70:80]=np.nan
fo,_,_=h.history(t,f,air,np.full(len(t),60000.),model)
assert np.isnan(fo[70:90]).all()
print('PASS gaps/unknown states stop reconstruction; read endpoints preserved')

# Different air throughput makes averaging multipliers wrong. Mixing the fluxes
# must produce the ratio of summed quantities, not a mean of their logarithms.
fa=np.array([1.,20.]);aa=np.array([1.,10.])
assert not np.isclose(np.log(fa.sum()/aa.sum()),np.log(fa/aa).mean())

# Recover independently generated positive air factors on moving trajectories.
def sample(seed,phase):
    rng=np.random.default_rng(seed);t=np.arange(7000)*.1
    w=.5+.48*np.sin(t*.071+phase)
    x=np.column_stack([w,1-w]);bank=np.where(np.arange(len(t))%2,-.5,.5)
    z=.17*np.sin(t*.73+phase)+.04*np.cos(t*.21)
    truth=np.array([-.09,.07,.014])
    # Generate from the physical weighted sum directly, not h.predict.
    p=expit((z-np.log(x@np.exp(truth[:-1]))-bank*truth[-1])/.04)
    return x,z,bank,rng.binomial(1,p),truth
x,z,b,y,truth=sample(417,0.)
fit=h.fit(x,z,b,y)
assert np.max(abs(fit-truth))<.014,(fit,truth)
tx,tz,tb,ty,_=sample(418,1.3)
pred=h.predict(tx,tz,tb,fit)
assert np.mean((pred>=.5)==ty)>.8
print('PASS known air-factor recovery with an independent moving test trajectory')

# Inner selection must never train on an outer-test row or its temporal halo.
tt=np.repeat(np.arange(0,400.),2);folds=(tt//100).astype(int)
outer_train,outer_test=h.split_masks(folds,tt,2)
for inner in [0,1,3]:
    train,test=h.split_masks(folds,tt,inner,outer_train)
    assert not np.any((train|test)&outer_test)
    assert np.all((tt[train]<tt[test].min()-20)|(tt[train]>tt[test].max()+20))
    assert np.all(train[::2]==train[1::2]) and np.all(test[::2]==test[1::2])
print('PASS nested chronological embargo and bank-pair separation')

# Input semantics: nonzero TI may coexist with a complete cut. Lambda OFF does
# not zero physical fuel, and rf_korr is already inside the logged TL air proxy.
spec=importlib.util.spec_from_file_location('analysis',Path(__file__).with_name('analyze-response-history.py'))
analysis=importlib.util.module_from_spec(spec);spec.loader.exec_module(analysis)
raw=[]
for i in range(12):
    r=dict(rpm=1200,rf=30,baseInjectionMs=2,stft1=1,stft2=1,baFTi=1,
           lambdaState1=0 if i==3 else 1,lambdaState2=0 if i==3 else 1,
           o2Precat1Mv=750,o2Precat2Mv=750,injectionBlankActual=6 if i==6 else 2 if i==9 else 0,
           injectionBlankTarget=6 if i==6 else 2 if i==9 else 0,coolantTemp=85,tankVent=0,ltft1=1,ltft2=1,
           rfKorrDirect=1.2)
    for name,offset,duration in [('standard',.05,50),('lambda',.15,70),('injection',.3,150)]:
        r[name+'ReadTime']=i+offset;r[name+'ReadMs']=duration
    for cyl in range(1,7):r[f'injection{cyl}Ms']=4
    raw.append(r)
points=[dict(load=1.) for _ in raw]
maps=dict(rpm=[800,1600],load=[0,2],baseline=[[.7,.9],[1.,1.2]])
cal=dict(richMv=510,leanMv=400)
p=analysis.prepare(raw,points,maps,cal)
cut=(p['grid']>6.0)&(p['grid']<6.5)
off=(p['grid']>3.0)&(p['grid']<3.5)
partial=(p['grid']>9.0)&(p['grid']<9.5)
assert np.all(p['fuel'][cut]==0) and np.all(p['fuel'][off]>0) and np.isnan(p['fuel'][partial]).all()
for r in raw:r['rfKorrDirect']=1.0
q=analysis.prepare(raw,points,maps,cal)
assert np.allclose(p['fuel'],q['fuel'],equal_nan=True) and np.allclose(p['air_cells'],q['air_cells'],equal_nan=True)
print('PASS TI cut semantics, lambda-OFF history, no duplicate rf_korr multiplication')
