"""Independent physical invariant: corrected fuel is compared with pre-k air."""
import importlib.util
from pathlib import Path
import sys
import numpy as np
sys.dont_write_bytecode=True
spec=importlib.util.spec_from_file_location('nominal',Path(__file__).with_name('analyze-nominal-response.py'))
n=importlib.util.module_from_spec(spec);spec.loader.exec_module(n)

constant=9739;nominal_rf=.8;nominal_ti=constant/1000*nominal_rf
raw=[];points=[]
for i,k in enumerate(np.r_[np.ones(20),np.linspace(1,1.2,20),np.full(20,1.2)]):
    t=i*.2
    r=dict(time=t,rpm=2400,rf=nominal_rf*k*100,baseInjectionMs=nominal_ti*k/2,rawLoad=7.5,
        rfSollDirect=nominal_rf,rfSollDirectTime=t,rfSollDirectReadMs=0,rfDirectSource='ram-0401-unverified',
        stft1=1/k,stft2=1/k,baFTi=1,injectionBlankActual=0,injectionBlankTarget=0,
        o2Precat1Mv=700,o2Precat2Mv=700,lambdaState1=1,lambdaState2=1,coolantTemp=90,tankVent=0,ltft1=1,ltft2=1)
    for j in range(1,7):r[f'injection{j}Ms']=nominal_ti
    for group in ['standard','lambda','injection']:
        r[group+'ReadTime']=t;r[group+'ReadMs']=0
    raw.append(r);points.append(dict(time=t,rpm=2400,load=7.5))
maps=dict(rpm=[2000,3000],load=[5,10],baseline=[[.8,.8],[.8,.8]])
cal=dict(richMv=510,leanMv=400)
old=n.a.prepare(raw,points,maps,cal)
new=n.prepare_nominal(raw,points,maps,cal,constant)
assert np.array_equal(old['fuel'],new['fuel'],equal_nan=True),'Final measured TI must never be undone twice'
assert np.array_equal(old['estimated'],new['estimated'],equal_nan=True),'Estimated fuel still needs the applied k already in TL'
ratio=new['fuel'][:,0]/new['air_cells'].sum(axis=1)
assert np.allclose(ratio,1),'Compensated enrichment cannot appear as changing nominal VE'
old_ratio=old['fuel'][:,0]/old['air_cells'].sum(axis=1)
assert np.isclose(old_ratio[0],1) and np.isclose(old_ratio[-1],1/1.2)
assert np.allclose(new['flow'],2400*80),'Physical reference flow must not rise with a fuel-only k correction'
rich=[{**r,**{f'injection{j}Ms':r[f'injection{j}Ms']*1.1 for j in range(1,7)}} for r in raw]
extra=n.prepare_nominal(rich,points,maps,cal,constant)
assert np.allclose(extra['fuel'][:,0]/extra['air_cells'].sum(axis=1),1.1),'A real fuel change must remain visible'
print('PASS pre-k reference is invariant under compensated k changes; measured fuel is unchanged and real enrichment is retained')
