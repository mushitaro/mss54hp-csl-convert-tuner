"""Constrain one cell at a time and refit neighbours on training blocks only.

This tests effective-air factors within the recorded-input model. It does not
turn an ordinal O2 likelihood into a nominal VE confidence interval.
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import numpy as np
from scipy.optimize import minimize
from scipy.sparse import csr_matrix
from scipy.special import expit

sys.dont_write_bytecode=True
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('history_analysis',Path(__file__).with_name('analyze-response-history.py'))
a=importlib.util.module_from_spec(spec);spec.loader.exec_module(a)
h=a.h


def constrained_fit(x,z,bank,y,col,factor,initial,regularization=1.,width=.04):
    x=csr_matrix(x)
    penalty=np.r_[np.full(x.shape[1],regularization/.2**2),regularization/.03**2]
    bounds=[(-.7,.7)]*x.shape[1]+[(-.1,.1)]
    if col is not None:
        if not 0<=col<x.shape[1] or not np.exp(-.7)<=factor<=np.exp(.7):
            raise ValueError('Constraint out of model domain')
        bounds[col]=(np.log(factor),np.log(factor))
    def loss(beta):
        f=np.exp(beta[:-1]);air=np.asarray(x@f).ravel()
        v=(z-np.log(air)-bank*beta[-1])/width;e=expit(v)-y
        objective=np.logaddexp(0,v).sum()-y@v+.5*np.sum(penalty*beta**2)
        gradient=np.r_[-f*np.asarray(x.T@(e/air)).ravel()/width,-bank@e/width]+penalty*beta
        return objective,gradient
    result=minimize(loss,initial,jac=True,bounds=bounds,method='L-BFGS-B',
                    options={'maxiter':1500,'ftol':1e-10,'gtol':1e-5})
    if not result.success:raise RuntimeError(result.message)
    if col is not None and abs(np.exp(result.x[col])-factor)>1e-10:
        raise AssertionError('Constraint escaped')
    return result.x,float(result.fun)


def run(directory, nominal=False):
    raw=a.old.read(directory/'log.json');raw=raw if isinstance(raw,list) else raw['data']
    saved_dir=ROOT/'archive'/('nominal-response' if nominal else 'response-history')/directory.name
    report=a.old.read(saved_dir/'analysis.json');saved=a.old.read(saved_dir/'predictions.json')
    for name,digest in report['scriptHashes'].items():
        if hashlib.sha256((ROOT/'scripts'/name).read_bytes()).hexdigest()!=digest:
            raise ValueError('Saved model provenance is stale: '+name)
    if hashlib.sha256((directory/'log.json').read_bytes()).hexdigest()!=report['logFileSha256']:
        raise ValueError('Log provenance differs')
    if hashlib.sha256((directory/'base.bin').read_bytes()).hexdigest()!=report['baseSha256']:
        raise ValueError('BASE provenance differs')
    derived=ROOT/'archive'/('dme-response-flash-context' if nominal else 'dme-response')/directory.name
    maps=a.old.read(derived/'maps.json');points=a.old.read(derived/'points.json')
    calibration=a.old.read(derived/'analysis.json')['calibration']
    if nominal:
        ns=importlib.util.spec_from_file_location('nominal',Path(__file__).with_name('analyze-nominal-response.py'))
        n=importlib.util.module_from_spec(ns);ns.loader.exec_module(n)
        if hashlib.sha256(Path(ns.origin).read_bytes()).hexdigest()!=report['airReference']['scriptSha256']:
            raise ValueError('Nominal-reference source changed')
        ti_const,proof=n.reference(directory)
        if proof!=report['airReference']['historicalCalibration']:raise ValueError('Recording reference changed')
        prepared=n.prepare_nominal(raw,points,maps,calibration,ti_const)
    else:prepared=a.prepare(raw,points,maps,calibration)
    used=np.array(report['cellIndices']);common=np.array(saved['commonIds']);folds=np.array(saved['folds'])
    models={};out=[];fits=[]
    factors=[.55,.7,.85,1.,1.15]
    for item in saved['saved']:
        if item['input']!='fuel':continue
        model=next(m for m in h.HYPOTHESES if m.name==item['model'])
        if model.name not in models:
            d=a.take(a.features(prepared,model,'fuel'),common);d['x']=d['x'][:,used];models[model.name]=d
        d=models[model.name];t=prepared['observed'][d['rows']]
        train,test=h.split_masks(folds,t,item['fold']);initial=np.array(item['beta'])
        assert np.array_equal(common[test],item['ids'])
        for row,load in enumerate(maps['load']):
            for c,rpm in enumerate(maps['rpm']):
                if not (7.5<=load<=10 and 2200<=rpm<=2700):continue
                cell=row*len(maps['rpm'])+c;col=int(np.flatnonzero(used==cell)[0])
                support=d['x'][test,col]>.01
                for factor in factors:
                    beta,obj=constrained_fit(d['x'][train],d['z'][train],d['bank'][train],d['y'][train],col,factor,initial)
                    pred=h.predict(d['x'][test],d['z'][test],d['bank'][test],beta)
                    out.append(dict(fold=item['fold'],rpm=rpm,load=load,factor=factor,objective=obj,
                                    baselineFactor=float(np.exp(initial[col])),
                                    ids=common[test].tolist(),support=support.tolist(),y=d['y'][test].tolist(),pred=pred.tolist()))
                    fits.append(dict(fold=item['fold'],rpm=rpm,load=load,factor=factor,beta=beta.tolist()))
                print(json.dumps(dict(fold=item['fold'],rpm=rpm,load=load,done=True)),flush=True)
    summary=[]
    for target in report['focusCellSupport']:
        rr=dict(rpm=target['rpm'],load=target['load'],factors=[])
        for factor in factors:
            parts=[r for r in out if r['rpm']==target['rpm'] and r['load']==target['load'] and r['factor']==factor]
            yy=np.concatenate([r['y'] for r in parts]);pp=np.concatenate([r['pred'] for r in parts]);ss=np.concatenate([r['support'] for r in parts])
            ids=np.concatenate([r['ids'] for r in parts]);assert len(set(ids))==len(common)
            rr['factors'].append(dict(factor=factor,all=a.old.metrics(yy,pp),
                                     local=a.old.metrics(yy[ss],pp[ss]) if ss.any() else None))
        summary.append(rr)
    destination=ROOT/'archive'/('nominal-response-profile' if nominal else 'response-profile')/directory.name;destination.mkdir(parents=True,exist_ok=True)
    result=dict(session=report['session'],baseSha256=report['baseSha256'],logFileSha256=report['logFileSha256'],
                sourceHashes={**report['scriptHashes'],Path(__file__).name:hashlib.sha256(Path(__file__).read_bytes()).hexdigest()},
                model='Frozen nested-selected transport, same blocked held-out observations; constrained cell and refitted neighbours.',
                constraints='Effective-air factors .55, .70, .85, 1.00, 1.15; same default prior and parameter bounds as source fit.',
                limitations=['This is sensitivity within a misspecified conditional model, not a calibrated confidence interval.',
                             'Global metrics can hide local error: local transported-cell support is reported separately.',
                             'Cell factors do not simulate post-flash RF gates, adaptation or closed-loop feedback.'],cells=summary)
    (destination/'analysis.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    (destination/'fits.json').write_text(json.dumps(dict(cellIndices=used.tolist(),fits=fits,predictions=out)),encoding='utf-8')
    print(json.dumps(result,ensure_ascii=False))


if __name__=='__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('session_directory',type=Path)
    p.add_argument('--nominal',action='store_true')
    args=p.parse_args();run(args.session_directory.resolve(),args.nominal)
