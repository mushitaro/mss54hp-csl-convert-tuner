import React from 'react';
import { LogDataPoint } from '@/lib/types';
import { AlertCircle } from 'lucide-react';
import { FieldKey, LOG_FIELD_REGISTRY, TOGGLEABLE_FIELDS, isFieldPresent, DEFAULT_FIELD_VISIBILITY } from '@/lib/field-registry/registry';

interface Props {
    data: LogDataPoint[];
    selectedIndex?: number | null;
    onRowClick?: (index: number) => void;
    totalCount?: number;
    visibleFields?: Record<FieldKey, boolean>;
    /** Full/raw log used only to decide which optional columns exist, so the column set stays stable
     *  even when the filtered view (`data`) is empty. Falls back to `data` when not provided. */
    presenceData?: LogDataPoint[];
}

// Factor is a computed diagnostic (rawLoad / correctedLoad, driven by the Alpha-N table), so it is
// styled here as a fixed column rather than a toggleable data channel.
const FACTOR_COLOR = '#9B84E8'; // M-violet (secondary / diagnostic) — matches lineage badges

export const LogDataTable: React.FC<Props> = ({ data, selectedIndex, onRowClick, totalCount, visibleFields = DEFAULT_FIELD_VISIBILITY, presenceData }) => {
    /**
     * `data` is already the shared window, so this renders it whole and indexes it directly.
     *
     * The cap that used to live here is gone along with the paging that replaced it. Both were ways
     * of deciding what to show, and this table must not make that decision at all: the window does,
     * for both views at once. A second, independent limit here is precisely what desynced the chart
     * from the rows — the chart offered indices this table had never rendered.
     *
     * The size bound still holds, one level up: the window is LOG_WINDOW_SIZE points, which is what
     * keeps the DOM at ~16,000 cells. (Measured: 2,000 rows ≈ 440 ms to build, 10,000 ≈ 2.2 s — and
     * it is rebuilt on every click, since the selection is a prop.)
     */
    const displayData = data;

    const effectiveTotal = totalCount ?? data.length;

    // Column set is derived from the log SOURCE (presenceData), not the possibly-empty filtered view,
    // so it doesn't change between live logging (which may be filtered to zero rows) and a loaded DB
    // session. A toggleable channel shows when the source provides it and the user has it enabled.
    const presenceSource = presenceData && presenceData.length > 0 ? presenceData : displayData;
    const columns: FieldKey[] = TOGGLEABLE_FIELDS.filter(key => visibleFields[key] && isFieldPresent(key, presenceSource));

    // Scroll to selected row
    React.useEffect(() => {
        if (selectedIndex !== undefined && selectedIndex !== null) {
            const row = document.getElementById(`log-row-${selectedIndex}`);
            if (row) {
                row.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        }
    }, [selectedIndex]);

    return (
        <div className="h-full flex flex-col bg-slate-900/50">
            <div className="flex px-4 py-2 border-b border-slate-800 justify-between items-center text-xs text-slate-400">
                <span>Displaying {displayData.length.toLocaleString()} of {effectiveTotal.toLocaleString()} records</span>
                {/* Keyed on the window being partial, not on this table truncating anything — it no
                    longer does. Says the same thing the chart is showing, because they share it. */}
                {effectiveTotal > displayData.length && (
                    <span className="text-orange-400 flex items-center gap-1">
                        <AlertCircle className="w-3 h-3" /> Windowed — use the slider or swipe the chart
                    </span>
                )}
            </div>

            <div className="flex-1 overflow-auto relative">
                <table className="w-full text-right border-collapse text-[10px] font-mono">
                    <thead className="sticky top-0 bg-slate-950 z-10 text-slate-500 font-bold uppercase tracking-wider">
                        <tr>
                            <th className="py-2 px-3 text-left border-b border-slate-800">Time</th>
                            <th className="py-2 px-3 border-b border-slate-800">{LOG_FIELD_REGISTRY.rpm.label}</th>
                            <th className="py-2 px-3 border-b border-slate-800 text-slate-400">{LOG_FIELD_REGISTRY.rawLoad.label}</th>
                            {/* Factor: app-computed (Alpha-N by RPM), always shown between Raw and Corrected */}
                            <th className="py-2 px-3 border-b border-slate-800" style={{ color: FACTOR_COLOR }}>Factor</th>
                            <th className="py-2 px-3 border-b border-slate-800" style={{ color: LOG_FIELD_REGISTRY.correctedLoad.color }}>{LOG_FIELD_REGISTRY.correctedLoad.label}</th>
                            {columns.map(key => (
                                <th key={key} className="py-2 px-3 border-b border-slate-800" style={{ color: LOG_FIELD_REGISTRY[key].color }}>
                                    {LOG_FIELD_REGISTRY[key].label}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/50">
                        {displayData.map((row, index) => (
                            <tr
                                key={index}
                                id={`log-row-${index}`}
                                onClick={() => onRowClick && onRowClick(index)}
                                className={`cursor-pointer transition-colors ${selectedIndex === index
                                    ? 'bg-blue-900/40 hover:bg-blue-900/50'
                                    : 'hover:bg-slate-800/50'
                                    }`}
                            >
                                <td className={`py-1 px-3 text-left ${selectedIndex === index ? 'text-blue-200' : 'text-slate-500'}`}>{row.time.toFixed(0)}</td>
                                <td className="py-1 px-3 text-slate-300">{LOG_FIELD_REGISTRY.rpm.format(row.rpm)}</td>
                                <td className="py-1 px-3 text-slate-400">{LOG_FIELD_REGISTRY.rawLoad.format(row.rawLoad)}</td>
                                <td className="py-1 px-3" style={{ color: FACTOR_COLOR }}>{row.correctionFactor?.toFixed(2) ?? '1.00'}</td>
                                <td className="py-1 px-3 font-bold" style={{ color: LOG_FIELD_REGISTRY.correctedLoad.color }}>{row.correctedLoad !== undefined ? LOG_FIELD_REGISTRY.correctedLoad.format(row.correctedLoad) : '-'}</td>
                                {columns.map(key => {
                                    const value = row[key];
                                    return (
                                        <td key={key} className="py-1 px-3" style={{ color: LOG_FIELD_REGISTRY[key].color }}>
                                            {value !== undefined ? LOG_FIELD_REGISTRY[key].format(value) : '-'}
                                        </td>
                                    );
                                })}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
};
