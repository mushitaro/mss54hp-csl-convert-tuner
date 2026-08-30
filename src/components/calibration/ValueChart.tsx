'use client';

import React from 'react';

/**
 * The calibration data drawn rather than tabulated, in the two flat forms:
 * MAP is the field seen from above, 2D is one section through it. (3-D is the
 * shared Plotly surface — see ValuePane.)
 *
 * Fed from the LOADED BINARY's decode, never from the graph's baked numbers,
 * and drawn as plain SVG so it costs nothing to mount beside the diagram.
 */

const PAD_L = 46;
const PAD_R = 12;
const PAD_T = 10;
const PAD_B = 28;

export function fmtValue(v: number | null): string {
    if (v === null || !Number.isFinite(v)) return '—';
    if (Number.isInteger(v)) return String(v);
    return v.toFixed(Math.abs(v) < 1 ? 3 : 2).replace(/0+$/, '').replace(/\.$/, '');
}

function extent(values: number[]): [number, number] {
    const finite = values.filter(Number.isFinite);
    if (!finite.length) return [0, 1];
    const lo = Math.min(...finite);
    const hi = Math.max(...finite);
    return lo === hi ? [lo - 1, hi + 1] : [lo, hi];
}

/**
 * Dark sequential ramp inside the M-blue: #06354E → #0A9BDB → #B6E4F5.
 * The TABLE's heat underlay uses the same function, so the two views agree
 * about which end is hot.
 */
const RAMP: Array<[number, number, number]> = [
    [0x06, 0x35, 0x4E],
    [0x0A, 0x9B, 0xDB],
    [0xB6, 0xE4, 0xF5],
];

export function heat(v: number, lo: number, hi: number): string {
    if (!Number.isFinite(v) || hi === lo) return '#0A0A0D';
    const r = Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
    const seg = r < 0.5 ? 0 : 1;
    const f = (r - seg * 0.5) * 2;
    const mix = (i: number) => Math.round(RAMP[seg][i] + (RAMP[seg + 1][i] - RAMP[seg][i]) * f);
    return `rgb(${mix(0)}, ${mix(1)}, ${mix(2)})`;
}

/**
 * A signed quantity — a difference — on the house's diverging convention:
 * blue below, red above, both fading to the panel at zero. Anchored on 0
 * rather than on the data's own range, because "no change" has to look like
 * nothing whichever way the rest of the field leans.
 */
export function signedHeat(v: number, maxAbs: number): string {
    if (!Number.isFinite(v) || v === 0 || maxAbs === 0) return '#0A0A0D';
    const a = Math.min(0.75, Math.max(0.12, (Math.abs(v) / maxAbs) * 0.75));
    return `rgba(${v > 0 ? '241, 26, 34' : '10, 155, 219'}, ${a})`;
}

/** A constant has no shape to draw; the number is the whole story. */
export function ScalarReadout({ value, raw, units }: { value: number | null; raw: number; units?: string }) {
    return (
        <div className="flex items-baseline gap-2 p-3">
            <span className="text-2xl font-mono text-blue-400">{fmtValue(value)}</span>
            {units && units !== '-' && (
                <span className="text-[10px] text-slate-600 uppercase tracking-widest">{units}</span>
            )}
            <span className="text-[9px] font-mono text-slate-600">raw {raw}</span>
        </div>
    );
}

/**
 * The map as a field of colour, seen from above — the shape at a glance.
 *
 * Clicking a cell moves the shared selection, so the section below, the table
 * and the cell editor are all looking at the same place. One window, one index.
 */
export function HeatField({
    grid,
    xLabel,
    yLabel,
    xLabels,
    yLabels,
    selected,
    onSelectCell,
    signed,
    width,
    height,
}: {
    grid: number[][];
    xLabel: string;
    yLabel: string;
    xLabels: (i: number) => string;
    yLabels: (i: number) => string;
    selected: { row: number; col: number } | null;
    onSelectCell: (row: number, col: number) => void;
    /** The grid holds differences: colour diverging from zero, not sequential. */
    signed?: boolean;
    width: number;
    height: number;
}) {
    const rows = grid.length;
    const cols = grid[0]?.length ?? 0;
    const flat = grid.flat();
    const [lo, hi] = extent(flat);
    const maxAbs = Math.max(...flat.filter(Number.isFinite).map(Math.abs), 0);
    const fill = (v: number) => (signed ? signedHeat(v, maxAbs) : heat(v, lo, hi));
    const fieldH = Math.max(80, height - PAD_T - PAD_B);
    const cw = (width - PAD_L - PAD_R) / Math.max(1, cols);
    const ch = fieldH / Math.max(1, rows);

    return (
        <svg
            className="font-mono"
            viewBox={`0 0 ${width} ${fieldH + PAD_T + PAD_B}`}
            width="100%"
            height={fieldH + PAD_T + PAD_B}
        >
            {grid.map((r, ri) =>
                r.map((v, ci) => (
                    <rect
                        key={`${ri}-${ci}`}
                        x={PAD_L + ci * cw}
                        y={PAD_T + ri * ch}
                        width={cw + 0.5}
                        height={ch + 0.5}
                        fill={fill(v)}
                        className="cursor-pointer"
                        onClick={() => onSelectCell(ri, ci)}
                    >
                        <title>{`${yLabel} ${yLabels(ri)} · ${xLabel} ${xLabels(ci)} → ${fmtValue(v)}`}</title>
                    </rect>
                )),
            )}
            {selected && (
                /* The pointer is slate-100 — never an accent. */
                <rect
                    className="fill-none stroke-slate-100 pointer-events-none"
                    strokeWidth={1.2}
                    x={PAD_L + selected.col * cw}
                    y={PAD_T + selected.row * ch}
                    width={cw}
                    height={ch}
                />
            )}
            <text className="fill-slate-500 text-[9.5px]" x={PAD_L - 5} y={PAD_T + 9} textAnchor="end">
                {yLabels(0)}
            </text>
            <text className="fill-slate-500 text-[9.5px]" x={PAD_L - 5} y={PAD_T + fieldH} textAnchor="end">
                {yLabels(rows - 1)}
            </text>
            <text className="fill-slate-500 text-[10px]" x={2} y={PAD_T - 1}>{yLabel}</text>
            <text className="fill-slate-500 text-[10px]" x={width - PAD_R} y={fieldH + PAD_T + 14} textAnchor="end">
                {xLabel}
            </text>
        </svg>
    );
}

/**
 * One section, as a line — and the reference beside it when the compare bar
 * names a different one, which is what makes "what did this change" readable
 * without arithmetic.
 */
export function SectionChart({
    xs,
    xLabels,
    subject,
    reference,
    xLabel,
    yLabel,
    selectedIndex,
    onSelectIndex,
    width,
    height,
}: {
    xs: number[];
    xLabels: (i: number) => string;
    subject: number[];
    /** Null when subject and reference are the same variant. */
    reference: number[] | null;
    xLabel: string;
    yLabel: string;
    selectedIndex: number | null;
    onSelectIndex: (i: number) => void;
    width: number;
    height: number;
}) {
    const [xLo, xHi] = extent(xs);
    const [yLo, yHi] = extent([...subject, ...(reference ?? [])]);
    const px = (v: number) => PAD_L + ((v - xLo) / (xHi - xLo)) * (width - PAD_L - PAD_R);
    const py = (v: number) => height - PAD_B - ((v - yLo) / (yHi - yLo)) * (height - PAD_B - PAD_T);
    const path = (ys: number[]) => ys
        .map((y, i) => (Number.isFinite(y) ? `${i === 0 ? 'M' : 'L'} ${px(xs[i]).toFixed(1)} ${py(y).toFixed(1)}` : ''))
        .filter(Boolean)
        .join(' ');
    const ticks = 4;

    return (
        <svg className="font-mono" viewBox={`0 0 ${width} ${height}`} width="100%" height={height}>
            <line x1={PAD_L} y1={PAD_T} x2={PAD_L} y2={height - PAD_B} className="stroke-slate-700" />
            <line x1={PAD_L} y1={height - PAD_B} x2={width - PAD_R} y2={height - PAD_B} className="stroke-slate-700" />
            {Array.from({ length: ticks + 1 }, (_, i) => {
                const v = yLo + ((yHi - yLo) * i) / ticks;
                const y = height - PAD_B - ((height - PAD_B - PAD_T) * i) / ticks;
                return (
                    <g key={i}>
                        <line x1={PAD_L} y1={y} x2={width - PAD_R} y2={y} className="stroke-slate-800" />
                        <text className="fill-slate-500 text-[9.5px]" x={PAD_L - 5} y={y + 3} textAnchor="end">
                            {fmtValue(v)}
                        </text>
                    </g>
                );
            })}

            {/* Reference first, so the subject draws over it. */}
            {reference && (
                <path className="fill-none stroke-indigo-400" strokeWidth={1.2} strokeDasharray="4 3" d={path(reference)} />
            )}
            <path className="fill-none stroke-[#26AEE4]" strokeWidth={1.5} d={path(subject)} />

            {subject.map((y, i) => (Number.isFinite(y) ? (
                <circle
                    key={i}
                    className={`cursor-pointer ${selectedIndex === i ? 'fill-slate-100' : 'fill-[#8FD8F2]'}`}
                    cx={px(xs[i])}
                    cy={py(y)}
                    r={selectedIndex === i ? 3.4 : 2.4}
                    onClick={() => onSelectIndex(i)}
                >
                    <title>{`${xLabel} ${xLabels(i)} → ${fmtValue(y)}${reference ? `  (ref ${fmtValue(reference[i])})` : ''}`}</title>
                </circle>
            ) : null))}

            {xs.length > 0 && (
                <>
                    <text className="fill-slate-500 text-[9.5px]" x={PAD_L} y={height - PAD_B + 14} textAnchor="start">
                        {xLabels(0)}
                    </text>
                    <text className="fill-slate-500 text-[9.5px]" x={width - PAD_R} y={height - PAD_B + 14} textAnchor="end">
                        {xLabels(xs.length - 1)}
                    </text>
                </>
            )}
            <text className="fill-slate-500 text-[10px]" x={width - PAD_R} y={height - 3} textAnchor="end">{xLabel}</text>
            <text className="fill-slate-500 text-[10px]" x={2} y={PAD_T + 4}>{yLabel}</text>
        </svg>
    );
}
