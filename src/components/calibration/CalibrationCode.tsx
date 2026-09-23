'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CodeLine, CodeListing } from '@/lib/calibration-graph/code-model';
import type { TokenRole } from '@/lib/calibration-graph/expr-tokens';
import { t } from '@/lib/calibration-graph/calib-i18n';
import { LIT_STROKE, LIT_WIDTH, dim, isLit } from '@/lib/calibration-graph/focus';

/**
 * The listing view — the same recovered code read top to bottom.
 *
 * Only the rows on screen are in the DOM. `ds2_handler` at DEPTH 3 with SHOW
 * ALL lists 610 blocks and 3,995 statements, and every statement is a row of a
 * dozen or so coloured spans; drawing all of them is roughly a hundred thousand
 * nodes, which React will build and the browser will then scroll badly. Every
 * entry in the model is exactly one line tall, so which rows are on screen is
 * arithmetic rather than measurement.
 *
 * Three things sit outside that stack of rows, and each is here because a flat
 * run of lines could not say it:
 *
 *   - the **heading that follows the scroll**, so "which function am I in" has
 *     an answer three hundred lines into one;
 *   - the **gutter rails**, which are `rowLinks` — the same relations the
 *     picture draws inside a box, in the same lanes;
 *   - the **ring bands**, which say how far from the subject you have walked.
 */
const ROW = 18;
/** Rows kept beyond each edge, so a fast scroll does not show empty space. */
const OVERSCAN = 12;
/** One level of `if` nesting, in characters. */
const INDENT = 4;
/** One monospace character, in pixels, at this pane's 11.5px type. */
const CH = 6.9;
/** Gutter geometry for the rails, and the line-number column beside them. */
const LANE = 4;
const LANE_PAD = 6;
const NUM_W = 26;

const TOKEN_CLASS: Record<TokenRole, string> = {
    calib: 'text-[#26AEE4]',
    helper: 'text-slate-500',
    signal: 'text-slate-300',
    symbol: 'text-slate-400',
    number: 'text-slate-400',
    plumbing: 'text-slate-600',
    inferred: 'text-slate-500 italic',
    op: 'text-slate-500',
};

// `dim` and the accent live in `focus.ts` — see the note there about the three
// copies of this rule that had drifted to three different numbers.

export function CalibrationCode({
    listing,
    lang,
    picked,
    onPick,
    onOpen,
    focusTarget,
}: {
    listing: CodeListing;
    lang: 'ja' | 'en';
    picked: string | null;
    onPick: (name?: string) => void;
    /** Pressing a block heading, or a cross-reference, moves the subject. */
    onOpen: (target: string) => void;
    /** The node the picture is drawn around, marked in the listing to match. */
    focusTarget?: string;
}) {
    const scroller = useRef<HTMLDivElement>(null);
    const [range, setRange] = useState({ from: 0, to: 60 });

    const measure = useCallback(() => {
        const el = scroller.current;
        if (!el) return;
        const first = Math.floor(el.scrollTop / ROW);
        const visible = Math.ceil(el.clientHeight / ROW);
        setRange(prev => {
            const from = Math.max(0, first - OVERSCAN);
            const to = Math.min(listing.lines.length, first + visible + OVERSCAN);
            return prev.from === from && prev.to === to ? prev : { from, to };
        });
    }, [listing.lines.length]);

    // Measured before the first paint, and again whenever the pane changes:
    // a window computed from a zero height would render one row and stop.
    useEffect(() => {
        measure();
        const el = scroller.current;
        if (!el) return;
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        return () => ro.disconnect();
    }, [measure]);

    // The document changed shape; re-measure which rows are on screen.
    useEffect(() => {
        measure();
    }, [listing, measure]);


    // A new SUBJECT is a different document, so start at the top of it.
    // Rebuilding the SAME document around the same subject is not: DEPTH, ALL,
    // PLUMBING and RAW all rebuild `listing`, and sending the reader back to
    // line 1 of eight thousand for that is this pane's own version of the
    // canvas jumping.
    // `measure` is deliberately NOT a dependency, and that is the whole point:
    // it closes over `listing.lines.length`, so it takes a new identity every
    // time the listing is rebuilt — which is exactly the four controls this
    // must ignore. Listing it put the reset back for all of them. Nothing is
    // measured here either: moving the scroll raises a scroll event, and a new
    // subject is always a new listing, which the effect above already measures.
    useEffect(() => {
        const el = scroller.current;
        if (el) el.scrollTop = 0;
    }, [focusTarget]);

    /** Width the rails and the line numbers take before the code begins. */
    const gutter = (listing.lanes ? listing.lanes * LANE + LANE_PAD : 0) + NUM_W;
    const railsRight = Math.max(0, gutter - NUM_W - 2);

    // The window is a view of THIS listing, so it is clamped to THIS listing —
    // here, in the render, not in `measure`.
    //
    // `range` is state. When a shorter listing arrives, the render that draws
    // it still holds the window measured on the old one, and `measure` only
    // catches up in an effect afterwards. That render read past the end of
    // `lines`, handed `Row` an `undefined`, and the exception took the whole
    // app down: scroll a long listing, then pick a parameter with a short one
    // — `kf_rf_soll_kath` at line 500, then `KF_TI_N_RF`, was enough.
    const from = Math.min(range.from, Math.max(0, listing.lines.length - 1));
    const to = Math.min(range.to, listing.lines.length);

    /**
     * The block the first visible line is inside.
     *
     * Binary search over the spans the model already recorded — the alternative
     * is scanning back up the lines on every scroll, which on an eight-thousand
     * line listing is the work the virtualisation exists to avoid.
     */
    const inBlock = useMemo(() => {
        const spans = listing.spans;
        let lo = 0;
        let hi = spans.length - 1;
        let found = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (spans[mid].at <= from) {
                found = mid;
                lo = mid + 1;
            } else hi = mid - 1;
        }
        if (found < 0) return null;
        const span = spans[found];
        // Only when the real heading has scrolled off. While it is on screen a
        // pinned copy of it is the same line drawn twice.
        if (from <= span.at || from >= span.end) return null;
        const line = listing.lines[span.at];
        return line.kind === 'block' ? line : null;
    }, [listing, from]);

    const rows = [];
    for (let i = from; i < to; i++) {
        rows.push(
            <Row
                key={i}
                line={listing.lines[i]}
                top={i * ROW}
                gutter={gutter}
                lang={lang}
                picked={picked}
                onPick={onPick}
                onOpen={onOpen}
                focusTarget={focusTarget}
            />,
        );
    }

    // What this listing is, and what it cannot say — a reading of statements
    // that carry conditions, not a recovered control flow — used to be a fourth
    // reserved row INSIDE this pane, which made the canvas 22px shorter in CODE
    // than in the other two views and moved everything below it on every
    // switch. It is carried by the shared honesty line now.
    return (
        <div className="relative h-full min-h-0">
                <div
                    ref={scroller}
                    onScroll={measure}
                    className="absolute inset-0 overflow-auto font-mono text-[11.5px] leading-[18px]"
                >
                    <div
                        style={{
                            height: listing.lines.length * ROW,
                            position: 'relative',
                            minWidth: '100%',
                            width: 'max-content',
                        }}
                    >
                        <Rails listing={listing} range={{ from, to }} right={railsRight} picked={picked} />
                        {rows}
                    </div>
                </div>
                {/* Which function the top of the pane is inside. Outside the
                    scroller, so it does not move with it. */}
                {inBlock && (
                    <div
                        className="pointer-events-none absolute inset-x-0 top-0 h-[18px] flex items-center gap-2 border-b border-slate-800 bg-slate-900/95 px-2 font-mono text-[11.5px] whitespace-nowrap"
                        aria-hidden
                    >
                        <span className="font-bold text-slate-400">{inBlock.label}</span>
                        <span className="text-[9px] text-slate-600">{inBlock.statements}</span>
                    </div>
                )}
        </div>
    );
}

/**
 * The relations between rows, in the gutter.
 *
 * One SVG covering the visible window only. A single element spanning the whole
 * listing would be 147,000px tall with several thousand paths in it, which is
 * the cost the row virtualisation was built to avoid — reintroducing it under
 * the rows would have made the listing scroll worse than before the rails.
 */
function Rails({
    listing,
    range,
    right,
    picked,
}: {
    listing: CodeListing;
    range: { from: number; to: number };
    right: number;
    picked: string | null;
}) {
    if (!listing.lanes) return null;
    const top = range.from * ROW;
    const height = (range.to - range.from) * ROW;
    /** A value leaves a row from under its name and arrives over the one that
     *  reads it — the same convention the picture's own gutter uses. */
    const leaves = (i: number) => i * ROW + 14 - top;
    const arrives = (i: number) => i * ROW + 5 - top;
    const laneX = (lane: number) => 3 + lane * LANE;

    const visible = listing.rails.filter(
        r => r.from < range.to && Math.max(r.from, ...r.to) >= range.from,
    );
    if (!visible.length) return null;

    return (
        <svg
            className="pointer-events-none absolute left-0"
            style={{ top, width: right + 2, height }}
            width={right + 2}
            height={height}
            aria-hidden
        >
            <defs>
                <marker
                    id="cal-code-tick"
                    viewBox="0 0 6 6"
                    refX={5}
                    refY={3}
                    markerWidth={5}
                    markerHeight={5}
                    orient="auto-start-reverse"
                >
                    <path d="M0 0.5 L 6 3 L 0 5.5 z" fill="context-stroke" />
                </marker>
            </defs>
            {visible.map((r, i) => {
                // A `writes` link — several rows that are successive values of
                // one quantity — is the stronger claim of the two and carries
                // the stronger line, exactly as it does in the picture.
                const stroke = isLit(picked, r.name)
                    ? LIT_STROKE
                    : r.kind === 'writes'
                      ? 'stroke-slate-500'
                      : 'stroke-slate-700';
                const width = isLit(picked, r.name) ? LIT_WIDTH : undefined;
                const o = dim(picked, r.name);
                const x = laneX(r.lane);
                const last = Math.max(...r.to);
                return (
                    <g key={i}>
                        <path
                            d={`M ${right} ${leaves(r.from)} H ${x} V ${arrives(last)}`}
                            className={`fill-none ${stroke}`}
                            strokeWidth={width}
                            opacity={o}
                        />
                        {r.to.map((line, k) => (
                            <path
                                key={k}
                                d={`M ${x} ${arrives(line)} H ${right}`}
                                className={`fill-none ${stroke}`}
                                strokeWidth={width}
                                markerEnd="url(#cal-code-tick)"
                                opacity={o}
                            />
                        ))}
                    </g>
                );
            })}
        </svg>
    );
}

const RING_KEY = {
    subject: 'ringSubject',
    upstream: 'ringUpstream',
    downstream: 'ringDownstream',
} as const;

function Row({
    line,
    top,
    gutter,
    lang,
    picked,
    onPick,
    onOpen,
    focusTarget,
}: {
    line: CodeLine;
    top: number;
    gutter: number;
    lang: 'ja' | 'en';
    picked: string | null;
    onPick: (name?: string) => void;
    onOpen: (target: string) => void;
    focusTarget?: string;
}) {
    const style = { top, height: ROW, position: 'absolute' as const, left: 0, right: 0 };
    const pad = (depth: number) => ({ paddingLeft: `${gutter + depth * INDENT * CH}px` });

    if (line.kind === 'ring') {
        // How far out from the subject this stretch of the listing is. The
        // first band is the thing that was picked; the rest are steps away from
        // it, and saying which direction is most of the value.
        return (
            <div
                style={style}
                className="flex items-center gap-2 whitespace-nowrap border-t border-slate-800 bg-slate-900/70 px-2 text-[9px] font-bold uppercase tracking-widest text-slate-500"
                title={t(lang, 'ringHint')}
            >
                <span className={line.side === 'subject' ? 'text-[#26AEE4]' : ''}>
                    {t(lang, RING_KEY[line.side])}
                </span>
                {line.ring > 0 && <span className="text-slate-600">{line.ring}</span>}
                <span className="font-normal normal-case tracking-normal text-slate-600">
                    {line.blocks} {t(lang, 'ringUnit')}
                </span>
            </div>
        );
    }

    if (line.kind === 'block') {
        const isFocus = line.target === focusTarget;
        return (
            <div
                style={{ ...style, paddingLeft: '8px' }}
                className={`flex items-center gap-2 whitespace-nowrap border-t ${isFocus ? 'border-[#26AEE4]/40 bg-blue-500/10' : 'border-slate-900 bg-slate-900/40'}`}
            >
                <button
                    type="button"
                    onClick={() => onOpen(line.target)}
                    className={`font-bold ${isFocus ? 'text-[#26AEE4]' : 'text-slate-300 hover:text-[#26AEE4]'} transition`}
                >
                    {line.label}
                </button>
                {line.bank && (
                    <span className="text-[9px] uppercase tracking-widest text-slate-600">
                        {t(lang, line.bank === 'master' ? 'master' : 'slave')}
                    </span>
                )}
                {line.addr !== undefined && (
                    <span className="text-[9px] text-slate-600">
                        0x{line.addr.toString(16).toUpperCase()}
                    </span>
                )}
                <span className="text-[9px] text-slate-600">{line.statements}</span>
            </div>
        );
    }

    if (line.kind === 'guard') {
        return (
            <div style={{ ...style, ...pad(line.depth) }} className="whitespace-nowrap text-slate-500">
                <span title={`${t(lang, 'rawCondition')}: ${line.raw}`}>
                    <span className="text-slate-600">if (</span>
                    <span className="italic">{line.text}</span>
                    <span className="text-slate-600">{') {'}</span>
                </span>
            </div>
        );
    }

    if (line.kind === 'close') {
        return (
            <div style={{ ...style, ...pad(line.depth) }} className="whitespace-nowrap text-slate-600">
                {'}'}
            </div>
        );
    }

    if (line.kind === 'gloss') {
        return (
            <div
                style={{ ...style, ...pad(line.depth + 1) }}
                className="whitespace-nowrap text-[10.5px] text-slate-500 truncate"
            >
                {line.text}
            </div>
        );
    }

    if (line.kind === 'note') {
        return (
            <div style={{ ...style, ...pad(line.depth) }} className="whitespace-nowrap italic text-slate-600">
                {line.text}
            </div>
        );
    }

    if (line.kind === 'source') {
        // Quoted C, for a function no statement was parsed out of. Drawn with
        // the decompiler's own indentation — the reconstructed `if` nesting
        // above it steps four characters a level, and applying that to a text
        // that steps two would push a five-deep loop off the pane.
        const litRow = Boolean(picked) && line.tokens.some(tk => tk.name === picked);
        return (
            <div
                style={{ ...style, paddingLeft: `${gutter + line.indent * CH}px` }}
                className={`whitespace-nowrap${litRow ? ' bg-[#26AEE4]/10' : ''}`}
            >
                {/* A real line number, unlike the ordinal the formula rows
                    carry: this line IS line n of the decompiler's output. */}
                <span
                    className="absolute text-[9.5px] text-slate-700 tabular-nums"
                    style={{ left: gutter - NUM_W, width: NUM_W - 6, textAlign: 'right' }}
                    title={t(lang, 'sourceLineNoHint')}
                >
                    {line.row}
                </span>
                {line.comment ? (
                    <span className="italic text-slate-600">{line.tokens[0]?.text}</span>
                ) : (
                    line.tokens.map((tk, i) => (
                        <span
                            key={i}
                            className={`${TOKEN_CLASS[tk.role]}${
                                picked && tk.name === picked ? ' font-bold underline' : ''
                            }${tk.target ? ' cursor-pointer hover:text-[#26AEE4]' : tk.name ? ' cursor-pointer' : ''}`}
                            style={{ opacity: tk.name ? dim(picked, tk.name) : 1 }}
                            // A call site opens the function, the way a block
                            // heading and a cross-reference do. Everything else
                            // that names something lights it.
                            onClick={
                                tk.target
                                    ? () => onOpen(tk.target!)
                                    : tk.name
                                      ? () => onPick(tk.name)
                                      : undefined
                            }
                            title={tk.title}
                        >
                            {tk.text}
                        </span>
                    ))
                )}
            </div>
        );
    }

    // The row this listing is being read FOR. A band behind it, the same one
    // the picture draws behind the equivalent row: one selection should not
    // look like three different degrees of "found it" across three views.
    const litRow = Boolean(picked)
        && (line.out.name === picked || line.tokens.some(tk => tk.name === picked));
    return (
        <div
            style={{ ...style, ...pad(line.depth) }}
            className={`whitespace-nowrap${litRow ? ' bg-[#26AEE4]/10' : ''}`}
        >
            {/* The ordinal within the function. Not an address: the recovered
                statements carry none, and a number that looked like one would
                be the listing's first lie. */}
            <span
                className="absolute text-[9.5px] text-slate-700 tabular-nums"
                style={{ left: gutter - NUM_W, width: NUM_W - 6, textAlign: 'right' }}
                title={t(lang, 'lineNoHint')}
            >
                {line.row + 1}
            </span>
            <span title={line.raw}>
                <span
                    className={`font-bold text-blue-300 cursor-pointer${picked === line.out.name ? ' underline' : ''}`}
                    style={{ opacity: dim(picked, line.out.name) }}
                    onClick={() => onPick(line.out.name)}
                >
                    {line.out.text}
                </span>
                <span className="text-slate-500"> = </span>
                {line.tokens.map((tk, i) => (
                    <span
                        key={i}
                        className={`${tk.alt ? 'text-amber-400' : TOKEN_CLASS[tk.role]}${
                            picked && tk.name === picked ? ' font-bold underline' : ''
                        }${tk.name ? ' cursor-pointer' : ''}`}
                        style={{ opacity: tk.name ? dim(picked, tk.name) : 1 }}
                        onClick={tk.name ? () => onPick(tk.name) : undefined}
                        title={tk.title}
                    >
                        {tk.text}
                    </span>
                ))}
            </span>
            {/* Who else touches what this line computes. Inline rather than in a
                right-hand column: the listing scrolls sideways, and a column
                pinned to the right edge would scroll away from its own rows. */}
            {line.xrefs.length > 0 && (
                <span className="text-[10px] text-slate-600" title={t(lang, 'xrefHint')}>
                    {`    ; ${t(lang, 'xrefLabel')} `}
                    {line.xrefs.map((x, i) => (
                        <span key={x.target}>
                            {i > 0 && ', '}
                            <button
                                type="button"
                                className="transition hover:text-[#26AEE4]"
                                onClick={() => onOpen(x.target)}
                            >
                                {x.label}
                            </button>
                        </span>
                    ))}
                    {line.moreXrefs > 0 && ` +${line.moreXrefs}`}
                </span>
            )}
        </div>
    );
}
