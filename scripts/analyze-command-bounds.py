"""Replay P-aware command uncertainty, keeping the comparison out of BIN writes.

Measured TI is divided by its same-response trim before interpolating its
non-lambda part. Sparse final TI itself is not treated as a straight line during
unobserved P jumps. The resulting fuel envelope is conditional on interpolation
of that non-lambda part (and on the input/transport assumptions of identification).
"""
from pathlib import Path
import argparse,importlib.util,json,sys,hashlib
import numpy as np
sys.dont_write_bytecode=True
from ve_command_envelope import reconstruct_trim
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('identification',ROOT/'scripts/analyze-response-identification.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
SOURCE_FILES=['analyze-command-bounds.py','ve_command_envelope.py','analyze-response-identification.py',
    've_controller_bounds.py','ve_response_bounds.py','analyze-response-bounds.py','analyze-nominal-response.py',
    'analyze-response-history.py','ve_response_history.py','analyze-ve-transient.py']


def prepare(data,clock=0.):
    p,intervals,kind=m.prepare(data,clock);raw=data['raw'];col=lambda key:np.array([r[key] for r in raw],float)
    image=ROOT/'archive/dme-response-flash-context'/data['directory'].name/'recorded-flash.bin'
    gains=m.b.gain_bounds(image.read_bytes(),.01)
    lower=[];upper=[]
    for bank in [1,2]:
        lo,hi=reconstruct_trim(p['grid'],raw,bank,gains)
        lower.append(lo);upper.append(hi)
    lower=np.array(lower).T;upper=np.array(upper).T
    if kind=='measured-command':
        it=col('injectionReadTime')+clock*col('injectionReadMs')/1000
        trim=np.c_[col('injectionStft1'),col('injectionStft2')]
        ti=np.c_[np.mean([col('injection'+str(c)+'Ms') for c in [1,2,3]],axis=0),
                 np.mean([col('injection'+str(c)+'Ms') for c in [4,5,6]],axis=0)]
        base=m.b.h.interpolate(p['grid'],it,ti/trim)
        rpm=m.b.h.interpolate(p['grid'],col('standardReadTime')+clock*col('standardReadMs')/1000,col('rpm'))
        cut=m.b.h.discrete(p['grid'],it,col('injectionBlankActual'),.5+clock)
        fraction=np.where(cut==0,1.,np.where(cut==6,0.,np.nan))
        base*=rpm[:,None]/120*fraction[:,None]
    else:
        lt=col('lambdaReadTime')+clock*col('lambdaReadMs')/1000
        u=m.b.h.interpolate(p['grid'],lt,np.c_[col('stft1'),col('stft2')])
        base=p['fuel']/u
    p['fuel_lower']=base*lower;p['fuel_upper']=base*upper
    # This branch is deliberately not a drop-in final command or a best guess.
    # There is no evidence supporting the envelope midpoint as the actual input.
    return p,intervals,kind


def entries(data,p,intervals,model):
    result={}
    for key in ['fuel_lower','fuel_upper']:
        rows=m.entries(data,{**p,'fuel':p[key]},intervals,model)
        for name,row in rows.items():
            if np.isfinite(row['lower'])==(key=='fuel_lower'):result[name]=row
    return result


def run(directories,all_models=False):
    data=[m.load(d.resolve()) for d in directories]
    if any(d['recording']['sha256']!=data[0]['recording']['sha256'] or d['maps']['baseline']!=data[0]['maps']['baseline'] for d in data):
        raise ValueError('Different recording calibration')
    maps=data[0]['maps'];column=maps['load'].index(7.5)*len(maps['rpm'])+maps['rpm'].index(2400)
    models=m.b.h.HYPOTHESES if all_models else [x for x in m.b.h.HYPOTHESES if x.name=='flow-0.25-mix']
    results=[]
    for clock in ([-.5,0.,.5] if all_models else [0.]):
        prepared=[prepare(d,clock) for d in data]
        for model in models:
            groups=[(d,entries(d,p,ints,model),kind) for d,(p,ints,kind) in zip(data,prepared)]
            for chosen in [list(range(len(data)))]+([[0],[1]] if len(data)==2 and clock==0 else []):
                result=m.profile([groups[j] for j in chosen],column,0.,.001)
                result.update(clock=clock,model=model.name,sessions=[data[j]['proof']['session'] for j in chosen])
                results.append(result)
                print(json.dumps({k:v for k,v in result.items() if k not in ['upperCertificate','lowerWitness','upperWitness']}),flush=True)
    out=ROOT/'archive/command-bounds';out.mkdir(exist_ok=True,parents=True)
    (out/('all-models.json' if all_models else 'analysis.json')).write_text(json.dumps(dict(results=results,
        recommendedFactor=None,calibrationStatus='comparison-only',
        sources=[dict(logSha256=d['maps']['logFileSha256'],recordingSha256=d['recording']['sha256']) for d in data],
        codeSha256={n:hashlib.sha256((ROOT/'scripts'/n).read_bytes()).hexdigest() for n in SOURCE_FILES},
        limits=['Conditional P-aware command bounds, not a measured fuel error bound.',
                'Non-lambda command part, air coordinates and transport still use interpolation/hypotheses.',
                'Counter decreases/saturation, unbracketed queries and impossible endpoints produce missing bounds.',
                'Hidden controller resets or asynchronous RAM overlay age remain unobserved.',
                'Only target-support constraints are included.']),indent=2),encoding='utf-8')


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('directories',nargs='+',type=Path);p.add_argument('--all-models',action='store_true')
    args=p.parse_args();run(args.directories,args.all_models)
