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

import { interpAxis } from '@/lib/log-engine/axisBracket';

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

/**
 * Linear interpolation with flat ends. Outside the axis the nearest breakpoint holds, which is what
 * the DME does and also the only defensible thing: extrapolating a calibration invents data.
 *
 * NaN in, NaN out — and it did not used to be. `at <= x[0]` is false for NaN, so a NaN fell past
 * both boundary tests and out of the loop to `return y[y.length - 1]`: a sample with no rpm was
 * given the calibration's value AT REDLINE, which for the WOT threshold is the most permissive
 * number on the curve. Now it says it does not know, and the gate treats an unknown threshold as a
 * channel it cannot test rather than as a test that passed.
 */
export function interpCurve(curve: Curve, at: number): number {
    return interpAxis(curve.x, curve.y, at);
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
 * way — and it is made so the census answers "what should I change about the next run": a cold
 * engine is fixable by waiting, a short pull by holding it longer, full load by driving
 * differently. The cheapest thing to fix wins the label.
 *
 * There is no purge reason. A tank-vent exclusion shipped here once, as salvage for logs recorded
 * without the TANK VENT: SHUT patch — measured on such a log (#902) it kept 17.2 % of the samples
 * and still had no detection power, and every tuning flash carries the patch, so the salvage was
 * a knob nobody could ever usefully turn. Deleted 2026-08-22; the patch is the whole answer. The
 * TETV channel itself is still logged — see verify-tankvent.mjs for what it is now for.
 */
export type DropReason =
    | 'coldEngine'
    | 'idle'
    | 'transient'
    | 'catProtect'
    | 'fullLoad'
    | 'controllerStop'
    | 'fuelCut'
    | 'highLoadSettle'
    | 'settle'
    | 'excluded';

export type DropCensus = Record<DropReason, number>;

export const EMPTY_CENSUS: DropCensus = {
    coldEngine: 0, idle: 0, transient: 0, catProtect: 0, fullLoad: 0, highLoadSettle: 0,
    settle: 0, controllerStop: 0, fuelCut: 0, excluded: 0,
};

/**
 * Overrun fuel cut — the engine turning, the throttle shut, and nothing being injected.
 *
 * Lift off in gear and the DME stops the injectors entirely. There is no mixture, so there is
 * nothing for the lambda controller to measure, and `la_f_regler` parks at exactly 1.000 until
 * fuelling resumes. That number is the controller saying "not measuring". Averaged into a VE cell
 * it votes "this cell is already perfect", which is the one thing it cannot possibly mean.
 *
 * Measured on two real drives before this gate existed: 1,814 of 7,751 samples (23%) sat at exactly
 * 1.000 at 1500-3500 rpm with the throttle at 0.1% and the load at 0.4%, and **1,197 of them — 28%
 * of everything the VE calculation was averaging — reached the map.** Every one of them pulled a
 * low-load cell toward "no correction", which is where 94 of the 98 evidence cells live.
 *
 * THREE conditions, and all three are needed:
 *
 *  1. **The controller is parked at exactly 1.000.** Bit-exact, not a tolerance: the channel is
 *     `uint16 x 2^-15`, so 1.000 is the single code 32768, and a controller that is actually
 *     working dithers around its setpoint rather than sitting on one code. This is the evidence.
 *  2. **The throttle is shut**, which is what makes it overrun rather than a coincidence.
 *  3. **The load is at the floor.** A closed throttle at high filling is not overrun; it is a
 *     moment during a lift where the manifold has not emptied yet.
 *
 * Requiring 2 and 3 is what keeps a genuinely perfect part-load cell — where the trim really can
 * read 1.000 for a sample or two — out of this gate. Missing channels answer `false`: a log with no
 * throttle column cannot tell overrun from anything else, and silence must not become evidence.
 */
export const FUEL_CUT_THROTTLE_MAX = 2.0;
export const FUEL_CUT_LOAD_MAX = 2.0;

export function isFuelCut(
    stft1: number | undefined,
    stft2: number | undefined,
    wdk1: number | undefined,
    rawLoad: number | undefined,
): boolean {
    if (wdk1 === undefined || rawLoad === undefined) return false;
    if (wdk1 > FUEL_CUT_THROTTLE_MAX || rawLoad > FUEL_CUT_LOAD_MAX) return false;
    // Every bank that reported has to be parked. One bank still controlling means fuel is flowing.
    const banks = [stft1, stft2].filter((v): v is number => v !== undefined);
    if (!banks.length) return false;
    return banks.every(v => v === 1);
}

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

/**
 * How close to its clamp a trim may sit and still count as high-load MEASUREMENT, absolute.
 *
 * `isAtControllerStop` (STOP_TOLERANCE) rejects a trim that IS pinned. This is its wider sibling
 * for the high-load settle gate: a trim that is merely NEAR its clamp mid-excursion is on its way
 * somewhere, and the number it shows is "at least this much", not a reading. Measured on the one
 * drive that exposed it (#917, a WOT entry onto a 304 degC pipe): the unconverged samples sat at
 * 0.721-0.766 against a 0.70001 floor — through STOP_TOLERANCE, eleven seconds past the settle
 * clock, and walking at ~1.5 %/s — while every converged high-load stretch in the same log stayed
 * at or above 0.853. The 0.09 gap between those two populations is what this margin cuts through;
 * trend detection cannot (the lambda dither is itself 4-8 % between 1.5 s windows, measured).
 */
export const TRIM_CLAMP_MARGIN = 0.10;

/** `isAtControllerStop` widened by TRIM_CLAMP_MARGIN — same bank rule: silence is not evidence. */
export function isNearControllerClamp(
    limits: LambdaLimits, stft1: number | undefined, stft2: number | undefined,
): boolean {
    const near = (v: number | undefined) => v !== undefined
        && (v >= limits.fMax - TRIM_CLAMP_MARGIN || v <= limits.fMin + TRIM_CLAMP_MARGIN);
    return near(stft1) || near(stft2);
}

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
