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
}

export const MapEditor: React.FC<Props> = ({ mapData, diffData, hitData, weightData, className }) => {
    // Render a scrollable grid
    // Styles: Dark mode table

    // Calculate max hits for heatmap normalization
    let maxHits = 1;
    if (hitData) {
        for (const row of hitData) {
            for (const val of row) {
                if (val > maxHits) maxHits = val;
            }
        }
    }

    return (
        <div className={clsx('overflow-auto h-full', className)}>
            <table className="w-full text-xs text-right border-collapse bg-slate-900">
                <thead className="sticky top-0 bg-slate-800 z-10">
                    <tr>
                        <th
                            className="p-2 text-slate-400 border-b border-r border-slate-700 sticky left-0 bg-slate-800 z-20 cursor-help"
                            title="Rows = RO % (load) / Columns = RPM"
                        >
                            <div className="flex items-center justify-center">
                                <Info className="w-3.5 h-3.5" />
                            </div>
                        </th>
                        {mapData.xAxis.map((rpm, i) => (
                            <th key={i} className="p-2 text-slate-300 font-mono border-b border-slate-700 min-w-[50px]">
                                {rpm}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {mapData.yAxis.map((load, rowIdx) => (
                        <tr key={rowIdx} className="hover:bg-slate-800/50">
                            <td className="p-2 text-slate-300 font-mono border-r border-slate-700 sticky left-0 bg-slate-900 font-bold">
                                {load.toFixed(2)}
                            </td>
                            {mapData.data[rowIdx].map((val, colIdx) => {
                                const diff = diffData ? diffData[rowIdx][colIdx] : 0;
                                const hits = hitData ? hitData[rowIdx][colIdx] : 0;
                                const weight = weightData ? weightData[rowIdx][colIdx] : 0;

                                // Colorize based on Diff
                                let bgColor = 'transparent';
                                let textColor = 'text-slate-400';
                                let style = {};

                                // If hits exist and no diff (or low diff logic), apply heat map
                                // User asked to prioritize seeing hits by color
                                const hasHits = hits > 0;

                                if (hasHits && (!diffData)) {
                                    const intensity = Math.min(hits / maxHits, 1.0);
                                    // Ice blue (#8FD8F2) = "the log actually visited this cell", the same
                                    // OK/present role emerald-* now carries. Safe to share the blue family
                                    // with the lean-diff fill below: the guard above means a cell can never
                                    // paint both, and diffData is all-or-nothing for the whole table.
                                    style = { backgroundColor: `rgba(143, 216, 242, ${intensity * 0.3})` };
                                    textColor = hits > maxHits * 0.5 ? 'text-emerald-100' : 'text-slate-300';
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

                                return (
                                    <td
                                        key={colIdx}
                                        style={style}
                                        className={clsx(
                                            'p-1 border border-slate-800 font-mono transition-colors relative group',
                                            bgColor,
                                            hasHits ? 'font-bold' : 'opacity-80'
                                        )}
                                        title={`RPM: ${mapData.xAxis[colIdx]}, RO %: ${load}\nRF %: ${val}\nHits: ${hits}\nWeight: ${weight.toFixed(2)}`}
                                    >
                                        <span className={textColor}>
                                            {diffData ? `${val > 0 ? '+' : ''}${val.toFixed(1)}%` : val.toFixed(3)}
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
};
