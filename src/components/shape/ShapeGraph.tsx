'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { Info } from 'lucide-react';
import { ColumnProfile } from '@/components/ColumnProfile';
import { ChartLoading } from '@/components/ChartLoading';
import { LABEL, type ShapeWorkspace } from './shapeWorkspace';

const MapVisualizer = dynamic(
    () => import('@/components/MapVisualizer').then(m => m.MapVisualizer),
    { ssr: false, loading: () => <ChartLoading /> });

/**
 * The SHAPE tab's graph pane: the surface, or one cut through it.
 *
 * The column beside the grid was empty on this tab — every other one draws a surface there — while
 * the profile chart was wedged under the grid in the map pane, appearing and disappearing with the
 * selection. The two swapped (operator, 2026-08-26).
 *
 * ## They are the same object at two scales
 *
 * SURFACE draws the tune as it stands, repair included: the filling surface whose SHAPE this tab
 * exists to judge, so a kink shows up as a kink. PROFILE is one line through that surface, at the
 * selected column or row.
 *
 * ## What the line plots, and why GAIN leads
 *
 * The grid next door shows the GRADIENT, and the chart used to show the filling — the same object
 * in two quantities, so a cell the grid painted red had no counterpart on the chart at all
 * (operator, 2026-08-26). GAIN is the default now and it is the same number the grid holds, at the
 * same index: `cells[r].gain` is the interval above row r, and so is the point at index r here. A
 * red cell IS the point where this line crosses below zero, and the marker lands on both.
 *
 * The zero line is drawn for it because zero is a defect boundary rather than a scale mark. The
 * GAIN STEP rule gets no line: it is a ratio between neighbouring intervals, not a level, so it
 * reads as a kink in this line and there is nothing horizontal to draw for it.
 *
 * RF and % vs BASE remain, for the shape as the engine meets it and for judging a repair.
 *
 * The unit governs BOTH views (operator, 2026-08-26). They are the same object, and a unit that
 * applied to only one of them left the two answering different questions. GAIN and % vs BASE are
 * signed — zero is the interesting value in both — so the surface takes the diverging scale
 * centred there, where RF takes the sequential one.
 *
 * A gain SURFACE is a harsh picture: gains step 13x between their own intervals because the
 * opening axis does, so it is one ridge and a floor. That is an argument against making it the
 * only surface, which it is not, and no argument at all against offering it.
 *
 * ## The switch does not move on its own
 *
 * Tapping a cell does not flip this to PROFILE. A view that changes because you touched something
 * else is a view you stop trusting to stay where you put it, and on a phone the two are different
 * panes anyway. PROFILE with nothing selected says so and says where to pick one.
 *
 * ## The chart is a control
 *
 * A point on the profile IS a cell, so tapping one moves the selection to it — along the cut, so
 * the line under the finger stays the same line and only the marker moves. That is what keeps the
 * graph pane usable on a phone without going back for the grid every time: the operator's own
 * objection when this layout was proposed.
 */
export const ShapeGraph: React.FC<{
    shape: ShapeWorkspace;
    /** The surface to draw — the page's DEFERRED copy of `shape.surface`, so dragging a parameter
     *  does not rebuild a 480-point Plotly scene on every frame of the drag. */
    surface: ShapeWorkspace['surface'];
}> = ({ shape, surface }) => {
    const {
        t, tuned, ready, selected, cut, setCut, unit, setUnit,
        view, setView, xScale, setXScale, pickPinned,
        anchorCol, colShaped, seriesFor, base, shownRepair, pickAlongCut,
    } = shape;
    /** Local: it explains two switches, and a reader who opened it has read it. Nothing about the
     *  proposal depends on it, so it does not need to survive a pane switch the way the view does. */
    const [helpOpen, setHelpOpen] = useState(false);
    /**
     * The chart's real box.
     *
     * It drew at a fixed 150px inside whatever the pane gave it — a third of the height on a phone
     * and a fifth on a desk (operator, 2026-08-26). ColumnProfile takes real pixels now, so this
     * measures the box and hands it over. A ResizeObserver rather than a one-shot read because the
     * pane changes size on rotation, on the split-graph breakpoint, and when the parameter popover
     * opens over it.
     */
    const [box, setBox] = useState<{ w: number; h: number } | null>(null);
    const observer = useRef<ResizeObserver | null>(null);
    /**
     * A CALLBACK ref, not an effect keyed on the view.
     *
     * The box only exists once a cell is selected, and selecting one happens on the GRID — which
     * does not change `view`, so an effect keyed on it never re-ran and the chart kept the 150px
     * fallback. Reaching PROFILE with nothing picked and then picking is the ordinary path, so that
     * was most of the time (operator, 2026-08-26).
     *
     * A callback ref fires exactly when the node appears and disappears, which is the condition.
     */
    const boxRef = useCallback((el: HTMLDivElement | null) => {
        observer.current?.disconnect();
        observer.current = null;
        if (!el || typeof ResizeObserver === 'undefined') return;
        const ro = new ResizeObserver(([e]) => {
            const r = e.contentRect;
            setBox({ w: Math.round(r.width), h: Math.round(r.height) });
        });
        ro.observe(el);
        observer.current = ro;
    }, []);
    /** The last one outlives the component if it is not let go of. */
    useEffect(() => () => observer.current?.disconnect(), []);

    if (!ready || !tuned || !surface) return null;

    return (
        <div className="h-full w-full flex flex-col">
            {/* One row, every switch. The view pair is always here; the rest belong to the profile
                and appear with it, because they mean nothing to a surface.
                The house's tab: underline-active, never a filled pill. These two are the same kind
                of choice the tab bar above the map is, and they were the only tabs in the app drawn
                as chips (tsunagi-m-design → Tabs). The switches that BELONG to the profile — which
                way it cuts, which axes it is drawn on — are the same control one size down. */}
            {/* Room to breathe: gap-x-5 between the groups and gap-y-2 between the lines it wraps
                onto, against the 3/1 it had. Four switch groups on a phone WILL take two lines, and
                two lines that are tight against each other read as one crowded one. */}
            <div className="shrink-0 flex flex-wrap items-baseline gap-x-5 gap-y-2 px-3 pt-2 pb-0.5
                            border-b border-slate-800 text-[9px] font-mono [&_button]:whitespace-nowrap">
                <span className="flex items-baseline gap-4">
                    {([['surface', LABEL.viewSurface], ['profile', LABEL.viewProfile]] as const).map(([v, l]) => (
                        <Tab key={v} on={view === v} onClick={() => setView(v)} lead>{l}</Tab>
                    ))}
                </span>
                {view === 'profile' && (
                    <>
                        {/* Which way the chart cuts. Independent of which way the FILL runs, because
                            a fill in one direction shows up as a STEP in the other, and that is
                            exactly what you want to look at after applying one. */}
                        <span className="flex items-baseline gap-3">
                            {([['column', LABEL.viewCol], ['row', LABEL.viewRow]] as const).map(([v, l]) => (
                                <Tab key={v} on={cut === v} onClick={() => setCut(v)}>{l}</Tab>
                            ))}
                            {selected && (
                                <span className="text-slate-500">
                                    {cut === 'row'
                                        ? `${tuned.yAxis[selected.row].toFixed(2)} %`
                                        : `${tuned.xAxis[selected.col]} rpm`}
                                </span>
                            )}
                        </span>
                        {/* The X axis, then the Y one. Both answer "what is this plotted against",
                            and they are the two switches a reader reaches for after asking why a
                            line looks the way it does — so their explanations sit on the ⓘ beside
                            them rather than in a `title`, which has no hover on this screen. */}
                        <span className="flex items-baseline gap-3">
                            {([['even', LABEL.xEven], ['scale', LABEL.xScale]] as const).map(([v, l]) => (
                                <Tab key={v} on={xScale === v} onClick={() => setXScale(v)}>{l}</Tab>
                            ))}
                        </span>
                    </>
                )}
                {/* The unit governs both views: the surface and the cut are the same object, and a
                    unit that applied to only one of them left the two answering different questions
                    (operator, 2026-08-26). */}
                <span className="ml-auto flex items-baseline gap-3">
                            {([['gain', LABEL.unitGain], ['ratio', LABEL.unitRatio], ['value', LABEL.unitValue]] as const)
                                .map(([v, l]) => (
                                    <Tab key={v} on={unit === v} onClick={() => setUnit(v)}>{l}</Tab>
                                ))}
                            <span className="relative self-center">
                                <button
                                    type="button"
                                    onClick={() => setHelpOpen(o => !o)}
                                    aria-expanded={helpOpen}
                                    aria-label={LABEL.about}
                                    className={`p-1 -mr-1 rounded transition-colors ${helpOpen ? 'text-blue-400' : 'text-slate-600 hover:text-slate-400'}`}
                                >
                                    <Info className="w-3 h-3" />
                                </button>
                                {helpOpen && (
                                    <div className="absolute top-full right-0 mt-1 z-30 w-[280px] max-w-[92vw] text-left
                                                    bg-slate-900 rounded shadow-xl p-3 space-y-2.5
                                                    max-h-[60vh] overflow-y-auto overscroll-contain
                                                    font-sans normal-case whitespace-normal">
                                        {/* What the line IS, first — it was under the chart, and
                                            a paragraph under a chart is a paragraph in front of the
                                            chart when the pane is short (operator, 2026-08-26). */}
                                        {view === 'profile' && (
                                            <AxisHelp
                                                label={cut === 'row' ? LABEL.viewRow : LABEL.viewCol}
                                                body={cut === 'row' ? t.profileRow : t.profileCol} />
                                        )}
                                        {unit === 'gain' && view === 'profile' && (
                                            <AxisHelp label={LABEL.unitGain} body={t.gainZeroNote} />
                                        )}
                                        {view === 'profile' && (
                                            <AxisHelp label={`${LABEL.xEven} / ${LABEL.xScale}`} body={t.axisNote} />
                                        )}
                                        <AxisHelp
                                            label={`${LABEL.unitGain} / ${LABEL.unitRatio} / ${LABEL.unitValue}`}
                                            body={t.unitNote} />
                                    </div>
                                )}
                            </span>
                </span>
            </div>

            <div className="flex-1 min-h-0">
                {view === 'surface' ? (
                    <MapVisualizer
                        mapData={surface.grid} title="" zAxisLabel={surface.zLabel}
                        scale={surface.scale} deviationMidpoint={surface.midpoint} />
                ) : !selected ? (
                    <div className="h-full flex items-center justify-center px-6">
                        <p className="text-[10px] text-slate-600 text-center leading-relaxed">{t.pickForProfile}</p>
                    </div>
                ) : (
                    <div className="h-full flex flex-col px-1 pb-1">
                        {/* THE LEGEND IS THE READOUT, and it had to become one.
                            ────────────────────────────────────────────────────────────────────
                            The chart draws a marker line at the picked point and said nothing
                            about it: not which opening or rpm it stands at, and not what any of
                            the three lines is worth there. The CALIBRATION tab reads clearly for
                            exactly that reason — its pane carries the selected cell's value and
                            its pinned axis in text beside the picture — and on a phone the SHAPE
                            grid's own cell readout is on the OTHER pane, so it cannot stand in.

                            Three colours were already on this line naming three series. Putting
                            each one's value next to its own name costs no height and needs no
                            legend to read, and the point's own axis coordinate leads it: with
                            the slider below naming the axis being held still, the pair says where
                            the marker is in both directions. */}
                        {(() => {
                            const i = cut === 'row' ? selected.col : selected.row;
                            const at = cut === 'row'
                                ? `${tuned.xAxis[i]} rpm`
                                : `${tuned.yAxis[i].toFixed(2)} %`;
                            // Two decimals, the same as the chart's own y ticks — a readout that
                            // disagreed with the axis beside it would be two numbers for one value.
                            const fmt = (v: number | null | undefined) =>
                                v == null || !Number.isFinite(v) ? '—' : v.toFixed(2);
                            const val = (grid: readonly (readonly number[])[] | undefined) =>
                                fmt(seriesFor(grid)[i]);
                            return (
                                <div className="shrink-0 flex flex-wrap items-center gap-x-3 gap-y-0.5 px-2 py-1.5 text-[9px] font-mono">
                                    <span className="text-slate-300 font-bold">{at}</span>
                                    <span className="text-slate-600">■ {LABEL.base} {val(base?.data)}</span>
                                    <span className="text-blue-400">■ {LABEL.tunedS} {val(tuned.data)}</span>
                                    {colShaped && (
                                        <span className="text-violet-300">▨ {LABEL.shapedS} {val(shownRepair!.values)}</span>
                                    )}
                                </div>
                            );
                        })()}
                        <div ref={boxRef} className="flex-1 min-h-0">
                        <ColumnProfile
                            width={box?.w}
                            height={Math.max(120, box?.h ?? 150)}
                            opening={cut === 'row' ? tuned.xAxis : tuned.yAxis}
                            anchors={anchorCol}
                            marked={cut === 'row' ? selected.col : selected.row}
                            onPick={pickAlongCut}
                            xScale={xScale}
                            zeroLine={unit === 'gain'}
                            series={[
                                { values: seriesFor(base?.data), color: '#4C4C58', label: LABEL.base, width: 1 },
                                { values: seriesFor(tuned.data), color: '#26AEE4', label: LABEL.tunedS },
                                ...(colShaped
                                    ? [{
                                        values: seriesFor(shownRepair!.values), color: '#9B84E8',
                                        label: LABEL.shapedS, dashed: true,
                                    }]
                                    : []),
                            ]}
                        />
                        </div>

                        {/* THE AXIS THIS CUT IS PINNED AT, under the picture because it moves the
                            picture — the same place and the same shape as the CALIBRATION tab's
                            section slider, which is the control this one is modelled on.

                            Perpendicular to the chart's own axis: tapping a point on the line walks
                            ALONG it (`pickAlongCut`), and this walks BETWEEN lines. Cutting across a
                            row, that is which row; down a column, which column.

                            `h-6` is also the number ShapeControls adds to the phone popover's
                            offset, so SHAPE REPAIR opens above this rather than over it. */}
                        <div className="h-6 flex-none flex items-center gap-2 px-2">
                            <span className="text-[9px] font-mono text-slate-500 whitespace-nowrap">
                                {cut === 'row'
                                    ? `${LABEL.axisOpening} ${tuned.yAxis[selected.row].toFixed(2)} %`
                                    : `${LABEL.axisRpm} ${tuned.xAxis[selected.col]}`}
                            </span>
                            <input
                                type="range"
                                min={0}
                                max={Math.max(0, (cut === 'row' ? tuned.yAxis.length : tuned.xAxis.length) - 1)}
                                value={cut === 'row' ? selected.row : selected.col}
                                onChange={e => pickPinned(Number(e.target.value))}
                                aria-label={cut === 'row'
                                    ? 'Move the cut to another opening row'
                                    : 'Move the cut to another rpm column'}
                                className="flex-1 min-w-0 h-1 accent-blue-500"
                            />
                            <span className="text-[9px] font-mono text-slate-600 whitespace-nowrap">
                                {(cut === 'row' ? selected.row : selected.col) + 1}/{cut === 'row' ? tuned.yAxis.length : tuned.xAxis.length}
                            </span>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

/**
 * One tab, the app's own: underline-active, never a filled pill.
 *
 * `border-b-2` in both states so nothing shifts when the active one moves, and `transition` rather
 * than `transition-all` — the curated list covers colour and border-colour, which is all this
 * animates (tsunagi-m-design → Tabs, Motion).
 */
const Tab: React.FC<{
    on: boolean; onClick: () => void; lead?: boolean; children: React.ReactNode;
}> = ({ on, onClick, lead, children }) => (
    <button
        type="button"
        onClick={onClick}
        className={'pb-1 tracking-widest transition border-b-2 '
            + (lead ? 'font-bold ' : '')
            + (on ? 'text-blue-400 border-blue-400' : 'text-slate-600 hover:text-slate-300 border-transparent')}
    >
        {children}
    </button>
);

/** One switch pair's explanation, named by the two words on the switches. */
const AxisHelp: React.FC<{ label: string; body: string }> = ({ label, body }) => (
    <div className="space-y-0.5">
        <h4 className="text-[9px] font-bold tracking-widest text-slate-300 font-mono">{label}</h4>
        <p className="text-[10px] leading-relaxed text-slate-500">{body}</p>
    </div>
);
