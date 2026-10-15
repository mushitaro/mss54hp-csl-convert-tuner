import type { LogDataPoint } from '@/lib/types';
// `import type` for the interface, as in rfKorrTuner.ts: Node's type stripping cannot tell a
// type-only named import from a value one, so a harness that loads this module directly would fail.
import type { EgtTables } from './egtTables';
import {
    isRfKorrFloorHeld, rfKorrActive, rfKorrAt, tabgModelAt, withStockRfKorrFloor,
} from './egtTables';
import {
    HALF_CYCLE_MAX_SEC, lambdaCyclingFlags, lambdaPJumpAt, REVERSAL_FRACTION, TRIM_CLAMP_FALLBACK,
    TRIM_RESET_JUMP,
} from './rampState';
import { STOP_TOLERANCE } from '@/lib/log-engine/lambdaGates';
import { timeScaleSeconds } from '@/lib/log-engine/filter';
import { RF_TRUNCATION_MEAN_PERCENT } from './calculator';
import { trimOf } from './rfKorrTuner';
import { APP_CONFIG } from '@/config/constants';

/**
 * May the 300/400 rows of KF_RF_KORR_DRREL follow the shrink of the highest measured row?
 *
 * ## Why the rows need a guard at all
 *
 * The tuner (rfKorrTuner.ts) writes `D = rf_korr x trim` from samples the lambda loop has finished
 * taking a K step back on, and those samples stop at about Δ 200. On #964-#970 — every one driven
 * with WOT TH armed — the highest post-ramp Δ was 289 and not one reached 300; the gate-open maximum
 * was 387 and 400 never occurred. High Δ comes at gate entry from part load, and TABG rises and takes
 * it below 290 within seconds, before the trim has taken K back (median 4.1 s). So the 300/400 rows
 * are never measured, and the tuner fills them from the row below by a ratio. That is an
 * extrapolation in the lean direction, and this is the evidence that licenses it.
 *
 * ## What it reads
 *
 * A K HOLD drive. There the DME applies K = 1.000 everywhere, so there is no K step to take back:
 * where the VE is right the trim cycles around its centre, and a trim that climbs past it says the
 * VE alone — the VE the tuner anchors on — did not feed the engine enough. For each sample this asks
 * what Δ the DME WOULD have computed with BMW's gate:
 *
 *     rf_soll = (RF + RF_TRUNCATION_MEAN_PERCENT) / 100          RF = rf_soll under the hold
 *     K*      = KF_RF_KORR_DRREL(N, max(0, kf_rf_tabg_modell(N, rf_soll · K*) − TABG))
 *     Δ*      = max(0, kf_rf_tabg_modell(N, rf_soll · K*) − TABG)
 *
 * K* is the DME's own pass-by-pass iteration run to its end (`counterfactualRfKorr`): each
 * background pass reads the model at the FINAL RF of the pass before, starting from the 1.000 it
 * releases to. The tables are the as-run binary's, with only the floor put back to stock
 * (`withStockRfKorrFloor`), because the floor is the one thing K HOLD changed.
 *
 * ## Only where the drive shows the VE converged
 *
 *     cell      nearest AXIS_RPM node x 5 %RF bin of rf_soll                          (`guardCell`)
 *     pass 1    over the cell's loop-on, limit-cycling (`lambdaCyclingFlags`) samples at
 *               Δ* < HIGH_DELTA_GUARD_BASELINE_DELTA_MAX:
 *                   converged(cell) = n >= GUARD_CONVERGED_MIN_SAMPLES and
 *                                     |median trim - 1| <= GUARD_CONVERGED_TOLERANCE
 *                   ref_b(cell)     = median STFT of bank b there — the centre its cycle runs about
 *     history   per bank, every cell the operating point was in from HALF_CYCLE_MAX_SEC before the
 *               bank's last trough until now, and none before the bank's last reset
 *     pass 2    a sample at Δ* >= 300 is COUNTED only if its own cell and every present bank's
 *               history cells are converged; else `skippedUnconverged`
 *
 * No K step is not no ramp. Drive from a cell whose VE is off into one whose VE is right and the
 * trim WALKS from the first cell's error to the second's at the I slope, ~0.04/s — and a walk up out
 * of a rich neighbour is, sample for sample, the lean phase this guard looks for. #971 was a K HOLD
 * drive taken before the VE had converged: judged without this section it counted 44 samples at
 * Δ* >= 300 and called 5 lean-locked, and all 5 were such walks, carrying a neighbouring cell's trim
 * (at 1366 s the trim was rising while Δ* FELL, which no density effect does). So a sample is judged
 * only where the same drive shows the VE right, and so is everywhere its trim came from.
 *
 * `trim` is the VE write's own (`trimOf`), so "converged" means what the tuner's anchor check means.
 * The history is the cells whose mixture set the level the trim stands at: the last trough's, which
 * the cycling before it set — one half-cycle, at most HALF_CYCLE_MAX_SEC, and the sensor's dead time
 * (0.1-0.5 s) carries a cell's mixture into the next — and every cell since. A RESET ends it: a loop
 * restart puts the integrator at exactly 1.000 whatever the cells before were, so after an overrun
 * cut or the VL's open loop the trim's level is the restart's and only the cells since count. That
 * is the commonest way into Δ* >= 300 — re-entry after a lift, the exhaust still cold — and it is
 * where a lock most needs counting. Resets are the trackers' signatures: loop off (every present
 * bank exactly 1.000), both banks bit-identical, a one-sample move over TRIM_RESET_JUMP, a missing
 * reading.
 *
 * On #971 this counts none of the 44 and skips them all — the cells they fall in (2200-3100 rpm,
 * rf_soll 65-80 %) were never shown converged — and on #974, the second K HOLD drive, none of 21.
 * The answer is "not ok" as before and the rows stay stock as before, but for the reason that is
 * true: neither drive showed the VE right where the guard reads, so neither can say.
 *
 * ## The lock
 *
 * At every counted sample — the stock gate would have entered (`rfKorrActive` on the stock floor),
 * Δ* >= 300, the loop running — it asks whether either bank was LEAN-LOCKED:
 *
 *     STFT_b >= fMax - STOP_TOLERANCE                                    on the upper clamp, or
 *     STFT_b >= max(ref_b(c) : c = the cell or a history cell) + P+ + LEAN_LOCK_MARGIN
 *
 * A two-point P+I loop about a fixed centre peaks about P+ above it: the lean switch jumps P+ from a
 * trough I-·Td below the centre and the I ramp climbs I+·Td more before the sensor sees rich, so the
 * peak is P+ + (I+ - I-)·Td ≈ P+ + 0.005 over the centre. A trim LEAN_LOCK_MARGIN beyond that stayed
 * lean for 0.8 s longer than the cycle does — the engine needed fuel the hold withheld, i.e. some of
 * BMW's enrichment at that Δ is real. Against the highest converged centre in the history because a
 * walk between two converged cells ends at the higher one's: the up to 0.04 two converged medians
 * may differ by is the VE error the convergence test allows, not a density effect.
 *
 * The margin is what the same drives show where nothing should lock: their loop-on samples at
 * Δ* < 200 and >= 1500 rpm whose cell and history are converged (#971 / #974, 6752 bank-samples).
 * There the excess over that reference + P+ is 0.025 at p99 and 0.042 at p99.9; the limit-cycling
 * ones among them peak at 0.038, and the ten bank-samples past 0.04 are four lean walks of bank 1 at
 * RF 11-31 %. A lean need under ~4 % therefore cannot be told from a cycle's peak in a 5 %RF cell
 * within a 1-2 s moment, and the answer is a direction, not a number.
 *
 * Not the rise from the trough, which the rule once read: a normal lean phase rises P+ + I+·Td, and
 * the P-jump counters on #967/#968/#970 imply a dead time of 0.4-0.5 s, so the cycle's own rise is
 * 0.040-0.045 — P+ + 0.02 above the trough read 10.4 % of those same converged samples as locked,
 * and a trough taken in one converged cell read against the peak of another.
 *
 * ## The verdict
 *
 *     ok = samples >= HIGH_DELTA_GUARD_MIN_SAMPLES && leanLocked === 0        samples: COUNTED ones
 *
 * Zero tolerance on the lock because the cost is asymmetric: a refused fill leaves the rows at
 * stock, the rich side; a wrong fill leans the mixture at the coldest exhaust and highest load the
 * table covers. One bank is enough for the same reason: DRREL is one table for both, so a shrink
 * that one bank needed the enrichment for leans that bank by it, however the other one fared. Δ* >= 300
 * vouches for the rows below 300 as well — the true density effect only grows with Δ, so a VE that
 * was not lean at 300 is not lean at 200 either. Skipped samples count for nothing either way: a
 * drive whose high-Δ moments all fell in cells it never showed converged has said nothing, and is
 * not ok — converge the VE there under K HOLD first, then drive the guard again.
 */

/** What the tuner is given, and what a K HOLD session persists. */
export interface HighDeltaGuard {
    /** Samples at Δ* >= `HIGH_DELTA_GUARD_DELTA_MIN` where the stock gate would have entered, the
     *  lambda loop was running, and the drive showed the VE converged in the sample's cell and in
     *  every present bank's history cells. */
    samples: number;
    /** Of those, the ones where at least one present bank was lean-locked. */
    leanLocked: number;
    /**
     * Samples that met everything `samples` asks except convergence: the cell, or a cell a bank's
     * trim took its level from, had too few cycling baseline samples or a median trim off 1. Not
     * judged — a rise there may be the walk from one cell's VE error to the next.
     *
     * Optional because a guard stored before this rule has none, and the tuner refuses such a guard
     * (`RfKorrTuneOptions.highDeltaGuard`). `computeHighDeltaGuard` always sets it.
     */
    skippedUnconverged?: number;
    /** Enough counted samples, none of them lean-locked: the rows may follow the shrink. */
    ok: boolean;
}

/** The Δ* the guard is about — the 300 row, the lowest one post-ramp samples never reached. */
export const HIGH_DELTA_GUARD_DELTA_MIN = 300;

/**
 * Below this Δ* a sample may vouch for its cell's VE.
 *
 * 200 is the top row the tuner measures — post-ramp samples stop about there — so the baseline is
 * the population the 300/400 fill extrapolates FROM, and the test at >= 300 is the step the fill
 * spans. Let the baseline reach toward 300 and the density effect the guard is looking for goes into
 * the "converged" median: a cell that is lean at high Δ would be called right because it was lean.
 */
export const HIGH_DELTA_GUARD_BASELINE_DELTA_MAX = 200;

/**
 * Baseline samples a cell needs before its median may call it converged.
 *
 * The limit cycle swings the trim ±0.02-0.03 about its centre in half-cycles of 0.5-1.5 s; at the
 * VE profile's sample every 0.18 s (median) a half-cycle is three to eight samples, five at the
 * median. Six cycling samples therefore usually span both sides of the centre, and put the median
 * within ~0.01 of it — half the tolerance. Three could be one rich half-cycle, reading 0.98 on a
 * cell that is right.
 */
export const GUARD_CONVERGED_MIN_SAMPLES = 6;

/** How far a cell's baseline median trim may sit from 1 and still be converged. The tuner's own
 *  anchor tolerance (`anchorTrimTolerance`). Two converged cells can therefore differ by 0.04, which
 *  is why the lock is read against the highest converged centre the trim came through. */
export const GUARD_CONVERGED_TOLERANCE = 0.02;

/** Width of a guard cell along rf_soll, %RF. See `guardCell`. */
export const GUARD_CELL_RF_BIN = 5;

/**
 * Samples a guard needs before its "no lean lock" may mean anything.
 *
 * The VE profile logs ~4 samples a second (#971 / #974: 3.9), so ten samples is ~2.5 s spent at
 * Δ* >= 300: at least one of the 1-2 s moments the plan describes, long enough for a lock to show —
 * at I+ 0.050/s a lean phase stands centre + P+ + LEAN_LOCK_MARGIN high ~1.2 s after its lean
 * switch, and a restart ramp from 1.000 gets there as soon. Fewer than that and a drive that never
 * held one of those moments would read as a clean bill. Counted samples only: a skipped one is not
 * a moment that was held.
 */
export const HIGH_DELTA_GUARD_MIN_SAMPLES = 10;

/** How far past a converged cycle's centre + P+ a trim must stand to count as a lock. See the
 *  header: the converged drives' own p99.9 is 0.042, and nothing that cycles reached it. */
export const LEAN_LOCK_MARGIN = 0.04;

/** The DME's iteration is a contraction (dDRREL/dΔ x dModel/dRF x rf_soll ~ 0.0011 x 490 x 0.7 =
 *  0.38 in the band), so it settles in a handful of passes; the cap is for a pathological table. */
const FIXED_POINT_MAX_PASSES = 50;
const FIXED_POINT_TOLERANCE = 1e-9;

/**
 * The rf_korr the DME would settle on at this operating point with its gate open, and the Δ it
 * would have read the table at — the fixed point of its own pass-by-pass update, started from the
 * 1.000 it enters with. `rfSoll` is a fraction (1.0 = 100 % filling); `tabg` is °C.
 */
export function counterfactualRfKorr(
    egt: EgtTables, rpm: number, rfSoll: number, tabg: number,
): { k: number; delta: number } {
    const deltaAt = (k: number) => Math.max(0, tabgModelAt(egt, rpm, rfSoll * k) - tabg);
    let k = 1;
    for (let i = 0; i < FIXED_POINT_MAX_PASSES; i++) {
        const next = rfKorrAt(egt, rpm, deltaAt(k));
        const done = Math.abs(next - k) < FIXED_POINT_TOLERANCE;
        k = next;
        if (done) break;
    }
    return { k, delta: deltaAt(k) };
}

/**
 * The operating-point cell a sample is judged in: the nearest VE rpm node (`AXIS_RPM`) x a 5 %RF bin
 * of rf_soll. rf_soll rather than the VE table's RO row because under the hold RF IS rf_soll, so
 * the cell needs nothing the drive did not log — no opening-to-RO table, no map. Undefined without
 * an RF reading.
 */
export function guardCell(rpm: number, rf: number | undefined): number | undefined {
    if (rf === undefined || !Number.isFinite(rf) || !Number.isFinite(rpm)) return undefined;
    const axis = APP_CONFIG.MSS54HP.AXIS_RPM;
    let n = 0;
    for (let i = 1; i < axis.length; i++) if (Math.abs(axis[i] - rpm) < Math.abs(axis[n] - rpm)) n = i;
    return Math.floor((rf + RF_TRUNCATION_MEAN_PERCENT) / GUARD_CELL_RF_BIN) * axis.length + n;
}

const median = (xs: number[]): number => {
    const s = [...xs].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Pass 1: the cells this drive shows converged, each with its banks' centres (`ref_b`, undefined for
 * a bank the baseline never read) — see the header. The cycle flags over the same raw log, on the
 * log's own time unit (`timeScaleSeconds`, the filters' answer), so the guard stays a function of
 * (log, egt) and nothing else.
 */
function convergedCells(log: LogDataPoint[], egt: EgtTables): Map<number, (number | undefined)[]> {
    const cycling = lambdaCyclingFlags(log, egt.lambda, timeScaleSeconds(log));
    const base = new Map<number, { trim: number[]; stft: number[][] }>();
    for (let i = 0; i < log.length; i++) {
        const p = log[i];
        if (!cycling[i] || p.rf === undefined || p.exhaustTemp === undefined) continue;
        const trim = trimOf(p);
        const cell = guardCell(p.rpm, p.rf);
        if (trim === undefined || !(trim > 0) || cell === undefined) continue;
        const rfSoll = (p.rf + RF_TRUNCATION_MEAN_PERCENT) / 100;
        if (counterfactualRfKorr(egt, p.rpm, rfSoll, p.exhaustTemp).delta >= HIGH_DELTA_GUARD_BASELINE_DELTA_MAX) continue;
        let e = base.get(cell);
        if (!e) base.set(cell, e = { trim: [], stft: [[], []] });
        e.trim.push(trim);
        [p.stft1, p.stft2].forEach((v, b) => { if (v !== undefined) e.stft[b].push(v); });
    }
    const out = new Map<number, (number | undefined)[]>();
    for (const [cell, e] of base) {
        if (e.trim.length < GUARD_CONVERGED_MIN_SAMPLES) continue;
        if (Math.abs(median(e.trim) - 1) > GUARD_CONVERGED_TOLERANCE) continue;
        out.set(cell, e.stft.map(s => (s.length ? median(s) : undefined)));
    }
    return out;
}

/**
 * One bank's phase: the trough it last fell to, the highest it has reached since, its last reset,
 * and its history — every cell the operating point was in from `HALF_CYCLE_MAX_SEC` before that
 * trough until now, none from before the reset.
 */
interface BankWatch {
    lo: number; hi: number; prev: number | undefined;
    resetT: number;
    cells: Set<number | undefined>;
}

/**
 * The guard over one K HOLD drive, or null when the drive was not held.
 *
 * `log` must be the RAW log in time order (`processed.rawData`): the trim history is a state the
 * integrator carried through every sample the filters later dropped, exactly as the latch and the
 * ramp tracker need it. `egt` must be the EFFECTIVE tables — `VECalculator.resolveKHold`'s — so a
 * hold that did not take, whose trims WERE ramping, comes back null rather than as a verdict.
 */
export function computeHighDeltaGuard(log: LogDataPoint[], egt: EgtTables): HighDeltaGuard | null {
    if (!isRfKorrFloorHeld(egt)) return null;
    const stock = withStockRfKorrFloor(egt);
    const pJumps = egt.lambda?.pJumps ?? null;
    const fMax = egt.lambda?.fMax ?? TRIM_CLAMP_FALLBACK.max;
    const converged = convergedCells(log, egt);
    const banks: BankWatch[] = [0, 1].map(() => ({
        lo: 1, hi: 1, prev: undefined, resetT: -Infinity, cells: new Set(),
    }));
    let samples = 0, leanLocked = 0, skippedUnconverged = 0;
    // The loop-on operating point's cells over the last HALF_CYCLE_MAX_SEC, in seconds of the log's
    // own unit. Loop-off samples are not in it: no mixture was being cycled about there.
    const secondsPerUnit = timeScaleSeconds(log);
    const recent: { t: number; cell: number | undefined }[] = [];

    for (const p of log) {
        const trims = [p.stft1, p.stft2];
        const present = trims.filter((v): v is number => v !== undefined);
        // Loop off: the integrator is held at exactly 1.000, so the trim says nothing about the
        // mixture — and under the hold, full load runs open-loop on BMW's VL enrichment and lands
        // here. A restart then begins its own lean or rich phase from 1.000.
        const loopOff = present.length > 0 && present.every(v => v === 1);
        const identical = present.length === 2 && trims[0] === trims[1];
        const rf = (p.rf ?? 0) / 100;
        const { pos, neg } = lambdaPJumpAt(pJumps, p.rpm, rf);
        const cell = guardCell(p.rpm, p.rf);
        const t = p.time * secondsPerUnit;
        if (!loopOff) recent.push({ t, cell });
        while (recent.length && recent[0].t < t - HALF_CYCLE_MAX_SEC) recent.shift();

        trims.forEach((v, i) => {
            const b = banks[i];
            // From the trough's window, never from before the bank's reset.
            const sinceTrough = () => new Set(recent.filter(r => r.t > b.resetT).map(r => r.cell));
            if (v !== undefined && !loopOff && !identical && b.prev !== undefined
                && Math.abs(v - b.prev) <= TRIM_RESET_JUMP) {
                b.prev = v;
                if (v <= b.hi - REVERSAL_FRACTION * neg) {
                    // A rich switch, or still descending in a rich phase: the next lean phase starts here.
                    b.lo = v; b.hi = v; b.cells = sinceTrough();
                } else {
                    if (v > b.hi) b.hi = v;
                    if (v < b.lo) { b.lo = v; b.cells = sinceTrough(); } else b.cells.add(cell);
                }
                return;
            }
            // A reset — or a gap in the bank, after which what the integrator did is unknown: the
            // level is the restart's, and no cell before this sample set it.
            b.prev = v; b.resetT = t; b.cells = new Set();
            if (v !== undefined) { b.lo = v; b.hi = v; }
        });

        if (loopOff || present.length === 0) continue;
        if (p.rf === undefined || p.exhaustTemp === undefined) continue;
        const rfSoll = (p.rf + RF_TRUNCATION_MEAN_PERCENT) / 100;
        if (!rfKorrActive(stock, p.rpm, rfSoll, p.vehicleSpeed)) continue;
        if (counterfactualRfKorr(egt, p.rpm, rfSoll, p.exhaustTemp).delta < HIGH_DELTA_GUARD_DELTA_MIN) continue;

        // Each present bank's reference: the highest converged centre among this cell and its
        // history — undefined when any of them is not converged, or never read this bank.
        const refs = trims.map((v, i) => {
            if (v === undefined) return null;
            let ref = -Infinity;
            for (const c of [cell, ...banks[i].cells]) {
                const centre = c === undefined ? undefined : converged.get(c)?.[i];
                if (centre === undefined) return undefined;
                ref = Math.max(ref, centre);
            }
            return ref;
        });
        if (refs.some(r => r === undefined)) {
            skippedUnconverged++;
            continue;
        }
        samples++;
        const locked = trims.some((v, i) => {
            const ref = refs[i];
            if (v === undefined || ref === null || ref === undefined) return false;
            return v >= fMax - STOP_TOLERANCE || v >= ref + pos + LEAN_LOCK_MARGIN;
        });
        if (locked) leanLocked++;
    }

    return {
        samples, leanLocked, skippedUnconverged,
        ok: samples >= HIGH_DELTA_GUARD_MIN_SAMPLES && leanLocked === 0,
    };
}
