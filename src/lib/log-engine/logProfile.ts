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
 * The EGT process is the point of the exercise. Measuring `rf_korr` is `(rf/100) / rf_soll`, all of
 * which is in block 3 — the lambda trim contributes nothing to it. Reading block 19 anyway costs
 * 113 ms of every sample to fetch four bytes that go unused, which is why the run that is currently
 * blocked on evidence has been collecting it at 2.4 Hz instead of 11.
 *
 * ## Why the channel list is the enforcement
 *
 * Nothing here forbids anything. An EGT log simply has no `la_f_regler`, so no VE map can be built
 * from it — not because a flag says so but because the number is not there. `isFieldPresent` and
 * the parser's own requirement already work this way, and leaning on that is what stops this from
 * becoming a second gating mechanism that can disagree with the first.
 */

/** Milliseconds of wire time for one exchange with a block of `payload` bytes, at 9600 8E1.
 *
 *  8E1 is 11 bits per byte, so 1.1458 ms each. A request is 5 bytes and a response is the payload
 *  plus 4 of framing; on a half-duplex K-line both cross the same wire, so they add. */
const WIRE_MS_PER_BYTE = 11 / 9600 * 1000;
const REQUEST_BYTES = 5;
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
 * It is the floor this whole exercise runs into: at 100 ms of thinking against 50 ms of wire, the
 * DME is two thirds of a block-3 sample. Dropping a block beats shaving bytes, and nothing short of
 * leaving DS2 behind beats dropping a block.
 */
export const DME_TURNAROUND_MS = 100;

export interface BlockCost { selection: number; payload: number }

export const BLOCK_COST: Record<number, BlockCost> = {
    3: { selection: 3, payload: 35 },
    19: { selection: 19, payload: 90 },
    83: { selection: 83, payload: 52 },
};

/** Expected samples per second for a set of blocks, wire and turnaround only.
 *
 *  Deliberately excludes host time: after W4 the derivation is O(1) per sample and runs off the
 *  poll path, so if the measured rate falls short of this the difference is the link, not the app.
 *  Shown next to the measured rate during a run precisely so that gap is visible. */
export function expectedHz(selections: number[]): number {
    const ms = selections.reduce((total, sel) => {
        const block = BLOCK_COST[sel];
        if (!block) return total;
        return total + (REQUEST_BYTES + RESPONSE_OVERHEAD + block.payload) * WIRE_MS_PER_BYTE
            + DME_TURNAROUND_MS;
    }, 0);
    return ms > 0 ? 1000 / ms : 0;
}

export type ProcessId = 'VE' | 'EGT' | 'INERTIA';

/** A patch this run needs in the ECU before it means anything. Checked BEFORE the run, because
 *  finding out afterwards costs a drive. */
export type RequiredPatch = 'PATCH' | 'TANK_VENT';

export interface LogProfile {
    id: ProcessId;
    label: string;
    /** DS2 selections polled per sample, in order. Empty for a process that does not use the
     *  standard live poll — see INERTIA, which has its own sample type. */
    blocks: number[];
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
}

export const LOG_PROFILES: Record<ProcessId, LogProfile> = {
    VE: {
        id: 'VE', label: 'VE',
        blocks: [3, 19],
        // The lambda trim is the whole input, and PATCH is what stops the DME hiding the error the
        // trim is supposed to reveal: k_rf_cfg turns MAP compensation off and K_LAA_TMOT_MIN stops
        // long-term adaptation learning around it.
        requires: ['PATCH'],
        produces: 'VE map (kf_rf_soll)',
    },
    EGT: {
        id: 'EGT', label: 'EGT',
        // Block 3 alone. MEASURING rf_korr is `(rf/100) / rf_soll`, and every term is here.
        blocks: [3],
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
        produces: 'Sustained gate-open evidence for the EGT correction (needs a VE run to derive)',
    },
    INERTIA: {
        id: 'INERTIA', label: 'INERTIA',
        // Polled by startInertiaRun, not by the standard live poll — a different sample type
        // entirely. Listed here so the rate estimate and the chooser have one source of truth.
        blocks: [83],
        // None. The estimate reads torque and speed gradient, which the patches do not touch.
        requires: [],
        produces: 'Flywheel inertia estimate and a calibration proposal',
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
