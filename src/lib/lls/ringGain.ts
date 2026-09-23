import { axisBracket, interpAxis } from '@/lib/log-engine/axisBracket';
import { interp2d, type IdleMap2d } from '@/lib/idle/idleTables';
import { decodeParam } from '@/lib/calibration/decode';
import type { IndexedCatalog } from '@/lib/calibration/catalog';

/**
 * The idle-valve ring: how much `RF` the DME's own model hands back for the air it asked for.
 *
 * ## Why this exists
 *
 * At small pedal the throttle is pinned at 0.0 % — `egas_compute_throttle_target` sends every
 * request below `ML_SOLL_MAX_LLS` to the idle valve — so the only live controller is `FR_REGLER`,
 * a pure integrator. And `RF` is not measured: `k_rf_cfg` = 0x12 makes `rf_calc` overwrite the
 * MAP-derived value with `kf_rf_soll`'s own output. The loop closes inside the model:
 *
 *     FR -> ML_SOLL_LLS -> KF_LLS_TV -> KL_AQ_ABS_LLS -> kl_aq_rel_rf_fakt -> kf_rf_soll -> RF -> FR
 *
 * None of those four maps was calibrated as a control gain. Their internal consistency IS the loop
 * gain, and on this car it is not 1: d ln RF / d ln ML measures 1.34 on the current tune and 1.79
 * on the stock-ish one. Asking for 1 % more air returns 1.79 % more modelled filling, so the
 * integrator overshoots every time around, the crossover Ki*e*RF climbs, and against the measured
 * 0.58 s loop delay the phase margin thins until a 0.3 Hz disturbance — steering load on the PAS
 * pump — is amplified rather than absorbed.
 *
 * ## Why this is the lever, and not the integrator
 *
 * The obvious fix is to halve `KL_FR_IPOS` / `KL_FR_INEG`. It was tried and withdrawn: a slower
 * integrator still carries a loop gain of 1.34, so the overshoot merely arrives later. Flattening
 * the ring is the structural answer; the integrator gain is symptomatic.
 *
 * Of the four maps only `KF_LLS_TV` is free. `KL_AQ_ABS_LLS` is the valve's physical flow area and
 * must match the hardware; `kf_rf_soll` is fuelling. So `KF_LLS_TV` is rebuilt as the inverse of
 * the three downstream maps, which is what `solveLlsTv` does.
 *
 * ## What this module will not do
 *
 * It reads `kf_rf_soll` and never writes it. The two are only valid as a matched pair, so a VE
 * autotune invalidates whatever `solveLlsTv` produced — that staleness is a lineage question for
 * the mode surface, not something to paper over here by rewriting both.
 *
 * Every value is the XDF display value. Raw counts appear in exactly one place, noted below.
 *
 * Derivation and the hand-worked cell: `docs/low_load_surge.md` 9.8-9.11 in the notes repo.
 * `verify:lls-ring` pins the numbers against that document on every run.
 */

/** The four maps and three constants the ring is made of, as XDF display values. */
export interface RingTables {
    /** `KF_LLS_TV` — x rpm (10), y ml_ll kg/h (13), duty %. Stored as x/50, so 0.02 % a step. */
    llsTv: IdleMap2d;
    /** `kf_rf_soll` — x rpm (20), y aq_rel_rf % (24), value RF on 0-1. */
    rfSoll: IdleMap2d;
    /**
     * `KL_AQ_ABS_LLS` — valve flow area mm².
     *
     * Its axis is NOT duty %: it is duty x 50, the same raw step `KF_LLS_TV` stores. 400..5000
     * spans 8..100 % duty. Handing it a percentage lands left of the first breakpoint and returns
     * 0 area, silently, for every cell. `aqAbsLlsAt` / `aqAbsLlsInv` are the only places that know.
     */
    aqAbsLls: { x: number[]; values: number[] };
    /** `kl_aq_rel_rf_fakt` — x rpm (12), the divisor taking AQ_REL to aq_rel_rf. */
    aqRelRfFakt: { x: number[]; values: number[] };
    /**
     * `KL_FR_INEG` — x is |FR_RF_DELTA|, value is the FR step per 10 ms tick.
     *
     * Read from the VALUE run at 0xDFEA. The catalog node is 0xDFDA, which is the x axis 16 bytes
     * earlier; reading that instead yields 0.005..0.13 and a Ki off by three orders of magnitude.
     */
    frINeg: { x: number[]; values: number[] };
    /** `K_AQ_ABS_MAX` — the area that is 100 % AQ_REL, mm². */
    kAqAbsMaxMm2: number;
    /** `K_LLS_TV_MIN` / `K_LLS_TV_MAX` — the rails a duty is clamped to, %. */
    llsTvMinPct: number;
    llsTvMaxPct: number;
}

export interface RingGainOptions {
    /**
     * Integrator gain, 1/s per unit RF error.
     *
     * `fr_calc` runs in `task_10ms`, so 100 steps/s, and `KL_FR_INEG`'s display value is already
     * the per-step change in FR. Ki = value x 100 / error at that point, which is a bell:
     * 5.33 at an error of 0.015, falling to 0.80 at 0.1. The small-error end is taken because
     * surge grows out of small amplitudes. Grade: code-confirmed rate, computed gain.
     */
    kiPerS: number;
    /**
     * One-way-round loop delay, s. Grade: measured, but from the first peak of one
     * duty x rpm cross-correlation at one operating point — it should move with rpm and load.
     */
    tdS: number;
    /**
     * `ml_ll` row held fixed, kg/h — the one row the solve does not rewrite, and the row that sets
     * the column's height through `k = RF_anchor / ML_anchor`.
     *
     * **The anchor is not a free choice, and it is not only a level.** It was tempting to say the
     * target `RF = k*ML` is elasticity 1 wherever it is pinned, so only the height moves. Measured,
     * that is false. The solve puts the WRITTEN rows on the line, but `KF_LLS_TV` interpolates duty
     * linearly while duty to `RF` is not linear, so between breakpoints the realised elasticity
     * depends on both which rows were solved and what `k` came out. Over 20-50 kg/h at 950 rpm:
     *
     *     mean |e - 1|     stock 0.466    anchor 30  0.202    anchor 20  0.285
     *
     * The notes are also inconsistent about the height: 9.9-10 grades the anchor arbitrary because
     * "the integrator absorbs it", while 9.9-4 states `omegaC = Ki*e*RF`. Steady state absorbs it;
     * phase margin does not. A higher column means a higher `RF` at every row. On Session 954:
     *
     *     anchor 30  ->  idle duty -1.00 pp,  margin 47.0 mean, 2.8 % of points under 30 deg
     *     anchor 20  ->  idle duty +-0.00 pp, margin 45.9 mean, 7.2 % of points under 30 deg
     *
     * So anchor 30 flattens the ring better and leaves a thinner tail, on both counts.
     *
     * 20 is the default anyway, chosen with those numbers in hand. It is the row this car idles on
     * — 18.15 kg/h puts 63 % of the DME's lookup weight there — so holding it means the idle point
     * does not move at all, IDLE keeps every cell it needs, and the two modes stop contending for
     * row 20 entirely. It is also the best-evidenced cell in the table, being the one IDLE has been
     * converging against measured behaviour. Both remaining options are a large improvement on
     * stock; this one buys an undisturbed idle with part of that improvement.
     */
    anchorMlKgH: number;
    /**
     * `ml_ll` rows the solver may rewrite — the ones the measured duty band reaches, minus the
     * anchor. Must not contain `anchorMlKgH`, and must not reach rows the drive never visited:
     * rows 11 and 15 sit below the measured band and the notes withdrew a draft that moved them.
     */
    writableMlKgH: readonly number[];
    /** rpm columns the solver rewrites. */
    rpmColumns: readonly number[];
}

export const RING_GAIN_DEFAULTS: RingGainOptions = {
    kiPerS: 5.33,
    tdS: 0.58,
    anchorMlKgH: 20,
    writableMlKgH: [25, 30, 40, 50],
    rpmColumns: [800, 950, 1400, 1700],
};

/**
 * The notes' own anchor, 9.8 and 9.9-6. Kept so the published table stays reproducible after the
 * default moved off it — `verify:lls-ring` solves with this to check the 16 cells 9.8 prints.
 */
export const NOTES_ANCHOR: Pick<RingGainOptions, 'anchorMlKgH' | 'writableMlKgH'> = {
    anchorMlKgH: 30,
    writableMlKgH: [20, 25, 40, 50],
};

// ---------------------------------------------------------------------------
// reading
// ---------------------------------------------------------------------------

/** Catalog name of the Alpha-N filling map. Bare `kf_rf_soll` is not a key, and `_ask` / `_kath` /
 *  `_tau_up` are different maps that a prefix match would happily pick up. */
const RF_SOLL = 'kf_rf_soll (CSL Alpha-N)';

function curve(cat: IndexedCatalog, buffer: ArrayBuffer, name: string): { x: number[]; values: number[] } | null {
    const def = cat.byName.get(name);
    if (!def) return null;
    const d = decodeParam(buffer, def);
    if (!d.value || !d.x || d.x.kind === 'labels') return null;
    const values = d.value.phys.map(v => (v === null ? NaN : v));
    if (values.some(v => !Number.isFinite(v))) return null;
    return { x: [...d.x.values], values };
}

function constant(cat: IndexedCatalog, buffer: ArrayBuffer, name: string): number | null {
    const def = cat.byName.get(name);
    if (!def) return null;
    const d = decodeParam(buffer, def);
    const v = d.value?.phys[0];
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function map2d(cat: IndexedCatalog, buffer: ArrayBuffer, name: string): IdleMap2d | null {
    const def = cat.byName.get(name);
    if (!def) return null;
    const d = decodeParam(buffer, def);
    if (!d.value || !d.x || !d.y || d.x.kind === 'labels' || d.y.kind === 'labels') return null;
    const x = [...d.x.values];
    const y = [...d.y.values];
    if (d.value.phys.length !== x.length * y.length) return null;
    const values: number[][] = [];
    for (let r = 0; r < y.length; r++) {
        const row: number[] = [];
        for (let c = 0; c < x.length; c++) {
            const v = d.value.phys[r * x.length + c];
            if (v === null || !Number.isFinite(v)) return null;
            row.push(v);
        }
        values.push(row);
    }
    return { x, y, values };
}

/**
 * The ring's six tables out of one image. `null` if any of them is missing or has a hole in it —
 * a ring with a gap in it cannot be solved, and a partial answer here would be written to a car.
 *
 * `KF_LLS_TV` deliberately comes through the catalog rather than `readIdleTables`, so that all six
 * tables carry the same provenance and one address table governs the lot.
 */
export function readRingTables(buffer: ArrayBuffer, cat: IndexedCatalog): RingTables | null {
    const llsTv = map2d(cat, buffer, 'KF_LLS_TV');
    const rfSoll = map2d(cat, buffer, RF_SOLL);
    const aqAbsLls = curve(cat, buffer, 'KL_AQ_ABS_LLS');
    const aqRelRfFakt = curve(cat, buffer, 'kl_aq_rel_rf_fakt');
    const frINeg = curve(cat, buffer, 'KL_FR_INEG');
    const kAqAbsMaxMm2 = constant(cat, buffer, 'K_AQ_ABS_MAX');
    const llsTvMinPct = constant(cat, buffer, 'K_LLS_TV_MIN');
    const llsTvMaxPct = constant(cat, buffer, 'K_LLS_TV_MAX');
    if (!llsTv || !rfSoll || !aqAbsLls || !aqRelRfFakt || !frINeg) return null;
    if (kAqAbsMaxMm2 === null || llsTvMinPct === null || llsTvMaxPct === null) return null;
    return { llsTv, rfSoll, aqAbsLls, aqRelRfFakt, frINeg, kAqAbsMaxMm2, llsTvMinPct, llsTvMaxPct };
}

/**
 * Ki at a given RF error, 1/s. The step is per 10 ms tick, hence x 100.
 *
 * Returns null at an error of 0 — the curve's own value there is 0, and 0/0 is not a gain.
 */
export function kiAt(t: RingTables, rfError: number): number | null {
    if (!Number.isFinite(rfError) || rfError <= 0) return null;
    const step = interpAxis(t.frINeg.x, t.frINeg.values, rfError);
    if (!Number.isFinite(step)) return null;
    return (step * 100) / rfError;
}

// ---------------------------------------------------------------------------
// the four maps, forward and back
// ---------------------------------------------------------------------------

/** Valve area for a duty, mm². The x50 is the raw-count axis noted on `aqAbsLls`. */
export function aqAbsLlsAt(t: RingTables, dutyPct: number): number {
    return interpAxis(t.aqAbsLls.x, t.aqAbsLls.values, dutyPct * 50);
}

/**
 * Duty for an area, % — `KL_AQ_ABS_LLS` inverted by linear back-interpolation.
 *
 * Flat outside, matching `interpAxis`: an area below the first breakpoint or above the last has no
 * duty that produces it, and the nearest end is the only honest answer.
 */
export function aqAbsLlsInv(t: RingTables, areaMm2: number): number | null {
    if (!Number.isFinite(areaMm2)) return null;
    const { x, values: v } = t.aqAbsLls;
    const last = v.length - 1;
    if (areaMm2 <= v[0]) return x[0] / 50;
    if (areaMm2 >= v[last]) return x[last] / 50;
    for (let i = 0; i < last; i++) {
        const lo = v[i];
        const hi = v[i + 1];
        if (areaMm2 >= lo && areaMm2 <= hi) {
            const span = hi - lo;
            if (span === 0) return x[i] / 50;
            return (x[i] + ((x[i + 1] - x[i]) * (areaMm2 - lo)) / span) / 50;
        }
    }
    return x[last] / 50;
}

/** aq_rel_rf % from a duty at an rpm — the middle two links of the ring. */
export function aqRelRfAt(t: RingTables, rpm: number, dutyPct: number): number {
    const area = aqAbsLlsAt(t, dutyPct);
    const q = (area / t.kAqAbsMaxMm2) * 100;
    return q / interpAxis(t.aqRelRfFakt.x, t.aqRelRfFakt.values, rpm);
}

/** `kf_rf_soll` at an rpm and an aq_rel_rf, bilinear, flat outside both axes. */
export function rfSollAt(t: RingTables, rpm: number, aqRelRfPct: number): number {
    return interp2d(t.rfSoll, rpm, aqRelRfPct);
}

/**
 * aq_rel_rf that produces a target RF at an rpm — `kf_rf_soll` inverted along its y axis.
 *
 * The column is scanned for the first breakpoint interval that brackets the target and bisected
 * inside it. Scanning rather than bisecting the whole axis is deliberate: the map is not guaranteed
 * monotone (single non-monotone cells exist in the low rows), and a global bisection on a
 * non-monotone column converges to whichever root it stumbles into. Taking the first crossing from
 * the bottom is at least a stated rule.
 *
 * Clamped flat at both ends, so an RF below the map's floor returns the lowest axis point.
 */
export function rfSollInv(t: RingTables, rpm: number, rfTarget: number, iterations = 60): number | null {
    if (!Number.isFinite(rpm) || !Number.isFinite(rfTarget)) return null;
    const ys = t.rfSoll.y;
    const last = ys.length - 1;
    const at = (y: number) => rfSollAt(t, rpm, y);
    if (rfTarget <= at(ys[0])) return ys[0];
    if (rfTarget >= at(ys[last])) return ys[last];
    for (let i = 0; i < last; i++) {
        let lo = ys[i];
        let hi = ys[i + 1];
        const fLo = at(lo);
        const fHi = at(hi);
        if ((fLo - rfTarget) * (fHi - rfTarget) > 0) continue;
        for (let k = 0; k < iterations; k++) {
            const mid = (lo + hi) / 2;
            if ((at(lo) - rfTarget) * (at(mid) - rfTarget) <= 0) hi = mid;
            else lo = mid;
        }
        return (lo + hi) / 2;
    }
    return null;
}

// ---------------------------------------------------------------------------
// the ring
// ---------------------------------------------------------------------------

/** One trip round: RF = G(ML), the composition of the four maps. Notes 9.9-1. */
export function ringRf(t: RingTables, rpm: number, mlKgH: number): number | null {
    if (!Number.isFinite(rpm) || !Number.isFinite(mlKgH)) return null;
    const duty = interp2d(t.llsTv, rpm, mlKgH);
    if (!Number.isFinite(duty)) return null;
    const rf = rfSollAt(t, rpm, aqRelRfAt(t, rpm, duty));
    return Number.isFinite(rf) ? rf : null;
}

/**
 * Ring elasticity e = d ln RF / d ln ML, dimensionless. Notes 9.9-2.
 *
 * 1.00 is a self-consistent model: 1 % more air asked for, 1 % more filling modelled back. The
 * central difference uses h = 0.01*ML because the step has to stay inside one `KF_LLS_TV` cell to
 * measure that cell's slope rather than an average over a breakpoint.
 */
export function ringElasticity(t: RingTables, rpm: number, mlKgH: number): number | null {
    if (!Number.isFinite(mlKgH) || mlKgH <= 0) return null;
    const h = 0.01 * mlKgH;
    const up = ringRf(t, rpm, mlKgH + h);
    const dn = ringRf(t, rpm, mlKgH - h);
    if (up === null || dn === null || up <= 0 || dn <= 0) return null;
    const e = (Math.log(up) - Math.log(dn)) / (Math.log(mlKgH + h) - Math.log(mlKgH - h));
    return Number.isFinite(e) ? e : null;
}

export interface PhaseMargin {
    /** Crossover frequency, rad/s. */
    omegaC: number;
    pmDeg: number;
    /** Damping ratio, from the PM/100 rule of thumb. */
    zeta: number;
    /** Resonant amplification 1/(2*zeta) — what a disturbance at the ring's own frequency is
     *  multiplied by. Above 1 the loop amplifies rather than absorbs. */
    q: number;
}

/**
 * Where the loop stands: an integrator plus a delay, so L(s) = (Ki*e*RF/s) * exp(-s*Td).
 * Notes 9.9-4.
 *
 * omegaC is proportional to RF as well as to e, which is why flattening the elasticity alone
 * still leaves less margin at high filling — and why the first reading of this, "elasticity > 1
 * means overshoot", was wrong. One discrete step is Ki*T*e*RF ~ 0.019, nowhere near the stability
 * limit. What is thin is the phase margin.
 *
 * Pass `measuredRf` to use a logged RF instead of the ring's own — the replay over a recorded
 * session does that, so the margin is evaluated where the car actually was.
 */
export function phaseMargin(
    t: RingTables,
    rpm: number,
    mlKgH: number,
    opts: { tdS?: number; kiPerS?: number; measuredRf?: number } = {},
): PhaseMargin | null {
    const tdS = opts.tdS ?? RING_GAIN_DEFAULTS.tdS;
    const kiPerS = opts.kiPerS ?? RING_GAIN_DEFAULTS.kiPerS;
    const e = ringElasticity(t, rpm, mlKgH);
    if (e === null) return null;
    const rf = opts.measuredRf ?? ringRf(t, rpm, mlKgH);
    if (rf === null || !Number.isFinite(rf)) return null;
    const omegaC = kiPerS * e * rf;
    const pmDeg = 90 - omegaC * tdS * (180 / Math.PI);
    const zeta = pmDeg / 100;
    return { omegaC, pmDeg, zeta, q: zeta === 0 ? Infinity : 1 / (2 * zeta) };
}

export interface LlsTvEdit {
    rpm: number;
    mlKgH: number;
    beforePct: number;
    afterPct: number;
}

/**
 * `KF_LLS_TV` rebuilt so that RF is proportional to ML — elasticity 1 — at the rows the car
 * was measured in. Notes 9.9-5.
 *
 * Per rpm column: the anchor row's duty is held, which fixes k = RF_anchor / ML_anchor, and every
 * other writable row is solved for RF = k*ML through the three downstream maps inverted. Holding
 * an anchor means only the column's height is free, and height is what the integrator absorbs
 * anyway; the shape is the part that sets the loop gain.
 *
 * The target is proportional and not logarithmic. omegaC also scales with RF, so holding
 * e*RF constant — RF = C*ln(ML) + D — is the theoretically right curve, and it was tried:
 * the low rows collide with `kf_rf_soll`'s 0.05 floor and the 14 % duty rail, two rows flatten onto
 * the same duty at 1700 rpm, and the margin comes out worse than proportional (43 deg against 49).
 * The map's resolution makes the correct target unreachable.
 *
 * Returned duties are exact. `KF_LLS_TV` stores x/50, so a writer has to quantise to 0.02 % —
 * which is the writer's job, not this function's.
 */
export function solveLlsTv(t: RingTables, opts: Partial<RingGainOptions> = {}): LlsTvEdit[] {
    const o = { ...RING_GAIN_DEFAULTS, ...opts };
    const anchorRow = t.llsTv.y.indexOf(o.anchorMlKgH);
    if (anchorRow < 0) return [];
    const edits: LlsTvEdit[] = [];
    for (const rpm of o.rpmColumns) {
        const col = t.llsTv.x.indexOf(rpm);
        if (col < 0) continue;
        const anchorDuty = t.llsTv.values[anchorRow][col];
        const rfAnchor = rfSollAt(t, rpm, aqRelRfAt(t, rpm, anchorDuty));
        if (!Number.isFinite(rfAnchor) || o.anchorMlKgH <= 0) continue;
        const k = rfAnchor / o.anchorMlKgH;
        for (const ml of o.writableMlKgH) {
            const row = t.llsTv.y.indexOf(ml);
            if (row < 0 || row === anchorRow) continue;
            const y = rfSollInv(t, rpm, k * ml);
            if (y === null) continue;
            const q = y * interpAxis(t.aqRelRfFakt.x, t.aqRelRfFakt.values, rpm);
            const duty = aqAbsLlsInv(t, (q / 100) * t.kAqAbsMaxMm2);
            if (duty === null) continue;
            edits.push({
                rpm,
                mlKgH: ml,
                beforePct: t.llsTv.values[row][col],
                afterPct: Math.min(t.llsTvMaxPct, Math.max(t.llsTvMinPct, duty)),
            });
        }
    }
    return edits;
}

/** One raw count of `KF_LLS_TV`, which stores x/50. A change smaller than this cannot be written. */
export const LLS_TV_STEP_PCT = 0.02;

export interface RingDrift {
    /** Cells a fresh solve would still move, out of the ones it is allowed to write. */
    staleCells: number;
    consideredCells: number;
    /** The largest move it would make, %. */
    worstPct: number;
    /** Nothing left to do: the table already IS the solve of itself. */
    converged: boolean;
}

/**
 * Whether `KF_LLS_TV` is still the solution to the maps beside it — asked by solving again.
 *
 * ## Why this is the test, rather than a threshold on elasticity
 *
 * `kf_rf_soll` is an INPUT to this solve, so writing a VE map invalidates whatever `KF_LLS_TV`
 * held: the two are only valid as a matched pair (notes 9.9-11), and the app used to write both
 * without either knowing the other existed. The question "has that happened" has an exact answer
 * that needs no constant — run the solve and see whether it would change anything.
 *
 * Elasticity was the obvious alternative and it needs a threshold nobody can defend. Measured over
 * the reference band on four real images it runs 0.14 to 0.37, with an uncorrected community patch
 * at 0.22 sitting between two corrected tables — so any line drawn through it would be arbitrary
 * and would misclassify a real image.
 *
 * ## It closes by itself, exactly once
 *
 * Measured: on the image this car is running, a fresh solve moves 16 of 16 cells, worst 3.72 %.
 * Solve once and the next three solves move NOTHING — the solve is a fixed point in one step. So
 * the notice appears while there is a difference and disappears when it is written, which is the
 * whole contract for a derived warning rather than a flag somebody has to clear.
 *
 * Comparison is on the STORAGE grid, not on the float: a difference smaller than one raw count
 * cannot be written, so reporting it would be asking for a flash that changes no bytes.
 */
export function ringDrift(t: RingTables, opts: Partial<RingGainOptions> = {}): RingDrift {
    const edits = solveLlsTv(t, opts);
    const grid = (v: number) => Math.round(v / LLS_TV_STEP_PCT) * LLS_TV_STEP_PCT;
    let stale = 0;
    let worst = 0;
    for (const e of edits) {
        if (grid(e.afterPct) === grid(e.beforePct)) continue;
        stale++;
        worst = Math.max(worst, Math.abs(e.afterPct - e.beforePct));
    }
    return {
        staleCells: stale,
        consideredCells: edits.length,
        worstPct: worst,
        converged: edits.length > 0 && stale === 0,
    };
}

/**
 * ML the car was at, back-calculated from a logged AQ_REL. Notes 9.9-7.
 *
 * The session carries no duty channel — `Idle Valve Status` is a status byte — so the duty comes
 * from `relativer Oeffnungsquerschnitt` through `KL_AQ_ABS_LLS` inverted, and ML from
 * `KF_LLS_TV` inverted along the column. This is what decides which rows the solver may touch.
 */
export function mlFromAqRel(t: RingTables, rpm: number, aqRelPct: number): number | null {
    if (!Number.isFinite(rpm) || !Number.isFinite(aqRelPct)) return null;
    const duty = aqAbsLlsInv(t, (aqRelPct / 100) * t.kAqAbsMaxMm2);
    if (duty === null) return null;
    const ys = t.llsTv.y;
    const last = ys.length - 1;
    const at = (ml: number) => interp2d(t.llsTv, rpm, ml);
    if (duty <= at(ys[0])) return ys[0];
    if (duty >= at(ys[last])) return ys[last];
    for (let i = 0; i < last; i++) {
        let lo = ys[i];
        let hi = ys[i + 1];
        if ((at(lo) - duty) * (at(hi) - duty) > 0) continue;
        for (let k = 0; k < 60; k++) {
            const mid = (lo + hi) / 2;
            if ((at(lo) - duty) * (at(mid) - duty) <= 0) hi = mid;
            else lo = mid;
        }
        return (lo + hi) / 2;
    }
    return null;
}

/** Duty the car was at, %, from a logged AQ_REL. The measured band is read off this. */
export function dutyFromAqRel(t: RingTables, aqRelPct: number): number | null {
    if (!Number.isFinite(aqRelPct)) return null;
    return aqAbsLlsInv(t, (aqRelPct / 100) * t.kAqAbsMaxMm2);
}

/** `KF_LLS_TV` with a solved edit list applied — for replaying a session against the new map
 *  without touching the caller's tables. */
export function withEdits(t: RingTables, edits: readonly LlsTvEdit[]): RingTables {
    const values = t.llsTv.values.map(row => [...row]);
    for (const e of edits) {
        const r = t.llsTv.y.indexOf(e.mlKgH);
        const c = t.llsTv.x.indexOf(e.rpm);
        if (r >= 0 && c >= 0) values[r][c] = e.afterPct;
    }
    return { ...t, llsTv: { x: [...t.llsTv.x], y: [...t.llsTv.y], values } };
}

export { axisBracket };
