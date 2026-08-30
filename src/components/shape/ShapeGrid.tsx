'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Info } from 'lucide-react';
import { MapEditor } from '@/components/MapEditor';
import { LABEL, type ShapeWorkspace } from './shapeWorkspace';

/**
 * The SHAPE tab's map pane: the counts, the gain grid, and what one cell of it says.
 *
 * What is NOT here any more: the parameter row, which is a popover in the footer now, and the
 * profile chart, which is in the graph pane. Both left for the same reason — see shapeWorkspace.
 *
 * ## The SHAPE of the whole `kf_rf_soll` surface, and what this tune did to it
 *
 * This tab used to be LOW LOAD, and it showed three views of the low-opening band: the values, the
 * change, and the slope. Two of those are now said better elsewhere — TUNED MAP renders the
 * composed grid both derivations write, and its detail strip carries the per-cell evidence and the
 * reason for every refusal, over the whole table rather than thirteen rows of it. Keeping a second
 * place to read the same numbers is how two screens come to disagree.
 *
 * What has no other home is the GRADIENT. A cell's value can be right on its own and wrong next to
 * its neighbour: `kf_rf_soll` is interpolated, so what the engine actually sees between two
 * breakpoints is the line between them, and the tune writes cells one at a time.
 *
 * ## The one constraint that needs no threshold
 *
 * At a fixed engine speed, opening the throttle further cannot admit less air. A column of this
 * table that falls as the opening rises is describing an engine that does not exist. That test has
 * no tuning parameter and no argument attached to it, which is why it leads.
 *
 * ## The one that does, and why it is shown as a PAIR
 *
 * The other signal is how hard the gain steps between adjacent intervals. It is real — a step at
 * the cell every pull-away passes through is felt as the throttle coming on unevenly — but it has
 * no absolute threshold that means anything on this table. Measured on this car's untouched BASE,
 * the ratio runs p05 0.19, median 0.81, p95 4.0, max 32 over 360 intervals, and a 1.6 cap flags
 * 200 of 480 cells. That is not a factory table full of defects; it is the opening axis being
 * non-uniform — 0.05 % steps at the bottom against 15 % at the top — while filling is not scaled
 * the same way. A count on its own would be measuring the axis and calling it a finding.
 *
 * So every count is shown as `BASE -> TUNED`. "200 -> 201" says what a reader needs in one glance:
 * the metric is noisy, and the tune did not move it. And the number that is actually about this
 * log — INTRODUCED, cells that were clean in the BASE and are not now — is the headline, because
 * that is the write landing on a cell whose neighbours had no evidence and stayed where they were.
 */
export const ShapeGrid: React.FC<{ shape: ShapeWorkspace; zoom?: number }> = ({ shape, zoom = 1 }) => {
    const { t, tuned, report, baseReport, gainMap, shownRepair, cell, selected, pick, opts } = shape;
    const [aboutOpen, setAboutOpen] = useState(false);

    /**
     * Stable across renders, so `MapEditor`'s `React.memo` has a chance of holding.
     *
     * It was an inline arrow, which is a new reference on every render — and with `gainMap` also
     * rebuilt whenever the repair moves, memo compared two fresh references, found them different
     * and re-rendered all 504 cells on every tick of the STEP CAP slider. `useCallback` fixes half
     * of that; the other half is `viewRepair` in the workspace, which stops `gainMap` changing at
     * drag rate in the first place.
     *
     * ABOVE the early return, because a hook is. It reads `report` optionally for that reason.
     */
    const cellTint = useCallback((row: number, col: number) => {
        // A shaped cell first, and in the accent colour, because the complaint that sent this here
        // was "nothing changes" — and with six shaped cells out of 480 the odds of tapping one by
        // chance are one in eighty. The proposal has to be findable on the grid before its chart is
        // worth opening.
        if (shownRepair?.shaped[row]?.[col]) return 'text-violet-300 font-bold';
        const c = report?.cells[row]?.[col];
        if (!c?.defect) return undefined;
        if (c.defect === 'falling') return c.introduced ? 'text-red-400 font-bold' : 'text-red-400';
        return c.introduced ? 'text-violet-300' : 'text-slate-500';
    }, [shownRepair, report]);

    /**
     * How much room the cell readout below needs, so the grid can scroll clear of it.
     *
     * Same problem and same answer as the TUNED and LAMBDA grids: the readout is an overlay on the
     * foot of the box — which is what keeps the map from moving under the finger that just tapped
     * it — and scrolled to the end it covered the last rows. On `AXIS_LOAD` those are RO 65, 85
     * and 100, the top of the opening axis. This tab was missed when the other two were fixed
     * (operator, 2026-08-30); it has its own readout rather than sharing CoverageDetail, so it
     * needed its own measurement.
     *
     * Measured rather than assumed, because the box has no fixed height: the sentence under the
     * numbers wraps, and how far depends on the finding and the language. Hooks live above the
     * early return below, which is why they are here rather than beside the element.
     */
    const readoutRef = useRef<HTMLDivElement | null>(null);
    const [readoutHeight, setReadoutHeight] = useState(0);
    /**
     * The FIRST measurement happens here, in the ref callback, and that is not a style choice.
     *
     * It was an effect that observed the node and read it synchronously, which the
     * `react-hooks/set-state-in-effect` rule refuses. Dropping the synchronous read and leaving
     * `ResizeObserver` to deliver the initial callback satisfied the rule and broke the feature:
     * the observer's first callback arrives with the frame, and the padding stayed at 0. A ref
     * callback runs at commit, when the node exists and its box is known, which is exactly the
     * moment this question has an answer.
     *
     * Null means the readout unmounted, so the height goes back to 0 with it.
     */
    const measureReadout = useCallback((el: HTMLDivElement | null) => {
        readoutRef.current = el;
        setReadoutHeight(el ? el.getBoundingClientRect().height : 0);
    }, []);
    const hasCell = !!cell;
    // Everything AFTER the first: the sentence rewraps when the finding changes, the language
    // switches, or the pane narrows. The observer never needs to take the first reading.
    useEffect(() => {
        const el = readoutRef.current;
        if (!el) return;
        const ro = new ResizeObserver(() => setReadoutHeight(el.getBoundingClientRect().height));
        ro.observe(el);
        return () => ro.disconnect();
    }, [hasCell]);


    if (!shape.ready || !tuned || !report || !gainMap) {
        return (
            <div className="h-full w-full flex items-center justify-center p-4">
                <p className="text-[11px] text-slate-500 max-w-md text-center">{t.noRun}</p>
            </div>
        );
    }

    const pair = (now: number, was: number | undefined) =>
        was === undefined ? `${now}` : `${was} → ${now}`;

    return (
        <div className="h-full w-full flex flex-col">
            {/* TWO LINES, and the split is by KIND rather than to save width: the first line is
                what this pane IS — its name and where its explanation lives — and the second is
                what the data currently SAYS. They used to run together on one wrapping line, so
                the heading and three counts reflowed into each other and the eye had nothing
                stable to return to (operator, 2026-08-26).

                It also fixes the ⓘ's address. `ml-auto` on a wrapping flex row put it after
                whichever count happened to be last, which moved as the numbers changed width. On
                its own line it is always at the same corner. */}
            <div className="shrink-0 px-2 pt-1 flex items-center justify-between">
                <span className="text-[10px] font-mono font-bold tracking-widest text-slate-400">
                    {LABEL.title}
                </span>
                {/* A panel rather than a modal: the modal dimmed and blurred the whole screen
                    for a piece of reading ABOUT what was behind it, so the one thing it
                    explained was the one thing you could no longer see (operator, 2026-08-26).
                    Same shell as the grid's colour legend and the TUNED strip's panels. */}
                <span className="relative">
                    <button
                        type="button"
                        onClick={() => setAboutOpen(o => !o)}
                        aria-expanded={aboutOpen}
                        aria-label={LABEL.about}
                        className={`p-1.5 -mr-1.5 rounded transition-colors ${aboutOpen ? 'text-blue-400' : 'text-slate-500 hover:text-slate-300'}`}
                    >
                        <Info className="w-3.5 h-3.5" />
                    </button>
                    {aboutOpen && (
                        <div className="absolute top-full right-0 mt-1 z-30 w-[300px] max-w-[92vw] text-left
                                        bg-slate-900 border border-slate-700 rounded shadow-xl p-3 space-y-2.5
                                        max-h-[60vh] overflow-y-auto overscroll-contain font-sans normal-case whitespace-normal">
                            <Section title={t.aboutTitle} body={t.aboutBody} />
                            <Section title={t.fallingTitle} body={t.fallingBody} />
                            <Section title={t.jumpTitle} body={t.jumpBody} />
                            <Section title={t.introTitle} body={t.introBody} />
                            <Section title={t.remedyTitle} body={t.remedyBody} />
                            {/* Moved in from under the grid, where it was a permanent line of
                                prose under a picture (operator, 2026-08-26). It says how to READ
                                this pane, which is exactly what this panel is for. */}
                            <Section title={t.tapTitle}
                                body={`${t.intro(report.introduced)} ${t.tapBody}`} />
                            <p className="text-[9px] text-slate-600 font-mono">
                                {`STEP CAP ${opts.gainRatioMax.toFixed(1)}x  ·  MAX MOVE ${(opts.maxRepairFrac * 100).toFixed(0)} %`}
                            </p>
                        </div>
                    )}
                </span>
            </div>

            {/* The data state, on its own line under the heading. Mono, because every one of
                these is read off the table rather than being app furniture. */}
            <div className="shrink-0 flex flex-wrap items-center gap-x-3 gap-y-0.5 px-2 pb-1 text-[10px] font-mono [&>span]:whitespace-nowrap">
                <span className="text-red-400">{LABEL.falling} {pair(report.falling, baseReport?.falling)}</span>
                <span className="text-violet-300">{LABEL.jumps} {pair(report.gainJumps, baseReport?.gainJumps)}</span>
                <span className={report.introduced ? 'text-red-400 font-bold' : 'text-emerald-400'}>
                    {LABEL.introduced} {report.introduced}
                </span>
            </div>

            {/* `relative`, because the cell readout is an OVERLAY over the foot of this box
                rather than a row under it — see below. */}
            <div className="flex-1 min-h-0 relative">
                <MapEditor
                    mapData={gainMap}
                    zoom={zoom}
                    valueLabel={LABEL.gain}
                    onCellSelect={pick}
                    selected={selected}
                    bottomInset={cell ? readoutHeight : 0}
                    // Red for the impossible, violet for the arguable, and BOLD for the ones this
                    // tune made — the reader's eye should land on what they caused, not on what
                    // BMW shipped.
                    cellTint={cellTint}
                />

                {/*
                 * The same shape as the TUNED MAP's cell strip (operator, 2026-08-26), and its
                 * note carries the full argument. In one line: an overlay costs the grid no
                 * height, so nothing appears until a cell is picked AND the map does not move
                 * under the finger that picked it — the two properties a fixed-height row can only
                 * have one of.
                 *
                 * `pointer-events-none` because this is a readout and the cells beneath it are
                 * still the control; a strip that swallowed taps would make the bottom row of the
                 * map unselectable while it was open.
                 *
                 * What this pane's version had instead was a 46px box, always mounted, empty until
                 * a cell was picked — 46px of the grid spent on nothing, on the pane where the
                 * grid is the whole point.
                 */}
                {cell && (
                    <div ref={measureReadout} className="absolute inset-x-0 bottom-0 z-20 pointer-events-none
                                    border-t border-slate-700 bg-slate-900/95 backdrop-blur-[2px]
                                    px-2 py-1.5 text-[10px] leading-tight">
                        <div className="font-mono text-slate-400">
                            <span className="text-slate-500">
                                {tuned.xAxis[cell.col]} rpm · {tuned.yAxis[cell.row].toFixed(2)} %
                            </span>
                            <span className="ml-2">
                                {cell.gain === null ? '—' : `${LABEL.gain} ${cell.gain.toFixed(4)}`}
                                {cell.gainRatio !== null ? ` · ×${cell.gainRatio.toFixed(2)} vs below` : ''}
                            </span>
                            {cell.defect && (
                                <span className={`ml-2 font-bold ${cell.defect === 'falling' ? 'text-red-400' : 'text-violet-300'}`}>
                                    {cell.defect === 'falling'
                                        ? `${LABEL.falling} −${cell.fallBy.toFixed(3)}`
                                        : LABEL.jumps}
                                    {cell.introduced ? `  · ${LABEL.introduced}` : ''}
                                </span>
                            )}
                        </div>
                        {/* WHAT THE FINDING MEANS, in one line and in the reader's language —
                            the same shape as the TUNED strip, where the second line is the reason
                            rather than a repeat of the label. It WRAPS, which is the point of this
                            no longer being a fixed-height row: an overlay owes the grid no height,
                            so the sentence finishes instead of being cut. */}
                        {cell.defect && (
                            <div className="text-slate-500">
                                {cell.defect === 'falling' ? t.cellFalling : t.cellJump}
                            </div>
                        )}
                    </div>
                )}
            </div>

        </div>
    );
};

const Section: React.FC<{ title: string; body: string }> = ({ title, body }) => (
    <div className="space-y-0.5">
        <h4 className="text-[10px] font-bold tracking-wider text-slate-300">{title}</h4>
        <p className="text-[10px] leading-relaxed text-slate-400">{body}</p>
    </div>
);
