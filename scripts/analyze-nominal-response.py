"""Use measured TI and pre-rf_korr rf_soll as separate histories. Comparison only."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import numpy as np
sys.dont_write_bytecode=True
spec=importlib.util.spec_from_file_location('response_analysis',Path(__file__).with_name('analyze-response-history.py'))
a=importlib.util.module_from_spec(spec);spec.loader.exec_module(a)
ROOT=a.ROOT


def reference(directory):
    dd=ROOT/'archive/dme-response-flash-context'/directory.name
    report=json.loads((dd/'analysis.json').read_text(encoding='utf-8'))
    proof=report['recordedCalibration'];image=(dd/'recorded-flash.bin').read_bytes()
    if hashlib.sha256(image).hexdigest()!=proof['sha256'] or not proof['context']['known'] or proof['context']['airModelActive'] or proof['context']['learningActive']:
        raise ValueError('Requires a hash-verified, MAP-off, learning-frozen recording reference')
    nodes={n['name']:n for n in json.loads((ROOT/'public/data/calibration-graph.json').read_text(encoding='utf-8'))['nodes'] if n['t']=='param'}
    def constant(name):
        n=nodes[name];return int.from_bytes(image[n['addr']:n['addr']+n['bits']//8],'big')
    ti_const=((constant('K_HFM_TI_RATE')*(constant('K_RF_LUFTDICHTE')*constant('K_RF_HUBVOLUMEN')//1000)//1000)*60)//250
    return ti_const,proof


def prepare_nominal(raw,points,maps,calibration,ti_const,clock_fraction=0.,cut_boundary=.5):
    p=a.prepare(raw,points,maps,calibration,clock_fraction,cut_boundary)
    col=lambda k:np.array([r.get(k,np.nan) for r in raw],float)
    standard=col('standardReadTime')+clock_fraction*col('standardReadMs')/1000
    rt=col('rfSollDirectTime')+clock_fraction*col('rfSollDirectReadMs')/1000
    if any(r.get('rfDirectSource')!='ram-0401-unverified' for r in raw):
        raise ValueError('Missing rf_soll source')
    # rf_soll already includes PT1 / temperature / pressure, but excludes the
    # subsequent rf_korr multiplication. Never multiply k into TI a second time.
    nominal_rf=a.h.interpolate(p['grid'],rt,col('rfSollDirect'))
    rpm=a.h.interpolate(p['grid'],standard,col('rpm'))
    load=a.h.interpolate(p['grid'],standard,np.array([r['load'] for r in points]))
    nominal_air=ti_const/1000*nominal_rf*rpm/120
    basis=a.old.basis(rpm,load,(np.array(maps['rpm']),np.array(maps['load'])),np.array(maps['baseline']))
    p['air_cells']=basis*nominal_air[:,None]
    p['flow']=rpm*nominal_rf*100
    # p['fuel'] and p['estimated'] retain the measured / DME-corrected inputs.
    return p


def run(directory):
    ti_const,proof=reference(directory)
    prepare=lambda raw,points,maps,cal,clock=0.,cut=.5:prepare_nominal(raw,points,maps,cal,ti_const,clock,cut)
    a.run(directory,prepare_fn=prepare,output_folder='nominal-response',derived_folder='dme-response-flash-context',
        extra_provenance=dict(kind='pre-rf-korr-rf-soll',rfTiConst=ti_const,historicalCalibration=proof,
            scriptSha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            limits=['Historical calibration, not an ECU readback at this log start.',
                'Measured rf_soll is a DME model output, not independently measured air mass.',
                'Changing a VE cell can change RF-dependent gates; this is not a post-flash simulation.',
                'RF read-window uncertainty, sparse operating coordinates and fuel transport still limit cell identification.']))


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('session_directory',type=Path)
    run(p.parse_args().session_directory.resolve())
