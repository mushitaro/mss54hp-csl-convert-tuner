'use client';

import React from 'react';
import { useDialogLang } from '@/hooks/useDialogLang';
import {
    coverageRemedy, COVERAGE_LABEL, COVERAGE_TONE,
    type CellCoverage,
} from '@/lib/ve-calculator/cellCoverage';
import type { VEMap } from '@/lib/types';

/**
 * What the TUNED MAP knows about one cell, and what the drive earned overall.
 *
 * ## Why this exists at all
 *
 * The map has always been able to say WHAT a cell holds and never WHY it holds it. Everything that
 * explains a cell — how many samples landed, how they were spread, which gate refused it — lived
 * either in a `title` attribute, which has no hover on the screen this app is used on, or in no
 * view whatever: the VE path did not record a reason until the same commit as this file.
 *
 * The question a reader actually arrives with is not "what is in this cell". It is **"why did my
 * drive not tune it, and what do I do about that"** — and the answers divide into two that look
 * identical on a map and demand opposite actions:
 *
 *     NOT ENOUGH DATA   samples landed, the evidence was judged short.   Drive it differently.
 *     NOT DRIVEN        no sample landed.                              Drive it at all — or never.
 *
 * Session #920 is why the second half of that matters. Rows 0 and 1 of the opening axis took ZERO
 * samples out of 13,608, and no amount of driving will change it: idle already sits at 0.37 %
 * opening, and the only state below that is a shut throttle, where the DME cuts the injectors and
 * there is no mixture to measure. A strip that says "no sample landed here" lets the reader stop
 * trying; one that says "not written" sends them back out for nothing.
 *
 * ## Nothing on screen until a cell is picked
 *
 * It used to hold a fixed 72px box whether or not one was, carrying a census and a "tap a cell"
 * hint — 72px of standing text above the fold on a phone, for a question nobody has asked yet
 * (operator, 2026-08-25: cell information appears when a cell is selected and not otherwise, on
 * every tab).
 *
 * The reason it was a fixed box was layout stability, and that reason is real: a strip that pushes
 * the grid up every time you tap a cell moves the cell out from under the finger that tapped it. So
 * this is an OVERLAY now rather than a row — absolutely positioned over the foot of the grid, which
 * costs the grid no height at all. Both properties at once: nothing when nothing is selected, and
 * the map does not move when something is.
 *
 * The census it used to carry moved to the strip above the grid, behind the ⓘ, next to the gate
 * settings that decide it. The "tap a cell" hint went with it.
 *
 * Nothing here is a control; tapping the same cell again clears the selection, which is the map's
 * job, not this one's.
 */

const TEXT = {
    en: {
        unvisitedNote: 'No sample landed here — drive this state.',
        belowReachNote: 'No sample, and none ever will: this sits BELOW the lowest opening the '
            + 'engine reached. Idle is above it, and under idle the throttle is shut and the '
            + 'injectors are off, so there is no mixture for the lambda loop to measure.',
        band: (b: 'low' | 've') => b === 'low'
            ? 'Low-opening band — judged on separate visits and a settled mean, because a car can park on one cell for minutes.'
            : 'Upper band — judged on samples and how centrally they landed, because a sweep crosses a cell in a second.',
    },
    ja: {
        unvisitedNote: 'サンプルが落ちていません —— この状態を走ってください。',
        belowReachNote: 'サンプルが無く、今後も落ちません —— ここはエンジンが到達した最低開度より'
            + '下です。アイドルがそれより上にあり、その下はスロットル全閉でインジェクタが止まって'
            + 'いるので、λ ループが測れる混合気がありません。',
        band: (b: 'low' | 've') => b === 'low'
            ? '低開度帯 —— 独立した訪問と落ち着いた平均で判定。車は一つのセルに数分留まれるため。'
            : '上帯 —— サンプル数と中心への寄り方で判定。スイープは一秒でセルを横切るため。',
    },
};

export function CoverageDetail({ cell, map, demand, rfKorr, rfKorrSpread, onHeightChange }: {
    cell: CellCoverage | null | undefined;
    map: VEMap | null;
    /**
     * How tall this readout currently is, so the grid under it can keep room to scroll clear.
     *
     * It overlays the FOOT of the map, and the map's last rows are the highest openings — RO 65,
     * 85 and 100 on `AXIS_LOAD`. Scrolled to the bottom, those three were the ones it covered, and
     * they are not spare: the top of the load axis is where a CSL conversion is actually being
     * tuned. So the caller reserves this many pixels of scroll room BELOW the grid.
     *
     * Padding below the content rather than a row beside it, because a row appearing would push
     * the grid up and take the cell out from under the finger that just tapped it — the reason
     * this is an overlay in the first place. Room added past the last row moves nothing.
     *
     * Measured rather than assumed: the box has no fixed height any more (the remedy sentence
     * wraps, and how many lines it takes depends on the cell and the language), so a constant here
     * would be right for one state and wrong for the rest. 0 when nothing is shown.
     */
    onHeightChange?: (px: number) => void;
    /**
     * What this cell ASKED for, before the gate and before the gain.
     *
     * Different from `cell.correction` on a written cell — the correction is what was applied after
     * the anti-ratchet clamp and the gain, the demand is what the samples wanted. On a REFUSED cell
     * they are the same number, and it is the one worth reading: it says how far out the cell is,
     * which is the whole reason to go and drive it again.
     */
    demand?: number;
    /** The weighted-mean `rf_korr` the cell's samples were taken under, and the spread within it.
     *  A cell built entirely at 1.00 is clean; one mixing 1.00 with 1.30 is averaging two different
     *  operating conditions into a single VE value, and only the spread says so. */
    rfKorr?: number;
    rfKorrSpread?: number;
}) {
    const lang = useDialogLang();
    const t = TEXT[lang === 'ja' ? 'ja' : 'en'];
    const box = React.useRef<HTMLDivElement | null>(null);

    // Reports on mount, on every content change, and on the resize that a language switch or a
    // narrower pane causes. Cleared to 0 on unmount so the grid does not keep padding for a
    // readout that has gone.
    React.useEffect(() => {
        const el = box.current;
        if (!el || !onHeightChange) { onHeightChange?.(0); return; }
        const ro = new ResizeObserver(() => onHeightChange(el.getBoundingClientRect().height));
        ro.observe(el);
        onHeightChange(el.getBoundingClientRect().height);
        return () => { ro.disconnect(); onHeightChange(0); };
    }, [cell, onHeightChange]);

    if (!cell) return null;

    return (
        /* Over the foot of the grid, not under it. `pointer-events-none` because this is a readout
           and the cells it covers are still the control — a strip that swallowed taps would make
           the bottom row of the map unselectable while it was open. */
        <div ref={box} className="absolute inset-x-0 bottom-0 z-20 pointer-events-none
                        border-t border-slate-700 bg-slate-900/95 backdrop-blur-[2px]
                        px-2 py-1.5 text-[10px] leading-tight">
            <div className="space-y-0.5">
                    <div className="font-mono text-slate-400">
                        <span className="text-slate-500">
                            {map ? `${map.xAxis[cell.col]} rpm · ${map.yAxis[cell.row].toFixed(2)} %` : `${cell.row}:${cell.col}`}
                        </span>
                        <span className={`ml-2 font-bold ${COVERAGE_TONE[cell.state]}`}>
                            {COVERAGE_LABEL[lang][cell.state]}
                        </span>
                        <span className="ml-2 text-slate-500">
                            {cell.samples} smp
                            {cell.weight !== undefined ? ` · w ${cell.weight.toFixed(1)}` : ''}
                            {cell.visits !== undefined ? ` · ${cell.visits} visits` : ''}
                            {/* SHOWN FOR EVERY VISITED CELL, written or not.
                                It used to appear only on cells the gate accepted, which threw away
                                the reading on exactly the cells the driver is deciding whether to
                                go back to. The gate governs the WRITE; the measurement is a
                                measurement either way, and the sample count beside it already says
                                how much weight to put on it (operator, 2026-08-28). */}
                            {cell.samples > 0 ? ` · ×${cell.correction.toFixed(4)}` : ''}
                            {demand !== undefined && cell.samples > 0
                                && Math.abs(demand - cell.correction) > 0.0005
                                ? ` (asked ×${demand.toFixed(4)})` : ''}
                            {rfKorr !== undefined && cell.samples > 0 && rfKorr !== 1
                                ? ` · rf_korr ${rfKorr.toFixed(3)}`
                                    + (rfKorrSpread ? `±${(rfKorrSpread / 2).toFixed(3)}` : '')
                                : ''}
                        </span>
                    </div>
                    {/* The reason, then the action. Never the reason alone — a refusal a reader
                        cannot act on is indistinguishable from a bug.
                        It WRAPS, and that is the point of the box no longer being a fixed 72px:
                        `truncate` was here because the old row had a height to respect, and it cut
                        the remedy off mid-sentence on a phone — the half that says what to do next
                        is the half that fell off the end. An overlay owes the grid no height, so
                        the sentence simply finishes. */}
                    <div className="text-slate-500">
                        {cell.state === 'unvisited'
                            ? (cell.belowReach ? t.belowReachNote : t.unvisitedNote)
                            : cell.reason
                                ? <>
                                    <span className="font-mono text-violet-300">{cell.reason}</span>
                                    {coverageRemedy(cell.reason, lang === 'ja' ? 'ja' : 'en')
                                        && <span>{'  ▸ '}{coverageRemedy(cell.reason, lang === 'ja' ? 'ja' : 'en')}</span>}
                                </>
                                : t.band(cell.band)}
                    </div>
            </div>
        </div>
    );
}
