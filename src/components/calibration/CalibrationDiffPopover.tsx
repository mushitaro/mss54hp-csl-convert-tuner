'use client';

import React, { useMemo, useState } from 'react';
import type { CalDiffEntry } from '@/hooks/useCalibrationData';
import { displayName } from '@/lib/calibration-graph/names';
import { useDialogLang } from '@/hooks/useDialogLang';

/**
 * WHICH parameters differ between the two BINs the compare bar names —
 * TunerPro's compare window, as a popover on the bar that poses the question.
 *
 * The balance beside it answers "how does THIS one differ" by redrawing the
 * visual; this answers "which ones do", which is the other half and the only
 * way to reach a parameter you did not already know about. Clicking a row
 * selects it, so the picture follows.
 */

const TEXT = {
    ja: {
        title: '差分の一覧',
        listLabel: 'LIST',
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
        title: 'Which parameters differ',
        listLabel: 'LIST',
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

export function CalibrationDiffPopover({
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
    const [open, setOpen] = useState(false);
    const [filter, setFilter] = useState('');

    const shown = useMemo(() => {
        if (!entries) return [];
        const q = filter.trim().toLowerCase();
        return q ? entries.filter(e => e.def.name.toLowerCase().includes(q)) : entries;
    }, [entries, filter]);

    const copyable = canCopyReference ? shown.filter(e => !e.def.lock.locked).map(e => e.def.id) : [];
    const count = entries?.length ?? 0;

    return (
        <div className="relative shrink-0">
            <button
                onClick={() => setOpen(v => !v)}
                title={text.title}
                className={`h-[24px] px-2 rounded text-[9px] font-bold tracking-widest transition ${open ? 'bg-slate-800 text-blue-400' : 'text-slate-400 hover:text-slate-200'}`}
            >
                {text.listLabel}
            </button>

            {open && (
                <>
                    <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
                    {/* Viewport sheet is the base shape — this trigger sits near the
                        right edge on a phone, where an anchored panel would open off
                        screen. The anchored form is the desk override. */}
                    <div className="fixed inset-x-3 bottom-[60px] z-50 flex flex-col rounded border border-slate-700 bg-slate-900 shadow-xl max-h-[min(70dvh,494px)] min-[900px]:absolute min-[900px]:inset-x-auto min-[900px]:bottom-auto min-[900px]:right-0 min-[900px]:top-8 min-[900px]:w-[380px] animate-in fade-in zoom-in-95 duration-200">
                        <div className="flex-none flex items-center gap-2 px-2 h-[30px] border-b border-slate-800">
                            <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400">
                                {text.listLabel}
                            </span>
                            <span className="text-[10px] font-mono text-slate-600">{count}</span>
                            <input
                                value={filter}
                                onChange={e => setFilter(e.target.value)}
                                placeholder={text.filter}
                                className="ml-auto w-[120px] bg-slate-800 rounded px-2 h-[20px] text-[10px] font-mono text-slate-200 placeholder:text-slate-600 outline-none focus:ring-1 focus:ring-blue-500"
                            />
                            {copyable.length > 0 && (
                                <button
                                    onClick={() => copyable.forEach(onCopyRef)}
                                    className="shrink-0 text-[9px] font-bold tracking-widest text-indigo-400 hover:text-indigo-300 transition"
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
                </>
            )}
        </div>
    );
}
