/**
 * Engine speed gradient, recovered from DS2 selection 83.
 *
 * The inertia estimate is a regression of torque against angular acceleration, so the gradient is
 * half the measurement and every bias in it lands directly on J. This module owns both routes to
 * it and the reason there are two.
 */

import type { EgasMeasurement } from '../dme-link/types';

/** `d_n40` resolution: 40 rpm/s per LSB, signed 8-bit. */
export const DN40_LSB_RPM_S = 40;

/**
 * Largest magnitude `d_n40` can express before it pins.
 *
 * The raw field is a signed byte, so the true rails are +5080 / -5120. A reading AT either rail is
 * indistinguishable from anything beyond it, so both are treated as saturated and dropped — see
 * `isDN40Saturated`. This is a real limit in practice, not a theoretical one: an unloaded S54 with
 * a light flywheel passes 5000 rpm/s on well under half throttle, which is why the measurement
 * procedure asks for a partial-throttle sweep rather than a blip.
 */
export const DN40_SATURATION_RPM_S = 5080;

/** True when the reading is at or past a rail and therefore carries no magnitude information. */
export function isDN40Saturated(reportedRpmPerS: number): boolean {
    return reportedRpmPerS >= DN40_SATURATION_RPM_S || reportedRpmPerS <= -DN40_SATURATION_RPM_S;
}

/**
 * Removes the `d_n40` quantisation bias.
 *
 * The DME computes `D_N40 = (D_N_SEGMENT + 0x14) / 0x28` — add half an LSB, divide by 40 — with a
 * division that **truncates toward zero**. Truncation toward zero is floor above the origin and
 * ceil below it, so solving `trunc((x + 20) / 40) = k` gives three cases, not two:
 *
 * ```
 * k > 0    x in [40k - 20, 40k + 20)    width 40   midpoint 40k       = reported
 * k < 0    x in (40k - 60, 40k - 20]    width 40   midpoint 40k - 40  = reported - 40
 * k = 0    x in (-60, 20)               width 80   midpoint -20
 * ```
 *
 * Three consequences, and each of them is a mistake that is easy to make:
 *
 * 1. **The positive branch is already unbiased.** It is ordinary round-half-up. "Rounding error, so
 *    correct both sides" would *introduce* a bias here where there was none.
 * 2. **The negative branch sits a full LSB high.** The worked case from the disassembly notes is a
 *    true -139 rpm/s reported as -80; corrected, -120, which is the midpoint of the interval -80
 *    actually implies.
 * 3. **Zero is a double-width dead zone spanning -60 to +20 rpm/s.** Both signs collapse into
 *    `k = 0`, so a reported 0 is not "no acceleration" — it is 80 rpm/s of ignorance centred on
 *    -20. This one is invisible from the formula until you write out the k = 0 case, and it is why
 *    `dn40UncertaintyHalfWidth` reports double there.
 *
 * Residual after correction is +/-20 rpm/s away from the origin and +/-40 at it. That is the
 * irreducible per-sample noise of this channel, and it is why the estimator regresses over many
 * samples rather than trusting any one of them.
 */
export function correctDN40(reportedRpmPerS: number): number {
    if (reportedRpmPerS > 0) return reportedRpmPerS;
    if (reportedRpmPerS < 0) return reportedRpmPerS - DN40_LSB_RPM_S;
    // Reported zero — the widened bucket. Note `Object.is(-0, 0)` is false but `-0 < 0` is also
    // false, so an encoder that produces -0 lands here too, which is what we want.
    return -DN40_LSB_RPM_S / 2;
}

/**
 * Half-width of the interval a corrected reading implies, rpm/s.
 *
 * Half an LSB everywhere except at zero, where the two truncation branches merge and it doubles.
 * Exposed so a caller can weight or reject the dead-zone samples knowingly rather than treating
 * every reading as equally sharp.
 */
export function dn40UncertaintyHalfWidth(reportedRpmPerS: number): number {
    return reportedRpmPerS === 0 ? DN40_LSB_RPM_S : DN40_LSB_RPM_S / 2;
}

/** rpm/s -> rad/s^2. */
export function rpmPerSecToRadPerSec2(rpmPerS: number): number {
    return (rpmPerS * 2 * Math.PI) / 60;
}

/**
 * Central difference of `n40` across a window, in rpm/s — the second, independent gradient.
 *
 * `n40` is coarse (40 rpm) but **unbiased**, and differencing it over a window trades resolution
 * for that: across a 5-sample span at ~9 Hz the endpoints contribute one LSB of error each to a
 * span of several hundred rpm. `d_n40` is the opposite trade — fine-grained per sample, but a
 * derived channel whose bias had to be reasoned out of a disassembled expression above.
 *
 * Having both is the point. They fail for unrelated reasons, so requiring them to agree rejects
 * exactly the samples where one of them is lying, and neither has to be trusted on its own.
 *
 * Returns null when the window does not fit, straddles a gap in the samples, or spans no time.
 */
export function centralDifferenceRpmPerS(
    samples: readonly EgasMeasurement[],
    index: number,
    halfWindow: number,
    maxGapSeconds: number,
): number | null {
    const lo = index - halfWindow;
    const hi = index + halfWindow;
    if (lo < 0 || hi >= samples.length) return null;

    const a = samples[lo];
    const b = samples[hi];
    if (a.n40 === null || b.n40 === null) return null;

    const dt = b.time - a.time;
    if (!(dt > 0)) return null;

    // A dropped sample makes the endpoints span more wall time than the window implies, and the
    // gradient in between is then an average over an interval the caller did not choose. Rejecting
    // is cheaper than reasoning about it — the run has thousands of samples and few gaps.
    for (let i = lo; i < hi; i++) {
        if (samples[i + 1].time - samples[i].time > maxGapSeconds) return null;
    }

    return (b.n40 - a.n40) / dt;
}
