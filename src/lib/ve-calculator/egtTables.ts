import { BinaryParser } from '@/lib/binary-engine/parser';
import { findEcuItem } from '@/lib/ecu-items/catalog';
import type { EcuItemDef, EcuMapDef, EcuCurveDef, EcuConstantDef } from '@/lib/ecu-items/types';

/**
 * The DME tables behind the EGT fuel correction, decoded out of a loaded binary.
 *
 * Held as plain arrays rather than as `EcuItemValue`s so that the tuner and the verification
 * scripts can use them without knowing anything about the catalog, and so that the AXES travel
 * with the values. The axes are read from the binary, never assumed: the whole back-calculation
 * is binned on this Δ axis, and a tune computed against breakpoints the ECU does not have would
 * be wrong in a way nothing downstream could detect.
 *
 * See docs/ecu-logic/20-egt-correction.md for what each one is and where the addresses come from.
 */
export interface EgtTables {
    /** KF_RF_KORR_DRREL — the correction itself. values[Δ][rpm], 1.000 = no correction. */
    rfKorr: { rpm: number[]; delta: number[]; values: number[][] };
    /** kf_rf_tabg_modell — nominal exhaust temperature. values[RF][rpm], °C. */
    tabgModel: { rpm: number[]; rf: number[]; values: number[][] };
    /** kl_rf_korr_rf_min — filling floor per rpm, above which the correction may engage. */
    rfKorrMin: { rpm: number[]; values: number[] };
    /** k_rf_korr_hys — how far rf_soll must fall BELOW the floor before the correction lets go. */
    hys: number;
    /** k_rf_korr_v_min — road-speed floor, km/h. Recorded for completeness; road speed is not in
     *  DS2 selection 3, so nothing here can evaluate it. See the note in rfKorrTuner.ts on why
     *  that turns out not to matter once Δ comes from the sensor. */
    vMin: number;
}

/** Inversion behaviour. Every one of these is a named export so it can be relaxed against real
 *  measured noise rather than by editing a literal buried in a function. */
export const EGT_INVERSION_DEFAULTS = {
    /**
     * Minimum local slope of k against Δ for the inverse to be reported at all, per °C.
     *
     * Monotonicity alone is not enough. The stock profile is strictly increasing at 4999 rpm and
     * its minimum slope there is 8e-8 /°C — blending into the flat 5000 rpm column — so inverting
     * it would divide measurement noise by almost nothing and report a Δ of any magnitude with a
     * straight face. At σ_k ≈ 0.002 (RF's 0.1 %-of-full LSB plus the Alpha-N interpolation
     * residue) this floor corresponds to about ±20 °C, which is a little better than the TABG
     * channel's own 16 °C quantisation — the natural target, since there is no point resolving
     * finer than the thing being cross-checked against.
     */
    minSlopePerDegC: 1e-4,
    /** k at or below 1 + this is treated as "no correction", which pins Δ only to [0, 30] — the
     *  DME clips tabg_delta at 0 and the Y axis starts at 30, so there is nothing to resolve. */
    unitTolerance: 0.003,
    /** A profile flatter than this across its whole Δ range cannot express anything. The 1100 and
     *  5100 rpm columns are 1.000 at every Δ; this also catches their blend into the neighbours. */
    minSpan: 0.010,
} as const;

// --- Interpolation --------------------------------------------------------------------------
// Reproduces the DME's klu_wint / kfu_wint: linear between breakpoints, CLAMPED to the end value
// outside the axis rather than extrapolated. Kept here rather than reused from VECalculator
// because that one is private and pinned to the VE grid; this has to run on three different axes
// and from a headless script.

const bracket = (axis: number[], q: number): { i0: number; i1: number; w1: number } => {
    if (!(q > axis[0])) return { i0: 0, i1: 0, w1: 0 };
    const last = axis.length - 1;
    if (!(q < axis[last])) return { i0: last, i1: last, w1: 0 };
    for (let i = 0; i < last; i++) {
        if (q >= axis[i] && q <= axis[i + 1]) {
            const span = axis[i + 1] - axis[i];
            if (span === 0) return { i0: i, i1: i, w1: 0 };
            return { i0: i, i1: i + 1, w1: (q - axis[i]) / span };
        }
    }
    return { i0: last, i1: last, w1: 0 };
};

export function interpCurve(x: number[], values: number[], q: number): number {
    const b = bracket(x, q);
    return values[b.i0] * (1 - b.w1) + values[b.i1] * b.w1;
}

export function interpMap2d(
    x: number[], y: number[], values: number[][], xq: number, yq: number,
): number {
    const bx = bracket(x, xq);
    const by = bracket(y, yq);
    const row0 = values[by.i0][bx.i0] * (1 - bx.w1) + values[by.i0][bx.i1] * bx.w1;
    const row1 = values[by.i1][bx.i0] * (1 - bx.w1) + values[by.i1][bx.i1] * bx.w1;
    return row0 * (1 - by.w1) + row1 * by.w1;
}

// --- Table lookups --------------------------------------------------------------------------

/** The 6-point k-against-Δ profile the DME would use at this rpm, blended between rpm columns.
 *  This — not a single stock column — is what has to be inverted, because a sample sits at an
 *  arbitrary rpm and the blend of two well-behaved columns need not be well-behaved. */
export function rfKorrProfileAt(t: EgtTables, rpm: number): number[] {
    const b = bracket(t.rfKorr.rpm, rpm);
    return t.rfKorr.delta.map((_, r) =>
        t.rfKorr.values[r][b.i0] * (1 - b.w1) + t.rfKorr.values[r][b.i1] * b.w1);
}

export function rfKorrAt(t: EgtTables, rpm: number, delta: number): number {
    return interpMap2d(t.rfKorr.rpm, t.rfKorr.delta, t.rfKorr.values, rpm, delta);
}

/** `rfFraction` is dimensionless (1.0 = 100 % filling) — the Y axis is stored that way. */
export function tabgModelAt(t: EgtTables, rpm: number, rfFraction: number): number {
    return interpMap2d(t.tabgModel.rpm, t.tabgModel.rf, t.tabgModel.values, rpm, rfFraction);
}

/**
 * Whether the load half of the correction's gate is open at this operating point.
 *
 * `margin` widens the floor to skip the hysteresis band as well. Once engaged the DME holds
 * rf_korr at its PREVIOUS value until rf_soll drops a further `k_rf_korr_hys` below the floor, so
 * samples just under the floor may be carrying a correction computed for a different operating
 * point. The measurement of what was applied is still exact there — it is the correspondence with
 * a current Δ that breaks — so this is a data-quality filter, not a safety gate.
 *
 * Tested against rf_soll (the Alpha-N lookup), not against RF: that is what the DME compares.
 */
export function gateOpen(t: EgtTables, rpm: number, rfSoll: number, margin = 0): boolean {
    return rfSoll > interpCurve(t.rfKorrMin.rpm, t.rfKorrMin.values, rpm) + margin;
}

/**
 * Recovers Δ (model-minus-measured exhaust temperature) from a measured rf_korr, or `undefined`.
 *
 * Used ONLY to build the `egtFromRfKorr` log column, which exists to be compared against the TABG
 * sensor: agreement cross-checks DS2 offsets 8 and 14, the catalog addresses and the whole model
 * at once. It is deliberately NOT the source of Δ for the table tuner — see rfKorrTuner.ts. Under
 * `minSlopePerDegC` only about 45 % of the 1100–5100 rpm span is invertible at all, which is a
 * fine restriction for an instrument and a disqualifying one for something bytes are derived from.
 *
 * Every refusal below returns `undefined` rather than a plausible number. A wrong Δ here would
 * look exactly like a wrong DS2 offset, which is the one thing this column has to be able to say.
 *
 * `hint` (the sensor's own Δ) selects a root inside a non-monotone profile — the stock 1600 and
 * 1900 rpm columns fall back at Δ=200 (1.034 → 1.006), so k ≈ 1.03 has three preimages there.
 */
export function invertRfKorrProfile(
    profile: number[],
    deltaAxis: number[],
    k: number,
    opts: { minSlopePerDegC: number; unitTolerance: number; minSpan: number; hint?: number },
): number | undefined {
    const n = profile.length;
    if (n < 2 || deltaAxis.length !== n) return undefined;

    // 1. A profile that never moves cannot answer the question, whatever k says.
    if (profile[n - 1] - profile[0] < opts.minSpan) return undefined;

    // 2. Below the first breakpoint the table reads 1.000 for every Δ in [0, 30]. That is not a
    //    failure to measure — it is the DME clipping tabg_delta at 0 — but it is not a Δ either.
    if (k <= profile[0] + opts.unitTolerance) return undefined;

    // 3. Above the top of the profile there is nothing to interpolate into.
    if (k > profile[n - 1]) return undefined;

    // Build the FULL preimage — every Δ at which the profile takes this value — rather than
    // scanning for the first rising segment that brackets k. The stock profiles have plateaus
    // (1200 rpm holds 1.050 from Δ=200 all the way to 400, 1400 rpm from 300 to 400), and there
    // the preimage is an interval, not a point. Taking the first root found returns its low end,
    // which reads as a confident temperature up to 200 °C away from the truth — indistinguishable
    // from the DS2-offset error this column exists to detect.
    const EPS = 1e-9;
    const pieces: Array<{ lo: number; hi: number; slope: number }> = [];
    for (let i = 0; i < n - 1; i++) {
        const vLo = profile[i], vHi = profile[i + 1];
        if (k < Math.min(vLo, vHi) - EPS || k > Math.max(vLo, vHi) + EPS) continue;

        const dDelta = deltaAxis[i + 1] - deltaAxis[i];
        if (dDelta <= 0) continue;
        const slope = (vHi - vLo) / dDelta;

        if (Math.abs(vHi - vLo) <= EPS) {
            // A plateau at exactly this value: every Δ across it is a preimage.
            pieces.push({ lo: deltaAxis[i], hi: deltaAxis[i + 1], slope: 0 });
        } else {
            const at = deltaAxis[i] + ((k - vLo) / (vHi - vLo)) * dDelta;
            const clamped = Math.min(deltaAxis[i + 1], Math.max(deltaAxis[i], at));
            pieces.push({ lo: clamped, hi: clamped, slope });
        }
    }
    if (pieces.length === 0) return undefined;

    // Merge touching or overlapping pieces. Two segments that share a breakpoint both report that
    // breakpoint; that is one preimage, not two, and must not read as an ambiguity.
    pieces.sort((a, b) => a.lo - b.lo);
    const merged: Array<{ lo: number; hi: number; slope: number }> = [];
    for (const p of pieces) {
        const last = merged[merged.length - 1];
        if (last && p.lo <= last.hi + EPS) {
            last.hi = Math.max(last.hi, p.hi);
            last.slope = Math.max(last.slope, Math.abs(p.slope));
        } else {
            merged.push({ lo: p.lo, hi: p.hi, slope: Math.abs(p.slope) });
        }
    }

    // A preimage with width is a range of temperatures, and reporting its midpoint would be a
    // number the table does not support. A hint cannot rescue this one either: picking the point
    // inside the plateau nearest the sensor would just echo the sensor back, which is exactly the
    // agreement this column is supposed to be able to fail to produce.
    if (merged.some(m => m.hi - m.lo > EPS)) return undefined;

    // Too shallow to resolve — see minSlopePerDegC. Judged on the steepest branch that produces
    // this value, since that is the one that bounds how far noise can move the answer.
    const usable = merged.filter(m => m.slope >= opts.minSlopePerDegC);
    if (usable.length === 0) return undefined;
    if (usable.length < merged.length) return undefined;   // one branch is unresolvable: refuse
    if (usable.length === 1) return usable[0].lo;

    // Genuinely several exact roots — the non-monotone rpm bands. Only the sensor's own Δ can
    // choose, and it is choosing AMONG exact solutions of the measured k rather than supplying
    // the answer, so the comparison it feeds is still a comparison.
    if (opts.hint === undefined) return undefined;
    return usable.reduce((best, m) =>
        Math.abs(m.lo - opts.hint!) < Math.abs(best.lo - opts.hint!) ? m : best).lo;
}

// --- Decoding -------------------------------------------------------------------------------

const asMap = (def: EcuItemDef | undefined): EcuMapDef | null =>
    def && def.kind === 'map' ? def : null;
const asCurve = (def: EcuItemDef | undefined): EcuCurveDef | null =>
    def && def.kind === 'curve' ? def : null;
const asConst = (def: EcuItemDef | undefined): EcuConstantDef | null =>
    def && def.kind === 'constant' ? def : null;

/**
 * Decodes every table the EGT correction needs out of a 64 KB partial binary, or returns `null`.
 *
 * All-or-nothing on purpose. A half-decoded set would not fail loudly — it would produce a tune
 * that looks entirely reasonable and is derived from the wrong bytes. Callers are expected to
 * treat `null` as "fall back to exactly the previous behaviour", never as "use a stock table from
 * constants.ts": a hardcoded table would state a calibration this binary may not have.
 */
export function readEgtTables(buffer: ArrayBuffer): EgtTables | null {
    try {
        const rfKorrDef = asMap(findEcuItem('KF_RF_KORR_DRREL'));
        const modelDef = asMap(findEcuItem('kf_rf_tabg_modell'));
        const minDef = asCurve(findEcuItem('kl_rf_korr_rf_min'));
        const hysDef = asConst(findEcuItem('k_rf_korr_hys'));
        const vMinDef = asConst(findEcuItem('k_rf_korr_v_min'));
        if (!rfKorrDef || !modelDef || !minDef || !hysDef || !vMinDef) return null;

        const parser = new BinaryParser(buffer);
        const rfKorr = parser.readItem(rfKorrDef);
        const model = parser.readItem(modelDef);
        const min = parser.readItem(minDef);
        const hys = parser.readItem(hysDef);
        const vMin = parser.readItem(vMinDef);
        if (rfKorr.kind !== 'map' || model.kind !== 'map' || min.kind !== 'curve'
            || hys.kind !== 'constant' || vMin.kind !== 'constant') return null;

        const tables: EgtTables = {
            rfKorr: { rpm: rfKorr.x, delta: rfKorr.y, values: rfKorr.values },
            tabgModel: { rpm: model.x, rf: model.y, values: model.values },
            rfKorrMin: { rpm: min.x, values: min.values },
            hys: hys.value,
            vMin: vMin.value,
        };
        return isPlausible(tables) ? tables : null;
    } catch {
        return null;
    }
}

/**
 * Shape and sanity checks on a decoded set.
 *
 * These are not style checks. If any of them fails, the addresses in the catalog do not describe
 * this binary — a different calibration, a full 1 MB image passed where a 64 KB partial was
 * expected, or a plain mistake — and every number derived downstream would be fiction. Ascending
 * axes in particular are load-bearing: `bracket` assumes it, and a descending axis would silently
 * clamp every lookup to one end.
 */
function isPlausible(t: EgtTables): boolean {
    const ascending = (a: number[]) => a.every((v, i) => i === 0 || v > a[i - 1]);
    const grid = (v: number[][], rows: number, cols: number) =>
        v.length === rows && v.every(r => r.length === cols);

    if (t.rfKorr.rpm.length < 2 || t.rfKorr.delta.length < 2) return false;
    if (!grid(t.rfKorr.values, t.rfKorr.delta.length, t.rfKorr.rpm.length)) return false;
    if (!ascending(t.rfKorr.rpm) || !ascending(t.rfKorr.delta)) return false;

    if (!grid(t.tabgModel.values, t.tabgModel.rf.length, t.tabgModel.rpm.length)) return false;
    if (!ascending(t.tabgModel.rpm) || !ascending(t.tabgModel.rf)) return false;

    if (t.rfKorrMin.values.length !== t.rfKorrMin.rpm.length) return false;
    if (!ascending(t.rfKorrMin.rpm)) return false;

    // Ranges. A correction below 1.0 would LEAN the mixture at exactly the condition BMW chose to
    // enrich; 2.0 is far above the stock peak of 1.371. Either would mean these are not the bytes
    // this code thinks they are.
    if (!t.rfKorr.values.every(r => r.every(v => v >= 1.0 && v <= 2.0))) return false;
    if (!t.tabgModel.values.every(r => r.every(v => v >= 0 && v <= 1400))) return false;
    if (!t.rfKorrMin.values.every(v => v > 0 && v <= 2)) return false;

    return true;
}
