'use client';

import React from 'react';
import { VEMap } from '@/lib/types';
import clsx from 'clsx'; // Install clsx if not already
import { Info } from 'lucide-react';

interface Props {
    mapData: VEMap;
    diffData?: number[][]; // Percentage diff
    hitData?: number[][]; // Hit counts
    weightData?: number[][]; // [NEW] Cell Weights
    className?: string;
    /** 1 is the size this grid has always been. See CELL/HEAD below. */
    zoom?: number;

    // --- What the numbers ARE ------------------------------------------------------------------
    // The grid itself has always been generic over xAxis.length / yAxis.length; only the labels
    // were pinned to the VE map. Defaults reproduce those strings exactly, so every existing call
    // site is unchanged. Supplied when the same grid shows a different table — KF_RF_KORR_DRREL is
    // 12 x 6 on rpm x exhaust-temperature delta, and calling its rows "RO %" would be a lie in the
    // one place a reader looks to find out what they are seeing.
    rowLabel?: string;
    colLabel?: string;
    valueLabel?: string;
    rowFormat?: (value: number) => string;
    valueFormat?: (value: number) => string;
    /** Per-cell text appended to the cell's tooltip. Used for coverage and rejection reasons. */
    cellNote?: (row: number, col: number) => string | undefined;
    /** Cells to render as inert — present, readable, and not part of the result. */
    mutedCells?: boolean[][];
}

/**
 * The grid's natural geometry at zoom 1, in px, and the only place these numbers live.
 *
 * Scaled by multiplication rather than by `transform: scale()`, which would be the obvious way and
 * is the wrong one here: this table's row and column headers are `position: sticky`, and a transform
 * on an ancestor becomes their containing block — the headers would stop sticking to the scroll port
 * and start sticking to the table, which is the one thing that makes a 20x24 grid readable on a
 * phone. Multiplying the widths keeps `table-fixed` intact too, so the 6.9s auto-layout pass this
 * grid was rescued from stays gone.
 */
const CELL = 50;   // per RPM column
const HEAD = 64;   // the RO % axis down the left
const FONT = 12;   // text-xs
const LINE = 16;   // …and its line-height, which has to scale with it or tall text clips
const PAD_HEAD = 8; // p-2 on the header cells
const PAD_CELL = 4; // p-1 on the data cells

// Coverage bands for the hit heat. These are ABSOLUTE sample counts, deliberately
// not a fraction of the busiest cell: the question this heat answers is "have I
// gathered enough here yet", which has a fixed answer per cell. Normalising by the
// max made the whole map fade as one cell filled up — the map got darker the longer
// you drove, which is backwards for spotting the gaps you still need to cover.
//
// These are a DISPLAY threshold, not a calculation one. calculator.ts only needs
// weightSum > 0.1, so a cell with a single sample still produces a correction. The
// bands say how thin the evidence under that correction is, which is exactly the
// "should I go drive this area more" signal.
const COVERAGE_THIN = 10;   // below this: some data, not enough to trust
const COVERAGE_OK = 30;     // at or above this: enough samples to act on

// One ice blue (#8FD8F2) over the table's slate-900, separated by lightness only —
// the palette rule in globals.css. Kept inside the original 0–0.30 alpha range: this
// is a dark instrument, and a filled cell has to stay a tint on the table rather than
// become a bright panel sitting on top of it. 0.30 is the ceiling the relative ramp
// already used, so the brightest cell here is no brighter than the brightest cell was.
const COVERAGE_ALPHA_THIN = 0.10;
const COVERAGE_ALPHA_OK = 0.20;
const COVERAGE_ALPHA_FULL = 0.30;

/**
 * Memoised. Every cell builds a clsx string and an inline style, and there are 480 of them; the
 * hidden pane still renders (it is `display:none`, not unmounted), so without this every unrelated
 * state change in the page rebuilt the whole grid twice over.
 */
export const MapEditor: React.FC<Props> = React.memo(function MapEditor({
    mapData, diffData, hitData, weightData, className, zoom = 1,
    rowLabel = 'RO %', colLabel = 'RPM', valueLabel = 'RF %',
    rowFormat = (v: number) => v.toFixed(2),
    valueFormat = (v: number) => v.toFixed(3),
    cellNote, mutedCells,
}) {
    // Render a scrollable grid
    // Styles: Dark mode table
    const cell = Math.round(CELL * zoom);
    const head = Math.round(HEAD * zoom);
    const type = { fontSize: `${(FONT * zoom).toFixed(1)}px`, lineHeight: `${(LINE * zoom).toFixed(1)}px` };
    const padHead = `${Math.round(PAD_HEAD * zoom)}px`;
    const padCell = `${Math.round(PAD_CELL * zoom)}px`;

    return (
        <div className={clsx('overflow-auto h-full', className)}>
            {/* `table-fixed` with a stated width, not `w-full` with automatic layout.
                Automatic layout has to measure every cell before it can settle a column, and there
                are 480 of them — so each time this pane came back from `display:none` the browser
                re-solved the whole grid. Measured on a 6x-throttled CPU: a single 6.9 s task on the
                first switch to the map and about 1.3 s on every one after it, which is the whole of
                the switching lag. Fixed layout reads the widths off the first row and stops.
                The width is stated rather than left at `w-full` because `table-fixed` would
                otherwise divide the container between the columns and collapse the horizontal
                scroll this grid depends on: 20 columns of 50px plus the 64px load axis. */}
            <table
                className="table-fixed text-right border-collapse bg-slate-900"
                style={{ width: `${mapData.xAxis.length * cell + head}px`, ...type }}
            >
                <thead className="sticky top-0 bg-slate-800 z-10">
                    <tr>
                        <th
                            className="text-slate-400 border-b border-r border-slate-700 sticky left-0 bg-slate-800 z-20 cursor-help"
                            style={{ width: `${head}px`, padding: padHead }}
                            title={`Rows = ${rowLabel} / Columns = ${colLabel}`}
                        >
                            <div className="flex items-center justify-center">
                                <Info className="w-3.5 h-3.5" />
                            </div>
                        </th>
                        {mapData.xAxis.map((rpm, i) => (
                            <th key={i} className="text-slate-300 font-mono border-b border-slate-700" style={{ width: `${cell}px`, padding: padHead }}>
                                {rpm}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {mapData.yAxis.map((load, rowIdx) => (
                        <tr key={rowIdx} className="hover:bg-slate-800/50">
                            <td className="text-slate-300 font-mono border-r border-slate-700 sticky left-0 z-[5] bg-slate-900 font-bold" style={{ padding: padHead }}>
                                {rowFormat(load)}
                            </td>
                            {mapData.data[rowIdx].map((val, colIdx) => {
                                const diff = diffData ? diffData[rowIdx][colIdx] : 0;
                                const hits = hitData ? hitData[rowIdx][colIdx] : 0;
                                const weight = weightData ? weightData[rowIdx][colIdx] : 0;

                                let textColor = 'text-slate-400';
                                let style = {};

                                // If hits exist and no diff (or low diff logic), apply heat map
                                // User asked to prioritize seeing hits by color
                                const hasHits = hits > 0;

                                if (hasHits && (!diffData)) {
                                    // Ice blue (#8FD8F2) = "the log actually visited this cell", the same
                                    // OK/present role emerald-* now carries. Safe to share the blue family
                                    // with the lean-diff fill below: the guard above means a cell can never
                                    // paint both, and diffData is all-or-nothing for the whole table.
                                    const alpha =
                                        hits >= COVERAGE_OK ? COVERAGE_ALPHA_FULL
                                            : hits >= COVERAGE_THIN ? COVERAGE_ALPHA_OK
                                                : COVERAGE_ALPHA_THIN;
                                    style = { backgroundColor: `rgba(143, 216, 242, ${alpha})` };
                                    // Every band stays dark enough for the light text the rest of the
                                    // table uses, so the numbers do not change colour as coverage builds.
                                    textColor = 'text-slate-300';
                                }

                                // If diff exists, colorize (Overrides hit map or combines?)
                                // Diff is usually more critical for Tuning, so let's keep Diff priority if it exists
                                if (diffData) {
                                    // DiffData is passed as Percentage Difference (e.g. -9.5, +5.0) from page.tsx
                                    // So deviation is simply the value itself.
                                    const deviation = diff;
                                    const absDeviation = Math.abs(deviation);

                                    if (absDeviation >= 0.5) {
                                        // Dynamic Intensity Calculation
                                        // 0.5% -> 0.1 opacity
                                        // 5.0% -> 0.6 opacity (max useful opacity usually)
                                        // Formula: (absDeviation / 5.0) * 0.6, clamped
                                        const intensity = Math.min(Math.max((absDeviation / 5.0) * 0.6, 0.1), 0.7);

                                        if (deviation > 0) {
                                            // Positive Diff (New > Old) -> Adding fuel -> RED (or customized)
                                            // Usually adding fuel = Richer map setting
                                            style = { backgroundColor: `rgba(241, 26, 34, ${intensity})` }; // M-red base
                                            textColor = 'text-red-100';
                                        } else {
                                            // Negative Diff (New < Old) -> Removing fuel -> BLUE
                                            style = { backgroundColor: `rgba(10, 155, 219, ${intensity})` }; // M-blue base
                                            textColor = 'text-blue-100';
                                        }
                                    }
                                }

                                const muted = mutedCells?.[rowIdx]?.[colIdx] ?? false;
                                const note = cellNote?.(rowIdx, colIdx);

                                return (
                                    <td
                                        key={colIdx}
                                        style={{ ...style, padding: padCell }}
                                        className={clsx(
                                            'border border-slate-800 font-mono transition-colors relative group',
                                            hasHits ? 'font-bold' : 'opacity-80',
                                            // Dimmed, not hidden. A cell that carries a measurement
                                            // the tune declined to use still has to be readable —
                                            // that is what tells you WHY it was declined.
                                            muted && 'opacity-40'
                                        )}
                                        title={`${colLabel}: ${mapData.xAxis[colIdx]}, ${rowLabel}: ${load}\n`
                                            + `${valueLabel}: ${val}\nHits: ${hits}\nWeight: ${weight.toFixed(2)}`
                                            + (note ? `\n${note}` : '')}
                                    >
                                        <span className={textColor}>
                                            {diffData ? `${val > 0 ? '+' : ''}${val.toFixed(1)}%` : valueFormat(val)}
                                        </span>
                                        {diff !== 0 && Math.abs(val - diff) > 0.001 && (!diffData) && ( /* Only show small diff tag if val != diff (i.e. not in Diff View) */
                                            <span className="absolute bottom-0 right-0 text-[8px] opacity-70 px-0.5">
                                                {diff.toFixed(1)}%
                                            </span>
                                        )}
                                    </td>
                                );
                            })}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
});
