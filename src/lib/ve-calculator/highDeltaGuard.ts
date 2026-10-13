import type { LogDataPoint } from '@/lib/types';
// `import type` for the interface, as in rfKorrTuner.ts: Node's type stripping cannot tell a
// type-only named import from a value one, so a harness that loads this module directly would fail.
import type { EgtTables } from './egtTables';
import {
    isRfKorrFloorHeld, rfKorrActive, rfKorrAt, tabgModelAt, withStockRfKorrFloor,
} from './egtTables';
import {
    lambdaPJumpAt, REVERSAL_FRACTION, TRIM_CLAMP_FALLBACK, TRIM_RESET_JUMP,
} from './rampState';
import { STOP_TOLERANCE } from '@/lib/log-engine/lambdaGates';
import { RF_TRUNCATION_MEAN_PERCENT } from './calculator';

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
 * A K HOLD drive. There the DME applies K = 1.000 everywhere, so nothing ever ramps: the trim at any
 * moment says whether the VE alone — the VE the tuner anchors on — fed the engine enough. For each
 * sample this asks what Δ the DME WOULD have computed with BMW's gate:
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
 * At every sample the stock gate would have entered at (`rfKorrActive` on the stock floor) with
 * Δ* >= 300 and the loop running, it asks whether either bank was LEAN-LOCKED:
 *
 *     on the upper clamp, or
 *     risen >= P+ + LEAN_LOCK_MARGIN above the trough with no rich switch in between
 *         (a rich switch: a fall of REVERSAL_FRACTION x P- below the running maximum), or
 *     sitting at >= 1 + P+ + LEAN_LOCK_MARGIN
 *
 * A two-point P+I loop that can reach λ = 1 switches within one P jump plus the I ramp over the
 * sensor's dead time: P+ 0.020 and I+ ~0.050/s over 0.15-0.3 s is a 0.028-0.035 rise. Rising 0.02
 * beyond P+ means the mixture stayed lean for at least 0.4 s more than that — the engine needed fuel
 * the hold withheld, i.e. some of BMW's enrichment at that Δ is real. The third line is the same
 * fact after the climb is over: the VE this guard vouches for is converged (the tuner's anchor), so a
 * cycle around λ = 1 peaks near 1 + P+; a trim that has climbed past 1.04 and cycles THERE was lean
 * before Δ* reached 300 and still is. Measured on the synthetic, an 8 % lean hold reads 5 locked
 * samples of 41 on the climb alone, 38 of 41 with the level. The plan sizes what one of these 1-2 s
 * moments can say at ±2-3 %, which is why the margin is 0.02 and the answer is a direction, not a
 * number.
 *
 * ## The verdict
 *
 *     ok = samples >= HIGH_DELTA_GUARD_MIN_SAMPLES && leanLocked === 0
 *
 * Zero tolerance on the lock because the cost is asymmetric: a refused fill leaves the rows at
 * stock, the rich side; a wrong fill leans the mixture at the coldest exhaust and highest load the
 * table covers. One bank is enough for the same reason: DRREL is one table for both, so a shrink
 * that one bank needed the enrichment for leans that bank by it, however the other one fared. Δ* >= 300 vouches for the rows below 300 as well — the true density effect only
 * grows with Δ, so a VE that was not lean at 300 is not lean at 200 either.
 */

/** What the tuner is given, and what a K HOLD session persists. */
export interface HighDeltaGuard {
    /** Samples at Δ* >= `HIGH_DELTA_GUARD_DELTA_MIN` where the stock gate would have entered and
     *  the lambda loop was running. */
    samples: number;
    /** Of those, the ones where at least one present bank was lean-locked. */
    leanLocked: number;
    /** Enough samples, none of them lean-locked: the rows may follow the shrink. */
    ok: boolean;
}

/** The Δ* the guard is about — the 300 row, the lowest one post-ramp samples never reached. */
export const HIGH_DELTA_GUARD_DELTA_MIN = 300;

/**
 * Samples a guard needs before its "no lean lock" may mean anything.
 *
 * The VE profile logs at ~3 Hz, so ten samples is >= 3 s spent at Δ* >= 300: two or more of the 1-2 s
 * moments the plan describes, each long enough for a lock to show — LEAN_LOCK_MARGIN past P+ takes
 * 0.4 s at I+ 0.050/s, and a restart ramp from 1.000 needs the whole 0.04, 0.8 s. Fewer than that and
 * a drive that never held one of those moments would read as a clean bill.
 */
export const HIGH_DELTA_GUARD_MIN_SAMPLES = 10;

/** How far past P+ a lean phase must rise with no rich switch — or a trim sit above 1.000 — to
 *  count as a lock. See the header. */
export const LEAN_LOCK_MARGIN = 0.02;

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

/** One bank's lean phase: the trough it started from and the highest it has reached since. */
interface BankWatch { lo: number; hi: number; prev: number | undefined }

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
    const banks: BankWatch[] = [0, 1].map(() => ({ lo: 1, hi: 1, prev: undefined }));
    let samples = 0, leanLocked = 0;

    for (const p of log) {
        const trims = [p.stft1, p.stft2];
        const present = trims.filter((v): v is number => v !== undefined);
        // Loop off: the integrator is held at exactly 1.000, so the trim says nothing about the
        // mixture — and under the hold, full load runs open-loop on BMW's VL enrichment and lands
        // here. A restart then begins its own lean or rich phase from 1.000.
        const loopOff = present.length > 0 && present.every(v => v === 1);
        const rf = (p.rf ?? 0) / 100;
        const { pos, neg } = lambdaPJumpAt(pJumps, p.rpm, rf);

        const locked = trims.map((v, i) => {
            const b = banks[i];
            if (v === undefined) {
                // A gap in the bank: what the integrator did across it is unknown, so the next
                // reading starts a phase rather than inheriting one.
                b.prev = undefined;
                return false;
            }
            const reset = loopOff || b.prev === undefined || Math.abs(v - b.prev) > TRIM_RESET_JUMP;
            b.prev = v;
            if (reset || v <= b.hi - REVERSAL_FRACTION * neg) {
                // A rich switch, or still descending in a rich phase: the next lean phase starts here.
                b.lo = v; b.hi = v;
            } else {
                if (v > b.hi) b.hi = v;
                if (v < b.lo) b.lo = v;
            }
            return v >= fMax - STOP_TOLERANCE
                || v - b.lo >= pos + LEAN_LOCK_MARGIN
                || v >= 1 + pos + LEAN_LOCK_MARGIN;
        });

        if (loopOff || present.length === 0) continue;
        if (p.rf === undefined || p.exhaustTemp === undefined) continue;
        const rfSoll = (p.rf + RF_TRUNCATION_MEAN_PERCENT) / 100;
        if (!rfKorrActive(stock, p.rpm, rfSoll, p.vehicleSpeed)) continue;
        if (counterfactualRfKorr(egt, p.rpm, rfSoll, p.exhaustTemp).delta < HIGH_DELTA_GUARD_DELTA_MIN) continue;

        samples++;
        if (trims.some((v, i) => v !== undefined && locked[i])) leanLocked++;
    }

    return {
        samples, leanLocked,
        ok: samples >= HIGH_DELTA_GUARD_MIN_SAMPLES && leanLocked === 0,
    };
}
