'use client';

import React, { useMemo, useState } from 'react';
import { BookOpen, Check, CornerDownRight, GitFork, MessageSquare, Pencil, X } from 'lucide-react';
import { useDialogLang } from '@/hooks/useDialogLang';
import {
    currentPlan, entryProblem, nextPlanVersion, openAsks, statusOf, stepsDone,
    type Evidence, type NotebookAuthor, type NotebookBody, type NotebookEntry,
} from '@/lib/notebook/rules';

/**
 * NOTEBOOK — the session's experiment notebook on screen.
 *
 * Read top to bottom the way a drive is: the questions waiting for the driver (answer them before
 * the next run), the plan to drive by, then what happened, in the order it was written. The desk
 * and the assistant in the car write into the same book; this is where the owner reads it, answers,
 * and adds a note of their own.
 *
 * Written to only while nothing is recording: during a run the book is read, and what the driver
 * says goes in by voice. Entries are added, never edited — a plan is rewritten as a new version,
 * and two rewrites of one plan are put to the owner to choose between rather than chosen for them.
 */

const LABEL = 'text-[10px] font-bold tracking-widest uppercase';
const INPUT = 'rounded bg-slate-800 px-2 text-[11px] text-slate-200 placeholder:text-slate-600 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50';

const TEXT = {
    en: {
        asks: (n: number) => `ASK · ${n} waiting for the driver`,
        answer: 'ANSWER',
        answerHint: 'Your answer, in your own words',
        save: 'SAVE',
        cancel: 'CANCEL',
        plan: 'PLAN',
        noPlan: 'No plan yet. The desk or the assistant can write one, or write it here.',
        writePlan: 'WRITE PLAN',
        revise: 'REVISE',
        purpose: 'Purpose', hypothesis: 'Hypothesis', criteria: 'How it is judged', steps: 'Steps, one per line',
        fork: 'Two versions of this plan were written. Choose the one to drive by; the other is set aside, not deleted.',
        driveThis: 'DRIVE THIS ONE',
        runs: 'RUNS', all: 'ALL',
        nothing: 'Nothing written in this notebook yet.',
        addNote: 'NOTE',
        noteHint: 'What happened, in your words — no names or places',
        recording: 'Recording: the notebook is read-only until STOP. Say it to the assistant instead.',
        jump: 'Show on the log',
    },
    ja: {
        asks: (n: number) => `ASK · 運転者の答え待ち ${n} 件`,
        answer: '答える',
        answerHint: 'ご自身の言葉で',
        save: '残す',
        cancel: 'やめる',
        plan: 'PLAN',
        noPlan: 'まだ計画がありません。机かアシスタントが書くか、ここで書いてください。',
        writePlan: '計画を書く',
        revise: '書き直す',
        purpose: '目的', hypothesis: '仮説', criteria: '判定', steps: '手順（一行に一つ）',
        fork: 'この計画は二通りに書き直されています。走る方を選んでください。選ばなかった方は取り下げとして残り、消えません。',
        driveThis: 'この計画で走る',
        runs: 'RUNS', all: 'ALL',
        nothing: 'このノートにはまだ何も書かれていません。',
        addNote: 'メモ',
        noteHint: '起きたことを、ご自身の言葉で（人の名前や場所は書かない）',
        recording: '記録中は読むだけです。STOP まで、言いたいことはアシスタントに話してください。',
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
    onAdd: (items: { by: NotebookAuthor; body: NotebookBody }[]) => Promise<unknown>;
    /** Shows a moment of a run on the log chart: the run on screen, or an earlier one to read. */
    onJump: (run: number, t: number) => void;
}

export default function NotebookPanel({ entries, run, runs, recording, onAdd, onJump }: Props) {
    const lang = useDialogLang();
    const t = TEXT[lang];
    const { plan, heads, forked } = useMemo(() => currentPlan(entries), [entries]);
    const asks = useMemo(() => openAsks(entries).filter(a => a.body.kind === 'ask' && (a.body.to === 'driver' || a.body.to === 'owner')), [entries]);
    const done = useMemo(() => stepsDone(entries, run), [entries, run]);
    /** What an answer answers and what a reading disputes, in a few words. */
    const byId = useMemo(() => new Map(entries.map(e => [e.id, e])), [entries]);
    const gist = (id: string) => {
        const target = byId.get(id);
        if (!target) return '';
        const words = textOf(target, entries);
        return words.length > 36 ? `${words.slice(0, 36)}…` : words;
    };
    const [filter, setFilter] = useState<number | null>(null);
    const [error, setError] = useState<string | null>(null);

    const save = async (items: { by: NotebookAuthor; body: NotebookBody }[]) => {
        setError(null);
        for (const x of items) {
            const p = entryProblem({ id: 'check-0000', sessionId: 'check-0000', at: 1, by: x.by, body: x.body });
            if (p) { setError(p); return false; }
        }
        try { await onAdd(items); return true; } catch (e) { setError(e instanceof Error ? e.message : String(e)); return false; }
    };

    const timeline = entries.filter(e => {
        if (e.body.kind === 'status') return false;
        if (filter === null) return true;
        return placeOf(e)?.[0] === filter;
    });

    return (
        <div className="space-y-5 text-slate-300">
            <div className="flex items-center justify-between">
                <h3 className={`${LABEL} flex items-center gap-1.5 text-slate-300`}>
                    <BookOpen className="w-3 h-3" />NOTEBOOK
                </h3>
            </div>
            {recording && <p className="text-[11px] leading-relaxed text-slate-500">{t.recording}</p>}
            {error && <p className="text-[11px] leading-relaxed text-red-400">{error}</p>}

            {asks.length > 0 && (
                <section className="space-y-3 rounded bg-slate-900 p-3">
                    <div className={`${LABEL} flex items-center gap-1.5 text-amber-300`}>
                        <span className="h-1.5 w-1.5 rounded-full bg-amber-300 animate-pulse motion-reduce:animate-none" />
                        {t.asks(asks.length)}
                    </div>
                    {asks.map(a => <AskRow key={a.id} ask={a} t={t} disabled={recording} onAnswer={text =>
                        save([{ by: 'owner', body: { kind: 'answer', re: a.id, text } }])} />)}
                </section>
            )}

            <PlanSection
                plan={plan} heads={heads} forked={forked} done={done} entries={entries} t={t} disabled={recording}
                onWrite={(body) => save([{ by: 'owner', body }])}
                onChoose={(keep) => save(heads.filter(h => h.id !== keep).map(h => ({ by: 'owner' as const, body: { kind: 'status' as const, re: h.id, to: 'withdrawn' as const } })))}
            />

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

            {!recording && <NoteInput t={t} onSave={text => save([{ by: 'owner', body: { kind: 'note', run: null, t: null, text, via: 'screen' } }])} />}
        </div>
    );
}

const Chip: React.FC<{ on: boolean; onClick: () => void; children: React.ReactNode }> = ({ on, onClick, children }) => (
    <button type="button" onClick={onClick}
        className={`rounded px-2 py-1 text-[10px] font-mono transition ${on ? 'bg-blue-900 text-blue-200' : 'bg-slate-800 text-slate-400 hover:text-slate-200'}`}>
        {children}
    </button>
);

type T = (typeof TEXT)[keyof typeof TEXT];

function AskRow({ ask, t, disabled, onAnswer }: { ask: NotebookEntry; t: T; disabled: boolean; onAnswer: (text: string) => Promise<boolean> }) {
    const [open, setOpen] = useState(false);
    const [text, setText] = useState('');
    if (ask.body.kind !== 'ask') return null;
    return (
        <div className="space-y-1.5">
            <div className="text-[10px] font-mono text-slate-500">
                {WHO[ask.by]} → {WHO[ask.body.to]}{ask.body.about ? ` · ${evidenceLine(ask.body.about)}` : ` · ${clock(ask.at)}`}
            </div>
            <p className="text-[12px] leading-relaxed text-slate-100">{ask.body.text}</p>
            {open ? (
                <div className="space-y-2">
                    <textarea className={`${INPUT} min-h-[4rem] w-full py-1.5 leading-relaxed`} value={text} placeholder={t.answerHint}
                        onChange={e => setText(e.target.value)} disabled={disabled} />
                    <div className="flex gap-4">
                        <button type="button" className={`${LABEL} text-blue-400 transition hover:text-blue-300`} disabled={disabled || !text.trim()}
                            onClick={async () => { if (await onAnswer(text.trim())) { setText(''); setOpen(false); } }}>
                            {t.save}
                        </button>
                        <button type="button" className={`${LABEL} text-slate-500 transition hover:text-slate-300`} onClick={() => setOpen(false)}>{t.cancel}</button>
                    </div>
                </div>
            ) : !disabled && (
                <button type="button" className={`${LABEL} flex items-center gap-1.5 text-blue-400 transition hover:text-blue-300`} onClick={() => setOpen(true)}>
                    <CornerDownRight className="w-3 h-3" />{t.answer}
                </button>
            )}
        </div>
    );
}

function PlanSection({ plan, heads, forked, done, entries, t, disabled, onWrite, onChoose }: {
    plan: NotebookEntry | null; heads: NotebookEntry[]; forked: boolean; done: Map<number, number>;
    entries: readonly NotebookEntry[]; t: T; disabled: boolean;
    onWrite: (body: NotebookBody) => Promise<boolean>; onChoose: (keep: string) => Promise<boolean>;
}) {
    const [editing, setEditing] = useState(false);
    const body = plan?.body.kind === 'plan' ? plan.body : null;
    const [draft, setDraft] = useState({ purpose: '', hypothesis: '', criteria: '', steps: '' });
    const startEdit = () => {
        setDraft({
            purpose: body?.purpose ?? '', hypothesis: body?.hypothesis ?? '', criteria: body?.criteria ?? '',
            steps: (body?.steps ?? []).map(s => s.do).join('\n'),
        });
        setEditing(true);
    };
    const submit = async () => {
        const steps = draft.steps.split('\n').map(s => s.trim()).filter(Boolean).map((s, i) => {
            // A step that keeps its words keeps its numbers (rpm, RO, hold) from the plan it rewrites.
            const was = body?.steps.find(x => x.do === s);
            return { ...(was ?? {}), n: i + 1, do: s };
        });
        const next: NotebookBody = {
            kind: 'plan', v: nextPlanVersion(entries),
            ...(plan ? { re: plan.id } : {}),
            purpose: draft.purpose.trim(),
            ...(draft.hypothesis.trim() ? { hypothesis: draft.hypothesis.trim() } : {}),
            ...(draft.criteria.trim() ? { criteria: draft.criteria.trim() } : {}),
            steps,
            ...(body?.watch ? { watch: body.watch } : {}),
        };
        if (await onWrite(next)) setEditing(false);
    };

    return (
        <section className="space-y-3 rounded bg-slate-900 p-3">
            <div className="flex items-center justify-between">
                <div className={`${LABEL} text-slate-500`}>
                    {t.plan}{body ? ` v${body.v}` : ''}
                    {plan && <span className="ml-2 font-mono font-normal normal-case tracking-normal text-slate-600">{WHO[plan.by]} · {clock(plan.at)}</span>}
                </div>
                {!disabled && !editing && (
                    <button type="button" className={`${LABEL} flex items-center gap-1.5 text-blue-400 transition hover:text-blue-300`} onClick={startEdit}>
                        <Pencil className="w-3 h-3" />{body ? t.revise : t.writePlan}
                    </button>
                )}
            </div>

            {forked && (
                <div className="space-y-2 rounded bg-slate-800/60 p-2">
                    <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-amber-300">
                        <GitFork className="mt-0.5 w-3 h-3 shrink-0" />{t.fork}
                    </p>
                    {heads.map(h => h.body.kind === 'plan' && (
                        <div key={h.id} className="flex items-center justify-between gap-3">
                            <span className="min-w-0 truncate text-[11px] text-slate-300">v{h.body.v} · {WHO[h.by]} · {h.body.purpose}</span>
                            {!disabled && (
                                <button type="button" className={`${LABEL} shrink-0 text-blue-400 transition hover:text-blue-300`} onClick={() => onChoose(h.id)}>
                                    {t.driveThis}
                                </button>
                            )}
                        </div>
                    ))}
                </div>
            )}

            {editing ? (
                <div className="space-y-2">
                    <input className={`${INPUT} h-7 w-full`} value={draft.purpose} placeholder={t.purpose} onChange={e => setDraft({ ...draft, purpose: e.target.value })} />
                    <textarea className={`${INPUT} min-h-[3rem] w-full py-1.5`} value={draft.hypothesis} placeholder={t.hypothesis} onChange={e => setDraft({ ...draft, hypothesis: e.target.value })} />
                    <input className={`${INPUT} h-7 w-full`} value={draft.criteria} placeholder={t.criteria} onChange={e => setDraft({ ...draft, criteria: e.target.value })} />
                    <textarea className={`${INPUT} min-h-[5rem] w-full py-1.5 leading-relaxed`} value={draft.steps} placeholder={t.steps} onChange={e => setDraft({ ...draft, steps: e.target.value })} />
                    <div className="flex gap-4">
                        <button type="button" className={`${LABEL} text-blue-400 transition hover:text-blue-300`} onClick={submit}>{t.save}</button>
                        <button type="button" className={`${LABEL} text-slate-500 transition hover:text-slate-300`} onClick={() => setEditing(false)}>{t.cancel}</button>
                    </div>
                </div>
            ) : body ? (
                <div className="space-y-2">
                    <dl className="grid grid-cols-[3.5rem_minmax(0,1fr)] gap-x-2 gap-y-1 text-[11px] leading-relaxed">
                        <dt className="text-[8px] font-bold tracking-widest uppercase pt-1 text-slate-500">{t.purpose}</dt><dd className="text-slate-200">{body.purpose}</dd>
                        {body.hypothesis && <><dt className="text-[8px] font-bold tracking-widest uppercase pt-1 text-slate-500">{t.hypothesis}</dt><dd className="text-slate-300">{body.hypothesis}</dd></>}
                        {body.criteria && <><dt className="text-[8px] font-bold tracking-widest uppercase pt-1 text-slate-500">{t.criteria}</dt><dd className="text-slate-300">{body.criteria}</dd></>}
                    </dl>
                    {body.steps.length > 0 && (
                        <ol className="space-y-1">
                            {body.steps.map(s => (
                                <li key={s.n} className="flex min-h-6 items-start gap-3">
                                    <span className="w-4 shrink-0 text-right text-[11px] font-mono text-slate-500">{s.n}</span>
                                    <span className={`flex-1 text-[11px] ${done.has(s.n) ? 'text-slate-500' : 'text-slate-200'}`}>{s.do}</span>
                                    {done.has(s.n) && <span className="flex items-center gap-1 text-[10px] font-mono text-emerald-400"><Check className="w-3 h-3" />{done.get(s.n)!.toFixed(1)} s</span>}
                                </li>
                            ))}
                        </ol>
                    )}
                    {body.watch?.length ? (
                        <p className="text-[10px] font-mono text-slate-500">WATCH {body.watch.map(w => w.address + (w.label ? ` ${w.label}` : '')).join(' · ')}</p>
                    ) : null}
                </div>
            ) : (
                <p className="text-[11px] text-slate-500">{t.noPlan}</p>
            )}
        </section>
    );
}

function NoteInput({ t, onSave }: { t: T; onSave: (text: string) => Promise<boolean> }) {
    const [text, setText] = useState('');
    return (
        <section className="space-y-2 rounded bg-slate-900 p-3">
            <div className={`${LABEL} flex items-center gap-1.5 text-slate-500`}><MessageSquare className="w-3 h-3" />{t.addNote}</div>
            <textarea className={`${INPUT} min-h-[3.5rem] w-full py-1.5 leading-relaxed`} value={text} placeholder={t.noteHint} onChange={e => setText(e.target.value)} />
            <div className="flex gap-4">
                <button type="button" className={`${LABEL} text-blue-400 transition hover:text-blue-300 disabled:text-slate-700`} disabled={!text.trim()}
                    onClick={async () => { if (await onSave(text.trim())) setText(''); }}>
                    {t.save}
                </button>
                {text && (
                    <button type="button" className={`${LABEL} flex items-center gap-1 text-slate-500 transition hover:text-slate-300`} onClick={() => setText('')}>
                        <X className="w-3 h-3" />{t.cancel}
                    </button>
                )}
            </div>
        </section>
    );
}
