/**
 * Has the map stopped moving?
 *
 * SHAPE is a projection onto a constraint set — monotone, bounded gain — and it can only be right
 * about a surface that is finished. Run on the output of one drive it repairs the shape of a
 * MEASUREMENT ERROR: the drive's noise becomes the surface SHAPE then makes smooth and monotone,
 * which is a worse artefact than the bumps it removed, because a smoothed error looks deliberate.
 *
 * So the question SHAPE has to be able to ask is not "is there a tune" but "has the tune settled",
 * and that is a property of the LAST drive rather than of any stored history:
 *
 *     base(n) = tune(n-1)        the chain rule — each session starts from the last flash
 *     demand(n) ~ 1              therefore means the previous map already satisfied this drive
 *
 * A pass whose demands are all near 1.000 is a pass that found nothing left to correct. That is
 * convergence, and it needs no cross-session store to see: it is visible in the current
 * derivation, provided the operator kept the chain (which the session's parent/baseSha256 records).
 *
 * NOT a count of written cells. A drive can write nothing because it was short, and a drive can
 * write everything because the map is far out — neither says whether the surface has settled.
 */

/** How far from 1.000 a cell may still ask to move and count as settled. */
export const CONVERGED_BAND = 0.02;

/**
 * Cells asking for less than this are not evidence of anything either way.
 *
 * A cell with two samples has a demand, and it is noise. Requiring the same floor DIRECT writes at
 * keeps the verdict about the map rather than about the log's thinnest corners.
 */
export const CONVERGENCE_MIN_SAMPLES = 3;

export interface ConvergenceReport {
    /** Cells that had enough samples for their demand to mean anything. */
    evaluated: number;
    /** Of those, how many still want to move by more than `band`. */
    unsettled: number;
    /** The largest |demand - 1| seen, as a fraction. 0 when nothing was evaluated. */
    worst: number;
    /** Where that worst cell is, for the UI to name. */
    worstAt: { row: number; col: number } | null;
    /** True only when something was evaluated AND nothing is unsettled. An empty map is not
     *  converged — it is unmeasured, and the two must not read the same on screen. */
    converged: boolean;
}

/**
 * @param demandMap  what each cell asked for, pre-gain — `calculateNewVEMap().demandMap`
 * @param hitMap     raw sample counts, to drop cells too thin to judge
 * @param rowFrom    first row to consider, so a caller can ask about the band it is about to shape
 */
export function summariseConvergence(
    demandMap: readonly (readonly number[])[] | null | undefined,
    hitMap: readonly (readonly number[])[] | null | undefined,
    opts: { band?: number; minSamples?: number; rowFrom?: number; rowTo?: number } = {},
): ConvergenceReport {
    const band = opts.band ?? CONVERGED_BAND;
    const minSamples = opts.minSamples ?? CONVERGENCE_MIN_SAMPLES;
    const empty: ConvergenceReport = {
        evaluated: 0, unsettled: 0, worst: 0, worstAt: null, converged: false,
    };
    if (!demandMap || !hitMap) return empty;

    const from = Math.max(0, opts.rowFrom ?? 0);
    const to = Math.min(demandMap.length - 1, opts.rowTo ?? demandMap.length - 1);
    let evaluated = 0, unsettled = 0, worst = 0;
    let worstAt: { row: number; col: number } | null = null;

    for (let r = from; r <= to; r++) {
        const demandRow = demandMap[r];
        const hitRow = hitMap[r];
        if (!demandRow || !hitRow) continue;
        for (let c = 0; c < demandRow.length; c++) {
            if ((hitRow[c] ?? 0) < minSamples) continue;
            const d = demandRow[c];
            // A cell with no evidence carries a demand of exactly 1 by construction, which would
            // otherwise pad the "settled" side with cells that were never measured. The sample
            // floor above already removes them; this guards a demand that is not a finite number.
            if (!Number.isFinite(d) || d <= 0) continue;
            evaluated++;
            const off = Math.abs(d - 1);
            if (off > band) unsettled++;
            if (off > worst) { worst = off; worstAt = { row: r, col: c }; }
        }
    }
    return { evaluated, unsettled, worst, worstAt, converged: evaluated > 0 && unsettled === 0 };
}
