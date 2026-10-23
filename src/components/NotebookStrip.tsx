'use client';

import React from 'react';
import { useDialogLang } from '@/hooks/useDialogLang';
import { currentPlan, lastNote, stepsDone, type NotebookEntry } from '@/lib/notebook/rules';

/**
 * The notebook on DASH: the step being driven, and the last thing the driver said.
 *
 * Two lines in a fixed 40px, whatever they hold — empty, they say so in grey rather than folding
 * away, because a strip that comes and goes moves the hub (tsunagi-m-ux §12). While a log records,
 * the step line is the DONE button for the step it names: one tap for whoever is in the passenger
 * seat, the same mark the assistant puts in when the driver says it. Otherwise it opens NOTEBOOK.
 */

const LINE = 'flex h-5 min-w-0 items-center gap-2';
const TAG = 'w-[4.5rem] shrink-0 text-[8px] font-bold tracking-widest uppercase';

const TEXT = {
    en: { fork: 'two versions — choose on NOTEBOOK', allDone: 'all steps done', mark: 'Mark this step done', open: 'Open NOTEBOOK' },
    ja: { fork: '計画が二通り — NOTEBOOK で選ぶ', allDone: '手順はすべて済み', mark: 'この手順を済みにする', open: 'NOTEBOOK を開く' },
} as const;

interface Props {
    entries: readonly NotebookEntry[];
    run: number | null;
    recording: boolean;
    onStepDone: (n: number, text: string) => void;
    onOpen: () => void;
}

export default function NotebookStrip({ entries, run, recording, onStepDone, onOpen }: Props) {
    const t = TEXT[useDialogLang()];
    const { plan, forked } = currentPlan(entries);
    const steps = plan?.body.kind === 'plan' ? plan.body.steps : [];
    const done = stepsDone(entries, run);
    const next = steps.find(s => !done.has(s.n)) ?? null;
    const note = lastNote(entries);

    const stepTag = !plan ? 'PLAN' : steps.length === 0 ? `PLAN v${plan.body.kind === 'plan' ? plan.body.v : ''}`
        : next ? `STEP ${next.n}/${steps.length}` : `STEP ${steps.length}/${steps.length}`;
    const stepText = !plan ? '—'
        : forked ? t.fork
            : steps.length === 0 ? (plan.body.kind === 'plan' ? plan.body.purpose : '')
                : next ? next.do : t.allDone;
    const canMark = recording && !!next && !forked;

    return (
        <div className="h-[40px] flex-none px-2 flex flex-col justify-center">
            <button
                type="button"
                onClick={() => (canMark ? onStepDone(next!.n, next!.do) : onOpen())}
                className={`${LINE} w-full text-left ${canMark ? 'text-blue-400' : ''}`}
                title={canMark ? t.mark : t.open}
            >
                <span className={`${TAG} ${plan ? 'text-slate-400' : 'text-slate-700'}`}>{stepTag}</span>
                <span className={`min-w-0 flex-1 truncate text-[11px] font-mono ${plan ? 'text-slate-200' : 'text-slate-700'}`}>{stepText}</span>
                {steps.length > 0 && (
                    <span className="flex shrink-0 gap-1" aria-hidden>
                        {steps.map(s => (
                            <i key={s.n} className={`block h-1 w-3 ${done.has(s.n) ? 'bg-emerald-400' : s === next ? 'bg-blue-500' : 'bg-slate-700'}`} />
                        ))}
                    </span>
                )}
                {canMark && <span className="shrink-0 text-[10px] font-bold tracking-widest uppercase">DONE</span>}
            </button>
            <button type="button" onClick={onOpen} className={`${LINE} w-full text-left`} title={t.open}>
                <span className={`${TAG} ${note ? 'text-slate-400' : 'text-slate-700'}`}>
                    {note ? (note.by === 'driver' ? 'DRIVER' : 'NOTE') : 'DRIVER'}
                    {note?.body.kind === 'note' && note.body.t !== null ? ` ${note.body.t.toFixed(0)}s` : ''}
                </span>
                <span className={`min-w-0 flex-1 truncate text-[11px] ${note ? 'text-slate-200' : 'text-slate-700'}`}>
                    {note?.body.kind === 'note' ? `「${note.body.text}」` : '—'}
                </span>
            </button>
        </div>
    );
}
