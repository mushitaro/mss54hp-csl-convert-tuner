'use client';

import React from 'react';
import { X } from 'lucide-react';
import { useDialogLang } from '@/hooks/useDialogLang';
import type { VEMap } from '@/lib/types';
import { movingLiveReasonLabel } from '@/lib/ve-calculator/movingResponseLive';
import type { MovingLiveCell, MovingLiveCoverage, MovingLiveReason } from '@/lib/ve-calculator/movingResponseLive';

/** Reserved beside the map, including when no cell is selected. Selection cannot move the grid. */
export const MOVING_ACQUISITION_SUMMARY_HEIGHT = 96;

export const MOVING_LIVE_STATES = ['unvisited', 'blocked', 'collecting', 'revisited'] as const;
type Language = 'ja' | 'en';
type State = MovingLiveCell['state'];

/** Preliminary measurement uses violet. Ice blue remains the final accepted-result colour. */
export const MOVING_LIVE_STYLE: Record<State, React.CSSProperties> = {
    unvisited: { backgroundColor: 'transparent' },
    blocked: {
        backgroundColor: 'rgba(155,132,232,0.04)',
        backgroundImage: 'repeating-linear-gradient(135deg,rgba(155,132,232,0.25) 0,rgba(155,132,232,0.25) 1px,transparent 1px,transparent 6px)',
    },
    collecting: { backgroundColor: 'rgba(155,132,232,0.20)' },
    revisited: { backgroundColor: 'rgba(185,166,238,0.38)' },
};
export const MOVING_LIVE_MARK: Record<State, string> = {
    unvisited: '·', blocked: '×', collecting: '•', revisited: '↻',
};
export const MOVING_LIVE_LABEL: Record<Language, Record<State, string>> = {
    ja: { unvisited: '未記録', blocked: '条件外／欠測', collecting: '解析候補', revisited: '複数通過' },
    en: { unvisited: 'Unvisited', blocked: 'Excluded / missing', collecting: 'Candidate', revisited: 'Revisited' },
};
export const MOVING_LIVE_FOOTER: Record<Language, string> = {
    ja: '色は収録状態です。補正への採用はSTOP後に判定します。',
    en: 'Colours show acquisition. Acceptance for VE correction is decided after STOP.',
};

export function movingLiveCellText(cell: MovingLiveCell, language: Language): string {
    const count = language === 'ja'
        ? `記録 ${cell.recorded}件 · 候補 ${cell.candidates}件 · 通過 ${cell.passes}回`
        : `${cell.recorded} recorded · ${cell.candidates} candidates · ${cell.passes} passes`;
    const reasons = Object.entries(cell.reasons)
        .filter(([, n]) => typeof n === 'number' && n > 0)
        .map(([reason, n]) => `${movingLiveReasonLabel(reason as MovingLiveReason, language)} ${n}`);
    return [MOVING_LIVE_LABEL[language][cell.state], count, ...reasons].join(' · ');
}

const COPY = {
    ja: {
        phases: { recording: '収録中', analyzing: '解析中', unresolved: '補正採用なし', error: '解析未完了' },
        total: (n: number, c: number) => `記録 ${n}件 · 解析候補 ${c}件`,
        tap: 'セルをタップすると、記録数・通過回数・条件外の理由を確認できます。',
        noReasons: '条件外・欠測の記録なし',
        close: 'セルの詳細を閉じる',
        more: '収録状態の詳細',
    },
    en: {
        phases: { recording: 'Recording', analyzing: 'Analyzing', unresolved: 'No VE update accepted', error: 'Analysis incomplete' },
        total: (n: number, c: number) => `${n} recorded · ${c} candidates`,
        tap: 'Tap a cell to inspect its counts, passes, and exclusion reasons.',
        noReasons: 'No excluded or missing records',
        close: 'Close cell details',
        more: 'Acquisition details',
    },
};

export function MovingAcquisitionSummary({
    coverage, mapData, selected, onClose, phase = 'recording',
}: {
    coverage: MovingLiveCoverage;
    mapData: VEMap;
    selected?: { row: number; col: number } | null;
    onClose?: () => void;
    phase?: 'recording' | 'analyzing' | 'unresolved' | 'error';
}) {
    const language = useDialogLang();
    const copy = COPY[language];
    const counts = { unvisited: 0, blocked: 0, collecting: 0, revisited: 0 };
    for (const row of coverage.cells) for (const cell of row) counts[cell.state]++;
    const cell = selected ? coverage.cells[selected.row]?.[selected.col] : undefined;
    const reasons = cell ? Object.entries(cell.reasons)
        .filter(([, n]) => typeof n === 'number' && n > 0)
        .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
        .map(([reason, n]) => `${movingLiveReasonLabel(reason as MovingLiveReason, language)} ${n}`) : [];

    return (
        <section data-moving-acquisition-summary className="shrink-0 bg-slate-950 border-t border-slate-700 px-3 py-2 flex flex-col gap-1 text-[10px] leading-[14px] text-slate-300"
            style={{ height: MOVING_ACQUISITION_SUMMARY_HEIGHT }} aria-label={language === 'ja' ? '測定点の収録状態' : 'Measurement acquisition'}>
            <div className="h-[14px] shrink-0 flex items-center justify-between gap-2">
                <span className={phase === 'error' ? 'text-red-300' : 'text-indigo-300'}>{copy.phases[phase]}</span>
                <span className="font-mono tabular-nums truncate">{copy.total(coverage.observedRows, coverage.candidateRows)}</span>
            </div>
            <div className="h-7 shrink-0 grid grid-cols-2 min-[500px]:grid-cols-4 gap-x-2" aria-label={language === 'ja' ? 'グリッドの凡例' : 'Grid legend'}>
                {MOVING_LIVE_STATES.map(state => (
                    <span key={state} className="flex items-center gap-1 whitespace-nowrap">
                        <span className="w-3.5 h-3.5 shrink-0 text-center font-mono text-indigo-300" style={MOVING_LIVE_STYLE[state]} aria-hidden="true">{MOVING_LIVE_MARK[state]}</span>
                        <span>{MOVING_LIVE_LABEL[language][state]}</span>
                        <span className="font-mono text-slate-400">{counts[state]}</span>
                    </span>
                ))}
            </div>
            <div className="relative min-h-0 flex-1 pr-7" aria-live="polite" aria-atomic="true">
                {cell && selected ? (
                    <>
                        <details className="group" key={`${selected.row}:${selected.col}`}>
                            <summary className="cursor-pointer list-none focus-visible:outline-2 focus-visible:outline-blue-400" aria-label={copy.more}>
                                <div className="font-mono truncate">{mapData.xAxis[selected.col]} RPM · RO {mapData.yAxis[selected.row]}% · {MOVING_LIVE_LABEL[language][cell.state]}</div>
                                <div className="font-mono truncate text-slate-400">
                                    {language === 'ja' ? `記録 ${cell.recorded}件 · 候補 ${cell.candidates}件 · 通過 ${cell.passes}回 · 詳細 ⓘ`
                                        : `${cell.recorded} recorded · ${cell.candidates} candidates · ${cell.passes} passes · ⓘ`}
                                </div>
                            </summary>
                            {/* Native details makes every reason readable by touch and keyboard, without
                                changing the reserved map geometry. Close by tapping its summary again. */}
                            <div className="fixed inset-x-3 bottom-[60px] z-50 min-[900px]:absolute min-[900px]:inset-x-0 min-[900px]:bottom-auto min-[900px]:top-full bg-slate-900 border border-slate-700 shadow-xl p-3 space-y-1 text-slate-300 max-h-[62vh] overflow-auto">
                                <div className="flex items-center justify-between gap-2">
                                    <span>{copy.more}</span>
                                    <button type="button" aria-label={copy.close} className="w-7 h-7 flex items-center justify-center text-slate-400 hover:text-slate-100"
                                        onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); }}><X className="w-4 h-4" /></button>
                                </div>
                                <p className="text-indigo-300">{MOVING_LIVE_FOOTER[language]}</p>
                                {reasons.length ? reasons.map(reason => <p key={reason}>{reason}</p>) : <p>{copy.noReasons}</p>}
                            </div>
                        </details>
                        {onClose && <button type="button" aria-label={copy.close} onClick={onClose}
                            className="absolute right-0 top-0 w-7 h-7 flex items-center justify-center text-slate-400 hover:text-slate-100 focus-visible:outline-2 focus-visible:outline-blue-400">
                            <X className="w-4 h-4" />
                        </button>}
                    </>
                ) : <p className="text-slate-400">{MOVING_LIVE_FOOTER[language]} <span className="hidden min-[500px]:inline">{copy.tap}</span></p>}
            </div>
        </section>
    );
}
