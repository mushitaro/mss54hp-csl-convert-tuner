import { type LogDataPoint, type VEMap, type RfKorrMode, type RfKorrSource, resolveRfKorr } from '@/lib/types';
import { APP_CONFIG, CSL_STOCK_MAP_DATA, CSL_STOCK_WARMUP_MAP, CSL_STOCK_WOT_MAP, CSL_STOCK_WARMUP_RPM, CSL_STOCK_WARMUP_LOAD, CSL_STOCK_WOT_RPM } from '@/config/constants';
import {
    type EgtTables, EGT_INVERSION_DEFAULTS, gateOpen, interpMap2d, invertRfKorrProfile, rfKorrAt,
    rfKorrProfileAt, tabgModelAt,
} from './egtTables';
import type { RfKorrTuneResult, RfKorrTuneOptions } from './rfKorrTuner';

interface GridCell {
    sumStftWeighted: number; // Sum(STFT * Weight)
    weightSum: number;       // Sum(Weight)
    rawCount: number;        // Count of samples (integer)

    // rf_korr is tracked on its own weight because it is present on fewer samples than STFT is:
    // a Testo CSV has no RF channel at all, and even on a live log a sample whose Alpha-N
    // interpolation comes out 0 yields no ratio. Dividing by `weightSum` would silently understate
    // the mean on any cell with a mixed set.
    sumRfKorrWeighted: number;
    weightSumRfKorr: number;
    minRfKorr: number;
    maxRfKorr: number;

    // The 'tuned' correction, accumulated alongside rather than instead of the nominal one. Both
    // are needed at the same time: the guard below compares them, and a cell that fails it falls
    // back to the nominal value, which has to still be there to fall back to.
    sumTunedWeighted: number;
    weightSumTuned: number;
}

/**
 * How far the 'tuned' correction may sit from the 'nominal' one before a cell gives up and takes
 * the nominal value.
 *
 * This is the load-bearing bound on the new path. 'nominal' is the behaviour that has shipped and
 * is known to fail rich; dividing by a measured quantity is new, and a cell whose k_new came from
 * thin evidence could otherwise move the map a long way on very little. 15 % means the tuned path
 * can refine the map but can never take it somewhere the existing path would not go.
 */
const TUNED_VS_NOMINAL_MAX = 0.15;

/**
 * Absolute bounds on any per-cell correction, either path.
 *
 * A catastrophe net rather than a tuning parameter: outside this range the lambda integrator is
 * pinned at its own clamp and the samples are not describing mixture any more. Nothing before this
 * commit could reach it — but nothing before this commit divided.
 */
const CORRECTION_MIN = 0.5;
const CORRECTION_MAX = 2.0;

export interface VeCalcOptions {
    /**
     * Fold the measured rf_korr into the correction: New = Old * STFT * rf_korr.
     * This is karter16's "Option 2", and the caller should normally pass it TRUE.
     *
     * What it decides is what kf_rf_soll is FOR, and the two answers differ by up to 37 % where
     * KF_RF_KORR_DRREL peaks:
     *
     *   ON  — the table holds filling at NOMINAL exhaust temperature; rf_korr adds the
     *         cold-exhaust enrichment on top. A map tuned on a cold-exhaust drive is still right
     *         once the exhaust heats up and rf_korr falls back to 1.0.
     *   OFF — the table holds filling at whatever rf_korr the log was taken under. Self-consistent
     *         at that condition, and correct at every condition IF BMW's density model exactly
     *         matches this engine — because then rf_korr cancels out of the derivation.
     *
     * They fail in opposite directions, and that is the whole argument: OFF, on a log taken with a
     * cold exhaust, writes a table that goes LEAN under load once things warm up. ON is rich-safe.
     * On an S54 that asymmetry is not a close call, which is why the config default is on.
     *
     * Whether the model actually matches cannot be settled from one log. It needs the same cell
     * sampled at different tabg_delta, and then STFT read against rf_korr: flat means the model
     * matches, sloped means it does not. `rfKorrMap` / `rfKorrSpreadMap` are what make that
     * comparison possible — see docs/ecu-logic/60-tuning-logic.md §6.3.
     */
    applyRfKorr?: boolean;

    /**
     * How much evidence a VE cell needs before it may move. Defaults 10 samples AND weight 5.0 —
     * the same discipline rfKorrTuner already applies to its own grid.
     *
     * There was no count threshold here at all until 2026-08-15. The only test was
     * `weightSum > 0.1`, and weightSum is a sum of bilinear corner weights, so ONE sample landing
     * squarely on a cell scores 1.0 and moved it. The 10/30 pair that looked like thresholds were
     * heatmap bands in MapEditor and gated nothing. karter16 (thread 242281 #161) suggested raising
     * the thresholds; the more useful half of that advice turned out to be that the map had none.
     *
     * Both conditions, not either: ten samples spread over four corners can carry very little
     * weight, and a big weight can come from very few samples sitting dead centre.
     */
    minCellSamples?: number;
    minCellWeight?: number;

    /**
     * Overrides for the rf_korr tuner's own grid thresholds, forwarded untouched.
     *
     * Separate from the two above because they gate different tables with different economics: the
     * VE map has 480 cells and the correction table has 72, so one rf_korr cell carries far more of
     * the result and deserves to be harder to move. Not merged into one pair of numbers for exactly
     * that reason.
     */
    rfKorrThresholds?: Partial<RfKorrTuneOptions>;

    /**
     * The DME's own EGT tables, decoded from the loaded binary. Optional throughout: without them
     * every derived column is simply absent and the calculation behaves exactly as it did before
     * they existed. `null` means the binary could not be decoded — treated the same as absent,
     * deliberately, since the alternative would be to substitute a stock table this binary may
     * not have. See readEgtTables.
     */
    egt?: EgtTables | null;

    /** @deprecated Read only through `resolveRfKorr`, so old sessions replay unchanged. */
    rfKorrMode?: RfKorrMode;

    /** Which rf_korr the derivation divides out. See LogFilterConfig.rfKorrSource. */
    rfKorrSource?: RfKorrSource;

    /**
     * Whether the back-calculated KF_RF_KORR_DRREL is being written into the binary — and therefore
     * whether the VE derivation must divide by it.
     *
     * The same flag drives both because they are one decision. `TuneSettings.writeRfKorr` is where
     * it is stored, alongside writeWarmup and writeWot.
     */
    writeRfKorr?: boolean;

    /** The back-calculated correction table. Required when `writeRfKorr` is set and ignored
     *  otherwise. Absent or not acceptable leaves the divisor out per cell — the caller is expected
     *  to have disabled the toggle, and a calculation is not where to raise that. */
    tunedRfKorr?: RfKorrTuneResult | null;
}

export class VECalculator {
    private rpmAxis: number[];
    private loadAxis: number[];

    constructor() {
        this.rpmAxis = APP_CONFIG.MSS54HP.AXIS_RPM;
        this.loadAxis = APP_CONFIG.MSS54HP.AXIS_LOAD;
    }

    /**
     * Calculates the new VE map based on multiple log files and the current VE map.
     * Logic:
     * 1. Aggregate STFT data from all logs into the grid using BILINEAR INTERPOLATION (Weighted).
     * 2. Calculate Weighted Average STFT for each cell.
     * 3. Apply correction: NewVE = OldVE * AvgSTFT
     */
    public calculateNewVEMap(
        currentMap: VEMap,
        logData: LogDataPoint[],
        options: VeCalcOptions = {}
    ): {
        newMap: VEMap; diffMap: number[][]; hitMap: number[][]; correctionMap: number[][];
        weightMap: number[][]; rfKorrMap: number[][]; rfKorrSpreadMap: number[][];
        tunedUsedMap: boolean[][];
        coverage: { withEvidence: number; withAnyData: number; total: number };
    } {
        // Defaults to RF ÷ rf_soll — the route that needs no sensor. A caller that forgets to pass
        // options lands on the same arithmetic the app has always done.
        const plan = resolveRfKorr(options);
        // Writing the derived table and dividing by it are one decision: a VE map built for k_new
        // while the DME still applies k_old leaves the residual k_new/k_old, which reaches -27 % at
        // the stock peak (2200-2350 rpm) and goes LEAN. So this reads the WRITE flag, not a mode.
        //
        // The table still has to have been derived and passed its own evidence thresholds. Without
        // one it degrades per cell to "no divisor" rather than failing — the UI gates the toggle
        // separately, and a calculation is not where to raise that.
        const tuned = options.writeRfKorr && options.tunedRfKorr?.acceptable
            ? options.tunedRfKorr : null;

        const grid = this.createGrid();

        // 1. Binning / Aggregation (Weighted)
        for (const point of logData) this.accumulatePoint(grid, point, plan, tuned);

        return this.finalizeGrid(currentMap, grid, options);
    }

    /**
     * An empty accumulation grid.
     *
     * Split out of `calculateNewVEMap` so a live log can hold one across samples instead of building
     * a new one every flush. The batch path builds it, fills it and discards it exactly as before —
     * the point of the split is that the three steps are now separately callable, not that any of
     * them changed.
     */
    public createGrid(): GridCell[][] {
        return Array(this.loadAxis.length)
            .fill(null)
            .map(() =>
                Array(this.rpmAxis.length)
                    .fill(null)
                    .map(() => ({
                        sumStftWeighted: 0, weightSum: 0, rawCount: 0,
                        sumRfKorrWeighted: 0, weightSumRfKorr: 0,
                        minRfKorr: Infinity, maxRfKorr: -Infinity,
                        sumTunedWeighted: 0, weightSumTuned: 0,
                    }))
            );
    }

    /**
     * One sample into the grid.
     *
     * Every accumulator in a cell is a SUM, which is what makes a live log able to add samples one
     * at a time and get the same answer as a batch pass over all of them. That is not a coincidence
     * to rely on quietly — `verify:incremental` asserts the two agree cell for cell on a real drive.
     *
     * `tuned` is the one input that is not per-sample: it comes from the rf_korr tuner, which reads
     * the whole log. A live caller must therefore either hold it fixed or rebuild the grid when it
     * changes; see IncrementalRun for which of those it does and why.
     */
    public accumulatePoint(
        grid: GridCell[][], point: LogDataPoint,
        plan: ReturnType<typeof resolveRfKorr>, tuned: RfKorrTuneResult | null,
    ): void {
        {
            // Use Corrected Load if available, else Raw Load
            const loadVal = point.correctedLoad ?? point.rawLoad;
            const rpmVal = point.rpm;
            const avgStft = (point.stft1 + point.stft2) / 2;

            // Find 4 bounding cells
            const rpmInfo = this.findBoundingIndices(rpmVal, this.rpmAxis);
            const loadInfo = this.findBoundingIndices(loadVal, this.loadAxis);

            if (!rpmInfo || !loadInfo) return;

            // The chosen route. Both annotated in the same pass by annotateRfKorr, so switching
            // between them re-derives from the same log without re-reading anything.
            //   'rf-ratio'    RF ÷ rf_soll        — what the DME applied, from its own output
            //   'table-delta' KF_RF_KORR_DRREL(rpm, Δ) at the sensor's Δ
            // A sample the chosen route cannot supply carries no correction rather than silently
            // borrowing the other one: the two disagree exactly where the disagreement matters
            // (a shut gate, a missing sensor), and substituting would hide that.
            const rfKorr = plan.source === 'table-delta' ? point.rfKorrFromEgt : point.rfKorr;
            const correction = (plan.apply && rfKorr !== undefined) ? avgStft * rfKorr : avgStft;

            // The 'tuned' correction: divide the nominal one by what the CORRECTED table would
            // have applied at this operating point. What survives is the trim as it would read
            // with the exhaust at nominal temperature — which is what the VE table should hold.
            //
            // Per sample rather than per cell, because Δ varies within a cell and the ratio does
            // not survive being averaged first. A sample the tuner could not place gets no tuned
            // value at all, so its cell simply carries less evidence for that path.
            let tunedCorrection: number | undefined;
            if (tuned && rfKorr !== undefined) {
                const kNew = this.tunedRfKorrAt(tuned, point);
                if (kNew !== undefined && kNew > 0) tunedCorrection = correction / kNew;
            }

            // Distribute to up to 4 neighbors
            this.distributeWeight(grid, this.loadAxis.length, this.rpmAxis.length, rpmInfo, loadInfo,
                correction, rfKorr, tunedCorrection);
        }
    }

    /**
     * The grid to the maps — O(cells), not O(samples).
     *
     * This is the half a live log runs on every flush. 480 cells is a fixed cost whatever the drive
     * has cost so far, which is the whole reason the split exists: the old arrangement paid for the
     * entire log again twice a second, so the sample rate fell as the run went on.
     */
    public finalizeGrid(
        currentMap: VEMap, grid: GridCell[][], options: VeCalcOptions = {},
    ): {
        newMap: VEMap; diffMap: number[][]; hitMap: number[][]; correctionMap: number[][];
        weightMap: number[][]; rfKorrMap: number[][]; rfKorrSpreadMap: number[][];
        tunedUsedMap: boolean[][];
        coverage: { withEvidence: number; withAnyData: number; total: number };
    } {
        const rows = this.loadAxis.length;
        const cols = this.rpmAxis.length;
        const minSamples = options.minCellSamples ?? 10;
        const minWeight = options.minCellWeight ?? 5.0;
        // Counted so the UI can say how much of the map this log actually earned. A threshold the
        // user cannot see the cost of is a threshold they cannot choose.
        let cellsWithEvidence = 0;
        let cellsWithSomeData = 0;

        // 2. Calculation
        const newMapData: number[][] = [];
        const diffMap: number[][] = [];
        const hitMap: number[][] = [];
        const correctionMap: number[][] = [];
        const weightMap: number[][] = [];
        const rfKorrMap: number[][] = [];
        const rfKorrSpreadMap: number[][] = [];
        const tunedUsedMap: boolean[][] = [];

        for (let r = 0; r < rows; r++) {
            const newRow: number[] = [];
            const diffRow: number[] = [];
            const hitRow: number[] = [];
            const correctionRow: number[] = [];
            const weightRow: number[] = [];
            const rfKorrRow: number[] = [];
            const rfKorrSpreadRow: number[] = [];
            const tunedUsedRow: boolean[] = [];

            for (let c = 0; c < cols; c++) {
                const cell = grid[r][c];
                const oldVal = currentMap.data[r][c];

                // 1.0 / 0.0 mean "this cell was built from samples that carried no rf_korr" — the
                // same reading as "the correction was inactive", which is what the DME does when
                // the gate is shut. Callers that need to tell the two apart use rawCount.
                if (cell.weightSumRfKorr > 0) {
                    rfKorrRow.push(cell.sumRfKorrWeighted / cell.weightSumRfKorr);
                    rfKorrSpreadRow.push(cell.maxRfKorr - cell.minRfKorr);
                } else {
                    rfKorrRow.push(1.0);
                    rfKorrSpreadRow.push(0);
                }

                // The evidence gate. Both conditions — see VeCalcOptions.minCellSamples for why,
                // and for what this replaced.
                if (cell.rawCount > 0) cellsWithSomeData++;
                if (cell.rawCount >= minSamples && cell.weightSum >= minWeight) {
                    cellsWithEvidence++;
                    // Calculation uses Weighted Average
                    // Avg = Sum(Value * Weight) / Sum(Weight)
                    const nominal = cell.sumStftWeighted / cell.weightSum;

                    // Take the tuned correction only if it stays close to the one that would have
                    // been used anyway. Thin evidence behind k_new shows up here as a large
                    // divergence, and a cell that diverges takes the nominal value and says so.
                    let avgCorrection = nominal;
                    let usedTuned = false;
                    if (cell.weightSumTuned > 0.1) {
                        const candidate = cell.sumTunedWeighted / cell.weightSumTuned;
                        if (nominal > 0 && Math.abs(candidate / nominal - 1) <= TUNED_VS_NOMINAL_MAX) {
                            avgCorrection = candidate;
                            usedTuned = true;
                        }
                    }
                    tunedUsedRow.push(usedTuned);

                    // Last line of defence, both paths. Nothing before the divide could reach it.
                    avgCorrection = Math.min(CORRECTION_MAX, Math.max(CORRECTION_MIN, avgCorrection));

                    // Formula: New = Old * Correction
                    const newVal = oldVal * avgCorrection;

                    newRow.push(newVal);
                    // Ratio % = (New / Old) * 100
                    // This is equivalent to Correction Factor * 100
                    diffRow.push(avgCorrection * 100);

                    // HitMap shows RAW Counts (matching MLV "Cell Hit Count")
                    hitRow.push(cell.rawCount);

                    // Correction itself (Lambda Deviation)
                    correctionRow.push(avgCorrection);

                    // Weight Sum (Cell Weight)
                    weightRow.push(cell.weightSum);
                } else {
                    newRow.push(oldVal); // No change
                    diffRow.push(100); // Ratio % (No change = 100%)
                    // The REAL count and weight, not zero. Before the gate existed these could only
                    // be reached with no samples at all, so zero was the truth; now a cell can hold
                    // nine samples and still be refused, and reporting that as 0 would erase the one
                    // signal that says "drive here again" rather than "you have never been here".
                    hitRow.push(cell.rawCount);
                    correctionRow.push(1.0); // No correction
                    weightRow.push(cell.weightSum);
                    tunedUsedRow.push(false);
                }
            }
            newMapData.push(newRow);
            diffMap.push(diffRow);
            hitMap.push(hitRow);
            correctionMap.push(correctionRow);
            weightMap.push(weightRow);
            rfKorrMap.push(rfKorrRow);
            rfKorrSpreadMap.push(rfKorrSpreadRow);
            tunedUsedMap.push(tunedUsedRow);
        }

        return {
            newMap: {
                xAxis: [...currentMap.xAxis], // Preserve axes
                yAxis: [...currentMap.yAxis],
                data: newMapData,
            },
            diffMap,
            hitMap, // Returns Integer Hits
            correctionMap,
            weightMap, // Returns Weight Sum
            tunedUsedMap, // Which cells actually took the 'tuned' correction
            rfKorrMap, // Weighted-mean rf_korr the cell's samples were taken under
            rfKorrSpreadMap, // max-min rf_korr across those samples
            /** How many cells cleared the evidence gate, out of how many the log touched at all and
             *  how many exist. The three numbers together are what makes a threshold adjustable:
             *  raising it is only a decision you can make if you can see what it costs. */
            coverage: { withEvidence: cellsWithEvidence, withAnyData: cellsWithSomeData, total: rows * cols }
        };
    }

    /**
     * Measures rf_korr, the EGT density correction the DME applied, for every sample that carries
     * an RF reading, and returns a copy of the log with `rfKorr` filled in.
     *
     * With MAP compensation off (k_rf_cfg = 0x02, which is what this app's PATCH writes) the DME's
     * load path is exactly RF = (rf_soll * rf_korr) >> 10, where rf_soll is the Alpha-N lookup.
     * So dividing the DME's own RF by our interpolation of the same table recovers the multiplier
     * directly — no need to model TABG or read KF_RF_KORR_DRREL.
     *
     * `rf_soll * rf_korr` is what the DME computes either way — MAP compensation only ADDS
     * rf_p_saug_i on top of it. So the ratio is still rf_korr plus a bounded error, not a
     * different quantity: rf_p_saug_i is clamped to ±2.5 %RF (k_rf_p_saug_i_min/max @0xE5EE/F0),
     * and rf_korr only engages above 55–80 %RF, so the worst case is ~±4 % on a signal that runs
     * to +37 %. Measuring it anyway beats discarding it — not correcting at all is the larger
     * error, and it is the one that goes lean.
     *
     * (Tuning with MAP compensation still on is its own problem — it hides VE error from the
     * trim — but that invalidates the whole run, not this measurement.)
     *
     * `egt` is optional and additive. Given the DME's own tables it also fills the cross-check
     * pair — see LogDataPoint.egtFromRfKorr / rfKorrFromEgt — which is the same rf_korr reached
     * by karter16's TABG route, so the two can be laid side by side. Without it this behaves
     * exactly as it did before the tables existed, which is what every no-binary path relies on.
     */
    /**
     * What the CORRECTED table would have applied at this sample's operating point.
     *
     * Reads the tuned grid on its own axes, with the same clamped-bilinear rule the DME uses, so
     * the number divided out here is the number the DME will multiply back in once these bytes
     * are flashed. Returns undefined when the sample has no Δ — nothing can be said about it, and
     * the cell just carries less evidence for the tuned path.
     */
    private tunedRfKorrAt(tuned: RfKorrTuneResult, point: LogDataPoint): number | undefined {
        if (point.tabgDelta === undefined) return undefined;
        return interpMap2d(tuned.rpm, tuned.delta, tuned.tuned, point.rpm, point.tabgDelta);
    }

    public annotateRfKorr(
        currentMap: VEMap, logData: LogDataPoint[], egt?: EgtTables | null,
    ): LogDataPoint[] {
        return logData.map(point => this.annotateRfKorrPoint(currentMap, point, egt));
    }

    /** One sample's worth of the above. Split out so a live run can annotate the samples that
     *  arrived rather than the whole drive again; the batch call is this in a `.map`, so the two
     *  cannot produce different numbers. */
    public annotateRfKorrPoint(
        currentMap: VEMap, point: LogDataPoint, egt?: EgtTables | null,
    ): LogDataPoint {
        {
            if (point.rf === undefined) return point;

            const loadVal = point.correctedLoad ?? point.rawLoad;
            const rfSoll = this.interpolateMap(currentMap, point.rpm, loadVal);
            // rfSoll is dimensionless (the table stores raw/1000, 1.0 = 100% fill); the DS2 RF
            // channel is a percentage. A zero or negative lookup means the operating point sits
            // outside anything the table describes, and a ratio there would be noise.
            if (!(rfSoll > 0)) return point;

            const rfKorr = (point.rf / 100) / rfSoll;
            const out: LogDataPoint = { ...point, rfKorr, rfSoll };
            if (!egt) return out;

            // The nominal exhaust temperature BMW measured for this operating point. Both derived
            // columns hang off it, and the DME's own Y axis for this table is the final RF — which
            // is the channel we logged, not rf_soll.
            const model = tabgModelAt(egt, point.rpm, point.rf / 100);

            // (a) rf_korr -> EGT. Sparse: refuses wherever the profile cannot be inverted honestly.
            //     The sensor's own delta is passed as a hint so the two non-monotone rpm bands
            //     (1600 / 1900) can still answer when there is a sensor to break the tie — that is
            //     not circular, because the hint only PICKS among exact roots of the measured k.
            // The DME's own Y-axis input. Computed once, here, so nothing downstream can arrive at
            // a different Δ for the same sample.
            const hint = point.exhaustTemp === undefined
                ? undefined : Math.max(0, model - point.exhaustTemp);
            if (hint !== undefined) out.tabgDelta = hint;
            const deltaInv = invertRfKorrProfile(
                rfKorrProfileAt(egt, point.rpm), egt.rfKorr.delta, rfKorr,
                { ...EGT_INVERSION_DEFAULTS, hint },
            );
            if (deltaInv !== undefined) out.egtFromRfKorr = model - deltaInv;

            // (b) EGT -> rf_korr. Reproduces the gate rather than ignoring it: below the filling
            //     floor the DME applies 1.000 regardless of how cold the exhaust is, so 1.000 is
            //     the right answer there and matching `rfKorr` is a clean pass on both offsets.
            if (hint !== undefined) {
                out.rfKorrFromEgt = gateOpen(egt, point.rpm, rfSoll)
                    ? rfKorrAt(egt, point.rpm, hint)
                    : 1.0;
            }

            return out;
        }
    }

    private findBoundingIndices(value: number, axis: number[]): { idx1: number; idx2: number; w1: number; w2: number } | null {
        // Handle out of bounds - clamp to edge? Or ignore?
        // MLV likely clamps or ignores. Let's clamp to valid range essentially but effectively Nearest on edges if outside.
        // Actually, if it's below min or above max, we might just assign 100% to the edge cell.

        if (value <= axis[0]) return { idx1: 0, idx2: 0, w1: 1.0, w2: 0.0 };
        if (value >= axis[axis.length - 1]) return { idx1: axis.length - 1, idx2: axis.length - 1, w1: 1.0, w2: 0.0 };

        for (let i = 0; i < axis.length - 1; i++) {
            if (value >= axis[i] && value <= axis[i + 1]) {
                const range = axis[i + 1] - axis[i];
                if (range === 0) return { idx1: i, idx2: i, w1: 1.0, w2: 0.0 };

                const w2 = (value - axis[i]) / range; // Weight for higher index
                const w1 = 1.0 - w2;                  // Weight for lower index
                return { idx1: i, idx2: i + 1, w1, w2 };
            }
        }
        return null; // Should be covered by boundary checks
    }

    private distributeWeight(
        grid: GridCell[][],
        rows: number,
        cols: number,
        rpm: { idx1: number; idx2: number; w1: number; w2: number },
        load: { idx1: number; idx2: number; w1: number; w2: number },
        val: number,
        rfKorr?: number,
        tunedVal?: number
    ) {
        // 4 corners:
        // (r1, c1) weight: load.w1 * rpm.w1
        // (r1, c2) weight: load.w1 * rpm.w2
        // (r2, c1) weight: load.w2 * rpm.w1
        // (r2, c2) weight: load.w2 * rpm.w2

        const add = (r: number, c: number, w: number) => {
            if (r >= 0 && r < rows && c >= 0 && c < cols && w > 0) {
                const cell = grid[r][c];
                cell.sumStftWeighted += val * w; // Accumulate Weighted Value
                cell.weightSum += w;             // Accumulate Weight
                cell.rawCount++;                 // Increment Raw Count (Integer)

                if (rfKorr !== undefined) {
                    cell.sumRfKorrWeighted += rfKorr * w;
                    cell.weightSumRfKorr += w;
                    if (rfKorr < cell.minRfKorr) cell.minRfKorr = rfKorr;
                    if (rfKorr > cell.maxRfKorr) cell.maxRfKorr = rfKorr;
                }

                // Its own weight, like rf_korr's: the tuned correction is available on strictly
                // fewer samples than the nominal one, and dividing by the shared weightSum would
                // understate it on any cell holding a mix.
                if (tunedVal !== undefined) {
                    cell.sumTunedWeighted += tunedVal * w;
                    cell.weightSumTuned += w;
                }
            }
        };

        add(load.idx1, rpm.idx1, load.w1 * rpm.w1);
        add(load.idx1, rpm.idx2, load.w1 * rpm.w2);
        add(load.idx2, rpm.idx1, load.w2 * rpm.w1);
        add(load.idx2, rpm.idx2, load.w2 * rpm.w2);
    }

    /**
     * [EXPERIMENTAL] Auto-generates a Warmup Map based on the Tuned VE Map.
     * Logic: NewWarmup = NewVE_Intep * (StockWarmup / StockVE_Interp)
     * Handles Axis Mismatch by interpolating Main VE maps to match Warmup Map axes.
     */
    public generateWarmupMap(newVEMap: VEMap): VEMap {
        const stockVE = { // Construct VEMap object for Stock Data
            xAxis: APP_CONFIG.MSS54HP.AXIS_RPM,
            yAxis: APP_CONFIG.MSS54HP.AXIS_LOAD,
            data: CSL_STOCK_MAP_DATA
        };
        const stockWarmup = CSL_STOCK_WARMUP_MAP;

        // Use the specific axes for Cold Map
        const targetRpmAxis = CSL_STOCK_WARMUP_RPM;
        const targetLoadAxis = CSL_STOCK_WARMUP_LOAD;

        // Validation - ensure dimensions match our constants
        if (stockWarmup.length !== targetLoadAxis.length || stockWarmup[0].length !== targetRpmAxis.length) {
            console.warn("Stock Warmup Map dimensions mismatch with defined Constants. Returning New VE Map fallback.");
            return newVEMap;
        }

        const newWarmupData: number[][] = [];

        for (let r = 0; r < targetLoadAxis.length; r++) {
            const rowArr: number[] = [];
            const load = targetLoadAxis[r];

            for (let c = 0; c < targetRpmAxis.length; c++) {
                const rpm = targetRpmAxis[c];

                const sWarm = stockWarmup[r][c];

                // Interpolate Main Maps at Cold Map (rpm, load)
                // We need the value of the Main Map at this specific operating point
                const sVE_Interp = this.interpolateMap(stockVE, rpm, load);
                const nVE_Interp = this.interpolateMap(newVEMap, rpm, load);

                // Calculate Ratio: Stock Warmup / Stock Main (Interpolated)
                const ratio = sVE_Interp !== 0 ? sWarm / sVE_Interp : 1.0;

                // New Warmup = New VE (Interpolated) * Ratio
                rowArr.push(nVE_Interp * ratio);
            }
            newWarmupData.push(rowArr);
        }

        return {
            xAxis: targetRpmAxis,    // Return map with ITS OWN axes
            yAxis: targetLoadAxis,
            data: newWarmupData
        };
    }

    /**
     * Bilinear Interpolation helper to get value from a Map at any (rpm, load)
     */
    private interpolateMap(map: VEMap, rpm: number, load: number): number {
        // Find bounding indices
        const rInfo = this.findBoundingIndices(load, map.yAxis); // Load is Y-axis
        const cInfo = this.findBoundingIndices(rpm, map.xAxis);  // RPM is X-axis

        if (!rInfo || !cInfo) return 0;

        // 4 Neighbors
        const v11 = map.data[rInfo.idx1][cInfo.idx1]; // Top-Left
        const v12 = map.data[rInfo.idx1][cInfo.idx2]; // Top-Right
        const v21 = map.data[rInfo.idx2][cInfo.idx1]; // Bottom-Left
        const v22 = map.data[rInfo.idx2][cInfo.idx2]; // Bottom-Right

        // Interpolate Logic
        // Val = w1*w1*v11 + w1*w2*v12 ... 
        // My weights are: w1 (lower index weight), w2 (higher index weight)
        // rInfo.w1 is weight for idx1 (lower). rInfo.w2 is weight for idx2 (higher).

        // Lerp Formula: V = V_low * w_low + V_high * w_high
        const valRow1 = v11 * cInfo.w1 + v12 * cInfo.w2; // Interpolate X at Row 1
        const valRow2 = v21 * cInfo.w1 + v22 * cInfo.w2; // Interpolate X at Row 2

        const res = valRow1 * rInfo.w1 + valRow2 * rInfo.w2; // Interpolate Y

        return res;
    }
    /**
     * [EXPERIMENTAL] Auto-generates a WOT Curve based on the Tuned VE Map (100% Load Column).
     * Logic: NewWOT(rpm) = NewVE(rpm, 100%) * (StockWOT(rpm) / StockVE(rpm, 100%))
     */
    /**
     * [EXPERIMENTAL] Auto-generates a WOT Map (3x18) based on the Tuned VE Map (High Load).
     * Logic: NewWOT(rpm) = NewVE_Intep(rpm, maxLoad) * (StockWOT(rpm) / StockVE_Interp(rpm, maxLoad))
     */
    public generateWOTMap(newVEMap: VEMap): number[][] {
        const stockVE = { // Construct VEMap object for Stock Data
            xAxis: APP_CONFIG.MSS54HP.AXIS_RPM,
            yAxis: APP_CONFIG.MSS54HP.AXIS_LOAD,
            data: CSL_STOCK_MAP_DATA
        };
        const stockWOT = CSL_STOCK_WOT_MAP;
        const targetRpmAxis = CSL_STOCK_WOT_RPM;

        // Define "WOT Load" as the maximum load in the main map (e.g. 100% or highest defined)
        // We use the last value of the stock load axis.
        const maxLoad = APP_CONFIG.MSS54HP.AXIS_LOAD[APP_CONFIG.MSS54HP.AXIS_LOAD.length - 1];

        // Validation
        if (stockWOT[0].length !== targetRpmAxis.length) {
            console.warn("Stock WOT Map dimensions mismatch constants. Returning empty.");
            return [];
        }

        const calculatedRow: number[] = [];

        // Calculate the 1D Curve first (using the first row of Stock WOT as reference)
        for (let c = 0; c < targetRpmAxis.length; c++) {
            const rpm = targetRpmAxis[c];
            const sWotVal = stockWOT[0][c];

            const sVE_Interp = this.interpolateMap(stockVE, rpm, maxLoad);
            const nVE_Interp = this.interpolateMap(newVEMap, rpm, maxLoad);

            const ratio = sVE_Interp !== 0 ? sWotVal / sVE_Interp : 1.0;
            calculatedRow.push(nVE_Interp * ratio);
        }

        // Return 3 identical rows (matching Stock WOT structure)
        return [
            [...calculatedRow],
            [...calculatedRow],
            [...calculatedRow]
        ];
    }
}
