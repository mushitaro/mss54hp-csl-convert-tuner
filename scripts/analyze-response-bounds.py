"""Replay an alpha-free moving-history bound estimator on a recorded session.

Requires the SHA-verified recording replay and nominal-response reference replay.
No BIN/ECU output. Raw logs, matrices and reports stay under ignored archive/.
Runs nested penalty selection, frozen previously cross-validated transport,
counterfactual baseline comparison, and no-worse-per-constraint cell profiles.
"""
from pathlib import Path
import argparse,importlib.util,json,sys,hashlib
sys.dont_write_bytecode=True
import numpy as np
from scipy.sparse import csr_matrix,hstack,vstack
from scipy.optimize import linprog
from threadpoolctl import threadpool_limits
from ve_response_bounds import Bands,fit,evaluate,interval_envelope,sample_envelope,controller_duration_bounds
threadpool_limits(1);sys.dont_write_bytecode=True
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('nominal',Path(__file__).with_name('analyze-nominal-response.py'))
n=importlib.util.module_from_spec(spec);spec.loader.exec_module(n);a=n.a;h=a.h


def gain_bounds(image,tick):
    nodes={p['name']:p for p in a.old.read(ROOT/'public/data/calibration-graph.json')['nodes'] if p['t']=='param'}
    def maximum(name):
        z=nodes[name]['axes']['z'];size=z['bits']//8;count=z.get('n',z.get('rows',1)*z.get('cols',1))
        return max(int.from_bytes(image[z['addr']+size*i:z['addr']+size*(i+1)],'big') for i in range(count))
    return dict(ki_pos=maximum('KF_LA_KI_POS')/32768/tick,
                ki_neg=maximum('KF_LA_KI_NEG')/32768/tick,
                kp_pos=maximum('KF_LA_KP_POS')*16/32768,kp_neg=maximum('KF_LA_KP_NEG')*16/32768,tick=tick)


def controller_intervals(raw,cal,gains):
    intervals=[];unexplained=[]
    for i in range(1,len(raw)):
        prev,cur=raw[i-1],raw[i]
        if not 0<cur['lambdaReadTime']-prev['lambdaReadTime']<=1.5:continue
        for bank in [1,2]:
            if any(not(r[f'lambdaState{bank}']&1) or r['baFTi']!=1 or r['coolantTemp']<65
                   or r['injectionBlankActual']!=0 or r['injectionBlankTarget']!=0
                   or r['tankVent']!=0 or r['ltft1']!=1 or r['ltft2']!=1
                   or not cal['trimMin']+1/32768<r[f'stft{bank}']<cal['trimMax']-1/32768
                   for r in [prev,cur]):continue
            count=cur[f'lambdaPSteps{bank}']-prev[f'lambdaPSteps{bank}']
            if count<0 or max(prev[f'lambdaPSteps{bank}'],cur[f'lambdaPSteps{bank}'])>=255:continue
            start=prev['lambdaReadTime']-prev['lambdaReadMs']/2000
            end=cur['lambdaReadTime']+cur['lambdaReadMs']/2000
            b=controller_duration_bounds(cur[f'stft{bank}']-prev[f'stft{bank}'],count,end-start,**gains)
            item=dict(index=i,bank=bank,start=start,end=end,**b)
            (intervals if b['feasible'] else unexplained).append(item)
    return intervals,unexplained


def observations(p,raw,intervals,model,used):
    fuel,air,_=h.history(p['grid'],p['fuel'],p['air_cells'],p['flow'],model)
    total=air.sum(axis=1);dt=float(np.median(np.diff(p['grid'])))
    valid=np.isfinite(air).all(axis=1)&np.isfinite(fuel).all(axis=1)&(total>0)&np.all(fuel>0,axis=1)
    # Drop only identically unused columns, preserving every transported share.
    x=np.divide(air[:,used],total[:,None],out=np.full((len(total),len(used)),np.nan),where=total[:,None]>0)
    q=np.divide(fuel,total[:,None],out=np.full_like(fuel,np.nan),where=total[:,None]>0)
    entries=[]
    def append(start,end,index,bank,rich,lean,kind):
        jj=np.flatnonzero((p['grid']+dt/2>start)&(p['grid']-dt/2<end))
        if not len(jj) or not valid[jj].all():return
        w=np.maximum(0,np.minimum(p['grid'][jj]+dt/2,end)-np.maximum(p['grid'][jj]-dt/2,start))
        if abs(w.sum()-(end-start))>1e-7:return
        bounds=(sample_envelope(x[jj],q[jj,bank-1],rich==1.) if kind=='point'
                else interval_envelope(x[jj],q[jj,bank-1],w,rich,lean))
        for row,lo,hi in bounds:
            side='rich' if np.isfinite(hi) else 'lean'
            entries.append(dict(id=f'{kind}:{index}:{bank}:{side}',index=index,kind=kind,bank=bank,
                time=(start+end)/2,row=row,lower=lo,upper=hi))
    for c in intervals:
        append(c['start'],c['end'],c['index'],c['bank'],min(1,c['richFractionMin']),min(1,c['leanFractionMin']),'duration')
    for i,r in enumerate(raw):
        if not p['score'][i]:continue
        # Treat the transaction window as a whole; never pretend it is one ECU tick.
        start=r['lambdaReadTime']-r['lambdaReadMs']/2000;end=r['lambdaReadTime']+r['lambdaReadMs']/2000
        if end<=start:continue
        for bank in [1,2]:
            y=p['labels'][i,bank-1]
            if np.isfinite(y):append(start,end,i,bank,float(y),1-float(y),'point')
    return {r['id']:r for r in entries}


def assemble(entries,ids):
    ee=[entries[i] for i in ids]
    bands=Bands(csr_matrix(np.array([r['row'] for r in ee])),np.array([r['lower'] for r in ee]),np.array([r['upper'] for r in ee]),
                np.array([-.5 if r['bank']==1 else .5 for r in ee]),np.ones(len(ee)))
    return bands,np.array([r['time'] for r in ee])


def profile(bands,result,columns):
    """Alternatives no worse in ANY constraint, without the fitting penalty.

    This is a conditional feasible-set range, NOT a confidence interval. The
    per-observation residual allowances are explicit, not silently discarded.
    """
    x=hstack([bands.design,csr_matrix(bands.bank[:,None])]).tocsr()
    beta=np.r_[result['factors'],result['bankOffset']];value=np.asarray(x@beta).ravel()
    upper=np.maximum(bands.upper,value)+1e-7;lower=np.minimum(bands.lower,value)-1e-7
    iu=np.isfinite(upper);il=np.isfinite(lower)
    aa=vstack([x[iu],-x[il]]);bb=np.r_[upper[iu],-lower[il]]
    out=[]
    for col in columns:
        objective=np.zeros(x.shape[1]);objective[col]=1
        rr=[]
        for direction in [1,-1]:
            result=linprog(direction*objective,A_ub=aa,b_ub=bb,bounds=[(.3,1.7)]*(x.shape[1]-1)+[(-.1,.1)],
                method='highs-ipm',options={'time_limit':15.})
            if not result.success:raise RuntimeError('Profile failed: '+result.message)
            rr.append(float(result.x[col]))
        out.append(rr)
        print(json.dumps(dict(stage='cell-profile',column=col,range=rr)),flush=True)
    return out


def run(directory):
    print(json.dumps(dict(stage='load')),flush=True)
    raw=a.old.read(directory/'log.json');derived=ROOT/'archive/dme-response-flash-context'/directory.name
    proof=a.old.read(derived/'analysis.json');maps=a.old.read(derived/'maps.json');points=a.old.read(derived/'points.json');cal=proof['calibration']
    report=a.old.read(ROOT/'archive/nominal-response'/directory.name/'analysis.json');saved=a.old.read(ROOT/'archive/nominal-response'/directory.name/'predictions.json')
    if hashlib.sha256((directory/'log.json').read_bytes()).hexdigest()!=report['logFileSha256']:
        raise ValueError('Log differs from validated transport replay')
    if (hashlib.sha256((directory/'base.bin').read_bytes()).hexdigest()!=report['baseSha256']
            or maps['baseSha256']!=report['baseSha256'] or maps['logFileSha256']!=report['logFileSha256']
            or len(raw)!=len(points) or any(r['time']!=p['time'] or r['rpm']!=p['rpm'] for r,p in zip(raw,points))):
        raise ValueError('BASE, derived coordinates and log provenance disagree')
    for name,digest in report['scriptHashes'].items():
        if hashlib.sha256((ROOT/'scripts'/name).read_bytes()).hexdigest()!=digest:raise ValueError('Stale reference code: '+name)
    if hashlib.sha256((ROOT/'scripts/analyze-nominal-response.py').read_bytes()).hexdigest()!=report['airReference']['scriptSha256']:
        raise ValueError('Stale nominal-reference preparation')
    constant,recording=n.reference(directory)
    if any(r.get('injectionReadSource')!='block19-0401-unverified' for r in raw):raise ValueError('Measured injection history required')
    p=n.prepare_nominal(raw,points,maps,cal,constant)
    # Read-time perturbations can activate cells absent in the midpoint replay.
    # Preserve the complete table; never renormalize the remaining shares.
    used=np.arange(np.array(maps['baseline']).size)
    print(json.dumps(dict(stage='history-prepared',grid=len(p['grid']),cells=len(used))),flush=True)
    gains=gain_bounds((derived/'recorded-flash.bin').read_bytes(),.01)
    intervals,unexplained=controller_intervals(raw,cal,gains)
    oldfits=[r for r in saved['saved'] if r['input']=='fuel'];models={}
    for item in oldfits:
        if item['model'] not in models:
            models[item['model']]=observations(p,raw,intervals,next(m for m in h.HYPOTHESES if m.name==item['model']),used)
            print(json.dumps(dict(stage='constraints-prepared',model=item['model'],constraints=len(models[item['model']]))),flush=True)
    ids=sorted(set.intersection(*[set(e) for e in models.values()]))
    data={key:assemble(value,ids) for key,value in models.items()}
    times=next(iter(data.values()))[1];edges=np.linspace(p['observed'].min(),p['observed'].max(),5)
    folds=np.clip(np.searchsorted(edges,times,side='right')-1,0,3)
    penalties=[.004,.04,.4,4.];results=[];allfits=[];selection=[]
    zero=dict(factors=np.ones(len(used)),bankOffset=0.)
    for old in oldfits:
        outer=old['fold'];bands,_=data[old['model']];train,test=h.split_masks(folds,times,outer)
        scores=[]
        for penalty in penalties:
            print(json.dumps(dict(stage='inner-fit',fold=outer,penalty=penalty)),flush=True)
            squares=[];counts=[]
            for inner in range(4):
                if inner==outer:continue
                itr,ite=h.split_masks(folds,times,inner,eligible=train)
                fitted=fit(bands.subset(itr),penalty)
                score=evaluate(bands.subset(ite),fitted);squares.append(score['rmsViolation']**2);counts.append(score['constraints'])
            scores.append(float(np.sqrt(np.average(squares,weights=counts))))
        chosen=penalties[int(np.argmin(scores))]
        for penalty in penalties:
            fitted=fit(bands.subset(train),penalty)
            allfits.append(dict(fold=outer,model=old['model'],penalty=penalty,selected=penalty==chosen,
                factors=fitted['factors'].tolist(),bankOffset=fitted['bankOffset'],iterations=fitted['iterations'],projectedGradient=fitted['projectedGradient'],
                test=evaluate(bands.subset(test),fitted)))
        best=next(r for r in allfits if r['fold']==outer and r['selected'])
        selection.append(dict(fold=outer,penalties=penalties,innerRms=scores,chosen=chosen))
        comparison=dict(fold=outer,model=old['model'],chosen=chosen,heldout=best['test'],currentMap=evaluate(bands.subset(test),zero))
        results.append(comparison);print(json.dumps(comparison),flush=True)
    focus=[]
    for load in [7.5,10.]:
        for rpm in [2200,2400,2700]:
            cell=maps['load'].index(load)*len(maps['rpm'])+maps['rpm'].index(rpm);col=int(np.flatnonzero(used==cell)[0])
            focus.append(dict(load=load,rpm=rpm,column=col,
                selectedFoldFactors=[r['factors'][col] for r in allfits if r['selected']],
                testedSensitivityRange=[min(r['factors'][col] for r in allfits),max(r['factors'][col] for r in allfits)]))
    # A final conditional map is separate from held-out scores. Its tuning choices
    # are selected on CV results; its in-sample performance is never a test result.
    final_model=max(models,key=lambda key:sum(r['model']==key for r in results))
    mean_scores=np.mean([r['innerRms'] for r in selection],axis=0);final_penalty=penalties[int(np.argmin(mean_scores))]
    bands,_=data[final_model];final=fit(bands,final_penalty)
    print(json.dumps(dict(stage='full-fit',model=final_model,penalty=final_penalty,
        focus=[float(final['factors'][r['column']]) for r in focus])),flush=True)
    ranges=profile(bands,final,[r['column'] for r in focus])
    for c,pr in zip(focus,ranges):
        c['fullFitFactor']=float(final['factors'][c['column']]);c['noWorsePerConstraintRange']=pr
        c['unchangedCellAdmissible']=pr[0]<=1<=pr[1]
        c['entireSearchRangeAdmissible']=abs(pr[0]-.3)<1e-8 and abs(pr[1]-1.7)<1e-8
    # Change complete read positions and the cut boundary, preserving chronology.
    # Rebuild the fuel/air histories and interval envelopes, not merely the labels.
    sensitivity=[]
    for clock in [-.5,0.,.5]:
        pp=n.prepare_nominal(raw,points,maps,cal,constant,clock,.5+clock)
        for name in models:
            entries=observations(pp,raw,intervals,next(m for m in h.HYPOTHESES if m.name==name),used)
            keep=[i for i in ids if i in entries]
            bb,_=assemble(entries,keep)
            for penalty in sorted(set(r['chosen'] for r in selection)):
                fitted=fit(bb,penalty)
                sensitivity.append(dict(clockFraction=clock,model=name,penalty=penalty,constraints=len(keep),
                    focusFactors=[float(fitted['factors'][r['column']]) for r in focus]))
    for j,c in enumerate(focus):
        c['readTimingModelPenaltyRange']=[min(r['focusFactors'][j] for r in sensitivity),max(r['focusFactors'][j] for r in sensitivity)]
    totals={key:float(np.sqrt(np.average([r[key]['rmsViolation']**2 for r in results],weights=[r[key]['constraints'] for r in results]))) for key in ['currentMap','heldout']}
    out=ROOT/'archive/response-bounds'/directory.name;out.mkdir(parents=True,exist_ok=True)
    summary=dict(session=proof['session'],logSha256=report['logFileSha256'],recordingSha256=recording['sha256'],
        algorithm='moving-history-inequality-v1',constraints=len(ids),pointConstraints=sum(i.startswith('point:') for i in ids),
        durationConstraints=sum(i.startswith('duration:') for i in ids),controllerIntervals=len(intervals),unexplainedControllerIntervals=unexplained,
        gains=gains,cellIndices=used.tolist(),results=results,selection=selection,aggregateRms=totals,focus=focus,
        readTimingSensitivity=sensitivity,
        axes=dict(rpm=maps['rpm'],load=maps['load']),baseline=maps['baseline'],
        comparisonMap=(np.array(maps['baseline'])*final['factors'].reshape(np.array(maps['baseline']).shape)).tolist(),
        calibrationStatus='comparison-only',
        sourceHashes={name:hashlib.sha256((ROOT/'scripts'/name).read_bytes()).hexdigest()
            for name in ['ve_response_bounds.py','analyze-response-bounds.py','analyze-nominal-response.py','ve_response_history.py']},
        fullFit=dict(model=final_model,penalty=final_penalty,factors=final['factors'].tolist(),bankOffset=final['bankOffset']),
        limitations=['Conditional transported pre-k air-reference factors, not certified nominal VE.',
            'No sigmoidal AFR error model. Bound violation has no AFR-calibration claim.',
            'Finite minimum-change penalty is chosen by inner time-block validation; it is not rf_korr alpha.',
            'Previous nested transport choices are frozen; this is a follow-up within the same drive.',
            'No-worse-per-constraint ranges are feasible-set profiles, not confidence intervals.',
            '100 ms quadrature, nominal 10 ms controller task, unmeasured overlay age and hidden resets remain assumptions.',
            'No BIN, production tune, or physical post-flash outcome is generated.'])
    (out/'analysis.json').write_text(json.dumps(summary,indent=2),encoding='utf-8')
    (out/'fits.json').write_text(json.dumps(allfits,indent=2),encoding='utf-8')
    print(json.dumps(dict(output=str(out),constraints=len(ids),aggregateRms=totals,focus=focus)),flush=True)


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('session_directory',type=Path)
    run(parser.parse_args().session_directory.resolve())
