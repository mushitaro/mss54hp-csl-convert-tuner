"""Audit which observations move a VE bound estimate. Private output, no BIN writes."""
from pathlib import Path
import sys,json,importlib.util,hashlib
sys.dont_write_bytecode=True
import numpy as np
from threadpoolctl import threadpool_limits
threadpool_limits(1)
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('bounds_replay',ROOT/'scripts/analyze-response-bounds.py')
b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)
from ve_response_bounds import Bands,fit,evaluate,residuals

def run(directory):
    read=lambda p:json.loads(p.read_text(encoding='utf-8'))
    raw=read(directory/'log.json');derived=ROOT/'archive/dme-response-flash-context'/directory.name
    proof=read(derived/'analysis.json');maps=read(derived/'maps.json');points=read(derived/'points.json')
    previous=read(ROOT/'archive/response-bounds'/directory.name/'analysis.json')
    assert hashlib.sha256((directory/'log.json').read_bytes()).hexdigest()==previous['logSha256']
    for name,digest in previous['sourceHashes'].items():
        assert hashlib.sha256((ROOT/'scripts'/name).read_bytes()).hexdigest()==digest,name
    constant,recording=b.n.reference(directory)
    assert recording['sha256']==previous['recordingSha256']
    p=b.n.prepare_nominal(raw,points,maps,proof['calibration'],constant)
    intervals,unexplained=b.controller_intervals(raw,proof['calibration'],previous['gains'])
    columns=np.arange(np.array(maps['baseline']).size)
    models={name:b.observations(p,raw,intervals,next(h for h in b.h.HYPOTHESES if h.name==name),columns) for name in ['flow-0.25','flow-0.25-mix']}
    ids=sorted(set.intersection(*[set(e) for e in models.values()]))
    entries=models['flow-0.25-mix'];bands,times=b.assemble(entries,ids)
    edges=np.linspace(p['observed'].min(),p['observed'].max(),5)
    folds=np.clip(np.searchsorted(edges,times,side='right')-1,0,3)
    index=np.array([entries[i]['index'] for i in ids]);kind=np.array([entries[i]['kind'] for i in ids]);bank=np.array([entries[i]['bank'] for i in ids])
    col=maps['load'].index(7.5)*len(maps['rpm'])+maps['rpm'].index(2400)
    x=bands.design.toarray();support=x[:,col]>1e-9
    full=fit(bands,.4);err=residuals(bands,full)
    summary={'session':proof['session'],'targetColumn':col,'factor':float(full['factors'][col]),'folds':[],'ablation':[],'observations':[],
        'logSha256':previous['logSha256'],'recordingSha256':recording['sha256'],
        'sourceHashes':{**previous['sourceHashes'],Path(__file__).name:hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}}
    for fold in range(4):
        train,test=b.h.split_masks(folds,times,fold)
        fitted=fit(bands.subset(train),.4)
        summary['folds'].append(dict(fold=fold,start=float(edges[fold]),end=float(edges[fold+1]),constraints=int(test.sum()),supportedConstraints=int((test&support).sum()),
            supportWeight=float(x[test,col].sum()),squaredWeight=float((x[test,col]**2).sum()),gradientAtFull=float((x[test,col]*err[test]).sum()),
            fittedWithoutFold=float(fitted['factors'][col]),supportedHeldout=evaluate(bands.subset(test&support),fitted) if np.any(test&support) else None))
    selectors={'all':np.ones(len(ids),bool),'pointOnly':kind=='point','durationOnly':kind=='duration','bank1':bank==1,'bank2':bank==2}
    for name,keep in selectors.items():
        fitted=fit(bands.subset(keep),.4)
        summary['ablation'].append(dict(name=name,factor=float(fitted['factors'][col]),bankOffset=fitted['bankOffset'],targetGradient=float((x[keep,col]*residuals(bands.subset(keep),fitted)).sum())))
    # Group support by observation-time gaps, not by bins or assumed fixed operating points.
    order=np.flatnonzero(support);order=order[np.argsort(times[order])]
    groups=np.split(order,np.flatnonzero(np.diff(times[order])>5.)+1)
    summary['passes']=[]
    for group_id,jj in enumerate(groups):
        if not len(jj):continue
        keep=np.ones(len(ids),bool);keep[jj]=False
        fitted=fit(bands.subset(keep),.4)
        summary['passes'].append(dict(id=group_id,start=float(times[jj].min()),end=float(times[jj].max()),indices=sorted(set(index[jj].tolist())),
            constraints=len(jj),rich=int(np.isfinite(bands.upper[jj]).sum()),lean=int(np.isfinite(bands.lower[jj]).sum()),
            weight=float(x[jj,col].sum()),squaredWeight=float((x[jj,col]**2).sum()),gradientAtFull=float((x[jj,col]*err[jj]).sum()),
            fittedWithoutPass=float(fitted['factors'][col])))
    for j in np.flatnonzero(support):
        r=raw[index[j]]
        summary['observations'].append(dict(id=ids[j],index=int(index[j]),fold=int(folds[j]),time=float(times[j]),weight=float(x[j,col]),
            lower=float(bands.lower[j]) if np.isfinite(bands.lower[j]) else None,upper=float(bands.upper[j]) if np.isfinite(bands.upper[j]) else None,
            prediction=float(x[j]@full['factors']+bands.bank[j]*full['bankOffset']),residual=float(err[j]),gradient=float(x[j,col]*err[j]),
            rpm=r['rpm'],load=points[index[j]]['load'],k=r['rfKorrDirect'],rfSoll=r['rfSollDirect'],stft1=r['stft1'],stft2=r['stft2'],o2=[r['o2Precat1Mv'],r['o2Precat2Mv']],
            cells=[dict(column=int(c),weight=float(x[j,c]),factor=float(full['factors'][c])) for c in np.flatnonzero(x[j]>1e-5)]))
    out=ROOT/'archive/response-influence'/directory.name;out.mkdir(parents=True,exist_ok=True)
    np.savez_compressed(out/'constraints.npz',x=x,lower=bands.lower,upper=bands.upper,bank=bands.bank,weight=bands.weight,times=times,folds=folds,index=index,kind=kind,ids=np.array(ids))
    (out/'analysis.json').write_text(json.dumps(summary,indent=2),encoding='utf-8')
    print(json.dumps({k:v for k,v in summary.items() if k!='observations'},indent=2),flush=True)

if __name__=='__main__':run(Path(sys.argv[1]).resolve())
