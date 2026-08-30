'use client';

import {
    type ReactElement,
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from 'react';
import type { Indexed } from '@/lib/calibration-graph/graph';
import { type DiagramNode, FOOTER_STEP, buildDiagram } from '@/lib/calibration-graph/diagram-model';
import type { Token, TokenRole } from '@/lib/calibration-graph/expr-tokens';
import { owningBlock } from '@/lib/calibration-graph/block-tree';
import { makeContext } from '@/lib/calibration-graph/logic-format';
import { displayName } from '@/lib/calibration-graph/names';
import { readMnemonic } from '@/lib/calibration-graph/mnemonic';
import { t } from '@/lib/calibration-graph/calib-i18n';
import { useDialogLang } from '@/hooks/useDialogLang';

/**
 * The block diagram — the notes viewer's renderer, restyled to the ///M tokens.
 *
 * Layout comes verbatim from lib/calibration-graph/diagram-model.ts; this file
 * is presentation only. The one-color-one-meaning rules it draws by:
 * editable calibration (map/curve/constant) is blue; signals are neutral;
 * DASHED means inferred, everywhere (alternative inputs, scan-origin wires);
 * the selection highlight is the interactive blue, never a new hue.
 */

const KIND_LABEL = {
    map: 'kindMap',
    curve: 'kindCurve',
    constant: 'kindConstant',
    signal: 'kRam',
    block: 'kFunc',
    unknown: 'kUnknown',
} as const;

const PORT_RECT: Record<DiagramNode['kind'], string> = {
    map: 'fill-slate-900 stroke-blue-500/70',
    curve: 'fill-slate-900 stroke-blue-500/70',
    constant: 'fill-slate-900 stroke-blue-500/70',
    signal: 'fill-slate-900 stroke-slate-700',
    block: 'fill-slate-900 stroke-slate-700',
    unknown: 'fill-slate-900 stroke-slate-800',
};

const PORT_TEXT: Record<DiagramNode['kind'], string> = {
    map: 'fill-[#26AEE4]',
    curve: 'fill-[#26AEE4]',
    constant: 'fill-[#26AEE4]',
    signal: 'fill-slate-300',
    block: 'fill-slate-400',
    unknown: 'fill-slate-500',
};

const PORT_GLYPH: Record<DiagramNode['kind'], string> = {
    map: 'stroke-[#26AEE4]',
    curve: 'stroke-[#26AEE4]',
    constant: 'stroke-[#26AEE4]',
    signal: 'stroke-slate-400',
    block: 'stroke-slate-400',
    unknown: 'stroke-slate-500',
};

/**
 * Magnification limits.
 *
 * The floor is where an 11.5px formula stops being text and becomes texture;
 * the ceiling is a little past where one block fills the pane, which is as far
 * in as a picture of connections is worth going.
 */
const ZOOM_MIN = 0.4;
const ZOOM_MAX = 2.5;
const ZOOM_STEP = 1.25;
const clampZoom = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));

/**
 * Where the canvas should be scrolled to once this render commits.
 *
 * Every write to scrollLeft/scrollTop in this component goes through one of
 * these, applied by a single layout effect. That is deliberate: what this
 * replaces was several independent writers — a re-centring effect, and the
 * browser's own focus handling — each moving the canvas for its own reason
 * while the reader was looking at something else.
 */
type Restore =
    /** An absolute position, already in scaled pixels. */
    | { kind: 'scroll'; left: number; top: number }
    /** Keep this node where it is on screen, wherever the relayout puts it. */
    | { kind: 'node'; id: string; dx: number; dy: number };

function KindGlyph({ kind }: { kind: DiagramNode['kind'] }) {
    const cls = `${PORT_GLYPH[kind]} fill-none`;
    switch (kind) {
        case 'map':
            // A 3x3 grid: the map is a field of values over two axes.
            return (
                <g className={cls}>
                    <rect x={0} y={0} width={12} height={12} rx={1} />
                    <path d="M4 0V12M8 0V12M0 4H12M0 8H12" />
                </g>
            );
        case 'curve':
            // One rising line: a curve is a value over a single axis.
            return (
                <g className={cls}>
                    <rect x={0} y={0} width={12} height={12} rx={1} />
                    <path d="M1.5 10.5C4 10.5 5 2.5 10.5 2.5" />
                </g>
            );
        case 'constant':
            return (
                <g className={cls}>
                    <circle cx={6} cy={6} r={4} />
                </g>
            );
        case 'block':
            return (
                <g className={cls}>
                    <rect x={0} y={2} width={12} height={8} rx={1} />
                </g>
            );
        default:
            // A signal: a wire tag.
            return (
                <g className={cls}>
                    <path d="M0 6H12M9 3l3 3-3 3" />
                </g>
            );
    }
}

export function LogicDiagram({
    g,
    rootId,
    selectedId,
    trail,
    onSelect,
    onBack,
}: {
    g: Indexed;
    /** The block the picture is drawn around. */
    rootId: string;
    /** What the reader last picked; lit up in place rather than re-centred. */
    selectedId: string;
    trail: string[];
    onSelect: (id: string) => void;
    onBack: (id: string) => void;
}) {
    const lang = useDialogLang();
    const [showAll, setShowAll] = useState(false);
    const [showNoise, setShowNoise] = useState(false);
    const [everything, setEverything] = useState(true);
    const [depth, setDepth] = useState(1);
    const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
    /**
     * The block last opened or closed, and where it was when that happened.
     *
     * Handed to the layout so its column slides around it instead of
     * re-centring underneath it. Cleared by every control that changes the
     * whole picture, where a pin to a position from a different layout would
     * mean nothing.
     */
    const [pinned, setPinned] = useState<{ key: string; y: number; stamp: string } | null>(null);
    const [zoom, setZoom] = useState(1);
    /**
     * Readable wording, or the decompiler's own.
     *
     * Readable is the default because it is what the picture is for; the other
     * is one click away because a rewrite the reader cannot check against the
     * source is a rewrite they have to take on trust.
     */
    const [plain, setPlain] = useState(true);
    /**
     * The symbol under the cursor, if any.
     *
     * With every wire now landing on the line that uses it, a busy block has a
     * lot of lines converging on it. Lighting one quantity everywhere it
     * appears — its port, its wire, its leader, every token spelling it, and
     * the rails inside the block — is what keeps that readable; without it the
     * extra precision would just be extra ink.
     */
    const [hovered, setHovered] = useState<string | null>(null);
    const scroller = useRef<HTMLDivElement>(null);
    const restore = useRef<Restore | null>(null);
    /** The (root, selection) pair the canvas was last centred for. */
    const centredFor = useRef('');
    /**
     * The live magnification, and the value every zoom is computed FROM.
     *
     * The gesture handlers subscribe once and must keep their listeners across
     * a pinch — an effect that re-ran on every zoom step would tear the gesture
     * down mid-stretch — so they read it through a ref rather than closing over
     * the state. `zoomAbout` and `fit` write it as they go, which is also what
     * lets several moves inside one frame each build on the last.
     */
    const zoomRef = useRef(zoom);

    // What the reader is looking at. Both the re-centring below and the layout
    // pin are scoped to it: navigating draws a different picture, and a pin
    // holding a column at a position from the previous one has nothing to hold
    // it to. Stamped rather than cleared in an effect — a stale pin is simply
    // not a pin, and deciding that during render costs no extra pass.
    const view = `${rootId}|${selectedId}`;
    const activePin = pinned?.stamp === view ? pinned : null;

    const ctx = useMemo(
        () => makeContext(g.raw.nodes, g.raw.nameIndex, g.byId, g.raw.glossary, lang, plain),
        [g, lang, plain],
    );
    const diagram = useMemo(() => {
        const opts = {
            ctx,
            maxPorts: 14,
            showAllLines: showAll,
            showNoise,
            showEverything: everything,
            depth,
            expanded,
            highlight: selectedId,
            anchor: activePin ?? undefined,
        };
        const first = buildDiagram(g, rootId, opts);
        // The picture only moves when what the reader picked is genuinely not in it.
        if (first?.nodes.some(n => n.target === selectedId)) return first;
        const picked = g.byId.get(selectedId);
        const owner = picked ? owningBlock(g, picked) : null;
        if (owner && owner.id !== rootId) return buildDiagram(g, owner.id, opts) ?? first;
        return first ?? (picked ? buildDiagram(g, selectedId, opts) : null);
    }, [g, rootId, selectedId, ctx, showAll, showNoise, everything, depth, expanded, activePin]);

    /**
     * The one place the canvas is allowed to move, and the rule it moves by.
     *
     * Navigation moves the window; nothing else does. Opening a formula,
     * changing DEPTH, or magnifying all rebuild the layout — finish() centres
     * every column vertically against the tallest one, so growing any block
     * shifts every other block — but none of those is a reason to show the
     * reader a different part of the picture. So a re-centre happens only when
     * the root or the selection actually changed, and every other cause of a
     * relayout carries an anchor that puts what is being read back where it was.
     *
     * This used to fire on `diagram` identity alone, and `expanded` is one of
     * that memo's dependencies: pressing "+N more" therefore snapped the canvas
     * onto the SELECTED node, which is rarely the block being opened.
     */
    useLayoutEffect(() => {
        const el = scroller.current;
        if (!el || !diagram) return;
        if (centredFor.current !== view) {
            centredFor.current = view;
            restore.current = null;
            const centre =
                diagram.nodes.find(n => n.target === selectedId) ??
                diagram.nodes.find(n => n.depth === 0);
            if (centre) {
                el.scrollLeft = Math.max(0, (centre.x + centre.w / 2) * zoom - el.clientWidth / 2);
            }
            return;
        }
        const r = restore.current;
        restore.current = null;
        if (!r) return;
        if (r.kind === 'scroll') {
            el.scrollLeft = Math.max(0, r.left);
            el.scrollTop = Math.max(0, r.top);
            return;
        }
        const n = diagram.nodes.find(x => x.id === r.id);
        if (!n) return;
        el.scrollLeft = Math.max(0, n.x * zoom - r.dx);
        el.scrollTop = Math.max(0, n.y * zoom - r.dy);
    }, [diagram, view, selectedId, zoom]);

    /**
     * Pin a node to where it sits on screen now, across the next relayout.
     *
     * Node ids are `L{layer}:{name}` and do not change when a block is opened,
     * so the anchor always finds the same box on the other side of the rebuild.
     * With no id, the focus block is the anchor — which is what the whole-view
     * controls want, since they are not about any one block.
     */
    /**
     * Anchor the scroll on a node, and drop any layout pin.
     *
     * Called with no id by the controls that change the whole picture: none of
     * them is about one block, so the pin from the last open would be holding a
     * column at a position from a layout that no longer exists.
     */
    const anchorOn = useCallback(
        (id?: string) => {
            if (!id) setPinned(null);
            const el = scroller.current;
            const n = id
                ? diagram?.nodes.find(x => x.id === id)
                : diagram?.nodes.find(x => x.depth === 0);
            if (!el || !n) return;
            const z = zoomRef.current;
            restore.current = {
                kind: 'node',
                id: n.id,
                dx: n.x * z - el.scrollLeft,
                dy: n.y * z - el.scrollTop,
            };
        },
        [diagram],
    );

    /** Magnify about a point in the viewport, so what is under it stays under it. */
    const zoomAbout = useCallback((next: (z: number) => number, cx: number, cy: number) => {
        // Everything here happens NOW, at the event, and `setZoom` is handed a
        // finished number.
        //
        // It used to be a state updater — `setZoom(prev => …)` with `next(prev)`
        // and the scroll write inside it — and React runs an updater during the
        // render pass, not when the event fires. So a pinch's `next` closure,
        // which measures the distance between two live fingers, was evaluated
        // after one of them could already have lifted: it destructured a
        // one-entry map and threw `Cannot read properties of undefined`, which
        // in a production build is the whole app replaced by "a client-side
        // exception has occurred". Reproduced by lifting a finger in the same
        // task as the move that preceded it.
        //
        // Writing `restore.current` from inside the updater was the same
        // mistake in its milder form: an updater has to be pure, and React is
        // free to call it more than once.
        const prev = zoomRef.current;
        const z = clampZoom(next(prev));
        if (!Number.isFinite(z) || z === prev) return;
        const el = scroller.current;
        if (el) {
            const px = (el.scrollLeft + cx) / prev;
            const py = (el.scrollTop + cy) / prev;
            restore.current = { kind: 'scroll', left: px * z - cx, top: py * z - cy };
        }
        // In step immediately, because a pinch emits several moves per frame and
        // each one has to see what the one before it decided.
        zoomRef.current = z;
        setZoom(z);
    }, []);

    /** A button press magnifies about the middle of what is on screen. */
    const nudgeZoom = useCallback(
        (factor: number) => {
            const el = scroller.current;
            zoomAbout(z => z * factor, (el?.clientWidth ?? 0) / 2, (el?.clientHeight ?? 0) / 2);
        },
        [zoomAbout],
    );

    const fit = useCallback(() => {
        const el = scroller.current;
        if (!el || !diagram) return;
        // Never past 1:1 — FIT is for seeing the whole chain, and blowing a
        // two-box diagram up to fill the pane is not what anyone means by it.
        const z = clampZoom(
            Math.min(1, (el.clientWidth - 8) / diagram.width, (el.clientHeight - 8) / diagram.height),
        );
        if (!Number.isFinite(z)) return;
        restore.current = { kind: 'scroll', left: 0, top: 0 };
        zoomRef.current = z;
        setZoom(z);
    }, [diagram]);

    /**
     * Ctrl/Cmd + wheel magnifies; a plain wheel is left alone to scroll.
     *
     * Non-passive because it has to preventDefault — otherwise the browser
     * takes a ctrl-wheel as page zoom and the pane and the page both change
     * size at once. A trackpad pinch arrives here as a ctrlKey wheel, which is
     * why the two gestures share one handler.
     */
    useEffect(() => {
        const el = scroller.current;
        if (!el) return;
        const onWheel = (e: WheelEvent) => {
            if (!e.ctrlKey && !e.metaKey) return;
            e.preventDefault();
            const r = el.getBoundingClientRect();
            // One mouse-wheel notch is deltaY ~120, and this rate puts that at
            // about 1.2x — a step, not a leap. At 0.99 a single notch was 3.3x,
            // which took the whole range in one flick of the finger.
            zoomAbout(z => z * Math.pow(0.9985, e.deltaY), e.clientX - r.left, e.clientY - r.top);
        };
        el.addEventListener('wheel', onWheel, { passive: false });
        return () => el.removeEventListener('wheel', onWheel);
    }, [zoomAbout]);

    /**
     * Two fingers magnify, anchored on the midpoint between them.
     *
     * The same split the trackpad has, and the one LogTimeSeriesChart draws for
     * the log: one finger is a scroll, which `touch-action: pan-x pan-y` leaves
     * to the browser, and two are a magnification. Mouse pointers are skipped
     * because a mouse already has the wheel.
     */
    useEffect(() => {
        const el = scroller.current;
        if (!el) return;
        const active = new Map<number, { x: number; y: number }>();
        let pinch: { dist: number; cx: number; cy: number; z: number } | null = null;
        /** Null unless two pointers are still down — never assume they are. */
        const spread = () => {
            const [a, b] = [...active.values()];
            if (!a || !b) return null;
            return Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
        };
        const down = (e: PointerEvent) => {
            if (e.pointerType === 'mouse') return;
            active.set(e.pointerId, { x: e.clientX, y: e.clientY });
            if (active.size !== 2) return;
            const [a, b] = [...active.values()];
            const dist = spread();
            if (dist === null) return;
            const r = el.getBoundingClientRect();
            pinch = {
                dist,
                cx: (a.x + b.x) / 2 - r.left,
                cy: (a.y + b.y) / 2 - r.top,
                z: zoomRef.current,
            };
        };
        const move = (e: PointerEvent) => {
            const held = active.get(e.pointerId);
            if (held) {
                held.x = e.clientX;
                held.y = e.clientY;
            }
            if (!pinch || active.size < 2) return;
            // Measured here, from the fingers as they are at this instant, and
            // handed on as a number. See `zoomAbout`.
            const now = spread();
            if (now === null) return;
            e.preventDefault();
            const ratio = now / pinch.dist;
            const from = pinch.z;
            zoomAbout(() => from * ratio, pinch.cx, pinch.cy);
        };
        const up = (e: PointerEvent) => {
            active.delete(e.pointerId);
            // The finger left behind does NOT become a new pinch: its starting
            // spread is from before the stretch, so resuming would jump.
            if (active.size < 2) pinch = null;
        };
        el.addEventListener('pointerdown', down, { capture: true });
        el.addEventListener('pointermove', move, { capture: true, passive: false });
        el.addEventListener('pointerup', up, { capture: true });
        el.addEventListener('pointercancel', up, { capture: true });
        return () => {
            el.removeEventListener('pointerdown', down, { capture: true });
            el.removeEventListener('pointermove', move, { capture: true });
            el.removeEventListener('pointerup', up, { capture: true });
            el.removeEventListener('pointercancel', up, { capture: true });
        };
    }, [zoomAbout]);

    const toggle = (key: string, id: string) => {
        anchorOn(id);
        const node = diagram?.nodes.find(n => n.id === id);
        if (node) setPinned({ key, y: node.y, stamp: view });
        setExpanded(prev => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });
    };

    return (
        <div className="h-full min-h-0 flex flex-col">
            {/* Breadcrumb — reserved height so a growing trail never reflows the canvas. */}
            <nav
                className="h-[22px] flex-none flex items-center gap-1 px-1 overflow-x-auto no-scrollbar whitespace-nowrap text-[10px] font-mono"
                aria-label={t(lang, 'blockDiagram')}
            >
                {trail.length > 1 && trail.map((id, i) => {
                    const node = g.byId.get(id);
                    if (!node) return null;
                    const last = i === trail.length - 1;
                    return (
                        <span key={id} className="flex items-center gap-1">
                            {i > 0 && <span className="text-slate-700">›</span>}
                            {last ? (
                                <strong className="text-slate-200">{displayName(node.name, node.t)}</strong>
                            ) : (
                                <button
                                    type="button"
                                    className="text-blue-400 hover:text-blue-300 transition"
                                    onClick={() => onBack(id)}
                                >
                                    {displayName(node.name, node.t)}
                                </button>
                            )}
                        </span>
                    );
                })}
            </nav>

            {/* Controls — one reserved row. Every control that changes the layout
                anchors on the focus block first, for the reason the scroll effect
                above gives: none of them is a reason to move the picture. */}
            <div className="h-[24px] flex-none flex items-center gap-3 px-1 text-[10px] font-bold uppercase tracking-widest text-slate-500">
                {/* The view toggles scroll when they do not fit; the
                    magnification stays pinned. The pane is narrow whenever the
                    tree is open, and a fixed row simply clipped the zoom
                    cluster off the right edge, where nothing could reach it. */}
                <div className="min-w-0 flex-1 flex items-center gap-3 overflow-x-auto no-scrollbar">
                <label className="flex-none flex items-center gap-1.5">
                    {t(lang, 'diagramDepth')}
                    <input
                        type="range"
                        min={1}
                        max={3}
                        value={depth}
                        onChange={e => {
                            anchorOn();
                            setDepth(Number(e.target.value));
                        }}
                        className="w-16 h-1 accent-blue-500"
                    />
                    <span className="font-mono text-slate-300">{depth}</span>
                </label>
                <button
                    type="button"
                    className={`flex-none transition ${everything ? 'text-blue-400' : 'hover:text-slate-300'}`}
                    onClick={() => {
                        anchorOn();
                        setEverything(v => !v);
                    }}
                >
                    {everything ? t(lang, 'showKeyOnly') : t(lang, 'showEverything')}
                </button>
                {(showNoise || (diagram?.hiddenNoise ?? 0) > 0) && (
                    <button
                        type="button"
                        className="flex-none transition hover:text-slate-300"
                        onClick={() => {
                            anchorOn();
                            setShowNoise(v => !v);
                        }}
                    >
                        {showNoise ? t(lang, 'hideNoise') : `${t(lang, 'showNoise')} (+${diagram?.hiddenNoise ?? 0})`}
                    </button>
                )}
                <button
                    type="button"
                    title={t(lang, plain ? 'plainFormHint' : 'decompiledFormHint')}
                    className={`flex-none transition ${plain ? 'hover:text-slate-300' : 'text-blue-400'}`}
                    onClick={() => {
                        anchorOn();
                        setPlain(v => !v);
                    }}
                >
                    {plain ? t(lang, 'decompiledForm') : t(lang, 'plainForm')}
                </button>
                {diagram?.paramFocus && (
                    <span className="min-w-0 normal-case font-normal tracking-normal text-slate-500 truncate">
                        <strong className="font-mono text-slate-300">{diagram.paramFocus}</strong>{' '}
                        {t(lang, 'diagramParamFocus')}
                    </span>
                )}
                </div>
                <span className="flex-none flex items-center gap-1.5">
                    <button
                        type="button"
                        title={t(lang, 'zoomOut')}
                        disabled={zoom <= ZOOM_MIN}
                        className="w-4 leading-none text-slate-400 transition hover:text-slate-200 disabled:text-slate-700"
                        onClick={() => nudgeZoom(1 / ZOOM_STEP)}
                    >
                        −
                    </button>
                    <span className="w-9 text-center font-mono tabular-nums text-slate-300">
                        {Math.round(zoom * 100)}%
                    </span>
                    <button
                        type="button"
                        title={t(lang, 'zoomIn')}
                        disabled={zoom >= ZOOM_MAX}
                        className="w-4 leading-none text-slate-400 transition hover:text-slate-200 disabled:text-slate-700"
                        onClick={() => nudgeZoom(ZOOM_STEP)}
                    >
                        +
                    </button>
                    <button type="button" title={t(lang, 'zoomFit')} className="transition hover:text-slate-300" onClick={fit}>
                        FIT
                    </button>
                </span>
            </div>

            {/* The canvas. `touch-action` keeps one-finger scrolling with the
                browser and reserves two fingers for the pinch handler above. */}
            <div className="flex-1 min-h-0 overflow-auto" style={{ touchAction: 'pan-x pan-y' }} ref={scroller}>
                {!diagram ? (
                    <p className="p-4 text-[11px] text-slate-500">{t(lang, 'noDiagram')}</p>
                ) : (
                    <svg
                        className="font-mono"
                        // Magnified by the drawn size against a fixed viewBox rather
                        // than by a CSS transform: a transform does not change layout
                        // size, so the scroll container would keep the 1:1 extent and
                        // half of a magnified diagram would be unreachable.
                        width={diagram.width * zoom}
                        height={diagram.height * zoom}
                        viewBox={`0 0 ${diagram.width} ${diagram.height}`}
                        role="img"
                        aria-label={t(lang, 'blockDiagram')}
                    >
                        <defs>
                            <marker
                                id="cal-arrow"
                                viewBox="0 0 8 8"
                                refX={7}
                                refY={4}
                                markerWidth={7}
                                markerHeight={7}
                                orient="auto-start-reverse"
                            >
                                <path d="M0 0.5 L 8 4 L 0 7.5 z" className="fill-slate-500" />
                            </marker>
                        </defs>

                        {diagram.edges.map((e, i) => (
                            <path
                                key={i}
                                d={e.d}
                                className={`fill-none ${e.kind === 'write' ? 'stroke-blue-500' : e.kind === 'call' ? 'stroke-slate-700 opacity-60' : 'stroke-slate-600'}${e.inferred ? ' opacity-50' : ''}`}
                                strokeDasharray={e.inferred ? '2 3' : e.alternative ? '4 3' : undefined}
                                markerEnd="url(#cal-arrow)"
                                opacity={dim(hovered, e.signal)}
                            />
                        ))}

                        {/* Border to token. Drawn before the boxes so the
                            formula text sits on top of its own connector. */}
                        {diagram.leaders.map((l, i) => (
                            <path
                                key={`l${i}`}
                                d={l.d}
                                className={hovered === l.name ? 'fill-none stroke-[#26AEE4]' : 'fill-none stroke-slate-700'}
                                strokeDasharray="1 2"
                                opacity={dim(hovered, l.name)}
                            />
                        ))}

                        {diagram.nodes.map(n =>
                            n.kind === 'block' ? (
                                <BlockBox
                                    key={n.id}
                                    n={n}
                                    lang={lang}
                                    hovered={hovered}
                                    onHover={setHovered}
                                    onSelect={onSelect}
                                    onToggle={toggle}
                                />
                            ) : (
                                <PortBox
                                    key={n.id}
                                    n={n}
                                    lang={lang}
                                    glossary={g.raw.glossary}
                                    hovered={hovered}
                                    onHover={setHovered}
                                    onSelect={onSelect}
                                />
                            ),
                        )}
                    </svg>
                )}
            </div>

            {/* Hidden-count honesty line — reserved height. */}
            <div className="h-[22px] flex-none flex items-center gap-3 px-1 text-[9px] font-mono text-slate-500 overflow-hidden">
                {diagram && diagram.hiddenLines > 0 && (
                    <button
                        type="button"
                        className="text-blue-400 hover:text-blue-300 transition uppercase tracking-widest font-sans font-bold"
                        onClick={() => {
                            anchorOn();
                            setShowAll(v => !v);
                        }}
                    >
                        {showAll ? t(lang, 'showFewerLines') : `${t(lang, 'showAllLines')} (+${diagram.hiddenLines})`}
                    </button>
                )}
                {diagram && diagram.hiddenPorts > 0 && (
                    <span>{t(lang, 'portsHidden')}: {diagram.hiddenPorts}</span>
                )}
                {diagram && diagram.hiddenBlocks > 0 && (
                    <span>{t(lang, 'blocksHidden')}: {diagram.hiddenBlocks}</span>
                )}
            </div>
        </div>
    );
}

/**
 * Press without taking focus, and without letting Space scroll the page.
 *
 * These are SVG `g`/`text` elements carrying role="button", not real buttons.
 * A mouse press on one focuses it, and the browser then scroll-into-views the
 * newly focused element — after the relayout has already moved it, so the
 * canvas jumps twice. preventDefault on mousedown stops the mouse-driven focus
 * while leaving the click, and Tab focus, alone. Space needs the same treatment
 * for the other half of the problem: on a non-button focusable element its
 * default action is to page-scroll the nearest scroll container.
 */
const pressGuards = (act: () => void) => ({
    onMouseDown: (e: { preventDefault: () => void }) => e.preventDefault(),
    onKeyDown: (e: { key: string; preventDefault: () => void }) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        act();
    },
});

/** Everything not on the hovered path recedes; nothing disappears. */
function dim(hovered: string | null, name?: string): number {
    if (!hovered) return 1;
    return name === hovered ? 1 : 0.25;
}

const TOKEN_CLASS: Record<TokenRole, string> = {
    calib: 'fill-[#26AEE4]',
    helper: 'fill-slate-500',
    signal: 'fill-slate-300',
    symbol: 'fill-slate-400',
    number: 'fill-slate-400',
    // Machine detail: present and checkable, not competing for attention.
    plumbing: 'fill-slate-600',
    // A name this tool worked out rather than read. Italic is the text form of
    // the dashed stroke the picture already uses for everything inferred.
    inferred: 'fill-slate-500 italic',
    op: 'fill-slate-500',
};

function PortBox({
    n,
    lang,
    glossary,
    hovered,
    onHover,
    onSelect,
}: {
    n: DiagramNode;
    lang: 'ja' | 'en';
    glossary: Record<string, string>;
    hovered: string | null;
    onHover: (name: string | null) => void;
    onSelect: (id: string) => void;
}) {
    const clickable = Boolean(n.target);
    const reading = readMnemonic(n.key, glossary, lang)?.reading;
    const tip = `${n.label} — ${t(lang, KIND_LABEL[n.kind])}${reading ? `\n${t(lang, 'mnemonicReading')}: ${reading}` : ''}`;
    const lit = hovered === n.label;
    return (
        <g
            className={clickable ? 'cursor-pointer' : undefined}
            transform={`translate(${n.x} ${n.y})`}
            onClick={clickable ? () => onSelect(n.target!) : undefined}
            tabIndex={clickable ? 0 : undefined}
            role={clickable ? 'button' : undefined}
            onMouseEnter={() => onHover(n.label)}
            onMouseLeave={() => onHover(null)}
            opacity={dim(hovered, n.label)}
            {...(clickable ? pressGuards(() => onSelect(n.target!)) : {})}
        >
            <title>{tip}</title>
            <rect
                width={n.w}
                height={n.h}
                rx={n.kind === 'constant' ? n.h / 2 : 3}
                className={n.highlight || lit ? 'fill-slate-900 stroke-[#26AEE4]' : PORT_RECT[n.kind]}
                strokeWidth={n.highlight || lit ? 1.5 : 1}
            />
            <g transform={`translate(9 ${(n.h - 12) / 2})`}>
                <KindGlyph kind={n.kind} />
            </g>
            <text x={28} y={n.h / 2 + 4} className={`text-[11.5px] ${PORT_TEXT[n.kind]}${n.highlight ? ' font-bold' : ''}`}>
                {n.label}
            </text>
        </g>
    );
}

function BlockBox({
    n,
    lang,
    hovered,
    onHover,
    onSelect,
    onToggle,
}: {
    n: DiagramNode;
    lang: 'ja' | 'en';
    hovered: string | null;
    onHover: (name: string | null) => void;
    onSelect: (id: string) => void;
    onToggle: (key: string, id: string) => void;
}) {
    // Row positions come from the layout now. They used to be recomputed here
    // at paint time, which was harmless while nothing else needed them — and
    // stopped being harmless the moment a wire had to land on a specific row.
    const rows = n.rows ?? [];
    const lines = n.lines ?? [];
    const textX = n.textX ?? 10;
    const open = () => onToggle(n.key, n.id);

    return (
        <g transform={`translate(${n.x} ${n.y})`}>
            <rect
                width={n.w}
                height={n.h}
                rx={5}
                className={`fill-slate-950 ${n.highlight ? 'stroke-[#26AEE4]' : n.collapsed ? 'stroke-slate-800' : 'stroke-slate-700'}`}
                strokeWidth={n.highlight ? 1.5 : 1}
                strokeDasharray={n.collapsed ? '5 3' : undefined}
            />
            <rect width={n.w} height={24} rx={5} className="fill-blue-500/10" />

            {/* Row to row inside this block: what one line computes, another
                reads back. Drawn in the left gutter so it never crosses text. */}
            {(n.rails ?? []).map((r, i) => (
                <path
                    key={`r${i}`}
                    d={r.d}
                    className={`fill-none ${hovered === r.name ? 'stroke-[#26AEE4]' : 'stroke-slate-700'}`}
                    opacity={dim(hovered, r.name)}
                />
            ))}

            <text
                className={`text-[12.5px] font-bold cursor-pointer ${n.collapsed ? 'fill-slate-300' : 'fill-[#26AEE4]'}`}
                x={textX}
                y={17}
                onClick={() => n.target && onSelect(n.target)}
            >
                {n.label}
            </text>
            {n.depth !== 0 && (
                <g
                    className="cursor-pointer"
                    transform={`translate(${n.w - 46} 5)`}
                    onClick={open}
                    role="button"
                    tabIndex={0}
                    {...pressGuards(open)}
                >
                    {/* The sign follows whether anything is still hidden, not whether the
                        block is drawn in brief. */}
                    <title>{t(lang, (n.moreLines ?? 0) > 0 ? 'expandBlock' : 'collapseBlock')}</title>
                    <rect width={16} height={14} rx={3} className="fill-slate-800 stroke-slate-700" />
                    <text x={8} y={11} textAnchor="middle" className="fill-slate-300 text-[11px]">
                        {(n.moreLines ?? 0) > 0 ? '+' : '−'}
                    </text>
                </g>
            )}
            {n.detail && n.depth === 0 && (
                <text className="fill-slate-500 text-[10px]" x={n.w - 10} y={17} textAnchor="end">
                    {t(lang, n.detail === 'master' ? 'master' : 'slave')}
                </text>
            )}
            {rows.map((row, i) => {
                const line = lines[i];
                if (!line) return null;
                const out: ReactElement[] = [];
                if (row.guardY !== null) {
                    out.push(
                        <text key={`g${i}`} className="fill-slate-500 italic text-[10.5px]" x={textX} y={row.guardY}>
                            {/* The condition as decompiled, for checking the
                                reading against — the same courtesy the formula
                                line has always had. */}
                            {line.rawGuards && <title>{`${t(lang, 'rawCondition')}: ${line.rawGuards}`}</title>}
                            {line.guardGloss ? line.guardGloss : `when ${line.guard}`}
                        </text>,
                    );
                }
                out.push(
                    <Formula
                        key={`f${i}`}
                        x={textX}
                        y={row.formulaY}
                        out={row.out}
                        tokens={row.tokens}
                        title={line.raw}
                        hovered={hovered}
                        onHover={onHover}
                    />,
                );
                if (row.glossY !== null) {
                    const clipped = Boolean(line.glossFull && line.glossFull !== line.gloss);
                    out.push(
                        <text key={`m${i}`} className="fill-slate-500 text-[10.5px]" x={textX + 12} y={row.glossY}>
                            {clipped && <title>{line.glossFull}</title>}
                            {line.gloss}
                        </text>,
                    );
                }
                return out;
            })}
            {(n.moreLines ?? 0) > 0 && (
                <text
                    className="fill-blue-400 text-[10px] cursor-pointer"
                    x={textX}
                    y={n.h - 8 - ((n.moreBlocks ?? 0) > 0 ? FOOTER_STEP : 0)}
                    role="button"
                    tabIndex={0}
                    onClick={open}
                    {...pressGuards(open)}
                >
                    <title>{t(lang, 'expandLines')}</title>
                    {`+${n.moreLines} ${t(lang, 'moreLines')}`}
                </text>
            )}
            {(n.moreBlocks ?? 0) > 0 && (
                <text className="fill-[#26AEE4] text-[10px]" x={textX} y={n.h - 8}>
                    <title>{t(lang, 'moreBlocksHint')}</title>
                    {`⋯ ${t(lang, 'moreBlocks')} ${n.moreBlocks} ${t(lang, 'moreBlocksUnit')}`}
                </text>
            )}
        </g>
    );
}

/**
 * Render `out = expr` from the tokens the layout measured.
 *
 * The colour rules used to live in a regex here that re-split the drawn string
 * at paint time. They live in `expr-tokens` now, which is what lets a wire find
 * the same operand this draws — one cut of the line, used by both.
 */
function Formula({
    x,
    y,
    out,
    tokens,
    title,
    hovered,
    onHover,
}: {
    x: number;
    y: number;
    out: Token;
    tokens: Token[];
    title?: string;
    hovered: string | null;
    onHover: (name: string | null) => void;
}) {
    const hoverProps = (name?: string) =>
        name
            ? { onMouseEnter: () => onHover(name), onMouseLeave: () => onHover(null) }
            : {};
    return (
        <text className="text-[11.5px]" x={x} y={y}>
            {/* The decompiler's own wording, for checking the rewrite against. */}
            {title && <title>{title}</title>}
            <tspan
                className={`fill-blue-300 font-bold${hovered === out.name ? ' underline' : ''}`}
                opacity={dim(hovered, out.name)}
                {...hoverProps(out.name)}
            >
                {out.text}
            </tspan>
            <tspan className="fill-slate-500"> = </tspan>
            {tokens.map((tk, i) => (
                <tspan
                    key={i}
                    // Alternatives — one of several tables, chosen by engine
                    // state — keep the armed channel they have always had.
                    className={`${tk.alt ? 'fill-amber-400' : TOKEN_CLASS[tk.role]}${hovered && tk.name === hovered ? ' font-bold underline' : ''}`}
                    opacity={tk.name ? dim(hovered, tk.name) : 1}
                    {...hoverProps(tk.name)}
                >
                    {tk.title && <title>{tk.title}</title>}
                    {tk.text}
                </tspan>
            ))}
        </text>
    );
}
