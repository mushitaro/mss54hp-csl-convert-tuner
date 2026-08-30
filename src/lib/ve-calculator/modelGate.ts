/**
 * The model gate — does the binary's own arithmetic reproduce the number the car reported?
 *
 * This is the entry condition for tuning, and it is the only check in the app that tests the WHOLE
 * chain at once: axis decode, map decode, scaling, the rpm factor, and the density correction, all
 * against one value the DME computed itself. Everything else verifies a piece.
 *
 *     aq_rel_rf = AQ_REL / kl_aq_rel_rf_fakt(N)                 // the DIVISOR; < 1 makes it larger
 *     RF        = kf_rf_soll(N, aq_rel_rf) x RF_PT_KORR         // x rf_korr, which is 1 below 20 km/h
 *
 * `AQ_REL` is what the log calls `rawLoad`. That was not obvious and cost two wrong readings: the
 * value indexes nothing directly, and using it as the y axis leaves a 15-20 % error that looks
 * exactly like a bad map. `RF_PT_KORR` was the second: unrecorded, it left the residual at 0.876
 * on one run and 0.739 on another, which is indistinguishable from a wrong address.
 *
 * ## What a pass means
 *
 * Measured on a real drive (session 920, 578 settled idle samples): **0.9938, sd 0.0054**. The sd
 * is the resolution of `rf` itself — 0.1 on ~20 — so the chain is exact to what the channel can
 * express. A run that passes has proven, on THIS car and THIS binary, that the app reads the table
 * the DME reads. A run that fails has not found a bad engine; it has found a bad address, a bad
 * scaling, or a state where a different term enters, and no correction derived from it is worth
 * writing.
 *
 * ## Where it stops being true
 *
 * Above the idle/part-load boundary (`KL_BZ_WDK_LL`, 1.2 % at every rpm with 0.2 % hysteresis) the
 * same arithmetic lands at 0.849. Measured, on the same drive, splitting cleanly at wdk1 = 1.1:
 * below it 0.993 across 578 samples, above it 0.849 across 968. So the gate is stated for the IDLE
 * state and must not be quoted for part load until the extra term is identified — see
 * docs/ecu-logic/66-tuning-methodology.md.
 */

import { rfPtKorr, type RfPtKorrCurves } from './chargeTemp';

/** One sample, in the shape the gate needs. Every field is required — a gate that runs on partial
 *  samples reports a pass it did not earn. */
export interface GateSample {
    rpm: number;
    /** `AQ_REL`, the log's `rawLoad`. NOT the kf_rf_soll y axis: divide by the rpm factor first. */
    rawLoad: number;
    /** What the DME said the filling was. The thing being predicted. */
    rf: number;
    intakeTemp: number;
    ambientPressure: number;
    /** Throttle plate angle, %. Decides whether this sample is in the state the gate is stated for. */
    wdk1: number;
    /** Road speed, km/h. Above `k_rf_korr_v_min` the DME applies rf_korr and this prediction is
     *  missing a term, so those samples are not evidence either way. */
    vehicleSpeed: number;
}

export interface GateTables {
    /** `kf_rf_soll`: x = rpm, y = aq_rel_rf (%), values = RF as a fraction. */
    sollRpm: number[];
    sollOpening: number[];
    sollValues: number[][];
    /** `kl_aq_rel_rf_fakt`: x = rpm, values dimensionless, used as a DIVISOR. */
    faktRpm: number[];
    faktValues: number[];
    ptKorr: RfPtKorrCurves;
}

/**
 * The boundary the gate is stated below.
 *
 * `KL_BZ_WDK_LL` is 1.2 % at every rpm with 0.2 % hysteresis, so the LL/TL edge sits at 1.0-1.2 %.
 * 1.0 is the inside of it: the measured split was clean, every sample at 1.1 landing in the part-
 * load population and every sample at 1.0 and below in the idle one.
 */
export const GATE_MAX_WDK_PCT = 1.0;

/** `k_rf_korr_v_min`. At or below this the DME pins rf_korr to 1.000, which is what lets this
 *  prediction omit it. Above it the sample carries a term the gate does not model. */
export const GATE_MAX_SPEED_KMH = 0;

/** What the residual has to look like to call the chain proven. The centre band is two quantisation
 *  steps of `rf`; the spread bound is four, which the measured 0.0054 clears by a factor of two. */
export const GATE_PASS = { centre: 1.0, centreTolerance: 0.02, maxSpread: 0.02 } as const;

function interp(xs: number[], ys: number[], x: number): number {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[xs.length - 1]) return ys[ys.length - 1];
    for (let i = 0; i < xs.length - 1; i++) {
        if (x >= xs[i] && x <= xs[i + 1]) {
            const t = (x - xs[i]) / (xs[i + 1] - xs[i]);
            return ys[i] + (ys[i + 1] - ys[i]) * t;
        }
    }
    return ys[ys.length - 1];
}

/** The y-axis position a sample sits at: `AQ_REL / kl_aq_rel_rf_fakt(N)`. Exported because the
 *  low-load and idle correctors have to bin by the same number the DME indexed with. */
export function aqRelRf(t: GateTables, rpm: number, rawLoad: number): number {
    const f = interp(t.faktRpm, t.faktValues, rpm);
    return f > 0 ? rawLoad / f : rawLoad;
}

/** What the binary says `rf` should be for this sample, as a percentage — the same units the log
 *  reports. Returns null when the tables cannot answer. */
export function predictRf(t: GateTables, s: GateSample): number | null {
    const aq = aqRelRf(t, s.rpm, s.rawLoad);
    const column = t.sollValues.map(row => interp(t.sollRpm, row, s.rpm));
    const soll = interp(t.sollOpening, column, aq);
    const pt = rfPtKorr(t.ptKorr, s.intakeTemp, s.ambientPressure);
    if (!Number.isFinite(soll) || !Number.isFinite(pt)) return null;
    return soll * 100 * pt;
}

export interface GateResult {
    /** Samples that were in the state the gate is stated for. */
    used: number;
    /** Samples excluded, by reason — reported rather than summed, because "no evidence" and
     *  "evidence the gate cannot judge" are different answers. */
    rejected: { throttleOpen: number; moving: number; incomplete: number };
    /** Median of logged / predicted. 1.0 is exact. */
    ratio: number | null;
    /** Population sd of the same. This is the number that says whether the chain is exact or merely
     *  centred: a right answer on average with a wide spread is two errors cancelling. */
    spread: number | null;
    passed: boolean;
    /** One line for a human, naming what failed rather than that something did. */
    detail: string;
}

/**
 * Run the gate over a set of samples.
 *
 * Deliberately reports the spread beside the centre. A centre alone can be produced by two errors
 * that cancel at the median, and the whole value of this check is that it is hard to fool.
 */
export function evaluateModelGate(samples: GateSample[], t: GateTables | null): GateResult {
    const rejected = { throttleOpen: 0, moving: 0, incomplete: 0 };
    if (!t) {
        return { used: 0, rejected, ratio: null, spread: null, passed: false, detail: 'The binary’s tables could not be read, so nothing was predicted.' };
    }
    const ratios: number[] = [];
    for (const s of samples) {
        if (![s.rpm, s.rawLoad, s.rf, s.intakeTemp, s.ambientPressure, s.wdk1, s.vehicleSpeed]
            .every(v => typeof v === 'number' && Number.isFinite(v)) || s.rf <= 0) {
            rejected.incomplete++; continue;
        }
        if (s.vehicleSpeed > GATE_MAX_SPEED_KMH) { rejected.moving++; continue; }
        if (s.wdk1 > GATE_MAX_WDK_PCT) { rejected.throttleOpen++; continue; }
        const p = predictRf(t, s);
        if (p === null || p <= 0) { rejected.incomplete++; continue; }
        ratios.push(s.rf / p);
    }
    if (ratios.length < 20) {
        return {
            used: ratios.length, rejected, ratio: null, spread: null, passed: false,
            detail: `Only ${ratios.length} samples were taken at a settled idle; the gate needs 20. `
                + `Excluded: ${rejected.throttleOpen} with the throttle past ${GATE_MAX_WDK_PCT} %, `
                + `${rejected.moving} moving, ${rejected.incomplete} missing a channel.`,
        };
    }
    const sorted = [...ratios].sort((a, b) => a - b);
    const ratio = sorted[sorted.length >> 1];
    const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length;
    const spread = Math.sqrt(ratios.reduce((a, b) => a + (b - mean) ** 2, 0) / ratios.length);

    const offCentre = Math.abs(ratio - GATE_PASS.centre) > GATE_PASS.centreTolerance;
    const tooWide = spread > GATE_PASS.maxSpread;
    const passed = !offCentre && !tooWide;
    const detail = passed
        ? `The binary reproduces this car’s own rf to ${((1 - Math.abs(1 - ratio)) * 100).toFixed(1)} % over ${ratios.length} idle samples (spread ${(spread * 100).toFixed(1)} %).`
        : offCentre
            ? `Predicted rf is off by ${((ratio - 1) * 100).toFixed(1)} % over ${ratios.length} idle samples. `
                + 'That is an address, a scaling or a missing term — not a mixture error. Do not derive a correction from this run.'
            : `Predicted rf is centred but scattered (spread ${(spread * 100).toFixed(1)} %, limit ${(GATE_PASS.maxSpread * 100).toFixed(0)} %). `
                + 'A centre that is right on average with a wide spread is two errors cancelling; the chain is not proven.';
    return { used: ratios.length, rejected, ratio, spread, passed, detail };
}
