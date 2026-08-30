/**
 * Turning Nm of governor torque into kg/h of idle air, without ever needing to know the conversion
 * up front.
 *
 * There is no constant in the binary that relates them, and there cannot be a good static estimate
 * either: the true gain is not just thermodynamics, it also absorbs the Momentenmanager's own
 * torque-to-throttle-to-air realisation error, which is not unity and is not recoverable from the
 * calibration. So the design does not try. It starts from a deliberately LOW default, applies a
 * fraction of what that implies, and learns the real gain from what the next pass observes.
 *
 * That is what makes an inaccurate gain a slower campaign rather than an unstable one.
 */

import type { IdleTuneOptions } from './types';

/**
 * The physics bound the default sits under.
 *
 *     g(N) = w * AFR * 3600 / (LHV * eta_i)      [kg/h per Nm]
 *
 * At 780 rpm with eta_i = 0.25 that is 0.397, hence 0.40. The operating point itself implies more:
 * 14 kg/h of valve air against 25-30 Nm of indicated torque is 0.47-0.56. Sitting below both is
 * deliberate and asymmetric on purpose — a gain that is too small costs one extra pass, and a gain
 * that is too large over-corrects upward, which is the one direction this calibration has almost no
 * way to recover from (KL_LFR_TZ_NEG is all zeros and the P term only acts below target, so the
 * only path down is a 5.12 s integrator).
 */
export function defaultGainKgHPerNm(rpm: number, opts: Pick<IdleTuneOptions, 'gainKgHPerNm' | 'gainRefRpm'>): number {
    // g scales with w, so a dwell at a different idle speed gets the default rescaled rather than
    // the same number. Idle spans 600-900 rpm, so this is a +/-20 % effect — small, but stating it
    // is what stops a 3000 rpm sample from ever being pooled into an idle gain.
    return opts.gainKgHPerNm * (rpm / opts.gainRefRpm);
}

/** One pass's contribution: what was actually written, and what the error did in response. */
export interface GainPair {
    /** kg/h, interpolated at the dwell's own operating point from the two BINARIES — not the
     *  breakpoint change, and not the value that was requested. What the DME actually got. */
    deltaQKgH: number;
    /** Nm. `error(this pass) - error(previous pass)`. */
    deltaErrorNm: number;
    /** The rpm the dwell sat at, so the pooled gain can be normalised back to the reference. */
    rpm: number;
}

export type GainRejectReason = 'delta-too-small' | 'step-too-small' | 'implausible-gain' | 'sign-inverted';

export interface GainLearnResult {
    gain: number;
    /** At the reference rpm, so it can be stored and rescaled. */
    used: number;
    rejected: { pair: GainPair; why: GainRejectReason }[];
    /** True when at least one real pair contributed — i.e. the number is measured, not the prior. */
    learned: boolean;
}

export const GAIN_LEARN_DEFAULTS = {
    /**
     * Below this the pass did not move the error enough to divide by.
     *
     * 1.0 Nm, not the 2.0 this started at, and the reason is arithmetic rather than taste: one
     * quantum of the map is 0.5 kg/h, which at a plausible gain moves the error by about 0.96 Nm.
     * A threshold of 2.0 could therefore never be cleared by a single pass, so the learner would
     * reject every pair it was ever offered and silently return the prior forever. Pairs are
     * accumulated against the FIRST pass rather than the previous one, so the usable signal grows
     * with the campaign; 1.0 is the floor below which one step's worth of movement is not
     * distinguishable from dwell-to-dwell scatter, which a settled idle keeps well under 0.1 Nm.
     */
    minLearnableDeltaNm: 1.0,
    /** Below one LSB of the map, nothing was really written. */
    minStepKgH: 0.5,
    /** One pair's worth of weight on the prior, so a single noisy pass cannot swing the gain to a
     *  rail while two consistent passes can move it most of the way. */
    priorWeight: 1,
} as const;

/**
 * Weighted regression through the origin, blended with the default as a one-pair prior.
 *
 * Through the origin because zero air written must mean zero error moved: an intercept would let
 * the fit explain away a real offset as a constant, which is exactly the error being hunted.
 *
 * A sign-inverted pair — more air, and the governor asked for MORE torque — is not noise to be
 * averaged out. It means something other than the feedforward moved between passes, and it stops
 * the iteration rather than contributing to it.
 */
export function learnGain(
    pairs: readonly GainPair[],
    prior: number,
    opts: { gainMin: number; gainMax: number; gainRefRpm: number },
): GainLearnResult {
    const rejected: { pair: GainPair; why: GainRejectReason }[] = [];
    let num = 0;
    let den = 0;
    let used = 0;

    for (const p of pairs) {
        if (Math.abs(p.deltaErrorNm) < GAIN_LEARN_DEFAULTS.minLearnableDeltaNm) {
            rejected.push({ pair: p, why: 'delta-too-small' }); continue;
        }
        if (Math.abs(p.deltaQKgH) < GAIN_LEARN_DEFAULTS.minStepKgH) {
            rejected.push({ pair: p, why: 'step-too-small' }); continue;
        }
        // Adding air should REDUCE the error (the governor stops having to make up the shortfall),
        // so the ratio is negated. A positive ratio here is the inverted case.
        const g = -p.deltaQKgH / p.deltaErrorNm;
        if (g <= 0) { rejected.push({ pair: p, why: 'sign-inverted' }); continue; }
        // Normalise to the reference rpm before pooling: g scales with w.
        const gRef = g * (opts.gainRefRpm / Math.max(1, p.rpm));
        if (gRef < opts.gainMin || gRef > opts.gainMax) {
            rejected.push({ pair: p, why: 'implausible-gain' }); continue;
        }
        // Weighted by how far the error moved: a pass that barely moved it says less about the
        // slope than one that moved it a long way, and least-squares through the origin already
        // encodes that if the regression is done on the products rather than on the ratios.
        const e = p.deltaErrorNm * (Math.max(1, p.rpm) / opts.gainRefRpm);
        num += -p.deltaQKgH * e;
        den += e * e;
        used++;
    }

    if (used === 0) return { gain: prior, used: prior, rejected, learned: false };

    // The prior enters as one pair's worth of evidence at the mean leverage of the real pairs.
    const w = GAIN_LEARN_DEFAULTS.priorWeight;
    const meanLeverage = den / used;
    const blended = (num + w * prior * meanLeverage) / (den + w * meanLeverage);
    const clamped = Math.min(opts.gainMax, Math.max(opts.gainMin, blended));
    return { gain: clamped, used: clamped, rejected, learned: true };
}
