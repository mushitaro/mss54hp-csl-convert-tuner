import type { LogDataPoint } from '@/lib/types';
import { axisBracket } from './axisBracket';

/**
 * Does this drive contain more than one population?
 *
 * ## The failure this exists to stop
 *
 * Session #920 (2026-08-23, 13,608 samples, 52 minutes) asked the map to come down another 3.8 %
 * in cells that had just been written. It was not the tune drifting and not a bad flash — the
 * write had landed, confirmed both by the spot read-back and by the gate-shut identity switching
 * sides between the drives. It was that ONE STRETCH of the drive disagreed with the rest:
 *
 *     whole drive          residual 0.9594   median change -3.8 %   34 cells beyond +-5 %
 *     minus minutes 8-35   residual 0.9882   median change -1.0 %    5 cells
 *     minutes 8-35 only    residual 0.9144   median change -6.8 %   49 cells
 *
 * Both banks moved together, lambda control never opened, the purge valve read zero throughout,
 * and the trim returned to 0.999 for the last fifteen minutes. Whatever it was, the app averaged
 * it with the healthy 27 minutes and produced a map that is right for neither. **Nothing on
 * screen said so.** A -1 % drive read as a -4 % drive, and -4 % is a number somebody writes.
 *
 * ## Why it is measured on PAIRED CELLS
 *
 * The obvious test — compare the median correction early against late — is wrong, and wrong in a
 * way that manufactures splits: the median moves when you drive somewhere else, because different
 * cells carry different corrections. The first cut of this analysis binned by (rpm, load) with a
 * coarse rounding and "found" a 4 % shift that was entirely the load bins being 0.35 in one drive
 * and 0.43 in the other.
 *
 * So the drive is compared with itself only through cells that BOTH sides visited, and the number
 * reported is the median of the per-cell ratios. What you drove cancels; only how it burned is
 * left.
 *
 * ## The thresholds, measured
 *
 * Cross-drive agreement on this car, on cells two healthy drives share: median 1.03 %, p90 2.09 %,
 * max 2.47 % (#915 vs #917, 52 shared cells). The #920 episode: 5-7 %. `MIN_GAP_PCT` sits at 3.0
 * between those two populations, and `MIN_SHARED_CELLS` at 8 because a gap over three cells is a
 * coincidence, not a finding.
 *
 * ## What this deliberately does NOT do
 *
 * It does not exclude anything. Dropping data because it disagrees is the shortest path to
 * fooling yourself, and the disagreeing stretch is often the interesting one — on #920 it is the
 * only evidence that something happens to this engine in slow traffic. The detector names the
 * stretch and puts the two numbers side by side; a human decides, and if they exclude it the
 * decision is recorded in `LogFilterConfig.excludeTimeRanges` so the session still reproduces.
 */

/** A stretch of the drive, in the log's own time units. */
export interface DriveSpan {
    from: number;
    to: number;
}

/**
 * The stretch currently taken out, or null — read from the CONFIG, never from the detector.
 *
 * These are two different facts and conflating them cost a release: the detector answers "does
 * this drive split?", the config answers "did somebody act on it?". The first version drove the
 * whole notice off the detector, so the moment EXCLUDE was pressed the offending stretch left the
 * log, the detector correctly found nothing in what remained, and the notice — with its RESTORE
 * — vanished. The exclusion stayed in force, silently, with no way back to it on screen. Measured
 * on #920: 6,478 samples dropped, `driveSplit` null, chip and bar both gone.
 *
 * A control must never strand the value it set. The config is what makes the excluded state
 * visible for exactly as long as it is true.
 */
export function activeExclusion(
    cfg: { excludeTimeRanges?: Array<[number, number]> } | null | undefined,
): DriveSpan | null {
    const r = cfg?.excludeTimeRanges;
    if (!r || r.length === 0) return null;
    // One span in the UI today; the field is a list because a second drive may want a second, and
    // widening a stored shape later is the change that breaks archived sessions.
    const [from, to] = r[0];
    return Number.isFinite(from) && Number.isFinite(to) && to > from ? { from, to } : null;
}

export interface DriveSplit {
    /** The stretch that disagrees with the rest of the drive. */
    odd: DriveSpan;
    /**
     * How far apart the two populations are, in percent, signed.
     *
     * Positive means the odd stretch wants MORE fuel than the rest (its correction is higher);
     * negative means less. The sign is worth carrying: "richer for 25 minutes" and "leaner for 25
     * minutes" have different causes and the reader is about to go looking for one.
     */
    gapPct: number;
    /** Cells the comparison could actually use — the weight behind `gapPct`. */
    sharedCells: number;
    /** Samples inside the odd stretch, and in the rest, after filtering. */
    oddSamples: number;
    restSamples: number;
    /** The odd stretch as a fraction of the drive's duration, 0-1. */
    oddFraction: number;
}

export interface DriveSplitOptions {
    /** Minimum |gap| to report, percent. */
    minGapPct: number;
    /** Minimum cells present on both sides. */
    minSharedCells: number;
    /** Minimum samples a cell needs on EACH side to be shared. */
    minCellSamples: number;
    /** Shortest stretch worth naming, seconds. Below this it is an event, not a population. */
    minSpanSec: number;
    /** Search grid, seconds. */
    stepSec: number;
    /**
     * How many seconds one unit of `time` is. 1 for a DS2 run; a Testo CSV counts in milliseconds,
     * and without this every span test would be off by a thousand and the detector would call any
     * drive a split.
     */
    secondsPerUnit: number;
}

export const DRIVE_SPLIT_DEFAULTS: DriveSplitOptions = {
    minGapPct: 3.0,
    minSharedCells: 8,
    minCellSamples: 6,
    minSpanSec: 120,
    stepSec: 20,
    secondsPerUnit: 1,
};

interface Sample {
    t: number;
    cell: number;
    /** trim x rf_korr — the correction this sample asks the table for. */
    corr: number;
}

const median = (v: number[]): number => {
    if (!v.length) return NaN;
    const s = [...v].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * @param annotated  the log AFTER `annotateRfKorr` — `rfKorr` is what makes a sample comparable
 *                   across stretches, because it is the part of the correction the DME applied
 *                   rather than the part the closed loop learned.
 * @param veAxes     the map's own axes, so a sample lands in the same cell it will be binned into.
 */
export function detectDriveSplit(
    annotated: LogDataPoint[],
    veAxes: { rpm: number[]; load: number[] },
    opts: Partial<DriveSplitOptions> = {},
): DriveSplit | null {
    const o = { ...DRIVE_SPLIT_DEFAULTS, ...opts };
    const perUnit = o.secondsPerUnit > 0 ? o.secondsPerUnit : 1;
    const minSpan = o.minSpanSec / perUnit;   // both in the log's own time units from here on
    const step = o.stepSec / perUnit;

    const samples: Sample[] = [];
    for (const p of annotated) {
        if (p.stft1 === undefined || p.rfKorr === undefined) continue;
        const trim = (p.stft1 + (p.stft2 ?? p.stft1)) / 2;
        const corr = trim * p.rfKorr;
        if (!(corr > 0)) continue;
        const load = p.correctedLoad ?? p.rawLoad;
        const r = axisBracket(veAxes.load, load), c = axisBracket(veAxes.rpm, p.rpm);
        if (!r || !c) continue;   // no rpm or no load is not a cell, and never a population
        // The nearer node, not the bracket's lower edge: a cell key is only an identity here, and
        // splitting one physical operating point across two keys costs shared cells for nothing.
        const ri = r.w1 >= 0.5 ? r.i1 : r.i0;
        const ci = c.w1 >= 0.5 ? c.i1 : c.i0;
        samples.push({ t: p.time, cell: ri * 1000 + ci, corr });
    }
    if (samples.length < 200) return null;
    samples.sort((a, b) => a.t - b.t);

    const t0 = samples[0].t, t1 = samples[samples.length - 1].t;
    const duration = t1 - t0;
    if (duration < minSpan * 2) return null;

    // --- 1. Normalise each sample by its own cell's whole-drive median -------------------------
    //
    // For the SEARCH only. This is circular if you use it as an answer — the whole-drive median is
    // itself contaminated by the stretch being looked for — but it is exactly right for finding
    // WHERE to cut, because it flattens "what you drove" and leaves "how it burned". The answer
    // comes from the paired-cell comparison below, which is not normalised by anything.
    const perCell = new Map<number, number[]>();
    for (const s of samples) {
        const v = perCell.get(s.cell);
        if (v) v.push(s.corr); else perCell.set(s.cell, [s.corr]);
    }
    const cellMedian = new Map<number, number>();
    for (const [k, v] of perCell) if (v.length >= o.minCellSamples) cellMedian.set(k, median(v));
    const rel: { t: number; v: number }[] = [];
    for (const s of samples) {
        const m = cellMedian.get(s.cell);
        if (m !== undefined && m > 0) rel.push({ t: s.t, v: s.corr / m });
    }
    if (rel.length < 200) return null;

    // --- 2. Find the window whose mean departs furthest from the rest --------------------------
    //
    // Means on the normalised series, with prefix sums, so the O(n^2) sweep over a 20 s grid is a
    // few thousand additions rather than a few thousand sorts. Means are fine here: this only
    // picks the candidate boundaries, and a mean is more sensitive than a median to exactly the
    // partial shift a real episode starts and ends with.
    const grid: number[] = [];
    for (let t = t0; t <= t1; t += step) grid.push(t);
    grid.push(t1 + 1e-6);
    const cum: number[] = [0], cnt: number[] = [0];
    let gi = 1;
    let sum = 0, n = 0;
    for (const r of rel) {
        while (gi < grid.length && r.t >= grid[gi]) { cum[gi] = sum; cnt[gi] = n; gi++; }
        sum += r.v; n++;
    }
    while (gi < grid.length) { cum[gi] = sum; cnt[gi] = n; gi++; }
    const total = sum, totalN = n;

    const minCells = Math.max(1, Math.round(minSpan / step));
    let best: { a: number; b: number; score: number } | null = null;
    for (let a = 0; a + minCells < grid.length; a++) {
        for (let b = a + minCells; b < grid.length; b++) {
            const inN = cnt[b] - cnt[a];
            const outN = totalN - inN;
            if (inN < 60 || outN < 60) continue;
            // The odd stretch is the minority by construction; a "split" where the odd part is most
            // of the drive is the same fact stated backwards, and naming the majority as the
            // anomaly would send the reader to look at the wrong twenty minutes.
            if (inN > totalN * 0.6) continue;
            const inMean = (cum[b] - cum[a]) / inN;
            const outMean = (total - (cum[b] - cum[a])) / outN;
            // Weighted by how much evidence stands behind the smaller side, so a 5 % gap over 3,000
            // samples outranks a 9 % gap over 61.
            const score = Math.abs(inMean - outMean) * Math.sqrt(Math.min(inN, outN));
            if (!best || score > best.score) best = { a: grid[a], b: grid[b], score };
        }
    }
    if (!best) return null;

    // --- 3. The honest number: paired cells, no normalisation ---------------------------------
    const inside = new Map<number, number[]>(), outside = new Map<number, number[]>();
    for (const s of samples) {
        const target = (s.t >= best.a && s.t < best.b) ? inside : outside;
        const v = target.get(s.cell);
        if (v) v.push(s.corr); else target.set(s.cell, [s.corr]);
    }
    const ratios: number[] = [];
    for (const [k, vi] of inside) {
        const vo = outside.get(k);
        if (!vo || vi.length < o.minCellSamples || vo.length < o.minCellSamples) continue;
        const mi = median(vi), mo = median(vo);
        if (mi > 0 && mo > 0) ratios.push(mi / mo);
    }
    if (ratios.length < o.minSharedCells) return null;

    const gapPct = (median(ratios) - 1) * 100;
    if (Math.abs(gapPct) < o.minGapPct) return null;

    let oddSamples = 0;
    for (const s of samples) if (s.t >= best.a && s.t < best.b) oddSamples++;
    return {
        odd: { from: best.a, to: best.b },
        gapPct,
        sharedCells: ratios.length,
        oddSamples,
        restSamples: samples.length - oddSamples,
        oddFraction: (best.b - best.a) / duration,
    };
}
