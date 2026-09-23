import { VEMap } from '@/lib/types';
import { RfKorrTuneResult } from './rfKorrTuner';

/**
 * One definition of what the RF KORR tab is currently showing.
 *
 * The table and the 3D surface are two renderings of the same table, and they sat in different
 * components with the selection held inside one of them — so the grid switched between STOCK,
 * TUNED and CHANGE % while the surface beside it stayed on TUNED forever, silently. Two views of
 * one thing disagreeing is worse than only having one: the surface looked like a second opinion.
 *
 * So the selection moves up to the page and the mapping from selection to picture lives here,
 * where both readers take it from the same function. React-free on purpose — the axis names and
 * the midpoints are facts about the table, not about a component, and a probe can assert on them
 * without mounting anything.
 */

export type RfKorrView = 'tuned' | 'stock' | 'diff';

/**
 * What the axes of KF_RF_KORR_DRREL actually are.
 *
 * Exported as constants because getting this wrong is the failure that prompted them. The 3D
 * scene had `RO %` written into it — the VE map's load axis — so the RF KORR surface announced its
 * rows as engine load when they are **exhaust temperature deltas in °C**. A reader who trusted it
 * would have read the whole map as a function of the wrong variable.
 *
 * The delta is the model's expected exhaust temperature minus the measured one, so a larger row
 * value means the sensor is reading further BELOW the model — see docs/ecu-logic/20-egt-correction.md.
 */
export const RF_KORR_ROW_LABEL = 'TABG Δ °C';
export const RF_KORR_COL_LABEL = 'RPM';
export const RF_KORR_VALUE_LABEL = 'RF KORR';

export interface RfKorrViewData {
    /** The grid to draw, on the table's own axes. */
    map: VEMap;
    /** Per-cell change against stock, in percent. Supplied for every view rather than only for
     *  `diff`: the table paints it as the cell fill in the diff view and as the small corner tag
     *  elsewhere, and computing it twice invites the two from drifting apart. */
    changePercent: number[][];
    /** What the surface's Z axis is showing in this view. */
    zAxisLabel: string;
    /** Where the deviation scale's neutral colour sits. A correction factor is centred on 1.000 —
     *  a table of 1.000 means "no correction anywhere" — while a percentage change is centred on 0.
     *  Stating it per view is what stops "no change" drifting with whatever this log's extremes
     *  happened to be. */
    deviationMidpoint: number;
}

/** Change against stock, per cell, in percent. Zero where the tune declined to write. */
export function rfKorrChangePercent(result: RfKorrTuneResult): number[][] {
    return result.tuned.map((row, r) => row.map((v, c) => {
        const stock = result.stock[r][c];
        // Guarded rather than assumed non-zero: a stock cell of 0 would be a decode failure, and a
        // division by it would paint Infinity across the map instead of showing that the read went
        // wrong. readEgtTables is all-or-nothing, so this should be unreachable — which is exactly
        // why it must not produce a plausible-looking number if it ever is reached.
        return stock > 0 ? (v / stock - 1) * 100 : 0;
    }));
}

export function rfKorrViewData(result: RfKorrTuneResult, view: RfKorrView): RfKorrViewData {
    const changePercent = rfKorrChangePercent(result);
    const grid = (data: number[][]): VEMap => ({ xAxis: result.rpm, yAxis: result.delta, data });

    switch (view) {
        case 'stock':
            return {
                map: grid(result.stock),
                changePercent,
                zAxisLabel: `${RF_KORR_VALUE_LABEL} (STOCK)`,
                deviationMidpoint: 1,
            };
        case 'diff':
            return {
                map: grid(changePercent),
                changePercent,
                zAxisLabel: 'CHANGE %',
                deviationMidpoint: 0,
            };
        case 'tuned':
            return {
                map: grid(result.tuned),
                changePercent,
                zAxisLabel: `${RF_KORR_VALUE_LABEL} (TUNED)`,
                deviationMidpoint: 1,
            };
    }
}
