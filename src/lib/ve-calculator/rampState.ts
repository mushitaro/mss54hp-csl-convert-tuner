/**
 * Has the DME's lambda loop finished taking back the last step — in rf_korr, or the restart that
 * put its integrator back at 1.000?
 *
 * ## The mechanism this exists for
 *
 * The DME steps the fuel by `rf_korr` the moment its latch engages, and it re-evaluates
 * `KF_RF_KORR_DRREL(N, tabg_delta)` on every background pass while the gate stays open, so K moves
 * in steps of its own as TABG and N move. The lambda loop answers each step the only way a
 * switching P+I controller can: the mixture goes rich, the sensor says so, and the integrator
 * ramps down at `KF_LA_KI_NEG` — 13 raw at 2200-2700 rpm and RF >= 0.5, i.e. 0.0406 per second,
 * against a logged median of -0.040/s — until the mixture crosses lean again and the trim jumps
 * back up by `KF_LA_KP_POS`.
 *
 * Until that jump the trim is a CLOCK, not a measurement. Measured on #941-#970 in the RO 7.5-10 %
 * band: 98 % of samples gate-open, median K 1.17, median 2.67 s since the gate opened, 93 % still
 * before the first lean switch. There `trim x K = K (1 - 0.0406 t)`, whatever the VE error is, so
 * writing it moved the cells +5.5..8.4 % per pass with no fixed point; the 1-second settle that
 * preceded this file had no fixed point either. After the lean switch the loop is oscillating
 * around the trim that cancels K, and `trim x K` is the VE error again.
 *
 * So the question is not "how long since K moved" but "has the trim reversed since K moved",
 * and the trim itself says so.
 *
 * ## The rule
 *
 *   EVENT   - the gate opened or shut, or, while it is open, K has moved >= `K_STEP_MIN` from where
 *             it stood at the last event. Every present bank becomes pending.
 *   RESTART - the loop has been re-initialised, which puts the integrator back at 1.000 and starts
 *             the ramp from scratch. Recognised three ways, all the same physical fact:
 *               - every present bank reads exactly 1.000 (loop off: the integrator is held there);
 *               - both banks read bit-identical values (`uint16 x 2^-15`, so this is one code):
 *                 the two integrators restarted together and ramp at the same gains, and they stay
 *                 identical until one of them switches. Measured on #967/#968/#970: 444 such
 *                 samples off 1.000, 437 (98 %) with both P-jump counters still at 0;
 *               - a bank moved further in one sample than the controller can move it
 *               (`TRIM_RESET_JUMP`): one P jump is at most 53/2048 = 0.026 and the I ramp at most
 *                 ~0.05 per second, so a 0.27 leap from 0.73 to 1.003 is a reset whose 1.000
 *                 sample the log did not catch. Lift-off fuel cut does this on most gate exits.
 *             A restarted bank is pending and stays pending while the banks are still identical.
 *   SETTLED - the switch that ends the ramp the event started, which depends on which way K went:
 *               - K rose, or moved less than `K_DROP_MIN` down, and every restart: the trim has
 *                 risen `REVERSAL_FRACTION` x P+ above its running minimum since the event — the
 *                 lean-switch jump. P+ is `KF_LA_KP_POS(N, RF)` of the AS-RUN binary, 41 raw = 0.020
 *                 in the band; 0.020 when the table cannot be read.
 *               - K fell by `K_DROP_MIN` or more — inside the gate, or the gate shutting on it: the
 *                 trim has fallen `REVERSAL_FRACTION` x P- below its running MAXIMUM since the event
 *                 — the rich-switch jump. P- is `KF_LA_KP_NEG`, 20 raw = 0.0098; 0.0098 without it.
 *             A trim at the controller's clamp (0.70 / 1.30) is never settled — it is reporting a
 *             bound, and the mixture there is whatever the clamp leaves it.
 *   kRamp   - any present bank pending, or pinned. Both banks settled is the only "not a ramp".
 *
 * ## Why a fall in K waits for the other switch
 *
 * A drop runs the recovery the other way up. The mixture goes LEAN, the loop answers with the P+
 * jump at once and then climbs at `KF_LA_KI_POS` (~0.05/s) until it crosses rich, so until the
 * rich switch `trim x K` sits below the VE error by the part of the drop not yet climbed back. A
 * rise test fires on the first sample of that climb — the P+ jump is the drop's own doing — and
 * wrote the climb as a lean VE error. In verify:k-ramp's continuous-time loop (VE correct) a
 * gate-open drop 1.25 -> 1.08 wrote 5-7 samples per event at a mean `trim x K` of 0.94,
 * the worst 0.88; 1.16 -> 1.08 wrote 1-3 at 0.97-0.98. That is the drop the DME makes on re-entry
 * from the hold band: K froze there, and DRREL is re-read at a TABG that has climbed meanwhile —
 * the RO 7.5-10 % band, where rf_soll sits on the floor. Lean, at the load this tool exists to
 * get right, is the side that costs, so the drop waits for the switch that actually ends it.
 *
 * `K_DROP_MIN` is twice the event step because K read as RF / rf_soll is noisy at a step and the
 * sign of a small change is often wrong (see below); a drop of 0.04 or less is taken back by the
 * one P+ jump it causes, so the rise test reads it correctly anyway.
 *
 * ## Measured against the DME's own P-jump counters
 *
 * Sessions #967/#968/#970 logged `LA_P_SPR_COUNT` per bank alongside the trim. Taking a bank as
 * truly settled from the first counter increment after the event at which its trim rose (the
 * counter is read ~0.1 s after the trim, so the rise may land one sample later), and a counter reset
 * as the restart, over every gate-open raw sample:
 *
 *     plan rule (restart on exactly 1.000 only)     settled precision 0.85  recall 0.61
 *     + identical banks + one-sample reset jump     settled precision 0.92  recall 0.61
 *
 * (VE-stream samples only: 0.84 / 0.62 -> 0.94 / 0.62.) Small numbers — 38 truly settled samples
 * among 416 gate-open, because those drives were pulls that rarely reached a lean switch — so read
 * them as a direction, not a rate. The two extra restart signatures are what
 * lifts precision, at no cost in recall: each missed reset was read as a lean switch, because the
 * jump back to 1.000 is a rise above the running minimum, and the restart ramp after it then
 * reached the map as "settled" at `trim ~ 1 x K` — the +K write this file exists to stop.
 * `REVERSAL_FRACTION` and `K_STEP_MIN` stay at the plan's 0.8 and 0.02: other values trade one
 * number for the other (0.5: 0.88 / 0.74; 1.0: 1.00 / 0.47) rather than improving both.
 *
 * The direction rule for a K DECREASE is scored against the same truth, and the truth cannot
 * referee it: it calls a bank settled at the first counter increment after the event, and after a
 * drop that increment is the drop's own P+ jump — the very sample the rule must not credit. Applied
 * to every decrease, whatever its size, it scored 0.83 / 0.53, because the sign of a small K change
 * is often wrong and a wrong sign waits for the wrong switch; that is what `K_DROP_MIN` is for. The
 * synthetic loop is the referee for the drop, and the reason the rule is shipped. With the arming
 * step it leaves the 0.92 / 0.61 above unchanged on these three drives; replayed over #964-#970 it
 * moved one session, #966, whose band lost six climb samples (7.5 % / 2400: -4.0 -> -3.5 %,
 * 7.5 % / 2700: -7.4 -> -5.7 %).
 *
 * ## Walk the RAW log
 *
 * For the reason `RfKorrLatch` does: the integrator kept running on samples this app later
 * dropped, and a restart is most often a fuel-cut sample — exactly what the VE filter removes.
 *
 * ## A restart is a clock with the gate shut too
 *
 *     excluded from the VE write  <=>  kRamp !== false          (`isLambdaRampExcluded`)
 *
 * whatever the gate says. This file was written for the K step, and the write used to skip only
 * gate-open samples; but the restart ramp is the same clock without K in it. After a lift-off fuel
 * cut, or BA / loop-off, the integrator is put back at exactly 1.000 and walks down at
 * `KF_LA_KI_NEG` (~0.04/s) for as long as the map is rich, so until the lean switch the trim reads
 * `1 - 0.04 t`: the seconds since fuelling resumed, not the cell. Under K HOLD the gate never opens,
 * a restart is the only event there is, and the band was written from it.
 *
 * Measured on the two stage-1 K HOLD drives — #971 on map M0, #974 on M1, which is #971's TUNED
 * and 3.7-7.9 % leaner than M0 in every band cell (RO 7.5 / 10 x 2200-2900 rpm). Bank samples the
 * tracker calls ramps, among the VE samples that reach a band cell, binned by time since the
 * restart (the last sample at exactly 1.000, or the reset jump):
 *
 *     since restart     <= 0.6 s   0.6-1.2   1.2-2    2-3     3-5
 *     #971  (M0)         0.992     0.974    0.949   0.914   0.895
 *     #974  (M1)         0.996     0.976    0.946   0.912   0.887
 *
 * Two maps 6 % apart give the same trim at the same second, so the trim is the clock. And it is
 * most of the band: 39 % of #971's band samples and 70 % of #974's were such ramps, 74 % / 91 %
 * of them within 3 s of a fuel cut, and 10 of #971's 187 (1 of #974's 100) more than 5 s after any
 * restart signature. DIRECT averaging them asks the band for ~-6 % on every pass whatever the map
 * is — M0 -> M1 moved the band cells -3.7..-7.9 %, M1 -> its own TUNED another 0..-7.6 % — while
 * the limit-cycle midpoints put M1 within about ±3 % there. That is the ratchet this file was
 * written to stop, arriving by the other door.
 *
 * So the predicate no longer reads the gate. It needs every sample the walk covered to carry a
 * defined `kRamp`, gate open or shut, which is what `annotateRfKorr` and the live walk now attach;
 * undefined is left meaning only "the walk never saw this sample", and that still counts as a ramp.
 *
 * ## Why a load rise is not an event
 *
 * An entry from cruise also falls on its way in — and it was measured before deciding against it.
 * An entry here is a rise of >= X %RF within <= Y s with no restart signature or fuel cut in the
 * 5 s before it and the banks apart for 2 s (#967/#968/#970/#971 on M0, #974 on M1):
 *
 *   - The map cannot be told from the clock. Where M0 and M1 differ — the band — #974 has ONE such
 *     entry at X/Y = 5/1, 10/2 or 15/2. Everywhere else the two maps sit < 1 % apart, so over the
 *     30-47 cells both drives entered, the slope of `ln(trim_M1 / trim_M0)` on `ln(VE_M0 / VE_M1)`
 *     (1 = the trim is the VE error, 0 = a clock) comes out -0.03 ± 0.26 (5/1, 2.5-6 s after) and
 *     0.06 ± 0.44 (10/2): either answer fits.
 *   - The DME's own transient fuel is too short to make one. `baFTi` (acceleration enrichment,
 *     logged on #967/#968/#970) is at most 1.11 and lasts 1-2 samples, a median 0.61-0.68 s; after
 *     the entries above it is above 1.0005 on 16 % of samples in the first 0.35 s, 2 % at 0.35-0.7 s
 *     and ~1 % after. A multi-second fall is not that.
 *   - Without an event the loop is walking from the last cell's error to this one's, and that heads
 *     where the write should end: DIRECT converging both cells removes it (`lambdaCyclingFlags`). A
 *     restart heads to `1 - 0.04 t` from 1.000 whatever the cell is, and nothing removes that.
 *   - In the band the samples such an event would hold are not one-sided: still pending since the
 *     entry they read 0.939 / 0.959 / 0.944 against 0.955 / 0.938 / 0.939 after the reversal
 *     (X/Y 5/1, 10/2, 15/2). The cost is not small: at 10/2, 103-244 VE samples a drive.
 *
 * The visit gate (calculator.ts, `VE_MIN_VISITS` and `VE_MIN_EFFECTIVE_VISITS`) is what answers the
 * one-episode cell instead: three visits, worth at least two equal ones by weight.
 *
 * ## Why the exclusion ends at the first switch, and not seconds later
 *
 * The kept samples nearest a restart do not ask for more cut than later ones. #971's post-ramp VE
 * samples, stated against M1 (`trim x VE_M0 / VE_M1`) and binned by seconds since the restart
 * signature, read at RO 6-8.75 % x 2150-3000 rpm +0.6 / -0.1 / +0.4 / -4.8 / -4.8 % at 0-3 / 3-5 /
 * 5-8 / 8-12 / 12-20 s (44 / 34 / 39 / 28 / 13 samples), and at RO 3-6 % +1.8 / +1.3 / +1.2 /
 * -1.8 %: the early samples ask for no more cut than the late ones, so excluding them longer would
 * not move the write toward the map. #974's band is too thin to say (33 post-ramp samples in
 * RO 6-12.5 %), and 10 of its 15 at RO 8.75-12.5 % are one stretch, 770-772 s, reading -9.7 %. That
 * stretch is what the cross-drive slope of `ln(demand_974 / demand_971)` on `ln(M0 / M1)` sees
 * (1 = the trim follows the map, 0 = a clock): 0.28 ± 0.16 over 13 cells with it, 0.80 ± 0.11 over
 * 12 with the eight seconds 765-773 s left out — one episode, not a clock.
 */

// Not `interpMap2d` from egtTables: that module reads these tables (`readEgtTables`), and importing
// back from it would make the two a cycle. `interpGrid` is the same clamped bilinear lookup.
import { STOP_TOLERANCE, interpGrid } from '@/lib/log-engine/lambdaGates';

/** `KF_LA_KP_POS` / `KF_LA_KP_NEG` — the lambda controller's P jumps, as trim fractions. Same axes
 *  convention as the DME: `pos[rfIndex][rpmIndex]`, rf as a fraction (1.0 = 100 % filling). */
export interface LambdaPJumps {
    rpm: number[];
    rf: number[];
    /** Upward jump, at a lean switch. */
    pos: number[][];
    /** Downward jump, at a rich switch — what ends the recovery after K falls. */
    neg: number[][];
}

/** What the ramp rule needs of the lambda controller, out of the as-run binary. */
export interface LambdaRampParams {
    pJumps: LambdaPJumps | null;
    /** `K_LA_FMIN` / `K_LA_FMAX`, the integrator's clamps. */
    fMin: number;
    fMax: number;
}

/** P jumps in the 2200-2700 rpm / RF >= 0.5 band of the 0401 calibration: 41 and 20 raw / 2048.
 *  Used when the binary's tables cannot be read. */
export const LAMBDA_P_JUMP_FALLBACK = { pos: 0.020, neg: 0.0098 } as const;

/** The integrator's clamps on the 0401 calibration, used when the binary cannot be read. */
export const TRIM_CLAMP_FALLBACK = { min: 0.70, max: 1.30 } as const;

/** How far K must move, while the gate is open, to count as a new step. Below this the loop absorbs
 *  the change inside one cycle of its own oscillation. */
export const K_STEP_MIN = 0.02;

/** How far K must FALL at an event for the bank to wait for a rich switch rather than a lean one.
 *  Twice the event step: below it the sign is unreliable and the one P+ jump takes the drop back. */
export const K_DROP_MIN = 2 * K_STEP_MIN;

/** The lean switch, as a fraction of the P jump. Less than 1 because the ramp before the jump and
 *  the ramp after it land in the same ~0.3 s sample and partly cancel. */
export const REVERSAL_FRACTION = 0.8;

/**
 * A one-sample trim move larger than this is a controller reset, not a controller move.
 *
 * The largest P jump in the 0401 tables is 53/2048 = 0.026 and the fastest I ramp ~0.05 per second,
 * so even a 1 Hz log cannot show a legitimate move above ~0.08. A gap in the log longer than that
 * also lands here, which is the safe reading of a gap: the state is unknown.
 */
export const TRIM_RESET_JUMP = 0.10;

/**
 * Addresses of the two P-jump tables in the 64 KB partial (slave calibration, XDF addresses), each
 * 6 rpm x u16, 6 rf x u16 (x/1000), then 6 x 6 u8 (x/2048 = x*16/32768).
 *
 * Read on the 0401 base: POS 41 / NEG 20 raw at 2500 rpm, RF 0.5-1.0 — the numbers the band's
 * logged jumps measure. The integrator clamps are `LAMBDA_SHUTDOWN.F_MIN/F_MAX`.
 */
const KP_POS = { x: 0x4926, y: 0x4932, z: 0x493E } as const;
const KP_NEG = { x: 0x4964, y: 0x4970, z: 0x497C } as const;
const F_MAX = 0x481A;
const F_MIN = 0x481C;

/**
 * The lambda controller's ramp parameters out of an as-run binary, or null.
 *
 * All-or-nothing like `readEgtTables`, for the same reason: a half-read set states a calibration
 * this binary may not have. Null falls back to `LAMBDA_P_JUMP_FALLBACK` / `TRIM_CLAMP_FALLBACK`.
 */
export function readLambdaRampParams(buffer: ArrayBuffer): LambdaRampParams | null {
    try {
        const v = new DataView(buffer);
        const u16s = (a: number, n: number) => Array.from({ length: n }, (_, i) => v.getUint16(a + 2 * i, false));
        const grid = (a: number) => Array.from({ length: 6 }, (_, r) =>
            Array.from({ length: 6 }, (_, c) => v.getUint8(a + r * 6 + c) / 2048));
        const ascending = (a: number[]) => a.every((x, i) => i === 0 || x > a[i - 1]);
        const posX = u16s(KP_POS.x, 6), posY = u16s(KP_POS.y, 6).map(q => q / 1000);
        const negX = u16s(KP_NEG.x, 6), negY = u16s(KP_NEG.y, 6).map(q => q / 1000);
        const fMax = v.getUint16(F_MAX, false) / 32768;
        const fMin = v.getUint16(F_MIN, false) / 32768;
        // The two tables share their axes in every image this app has seen. Requiring it is the
        // cheapest proof these are the bytes this code thinks they are.
        if (!ascending(posX) || !ascending(posY) || posX.some((x, i) => x !== negX[i])
            || posY.some((y, i) => y !== negY[i])) return null;
        const pos = grid(KP_POS.z), neg = grid(KP_NEG.z);
        // A P jump of zero or above 0.1 is not a calibration; nor is a clamp the wrong way round.
        if (![...pos.flat(), ...neg.flat()].every(p => p > 0 && p <= 0.1)) return null;
        if (!(fMin > 0.5 && fMin < 1 && fMax > 1 && fMax < 1.5)) return null;
        return { pJumps: { rpm: posX, rf: posY, pos, neg }, fMin, fMax };
    } catch {
        return null;
    }
}

/** P+ / P- at this operating point — the DME's clamped bilinear lookup on (N, RF). */
export function lambdaPJumpAt(
    t: LambdaPJumps | null | undefined, rpm: number, rfFraction: number,
): { pos: number; neg: number } {
    if (!t) return { ...LAMBDA_P_JUMP_FALLBACK };
    return {
        pos: interpGrid({ x: t.rpm, y: t.rf, z: t.pos }, rpm, rfFraction),
        neg: interpGrid({ x: t.rpm, y: t.rf, z: t.neg }, rpm, rfFraction),
    };
}

/** One raw sample, as the tracker needs it. `k` is the rf_korr the DME applied (1 while shut). */
export interface KRampSample {
    time: number;
    rpm: number;
    /** RF, %, the lookup's Y input. Absent reads as 0, the table's lowest row. */
    rf?: number;
    stft1?: number;
    stft2?: number;
    gateOpen: boolean;
    k: number;
}

interface BankState {
    pending: boolean;
    /** The bank is waiting for its first switch since a restart. */
    restart: boolean;
    /** Running minimum of the trim since the event. */
    lo: number;
    /** Running maximum of the trim since the event. */
    hi: number;
    /** The event lowered K by `K_DROP_MIN` or more: the ramp ends at a rich switch, not a lean one. */
    awaitRich: boolean;
    prev: number | undefined;
}

/**
 * The rule above as a state machine. `step` must see every raw sample once, in time order — the
 * batch walk and the live run each hold one, which is what lets them agree.
 */
export class KRampTracker {
    private readonly pJumps: LambdaPJumps | null;
    private readonly fMin: number;
    private readonly fMax: number;
    private kRef = 1;
    private open: boolean | null = null;
    private readonly banks: BankState[] = [0, 1].map(() => ({
        pending: false, restart: false, lo: 1, hi: 1, awaitRich: false, prev: undefined,
    }));

    constructor(params?: LambdaRampParams | null) {
        this.pJumps = params?.pJumps ?? null;
        this.fMin = params?.fMin ?? TRIM_CLAMP_FALLBACK.min;
        this.fMax = params?.fMax ?? TRIM_CLAMP_FALLBACK.max;
    }

    /** Advance one sample and return whether the trim is still taking back a K step there. */
    step(s: KRampSample): boolean {
        const trims = [s.stft1, s.stft2];
        const present = trims.filter((v): v is number => v !== undefined);
        const { pos, neg } = lambdaPJumpAt(this.pJumps, s.rpm, (s.rf ?? 0) / 100);

        const allAtOne = present.length > 0 && present.every(v => v === 1);
        const identical = present.length === 2 && trims[0] === trims[1];
        const event = (this.open !== null && s.gateOpen !== this.open)
            || (s.gateOpen && Math.abs(s.k - this.kRef) >= K_STEP_MIN);
        // Against the K of the last event, before it moves: a gate exit reads K = 1 here, so an exit
        // from a stepped gate is a drop like any other.
        const drop = event && this.kRef - s.k >= K_DROP_MIN;
        if (event) this.kRef = s.k;
        this.open = s.gateOpen;

        let ramp = false;
        trims.forEach((v, i) => {
            const b = this.banks[i];
            if (v === undefined) { b.prev = undefined; return; }
            const reset = allAtOne || identical
                || (b.prev !== undefined && Math.abs(v - b.prev) > TRIM_RESET_JUMP);
            b.prev = v;
            const pinned = v <= this.fMin + STOP_TOLERANCE || v >= this.fMax - STOP_TOLERANCE;
            if (reset) {
                b.pending = true; b.restart = true; b.lo = v; b.hi = v; b.awaitRich = false;
            } else if (event && !b.restart) {
                // A restarted bank keeps its own clock: its ramp started at 1.000 and the first
                // switch is what ends it, whatever K did meanwhile.
                b.pending = true; b.lo = v; b.hi = v; b.awaitRich = drop;
            } else if (b.pending) {
                b.lo = Math.min(b.lo, v);
                b.hi = Math.max(b.hi, v);
                const switched = b.awaitRich
                    ? b.hi - v >= REVERSAL_FRACTION * neg
                    : v - b.lo >= REVERSAL_FRACTION * pos;
                if (switched && !pinned) {
                    b.pending = false; b.restart = false; b.awaitRich = false;
                }
            }
            if (b.pending || pinned) ramp = true;
        });
        return ramp;
    }
}

/**
 * The longest half-cycle — one reversal of a bank's trim to the next — that is still the limit
 * cycle, in seconds. Every sample of a longer one is a WALK.
 *
 * A half-cycle is the I ramp running one way, so its length is its excursion. Per half-cycle, the
 * median trim move on the K HOLD drives #971 / #974 is 0.012 / 0.011 at 0.5-1 s, 0.023 / 0.022 at
 * 1-1.5 s, 0.040 / 0.035 at 1.5-2 s and 0.056 / 0.047 at 2-2.5 s. Up to 1.5 s that is the cycle's
 * own swing, ±0.02 about its centre — the tolerance every reader of this flag works to; past it
 * the trim is covering a distance it was not already within. The car's loop sits well inside: the
 * DME's own P-jump counters (`LA_P_SPR_COUNT`, logged on #967/#968/#970) put consecutive jumps of
 * a bank 0.52 s apart at p10, 0.61 s at p25 and 0.89 s at the median, and the tracker's reversals
 * on #971 / #974 come 0.86 / 1.00 s apart at the median.
 *
 * What it costs is reversals the log cannot see. A half-cycle shorter than one sample interval can
 * hide its pair of reversals, and three half-cycles then read as one of ~2 s. On the VE profile
 * (#971 / #974: a sample every 0.18 s at the median, 0.39 s at p90) that takes a half-cycle under
 * 0.2-0.4 s, below the counters' p10; at the 1.5-2 Hz the counter channels slowed #967/#968/#970
 * to, it is common. Either way the cost lands on "not cycling", which every reader takes as "do
 * not read".
 */
export const HALF_CYCLE_MAX_SEC = 1.5;

/** One raw sample, as the cycle tracker needs it. `time` is in the LOG's own unit — the flags are
 *  told seconds-per-unit. */
export type LambdaCycleSample = Pick<KRampSample, 'time' | 'rpm' | 'rf' | 'stft1' | 'stft2'>;

/**
 * What one sample did to one bank's phase. `absent`: no reading. `reset`: a restart signature, so
 * the phase so far is void. `reversal`: the P jump against the phase's direction, which ends one
 * half-cycle and opens the next. `none`: the phase goes on.
 */
export type LambdaBankEvent = 'absent' | 'reset' | 'reversal' | 'none';

/** One sample's step of `LambdaCycleTracker`, per bank (index 0 is bank 1). */
export interface LambdaCycleStep {
    event: [LambdaBankEvent, LambdaBankEvent];
    /** On the integrator's clamp (`STOP_TOLERANCE`, as `KRampTracker`): reporting a bound, not a
     *  mixture, so never cycling. */
    pinned: [boolean, boolean];
}

interface CycleBank {
    /** Running minimum / maximum of the trim since the last reversal or reset. */
    lo: number;
    hi: number;
    /** The phase the trim is in: +1 rising (a lean phase, after a lean switch), -1 falling (a rich
     *  phase), 0 unknown — after a reset, until the first move says which. */
    dir: -1 | 0 | 1;
    prev: number | undefined;
}

/**
 * Where does each bank's trim REVERSE? The event half of `lambdaCyclingFlags`, which says what the
 * reversals are for. Causal: `step` sees each raw sample once, in time order.
 *
 *   REVERSAL - in a falling phase, the trim rose `REVERSAL_FRACTION` x P+ above `lo` (the lean
 *              switch); in a rising phase, it fell `REVERSAL_FRACTION` x P- below `hi` (the rich
 *              switch). P from `lambdaPJumpAt` at this (N, RF), as `KRampTracker` takes it. Then
 *              `lo = hi = v` and the direction flips.
 *   RESET    - loop off (every present bank exactly 1.000), both banks bit-identical, a one-sample
 *              move over `TRIM_RESET_JUMP`, or the first reading after none: the same restart
 *              signatures as `KRampTracker`, plus the gap. The direction is unknown; the first move
 *              after it sets the direction and is NOT a reversal — there is nothing yet to reverse.
 *
 * ## Why the direction is part of it
 *
 * A ramp's own I slope crosses either threshold within a fraction of a second — 0.8 x P- = 0.0078
 * is 0.19 s at 0.0406/s — so comparing the trim with its extremes since the last reversal, without
 * the direction, calls a monotone walk a train of rich switches, one every sample. The P jump is the
 * one move AGAINST the phase's direction, and that is what is counted.
 */
export class LambdaCycleTracker {
    private readonly pJumps: LambdaPJumps | null;
    private readonly fMin: number;
    private readonly fMax: number;
    private readonly banks: CycleBank[] = [0, 1].map(() => ({ lo: 1, hi: 1, dir: 0, prev: undefined }));

    constructor(params?: LambdaRampParams | null) {
        this.pJumps = params?.pJumps ?? null;
        this.fMin = params?.fMin ?? TRIM_CLAMP_FALLBACK.min;
        this.fMax = params?.fMax ?? TRIM_CLAMP_FALLBACK.max;
    }

    /** Advance one sample and say what it did to each bank. */
    step(s: LambdaCycleSample): LambdaCycleStep {
        const trims = [s.stft1, s.stft2];
        const present = trims.filter((v): v is number => v !== undefined);
        const { pos, neg } = lambdaPJumpAt(this.pJumps, s.rpm, (s.rf ?? 0) / 100);
        const allAtOne = present.length > 0 && present.every(v => v === 1);
        const identical = present.length === 2 && trims[0] === trims[1];

        const out: LambdaCycleStep = { event: ['absent', 'absent'], pinned: [false, false] };
        trims.forEach((v, i) => {
            const b = this.banks[i];
            if (v === undefined) {
                // What the integrator did across the gap is unknown; the next reading starts afresh.
                b.prev = undefined; b.dir = 0;
                return;
            }
            out.pinned[i] = v <= this.fMin + STOP_TOLERANCE || v >= this.fMax - STOP_TOLERANCE;
            const reset = allAtOne || identical || b.prev === undefined
                || Math.abs(v - b.prev) > TRIM_RESET_JUMP;
            b.prev = v;
            if (reset) {
                b.lo = v; b.hi = v; b.dir = 0;
                out.event[i] = 'reset';
                return;
            }
            b.lo = Math.min(b.lo, v);
            b.hi = Math.max(b.hi, v);
            out.event[i] = 'none';
            if (b.dir === 0) {
                if (v < b.hi) b.dir = -1;
                else if (v > b.lo) b.dir = 1;
            } else if (b.dir < 0 ? v - b.lo >= REVERSAL_FRACTION * pos : b.hi - v >= REVERSAL_FRACTION * neg) {
                b.dir = b.dir < 0 ? 1 : -1;
                b.lo = v; b.hi = v;
                out.event[i] = 'reversal';
            }
        });
        return out;
    }
}

/**
 * Is the lambda loop LIMIT-CYCLING at each sample — reversing about the trim that holds λ = 1 at
 * this operating point — or WALKING toward a trim it has not reached?
 *
 *   per bank        the half-cycle a sample is in: the reversal at or before it (`r_open`) and the
 *                   first one after it (`r_close`), with no reset or missing reading between
 *                   (`LambdaCycleTracker`)
 *   bank cycling    off its clamp, both reversals in the log, and
 *                   t(r_close) - t(r_open) <= HALF_CYCLE_MAX_SEC
 *   lambdaCycling   at least one bank present, and every present bank cycling
 *
 * ## Why `kRamp` does not answer this
 *
 * `KRampTracker` asks one question: has each bank reversed since the last K step or loop restart.
 * After that one switch it calls the bank settled until the next K event. But a K step is not the
 * only step the loop answers. Move from a cell whose VE is 4 % rich into one that is right, and the
 * trim — at 0.96 — has to walk back at the same I slope it walks a K step back at; until it gets
 * there it carries the PREVIOUS cell's error, and nothing about K moved. Under K HOLD the gate never
 * opens, so a restart is the tracker's only event and every such walk reads settled. Measured on
 * #971 (a K HOLD drive): 448-452 s the trim walked 1.04 -> 0.89 and 461-465 s 1.00 -> 0.84, at
 * ~-0.04/s, with `kRamp` false throughout.
 *
 * ## Why it needs the reversal AFTER the sample
 *
 * A walk starts with a switch. The move into the new cell turns the mixture, the sensor reports it,
 * and the P jump that answers is a reversal like any other — then the I ramp runs one way for as
 * long as the distance takes. Only the end of a phase says how long it was, so a flag that looks
 * back alone ("reversed within the last 1.5 s") passes the first 1.5 s of every walk: on #971 that
 * is where 72 % of the gate-region samples it called cycling sat, and 4 of the 5 rises the high-Δ
 * guard once read as lean locks. Asked of the whole half-cycle, the walk is a walk from its first
 * sample.
 *
 * The price is the end of a log. The last half-cycle has not closed, so it reads "not cycling" —
 * on a live run, the last second or so until the next flush re-annotates the prefix. And it is a
 * pass over a log, not a step: the live VE stream, annotated one sample at a time, does not carry
 * the flag, and nothing that reads the live stream needs it.
 *
 * ## Measured
 *
 * Against the DME's P-jump counters on #967/#968/#970, a sample truly cycling where both banks sit
 * between two counter rises at most 2 s apart: the samples this calls cycling are 0.86 right, at a
 * recall of 0.26. Of what it passes, 14 % sits in a counter gap over 2 s — a walk — where the
 * backward look passed 48 %; on the anchor check's gate-shut post-ramp population, 14 % against
 * 48 %. (Against a 1.5 s gap it scores 0.70 / 0.32 — at those logs' 0.5-0.66 s sampling both
 * lengths are read to a sample either way — and against the backward truth "a rise in the last
 * 1.5 s" 0.97 / 0.17.) The recall is the sampling's price: at 1.5-2 Hz most short half-cycles hide
 * a reversal pair. On #971 / #974 it calls 23 % / 17 % of the loop-on samples cycling, and 3 % / 2 %
 * of those the stock gate would have entered: those drives' gate region was walking almost
 * throughout.
 *
 * What the readers get. #971's α — the within-cell slope of ln trim on ln K*, the share of BMW's
 * enrichment the engine needed — reads +0.038 [-0.024, +0.097] over 891 samples at 1200-5000 rpm,
 * where the backward look read +0.065 [+0.011, +0.112] and the limit cycle's own midpoints give
 * +0.005..+0.03; the stock gate region keeps 14 samples, too few to estimate, where the backward
 * look read +0.518 off its walk starts. Over #964-#970 the DRREL tuner's tables come out unchanged:
 * D turns away 1-9 post-ramp samples a drive (the 3 thin-count samples #966 and #968 each used
 * among them), and the anchor check keeps 14-21 % of its gate-shut samples, 290-516 a drive, with
 * its median moving -0.002..+0.007 and no verdict changing.
 *
 * ## Independent of `kRamp`
 *
 * The two answer different questions and neither replaces the other. A bank that has settled on a
 * K step and then walks a VE step is post-ramp AND not cycling; a bank cycling before a K step is
 * still mid-ramp after it, whatever its half-cycles. The VE write reads only `kRamp` (see
 * `LogDataPoint.lambdaCycling` for why); the readers that need the trim to be the error at THIS
 * operating point read both.
 */
export function lambdaCyclingFlags(
    samples: readonly LambdaCycleSample[], params: LambdaRampParams | null | undefined, secondsPerUnit: number,
): boolean[] {
    const tracker = new LambdaCycleTracker(params);
    const steps = samples.map(s => tracker.step(s));
    const t = samples.map(s => s.time * secondsPerUnit);
    const n = samples.length;
    const flags = steps.map(s => s.event.some(e => e !== 'absent'));
    const open = new Array<number>(n);
    for (let k = 0; k < 2; k++) {
        // Forward: the reversal that opened each sample's half-cycle, -1 since a reset or a gap.
        let last = -1;
        for (let i = 0; i < n; i++) {
            const e = steps[i].event[k];
            if (e === 'absent' || e === 'reset') last = -1;
            else if (e === 'reversal') last = i;
            open[i] = last;
        }
        // Backward: the reversal that closes it, -1 when a reset, a gap or the log's end comes first.
        let next = -1;
        for (let i = n - 1; i >= 0; i--) {
            const e = steps[i].event[k];
            if (e !== 'absent') {
                const cycling = !steps[i].pinned[k] && open[i] >= 0 && next >= 0
                    && t[next] - t[open[i]] <= HALF_CYCLE_MAX_SEC;
                if (!cycling) flags[i] = false;
            }
            if (e === 'absent' || e === 'reset') next = -1;
            else if (e === 'reversal') next = i;
        }
    }
    return flags;
}

/**
 * Is this sample excluded from a VE write as a lambda ramp? The ONE predicate the calculator, the
 * drop census (`lambdaRamp`) and the live counter share.
 *
 *     excluded  <=>  kRamp !== false
 *
 * Whatever the gate state: a bank pending since the last event — the gate opening or shutting, a K
 * step, or a loop restart — is reading the time since that event, with the gate shut as with it
 * open (see "A restart is a clock with the gate shut too" above). The gate no longer enters.
 *
 * Undefined is the walk never having seen the sample — a timestamp outside the raw log it walked —
 * and it counts as a ramp: the alternative credits it a trim whose history is unknown. Every sample
 * the walk did see carries a defined value, gate open or shut, binary or not (`annotateRfKorr`,
 * `VECalculator.rfKorrWalk`), so this does not refuse a stream wholesale; a hand-built sample that
 * was never annotated must say `kRamp: false` to be written.
 */
export function isLambdaRampExcluded(point: { kRamp?: boolean }): boolean {
    return point.kRamp !== false;
}
