"""Unpenalized, per-cell cross-drive identification and input/model sensitivity.

Requires the verified recorded-calibration replay. Uses source logs, recorded BIN and DME
controller branches; no removal of an influential passage and no BIN writer.
"""
from pathlib import Path
import argparse,importlib.util,json,sys,hashlib
sys.dont_write_bytecode=True
import numpy as np
from scipy.sparse import csr_matrix,vstack
from threadpoolctl import threadpool_limits
from ve_response_bounds import Bands
from ve_controller_bounds import switch_envelope,feasible_range
threadpool_limits(1)
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('bounds_analysis',ROOT/'scripts/analyze-response-bounds.py')
b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)
read=lambda p:json.loads(p.read_text(encoding='utf-8'))


def load(directory):
    raw=read(directory/'log.json');dd=ROOT/'archive/dme-response-flash-context'/directory.name
    proof=read(dd/'analysis.json');maps=read(dd/'maps.json');points=read(dd/'points.json')
    if (hashlib.sha256((directory/'log.json').read_bytes()).hexdigest()!=maps['logFileSha256']
        or hashlib.sha256((directory/'base.bin').read_bytes()).hexdigest()!=maps['baseSha256']
        or len(raw)!=len(points) or any(r['time']!=p['time'] or r['rpm']!=p['rpm'] for r,p in zip(raw,points))):
        raise ValueError('Log/BIN/coordinates provenance mismatch')
    constant,recording=b.n.reference(directory)
    return dict(directory=directory,raw=raw,proof=proof,maps=maps,points=points,constant=constant,recording=recording)


def prepare(data,clock):
    raw,points,maps=data['raw'],data['points'],data['maps'];cal=data['proof']['calibration']
    if all('injection1Ms' in r for r in raw):
        p=b.n.prepare_nominal(raw,points,maps,cal,data['constant'],clock,.5+clock)
        gains=b.gain_bounds((ROOT/'archive/dme-response-flash-context'/data['directory'].name/'recorded-flash.bin').read_bytes(),.01)
        intervals,unexplained=b.controller_intervals(raw,cal,gains)
        return p,intervals,'measured-command'
    col=lambda key:np.array([r[key] for r in raw],float)
    times={}
    for kind in ['standard','lambda','rfSollDirect','rfKorrDirect']:
        key=kind+('Time' if kind.startswith('rf') else 'ReadTime')
        times[kind]=col(key)+clock*col(kind+'ReadMs')/1000
    grid=np.arange(max(t[0] for t in times.values()),min(t[-1] for t in times.values()),.1)
    rpm=b.h.interpolate(grid,times['standard'],col('rpm'))
    load=b.h.interpolate(grid,times['standard'],np.array([p['load'] for p in points]))
    rf=b.h.interpolate(grid,times['rfSollDirect'],col('rfSollDirect'))
    k=b.h.interpolate(grid,times['rfKorrDirect'],col('rfKorrDirect'))
    u=b.h.interpolate(grid,times['lambda'],np.c_[col('stft1'),col('stft2')]);ba=b.h.interpolate(grid,times['lambda'],col('baFTi'))
    active=(col('lambdaState1').astype(int)&1>0)&(col('lambdaState2').astype(int)&1>0)
    air=data['constant']/1000*rf*rpm/120;fuel=air[:,None]*k[:,None]*u*ba[:,None]
    fuel[b.h.discrete(grid,times['lambda'],active.astype(float),.5+clock)!=1]=np.nan
    basis=b.a.old.basis(rpm,load,(np.array(maps['rpm']),np.array(maps['load'])),np.array(maps['baseline']))
    o2=np.c_[col('o2Precat1Mv'),col('o2Precat2Mv')]
    labels=np.where(o2>=cal['richMv'],1,np.where(o2<=cal['leanMv'],0,np.nan))
    score=active&(col('coolantTemp')>=65)&(col('tankVent')==0)&(col('ltft1')==1)&(col('ltft2')==1)&(col('baFTi')==1)
    return dict(grid=grid,fuel=fuel,air_cells=air[:,None]*basis,flow=rpm*rf*100,labels=labels,score=score,observed=times['lambda']),[],'reconstructed-fuel'


def entries(data,p,intervals,model):
    raw=data['raw'];out=b.observations(p,raw,intervals,model,np.arange(np.array(data['maps']['baseline']).size))
    ff,aa,_=b.h.history(p['grid'],p['fuel'],p['air_cells'],p['flow'],model)
    total=aa.sum(1);valid=np.isfinite(ff).all(1)&np.isfinite(aa).all(1)&(total>0)&np.all(ff>0,axis=1)
    dt=float(np.median(np.diff(p['grid'])))
    # Executed-P information also exists in #967. It does not require measured
    # TI or an inferred integral duration. Keep its reconstructed-fuel uncertainty.
    # Do not fabricate missing cut channels to pass the I-duration eligibility.
    switch_intervals=list(intervals)
    if not intervals:
        cal=data['proof']['calibration']
        for i in range(1,len(raw)):
            prev,cur=raw[i-1],raw[i]
            if not (p['score'][i-1] and p['score'][i]) or not 0<cur['lambdaReadTime']-prev['lambdaReadTime']<=1.5:continue
            for bank in [1,2]:
                key='lambdaPSteps'+str(bank)
                if not 2<=cur[key]-prev[key]<255 or max(prev[key],cur[key])>=255:continue
                if any(not cal['trimMin']+1/32768<r['stft'+str(bank)]<cal['trimMax']-1/32768 for r in [prev,cur]):continue
                switch_intervals.append(dict(index=i,bank=bank,start=prev['lambdaReadTime']-prev['lambdaReadMs']/2000,
                                             end=cur['lambdaReadTime']+cur['lambdaReadMs']/2000))
    for c in switch_intervals:
        i,bank=c['index'],c['bank'];key='lambdaPSteps'+str(bank);m=raw[i][key]-raw[i-1][key]
        if m<2:continue
        jj=np.flatnonzero((p['grid']+dt/2>c['start'])&(p['grid']-dt/2<c['end']))
        if not len(jj) or not valid[jj].all():continue
        covered=np.maximum(0,np.minimum(p['grid'][jj]+dt/2,c['end'])-np.maximum(p['grid'][jj]-dt/2,c['start'])).sum()
        if abs(covered-(c['end']-c['start']))>1e-7:continue
        for row,lo,hi in switch_envelope(aa[jj]/total[jj,None],ff[jj,bank-1]/total[jj],m):
            side='rich' if np.isfinite(hi) else 'lean';key=f'switch:{i}:{bank}:{side}'
            out[key]=dict(id=key,index=i,bank=bank,kind='switch',time=(c['start']+c['end'])/2,row=row,lower=lo,upper=hi)
    return out


def profile(groups,column,estimated_width,threshold):
    rows=[];lower=[];upper=[];nuisance=[];keys=[]
    for group,(data,observations,fuelkind) in enumerate(groups):
        for key,r in observations.items():
            if r['row'][column]<=threshold:continue
            width=estimated_width if fuelkind=='reconstructed-fuel' else 0.
            rows.append(r['row']);lower.append(r['lower']*(1-width));upper.append(r['upper']*(1+width))
            n=np.zeros(len(groups));n[group]=-.5 if r['bank']==1 else .5;nuisance.append(n)
            keys.append(f"{data['proof']['session']}:{key}")
    if not rows:return dict(status='no-evidence',range=None,constraints=0)
    bands=Bands(csr_matrix(rows),np.array(lower),np.array(upper),np.zeros(len(rows)),np.ones(len(rows)))
    r=feasible_range(bands,column,np.array(nuisance))
    if r['status']=='feasible':
        for c in r['upperCertificate']:c['id']=keys[c['row']]
    return dict(**r,constraints=len(rows),rich=int(np.isfinite(upper).sum()),lean=int(np.isfinite(lower).sum()))


def run(directories,all_models=False):
    data=[load(d.resolve()) for d in directories]
    if any(d['recording']['sha256']!=data[0]['recording']['sha256'] or d['maps']['baseline']!=data[0]['maps']['baseline'] for d in data):
        raise ValueError('Joint identification requires the same recorded calibration and map')
    maps=data[0]['maps'];column=maps['load'].index(7.5)*len(maps['rpm'])+maps['rpm'].index(2400)
    models=b.h.HYPOTHESES if all_models else [m for m in b.h.HYPOTHESES if m.name in ['flow-0.25','flow-0.25-mix']]
    results=[]
    for clock in [-.5,0.,.5]:
        prepared=[prepare(d,clock) for d in data]
        for model in models:
            groups=[(d,entries(d,p,intervals,model),kind) for d,(p,intervals,kind) in zip(data,prepared)]
            for width in [0.,.03,.05]:
                for selection in [list(range(len(groups)))] + ([[0],[1]] if clock==0 and width==0 and len(groups)==2 else []):
                    pr=profile([groups[i] for i in selection],column,width,.001)
                    item=dict(model=model.name,clock=clock,estimatedFuelWidth=width,sessions=[data[i]['proof']['session'] for i in selection],**pr)
                    results.append(item)
                    print(json.dumps({k:v for k,v in item.items() if k not in ['upperCertificate','lowerWitness','upperWitness']}),flush=True)
    out=ROOT/'archive/response-identification';out.mkdir(parents=True,exist_ok=True)
    summary=dict(target=dict(load=7.5,rpm=2400,column=column),results=results,
        calibrationStatus='comparison-only',recommendedFactor=None,
        sources=[dict(session=d['proof']['session'],logSha256=d['maps']['logFileSha256'],recordingSha256=d['recording']['sha256']) for d in data],
        scriptHashes={name:hashlib.sha256((ROOT/'scripts'/name).read_bytes()).hexdigest() for name in ['ve_controller_bounds.py','ve_response_bounds.py','analyze-response-identification.py','analyze-response-bounds.py','analyze-nominal-response.py','ve_response_history.py']},
        limitations=['Conditional bounds, not confidence intervals or identified true nominal VE.',
        'Each drive has a separate constant bank nuisance; no fitted-residual relaxation or change penalty.',
        'Only rows with target coefficient > .001 are used; discarding constraints is an outer relaxation.',
        'Estimated fuel widths and transport hypotheses are sensitivity scenarios, not measured error limits.',
        'Input-window, unobserved reset, physical air/fuel and planned RF calibration dependencies remain.'])
    (out/('all-models.json' if all_models else 'analysis.json')).write_text(json.dumps(summary,indent=2),encoding='utf-8')


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('directories',nargs='+',type=Path);parser.add_argument('--all-models',action='store_true')
    args=parser.parse_args();run(args.directories,args.all_models)
