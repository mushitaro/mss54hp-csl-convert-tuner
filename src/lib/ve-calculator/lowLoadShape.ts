/**
 * Repairing the SHAPE of the Alpha-N table's low-opening rows.
 *
 * No log input at all — this is a projection of a grid onto a constraint set, which is why it can
 * be tested exhaustively without a drive, and why it runs AFTER the measurement rather than instead
 * of it.
 *
 * ## The two defects, and why they are shape rather than value
 *
 * `csl_conversion_idle_and_tipin.md` §3 argues both entirely from SLOPE, and a grid of values
 * cannot show either:
 *
 *   (c) at 1600 rpm the filling FALLS between 0.098 % and 0.146 % opening (0.088 -> 0.084). Opening
 *       the throttle and getting less air is not a thing an engine does; it is a calibration typo,
 *       and at very small openings it makes torque reverse.
 *
 *   (b) immediately above the idle operating point, at 1.39-1.61 % opening, the gain jumps: 1.70x
 *       at 1300 rpm, 3.55x at 1100, 4.75x at 1600. Every pull-away passes through it, which is the
 *       mechanical description of "it jerks when you squeeze the throttle just off idle".
 *
 * ## What is deliberately NOT repaired
 *
 * Defect (a), the 13.7x gain step between the 0.10-1.00 % band and the 3.20-5.00 % band. The notes
 * say to leave it and they are right: it is inherent to Alpha-N — the RELATIVE rate of change of
 * opening area is enormous at small openings — and flattening it kills the initial pedal. R2 never
 * sees it because R2 compares ADJACENT intervals and that step is spread across many.
 */

export interface LowLoadShapeOptions {
    /**
     * How much the gain may change between adjacent intervals.
     *
     * MEASURED, not chosen. From the notes' own slope table: clean stretches run adjacent-interval
     * ratios of 1.31, 1.25, 1.19, 0.83, 0.76, 1.04 — topping out near 1.5. The hump starts at 1.70
     * and reaches 4.75. So 1.6 passes everything healthy and catches every instance of the defect,
     * with the boundary sitting in a real gap rather than through the middle of the data.
     */
    gainRatioMax: number;
    /**
     * The most any single cell may be moved by the repair, as a fraction of its own value.
     *
     * The hump is a 2-5x GAIN defect but only a ~3 % VALUE defect, because the rows are 0.2 % apart.
     * 6 % caps it with margin. A cell that wants more is telling you the measurement and the shape
     * disagree, which is reported rather than quietly applied.
     */
    maxRepairFrac: number;
    /** Weight an unmeasured cell carries in the monotone fit — a weak prior, so it yields to
     *  measured neighbours without being free to fly. */
    stockWeight: number;
    iterations: number;
}

export const LOW_LOAD_SHAPE_DEFAULTS: LowLoadShapeOptions = {
    gainRatioMax: 1.6,
    maxRepairFrac: 0.06,
    stockWeight: 1.0,
    iterations: 8,
};

/**
 * Weighted pool-adjacent-violators: the least-squares projection onto the monotone cone.
 *
 * PAV rather than a hand-written smoothing pass, and the difference is a property rather than a
 * preference: PAV is the MINIMUM-CHANGE projection onto the constraint, so it cannot touch data
 * that already satisfies the constraint. A smoother would quietly rewrite healthy columns too, and
 * nothing downstream would be able to tell that it had.
 */
export function isotonicWeighted(v: readonly number[], w: readonly number[]): number[] {
    const n = v.length;
    if (n === 0) return [];
    // Blocks of (weighted mean, total weight, length), merged while the sequence decreases.
    const mean: number[] = [];
    const wt: number[] = [];
    const len: number[] = [];
    for (let i = 0; i < n; i++) {
        let m = v[i];
        let ww = Math.max(1e-9, w[i]);
        let l = 1;
        while (mean.length && mean[mean.length - 1] > m) {
            const pm = mean.pop() as number;
            const pw = wt.pop() as number;
            const pl = len.pop() as number;
            m = (pm * pw + m * ww) / (pw + ww);
            ww += pw;
            l += pl;
        }
        mean.push(m); wt.push(ww); len.push(l);
    }
    const out: number[] = [];
    for (let b = 0; b < mean.length; b++) for (let k = 0; k < len[b]; k++) out.push(mean[b]);
    return out;
}

/** dRF per unit of opening, per interval — the quantity the defect actually lives in. */
export function gains(v: readonly number[], x: readonly number[]): number[] {
    const g: number[] = [];
    for (let i = 0; i + 1 < v.length; i++) {
        const dx = x[i + 1] - x[i];
        g.push(dx === 0 ? 0 : (v[i + 1] - v[i]) / dx);
    }
    return g;
}

/**
 * Cap the ratio between adjacent gains, moving ONE interior point and preserving the total rise.
 *
 * Holding `v[r]` and `v[r+2]` fixed and redistributing the rise between the two intervals is what
 * keeps the repair local: nothing outside the offending pair shifts, so the cells above and below
 * the band come out untouched by construction rather than by luck. With widths w0, w1 and total
 * rise S, putting the ratio exactly on the cap gives `g0 = S / (w0 + c*w1)`.
 */
function capGainRatio(v: number[], x: readonly number[], c: number): boolean {
    let moved = false;
    for (let r = 0; r + 2 < v.length; r++) {
        const w0 = x[r + 1] - x[r];
        const w1 = x[r + 2] - x[r + 1];
        if (w0 <= 0 || w1 <= 0) continue;
        const g0 = (v[r + 1] - v[r]) / w0;
        const g1 = (v[r + 2] - v[r + 1]) / w1;
        if (g0 <= 0 || g1 <= 0) continue;      // monotonicity is R1's job, not this one's
        const ratio = g1 / g0;
        if (ratio <= c && ratio >= 1 / c) continue;
        const S = g0 * w0 + g1 * w1;
        const cap = ratio > c ? c : 1 / c;
        const ng0 = S / (w0 + cap * w1);
        const next = v[r] + ng0 * w0;
        if (Math.abs(next - v[r + 1]) > 1e-12) { v[r + 1] = next; moved = true; }
    }
    return moved;
}

export interface LowLoadShapeResult {
    values: number[][];
    repaired: boolean[][];
    /** Cells the repair wanted to move further than `maxRepairFrac` allowed. Reverted to their
     *  measured value and reported, because a repair that large means the measurement and the shape
     *  disagree — which is a finding, not something to apply quietly. */
    refused: boolean[][];
}

/**
 * Repair the low-opening block of an already-measured, already-clamped grid.
 *
 * `values` is indexed `[openingRow][rpmCol]`, matching the VE table's own layout. Only rows
 * `0..maxRow` are touched; everything else is copied through untouched.
 */
export function repairLowLoadShape(
    values: readonly (readonly number[])[],
    opening: readonly number[],
    weight: readonly (readonly number[])[],
    maxRow: number,
    opts?: Partial<LowLoadShapeOptions>,
): LowLoadShapeResult {
    const o = { ...LOW_LOAD_SHAPE_DEFAULTS, ...opts };
    const rows = values.length;
    const cols = values[0]?.length ?? 0;
    const out = values.map(r => [...r]);
    const repaired = values.map(r => r.map(() => false));
    const refused = values.map(r => r.map(() => false));
    const top = Math.min(maxRow, rows - 1);
    if (top < 1 || cols === 0) return { values: out, repaired, refused };

    for (let c = 0; c < cols; c++) {
        const before: number[] = [];
        const w: number[] = [];
        const x: number[] = [];
        for (let r = 0; r <= top; r++) {
            before.push(values[r][c]);
            w.push(weight[r]?.[c] ? weight[r][c] : o.stockWeight);
            x.push(opening[r]);
        }

        // R1 first: monotone non-decreasing filling as the throttle opens.
        let col = isotonicWeighted(before, w);
        // R2, iterated to a fixed point, then R1 again. The redistribution cannot make a gain
        // negative, so the second R1 is cheap insurance rather than a correction — but running it
        // makes the output PROVABLY monotone instead of monotone-by-argument.
        for (let i = 0; i < o.iterations; i++) if (!capGainRatio(col, x, o.gainRatioMax)) break;
        col = isotonicWeighted(col, w);

        for (let r = 0; r <= top; r++) {
            const from = before[r];
            const to = col[r];
            if (Math.abs(to - from) <= 1e-12) continue;
            const frac = from === 0 ? Infinity : Math.abs(to - from) / Math.abs(from);
            if (frac > o.maxRepairFrac) { refused[r][c] = true; continue; }
            out[r][c] = to;
            repaired[r][c] = true;
        }
    }

    return { values: out, repaired, refused };
}

/** What is wrong with the surface at a cell, looking UP the opening axis from it. */
export type ShapeDefect =
    /** Filling falls as the throttle opens. Physically impossible on an Alpha-N table: more
     *  opening is more air. Wherever it appears, the table is wrong, not the engine. */
    | 'falling'
    /** The gain steps by more than `gainRatioMax` against the interval below it. Not impossible,
     *  but on a measured surface it is the signature of one cell having moved without its
     *  neighbours — which is exactly what a per-cell write does when only some cells clear the
     *  evidence bar. */
    | 'gain-jump';

export interface ShapeCell {
    row: number;
    col: number;
    /** Gain across the interval ABOVE this row, in filling per % opening. Null on the top row,
     *  which has no interval above it. */
    gain: number | null;
    /**
     * This gain against the one below it. Null where either interval is missing or flat.
     *
     * Reported per cell for RANKING, never as a pass/fail census. Measured on the untouched BASE of
     * this car the ratio runs p05 0.19, median 0.81, p95 4.0, max 32 across 360 intervals — so any
     * absolute cap flags a large fraction of a factory table. That is the OPENING AXIS being
     * non-uniform (0.05 % steps at the bottom against 15 % at the top, on a filling that is not
     * scaled the same way), not a surface defect. A threshold here would measure the axis.
     */
    gainRatio: number | null;
    /** How far the filling FALLS across the interval above this cell, in filling units. Zero
     *  unless `defect` is 'falling'. Carried so the panel can rank: this car's BASE holds 34
     *  reversals running from 0.001 — one LSB of `raw/1000`, arguably rounding — to 0.204, and the
     *  reader wants the 0.204 one rather than an alphabetical list. */
    fallBy: number;
    defect: ShapeDefect | null;
    /**
     * The BASE was clean here and the tuned grid is not — this tune put the kink in.
     *
     * The distinction the whole report exists for. A surface inherited from BMW with a hump in it
     * is a fact about the calibration and someone else's decision; a hump that appeared between
     * BASE and TUNED is THIS log's doing, and it is almost always the write landing on a cell
     * whose neighbours had no evidence and stayed put. That is the residual the per-cell clamp
     * bounds but cannot remove — bounding a spike is not the same as not making one.
     */
    introduced: boolean;
}

export interface ShapeReport {
    cells: ShapeCell[][];
    /** Cells whose filling falls as the throttle opens. */
    falling: number;
    /**
     * Cells whose gain steps harder than the cap against the interval below.
     *
     * Reported ALWAYS beside the same count for the BASE, and never alone, because alone it
     * misleads: this car's factory table scores 200 of 480 on it. What the PAIR says — 200 -> 201 —
     * is the useful statement, and it is about the tune rather than about the metric.
     */
    gainJumps: number;
    /** Of all defects, how many this tune introduced. The number that decides whether a repair is
     *  fixing the calibration or cleaning up after the write. */
    introduced: number;
}

/**
 * The shape of the WHOLE table, column by column, and what the tune did to it.
 *
 * Reads down each rpm column across the opening axis, because that is the axis the physical
 * constraint lives on: at a fixed engine speed, opening the throttle further cannot admit less air.
 * Nothing here reads across rpm — a table may legitimately fall with rpm at fixed opening, and
 * treating that as a defect would flag most of the map.
 *
 * `base` may be null, in which case nothing is marked `introduced` — an honest absence rather than
 * a claim that every defect is pre-existing.
 */
export function analyseShape(
    tuned: readonly (readonly number[])[],
    base: readonly (readonly number[])[] | null,
    opening: readonly number[],
    opts?: Partial<LowLoadShapeOptions>,
): ShapeReport {
    const o = { ...LOW_LOAD_SHAPE_DEFAULTS, ...opts };
    const rows = tuned.length;
    const cols = tuned[0]?.length ?? 0;

    /** One column's defects, as a flat array indexed by row. */
    const defectsOf = (grid: readonly (readonly number[])[], c: number): (ShapeDefect | null)[] => {
        const col: number[] = [];
        for (let r = 0; r < rows; r++) col.push(grid[r]?.[c] ?? 0);
        const g = gains(col, opening);
        const out: (ShapeDefect | null)[] = new Array(rows).fill(null);
        for (let r = 0; r < g.length; r++) {
            if (g[r] < 0) { out[r] = 'falling'; continue; }
            if (r === 0) continue;
            const below = g[r - 1];
            // A flat interval has no meaningful ratio against it, and dividing by it would call
            // every cell above a plateau a jump. Two zero gains in a row is a flat surface, which
            // is not a defect — it is a table that stopped rising.
            if (below <= 0 || g[r] <= 0) continue;
            const ratio = g[r] / below;
            if (ratio > o.gainRatioMax || ratio < 1 / o.gainRatioMax) out[r] = 'gain-jump';
        }
        return out;
    };

    const cells: ShapeCell[][] = Array.from({ length: rows }, (_, r) =>
        Array.from({ length: cols }, (_, c) => ({
            row: r, col: c, gain: null, gainRatio: null, defect: null, introduced: false, fallBy: 0,
        })));
    let falling = 0, gainJumps = 0, introduced = 0;

    for (let c = 0; c < cols; c++) {
        const col: number[] = [];
        for (let r = 0; r < rows; r++) col.push(tuned[r]?.[c] ?? 0);
        const g = gains(col, opening);
        const now = defectsOf(tuned, c);
        const was = base ? defectsOf(base, c) : null;

        for (let r = 0; r < rows; r++) {
            const cell = cells[r][c];
            cell.gain = r < g.length ? g[r] : null;
            cell.gainRatio = r > 0 && r < g.length && g[r - 1] > 0 && g[r] > 0 ? g[r] / g[r - 1] : null;
            cell.defect = now[r];
            cell.fallBy = now[r] === 'falling' && r + 1 < rows ? col[r] - col[r + 1] : 0;
            cell.introduced = !!now[r] && !!was && !was[r];
            if (now[r] === 'falling') falling++;
            if (now[r] === 'gain-jump') gainJumps++;
            if (cell.introduced) introduced++;
        }
    }
    return { cells, falling, gainJumps, introduced };
}

/**
 * Which repairs are allowed to run, and how far each may go.
 *
 * Every option is a physical statement about an engine rather than a preference about a curve, and
 * each is off until asked for. The parameters are exposed because the right value is a judgement
 * about THIS engine that only someone looking at the column profile can make.
 */
export interface ShapeRepairOptions {
    /**
     * Filling may not fall as the throttle opens, at a fixed engine speed.
     *
     * The one rule with no parameter, because it needs no threshold: more opening is more air, and
     * a column that falls describes an engine that does not exist. Applied by moving the UNMEASURED
     * cell of the offending pair — a falling pair of two MEASURED cells is a finding about the
     * measurements and is reported rather than smoothed away.
     */
    monotone: boolean;
    /**
     * Carry the measured correction across the cells between two measured ones.
     *
     * The physical claim: the error in an air model varies smoothly with operating point. If one
     * cell reads 4 % rich and the next measured cell four rows up reads 3 % rich, the cells between
     * them are somewhere in between — not untouched at 0 %.
     *
     * Applied to the BASE VALUE rather than to the shape: the correction is interpolated and
     * multiplied in, so the factory curvature between the anchors survives exactly. With equal
     * corrections at both anchors the whole run is scaled by one number and the shape is identical.
     */
    blend: boolean;
    /**
     * Cap how hard the gradient may step between adjacent intervals — IN THE OPENING DIRECTION ONLY.
     *
     * A step in dRF/dRO is felt through the pedal as the throttle coming on unevenly. That is a
     * PEDAL-direction complaint, which is the first reason this rule does not cross to rpm.
     *
     * The second reason is the one that settles it. Read along a high-opening row, this table IS
     * the volumetric-efficiency curve against engine speed, and on this car that curve is not
     * smooth and is not supposed to be. The 100 % row runs 1.202 at 600 rpm, down to 0.666 at
     * 1300, up to 1.053 at 1600, down to 0.689 at 2100, up to 1.295 at 3900 — ten turning points,
     * and the SAME features appear on the 45, 65 and 85 % rows too. A feature that repeats across
     * independent rows is not noise; it is intake resonance and cam timing. Capping the gradient
     * across rpm would flatten real engine behaviour and call it a repair.
     *
     * It is also the only rule carrying an arbitrary number: measured on this car's untouched BASE
     * the ratio runs p05 0.19 to p95 4.0, so any cap flags a large part of a factory table. Use it
     * on what the TUNE did, never to "fix" the calibration.
     */
    smoothGain: boolean;
    /** Extend the outermost measured correction past the last anchor. OFF, and it should stay off
     *  unless you know why you want it: beyond the anchors there is nothing to interpolate between,
     *  so this writes cells from a single distant observation. */
    extrapolate: boolean;
    /** The most any one cell may be moved, as a fraction of its own value. A cell that wants more
     *  is telling you the measurement and the shape disagree, which is reported, not applied. */
    maxRepairFrac: number;
    /** The gradient-step cap, when `smoothGain` is on. */
    gainRatioMax: number;
    /**
     * Which direction the fill runs in.
     *
     * The two axes are NOT symmetric, and the difference is physical rather than a convention:
     *
     *   OPENING  at a fixed engine speed, more throttle is more air. Filling must rise. This is
     *            where `monotone` lives, and it is the only direction it can live in.
     *   RPM      at a fixed opening, filling may legitimately FALL with engine speed, and on this
     *            car it does — 0.331 at 600 rpm against 0.073 at 7900 rpm along the 0.40 % row.
     *            So monotonicity says nothing here. What still holds is smoothness: volumetric
     *            efficiency varies continuously with speed, so there is no reason for a step at
     *            one rpm breakpoint that is not there at its neighbour.
     *
     * `both` runs the opening direction first and lets the rpm direction fill only what is left.
     * A drive sweeps rpm at roughly constant throttle far more than it sweeps throttle at constant
     * rpm — a full-throttle pull is exactly that — so the rpm direction usually reaches the most
     * cells. The opening direction still goes first, because it is the one carrying the constraint
     * that cannot be argued with.
     *
     * Note which rules survive the crossing: BLEND does, because it interpolates the CORRECTION —
     * the error in our own air model, which really does vary smoothly with speed — and multiplies
     * it onto the BASE, so whatever resonance the factory curve holds is preserved exactly.
     * MONOTONE and SMOOTH do not, and the reasons are on those two fields.
     */
    axis: 'opening' | 'rpm' | 'both';
}

export const SHAPE_REPAIR_DEFAULTS: ShapeRepairOptions = {
    monotone: false,
    blend: false,
    smoothGain: false,
    extrapolate: false,
    maxRepairFrac: 0.06,
    gainRatioMax: LOW_LOAD_SHAPE_DEFAULTS.gainRatioMax,
    // `both`, because the direction that fills the most cells is the one a car actually sweeps: a
    // pull holds the throttle still and lets the engine climb. The opening direction runs first
    // regardless, so nothing is lost by asking for both.
    axis: 'both',
};

export interface ShapeRepairResult {
    /** The grid to write: anchors untouched, shaped cells moved, everything else BASE. */
    values: number[][];
    /** True where this repair moved the cell. Never true on an anchor. */
    shaped: boolean[][];
    /** Cells the repair wanted to move further than `maxRepairFrac` allowed. Left alone and
     *  reported — a repair that large means the measurement and the shape disagree. */
    refused: boolean[][];
    shapedCount: number;
    refusedCount: number;
}

/**
 * Fill and smooth the cells this tune did NOT measure, without touching the ones it did.
 *
 * ## What may move
 *
 * Anchors — the cells the tune wrote — are frozen. That is the safety property the whole design
 * rests on: a repair that cannot move a measured cell cannot contradict a measurement, whatever
 * its parameters are set to.
 *
 * ## What it will not do
 *
 * It does not repair the BASE. This car's factory table holds 34 falling pairs and, at a 1.6 cap,
 * 200 gradient steps; running a smoother over all of them would not be a repair, it would be
 * rewriting the factory calibration from a 52-minute drive. Only cells BETWEEN anchors are
 * eligible — plus, if `extrapolate` is on, the ones beyond them — and a column with fewer than two
 * anchors is left entirely alone.
 */
export function repairShape(
    base: readonly (readonly number[])[],
    tuned: readonly (readonly number[])[],
    anchored: readonly (readonly boolean[])[],
    opening: readonly number[],
    opts: ShapeRepairOptions,
    /** The rpm breakpoints. Only needed when the fill runs across rpm; the spacing is what the
     *  interpolation is against, and using indices instead would put a 3900-to-4600 gap on the same
     *  footing as a 2100-to-2200 one. */
    rpm?: readonly number[],
): ShapeRepairResult {
    const rows = tuned.length;
    const cols = tuned[0]?.length ?? 0;
    const values = tuned.map(r => [...r]);
    const shaped = tuned.map(r => r.map(() => false));
    const refused = tuned.map(r => r.map(() => false));

    if (cols === 0 || !(opts.monotone || opts.blend || opts.smoothGain)) {
        return { values, shaped, refused, shapedCount: 0, refusedCount: 0 };
    }

    /**
     * One line of the table — a column down the opening axis, or a row across rpm.
     *
     * `get`/`put` hide which it is, so the rules are written once. `monotone` is passed rather than
     * read from `opts` because it is only meaningful in the opening direction: filling may fall
     * with rpm, and projecting a row onto the monotone cone would rewrite the whole table into a
     * shape no engine has.
     */
    const repairLine = (
        n: number,
        axisAt: readonly number[],
        baseAt: (i: number) => number,
        tunedAt: (i: number) => number,
        currentAt: (i: number) => number,
        isAnchor: (i: number) => boolean,
        alreadyShaped: (i: number) => boolean,
        commit: (i: number, v: number, ok: boolean) => void,
        allowMonotone: boolean,
    ) => {
        const anchors: number[] = [];
        for (let i = 0; i < n; i++) if (isAnchor(i)) anchors.push(i);
        // Nothing measured on this line, or one point with nothing to interpolate between.
        if (anchors.length < 2) return;
        const lo = anchors[0];
        const hi = anchors[anchors.length - 1];

        const line: number[] = [];
        for (let i = 0; i < n; i++) line.push(currentAt(i));
        // A cell a previous pass already shaped is finished: `both` means "fill by whichever
        // direction brackets it", not "fill twice and keep the last answer".
        const free = (i: number) => !isAnchor(i) && !alreadyShaped(i)
            && (opts.extrapolate ? true : i > lo && i < hi);

        if (opts.blend) {
            for (let k = 0; k + 1 < anchors.length; k++) {
                const a = anchors[k], b = anchors[k + 1];
                const span = axisAt[b] - axisAt[a];
                if (span <= 0) continue;
                const ka = baseAt(a) === 0 ? 1 : tunedAt(a) / baseAt(a);
                const kb = baseAt(b) === 0 ? 1 : tunedAt(b) / baseAt(b);
                for (let i = a + 1; i < b; i++) {
                    if (!free(i)) continue;
                    const t = (axisAt[i] - axisAt[a]) / span;
                    line[i] = baseAt(i) * ((1 - t) * ka + t * kb);
                }
            }
            if (opts.extrapolate) {
                // Flat, never a slope: past the last anchor there is nothing to interpolate
                // between, so the honest extension is the nearest measured correction held
                // constant. Extending a gradient would be inventing data with a straight face.
                const kLo = baseAt(lo) === 0 ? 1 : tunedAt(lo) / baseAt(lo);
                const kHi = baseAt(hi) === 0 ? 1 : tunedAt(hi) / baseAt(hi);
                for (let i = 0; i < lo; i++) if (free(i)) line[i] = baseAt(i) * kLo;
                for (let i = hi + 1; i < n; i++) if (free(i)) line[i] = baseAt(i) * kHi;
            }
        }

        // SMOOTH then MONOTONE: the redistribution in `capGainRatio` cannot make a gain negative,
        // while a monotone projection CAN reintroduce a step. So the constraint with no parameter
        // in it gets the last word.
        // Gated on `allowMonotone` as well, which is really "is this the opening direction": both
        // of these rules are opening-direction rules, for reasons written on their own fields.
        if (opts.smoothGain && allowMonotone) {
            for (let it = 0; it < LOW_LOAD_SHAPE_DEFAULTS.iterations; it++) {
                const before = [...line];
                if (!capGainRatio(line, axisAt, opts.gainRatioMax)) break;
                // Put back anything the cap moved that it was not allowed to move: `capGainRatio`
                // shifts one interior point at a time and knows nothing about anchors.
                for (let i = 0; i < n; i++) if (!free(i)) line[i] = before[i];
            }
        }
        if (allowMonotone && opts.monotone) {
            // A large weight on the frozen points is what pins them: `isotonicWeighted` is a
            // least-squares projection, so a point at 1e6 moves by ~1e-6 of what a free one does.
            // Pinning by weight rather than by slicing keeps the constraint ACROSS an anchor,
            // which is where the violations actually are.
            const w = line.map((_, i) => (free(i) ? 1 : 1e6));
            const fitted = isotonicWeighted(line, w);
            for (let i = 0; i < n; i++) if (free(i)) line[i] = fitted[i];
        }

        for (let i = 0; i < n; i++) {
            if (!free(i)) continue;
            const from = tunedAt(i);
            const to = line[i];
            if (Math.abs(to - from) <= 1e-12) continue;
            const frac = from === 0 ? Infinity : Math.abs(to - from) / Math.abs(from);
            commit(i, to, frac <= opts.maxRepairFrac);
        }
    };

    const wantOpening = opts.axis === 'opening' || opts.axis === 'both';
    const wantRpm = (opts.axis === 'rpm' || opts.axis === 'both') && !!rpm;

    if (wantOpening) {
        for (let c = 0; c < cols; c++) {
            repairLine(rows, opening,
                r => base[r][c], r => tuned[r][c], r => values[r][c],
                r => !!anchored[r]?.[c], r => shaped[r][c],
                (r, v, ok) => { if (ok) { values[r][c] = v; shaped[r][c] = true; } else refused[r][c] = true; },
                true);
        }
    }
    if (wantRpm) {
        for (let r = 0; r < rows; r++) {
            repairLine(cols, rpm!,
                c => base[r][c], c => tuned[r][c], c => values[r][c],
                c => !!anchored[r]?.[c], c => shaped[r][c],
                (c, v, ok) => { if (ok) { values[r][c] = v; shaped[r][c] = true; } else refused[r][c] = true; },
                false);
        }
    }

    let shapedCount = 0, refusedCount = 0;
    for (const row of shaped) for (const v of row) if (v) shapedCount++;
    for (const row of refused) for (const v of row) if (v) refusedCount++;
    return { values, shaped, refused, shapedCount, refusedCount };
}
