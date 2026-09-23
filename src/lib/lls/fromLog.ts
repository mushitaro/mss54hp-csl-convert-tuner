import {
    dutyFromAqRel, mlFromAqRel, phaseMargin, ringElasticity, type RingTables,
} from './ringGain';

/**
 * What a micro-throttle drive measures: the loop delay, the band the car actually sat in, and the
 * margin at every point of it.
 *
 * ## Why this is separate from ringGain
 *
 * `ringGain` is map-to-map and needs no samples at all — it can answer "what is this calibration
 * worth" from a binary alone. This file is the other half: it turns a recorded session into the two
 * constants that calculation needs (`Td`, and which rows the measured duty reaches) and reports
 * what the drive itself showed. Keeping them apart is what lets the solver be verified against a
 * hand calculation with no log in sight.
 *
 * ## The session has no duty channel
 *
 * `Idle Valve Status` is a status byte, not a duty. The valve position is recovered from
 * `relativer Oeffnungsquerschnitt` (AQ_REL) through `KL_AQ_ABS_LLS` inverted, and the air request
 * from `KF_LLS_TV` inverted along the column. Both live in `ringGain`; nothing here re-derives them.
 *
 * ## Stopped samples are not part of the drive
 *
 * The rule is `speedKmH > 0`. On Session 954 that is 320 of 362 rows, which is the count the notes
 * report, and it is what makes the before-statistics reproduce: the stationary rows at the head of
 * the log sit at an operating point the rolling section never returns to, and they drag the worst
 * decile down by 2.5 deg on their own.
 *
 * Measurement policy is `tsunagi-m-ux` section 8: report what was observed, return null rather than
 * zero for what could not be, and never round a suspicious number into a plausible one.
 *
 * Method: `docs/low_load_surge.md` 9.3a, 9.4 and 9.9-7 in the notes repo.
 */

/** One row of a recorded micro-throttle session, in XDF display units. */
export interface LlsSample {
    /** Seconds from the start of the log, as the log itself timed it. */
    tS: number;
    rpm: number;
    /** Relative filling on 0-1 — the logged percentage divided by 100. */
    rf: number;
    /** AQ_REL %, the valve opening the DME reported. */
    aqRelPct: number;
    speedKmH: number;
    /**
     * The ring, read from RAM instead of reconstructed. All optional: a log recorded before these
     * channels existed, or in another mode, simply does not carry them.
     *
     * When present they replace two assumed map inversions — `aqRelPct` through `KL_AQ_ABS_LLS`
     * for the duty, then `KF_LLS_TV` for the air request — with what the DME actually commanded.
     * `frRegler` has no reconstruction at all; it is the integrator the 0.3 Hz argument is about.
     */
    frRegler?: number;
    llsTvPct?: number;
    mlSollLlsKgH?: number;
    /** `WDK1`, throttle plate %. The defining condition of this mode is that it stays on the floor;
     *  a sample above the floor is not a micro-throttle sample whatever else it looks like. */
    throttlePct?: number;
}

/**
 * The operating point a drive has to hit for its numbers to be comparable with another drive's.
 *
 * ## Why this exists
 *
 * Three sessions in a row missed it. 954 ran at 1162 rpm and 10 km/h; 956 came back at 932 rpm and
 * 7; 957 at ~900 and 6. Each time the ring numbers improved and each time the improvement could
 * not be separated from "the car was somewhere else" — because the loop delay moves with rpm and
 * load, so a slower drive has a slower resonance whether or not anything was fixed.
 *
 * The band is not a rule about how to drive. It is the question "can this be compared with the
 * reference" made answerable WHILE there is still time to correct it, rather than after the log is
 * closed and the drive is over.
 */
export interface LlsTargetBand {
    label: string;
    rpmMin: number;
    rpmMax: number;
    airMin: number;
    airMax: number;
    speedMin: number;
    speedMax: number;
    /** `WDK1` must stay at or below this. 954 measured 0.0-0.1 on all 362 rows. */
    maxThrottlePct: number;
}

/**
 * Session 954, as measured — p5 to p95 of its rolling points, not numbers anyone chose.
 *
 * p5/p95 rather than min/max on purpose: the extremes of a 320-point drive are one sample each,
 * and a band a drive can only touch at its edges is a band nobody can hold. Speed is the handle the
 * driver actually has; rpm and air are what it produces, and both are reported so a drive that
 * holds the speed and still misses the rpm says so rather than looking compliant.
 */
export const REFERENCE_BAND: LlsTargetBand = {
    label: 'Session 954',
    rpmMin: 909,
    rpmMax: 1409,
    airMin: 19.2,
    airMax: 36.3,
    speedMin: 8,
    speedMax: 11,
    maxThrottlePct: 0.1,
};

export interface TargetVerdict {
    rpm: boolean;
    air: boolean;
    speed: boolean;
    throttle: boolean;
    /** Every channel that was READABLE is inside the band. A channel the sample does not carry
     *  cannot fail — an absent reading is not evidence of being off target. */
    all: boolean;
}

/**
 * Is this sample on the reference operating point?
 *
 * ONE function, called from two places: the strip that floats over the graph during a run, and
 * `summariseSession` afterwards. That is deliberate — a live gate computed separately from the
 * verdict it predicts is a second opinion, and the moment they disagree the one on screen during
 * the drive is the one the driver acted on.
 */
export function onTarget(band: LlsTargetBand, s: {
    rpm?: number | null;
    airKgH?: number | null;
    speedKmH?: number | null;
    throttlePct?: number | null;
}): TargetVerdict {
    const within = (v: number | null | undefined, lo: number, hi: number) =>
        !Number.isFinite(v as number) || ((v as number) >= lo && (v as number) <= hi);
    const verdict = {
        rpm: within(s.rpm, band.rpmMin, band.rpmMax),
        air: within(s.airKgH, band.airMin, band.airMax),
        speed: within(s.speedKmH, band.speedMin, band.speedMax),
        throttle: within(s.throttlePct, -Infinity, band.maxThrottlePct),
    };
    return { ...verdict, all: verdict.rpm && verdict.air && verdict.speed && verdict.throttle };
}

/** A distribution reported the way an instrument should: the ends, and where the body sits. */
export interface Band {
    min: number;
    p5: number;
    median: number;
    p95: number;
    max: number;
}

/** How a number in this summary came to be, per `tsunagi-m-ux` section 15. */
export type Grade = 'measured' | 'computed' | 'inferred' | 'authored';

/**
 * Where the duty and air figures came from.
 *
 * `direct` means the DME's own `LLS_TV` and `ML_SOLL_LLS`. `reconstructed` means they were derived
 * from `AQ_REL` back through two map inversions, which is what every log before these channels
 * existed must use. Reported rather than assumed because the two are not interchangeable: a
 * reconstruction is only as good as the maps in the image it was inverted against, and if that
 * image is not the one the car was running it is wrong in a way nothing else in the summary shows.
 */
export type RingSource = 'direct' | 'reconstructed';

export interface LagPeak {
    /** Seconds, refined sub-sample. Positive means the first series leads the second. */
    lagS: number;
    /** Correlation at that lag, -1..1. */
    r: number;
    /**
     * The same peak at whole-sample resolution.
     *
     * Reported beside the refined figure because the notes' Td of 0.58 s IS this number — the
     * integer peak of Session 954 at 5.17 Hz — and a refinement that quietly replaced it would make
     * the document and the app disagree with no way to see why. On 954 the two are 0.58 and 0.63.
     */
    coarseLagS: number;
    /** One lag step, seconds: the resolution the refinement works inside. 954 is 0.19, an LLS run
     *  with the ring channels is 0.30. A refinement smaller than this is not evidence of anything. */
    stepS: number;
}

export interface LlsSessionSummary {
    /** Rows handed in, and the rolling subset the rest of this describes. */
    samples: number;
    rolling: number;
    /** Mean Hz over the span — throughput, drops included. Null if it cannot be known. */
    sampleRateHz: number | null;
    /** Nominal Hz, `1 / median(dt)` — the rate the samples were taken at. Lags convert on this. */
    cadenceHz: number | null;
    /** The loop delay: duty against rpm, first peak. Null if the series will not support a lag. */
    td: LagPeak | null;
    /** Duty peak-to-peak of the smoothed residual — the size of the surge. */
    dutyPpPct: number | null;
    /** Autocorrelation first peak of that residual: the period of the oscillation. */
    period: LagPeak | null;
    duty: Band | null;
    ml: Band | null;
    rf: Band | null;
    /** Rows of `KF_LLS_TV` the measured air request reaches, and so the rows a solve may write. */
    reachedRows: number[];
    elasticity: Band | null;
    phaseMarginDeg: Band | null;
    /** Share of points below 30 deg — the tail the correction is aimed at. */
    thinMarginShare: number | null;
    /** Whether duty and air were read or inverted. See `RingSource`. */
    source: RingSource;
    /** The integrator, when the log carried it. Null on every log recorded before it existed. */
    frRegler: Band | null;
    /** Share of rolling samples inside `REFERENCE_BAND`, 0-1 — how comparable this drive is with
     *  the reference. The same `onTarget` the live strip shows, so the two cannot disagree. */
    onTargetShare: number | null;
}

// ---------------------------------------------------------------------------
// statistics
// ---------------------------------------------------------------------------

function band(values: readonly number[]): Band | null {
    const v = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (v.length === 0) return null;
    const at = (p: number) => v[Math.min(v.length - 1, Math.floor(p * (v.length - 1)))];
    return { min: v[0], p5: at(0.05), median: at(0.5), p95: at(0.95), max: v[v.length - 1] };
}

/**
 * Sample rate from the samples' own clock.
 *
 * `(n - 1) / (last - first)`, not `n / last`: the time origin is the first sample, not zero, and
 * dividing by the last timestamp quietly reports a rate that is too low by one interval.
 *
 * Null rather than zero when it cannot be known. `!(span > 0)` rather than `span <= 0` so that a
 * NaN span is caught too — a log whose timestamps did not parse should say nothing, not claim 0 Hz.
 */
export function sampleRateHz(samples: readonly LlsSample[]): number | null {
    if (samples.length < 2) return null;
    const span = samples[samples.length - 1].tS - samples[0].tS;
    if (!(span > 0)) return null;
    return (samples.length - 1) / span;
}

/**
 * The logger's nominal cadence, `1 / median(dt)` — a different number from `sampleRateHz`, and
 * both are reported because they answer different questions.
 *
 * Session 954 runs at a median interval of 0.194 s (5.17 Hz) but averages 4.21 Hz over its span,
 * because a handful of intervals stretch to 0.99 s — five missed samples in a row. The mean is the
 * honest throughput; the median is the rate the samples were actually taken at, and it is the one
 * that converts a lag in samples into seconds, because a lag of k spans k nominal intervals
 * wherever the drops are not.
 *
 * Reporting only the mean would make every lag in this file 20 % too long. Reporting only the
 * median would hide that a fifth of the expected samples never arrived.
 */
export function cadenceHz(samples: readonly LlsSample[]): number | null {
    if (samples.length < 3) return null;
    const dt: number[] = [];
    for (let i = 1; i < samples.length; i++) {
        const d = samples[i].tS - samples[i - 1].tS;
        if (d > 0) dt.push(d);
    }
    if (dt.length === 0) return null;
    dt.sort((a, b) => a - b);
    const median = dt[Math.floor(dt.length / 2)];
    return median > 0 ? 1 / median : null;
}

/** Centred moving average. The residual against it is what carries the surge. */
function smooth(values: readonly number[], window: number): number[] {
    if (window < 2) return [...values];
    const half = Math.floor(window / 2);
    return values.map((_, i) => {
        const lo = Math.max(0, i - half);
        const hi = Math.min(values.length - 1, i + half);
        let sum = 0;
        for (let k = lo; k <= hi; k++) sum += values[k];
        return sum / (hi - lo + 1);
    });
}

/** What is left of a series once its trend is removed. */
export function residual(values: readonly number[], window: number): number[] {
    const base = smooth(values, window);
    return values.map((v, i) => v - base[i]);
}

function correlationAtLag(a: readonly number[], b: readonly number[], lag: number): number | null {
    const n = a.length;
    const lo = Math.max(0, -lag);
    const hi = Math.min(n, n - lag);
    const count = hi - lo;
    if (count < 8) return null;
    let sa = 0;
    let sb = 0;
    for (let i = lo; i < hi; i++) { sa += a[i]; sb += b[i + lag]; }
    const ma = sa / count;
    const mb = sb / count;
    let num = 0;
    let da = 0;
    let db = 0;
    for (let i = lo; i < hi; i++) {
        const x = a[i] - ma;
        const y = b[i + lag] - mb;
        num += x * y;
        da += x * x;
        db += y * y;
    }
    if (!(da > 0) || !(db > 0)) return null;
    return num / Math.sqrt(da * db);
}

/**
 * The lag at which two series correlate most strongly, searched both ways.
 *
 * A positive lag means `a` leads `b`. On Session 954 duty leads rpm by +0.58 s at r = +0.335, and
 * rpm leads duty by the same interval with the sign flipped — the valve moves, the engine follows,
 * the controller pulls it back. That symmetry is the evidence a closed loop exists at all, so the
 * search covers both signs rather than assuming the direction.
 */
export function peakLag(
    a: readonly number[],
    b: readonly number[],
    maxLagSamples: number,
    rateHz: number,
): LagPeak | null {
    if (a.length !== b.length || a.length < 16 || !(rateHz > 0)) return null;
    let bestLag: number | null = null;
    let bestR = 0;
    for (let lag = -maxLagSamples; lag <= maxLagSamples; lag++) {
        const r = correlationAtLag(a, b, lag);
        if (r === null) continue;
        if (bestLag === null || Math.abs(r) > Math.abs(bestR)) { bestLag = lag; bestR = r; }
    }
    if (bestLag === null) return null;

    /*
     * SUB-SAMPLE, by fitting a parabola through the peak and its two neighbours.
     *
     * Without this the answer is quantised to one sample, and that quantum grew when the ring
     * channels were added: three extra RAM reads take the LLS profile from 7.38 Hz to 3.37, so a
     * lag step went from 0.14 s to 0.30 s. A 0.58 s delay is then "about two samples", and the next
     * representable answer is 0.89 s — which is uncomfortably close to a figure this investigation
     * has already had to argue about.
     *
     * The interpolation is standard and is not spurious precision: the correlation function is
     * smooth near its maximum, so three points locate the vertex to well inside one step. It is
     * skipped at the ends of the search, where there is no neighbour on one side.
     */
    const rm = correlationAtLag(a, b, bestLag - 1);
    const rp = correlationAtLag(a, b, bestLag + 1);
    let lag = bestLag;
    if (rm !== null && rp !== null) {
        const denom = rm - 2 * bestR + rp;
        // Zero denominator is a flat top, which the integer peak already answers correctly.
        if (denom !== 0) {
            const shift = 0.5 * (rm - rp) / denom;
            // A vertex more than half a step away means the parabola did not fit the peak.
            if (Math.abs(shift) <= 0.5) lag = bestLag + shift;
        }
    }
    return { lagS: lag / rateHz, r: bestR, coarseLagS: bestLag / rateHz, stepS: 1 / rateHz };
}

/**
 * The first autocorrelation peak past the origin — the period of whatever is oscillating.
 *
 * The search starts past `minLagSamples` because every series correlates perfectly with itself at
 * lag 0, and that is not a period.
 *
 * **A peak must be a positive correlation.** Without that test this returned a local maximum at
 * r = -0.206 and called it a 1.86 s period: a turning point in anticorrelated territory is the
 * series being most unlike itself, which is the opposite of a repeat. It looked like an answer
 * because it had the shape of one.
 *
 * Read the strength, not just the lag. Over a whole session the notes measure r <= 0.24 at a lag of
 * 12-20 s and conclude there is no clean periodicity; it is section by section that the 2.9-3.3 s
 * at r = 0.27-0.62 appears. A weak peak here is a real finding about the drive, not a failure.
 */
export function firstPeriod(
    values: readonly number[],
    minLagSamples: number,
    maxLagSamples: number,
    rateHz: number,
): LagPeak | null {
    if (values.length < 16 || !(rateHz > 0)) return null;
    let prev: number | null = null;
    let rising = false;
    for (let lag = minLagSamples; lag <= maxLagSamples; lag++) {
        const r = correlationAtLag(values, values, lag);
        if (r === null) continue;
        if (prev !== null) {
            if (r > prev) rising = true;
            // A local maximum, once the curve has climbed into it and while it still means repeat.
            else if (rising && prev > 0) {
                return { lagS: (lag - 1) / rateHz, r: prev, coarseLagS: (lag - 1) / rateHz, stepS: 1 / rateHz };
            }
        }
        prev = r;
    }
    return null;
}

// ---------------------------------------------------------------------------
// the session
// ---------------------------------------------------------------------------

/** The rolling part of a drive. Stopped samples belong to a different operating point. */
export function rollingOnly(samples: readonly LlsSample[]): LlsSample[] {
    return samples.filter(s => Number.isFinite(s.speedKmH) && s.speedKmH > 0);
}

/**
 * Which `KF_LLS_TV` rows the measured air request actually reaches.
 *
 * This is the whole basis for confining a solve: a row the car never visited has no evidence behind
 * it, and the first draft of the notes rewrote two such rows before withdrawing them.
 *
 * It reports what the DRIVE reached and nothing else — the anchor is NOT excluded here. It used to
 * be, which made this function quietly depend on a choice that has nothing to do with the drive,
 * and made "which rows may I anchor on" unanswerable from its output. `solveLlsTv` skips the anchor
 * itself, so passing the full set is safe; the caller that wants the written set subtracts it.
 */
export function reachedRows(
    t: RingTables,
    samples: readonly LlsSample[],
    excludeMlKgH: number | null = null,
): number[] {
    const ml = samples
        .map(s => Number.isFinite(s.mlSollLlsKgH) ? (s.mlSollLlsKgH as number) : mlFromAqRel(t, s.rpm, s.aqRelPct))
        .filter((v): v is number => v !== null && Number.isFinite(v));
    if (ml.length === 0) return [];
    const lo = Math.min(...ml);
    const hi = Math.max(...ml);
    const rows = t.llsTv.y;
    return rows.filter((row, i) => {
        if (excludeMlKgH !== null && row === excludeMlKgH) return false;
        // The row is reached if the measured band overlaps the interval it governs, which runs to
        // the midpoint of each neighbour — that is the span where this row carries the most weight.
        const below = i > 0 ? (rows[i - 1] + row) / 2 : row;
        const above = i < rows.length - 1 ? (row + rows[i + 1]) / 2 : row;
        return hi >= below && lo <= above;
    });
}

/**
 * Everything a micro-throttle drive has to say, from its samples and the calibration it was
 * recorded on.
 *
 * `tdS` here is `measured` and single-point: one cross-correlation, at one operating point, on one
 * log. It should move with rpm and load, and nothing in this app yet knows by how much — which is
 * why it is reported rather than folded into a constant.
 */
export function summariseSession(t: RingTables, all: readonly LlsSample[]): LlsSessionSummary {
    const s = rollingOnly(all);
    const rateHz = sampleRateHz(s);
    // Lags convert on the cadence, not the mean — see `cadenceHz`. Taken over the whole log,
    // because the cadence is a property of the logger and not of the filter applied afterwards.
    const lagHz = cadenceHz(all) ?? rateHz;

    // Direct only if EVERY rolling sample carries it. A mixed series would put two different
    // quantities in one column and report the join as a measurement.
    const direct = s.length > 0
        && s.every(p => Number.isFinite(p.llsTvPct) && Number.isFinite(p.mlSollLlsKgH));
    const source: RingSource = direct ? 'direct' : 'reconstructed';
    const dutyOf = (p: LlsSample) => direct ? (p.llsTvPct as number) : dutyFromAqRel(t, p.aqRelPct);
    const airOf = (p: LlsSample) => direct ? (p.mlSollLlsKgH as number) : mlFromAqRel(t, p.rpm, p.aqRelPct);

    const duty = s.map(dutyOf).filter((v): v is number => v !== null && Number.isFinite(v));
    const ml = s.map(airOf).filter((v): v is number => v !== null && Number.isFinite(v));
    const rf = s.map(p => p.rf);

    const elasticity: number[] = [];
    const margins: number[] = [];
    for (const p of s) {
        const air = airOf(p);
        if (air === null || !Number.isFinite(air)) continue;
        const e = ringElasticity(t, p.rpm, air);
        if (e !== null) elasticity.push(e);
        const pm = phaseMargin(t, p.rpm, air, { measuredRf: p.rf });
        if (pm !== null) margins.push(pm.pmDeg);
    }

    // A ~6 s window at this cadence: long enough to be a trend against a 3 s oscillation, short
    // enough not to swallow it.
    const window = lagHz ? Math.max(3, Math.round(lagHz * 6)) : 30;
    const dutyResidual = duty.length === s.length ? residual(duty, window) : null;
    const frBand = band(s.map(p => p.frRegler).filter((v): v is number => Number.isFinite(v)));
    const rpmResidual = residual(s.map(p => p.rpm), window);

    const maxLag = lagHz ? Math.round(lagHz * 3) : 0;
    return {
        samples: all.length,
        rolling: s.length,
        sampleRateHz: rateHz,
        cadenceHz: cadenceHz(all),
        td: dutyResidual && lagHz ? peakLag(dutyResidual, rpmResidual, maxLag, lagHz) : null,
        dutyPpPct: dutyResidual ? Math.max(...dutyResidual) - Math.min(...dutyResidual) : null,
        period: dutyResidual && lagHz
            ? firstPeriod(dutyResidual, Math.max(2, Math.round(lagHz * 1.5)), Math.round(lagHz * 20), lagHz)
            : null,
        duty: band(duty),
        ml: band(ml),
        rf: band(rf),
        reachedRows: reachedRows(t, s),
        elasticity: band(elasticity),
        phaseMarginDeg: band(margins),
        thinMarginShare: margins.length ? margins.filter(m => m < 30).length / margins.length : null,
        source,
        frRegler: frBand,
        onTargetShare: s.length === 0 ? null : s.filter(p => onTarget(REFERENCE_BAND, {
            rpm: p.rpm, airKgH: airOf(p), speedKmH: p.speedKmH, throttlePct: p.throttlePct,
        }).all).length / s.length,
    };
}
