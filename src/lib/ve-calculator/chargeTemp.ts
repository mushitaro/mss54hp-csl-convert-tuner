import { BinaryParser } from '@/lib/binary-engine/parser';
import { findEcuItem } from '@/lib/ecu-items/catalog';
import type { EcuCurveDef, EcuItemDef } from '@/lib/ecu-items/types';
import { interpAxis } from '@/lib/log-engine/axisBracket';
import type { LogDataPoint } from '@/lib/types';

/**
 * Stating a VE measurement at the air the table is written for.
 *
 * ## The thing that had to be corrected first
 *
 * This app was built believing the Alpha-N fuel path has no temperature or pressure term, and that
 * a VE table therefore silently bakes in whatever air it was measured in. That is false.
 * `rf_soll_calc` (decomp/master/01a9d2.txt) ends with
 *
 *     rf_soll = (rf_soll_filtered * RF_PT_KORR) >> 12;
 *
 * and `RF_PT_KORR` is `KL_RF_TAN_KORR(TAN) * KL_RF_P_UMG_KORR(P_UMG)`. The tuning patch clears
 * `k_rf_cfg` bit 4, which removes the `rf_p_saug_i` integral from `rf_calc` and touches nothing
 * here. So the DME scales the table for the day's air on every segment, patch in or out, and a
 * logged lambda trim was measured through that scaling.
 *
 * The job is therefore not to ADD a density correction. It is to avoid subtracting one twice.
 *
 * ## Pressure: it cancels, and that is why there is no pressure term below
 *
 * Write the measurement out. With the table holding `kf_rf_soll` and the truth being `VE_geom`:
 *
 *     trim  =  actual air / commanded air
 *           ∝  (P * VE_geom / T) / (kf_rf_soll * KL_P(P))
 *
 * `KL_RF_P_UMG_KORR` is linear in pressure — within 0.24 % at 888 mbar and 0.08 % at 943, the two
 * altitudes this car lives between — so `KL_P(P) = P / 960.5` and the `P` divides out:
 *
 *     trim  ∝  960.5 * VE_geom / (T * kf_rf_soll)
 *
 * The same table therefore comes out of a drive at 888 mbar as out of one at 943. **Adding a
 * pressure term here would BREAK that cancellation, not improve it.** Pressure is still logged,
 * because the cancellation only holds while the DME has a real reading — see
 * `ambientPressureSubstituted`.
 *
 * **That is true of the TRIM, and it was false of what this app used to bin.** The correction is
 * `avgStft * rfKorr`, and `rfKorr` was measured as `RF / kf_rf_soll` against a table that has no
 * `RF_PT_KORR` in it — so the measured value was `RF_PT_KORR * rf_korr`, and multiplying by it put
 * back exactly the density the trim had cancelled. Measured on this car: within one drive, with the
 * VE cell held fixed, `d ln(correction)/d ln(P)` was **+1.10 ± 0.16** where the trim alone gave
 * **+0.07 ± 0.06**. Two drives ten hours apart at 969 and 994 mbar disagreed by 2.9 %, and by 0.25 %
 * once the density was divided back out; two campaigns at 888 and 993 mbar disagreed by 12.9 %.
 * `rfPtKorrFor` below is what stops it, applied in `annotateRfKorrPoint` where the measurement is
 * made rather than here where its consequences are.
 *
 * ## Temperature: the DME has a better answer than an exponent
 *
 * What is left is `VE_geom * T_charge / KL_T(TAN)`, and `T_charge` is not the sensor. `tan_m`
 * (`tan_m_adj_calc`, decomp/master/0212be.txt, with `k_tanm_cfg` = 1 on this calibration) is
 *
 *     tan_m = TMOT - f * (TMOT - TAN),    f = |gain| * ML[kg/h] / 10000, clamped to 1
 *
 * — air through a hot port picks up wall heat, and less of it the faster it goes, so at light load
 * the charge sits near coolant temperature whatever the weather is and at high flow it is the
 * sensor reading. `f` reaches 1 at 286 kg/h running, 143 idling.
 *
 * That makes the temperature sensitivity of VE **load-dependent**, which a one-dimensional
 * `KL_RF_TAN_KORR` cannot express — and is why that curve is so much flatter than 1/T. It is an
 * average of a thing that varies.
 *
 * So the factor is
 *
 *     factor = (tan_m / tan_m_ref) * KL_T(TAN)
 *
 * with `tan_m_ref` the value `tan_m` would have had at the reference intake temperature and the
 * same coolant and flow. **No fitted constant appears anywhere in it.** `f` does not have to be
 * recomputed from the gains either — it falls out of three logged channels:
 *
 *     f = (TMOT - tan_m) / (TMOT - TAN)
 *
 * Sanity, at TMOT 95 degC and TAN 60 degC: at high flow `f` = 1, `tan_m` = TAN, and the factor is
 * `(333/293) * 0.9795` = 1.113 — the mass hot air lost, put back, less what the DME already put
 * back. At idle `f` = 0, `tan_m` = TMOT, and the factor is `0.9795` — the app UNDOING the DME's
 * correction, because at low flow the ambient temperature does not reach the charge and the DME
 * corrected for it anyway.
 *
 * ## It was measured, and it failed
 *
 * The acceptance test was stated before the drive: applying this must REDUCE the cell-to-cell
 * scatter. Session #917 (2026-08-22, 6,092 samples, 22 minutes, intake air spanning 37.5 to
 * 68.5 degC, a 29.8 s sustained pull so the charge model actually converged) says it does not.
 *
 *     per-cell correction against cell mean intake temperature   +0.029 %/degC over 14 cells
 *         ideal gas would predict about                          -0.30
 *         BMW's own KL_RF_TAN_KORR about                         -0.06
 *
 *     cell-to-cell spread (p05-p95)   normalisation OFF   7.30 %
 *                                     normalisation ON    7.86 %
 *
 * **There is no leftover temperature dependence to remove, and switching this on makes the map
 * noisier.** The seasonal difference this module was written for was never density: it was the
 * rf_korr measurement carrying RF_PT_KORR, fixed in `annotateRfKorrPoint`. Once that came out, three
 * drives at 969, 994 and 985 mbar and intake temperatures from 28 to 69 degC agreed to 0.3 % at the
 * median, with 88 % of shared cells inside 2 %.
 *
 * So the toggle is gone from the panel — a control that has been measured to make things worse is
 * worse than a dead one, because someone will eventually wonder and spend a drive finding out
 * again. `LogFilterConfig.normaliseChargeTemp` and `VeCalcOptions.normaliseTo` are still honoured,
 * so an archived session that carries the flag still reproduces, and `verify:charge-temp` still
 * pins the arithmetic. To re-test: set `normaliseTo` in a scratch script against a drive with a
 * wide intake-temperature span and compare the two numbers above.
 *
 * The measurement side stays. `summariseChargeTemp` reports what air a drive was taken in, which is
 * worth knowing whether or not anything is done with it — and `rfPtKorrFor` below is now load
 * bearing for a different reason entirely: it is what `annotateRfKorrPoint` divides by.
 */

/** `KL_RF_TAN_KORR` and `KL_RF_P_UMG_KORR`, decoded, with their axes in physical units. */
export interface RfPtKorrCurves {
    /** x in degC (raw `TAN` minus 48), values around 1.0. */
    tan: { x: number[]; values: number[] };
    /** x in mbar (raw `P_UMG` times 3 plus 498.5), values around 1.0. */
    pUmg: { x: number[]; values: number[] };
}

/** The condition at which `RF_PT_KORR` is exactly 1 — i.e. what the VE table's numbers mean. */
export interface RfPtKorrReference {
    intakeTempC: number;
    pressureMbar: number;
}

/**
 * How far the pressure curve may stray from a straight line through its own unity point.
 *
 * This is not a style check. The decision NOT to carry a pressure term rests entirely on
 * `KL_RF_P_UMG_KORR` being proportional to pressure; if a binary turned up where it is not, the
 * cancellation above is false and this module would be quietly writing altitude into the map. The
 * shipped curve's worst point is 0.79 % (at 597.5 mbar, far below anywhere this car goes) and it is
 * inside 0.25 % across 888-1098, so 2 % is loose enough to admit a different calibration's rounding
 * and tight enough to catch a curve that means something else.
 */
export const PRESSURE_LINEARITY_TOLERANCE = 0.02;

/**
 * Minimum coolant-to-intake gap for `f` to be recoverable, kelvin.
 *
 * `f = (TMOT - tan_m) / (TMOT - TAN)` is indeterminate when the two anchors meet, and merely noisy
 * just before that. A cold start has them equal by definition; the tuner's own temperature filter
 * (65 degC coolant) means samples that reach here normally sit 20-50 K apart.
 */
export const MIN_COOLANT_INTAKE_GAP_K = 5;

/**
 * How far outside `[TAN, TMOT]` a charge temperature may sit before the sample is refused, kelvin.
 *
 * The model's own clamp keeps `tan_m_adj` between the two anchors, so anything outside is either
 * filter lag across a transient or a decode that is not what this file claims. Two kelvin admits
 * the first and rejects the second.
 */
export const CHARGE_TEMP_SLACK_K = 2;

const CELSIUS_TO_K = 273.15;

function asCurve(def: EcuItemDef | undefined): EcuCurveDef | null {
    return def && def.kind === 'curve' ? def : null;
}

/**
 * Where a curve crosses 1.0, in axis units.
 *
 * Both curves land their unity value on an exact grid node in the shipped binary, which is not a
 * coincidence — it is how BMW says what the table is defined at. Interpolating anyway means a
 * calibration that puts it between nodes still gets a right answer rather than a nearest one.
 *
 * Returns null when the curve does not cross 1.0 at all, which would mean the axis is not the one
 * this file thinks it is.
 */
function unityPoint(x: readonly number[], values: readonly number[]): number | null {
    for (let i = 0; i < values.length; i++) {
        if (values[i] === 1) return x[i];
    }
    for (let i = 0; i < values.length - 1; i++) {
        const a = values[i] - 1;
        const b = values[i + 1] - 1;
        if ((a < 0 && b > 0) || (a > 0 && b < 0)) {
            return x[i] + (x[i + 1] - x[i]) * (a / (a - b));
        }
    }
    return null;
}

/**
 * Shape checks. A failure here means the addresses do not describe this binary, and every number
 * downstream would be fiction — the same standard `egtTables.isPlausible` holds itself to.
 */
function isPlausible(c: RfPtKorrCurves): boolean {
    const ascending = (a: number[]) => a.every((v, i) => i === 0 || v > a[i - 1]);
    if (c.tan.x.length < 2 || c.pUmg.x.length < 2) return false;
    if (!ascending(c.tan.x) || !ascending(c.pUmg.x)) return false;
    if ([...c.tan.values, ...c.pUmg.values].some(v => !(v > 0.2 && v < 3))) return false;

    const ref = referenceOf(c);
    if (!ref) return false;
    // The reference has to be somewhere an engine actually runs. 20 degC / 960.5 mbar on the
    // shipped binary; the bands are wide enough for any calibration and narrow enough that a curve
    // read at the wrong address cannot pass.
    if (!(ref.intakeTempC > -20 && ref.intakeTempC < 60)) return false;
    if (!(ref.pressureMbar > 700 && ref.pressureMbar < 1100)) return false;

    // The load-bearing one: proportional to pressure, or the whole no-pressure-term argument fails.
    const worst = Math.max(...c.pUmg.x.map((p, i) =>
        Math.abs(c.pUmg.values[i] / (p / ref.pressureMbar) - 1)));
    return worst <= PRESSURE_LINEARITY_TOLERANCE;
}

/** The condition where `RF_PT_KORR` is 1 — read out of the curves, never assumed. */
export function referenceOf(c: RfPtKorrCurves): RfPtKorrReference | null {
    const intakeTempC = unityPoint(c.tan.x, c.tan.values);
    const pressureMbar = unityPoint(c.pUmg.x, c.pUmg.values);
    return intakeTempC === null || pressureMbar === null ? null : { intakeTempC, pressureMbar };
}

/** Both curves out of a loaded partial BIN, or null if they do not decode plausibly. */
export function readRfPtKorrCurves(buffer: ArrayBuffer): RfPtKorrCurves | null {
    try {
        const tanDef = asCurve(findEcuItem('KL_RF_TAN_KORR'));
        const pDef = asCurve(findEcuItem('KL_RF_P_UMG_KORR'));
        if (!tanDef || !pDef) return null;

        const parser = new BinaryParser(buffer);
        const tan = parser.readItem(tanDef);
        const pUmg = parser.readItem(pDef);
        if (tan.kind !== 'curve' || pUmg.kind !== 'curve') return null;

        const curves: RfPtKorrCurves = {
            tan: { x: tan.x, values: tan.values },
            pUmg: { x: pUmg.x, values: pUmg.values },
        };
        return isPlausible(curves) ? curves : null;
    } catch {
        return null;
    }
}

/**
 * `RF_PT_KORR` as the DME computes it, for display beside a log.
 *
 * Reproduced rather than read from RAM because it is not in either readable window, and because
 * having it as a function is what lets the app show the factor for a sample that has the two
 * indices and nothing else. `klu_wint` clamps at both ends; `interpAxis` does the same.
 */
export function rfPtKorr(c: RfPtKorrCurves, intakeTempC: number, pressureMbar: number): number {
    return interpAxis(c.tan.x, c.tan.values, intakeTempC)
        * interpAxis(c.pUmg.x, c.pUmg.values, pressureMbar);
}

/**
 * What to multiply a sample's measured correction by to state it at the reference air.
 *
 * Returns undefined — never 1 — when the sample cannot answer. A factor of 1 would silently mix an
 * un-normalised sample in with normalised ones in the same cell, which is the failure this whole
 * exercise exists to stop; the caller drops it instead.
 */
export function chargeTempFactor(
    point: LogDataPoint, curves: RfPtKorrCurves | null,
): number | undefined {
    if (!curves) return undefined;
    // A substituted ambient pressure breaks the cancellation the whole derivation rests on. It
    // cannot be seen in the value — the DME re-learns its substitute from the manifold sensor at
    // key-on — so this flag is the only thing that can refuse the sample.
    if (point.ambientPressureSubstituted) return undefined;

    const { intakeTemp, chargeTemp, coolantTemp } = point;
    if (intakeTemp === undefined || chargeTemp === undefined || coolantTemp === undefined) return undefined;
    if (![intakeTemp, chargeTemp, coolantTemp].every(Number.isFinite)) return undefined;

    const ref = referenceOf(curves);
    if (!ref) return undefined;

    const tan = intakeTemp + CELSIUS_TO_K;
    const tanM = chargeTemp + CELSIUS_TO_K;
    const tmot = coolantTemp + CELSIUS_TO_K;
    const refK = ref.intakeTempC + CELSIUS_TO_K;

    // The model puts the charge between the two anchors. Outside them, by more than filter lag can
    // explain, this is not the quantity this file thinks it is.
    const lo = Math.min(tan, tmot) - CHARGE_TEMP_SLACK_K;
    const hi = Math.max(tan, tmot) + CHARGE_TEMP_SLACK_K;
    if (tanM < lo || tanM > hi) return undefined;

    const gap = tmot - tan;
    if (Math.abs(gap) < MIN_COOLANT_INTAKE_GAP_K) return undefined;

    // How much of the coolant-to-intake gap the flow has removed. Recovered from the readings
    // rather than recomputed from `k_tanm_load_gain` and an estimated air mass, so it carries the
    // DME's own filtering and needs no constant from this file.
    const f = Math.min(1, Math.max(0, (tmot - tanM) / gap));

    // What tan_m would have been at the reference intake temperature, same coolant, same flow.
    const tanMRef = tanM - f * (tan - refK);
    if (!(tanMRef > 0)) return undefined;

    const factor = (tanM / tanMRef) * interpAxis(curves.tan.x, curves.tan.values, intakeTemp);
    return Number.isFinite(factor) ? factor : undefined;
}

/** What the app shows about a normalisation: what it did, over how much, and how big it was. */
export interface ChargeTempInfo {
    applied: boolean;
    reference: RfPtKorrReference | null;
    /** Samples that produced a factor, out of those the filter kept. */
    usable: number;
    total: number;
    /** Median factor over the usable samples. 1.0 means this drive needed no restating. */
    medianFactor?: number;
    /** Spread, as the 5th and 95th percentiles — a run where every cell gets the same factor has
     *  had its LEVEL moved and its SHAPE left alone, which is worth being able to see. */
    p05?: number;
    p95?: number;
    /** Set when any sample reported a substituted ambient pressure. The run cannot be normalised. */
    pressureSubstituted: boolean;
    /**
     * How many samples carrying an `rf` channel could have their rf_korr measured — i.e. had the air
     * data the measurement needs — out of how many carried `rf` at all.
     *
     * Zero means the whole log fell back to the lambda trim alone. That is the RIGHT answer for a
     * log recorded before the ambient channel existed, and it must be visible: the difference
     * between "trim only" and "trim x rf_korr" is up to 13 % of the map, and it used to happen
     * silently in the wrong direction.
     */
    rfKorrMeasured: number;
    rfKorrCandidates: number;
}

/** Summarise what normalising a log would do, without doing it. */
export function summariseChargeTemp(
    points: readonly LogDataPoint[], curves: RfPtKorrCurves | null, applied: boolean,
): ChargeTempInfo {
    const factors: number[] = [];
    let substituted = false;
    for (const p of points) {
        if (p.ambientPressureSubstituted) substituted = true;
        const f = chargeTempFactor(p, curves);
        if (f !== undefined) factors.push(f);
    }
    factors.sort((a, b) => a - b);
    const at = (q: number) => factors[Math.min(factors.length - 1, Math.floor(q * factors.length))];
    return {
        applied,
        reference: curves ? referenceOf(curves) : null,
        usable: factors.length,
        total: points.length,
        medianFactor: factors.length ? at(0.5) : undefined,
        p05: factors.length ? at(0.05) : undefined,
        p95: factors.length ? at(0.95) : undefined,
        pressureSubstituted: substituted,
        // Filled in by the caller, which is the only place that has the annotated log. Zero here
        // rather than optional, so a caller that forgets shows "0 of 0" instead of nothing.
        rfKorrMeasured: 0,
        rfKorrCandidates: 0,
    };
}

/**
 * `RF_PT_KORR` for one logged sample, or undefined when the sample cannot say.
 *
 * This is what `annotateRfKorrPoint` divides the measured `rf_korr` by. Undefined is a refusal, and
 * the caller must treat it as "this sample has no usable rf_korr" rather than substituting 1: a
 * factor of 1 is the OLD behaviour, and the old behaviour is what wrote the measurement day's air
 * into the table.
 *
 * `assumedPressureMbar` exists for logs recorded before the ambient channel did — the temperature
 * is in them and the pressure is not, and the pressure is the half that matters (it moved 11.4 %
 * between this car's two roads, against 3.2 % for a realistic seasonal intake swing). It is a
 * setting the operator supplies from the altitude they drove at, and it is deliberately NOT
 * defaulted: a wrong assumed pressure is the same failure as no correction at all, and silently
 * guessing one would hide it.
 *
 * A substituted ambient reading is refused outright. The DME re-learns its substitute from the
 * manifold sensor at key-on, so it is a plausible number that is not a measurement.
 */
export function rfPtKorrFor(
    point: Pick<LogDataPoint, 'intakeTemp' | 'ambientPressure' | 'ambientPressureSubstituted'>,
    curves: RfPtKorrCurves | null,
    assumedPressureMbar?: number,
): number | undefined {
    if (!curves) return undefined;
    if (point.ambientPressureSubstituted) return undefined;
    const t = point.intakeTemp;
    if (t === undefined || !Number.isFinite(t)) return undefined;
    const p = point.ambientPressure ?? assumedPressureMbar;
    if (p === undefined || !Number.isFinite(p)) return undefined;
    // The DME's own plausibility band for this channel. Outside it the curve clamps flat, which
    // would silently apply the end point to a garbled reading.
    if (!(p >= 400 && p <= 1150)) return undefined;
    return rfPtKorr(curves, t, p);
}

/** How much of a log could have its rf_korr measured honestly. */
export interface RfKorrAirCoverage {
    /** Samples whose measured rf_korr was divided by a real RF_PT_KORR. */
    corrected: number;
    /** Samples carrying an `rf` channel at all — the ones that could have had an rf_korr. */
    candidates: number;
    /** True when a pressure was supplied by the operator rather than logged. */
    assumedPressure?: number;
}
