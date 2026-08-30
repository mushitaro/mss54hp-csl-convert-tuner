import React from 'react';
import { LogDataPoint } from '@/lib/types';
import { Info } from 'lucide-react';
import { useDialogLang } from '@/hooks/useDialogLang';
import { FieldKey, LOG_FIELD_REGISTRY, TOGGLEABLE_FIELDS, isFieldPresent, DEFAULT_FIELD_VISIBILITY, describeField } from '@/lib/field-registry/registry';

/**
 * What a partial view is and how to move it — behind the ⓘ, like every explanation in this app.
 *
 * It used to be a permanent line in the header: "Windowed — use the slider or swipe the chart". It
 * is standing instructions, and standing instructions read once are furniture from then on
 * (operator, 2026-08-25), competing for a header the record count also has to fit into. The FACT
 * that the view is partial is not hidden with it — "Displaying 2,000 of 12,431 records", to its
 * left, is the same statement in the form that stays useful after the first read.
 *
 * The gestures are named here and nowhere else, which is why this line is the one that had to grow
 * when the chart learnt to pinch: it is where a reader goes to find out what the chart will do.
 */
const WINDOW_HINT = {
    ja: 'ログの一部だけを表示しています。表示範囲は、下のスライダーを動かすか、グラフを横にスワイプすると移動します。'
        + 'グラフはピンチで拡大縮小できます（拡大は表示範囲の中だけで、どのデータを見ているかは変わりません）。',
    en: 'Only part of the log is on screen. Move the view with the slider below, or by swiping the '
        + 'chart sideways. Pinch the chart to zoom — magnification stays inside the window and does '
        + 'not change which data you are looking at.',
};

interface Props {
    data: LogDataPoint[];
    selectedIndex?: number | null;
    onRowClick?: (index: number) => void;
    totalCount?: number;
    visibleFields?: Record<FieldKey, boolean>;
    /** Full/raw log used only to decide which optional columns exist, so the column set stays stable
     *  even when the filtered view (`data`) is empty. Falls back to `data` when not provided. */
    presenceData?: LogDataPoint[];
    /**
     * Whether this table is on screen right now.
     *
     * The narrow layout keeps both panes mounted and hides one with `invisible`, so being rendered
     * is not the same as being visible — and a scroll requested while invisible does not happen.
     * Defaults to true, which is what it is for anything that renders it unconditionally.
     */
    active?: boolean;
}

// Factor is a computed diagnostic (rawLoad / correctedLoad, driven by the Alpha-N table), so it is
// styled here as a fixed column rather than a toggleable data channel.
const FACTOR_COLOR = '#9B84E8'; // M-violet (secondary / diagnostic) — matches lineage badges

export const LogDataTable: React.FC<Props> = ({ data, selectedIndex, onRowClick, totalCount, visibleFields = DEFAULT_FIELD_VISIBILITY, presenceData, active = true }) => {
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

    const lang = useDialogLang();
    const [hintOpen, setHintOpen] = React.useState(false);

    // Column set is derived from the log SOURCE (presenceData), not the possibly-empty filtered view,
    // so it doesn't change between live logging (which may be filtered to zero rows) and a loaded DB
    // session. A toggleable channel shows when the source provides it and the user has it enabled.
    const presenceSource = presenceData && presenceData.length > 0 ? presenceData : displayData;
    const columns: FieldKey[] = TOGGLEABLE_FIELDS.filter(key => visibleFields[key] && isFieldPresent(key, presenceSource));

    /**
     * Bring the selected row to the middle — including when the selection was made while this table
     * was off screen.
     *
     * A point picked on the chart is picked on the OTHER narrow pane, and the pane this table is on
     * is `invisible` at that moment. Two things then went wrong, and both had to be fixed for the
     * jump to happen at all:
     *
     *   • `behavior: 'smooth'` is an animation, and an animation in a subtree that is not being
     *     painted is dropped rather than deferred. Measured: `scrollIntoView({block:'center'})` on
     *     a hidden pane moves the container to 11,214px, the same call with `behavior: 'smooth'`
     *     leaves it at 0. A jump is what is wanted anyway — a 400 ms ride past 2,000 rows nobody
     *     asked to see is not better than being there.
     *   • Nothing re-ran when the pane came back. The selection had not changed by then, so the
     *     effect keyed on it alone had already had its turn and missed. `active` is in the deps for
     *     exactly that: the pane becoming visible is the second chance.
     */
    React.useEffect(() => {
        if (!active || selectedIndex === undefined || selectedIndex === null) return;
        document.getElementById(`log-row-${selectedIndex}`)?.scrollIntoView({ block: 'center' });
    }, [selectedIndex, active]);

    return (
        <div className="h-full flex flex-col bg-slate-900/50">
            <div className="px-4 py-2 border-b border-slate-800 text-xs text-slate-400">
                <div className="flex justify-between items-center gap-2">
                    <span>Displaying {displayData.length.toLocaleString()} of {effectiveTotal.toLocaleString()} records</span>
                    {/* Keyed on the window being partial, not on this table truncating anything — it
                        no longer does. Offered only then, because with the whole log on screen there
                        is no view to move and nothing the hint would be about. `p-1.5 -mr-1.5` is
                        the filter panel's own ⓘ box: a 24px target that adds no height to the row. */}
                    {effectiveTotal > displayData.length && (
                        <button
                            type="button"
                            onClick={() => setHintOpen(v => !v)}
                            aria-expanded={hintOpen}
                            aria-label="About the windowed view"
                            className={`p-1.5 -mr-1.5 rounded shrink-0 transition-colors ${hintOpen ? 'text-blue-400' : 'text-slate-600 hover:text-slate-400'}`}
                        >
                            <Info className="w-3 h-3" />
                        </button>
                    )}
                </div>
                {hintOpen && effectiveTotal > displayData.length && (
                    <p className="text-[9px] text-slate-500 leading-relaxed pt-1">{WINDOW_HINT[lang]}</p>
                )}
            </div>

            <div className="flex-1 overflow-auto relative">
                <table className="w-full text-right border-collapse text-[10px] font-mono">
                    <thead className="sticky top-0 bg-slate-950 z-10 text-slate-500 font-bold uppercase tracking-wider">
                        <tr>
                            <th className="py-2 px-3 text-left border-b border-slate-800 sticky left-0 bg-slate-950">Time</th>
                            {/* Headers are DME symbols in a monospace face, hover for the description and
                                the selection/offset they arrived at. Lowercase is preserved deliberately:
                                these are identifiers shared with the reference tool, the Funktionsrahmen
                                and the disassembly, and shouting them breaks the match. */}
                            <th className="py-2 px-3 border-b border-slate-800 font-mono" title={describeField(LOG_FIELD_REGISTRY.rpm)}>{LOG_FIELD_REGISTRY.rpm.symbol}</th>
                            <th className="py-2 px-3 border-b border-slate-800 text-slate-400 font-mono" title={describeField(LOG_FIELD_REGISTRY.rawLoad)}>{LOG_FIELD_REGISTRY.rawLoad.symbol}</th>
                            {/* Factor: app-computed (Alpha-N by RPM), always shown between Raw and Corrected */}
                            <th className="py-2 px-3 border-b border-slate-800" style={{ color: FACTOR_COLOR }} title="Alpha-N interpolation factor at this RPM
Computed by this app — the DME never sent this.">Factor</th>
                            <th className="py-2 px-3 border-b border-slate-800" style={{ color: LOG_FIELD_REGISTRY.correctedLoad.color }} title={describeField(LOG_FIELD_REGISTRY.correctedLoad)}>{LOG_FIELD_REGISTRY.correctedLoad.symbol}</th>
                            {columns.map(key => (
                                <th
                                    key={key}
                                    className={`py-2 px-3 border-b border-slate-800 ${LOG_FIELD_REGISTRY[key].source === 'derived' ? '' : 'font-mono'}`}
                                    style={{ color: LOG_FIELD_REGISTRY[key].color }}
                                    title={describeField(LOG_FIELD_REGISTRY[key])}
                                >
                                    {LOG_FIELD_REGISTRY[key].symbol}
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
                                {/* Sticky, so the row keeps a handle once the table is scrolled sideways —
                                    with 10+ columns the time was the first thing to leave and every row
                                    then looked alike. A sticky cell has to be opaque or the columns
                                    sliding under it show through, which is why the selected state repeats
                                    here as a flat colour: #02151F is exactly the row's `bg-blue-900/40`
                                    (#06354E at 40%) resolved over the black table, so the highlight still
                                    reads across the one column that says which row you picked. */}
                                <td className={`py-1 px-3 text-left sticky left-0 z-[5] ${selectedIndex === index ? 'bg-[#02151F] text-blue-200' : 'bg-slate-950 text-slate-500'}`}>{row.time.toFixed(0)}</td>
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
