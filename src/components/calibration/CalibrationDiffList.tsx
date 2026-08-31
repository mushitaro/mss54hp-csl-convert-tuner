'use client';

import React, { useMemo, useState } from 'react';
import type { CalDiffEntry } from '@/hooks/useCalibrationData';
import { displayName } from '@/lib/calibration-graph/names';
import { useDialogLang } from '@/hooks/useDialogLang';

/**
 * WHICH parameters differ between the two BINs the compare bar names —
 * TunerPro's compare window, in the hub beside INFO and FLASH.
 *
 * The balance on the compare bar answers "how does THIS one differ" by
 * redrawing the visual; this answers "which ones do", which is the other half
 * and the only way to reach a parameter you did not already know about.
 * Clicking a row jumps to it — see `jump` in useCalibrationWorkspace, which
 * re-roots the diagram rather than lighting a parameter inside a block that is
 * still the one you were reading.
 *
 * It was a popover hanging off the balance, and it had to move for two
 * reasons. Its trigger mounted as a flex sibling of the balance, so pressing
 * the balance shoved the balance itself 45px left — you pressed a control and
 * it left. And a panel anchored near the right edge of a phone opens off
 * screen, which is why it already carried a second, fixed layout for narrow
 * viewports. The hub is a region that exists at every width and holds exactly
 * this kind of reading.
 */

const TEXT = {
    ja: {
        empty: '差分はありません。',
        unavailable: '比較できません。REFERENCE に別のバイナリを選んでください。',
        cells: 'cells',
        copyRef: 'COPY REF',
        revert: 'REVERT',
        filter: 'FILTER',
        copyShown: (n: number) => `COPY ${n} SHOWN`,
        hint: '行をクリックするとそのパラメータを開きます。',
    },
    en: {
        empty: 'Nothing differs.',
        unavailable: 'Nothing to compare against — pick another REFERENCE.',
        cells: 'cells',
        copyRef: 'COPY REF',
        revert: 'REVERT',
        filter: 'FILTER',
        copyShown: (n: number) => `COPY ${n} SHOWN`,
        hint: 'Click a row to open that parameter.',
    },
} as const;

function fmtDelta(v: number | null): string {
    if (v === null || !Number.isFinite(v)) return '—';
    if (v === 0) return '0';
    return v >= 100 ? v.toFixed(0) : v >= 1 ? v.toFixed(2) : v.toFixed(4).replace(/0+$/, '');
}

export function CalibrationDiffList({
    entries,
    editedIds,
    selectedId,
    canCopyReference,
    onSelect,
    onCopyRef,
    onRevert,
}: {
    /** Null when one of the two variants has no bytes to read. */
    entries: CalDiffEntry[] | null;
    editedIds: ReadonlySet<string>;
    selectedId: string | null;
    /** Copying only means something when the reference is the other BIN. */
    canCopyReference: boolean;
    onSelect: (paramId: string) => void;
    onCopyRef: (paramId: string) => void;
    onRevert: (paramId: string) => void;
}) {
    const lang = useDialogLang();
    const text = TEXT[lang];
    const [filter, setFilter] = useState('');

    const shown = useMemo(() => {
        if (!entries) return [];
        const q = filter.trim().toLowerCase();
        return q ? entries.filter(e => e.def.name.toLowerCase().includes(q)) : entries;
    }, [entries, filter]);

    const copyable = canCopyReference ? shown.filter(e => !e.def.lock.locked).map(e => e.def.id) : [];

    return (
        <div className="flex-1 min-h-0 flex flex-col">
            {/* No title and no count here. The tab immediately above is called
                DIFF LIST and carries the same number, and a panel that repeats
                its own tab spends a phone's width saying nothing. The title was
                right when this floated free of anything that named it. */}
            <div className="flex-none flex items-center gap-2 px-2 h-[30px] border-b border-slate-800">
                <input
                    value={filter}
                    onChange={e => setFilter(e.target.value)}
                    placeholder={text.filter}
                    className="min-w-0 flex-1 max-w-[200px] bg-slate-800 rounded px-2 h-[20px] text-[10px] font-mono text-slate-200 placeholder:text-slate-600 outline-none focus:ring-1 focus:ring-blue-500"
                />
                {copyable.length > 0 && (
                    <button
                        onClick={() => copyable.forEach(onCopyRef)}
                        className="ml-auto shrink-0 text-[9px] font-bold tracking-widest text-indigo-400 hover:text-indigo-300 transition"
                    >
                        {text.copyShown(copyable.length)}
                    </button>
                )}
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto">
                {entries === null ? (
                    <p className="p-3 text-[11px] text-slate-500">{text.unavailable}</p>
                ) : !shown.length ? (
                    <p className="p-3 text-[11px] text-slate-500">{text.empty}</p>
                ) : (
                    <table className="w-full border-collapse">
                        <tbody>
                            {shown.map(entry => {
                                const { def } = entry;
                                const isSelected = def.id === selectedId;
                                return (
                                    <tr
                                        key={def.id}
                                        className={`h-[26px] border-b border-slate-900 cursor-pointer transition ${isSelected ? 'bg-slate-800' : 'hover:bg-slate-800/50'}`}
                                        onClick={() => onSelect(def.id)}
                                    >
                                        <td className="px-2 w-4 text-[9px] text-blue-500/70">
                                            {def.kind === 'map' ? '▦' : def.kind === 'curve' ? '◠' : '●'}
                                        </td>
                                        <td className={`px-1 font-mono text-[10px] truncate max-w-0 w-[45%] ${isSelected ? 'text-blue-400' : 'text-slate-300'}`}>
                                            {displayName(def.name)}
                                            {editedIds.has(def.id) && (
                                                <span className="ml-1.5 inline-block w-1.5 h-1.5 rounded-full bg-blue-400 align-middle" />
                                            )}
                                        </td>
                                        <td className="px-1 font-mono text-[9px] text-slate-500 text-right whitespace-nowrap">
                                            {entry.cellsChanged} {text.cells}
                                        </td>
                                        <td className="px-1 font-mono text-[9px] text-slate-400 text-right whitespace-nowrap w-[62px]">
                                            Δ {fmtDelta(entry.maxDelta)}
                                        </td>
                                        <td className="px-1 text-right whitespace-nowrap w-[104px]">
                                            {canCopyReference && !def.lock.locked && (
                                                <button
                                                    onClick={e => { e.stopPropagation(); onCopyRef(def.id); }}
                                                    className="text-[8px] font-bold tracking-widest text-indigo-400 hover:text-indigo-300 transition mr-2"
                                                >
                                                    {text.copyRef}
                                                </button>
                                            )}
                                            {editedIds.has(def.id) && (
                                                <button
                                                    onClick={e => { e.stopPropagation(); onRevert(def.id); }}
                                                    className="text-[8px] font-bold tracking-widest text-slate-500 hover:text-red-400 transition"
                                                >
                                                    {text.revert}
                                                </button>
                                            )}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                )}
            </div>

            <p className="flex-none px-2 py-1 text-[9px] text-slate-600 border-t border-slate-800">
                {text.hint}
            </p>
        </div>
    );
}
