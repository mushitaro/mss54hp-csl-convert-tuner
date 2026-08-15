/**
 * Was the lambda controller actually controlling when this sample was taken?
 *
 * The VE correction is built from `la_f_regler`, the controller's output factor. That number only
 * means "this is how far the mixture is off" while the loop is closed and unsaturated. Funktions-
 * rahmen 5.01 (module LA) lists more than ten conditions under which the DME switches the controller
 * off, and in every one of them the channel keeps reporting a number that looks exactly like a
 * converged one. Averaging those into a cell does not add noise — it moves the cell to the wrong
 * place, and more samples make it worse rather than better.
 *
 * Everything here is pure: thresholds in, one verdict out. The thresholds are read from the binary
 * the log was captured against, never hard-coded, because they are calibration — and because this
 * app patches one of them. See `readLambdaLimits`.
 *
 * ## What is checked, and what is deliberately not
 *
 * | FR 5.01 | Checked here | Why |
 * |---|---|---|
 * | x.2.3.2 full load | yes, `wdk1` vs `KF_BZ_WDK_VL(n, tmot)` | the channel exists as of W1 |
 * | x.2.3.2 load threshold | yes, `rf` vs `KL_LA_N(n)` | curve is in the binary |
 * | x.6.4 controller stops | yes, `la_f_regler` vs `K_LA_FMAX`/`FMIN` | saturation, not measurement |
 * | x.2.3.4 knock enrichment | no | `ti_f_klops` is on no block this app reads |
 * | x.2.3.8 torque intervention | no | same |
 * | x.2.3.6 secondary air | no | same, and irrelevant warm |
 * | x.2.3.9 sensor fault | no | would need the error memory mid-run |
 *
 * The unchecked ones are not silently assumed absent — they are the reason a rejected-sample census
 * is worth showing. A run whose numbers still look wrong after these three is a run to go looking at
 * the list above for.
 *
 * ## K_LA_N_VL is NOT used, on purpose
 *
 * FR 5.01 x.2.3.2 phrases the full-load condition as "speed greater than `K_LA_N_VL` and the
 * operating state is FULL LOAD". The XDF puts `K_LA_N_VL` at slave `0x4806` with the equation `x`,
 * and the value in a real binary is **120** — which as rpm is below cranking speed and would make
 * the term vacuous, while as n40 units (40 rpm/LSB, the resolution the DME uses everywhere else for
 * speed thresholds) it is 4800 rpm, which is exactly the kind of number this threshold would hold.
 *
 * Rather than pick, the speed half is dropped and full load alone rejects. That is the conservative
 * direction: it throws away a few samples the DME might still have been controlling through, and
 * never keeps one it was not. Reversing it would take a car — full load below and above 4800 rpm,
 * watching whether the trim goes rigid.
 */

/** A run of breakpoints and the values at them — the shape both DME tables here happen to have. */
export interface Curve {
    x: number[];
    y: number[];
}

export interface Grid {
    x: number[];
    y: number[];
    /** `z[yIndex][xIndex]`, matching how the binary stores it row-major over the Y axis. */
    z: number[][];
}

export interface LambdaLimits {
    /** `KF_BZ_WDK_VL` — throttle position above which the DME calls it full load, over (n, tmot). */
    wotThreshold: Grid;
    /** `KL_LA_N` — load above which the controller is switched off, over n. */
    loadThreshold: Curve;
    /** `K_LA_FMAX` / `K_LA_FMIN` — the controller's clamps. */
    fMax: number;
    fMin: number;
}

/** Linear interpolation with flat ends. Outside the axis the nearest breakpoint holds, which is what
 *  the DME does and also the only defensible thing: extrapolating a calibration invents data. */
export function interpCurve(curve: Curve, at: number): number {
    const { x, y } = curve;
    if (!x.length) return NaN;
    if (at <= x[0]) return y[0];
    if (at >= x[x.length - 1]) return y[y.length - 1];
    for (let i = 1; i < x.length; i++) {
        if (at <= x[i]) {
            const span = x[i] - x[i - 1];
            const f = span === 0 ? 0 : (at - x[i - 1]) / span;
            return y[i - 1] + (y[i] - y[i - 1]) * f;
        }
    }
    return y[y.length - 1];
}

/** Bilinear over the grid, flat outside it, same reasoning as above. */
export function interpGrid(grid: Grid, atX: number, atY: number): number {
    const row = (i: number) => interpCurve({ x: grid.x, y: grid.z[i] }, atX);
    return interpCurve({ x: grid.y, y: grid.y.map((_, i) => row(i)) }, atY);
}

/**
 * Why a sample did not reach the VE calculation.
 *
 * One reason per sample, and the ORDER of evaluation is what decides which one a sample gets when
 * several apply. That is a reporting choice, not an arithmetic one — the sample is rejected either
 * way — and it is made so the census answers "what should I change about the next run": a purge
 * window is fixable with a patch, a cold engine is fixable by waiting, full load is fixable by
 * driving differently. The cheapest thing to fix wins the label.
 */
export type DropReason =
    | 'coldEngine'
    | 'idle'
    | 'transient'
    | 'catProtect'
    | 'tankVent'
    | 'fullLoad'
    | 'controllerStop';

export type DropCensus = Record<DropReason, number>;

export const EMPTY_CENSUS: DropCensus = {
    coldEngine: 0, idle: 0, transient: 0, catProtect: 0, tankVent: 0, fullLoad: 0, controllerStop: 0,
};

/**
 * Full load: is the throttle at or past the threshold the DME uses for this (rpm, coolant)?
 *
 * `>=` rather than `>` because the threshold is where the DME's own comparison flips, and a sample
 * sitting exactly on it is precisely the ambiguous one.
 *
 * Returns false when the throttle channel is absent — a log without `wdk1` (any CSV, and any DS2 run
 * from before W1) simply cannot answer this, and answering "not full load" is the honest reading of
 * "we do not know" for a gate whose job is to reject. Silence must not become evidence.
 *
 * Note what happens when this app's own WOT patch is in the binary: every cell of the table reads
 * 102.3 %, no throttle can reach it, and the gate correctly stops rejecting anything. That is the
 * patch working — it exists to keep the controller alive at full load — and it means the gate reads
 * its own answer out of the calibration rather than out of a setting the user might have got wrong.
 */
export function isFullLoad(
    limits: LambdaLimits, wdk1: number | undefined, rpm: number, coolantTemp: number | undefined,
): boolean {
    if (wdk1 === undefined) return false;
    // Coolant is an axis on this table; without it, take the warm end, which is where a tuning run
    // is and which gives the highest threshold — i.e. rejects the least.
    const tmot = coolantTemp ?? limits.wotThreshold.y[limits.wotThreshold.y.length - 1];
    return wdk1 >= interpGrid(limits.wotThreshold, rpm, tmot);
}

/** Load threshold: `KL_LA_N` is a relative filling, and `rf` arrives as a percentage. */
export function isOverLoadThreshold(limits: LambdaLimits, rf: number | undefined, rpm: number): boolean {
    if (rf === undefined) return false;
    return rf / 100 >= interpCurve(limits.loadThreshold, rpm);
}

/**
 * Is the controller pinned against a stop?
 *
 * At the clamp the number stops being a measurement: a true 40 % error and a true 31 % error both
 * read as `K_LA_FMAX`, so folding it in understates the correction by an unknown amount. FR 5.01
 * x.6.4 treats the same condition as a fault once it persists, which is the DME agreeing that a
 * railed factor is not a working one.
 *
 * A small tolerance, because the value arrives quantised at 1/32768 and the clamp is stored in the
 * same units — an exact equality test would miss a sample sitting one count inside the rail.
 */
export const STOP_TOLERANCE = 1e-4;

export function isAtControllerStop(
    limits: LambdaLimits, stft1: number | undefined, stft2: number | undefined,
): boolean {
    // A bank that is not there cannot be pinned. Same rule as the other two gates: silence is not
    // evidence, and an EGT run — which never reads block 19 — must not have every sample rejected
    // for a channel it deliberately did not fetch.
    const pinned = (v: number | undefined) => v !== undefined
        && (v >= limits.fMax - STOP_TOLERANCE || v <= limits.fMin + STOP_TOLERANCE);
    return pinned(stft1) || pinned(stft2);
}
