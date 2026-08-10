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
    stft1: number;
    stft2: number;
    lambda1?: number; // [NEW] Actual Lambda
    lambda2?: number; // [NEW] Actual Lambda
    coolantTemp?: number; // [UPDATED] Optional
    correctionFactor?: number; // [NEW] For debugging validation

    /** TABG — exhaust gas temperature (degC). DS2 selection 3, payload byte 14, 16 degC/LSB, so
     *  this is coarse: it is a monitoring and gating channel, not a precision measurement. */
    exhaustTemp?: number;
    /** RF — the DME's final relative filling (%), AFTER the EGT correction rf_korr has been applied
     *  to the Alpha-N table's rf_soll. DS2 selection 3, payload bytes 8-9. */
    rf?: number;
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
}

export interface LogFilterConfig {
    enableCorrection: boolean; // Default: true. Set false if CSV is already processed.
    enableMinTemp: boolean;
    minTemp: number;         // Default: 65 (Water Temp > 65)

    enableIdle: boolean;
    idleRpm: number;         // Default: 1000 (Exclude < 1000 RPM & RawLoad=0)

    enableTransient: boolean;
    transientWindow: number; // Default: 4 (Frames to look back)
    rpmStableThreshold: number; // Default: 10 (% Change)
    tpsStableThreshold: number; // Default: 5 (Absolute Change in RO)

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

    /**
     * Correct the logged trim by the measured rf_korr before it reaches the VE map — karter16's
     * "Option 2". Default TRUE.
     *
     * It lives on the filter config rather than somewhere calculator-shaped because it is part of
     * "how this log becomes a map", it has to be persisted with the session for the tune to be
     * reproducible, and TuneSettings already carries filterConfig whole.
     *
     * What it decides is what the Alpha-N table is FOR. With it on, the table holds the filling at
     * NOMINAL exhaust temperature and rf_korr adds the cold-exhaust enrichment on top — so a map
     * tuned on a cold-exhaust drive stays valid once things heat up. With it off, the table holds
     * the filling at whatever rf_korr the log happened to be taken under, which is only right if
     * BMW's density model exactly matches this engine.
     *
     * The two disagree by up to 37 % where KF_RF_KORR_DRREL peaks (~2350 rpm), and they fail in
     * opposite directions: on is rich-safe, off can leave the map lean under load once the exhaust
     * comes up to temperature. That asymmetry is why this defaults on — see
     * docs/ecu-logic/60-tuning-logic.md §6.
     */
    applyRfKorr?: boolean;
}

export interface InterpolationPoint {
    rpm: number;
    factor: number;
}
