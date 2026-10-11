/** Finite command-ratio updates from moving, one-sided DME observations.
 * Residuals are command/reference bounds, not an AFR estimate. The 5% default
 * limits one optimization step; it is unrelated to an rf_korr exponent.
 */
export interface MovingCellShare { cell: number; weight: number }
export interface MovingResponseConstraint {
    shares: readonly MovingCellShare[];
    lower?: number; upper?: number;
    time: number; bank: 1 | 2; index: number; model: string;
    /** Stable physical visit ID, shared by all transport/read-time scenarios. */
    pass?: string;
    /** Distinguishes recordings whose clocks and row indices both start at zero. */
    session?: string;
    weight?: number;
}
export type MovingFitReason = 'accepted' | 'unsupported' | 'no-direction'
    | 'insufficient-passes' | 'pass-conflict' | 'combined-conflict' | 'cross-validation';
export interface MovingCellFit {
    cell: number; factor: number; requestedFactor: number; reason: MovingFitReason;
    observations: number; support: number; passes: [number, number];
    improvedPasses: [number, number]; lossChange: number;
}
export interface MovingResponseFitResult {
    factors: number[]; demand: number[]; cells: MovingCellFit[];
    accepted: number[]; beforeLoss: number; afterLoss: number;
    /** Residuals remain visible even when a useful finite update is accepted. */
    beforeViolations: number; afterViolations: number;
    groups: { key: string; beforeLoss: number; afterLoss: number; rows: number }[];
    validation?: MovingCrossValidation;
}
export interface MovingCrossValidation {
    folds: number; embargoSec: number; beforeLoss: number; afterLoss: number;
    groups: { key: string; beforeLoss: number; afterLoss: number; rows: number }[];
    cells: { cell: number; trainingFactors: number[]; testFolds: [number, number];
        improvedTestFolds: [number, number]; improvedTestPasses: [number, number];
        regionalImprovedTestPasses: [number, number]; regionalGroupChanges: { key: string; change: number }[];
        oppositeDirection: boolean; passed: boolean }[];
    rejectedCells: number[];
}
export interface MovingResponseFitOptions {
    maxStep?: number; minPassesPerBank?: number; huberDelta?: number;
    supportThreshold?: number; visitGapSec?: number;
    /** Used for dominance grouping only when the caller has no visit ID. */
    validationBlockSec?: number;
    /** Chronological loss groups replace zero-error dominance in every short window. */
    validationFolds?: number;
    /** Fit on the other folds, then evaluate untouched held-out rows. */
    crossValidate?: boolean;
    embargoSec?: number;
}
type Prepared = {
    shares: MovingCellShare[]; lower: number; upper: number; time: number;
    bank: 1 | 2; index: number; model: string; session: string; pass?: string;
    weight: number; group: number;
};
type Hit = { row: number; share: number; visit: string };
type Change = { delta: number; worst: number; improved: [number, number]; valid: boolean };
const finite = (v: number) => Number.isFinite(v);
function residual(v: number, lo: number, hi: number) { return v < lo ? v - lo : v > hi ? v - hi : 0; }
function huber(v: number, delta: number) {
    const a = Math.abs(v); return a <= delta ? v * v / 2 : delta * (a - delta / 2);
}

/** Each coordinate is checked against the CURRENT combined proposal in fixed
 * model/bank/visit groups. Hence sequential updates cannot silently add up to a
 * worse group. Independent-visit support is deduplicated across model scenarios.
 * No smoothness, shrinkage-to-one, or narrowband-voltage-to-AFR conversion.
 */
type TimeRanges = Map<string, { min: number; max: number }>;
function rangesOf(input: readonly MovingResponseConstraint[]): TimeRanges {
    const ranges: TimeRanges = new Map();
    for (const row of input) { const key = row.session ?? '', previous = ranges.get(key);
        ranges.set(key, { min: Math.min(previous?.min ?? Infinity, row.time), max: Math.max(previous?.max ?? -Infinity, row.time) }); }
    return ranges;
}
function foldOf(row: MovingResponseConstraint, ranges: TimeRanges, count: number) {
    const range = ranges.get(row.session ?? '')!;
    return range.max > range.min ? Math.min(count - 1, Math.max(0, Math.floor((row.time - range.min) / (range.max - range.min) * count))) : 0;
}
function fitCore(input: readonly MovingResponseConstraint[], cellCount: number,
    options: MovingResponseFitOptions, ranges: TimeRanges, allowedCells?: ReadonlySet<number>): MovingResponseFitResult {
    const maxStep = options.maxStep ?? .05, minPasses = options.minPassesPerBank ?? 2;
    const delta = options.huberDelta ?? .025, supportThreshold = options.supportThreshold ?? .001;
    const visitGap = options.visitGapSec ?? 5, block = options.validationBlockSec ?? 10;
    if (!Number.isInteger(cellCount) || cellCount < 1 || !finite(maxStep) || maxStep <= 0 || maxStep >= 1
        || !Number.isInteger(minPasses) || minPasses < 2 || !finite(delta) || delta <= 0
        || !finite(supportThreshold) || supportThreshold < 0 || !finite(visitGap) || visitGap <= 0
        || !finite(block) || block <= 0) throw new Error('Invalid moving-response fit options');
    if (options.validationFolds !== undefined && (!Number.isInteger(options.validationFolds) || options.validationFolds < 2))
        throw new Error('Invalid chronological validation fold count');
    const groupKeys: string[] = [], groupMap = new Map<string, number>(), groupWeights: number[] = [];
    const rows: Prepared[] = input.map(row => {
        const lower = row.lower ?? -Infinity, upper = row.upper ?? Infinity, weight = row.weight ?? 1;
        if (!finite(row.time) || !Number.isInteger(row.index) || row.index < 0
            || (row.bank !== 1 && row.bank !== 2) || !row.model
            || !(finite(lower) || lower === -Infinity) || !(finite(upper) || upper === Infinity)
            || lower > upper || (!finite(lower) && !finite(upper)) || !finite(weight) || weight <= 0)
            throw new Error('Invalid moving-response constraint');
        const merged = new Map<number, number>();
        for (const { cell, weight: share } of row.shares) {
            if (!Number.isInteger(cell) || cell < 0 || cell >= cellCount || !finite(share) || share < 0)
                throw new Error('Invalid moving-response cell share');
            if (share > 0) merged.set(cell, (merged.get(cell) ?? 0) + share);
        }
        if (!merged.size) throw new Error('Empty moving-response cell shares');
        // Do not normalize extrema-derived shares: their sum need not be one.
        const session = row.session ?? '', visit = options.validationFolds
            ? `fold:${foldOf(row, ranges, options.validationFolds)}`
            : row.pass ?? `block:${Math.floor(row.time / block)}`;
        const key = JSON.stringify([session, row.model, row.bank, visit]);
        let group = groupMap.get(key);
        if (group === undefined) { group = groupKeys.length; groupMap.set(key, group); groupKeys.push(key); groupWeights.push(0); }
        groupWeights[group] += weight;
        return { ...row, lower, upper, weight, session, group,
            shares: [...merged].map(([cell, share]) => ({ cell, weight: share })) };
    });
    // A denser log or duplicated constraints cannot add independent evidence.
    rows.forEach(row => { row.weight /= groupWeights[row.group]; });
    const hits: Hit[][] = Array.from({ length: cellCount }, () => []);
    rows.forEach((row, i) => row.shares.forEach(s => hits[s.cell].push({ row: i, share: s.weight, visit: '' })));
    const cells: MovingCellFit[] = hits.map((hh, cell) => {
        const strong = hh.filter(h => h.share > supportThreshold).sort((a, b) =>
            rows[a.row].session.localeCompare(rows[b.row].session) || rows[a.row].time - rows[b.row].time);
        let previousSession = '', previousTime = -Infinity, visit = -1;
        const byIndex = new Map<string, string>();
        for (const h of strong) {
            const row = rows[h.row];
            if (row.session !== previousSession || row.time - previousTime > visitGap) visit++;
            h.visit = JSON.stringify([row.session, row.pass ?? `visit:${visit}`]);
            previousSession = row.session; previousTime = row.time;
            byIndex.set(JSON.stringify([row.session, row.index]), h.visit);
        }
        const counts: [Set<string>, Set<string>] = [new Set(), new Set()];
        const indices = new Set<string>(); let support = 0;
        for (const h of hh) {
            const row = rows[h.row];
            h.visit = byIndex.get(JSON.stringify([row.session, row.index])) ?? '';
            if (h.share > supportThreshold) {
                counts[row.bank - 1].add(h.visit); indices.add(JSON.stringify([row.session, row.index]));
                support += row.weight * h.share;
            }
        }
        return { cell, factor: 1, requestedFactor: 1, reason: strong.length ? 'no-direction' : 'unsupported',
            observations: indices.size, support, passes: [counts[0].size, counts[1].size],
            improvedPasses: [0, 0], lossChange: 0 };
    });
    const current = Float64Array.from(rows, row => row.shares.reduce((sum, s) => sum + s.weight, 0));
    const rowLoss = (i: number, value: number) => rows[i].weight * huber(residual(value, rows[i].lower, rows[i].upper), delta);
    const before = Float64Array.from(rows, (_, i) => rowLoss(i, current[i]));
    const losses = before.slice(), tolerance = 1e-12;
    function check(cell: number, step: number): Change {
        const groups = new Map<number, number>(), visits = new Map<string, { bank: number; change: number }>();
        let total = 0;
        for (const h of hits[cell]) {
            const row = rows[h.row], change = rowLoss(h.row, current[h.row] + h.share * step) - losses[h.row];
            total += change; groups.set(row.group, (groups.get(row.group) ?? 0) + change);
            if (h.visit && h.share > supportThreshold) {
                const key = JSON.stringify([row.model, row.bank, h.visit]);
                const prior = visits.get(key); visits.set(key, { bank: row.bank, change: (prior?.change ?? 0) + change });
            }
        }
        const improved: [Set<string>, Set<string>] = [new Set(), new Set()];
        for (const [key, value] of visits) if (value.change < -tolerance) {
            const [, , visitId] = JSON.parse(key) as [string, number, string]; improved[value.bank - 1].add(visitId);
        }
        const counts: [number, number] = [improved[0].size, improved[1].size];
        let worst = 0; for (const change of groups.values()) worst = Math.max(worst, change);
        return { delta: total, worst, improved: counts,
            valid: worst <= tolerance && Math.min(...counts) >= minPasses && total < -tolerance };
    }
    const backtracking = [1, .5, .25, .125, .0625, .03125, .015625];
    const proposals: { cell: number; step: number; initial: Change }[] = [];
    for (const cell of cells) {
        if (allowedCells && !allowedCells.has(cell.cell)) { cell.reason = 'cross-validation'; continue; }
        if (cell.reason === 'unsupported') continue;
        if (Math.min(...cell.passes) < minPasses) { cell.reason = 'insufficient-passes'; continue; }
        const trials = backtracking.flatMap(scale => [-1, 1].map(sign => {
            const step = sign * maxStep * scale; return { step, initial: check(cell.cell, step) };
        })).sort((a, b) => a.initial.delta - b.initial.delta || Math.abs(a.step) - Math.abs(b.step));
        // A full trust-region step can overshoot an otherwise useful small
        // correction. Prefer the best admissible step before reporting conflict.
        const { step, initial } = trials.find(trial => trial.initial.valid) ?? trials[0];
        cell.requestedFactor = 1 + step; cell.improvedPasses = initial.improved;
        if (initial.delta >= -tolerance) { cell.reason = 'no-direction'; cell.requestedFactor = 1; continue; }
        if (!initial.valid) { cell.reason = initial.worst > tolerance ? 'pass-conflict' : 'insufficient-passes'; continue; }
        proposals.push({ cell: cell.cell, step, initial });
    }
    proposals.sort((a, b) => a.initial.delta - b.initial.delta || a.cell - b.cell);
    const accepted: number[] = [];
    for (const proposal of proposals) {
        const cell = cells[proposal.cell];
        const trials = backtracking.map(scale => {
            const step = proposal.step * scale; return { step, result: check(proposal.cell, step) };
        }).filter(trial => trial.result.valid).sort((a, b) => a.result.delta - b.result.delta);
        const { step, result } = trials[0] ?? { step: 0, result: check(proposal.cell, proposal.step) };
        if (!result.valid) { cell.reason = 'combined-conflict'; continue; }
        cell.reason = 'accepted'; cell.factor += step; cell.improvedPasses = result.improved;
        cell.lossChange = result.delta; accepted.push(cell.cell);
        for (const h of hits[cell.cell]) { current[h.row] += h.share * step; losses[h.row] = rowLoss(h.row, current[h.row]); }
    }
    const groups = groupKeys.map(key => ({ key, beforeLoss: 0, afterLoss: 0, rows: 0 }));
    rows.forEach((row, i) => { const g = groups[row.group]; g.beforeLoss += before[i]; g.afterLoss += losses[i]; g.rows++; });
    if (groups.some(g => g.afterLoss > g.beforeLoss + tolerance * Math.max(1, accepted.length)))
        throw new Error('Combined moving-response proposal regressed a validation group');
    return { factors: cells.map(cell => cell.factor), demand: cells.map(cell => cell.requestedFactor), cells, accepted,
        beforeLoss: before.reduce((a, b) => a + b, 0), afterLoss: losses.reduce((a, b) => a + b, 0),
        beforeViolations: [...before].filter(v => v > 0).length, afterViolations: [...losses].filter(v => v > 0).length, groups };
}

export function fitMovingResponse(input: readonly MovingResponseConstraint[], cellCount: number,
    options: MovingResponseFitOptions = {}): MovingResponseFitResult {
    if (options.crossValidate && options.validationFolds === undefined) options = { ...options, validationFolds: 5 };
    const ranges = rangesOf(input), initial = fitCore(input, cellCount, options, ranges);
    if (!options.crossValidate || !input.length || !initial.accepted.length) return initial;
    const folds = options.validationFolds ?? 5, embargo = options.embargoSec ?? 20;
    if (!Number.isInteger(folds) || folds < 2 || !finite(embargo) || embargo < 0)
        throw new Error('Invalid moving-response cross-validation options');
    const delta = options.huberDelta ?? .025, support = options.supportThreshold ?? .001, tolerance = 1e-12;
    const training: MovingResponseFitResult[] = [];
    const testByFold = Array.from({ length: folds }, () => [] as MovingResponseConstraint[]);
    for (const row of input) testByFold[foldOf(row, ranges, folds)].push(row);
    for (let fold = 0; fold < folds; fold++) {
        const train = input.filter(row => {
            const range = ranges.get(row.session ?? '')!, width = (range.max - range.min) / folds;
            const lo = range.min + fold * width - embargo, hi = range.min + (fold + 1) * width + embargo;
            return row.time < lo || row.time > hi;
        });
        training.push(fitCore(train, cellCount, { ...options, crossValidate: false, validationFolds: folds }, ranges));
    }
    const groupWeights = new Map<string, number>();
    const groupKey = (row: MovingResponseConstraint, fold: number) => JSON.stringify([row.session ?? '', row.model, row.bank, fold]);
    for (const row of input) { const key = groupKey(row, foldOf(row, ranges, folds));
        groupWeights.set(key, (groupWeights.get(key) ?? 0) + (row.weight ?? 1)); }
    const groups = new Map<string, { key: string; beforeLoss: number; afterLoss: number; rows: number }>();
    const candidates = new Set(initial.accepted);
    const visitIds = new Map<number, Map<string, string>>();
    for (const cell of candidates) {
        const observations = new Map<string, MovingResponseConstraint>();
        for (const row of input) if (row.shares.some(s => s.cell === cell && s.weight > support))
            observations.set(JSON.stringify([row.session ?? '', row.index]), row);
        const ordered = [...observations].sort((a, b) => (a[1].session ?? '').localeCompare(b[1].session ?? '') || a[1].time - b[1].time);
        const ids = new Map<string, string>(); let session = '', time = -Infinity, visit = -1;
        for (const [id, row] of ordered) {
            const currentSession = row.session ?? '';
            if (currentSession !== session || row.time - time > (options.visitGapSec ?? 5)) visit++;
            ids.set(id, JSON.stringify([currentSession, row.pass ?? `visit:${visit}`])); session = currentSession; time = row.time;
        }
        visitIds.set(cell, ids);
    }
    const perCell = initial.cells.map(cell => ({ cell: cell.cell, trainingFactors: training.map(f => f.factors[cell.cell]),
        support: [new Set<string>(), new Set<string>()], improved: [new Set<string>(), new Set<string>()],
        visits: new Map<string, number>(), improvedVisits: [new Set<string>(), new Set<string>()],
        regionalVisits: new Map<string, number>(), regionalGroups: new Map<string, number>(),
        groups: new Map<string, number>(), oppositeDirection: false }));
    for (let fold = 0; fold < folds; fold++) for (const row of testByFold[fold]) {
        const key = groupKey(row, fold), weight = (row.weight ?? 1) / groupWeights.get(key)!;
        const lo = row.lower ?? -Infinity, hi = row.upper ?? Infinity;
        const value = row.shares.reduce((sum, share) => sum + share.weight, 0);
        const prediction = row.shares.reduce((sum, share) => sum + share.weight * training[fold].factors[share.cell], 0);
        const before = weight * huber(residual(value, lo, hi), delta), after = weight * huber(residual(prediction, lo, hi), delta);
        const g = groups.get(key) ?? { key, beforeLoss: 0, afterLoss: 0, rows: 0 };
        g.beforeLoss += before; g.afterLoss += after; g.rows++; groups.set(key, g);
        const combined = new Map<number, number>();
        for (const share of row.shares) combined.set(share.cell, (combined.get(share.cell) ?? 0) + share.weight);
        for (const [cell, share] of combined) {
            if (!candidates.has(cell)) continue;
            const c = perCell[cell], step = training[fold].factors[cell] - 1;
            const change = weight * huber(residual(value + share * step, lo, hi), delta) - before;
            c.groups.set(key, (c.groups.get(key) ?? 0) + change);
            if (share > support) {
                c.support[row.bank - 1].add(JSON.stringify([row.session ?? '', fold]));
                const visit = visitIds.get(cell)?.get(JSON.stringify([row.session ?? '', row.index]));
                if (visit) { const visitKey = JSON.stringify([row.bank, visit]);
                    c.visits.set(visitKey, (c.visits.get(visitKey) ?? 0) + change);
                    c.regionalVisits.set(visitKey, (c.regionalVisits.get(visitKey) ?? 0) + share * (after - before)); }
                c.regionalGroups.set(key, (c.regionalGroups.get(key) ?? 0) + share * (after - before));
            }
        }
    }
    const allowed = new Set<number>();
    const cells = perCell.map(c => {
        const sign = Math.sign(initial.factors[c.cell] - 1);
        c.oppositeDirection = c.trainingFactors.some(f => Math.sign(f - 1) !== 0 && Math.sign(f - 1) !== sign);
        for (const [key, change] of c.groups) if (change < -tolerance) {
            const [session, , bank, fold] = JSON.parse(key) as [string, string, number, number];
            c.improved[bank - 1].add(JSON.stringify([session, fold]));
        }
        const testFolds: [number, number] = [c.support[0].size, c.support[1].size];
        const improvedTestFolds: [number, number] = [c.improved[0].size, c.improved[1].size];
        for (const [key, change] of c.visits) if (change < -tolerance) {
            const [bank, visit] = JSON.parse(key) as [number, string]; c.improvedVisits[bank - 1].add(visit);
        }
        const improvedTestPasses: [number, number] = [c.improvedVisits[0].size, c.improvedVisits[1].size];
        const regionalVisits: [Set<string>, Set<string>] = [new Set(), new Set()];
        for (const [key, change] of c.regionalVisits) if (change < -tolerance) {
            const [bank, visit] = JSON.parse(key) as [number, string]; regionalVisits[bank - 1].add(visit);
        }
        const regionalImprovedTestPasses: [number, number] = [regionalVisits[0].size, regionalVisits[1].size];
        const learned = c.trainingFactors.filter(f => Math.sign(f - 1) === sign && sign !== 0).length;
        // Bilinear basis columns overlap. A training fold may put the same
        // useful correction in a neighbouring cell. Validate the HELD-OUT
        // command prediction on this cell's supporting operating region, not
        // an isolated coefficient pretending its fitted neighbours were one.
        const passed = candidates.has(c.cell) && learned >= 2 && !c.oppositeDirection
            && Math.min(...testFolds) >= 2 && Math.min(...regionalImprovedTestPasses) >= (options.minPassesPerBank ?? 2)
            && [...c.regionalGroups.values()].every(change => change <= tolerance);
        if (passed) allowed.add(c.cell);
        return { cell: c.cell, trainingFactors: c.trainingFactors, testFolds, improvedTestFolds, improvedTestPasses,
            regionalImprovedTestPasses, regionalGroupChanges: [...c.regionalGroups].map(([key, change]) => ({ key, change })),
            oppositeDirection: c.oppositeDirection, passed };
    });
    const result = fitCore(input, cellCount, { ...options, crossValidate: false, validationFolds: folds }, ranges, allowed);
    const groupResults = [...groups.values()];
    result.validation = { folds, embargoSec: embargo, beforeLoss: groupResults.reduce((s, g) => s + g.beforeLoss, 0),
        afterLoss: groupResults.reduce((s, g) => s + g.afterLoss, 0), groups: groupResults, cells,
        rejectedCells: initial.accepted.filter(cell => !allowed.has(cell)) };
    return result;
}
