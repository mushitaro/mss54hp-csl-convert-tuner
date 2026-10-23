'use client';

import React, { useMemo, useState } from 'react';
import { GitFork, Users } from 'lucide-react';
import { useDialogLang } from '@/hooks/useDialogLang';
import {
    currentPlan, openAsks, statusOf,
    type Evidence, type NotebookAuthor, type NotebookEntry,
} from '@/lib/notebook/rules';
import { stepCounts } from '@/lib/notebook/steps';
import { StepBoard } from './CoworkDisplay';

/**
 * CO-WORK — the session's record with the assistant, on screen, to read.
 *
 * Nothing here is written from the screen (operator, 2026-10-23). The assistant writes it — the
 * driver's words, steps marked done in any order, findings, questions and answers — and the desk
 * adds to it between drives; the owner answers a question, chooses between two versions of a plan or
 * asks for a change by saying so to the assistant. What the screen keeps is reading: the questions
 * waiting, the plan and its steps with how often each is done, and what happened in the order it
 * was written, each moment a way into the log.
 */

const LABEL = 'text-[10px] font-bold tracking-widest uppercase';

const TEXT = {
    en: {
        asks: (n: number) => `ASK · ${n} waiting for the driver`,
        answerByVoice: 'Answer by telling the assistant.',
        plan: 'PLAN',
        noPlan: 'No plan yet. Ask the assistant, or the desk, to write one.',
        fork: 'Two versions of this plan were written. Tell the assistant which to drive by; the other is set aside, not deleted.',
        purpose: 'Purpose', hypothesis: 'Hypothesis', criteria: 'How it is judged',
        steps: 'STEPS',
        runs: 'RUNS', all: 'ALL',
        nothing: 'Nothing written yet.',
        jump: 'Show on the log',
    },
    ja: {
        asks: (n: number) => `ASK · 運転者の答え待ち ${n} 件`,
        answerByVoice: 'アシスタントに声で答えてください。',
        plan: 'PLAN',
        noPlan: 'まだ計画がありません。アシスタントか机に頼んでください。',
        fork: 'この計画は二通りに書き直されています。どちらで走るかをアシスタントに伝えてください。選ばなかった方は取り下げとして残り、消えません。',
        purpose: '目的', hypothesis: '仮説', criteria: '判定',
        steps: '手順',
        runs: 'RUNS', all: 'ALL',
        nothing: 'まだ何も書かれていません。',
        jump: 'ログで見る',
    },
} as const;

const KIND: Record<string, { label: string; cls: string }> = {
    step: { label: 'STEP', cls: 'text-slate-500' },
    driver: { label: 'DRIVER', cls: 'text-slate-200' },
    note: { label: 'NOTE', cls: 'text-slate-300' },
    fact: { label: 'FACT', cls: 'text-emerald-400' },
    read: { label: 'READ', cls: 'text-indigo-400' },
    ask: { label: 'ASK', cls: 'text-amber-400' },
    answer: { label: 'ANSWER', cls: 'text-slate-300' },
    plan: { label: 'PLAN', cls: 'text-blue-400' },
    status: { label: 'STATUS', cls: 'text-slate-500' },
};

const WHO: Record<NotebookAuthor, string> = { driver: 'DRIVER', chat: 'CHAT', desk: 'DESK', owner: 'OWNER' };

const clock = (at: number) => {
    const d = new Date(at);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const evidenceLine = (e: Evidence) =>
    `RUN ${e.run} · ${e.from.toFixed(1)}–${e.to.toFixed(1)} s · ${e.channels.join(', ')}${e.decode ? ` · ${e.decode}` : ''}`;

/** Where an entry sits in a run, when it sits in one: [run, log seconds]. */
function placeOf(e: NotebookEntry): [number, number] | null {
    const b = e.body;
    if (b.kind === 'step') return [b.run, b.t];
    if (b.kind === 'note' && b.run !== null && b.t !== null) return [b.run, b.t];
    if (b.kind === 'fact') return [b.evidence.run, b.evidence.from];
    if (b.kind === 'read' && b.evidence) return [b.evidence.run, b.evidence.from];
    if (b.kind === 'ask' && b.about) return [b.about.run, b.about.from];
    return null;
}

function textOf(e: NotebookEntry, entries: readonly NotebookEntry[]): string {
    const b = e.body;
    switch (b.kind) {
        case 'plan': return `v${b.v} · ${b.purpose}`;
        case 'step': {
            const plan = currentPlan(entries).plan;
            const step = plan?.body.kind === 'plan' ? plan.body.steps.find(s => s.n === b.n) : undefined;
            return `${b.n}${step ? ` · ${step.do}` : ''}`;
        }
        case 'note': return `「${b.text}」`;
        case 'answer': return b.text;
        case 'status': return b.to.toUpperCase();
        default: return b.text;
    }
}

interface Props {
    entries: readonly NotebookEntry[];
    /** The run on screen — the one the log chart is drawing — or null when there is none. */
    run: number | null;
    /** How many runs the session holds, the one on screen included. */
    runs: number;
    recording: boolean;
    /** Shows a moment of a run on the log chart: the run on screen, or an earlier one to read. */
    onJump: (run: number, t: number) => void;
}

export default function CoworkPanel({ entries, run, runs, recording, onJump }: Props) {
    const lang = useDialogLang();
    const t = TEXT[lang];
    const { plan, heads, forked } = useMemo(() => currentPlan(entries), [entries]);
    const asks = useMemo(() => openAsks(entries).filter(a => a.body.kind === 'ask' && (a.body.to === 'driver' || a.body.to === 'owner')), [entries]);
    const counts = useMemo(() => stepCounts(entries, run), [entries, run]);
    /** What an answer answers and what a reading disputes, in a few words. */
    const byId = useMemo(() => new Map(entries.map(e => [e.id, e])), [entries]);
    const gist = (id: string) => {
        const target = byId.get(id);
        if (!target) return '';
        const words = textOf(target, entries);
        return words.length > 36 ? `${words.slice(0, 36)}…` : words;
    };
    const [filter, setFilter] = useState<number | null>(null);
    const body = plan?.body.kind === 'plan' ? plan.body : null;

    const timeline = entries.filter(e => {
        if (e.body.kind === 'status') return false;
        if (filter === null) return true;
        return placeOf(e)?.[0] === filter;
    });

    return (
        <div className="space-y-5 text-slate-300">
            <h3 className={`${LABEL} flex items-center gap-1.5 text-slate-300`}>
                <Users className="w-3 h-3" />CO-WORK
            </h3>

            {asks.length > 0 && (
                <section className="space-y-3 rounded bg-slate-900 p-3">
                    <div className={`${LABEL} flex items-center gap-1.5 text-amber-300`}>
                        <span className="h-1.5 w-1.5 rounded-full bg-amber-300 animate-pulse motion-reduce:animate-none" />
                        {t.asks(asks.length)}
                    </div>
                    {asks.map(a => a.body.kind === 'ask' && (
                        <div key={a.id} className="space-y-1">
                            <div className="text-[10px] font-mono text-slate-500">
                                {WHO[a.by]} → {WHO[a.body.to]}{a.body.about ? ` · ${evidenceLine(a.body.about)}` : ` · ${clock(a.at)}`}
                            </div>
                            <p className="text-[12px] leading-relaxed text-slate-100">{a.body.text}</p>
                        </div>
                    ))}
                    <p className="text-[10px] text-slate-500">{t.answerByVoice}</p>
                </section>
            )}

            <section className="space-y-3 rounded bg-slate-900 p-3">
                <div className={`${LABEL} text-slate-500`}>
                    {t.plan}{body ? ` v${body.v}` : ''}
                    {plan && <span className="ml-2 font-mono font-normal normal-case tracking-normal text-slate-600">{WHO[plan.by]} · {clock(plan.at)}</span>}
                </div>
                {forked && (
                    <div className="space-y-1 rounded bg-slate-800/60 p-2">
                        <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-amber-300">
                            <GitFork className="mt-0.5 w-3 h-3 shrink-0" />{t.fork}
                        </p>
                        {heads.map(h => h.body.kind === 'plan' && (
                            <p key={h.id} className="truncate text-[11px] text-slate-300">v{h.body.v} · {WHO[h.by]} · {h.body.purpose}</p>
                        ))}
                    </div>
                )}
                {body ? (
                    <div className="space-y-3">
                        <dl className="grid grid-cols-[3.5rem_minmax(0,1fr)] gap-x-2 gap-y-1 text-[11px] leading-relaxed">
                            <dt className="text-[8px] font-bold tracking-widest uppercase pt-1 text-slate-500">{t.purpose}</dt><dd className="text-slate-200">{body.purpose}</dd>
                            {body.hypothesis && <><dt className="text-[8px] font-bold tracking-widest uppercase pt-1 text-slate-500">{t.hypothesis}</dt><dd className="text-slate-300">{body.hypothesis}</dd></>}
                            {body.criteria && <><dt className="text-[8px] font-bold tracking-widest uppercase pt-1 text-slate-500">{t.criteria}</dt><dd className="text-slate-300">{body.criteria}</dd></>}
                        </dl>
                        {body.steps.length > 0 && (
                            <div className="space-y-1.5">
                                <div className={`${LABEL} text-slate-500`}>{t.steps}{run !== null ? ` · RUN ${run}` : ''}</div>
                                <StepBoard steps={body.steps} counts={counts} />
                            </div>
                        )}
                        {body.watch?.length ? (
                            <p className="text-[10px] font-mono text-slate-500">WATCH {body.watch.map(w => w.address + (w.label ? ` ${w.label}` : '')).join(' · ')}</p>
                        ) : null}
                    </div>
                ) : (
                    <p className="text-[11px] text-slate-500">{t.noPlan}</p>
                )}
            </section>

            <section className="space-y-2 rounded bg-slate-900 p-3">
                <div className="flex flex-wrap items-center gap-2">
                    <span className={`${LABEL} mr-1 text-slate-500`}>{t.runs}</span>
                    <Chip on={filter === null} onClick={() => setFilter(null)}>{t.all}</Chip>
                    {Array.from({ length: runs }, (_, i) => (
                        <Chip key={i} on={filter === i + 1} onClick={() => setFilter(i + 1)}>RUN {i + 1}</Chip>
                    ))}
                </div>
                {timeline.length === 0
                    ? <p className="text-[11px] font-mono text-slate-600">{t.nothing}</p>
                    : (
                        <ol className="divide-y divide-slate-800/60">
                            {timeline.map(e => {
                                const place = placeOf(e);
                                const kind = e.body.kind === 'note' && e.by === 'driver' ? KIND.driver : KIND[e.body.kind];
                                const status = statusOf(entries, e.id);
                                // Any run the session holds; an earlier one opens on LOG and GRAPH to
                                // read. While a log records only the live one — the chart is its then.
                                const jumpable = place !== null && (place[0] === run || (!recording && place[0] >= 1 && place[0] <= runs));
                                const evidence = e.body.kind === 'fact' ? e.body.evidence
                                    : e.body.kind === 'read' ? e.body.evidence : e.body.kind === 'ask' ? e.body.about : undefined;
                                const Row = jumpable ? 'button' : 'div';
                                return (
                                    <li key={e.id}>
                                        <Row
                                            {...(jumpable ? { type: 'button' as const, onClick: () => onJump(place![0], place![1]), title: t.jump } : {})}
                                            className={`grid w-full grid-cols-[4.5rem_4.5rem_minmax(0,1fr)] gap-2 py-2 text-left ${jumpable ? 'transition hover:bg-slate-800/50' : ''}`}
                                        >
                                            <span className="text-right text-[10px] font-mono text-slate-500">
                                                {place ? `R${place[0]} ${place[1].toFixed(1)}` : clock(e.at)}
                                            </span>
                                            <span className={`text-[8px] font-bold tracking-widest uppercase pt-0.5 ${status === 'disputed' ? 'text-red-400' : kind.cls}`}>
                                                {status === 'disputed' ? 'DISPUTED' : status === 'withdrawn' ? `${kind.label} ×` : kind.label}
                                            </span>
                                            <span className={`min-w-0 text-[11px] leading-snug ${status === 'withdrawn' ? 'text-slate-600 line-through' : e.body.kind === 'note' ? 'text-slate-200' : 'text-slate-300'}`}>
                                                {textOf(e, entries)}
                                                <span className="block text-[10px] font-mono text-slate-500 no-underline">
                                                    {WHO[e.by]}
                                                    {e.body.kind === 'read' ? ` · ${e.body.sure}` : ''}
                                                    {e.body.kind === 'read' && e.body.re ? ` · re: ${gist(e.body.re)}` : ''}
                                                    {e.body.kind === 'answer' ? ` · → ${gist(e.body.re)}` : ''}
                                                    {evidence ? ` · ${evidenceLine(evidence)}` : ''}
                                                </span>
                                            </span>
                                        </Row>
                                    </li>
                                );
                            })}
                        </ol>
                    )}
            </section>
        </div>
    );
}

const Chip: React.FC<{ on: boolean; onClick: () => void; children: React.ReactNode }> = ({ on, onClick, children }) => (
    <button type="button" onClick={onClick}
        className={`rounded px-2 py-1 text-[10px] font-mono transition ${on ? 'bg-blue-900 text-blue-200' : 'bg-slate-800 text-slate-400 hover:text-slate-200'}`}>
        {children}
    </button>
);
