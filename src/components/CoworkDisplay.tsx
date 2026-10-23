'use client';

import React from 'react';
import { Check } from 'lucide-react';
import type { LogDataPoint } from '@/lib/types';
import type { PlanStep } from '@/lib/notebook/rules';
import { checkable, liveHold, stepDone, stepGears } from '@/lib/notebook/steps';
import { LOG_FIELD_REGISTRY } from '@/lib/field-registry/registry';
import { COLUMNS } from '@/lib/bridge/moment';

/**
 * CO-WORK on DASH's upper area: what the assistant chose to show the driver.
 *
 * Shown, never operated. The driver does not touch the screen while driving (operator, 2026-10-23):
 * the assistant switches what is here (tuner_display) — on its own judgement, or because the driver
 * asked by voice — and marks steps done. Every view is a reading the driver can take in at a glance.
 *
 *   target  one step: its bands, and whether the car is in them now and for how long
 *   steps   the plan's steps, each with how often it is done, in any order
 *   values  the values the assistant named, large
 *
 * The graph is the log chart itself, which the page draws in this place when asked.
 */

export type CoworkView = 'target' | 'steps' | 'values' | 'graph';

const LABEL = 'text-[10px] font-bold tracking-widest uppercase';

const TEXT = {
    en: { target: 'TARGET', steps: 'STEPS', values: 'VALUES', noPlan: 'No plan in CO-WORK', noStep: 'No step to aim for', allDone: 'All steps done', notRecording: 'Not recording', held: 'held', any: 'any gear', none: 'No values chosen' },
    ja: { target: '目標', steps: '手順', values: '値', noPlan: 'CO-WORK に計画がありません', noStep: '狙う手順がありません', allDone: '手順はすべて済み', notRecording: '記録していません', held: '保持', any: 'ギアは問わない', none: '値が選ばれていません' },
} as const;
type T = (typeof TEXT)[keyof typeof TEXT];

const range = (r: [number, number] | undefined, digits = 0) =>
    r ? `${r[0].toLocaleString(undefined, { maximumFractionDigits: digits })}–${r[1].toLocaleString(undefined, { maximumFractionDigits: digits })}` : null;

/** The bands a step names, as short tags: 4/5 · 2,400–2,800 rpm · RO 6–8 · 5 s · ×4. */
export function stepTags(s: PlanStep): string[] {
    const gears = stepGears(s);
    return [
        gears.length ? `GEAR ${gears.join('/')}` : null,
        range(s.rpm) ? `${range(s.rpm)} rpm` : null,
        range(s.ro, 1) ? `RO ${range(s.ro, 1)}` : null,
        s.holdS !== undefined ? `${s.holdS} s` : null,
        s.times ? `×${s.times}` : null,
    ].filter((x): x is string => !!x);
}

/** The steps, each with its count, done ones marked — no "next", no order. */
export function StepBoard({ steps, counts, large = false }: { steps: readonly PlanStep[]; counts: Map<number, number>; large?: boolean }) {
    return (
        <ol className={large ? 'space-y-1.5' : 'space-y-1'}>
            {steps.map(s => {
                const n = counts.get(s.n) ?? 0;
                const done = stepDone(s, counts);
                return (
                    <li key={s.n} className="grid grid-cols-[1.5rem_minmax(0,1fr)_auto] items-start gap-2">
                        <span className={`text-right font-mono ${large ? 'text-[13px]' : 'text-[11px]'} ${done ? 'text-blue-400' : 'text-slate-500'}`}>{s.n}</span>
                        <span className="min-w-0">
                            <span className={`block ${large ? 'text-[13px]' : 'text-[11px]'} ${done ? 'text-slate-500' : 'text-slate-200'}`}>{s.do}</span>
                            {stepTags(s).length > 0 && <span className="block text-[10px] font-mono text-slate-500">{stepTags(s).join(' · ')}</span>}
                        </span>
                        <span className={`flex items-center gap-1 font-mono ${large ? 'text-[13px]' : 'text-[11px]'} ${done ? 'text-blue-400' : n ? 'text-slate-300' : 'text-slate-600'}`}>
                            {done && <Check className="w-3 h-3" />}{n}/{s.times ?? 1}
                        </span>
                    </li>
                );
            })}
        </ol>
    );
}

function Reading({ label, value, on }: { label: string; value: string; on: boolean | null }) {
    return (
        <div className="flex flex-col items-center">
            <span className="text-[8px] font-bold tracking-widest uppercase text-slate-500">{label}</span>
            <span className={`text-[22px] font-mono leading-none ${on === null ? 'text-slate-600' : on ? 'text-blue-300' : 'text-slate-300'}`}>{value}</span>
        </div>
    );
}

function TargetView({ step, count, samples, recording, t }: { step: PlanStep; count: number; samples: readonly LogDataPoint[]; recording: boolean; t: T }) {
    const live = liveHold(recording ? samples : [], step);
    const need = step.holdS ?? 1;
    const gears = stepGears(step);
    const inRpm = live.rpm === null || !step.rpm ? null : live.rpm >= step.rpm[0] && live.rpm <= step.rpm[1];
    const inRo = live.ro === null || !step.ro ? null : live.ro >= step.ro[0] && live.ro <= step.ro[1];
    const inGear = live.gear === null || !gears.length ? null : gears.includes(live.gear);
    const held = Math.min(live.seconds, need);
    return (
        <div className="flex h-full flex-col justify-center gap-4 px-4">
            <div className="min-w-0">
                <div className={`${LABEL} text-slate-500`}>{t.target} · STEP {step.n} · {count}/{step.times ?? 1}</div>
                <div className="truncate text-[15px] text-slate-100">{step.do}</div>
                <div className="truncate text-[11px] font-mono text-slate-400">{stepTags(step).join(' · ') || t.any}</div>
            </div>
            <div className="grid grid-cols-3 gap-2">
                <Reading label="GEAR" value={live.gear === null ? '—' : String(live.gear)} on={inGear} />
                <Reading label="RPM" value={live.rpm === null ? '—' : Math.round(live.rpm).toLocaleString()} on={inRpm} />
                <Reading label="RO" value={live.ro === null ? '—' : live.ro.toFixed(1)} on={inRo} />
            </div>
            {checkable(step) && (
                <div className="space-y-1">
                    <div className="h-1.5 rounded bg-slate-800">
                        <div className={`h-1.5 rounded ${held >= need ? 'bg-blue-400' : 'bg-blue-600'}`} style={{ width: `${Math.round((held / need) * 100)}%` }} />
                    </div>
                    <div className="flex justify-between text-[10px] font-mono text-slate-500">
                        <span>{recording ? `${t.held} ${held.toFixed(1)} / ${need} s` : t.notRecording}</span>
                        <span>{live.inBand ? 'IN BAND' : ''}</span>
                    </div>
                </div>
            )}
        </div>
    );
}

type Getter = (p: LogDataPoint) => number | undefined;
const field = (key: string): Getter => p => {
    const v = (p as unknown as Record<string, unknown>)[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
};

/**
 * A value the assistant named. First by the names tuner_moment's rows use (rpm, aq_rel, stft1,
 * coolant, egt, tz1 …), so whatever it read there it can show; then RO (the corrected opening the
 * steps are judged on); then a log key or the DME's symbol for anything else the log carries.
 */
export function resolveChannel(name: string): Getter | null {
    const n = name.trim().toLowerCase();
    const col = COLUMNS.find(c => c.name.toLowerCase() === n);
    if (col) return col.get;
    if (n === 'ro' || n === 'correctedload') return field('correctedLoad');
    if (n === 'rawload') return field('rawLoad');
    for (const [key, f] of Object.entries(LOG_FIELD_REGISTRY)) {
        if (key.toLowerCase() === n || f.symbol.toLowerCase() === n) return field(key);
    }
    return null;
}

function ValuesView({ channels, samples, t }: { channels: readonly string[]; samples: readonly LogDataPoint[]; t: T }) {
    if (!channels.length) return <p className="px-4 text-[11px] font-mono text-slate-600">{t.none}</p>;
    // The latest value each channel has: slow lanes are read one sample in 8 or 16.
    const latest = (get: Getter) => {
        for (let i = samples.length - 1; i >= Math.max(0, samples.length - 40); i--) {
            const v = get(samples[i]);
            if (v !== undefined && Number.isFinite(v)) return v;
        }
        return undefined;
    };
    return (
        <div className="grid h-full grid-cols-2 content-center gap-x-4 gap-y-5 px-4">
            {channels.slice(0, 6).map(c => {
                const get = resolveChannel(c);
                const v = get ? latest(get) : undefined;
                const digits = v === undefined ? 0 : Math.abs(v) >= 100 ? 0 : Math.abs(v) >= 10 ? 1 : 3;
                return <Reading key={c} label={c} value={v === undefined ? '—' : v.toFixed(digits)} on={null} />;
            })}
        </div>
    );
}

export default function CoworkDisplay({ view, steps, counts, step, channels, samples, recording, lang }: {
    view: Exclude<CoworkView, 'graph'>;
    steps: readonly PlanStep[] | null;
    counts: Map<number, number>;
    /** The step the assistant pointed at; otherwise the first one not yet done. */
    step: number | null;
    channels: readonly string[];
    samples: readonly LogDataPoint[];
    recording: boolean;
    lang: 'en' | 'ja';
}) {
    const t = TEXT[lang];
    if (view === 'values') return <ValuesView channels={channels} samples={samples} t={t} />;
    if (!steps) return <p className="flex h-full items-center justify-center text-[11px] font-mono text-slate-600">{t.noPlan}</p>;
    if (view === 'steps') {
        return (
            <div className="h-full overflow-y-auto px-4 py-3">
                <div className={`${LABEL} mb-2 text-slate-500`}>{t.steps}</div>
                <StepBoard steps={steps} counts={counts} large />
            </div>
        );
    }
    const chosen = (step !== null ? steps.find(s => s.n === step) : undefined) ?? steps.find(s => !stepDone(s, counts));
    if (!chosen) return <p className="flex h-full items-center justify-center text-[11px] font-mono text-blue-300">{steps.length ? t.allDone : t.noStep}</p>;
    return <TargetView step={chosen} count={counts.get(chosen.n) ?? 0} samples={samples} recording={recording} t={t} />;
}
