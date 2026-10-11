"""Replay recorded injection histories; nested validation, no tuning writes.

Usage: python scripts/analyze-response-history.py <exported-session-directory>
First run analyze-dme-response.mjs for the verified BASE grid/load coordinates.
Outputs private evidence under archive/response-history/<session-id>/.
"""
import argparse
from dataclasses import asdict
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import numpy as np

sys.dont_write_bytecode = True
import ve_response_history as h
ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('transient', Path(__file__).with_name('analyze-ve-transient.py'))
old = importlib.util.module_from_spec(spec); spec.loader.exec_module(old)


def prepare(raw, points, maps, calibration, clock_fraction=0., cut_boundary=.5):
    col = lambda key: np.array([r.get(key,np.nan) for r in raw], dtype=float)
    times = {}
    for kind in ['standard','lambda','injection']:
        times[kind] = col(kind+'ReadTime')+clock_fraction*col(kind+'ReadMs')/1000
    for tt in times.values():
        if not np.isfinite(tt).all() or np.any(np.diff(tt)<=0):
            raise ValueError('Complete increasing group read times required')
    grid = np.arange(max(tt[0] for tt in times.values()), min(tt[-1] for tt in times.values()), .1)
    standard = np.column_stack([col('rpm'),col('rf'),col('baseInjectionMs'),[p['load'] for p in points]])
    s = h.interpolate(grid,times['standard'],standard)
    rpm,rf,tl,load = s.T
    bank_ti = np.column_stack([np.mean([col(f'injection{i}Ms') for i in [1,2,3]],axis=0),
                               np.mean([col(f'injection{i}Ms') for i in [4,5,6]],axis=0)])
    ti = h.interpolate(grid,times['injection'],bank_ti)
    trim_ba = h.interpolate(grid,times['lambda'],np.column_stack([col('stft1'),col('stft2'),col('baFTi')]))
    cut = h.discrete(grid,times['injection'],col('injectionBlankActual'),cut_boundary)
    fraction = np.where(cut==0,1.,np.where(cut==6,0.,np.nan))
    # Air-reference and fuel are proportional mass rates. Common injector scale
    # cancels, not individual cylinder offsets or fuel-pressure differences.
    air = 2*tl*rpm/120
    fuel = ti*rpm[:,None]/120*fraction[:,None]
    estimated = air[:,None]*trim_ba[:,:2]*trim_ba[:,2,None]*fraction[:,None]
    basis = old.basis(rpm,load,(np.array(maps['rpm']),np.array(maps['load'])),np.array(maps['baseline']))
    air_cells = basis*air[:,None]
    observed = times['lambda']
    o2 = np.column_stack([col('o2Precat1Mv'),col('o2Precat2Mv')])
    labels = np.where(o2>=calibration['richMv'],1,np.where(o2<=calibration['leanMv'],0,np.nan))
    active = (col('lambdaState1').astype(int)&1>0)&(col('lambdaState2').astype(int)&1>0)
    score = active&(col('coolantTemp')>=65)&(col('tankVent')==0)&(col('injectionBlankActual')==0)&(col('injectionBlankTarget')==0)
    score &= (col('ltft1')==1)&(col('ltft2')==1)
    return dict(grid=grid,fuel=fuel,estimated=estimated,air_cells=air_cells,flow=rpm*rf,
                observed=observed,labels=labels,score=score)


def features(prepared, hypothesis, fuel_kind):
    p = prepared
    f,a,source = h.history(p['grid'],p[fuel_kind],p['air_cells'],p['flow'],hypothesis)
    ff = h.interpolate(p['observed'],p['grid'],f)
    aa = h.interpolate(p['observed'],p['grid'],a)
    src = h.interpolate(p['observed'],p['grid'],source)
    air = aa.sum(axis=1)
    valid = p['score']&np.isfinite(aa).all(axis=1)&np.isfinite(ff).all(axis=1)&(air>0)&np.all(ff>0,axis=1)
    rows = np.flatnonzero(valid)
    y = p['labels'][rows].ravel(); good = np.isfinite(y)
    ids = (np.repeat(rows,2)*2+np.tile([0,1],len(rows)))[good]
    return dict(ids=ids,rows=np.repeat(rows,2)[good],bank=np.tile([-.5,.5],len(rows))[good],y=y[good],
                x=np.repeat(aa[rows]/air[rows,None],2,axis=0)[good],z=np.log(ff[rows]/air[rows,None]).ravel()[good],
                lag=np.repeat(p['observed'][rows]-src[rows],2)[good])


def take(d,ids):
    by_id = {int(v):i for i,v in enumerate(d['ids'])}
    if any(int(v) not in by_id for v in ids):
        raise ValueError('Comparison observations missing')
    pick = np.array([by_id[int(v)] for v in ids], dtype=int)
    return {key:value[pick] for key,value in d.items()}


def fit_predict(d, train, test, global_only=False, regularization=1.):
    x = np.ones((len(d['y']),1)) if global_only else d['x']
    beta = h.fit(x[train],d['z'][train],d['bank'][train],d['y'][train],regularization)
    pred = h.predict(x[test],d['z'][test],d['bank'][test],beta)
    return pred,beta


def run(input_dir, prepare_fn=prepare, output_folder='response-history', derived_folder='dme-response', extra_provenance=None):
    source_names=['ve_response_history.py','analyze-response-history.py','analyze-ve-transient.py']
    source_hashes={name:hashlib.sha256((ROOT/'scripts'/name).read_bytes()).hexdigest() for name in source_names}
    session = old.read(input_dir/'session.json'); raw=old.read(input_dir/'log.json')
    if not isinstance(raw,list): raw=raw['data']
    base_hash=hashlib.sha256((input_dir/'base.bin').read_bytes()).hexdigest()
    log_hash=hashlib.sha256((input_dir/'log.json').read_bytes()).hexdigest()
    derived=ROOT/'archive'/derived_folder/input_dir.name
    maps,points=old.read(derived/'maps.json'),old.read(derived/'points.json')
    calibration=old.read(derived/'analysis.json')['calibration']
    if not (base_hash==session['baseSha256']==maps['baseSha256'] and log_hash==maps['logFileSha256'] and len(raw)==len(points)==session['logPointCount']):
        raise ValueError('Session, log and calibration provenance mismatch')
    if any(p['time']!=r['time'] or p['rpm']!=r['rpm'] for p,r in zip(points,raw)):
        raise ValueError('Derived timeline not aligned')
    if any(r.get('injectionReadSource')!='block19-0401-unverified' for r in raw):
        raise ValueError('This experiment requires recorded injection data; cannot synthesize it for older logs')
    out=ROOT/'archive'/output_folder/input_dir.name;out.mkdir(parents=True,exist_ok=True)
    p=prepare_fn(raw,points,maps,calibration)
    full={}
    for kind in ['estimated','fuel']:
        for model in h.HYPOTHESES:
            full[(kind,model.name)]=features(p,model,kind)
    common=np.array(sorted(set.intersection(*[set(d['ids']) for d in full.values()])))
    if len(common)<500: raise ValueError('Insufficient shared observations for blocked validation')
    data={key:take(d,common) for key,d in full.items()}
    ref=data[('fuel','instant')];rows=ref['rows'];y=ref['y'];t=p['observed'][rows]
    edges=np.linspace(p['observed'].min(),p['observed'].max(),5)
    folds=np.clip(np.searchsorted(edges,t,side='right')-1,0,3)
    # Include all transported cells, including those no longer under current rpm/load.
    used=np.flatnonzero(np.sum([d['x'].sum(axis=0) for d in data.values()],axis=0)>1e-10)
    for d in data.values():d['x']=d['x'][:,used]
    results=[];selection=[];saved=[]
    for kind in ['estimated','fuel']:
        direct=np.full(len(y),np.nan);history=direct.copy();global_pred=direct.copy();strong_pred=direct.copy()
        chosen_betas=[];strong_betas=[]
        for outer in range(4):
            train,test=h.split_masks(folds,t,outer)
            losses=[]
            # Model choice sees only outer-training data, never this test block.
            for model in h.HYPOTHESES:
                d=data[(kind,model.name)];inner_y=[];inner_p=[]
                for inner in range(4):
                    if inner==outer: continue
                    itr,ite=h.split_masks(folds,t,inner,eligible=train)
                    prediction,_=fit_predict(d,itr,ite)
                    inner_y.extend(y[ite]);inner_p.extend(prediction)
                losses.append(old.metrics(inner_y,inner_p)['logLoss'])
            selected=h.HYPOTHESES[int(np.argmin(losses))]
            d=data[(kind,selected.name)]
            prediction,beta=fit_predict(d,train,test);history[test]=prediction
            direct[test],_=fit_predict(data[(kind,'instant')],train,test)
            global_pred[test],_=fit_predict(d,train,test,True)
            strong_pred[test],strong=fit_predict(d,train,test,regularization=10.)
            selected_metrics=old.metrics(y[test],prediction)
            chosen_betas.append(beta[:-1].tolist())
            strong_betas.append(strong[:-1].tolist())
            selection.append(dict(input=kind,outerFold=outer,selected=asdict(selected),innerLogLossByModel=dict(zip([m.name for m in h.HYPOTHESES],losses)),test=selected_metrics))
            saved.append(dict(input=kind,fold=outer,model=selected.name,beta=beta.tolist(),ids=common[test].tolist(),pred=prediction.tolist()))
            print(json.dumps({'input':kind,'fold':outer,'selected':selected.name,'test':selected_metrics}),flush=True)
        assert np.isfinite(history).all()
        current_focus=np.array([points[i]['focus'] for i in rows])
        active_k=np.array([raw[i]['rfKorrDirect']>1.001 for i in rows])
        results.append(dict(input=kind,instant=old.metrics(y,direct),selectedHistory=old.metrics(y,history),
                            globalOffsetBaseline=old.metrics(y,global_pred),rfKorrActive=old.metrics(y[active_k],history[active_k]),
                            currentFocus=old.metrics(y[current_focus],history[current_focus]) if current_focus.any() else None,
                            foldCellLogFactors=chosen_betas,
                            strongerPriorSensitivity=dict(metrics=old.metrics(y,strong_pred),foldCellLogFactors=strong_betas)))
    # Freeze selection and fitted factors; only move read positions/cut brackets.
    timing=[]
    for name,clock,cut in [('early',-.5,0.),('late',.5,1.)]:
        pp=prepare_fn(raw,points,maps,calibration,clock,cut);cache={}; yy=[];preds=[];ids_used=[]
        for item in saved:
            if item['input']!='fuel':continue
            model=next(m for m in h.HYPOTHESES if m.name==item['model'])
            if model.name not in cache:cache[model.name]=features(pp,model,'fuel')
            d=cache[model.name];keep=np.intersect1d(d['ids'],item['ids']);d=take(d,keep)
            preds.extend(h.predict(d['x'][:,used],d['z'],d['bank'],np.array(item['beta'])))
            yy.extend(d['y']);ids_used.extend(keep.tolist())
        timing.append(dict(scenario=name,clockFraction=clock,cutTransitionFraction=cut,metrics=old.metrics(yy,preds),ids=ids_used,predictions=list(map(float,preds))))
    # Each sensitivity is also compared with midpoint on EXACTLY its retained IDs.
    midpoint={i:p for item in saved if item['input']=='fuel' for i,p in zip(item['ids'],item['pred'])}
    labels={int(i):float(v) for i,v in zip(common,y)}
    for check in timing:
        check['midpointOnSameObservations']=old.metrics([labels[i] for i in check['ids']],[midpoint[i] for i in check['ids']])
    support=[]
    for r,load in enumerate(maps['load']):
        for c,rpm in enumerate(maps['rpm']):
            if not (7.5<=load<=10 and 2200<=rpm<=2700):continue
            cell=r*len(maps['rpm'])+c;where=np.flatnonzero(used==cell)
            if not len(where): support.append(dict(rpm=rpm,load=load,observations=0));continue
            col=int(where[0]);weights=np.zeros(len(y))
            for item in saved:
                if item['input']!='fuel':continue
                test=folds==item['fold'];weights[test]=data[('fuel',item['model'])]['x'][test,col]
            hit=weights>.01
            support.append(dict(rpm=rpm,load=load,observations=int(hit.sum()),rich=int(y[hit].sum()),lean=int((1-y[hit]).sum()),
                                timeBlocks=len(np.unique(folds[hit])),weight=float(weights.sum()),
                                foldLogFactors=[f[col] for f in results[1]['foldCellLogFactors']],
                                strongerPriorFoldLogFactors=[f[col] for f in results[1]['strongerPriorSensitivity']['foldCellLogFactors']]))
    counter_inventory=[]
    for bank in [1,2]:
        pairs=[]
        for previous,current in zip(raw[:-1],raw[1:]):
            delta=current[f'lambdaPSteps{bank}']-previous[f'lambdaPSteps{bank}']
            dt=current['lambdaReadTime']-previous['lambdaReadTime']
            if not (current[f'lambdaState{bank}']&1 and previous[f'lambdaState{bank}']&1 and 0<dt<=1.5 and delta>=0 and current[f'lambdaPSteps{bank}']<255):continue
            def sign(value):return 1 if value>=calibration['richMv'] else 0 if value<=calibration['leanMv'] else -1
            a,b=sign(previous[f'o2Precat{bank}Mv']),sign(current[f'o2Precat{bank}Mv'])
            pairs.append((delta,a==b and a>=0))
        counter_inventory.append(dict(bank=bank,intervals=len(pairs),multiplePSteps=sum(delta>=2 for delta,_ in pairs),
                                      sameO2SideWithMultiplePSteps=sum(delta>=2 and same for delta,same in pairs)))
    inventory={f'{kind}/{name}':len(d['ids']) for (kind,name),d in full.items()}
    output=dict(version=1,session=session['seq'],baseSha256=base_hash,logFileSha256=log_hash,rawRows=len(raw),
                commonRows=len(np.unique(rows)),commonBankObservations=len(common),inventory=inventory,
                hypotheses=[asdict(m) for m in h.HYPOTHESES],results=results,selection=selection,
                timingSensitivity=[{k:v for k,v in check.items() if k not in ['ids','predictions']} for check in timing],
                focusCellSupport=support,cellIndices=used.tolist(),controllerSampling=counter_inventory,
                scriptHashes=source_hashes,airReference=extra_provenance,
                validation='Nested 4-block outer / 3-block inner chronological validation, both banks together, 20-second embargo. No fixed operating-point gate.',
                limits=[('Cell factors modify the pre-rf_korr rf_soll reference; they remain conditional on transport, interpolation and VE-basis sensitivity.' if extra_provenance else
                        'Cell factors represent conditional effective air error; TL includes live rf_korr/MAP and upstream RF filtering. This is not a validated VE-table update.'),
                        'Flux-history, fuel-film and mixing kernels are hypotheses; physical transport parameters are not directly measured or uniquely identified.',
                        'Read-window and cut-boundary sensitivity does not recover changes between samples.',
                        'Observation sigmoid width .04 is a fixed modelling choice, not measured AFR uncertainty.',
                        'Measured fuel is an input; this is not a free-running closed-loop or post-flash validation.',
                        'Prior Session 968 analyses were exploratory; nested splits limit within-run selection leakage but are not a new independent drive.'])
    if any(hashlib.sha256((ROOT/'scripts'/name).read_bytes()).hexdigest()!=digest for name,digest in source_hashes.items()):
        raise RuntimeError('Analysis source changed during replay; rerun with unchanged files')
    (out/'analysis.json').write_text(json.dumps(output,ensure_ascii=False,indent=2),encoding='utf-8')
    (out/'predictions.json').write_text(json.dumps(dict(commonIds=common.tolist(),labels=y.tolist(),folds=folds.tolist(),saved=saved,timing=timing)),encoding='utf-8')
    print(json.dumps({'out':str(out),'summary':[{k:v for k,v in r.items() if k not in ['foldCellLogFactors','strongerPriorSensitivity']} for r in results],'timing':output['timingSensitivity'],'focus':support,'sampling':counter_inventory},ensure_ascii=False),flush=True)


if __name__=='__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('session_directory',type=Path)
    run(parser.parse_args().session_directory.resolve())
