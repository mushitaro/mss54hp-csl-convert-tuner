/**
 * Engine speed gradient for the inertia measurement.
 *
 * The estimate is a regression of torque against angular acceleration, so the gradient is half the
 * measurement and every bias in it lands directly on J.
 *
 * ## Why there is only one route now
 *
 * There used to be two, and they were both bad. The measurement ran on DS2 selection 83, whose
 * speed channels are `n40` (40 rpm per LSB) and `d_n40` (40 rpm/s per LSB, with a truncation bias
 * that had to be reasoned out of a disassembled expression, and rails at ±5080 rpm/s that a light
 * flywheel reaches on half throttle). Requiring the two to agree was a way of coping with the fact
 * that neither could be trusted alone.
 *
 * Selection 83 turned out to be a latched fault freeze-frame that never updates, so none of that
 * machinery was ever going to run on a car. The replacement reads engine speed from selection 3,
 * where `n` is a **1 rpm** unsigned 16-bit channel with no derived quantity anywhere in it. A
 * central difference of that is unbiased, unsaturated, and better than either of the channels it
 * replaces — so the cross-check, the truncation correction and the saturation gate all go, not
 * because they were wrong but because the thing they defended against is gone.
 *
 * What remains is the honest limit: a central difference is the *mean* gradient over its window,
 * assigned to the window's midpoint. That is exact for a constant gradient and second-order in the
 * curvature otherwise, which is why `gradientHalfWindow` is small.
 */

import type { InertiaSample } from '../dme-link/types';

/** rpm/s -> rad/s^2. */
export function rpmPerSecToRadPerSec2(rpmPerS: number): number {
    return (rpmPerS * 2 * Math.PI) / 60;
}

/** rad/s^2 -> rpm/s. */
export function radPerSec2ToRpmPerSec(radPerS2: number): number {
    return (radPerS2 * 60) / (2 * Math.PI);
}

/**
 * Central difference of `rpm` across a window, in rpm/s.
 *
 * Returns null when the window does not fit, straddles a gap in the samples, or spans no time.
 * A dropped sample makes the endpoints span more wall time than the window implies, and the
 * gradient in between is then an average over an interval the caller did not choose; rejecting is
 * cheaper than reasoning about it, and a run has far more samples than gaps.
 */
export function centralDifferenceRpmPerS(
    samples: readonly InertiaSample[],
    index: number,
    halfWindow: number,
    maxGapSeconds: number,
): number | null {
    const lo = index - halfWindow;
    const hi = index + halfWindow;
    if (lo < 0 || hi >= samples.length) return null;

    const a = samples[lo];
    const b = samples[hi];
    if (a.rpm === null || b.rpm === null) return null;

    const dt = b.time - a.time;
    if (!(dt > 0)) return null;

    for (let i = lo; i < hi; i++) {
        if (samples[i + 1].time - samples[i].time > maxGapSeconds) return null;
    }

    return (b.rpm - a.rpm) / dt;
}
