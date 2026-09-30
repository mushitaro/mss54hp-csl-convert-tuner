/**
 * Two idle runs, one gain.
 *
 * `gain.ts` has been able to learn the torque-to-duty gain since it was written and has never been
 * given a pair to learn from: `tuneIdleFeedforward`'s `gainOverride` had no caller, so every
 * campaign ran forever on the deliberately low 0.40 prior. The design's own promise — "an
 * inaccurate gain is a slower campaign rather than an unstable one" — only holds if the campaign
 * eventually stops being slow. This is the missing half.
 *
 * ## What a pair is
 *
 * One operating point, measured twice, with a known change to the map in between:
 *
 *     deltaDutyPct  = KF_LLS_TV_after(n, ml) - KF_LLS_TV_before(n, ml)      what the DME got
 *     deltaErrorNm  = error_after            - error_before                 what it did about it
 *
 * Both **interpolated at the dwell's own operating point**, never read off a breakpoint. This car
 * idles at 880 rpm between the 800 and 950 columns, so the duty it actually sees is a weighted
 * blend of four cells; using a cell delta would overstate the change by 1/w and learn a gain that
 * is too small by the same factor — which would then damp the next pass further, and the campaign
 * would converge more slowly the harder it tried.
 *
 * ## What is deliberately NOT here
 *
 * No attempt to match dwells one-to-one across runs. A dwell is a 20 s window at an operating point
 * the driver did not choose, and two runs will not repeat one. Instead each run is reduced to its
 * own weighted operating point and error, and the pair is formed between those. That is one pair
 * per run-pair rather than several, which sounds wasteful and is not: the pairs `learnGain` wants
 * are INDEPENDENT observations of the slope, and two dwells inside one run at one idle speed are
 * not independent — they are the same observation twice.
 */

import type { IdleSample } from '@/lib/dme-link/types';
import type { IdleTables } from './idleTables';
import { llsTvAt, llsTvSlopePctPerKgH } from './valveModel';
import { tuneIdleFeedforward } from './tuner';
import { learnGain, type GainPair, type GainLearnResult } from './gain';
import type { IdleTuneOptions } from './types';
import { withDefaults } from './types';

/** One run reduced to the single operating point its accepted dwells sat at, and the error there. */
export interface RunPoint {
    /** Sample-weighted mean rpm over the accepted dwells. */
    rpm: number;
    /** Sample-weighted mean `ML_SOLL_LLS`, kg/h — the map's other axis. */
    air: number;
    /** Sample-weighted mean of `md_llri + md_llra - target`, Nm. */
    errorNm: number;
    /** How many samples stand behind it, so a thin run can be refused by the caller. */
    samples: number;
    dwells: number;
}

/**
 * Reduce a run to its operating point, or null when it accepted no dwell.
 *
 * Weighted by samples for the reason the cell pooling is: a 90 s window says more than a 20 s one.
 * Runs the same `tuneIdleFeedforward` the panel runs rather than a second copy of the admission
 * rules — the whole reason a census and a verdict share one function.
 */
export function runPoint(
    samples: readonly IdleSample[],
    tables: IdleTables,
    opts?: Partial<IdleTuneOptions>,
): RunPoint | null {
    const res = tuneIdleFeedforward(samples, tables, opts);
    if (!res) return null;
    const accepted = res.dwells.filter(d => !d.rejected && d.mlSollLlsMean !== null);
    if (!accepted.length) return null;
    const w = accepted.reduce((a, d) => a + d.samples, 0);
    if (w <= 0) return null;
    return {
        rpm: accepted.reduce((a, d) => a + d.rpmMean * d.samples, 0) / w,
        air: accepted.reduce((a, d) => a + (d.mlSollLlsMean as number) * d.samples, 0) / w,
        errorNm: accepted.reduce((a, d) => a + d.error * d.samples, 0) / w,
        samples: w,
        dwells: accepted.length,
    };
}

/**
 * The pair between an earlier run and a later one.
 *
 * `before`/`after` are the two runs' own binaries — what the DME was actually holding when each was
 * recorded. Interpolated at the LATER run's operating point, because that is where the after-error
 * was measured; the two points are close by construction (an idle is an idle) and using one of them
 * consistently is what keeps the difference a property of the map rather than of where the car
 * happened to settle.
 *
 * `null` when either run accepted nothing. A pair built on a run that measured nothing is not a
 * weak pair, it is not a pair.
 */
export function pairFromRuns(
    before: { samples: readonly IdleSample[]; tables: IdleTables },
    after: { samples: readonly IdleSample[]; tables: IdleTables },
    opts?: Partial<IdleTuneOptions>,
): GainPair | null {
    const a = runPoint(before.samples, before.tables, opts);
    const b = runPoint(after.samples, after.tables, opts);
    if (!a || !b) return null;
    const dutyBefore = llsTvAt(before.tables.llsTv, b.rpm, b.air);
    const dutyAfter = llsTvAt(after.tables.llsTv, b.rpm, b.air);
    return {
        deltaDutyPct: dutyAfter - dutyBefore,
        deltaErrorNm: b.errorNm - a.errorNm,
        rpm: b.rpm,
    };
}

/**
 * The learned gain for a campaign, from its runs in order.
 *
 * Pairs are formed against the FIRST run rather than the previous one — the rule `gain.ts` already
 * documents for `minLearnableDeltaNm`. Against the previous run, each pass moves the error by about
 * one damped step and most pairs fall under the learnable threshold forever; against the first, the
 * signal grows with the campaign, so a gain that is wrong by a factor of two is discovered by run
 * three rather than never.
 *
 * `runs` must be ordered oldest first, each with the binary it was recorded against.
 */
export function learnIdleGain(
    runs: readonly { samples: readonly IdleSample[]; tables: IdleTables }[],
    opts?: Partial<IdleTuneOptions>,
): GainLearnResult {
    const o = withDefaults(opts);
    // Before anything reads runs[0]. An empty campaign is not an error, it is a campaign with
    // nothing learned yet, and the caller gets the prior in the AIR unit because there is no map to
    // convert it with.
    if (!runs.length) {
        return { gain: o.gainKgHPerNm, used: o.gainKgHPerNm, rejected: [], learned: false };
    }
    const first = runs[0];

    /**
     * THE UNIT CONVERSION, and it is the whole reason this function exists rather than a direct
     * `learnGain` call.
     *
     * `IDLE_TUNE_DEFAULTS.gainKgHPerNm` and its rails are AIR gains — (kg/h)/Nm — from when the
     * correction was written in kg/h into `KF_LLR_QVS_GRUND`. What is learned now is a DUTY gain,
     * %/Nm, because that is what `KF_LLS_TV` holds. Handing 0.40 (kg/h)/Nm to a %/Nm learner as its
     * prior does not fail loudly: it drags every learned value toward a number in the wrong unit,
     * and the pool comes back plausible and wrong. Measured on the synthetic campaign in
     * verify:idle-gain: a true 0.80 %/Nm was pulled to 0.606.
     *
     * So the air constants stay what they say they are, and the conversion happens here, once, by
     * the map's own slope at the campaign's own operating point — the same factor the tuner uses
     * (`slope * g_air`), evaluated where the evidence actually sits rather than at a breakpoint.
     *
     * At the reference rpm, so it matches what `learnGain` normalises its pairs back to.
     */
    const p0 = runPoint(first.samples, first.tables, opts);
    const slope = p0 ? llsTvSlopePctPerKgH(first.tables.llsTv, p0.rpm, p0.air) : null;
    // No slope means no conversion, and a prior in the wrong unit is worse than no learning at all.
    const k = slope !== null && slope > 0 ? slope : null;
    const prior = k === null ? o.gainKgHPerNm : k * o.gainKgHPerNm;

    if (runs.length < 2 || k === null) {
        return { gain: prior, used: prior, rejected: [], learned: false };
    }
    const pairs: GainPair[] = [];
    for (const run of runs.slice(1)) {
        const p = pairFromRuns(first, run, opts);
        if (p) pairs.push(p);
    }
    return learnGain(pairs, prior, {
        // The rails travel through the same factor. They bound a PHYSICAL claim about how much air
        // a Nm of governor effort is worth; scaled by the map's slope they bound the same claim in
        // the unit the map is written in.
        gainMin: k * o.gainMin, gainMax: k * o.gainMax, gainRefRpm: o.gainRefRpm,
    });
}
