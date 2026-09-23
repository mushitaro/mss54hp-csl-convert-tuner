'use client';

import type { ReactElement } from 'react';
import {
    INSIDE_GUARD_STEP,
    INSIDE_PAD,
    type Inside,
    type InsideRow,
} from '@/lib/calibration-graph/inside-model';
import type { Token, TokenRole } from '@/lib/calibration-graph/expr-tokens';
import { t } from '@/lib/calibration-graph/calib-i18n';
import { LIT_STROKE, LIT_WIDTH, dim, isLit } from '@/lib/calibration-graph/focus';

/**
 * Inside one function — the picture, not the scroller.
 *
 * Drawn to the same rules as the network view next door, because they are the
 * same reader looking at the same code one level in: calibration is blue,
 * signals neutral, the picked quantity lights everywhere it appears, and values
 * travel right to left. Everything about zooming and panning belongs to
 * LogicDiagram, which owns the pane both pictures are drawn in — two copies of
 * that machinery would be two pinch gestures that behave slightly differently.
 */

const TOKEN_CLASS: Record<TokenRole, string> = {
    calib: 'fill-[#26AEE4]',
    helper: 'fill-slate-500',
    signal: 'fill-slate-300',
    symbol: 'fill-slate-400',
    number: 'fill-slate-400',
    plumbing: 'fill-slate-600',
    inferred: 'fill-slate-500 italic',
    op: 'fill-slate-500',
};

// `dim` and the accent live in `focus.ts`. They used to live here too, at
// 0.25, while NETWORK had drifted to 0.85 — the same selection, three views,
// three answers, and only the one that got complained about was fixed.

export function CalibrationInside({
    inside,
    lang,
    picked,
    onPick,
    canvasRef,
    width,
    height,
}: {
    inside: Inside;
    lang: 'ja' | 'en';
    picked: string | null;
    onPick: (name?: string) => void;
    canvasRef: React.Ref<SVGSVGElement>;
    /** Drawn size; the viewBox stays 1:1 so magnification changes layout size. */
    width: number;
    height: number;
}) {
    return (
        <svg
            ref={canvasRef}
            className="font-mono"
            width={width}
            height={height}
            viewBox={`0 0 ${inside.width} ${inside.height}`}
            role="img"
            aria-label={inside.block.label}
        >
            <defs>
                <marker
                    id="cal-inside-tick"
                    viewBox="0 0 7 7"
                    refX={6}
                    refY={3.5}
                    markerWidth={6}
                    markerHeight={6}
                    orient="auto-start-reverse"
                >
                    <path d="M0 0.5 L 7 3.5 L 0 6.5 z" fill="context-stroke" />
                </marker>
            </defs>

            {/* Conditions as containers. Drawn first, so the boxes they hold sit
                on top of them rather than being covered. */}
            {inside.frames.map((f, i) => (
                <g key={`f${i}`}>
                    <rect
                        x={f.x}
                        y={f.y}
                        width={f.w}
                        height={f.h}
                        rx={4}
                        className="fill-slate-900/40 stroke-slate-800"
                    />
                    <text className="fill-slate-500 italic text-[10.5px]" x={f.x + 8} y={f.y + 13}>
                        {/* The condition as decompiled, for checking the
                            reading against — the same courtesy the formula has. */}
                        <title>{`${t(lang, 'rawCondition')}: ${f.raw}`}</title>
                        {`if (${f.text})`}
                    </text>
                </g>
            ))}

            {/* One row handing a value to another. A `writes` link — successive
                values of ONE quantity — is the stronger claim and carries the
                stronger line, exactly as it does in the gutter next door. */}
            {inside.edges.map((e, i) => (
                <path
                    key={`e${i}`}
                    d={e.d}
                    className={`fill-none ${
                        isLit(picked, e.name)
                            ? LIT_STROKE
                            : e.kind === 'writes'
                              ? 'stroke-slate-500'
                              : 'stroke-slate-700'
                    }`}
                    strokeWidth={isLit(picked, e.name) ? LIT_WIDTH : undefined}
                    markerEnd="url(#cal-inside-tick)"
                    opacity={dim(picked, e.name)}
                />
            ))}

            {inside.rows.map(r => (
                <RowBox key={r.row} r={r} lang={lang} picked={picked} onPick={onPick} />
            ))}
        </svg>
    );
}

function RowBox({
    r,
    lang,
    picked,
    onPick,
}: {
    r: InsideRow;
    lang: 'ja' | 'en';
    picked: string | null;
    onPick: (name?: string) => void;
}) {
    const lit = Boolean(picked) && (r.out.name === picked || r.tokens.some(tk => tk.name === picked));
    const glossClipped = Boolean(r.glossFull && r.glossFull !== r.gloss);
    return (
        <g transform={`translate(${r.x} ${r.y})`}>
            <rect
                width={r.w}
                height={r.h}
                rx={4}
                className={
                    lit
                        ? 'fill-[#26AEE4]/10 stroke-[#26AEE4]'
                        : 'fill-slate-950 stroke-slate-700'
                }
                strokeWidth={lit ? 1.5 : 1}
            />
            {/* The statement's own number, matching the listing's. It is not an
                address — none is recoverable — but it is stable, so two people
                can say "line 7 of rf_soll_calc" and mean the same line. */}
            <text className="fill-slate-700 text-[9px]" x={r.w - 5} y={11} textAnchor="end">
                <title>{t(lang, 'lineNoHint')}</title>
                {r.row + 1}
            </text>
            {/* In `flow` the conditions ride on the box: a branch's rows are
                scattered across columns by what they depend on, so no frame
                could enclose them without enclosing most of the function. */}
            {r.guards.map((gd, i) => (
                <text
                    key={`g${i}`}
                    className="fill-slate-600 italic text-[10px]"
                    x={INSIDE_PAD}
                    y={INSIDE_PAD + i * INSIDE_GUARD_STEP + 11}
                >
                    <title>{`${t(lang, 'rawCondition')}: ${gd.raw}`}</title>
                    {`if (${gd.text})`}
                </text>
            ))}
            <Formula
                x={INSIDE_PAD}
                y={r.formulaY}
                out={r.out}
                tokens={r.tokens}
                title={r.raw}
                picked={picked}
                onPick={onPick}
            />
            {r.glossY !== null && r.gloss && (
                <text className="fill-slate-500 text-[10.5px]" x={INSIDE_PAD} y={r.glossY}>
                    {glossClipped && <title>{r.glossFull}</title>}
                    {r.gloss}
                </text>
            )}
        </g>
    );
}

/** `out = expr` from the tokens the layout measured — the picture's Formula. */
function Formula({
    x,
    y,
    out,
    tokens,
    title,
    picked,
    onPick,
}: {
    x: number;
    y: number;
    out: Token;
    tokens: Token[];
    title?: string;
    picked: string | null;
    onPick: (name?: string) => void;
}): ReactElement {
    const litClass = (name?: string) => (name && name === picked ? ' font-bold underline' : '');
    return (
        <text className="text-[11.5px]" x={x} y={y}>
            {title && <title>{title}</title>}
            <tspan
                className={`fill-blue-300 font-bold cursor-pointer${litClass(out.name)}`}
                opacity={dim(picked, out.name)}
                onClick={() => onPick(out.name)}
            >
                {out.text}
            </tspan>
            <tspan className="fill-slate-500"> = </tspan>
            {tokens.map((tk, i) => (
                <tspan
                    key={i}
                    className={`${tk.alt ? 'fill-amber-400' : TOKEN_CLASS[tk.role]}${litClass(tk.name)}${tk.name ? ' cursor-pointer' : ''}`}
                    opacity={tk.name ? dim(picked, tk.name) : 1}
                    onClick={tk.name ? () => onPick(tk.name) : undefined}
                >
                    {tk.title && <title>{tk.title}</title>}
                    {tk.text}
                </tspan>
            ))}
        </text>
    );
}
