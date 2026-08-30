import React, { useMemo } from 'react';
import { CheckCircle2, CircleSlash, HelpCircle, OctagonX } from 'lucide-react';
import type { IdleSample } from '@/lib/dme-link/types';
import type { IdleTables } from '@/lib/idle/idleTables';
import { evaluateIdlePreflight, type PreflightStatus } from '@/lib/idle/preflight';
import { useDialogLang } from '@/hooks/useDialogLang';

/**
 * The section 7.1 preconditions, rendered.
 *
 * The verdict itself is `lib/idle/preflight.ts` — this only draws it, the same split `IdlePanel`
 * and `tuner.ts` already have. It sits ABOVE the census rather than beside it because it is not a
 * quality score on the run: it is whether the run is a measurement at all, and reading it after the
 * numbers would be reading it too late.
 */

const TEXT = {
    ja: {
        title: '事前条件（§7.1）',
        lede: 'これはチューニングではありません。**この計測に意味があるかどうか**の判定です。'
            + 'しきい値は 1 つを除いて読み込み済みの BIN から読んでいます。',
        waiting: '記録を開始すると、暖機安定アイドルでの判定が出ます。',
        allOk: '事前条件は満たされています。',
        fatalFail: 'ここで止めてください。下の計測は「動いていない制御器」を測っています。',
        someFail: '条件を外れています。下の計測の意味が変わります。',
        someUnknown: '一部のチャネルがまだ届いていません（低速レーン）。',
        reading: '実測', rule: '判定', na: '未取得', over: 'サンプル',
        inference: 'このしきい値だけは BIN ではなく調査からの inference',
    },
    en: {
        title: 'PRECONDITIONS (7.1)',
        lede: 'This is not tuning. It is the question of **whether the measurement below means '
            + 'anything.** Every threshold but one is read from the loaded binary.',
        waiting: 'Start a run to get the verdict at warm settled idle.',
        allOk: 'Preconditions hold.',
        fatalFail: 'Stop here. The measurement below is of a controller that is not running.',
        someFail: 'Outside the conditions. What the measurement below means has changed.',
        someUnknown: 'Some channels have not arrived yet (slow lane).',
        reading: 'measured', rule: 'rule', na: 'not read', over: 'samples',
        inference: 'this threshold alone is an inference from the investigation, not read from the binary',
    },
};

const ICON: Record<PreflightStatus, React.ComponentType<{ className?: string }>> = {
    ok: CheckCircle2, fail: CircleSlash, unknown: HelpCircle,
};
const TONE: Record<PreflightStatus, string> = {
    ok: 'text-emerald-400', fail: 'text-red-400', unknown: 'text-white/40',
};

interface Props {
    samples: IdleSample[];
    tables: IdleTables | null;
}

export const IdlePreflight: React.FC<Props> = ({ samples, tables }) => {
    const lang = useDialogLang();
    const t = TEXT[lang === 'ja' ? 'ja' : 'en'];
    const verdict = useMemo(() => evaluateIdlePreflight(samples, tables), [samples, tables]);

    if (!tables) return null;

    const fmt = (v: number | null, unit: string) =>
        v === null ? t.na : `${v.toFixed(2)}${unit ? ` ${unit}` : ''}`;

    return (
        <div className={`rounded border p-3 space-y-2 ${verdict?.blocked ? 'border-red-500/50 bg-red-500/5'
            : verdict?.anyFail ? 'border-amber-500/40 bg-amber-500/5'
                : 'border-white/10'}`}>
            <div className="flex items-center gap-2">
                {verdict?.blocked && <OctagonX className="w-4 h-4 text-red-400 shrink-0" />}
                <span className="font-mono text-xs tracking-wide text-white/70">{t.title}</span>
                {verdict && (
                    <span className="font-mono text-[10px] text-white/30 ml-auto">
                        {verdict.samplesUsed} {t.over}
                    </span>
                )}
            </div>
            <p className="text-white/60 leading-relaxed text-xs">{t.lede}</p>

            {!verdict ? (
                <p className="text-white/40 text-xs">{t.waiting}</p>
            ) : (
                <>
                    <div className={`font-mono text-xs ${verdict.blocked ? 'text-red-300'
                        : verdict.anyFail ? 'text-amber-300' : 'text-emerald-300'}`}>
                        {verdict.blocked ? t.fatalFail
                            : verdict.anyFail ? t.someFail
                                : verdict.anyUnknown ? t.someUnknown : t.allOk}
                    </div>
                    <div className="space-y-1.5">
                        {verdict.tests.map(x => {
                            const Icon = ICON[x.status];
                            return (
                                <div key={x.id} className="flex gap-2 text-xs">
                                    <Icon className={`w-3.5 h-3.5 shrink-0 mt-0.5 ${TONE[x.status]}`} />
                                    <div className="min-w-0">
                                        <div className="font-mono text-[11px]">
                                            <span className="text-white/70">{x.id}</span>
                                            <span className="text-white/40">{`  ${t.reading} `}</span>
                                            <span className={TONE[x.status]}>
                                                {fmt(x.value, x.unit)}
                                                {x.against !== null && ` / ${fmt(x.against, x.unit)}`}
                                            </span>
                                            <span className="text-white/40">{`  ${t.rule} ${x.rule}`}</span>
                                        </div>
                                        {x.status !== 'ok' && (
                                            <div className="text-white/50 leading-relaxed mt-0.5">
                                                {x.consequence[lang === 'ja' ? 'ja' : 'en']}
                                                {x.thresholdIsInference && (
                                                    <span className="text-amber-400/70">{` — ${t.inference}`}</span>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </>
            )}
        </div>
    );
};
