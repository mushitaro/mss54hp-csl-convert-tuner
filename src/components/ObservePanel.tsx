'use client';

import React, { useState } from 'react';
import { Check, Eye, Flag, Plus, X } from 'lucide-react';
import type { LogDataPoint } from '@/lib/types';
import { useDialogLang } from '@/hooks/useDialogLang';
import { expectedHz, LOG_PROFILES, type LogExchange } from '@/lib/log-engine/logProfile';
import {
    OBSERVE_LANES, OBSERVE_MAX_READS, activeSteps, marksOf, parseAddress, planProblems, readings,
    stepMark, summariseWatch, watchExchanges, watchKey, type ObservePlan, type WatchRead,
} from '@/lib/log-engine/observe';

/**
 * OBSERVE — the plan for a run that watches addresses nobody has named, and what the run saw.
 *
 * Two states, both derived: before a run the plan is edited here; during and after one, the steps
 * are ticked off by MARKs in the log itself (a step is done when the log carries its mark, not when
 * a checkbox here was pressed), and the watched bytes are summarised straight off the samples.
 *
 * Everything shown about a byte is a READING of it — u8, u16 — never a value. The run exists to
 * find out what the byte means, so the panel does not get to decide first.
 */

const LABEL = 'text-[10px] font-bold tracking-widest uppercase';
const INPUT = 'h-7 rounded bg-slate-800 px-2 text-[11px] text-slate-200 placeholder:text-slate-600 focus:outline-none focus:ring-1 focus:ring-blue-500';

const TEXT = {
    en: {
        intro: 'Stop tuning and watch what nobody has named yet. The run records these addresses as raw bytes beside rpm, load and throttle; naming them comes afterwards, from what moved with what.',
        practice: 'PRACTICE: these bytes are made up. Each address follows one of four invented shapes (rpm, load, a throttle-shut flag, a counter) — good for rehearsing the run, meaningless about any real address.',
        title: 'What is this run for?',
        address: 'FFD1A2',
        label: 'its name for now (DAT_…)',
        notAddress: 'Not an address: six hex digits, 0x…, or DAT_….',
        steps: 'One step per line — what to ask the owner to do, parked steps first.',
        start: 'START TUNE starts the run. The plan is written into the log as its first mark.',
        recordingHint: 'Press DONE as each step finishes; it is marked in the log at that moment.',
        noReads: 'No watched bytes in this log yet.',
    },
    ja: {
        intro: 'チューニングを止めて、まだ名前のないものを観察します。指定したアドレスを、回転・負荷・開度と並べて生のバイトのまま記録します。名前は、何と一緒に動いたかを見て後で付けます。',
        practice: 'PRACTICE：このバイトは作り物です。アドレスごとに四つの架空の動き（回転、負荷、スロットル全閉のフラグ、カウンタ）のどれかをします。手順の練習用で、実際のアドレスについては何も分かりません。',
        title: 'この観察は何のため？',
        address: 'FFD1A2',
        label: '仮の名前（DAT_…）',
        notAddress: 'アドレスではありません。16進6桁、0x…、DAT_… のどれかで。',
        steps: '一行に一手順。オーナーにお願いすることを、停車中にできるものから。',
        start: 'START TUNE で始まります。計画は最初のマークとしてログに残ります。',
        recordingHint: '手順が終わるたびに DONE を押すと、その時点がログに印されます。',
        noReads: 'このログにはまだ観察したバイトがありません。',
    },
} as const;

const byteOptions = [1, 2, 4] as const;

/** One address row. The text is the row's own until it parses — typing "FFD" must not reach the plan. */
const AddressInput: React.FC<{ read: WatchRead; placeholder: string; onCommit: (address: number) => void; invalidText: string; disabled: boolean }>
    = ({ read, placeholder, onCommit, invalidText, disabled }) => {
        const [text, setText] = useState(Number.isInteger(read.address) ? watchKey(read.address) : '');
        const parsed = text.trim() ? parseAddress(text) : null;
        const invalid = text.trim() !== '' && parsed === null;
        return (
            <div className="flex flex-col gap-1">
                <input
                    className={`${INPUT} w-24 font-mono uppercase`}
                    value={text}
                    placeholder={placeholder}
                    spellCheck={false}
                    disabled={disabled}
                    autoCapitalize="characters"
                    onChange={e => setText(e.target.value)}
                    onBlur={() => { if (parsed !== null && parsed !== read.address) onCommit(parsed); }}
                    onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                    aria-invalid={invalid}
                    title={invalid ? invalidText : undefined}
                />
                {invalid && <span className="text-[10px] text-red-400">{invalidText}</span>}
            </div>
        );
    };

interface Props {
    plan: ObservePlan;
    onPlanChange: (next: ObservePlan) => void;
    /** A log is recording right now. The plan is frozen while it does: it is what the log is of. */
    recording: boolean;
    /** The log as the page holds it — live during a run, the loaded log after one. */
    points: readonly LogDataPoint[];
    onMark: (label: string) => void;
    practice: boolean;
}

export default function ObservePanel({ plan, onPlanChange, recording, points, onMark, practice }: Props) {
    const lang = useDialogLang();
    const t = TEXT[lang];
    const problems = planProblems(plan, lang);
    const steps = activeSteps(plan);

    // The rate the plan would run at, from the rows that are already valid on their own.
    const validReads = plan.reads.filter(r => planProblems({ ...plan, title: 'x', reads: [r] }).length === 0);
    let exchanges: LogExchange[] = LOG_PROFILES.OBSERVE.exchanges;
    try { exchanges = [...exchanges, ...watchExchanges({ ...plan, title: 'x', reads: validReads })]; } catch { /* none valid yet */ }
    const hz = validReads.length ? expectedHz(exchanges) : expectedHz(LOG_PROFILES.OBSERVE.exchanges);

    const setRead = (i: number, patch: Partial<WatchRead>) =>
        onPlanChange({ ...plan, reads: plan.reads.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
    const addRead = () => onPlanChange({ ...plan, reads: [...plan.reads, { address: NaN, count: 2, every: 2, label: '' }] });
    const removeRead = (i: number) => onPlanChange({ ...plan, reads: plan.reads.filter((_, j) => j !== i) });

    // What the log says: which steps are marked done, and what each watched address did.
    const marks = new Map<string, number>();
    for (const p of points) for (const m of marksOf(p.mark)) if (!marks.has(m)) marks.set(m, p.time);
    const keys = [...new Set([
        ...plan.reads.filter(r => Number.isInteger(r.address)).map(r => watchKey(r.address)),
        ...points.flatMap(p => (p.watch ? Object.keys(p.watch) : [])),
    ])];
    const summaries = keys.map(k => summariseWatch(points, k)).filter(s => s.reads > 0);
    const labelOf = (key: string) => plan.reads.find(r => Number.isInteger(r.address) && watchKey(r.address) === key)?.label ?? '';

    return (
        <div className="space-y-5 text-slate-300">
            <div className="flex items-center justify-between">
                <h3 className={`${LABEL} flex items-center gap-1.5 text-slate-300`}>
                    <Eye className="w-3 h-3" />OBSERVE
                </h3>
                <span className="text-[10px] font-mono text-slate-500" title="expected, from the exchange list">≈ {hz.toFixed(1)} Hz</span>
            </div>
            <p className="text-[11px] leading-relaxed text-slate-400">{t.intro}</p>
            {practice && <p className="text-[11px] leading-relaxed text-amber-400">{t.practice}</p>}

            <section className="space-y-3 rounded bg-slate-900 p-3">
                <div className={`${LABEL} text-slate-500`}>PLAN</div>
                <input
                    className={`${INPUT} w-full`}
                    value={plan.title}
                    placeholder={t.title}
                    disabled={recording}
                    onChange={e => onPlanChange({ ...plan, title: e.target.value })}
                />

                <div className="space-y-2">
                    <div className={`${LABEL} text-slate-500`}>WATCH</div>
                    {plan.reads.map((r, i) => (
                        <div key={i} className="flex flex-wrap items-start gap-2">
                            <AddressInput
                                key={`${i}:${Number.isInteger(r.address) ? r.address : 'new'}`}
                                read={r}
                                placeholder={t.address}
                                invalidText={t.notAddress}
                                disabled={recording}
                                onCommit={address => setRead(i, { address })}
                            />
                            <label className="flex h-7 items-center gap-1 rounded bg-slate-800 px-2">
                                <span className="text-[10px] text-slate-500">BYTES</span>
                                <select
                                    className="bg-transparent text-[11px] font-mono text-slate-200 focus:outline-none"
                                    value={r.count}
                                    disabled={recording}
                                    onChange={e => setRead(i, { count: Number(e.target.value) })}
                                >
                                    {byteOptions.map(n => <option key={n} value={n} className="bg-slate-900">{n}</option>)}
                                </select>
                            </label>
                            <label className="flex h-7 items-center gap-1 rounded bg-slate-800 px-2">
                                <span className="text-[10px] text-slate-500">EVERY</span>
                                <select
                                    className="bg-transparent text-[11px] font-mono text-slate-200 focus:outline-none"
                                    value={r.every}
                                    disabled={recording}
                                    onChange={e => setRead(i, { every: Number(e.target.value) as WatchRead['every'] })}
                                >
                                    {OBSERVE_LANES.map(n => <option key={n} value={n} className="bg-slate-900">{n}</option>)}
                                </select>
                            </label>
                            <input
                                className={`${INPUT} min-w-[8rem] flex-1 font-mono`}
                                value={r.label}
                                placeholder={t.label}
                                disabled={recording}
                                onChange={e => setRead(i, { label: e.target.value })}
                            />
                            {!recording && (
                                <button
                                    type="button"
                                    className="flex h-7 items-center text-slate-600 transition hover:text-red-400"
                                    onClick={() => removeRead(i)}
                                    aria-label={`remove ${Number.isInteger(r.address) ? watchKey(r.address) : 'row'}`}
                                >
                                    <X className="w-3 h-3" />
                                </button>
                            )}
                        </div>
                    ))}
                    {!recording && plan.reads.length < OBSERVE_MAX_READS && (
                        <button type="button" className={`${LABEL} flex items-center gap-1.5 text-blue-400 transition hover:text-blue-300`} onClick={addRead}>
                            <Plus className="w-3 h-3" />ADDRESS
                        </button>
                    )}
                </div>

                <div className="space-y-2">
                    <div className={`${LABEL} text-slate-500`}>STEPS</div>
                    <textarea
                        className={`${INPUT} h-auto min-h-[6rem] w-full py-1.5 leading-relaxed`}
                        value={plan.steps.join('\n')}
                        placeholder={t.steps}
                        disabled={recording}
                        onChange={e => onPlanChange({ ...plan, steps: e.target.value.split('\n') })}
                    />
                </div>

                {problems.length > 0 && !recording && (
                    <ul className="space-y-1">
                        {problems.map(p => <li key={p} className="text-[11px] text-amber-400">{p}</li>)}
                    </ul>
                )}
                {problems.length === 0 && !recording && <p className="text-[11px] text-slate-500">{t.start}</p>}
            </section>

            {(recording || steps.some((_, i) => marks.has(stepMark(plan, i)))) && steps.length > 0 && (
                <section className="space-y-2 rounded bg-slate-900 p-3">
                    <div className="flex items-center justify-between">
                        <div className={`${LABEL} text-slate-500`}>RUN</div>
                        {recording && (
                            <button type="button" className={`${LABEL} flex items-center gap-1.5 text-blue-400 transition hover:text-blue-300`}
                                onClick={() => onMark('mark')}>
                                <Flag className="w-3 h-3" />MARK
                            </button>
                        )}
                    </div>
                    {recording && <p className="text-[11px] text-slate-500">{t.recordingHint}</p>}
                    <ol className="space-y-1.5">
                        {steps.map((s, i) => {
                            const at = marks.get(stepMark(plan, i));
                            return (
                                <li key={i} className="flex min-h-7 items-center gap-3">
                                    <span className="w-4 shrink-0 text-right text-[11px] font-mono text-slate-500">{i + 1}</span>
                                    <span className={`flex-1 text-[11px] ${at !== undefined ? 'text-slate-500' : 'text-slate-200'}`}>{s}</span>
                                    {at !== undefined
                                        ? <span className="flex items-center gap-1 text-[10px] font-mono text-emerald-400"><Check className="w-3 h-3" />{at.toFixed(1)} s</span>
                                        : recording && (
                                            <button type="button" className={`${LABEL} text-blue-400 transition hover:text-blue-300`}
                                                onClick={() => onMark(stepMark(plan, i))}>
                                                DONE
                                            </button>
                                        )}
                                </li>
                            );
                        })}
                    </ol>
                </section>
            )}

            <section className="space-y-2 rounded bg-slate-900 p-3">
                <div className={`${LABEL} text-slate-500`}>BYTES</div>
                {summaries.length === 0
                    ? <p className="text-[11px] font-mono text-slate-600">{t.noReads}</p>
                    : (
                        <div className="overflow-x-auto">
                            <table className="w-full text-left">
                                <thead>
                                    <tr className={`${LABEL} text-slate-500`}>
                                        <th className="py-1 pr-3 font-bold">ADDR</th>
                                        <th className="py-1 pr-3 font-bold">NOW</th>
                                        <th className="py-1 pr-3 font-bold" title="the first byte, unsigned">U8</th>
                                        <th className="py-1 pr-3 font-bold" title="the first two bytes, big-endian, unsigned">U16</th>
                                        <th className="py-1 pr-3 font-bold" title="smallest – largest, as u16 when two or more bytes">RANGE</th>
                                        <th className="py-1 pr-3 font-bold" title="times the bytes differed from the read before">CHG</th>
                                        <th className="py-1 font-bold">READS</th>
                                    </tr>
                                </thead>
                                <tbody className="text-[11px] font-mono">
                                    {summaries.map(s => {
                                        const r = s.last ? readings(s.last) : null;
                                        return (
                                            <tr key={s.key}>
                                                <td className="py-1 pr-3 text-slate-300">
                                                    {s.key}
                                                    {labelOf(s.key) && <span className="ml-2 text-[10px] text-slate-500">{labelOf(s.key)}</span>}
                                                </td>
                                                <td className="py-1 pr-3 text-blue-400">{s.last ?? '—'}</td>
                                                <td className="py-1 pr-3 text-slate-300">{r?.u8 ?? '—'}</td>
                                                <td className="py-1 pr-3 text-slate-300">{r?.u16 ?? '—'}</td>
                                                <td className="py-1 pr-3 text-slate-400">{s.min !== null ? `${s.min}–${s.max}` : '—'}</td>
                                                <td className="py-1 pr-3 text-slate-400">{s.changes}</td>
                                                <td className="py-1 text-slate-500">{s.reads}</td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    )}
            </section>
        </div>
    );
}
