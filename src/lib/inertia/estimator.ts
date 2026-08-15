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
 * Two properties of that make it worth doing this way rather than by free deceleration alone:
 *
 * - **No before-and-after measurement is needed.** J_old is already in the ROM (`K_SMG_J_MOTOR`,
 *   `K_MD_J_MOTOR`), so only J_new has to be measured and the ratio follows. A flywheel change that
 *   was never instrumented beforehand is still recoverable.
 * - **J must not depend on rpm.** So the agreement of the bins is an independent test of the whole
 *   procedure, paid for by nothing. See `jSpread`.
 *
 * ## Why stationary specifically
 *
 * The tip-in and dashpot slew limiters are bypassed below `K_MD_DF_VMIN` (3 km/h) — the torque
 * request passes through untouched, so `md_ind_opt_korr` is on the engine's own curve rather than
 * on a filter's ramp. Standing still removes that variable rather than modelling it. `md_dyn_st` is
 * still checked per sample, because "should be bypassed" and "was bypassed" are different claims.
 *
 * ## The bias this cannot see, stated plainly
 *
 * `md_ind_opt_korr` is a **model output**, not a measurement: the DME computes it from measured
 * filling and an assumed efficiency. Any multiplicative error `k` in that model scales the slope
 * and the intercept **identically**, so it lands on J at full strength — and the free-deceleration
 * cross-check cannot detect it either, because `k` cancels there too.
 *
 * The measurement regime is chosen to make `k` small rather than to measure it: warm, closed-loop,
 * 15-35 % pedal, low exhaust temperature, so mixture is trimmed to lambda 1 by the closed loop and
 * `rf_korr` sits on its identity column. What remains is bounded only by the plausibility rail on
 * `M_loss` — an S54 does not motor at 90 Nm — and that is weak, roughly +/-30 %.
 *
 * So: the ratio `J_new / J_old` is a starting point for a correction, not a verdict. The final
 * value of every parameter it feeds is settled by an A/B on the car. Nothing downstream should
 * present this number as more certain than that.
 */

import type { EgasMeasurement } from '../dme-link/types';
import type {
    InertiaBin, InertiaEstimate, InertiaEstimatorOptions, InertiaRejectCounts, InertiaRejectReason,
    FreeDecelCheck,
} from './types';
import { DEFAULT_INERTIA_OPTIONS } from './types';
import {
    correctDN40, isDN40Saturated, centralDifferenceRpmPerS, rpmPerSecToRadPerSec2,
} from './gradient';

/** `zustand_motor` value meaning "running normally". Anything else is start, stall or fault. */
const ENGINE_STATE_RUNNING = 2;
/** Standstill threshold, km/h. Below `K_MD_DF_VMIN` (3) with margin for the 0.0625 km/h channel. */
const STATIONARY_KMH = 1.5;
/** `md_dyn_st` bits 4-6: the dashpot or the tip-in limiter actually clipped. */
const MD_DYN_ST_LIMITER_MASK = 0b0111_0000;
/** `sa_we_st` bit 0: overrun fuel cut active. */
const SA_WE_ST_CUT_MASK = 0b0000_0001;

interface Accepted {
    rpm: number;
    /** rad/s^2, from the corrected `d_n40`. */
    alpha: number;
    /** Nm. */
    torque: number;
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
 * Finds the longest run of consecutive samples in overrun fuel cut, neutral and decelerating, and
 * measures its mean gradient — then compares against what the regression predicts.
 *
 * Independent of the main fit in its inputs (it uses no torque channel at all) and dependent on it
 * for the prediction, which is the useful direction: it can falsify the fit without being able to
 * be dragged along by it.
 */
function checkFreeDecel(
    samples: readonly EgasMeasurement[],
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
        const inCut = s !== null
            && s.gang === 0
            && s.saWeSt !== null && (s.saWeSt & SA_WE_ST_CUT_MASK) !== 0
            && s.n40 !== null
            && s.n40 >= opts.minRpm && s.n40 <= opts.maxRpm + 1000;
        if (inCut) {
            if (runStart < 0) runStart = i;
        } else if (runStart >= 0) {
            const len = i - runStart;
            if (len > bestLen) { bestLen = len; bestStart = runStart; }
            runStart = -1;
        }
    }
    // Four samples is the shortest span whose endpoints are far enough apart for n40's 40 rpm
    // quantisation to be small against the difference.
    if (bestStart < 0 || bestLen < 4) return empty;

    const a = samples[bestStart];
    const b = samples[bestStart + bestLen - 1];
    if (a.n40 === null || b.n40 === null) return empty;
    const dt = b.time - a.time;
    if (!(dt > 0)) return empty;

    const measured = (b.n40 - a.n40) / dt;
    // Under fuel cut there is no combustion torque, so J * alpha = -M_loss(n) exactly. Evaluated at
    // the midpoint speed, which is where a mean gradient over the span belongs.
    const midRpm = (a.n40 + b.n40) / 2;
    const loss = mLossAt(midRpm);
    if (loss === null) return { ...empty, found: true, measuredRpmPerS: measured };

    const predictedRadPerS2 = -loss / j;
    const predicted = (predictedRadPerS2 * 60) / (2 * Math.PI);
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
 * Estimates engine rotational inertia from an EGAS (selection 83) run.
 *
 * Takes `EgasMeasurement[]` and nothing else — a VE datalog is a different type and will not
 * compile here, which is deliberate. The two runs carry disjoint channels and cannot answer each
 * other's question; see the note on `EgasMeasurement`.
 */
export function estimateInertia(
    samples: readonly EgasMeasurement[],
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
        const s = samples[i];

        // Null is not zero. A DME that did not report a gear has not reported neutral.
        if (s.gang === null || s.gang !== 0) { reject('not-neutral'); continue; }
        if (s.vAntrieb === null || s.vAntrieb > STATIONARY_KMH) { reject('moving'); continue; }
        if (s.engineState === null || s.engineState !== ENGINE_STATE_RUNNING) { reject('not-warm'); continue; }
        if (s.mdDynSt === null || (s.mdDynSt & MD_DYN_ST_LIMITER_MASK) !== 0) { reject('filter-active'); continue; }
        if (s.saWeSt === null || (s.saWeSt & SA_WE_ST_CUT_MASK) !== 0) { reject('fuel-cut'); continue; }

        if (s.n40 === null || s.n40 < opts.minRpm || s.n40 > opts.maxRpm) { reject('out-of-range'); continue; }
        if (s.mdIndOptKorr === null || !(s.mdIndOptKorr > 0)) { reject('no-torque'); continue; }

        if (s.dN40 === null) { reject('no-gradient'); continue; }
        if (isDN40Saturated(s.dN40)) { reject('saturated-gradient'); continue; }

        const fromDN40 = correctDN40(s.dN40);
        const fromN40 = centralDifferenceRpmPerS(samples, i, opts.gradientHalfWindow, opts.maxSampleGapS);
        if (fromN40 === null) { reject('no-gradient'); continue; }
        if (Math.abs(fromDN40 - fromN40) > opts.gradientAgreementRpmPerS) { reject('gradient-disagree'); continue; }

        // The DME's own channel is the one kept: it is a per-sample value, where the central
        // difference is an average over the window and therefore lags a changing gradient. The
        // window's job was to catch the case where `d_n40` is wrong, not to replace it.
        accepted.push({ rpm: s.n40, alpha: rpmPerSecToRadPerSec2(fromDN40), torque: s.mdIndOptKorr });
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
            + `Re-run the sweeps: the usual causes are not being in neutral, rolling, or a pedal so `
            + `large that d_n40 saturated.`);
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
            notes.push(`J = ${j.toFixed(4)} Nms² is outside the plausible range `
                + `${opts.minPlausibleJ}-${opts.maxPlausibleJ}. Suspect the torque channel before the flywheel.`);
        }
        const lossNear4000 = mLossAt(4000);
        if (lossNear4000 !== null && (lossNear4000 < opts.minPlausibleMLoss || lossNear4000 > opts.maxPlausibleMLoss)) {
            acceptable = false;
            notes.push(`Loss torque came out at ${lossNear4000.toFixed(1)} Nm near 4000 rpm, outside the `
                + `${opts.minPlausibleMLoss}-${opts.maxPlausibleMLoss} Nm an S54 motors at. This is the only `
                + `check on a scale error in md_ind_opt_korr, and a scale error there lands on J one-for-one.`);
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
            notes.push('No free-deceleration run found, so the cross-check did not run. Add a coast-down '
                + 'in neutral from 5000 rpm with the throttle shut.');
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
