'use client';

import React, { useMemo } from 'react';
import type { IdleSample } from '@/lib/dme-link/types';
import type { IdleTuneResult } from '@/lib/idle/types';
import type { IdleTables } from '@/lib/idle/idleTables';
import { admissionMask, idleGateNow } from '@/lib/idle/tuner';
import { useDialogLang } from '@/hooks/useDialogLang';

/**
 * THE PICTURE THIS SCREEN IS FOR — the governor's standing effort against time, and whether the
 * conditions that make it a measurement are being met RIGHT NOW.
 *
 * Rendered by IdleWorkflow into the VISUALIZATION pane, where every other tab's picture goes.
 *
 * ## It draws the LOG, and it no longer answers "am I being recorded"
 *
 * It carried a rail of gate chips and a HOLD countdown, and that was right while this was the IDLE
 * tab's own picture. It is not any more: the IDLE tab shows `IdleGauges`, every gate as a bar with
 * the live reading's position on it, and this moved to IDLE LOG where the log is. Keeping the rail
 * left the same seven gates on screen twice, in two visual languages, on two tabs — and on the tab
 * whose question is "what happened", not "what is happening".
 *
 * What is left is the trace, its readout, and the admission strip along the time axis.
 *
 * ## Why it is hand-drawn SVG and not Plotly
 *
 * One trace against one horizontal line, on a phone, in a car park, updating four times a second.
 * Plotly's first paint is measured in hundreds of milliseconds and its rebuild cost is the reason
 * `ux-patterns.md` has a chart-engineering section at all. This renders instantly and costs nothing.
 *
 * ## The two-layer split, which is what fixes the distortion
 *
 * The traces are in an SVG stretched with `preserveAspectRatio="none"` — right for a time series,
 * where x and y are unrelated quantities and both should fill the box. That stretch used to scale
 * the STROKES and the TEXT with it: on a tall narrow pane the lines came out fat and the labels
 * came out squashed, which is most of why this read as a sketch rather than an instrument.
 *
 * So the geometry is drawn with `vectorEffect="non-scaling-stroke"` and every glyph moved OUT of
 * the SVG into an HTML layer positioned in per cent. Text stays crisp at any pane shape, strokes
 * stay 1px, and the traces still fill the box.
 *
 * ## The colours are roles, not decoration
 *
 *   sum      slate-200, the brightest thing here. It IS the measurement — `md_llri + md_llra`,
 *            the quantity invariant to how long the engine has been idling.
 *   md_llri  indigo-400, the diagnostic role. A COMPONENT of the measurement, worth seeing
 *            separate from it because the gap between the two is the adaptation.
 *   target   blue-400, the primary/reference role, dashed. The single most important line here.
 *   dwells   ice blue — the OK/verified role, on the admission strip.
 *   refused  red-400, on the strip only. A window long enough to be judged, and thrown away.
 */

/** Nice-ish tick step for a range, in the 1/2/5 decades. */
function tickStep(span: number, want: number): number {
    const raw = span / Math.max(1, want);
    const mag = Math.pow(10, Math.floor(Math.log10(Math.max(1e-9, raw))));
    const n = raw / mag;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
}

const C = {
    sum: '#DFDFE6',       // slate-200 — the measurement
    llri: '#9B84E8',      // indigo-400 — diagnostic component
    target: '#26AEE4',    // blue-400 — the reference
    dwell: '#8FD8F2',     // ice blue — accepted / verified
    refused: '#F64A50',   // red-400 — judged and thrown away
    grid: '#2A2A33',      // slate-700
    base: '#17171C',      // slate-800 — the ribbon's unlit ground
};

/** Prose switches; instrument shorthand does not. The rule in lib/dialog-text.ts. */
/** Prose switches; instrument shorthand does not. The rule in lib/dialog-text.ts.
 *  Two strings: the rail that used every other key is gone — see the header. */
const TEXT = {
    ja: { noSamples: 'サンプルなし', waiting: 'MD_LLRI 待ち' },
    en: { noSamples: 'NO SAMPLES', waiting: 'WAITING FOR MD_LLRI' },
};

/** Reserved slots. Declared here so the plot between them is what is left, never what fits. */
const READOUT_H = 34;
/**
 * The admission strip, in PIXELS.
 *
 * It used to be 32 of the SVG's 1000 y-units, which the `preserveAspectRatio="none"` stretch scaled
 * with the pane — 16 px in a 500 px one, and on a run admitted end to end it drew as a solid bright
 * bar that read like an axis four times too thick. Six pixels is a strip. What it says is where it
 * changes colour, never how tall it is.
 */
const RIBBON_H = 6;

export const IdleTrace: React.FC<{
    samples: IdleSample[];
    result: IdleTuneResult | null;
    target: number;
    running?: boolean;
    /** The binary, for the one threshold the strip's own gate reads from it — the warm gate is
     *  `K_LFR_TMOT_ADAPT`, so without this the strip would light a different set from the census. */
    tables?: IdleTables | null;
}> = ({ samples, result, target, running, tables }) => {
    const lang = useDialogLang();
    const t = TEXT[lang === 'ja' ? 'ja' : 'en'];
    const pts = useMemo(() => samples.filter(s => s.mdLlri !== null), [samples]);

    /** Which samples the gates admitted, run-length encoded onto the time axis. */
    const admitted = useMemo(() => {
        if (samples.length < 2) return [];
        const mask = admissionMask(samples, tables ?? null);
        const segs: { a: number; b: number }[] = [];
        let start = -1;
        for (let i = 0; i < mask.length; i++) {
            if (mask[i] && start < 0) start = i;
            if (!mask[i] && start >= 0) { segs.push({ a: samples[start].time, b: samples[i - 1].time }); start = -1; }
        }
        if (start >= 0) segs.push({ a: samples[start].time, b: samples[samples.length - 1].time });
        return segs;
    }, [samples, tables]);

    /** What the gates say about the newest sample, and how long the open window has held. */
    const now = useMemo(() => idleGateNow(samples, tables ?? null), [samples, tables]);

    const geom = useMemo(() => {
        if (pts.length < 2) return null;
        const W = 1000;
        const H = 1000;
        const t0 = pts[0].time;
        const t1 = pts[pts.length - 1].time;
        const span = Math.max(1e-6, t1 - t0);
        const vals = pts.flatMap(s => [s.mdLlri as number, (s.mdLlri as number) + (s.mdLlra ?? 0)]);
        // The target is always in frame with a margin, so "how far off is it" is answerable
        // without reading a number — which is the whole job of this picture.
        const rawLo = Math.min(target - 2, ...vals);
        const rawHi = Math.max(target + 2, ...vals);
        // Asymmetric headroom, and deliberately: the legend sits top-right, so a trace that ran
        // along the frame's top edge would pass under it. 18 % up, 8 % down.
        const range = Math.max(1e-6, rawHi - rawLo);
        const lo = rawLo - range * 0.08;
        const hi = rawHi + range * 0.18;
        const x = (v: number) => ((v - t0) / span) * W;
        const y = (v: number) => H - ((v - lo) / Math.max(1e-6, hi - lo)) * H;
        const path = (get: (s: IdleSample) => number) =>
            pts.map((s, i) => `${i ? 'L' : 'M'}${x(s.time).toFixed(1)},${y(get(s)).toFixed(1)}`).join('');

        const step = tickStep(hi - lo, 4);
        const ticks: number[] = [];
        for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) ticks.push(v);

        const tStep = tickStep(span, 4);
        const tTicks: number[] = [];
        for (let v = Math.ceil(t0 / tStep) * tStep; v <= t1; v += tStep) tTicks.push(v);

        return {
            W, H, t0, t1, lo, hi, x, y, path, ticks, tTicks,
            pctY: (v: number) => `${(1 - (v - lo) / Math.max(1e-6, hi - lo)) * 100}%`,
            pctX: (v: number) => `${((v - t0) / span) * 100}%`,
        };
    }, [pts, target]);

    const last = pts[pts.length - 1];
    const err = result?.dwells.filter(d => !d.rejected).slice(-1)[0]?.error ?? null;

    /**
     * THE WINDOW STILL BEING HELD — not a verdict, and it must not be drawn as one.
     *
     * `findDwells` flushes at the end of the samples, so the window a driver is holding RIGHT NOW is
     * judged on every publish and comes back `too-short` until it is long enough. Painting that on
     * the ribbon put a red "thrown away" band under a HOLD bar that was telling the same driver to
     * keep going: two devices on one screen, disagreeing, about the only thing being asked of them.
     *
     * So while a run is going, the trailing window is drawn from `settledTail`'s own start in the
     * HOLD bar's own two colours — filling, then ready. Same source, so they cannot disagree. Once
     * the run stops, the last window IS a verdict and goes back to being drawn as one.
     */
    const openFrom = running && now && !now.blocking && now.startTime !== null ? now.startTime : null;
    const openReady = !!now && now.heldSec >= now.needSec;
    const lastIndex = samples.length - 1;

    return (
        <div className="relative h-full w-full">
            {/* THE READOUT. Its own row above the picture rather than floating over it, because
                the pane is short on a phone and a floating box would cover the trace it describes.
                Fixed height, so a value arriving cannot resize the chart under it. */}
            <IdleReadout last={last} target={target} err={err} running={running} />

            <div className="absolute inset-x-0" style={{ top: READOUT_H, bottom: RIBBON_H }}>
                {geom ? (
                    <>
                        <svg
                            viewBox={`0 0 ${geom.W} ${geom.H}`}
                            preserveAspectRatio="none"
                            className="absolute inset-0 h-full w-full"
                        >
                            {/* NO full-height band over the accepted windows.
                                It marked which parts of a run counted, and once a continuous idle
                                stopped being chopped into fragments it covered the whole plot — a
                                highlight over 100 % of the area highlights nothing and costs the
                                traces their contrast. The strip under the axis says the same thing
                                without fogging the picture, which is one device per meaning. */}
                            {/* Grid. Hairlines, not a cage — one device per edge. */}
                            {geom.ticks.map(v => (
                                <line key={v} x1={0} x2={geom.W} y1={geom.y(v)} y2={geom.y(v)}
                                    stroke={C.grid} strokeWidth={1} vectorEffect="non-scaling-stroke" />
                            ))}
                            {/* The target. */}
                            <line x1={0} x2={geom.W} y1={geom.y(target)} y2={geom.y(target)}
                                stroke={C.target} strokeWidth={1} strokeDasharray="5 4"
                                vectorEffect="non-scaling-stroke" />
                            {/* md_llri alone — the component. */}
                            <path d={geom.path(s => s.mdLlri as number)} fill="none" stroke={C.llri}
                                strokeWidth={1} opacity={0.75} vectorEffect="non-scaling-stroke" />
                            {/* The sum — the measurement. Brightest and thickest. */}
                            <path d={geom.path(s => (s.mdLlri as number) + (s.mdLlra ?? 0))} fill="none"
                                stroke={C.sum} strokeWidth={1.75} vectorEffect="non-scaling-stroke" />

                        </svg>

                        {/* THE GLYPH LAYER. Outside the stretched SVG so nothing is squashed. */}
                        <div className="pointer-events-none absolute inset-0 font-mono text-[8px] leading-none">
                            {geom.ticks.map(v => (
                                <span key={v} className="absolute left-1 -translate-y-1/2 text-slate-600"
                                    style={{ top: geom.pctY(v) }}>
                                    {v.toFixed(0)}
                                </span>
                            ))}
                            <span className="absolute left-1 -translate-y-1/2 font-bold"
                                style={{ top: geom.pctY(target), color: C.target }}>
                                {target.toFixed(1)}
                            </span>
                            {geom.tTicks.map(v => (
                                <span key={v} className="absolute bottom-0.5 -translate-x-1/2 text-slate-600"
                                    style={{ left: geom.pctX(v) }}>
                                    {v.toFixed(0)}s
                                </span>
                            ))}
                            {/* Units and legend, top-right, out of the trace's way. */}
                            <div className="absolute right-1 top-0.5 flex items-center gap-2.5 uppercase tracking-wider">
                                <Key color={C.sum} label="sum" />
                                <Key color={C.llri} label="md_llri" />
                                <Key color={C.target} label="target" dashed />
                                <span className="text-slate-600">Nm</span>
                            </div>
                        </div>
                    </>
                ) : (
                    <div className="flex h-full items-center justify-center font-mono text-[10px] text-slate-700">
                        {samples.length ? t.waiting : t.noSamples}
                    </div>
                )}
            </div>

            {/* ── THE ADMISSION STRIP ────────────────────────────────────────────────────────
                The run's gate history along the time axis: which stretches the gates admitted,
                which became a window, which window was thrown away.

                  slate-800   the gates refused this sample
                  ice 0.30    admissible, but not yet a judged window
                  red 0.55    a window long enough to be judged, and thrown away
                  ice 0.85    a window that counted

                In the HTML layer at a FIXED PIXEL HEIGHT, not in the stretched SVG. As 32 of the
                viewBox's 1000 units it scaled with the pane — 16 px in a 500 px pane — and on a run
                the gates admitted end to end it became one solid bright bar across the foot of the
                chart, which reads as an absurdly thick axis rather than as information. Six pixels
                is a strip; the information is in where it changes colour, never in how tall it is. */}
            <div className="absolute inset-x-0 bottom-0 overflow-hidden bg-slate-800"
                style={{ height: RIBBON_H }}>
                {geom && admitted.map((s, i) => (
                    <span key={`a${i}`} className="absolute inset-y-0"
                        style={{
                            left: geom.pctX(s.a), width: `${(geom.x(s.b) - geom.x(s.a)) / 10}%`,
                            background: C.dwell, opacity: 0.3,
                        }} />
                ))}
                {geom && result?.dwells
                    .filter(d => openFrom === null || d.endIndex !== lastIndex)
                    .map((d, i) => {
                        const a = samples[d.startIndex]?.time ?? geom.t0;
                        const b = samples[d.endIndex]?.time ?? geom.t0;
                        return (
                            <span key={`d${i}`} className="absolute inset-y-0"
                                style={{
                                    left: geom.pctX(a), width: `${(geom.x(b) - geom.x(a)) / 10}%`,
                                    background: d.rejected ? C.refused : C.dwell,
                                    opacity: d.rejected ? 0.55 : 0.85,
                                }} />
                        );
                    })}
                {geom && openFrom !== null && (
                    <span className="absolute inset-y-0"
                        style={{
                            left: geom.pctX(openFrom),
                            width: `${(geom.x(geom.t1) - geom.x(openFrom)) / 10}%`,
                            background: openReady ? C.dwell : C.target, opacity: openReady ? 0.85 : 0.6,
                        }} />
                )}
            </div>
        </div>
    );
};

const Key: React.FC<{ color: string; label: string; dashed?: boolean }> = ({ color, label, dashed }) => (
    <span className="flex items-center gap-1 text-slate-500">
        <span className="inline-block h-0 w-3" style={{ borderTop: `${dashed ? '1px dashed' : '2px solid'} ${color}` }} />
        {label}
    </span>
);

/**
 * The idle run's own readout — what LiveTelemetryStrip is for a VE drive.
 *
 * A separate component and not a mode of that one: they share no channel. That strip reads
 * `useLiveReadout(liveRun.readout)`, which an idle run never feeds, so in IDLE mode it rendered
 * seven dashes and a zero — an instrument reporting nothing, over the one picture that mattered.
 *
 * `ERR` is the whole point and sits in the accent: it is the number the write is derived from.
 * Everything else is context for it. Fixed cells, so a channel arriving cannot reflow the row.
 */
const IdleReadout: React.FC<{
    last: IdleSample | undefined;
    target: number;
    err: number | null;
    running?: boolean;
}> = ({ last, target, err, running }) => {
    const sum = last && last.mdLlri !== null ? last.mdLlri + (last.mdLlra ?? 0) : null;
    const cells: { label: string; value: string; color: string }[] = [
        { label: 'N', value: last?.rpm != null ? last.rpm.toFixed(0) : '—', color: 'text-slate-200' },
        { label: 'MD_LLRI', value: last?.mdLlri != null ? last.mdLlri.toFixed(2) : '—', color: 'text-indigo-400' },
        { label: 'MD_LLRA', value: last?.mdLlra != null ? last.mdLlra.toFixed(2) : '—', color: 'text-indigo-400' },
        { label: 'SUM', value: sum != null ? sum.toFixed(2) : '—', color: 'text-slate-200' },
        // Against the target, which is what every gate here is about.
        { label: 'ERR', value: sum != null ? (sum - target >= 0 ? '+' : '') + (sum - target).toFixed(2) : '—', color: 'text-blue-400' },
        { label: 'LLS_TV', value: last?.llsTv != null ? `${last.llsTv.toFixed(1)}` : '—', color: 'text-slate-400' },
        { label: 'ML_LL', value: last?.mlSollLls != null ? last.mlSollLls.toFixed(1) : '—', color: 'text-slate-400' },
        // The DWELL error, once a window has been accepted — the figure the correction uses, as
        // opposed to the instantaneous ERR beside it. Dash until one lands, never a zero.
        { label: 'DWELL', value: err != null ? (err >= 0 ? '+' : '') + err.toFixed(2) : '—', color: 'text-blue-400' },
    ];
    return (
        /**
         * EIGHT cells, not ten, and the two that went are the two this screen already said.
         *
         * TMOT is an admission GATE and reads `85°` on the rail's own chip; SAMP is in the panel's
         * header. Ten columns on a 375 px phone left 28 px a cell, which is not enough for a
         * five-character number: `-3.92` came out as `-3.…`. A truncated reading is worse than an
         * absent one, and a value shown twice is two readouts that look like one — the same rule
         * that took the START button off the panel.
         */
        <div className={`absolute inset-x-0 top-0 z-20 grid h-[34px] grid-cols-8 items-center gap-x-1.5 border-b border-slate-800 bg-slate-950/85 px-2 font-mono min-[900px]:backdrop-blur-sm ${running ? '' : 'opacity-80'}`}>
            {/* `min-w-0` and `truncate` together, or the labels do not shrink: a grid track's default
                `minmax(auto, ...)` floors each cell at its content, so at 375 px `MD_LLRI MD_LLRA SUM`
                overflowed its column and ran into the next one instead of clipping. */}
            {cells.map(c => (
                <div key={c.label} className="flex min-w-0 flex-col leading-none">
                    <span className="truncate text-[8px] uppercase tracking-wider text-slate-600">{c.label}</span>
                    <span className={`truncate text-[11px] font-bold ${c.color}`}>{c.value}</span>
                </div>
            ))}
        </div>
    );
};
