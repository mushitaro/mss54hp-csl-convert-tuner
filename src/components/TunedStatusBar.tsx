'use client';

import React from 'react';
import { AlertTriangle, Info, Scissors } from 'lucide-react';
import { useDialogLang } from '@/hooks/useDialogLang';
import type { VeMethod } from '@/lib/ve-calculator/calculator';
import {
    COVERAGE_LABEL, COVERAGE_TONE, type CoverageState,
} from '@/lib/ve-calculator/cellCoverage';
import type { ChargeTempInfo } from '@/lib/ve-calculator/chargeTemp';
import type { DriveSplit, DriveSpan } from '@/lib/log-engine/driveSplit';
import { splitBody, splitExcludedBody, SPLIT_ACTIONS } from './DriveSplitNotice';

/**
 * One line above the TUNED map, with everything that used to be three.
 *
 * ## What it replaced, and why
 *
 * The tab had a stacked amber paragraph about the drive splitting in two, a mono line of six
 * `·`-separated facts about the evidence gate and the air model, and — under the grid — a census
 * that restated part of the same thing. On a phone that is most of the screen before the map
 * starts, and the operator said so (2026-08-25).
 *
 * None of it was wrong, and almost none of it is read twice. A gate setting, an air factor and a
 * drive split are things you check when a number surprises you, not things you monitor. So the
 * strip keeps ON SCREEN only what changes the reading of the map you are looking at:
 *
 *     40/480 gate · 120 touched          how much of this map the drive actually earned
 *     TRIM ONLY                          a red token, only when something is genuinely missing
 *     ⚠ / ✂                              that the drive splits, or that a stretch is excluded
 *
 * and puts the rest one tap away. The two icons are buttons, and each opens the panel that
 * belongs to it: the ⚠ opens the split's explanation WITH its Exclude/Restore control, because a
 * finding and the decision it leads to should not be in different places; the ⓘ opens the gate
 * settings, the air model, the cell census and the hint that a cell can be tapped.
 *
 * ## The warnings do not hide
 *
 * `AMBIENT PRESSURE SUBSTITUTED` and `TRIM ONLY` stay on the strip as red tokens with their detail
 * behind the ⓘ. They are the two states where the map is built from something other than what the
 * reader assumes, and the difference reaches 13 % — a fact that changes whether the map should be
 * written at all does not go behind a tap. Everything that is merely informative does.
 */

const TEXT = {
    ja: {
        gate: 'VE METHOD',
        lead: 'この走行データをどう扱ったかです。方式は RAW FILTER の VE Method で変えられます。',
        methodName: (m: string) => (m === 'direct' ? 'DIRECT' : 'STATISTICAL'),
        samplesTerm: (n: number) => `サンプル ${n} 以上`,
        samplesBody: 'そのセルの付近で記録された点の数。これに満たないセルは書き換えません。',
        authorityTerm: (a: number) => `AUTHORITY ${Math.round(a * 100)} %`,
        authorityBody: '測った要求のうち、今回書いた割合。100 % のままで構いません —— '
            + '要求はそのセル自身のサンプルが出した範囲に既に抑えられています。',
        directBody: 'DIRECT は、測った値をそのまま書く方式です。データのあるセルを全部書いて、焼いて、また走る。1 回で当てにいきません。'
            + '走るたびに残った誤差が縮み、数回で収束します。書き換わらなかったセルは、設定ではなく走行が'
            + '足りていません。',
        statBody: 'STATISTICAL は「この 1 回の走行だけでこのセルを 95 % の確信をもって主張できるか」を'
            + '問う方式で、収束したあとの最終確認用です。途中で使うと、まだ本物の補正が残っているセルまで'
            + '拒否します。自己シェア・独立性・散らばり・有意性の 4 つが追加で効きます。',
        counts: (written: number, total: number, touched: number) =>
            `この走行では ${total} セル中 ${touched} セルにデータがあり、${written} セルを書き換えました。`
            + `残る ${touched - written} セルが次に狙う場所です。セルをタップすると理由が分かります。`,
        air: 'AIR MODEL',
        airBody: (f: string, lo?: string, hi?: string) =>
            `このログをテーブル基準の空気に置き直すと ×${f}`
            + (lo && hi ? `（中央 90 % は ${lo}〜${hi}）` : '')
            + '。適用の有無に関わらず表示しています — 読み値としても意味があるためです。',
        airAt: (t: number, p: number) => `基準: 吸気温 ${t} °C / ${p.toFixed(0)} mbar。`,
        airUsable: (u: number, t: number) => `${t} サンプル中 ${u} で計算できました。`,
        airApplied: '適用中。',
        substituted: '大気圧がログに無く、代替値で計算しています。高度差のぶんマップがずれます。',
        trimOnly: '吸気温か気圧が無いため rf_korr を測れず、λ トリムだけでマップを作っています。'
            + '差は最大で 13 % に達します。',
        trimPartial: (m: number, c: number) => `rf_korr を測れたのは ${c} サンプル中 ${m} です。`,
        census: 'CELLS',
        split: 'DRIVE SPLIT',
    },
    en: {
        gate: 'VE METHOD',
        lead: 'How this drive’s data was used. The method is on RAW FILTER, under VE Method.',
        methodName: (m: string) => (m === 'direct' ? 'DIRECT' : 'STATISTICAL'),
        samplesTerm: (n: number) => `${n}+ samples`,
        samplesBody: 'How many points were recorded near the cell. Below this the cell is not written.',
        authorityTerm: (a: number) => `AUTHORITY ${Math.round(a * 100)} %`,
        authorityBody: 'How much of the measured demand this pass applied. 100 % is fine — the '
            + 'demand is already bounded by what samples inside that cell asked for.',
        directBody: 'DIRECT writes what the drive measured — every cell that has data — then you flash and '
            + 'drive again. It does not try '
            + 'to be right in one pass — each drive shrinks the error left over, and it converges in a '
            + 'few laps. A cell that did not move needs driving, not a different setting.',
        statBody: 'STATISTICAL asks whether THIS drive can prove THIS cell on its own at 95 %, and is '
            + 'for the final check once the map has converged. Used partway through it refuses cells that '
            + 'still hold real correction. Self-share, independence, scatter and significance all apply.',
        counts: (written: number, total: number, touched: number) =>
            `${touched} of the map’s ${total} cells have data on this drive, and ${written} were `
            + `written. The other ${touched - written} are where to aim next — tap a cell for the reason.`,
        air: 'AIR MODEL',
        airBody: (f: string, lo?: string, hi?: string) =>
            `Restating this log at the table's own air is ×${f}`
            + (lo && hi ? ` (middle 90 % ${lo}–${hi})` : '')
            + '. Shown whether or not it is applied — it is a reading before it is a transform.',
        airAt: (t: number, p: number) => `Reference: ${t} °C intake / ${p.toFixed(0)} mbar.`,
        airUsable: (u: number, t: number) => `Computed on ${u} of ${t} samples.`,
        airApplied: 'Applied.',
        substituted: 'No ambient pressure in this log, so a substitute is being used. The map is '
            + 'off by whatever the altitude difference is.',
        trimOnly: 'Without intake temperature or pressure this log cannot measure rf_korr, so the '
            + 'map is built from the lambda trim alone. The difference reaches 13 %.',
        trimPartial: (m: number, c: number) => `rf_korr measured on ${m} of ${c} samples.`,
        census: 'CELLS',
        split: 'DRIVE SPLIT',
    },
};

/** The panel both buttons open into. Absolute, so nothing above the grid changes height when one
 *  opens — the map does not move under the finger that opened it. */
const Panel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <div className="absolute top-full right-0 mt-1 z-30 w-[300px] max-w-[92vw] text-left
                    bg-slate-900 border border-slate-700 rounded shadow-xl p-3 space-y-2.5
                    text-[10px] leading-relaxed max-h-[60vh] overflow-y-auto overscroll-contain">
        {children}
    </div>
);

const Head: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <div className="text-[9px] text-slate-500 font-bold uppercase tracking-widest">{children}</div>
);

export const TunedStatusBar: React.FC<{
    coverage: { withEvidence: number; total: number; withAnyData: number } | null | undefined;
    census: Record<CoverageState, number>;
    /** The calculator's own type, not a copy of its shape: a structural clone here would compile
     *  until the day the real one gains a nullable field, which is how this was first written. */
    chargeTempInfo?: ChargeTempInfo | null;
    gate: { method: VeMethod; samples: number; authority: number };
    split: DriveSplit | null;
    excludedSpan: DriveSpan | null;
    originSec: number;
    readOnly?: boolean;
    onExclude: () => void;
    onRestore: () => void;
}> = ({
    coverage, census, chargeTempInfo, gate, split, excludedSpan, originSec,
    readOnly = false, onExclude, onRestore,
}) => {
    const lang = useDialogLang();
    const t = TEXT[lang];
    const [open, setOpen] = React.useState<'split' | 'info' | null>(null);
    const toggle = (which: 'split' | 'info') => setOpen(o => (o === which ? null : which));

    const air = chargeTempInfo;
    const trimOnly = !!air && air.rfKorrCandidates > 0 && air.rfKorrMeasured === 0;
    const trimPartial = !!air && air.rfKorrCandidates > 0
        && air.rfKorrMeasured > 0 && air.rfKorrMeasured < air.rfKorrCandidates;
    const substituted = !!air?.pressureSubstituted;
    const excluded = !!excludedSpan;
    const hasSplit = !!split || excluded;
    const span = excludedSpan ?? split?.odd ?? null;
    const minutes = (sec: number) => ((sec - originSec) / 60).toFixed(1);

    if (!coverage) return null;

    return (
        <div className="shrink-0 relative z-30 flex items-center gap-2 px-3 py-1.5
                        bg-slate-900/50 border-b border-slate-800 text-[10px] font-mono">
            {/* The two numbers that change how the map in front of you reads, and nothing else. */}
            <span className="min-w-0 truncate">
                <span className={coverage.withEvidence === 0 ? 'text-red-400' : 'text-slate-300'}>
                    {coverage.withEvidence}
                </span>
                <span className="text-slate-600">{`/${coverage.total} gate`}</span>
                <span className="text-slate-600">{`  ·  ${coverage.withAnyData} touched`}</span>
            </span>

            {/* Only when the map is built from something other than what a reader assumes. */}
            {(trimOnly || substituted) && (
                <span className="text-red-400 font-bold shrink-0 truncate">
                    {trimOnly ? 'TRIM ONLY' : 'NO PRESSURE'}
                </span>
            )}

            <span className="ml-auto flex items-center gap-0.5 shrink-0">
                {hasSplit && (
                    <button
                        type="button"
                        onClick={() => toggle('split')}
                        aria-expanded={open === 'split'}
                        aria-label="Drive split"
                        className={`p-1.5 rounded transition-colors ${open === 'split' ? 'text-blue-400'
                            : excluded ? 'text-slate-500 hover:text-slate-300'
                                : 'text-amber-400 hover:text-amber-300'}`}
                    >
                        {excluded ? <Scissors className="w-3.5 h-3.5" /> : <AlertTriangle className="w-3.5 h-3.5" />}
                    </button>
                )}
                <button
                    type="button"
                    onClick={() => toggle('info')}
                    aria-expanded={open === 'info'}
                    aria-label="How this map was built"
                    className={`p-1.5 -mr-1.5 rounded transition-colors ${open === 'info' ? 'text-blue-400' : 'text-slate-600 hover:text-slate-400'}`}
                >
                    <Info className="w-3.5 h-3.5" />
                </button>
            </span>

            {open === 'split' && span && (
                <Panel>
                    <Head>{t.split}</Head>
                    <div className="text-slate-300 font-sans">
                        {excluded
                            ? splitExcludedBody(lang, minutes(span.from), minutes(span.to), split)
                            : splitBody(lang, minutes(span.from), minutes(span.to), split!)}
                    </div>
                    {/* The decision, in the same panel as the finding — a warning whose control is
                        somewhere else is a warning you read twice and act on once. */}
                    {!readOnly && (
                        <button
                            type="button"
                            onClick={() => { setOpen(null); (excluded ? onRestore : onExclude)(); }}
                            className={`w-full px-2 py-2 rounded text-[10px] font-bold uppercase tracking-widest transition-colors ${excluded
                                ? 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                                : 'bg-amber-500/15 text-amber-300 hover:bg-amber-500/25'}`}
                        >
                            {excluded ? SPLIT_ACTIONS.restore : SPLIT_ACTIONS.exclude}
                        </button>
                    )}
                </Panel>
            )}

            {open === 'info' && (
                <Panel>
                    <div className="space-y-1.5 font-sans">
                        <Head>{t.gate}</Head>
                        {/* The lead first, because it is the only sentence that says what the
                            reader is looking at and where to change it. Then the two quantities
                            BY NAME, before the rule that uses them — a threshold quoted against a
                            word the reader has not been given is a number they cannot judge
                            (operator, 2026-08-25). */}
                        <p className="text-slate-400">{t.lead}</p>
                        <p className="text-slate-500">
                            <span className="text-slate-300 font-bold">{t.methodName(gate.method)}</span>
                            {' — '}{gate.method === 'direct' ? t.directBody : t.statBody}
                        </p>
                        <p className="text-slate-500">
                            <span className="text-slate-300 font-bold">{t.samplesTerm(gate.samples)}</span>
                            {' — '}{t.samplesBody}
                        </p>
                        {gate.method === 'direct' && (
                            <p className="text-slate-500">
                                <span className="text-slate-300 font-bold">{t.authorityTerm(gate.authority)}</span>
                                {' — '}{t.authorityBody}
                            </p>
                        )}
                        <p className="text-slate-400">
                            {t.counts(coverage.withEvidence, coverage.total, coverage.withAnyData)}
                        </p>
                    </div>

                    <div className="space-y-1">
                        <Head>{t.census}</Head>
                        <div className="flex flex-wrap gap-x-3 gap-y-0.5">
                            {(['written', 'settled', 'refused', 'unvisited'] as CoverageState[]).map(s => (
                                <span key={s} className={COVERAGE_TONE[s]}>
                                    {census[s]}{' '}
                                    <span className="text-slate-600 font-sans">
                                        {COVERAGE_LABEL[lang][s]}
                                    </span>
                                </span>
                            ))}
                        </div>
                    </div>

                    {air && air.usable > 0 && (
                        <div className="space-y-1">
                            <Head>{t.air}</Head>
                            <p className="text-slate-400 font-sans">
                                {t.airBody(
                                    air.medianFactor?.toFixed(3) ?? '—',
                                    air.p05?.toFixed(3), air.p95?.toFixed(3))}
                                {air.applied ? ` ${t.airApplied}` : ''}
                            </p>
                            <p className="text-slate-500 font-sans">
                                {air.reference
                                    ? `${t.airAt(air.reference.intakeTempC, air.reference.pressureMbar)} ` : ''}
                                {t.airUsable(air.usable, air.total)}
                            </p>
                        </div>
                    )}

                    {(substituted || trimOnly || trimPartial) && (
                        <div className="space-y-1 border-t border-slate-800 pt-2">
                            {substituted && <p className="text-red-400 font-sans">{t.substituted}</p>}
                            {trimOnly && <p className="text-red-400 font-sans">{t.trimOnly}</p>}
                            {trimPartial && (
                                <p className="text-slate-500 font-sans">
                                    {t.trimPartial(air!.rfKorrMeasured, air!.rfKorrCandidates)}
                                </p>
                            )}
                        </div>
                    )}
                </Panel>
            )}
        </div>
    );
};
