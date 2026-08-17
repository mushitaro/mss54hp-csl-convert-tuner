// The census lives with the gates that produce it rather than here, so the reason list and the
// rules that assign a reason cannot drift apart. Type-only, so this stays a leaf import.
import type { DropCensus } from '@/lib/log-engine/lambdaGates';
import type { FilterResume } from '@/lib/log-engine/filter';

export interface VEMap {
    xAxis: number[]; // RPM
    yAxis: number[]; // Load
    data: number[][]; // VE Values
}

export interface BinaryConfig {
    mapCorrection: boolean; // k_rf_cfg
    tempLimit: number; // K_LAA_TMOT_MIN
}

export interface LogDataPoint {
    time: number;
    rpm: number;
    rawLoad: number; // relativer Oeffnungsquerschnitt
    correctedLoad?: number; // AQ_REL_ALPHA_N (calculated)
    /**
     * `la_f_regler1/2` — the lambda controller's output factor, per bank.
     *
     * ONE pair, where there used to be two. `lambda1/lambda2` held the same numbers under a name
     * that promised a measured lambda — which Testo puts on the sensor VOLTAGE, a different channel
     * on a different block — and existed only to record whether the source physically carried the
     * column. `undefined` says that directly, so the second pair is gone.
     *
     * Optional for the same reason it is on LiveMeasurement: an EGT run never reads block 19, and
     * a bank a CSV did not carry is absent rather than copied. The VE correction averages whichever
     * banks are present and refuses a sample with none.
     */
    stft1?: number;
    stft2?: number;
    coolantTemp?: number; // [UPDATED] Optional
    correctionFactor?: number; // [NEW] For debugging validation

    /** TABG — exhaust gas temperature (degC). DS2 selection 3, payload byte 14, 16 degC/LSB, so
     *  this is coarse: it is a monitoring and gating channel, not a precision measurement. */
    exhaustTemp?: number;
    /** RF — the DME's final relative filling (%), AFTER the EGT correction rf_korr has been applied
     *  to the Alpha-N table's rf_soll. DS2 selection 3, payload bytes 8-9. */
    rf?: number;
    /** WDK1 — throttle plate 1 position (%). DS2 selection 3, payload bytes 27-28, free.
     *
     *  A gate input rather than a gauge: FR 5.01 x.2.3.2 switches the lambda controller off at full
     *  load, so a sample taken above the WOT threshold carries a trim that is not controlling
     *  anything. Until this channel existed the log had no way to tell. */
    wdk1?: number;

    // --- tank ventilation -------------------------------------------------------------------
    // Free: DS2 selection 19, the same response stft1/stft2 already come out of.
    //
    // These exist because evaporative purge is the largest known threat to a VE log's
    // reproducibility, and this pipeline had no way to see it. Purged vapour is fuel the DME did
    // not inject, so `stft1`/`stft2` — the only input the VE correction is derived from — absorb
    // it; and the DME's own purge estimate is subtracted from the air mass, so `rf` moves too.
    // Stock duty is 94-99.6 % above 2500 rpm at mid load, i.e. squarely in the tuning region.

    /** TETV — tank-vent valve pulse time (ms). 0 = shut, which is the state a tuning run wants.
     *  Undefined = this DME did not report it, which is NOT the same as shut. */
    tankVent?: number;
    /** TEFC_LL_ST — tank-vent idle functional-check state. States 0x10-0x15 drive the valve from
     *  the TEFC ramp instead of the duty map, and are the one path `K_TE_TVTE_GA = 0` does not
     *  gate. Logged so that gap can be measured rather than assumed closed. */
    tankVentCheckState?: number;
    /** TEFC_ED — tank-vent diagnostic handle. Watch it after disabling purge: DTC 24 is exactly
     *  the code a permanently-shut valve would set. */
    tankVentDiag?: number;
    /** LA_FREEZE_FLAG — DS2 selection 19, payload byte 89. Recorded and never interpreted: the
     *  symbol appears only in the reference catalog and the Funktionsrahmen's lambda module has no
     *  "freeze" in it, so nothing may gate on this until a car establishes what it is. */
    lambdaFreeze?: number;
    /** rf_korr — the EGT density correction the DME applied, measured rather than looked up:
     *  with MAP compensation off (k_rf_cfg = 0x02) the DME computes RF = rf_soll * rf_korr exactly,
     *  so rf_korr = (rf/100) / kf_rf_soll(rpm, correctedLoad). 1.0 = no correction.
     *  Only populated when `rf` is present AND the Alpha-N interpolation is non-zero. */
    rfKorr?: number;
    /** rf_soll — this app's interpolation of the Alpha-N table at (rpm, correctedLoad), i.e. the
     *  denominator `rfKorr` was measured against. Surfaced because it is what decides whether the
     *  correction's load gate was open, and because a wrong one falsifies rf_korr silently. */
    rfSoll?: number;

    // --- The EGT cross-check pair ---------------------------------------------------------------
    // Two independent routes to the same physical quantity. Agreement means DS2 offsets 8 and 14,
    // the catalog addresses, kf_rf_tabg_modell's interpretation and the RF/rf_soll measurement are
    // ALL correct at once; disagreement localises the fault. This is karter16's Option 2 (log TABG,
    // do the maths) running alongside this app's direct measurement (RF / rf_soll).

    /** tabg_delta — `kf_rf_tabg_modell(rpm, RF) − TABG`, clipped at 0, in °C. The DME's own Y-axis
     *  input to KF_RF_KORR_DRREL. Computed once here so the table tuner and the VE calculation can
     *  never disagree about which row of that table a sample belongs to. Present only when the log
     *  carries an exhaust temperature AND the binary's tables could be read. */
    tabgDelta?: number;

    /** Exhaust temperature implied by the MEASURED rf_korr: invert KF_RF_KORR_DRREL along Δ, then
     *  subtract from kf_rf_tabg_modell. Compare against `exhaustTemp`; the residual is in °C.
     *  Sparse by nature — only ~45 % of the rpm axis has an invertible profile, and k = 1.000
     *  pins Δ no better than [0, 30] — so most rows are legitimately blank. See egtTables.ts. */
    egtFromRfKorr?: number;
    /** rf_korr implied by the MEASURED exhaust temperature: Δ = model − TABG, then look the table
     *  up. Compare against `rfKorr`; the residual is dimensionless. Populated whenever the log
     *  carries `exhaustTemp` and `rf`, including where the gate was shut (in which case it is
     *  1.000, because that is what the DME applied). */
    rfKorrFromEgt?: number;
}

export interface ProcessedLog {
    fileName: string;
    data: LogDataPoint[];
    validCount: number;
    droppedCount: number;
    /** The same total, broken out by reason. `droppedCount` says how much of the drive was thrown
     *  away; this says what to do about it. See lambdaGates.ts for the reason list and the rule
     *  that decides which one a sample gets when several apply. */
    dropCensus: DropCensus;
    /** Hand this back to `processLogData` with the same log to continue instead of starting again.
     *  See FilterResume — it is what makes a live run cost the samples that arrived rather than the
     *  samples so far. */
    resume: FilterResume;

    /**
     * The samples the rf_korr TABLE derivation is allowed to see — a different set from `data`, on
     * purpose.
     *
     * `data` is filtered for the VE map, which needs the lambda loop to have converged, so the
     * transient test throws away everything that is still accelerating. That is correct for VE and
     * fatal for rf_korr: the DME only applies the correction above 55-80 % filling, which on this
     * engine only happens while the car is pulling. Measured on a real drive, the transient test
     * removed 97 % of the samples where the DME's gate was open (100 in the raw log, 3 survived) —
     * so the table was being derived from the one region where the correction is provably inactive.
     *
     * This set therefore skips the transient test and keeps everything else: the same coolant, idle
     * and cat-protection prerequisites, and the same `correctedLoad`. Selecting more samples is not
     * the same as trusting them — rfKorrTuner applies its own gate and settling requirements on top,
     * and rejects far more than this hands it.
     */
    rfKorrData: LogDataPoint[];
}

export interface LogFilterConfig {
    enableCorrection: boolean; // Default: true. Set false if CSV is already processed.
    enableMinTemp: boolean;
    minTemp: number;         // Default: 65 (Water Temp > 65)

    enableIdle: boolean;
    idleRpm: number;         // Default: 1000 (Exclude < 1000 RPM & RawLoad=0)

    enableTransient: boolean;
    /**
     * @deprecated Superseded by `transientSettleSec`. Kept because every session ever saved carries
     * it, and re-deriving one of those has to reproduce the map it stored. See resolveTransientWindow.
     */
    transientWindow: number; // Frames to look back
    rpmStableThreshold: number; // Default: 10 (% Change)
    tpsStableThreshold: number; // Default: 5 (Absolute Change in RO)

    /**
     * How long the lambda trim is given to arrive before a sample counts, in SECONDS.
     *
     * The thing being waited for is the DME's, not the app's. `la_f_regler` is an integrator whose
     * gain the calibration states in 1/sec (KF_LA_KI_POS: 0.0305-0.0488, i.e. roughly 3-5 % per
     * second), so a 5 % error takes about a second to absorb and a 10 % error about two. That
     * duration is a property of the car and does not change.
     *
     * `transientWindow` expressed the same wait as a COUNT OF SAMPLES, which does change: four
     * frames is 1.36 s at the VE profile's measured 2.95 Hz and 0.61 s at the 6.6 Hz of the retired
     * EGT profile. Same setting, same car, less than half the wait — and because the test is a raw
     * difference with no division by dt, the faster log also tolerated roughly 2.2x the rpm slope
     * before calling a sample transient. Nothing about the DME had changed.
     *
     * So the wait is stored in seconds and converted per log at its own measured rate. That keeps
     * reproduction exact — a log's rate is a property of that log, so re-opening it converts to the
     * same number of samples — while keeping the wait matched to what it is waiting for.
     */
    transientSettleSec?: number;

    // --- Open-loop exclusion ---------------------------------------------------------------
    // The VE correction consumes `stft` = la_f_regler, the DME's own lambda INTEGRATOR. That
    // number only carries information while the lambda controller is closed. When the controller
    // is off the integrator is frozen at its last value, and folding a frozen value into the map
    // moves cells for no reason. These fields drop the samples where the 0401 binary says the
    // loop is open. All optional: sessions saved before this existed simply lack them, and the
    // `??` defaults below restore the previous behaviour where that matters.

    /** Master switch for the cat-protection exclusion. Default true. */
    enableOpenLoopExclusion?: boolean;
    /** TABG at which cat-protection enrichment arms (K_TI_KATS_TABG_EIN = 850 degC in the 0401
     *  calibration). Once ti_f_kats leaves 1.0 the lambda controller is deactivated outright —
     *  FR 4.01 §1.2.4: "Sobald der Katschutzfaktor > 1.0 ist ... wird die Lambdaregelung
     *  deaktiviert." */
    katsTabgOn?: number;
    /** TABG below which the enrichment starts unwinding (K_TI_KATS_TABG_AUS = 840 degC). */
    katsTabgOff?: number;
    /** Seconds to keep excluding after TABG falls back below `katsTabgOff`. The integrator ramps
     *  at KL_TI_KATS_DELTA_ML = 0.0195/s and has up to 0.3496 of travel (K_TI_F_KATS_MAX), so it
     *  needs ~18 s to reach 1.0 again — and lambda stays open for all of it. Default 20. */
    katsTailSec?: number;

    // --- Tank-ventilation exclusion ---------------------------------------------------------
    // A different failure from the one above, needing the same remedy. Cat protection makes the
    // trim MEANINGLESS (the controller is off). Purge makes it MISLEADING: the controller is
    // perfectly closed and doing its job, and the trim it reports is a true correction for fuel
    // the engine really received — just not fuel this app injected or can model. Folding it into
    // the map moves cells to compensate for vapour that will not be there next time.
    //
    // karter16, thread 242281 #161, on why this matters more than it sounds: "in my experience
    // this makes a MASSIVE difference to reproducibility, to the point that I personally wouldn't
    // bother attempting tuning runs without it."
    //
    // Off by default, unlike the cat-protection exclusion. That one is free — a log without EGT
    // simply never triggers it. This one throws away samples that a run with purge disabled at
    // the calibration would not have produced in the first place, and on a car that purges 94 % of
    // the time above 2500 rpm it could discard most of a log. Discarding is the second-best
    // answer; disabling the valve is the first. This exists so a log taken WITHOUT that patch can
    // still be salvaged, and so a log taken WITH it can be checked for having actually worked.

    // --- Coverage thresholds ----------------------------------------------------------------
    // How much evidence a cell needs before this app is willing to move it.
    //
    // These decide what gets WRITTEN, not what gets discarded, which is why they sit apart from
    // the row filters above: everything before this point answers "is this sample usable", and
    // these answer "is this cell's pile of usable samples big enough to act on".
    //
    // They exist because karter16 pointed out the thresholds were too low (thread 242281 #161:
    // "it might be worth bumping up the samples thresholds ... I think users might get better
    // results if they collect some more hits") — and looking properly, the VE map had no count
    // threshold at all. Its only test was `weightSum > 0.1`, and weightSum is a sum of bilinear
    // corner weights, so a single sample landing squarely on a cell scores 1.0 and moved it. The
    // 10/30 numbers that looked like thresholds were heatmap bands and gated nothing.
    //
    // Optional, and the `??` defaults below restore the shipped values. A session saved before
    // these existed replays under today's defaults rather than under the old no-gate behaviour —
    // deliberately: the old behaviour is the bug, and reproducing a map built by it is not a
    // promise worth keeping. What IS kept is that the numbers travel with the session, so a
    // re-opened tune says which thresholds produced it.

    /**
     * Whether the VE cell gate runs at all. Default true.
     *
     * Off means off: a cell holding one sample is written. That is the behaviour this gate was
     * added to end, so the panel says so in red the moment it is unticked and the accepted-cell
     * count beside it moves to show the cost. A control whose label and behaviour disagree would be
     * worse than the setting it guards.
     */
    enableVeCellGate?: boolean;
    /** Whether the correction table's cell gate runs at all. Default true. Same reasoning. */
    enableRfKorrCellGate?: boolean;

    /** Samples that must land in a VE cell before it may move. Default 10. */
    minVeCellSamples?: number;
    /** Bilinear weight that must accumulate in a VE cell before it may move. Default 5.0.
     *  Both are required: 10 samples spread across four corners can carry very little weight. */
    minVeCellWeight?: number;
    /** Heatmap band edges — display only, and deliberately higher than the gate. The gate says
     *  "enough to act on"; these say "enough to stop driving this area". Defaults 50 / 200 —
     *  see COVERAGE_THIN_DEFAULT, which is where the numbers and their measurement live. */
    coverageThin?: number;
    coverageOk?: number;

    /** The rf_korr tuner's own grid thresholds. Separate numbers because that table has 72 cells
     *  against the VE map's 480, so one of its cells carries far more of the result. Defaults are
     *  RF_KORR_TUNE_DEFAULTS (10 samples / weight 5.0) — until now unreachable from the UI, because
     *  the only production call site passed no options at all. */
    rfKorrMinCellSamples?: number;
    rfKorrMinCellWeight?: number;

    /** Drop samples recorded while the tank-vent valve was open. Default false. */
    enableTankVentExclusion?: boolean;
    /**
     * TETV pulse time (ms) above which a sample is dropped. Default 0, i.e. drop anything the DME
     * reports as non-zero.
     *
     * A threshold rather than a boolean because `K_TE_TV_MIN` puts a floor of ~6.9 ms under any
     * commanded duty, so "barely open" and "shut" are not adjacent numbers — and because a car
     * whose valve reads a small non-zero at rest would otherwise have every sample discarded.
     * Samples with no TETV reading at all are always kept: absent is not open.
     */
    tankVentMaxMs?: number;

    /**
     * @deprecated Superseded by `rfKorrSource`. Read only by `resolveRfKorr`, so a session saved
     * before that field existed still replays to the same bytes. Never written by new code.
     */
    applyRfKorr?: boolean;

    /**
     * @deprecated Superseded by `rfKorrSource` plus `TuneSettings.writeRfKorr`. See `resolveRfKorr`
     * for the mapping. Never written by new code.
     */
    rfKorrMode?: RfKorrMode;

    /**
     * Which rf_korr the VE derivation divides out of the logged trim.
     *
     * `VE′ = VE × STFT × rf_korr`, always — the DME meters fuel from `RF = rf_soll × rf_korr`
     * (rf_calc, master 0x0218D0), so the trim the closed loop learned is an error on the CORRECTED
     * value. Dividing the correction back out is what leaves a table the DME can then re-correct.
     * That part is not a choice. WHERE the number comes from is:
     *
     *   'rf-ratio'     rf_korr = RF ÷ rf_soll
     *                  What the DME actually applied, recovered from its own output. Needs the RF
     *                  channel and nothing else. Exact only with the PATCH on (k_rf_cfg = 0x02):
     *                  with bit 4 set, RF also carries rf_p_saug_i and the ratio is contaminated.
     *
     *   'table-delta'  rf_korr = KF_RF_KORR_DRREL(rpm, Δ),  Δ = kf_rf_tabg_modell(rpm, RF) − TABG
     *                  The binary's own table, read at the exhaust delta the sensor reports. Needs
     *                  a TABG channel. Cannot see the DME's 20 km/h gate, so where the gate was shut
     *                  this returns the table value while the DME applied 1.000.
     *
     * Both reach the same table two ways, so their AGREEMENT is the check on DS2 offsets 8 and 14 —
     * see rfKorrRouteAgreement. Their DISAGREEMENT is why this is a choice rather than a constant:
     * offset 8 has not been confirmed against a real DME, and if it turned out to be pre-correction
     * `rf_soll`, 'rf-ratio' would silently read 1.000 everywhere.
     *
     * Defaults to 'rf-ratio': it is the one that needs no sensor, and it is what the DME did rather
     * than what its table says it should have done.
     */
    rfKorrSource?: RfKorrSource;
}

/** @deprecated The three-way this replaced. Kept for reading old sessions. */
export type RfKorrMode = 'nominal' | 'as-logged' | 'tuned';

export type RfKorrSource = 'rf-ratio' | 'table-delta';

export interface RfKorrPlan {
    source: RfKorrSource;
    /**
     * Whether rf_korr is divided out at all.
     *
     * Always true for anything selectable today. False exists solely so a session saved as
     * `'as-logged'` — a mode that is gone from the UI — still rebuilds to the bytes it recorded.
     * Removing it would silently re-derive those sessions and break their sha256 reproduction
     * check, which is the one thing an archived session is for.
     */
    apply: boolean;
    /**
     * True only for a legacy `'tuned'` session. The write-back is `TuneSettings.writeRfKorr` now,
     * beside writeWarmup and writeWot, so the caller has to seed it from here when loading one.
     */
    legacyWrite: boolean;
}

/** The one place the two superseded fields are reconciled with the current one. */
export function resolveRfKorr(
    config: Pick<LogFilterConfig, 'rfKorrSource' | 'rfKorrMode' | 'applyRfKorr'>,
): RfKorrPlan {
    if (config.rfKorrSource) return { source: config.rfKorrSource, apply: true, legacyWrite: false };
    const legacy = config.rfKorrMode ?? ((config.applyRfKorr ?? true) ? 'nominal' : 'as-logged');
    return {
        // Every legacy mode used RF ÷ rf_soll; the table route did not exist as an input.
        source: 'rf-ratio',
        apply: legacy !== 'as-logged',
        legacyWrite: legacy === 'tuned',
    };
}

/** The wait the panel now offers, in seconds. Two seconds is what the lambda integrator's own gain
 *  asks for: at 3-5 % per second it needs about that long to absorb a 10 % error. */
export const TRANSIENT_SETTLE_SEC_DEFAULT = 2.0;

/**
 * Roughly how many samples the transient wait works out to on a log at this rate.
 *
 * **For display only.** The filter does not convert seconds to a count — it walks back over the
 * timestamps, so the wait is a duration and no rate enters the arithmetic. This exists because
 * "2.0 s" alone does not tell a reader whether that is three samples or thirty, and the count is
 * what makes the setting feel concrete next to a log of a known length.
 *
 * Converting for real was tried and reverted: a live flush has seen less of the log than a batch
 * pass, measures a different rate, and rounds to a different count. On a rate ramping 0.20 s to
 * 0.40 s that came out as 37 valid samples live against 41 batch — and the live number is the one
 * that gets saved, because nothing reprocesses after STOP.
 *
 * Returns the stored `transientWindow` for a config from before the setting existed, which is what
 * that session was actually built with, and undefined when there is no rate to convert at.
 */
export function resolveTransientWindow(
    config: Pick<LogFilterConfig, 'transientWindow' | 'transientSettleSec'>,
    hz: number | undefined,
): number | undefined {
    if (config.transientSettleSec === undefined) return config.transientWindow;
    if (hz === undefined || !(hz > 0)) return undefined;
    return Math.max(1, Math.round(config.transientSettleSec * hz));
}

export interface InterpolationPoint {
    rpm: number;
    factor: number;
}
