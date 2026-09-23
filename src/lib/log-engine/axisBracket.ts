/**
 * Where a value sits on a calibration axis — one answer, used everywhere it is asked.
 *
 * ## Why this exists
 *
 * There were five of these: the rf_korr tuner's `bracket`, the VE calculator's
 * `findBoundingIndices`, `interpCurve` in lambdaGates, the EGT tables' own, and the load
 * corrector's. They agree on every ordinary input and disagree on the two that matter.
 *
 * **NaN.** `findBoundingIndices` tested `value <= axis[0]`, which NaN fails, then walked the axis
 * failing every comparison, and returned `null` — a case the caller had to remember. `interpCurve`
 * tested `at <= x[0]`, NaN fell through the loop, and it returned the LAST breakpoint: a NaN rpm
 * read as redline. The tuner's `bracket` tested `!(q > axis[0])`, which NaN passes, so the same
 * value read as idle. One value, three answers, two of them silently plausible.
 *
 * Here it is stated once, and stated as a refusal: a value that is not a number does not sit
 * anywhere on the axis, and the only honest bracket for it is none. Callers get `null` and drop the
 * sample, which is what a sample with no rpm deserves.
 *
 * **Outside the axis.** Flat, both ends — the nearest breakpoint holds, with all of its weight.
 * That is what the DME's own `kfu_wint` does, and it is the only defensible choice besides:
 * extrapolating a calibration invents data.
 */

/** Two breakpoints and the weight on the upper one. `i0 === i1` means the value landed on a
 *  breakpoint or outside the axis, so `w1` is 0 and the pair is really one cell. */
export interface AxisBracket {
    i0: number;
    i1: number;
    /** Weight of `i1`. The weight of `i0` is `1 - w1`. */
    w1: number;
}

/**
 * Returns null for a non-finite value or an empty axis, and never for anything else.
 *
 * An axis is assumed ascending — every calibration axis in this app is, and `egtTables.isPlausible`
 * is where that is checked when the axis comes out of a binary. A descending or unsorted axis makes
 * the scan below return the first bracket that happens to contain the value, which is a garbage-in
 * answer rather than a crash.
 */
export function axisBracket(axis: readonly number[], value: number): AxisBracket | null {
    if (!Number.isFinite(value) || axis.length === 0) return null;
    const last = axis.length - 1;
    if (value <= axis[0]) return { i0: 0, i1: 0, w1: 0 };
    if (value >= axis[last]) return { i0: last, i1: last, w1: 0 };
    for (let i = 0; i < last; i++) {
        if (value >= axis[i] && value <= axis[i + 1]) {
            const span = axis[i + 1] - axis[i];
            // A repeated breakpoint is a degenerate cell, not a division by zero.
            if (span === 0) return { i0: i, i1: i, w1: 0 };
            return { i0: i, i1: i + 1, w1: (value - axis[i]) / span };
        }
    }
    // Unreachable for an ascending axis — the boundary tests above cover everything outside it and
    // the scan covers everything inside. Answered rather than thrown, because an axis read out of a
    // binary is data and this is a hot path.
    return { i0: last, i1: last, w1: 0 };
}

/** Linear interpolation along `y` at `x = at`, flat outside the axis. NaN in, NaN out — a caller
 *  that cannot say where it is asking cannot be given a number. */
export function interpAxis(x: readonly number[], y: readonly number[], at: number): number {
    const b = axisBracket(x, at);
    if (!b) return NaN;
    return y[b.i0] + (y[b.i1] - y[b.i0]) * b.w1;
}
