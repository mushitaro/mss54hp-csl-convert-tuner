"""Independent event audit: commanded full fuel cuts and subsequent O2 changes.

Cut and threshold crossing times are intervals, not row timestamps. A measured
response after a large fuel cut is not a calibrated small-signal exhaust delay.
"""
import argparse
import hashlib
import json
from pathlib import Path
import sys
import numpy as np

ROOT=Path(__file__).resolve().parents[1]


def window(row,kind):
    t=row[kind+'ReadTime'];half=row[kind+'ReadMs']/2000
    return t-half,t+half


def audit(directory):
    read=lambda p:json.loads(p.read_text(encoding='utf-8'))
    raw=read(directory/'log.json');raw=raw if isinstance(raw,list) else raw['data']
    session=read(directory/'session.json')
    base_hash=hashlib.sha256((directory/'base.bin').read_bytes()).hexdigest()
    log_hash=hashlib.sha256((directory/'log.json').read_bytes()).hexdigest()
    maps=read(ROOT/'archive/dme-response'/directory.name/'maps.json')
    cal=read(ROOT/'archive/dme-response'/directory.name/'analysis.json')['calibration']
    if base_hash!=session['baseSha256'] or base_hash!=maps['baseSha256'] or log_hash!=maps['logFileSha256']:
        raise ValueError('Provenance differs')
    episodes=[]
    for i in range(1,len(raw)):
        if raw[i].get('injectionBlankActual')!=6 or raw[i-1].get('injectionBlankActual')!=0:continue
        cut_lo=window(raw[i-1],'injection')[0];cut_hi=window(raw[i],'injection')[1]
        end=i
        while end+1<len(raw) and raw[end+1].get('injectionBlankActual')==6:end+=1
        event=dict(first=i,last=end,cutStart=[cut_lo,cut_hi],rpm=raw[i]['rpm'],
                   load=raw[i]['rawLoad'],banks=[])
        if cut_hi-cut_lo>1.8: event['rejected']='wide-cut-bracket';episodes.append(event);continue
        for bank in [1,2]:
            key=f'o2Precat{bank}Mv'
            # Start with a confirmed rich observation at/before the last no-cut
            # injection read. No inference from already-lean exhaust.
            pre=[j for j in range(max(0,i-3),i+1) if window(raw[j],'lambda')[1]<=cut_lo]
            if not pre or raw[pre[-1]].get(key,-1)<cal['richMv']:
                event['banks'].append(dict(bank=bank,rejected='already-lean-or-no-rich-baseline'));continue
            start=pre[-1]
            lean=next((j for j in range(start+1,end+1) if raw[j].get(key,2000)<=cal['leanMv']),None)
            if lean is None:event['banks'].append(dict(bank=bank,rejected='right-censored-no-lean'));continue
            # Last rich bounds passage through the entire threshold band; a
            # sample between thresholds is neither invented rich nor lean.
            rich=max(j for j in range(start,lean) if raw[j][key]>=cal['richMv'])
            lo=window(raw[rich],'lambda')[0];hi=window(raw[lean],'lambda')[1]
            if hi<cut_lo:
                event['banks'].append(dict(bank=bank,rejected='lean-before-cut-bracket'));continue
            if any(raw[j+1]['lambdaReadTime']-raw[j]['lambdaReadTime']>1.5 for j in range(start,lean)):
                event['banks'].append(dict(bank=bank,rejected='observation-gap'));continue
            bound=[max(0.,lo-cut_hi),max(0.,hi-cut_lo)]
            event['banks'].append(dict(bank=bank,richIndex=rich,leanIndex=lean,
                crossing=[lo,hi],responseSeconds=bound,
                causalOrderResolved=lo>=cut_hi,
                caveat='Conditional on this cut causing the rich-to-lean transition; no hidden intermediate cut/resume.'))
        episodes.append(event)
    usable=[b for e in episodes for b in e['banks'] if 'responseSeconds' in b]
    output=dict(session=session['seq'],baseSha256=base_hash,logFileSha256=log_hash,
                episodes=episodes,summary=dict(fullCutOnsets=len(episodes),boundedBankResponses=len(usable),
                    orderResolved=sum(b['causalOrderResolved'] for b in usable),
                    upperBoundBelowOneSecond=sum(b['responseSeconds'][1]<1 for b in usable),
                    upperBoundBelowThreePointFiveSeconds=sum(b['responseSeconds'][1]<3.5 for b in usable),
                    upperBoundsQuantiles=np.quantile([b['responseSeconds'][1] for b in usable],[0,.5,.9,1]).tolist() if usable else []),
                scriptSha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                limitations=['Read brackets include host transport; ECU internal acquisition instants remain unknown.',
                    'Normal driving changes airflow during the cut; this is not an isolated identification experiment.',
                    'Full-cut response does not identify the delay of a small rich/lean correction or fuel-film parameters.',
                    'Event bank responses and repeated samples are not independent trials.',
                    'TI commands remaining nonzero during blanking are not continuing fuel delivery.'])
    out=ROOT/'archive/cut-response'/directory.name;out.mkdir(parents=True,exist_ok=True)
    (out/'analysis.json').write_text(json.dumps(output,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(output['summary'],indent=2))


if __name__=='__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('session_directory',type=Path)
    audit(p.parse_args().session_directory.resolve())
