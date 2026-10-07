import type { LogDataPoint } from '@/lib/types';
import { interpCurve, interpGrid, isFuelCut, type LambdaLimits } from '@/lib/log-engine/lambdaGates';

/** Additional evidence for the opt-in operating-condition correction, not a claim to measure AFR.
 * These are provisional acquisition limits, not fitted engine constants. In particular, a flat
 * controller value and LA_FREEZE_FLAG=0 cannot establish closed-loop operation. The caller must
 * still establish the calibration/learning context and apply the existing sample exclusions. */
export interface SteadyEvidenceOptions {
    windowSec: number;
    minSamples: number;
    maxGapSec: number;
    /** Full peak-to-peak ranges, not +/- tolerances. RO and RF are percentage points. */
    maxRpmRange: number;
    maxLoadRange: number;
    maxRfRange: number;
    maxStftRange: number;
    /** Maximum change between the time-weighted means of the two halves, for EACH bank. */
    maxTrimHalfMeanDelta: number;
    maxLtftRange: number;
    clampMargin: number;
    purgeMaxMs: number;
    minCoolantTemp: number;
    katsTabgOn: number;
    katsTabgOff: number;
    katsTailSec: number;
    /** Explicit for causal batch/prefix equivalence. The caller knows the log's time units. */
    secondsPerTimeUnit: number;
    /** Read from the image used for the log. A missing/invalid calibration earns no evidence. */
    lambdaLimits?: LambdaLimits | null;
    /** Half-open [start, end) intervals in the log's ORIGINAL time units, as in processLogData.
     * Crossing an interval also breaks the window when no read landed inside that interval. */
    excludeTimeRanges?: ReadonlyArray<readonly [number, number]>;
}

export const STEADY_EVIDENCE_DEFAULTS: Readonly<Omit<SteadyEvidenceOptions, 'lambdaLimits'>> = Object.freeze({
    windowSec: 5,
    minSamples: 10,
    maxGapSec: 1,
    maxRpmRange: 200,
    maxLoadRange: 1,
    maxRfRange: 5,
    maxStftRange: 0.12,
    maxTrimHalfMeanDelta: 0.03,
    maxLtftRange: 0.005,
    clampMargin: 0.02,
    purgeMaxMs: 0,
    minCoolantTemp: 65,
    katsTabgOn: 850,
    katsTabgOff: 840,
    katsTailSec: 20,
    secondsPerTimeUnit: 1,
});

export type VeEvidenceReason =
    | 'eligible' | 'invalid-config' | 'invalid-time' | 'non-monotonic-time' | 'sample-gap' | 'excluded'
    | 'controller-limits-unknown' | 'operating-point-unknown' | 'trim-unknown' | 'ltft-unknown'
    | 'purge-unknown' | 'purge-active' | 'lambda-state-unknown' | 'cold-engine'
    | 'full-load' | 'fuel-cut' | 'controller-clamp' | 'cat-protect'
    | 'correction-state-unknown' | 'correction-transition' | 'correction-settling'
    | 'rpm-moving' | 'load-moving' | 'rf-moving' | 'trim-moving' | 'ltft-moving'
    | 'short-window' | 'thin-window';

type EvidencePoint = LogDataPoint & {
    veEvidenceEligible: boolean;
    veEvidenceReason: VeEvidenceReason;
    veSteadySeconds: number;
};

interface Frame {
    time: number;
    rpm: number;
    load: number;
    rf: number;
    stft1: number;
    stft2: number;
    ltft1: number;
    ltft2: number;
    trim1: number;
    trim2: number;
    gate: boolean;
    dwell?: number;
}

const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const positive = (x: unknown): x is number => finite(x) && x > 0;

function validOptions(o: SteadyEvidenceOptions): boolean {
    const nonnegative = [o.maxRpmRange, o.maxLoadRange, o.maxRfRange, o.maxStftRange,
        o.maxTrimHalfMeanDelta, o.maxLtftRange, o.clampMargin, o.purgeMaxMs, o.katsTailSec];
    return positive(o.windowSec) && Number.isInteger(o.minSamples) && o.minSamples >= 2
        && positive(o.maxGapSec) && o.maxGapSec <= o.windowSec && positive(o.secondsPerTimeUnit)
        && nonnegative.every(x => finite(x) && x >= 0) && finite(o.minCoolantTemp)
        && finite(o.katsTabgOn) && finite(o.katsTabgOff) && o.katsTabgOff <= o.katsTabgOn
        && (o.excludeTimeRanges === undefined || (Array.isArray(o.excludeTimeRanges)
            && o.excludeTimeRanges.every(r => Array.isArray(r) && r.length === 2
                && finite(r[0]) && finite(r[1]) && r[1] >= r[0])));
}

function validLimits(l: LambdaLimits | null | undefined, margin: number): l is LambdaLimits {
    if (!l || !positive(l.fMin) || !positive(l.fMax) || l.fMax - l.fMin <= margin * 2) return false;
    const axis = (a: number[]) => Array.isArray(a) && a.length > 0
        && a.every((x, i) => finite(x) && (i === 0 || x > a[i - 1]));
    const w = l.wotThreshold, load = l.loadThreshold;
    return !!w && !!load && axis(w.x) && axis(w.y) && axis(load.x)
        && Array.isArray(w.z) && w.z.length === w.y.length
        && w.z.every(row => Array.isArray(row) && row.length === w.x.length && row.every(positive))
        && Array.isArray(load.y) && load.y.length === load.x.length && load.y.every(positive);
}

function frameReason(p: LogDataPoint, o: SteadyEvidenceOptions): VeEvidenceReason | undefined {
    const load = p.correctedLoad ?? p.rawLoad;
    if (!positive(p.rpm) || !finite(load) || load < 0 || !positive(p.rf)) return 'operating-point-unknown';
    if (!positive(p.stft1) || !positive(p.stft2)) return 'trim-unknown';
    if (!positive(p.ltft1) || !positive(p.ltft2)) return 'ltft-unknown';
    if (!finite(p.tankVent) || p.tankVent < 0) return 'purge-unknown';
    if (p.tankVent > o.purgeMaxMs) return 'purge-active';
    if (!finite(p.coolantTemp) || !finite(p.wdk1) || p.wdk1 < 0 || !finite(p.exhaustTemp)) {
        return 'lambda-state-unknown';
    }
    if (p.coolantTemp < o.minCoolantTemp) return 'cold-engine';
    const limits = o.lambdaLimits!;
    if (p.wdk1 >= interpGrid(limits.wotThreshold, p.rpm, p.coolantTemp)
        || p.rf / 100 >= interpCurve(limits.loadThreshold, p.rpm)) return 'full-load';
    if (isFuelCut(p.stft1, p.stft2, p.wdk1, p.rawLoad)) return 'fuel-cut';
    if ([p.stft1, p.stft2].some(t => t <= limits.fMin + o.clampMargin || t >= limits.fMax - o.clampMargin)) {
        return 'controller-clamp';
    }
    // The legacy gate reconstruction returns false when speed is missing. That fallback is useful
    // for displaying old logs, but it is not proof that the real ECU's gate was shut.
    if (!finite(p.vehicleSpeed) || p.vehicleSpeed < 0 || typeof p.rfKorrGateOpen !== 'boolean'
        || (p.rfKorrGateOpen && (!finite(p.rfKorrDwellSec) || p.rfKorrDwellSec < 0))) {
        return 'correction-state-unknown';
    }
    return undefined;
}

function asFrame(p: LogDataPoint, time: number): Frame {
    return {
        time, rpm: p.rpm, load: p.correctedLoad ?? p.rawLoad, rf: p.rf!,
        stft1: p.stft1!, stft2: p.stft2!, ltft1: p.ltft1!, ltft2: p.ltft2!,
        trim1: p.stft1! * p.ltft1!, trim2: p.stft2! * p.ltft2!,
        gate: p.rfKorrGateOpen!, dwell: p.rfKorrDwellSec,
    };
}

/** Integrate the logged bank products over time, linearly between reads. Sample rate changes must
 * not turn the same controller trace into a different apparent trend. The frame list brackets the
 * interval; there is no forward extrapolation and no use of a point after the current sample. */
function timeMean(frames: readonly Frame[], from: number, to: number, bank: 'trim1' | 'trim2'): number {
    let area = 0;
    for (let i = 1; i < frames.length; i++) {
        const a = frames[i - 1], b = frames[i];
        const lo = Math.max(from, a.time), hi = Math.min(to, b.time);
        if (hi <= lo) continue;
        const slope = (b[bank] - a[bank]) / (b.time - a.time);
        const vLo = a[bank] + slope * (lo - a.time), vHi = a[bank] + slope * (hi - a.time);
        area += (vLo + vHi) * (hi - lo) / 2;
    }
    return area / (to - from);
}

/** Annotate an intact, chronologically recorded timeline. Missing/invalid frames, a time reset,
 * purge, a controller stop, and a correction transition break the evidence window. Callers must
 * not feed only the retained VE rows: doing so can conceal an intervening excursion.
 *
 * All decisions use the current sample and its past. Replaying a prefix gives exactly the same
 * annotations as the corresponding prefix of the full replay. No input object/array is changed.
 * The gate fields are the existing reconstructed gate/dwell, not unverified direct RAM channels.
 * An eligible point is still conditional evidence, not proof of every unlogged ECU fuel term. */
export function annotateSteadyEvidence(
    fullRawTimeline: readonly LogDataPoint[], options: Partial<SteadyEvidenceOptions> = {},
): EvidencePoint[] {
    const o: SteadyEvidenceOptions = { ...STEADY_EVIDENCE_DEFAULTS,
        ...Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)) };
    const mark = (p: LogDataPoint, reason: VeEvidenceReason, seconds = 0): EvidencePoint => ({
        ...p, veEvidenceEligible: reason === 'eligible', veEvidenceReason: reason,
        veSteadySeconds: Math.min(o.windowSec, Math.max(0, seconds)),
    });
    if (!validOptions(o)) return fullRawTimeline.map(p => ({ ...mark(p, 'invalid-config'), veSteadySeconds: 0 }));
    if (!validLimits(o.lambdaLimits, o.clampMargin)) return fullRawTimeline.map(p => mark(p, 'controller-limits-unknown'));

    let history: Frame[] = [];
    let previousTime: number | undefined;
    let lastKatsHot = -Infinity;
    const result: EvidencePoint[] = [];
    const rangeRules: ReadonlyArray<[keyof Pick<Frame, 'rpm' | 'load' | 'rf' | 'stft1' | 'stft2' | 'ltft1' | 'ltft2'>, number, VeEvidenceReason]> = [
        ['rpm', o.maxRpmRange, 'rpm-moving'], ['load', o.maxLoadRange, 'load-moving'],
        ['rf', o.maxRfRange, 'rf-moving'], ['stft1', o.maxStftRange, 'trim-moving'],
        ['stft2', o.maxStftRange, 'trim-moving'], ['ltft1', o.maxLtftRange, 'ltft-moving'],
        ['ltft2', o.maxLtftRange, 'ltft-moving'],
    ];

    for (const p of fullRawTimeline) {
        const now = p.time * o.secondsPerTimeUnit;
        if (!finite(p.time) || !finite(now)) {
            history = []; previousTime = undefined;
            // Time is unknown, so the cat-protection tail cannot be said to have expired.
            if (lastKatsHot !== -Infinity || (finite(p.exhaustTemp) && p.exhaustTemp >= o.katsTabgOn)) {
                lastKatsHot = Infinity;
            }
            result.push(mark(p, 'invalid-time')); continue;
        }
        if (previousTime !== undefined && now <= previousTime) {
            history = []; previousTime = now;
            // Restart an outstanding tail in the new clock rather than clearing a known risk.
            if (lastKatsHot !== -Infinity || (finite(p.exhaustTemp) && p.exhaustTemp >= o.katsTabgOn)) {
                lastKatsHot = now;
            }
            result.push(mark(p, 'non-monotonic-time')); continue;
        }
        if (lastKatsHot === Infinity) lastKatsHot = now;
        const gap = previousTime !== undefined && now - previousTime > o.maxGapSec;
        const crossedExclusion = o.excludeTimeRanges?.some(([a, b]) => b > a
            && now >= a * o.secondsPerTimeUnit
            && (now < b * o.secondsPerTimeUnit
                || (previousTime !== undefined && previousTime < b * o.secondsPerTimeUnit)));
        previousTime = now;
        if (finite(p.exhaustTemp) && p.exhaustTemp >= o.katsTabgOn) lastKatsHot = now;
        const catProtect = lastKatsHot !== -Infinity
            && (!finite(p.exhaustTemp) || p.exhaustTemp >= o.katsTabgOff || now - lastKatsHot < o.katsTailSec);
        const reason = crossedExclusion ? 'excluded' : catProtect ? 'cat-protect' : frameReason(p, o);
        if (reason) { history = []; result.push(mark(p, reason)); continue; }

        const frame = asFrame(p, now), previous = history.at(-1);
        const transition = previous && (frame.gate !== previous.gate
            || (frame.gate && frame.dwell! < previous.dwell!));
        if (gap || transition) {
            history = [frame];
            result.push(mark(p, gap ? 'sample-gap' : 'correction-transition')); continue;
        }
        history.push(frame);
        // Retain one point at/before the boundary to demonstrate a full observed interval.
        while (history.length > 1 && history[1].time <= now - o.windowSec) history.shift();

        const ranges = rangeRules.map(([key]) => ({ lo: frame[key], hi: frame[key] }));
        let first = history.length - 1;
        let unstable: VeEvidenceReason | undefined;
        for (let i = history.length - 2; i >= 0; i--) {
            for (let r = 0; r < rangeRules.length; r++) {
                const [key, bound, fail] = rangeRules[r], range = ranges[r];
                range.lo = Math.min(range.lo, history[i][key]);
                range.hi = Math.max(range.hi, history[i][key]);
                if (range.hi - range.lo > bound + 1e-12) { unstable = fail; break; }
            }
            if (unstable) break;
            first = i;
        }
        const steadySeconds = now - history[first].time;
        if (steadySeconds + 1e-9 < o.windowSec) {
            result.push(mark(p, unstable ?? (frame.gate && frame.dwell! < o.windowSec
                ? 'correction-settling' : 'short-window'), steadySeconds)); continue;
        }
        if (frame.gate && frame.dwell! + 1e-9 < o.windowSec) {
            result.push(mark(p, 'correction-settling', Math.min(steadySeconds, frame.dwell!))); continue;
        }
        const window = history.slice(first);
        if (window.filter(f => f.time >= now - o.windowSec).length < o.minSamples) {
            result.push(mark(p, 'thin-window', steadySeconds)); continue;
        }
        const start = now - o.windowSec, middle = now - o.windowSec / 2;
        if ((['trim1', 'trim2'] as const).some(bank => Math.abs(
            timeMean(window, start, middle, bank) - timeMean(window, middle, now, bank),
        ) > o.maxTrimHalfMeanDelta + 1e-12)) {
            result.push(mark(p, 'trim-moving')); continue;
        }
        result.push(mark(p, 'eligible', steadySeconds));
    }
    return result;
}

export interface OperatingCorrectionInput {
    trim?: number;
    /** Undefined when the applied/planned correction or its gate is not established. Never
     * substitute 1 for missing evidence; a proved shut gate may explicitly supply 1. */
    kApplied?: number;
    kPlanned?: number;
    /** Gain on the WHOLE requested change, in [0, 1]. This is not an exponent fitted to rf_korr. */
    learningRate?: number;
}

/** Local steady-state identity. The caller must separately validate interpolation, changed gate
 * thresholds, and the resulting ECU path. Damping the complete demand toward one cannot reverse
 * its direction. Equal old/new corrections cancel, so a neutral trim remains exactly neutral. */
export function deriveOperatingCorrection({ trim, kApplied, kPlanned, learningRate }: OperatingCorrectionInput): number | undefined {
    if (!positive(trim) || !positive(kApplied) || !positive(kPlanned)
        || !finite(learningRate) || learningRate < 0 || learningRate > 1) return undefined;
    const demand = trim * (kApplied / kPlanned);
    if (!positive(demand)) return undefined;
    const correction = demand ** learningRate;
    return positive(correction) ? correction : undefined;
}
