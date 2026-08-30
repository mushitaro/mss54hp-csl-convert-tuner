/**
 * `KF_LLS_TV` as the DME reads it, and the gate that proves the map on the car.
 *
 * ## Why this map and not the other one
 *
 * The feature was built to correct `KF_LLR_QVS_GRUND`, and that map is sealed because its output
 * chain has no reader in this calibration. The live chain, recovered from `lls_tv_calc`
 * (master `0x025D0A`), runs the other way:
 *
 *     _ML_SOLL_DPR ─┬─ min(., ML_SOLL_MAX_LLS) ─→ ML_SOLL_LLS ─┐
 *                   │                                          ├→ KF_LLS_TV(n, ml_ll) → LLS_TV → valve
 *                   └─ max(0, . - ML_SOLL_MAX_LLS) ─→ ML_SOLL_WDK ─→ throttle plate
 *
 * So the air the idle valve is asked for is the torque path's own demand, split at a ceiling, and
 * the only calibration between that demand and the valve is `KF_LLS_TV` — x = rpm, y = `ml_ll`
 * kg/h, z = duty %. That is the map to correct, and its axes are not the ones the estimator was
 * written for.
 *
 * ## The gain comes out of the map, not out of a new constant
 *
 * The governor's standing error is torque, and torque at idle is air, so the shortfall in kg/h is
 * `g_air * error` with the same physics-bounded `g_air` the old target used. Turning kg/h into duty
 * is then the map's OWN slope along y:
 *
 *     dTV/dml   at 800 rpm, 11->15 kg/h:  (23.0 - 14.0) / 4  =  2.25 %/(kg/h)
 *               at 800 rpm, 15->20 kg/h:  (33.6 - 23.0) / 5  =  2.12 %/(kg/h)
 *
 * Two adjacent rows agreeing to 6 % is what makes a local slope usable. No constant is invented:
 * the combined gain is `slope * g_air`, about 0.90 %/Nm at the idle cell, and it is still learned
 * across passes the same way.
 *
 * ## The gate
 *
 * `modelAgreement` interpolates this map at the sample's own (rpm, ml_ll) and compares it with the
 * duty the DME actually ran. On a settled warm dwell those must match, and every way they can fail
 * is a way this feature could be wrong:
 *
 *   - the KATH blend is contributing (`AVAN1_SOLL_FAKTOR` non-zero) — cat heating is not over, and
 *     the measured duty carries a second map. That channel is NOT logged, so this is how it is
 *     detected rather than assumed away.
 *   - the map was decoded at the wrong address or scaling
 *   - `ML_SOLL_LLS` is not what indexes it after all, which would refute the chain above
 *   - the run is on a calibration where `cfg_m.egas` is 1, so `LLR_QSOLL` drives the valve instead
 *
 * The old model gate compared RAM `LLR_QVS` against `KF_LLR_QVS_GRUND` and could prove only that a
 * dead map was being evaluated. This one compares the map that will be WRITTEN against the duty the
 * valve was GIVEN, which is the whole claim.
 */

import { interp2d, type IdleMap2d } from './idleTables';

/** Bracket `v` in an ascending axis, for the slope below. The LOOKUP is `interp2d`'s — this is only
 *  used to find which interval the operating point sits in, which the lookup does not report. */
function bracket(axis: readonly number[], v: number): { i: number; j: number; f: number } {
    if (!axis.length) return { i: 0, j: 0, f: 0 };
    if (v <= axis[0]) return { i: 0, j: 0, f: 0 };
    const last = axis.length - 1;
    if (v >= axis[last]) return { i: last, j: last, f: 0 };
    let i = 0;
    while (i < last && axis[i + 1] <= v) i++;
    const span = axis[i + 1] - axis[i];
    return { i, j: i + 1, f: span > 0 ? (v - axis[i]) / span : 0 };
}

/** The map at (rpm, ml) — the shared lookup, named for this map so call sites read as intent. */
export function llsTvAt(map: IdleMap2d, rpm: number, ml: number): number {
    return interp2d(map, rpm, ml);
}

/**
 * How much duty one more kg/h buys here, %/(kg/h) — the map's own slope along its y axis.
 *
 * Taken across the bracketing rows rather than differentiated, because the map IS piecewise linear
 * between breakpoints: the bracket's slope is not an approximation of the DME's behaviour, it is
 * the DME's behaviour. At the top row it falls back to the last real interval, since a request
 * above the last breakpoint is clamped and has no slope of its own.
 */
export function llsTvSlopePctPerKgH(map: IdleMap2d, rpm: number, ml: number): number | null {
    if (map.y.length < 2) return null;
    const cy = bracket(map.y, ml);
    const [a, b] = cy.i === cy.j
        ? (cy.i === 0 ? [0, 1] : [map.y.length - 2, map.y.length - 1])
        : [cy.i, cy.j];
    const dml = map.y[b] - map.y[a];
    if (!(dml > 0)) return null;
    const cx = bracket(map.x, rpm);
    const at = (row: number) => {
        const v0 = map.values[row]?.[cx.i];
        const v1 = map.values[row]?.[cx.j] ?? v0;
        return v0 === undefined ? NaN : v0 + (v1 - v0) * cx.f;
    };
    const slope = (at(b) - at(a)) / dml;
    return Number.isFinite(slope) ? slope : null;
}

export interface ModelAgreement {
    /** What the map says the duty should be at this operating point, %. */
    expected: number;
    /** What the DME actually ran, %. */
    measured: number;
    /** measured - expected, %. Signed: positive means the valve was given MORE than the map alone
     *  asks for, which is what a live KATH blend looks like. */
    delta: number;
    agrees: boolean;
}

/**
 * Does the duty the valve got match the map we intend to write?
 *
 * `tolerancePct` is generous on purpose. Between the map and the pin sit a PT1 filter
 * (`K_LLS_TAU2`, converged over a 20 s dwell), a battery-voltage correction
 * (`(TV - K_LLS_TV_DREHPUNKT) * KL_LLS_UB_KORR(UB) >> 8`, which is zero at nominal voltage) and the
 * `K_LLS_TV_MIN/MAX` clamps. None of those is modelled here, so the gate is asking "is this the
 * right map at all", not "is this the exact byte" — a disagreement of a per-cent is the voltage
 * term, and a disagreement of ten is a different map.
 */
export function modelAgreement(
    map: IdleMap2d,
    rpm: number | null,
    ml: number | null,
    measuredDutyPct: number | null,
    tolerancePct: number,
): ModelAgreement | null {
    if (rpm === null || ml === null || measuredDutyPct === null) return null;
    const expected = llsTvAt(map, rpm, ml);
    if (!Number.isFinite(expected)) return null;
    const delta = measuredDutyPct - expected;
    return { expected, measured: measuredDutyPct, delta, agrees: Math.abs(delta) <= tolerancePct };
}
