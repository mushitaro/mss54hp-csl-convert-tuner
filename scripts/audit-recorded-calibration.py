"""Audit historical flash identity and RF arithmetic without modifying exports or ECU data."""
import argparse
import hashlib
import json
from pathlib import Path
import numpy as np

ROOT = Path(__file__).resolve().parents[1]


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def audit(directory, flash_directory):
    session = json.loads((directory/'session.json').read_text(encoding='utf-8'))
    log = json.loads((directory/'log.json').read_text(encoding='utf-8'))
    rows = log if isinstance(log, list) else log['data']
    flash_session = json.loads((flash_directory/'session.json').read_text(encoding='utf-8'))
    replay = json.loads((ROOT/'archive/dme-response-flash-context'/session['id']/'analysis.json').read_text(encoding='utf-8'))
    proof = replay['recordedCalibration']
    if proof['sourceSessionId'] != flash_session['id'] or replay['baseSha256'] != sha(directory/'base.bin'):
        raise ValueError('Replay provenance mismatch')
    # The JS replay reconstructed the patch-only image through the real patcher
    # and compared SHA-256. This independent audit reads the resulting artifact.
    image = ROOT/'archive/dme-response-flash-context'/session['id']/'recorded-flash.bin'
    if sha(image) != proof['sha256']:
        raise ValueError('Historical image identity mismatch')
    before, after = (directory/'base.bin').read_bytes(), image.read_bytes()
    changed = [i for i,(a,b) in enumerate(zip(before,after)) if a!=b]
    runs = []
    for i in changed:
        if runs and i == runs[-1][1]+1: runs[-1][1] = i
        else: runs.append([i,i])

    channels = {}
    for field,time,scale,limit in [('rf','standardReadTime',.01,.03),
            ('rfSollDirect','rfSollDirectTime',1,.03),('rfKorrDirect','rfKorrDirectTime',1,.003)]:
        points = np.array([(p[time],p[field]*scale) for p in rows if p.get(time) is not None and p.get(field) is not None])
        if np.any(np.diff(points[:,0])<=0): raise ValueError('Non-monotonic source clock')
        channels[field] = (points,limit)
    matched = []
    for i,p in enumerate(rows):
        t,mi = p.get('rfMapIntegratorDirectTime'),p.get('rfMapIntegratorDirect')
        if t is None or mi is None or abs(mi)<=.01: continue
        values={}
        for field,(series,limit) in channels.items():
            j=np.searchsorted(series[:,0],t)
            if j==0 or j>=len(series): break
            a,b=series[j-1],series[j]
            if b[0]-a[0]>1.5: break
            change=abs(b[1]-a[1]) if field=='rfKorrDirect' else abs(b[1]-a[1])/max((a[1]+b[1])/2,1e-9)
            if change>=limit: break
            values[field]=float(np.interp(t,series[:,0],series[:,1]))
        if len(values)!=3: continue
        residual=values['rf']-values['rfSollDirect']*values['rfKorrDirect']
        matched.append({'row':i,'time':t,'residual':residual,'storedMap':mi,
            'withoutMapError':abs(residual),'withMapError':abs(residual-mi)})
    metrics={'comparablePoints':len(matched),
        'noMapBetter':sum(p['withoutMapError']<p['withMapError'] for p in matched),
        'maeWithoutMap':float(np.mean([p['withoutMapError'] for p in matched])),
        'maeWithMap':float(np.mean([p['withMapError'] for p in matched])),
        'medianResidual':float(np.median([p['residual'] for p in matched])),
        'medianStoredMap':float(np.median([p['storedMap'] for p in matched]))}
    maps=json.loads((ROOT/'archive/dme-response-flash-context'/session['id']/'maps.json').read_text(encoding='utf-8'))
    out=ROOT/'archive/recording-audit'/session['id'];out.mkdir(parents=True,exist_ok=True)
    summary={'session':session['seq'],'baseSha256':sha(directory/'base.bin'),'logFileSha256':sha(directory/'log.json'),
        'historicalCalibration':proof,'baseConfig':before[0xe5e4],'flashConfig':after[0xe5e4],
        'changedBytes':len(changed),'changedAddressRuns':[[hex(a),hex(b)] for a,b in runs],
        'rfArithmetic':metrics,'legacyAcceptedCells':maps['legacy']['coverage']['withEvidence'],
        'responseAcceptedCells':maps['responseWithCalibrationHold']['coverage']['withEvidence'],
        'targetCells':replay['cells'],
        'limits':['A historical hash-verified flash is not an ECU checksum measurement at the start of this old log.',
            'No-MAP arithmetic is corroboration, not a unique identification of k_rf_cfg (the diagnostic branch can also bypass MAP).',
            'Interpolation and diagnostic 3%/0.003 limits do not impose an operating-point hold on the driver.',
            'Candidate cells remain comparison-only; this audit does not produce a tuned BIN.']}
    (out/'analysis.json').write_text(json.dumps(summary,indent=2,ensure_ascii=False)+'\n',encoding='utf-8')
    (out/'rf-matches.json').write_text(json.dumps(matched,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({'out':str(out),**metrics,'candidateCells':summary['responseAcceptedCells']},ensure_ascii=False))


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('session_directory',type=Path);p.add_argument('flash_directory',type=Path)
    args=p.parse_args();audit(args.session_directory,args.flash_directory)
