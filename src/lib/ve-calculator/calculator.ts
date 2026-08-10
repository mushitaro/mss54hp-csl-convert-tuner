import { LogDataPoint, VEMap } from '@/lib/types';
import { APP_CONFIG, CSL_STOCK_MAP_DATA, CSL_STOCK_WARMUP_MAP, CSL_STOCK_WOT_MAP, CSL_STOCK_WARMUP_RPM, CSL_STOCK_WARMUP_LOAD, CSL_STOCK_WOT_RPM } from '@/config/constants';

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
}

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
     * Whether the DME had MAP compensation disabled (k_rf_cfg = 0x02) while this log was taken.
     * Precondition for measuring rf_korr at all — see annotateRfKorr. Defaults false, so a caller
     * that cannot establish it gets the pre-existing behaviour rather than a mislabelled ratio.
     */
    mapCompensationOff?: boolean;
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
    } {
        const rows = this.loadAxis.length;
        const cols = this.rpmAxis.length;
        // Defaults ON, matching LogFilterConfig.applyRfKorr. A caller that forgets to pass options
        // must land on the rich-safe behaviour, not the one that can write a lean map.
        const applyRfKorr = options.applyRfKorr !== false;

        // Initialize accumulation grid
        const grid: GridCell[][] = Array(rows)
            .fill(null)
            .map(() =>
                Array(cols)
                    .fill(null)
                    .map(() => ({
                        sumStftWeighted: 0, weightSum: 0, rawCount: 0,
                        sumRfKorrWeighted: 0, weightSumRfKorr: 0,
                        minRfKorr: Infinity, maxRfKorr: -Infinity,
                    }))
            );

        // 1. Binning / Aggregation (Weighted)
        for (const point of logData) {
            // Use Corrected Load if available, else Raw Load
            const loadVal = point.correctedLoad ?? point.rawLoad;
            const rpmVal = point.rpm;
            const avgStft = (point.stft1 + point.stft2) / 2;

            // Find 4 bounding cells
            const rpmInfo = this.findBoundingIndices(rpmVal, this.rpmAxis);
            const loadInfo = this.findBoundingIndices(loadVal, this.loadAxis);

            if (!rpmInfo || !loadInfo) continue;

            const rfKorr = point.rfKorr;
            const correction = (applyRfKorr && rfKorr !== undefined) ? avgStft * rfKorr : avgStft;

            // Distribute to up to 4 neighbors
            this.distributeWeight(grid, rows, cols, rpmInfo, loadInfo, correction, rfKorr);
        }

        // 2. Calculation
        const newMapData: number[][] = [];
        const diffMap: number[][] = [];
        const hitMap: number[][] = [];
        const correctionMap: number[][] = [];
        const weightMap: number[][] = [];
        const rfKorrMap: number[][] = [];
        const rfKorrSpreadMap: number[][] = [];

        for (let r = 0; r < rows; r++) {
            const newRow: number[] = [];
            const diffRow: number[] = [];
            const hitRow: number[] = [];
            const correctionRow: number[] = [];
            const weightRow: number[] = [];
            const rfKorrRow: number[] = [];
            const rfKorrSpreadRow: number[] = [];

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

                // Check sufficient weight data
                if (cell.weightSum > 0.1) {
                    // Calculation uses Weighted Average
                    // Avg = Sum(Value * Weight) / Sum(Weight)
                    const avgCorrection = cell.sumStftWeighted / cell.weightSum;

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
                    hitRow.push(0);
                    correctionRow.push(1.0); // No correction
                    weightRow.push(0);
                }
            }
            newMapData.push(newRow);
            diffMap.push(diffRow);
            hitMap.push(hitRow);
            correctionMap.push(correctionRow);
            weightMap.push(weightRow);
            rfKorrMap.push(rfKorrRow);
            rfKorrSpreadMap.push(rfKorrSpreadRow);
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
            rfKorrMap, // Weighted-mean rf_korr the cell's samples were taken under
            rfKorrSpreadMap // max-min rf_korr across those samples
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
     * With MAP compensation ON the DME adds rf_p_saug_i on top, so the ratio would be rf_korr PLUS
     * the MAP integrator's contribution — a different quantity wearing the same name. Rather than
     * report that as rf_korr, `mapCompensationOff = false` leaves rfKorr undefined on every row,
     * which makes the correction fall back to STFT alone. Normal workflow satisfies the condition:
     * this app's own PATCH writes k_rf_cfg = 0x02, and the workspace is reloaded from the patched
     * buffer after a patch write, so patchStatus.mapOff tracks what the ECU actually holds.
     */
    public annotateRfKorr(
        currentMap: VEMap,
        logData: LogDataPoint[],
        mapCompensationOff: boolean,
    ): LogDataPoint[] {
        if (!mapCompensationOff) return logData;
        return logData.map(point => {
            if (point.rf === undefined) return point;

            const loadVal = point.correctedLoad ?? point.rawLoad;
            const rfSoll = this.interpolateMap(currentMap, point.rpm, loadVal);
            // rfSoll is dimensionless (the table stores raw/1000, 1.0 = 100% fill); the DS2 RF
            // channel is a percentage. A zero or negative lookup means the operating point sits
            // outside anything the table describes, and a ratio there would be noise.
            if (!(rfSoll > 0)) return point;

            return { ...point, rfKorr: (point.rf / 100) / rfSoll };
        });
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
        rfKorr?: number
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
