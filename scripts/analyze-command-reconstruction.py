"""Validate DME trim envelopes against separately sampled injection-block trim.

The injection trim is held out, never used to construct the tested envelope.
Outputs private row-level evidence; this does not generate a tuning map.
"""
import importlib.util,json,sys,hashlib,argparse
from pathlib import Path
import numpy as np
sys.dont_write_bytecode=True
from ve_command_envelope import reconstruct_trim
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('identification',ROOT/'scripts/analyze-response-identification.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)


def run(directory,focus_start=None,focus_end=None):
    d=m.load(directory);raw=d['raw'];col=lambda key:np.array([r[key] for r in raw])
    image=ROOT/'archive/dme-response-flash-context'/directory.name/'recorded-flash.bin'
    gains=m.b.gain_bounds(image.read_bytes(),.01);query=col('injectionReadTime')
    records=[]
    # Use each query's actual read window, not an estimated fixed acquisition age.
    for bank in [1,2]:
        lo=np.full(len(raw),np.nan);hi=lo.copy()
        # Different radii are supplied as a vector of independent reconstructions.
        # A uniform worst radius would unnecessarily widen short transactions.
        for radius in np.unique(col('injectionReadMs')/2000):
            ids=np.flatnonzero(col('injectionReadMs')/2000==radius)
            lo[ids],hi[ids]=reconstruct_trim(query[ids],raw,bank,gains,float(radius))
        linear=m.b.h.interpolate(query,col('lambdaReadTime'),col('stft'+str(bank)))
        actual=col('injectionStft'+str(bank));valid=np.isfinite(lo)&np.isfinite(actual)&np.isfinite(linear)
        for i in np.flatnonzero(valid):
            records.append(dict(index=int(i),bank=bank,time=float(query[i]),actual=float(actual[i]),linear=float(linear[i]),
                lower=float(lo[i]),upper=float(hi[i]),linearError=float(linear[i]-actual[i]),
                outside=float(max(lo[i]-actual[i],actual[i]-hi[i],0))))
    def stats(rows):
        return dict(n=len(rows),outside=sum(r['outside']>1e-8 for r in rows),
            maximumViolation=max((r['outside'] for r in rows),default=None),
            linearAbsErrorQuantiles=np.quantile([abs(r['linearError']) for r in rows],[.5,.95,.99,1]).tolist() if rows else [],
            envelopeWidthQuantiles=np.quantile([r['upper']-r['lower'] for r in rows],[.5,.95,.99,1]).tolist() if rows else [])
    focus=None if focus_start is None or focus_end is None else dict(startIndex=focus_start,endIndex=focus_end,
        **stats([r for r in records if focus_start<=r['index']<=focus_end]))
    summary=dict(all=stats(records),focusPass=focus,gains=gains,
        rows=records,logSha256=d['maps']['logFileSha256'],sourceSha256={name:hashlib.sha256((ROOT/'scripts'/name).read_bytes()).hexdigest()
        for name in ['ve_command_envelope.py','analyze-command-reconstruction.py']})
    out=ROOT/'archive/command-reconstruction'/directory.name;out.mkdir(exist_ok=True,parents=True)
    (out/'analysis.json').write_text(json.dumps(summary,indent=2),encoding='utf-8')
    print(json.dumps({k:v for k,v in summary.items() if k!='rows'}))


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('directory',type=Path)
    p.add_argument('--focus-start',type=int);p.add_argument('--focus-end',type=int)
    args=p.parse_args();run(args.directory.resolve(),args.focus_start,args.focus_end)
