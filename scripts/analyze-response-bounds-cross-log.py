"""Evaluate a saved bound candidate on separate logs with reconstructed fuel.

Usage: python scripts/analyze-response-bounds-cross-log.py <analysis.json> <session-dir> [<session-dir> ...]
Reconstructed fuel and optional error widths are sensitivity checks, not measured TI.
"""
from pathlib import Path
import importlib.util,json,sys
sys.dont_write_bytecode=True
if len(sys.argv)<3:raise SystemExit(__doc__)
import numpy as np
from threadpoolctl import threadpool_limits
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'scripts'))
from ve_response_bounds import Bands,sample_envelope,evaluate
from scipy.sparse import csr_matrix
spec=importlib.util.spec_from_file_location('nominal',ROOT/'scripts/analyze-nominal-response.py');n=importlib.util.module_from_spec(spec);spec.loader.exec_module(n);a=n.a;h=a.h
threadpool_limits(1)
read=lambda p:json.loads(p.read_text(encoding='utf-8'))
target=read(Path(sys.argv[1]))
for name,digest in target['sourceHashes'].items():
    import hashlib
    if hashlib.sha256((ROOT/'scripts'/name).read_bytes()).hexdigest()!=digest:raise ValueError('Stale candidate source: '+name)
fitted=dict(factors=np.array(target['fullFit']['factors']),bankOffset=target['fullFit']['bankOffset'])
local=dict(factors=np.ones(len(fitted['factors'])),bankOffset=0.)
weakestFold=dict(factors=np.ones(len(fitted['factors'])),bankOffset=0.)
for c in target['focus']:
    if not c['unchangedCellAdmissible']:
        local['factors'][c['column']]=c['fullFitFactor']
        weakestFold['factors'][c['column']]=max(c['selectedFoldFactors'])
results=[]
for argument in sys.argv[2:]:
    directory=Path(argument).resolve();sid=directory.name
    raw=read(directory/'log.json');derived=ROOT/'archive/dme-response-flash-context'/sid
    proof=read(derived/'analysis.json');maps=read(derived/'maps.json');points=read(derived/'points.json');cal=proof['calibration']
    if (hashlib.sha256((directory/'log.json').read_bytes()).hexdigest()!=maps['logFileSha256']
            or len(raw)!=len(points) or any(r['time']!=p['time'] or r['rpm']!=p['rpm'] for r,p in zip(raw,points))):
        raise ValueError('Cross-log coordinates differ from source log')
    constant,recording=n.reference(directory)
    assert recording['sha256']==target['recordingSha256'] and maps['baseline']==target['baseline']
    col=lambda key:np.array([r[key] for r in raw],float)
    times={kind:col(kind+('Time' if kind.startswith('rf') else 'ReadTime')) for kind in ['standard','lambda','rfSollDirect','rfKorrDirect']}
    grid=np.arange(max(t[0] for t in times.values()),min(t[-1] for t in times.values()),.1);dt=.1
    rpm=h.interpolate(grid,times['standard'],col('rpm'));load=h.interpolate(grid,times['standard'],np.array([p['load'] for p in points]))
    rf=h.interpolate(grid,times['rfSollDirect'],col('rfSollDirect'));k=h.interpolate(grid,times['rfKorrDirect'],col('rfKorrDirect'))
    u=h.interpolate(grid,times['lambda'],np.c_[col('stft1'),col('stft2')]);ba=h.interpolate(grid,times['lambda'],col('baFTi'))
    active=(col('lambdaState1').astype(int)&1>0)&(col('lambdaState2').astype(int)&1>0)
    active_grid=h.discrete(grid,times['lambda'],active.astype(float))
    air=constant/1000*rf*rpm/120;fuel=air[:,None]*k[:,None]*u*ba[:,None]
    # No actual cut channel in #967: do not invent fuel during lambda-OFF history.
    fuel[active_grid!=1]=np.nan
    basis=a.old.basis(rpm,load,(np.array(maps['rpm']),np.array(maps['load'])),np.array(maps['baseline']))
    ac=air[:,None]*basis;score=active&(col('coolantTemp')>=65)&(col('tankVent')==0)&(col('ltft1')==1)&(col('ltft2')==1)&(col('baFTi')==1)
    for model in [m for m in h.HYPOTHESES if m.name in ['flow-0.25','flow-0.25-mix']]:
        ff,aa,_=h.history(grid,fuel,ac,rpm*rf*100,model);total=aa.sum(axis=1)
        valid=np.isfinite(ff).all(axis=1)&np.isfinite(aa).all(axis=1)&(total>0)&np.all(ff>0,axis=1)
        rows=[];lo=[];hi=[];banks=[];focus=[]
        for i,r in enumerate(raw):
            if not score[i]:continue
            start=r['lambdaReadTime']-r['lambdaReadMs']/2000;end=r['lambdaReadTime']+r['lambdaReadMs']/2000
            jj=np.flatnonzero((grid+dt/2>start)&(grid-dt/2<end))
            if not len(jj) or not valid[jj].all():continue
            x=aa[jj]/total[jj,None]
            for bank in [1,2]:
                mv=r[f'o2Precat{bank}Mv'];rich=mv>=cal['richMv'];lean=mv<=cal['leanMv']
                if not rich and not lean:continue
                for row,lower,upper in sample_envelope(x,ff[jj,bank-1]/total[jj],rich):
                    rows.append(row);lo.append(lower);hi.append(upper);banks.append(-.5 if bank==1 else .5)
                    focus.append(any(row[maps['load'].index(ro)*len(maps['rpm'])+maps['rpm'].index(rp)]>.01 for ro in [7.5,10] for rp in [2200,2400,2700]))
        focus=np.array(focus);lower=np.array(lo);upper=np.array(hi)
        for uncertainty in [0.,.03,.05,.1]:
            bands=Bands(csr_matrix(np.array(rows)),lower*(1-uncertainty),upper*(1+uncertainty),np.array(banks),np.ones(len(rows)))
            base=dict(factors=np.ones(len(fitted['factors'])),bankOffset=0.)
            result=dict(session=proof['session'],model=model.name,estimatedFuelUncertainty=uncertainty,
                current=evaluate(bands,base),candidate=evaluate(bands,fitted),
                local=evaluate(bands,local),weakestFold=evaluate(bands,weakestFold),
                focusCurrent=evaluate(bands.subset(focus),base),focusCandidate=evaluate(bands.subset(focus),fitted),
                focusLocal=evaluate(bands.subset(focus),local),focusWeakestFold=evaluate(bands.subset(focus),weakestFold))
            results.append(result);print(json.dumps(result),flush=True)
independent=[r for r in results if r['session']!=target['session']]
verdicts={name:('not-evaluated' if not independent else 'worsens-some-scenarios'
    if any(r[name]['rmsViolation']>r['current']['rmsViolation']+1e-10 for r in independent)
    else 'no-worse-in-tested-scenarios') for name in ['candidate','local','weakestFold']}
out=ROOT/'archive/response-bounds/cross-log-check.json';out.write_text(json.dumps(dict(results=results,verdicts=verdicts,
    version=2,candidateSession=target['session'],localFactors=local['factors'].tolist(),weakestFoldFactors=weakestFold['factors'].tolist(),
    limitations=['weakestFold is a leave-block diagnostic, NOT a conservative or identified calibration candidate.',
        'Reconstructed fuel is a conditional secondary check; missing TI/cut states are not observations.',
        'Fuel uncertainty widths are sensitivity scenarios, not measured confidence limits.',
        'A one-sided observation may admit both old and new maps; passing is not identifying magnitude.',
        'The candidate training session is in-sample; only other sessions are separate-drive checks.']),indent=2),encoding='utf-8')
print(json.dumps(dict(output=str(out),verdicts=verdicts)),flush=True)
