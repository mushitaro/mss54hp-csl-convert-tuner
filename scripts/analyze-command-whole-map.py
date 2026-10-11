"""Check all eligible observations, without target-support selection or residual slack."""
from pathlib import Path
import argparse,importlib.util,json,sys,hashlib
import numpy as np
sys.dont_write_bytecode=True
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('commands',ROOT/'scripts/analyze-command-bounds.py')
c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)


def run(directories,all_models):
    data=[c.m.load(d.resolve()) for d in directories]
    if any(d['recording']['sha256']!=data[0]['recording']['sha256'] or d['maps']['baseline']!=data[0]['maps']['baseline'] for d in data):
        raise ValueError('Different recording calibration')
    maps=data[0]['maps'];column=maps['load'].index(7.5)*len(maps['rpm'])+maps['rpm'].index(2400)
    prepared=[c.prepare(d) for d in data];results=[]
    models=c.m.b.h.HYPOTHESES if all_models else [m for m in c.m.b.h.HYPOTHESES if m.name=='flow-0.25-mix']
    for model in models:
        groups=[(d,c.entries(d,p,ints,model),kind) for d,(p,ints,kind) in zip(data,prepared)]
        for chosen in ([[0],[1],[0,1]] if len(data)==2 else [list(range(len(data)))]):
            result=c.m.profile([groups[i] for i in chosen],column,0.,-1.)
            result.update(model=model.name,sessions=[data[i]['proof']['session'] for i in chosen]);results.append(result)
            print(json.dumps({k:v for k,v in result.items() if k not in ['lowerWitness','upperWitness','upperCertificate']}),flush=True)
    out=ROOT/'archive/command-bounds';out.mkdir(exist_ok=True,parents=True)
    (out/('whole-map-all-models.json' if all_models else 'whole-map.json')).write_text(json.dumps(dict(results=results,
        calibrationStatus='comparison-only',recommendedFactor=None,
        sources=[dict(logSha256=d['maps']['logFileSha256'],recordingSha256=d['recording']['sha256']) for d in data],
        codeSha256={n:hashlib.sha256((ROOT/'scripts'/n).read_bytes()).hexdigest() for n in c.SOURCE_FILES+['analyze-command-whole-map.py']},
        limits=['Outer linear necessary conditions. Infeasibility rejects the supplied model assumptions; feasibility alone cannot certify a calibration.',
                'No target-support selection, no ridge, no fitted-residual allowances.',
                'Midpoint input timing, conditional non-lambda command interpolation and per-drive constant bank nuisance.']),indent=2),encoding='utf-8')


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('directories',nargs='+',type=Path);p.add_argument('--all-models',action='store_true')
    args=p.parse_args();run(args.directories,args.all_models)
