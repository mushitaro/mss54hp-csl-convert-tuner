import { LogDataPoint, VEMap } from '@/lib/types';
import { EgtTables, gateOpen, tabgModelAt } from './egtTables';

/**
 * Back-calculates KF_RF_KORR_DRREL from a data log.
 *
 * ## What is being solved
 *
 * The DME injects on RF = rf_soll x rf_korr, and the closed loop moves STFT until lambda is 1.
 * At convergence, for one VE cell (one rf_soll):
 *
 *     rf_soll x k_applied(i) x STFT(i) = A(delta_i)
 *
 * where A is the air the cylinder actually got. Take the ratio of a cold-exhaust sample to a
 * warm-exhaust one in the SAME cell and rf_soll cancels:
 *
 *     A(delta) / A(0) = k_applied(delta) x STFT(delta) / STFT(0)
 *
 * The left side is what KF_RF_KORR_DRREL should hold. Two consequences follow, and both matter:
 *
 * 1. **The VE table need not be converged.** Its error is common to both samples and divides out.
 *    There is no "tune VE first, then the table" ordering.
 * 2. **The answer does not depend on what k the DME actually applied.** `k_applied` is measured
 *    (RF / rf_soll), so whether the correction's gate was open, shut, or holding a stale value
 *    through the hysteresis band, the equation is the same. This is why nothing here tries to
 *    evaluate the road-speed half of the gate, which DS2 selection 3 cannot report anyway.
 *
 * ## Where the gate DOES matter
 *
 * Identifying the anchor. `k_applied = 1.000` has three different causes — a genuinely warm
 * exhaust, a shut gate, and the identity rpm columns — and only the first is a nominal condition.
 * Using "k is about 1" as a proxy for "the exhaust is warm" lets a shut-gate sample at
 * delta = 300 degC into the anchor, which inflates it by the true density effect and pulls every
 * derived table entry DOWN. Understating this table leans the mixture under load at 2200-3500 rpm,
 * which is the one direction docs/ecu-logic/20-egt-correction.md says not to go.
 *
 * So the anchor is chosen on the SENSOR's delta, never on k. That is the whole reason the tuned
 * mode requires an exhaust-temperature channel.
 *
 * See docs/ecu-logic/60-tuning-logic.md section 6.5 for the derivation and its conditions.
 */

export interface RfKorrTuneOptions {
    /** Δ at or below which a sample counts as nominal — the table's first Y breakpoint, where
     *  every rpm column reads 1.000. Above it the DME is already correcting. */
    anchorDeltaMax: number;
    /** Widens the filling floor to skip the hysteresis band, where rf_korr is holding a value
     *  computed at a different operating point and so no longer corresponds to this sample's Δ. */
    gateMargin: number;

    /** Evidence a VE cell needs before its anchor may be used as a DENOMINATOR. Far above the
     *  `weightSum > 0.1` the VE map itself runs on: that threshold is adequate for a mean, and a
     *  divisor built from one sample would propagate its noise into every entry it feeds. */
    minAnchorSamples: number;
    minAnchorWeight: number;

    /** Evidence a (rpm, Δ) grid cell needs before its value is written. */
    minCellSamples: number;
    minCellWeight: number;
    /** Distinct VE cells that must have contributed. One bad anchor must not become a table
     *  entry on its own — with two, a bad anchor has to be agreed with to survive. */
    minDistinctVeCells: number;
    /** max−min of the ratios binned into one grid cell. The derivation assumes the air really
     *  does factor as g(rpm, load) x D(rpm, Δ); samples from different VE cells that disagree by
     *  more than this are saying it does not, here. */
    maxSpread: number;

    /** Never below 1.000: a correction under 1 leans the mixture at exactly the condition BMW
     *  chose to enrich. Never above the ceiling: the stock peak is 1.371. */
    floor: number;
    ceiling: number;
    /** Per-run movement limits against the loaded table. Asymmetric because down is the lean
     *  direction. Convergence is iterative — one log does not get to swing a cell by 37 %. */
    maxStepUp: number;
    maxStepDown: number;

    /** Write the identity rpm columns (every Δ reads 1.000 in stock). Off: BMW pinned those to
     *  say "no correction outside this band", and moving an end column tilts the whole
     *  interpolation segment beside it. The measurement is still reported. */
    writeIdentityColumns: boolean;
    /** A column flatter than this across Δ is an identity column. Same number as the inverter's
     *  minSpan, and for the same reason. */
    identitySpan: number;
}

export const RF_KORR_TUNE_DEFAULTS: RfKorrTuneOptions = {
    anchorDeltaMax: 30,
    gateMargin: 0.05,
    minAnchorSamples: 5,
    minAnchorWeight: 3.0,
    minCellSamples: 10,
    minCellWeight: 5.0,
    minDistinctVeCells: 2,
    maxSpread: 0.15,
    floor: 1.0,
    ceiling: 1.40,
    maxStepUp: 0.10,
    maxStepDown: 0.05,
    writeIdentityColumns: false,
    identitySpan: 0.010,
};

export type RejectReason =
    | 'no-evidence'
    | 'thin-weight'
    | 'thin-count'
    | 'single-ve-cell'
    | 'spread'
    | 'identity-column';

export interface RfKorrTuneReport {
    samplesTotal: number;
    /** Carried neither `rf` nor a usable rf_soll — nothing was measured. */
    samplesNoMeasurement: number;
    /** No exhaust-temperature channel on the row, so no Δ. */
    samplesNoDelta: number;
    /** Inside the hysteresis band: the applied correction belongs to another operating point. */
    samplesHysteresis: number;
    /** Qualified as nominal and went into an anchor. */
    anchorSamples: number;
    /** Carried a Δ above the anchor threshold and contributed a ratio. */
    ratioSamples: number;
    /** Had a Δ but no usable anchor in their own VE cell, so said nothing. */
    samplesNoAnchor: number;
    veCellsWithAnchor: number;
    gridCellsUpdated: number;
    rejectedByReason: Record<RejectReason, number>;
    /** No log row carried an exhaust temperature. Without one nothing here can run. */
    sensorMissing: boolean;
    /** Largest |tuned − stock| actually written, for a quick read on how far this log moved things. */
    largestChange: number;
}

export interface RfKorrTuneResult {
    /** Axes as read from the binary, never assumed — the bins depend on them. */
    rpm: number[];
    delta: number[];
    stock: number[][];
    tuned: number[][];
    countMap: number[][];
    weightMap: number[][];
    spreadMap: number[][];
    /** The raw weighted-mean ratio per grid cell, before any clamp. Shown so the difference
     *  between "the log said this" and "this is what will be written" stays visible. */
    measuredMap: number[][];
    updated: boolean[][];
    rejected: (RejectReason | null)[][];
    /** Per VE cell (load x rpm, matching the VE grid), the anchor and the weight behind it. */
    anchorMap: number[][];
    anchorWeightMap: number[][];
    /** Enough of the table moved to be worth writing. */
    acceptable: boolean;
    report: RfKorrTuneReport;
}

interface AnchorCell { sumQw: number; weight: number; count: number }
interface GridBin {
    sumDw: number; weight: number; count: number;
    min: number; max: number; veCells: Set<number>;
}

const zeros = (rows: number, cols: number) =>
    Array.from({ length: rows }, () => new Array<number>(cols).fill(0));

/**
 * Bracketing weights on an ascending axis, clamped to the ends — the same rule as the DME's
 * kfu_wint and as VECalculator's own binning, so a sample lands in the same place here as it does
 * in the VE map.
 */
function bracket(axis: number[], q: number): { i0: number; i1: number; w1: number } {
    if (!(q > axis[0])) return { i0: 0, i1: 0, w1: 0 };
    const last = axis.length - 1;
    if (!(q < axis[last])) return { i0: last, i1: last, w1: 0 };
    for (let i = 0; i < last; i++) {
        if (q >= axis[i] && q <= axis[i + 1]) {
            const span = axis[i + 1] - axis[i];
            if (span === 0) return { i0: i, i1: i, w1: 0 };
            return { i0: i, i1: i + 1, w1: (q - axis[i]) / span };
        }
    }
    return { i0: last, i1: last, w1: 0 };
}

/** The four bilinear corners and their weights, skipping zero-weight ones. */
function corners(
    x: { i0: number; i1: number; w1: number },
    y: { i0: number; i1: number; w1: number },
): Array<{ r: number; c: number; w: number }> {
    const out: Array<{ r: number; c: number; w: number }> = [];
    const push = (r: number, c: number, w: number) => { if (w > 0) out.push({ r, c, w }); };
    push(y.i0, x.i0, (1 - y.w1) * (1 - x.w1));
    push(y.i0, x.i1, (1 - y.w1) * x.w1);
    push(y.i1, x.i0, y.w1 * (1 - x.w1));
    push(y.i1, x.i1, y.w1 * x.w1);
    return out;
}

export function tuneRfKorrTable(
    currentMap: VEMap,
    annotatedLog: LogDataPoint[],
    egt: EgtTables,
    veAxes: { rpm: number[]; load: number[] },
    opts: Partial<RfKorrTuneOptions> = {},
): RfKorrTuneResult | null {
    const o: RfKorrTuneOptions = { ...RF_KORR_TUNE_DEFAULTS, ...opts };

    const rpmAxis = egt.rfKorr.rpm;
    const deltaAxis = egt.rfKorr.delta;
    const rows = deltaAxis.length, cols = rpmAxis.length;
    const veRows = veAxes.load.length, veCols = veAxes.rpm.length;

    const report: RfKorrTuneReport = {
        samplesTotal: annotatedLog.length,
        samplesNoMeasurement: 0, samplesNoDelta: 0, samplesHysteresis: 0,
        anchorSamples: 0, ratioSamples: 0, samplesNoAnchor: 0,
        veCellsWithAnchor: 0, gridCellsUpdated: 0,
        rejectedByReason: {
            'no-evidence': 0, 'thin-weight': 0, 'thin-count': 0,
            'single-ve-cell': 0, 'spread': 0, 'identity-column': 0,
        },
        sensorMissing: true,
        largestChange: 0,
    };

    // --- Pass 0: everything each sample contributes, computed once -----------------------------
    // Held rather than recomputed because pass 2 needs the same Δ, the same q and the same VE
    // corners pass 1 used. Deriving them twice is how the anchor and the ratio end up disagreeing
    // about which cell a sample belongs to.
    interface Prepared {
        rpm: number;
        q: number;                                   // k_applied x STFT
        delta: number;
        veCorners: Array<{ r: number; c: number; w: number }>;
        /** Index of the VE cell this sample sits closest to, used only to count how many distinct
         *  cells agreed on a grid entry. */
        veKey: number;
        isAnchor: boolean;
    }
    const prepared: Prepared[] = [];

    for (const p of annotatedLog) {
        const rfKorr = p.rfKorr;
        const rfSoll = p.rfSoll;
        if (rfKorr === undefined || rfSoll === undefined || !(rfSoll > 0)) {
            report.samplesNoMeasurement++;
            continue;
        }
        if (p.exhaustTemp === undefined || p.rf === undefined) {
            report.samplesNoDelta++;
            continue;
        }
        report.sensorMissing = false;

        // The hysteresis band. The measurement of what was applied is still exact here — it is
        // the correspondence with THIS sample's Δ that is broken, because the held value was
        // computed somewhere else. Excluded as a data-quality matter, not a safety one.
        if (!gateOpen(egt, p.rpm, rfSoll, o.gateMargin) && gateOpen(egt, p.rpm, rfSoll)) {
            report.samplesHysteresis++;
            continue;
        }

        // annotateRfKorr already computed this against the same tables; taking its value rather
        // than recomputing is what keeps the tuner and the VE calculation on the same Δ.
        const delta = p.tabgDelta
            ?? Math.max(0, tabgModelAt(egt, p.rpm, p.rf / 100) - p.exhaustTemp);
        const stft = (p.stft1 + p.stft2) / 2;
        if (!(stft > 0)) { report.samplesNoMeasurement++; continue; }

        const load = p.correctedLoad ?? p.rawLoad;
        const veCorners = corners(bracket(veAxes.rpm, p.rpm), bracket(veAxes.load, load));
        if (veCorners.length === 0) { report.samplesNoMeasurement++; continue; }

        const dominant = veCorners.reduce((best, c) => (c.w > best.w ? c : best));
        prepared.push({
            rpm: p.rpm,
            q: rfKorr * stft,
            delta,
            veCorners,
            veKey: dominant.r * veCols + dominant.c,
            isAnchor: delta <= o.anchorDeltaMax,
        });
    }

    if (report.sensorMissing) return null;

    // --- Pass 1: the anchors, per VE cell ------------------------------------------------------
    const anchors: AnchorCell[][] = Array.from({ length: veRows }, () =>
        Array.from({ length: veCols }, () => ({ sumQw: 0, weight: 0, count: 0 })));

    for (const s of prepared) {
        if (!s.isAnchor) continue;
        report.anchorSamples++;
        for (const c of s.veCorners) {
            const cell = anchors[c.r][c.c];
            cell.sumQw += s.q * c.w;
            cell.weight += c.w;
            cell.count++;
        }
    }

    const anchorMap = zeros(veRows, veCols);
    const anchorWeightMap = zeros(veRows, veCols);
    for (let r = 0; r < veRows; r++) for (let c = 0; c < veCols; c++) {
        const a = anchors[r][c];
        anchorWeightMap[r][c] = a.weight;
        if (a.count >= o.minAnchorSamples && a.weight >= o.minAnchorWeight && a.sumQw > 0) {
            anchorMap[r][c] = a.sumQw / a.weight;
            report.veCellsWithAnchor++;
        }
    }

    // --- Pass 2: the ratios, binned on the correction's own grid --------------------------------
    const bins: GridBin[][] = Array.from({ length: rows }, () =>
        Array.from({ length: cols }, () => ({
            sumDw: 0, weight: 0, count: 0,
            min: Infinity, max: -Infinity, veCells: new Set<number>(),
        })));

    for (const s of prepared) {
        if (s.isAnchor) continue;   // pinned at 1.000 by the table itself: carries no Δ information

        // The anchor for THIS sample's operating point, blended over the same VE corners it was
        // binned into. Using a single nearest cell would step the anchor discontinuously across a
        // cell boundary and put that step straight into the derived table.
        let anchorSum = 0, anchorW = 0;
        for (const c of s.veCorners) {
            const a = anchorMap[c.r][c.c];
            if (a > 0) { anchorSum += a * c.w; anchorW += c.w; }
        }
        if (!(anchorW > 0)) { report.samplesNoAnchor++; continue; }
        const anchor = anchorSum / anchorW;
        if (!(anchor > 0)) { report.samplesNoAnchor++; continue; }

        const ratio = s.q / anchor;
        if (!Number.isFinite(ratio) || ratio <= 0) { report.samplesNoAnchor++; continue; }
        report.ratioSamples++;

        // Weight the ratio by how much of the anchor it actually stands on, so a sample sitting
        // mostly over VE cells with no anchor counts for correspondingly less.
        const confidence = anchorW;

        for (const g of corners(bracket(rpmAxis, s.rpm), bracket(deltaAxis, s.delta))) {
            const bin = bins[g.r][g.c];
            const w = g.w * confidence;
            bin.sumDw += ratio * w;
            bin.weight += w;
            bin.count++;
            if (ratio < bin.min) bin.min = ratio;
            if (ratio > bin.max) bin.max = ratio;
            bin.veCells.add(s.veKey);
        }
    }

    // --- Pass 3: decide each grid cell ----------------------------------------------------------
    const stock = egt.rfKorr.values.map(row => [...row]);
    const tuned = egt.rfKorr.values.map(row => [...row]);
    const countMap = zeros(rows, cols);
    const weightMap = zeros(rows, cols);
    const spreadMap = zeros(rows, cols);
    const measuredMap = zeros(rows, cols);
    const updated = Array.from({ length: rows }, () => new Array<boolean>(cols).fill(false));
    const rejected: (RejectReason | null)[][] =
        Array.from({ length: rows }, () => new Array<RejectReason | null>(cols).fill(null));

    // A column BMW pinned at 1.000 across every Δ. Detected from the loaded bytes rather than by
    // rpm value, so a binary with a different calibration is judged on what it actually contains.
    const isIdentityColumn = (c: number) => {
        let lo = Infinity, hi = -Infinity;
        for (let r = 0; r < rows; r++) {
            lo = Math.min(lo, stock[r][c]);
            hi = Math.max(hi, stock[r][c]);
        }
        return hi - lo < o.identitySpan;
    };

    for (let c = 0; c < cols; c++) {
        const identity = isIdentityColumn(c);
        for (let r = 0; r < rows; r++) {
            const bin = bins[r][c];
            countMap[r][c] = bin.count;
            weightMap[r][c] = bin.weight;
            if (bin.count > 0) {
                spreadMap[r][c] = bin.max - bin.min;
                measuredMap[r][c] = bin.weight > 0 ? bin.sumDw / bin.weight : 0;
            }

            const reason = rejectionFor(bin, identity, o);
            if (reason) { rejected[r][c] = reason; report.rejectedByReason[reason]++; continue; }

            const raw = bin.sumDw / bin.weight;
            const stepped = Math.min(stock[r][c] + o.maxStepUp,
                Math.max(stock[r][c] - o.maxStepDown, raw));
            const value = Math.min(o.ceiling, Math.max(o.floor, stepped));

            tuned[r][c] = value;
            updated[r][c] = true;
            report.gridCellsUpdated++;
            report.largestChange = Math.max(report.largestChange, Math.abs(value - stock[r][c]));
        }
    }

    return {
        rpm: [...rpmAxis], delta: [...deltaAxis],
        stock, tuned, countMap, weightMap, spreadMap, measuredMap, updated, rejected,
        anchorMap, anchorWeightMap,
        // One updated cell is a curiosity, not a calibration. Requiring a handful keeps a log that
        // happened to clip one corner of the grid from presenting itself as a tune.
        acceptable: report.gridCellsUpdated >= 3,
        report,
    };
}

function rejectionFor(bin: GridBin, identity: boolean, o: RfKorrTuneOptions): RejectReason | null {
    if (bin.count === 0) return 'no-evidence';
    if (identity && !o.writeIdentityColumns) return 'identity-column';
    if (bin.count < o.minCellSamples) return 'thin-count';
    if (bin.weight < o.minCellWeight) return 'thin-weight';
    if (bin.veCells.size < o.minDistinctVeCells) return 'single-ve-cell';
    if (bin.max - bin.min > o.maxSpread) return 'spread';
    return null;
}
