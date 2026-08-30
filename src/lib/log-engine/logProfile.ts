/**
 * What a run is for — and therefore what it reads, what it needs armed, and how fast it goes.
 *
 * The inertia run got here first and the reasoning is already written down in `useDmeLink`: it is a
 * sibling of the VE run rather than a mode of it, "because the two produce different sample types
 * and answer different questions... keeping them apart at the type level means a mismatched log is
 * a compile error rather than a confident wrong answer downstream". This file is that idea given a
 * name and a third member.
 *
 * ## Why it buys speed
 *
 * DS2 reads whole BLOCKS. `0x0B` takes one selection number and returns all of it; there is no way
 * to ask for two bytes. So the cost of a sample is the cost of the blocks it needs, and a run that
 * needs fewer blocks is genuinely faster — not by tuning anything, by not asking.
 *
 *   block 3    35 B payload, 44 B on the wire    ~50 ms    n aq_rel tmot rf tabg wdk1
 *   block 19   90 B payload, 99 B on the wire   ~113 ms    la_f_regler1/2 tetv tefc_* la_freeze
 *   block 83   52 B payload, 61 B on the wire    ~70 ms    md_ind_* d_n40 gang v_antrieb ...
 *
 * ## The EGT profile, and why it is retired
 *
 * It was the point of the exercise, and the reasoning was wrong. MEASURING `rf_korr` really is
 * `(rf/100) / rf_soll`, every term in block 3, so dropping the 90-byte trim block really did more
 * than double the rate — #903 collected at 6.60 Hz against #902's 2.44.
 *
 * But DERIVING what the correction table SHOULD hold is a different calculation:
 *
 *     A(delta)/A(0) = k_applied x STFT(delta) / STFT(0)
 *
 * `k_applied` says what the DME DID; only STFT says whether it was RIGHT, and STFT is `la_f_regler`,
 * in block 19. Two logs cannot be combined either — separate drives do not correspond sample by
 * sample. So the faster profile could only ever produce a drive that had to be driven again, and it
 * did exactly that once. It stays in the type for records that name it; `runnable: false` keeps it
 * out of the menu.
 *
 * ## Why the channel list is the enforcement
 *
 * Nothing here forbids anything. An EGT log simply has no `la_f_regler`, so no VE map can be built
 * from it — not because a flag says so but because the number is not there. `isFieldPresent` and
 * the parser's own requirement already work this way, and leaning on that is what stops this from
 * becoming a second gating mechanism that can disagree with the first.
 */

import {
    LAMBDA_TRIM_RAM_READ, INERTIA_RAM_READ, AMBIENT_CHARGE_RAM_READ,
    AMBIENT_TEMP_RAM_READ,
    IDLE_TORQUE_RAM_READ, IDLE_ACTUATOR_RAM_READ, ENGINE_STATE_RAM_READ, COMPRESSOR_RAM_READ,
    IDLE_GOVERNOR_RAM_READ, IDLE_THROTTLE_RAM_READ, IDLE_WDK_RAM_READ, IDLE_LAMBDA_LEARN_RAM_READ,
    IDLE_RESERVE_RAM_READ, IDLE_STEERING_RAM_READ, IDLE_VALVE_STATE_RAM_READ,
    SLEW_STATE_RAM_READ, SLEW_TORQUE_RAM_READ,
    IDLE_VANOS_RAM_READ, IDLE_VANOS_TARGET_RAM_READ,
} from '@/lib/dme-link/ramMap';
import { type FieldKey, LOG_FIELD_REGISTRY } from '@/lib/field-registry/registry';

/** Milliseconds of wire time for one byte, at 9600 8E1.
 *
 *  8E1 is 11 bits per byte, so 1.1458 ms each. On a half-duplex K-line the request and the response
 *  cross the same wire, so they add.
 *
 *  One rate for both directions. The ECU actually answers at ~9709 (measured), which is 1.1 % faster
 *  — well below the residual between this whole model and a measured drive, so splitting it would be
 *  precision the model has not earned. */
const WIRE_MS_PER_BYTE = 11 / 9600 * 1000;

/** Bytes on the wire for the two request shapes.
 *
 *  A block read is `[addr][len][0x0B][selection][cksum]`. A RAM read is `[addr][len][0x06]` plus the
 *  five-byte payload `buildReadMemoryPayload` builds (`segment`, 24-bit address, count) plus the
 *  checksum — nine. Four more bytes to save eighty-six is the trade the fast VE profile is. */
const REQUEST_BYTES = { block: 5, ram: 9 } as const;
/** `[addr][len][status]...[cksum]` around whatever the DME returns. */
const RESPONSE_OVERHEAD = 4;

/**
 * What the DME spends thinking between the request and the response, per exchange.
 *
 * Measured on the car, and revised once. The first figure — 40 ms — came from session #902, whose
 * 410 ms/sample minus 164 ms of wire left 246 ms for two exchanges; but #902 ran the OLD whole-log
 * derivation inside the sample callback, so an unknown share of that was the HOST, and attributing
 * all of it to the DME made 40 ms a residual rather than a measurement.
 *
 * Session #903 settles it. Block 3 alone, after the derivation was made incremental, so host cost
 * is O(1) per sample and no longer confounds the subtraction:
 *
 *     2940 samples / 446 s = 6.60 Hz  =  151.5 ms/sample
 *     wire (44 B at 9600 8E1)         =   50.4 ms
 *     -> non-wire                     =  101.1 ms, one exchange
 *
 * Applying 100 ms back to #902 predicts 2.75 Hz against 2.44 measured, leaving ~23 ms/exchange of
 * host — which is exactly the whole-log derivation that #903 no longer pays. Two runs, one constant,
 * and the residual lands where the code says it should.
 *
 * Then session #904 measured it DIRECTLY, which is why the number is 83 and not 101. The instrument
 * armed for datalogs reports a median turnaround of **83 ms** and a median `hostGap` of **0.3 ms** —
 * so the host really is out of the picture, and the subtraction above was attributing transport
 * cost to the DME.
 *
 * What is left over does not fit one constant, and this comment will not pretend it does:
 *
 *     #904  VE  [3,19]   329.8 ms predicted   339 ms measured (2.95 Hz)    ~5 ms/exchange over
 *     #903  EGT [3]      133.4 ms predicted   151 ms measured (6.60 Hz)   ~18 ms/exchange over
 *
 * The remainder is larger on the SMALLER block, which rules out anything proportional to bytes and
 * fits a fixed per-response latency that a big response partly hides — the FTDI latency timer
 * (16 ms by default) is the obvious candidate, and the transport is `web-usb-ftdi`. Two points is
 * not enough to fit a second term, so none is fitted: the model states the DME's own cost, and the
 * gap to a measured rate is the transport's. Naming it that way is what stopped the last revision
 * from being right.
 *
 * It is still the floor this exercise runs into: 83 ms of thinking against 50 ms of wire makes the
 * DME two thirds of a block-3 sample. Dropping a block beats shaving bytes.
 *
 * ## Two constants, not one, and deliberately not four
 *
 * A control-0x06 RAM read is a different mechanism from a block read — a bounds check and a byte
 * copy, with no measurement job behind it — and the per-exchange traces from #904 put it at 18-48 ms
 * against a block read's 83. That difference is what the fast VE profile spends, so it has to be in
 * the model.
 *
 * What is NOT split here is block 3 against block 19, even though the same traces show 13-85 ms for
 * one and 85-100 for the other. Those are per-exchange spreads inside a run whose only reported
 * summary is a single median, and fitting two constants to one median is how the previous revision
 * of this comment ended up attributing transport cost to the DME. One drive with the exchange-kind
 * breakdown now recorded (see `beginLogTiming`) settles it; until then the model states one
 * block-read cost and the gap to a measured rate stays visible rather than being absorbed.
 */
export const DME_TURNAROUND_MS = { block: 83, ram: 35 } as const;

export interface BlockCost { selection: number; payload: number }

export const BLOCK_COST: Record<number, BlockCost> = {
    3: { selection: 3, payload: 35 },
    /** Standard adaptations (0x06). Only the idle run's FALLBACK reads it, and only for md_llra —
     *  the fast path takes that from RAM alongside md_llri, which is the point of the RAM read.
     *  Absent from this table, `blockMs` returned 0 and the fallback priced itself 1 % too fast. */
    6: { selection: 6, payload: 83 },
    19: { selection: 19, payload: 90 },
    83: { selection: 83, payload: 52 },
};

/**
 * One request-and-response with the DME. A sample is a list of these.
 *
 * The list replaced a `number[]` of block selections, and the reason is that a sample stopped being
 * "some blocks": the VE profile's lambda trim now comes from four bytes of RAM, and block 19 comes
 * back only every eighth sample for the four channels that exist nowhere else. Neither of those can
 * be said with a selection number.
 *
 * `every` is a divisor on the sample index, and sample 0 always reads everything — so a run's first
 * sample is complete, and the slow-lane channels are present from the start rather than undefined
 * for the first eight samples of every log.
 *
 * ## `provides`
 *
 * Which log channels this exchange is what puts in the log. Provenance, and it does one job that
 * nothing else can do: it lets a variant be narrowed by RELEVANCE rather than by a hand-written
 * list of channel names that would immediately start drifting from the registry.
 *
 * It cannot be derived. `source` on a registry field is either a `{selection, offset}` or the word
 * `derived` — and `derived` covers BOTH a channel this app computes (correctedLoad) and one read
 * out of RAM (TAN, P_UMG, LLS_ST). From the registry alone there is no way to tell which RAM read
 * a RAM-sourced channel came out of, so the exchange has to say.
 *
 * Optional, and absent means KEPT. A forgotten annotation therefore records a channel that could
 * have been dropped — the harmless direction. The opposite default would silently delete a tuning
 * channel from a drive, which costs the drive. `verify:production-log` closes the gap by asserting
 * the annotation is complete on the profile production can actually run.
 */
export type LogExchange =
    | { kind: 'block'; selection: number; every?: number; provides?: readonly FieldKey[] }
    | {
        kind: 'ram';
        /** For the event log and the diagnostics record — a numeric address in a trace is unreadable. */
        name: string;
        segment: number;
        address: number;
        count: number;
        every?: number;
        provides?: readonly FieldKey[];
    };

/**
 * The exchange list with the DEBUG-only reads taken out — what a PRODUCTION build records.
 *
 * Decided 2026-08-25, shipped with the first production cut. Production records `core` + `tuning`:
 * the two lambda pairs, coolant, EGT, rf, RF KORR, purge duty and road speed. The twelve `debug`
 * channels are for the preview build, because the question each of them answers is "why is the tool
 * or the DME saying that" rather than "what is this tune doing", and nothing in the derivation reads
 * one.
 *
 * **An exchange goes only when EVERY channel on it is debug.** That is the whole rule, and it is
 * why this is a filter over `relevance` rather than a list: `T_UMG/V` carries a debug channel
 * (outside air temperature) and a tuning one (road speed) in one telegram, so it stays, and block 19
 * carries three debug bytes beside `tetv` and the lambda truth gate, so it stays too. Dropping an
 * exchange for its debug half would take the tuning half with it.
 *
 * What it actually removes from a VE run is two reads — the P_UMG/TAN_M cluster at 1/16 and the
 * LLS_ST byte at 1/64 — and the measured rate goes 4.460 Hz -> 4.563 Hz, which is 2.31 %. Worth
 * saying plainly: the rate is NOT the reason. The reason is that a production log should carry the
 * channels a tune is read from and not twelve more that only make sense with the disassembly open.
 */
export function productionExchanges(exchanges: readonly LogExchange[]): LogExchange[] {
    return exchanges.filter(x => !x.provides?.length
        || x.provides.some(key => LOG_FIELD_REGISTRY[key].relevance !== 'debug'));
}

/** Wire plus turnaround for one exchange, ignoring `every`. */
export function exchangeMs(exchange: LogExchange): number {
    if (exchange.kind === 'ram') {
        return (REQUEST_BYTES.ram + RESPONSE_OVERHEAD + exchange.count) * WIRE_MS_PER_BYTE
            + DME_TURNAROUND_MS.ram;
    }
    const block = BLOCK_COST[exchange.selection];
    if (!block) return 0;
    return (REQUEST_BYTES.block + RESPONSE_OVERHEAD + block.payload) * WIRE_MS_PER_BYTE
        + DME_TURNAROUND_MS.block;
}

/** Mean milliseconds per sample for an exchange list, amortising the slow lane over `every`. */
export function sampleMs(exchanges: readonly LogExchange[]): number {
    return exchanges.reduce((total, x) => total + exchangeMs(x) / Math.max(1, x.every ?? 1), 0);
}

/** Expected samples per second, wire and turnaround only.
 *
 *  Deliberately excludes host time: after W4 the derivation is O(1) per sample and runs off the
 *  poll path, so if the measured rate falls short of this the difference is the link, not the app.
 *  Shown next to the measured rate during a run precisely so that gap is visible. */
export function expectedHz(exchanges: readonly LogExchange[]): number {
    const ms = sampleMs(exchanges);
    return ms > 0 ? 1000 / ms : 0;
}

/** The block selections in an exchange list, for the callers that still speak in blocks — the
 *  channel-presence claims and the timing instrument's payload sizing. */
export function blocksOf(exchanges: readonly LogExchange[]): number[] {
    return exchanges.filter(x => x.kind === 'block').map(x => x.selection);
}

/** One line naming what a sample really costs, for the rate tooltip and the event log. */
export function describeExchanges(exchanges: readonly LogExchange[]): string {
    return exchanges
        .map(x => {
            const what = x.kind === 'block' ? `block ${x.selection}` : `RAM ${x.name} ${x.count} B`;
            return (x.every ?? 1) > 1 ? `${what} 1/${x.every}` : what;
        })
        .join(' + ');
}

/** A block read, spelled out. */
const block = (selection: number, every?: number): LogExchange =>
    every === undefined ? { kind: 'block', selection } : { kind: 'block', selection, every };

/**
 * How often the VE profile still reads block 19, when the trim is coming from RAM.
 *
 * Not zero, and that is the point. `tetv`, `tefc_ll_st`, `tefc_ed` and `la_freeze_flag` exist in no
 * other block, and two of them are in slave RAM this calibration refuses to serve at all — so
 * dropping block 19 outright would silently delete the purge channels, which are exactly what a
 * disagreement between two logs of the same road gets blamed on.
 *
 * Eight is chosen against what the channels DO rather than against the arithmetic. All four are
 * slow, latching state: a purge duty ramps over seconds, and the two diagnostic bytes change on
 * fault transitions. At ~5 Hz, eight samples is ~1.6 s — finer than any of them move.
 *
 * It also pays for the truth gate. Every eighth sample carries block 19's own `la_f_regler`
 * alongside the RAM read of the same instant, so the claim "these four bytes are that channel" is
 * re-checked on the car for the whole drive rather than only at the start.
 */
export const LAMBDA_SLOW_LANE_EVERY = 8;

/**
 * The density cluster's own cadence, half the rate of the block-19 lane.
 *
 * Nothing in `AMBIENT_CHARGE_RAM_READ` moves fast enough to want eight. `tan_m` is a filtered model
 * with an 11-second time constant (`k_tanm_delta_weight` = 11000 at 100 ms). Ambient pressure is
 * slew-limited by the DME itself to 1.875 mbar/s, so at 4.5 Hz sixteen samples is 3.5 s and at most
 * 6.6 mbar — 0.7 % of density, on a channel that does not enter the correction at all. Intake air
 * temperature comes through a 1.3 s IIR (`K_TAN_TAU`) off a sensor with far more thermal mass
 * than that.
 *
 * What sixteen buys is the sample rate. The cluster is 16 bytes where the intake-temperature byte
 * it replaced was one, and those fifteen extra payload bytes are ~17 ms of wire time per read. At
 * eight that is 2.1 ms on every sample and the fast VE profile stops being 1.5x the both-blocks
 * fallback; at sixteen it is 1.1 ms and the margin comes back. The exchange COUNT is unchanged
 * either way — this replaced a read, it did not add one.
 *
 * The cost of the slower lane is that the first sixteen samples of a run carry no density channels.
 * They are dropped rather than normalised from nothing; see the charge-temperature normaliser.
 */
export const DENSITY_SLOW_LANE_EVERY = 16;

/**
 * The outside-air lane, slower again.
 *
 * `T_UMG` comes off CAN 0x62F and moves with the weather; the `P_UMG` byte on the same telegram is
 * a cross-check on an address, not a signal. Neither wants a rate. At 4.5 Hz this is one read every
 * seven seconds, which costs about 0.8 ms a sample.
 *
 * `V` is on it too and is NOT happy here — it crosses the 20 km/h `rf_korr` gate threshold in
 * roughly a second and a half from rest. That is why it is recorded and not yet gated on: reading
 * it fast enough to gate would mean a telegram spanning `0xFF8082` to `LA_F_REGLER2`, 62 bytes on
 * every sample against the four the trim costs now. Closing the gate properly is a separate change
 * with its own rate decision, not something to smuggle in behind a diagnostic.
 */
export const AMBIENT_SLOW_LANE_EVERY = 32;

/**
 * For a bit something LATCHES, rather than a value that moves.
 *
 * `LLS_ST` bit 7 is set by the idle-valve diagnosis and stays set until the diagnosis clears it, so
 * what a log needs from it is "was this ever set during the run" — not a per-sample reading. Once
 * every 64 samples is about 14 s at the VE rate, which answers that question and costs 0.35 % of
 * the rate. Reading it eight times faster would cost four times as much and tell nobody anything.
 */
export const LATCHED_BIT_LANE_EVERY = 64;

/**
 * What has to be true on THIS car before a log's lambda trim may come from RAM.
 *
 * The address is right in a disassembly of the 0401 master. That is evidence, not proof: a
 * calibration variant, a different link order, or simply a mis-read of the graph would put a
 * plausible number at those four bytes and produce an entire drive of wrong trim — the failure mode
 * with no symptom, since every downstream check would see a number in range. So the run asks the ECU
 * directly, at the only moment it is free to be slow.
 *
 * The check is a sandwich: RAM, then block 19, then RAM again. Bracketing the block read is what
 * makes it a comparison rather than a race — the trim moves continuously, and a single before-and-
 * after pair could disagree because 200 ms passed rather than because the address is wrong. Each
 * pair is judged on the block-19 reading against the mean of the two RAM readings around it.
 *
 * `tolerance` is 5 % rather than the ~0.003 % a bit-exact match would allow, and that is deliberate:
 * the two are read a fifth of a second apart, and the controller's own step is larger than any
 * decoding error would be. A wrong address does not miss by 5 % — it misses by being a gear number,
 * a temperature, or a byte pair that never moves.
 *
 * `plausible` is the second half, and it catches what agreement cannot: a channel that is stuck.
 * Two readings of 0x0000 agree perfectly. A closed-loop trim lives near 1.0 by construction and the
 * DME's own limits sit far inside this band, so anything outside it is not a trim.
 */
export const LAMBDA_TRUTH_GATE = {
    tolerance: 0.05,
    plausible: { min: 0.7, max: 1.3 },
    /** Pairs taken at the start of a run, and how many must pass. Two of three, so one sample landing
     *  on a fast transient does not cost the profile. */
    pairsTaken: 3,
    pairsRequired: 2,
    /**
     * Consecutive slow-lane disagreements before the run says so.
     *
     * It says so; it does NOT switch. A silent change of where a channel came from, in the middle of
     * a drive, would leave a log that is two different measurements with one name — and the source
     * is recorded per sample (`LiveMeasurement.stftSource`) precisely so that never has to be
     * guessed at afterwards. Three in a row because the slow lane is 1/8 rate: a single disagreement
     * at a gear change is normal.
     */
    driftWarnAfter: 3,
} as const;

/** Whether one RAM reading and one block-19 reading of the lambda trim are the same channel.
 *
 *  `undefined` on either side is a failure, not a pass: "we could not check" must never read as
 *  "checked and fine" — that is the whole reason the gate exists. */
export function lambdaTrimAgrees(fromRam: number | undefined, fromBlock19: number | undefined): boolean {
    if (fromRam === undefined || fromBlock19 === undefined) return false;
    const { tolerance, plausible } = LAMBDA_TRUTH_GATE;
    for (const v of [fromRam, fromBlock19]) {
        if (!Number.isFinite(v) || v < plausible.min || v > plausible.max) return false;
    }
    // Relative to the block-19 value, which is the one being trusted. It cannot be near zero — the
    // plausibility band above already required it to be near 1.
    return Math.abs(fromRam - fromBlock19) / fromBlock19 <= tolerance;
}

/**
 * How often an idle run reads block 19 purely to check itself.
 *
 * Much sparser than the VE profile's 8, and for the opposite reason. There the slow lane also
 * FETCHES four channels that exist nowhere else, so its rate is set by how fast those move. Here it
 * fetches nothing the RAM read did not already give: its whole job is to put block 19's md_llri
 * (offset 77) next to the RAM copy of the same instant, so the claim that 0xFFD8F0 is that channel
 * keeps being re-checked for the whole run instead of only at the start.
 *
 * 32 at ~4.1 Hz is roughly every 8 s. The integrator's own time constant is K_LFR_TAU_IA1 = 5.12 s
 * and a dwell is 20 s, so every dwell gets two or three checks — enough to catch an address that
 * goes wrong mid-run, cheap enough that the check costs 6 ms of a 242 ms sample.
 */
export const IDLE_TRUTH_LANE_EVERY = 32;

/**
 * How often the idle run reads the three diagnostic exchanges: actuator, engine state, compressor.
 *
 * Exported and used BOTH in the profile below and in the poll that implements it, so the rate the
 * model predicts and the rate the link actually runs cannot drift apart. Four at ~4.1 Hz is ~1 s.
 * Every one of these is latching state — a limp-branch flag, an LL bit, a compressor relay — and a
 * dwell is 20 s, so 1 s of resolution loses nothing while turning three 51 ms exchanges into 38 ms.
 */
export const IDLE_SLOW_LANE_EVERY = 4;

/**
 * The survey lane: a few times a run rather than a few times a second.
 *
 * For channels that answer a question about the CALIBRATION rather than about the sample — the
 * lambda learning stores, whose whole point is that they hold a standing offset. A standing offset
 * does not need 3 Hz, and buying it at 3 Hz would cost the run's rate for nothing.
 */
export const IDLE_SURVEY_LANE_EVERY = 8;

/**
 * What has to be true before an idle run trusts RAM for MD_LLRI. Same sandwich as the lambda gate,
 * different arithmetic, and the difference is the interesting part.
 *
 * `toleranceNm` is ABSOLUTE where the lambda gate is relative, because md_llri lives near -7 Nm and
 * legitimately crosses zero — a relative tolerance is undefined exactly where this channel spends
 * its time. 2.0 Nm is the controller's own step over the ~200 ms separating the two readings, not a
 * decoding slack. A wrong address does not miss by 2 Nm; it misses by being a temperature, a gear
 * number, or a word that never moves.
 *
 * There is no fixed `plausible` band either. The lambda gate could hard-code 0.7-1.3 because a
 * closed-loop trim lives near 1.0 by construction. MD_LLRI's range is whatever the binary's clamps
 * say, and there are three candidate pairs whose order of application is not recovered — so the
 * caller passes the widest pair read from the loaded BIN rather than this file inventing one.
 */
export const IDLE_TORQUE_TRUTH_GATE = {
    toleranceNm: 2.0,
    pairsTaken: 3,
    pairsRequired: 2,
    driftWarnAfter: 3,
} as const;

/** Whether one RAM reading and one block-19 reading of MD_LLRI are the same channel.
 *
 *  `rails` is the [min, max] the loaded binary allows, widest of the clamp pairs. Passing it in is
 *  what keeps this honest: a value outside what the DME can produce is not a disagreement, it is a
 *  decode. `undefined` on either side fails, for the reason lambdaTrimAgrees fails — "could not
 *  check" must never read as "checked and fine". */
export function idleTorqueAgrees(
    fromRam: number | undefined,
    fromBlock19: number | undefined,
    rails: { min: number; max: number },
): boolean {
    if (fromRam === undefined || fromBlock19 === undefined) return false;
    for (const v of [fromRam, fromBlock19]) {
        if (!Number.isFinite(v) || v < rails.min || v > rails.max) return false;
    }
    return Math.abs(fromRam - fromBlock19) <= IDLE_TORQUE_TRUTH_GATE.toleranceNm;
}

export type ProcessId = 'VE' | 'EGT' | 'INERTIA' | 'IDLE';

/** A patch this run needs in the ECU before it means anything. Checked BEFORE the run, because
 *  finding out afterwards costs a drive. */
export type RequiredPatch = 'PATCH' | 'TANK_VENT';

export interface LogProfile {
    id: ProcessId;
    label: string;
    /** What one sample is made of, in the order it is fetched. */
    exchanges: LogExchange[];
    /**
     * What to poll instead when `exchanges` rests on a claim the car did not confirm.
     *
     * Only the VE profile has one, and only because it reads the lambda trim out of RAM. That
     * address is right in a disassembly of the 0401 master; whether it is right in THIS ECU is a
     * question only this ECU can answer, and answering it wrong costs a whole drive of plausible,
     * wrong trim. So the run opens with a check (see `LAMBDA_TRUTH_GATE`) and drops to the list that
     * needs no claim at all if the check fails.
     *
     * Undefined means the profile makes no claim to fall back from.
     */
    fallback?: LogExchange[];
    /**
     * Patches that must already be in the ECU.
     *
     * Advisory in the sense that the app states them and lets the operator decide, mandatory in the
     * sense that a run without them produces a log that cannot answer the question. The EGT run
     * needs TANK_VENT specifically BECAUSE it drops block 19: purge moves `rf` through the DME's own
     * air-mass model, and without `tetv` there is no way to see it happening. Holding the valve shut
     * removes the contamination instead of measuring it, which is what buys the rate.
     */
    requires: RequiredPatch[];
    /** One line, shown where the process is chosen. */
    produces: string;
    /**
     * Whether a drive can still be STARTED as this process.
     *
     * EGT is false, and the entry stays because sessions recorded before it was retired still name
     * it and a log with rf but no trim is still honestly described by it. What it cannot do is be
     * chosen for a new run: the correction table needs the lambda trim, block 3 does not carry it,
     * and so the faster profile could only ever produce a drive that has to be driven again. A
     * retired option left in a menu is a trap with a label on it.
     */
    runnable: boolean;
}

export const LOG_PROFILES: Record<ProcessId, LogProfile> = {
    IDLE: {
        id: 'IDLE', label: 'IDLE',
        // Polled by startIdleRun. Its own sample type, for the reason InertiaSample has one, plus a
        // third that settles it: the VE filter DELETES exactly the samples this run exists to
        // collect (filter.ts used to drop rawLoad <= 1.0 && rpm < idleRpm), so a VE log structurally
        // cannot carry an idle dwell no matter what channels it has.
        //
        // 333.6 ms/sample -> 3.00 Hz, down from 4.13 when this run measured one thing. It now also
        // carries the section 7.1 preconditions, and that is the right trade: what is being
        // estimated is the steady value of an integrator whose own time constant is
        // K_LFR_TAU_IA1 = 5.12 s, over a 20 s dwell, so the rate buys outlier rejection against
        // split RAM reads rather than bandwidth. What the extra channels buy is the answer to
        // whether the estimate is meaningful at all — and a fast measurement of a quantity whose
        // preconditions were never checked is not worth more than a slower one that checks them.
        exchanges: [
            block(3),
            { kind: 'ram', name: 'MD_LLRI/MD_LLRA/MD_LLRA_KO/ML_SOLL/ML_SOLL_MAX_LLS', ...IDLE_TORQUE_RAM_READ },
            { kind: 'ram', name: 'LLS_TV/LLR_QVS/LLR_QSOLL', ...IDLE_ACTUATOR_RAM_READ, every: IDLE_SLOW_LANE_EVERY },
            { kind: 'ram', name: 'ZUSTAND_MOTOR', ...ENGINE_STATE_RAM_READ, every: IDLE_SLOW_LANE_EVERY },
            { kind: 'ram', name: 'KKOS_ST', ...COMPRESSOR_RAM_READ, every: IDLE_SLOW_LANE_EVERY },
            { kind: 'ram', name: 'LLS_ST', ...IDLE_VALVE_STATE_RAM_READ, every: IDLE_SURVEY_LANE_EVERY },
            // The section 7.1 preconditions. Slow lane rather than every sample because they are
            // STEADY-STATE facts — is the governor in its idle state, is the throttle plate where
            // the split says it is — and a fact that is true for the whole dwell does not need to
            // be re-asked four times a second. They cost the run about a quarter of its rate; the
            // measured quantity is the resting value of an integrator with a 5.12 s time constant,
            // so that is not a trade the estimate notices.
            { kind: 'ram', name: 'FR_REGLER/FRA/LFR_MDI/LFR_ZUSTAND/LFR_I_AFR', ...IDLE_GOVERNOR_RAM_READ, every: IDLE_SLOW_LANE_EVERY },
            { kind: 'ram', name: 'EGAS_SOLL/EGAS_MAX_WDK/WDK_SOLL', ...IDLE_THROTTLE_RAM_READ, every: IDLE_SLOW_LANE_EVERY },
            { kind: 'ram', name: 'WDK_WORD', ...IDLE_WDK_RAM_READ, every: IDLE_SLOW_LANE_EVERY },
            { kind: 'ram', name: 'LA_F_REGLER/LAA_F/LAA_REGLER', ...IDLE_LAMBDA_LEARN_RAM_READ, every: IDLE_SURVEY_LANE_EVERY },
            // The additive store those six words DON'T include — and at a stationary idle, the
            // only one whose learning zone is actually open (ML < 30 kg/h, N < 1200, V < 5 km/h).
            // Other RAM window, own exchange, same survey cadence as the cluster it completes.
            // The torque reserve, and the steering angle that arms it. Survey lane, and it belongs
            // there: on the reading in ramMap.ts these are identically zero at a settled idle, so
            // what they buy is not a measurement but a REFUTATION — the whole "the governor has no
            // fast ignition path at warm idle" argument reduces to bit1 of MD_RES_LRW_ST, and a dwell
            // taken with the wheel near the stop is a dwell taken under a different control
            // structure. Two exchanges rather than one only because LWS_LRW is in the other window.
            { kind: 'ram', name: 'MD_RES_KATH/MD_RES_LRW_ST/MD_RES_LRW', ...IDLE_RESERVE_RAM_READ, every: IDLE_SURVEY_LANE_EVERY },
            { kind: 'ram', name: 'LWS_LRW', ...IDLE_STEERING_RAM_READ, every: IDLE_SURVEY_LANE_EVERY },
            // The VANOS cams and the latch that decides whether cylinder-individual idle balance
            // is allowed to run at all. Survey lane, and it is the clearest case for that lane in
            // the profile: the failure this catches cannot come and go during a run, because
            // EVAN1_ST bit3 can only arm just after a start. Asking four times a second would be
            // asking a question whose answer was fixed before the engine was warm.
            //
            // NOT a DS2 block. Selection 0x23 is named in the notes as carrying evan1_ist and does
            // not — see the derivation in ramMap.ts. RAM is the only route, and it is the better
            // one anyway, because it reaches EVAN1_ST itself rather than a position to infer from.
            { kind: 'ram', name: 'EVAN1_IST/EVAN1_ST/VAN_ED_ST', ...IDLE_VANOS_RAM_READ, every: IDLE_SURVEY_LANE_EVERY },
            { kind: 'ram', name: 'EVAN1_IST_FILT/EVAN1_SOLL', ...IDLE_VANOS_TARGET_RAM_READ, every: IDLE_SURVEY_LANE_EVERY },
            // The air of the day — TAN and P_UMG, the two indices into RF_PT_KORR. Survey lane,
            // because it is weather: the correction moves over minutes, not over samples.
            //
            // Without it, the chain LLS_TV -> KL_AQ_ABS_LLS -> AQ_REL -> kf_rf_soll reproduces the
            // car's own `rf` only up to an unexplained constant — measured at 0.876 on a cold run
            // and 0.739 on a warm one. Since `rf_soll_calc` ends with
            // `rf_soll = (rf_soll_filtered * RF_PT_KORR) >> 12`, that constant is a term the DME
            // applied and the log did not record. With these two the prediction closes, and a
            // remaining disagreement means an address or a scaling is wrong rather than the weather.
            { kind: 'ram', name: 'TAN/P_UMG (RF_PT_KORR)', ...AMBIENT_CHARGE_RAM_READ, every: IDLE_SURVEY_LANE_EVERY },
            block(19, IDLE_TRUTH_LANE_EVERY),
        ],
        // 332.8 ms -> 3.00 Hz, and it loses more than rate: no md_llra_ko, no zustand_motor, no
        // kkos_st. So on the fallback the A/C exclusion stops being a gate the tool enforces and
        // becomes a procedure the driver follows. The panel has to say so rather than degrade
        // quietly — an excluded disturbance and an undetected one produce the same clean-looking
        // dwell, and only one of them is a measurement.
        fallback: [block(3), block(19), block(6, 64)],
        // None. The patches change FUELLING; this measures AIR. k_rf_cfg and K_LAA_TMOT_MIN have
        // nothing to do with what the idle valve is asked for.
        //
        // There IS a precondition, it just is not a patch and cannot be checked from the partial
        // BIN: on a Terra-program DME K_FR_T_ADAPT leaves the filling regulator adapting every
        // 384 s instead of 1.5, which puts a standing ml_soll error in exactly this operating
        // region. Stated in the panel as something the operator confirms, with fr_regler logged so
        // a drifting regulator is at least visible in the trace.
        requires: [],
        produces: 'Idle governor state, the throttle-split preconditions, and the LFR integrators',
        runnable: true,
    },
    VE: {
        id: 'VE', label: 'VE',
        // Block 3 for rpm, load, rf and tabg; four bytes of RAM for the lambda trim that used to
        // cost a 90-byte block; block 19 every eighth sample for the purge and freeze channels that
        // exist nowhere else — and, in the same breath, for the check that the four bytes are what
        // they are claimed to be.
        exchanges: [
            // `provides` from here down is what `productionExchanges` narrows on. It names the LOG
            // channels an exchange puts in the file — not every byte it decodes: `ambientPressure-
            // Substituted`, `ambientTempFromCan` and `pressureDecodeDisagreesMbar` ride along on
            // these same reads as qualifiers on a channel rather than columns of their own, so they
            // have no registry entry to name and cannot keep an exchange alive by themselves.
            { ...block(3), provides: ['rpm', 'rawLoad', 'coolantTemp', 'exhaustTemp', 'rf', 'wdk1'] },
            // Eight bytes: the short-term pair the correction is read from, and the long-term
            // stores its mean is learned into. All four are tuning — this read never narrows.
            { kind: 'ram', name: 'LA_F_REGLER1/2', ...LAMBDA_TRIM_RAM_READ,
                provides: ['stft1', 'stft2', 'ltft1', 'ltft2'] },
            // Three debug bytes and `tetv`, which is tuning — so this stays in production, and the
            // three ride in free. It also carries the truth gate, which is not a channel at all.
            { ...block(19, LAMBDA_SLOW_LANE_EVERY),
                provides: ['tankVent', 'tankVentCheckState', 'tankVentDiag', 'lambdaFreeze'] },
            // Ambient pressure, its two diagnostic bytes, the DME's altitude, intake air
            // temperature and the DME's own modelled charge temperature — sixteen bytes, one
            // telegram, on the same slow lane. This is what separates a real VE error from a
            // season; see AMBIENT_CHARGE_RAM_READ. Not on the fallback: see there.
            //
            // ALL FOUR ARE DEBUG, so this is one of the two exchanges a production run drops. The
            // density normalisation they feed is off by default and refuses rather than guesses when
            // they are absent — the same property the fallback below relies on — so a production log
            // losing them costs a comparison between seasons and nothing in the map.
            { kind: 'ram', name: 'P_UMG/TAN_M', ...AMBIENT_CHARGE_RAM_READ, every: DENSITY_SLOW_LANE_EVERY,
                provides: ['ambientPressure', 'altitude', 'intakeTemp', 'chargeTemp'] },
            // The other window's half: outside air temperature and where it came from, road
            // speed, and a second decode of the same pressure. T_UMG cannot share a telegram
            // with the cluster above — different segment — so this is a second exchange, and
            // it rides slower still because nothing in it is needed per sample.
            // `V` is tuning — road speed is how a log is read back as a drive rather than a column
            // of numbers — so this telegram stays and `T_UMG` comes with it.
            { kind: 'ram', name: 'T_UMG/V', ...AMBIENT_TEMP_RAM_READ, every: AMBIENT_SLOW_LANE_EVERY,
                provides: ['ambientTemp', 'vehicleSpeed'] },
            // One byte, 0.35 % of the rate. Bit 7 says which table `ti_load_factor` reads,
            // and a diagnosis latches it rather than anything a sample could catch — see
            // LATCHED_BIT_LANE_EVERY for why the slowest lane in the app is the right one.
            // One channel, debug — the other exchange a production run drops.
            { kind: 'ram', name: 'LLS_ST', ...IDLE_VALVE_STATE_RAM_READ, every: LATCHED_BIT_LANE_EVERY,
                provides: ['llsSt'] },
            // The slew limiter, in two exchanges because `MD_DYN_ST` is in segment 0x01 and the
            // torque words are in 0x04 — a telegram cannot span both.
            //
            // Neither is a VE input, and both are DEBUG: a production run drops them the same way
            // it drops the density cluster and LLS_ST. What they answer is a question the maps
            // cannot — `KF_MD_LS_KOMF` says what the allowance WAS, and only bit 6 says whether the
            // demand ever exceeded it. On the survey lane because a tip-in is not a state you hold:
            // it lasts a few hundred milliseconds, and what is wanted is whether it happened at all
            // during a drive, not its shape. One in sixty-four samples costs 0.7 % of the rate and
            // is enough to answer that; catching the clip itself is what the WOT pull is for.
            { kind: 'ram', name: 'MD_DYN_ST', ...SLEW_STATE_RAM_READ, every: LATCHED_BIT_LANE_EVERY,
                provides: ['mdDynSt'] },
            { kind: 'ram', name: 'MD_FW/MD_FW_FILTER', ...SLEW_TORQUE_RAM_READ, every: LATCHED_BIT_LANE_EVERY,
                provides: ['mdFw', 'mdFwFilter', 'mdLsDelta', 'mdDpDelta'] },
            // The additive half of long-term lambda learning — the store a stationary idle parks
            // its error in, which `laa_f` above cannot reach (its zone needs ML > 40 kg/h). Four
            // bytes in the OTHER RAM window, so it is its own exchange; the learner's time
            // constant is minutes, so the slowest lane loses nothing.
        ],
        // What a VE log was until this: both blocks, every sample, no claim about RAM addresses.
        // Slower and complete, which is the right thing to be wrong towards.
        // No RAM at all, deliberately — including the density cluster. The fallback exists for the
        // case where a RAM claim did not hold up on the car, and answering that by making a
        // DIFFERENT unproven RAM claim would defeat it. The density channels are a diagnostic
        // rather than a tuning input — the normalisation they feed is off by default and refuses
        // rather than guesses when they are absent — so a degraded run losing them costs a
        // comparison between seasons and nothing in the map. `verify:route` pins this.
        // Annotated for the same reason the fast list is: a run that fell back is still a run, and
        // in production it must record the same channel set. Narrowing this changes nothing — both
        // blocks carry tuning channels — which is the point of stating it rather than assuming it.
        fallback: [
            { ...block(3), provides: ['rpm', 'rawLoad', 'coolantTemp', 'exhaustTemp', 'rf', 'wdk1'] },
            { ...block(19), provides: ['stft1', 'stft2', 'tankVent', 'tankVentCheckState', 'tankVentDiag', 'lambdaFreeze'] },
        ],
        // The lambda trim is the whole input, and PATCH is what stops the DME hiding the error the
        // trim is supposed to reveal: k_rf_cfg turns MAP compensation off and K_LAA_TMOT_MIN stops
        // long-term adaptation learning around it.
        requires: ['PATCH'],
        produces: 'VE map (kf_rf_soll) and the KF_RF_KORR_DRREL evidence',
        runnable: true,
    },
    EGT: {
        id: 'EGT', label: 'EGT',
        // Block 3 alone. MEASURING rf_korr is `(rf/100) / rf_soll`, and every term is here.
        exchanges: [block(3)],
        requires: ['PATCH', 'TANK_VENT'],
        /**
         * NOT the table itself, and the difference is the correction to a claim this profile
         * carried when it was built.
         *
         * Measuring what the DME applied and deriving what it SHOULD apply are two calculations,
         * and only the first fits in block 3. The derivation is
         * `A(Δ)/A(0) = k_applied × STFT(Δ)/STFT(0)`: `k_applied` is `rf / rf_soll` and is here, but
         * STFT is the lambda trim, which lives in block 19 — the block this profile drops to go
         * 2.7× faster. Without it the ratio collapses to `k_applied(Δ)/k_applied(0)`, which is the
         * table already in the ECU. `tuneRfKorrTable` now returns null rather than hand that back.
         *
         * So what an EGT run is FOR is the evidence the derivation has been starved of: sustained
         * gate-open samples. The gate needs 55-80 % filling, which on this engine means pulling, and
         * pulls are short — session #901 managed 100 gate-open samples in 0.3-3.5 s stabs, every one
         * of them too brief for Δ to be anything but sensor lag. #903, at this profile's rate,
         * returned 476 across nine pulls of 3 s or more. That is the input the table needs; it is
         * just not the table.
         */
        produces: 'Retired — block 3 carries no lambda trim, so no correction table can come out of it',
        runnable: false,
    },
    INERTIA: {
        id: 'INERTIA', label: 'INERTIA',
        // Polled by startInertiaRun, not by the standard live poll — a different sample type
        // entirely. Listed here so the rate estimate and the chooser have one source of truth.
        //
        // It used to say `[83]`, which was left over from when the inertia run really did read the
        // EGAS freeze-frame. It has read block 3 plus a 40-byte RAM chunk since that block turned
        // out to be a latched fault frame rather than telemetry, so the rate estimate has been
        // describing an exchange the run does not make — and overestimating it by about 1.8x, which
        // is exactly the kind of number that gets read as "the app is slow" during a drive.
        exchanges: [block(3), { kind: 'ram', name: 'MD_DYN_ST..MD_IND_NE', ...INERTIA_RAM_READ }],
        // None. The estimate reads torque and speed gradient, which the patches do not touch.
        requires: [],
        produces: 'Flywheel inertia estimate and a calibration proposal',
        runnable: true,
    },
};

/** Which processes a log could belong to, judged only on the channels it actually carries.
 *
 *  Used to label an imported or reopened log rather than to permit anything — the permitting is
 *  done by the data being absent. A CSV from another tool has no `process` recorded anywhere, and
 *  this is the honest way to say what it can be used for. */
export function processesSupportedBy(hasTrim: boolean, hasRf: boolean): ProcessId[] {
    const out: ProcessId[] = [];
    if (hasTrim && hasRf) out.push('VE');
    if (hasRf) out.push('EGT');
    return out;
}

/** What the ECU is holding, as the hub already derives it from the loaded binary. */
export interface ArmedPatches {
    patched: boolean;
    tankVentShut: boolean;
}

/**
 * Which of this profile's prerequisites are not in the ECU.
 *
 * Reported, not enforced. The same reasoning the lineage check states out loud — overridable
 * deliberately, because there are legitimate reasons to run without one (comparing against a purge
 * window on purpose, for instance) and a check that cannot be overridden gets worked around instead
 * of heeded. What it must never be is silent, and a run costs a drive to repeat.
 */
export function missingPatches(profile: LogProfile, armed: ArmedPatches): RequiredPatch[] {
    return profile.requires.filter(r =>
        (r === 'PATCH' && !armed.patched) || (r === 'TANK_VENT' && !armed.tankVentShut));
}

/**
 * Which campaign shape the next WRITE belongs to.
 *
 * DERIVED, never stored — the same rule `idleAction` follows, and for the same reason. A stored
 * "route" would be a second answer to a question `rfKorrSource` and `writeRfKorr` already answer,
 * and the two could disagree. Here the route is a NAME for a combination the operator has already
 * chosen by other means, which is why picking it is impossible and getting it wrong is too.
 *
 *   CONSERVATIVE  VE map only. BMW's correction table is left exactly as it is — the safest
 *                 workflow there is, and the one that needs no EGT run at all.
 *   A1            The correction table alone, no VE map. First half of the sequential campaign.
 *   A2            VE map only, on a BASE whose table this campaign already replaced. Second half.
 *   B             Both together, with the VE map divided by k_new. One flash slot instead of two,
 *                 at the cost of depending on a division that no car has yet checked.
 *   NONE          Nothing has been derived, so there is nothing to write.
 */
export type RouteId = 'CONSERVATIVE' | 'A1' | 'A2' | 'B' | 'NONE';

export function deriveRoute(input: {
    process: ProcessId;
    /** Is the back-calculated KF_RF_KORR_DRREL armed for writing? */
    writeRfKorr: boolean;
    /** Has a VE map been derived from this session's log? */
    hasVeMap: boolean;
    /** The process of the session this one's BASE came from, if any. */
    parentProcess?: ProcessId;
}): RouteId {
    const { process, writeRfKorr, hasVeMap, parentProcess } = input;
    if (process === 'INERTIA') return 'NONE';
    if (process === 'EGT') return writeRfKorr ? 'A1' : 'NONE';
    if (!hasVeMap) return 'NONE';
    if (writeRfKorr) return 'B';
    return parentProcess === 'EGT' ? 'A2' : 'CONSERVATIVE';
}

/** Does this route rest on the k_new division that has never been checked on a car? */
export function routeNeedsUnverifiedDivision(route: RouteId): boolean {
    return route === 'B';
}
