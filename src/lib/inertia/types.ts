/**
 * Types for the engine-inertia measurement.
 *
 * The shape follows `ve-calculator/rfKorrTuner.ts` on purpose: named rejection reasons kept and
 * reported rather than summed into a single count, per-bin evidence surfaced next to the number it
 * produced, and an explicit `acceptable` gate so "we measured something" and "the measurement is
 * worth acting on" stay separate answers.
 */

/**
 * Why a sample never reached the regression. Counted per reason, and shown that way.
 *
 * Shorter than it was, and the removals are the interesting part. Gone: `not-neutral`, `moving` and
 * `not-running`, because the channels that fed them (`gang`, `v_antrieb`, `zustand_motor`) came
 * from the EGAS freeze-frame and are not available live in one telegram — what stands in for them
 * is described on `estimateInertia`. Gone too: `saturated-gradient` and `gradient-disagree`, which
 * existed only to police `d_n40`, and `fuel-cut`, which threw away the single most useful sample
 * class in the run. See `admitSample`.
 */
export type InertiaRejectReason =
    /** Coolant below `minCoolantTempC`. Loss torque moves with temperature, and it is the intercept
     *  the fit is trying to hold constant inside a bin. */
    | 'not-warm'
    /** `md_dyn_st` says the torque-request slew limiter clipped this cycle, so the torque channel
     *  is a filter's ramp rather than the engine's own curve. */
    | 'filter-active'
    /** Window did not fit, straddled a gap, or a needed channel was null. */
    | 'no-gradient'
    /** The gradient window straddled the throttle opening or shutting, so its mean acceleration and
     *  its mean torque describe two different regimes and the sample sits on neither curve. */
    | 'torque-transient'
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
     * Slope of `md_ind_ne` against angular acceleration — the inertia, in Nms^2 (== kg m^2).
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

/**
 * The free-deceleration cross-check.
 *
 * Found by torque rather than by a fuel-cut flag: `md_ind_ne` at zero *is* "no combustion torque",
 * and it is the quantity the prediction is about. The old version keyed on `sa_we_st` bit 3 out of
 * the freeze-frame, which is both unavailable now and one step removed from the thing that matters.
 */
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
    /** Half-window for the `rpm` central difference, in samples. */
    gradientHalfWindow: number;
    /** Largest inter-sample gap tolerated inside a gradient window, seconds. */
    maxSampleGapS: number;
    /** Coolant temperature a sample must reach, °C. */
    minCoolantTempC: number;
    /** Largest torque range tolerated across a gradient window, Nm, before the sample is treated as
     *  a transition rather than a point on a curve. */
    maxTorqueSpanNm: number;
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
    // 2000-5000. Below 2000 the idle controller starts intervening on its own account; above 5000
    // a stationary sweep spends too little time per bin to be worth a bin.
    minRpm: 2000,
    maxRpm: 5000,
    // +/-1 sample: ~0.4 s at the ~5 Hz two telegrams reach. Narrower than the old +/-2 because it
    // no longer has to average out a 40 rpm quantisation — `n` resolves 1 rpm, so the only thing the
    // window costs is curvature error, and a free deceleration at 2000+ rpm/s has plenty of that.
    gradientHalfWindow: 1,
    maxSampleGapS: 0.5,
    // Warm, and firmly so. Loss torque falls steeply with oil temperature, and inside one rpm bin
    // it is the intercept the fit holds constant — a run that warms up while it is being taken puts
    // that drift into the residuals, and if the torque levels happen to correlate with time it puts
    // it into the slope. Every log recorded on this car so far sat at 74-82 °C, which is why this
    // is a gate rather than a note.
    minCoolantTempC: 80,
    // 40 Nm across ~0.4 s. A held pedal moves the torque far less than that as the engine sweeps a
    // bin; the throttle opening or shutting moves it by 100+ Nm in one sample. Generous on purpose:
    // this exists to remove the two or three transition samples per sweep that sit on no curve at
    // all, not to police ordinary variation.
    maxTorqueSpanNm: 40,
    minBinSamples: 12,
    // ~95 rpm/s of spread. Below this the fit cannot separate slope from intercept. Easily met now
    // that overrun samples are admitted: they sit at zero torque and 2000+ rpm/s of deceleration,
    // which is the far end of the line from anything a pedal sweep produces.
    minAlphaSpan: 10,
    minR2: 0.75,
    minAcceptedBins: 3,
    maxJSpreadFraction: 0.20,
    minPlausibleJ: 0.10,
    maxPlausibleJ: 0.35,
    // An S54's motoring torque. Widened at the top from 70: the measured free-deceleration rate on
    // this car is 2200-2400 rpm/s, which at J ~ 0.22 implies ~50 Nm rather than the 25-35 assumed
    // when this rail was first written. Still a sanity rail and not a measurement — see the bias
    // discussion in estimator.ts.
    minPlausibleMLoss: 20,
    maxPlausibleMLoss: 80,
    freeDecelTolerance: 0.25,
};
