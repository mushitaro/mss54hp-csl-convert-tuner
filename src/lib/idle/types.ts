/**
 * What the idle feedforward corrector measures, and what it refuses to measure.
 *
 * Shaped after `ve-calculator/rfKorrTuner.ts`: one options struct with an undefined-safe merge, a
 * named rejection for every way a sample or a cell can fail, and counters that are reported per
 * reason rather than summed. The reasons are the product as much as the correction is — a run that
 * produces nothing has to say which gate ate the evidence, or the next drive repeats the mistake.
 *
 * One structural difference from every other tuner here: this one bins **dwells**, not samples. A
 * steady state is a property of a window, and the statistic being estimated is where an integrator
 * with a 5.12 s time constant settles. A per-sample census would count points on a ramp.
 */

import { expectedHz, LOG_PROFILES } from '@/lib/log-engine/logProfile';

/**
 * How much of a dwell window the DME has to have actually answered.
 *
 * `minDwellSamples` exists to catch a window the link only half filled — a run where reads were
 * refused or the port stalled. It does NOT exist to encode a sample rate, and that distinction is
 * the reason it is derived here instead of written down.
 *
 * It was 60 against a 20 s dwell when the idle profile ran at 4.13 Hz, which is 73 % of the 82
 * samples such a window then held. As the profile took on the section 7.1 preconditions and then
 * the torque reserve, the rate fell to just under 3 Hz — at which point a flat 60 stops meaning
 * "mostly answered" and starts meaning "hold it for 21 seconds", reported as `thin-count`. That
 * message names the DME as the culprit for what is really an arithmetic collision between two
 * constants, and a rejection reason that points at the wrong thing is worse than no reason.
 *
 * So the fraction is the constant and the count follows the profile. Add an exchange and this
 * number moves with it.
 */
export const IDLE_DWELL_COMPLETENESS = 0.73;

/** The sample count a dwell of `dwellSec` needs, at whatever rate the IDLE profile currently runs. */
export function minDwellSamplesFor(dwellSec: number): number {
    return Math.ceil(dwellSec * expectedHz(LOG_PROFILES.IDLE.exchanges) * IDLE_DWELL_COMPLETENESS);
}

/** Every way a sample, a dwell or a cell can fail to become evidence. */
export type IdleRejectReason =
    // --- sample level ------------------------------------------------------------------------
    | 'not-warm'
    | 'off-target'
    | 'target-moving'
    | 'throttle-open'
    | 'not-ll'
    | 'compressor'
    | 'electrical-load'
    | 'no-measurement'
    // --- dwell level -------------------------------------------------------------------------
    | 'too-short'
    | 'thin-count'
    | 'unsteady'
    | 'integrator-drifting'
    | 'adaptation-moved'
    | 'ndiff-reset'
    | 'integrator-railed'
    | 'duty-railed-low'
    | 'duty-railed-high'
    | 'limp-branch'
    /** No `ML_SOLL_LLS` in the window, so there is no row to bin onto. `KF_LLS_TV` is indexed on
     *  the air request, not on coolant, so this is as fatal as a missing `MD_LLRI`. */
    | 'no-air-request'
    /** The duty the DME ran does not match `KF_LLS_TV` interpolated at this operating point.
     *  Every way that happens is a way the retarget could be wrong — see valveModel.ts. */
    | 'model-disagrees'
    // --- cell level --------------------------------------------------------------------------
    | 'no-evidence'
    | 'single-dwell'
    | 'stall-column'
    | 'cold-row'
    | 'authority-floor-row'
    | 'below-authority-floor'
    | 'sub-quantum';

export type IdleRejectCounts = Record<IdleRejectReason, number>;

export const EMPTY_IDLE_REJECTS: IdleRejectCounts = {
    'no-air-request': 0, 'model-disagrees': 0,
    'not-warm': 0, 'off-target': 0, 'target-moving': 0, 'throttle-open': 0, 'not-ll': 0,
    compressor: 0, 'electrical-load': 0, 'no-measurement': 0,
    'too-short': 0, 'thin-count': 0, unsteady: 0, 'integrator-drifting': 0,
    'adaptation-moved': 0, 'ndiff-reset': 0, 'integrator-railed': 0,
    'duty-railed-low': 0, 'duty-railed-high': 0, 'limp-branch': 0,
    'no-evidence': 0, 'single-dwell': 0, 'stall-column': 0,
    'cold-row': 0, 'authority-floor-row': 0, 'below-authority-floor': 0, 'sub-quantum': 0,
};

export interface IdleTuneOptions {
    // --- warm (DETECTABLE, block 3) ------------------------------------------------------------
    minCoolantC: number;
    maxCoolantC: number;
    // --- on target (DETECTABLE, block 3 offsets 0 and 2) ---------------------------------------
    maxSpeedErrorRpm: number;
    maxNSollDriftRpm: number;
    // --- throttle closed (DETECTABLE, block 3 offset 27) ---------------------------------------
    maxThrottlePct: number;
    // --- the DME's own answer (DETECTABLE only on the RAM profile) -----------------------------
    requireLlBit: boolean;
    // --- compressor (DETECTABLE only on the RAM profile) ---------------------------------------
    excludeCompressor: boolean;
    compressorLockoutSec: number;
    // --- electrical load (PARTIALLY detectable, via ub stability) ------------------------------
    maxUbDriftV: number;
    // --- the adaptation confound ---------------------------------------------------------------
    useAdaptationSum: boolean;
    maxAdaptDriftNm: number;
    adaptSettleSec: number;
    // --- dwell ----------------------------------------------------------------------------------
    /** How long a bridgeable excursion may last before it cuts the window. See findDwells. */
    maxExcursionSec: number;
    dwellSec: number;
    minDwellSamples: number;
    maxMdLlriDriftNm: number;
    maxStatDisagreeNm: number;
    // --- rails (DIAGNOSIS, not limits) ----------------------------------------------------------
    railToleranceNm: number;
    railToleranceDutyPct: number;
    // --- the correction ---------------------------------------------------------------------------
    gainKgHPerNm: number;
    gainRefRpm: number;
    gainMin: number;
    gainMax: number;
    stepFraction: number;
    /** Cap on one pass's move, in DUTY per cent — the unit `KF_LLS_TV` is written in. */
    maxStepPct: number;
    /** How far the measured duty may sit from the map before the dwell is refused. Generous: a PT1
     *  filter, a battery-voltage term and two clamps sit between the map and the pin, and none of
     *  them is modelled. This asks "is this the right map", not "is this the exact byte". */
    maxModelDeltaPct: number;
    minCellDwells: number;
    minCellSamples: number;
    /**
     * GONE, and the note is the point: there were `maxOffsetFrac` and `minRpmTolerance` here, which
     * refused a dwell that sat too far from the breakpoint it was binned onto.
     *
     * They implemented a design that binned each dwell onto ONE cell, and this car cannot satisfy
     * it: it idles at 880 rpm against breakpoints at 800 and 950, so every dwell it will ever
     * produce sat 0.467 of a span away and was refused. The fix was not a looser tolerance — see
     * `lookupNodes`. A dwell is now evidence for every cell the DME reads it from, weighted, so
     * there is no "off" a breakpoint to be.
     */
    minTmotTolerance: number;
    qvsFloorFrac: number;
    qvsCeilingFrac: number;
    writeStallColumn: boolean;
    writeColdRows: boolean;
    targetFromBinary: boolean;
}

/**
 * Defaults, each with the reason it is that number rather than a round one.
 *
 * Where a threshold has a counterpart in the DME's own calibration, it is that counterpart or a
 * stated margin inside it. Inventing a number when the ECU already contains one is how a gate ends
 * up describing the tool's assumptions instead of the engine's behaviour.
 */
export const IDLE_TUNE_DEFAULTS: IdleTuneOptions = {
    /**
     * The FALLBACK only — `readIdleTables` supplies `K_LFR_TMOT_ADAPT` from the loaded binary and
     * that wins. See `IdleTables.adaptTmotC`.
     *
     * It was 80, taken from `KF_LLR_QVS_GRUND`'s y[4] COOLANT breakpoint so a dwell binned onto the
     * row it would be written to. That map is dead and `KF_LLS_TV` has no coolant axis — its y is
     * air demand, and a cooler engine asks for more air and lands on a higher row by itself. The 80
     * survived the retarget as a leftover and cost a whole run: session #937 never rose above
     * 77 degC and all 1080 of its samples were refused `not-warm`.
     */
    minCoolantC: 70,
    /** Above this KL_LFR_N_TOG starts lifting the target on oil temperature. */
    maxCoolantC: 105,
    /** Half of LLSync's own K_LL_DN_MAX (50 rpm). K_LFR_DN_EINGEREGELT is 200 rpm, which is the
     *  DME's "settled" flag and is far too loose to call a steady state. */
    maxSpeedErrorRpm: 25,
    /** The target itself must be still. This one gate replaces the post-start ramp lockout, the
     *  safety-concept target, the DS2-test target and the oil-temperature lift, because every one
     *  of those moves llr_n_soll and none of them moves it by less than 5 rpm. */
    maxNSollDriftRpm: 5,
    /** KL_BZ_WDK_LL is 1.2 % at every rpm with 0.2 % hysteresis, so 1.0 IS the LL/TL boundary in
     *  this calibration. 0.8 leaves a margin inside it. */
    maxThrottlePct: 0.8,
    requireLlBit: true,
    excludeCompressor: true,
    /** The load arrives through K_MD_MIN_KKOS_FILTER over ~5.1 s and leaves in ~0.066 s, so the
     *  disturbance outlives the flag by seconds in one direction only. 12 covers it either way. */
    compressorLockoutSec: 12.0,
    /** Relative, so it survives a wrong ub scale: what matters is that the voltage did not MOVE. */
    maxUbDriftV: 0.3,
    useAdaptationSum: true,
    maxAdaptDriftNm: 0.5,
    adaptSettleSec: 45,
    /** A settle wait of ~20 s. Chosen as four times 5.12 s, which was believed to be the idle
     *  integrator's time constant and is not — K_LFR_TAU_IA1 is only read in LFR_ZUSTAND 8, where
     *  LFR_MDI has already been zeroed, and the idle rate is the KF_LFR_DQI map. The NUMBER is
     *  kept because it is the right order of magnitude for a settle wait and changing it would
     *  invalidate every stored session; the JUSTIFICATION is withdrawn. The "3 s in one direction
     *  is a feedforward error" note is the DETECTION threshold; this is what it takes to put a
     *  number on it. */
    /**
     * Under half of the 5.12 s settle constant above — see that note for why the constant is a
     * heuristic rather than the ECU's idle time constant.
     *
     * Session #936 is 169 s of unbroken warm idle that the detector cut into eight windows, because
     * 12 samples of ordinary governor wander crossed `maxSpeedErrorRpm`. Five of the eight were then
     * too short to count. The excursion is not a different steady state — the governor moving off
     * target IS the governor working — and the whole-window drift bound still decides steadiness, so
     * this only decides whether to CUT.
     */
    maxExcursionSec: 2.0,
    dwellSec: 20.0,
    minDwellSamples: minDwellSamplesFor(20.0),
    maxMdLlriDriftNm: 3.0,
    /** Trimmed mean against median. They disagree when the window contains an EVENT — a
     *  K_LFR_NDIFF_RESET zeroing, a split read — rather than a steady state. */
    maxStatDisagreeNm: 2.0,
    railToleranceNm: 0.5,
    railToleranceDutyPct: 1.0,
    /** Physics, at 780 rpm with eta_i = 0.25: w * AFR * 3600 / (LHV * eta) = 0.397. Deliberately
     *  below the 0.47-0.56 the operating point itself implies, because too small costs one extra
     *  pass and too large over-corrects into the direction this DME recovers from worst. */
    gainKgHPerNm: 0.40,
    gainRefRpm: 780,
    /** eta_i in [0.10, 0.45] bounds it to [0.22, 0.99] at idle; widened because the gain also
     *  absorbs the Momentenmanager's torque-to-air realisation error, which is not unity and is not
     *  knowable statically. That unknowability is exactly why it is learned rather than computed. */
    gainMin: 0.15,
    gainMax: 1.20,
    stepFraction: 0.5,
    /**
     * Three per cent of duty, which at the idle cell is about a third of the way from the stock
     * 20.7 % to the K_LLS_TV_MIN rail at 14 %. The map stores x/50, so this is 150 raw steps — the
     * cap is about how far one pass may move the car, not about the map's resolution.
     */
    maxStepPct: 3.0,
    /**
     * Two per cent of duty. The voltage term is `(TV - K_LLS_TV_DREHPUNKT) * KL_LLS_UB_KORR(UB)`
     * and is zero at nominal, so on a settled warm dwell with a healthy battery the residual is a
     * fraction of a per cent; a live KATH blend puts the measured duty percent above the map by
     * several, which is what this has to separate.
     */
    maxModelDeltaPct: 2.0,
    /** Two INDEPENDENT dwells. One dwell of 120 samples is one observation of the operating point
     *  repeated 120 times, which is a different thing from two observations. */
    minCellDwells: 2,
    minCellSamples: 120,
    minTmotTolerance: 5,
    qvsFloorFrac: 0.70,
    qvsCeilingFrac: 1.50,
    /** The 500 rpm column runs 30.0 kg/h against the warm row's 14.0 — it is the stall catch, not a
     *  calibration error, and warm-idle evidence says nothing about it. */
    writeStallColumn: false,
    /** Writing a cold row from warm evidence is how a warm measurement becomes a cold-morning
     *  stall. It also leaves KF_LLS_TV_KATH's shared request alone. */
    writeColdRows: false,
    targetFromBinary: true,
};

/**
 * Undefined-safe merge.
 *
 * Copied deliberately rather than reached for from `rfKorrTuner`, because the bug it exists to
 * prevent is worth having twice: `{ ...DEFAULTS, ...partial }` writes `undefined` over a default
 * when the caller assembles its options object unconditionally from optional config fields, and
 * `count < undefined` is `false`, so every gate silently passes. `tsconfig` has `strict` but not
 * `exactOptionalPropertyTypes`, so nothing complains.
 */
export function withDefaults(partial?: Partial<IdleTuneOptions>): IdleTuneOptions {
    const out = { ...IDLE_TUNE_DEFAULTS };
    if (!partial) return out;
    for (const [k, v] of Object.entries(partial)) {
        if (v !== undefined) (out as Record<string, unknown>)[k] = v;
    }
    return out;
}

/** One accepted or rejected steady window. The unit the census bins. */
export interface IdleDwell {
    startIndex: number;
    endIndex: number;
    durationSec: number;
    samples: number;
    /** Where this evidence SAT. With `mlSollLlsMean` it is the operating point the correction is
     *  distributed from — see `lookupNodes` — and the point the gain's slope is evaluated at. */
    rpmMean: number;
    tmotMean: number;
    /**
     * `ML_SOLL_LLS` over the dwell, kg/h — the row `KF_LLS_TV` is indexed on.
     *
     * The correction moved to that map when `cfg_m.egas = 0x00` settled that `KF_LLR_QVS_GRUND`'s
     * output has no reader (see seal.ts). Coolant is no longer an axis: the map has none, and cold
     * idle separates itself by demanding more air, which is a row rather than a column.
     */
    mlSollLlsMean: number | null;
    /**
     * Measured duty minus `KF_LLS_TV(rpm, ml_ll)`, %. Null when a channel was missing.
     *
     * The gate that makes the first capture worth taking, and the one number that would refute the
     * whole retarget. Kept on the dwell even when it passes, because "they agreed to 0.3 %" is the
     * evidence that the chain is real and is worth more than the absence of a rejection.
     */
    modelDeltaPct: number | null;
    /** The statistic, computed two robust ways that have to agree. */
    mdLlriTrimmedMean: number;
    mdLlriMedian: number;
    mdLlriDrift: number;
    /** Spread of the quantity actually being measured across the dwell — the sum when the sum
     *  is in use. This is what steadiness means here; mdLlriDrift is reported alongside it
     *  because a pinned integrator next to a moving sum is itself worth seeing. */
    errorDrift: number;
    mdLlraMean: number;
    mdLlraDrift: number;
    llsTvMean: number | null;
    /**
     * The four window statistics the gates compare against, kept on the dwell rather than recomputed.
     *
     * They were locals inside the detector, which meant the LIVE rack could only show them by
     * computing them a second time — and a bar that says "inside" beside a census that refused the
     * window for exactly that gate is worse than no bar. Reported whether or not the gate they feed
     * is the one that fired, because "the voltage was steady" is worth seeing on a window refused
     * for something else.
     */
    /** Spread of `ub` across the window, V — a load being SWITCHED. */
    ubDrift: number;
    /** |mean(ub) - the run's resting ub|, V — a load that was on for this whole window. */
    ubOffset: number;
    /** Spread of `n_soll`, rpm. The target itself moving. */
    nSollDrift: number;
    /** |trimmed mean - median| of md_llri, Nm. An EVENT rather than a steady state. */
    statDisagree: number;
    /** `mdLlri + (useAdaptationSum ? mdLlra : 0) - idleTargetNm`, Nm. Positive = needs more air. */
    error: number;
    rejected: IdleRejectReason | null;
}

export interface IdleCellResult {
    row: number;
    col: number;
    rpm: number;
    tmot: number;
    stock: number;
    /** What will be written. Equals `stock` when the cell was rejected. */
    tuned: number;
    /** The uncorrected request, before the step limit, the clamps and the quantiser. Kept so the
     *  difference between "the log said this" and "this is what fits in the map" stays visible. */
    rawTarget: number;
    dwells: number;
    samples: number;
    errorNm: number;
    rejected: IdleRejectReason | null;
    /** True when the only thing stopping a write is that the map cannot express the step. */
    converged: boolean;
}

export interface IdleTuneReport {
    samplesSeen: number;
    samplesAdmitted: number;
    dwellsFound: number;
    dwellsAccepted: number;
    cellsUpdated: number;
    cellsConverged: number;
    rejects: IdleRejectCounts;
    /** The largest |error| across accepted dwells, Nm — the headline "how far out is it". */
    worstErrorNm: number;
    /** True when any sample showed the limp branch. Fatal to the whole run, not to a dwell. */
    limpSeen: boolean;
    /** True when any accepted dwell's integrator was parked on a clamp. */
    integratorRailed: boolean;
    /** The gain the proposal was computed with, and where it came from. */
    gainUsed: number;
    gainLearned: boolean;
    /** Whichever md_llri source the samples carried. Mixed sources in one run is itself a finding. */
    source: 'ram' | 'block19' | 'mixed' | 'none';
}

export interface IdleTuneResult {
    /** KF_LLR_QVS_GRUND as loaded, and as proposed. Both on the binary's own axes. */
    stock: number[][];
    tuned: number[][];
    rpmAxis: number[];
    tmotAxis: number[];
    cells: IdleCellResult[][];
    dwells: IdleDwell[];
    report: IdleTuneReport;
    /** The target the errors were measured against, Nm. Recorded because it comes from the binary
     *  and a session reopened against a different BASE must not silently reinterpret its own
     *  numbers. */
    targetNm: number;
    /** Every writable cell is within one quantisation step of where it wants to be. */
    converged: boolean;
    /** Whether this is worth writing at all. */
    acceptable: boolean;
}
