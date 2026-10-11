"""Read-only identifiability experiment, not a VE calibration generator.

Run analyze-dme-response.mjs first, then:
  python scripts/analyze-ve-transient.py <exported-session-directory>
Requires numpy/scipy. Private outputs go to archive/ve-transient/<session-id>/.
Models observed O2 rich/lean conditional on recorded fuel multipliers. It does not
convert narrowband voltage to AFR or simulate a post-flash closed loop.
"""
from pathlib import Path
import argparse
import hashlib
import json
import sys
import numpy as np
from scipy.optimize import minimize
from scipy.special import expit
from scipy.sparse import csr_matrix

ROOT = Path(__file__).resolve().parents[1]


def read(path):
    return json.loads(path.read_text(encoding='utf-8'))


def basis(rpm, load, axes, baseline):
    """Local derivative for multiplicative VE-cell changes, not plain hit weights."""
    xa, ya = axes
    n = len(rpm)
    out = np.zeros((n, baseline.size))
    xi = np.clip(np.searchsorted(xa, rpm, side='right')-1, 0, len(xa)-2)
    yi = np.clip(np.searchsorted(ya, load, side='right')-1, 0, len(ya)-2)
    fx = np.clip((rpm-xa[xi])/(xa[xi+1]-xa[xi]), 0, 1)
    fy = np.clip((load-ya[yi])/(ya[yi+1]-ya[yi]), 0, 1)
    for dx, dy, w in [(0, 0, (1-fx)*(1-fy)), (1, 0, fx*(1-fy)),
                      (0, 1, (1-fx)*fy), (1, 1, fx*fy)]:
        out[np.arange(n), (yi+dy)*len(xa)+xi+dx] += w*baseline[yi+dy, xi+dx]
    return out/out.sum(axis=1, keepdims=True)


def interp(x, times, values, epochs, wanted):
    j = np.clip(np.searchsorted(times, x, side='right')-1, 0, len(times)-2)
    width = times[j+1]-times[j]
    valid = ((x >= times[j]) & (x <= times[j+1]) & (width > 0) & (width <= 1.5)
             & (epochs[j] == wanted) & (epochs[j+1] == wanted) & (wanted >= 0))
    f = (x-times[j])/width
    if values.ndim == 2:
        f = f[:, None]
    return values[j]+f*(values[j+1]-values[j]), valid


def fit(x, z, y, regularization, width=.04):
    """Fixed-width ordinal observation approximation; width is not measured AFR noise."""
    x = csr_matrix(x)
    penalty = np.full(x.shape[1], regularization/.2**2)
    penalty[-1] = regularization/.03**2  # bank-difference nuisance

    def loss(beta):
        v = (z-x@beta)/width
        objective = np.logaddexp(0, v).sum()-y@v + .5*np.sum(penalty*beta**2)
        grad = -np.asarray(x.T@(expit(v)-y)).ravel()/width + penalty*beta
        return objective, grad

    res = minimize(loss, np.zeros(x.shape[1]), jac=True, method='L-BFGS-B',
                   options={'maxiter': 700, 'ftol': 1e-10, 'gtol': 1e-5})
    if not res.success:
        raise RuntimeError(f'Fit did not converge: {res.message}')
    return res.x


def metrics(y, p):
    y, p = np.asarray(y), np.clip(np.asarray(p), 1e-9, 1-1e-9)
    pred = p >= .5
    recalls = [float(np.mean(pred[y == b] == b)) for b in [0, 1] if np.any(y == b)]
    return {'bankObservations': len(y), 'rich': int(y.sum()),
            'accuracy': float(np.mean(pred == y)),
            'balancedAccuracy': float(np.mean(recalls)) if len(recalls) == 2 else None,
            'logLoss': float(np.mean(-y*np.log(p)-(1-y)*np.log1p(-p)))}


def run(input_dir):
    session = read(input_dir/'session.json')
    raw = read(input_dir/'log.json')
    raw = raw if isinstance(raw, list) else raw['data']
    base = (input_dir/'base.bin').read_bytes()
    assert hashlib.sha256(base).hexdigest() == session['baseSha256']
    assert len(raw) == session['logPointCount']
    derived_dir = ROOT/'archive/dme-response'/input_dir.name
    points, maps = read(derived_dir/'points.json'), read(derived_dir/'maps.json')
    derived = read(derived_dir/'analysis.json')
    calibration = derived['calibration']
    assert maps['baseSha256'] == session['baseSha256'] and len(points) == len(raw)
    assert maps['logFileSha256'] == hashlib.sha256((input_dir/'log.json').read_bytes()).hexdigest()
    assert all(p['time'] == r['time'] and p['rpm'] == r['rpm'] for p,r in zip(points,raw))
    out = ROOT/'archive/ve-transient'/input_dir.name
    out.mkdir(parents=True, exist_ok=True)
    n = len(raw)
    col = lambda key: np.array([p.get(key, np.nan) for p in raw], dtype=float)
    t, ts, tk = col('lambdaReadTime'), col('standardReadTime'), col('rfKorrDirectTime')
    assert all(np.all(np.diff(tt) > 0) for tt in [t, ts, tk])
    loads = np.array([p['load'] for p in points])
    rpm, k, ba = col('rpm'), col('rfKorrDirect'), col('baFTi')
    trim = np.array([[p['stft1'], p['stft2']] for p in raw])
    o2 = np.array([[p['o2Precat1Mv'], p['o2Precat2Mv']] for p in raw])
    counts = np.array([[p['lambdaPSteps1'], p['lambdaPSteps2']] for p in raw])
    active = np.array([bool(p['lambdaState1'] & 1 and p['lambdaState2'] & 1) for p in raw])
    valid = active & (col('coolantTemp') >= 65) & (col('tankVent') == 0) & (col('ltft1') == 1) & (col('ltft2') == 1)
    epochs = np.full(n, -1, dtype=int)
    epoch = -1
    for i in range(n):
        if not valid[i]:
            continue
        if i == 0 or not valid[i-1] or t[i]-t[i-1] > 1.5 or np.any(counts[i] < counts[i-1]):
            epoch += 1
        epochs[i] = epoch
    edges = np.linspace(t.min(), t.max(), 5)
    epoch_fold = {int(e): int(np.clip(np.searchsorted(edges, np.median(t[epochs == e]), side='right')-1, 0, 3))
                  for e in np.unique(epochs) if e >= 0}
    xa, ya = np.array(maps['rpm']), np.array(maps['load'])
    baseline = np.array(maps['baseline'])
    focus_cols = np.array([r*len(xa)+c for r, ro in enumerate(ya) for c, nr in enumerate(xa)
                           if 7.5 <= ro <= 10 and 2200 <= nr <= 2700])
    current_focus = (rpm >= 2200) & (rpm <= 2700) & (loads >= 7.5) & (loads <= 10)
    assert current_focus.sum() == derived['focus']['total']
    yraw = np.where(o2 >= calibration['richMv'], 1, np.where(o2 <= calibration['leanMv'], 0, np.nan))
    switches = []
    for b in range(2):
        for i in range(1, n):
            if epochs[i] >= 0 and epochs[i] == epochs[i-1] and np.isfinite(yraw[i, b]+yraw[i-1, b]) and yraw[i,b] != yraw[i-1,b]:
                switches.append({'bank':b+1, 'before':i-1, 'after':i, 'midTime':float((t[i]+t[i-1])/2),
                                 'intervalSec':float(t[i]-t[i-1]), 'currentFocus':bool(current_focus[i] or current_focus[i-1])})
    results, inventories, profiles, saved_predictions, common_predictions = [], [], [], [], []
    # Cumulative flow clock, rather than using current flow to represent the whole past path.
    # This remains a proxy: logged RF is DME modelled fill, not measured true air mass.
    flow = np.maximum(rpm*col('rf'), 1)
    flow_clock = np.r_[0, np.cumsum((flow[:-1]+flow[1:])/2*np.diff(ts))]
    for delay in [0, .25, .5, 1, 2, 'flow-0.25', 'flow-0.5', 'flow-1.0']:
        if isinstance(delay, str):
            volume = float(delay.split('-')[1])*2000*30
            before_sensor = np.interp(t-.15, ts, flow_clock, left=np.nan, right=np.nan)
            source_t = np.interp(before_sensor-volume, flow_clock, ts, left=np.nan, right=np.nan)
        else:
            source_t = t-delay
        position, ok_pos = interp(source_t, ts, np.column_stack([rpm, loads]), epochs, epochs)
        tr, ok_tr = interp(source_t, t, trim, epochs, epochs)
        kf, ok_k = interp(source_t, tk, k, epochs, epochs)
        bf, ok_ba = interp(source_t, t, ba, epochs, epochs)
        good = valid & ok_pos & ok_tr & ok_k & ok_ba & np.isfinite(source_t) & (t-source_t <= 4)
        x0 = basis(position[:,0], position[:,1], (xa, ya), baseline)
        z0 = np.log(np.maximum(tr*kf[:,None]*bf[:,None], 1e-6))
        source_focus = ((position[:,0] >= 2200) & (position[:,0] <= 2700)
                        & (position[:,1] >= 7.5) & (position[:,1] <= 10))
        inv = {'delaySec':delay, 'actualDelayP10P50P90':np.quantile((t-source_t)[good],[.1,.5,.9]).tolist(),
               'rows':int(good.sum()), 'focusSourceRows':int((good & source_focus).sum()),
               'focusSourceRich':int(np.sum(yraw[good & source_focus] == 1)),
               'focusSourceLean':int(np.sum(yraw[good & source_focus] == 0)),
               'currentFocusRows':int((good & current_focus).sum())}
        inventories.append(inv)
        for memory in [0, .5]:
            x, z = x0.copy(), z0.copy()
            use = good.copy()
            start = 0
            for i in range(n):
                if not good[i] or i == 0 or not good[i-1] or epochs[i] != epochs[i-1]:
                    start = i
                elif memory:
                    a = np.exp(-(t[i]-t[i-1])/memory)
                    x[i] = a*x[i-1]+(1-a)*x0[i]
                    z[i] = a*z[i-1]+(1-a)*z0[i]
                # Initialization uncertainty, not a fixed-rpm/load hold requirement.
                if memory and t[i]-t[start] < 3*memory:
                    use[i] = False
            row_indices = np.flatnonzero(use)
            # Always keep both banks of a row/epoch in the same held-out block.
            xx = np.repeat(x[row_indices], 2, axis=0)
            zz, yy = z[row_indices].ravel(), yraw[row_indices].ravel()
            obs_row = np.repeat(row_indices, 2)
            banks = np.tile([-.5,.5], len(row_indices))
            label_ok = np.isfinite(yy)
            xx, zz, yy, obs_row, banks = [v[label_ok] for v in [xx,zz,yy,obs_row,banks]]
            used_cols = np.flatnonzero(np.sum(xx, axis=0) > 1e-8)
            design = np.column_stack([xx[:,used_cols], banks])
            assert np.isfinite(design).all() and np.isfinite(zz).all()
            folds = np.array([epoch_fold[int(e)] for e in epochs[obs_row]])
            focus_obs = current_focus[obs_row]
            for penalty in [1., 10.]:
                pred = np.full(len(yy), np.nan)
                intercept_pred = pred.copy()
                prior_pred = pred.copy()
                betas, pooled_betas = [], []
                pooled_pred = pred.copy()
                pool_mask = np.isin(used_cols,focus_cols)
                pooled_design = np.column_stack([design[:,:-1][:,~pool_mask],design[:,:-1][:,pool_mask].sum(axis=1),banks])
                for fold in range(4):
                    test = folds == fold
                    if not test.any():
                        continue
                    # Entire epochs are disjoint; purge neighbours of the held-out time span.
                    lo, hi = t[obs_row[test]].min()-10, t[obs_row[test]].max()+10
                    train = (folds != fold) & ((t[obs_row] < lo) | (t[obs_row] > hi))
                    assert not set(epochs[obs_row[train]]) & set(epochs[obs_row[test]])
                    beta = fit(design[train], zz[train], yy[train], penalty)
                    pred[test] = expit((zz[test]-design[test]@beta)/.04)
                    reduced = np.column_stack([np.ones(len(yy)),banks])
                    intercept = fit(reduced[train],zz[train],yy[train],penalty)
                    intercept_pred[test] = expit((zz[test]-reduced[test]@intercept)/.04)
                    prior_pred[test] = yy[train].mean()
                    if memory == 0 and penalty == 1:
                        bp = fit(pooled_design[train],zz[train],yy[train],penalty)
                        pooled_pred[test] = expit((zz[test]-pooled_design[test]@bp)/.04)
                        pooled_betas.append(float(bp[-2]))
                    full = np.zeros(baseline.size);full[used_cols] = beta[:-1]
                    betas.append(full)
                assert np.isfinite(pred).all()
                beta = fit(design,zz,yy,penalty)
                full = np.zeros(baseline.size);full[used_cols] = beta[:-1]
                result = {'delaySec':delay, 'memorySec':memory, 'regularization':penalty,
                          'rows':len(np.unique(obs_row)), 'epochs':len(np.unique(epochs[obs_row])),
                          'observedCells':len(used_cols), 'heldOut':metrics(yy,pred),
                          'globalOffsetBaseline':metrics(yy,intercept_pred),
                          'richPrevalenceBaseline':metrics(yy,prior_pred),
                          'focusHeldOut':metrics(yy[focus_obs],pred[focus_obs]) if focus_obs.any() else None,
                          'sourceFocusHeldOut':metrics(yy[source_focus[obs_row]],pred[source_focus[obs_row]]) if source_focus[obs_row].any() else None,
                          'focusNominalLogParameters':full[focus_cols].tolist(),
                          'focusFoldNominalLogParameters':[b[focus_cols].tolist() for b in betas]}
                if pooled_betas:
                    bp=fit(pooled_design,zz,yy,penalty)
                    result['pooledFocus']={'heldOut':metrics(yy,pooled_pred),'logParameter':float(bp[-2]),'foldLogParameters':pooled_betas}
                results.append(result)
                common_predictions.append({'id':obs_row*2+(banks+.5).astype(int),'y':yy,'p':pred,'global':intercept_pred,'prevalence':prior_pred})
                print(json.dumps({k:result[k] for k in ['delaySec','memorySec','regularization','rows','heldOut']}),flush=True)
                # Likelihood-only profile with other parameters fixed: a diagnostic, not a CI.
                # Refitting nuisance parameters can only make identifiability weaker.
                if delay in [0, .5, 1] and memory == 0 and penalty == 1:
                    center = zz-design@beta
                    for col_index in focus_cols:
                        target = np.flatnonzero(used_cols == col_index)
                        if not len(target):
                            continue
                        j = target[0]
                        contributing = design[:,j] > .001
                        losses=[]
                        for shift in [-.30,-.20,-.10,0,.10,.20,.30]:
                            logits = (center-design[:,j]*shift)/.04
                            loss = float(np.sum(np.logaddexp(0,logits)-yy*logits))
                            losses.append([shift,loss])
                        profiles.append({'delaySec':delay,'cellIndex':int(col_index),
                                         'richContributors':int(np.sum(yy[contributing]==1)),
                                         'leanContributors':int(np.sum(yy[contributing]==0)),
                                         'lossByShift':losses})
                    saved_predictions.append({'delaySec':delay,'row':obs_row.tolist(),'bank':(banks+1.5).astype(int).tolist(),
                                              'observedRich':yy.astype(int).tolist(),'predictedRich':pred.tolist()})
    common_ids = sorted(set.intersection(*[set(p['id'].tolist()) for p in common_predictions]))
    for result,p in zip(results,common_predictions):
        by_id={int(v):i for i,v in enumerate(p['id'])}
        pick=np.array([by_id[i] for i in common_ids])
        result['commonHeldOut']=metrics(p['y'][pick],p['p'][pick])
        result['commonGlobalOffsetBaseline']=metrics(p['y'][pick],p['global'][pick])
        result['commonRichPrevalenceBaseline']=metrics(p['y'][pick],p['prevalence'][pick])
    output = {'version':2,'session':session['seq'],'baseSha256':session['baseSha256'],
              'logFileSha256':hashlib.sha256((input_dir/'log.json').read_bytes()).hexdigest(), 'calibration':calibration,
              'model':'P(rich)=sigmoid((filter(log(STFT*k_direct*BA))-filter(VE-weighted-cell-basis)*beta-bankOffset)/0.04)',
              'validation':'Four chronological epoch groups, entire lambda-reset epochs held out, 10-second purge. Measured STFT is an input; no free-running closed-loop validation.',
              'sensitivity':'Delay 0/0.25/0.5/1/2 seconds, cumulative modelled-air flow clock with .15 s sensor term and .25/.5/1 s at 2000 rpm * RF 30%, and memory 0/.5 seconds are hypotheses, not identified DME constants. Fixed local log-linear approximation.',
              'commonHeldOutBankObservations':len(common_ids),
              'rawRows':n,'focusRows':int(current_focus.sum()), 'focusRichBankObservations':int(np.sum(yraw[current_focus]==1)),
              'focusLeanBankObservations':int(np.sum(yraw[current_focus]==0)),
              'observedAdjacentSwitches':len(switches),'switchesWithCurrentFocusEndpoint':sum(s['currentFocus'] for s in switches),
              'focusCells':[{'index':int(c),'rpm':int(xa[c%len(xa)]),'load':float(ya[c//len(xa)])} for c in focus_cols],
              'inventories':inventories,'models':results,'likelihoodProfiles':profiles,
              'limits':['beta is an effective nominal balance parameter, not an authorized VE update.',
                        'MAP addition and unlogged fuel factors are not resolved; installed BIN/RAM correspondence remain unverified.',
                        'The two banks and sequential samples are not independent experiments.',
                        'No AFR magnitude, wall-film model, physical transport delay or counterfactual Tune is validated.',
                        'Interpolation at recorded midpoints has read-window uncertainty. No forward fill across reset/gap.',
                        'Model-selection performance is not claimed: all prespecified sensitivities are reported.']}
    (out/'analysis.json').write_text(json.dumps(output,ensure_ascii=False,indent=2),encoding='utf-8')
    (out/'switches.json').write_text(json.dumps(switches,ensure_ascii=False,indent=2),encoding='utf-8')
    (out/'held-out-predictions.json').write_text(json.dumps(saved_predictions),encoding='utf-8')
    print(str(out),flush=True)


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('session_directory', type=Path)
    args = parser.parse_args()
    run(args.session_directory.resolve())
