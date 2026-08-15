/**
 * Types for the engine-inertia measurement.
 *
 * The shape follows `ve-calculator/rfKorrTuner.ts` on purpose: named rejection reasons kept and
 * reported rather than summed into a single count, per-bin evidence surfaced next to the number it
 * produced, and an explicit `acceptable` gate so "we measured something" and "the measurement is
 * worth acting on" stay separate answers.
 */

/** Why a sample never reached the regression. Counted per reason, and shown that way. */
export type InertiaRejectReason =
    /** Gear was not neutral, or the DME did not report a gear at all. */
    | 'not-neutral'
    /** Rolling. The measurement requires standstill so the tip-in/dashpot limiter is bypassed. */
    | 'moving'
    /** Coolant/engine state says the engine is not warmed up and running normally. */
    | 'not-warm'
    /** `md_dyn_st` says the torque-request slew limiter clipped this cycle, so the torque channel
     *  is not the driver's request and the sample is not on the free-running curve. */
    | 'filter-active'
    /** Overrun fuel cut was active — combustion torque is not what the model reports. */
    | 'fuel-cut'
    /** `d_n40` was at a rail; magnitude unknown. */
    | 'saturated-gradient'
    /** The two gradient routes disagreed by more than the tolerance. */
    | 'gradient-disagree'
    /** Window did not fit, straddled a gap, or a needed channel was null. */
    | 'no-gradient'
    /** Torque channel absent or implausible. */
    | 'no-torque'
    /** Outside the rpm range the procedure covers. */
    | 'out-of-range';

export interface InertiaRejectCounts {
    reason: InertiaRejectReason;
    count: number;
}

/** One rpm bin's independent fit. */
export interface InertiaBin {
    /** Bin centre, rpm. */
    rpm: number;
    loRpm: number;
    hiRpm: number;
    /** Samples that survived every gate and entered this bin's regression. */
    count: number;
    /**
     * Slope of `md_ind_opt_korr` against angular acceleration — the inertia, in Nms^2 (== kg m^2).
     * Null when the bin did not meet its evidence thresholds.
     */
    j: number | null;
    /** Intercept — the loss torque at this speed, Nm. Friction plus pumping. */
    mLoss: number | null;
    /** Coefficient of determination of the fit. */
    r2: number | null;
    /** Spread of angular acceleration the bin's samples covered, rad/s^2. A fit over a narrow span
     *  is an extrapolation dressed as a regression, so this is a gate, not decoration. */
    alphaSpan: number;
    /** Why this bin produced no J, when it produced none. */
    rejected: 'thin-count' | 'thin-alpha-span' | 'poor-fit' | null;
}

/** The free-deceleration cross-check. */
export interface FreeDecelCheck {
    /** Whether a usable deceleration run was found at all. */
    found: boolean;
    /** Measured mean gradient over the window, rpm/s (negative). */
    measuredRpmPerS: number | null;
    /** Gradient predicted from the regression's own J and M_loss over the same speed range. */
    predictedRpmPerS: number | null;
    /** |measured - predicted| / |predicted|. */
    relativeError: number | null;
    /** Within tolerance. Null when no run was found. */
    agrees: boolean | null;
}

export interface InertiaEstimate {
    /** Weighted mean of the accepted bins' J, Nms^2. Null when nothing was acceptable. */
    j: number | null;
    /**
     * Standard deviation of J **across bins**, not within them.
     *
     * This is the headline trustworthiness number and the reason the estimate is binned at all.
     * Engine inertia does not depend on engine speed, so a J that drifts with rpm is not a noisy
     * measurement of one quantity — it is evidence that something in the model is wrong (the wrong
     * samples admitted, a gradient bias, a torque channel that is not what it claims). Scatter
     * within a bin is ordinary noise; scatter between bins is a falsified assumption.
     */
    jSpread: number | null;
    bins: InertiaBin[];
    /** Loss torque by bin centre, for plotting and for the plausibility gate. */
    mLossCurve: { rpm: number; mLoss: number }[];
    freeDecel: FreeDecelCheck;
    samplesSeen: number;
    samplesUsed: number;
    rejects: InertiaRejectCounts[];
    /** Median sample interval actually achieved, seconds. Measured, never assumed. */
    medianSampleIntervalS: number | null;
    /**
     * Whether this estimate should be allowed to drive a correction proposal.
     *
     * False does not mean the drive was wasted — `notes` says what to change and re-run.
     */
    acceptable: boolean;
    /** Human-readable reasons the estimate is or is not acceptable. Always populated. */
    notes: string[];
}

/** Tunables, all defaulted. Exposed so tests can drive the estimator hard without editing it. */
export interface InertiaEstimatorOptions {
    /** Bin width, rpm. */
    binWidthRpm: number;
    /** rpm range the procedure covers. */
    minRpm: number;
    maxRpm: number;
    /** Half-window for the `n40` central difference, in samples. */
    gradientHalfWindow: number;
    /** Largest inter-sample gap tolerated inside a gradient window, seconds. */
    maxSampleGapS: number;
    /** How far the two gradient routes may differ, rpm/s, before the sample is dropped.
     *  Two independent +/-20 rpm/s quantisations plus the window's own averaging. */
    gradientAgreementRpmPerS: number;
    /** Minimum samples for a bin to report a J. */
    minBinSamples: number;
    /** Minimum angular-acceleration span for a bin to report a J, rad/s^2. */
    minAlphaSpan: number;
    /** Minimum r^2 for a bin to report a J. */
    minR2: number;
    /** Minimum bins that must report a J. */
    minAcceptedBins: number;
    /** Largest across-bin J standard deviation, as a fraction of the mean, still acceptable. */
    maxJSpreadFraction: number;
    /** Plausibility window on J, Nms^2. Outside this the torque channel is the suspect. */
    minPlausibleJ: number;
    maxPlausibleJ: number;
    /** Plausibility window on loss torque at 4000 rpm, Nm. */
    minPlausibleMLoss: number;
    maxPlausibleMLoss: number;
    /** Free-decel agreement tolerance, as a fraction. */
    freeDecelTolerance: number;
}

export const DEFAULT_INERTIA_OPTIONS: InertiaEstimatorOptions = {
    binWidthRpm: 500,
    minRpm: 1750,
    maxRpm: 4750,
    // +/-2 samples spans ~0.44 s at the ~9 Hz this profile is expected to reach: long enough that
    // n40's 40 rpm endpoints are small against the span, short enough that the gradient has not
    // meaningfully changed across it during a deliberate pedal sweep.
    gradientHalfWindow: 2,
    maxSampleGapS: 0.5,
    gradientAgreementRpmPerS: 150,
    minBinSamples: 12,
    // ~95 rpm/s of spread. Below this the fit cannot separate slope from intercept.
    minAlphaSpan: 10,
    minR2: 0.75,
    minAcceptedBins: 3,
    maxJSpreadFraction: 0.20,
    minPlausibleJ: 0.10,
    maxPlausibleJ: 0.35,
    // An S54's motoring torque. Wide, because this is a sanity rail and not a measurement —
    // see the bias discussion in estimator.ts.
    minPlausibleMLoss: 15,
    maxPlausibleMLoss: 70,
    freeDecelTolerance: 0.25,
};
