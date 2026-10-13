/**
 * Has the DME's lambda loop finished taking back the last step in rf_korr?
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

/** Is this sample excluded from a VE write as a ramp? The ONE predicate the calculator, the drop
 *  census and the live counter share. A gate-open sample whose ramp state was never walked —
 *  `kRamp` undefined — counts as a ramp: the alternative credits it `trim x K`, which during a
 *  ramp is the time since the step and not the VE error. */
export function isKRampExcluded(point: { rfKorrGateOpen?: boolean; kRamp?: boolean }): boolean {
    return point.rfKorrGateOpen === true && point.kRamp !== false;
}
