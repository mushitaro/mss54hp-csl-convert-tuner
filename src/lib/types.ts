// The census lives with the gates that produce it rather than here, so the reason list and the
// rules that assign a reason cannot drift apart. Type-only, so this stays a leaf import.
import type { DropCensus } from '@/lib/log-engine/lambdaGates';
import type { FilterResume } from '@/lib/log-engine/filter';
import type { VeMethod } from '@/lib/ve-calculator/calculator';

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
    /**
     * The operating point had moved within `transientSettleSec` of this sample.
     *
     * A FLAG, not a deletion, and the difference is the whole reason this field exists.
     * `rfKorrTuner.settledFlags` walks `rfKorrData` with a window bounded on TIMESTAMPS, so a gap
     * shorter than its own settle is spanned rather than seen — and its call site says so in as
     * many words, licensing the shortcut because the log filter's removals were all longer than
     * that. Excluding these samples from the array would manufacture exactly the short gaps that
     * comment assumed away, and strictly in the loosening direction: the samples deleted are the
     * unsteady ones, so their steady neighbours would stop having anything to look at.
     *
     * So the sample stays in the series and the tuner skips it in pass 0, after the flags are
     * computed over an intact array.
     */
    settleUnsteady?: boolean;
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
    /** `laa_f1` / `laa_f2` — the MULTIPLICATIVE long-term lambda trim per bank, 1.000 = nothing
     *  learned. Learned in driven part load (ML > 40 kg/h); applied everywhere. See
     *  LiveMeasurement.ltft1 for the two-store structure. */
    ltft1?: number;
    ltft2?: number;
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
    /**
     * TAN — intake air temperature, degC, read from RAM on the slow lane.
     *
     * **It IS a tuning input, and this comment used to say the opposite.** `rf_soll_calc` (master
     * `0x01A9D2`) ends with `rf_soll = (rf_soll_filtered * RF_PT_KORR) >> 12`, and `RF_PT_KORR` is
     * `KL_RF_TAN_KORR(TAN) * KL_RF_P_UMG_KORR(P_UMG)`. The Alpha-N table is scaled for air density
     * on every segment, the tuning patch does not stop it, and so a logged trim was measured
     * through that curve. Reproducing it is the only way to know what the trim meant.
     */
    intakeTemp?: number;
    /** Ambient pressure, mbar — the other index into `RF_PT_KORR`. See `chargeTemp` for why the
     *  pressure nevertheless cancels out of the correction rather than appearing in it. */
    ambientPressure?: number;
    /**
     * The DME's modelled charge temperature at the intake valve, degC (`tan_m`, RAM 0xFFED46).
     *
     * `TMOT - f*(TMOT - TAN)`, `f` rising with air mass flow: air through a hot port picks up less
     * wall heat the faster it goes. This is what makes the temperature sensitivity of VE
     * load-dependent — near zero at light load, full ideal-gas at high flow — which a
     * one-dimensional `KL_RF_TAN_KORR` cannot express and is why that curve is so flat.
     */
    chargeTemp?: number;
    /** The altitude the DME derives from ambient pressure, metres (`P_UMG_HOEHE`). Diagnostic. */
    altitude?: number;
    /** Set only when the DME was reporting a substitute ambient pressure. Absent on a healthy run,
     *  and the serializer only emits the column when some sample carries it. */
    ambientPressureSubstituted?: boolean;
    /** `T_UMG` — outside air temperature, degC, off CAN 0x62F. The reference `intakeTemp` is
     *  checked against: cold-soaked, the two and `coolantTemp` must agree. */
    ambientTemp?: number;
    /** False when the DME substituted `T_UMG_ERSATZ` — the running minimum of `TAN` — for a missing
     *  CAN frame, which makes `ambientTemp` a restatement of `intakeTemp` and the check circular. */
    ambientTempFromCan?: boolean;
    /**
     * `LLS_ST` — idle-valve status, and **bit 7 is what it is here for**.
     *
     * `ti_load_factor` (slave 0x01C6CA) reads the idle curve `KL_TI_N_ZWD_LL` — the 0.859 one —
     * only while `ZUSTAND_MOTOR`'s LL bit is set AND this bit is set; otherwise it reads
     * `KF_TI_N_RF`. Bit 7 is set by the idle-valve DIAGNOSIS (`lls_diag`, master 0x026142) and
     * cleared at 0x026196, so at a healthy idle it is low.
     *
     * Which branch runs decides `TI_F_STAT`, the factor the DME multiplies injection time by. It
     * is not a term in the LOW LOAD correction, so `requireTiBranchProven` — which once refused
     * every idle cell over this — is OFF and neither branch moves a written byte. The disassembly
     * answers which one runs; this channel is how the CAR answers it.
     *
     * Slowest lane. A bit a diagnosis latches does not move on a timescale a sample could catch.
     */
    llsSt?: number;
    /** The slew limiter, as the DME ran it — see SLEW_STATE_RAM_READ / SLEW_TORQUE_RAM_READ.
     *  `mdDynSt` bit 6 says the tip-in path actually clipped; `mdFwFilter - mdFw` says by how
     *  much. Diagnostics for the drivability tables, never an input to the VE derivation. */
    mdDynSt?: number;
    mdFw?: number;
    mdFwFilter?: number;
    mdLsDelta?: number;
    mdDpDelta?: number;
    /** `V` — road speed, km/h. The half of the `rf_korr` gate this app has never evaluated.
     *  Recorded, not yet gated on; see the RAM read's own note. */
    vehicleSpeed?: number;
    /** Gap between the word and byte decodes of ambient pressure, mbar. Agreement is evidence both
     *  addresses are what this app claims; a gap is evidence one is not. */
    pressureDecodeDisagreesMbar?: number;
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

    /**
     * Whether the correction's load gate was open at this sample — `rf_soll > kl_rf_korr_rf_min(N)`.
     *
     * Recorded rather than re-derived for the same reason `tabgDelta` is: three places need this
     * answer and they must not be able to reach different ones. It is not inferable from
     * `rfKorrFromEgt`, because 1.000 there means either "the gate was shut" or "the gate was open
     * and Δ ≤ 30" — and those two demand opposite treatment when the VE derivation divides by the
     * corrected table.
     *
     * Only the LOAD half. The DME also requires `V > k_rf_korr_v_min` (20 km/h), and road speed is
     * not in the blocks this app polls, so a sample below that speed reads as open here and was
     * 1.000 in the car. See docs/ecu-logic/20-egt-correction.md §1.
     *
     * Present exactly when `tabgDelta` is — both need the binary's tables.
     */
    rfKorrGateOpen?: boolean;
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
    /** `validData` plus the samples the idle gate dropped — the only set that contains the rows a
     *  low-opening Alpha-N correction is derived from. See the note in filter.ts for why they are
     *  a separate set rather than a relaxed gate. */
}

export interface LogFilterConfig {
    enableCorrection: boolean; // Default: true. Set false if CSV is already processed.
    enableMinTemp: boolean;
    minTemp: number;         // Default: 65 (Water Temp > 65)


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
    /**
     * State every sample at the air the VE table is written for, before it is binned.
     *
     * This is what makes a summer log and a winter log of the same engine produce the same map.
     *
     * It replaces two earlier settings — `normaliseIntakeTempC` and `normaliseLevel` — that were
     * both built on a premise this tree stated as fact and which is false: that the Alpha-N path
     * has no temperature or pressure term. It has one. `rf_soll_calc` scales the table by
     * `RF_PT_KORR = KL_RF_TAN_KORR(TAN) * KL_RF_P_UMG_KORR(P_UMG)` on every segment, and the tuning
     * patch does not stop it. Both old settings therefore corrected a second time for something
     * already corrected once.
     *
     * There is no reference to configure. It is where those two curves are exactly 1 — 20 degC and
     * 960.5 mbar on this calibration — and it is read from the loaded BASE. Neither old field is
     * migrated: a session that carried one describes an arithmetic that no longer exists, and
     * silently reinterpreting it as this would be a different claim about the same bytes.
     *
     * Off by default, because it changes what gets written. See chargeTemp.ts.
     */
    normaliseChargeTemp?: boolean;

    /**
     * Ambient pressure to assume for a log that does not carry one, mbar. NO UI — scripts only.
     *
     * Without a pressure the app cannot measure rf_korr — `RF / kf_rf_soll` is
     * `RF_PT_KORR * rf_korr`, so the density has to come out before the number means anything —
     * and such a log falls back to the lambda trim alone, which measurement shows is already
     * pressure-free. Supplying a pressure recovers the rf_korr half; that is how the pre-channel
     * campaign logs (#911/#912, 888/993 mbar) were reanalysed to prove the contamination.
     *
     * The panel row for it was removed 2026-08-22 at the operator's direction: this branch is an
     * experiment, its old logs need no salvage in the UI, and every current profile logs `P_UMG`.
     * The field is still honoured here so an analysis script (or a hand-edited stored config) can
     * set it — see `veCalcOptionsFor`, which passes it into `rfKorrAir.assumedPressureMbar`.
     */
    assumedAmbientPressure?: number;
    enableVeCellGate?: boolean;
    /** Whether the correction table's cell gate runs at all. Default true. Same reasoning. */
    enableRfKorrCellGate?: boolean;

    /**
     * Stretches of the drive the operator has taken out, as [from, to] in the log's own time units.
     *
     * Written only by the DRIVE SPLIT notice, which never excludes anything by itself — it names
     * the stretch that disagrees and the operator decides. Kept in the config rather than in a
     * component's state for the reason every other filter is: a session has to rebuild to the same
     * bytes it recorded, and a map built from 27 of 52 minutes is a different map.
     *
     * Absent means the whole drive, which is what every session saved before this existed means.
     */
    excludeTimeRanges?: Array<[number, number]>;

    /**
     * Seconds the filling must stay above 55 %RF before a high-load sample counts, default 6.
     *
     * Entering that region makes the DME's `rf_korr` step up off a lagging TABG while the lambda
     * trim walks after it at a few percent a second; until it lands, `trim × rf_korr` reads high.
     * Two same-day drives disagreed by 5.2 % at high load because one was short stabs (sampling the
     * excursion) and the other held a 29.8 s pull (sampling the answer); requiring 6 s closed it to
     * 1.1 %. See the gate in filter.ts for the measured decay curve.
     *
     * Absent = off, so a session saved before this existed reproduces its map exactly. 0 disables.
     */
    highLoadSettleSec?: number;

    /**
     * WHICH METHOD DECIDES A CELL — 'direct' (default) or 'statistical'. See VeMethod in calculator.ts.
     *
     * The axis of the whole VE path, and it lives in the filter config for the reason every
     * threshold does: a session has to re-derive to the bytes it recorded, and the two methods do
     * not produce the same map.
     *
     * ONE EXCEPTION, deliberate. A session archived BEFORE this field existed stores nothing here
     * and therefore re-derives under 'direct', not under the statistical gate it was actually built
     * with. That is a real behaviour change on reopen, taken knowingly: this is the experimental
     * branch, the statistical gate was the default for one day, and pinning old sessions to a
     * method the operator has since rejected would preserve bytes nobody wants at the cost of a
     * legacy branch in the one place the method has to stay readable.
     */
    veMethod?: VeMethod;
    /** Fraction of a cell's measured demand one DIRECT pass applies, 0-1. Default 1.0. Ignored by the
     *  statistical method, which sizes each step from the evidence instead. */
    directAuthority?: number;
    /** Samples that must land in a VE cell before it may move. Default 10 statistical / 3 DIRECT. */
    minVeCellSamples?: number;
    /** Bilinear weight that must accumulate in a VE cell before it may move. Default 5.0.
    /**
     * Bilinear weight a VE cell must accumulate before it may move. Default 2.5, and BOTH bars are
     * required: three samples that only just clear CLAMP_MIN_WEIGHT carry 0.75 of weight, so the
     * count and the weight refuse different cells. See VE_MIN_WEIGHT_DEFAULT for why 2.5.
     *
     * A SECOND DELIBERATE REPLAY DIVERGENCE, alongside `veMethod` above. This field was absent from
     * DEFAULT_FILTER_CONFIG for as long as the bar was retired at 0, so every session saved in that
     * window stores nothing here and now re-derives under 2.5 instead. Measured on #933: 83 written
     * cells become 69, fourteen kf_rf_soll cells stop being written and return to BASE, the largest
     * of them 8.68 %. The bytes those sessions RECORDED are unchanged — the artifact and its sha256
     * are stored — but reopening one and re-deriving no longer reproduces them.
     *
     * Taken knowingly, on the same grounds as `veMethod`: this is the experimental branch, the bar
     * was retired for one week on a measurement that no longer applies (it was taken while the
     * count admitted grazes), and pinning old sessions to 0 would preserve maps whose thin cells
     * are the reason the bar came back. New sessions pin it, so this closes rather than accumulates.
     */
    minVeCellWeight?: number;
    /**
     * @deprecated The lower heatmap band is the VE gate's own sample count now, not a separate
     * number. Independent, the two could contradict each other — a cell above the gate and below
     * this was rewritten and still painted as barely visited. Kept on the type because sessions
     * stored one; ignored, which costs nothing, since this was only ever a colour.
     */
    coverageThin?: number;
    /** Where the heatmap's strongest band begins — display only. The gate says "enough to act on";
     *  this says "enough to stop driving this area", which is the higher bar. Default 200; see
     *  COVERAGE_OK_DEFAULT, where the number and its measurement live. */
    coverageOk?: number;

    /** The rf_korr tuner's own grid thresholds. Separate numbers because that table has 72 cells
     *  against the VE map's 480, so one of its cells carries far more of the result. Defaults are
     *  RF_KORR_TUNE_DEFAULTS (10 samples / weight 5.0) — until now unreachable from the UI, because
     *  the only production call site passed no options at all. */
    rfKorrMinCellSamples?: number;
    rfKorrMinCellWeight?: number;

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
     * Which rf_korr the VE derivation cancels out of the logged trim.
     *
     * `VE′ = VE × STFT × rf_korr`, always — the DME meters fuel from `RF = rf_soll × rf_korr`
     * (rf_calc, master 0x0218D0), so the trim the closed loop learned is an error on the CORRECTED
     * value and carries 1/rf_korr inside it. Multiplying the applied rf_korr back in cancels that,
     * and leaves a table the DME can then re-correct. That part is not a choice. WHERE the number
     * comes from is (the panel's button names in parentheses):
     *
     *   'rf-ratio'     (CALCULATE)  rf_korr = RF ÷ rf_soll
     *                  What the DME actually applied, recovered from its own output. Needs the RF
     *                  channel, plus the air channels (or the assumed-pressure setting) to
     *                  reproduce rf_soll = table × pt_korr — without them the sample carries no
     *                  rfKorr and the trim stands alone. Exact only with the PATCH on
     *                  (k_rf_cfg = 0x02): with bit 4 set, RF also carries rf_p_saug_i and the
     *                  ratio is contaminated.
     *
     *   'table-delta'  (TABG)  rf_korr = KF_RF_KORR_DRREL(rpm, Δ),
     *                  Δ = kf_rf_tabg_modell(rpm, RF) − TABG
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
     * Whether rf_korr is cancelled at all.
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

/**
 * The wait the panel offers, in seconds.
 *
 * TWO SECONDS ANSWERED THE WRONG QUESTION. It was set to the time the lambda integrator needs to
 * ABSORB a 10 % error — 3-5 % per second, so about two — but this gate does not ask whether the
 * trim has finished moving. Its own doc says what it asks: whether the trim in a sample corresponds
 * to the air flow at that sample rather than to the air before or after it. That is the loop's
 * response time, not its settling time, and the two differ by a factor of two.
 *
 * The response time is measured on this car, not assumed: `la_f_regler` is a two-point controller
 * oscillating at 1-2 Hz by construction (period 0.5-1.0 s), and the per-drive correlation time runs
 * 0.78 to 2.07 s with a representative 1.1 s (`calculator.ts`, AUTOCORR_FALLBACK).
 *
 * What the extra second cost, measured on session #931: the reference sits 2 s back while a bucking
 * event lasts 2-4 s, so the sample is compared against a point BEFORE the event began — the load
 * delta reads a median 53 % against a threshold of 5, and 109 of 121 samples inside the ten events
 * were refused. At 1.0 s the same comparison reads 18.9.
 *
 * AND ONE SECOND ANSWERED IT TOO, JUST LESS. The gate compares the OPERATING POINT at two instants.
 * What decides whether a trim is readable is the state of the lambda INTEGRATOR, which is a
 * different clock: on #933 the operating point can be moving throughout (rpm 1228 -> 1543 over three
 * seconds) and pass this test on every adjacent pair, while a sample whose integrator is fully wound
 * is refused because the car was accelerating. Gating one with the other trades away transient
 * evidence — which is the evidence a VE map is FOR — and buys nothing on the axis it was aimed at.
 *
 * Measured on #933, which is why the default is 0. Same log, same base, settle alone varying, with
 * the settle still on the VE stream as it then was:
 *
 *     1.0 s   2991 valid   74 cells   median |write| 2.64 %   worst 12.55 %
 *     2.0 s   2227 valid   44 cells   median |write| 2.21 %   worst  9.15 %
 *     3.0 s   1906 valid   32 cells   median |write| 1.43 %   worst  9.80 %
 *
 * Thirty cells appear at 1.0 s that 2.0 s refuses and none go the other way, so the setting is a
 * coverage dial and not a quality one.
 *
 * And what it was protecting against does not vary with time. Over #933's 4,030 samples that carry
 * a moving trim, |trim - 1| correlates +0.32 with filling and +0.29 with load, while every clock
 * comes out at or below zero: -0.04 against seconds since the trim was last parked at bit-exact
 * 1.000, -0.10 against time since the drive began. Holding longer does not shrink it either — over
 * 76 holds of 3 s+, mean |trim - 1| is 2.29 % on holds of 8 s+ against 1.87 % on holds under 5 s.
 *
 * An earlier version of this note quoted +0.132 for the first of those. It reproduces, but only
 * inside an arbitrary 12-second cap on that clock; without the cap the sign flips. The magnitude
 * tracks the OPERATING POINT — which is what the two remaining thresholds test — and a number that
 * changes sign with the window it is read over is not evidence for anything.
 *
 * So the default is 0 — compare each sample against the one immediately before it — and the panel
 * offers 0 to 3 s in 0.1 s steps for anyone who wants to put the wait back. Turning the test OFF
 * entirely is `enableTransient`, which is a different control and still there.
 */
export const TRANSIENT_SETTLE_SEC_DEFAULT = 0;

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
