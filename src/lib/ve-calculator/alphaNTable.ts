/**
 * The tables a low-load correction cannot be derived without.
 *
 * Same all-or-nothing contract as `egtTables.ts`, and the same rule about `null`: it means fall
 * back, never "use a stock table". Here that rule carries more weight than anywhere else in the
 * app, because the failure it prevents is silent and large.
 *
 * ## What this module is for, now that TI_F_STAT is not a correction term
 *
 * **This header used to carry the derivation the whole app cited, and the derivation was wrong.**
 * It read:
 *
 *     ti proportional to TL x TI_F_STAT x STFT,  TL proportional to RF,  loop drives lambda -> 1
 *     =>  kf_rf_soll_new = kf_rf_soll_old x STFT x rf_korr x TI_F_STAT
 *
 * with the conclusion that a trim of 1/1.148 = 0.871 at the lowest filling is what a PERFECT
 * engine shows, so multiplying the factor back in is how you recover "change nothing", and
 * omitting it leans the map 13 %.
 *
 * The step that does not hold is `ti proportional to ... x STFT` with STFT free to absorb
 * TI_F_STAT. Session #920 walked RF across this table's own y = 0.15 breakpoint, where the factor
 * steps from ~1.17 to exactly 1.000, with rpm held inside one band — 1,479 warm closed-loop
 * samples:
 *
 *     median trim               0.9685 below  ->  0.9699 above    (+0.1 %)   CONTINUOUS
 *     median trim x TI_F_STAT   1.0728 below  ->  0.9699 above    (-9.6 %)   STEPS
 *     regression of (trim - 1) on (TI_F_STAT - 1):   slope -0.025, against -1 predicted
 *
 * The enrichment reading requires the TRIM to carry the step. It does not; the PRODUCT does. So
 * the loop never removes the factor, and `KF_TI_N_RF` is part of the air-to-fuel conversion
 * already — small-pulse injector compensation, which is also what its shape says: unity
 * everywhere, rising only at the shortest pulses and rising further with rpm. Multiplying by it
 * invented up to +15 % of correction in the cells an ordinary drive covers best.
 * `verify:ti-factor` holds the measurement and fails if any derivation puts the factor back.
 *
 * **The correction, in both bands, is `trim x rf_korr` with `trim = STFT x LTFT`.** See
 * `calculator.ts` accumulatePoint for why `rf_korr` IS a term (measured at the seam of the DME
 * gate) and `docs/ecu-logic/60-tuning-logic.md` section 6.3.1 for the numbers.
 *
 * So this module no longer supplies an operator. It supplies:
 *   - `sollRpm` / `sollOpening`, the axes of `kf_rf_soll` read from the binary rather than rounded
 *     constants — which is why `null` still means fall back and never "use a stock table";
 *   - `tiLoadFactorAt`, so the panel can report how many samples were taken where the DME was
 *     compensating short pulses;
 *   - `tiBranchAmbiguous`, for a gate that is now off by default because neither branch can change
 *     a written byte.
 */

import { BinaryParser } from '@/lib/binary-engine/parser';
import { findEcuItem } from '@/lib/ecu-items/catalog';

/**
 * `kf_rf_soll`'s own axis addresses. The table's data lives at 0xD356, which
 * `APP_CONFIG.MSS54HP.VE_TABLE` already names; these two runs sit immediately before it and are the
 * axes the app has always assumed rather than read.
 */
const VE_X_ADDR = 0xD2FE;
const VE_X_N = 20;
const VE_Y_ADDR = 0xD326;
const VE_Y_N = 24;

export interface AlphaNMap { x: number[]; y: number[]; values: number[][] }
export interface AlphaNCurve { x: number[]; values: number[] }

export interface AlphaNTables {
    /** `KF_TI_N_RF` — x = rpm, y = RF (fraction), values dimensionless. */
    tiLoad: AlphaNMap;
    /** `KF_TI_N_RF_VL` — the full-load branch. Read for completeness and for the WOT-map identity. */
    tiVl: AlphaNMap;
    /** `KL_TI_N_ZWD_LL` — the unresolved idle branch. Values BELOW 1.0. */
    tiIdle: AlphaNCurve;
    /** `K_LA_TI_MIN`, ms. Below this the DME opens the lambda loop. */
    tiMinMs: number;
    /** `kf_rf_soll`'s own axes, read from the binary rather than taken from APP_CONFIG.
     *  The constants round 1.391602 to 1.40 and 1.611328 to 1.60 — a 0.6-0.7 % error sitting
     *  directly on top of the gain hump a low-load repair exists to flatten. */
    sollRpm: number[];
    sollOpening: number[];
}

function ascending(a: number[]): boolean {
    return a.length > 1 && a.every((v, i) => i === 0 || v > a[i - 1]);
}

/**
 * The structural fingerprint of `KF_TI_N_RF`.
 *
 * Every row at rf >= 0.15 is EXACTLY 1.000 in this calibration — that is not a coincidence of the
 * numbers, it is the shape of the design: BMW enriched one row and left the rest alone. A binary
 * where those rows are not flat is either a different calibration or the wrong bytes, and in both
 * cases the premise the whole low-load derivation rests on has stopped being true. Refusing is the
 * only honest answer; assuming 1.0 would derive a correction from a table nobody read.
 */
function tiLoadIsPlausible(m: AlphaNMap): boolean {
    if (!ascending(m.x) || !ascending(m.y)) return false;
    if (m.values.length !== m.y.length) return false;
    if (m.values.some(r => r.length !== m.x.length)) return false;
    if (m.values.some(r => r.some(v => !(v >= 0.5 && v <= 2.0)))) return false;
    // Row 0 is the enriched one; every row above it must be exactly unity.
    for (let r = 1; r < m.values.length; r++) {
        if (m.values[r].some(v => Math.abs(v - 1) > 1e-9)) return false;
    }
    // ...and row 0 must actually be enriched, or this is not the table it claims to be.
    if (!m.values[0].some(v => v > 1.01)) return false;
    return true;
}

export function readAlphaNTables(buffer: ArrayBuffer): AlphaNTables | null {
    let parser: BinaryParser;
    try { parser = new BinaryParser(buffer); } catch { return null; }

    const readMap = (symbol: string): AlphaNMap | null => {
        const def = findEcuItem(symbol);
        if (!def || def.kind !== 'map') return null;
        const v = parser.readItem(def);
        return v && v.kind === 'map' ? { x: v.x, y: v.y, values: v.values } : null;
    };

    const tiLoad = readMap('KF_TI_N_RF');
    const tiVl = readMap('KF_TI_N_RF_VL');
    const tiIdleDef = findEcuItem('KL_TI_N_ZWD_LL');
    const tiMinDef = findEcuItem('K_LA_TI_MIN');
    if (!tiLoad || !tiVl || !tiIdleDef || tiIdleDef.kind !== 'curve' || !tiMinDef || tiMinDef.kind !== 'constant') {
        return null;
    }
    const tiIdleVal = parser.readItem(tiIdleDef);
    const tiMinVal = parser.readItem(tiMinDef);
    if (!tiIdleVal || tiIdleVal.kind !== 'curve' || !tiMinVal || tiMinVal.kind !== 'constant') return null;

    // kf_rf_soll's axes, straight out of the bytes.
    //
    // NOT via getVETable, which returns APP_CONFIG.AXIS_RPM / AXIS_LOAD — hard-coded constants that
    // round 1.391602 to 1.40 and 1.611328 to 1.60. That is a 0.6-0.7 % axis error sitting directly
    // on top of the gain hump the shape repair exists to flatten, so a repair computed against the
    // constants would be measuring interval widths the calibration does not have.
    const sollRpm: number[] = [];
    const sollOpening: number[] = [];
    try {
        for (let i = 0; i < VE_X_N; i++) sollRpm.push(parser.getUint16(VE_X_ADDR + i * 2));
        for (let i = 0; i < VE_Y_N; i++) sollOpening.push(parser.getUint16(VE_Y_ADDR + i * 2) * 100 / 32768);
    } catch { return null; }

    const out: AlphaNTables = {
        tiLoad, tiVl,
        tiIdle: { x: tiIdleVal.x, values: tiIdleVal.values },
        tiMinMs: tiMinVal.value,
        sollRpm, sollOpening,
    };

    if (!tiLoadIsPlausible(tiLoad)) return null;
    if (!(out.tiMinMs > 0 && out.tiMinMs <= 5)) return null;
    if (out.tiIdle.values.some(v => !(v >= 0.5 && v <= 1.5))) return null;
    if (!ascending(sollRpm) || !ascending(sollOpening)) return null;
    return out;
}

/** Bilinear lookup with edge clamping. */
function interp2d(m: AlphaNMap, x: number, y: number): number {
    const bracket = (axis: number[], v: number) => {
        if (v <= axis[0]) return { i0: 0, i1: 0, w: 0 };
        const last = axis.length - 1;
        if (v >= axis[last]) return { i0: last, i1: last, w: 0 };
        let i = 0;
        while (i < last && axis[i + 1] < v) i++;
        const span = axis[i + 1] - axis[i];
        return { i0: i, i1: i + 1, w: span === 0 ? 0 : (v - axis[i]) / span };
    };
    const bx = bracket(m.x, x);
    const by = bracket(m.y, y);
    const top = m.values[by.i0][bx.i0] * (1 - bx.w) + m.values[by.i0][bx.i1] * bx.w;
    const bot = m.values[by.i1][bx.i0] * (1 - bx.w) + m.values[by.i1][bx.i1] * bx.w;
    return top * (1 - by.w) + bot * by.w;
}

/**
 * `TI_F_STAT` at this operating point — the term the low-load correction MULTIPLIES by.
 *
 * Looked up at the LOGGED `rf`, per sample, never at an assumed one. The y axis is relative
 * filling, not throttle opening, which is what makes this a smooth function rather than a step: a
 * sample at rf = 0.125 gets about 1.074.
 */
export function tiLoadFactorAt(t: AlphaNTables, rpm: number, rfFraction: number): number {
    return interp2d(t.tiLoad, rpm, rfFraction);
}

/** The idle-branch factor, for showing next to the one above while the branch is unresolved. */
export function tiIdleFactorAt(t: AlphaNTables, rpm: number): number {
    const { x, values } = t.tiIdle;
    if (rpm <= x[0]) return values[0];
    const last = x.length - 1;
    if (rpm >= x[last]) return values[last];
    let i = 0;
    while (i < last && x[i + 1] < rpm) i++;
    const span = x[i + 1] - x[i];
    const w = span === 0 ? 0 : (rpm - x[i]) / span;
    return values[i] * (1 - w) + values[i + 1] * w;
}

/**
 * Do the two candidate branches disagree here?
 *
 * Where they agree, the unresolved branch condition does not matter and a sample is usable whatever
 * `ti_load_factor` picked. Where they disagree — which is the whole idle region, 1.148 against
 * 0.859 — nothing may be derived until the branch is settled on the car. This is the function that
 * lets the tuner be precise about which samples the open question actually costs it, instead of
 * refusing the whole band.
 */
export function tiBranchAmbiguous(t: AlphaNTables, rpm: number, rfFraction: number, tol = 0.01): boolean {
    // Outside the idle curve's OWN x axis the idle branch is not a candidate at all: BMW ended it
    // at 1800 rpm, and a lookup above that is an edge-clamp rather than a value the DME would use.
    // Without this the function would call every operating point ambiguous — including 3000 rpm at
    // half load, where the idle branch obviously does not run — which is a useless answer wearing a
    // cautious one's clothes.
    const idleAxisTop = t.tiIdle.x[t.tiIdle.x.length - 1];
    if (rpm > idleAxisTop) return false;
    return Math.abs(tiLoadFactorAt(t, rpm, rfFraction) - tiIdleFactorAt(t, rpm)) > tol;
}
