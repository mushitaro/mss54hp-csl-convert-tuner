'use client';

import React from 'react';

/**
 * One rpm column of `kf_rf_soll`, drawn as filling against throttle opening.
 *
 * ## Why a chart and not more numbers
 *
 * Every constraint the repair enforces is a statement about a LINE, and a grid of numbers is the
 * wrong instrument for judging one. "Filling must not fall as the throttle opens" is a slope you
 * can see at a glance and have to compute by eye from a column of decimals. So is whether a
 * proposed repair follows the shape of what was measured or bends away from it.
 *
 * This is also the only surface in the app where a parameter is adjusted against a continuous
 * result rather than against a verdict. The operator moves a bound and watches the violet line
 * move; that is the loop the request asked for, and a table cannot close it.
 *
 * ## Inline SVG rather than the chart library
 *
 * Plotly is already in the bundle for the log chart and the 3-D surface, and it is the right tool
 * there. Here it would be about sixty times the code weight for four polylines and no interaction,
 * inside a panel that re-renders on every drag of a slider. The axes are drawn from the data
 * because a fixed scale would flatten the low-opening rows into the baseline — which is exactly
 * where the tune's evidence is.
 *
 * ## The log-ish x axis
 *
 * The opening axis runs 0.098 to 100 %, and 24 of its breakpoints are below 5 %. Drawn linearly,
 * everything this tune touched would be a smear against the left edge. Positions come from the
 * axis INDEX instead, so every breakpoint gets equal width — the same spacing the table itself has,
 * and the same one the reader is looking at in the grid above.
 */

export interface ProfileSeries {
    /** One value per opening row, or null where the series has nothing to say there. */
    values: readonly (number | null)[];
    color: string;
    label: string;
    /** Drawn dashed. For a proposal, so it never reads as a measurement. */
    dashed?: boolean;
    width?: number;
}

export function ColumnProfile({ opening, series, anchors, height = 150, marked, onPick, xScale = 'even', zeroLine, width }: {
    /** The opening axis, for the tick labels. */
    opening: readonly number[];
    series: readonly ProfileSeries[];
    /** Rows the tune actually measured — drawn as dots, because they are the only points on this
     *  chart that came from the car rather than from arithmetic. */
    anchors?: readonly boolean[];
    height?: number;
    /**
     * Which point the grid has selected, drawn as a line down the chart.
     *
     * The chart shows one cut and the grid shows the whole table, so without this the reader has
     * the line but not their place on it.
     */
    marked?: number | null;
    /**
     * Tapping a point picks it — the chart is a control as well as a readout.
     *
     * The cut lives in the graph pane and the grid in the map pane, which on a phone are two
     * different screens: without this, moving one cell along the line you are reading means going
     * back for the grid and returning. The whole width is live, snapping to the nearest breakpoint,
     * because the points themselves are a few pixels apart at the bottom of the opening axis.
     */
    onPick?: (index: number) => void;
    /**
     * Where the points sit along the bottom.
     *
     * `even` gives every breakpoint the same width — the spacing the grid above has, and the only
     * one in which the low-opening rows are legible at all: 24 of the axis's points are below 5 %.
     * `scale` puts them at their real values, which is the only way to read a SLOPE off this chart,
     * because an even axis draws equal steps for intervals that are 0.05 % and 15 % wide.
     *
     * Two questions, two axes, and neither answers the other (operator, 2026-08-26).
     */
    xScale?: 'even' | 'scale';
    /**
     * Draw the zero line.
     *
     * For the gradient view, where zero is not a scale mark but the DEFECT boundary: below it,
     * filling falls as the throttle opens, which is the one test on this tab with no threshold. Off
     * for the value views, where the BASE series already draws its own reference.
     */
    zeroLine?: boolean;
    /**
     * The box to draw in, in real pixels.
     *
     * The viewBox is the measured box rather than a fixed 320 — with a fixed one, an SVG given
     * `w-full` AND a height letterboxes to preserve its aspect, so the chart drew at whatever size
     * the shorter dimension allowed and left the rest of the pane empty. Measured in the graph pane
     * at 375px that was 176px of drawing in a 240px box. One unit is one pixel now, and the caller
     * hands over the space it actually has (operator, 2026-08-26).
     */
    width?: number;
}) {
    const n = opening.length;
    const PAD = { l: 34, r: 6, t: 8, b: 16 };
    const W = width ?? 320;
    const innerW = W - PAD.l - PAD.r;
    const innerH = height - PAD.t - PAD.b;

    // With `preserveAspectRatio: none` the viewBox IS the box, so nothing is stretched: one unit
    // is one pixel in both directions and the type is drawn at the size it says.
    const all = series.flatMap(s => s.values.filter((v): v is number => v !== null && isFinite(v)));
    if (!all.length || n < 2) {
        return <div className="h-[150px] flex items-center justify-center text-[10px] text-slate-600">—</div>;
    }
    let min = Math.min(...all), max = Math.max(...all);
    // A flat column would divide by zero and, worse, would draw a line through the middle of an
    // empty box as though it meant something. Give it a visible band instead.
    if (max - min < 1e-9) { min -= 0.01; max += 0.01; }
    if (zeroLine) { min = Math.min(min, 0); max = Math.max(max, 0); }
    const pad = (max - min) * 0.08;
    min -= pad; max += pad;

    const xLo = opening[0], xHi = opening[n - 1];
    const xSpan = xHi - xLo;
    const x = (i: number) => (xScale === 'scale' && xSpan !== 0)
        ? PAD.l + (innerW * (opening[i] - xLo)) / xSpan
        : PAD.l + (innerW * i) / (n - 1);
    const y = (v: number) => PAD.t + innerH * (1 - (v - min) / (max - min));

    const path = (s: ProfileSeries) => {
        const parts: string[] = [];
        let pen = false;
        s.values.forEach((v, i) => {
            if (v === null || !isFinite(v)) { pen = false; return; }
            parts.push(`${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`);
            pen = true;
        });
        return parts.join(' ');
    };

    // Four ticks, and the value at each — enough to read a level off, few enough not to crowd a
    // 150px box on a phone.
    const ticks = [0, 1, 2, 3].map(k => min + ((max - min) * k) / 3);

    /** Nearest breakpoint to where the pointer landed, in the SVG's own coordinates. */
    const pickAt = (e: React.PointerEvent<SVGSVGElement>) => {
        if (!onPick) return;
        const r = e.currentTarget.getBoundingClientRect();
        if (r.width <= 0) return;
        const sx = ((e.clientX - r.left) / r.width) * W;
        // Nearest by DRAWN position, so the inversion follows the scale in force rather than
        // assuming the even one — on a to-scale axis those differ by most of the chart.
        let best = 0, bestD = Infinity;
        for (let i = 0; i < n; i++) {
            const d = Math.abs(x(i) - sx);
            if (d < bestD) { bestD = d; best = i; }
        }
        onPick(best);
    };

    return (
        <svg viewBox={`0 0 ${W} ${height}`} className={`block w-full ${onPick ? 'cursor-pointer touch-manipulation' : ''}`}
            style={{ height }} preserveAspectRatio="none" role="img" onPointerUp={pickAt}
            aria-label="Filling against throttle opening for the selected engine speed">
            {ticks.map((v, k) => (
                <g key={k}>
                    <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} stroke="#2A2A33" strokeWidth={0.5} />
                    <text x={PAD.l - 4} y={y(v) + 3} textAnchor="end" fontSize={8} fill="#4C4C58"
                        fontFamily="ui-monospace, monospace">
                        {v.toFixed(2)}
                    </text>
                </g>
            ))}
            {/* Opening labels at the ends and the middle only — the grid above carries the full axis. */}
            {[0, Math.floor((n - 1) / 2), n - 1].map(i => (
                <text key={i} x={x(i)} y={height - 4} textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}
                    fontSize={8} fill="#4C4C58" fontFamily="ui-monospace, monospace">
                    {opening[i] < 1 ? opening[i].toFixed(2) : opening[i].toFixed(0)}
                </text>
            ))}
            {series.map((s, k) => (
                <path key={k} d={path(s)} fill="none" stroke={s.color} strokeWidth={s.width ?? 1.5}
                    strokeDasharray={s.dashed ? '3 2' : undefined}
                    strokeLinejoin="round" strokeLinecap="round" />
            ))}
            {/* The defect boundary, drawn in the palette's danger red at a weight that reads as
                a rule rather than a series. */}
            {zeroLine && (
                <line x1={PAD.l} x2={W - PAD.r} y1={y(0)} y2={y(0)}
                    stroke="#F64A50" strokeWidth={0.75} strokeOpacity={0.6} strokeDasharray="4 3" />
            )}
            {/* Where the grid's selection sits on this line. Under the anchors and the traces, so
                it locates without hiding anything. */}
            {marked != null && marked >= 0 && marked < n && (
                <line x1={x(marked)} x2={x(marked)} y1={PAD.t} y2={height - PAD.b}
                    stroke="#F2F2F5" strokeWidth={1} strokeOpacity={0.5} />
            )}
            {/* The measured points, on top of every line: the only marks here that came from the car. */}
            {anchors && series[0] && anchors.map((a, i) => {
                const v = series.find(s => s.values[i] !== null)?.values[i];
                return a && v != null && isFinite(v)
                    ? <circle key={i} cx={x(i)} cy={y(v)} r={2.5} fill="#26AEE4" /> : null;
            })}
        </svg>
    );
}
