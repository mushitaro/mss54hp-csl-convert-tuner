/**
 * Engine rotational inertia, measured from a stationary-neutral pedal sweep.
 *
 * ## What is measured, and why this manoeuvre
 *
 * With the car stationary and the gearbox in neutral, the engine is the entire plant:
 *
 * ```
 *   M_ind(n) = J * alpha + M_loss(n)          alpha = dOmega/dt [rad/s^2]
 * ```
 *
 * Regress the DME's own indicated torque against angular acceleration **within a narrow rpm band**
 * and the slope is J while the intercept is the loss torque at that speed. Binning by rpm is what
 * makes `M_loss(n)` drop out without a friction model: inside one bin it is a constant, so it
 * becomes the intercept instead of an error term.
 *
 * Three properties of that make it worth doing this way rather than by free deceleration alone:
 *
 * - **No before-and-after measurement is needed.** J_old is already in the ROM (`K_SMG_J_MOTOR`,
 *   `K_MD_J_MOTOR`), so only J_new has to be measured and the ratio follows. A flywheel change that
 *   was never instrumented beforehand is still recoverable — and on this car it was not, so a
 *   before-and-after method has nothing to be a ratio against.
 * - **`M_loss` never has to be known.** Which matters because the DME's own drag channel cannot
 *   supply it: `MD_IND_SCHLEPP` is `(MD_MIN_F_LLRA * (MD_LLRA_KO + MD_LLRA)) >> 10` floored at
 *   zero — a function of the learned *idle* adaptation, not a friction curve over engine speed.
 *   Dividing a coast-down gradient by that would import its whole model error into J.
 * - **J must not depend on rpm.** So the agreement of the bins is an independent test of the whole
 *   procedure, paid for by nothing. See `jSpread`.
 *
 * ## Where the spread in alpha comes from
 *
 * A regression needs two well-separated torques at the same engine speed, and the manoeuvre that
 * produces them is simply blipping to ~5000 rpm and letting go, several times, at different pedal
 * openings. The up-sweep gives large positive alpha at large torque; the release gives large
 * negative alpha at **zero** torque, because under overrun cut there is no combustion.
 *
 * Those overrun samples are the most valuable ones in the run and an earlier version threw all of
 * them away on a `fuel-cut` gate. That gate came from a design where the torque channel was read
 * out of a block that could not be polled at all; with a live `md_ind_ne` the cut state stops being
 * something to reason about, because the channel reports the torque either way.
 *
 * ## What replaced the neutral/standstill/running gates
 *
 * Nothing observes them any more — `gang`, `v_antrieb` and `zustand_motor` live in the EGAS
 * freeze-frame, which is latched and not pollable. Three things stand in, and it is worth being
 * explicit that they are weaker:
 *
 * - **In gear, J comes out wrong by an order of magnitude, not subtly.** `KL_MD_JFZ_GANG` puts the
 *   car's inertia at the crank at 0.70 Nms² in first and 12.0 in sixth, against ~0.22 for the
 *   engine alone. `minPlausibleJ`/`maxPlausibleJ` catch that with room to spare.
 * - **`md_dyn_st` is still read per sample.** The tip-in and dashpot limiters are bypassed below
 *   `K_MD_DF_VMIN` (3 km/h), so at a standstill the gate should never fire — and "should be
 *   bypassed" and "was bypassed" are different claims, so it is checked rather than assumed. It
 *   firing at all is evidence the car was moving.
 * - **The operator is standing still with the handbrake on.** Which is a procedure, not a check,
 *   and is stated as such.
 *
 * ## The bias this cannot see, stated plainly
 *
 * `md_ind_ne` is a **model output**, not a measurement: the DME computes it from measured filling
 * and an ignition efficiency. Any multiplicative error `k` in that model scales the slope and the
 * intercept **identically**, so it lands on J at full strength — and the free-deceleration
 * cross-check cannot detect it either, because `k` cancels there too.
 *
 * The measurement regime is chosen to make `k` small rather than to measure it: warm, closed-loop,
 * stationary, so mixture is trimmed to lambda 1 by the closed loop and `rf_korr` sits on its
 * identity column. What remains is bounded only by the plausibility rail on `M_loss` — an S54 does
 * not motor at 100 Nm — and that is weak, roughly +/-30 %.
 *
 * So: the ratio `J_new / J_old` is a starting point for a correction, not a verdict. The final
 * value of every parameter it feeds is settled by an A/B on the car. Nothing downstream should
 * present this number as more certain than that.
 */

import type { InertiaSample } from '../dme-link/types';
import type {
    InertiaBin, InertiaEstimate, InertiaEstimatorOptions, InertiaRejectCounts, InertiaRejectReason,
    FreeDecelCheck,
} from './types';
import { DEFAULT_INERTIA_OPTIONS } from './types';
import { centralDifferenceRpmPerS, rpmPerSecToRadPerSec2, radPerSec2ToRpmPerSec } from './gradient';

/** `md_dyn_st` bits 4-6: the dashpot or the tip-in limiter actually clipped. */
const MD_DYN_ST_LIMITER_MASK = 0b0111_0000;

/**
 * Torque at or below this counts as "no combustion", Nm.
 *
 * `md_ind_ne` is unsigned, so overrun reads as 0 rather than negative — but it is a computed
 * quantity and need not land exactly on zero, so this is a small band rather than an equality.
 * Used only to find the free-deceleration run; the regression itself takes the value as it is.
 */
const NO_COMBUSTION_TORQUE_NM = 0.5;

/** Throttle below this counts as shut, %. `wdk1` idles at 0.0-0.3 on this car. */
const CLOSED_THROTTLE_PCT = 0.5;

export interface Accepted {
    rpm: number;
    /** rad/s^2, from a central difference of the 1 rpm speed channel. */
    alpha: number;
    /** Nm, `md_ind_ne`. */
    torque: number;
}

export type AdmitResult =
    | { ok: true; accepted: Accepted }
    | { ok: false; reason: InertiaRejectReason };

/**
 * Decides whether one sample may enter the regression, and why not when it may not.
 *
 * **Exported so the live display can call the same function the verdict calls.** This is not tidying:
 * a progress bar that counts samples by its own rules is a progress bar that can fill up while the
 * estimator is rejecting every one of them — which is precisely the failure that got a real drive
 * thrown away. Two implementations of "is this sample usable" will drift, and the drift is invisible
 * until someone has already driven.
 *
 * Takes the whole array and an index rather than a single sample, because the gradient cross-check
 * needs a window either side of `i`. That is also why a sample cannot be judged the instant it
 * arrives — the last `gradientHalfWindow` samples of a run are always pending.
 */
export function admitSample(
    samples: readonly InertiaSample[],
    i: number,
    opts: InertiaEstimatorOptions,
): AdmitResult {
    const s = samples[i];

    // Null is not zero, throughout. A channel the DME did not report has not reported a value.
    if (s.coolantTemp === null || s.coolantTemp < opts.minCoolantTempC) return { ok: false, reason: 'not-warm' };
    if (s.mdDynSt === null || (s.mdDynSt & MD_DYN_ST_LIMITER_MASK) !== 0) return { ok: false, reason: 'filter-active' };
    if (s.rpm === null || s.rpm < opts.minRpm || s.rpm > opts.maxRpm) return { ok: false, reason: 'out-of-range' };
    // `>= 0`, not `> 0`. Zero indicated torque under overrun cut is a real reading and the single
    // most informative sample class in the run — it is the only way the fit reaches large negative
    // alpha. Rejecting it (as `> 0` did) removed one end of every regression line.
    if (s.mdIndNe === null || !(s.mdIndNe >= 0)) return { ok: false, reason: 'no-torque' };

    const rpmPerS = centralDifferenceRpmPerS(samples, i, opts.gradientHalfWindow, opts.maxSampleGapS);
    if (rpmPerS === null) return { ok: false, reason: 'no-gradient' };

    // Torque averaged over the SAME window the gradient spans, not the centre sample's value.
    //
    // This is the pairing the physics asks for, not a smoothing choice. Integrating
    // `J dw/dt = M(t) - M_loss(w)` over [t1, t2] and dividing by the span gives
    // `J * alpha_mean = M_mean - M_loss_mean` — so a central difference, which IS the mean
    // acceleration over its window, belongs with the mean torque over that window. Pairing it with
    // the instantaneous torque is an approximation that is exact only where torque is constant, and
    // the run is deliberately full of places where it is not.
    //
    // Measured effect on the bench: recovering J to 6.5 % with the point value, under 2 % with this.
    const lo = i - opts.gradientHalfWindow, hi = i + opts.gradientHalfWindow;
    let sum = 0, minT = Infinity, maxT = -Infinity;
    for (let k = lo; k <= hi; k++) {
        const v = samples[k].mdIndNe;
        if (v === null) return { ok: false, reason: 'no-torque' };
        sum += v;
        if (v < minT) minT = v;
        if (v > maxT) maxT = v;
    }
    // A window straddling the throttle opening or shutting has no single torque and no single
    // acceleration — it averages two regimes, and the average is on neither curve. One or two such
    // samples per sweep is enough to drag a bin's slope, which is exactly what happened.
    if (maxT - minT > opts.maxTorqueSpanNm) return { ok: false, reason: 'torque-transient' };

    return {
        ok: true,
        accepted: {
            rpm: s.rpm,
            alpha: rpmPerSecToRadPerSec2(rpmPerS),
            torque: sum / (hi - lo + 1),
        },
    };
}

/**
 * Simple linear regression of y on x. Returns null when x has no spread, which is the degenerate
 * case a least-squares fit reports as a confident vertical line rather than as a refusal.
 */
function fitLine(points: readonly { x: number; y: number }[]): { slope: number; intercept: number; r2: number } | null {
    const n = points.length;
    if (n < 2) return null;
    let sx = 0, sy = 0;
    for (const p of points) { sx += p.x; sy += p.y; }
    const mx = sx / n, my = sy / n;
    let sxx = 0, sxy = 0, syy = 0;
    for (const p of points) {
        const dx = p.x - mx, dy = p.y - my;
        sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
    }
    if (sxx <= 0) return null;
    const slope = sxy / sxx;
    const intercept = my - slope * mx;
    // syy === 0 means every y is identical: the line is exact, and reporting r2 = 1 is right.
    const r2 = syy > 0 ? (sxy * sxy) / (sxx * syy) : 1;
    return { slope, intercept, r2 };
}

function median(values: number[]): number | null {
    if (values.length === 0) return null;
    const s = [...values].sort((a, b) => a - b);
    const mid = s.length >> 1;
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Finds the longest run of consecutive samples with the throttle shut and no combustion torque, and
 * measures its mean gradient — then compares against what the regression predicts.
 *
 * Keyed on `md_ind_ne == 0` rather than on an overrun-cut flag. That is not a workaround for the
 * flag being unavailable: zero indicated torque **is** the condition the prediction is about, where
 * the flag is one inference removed from it. The throttle is checked too, because a torque that
 * happens to pass through zero on its way somewhere is not a coast-down.
 *
 * Dependent on the fit for its prediction and independent of it in its measurement, which is the
 * useful direction: it can falsify the fit without being able to be dragged along by it. What it
 * cannot do is see a scale error in the torque model, because `k` cancels here too — a
 * disagreement means something *else* is wrong, and the note it emits says so.
 */
function checkFreeDecel(
    samples: readonly InertiaSample[],
    j: number | null,
    mLossAt: (rpm: number) => number | null,
    opts: InertiaEstimatorOptions,
): FreeDecelCheck {
    const empty: FreeDecelCheck = {
        found: false, measuredRpmPerS: null, predictedRpmPerS: null, relativeError: null, agrees: null,
    };
    if (j === null || j <= 0) return empty;

    let bestStart = -1, bestLen = 0;
    let runStart = -1;
    for (let i = 0; i <= samples.length; i++) {
        const s = i < samples.length ? samples[i] : null;
        const coasting = s !== null
            && s.mdIndNe !== null && s.mdIndNe <= NO_COMBUSTION_TORQUE_NM
            && s.wdk1 !== null && s.wdk1 <= CLOSED_THROTTLE_PCT
            && s.rpm !== null
            && s.rpm >= opts.minRpm && s.rpm <= opts.maxRpm + 1000;
        if (coasting) {
            if (runStart < 0) runStart = i;
        } else if (runStart >= 0) {
            const len = i - runStart;
            if (len > bestLen) { bestLen = len; bestStart = runStart; }
            runStart = -1;
        }
    }
    // Four samples spans ~0.6 s at the rate two telegrams reach — long enough that the endpoints are
    // hundreds of rpm apart at a free-deceleration rate, and short enough to actually occur.
    if (bestStart < 0 || bestLen < 4) return empty;

    const a = samples[bestStart];
    const b = samples[bestStart + bestLen - 1];
    if (a.rpm === null || b.rpm === null) return empty;
    const dt = b.time - a.time;
    if (!(dt > 0)) return empty;

    const measured = (b.rpm - a.rpm) / dt;
    // With no combustion torque, J * alpha = -M_loss(n) exactly. Evaluated at the midpoint speed,
    // which is where a mean gradient over the span belongs.
    const midRpm = (a.rpm + b.rpm) / 2;
    const loss = mLossAt(midRpm);
    if (loss === null) return { ...empty, found: true, measuredRpmPerS: measured };

    const predicted = radPerSec2ToRpmPerSec(-loss / j);
    if (!(Math.abs(predicted) > 0)) return { ...empty, found: true, measuredRpmPerS: measured };

    const relativeError = Math.abs(measured - predicted) / Math.abs(predicted);
    return {
        found: true,
        measuredRpmPerS: measured,
        predictedRpmPerS: predicted,
        relativeError,
        agrees: relativeError <= opts.freeDecelTolerance,
    };
}

/**
 * Estimates engine rotational inertia from a stationary-neutral inertia run.
 *
 * Takes `InertiaSample[]` and nothing else — a VE datalog is a different type and will not compile
 * here, and neither will a stale `EgasMeasurement[]` from the abandoned selection-83 design. Both
 * exclusions are deliberate: the runs carry disjoint channels and cannot answer each other's
 * question, and a freeze-frame array would type-check into silence.
 */
export function estimateInertia(
    samples: readonly InertiaSample[],
    options: Partial<InertiaEstimatorOptions> = {},
): InertiaEstimate {
    const opts: InertiaEstimatorOptions = { ...DEFAULT_INERTIA_OPTIONS, ...options };

    const rejectCounts = new Map<InertiaRejectReason, number>();
    const reject = (reason: InertiaRejectReason) => rejectCounts.set(reason, (rejectCounts.get(reason) ?? 0) + 1);

    const intervals: number[] = [];
    for (let i = 1; i < samples.length; i++) intervals.push(samples[i].time - samples[i - 1].time);
    const medianSampleIntervalS = median(intervals);

    // ---- Pass 0: admit samples -----------------------------------------------------------------
    const accepted: Accepted[] = [];
    for (let i = 0; i < samples.length; i++) {
        const verdict = admitSample(samples, i, opts);
        if (verdict.ok) accepted.push(verdict.accepted);
        else reject(verdict.reason);
    }

    // ---- Pass 1: one independent fit per rpm bin -----------------------------------------------
    const bins: InertiaBin[] = [];
    for (let lo = opts.minRpm; lo < opts.maxRpm; lo += opts.binWidthRpm) {
        const hi = lo + opts.binWidthRpm;
        const inBin = accepted.filter(a => a.rpm >= lo && a.rpm < hi);
        const alphas = inBin.map(a => a.alpha);
        const alphaSpan = alphas.length > 0 ? Math.max(...alphas) - Math.min(...alphas) : 0;
        const base = { rpm: lo + opts.binWidthRpm / 2, loRpm: lo, hiRpm: hi, count: inBin.length, alphaSpan };

        if (inBin.length < opts.minBinSamples) {
            bins.push({ ...base, j: null, mLoss: null, r2: null, rejected: 'thin-count' });
            continue;
        }
        if (alphaSpan < opts.minAlphaSpan) {
            bins.push({ ...base, j: null, mLoss: null, r2: null, rejected: 'thin-alpha-span' });
            continue;
        }
        const fit = fitLine(inBin.map(a => ({ x: a.alpha, y: a.torque })));
        if (fit === null || fit.r2 < opts.minR2) {
            bins.push({ ...base, j: null, mLoss: null, r2: fit?.r2 ?? null, rejected: 'poor-fit' });
            continue;
        }
        bins.push({ ...base, j: fit.slope, mLoss: fit.intercept, r2: fit.r2, rejected: null });
    }

    // ---- Pass 2: combine, and decide whether to believe it -------------------------------------
    const good = bins.filter(b => b.j !== null && b.mLoss !== null);
    const totalWeight = good.reduce((s, b) => s + b.count, 0);
    const j = totalWeight > 0 ? good.reduce((s, b) => s + b.j! * b.count, 0) / totalWeight : null;

    let jSpread: number | null = null;
    if (j !== null && good.length >= 2) {
        const variance = good.reduce((s, b) => s + b.count * (b.j! - j) ** 2, 0) / totalWeight;
        jSpread = Math.sqrt(variance);
    } else if (j !== null) {
        jSpread = 0;
    }

    const mLossCurve = good.map(b => ({ rpm: b.rpm, mLoss: b.mLoss! }));
    const mLossAt = (rpm: number): number | null => {
        if (mLossCurve.length === 0) return null;
        // Nearest bin centre. The curve has at most a handful of points over 3000 rpm, so
        // interpolating between them would imply a resolution the measurement does not have.
        let best = mLossCurve[0];
        for (const p of mLossCurve) if (Math.abs(p.rpm - rpm) < Math.abs(best.rpm - rpm)) best = p;
        return best.mLoss;
    };

    const freeDecel = checkFreeDecel(samples, j, mLossAt, opts);

    const notes: string[] = [];
    let acceptable = true;

    if (j === null) {
        acceptable = false;
        notes.push(`No rpm bin produced a usable fit (${accepted.length} samples survived the gates). `
            + `The reject tally above names the gate — the usual causes are a cold engine and sweeps `
            + `that never reached ${opts.minRpm} rpm.`);
    } else {
        if (good.length < opts.minAcceptedBins) {
            acceptable = false;
            notes.push(`Only ${good.length} of ${bins.length} rpm bins produced a fit `
                + `(${opts.minAcceptedBins} required). Cover more of the ${opts.minRpm}-${opts.maxRpm} rpm range.`);
        }
        if (jSpread !== null && jSpread / j > opts.maxJSpreadFraction) {
            acceptable = false;
            notes.push(`J varies ${(100 * jSpread / j).toFixed(0)} % across rpm bins `
                + `(limit ${(100 * opts.maxJSpreadFraction).toFixed(0)} %). Inertia does not depend on engine `
                + `speed, so this is not noise — something admitted samples it should not have, or the `
                + `torque channel is not behaving as a torque.`);
        }
        if (j < opts.minPlausibleJ || j > opts.maxPlausibleJ) {
            acceptable = false;
            // The specific failure worth naming: with `gang` no longer observable, a run taken in
            // gear is caught here rather than at the gate. KL_MD_JFZ_GANG puts the car's inertia at
            // the crank between 0.70 (1st) and 12.0 (6th) Nms², so an in-gear run lands far above
            // the rail rather than near it.
            const inGearish = j > opts.maxPlausibleJ * 2;
            notes.push(`J = ${j.toFixed(4)} Nms² is outside the plausible range `
                + `${opts.minPlausibleJ}-${opts.maxPlausibleJ}. `
                + (inGearish
                    ? 'A value this high is the driveline, not the engine — the gearbox was in gear for at '
                        + 'least part of this run. Repeat it in neutral, stationary.'
                    : 'Suspect the torque channel before the flywheel.'));
        }
        const lossNear4000 = mLossAt(4000);
        if (lossNear4000 !== null && (lossNear4000 < opts.minPlausibleMLoss || lossNear4000 > opts.maxPlausibleMLoss)) {
            acceptable = false;
            notes.push(`Loss torque came out at ${lossNear4000.toFixed(1)} Nm near 4000 rpm, outside the `
                + `${opts.minPlausibleMLoss}-${opts.maxPlausibleMLoss} Nm an S54 motors at. This is the only `
                + `check on a scale error in md_ind_ne, and a scale error there lands on J one-for-one.`);
        }
        if (freeDecel.found && freeDecel.agrees === false) {
            notes.push(`Free-deceleration cross-check disagrees by `
                + `${(100 * (freeDecel.relativeError ?? 0)).toFixed(0)} %: measured `
                + `${freeDecel.measuredRpmPerS?.toFixed(0)} rpm/s against ${freeDecel.predictedRpmPerS?.toFixed(0)} `
                + `predicted. Note this check shares the torque model's scale error and so cannot detect one — `
                + `a disagreement here means something else is wrong.`);
            acceptable = false;
        }
        if (!freeDecel.found) {
            notes.push('No free-deceleration run found, so the cross-check did not run. Let the revs fall '
                + 'all the way from 5000 to 2000 rpm with the throttle shut, without catching them.');
        }
        if (acceptable) {
            notes.push(`J = ${j.toFixed(4)} ± ${(jSpread ?? 0).toFixed(4)} Nms² across ${good.length} rpm bins.`);
        }
    }

    const rejects: InertiaRejectCounts[] = [...rejectCounts.entries()]
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count);

    return {
        j, jSpread, bins, mLossCurve, freeDecel,
        samplesSeen: samples.length,
        samplesUsed: accepted.length,
        rejects,
        medianSampleIntervalS,
        acceptable,
        notes,
    };
}
