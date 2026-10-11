"""Read-only audit of recorded RF, rf_soll and the actual BASE's segment filter.

Uses the graph for addresses, not its sometimes inverted display formula for
filter coefficients. Private measurements and results stay under archive/.
This is an offline reconstruction; interpolated inputs are not ECU observations.
"""
import argparse
import hashlib
import json
from pathlib import Path
import sys

import numpy as np

sys.dont_write_bytecode = True
from ve_response_history import interpolate

ROOT = Path(__file__).resolve().parents[1]


def read(path):
    return json.loads(path.read_text(encoding='utf-8'))


def stats(values):
    values = np.asarray(values)
    values = values[np.isfinite(values)]
    return dict(n=len(values), quantiles=dict(zip(['p0','p10','p50','p90','p100'],
                map(float, np.quantile(values,[0,.1,.5,.9,1]))))) if len(values) else dict(n=0)


def table_weights(rpm, load, x, y):
    ix = np.clip(np.searchsorted(x,rpm,side='right')-1,0,len(x)-2)
    iy = np.clip(np.searchsorted(y,load,side='right')-1,0,len(y)-2)
    fx = np.clip((rpm-x[ix])/(x[ix+1]-x[ix]),0,1)
    fy = np.clip((load-y[iy])/(y[iy+1]-y[iy]),0,1)
    return ix,iy,fx,fy


def lookup(rpm,load,x,y,z):
    ix,iy,fx,fy = table_weights(rpm,load,x,y)
    return ((1-fx)*(1-fy)*z[iy,ix]+fx*(1-fy)*z[iy,ix+1]
            +(1-fx)*fy*z[iy+1,ix]+fx*fy*z[iy+1,ix+1])


def segment_filter(times, target, rpm, up, down):
    """First-order response in the combustion-segment clock (six cylinders).

    Raw gain g/16384 multiplies the new input. Piecewise-constant targets are
    integrated with fractional segment counts, rather than misreading 1-g as
    seconds. No claim to recover between-read input steps or integer rounding.
    """
    out = np.full(len(times),np.nan)
    for i in range(len(times)):
        if not np.isfinite(target[i]+rpm[i]+up[i]):
            continue
        if i==0 or not np.isfinite(out[i-1]):
            out[i]=target[i]
            continue
        gain=up[i] if target[i]>out[i-1] else down
        if not 0<gain<=1:
            raise ValueError('Invalid raw segment gain')
        retained=(1-gain)**((times[i]-times[i-1])*rpm[i]/20)
        out[i]=target[i]+(out[i-1]-target[i])*retained
    return out


def audit(directory):
    raw=read(directory/'log.json');raw=raw if isinstance(raw,list) else raw['data']
    session=read(directory/'session.json');base=(directory/'base.bin').read_bytes()
    digest=hashlib.sha256(base).hexdigest()
    maps=read(ROOT/'archive/dme-response'/directory.name/'maps.json')
    if digest!=session['baseSha256'] or digest!=maps['baseSha256']:
        raise ValueError('BASE provenance differs')
    log_hash=hashlib.sha256((directory/'log.json').read_bytes()).hexdigest()
    if log_hash!=maps['logFileSha256'] or len(raw)!=session['logPointCount']:
        raise ValueError('Log provenance differs')
    nodes={n['name']:n for n in read(ROOT/'public/data/calibration-graph.json')['nodes'] if n['t']=='param'}
    def axis(name,key):
        a=nodes[name]['axes'][key];w=a['bits']//8;n=a.get('rows',1)*a.get('cols',a.get('n',1))
        v=np.array([int.from_bytes(base[a['addr']+i*w:a['addr']+(i+1)*w],'big',signed=a.get('signed',False)) for i in range(n)])
        return v.reshape(a['rows'],a['cols']) if 'rows' in a else v
    def constant(name):
        n=nodes[name];return int.from_bytes(base[n['addr']:n['addr']+n['bits']//8],'big')
    col=lambda k:np.array([r.get(k,np.nan) for r in raw],float)
    ts=col('standardReadTime');tr=col('rfSollDirectTime');tk=col('rfKorrDirectTime')
    rpm=col('rpm');rf=col('rf')/100;rawload=col('rawLoad')
    factor=np.interp(rpm,axis('kl_aq_rel_rf_fakt','x'),axis('kl_aq_rel_rf_fakt','y')/32768)
    pt=np.interp(col('intakeTemp'),axis('KL_RF_TAN_KORR','x')-48,axis('KL_RF_TAN_KORR','y')/4096)
    pt*=np.interp(col('ambientPressure'),axis('KL_RF_P_UMG_KORR','x')*3+500,axis('KL_RF_P_UMG_KORR','y')/4096)
    x,y,z=map(np.asarray,[maps['rpm'],maps['load'],maps['baseline']])
    direct=col('rfSollDirect');k=col('rfKorrDirect')
    gain=lookup(rpm,rf*1000,axis('kf_rf_soll_tau_up','x'),axis('kf_rf_soll_tau_up','y'),axis('kf_rf_soll_tau_up','z'))/16384
    down=constant('k_rf_soll_tau_down')/16384
    ti_const=((constant('K_HFM_TI_RATE')*(constant('K_RF_LUFTDICHTE')*constant('K_RF_HUBVOLUMEN')//1000)//1000)*60)//250
    # Keep each integer truncation in rf_consts_calc's stated order.
    model_rf=interpolate(tr,ts,rf)
    k_r=interpolate(tr,tk,k)
    pred_rf=direct*k_r
    scenarios={}
    trace={}
    grid=np.arange(ts[0],ts[-1],.005)
    gp=interpolate(grid,ts,np.column_stack([rpm,rf,pt,gain]))
    for name,load in [('AQ_REL',rawload/factor),('already_rf',rawload),('already_rf_pt',rawload*pt)]:
        table=lookup(rpm,load,x,y,z)
        nominal=interpolate(tr,ts,table*pt)
        gl=interpolate(grid,ts,load)
        target=lookup(gp[:,0],gl,x,y,z)
        fine_nominal=interpolate(tr,grid,target*gp[:,2])
        filtered=segment_filter(grid,target,gp[:,0],gp[:,3],down)*gp[:,2]
        predicted=interpolate(tr,grid,filtered)
        scenarios[name]=dict(instantResidualPercent=stats(100*(direct/nominal-1)),
                             filteredResidualPercent=stats(100*(direct/predicted-1)),
                             filterEffectPercent=stats(100*(predicted/fine_nominal-1)),
                             inputInterpolationEffectPercent=stats(100*(fine_nominal/nominal-1)))
        trace[name]=dict(instant=nominal.tolist(),filtered=predicted.tolist())
    # Separate simultaneous block-3 TL/RF from independently-timed RAM comparisons.
    ti_rf=(np.floor(ti_const*np.round(rf*1000)/2000)/1000)
    measured_i=col('rfMapIntegratorDirect');it=col('rfMapIntegratorDirectTime');has_i=np.isfinite(measured_i+it)
    # Sparse MAP states are not carried forward as if simultaneous. Their bracket
    # spread and full +/-0.025 range are reported separately.
    residual=model_rf-pred_rf
    focus=(rpm>=2200)&(rpm<=2700)&(rawload/factor>=7.5)&(rawload/factor<=10)
    active=k>1.001
    output=dict(session=session['seq'],baseSha256=digest,logFileSha256=log_hash,
        rfCfg=constant('k_rf_cfg'),rfTiConst=ti_const,rows=len(raw),focusRows=int(focus.sum()),
        tlResidualMs=stats(col('baseInjectionMs')-ti_rf),
        segmentFilter=dict(upGain=stats(gain),downGain=down,
                           focusRegionRiseEfoldSeconds=stats(-20/rpm[(rpm>=2200)&(rpm<=2700)]/np.log1p(-gain[(rpm>=2200)&(rpm<=2700)])),
                           focusRegionRise95Seconds=stats(np.ceil(np.log(.05)/np.log1p(-gain[(rpm>=2200)&(rpm<=2700)]))*20/rpm[(rpm>=2200)&(rpm<=2700)]),
                           fallEfoldAt2400Seconds=float(-20/2400/np.log1p(-down))),
        dkbaSoftRaw=axis('KF_DKBA_SOFT_RF_N','z').tolist(),dkbaHardRaw=axis('KF_DKBA_HARD_RF_N','z').tolist(),
        airPathResidualRf=stats(residual),activeKAirPathResidualRf=stats(residual[active]),
        mapIntegrator=stats(measured_i[has_i]),scenarios=scenarios,
        sourceHashes={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in [Path(__file__), ROOT/'public/data/calibration-graph.json', ROOT/'public/data/calibration-decomp.json']},
        limitations=['BASE is a saved snapshot, not current ECU readback.',
                    'Interpolation cannot recover inputs or state changes between reads.',
                    'PT curves and load factor use held logger values; no atomic timestamp for every environmental channel.',
                    'Segment filter excludes unlogged warmup/ASK contributions; residuals do not prove a VE error.'])
    out=ROOT/'archive/dme-air-path'/directory.name;out.mkdir(parents=True,exist_ok=True)
    (out/'analysis.json').write_text(json.dumps(output,ensure_ascii=False,indent=2),encoding='utf-8')
    (out/'trace.json').write_text(json.dumps(dict(time=tr.tolist(),observed=direct.tolist(),scenarios=trace)),encoding='utf-8')
    print(json.dumps(output,ensure_ascii=False,indent=2))


if __name__=='__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('session_directory',type=Path)
    audit(p.parse_args().session_directory.resolve())
