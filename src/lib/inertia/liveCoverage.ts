/**
 * What the run has actually collected, while it is still running.
 *
 * ## Why this exists
 *
 * The panel used to show one number during a run: how many samples had arrived. That number is
 * worse than useless, because it is the one figure guaranteed to look healthy in the case that
 * matters — a run where every sample is being thrown away still counts up at nine a second. A real
 * drive was lost to exactly that: 265 samples collected, 265 samples rejected, and nothing on
 * screen said so until the run had already ended.
 *
 * So this reports what the estimator would keep, per rpm bin, as it happens — and it does that by
 * calling `admitSample`, the same function the final verdict calls. Not a copy of the rules, the
 * rules. Two implementations of "is this sample usable" drift, and the drift is invisible until
 * someone has already driven.
 *
 * ## Why it recomputes rather than accumulating
 *
 * A sample cannot be judged when it arrives: the gradient cross-check needs a window on both sides
 * of it, so the newest `gradientHalfWindow` samples are always pending, and a sample already
 * counted can never change afterwards. An incremental accumulator would therefore need its own
 * pending-window bookkeeping — state that can disagree with the estimator in ways no test would
 * catch. Recomputing the whole array is O(n) per call, n is a few hundred to a few thousand, and
 * the caller throttles to a few times a second. That is nothing, and it cannot drift.
 */

import type { InertiaSample } from '../dme-link/types';
import type { InertiaEstimatorOptions, InertiaRejectCounts, InertiaRejectReason } from './types';
import { DEFAULT_INERTIA_OPTIONS } from './types';
import { admitSample } from './estimator';

/** No combustion torque, Nm. Same band the estimator's coast-down search uses. */
const NO_COMBUSTION_TORQUE_NM = 0.5;
/** Throttle shut, %. Same threshold the estimator's coast-down search uses. */
const CLOSED_THROTTLE_PCT = 0.5;

export interface LiveBin {
    loRpm: number;
    hiRpm: number;
    /** Samples in this bin the estimator would keep. */
    count: number;
    /** How many more this bin needs to reach `minBinSamples`. Zero once satisfied. */
    need: number;
    /** Angular-acceleration span covered so far, rad/s². */
    alphaSpan: number;
    /**
     * True when the bin has enough samples AND enough spread.
     *
     * Both, because they fail for different reasons and the driver's remedy differs: too few
     * samples means sweep again, too little spread means sweep again *at a different pedal*.
     */
    satisfied: boolean;
    /** Set when the count is there but the spread is not — i.e. sweep at a different pedal. */
    needsMorePedalSpread: boolean;
}

export interface LiveCoverage {
    bins: LiveBin[];
    /** Reject tallies so far, most common first. The single most useful thing on screen when a run
     *  is going wrong: it names the gate rather than leaving the driver to guess. */
    rejects: InertiaRejectCounts[];
    seen: number;
    accepted: number;
    /** Mean rate over the run so far, Hz. Mean, not median — see the note in InertiaPanel. */
    hz: number | null;
    /** Longest run of consecutive in-neutral overrun-cut samples seen so far. The coast-down. */
    coastDownSamples: number;
    /** Whether a usable coast-down has been captured (the estimator needs 4 consecutive). */
    coastDownCaptured: boolean;
    /** Every bin satisfied and the coast-down captured — the run can stop. */
    ready: boolean;
    /** Bins still short, as a compact "1750-2250 needs 7 more" list for the panel. */
    outstanding: string[];
}

/** Minimum consecutive cut samples `checkFreeDecel` requires before it will use a coast-down. */
const MIN_COAST_DOWN_SAMPLES = 4;

export function liveCoverage(
    samples: readonly InertiaSample[],
    options: Partial<InertiaEstimatorOptions> = {},
): LiveCoverage {
    const opts: InertiaEstimatorOptions = { ...DEFAULT_INERTIA_OPTIONS, ...options };

    const rejectCounts = new Map<InertiaRejectReason, number>();
    const byBin = new Map<number, { count: number; min: number; max: number }>();
    let accepted = 0;

    for (let i = 0; i < samples.length; i++) {
        const verdict = admitSample(samples, i, opts);
        if (!verdict.ok) {
            rejectCounts.set(verdict.reason, (rejectCounts.get(verdict.reason) ?? 0) + 1);
            continue;
        }
        accepted++;
        const { rpm, alpha } = verdict.accepted;
        const lo = opts.minRpm + Math.floor((rpm - opts.minRpm) / opts.binWidthRpm) * opts.binWidthRpm;
        const cell = byBin.get(lo);
        if (cell) {
            cell.count++;
            if (alpha < cell.min) cell.min = alpha;
            if (alpha > cell.max) cell.max = alpha;
        } else {
            byBin.set(lo, { count: 1, min: alpha, max: alpha });
        }
    }

    const bins: LiveBin[] = [];
    const outstanding: string[] = [];
    for (let lo = opts.minRpm; lo < opts.maxRpm; lo += opts.binWidthRpm) {
        const cell = byBin.get(lo);
        const count = cell?.count ?? 0;
        const alphaSpan = cell ? cell.max - cell.min : 0;
        const need = Math.max(0, opts.minBinSamples - count);
        const spreadOk = alphaSpan >= opts.minAlphaSpan;
        const satisfied = need === 0 && spreadOk;
        bins.push({
            loRpm: lo, hiRpm: lo + opts.binWidthRpm, count, need, alphaSpan,
            satisfied, needsMorePedalSpread: need === 0 && !spreadOk,
        });
        if (need > 0) outstanding.push(`${lo}-${lo + opts.binWidthRpm}: +${need}`);
        else if (!spreadOk) outstanding.push(`${lo}-${lo + opts.binWidthRpm}: 別開度で`);
    }

    // The coast-down, found the same way `checkFreeDecel` finds it: the longest consecutive run of
    // neutral samples with the cut bit set. Reported live because it is the one part of the
    // procedure that is easy to forget and impossible to add afterwards.
    let coastDownSamples = 0;
    let current = 0;
    for (const s of samples) {
        const coasting = s.mdIndNe !== null && s.mdIndNe <= NO_COMBUSTION_TORQUE_NM
            && s.wdk1 !== null && s.wdk1 <= CLOSED_THROTTLE_PCT
            && s.rpm !== null && s.rpm >= opts.minRpm;
        current = coasting ? current + 1 : 0;
        if (current > coastDownSamples) coastDownSamples = current;
    }

    const span = samples.length > 1 ? samples[samples.length - 1].time - samples[0].time : 0;
    const coastDownCaptured = coastDownSamples >= MIN_COAST_DOWN_SAMPLES;

    return {
        bins,
        rejects: [...rejectCounts.entries()]
            .map(([reason, count]) => ({ reason, count }))
            .sort((a, b) => b.count - a.count),
        seen: samples.length,
        accepted,
        hz: span > 0 ? (samples.length - 1) / span : null,
        coastDownSamples,
        coastDownCaptured,
        // `ready` must mean "the estimator would accept this", and the estimator asks for
        // `minAcceptedBins` bins, not for all of them. Requiring every bin was stricter than the
        // verdict — the top bin never fills, because the sweeps turn round at `maxRpm` and spend
        // almost no time up there — so the display told the driver to keep going long after the
        // measurement was good. That is the same class of lie as a progress bar that fills while
        // every sample is being rejected, just pointing the other way.
        //
        // The coast-down is still required on top. It is the only independent falsification the
        // estimate has, and a run that stops without it produces a number with nothing to check it
        // against. `outstanding` still lists every short bin, so "you may stop" and "here is what
        // would make it better" stay separate answers.
        ready: bins.filter(b => b.satisfied).length >= opts.minAcceptedBins && coastDownCaptured,
        outstanding,
    };
}
