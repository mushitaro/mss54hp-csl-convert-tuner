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
import { type DiagramNode, FOOTER_STEP, buildDiagram, usersOf } from '@/lib/calibration-graph/diagram-model';
import { type InsideMode, buildInside } from '@/lib/calibration-graph/inside-model';
import type { Token, TokenRole } from '@/lib/calibration-graph/expr-tokens';
import { makeContext } from '@/lib/calibration-graph/logic-format';
import { buildCode } from '@/lib/calibration-graph/code-model';
import type { DecompCorpus } from '@/lib/calibration-graph/decomp';
import { loadDecompCorpus } from '@/lib/calibration/catalog';
import { reach } from '@/lib/calibration-graph/boundary';
import { systemMap } from '@/lib/calibration-graph/system-map';
import { CalibrationCode } from './CalibrationCode';
import { CalibrationInside } from './CalibrationInside';
import { displayName } from '@/lib/calibration-graph/names';
import { readMnemonic } from '@/lib/calibration-graph/mnemonic';
import { type StringKey, t, type Lang } from '@/lib/calibration-graph/calib-i18n';
import { LIT_STROKE, LIT_WIDTH, dim, isLit } from '@/lib/calibration-graph/focus';
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

/** The sentence a boundary port adds to its tooltip. */
const BOUNDARY_TIP = (lang: Lang, side: 'in' | 'out') =>
    `
${t(lang, side === 'in' ? 'boundaryIn' : 'boundaryOut')}`;

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
/**
 * Where a newly selected subject lands: the middle of the pane, every time.
 *
 * A FIXED point, not the one the last picture happened to be read at. What this
 * replaces is `focusAt`, a remembered offset that was replayed on the next
 * selection — so panning the subject off the left edge and then picking
 * something else put the new subject off the left edge too. Measured: the
 * subject at x = -143 in a 633px pane, invisible, twice in a row.
 *
 * A box wider or taller than the pane cannot be centred, so it goes to this
 * inset instead: its heading is what a reader needs first, not its middle.
 */
const HOME_INSET = 24;

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
            // A signal: a value that changes while the engine runs.
            //
            // It was an arrow, and an arrow beside a name reads as an operator
            // pointing AT that name — `→ LLS_TV_AQ` looked like notation for
            // something being assigned or integrated, which is exactly what it
            // is not. It is a kind mark, like the grid and the circle above it.
            // A pulse says the one thing that separates a signal from the rest
            // of the set: the others are numbers in flash and this one moves.
            return (
                <g className={cls}>
                    <path d="M0 9.5H3V3.5H7V9.5H12" />
                </g>
            );
    }
}

export function LogicDiagram({
    g,
    subjectId,
    trail,
    onSelect,
    onBack,
}: {
    g: Indexed;
    /**
     * The one thing the reader picked, and the one thing every view is about.
     *
     * A parameter, a signal or a block — whichever it is, it is the centre of
     * the picture and the top of the listing. There is no second selection and
     * no substitution: see useCalibrationWorkspace for what that replaced.
     */
    subjectId: string;
    trail: string[];
    onSelect: (id: string) => void;
    onBack: (id: string) => void;
}) {
    const lang = useDialogLang();
    const [showAll, setShowAll] = useState(false);
    const [showNoise, setShowNoise] = useState(false);
    /**
     * The per-column and per-block caps are ON at the start.
     *
     * ALL lifts them, and it used to start lifted. That was survivable while
     * every box was a wall of formulas — the picture was unreadable either way
     * — and it stopped being survivable the moment the boxes shut. Measured
     * over the 1,384 pictures, at the WIDEST each depth reaches: ALL lit draws
     * 233 boxes at DEPTH 1, 496 at 2 and **637** at 3, in canvases 11,153,
     * 33,194 and 28,482 pixels tall. Capped, the same three are 13, 23 and 32
     * boxes. The medians tell the same story more quietly — 6 / 15 / 33 lit
     * against 6 / 9 / 13 capped — which is why the cap barely shows at DEPTH 1
     * and is the whole difference by DEPTH 3.
     *
     * Nothing goes quiet: what the caps drop is counted into HIDDEN, and the
     * control that lifts them is in the row above it.
     */
    const [everything, setEverything] = useState(false);
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
     * The symbol the reader has picked, if any.
     *
     * With every wire landing on the line that uses it, a busy block has a lot
     * of lines converging on it. Lighting one quantity everywhere it appears —
     * its port, its wire, its leader, every token spelling it, and the rails
     * inside the block — is what keeps that readable.
     *
     * It used to follow the cursor, which made the whole picture change on the
     * way to anything: crossing a formula to reach a port re-lit it once per
     * word. A quantity is now lit because it was CHOSEN, and stays lit until
     * something else is chosen or the choice is cleared — so it can be
     * followed with the eye, or scrolled to, without holding the mouse still.
     */
    const [pickedRaw, setPicked] = useState<{ name: string | null; stamp: string } | null>(null);
    /**
     * Which of the three readings is on screen.
     *
     * They are one axis — outside in — and they all answer about the same
     * subject: NETWORK is how functions connect (the thing Ghidra has no view
     * of), INSIDE is within one function (its Function Graph's question),
     * CODE is the text (its Decompiler's). Switching between them never
     * changes the subject; only what is being asked about it.
     *
     * All three are built from the same recovered statements, the same
     * `guardTree` and the same `rowLinks`, so they cannot contradict each
     * other about the shape of a block or about what feeds what.
     */
    const [viewMode, setViewMode] = useState<'network' | 'inside' | 'code'>('network');
    /** Inside a function: the data flow, or the shape of the conditions. */
    const [insideMode, setInsideMode] = useState<InsideMode>('flow');
    /**
     * Which function INSIDE is showing, when the subject does not name one.
     *
     * A block IS a function; a parameter is used by several, and picking one
     * for the reader is the substitution this whole redesign removed. So the
     * reader picks, and the choice is stamped with the subject it was made
     * under — a function chosen for KF_RF_SOLL means nothing once the subject
     * is something else.
     */
    const [insideAt, setInsideAt] = useState<{ id: string; stamp: string } | null>(null);

    const scroller = useRef<HTMLDivElement | null>(null);
    const restore = useRef<Restore | null>(null);
    /**
     * Bumped when the scroll container is a DIFFERENT element.
     *
     * CODE and the FUNCTION picker replace the canvas outright, and what comes
     * back is a new div. Without noticing that, two things went wrong at once:
     * `placedFor` still matched so nothing was written, and the ResizeObserver
     * below — installed once, with `[]` deps — went on watching the element
     * that had been thrown away. Measured: after one trip through CODE the pane
     * was 397x595 while the canvas was still padded for 633x745, and no later
     * resize could correct it. Element identity is therefore part of what the
     * canvas is "placed for".
     */
    const [mount, setMount] = useState(0);
    const attachScroller = useCallback((el: HTMLDivElement | null) => {
        if (scroller.current === el) return;
        scroller.current = el;
        setMount(m => m + 1);
    }, []);
    /** The subject, pane size and element the canvas was last positioned for. */
    const placedFor = useRef({ focus: '', pane: '', mount: -1 });
    const canvas = useRef<SVGSVGElement>(null);
    /**
     * The pane's own size, and therefore the slack the canvas is padded with.
     *
     * A picture smaller than the pane has NO scroll range, and with no scroll
     * range nothing can be held anywhere: the block that was pressed lands
     * where the corner puts it, and a pinch grows the picture about the pane's
     * centre instead of about the fingers. Centring the content only moved
     * where it could not be held. A pane's worth of padding on every side is
     * what buys the freedom back — every point of the picture can then be put
     * at every point of the pane, and both rules become expressible.
     */
    const [pane, setPane] = useState({ w: 0, h: 0 });
    /** The same numbers, readable during an event without waiting for a render. */
    const paneRef = useRef({ w: 0, h: 0 });
    // Read synchronously, before the first paint — a ResizeObserver only
    // delivers on a frame, and a frame is one paint too late: the canvas would
    // be drawn with no padding and every position taken from it would be wrong
    // by a pane. Re-installed whenever the element changes, or it ends up
    // measuring a div that is no longer on the page.
    useLayoutEffect(() => {
        const el = scroller.current;
        if (!el) return;
        const read = () => {
            const [w, h] = [el.clientWidth, el.clientHeight];
            const was = paneRef.current;
            if (was.w === w && was.h === h) return;
            // The padding IS a pane, so it moves with the pane. Correcting the
            // scroll by half the change keeps whatever is in the middle of the
            // pane in the middle of the pane — which is what collapsing the
            // tree, rotating a phone, or a URL bar retracting must not disturb.
            // A SELECTION always goes home; a resize never does.
            if (was.w || was.h) {
                el.scrollLeft += (w - was.w) / 2;
                el.scrollTop += (h - was.h) / 2;
            }
            paneRef.current = { w, h };
            setPane({ w, h });
        };
        read();
        const ro = new ResizeObserver(read);
        ro.observe(el);
        return () => ro.disconnect();
    }, [mount]);
    /**
     * The node the reader just pressed, and where it sat when they pressed it.
     *
     * Anchoring the new picture on the PREVIOUS focus was not enough, and on a
     * desk it was actively wrong: the block being pressed is somewhere else
     * entirely — a neighbour column, several screens down — and re-rooting slid
     * it to where the last focus had been. Measured at 1,968px across and
     * 5,776px down. The reader pressed a box and the box left.
     *
     * So the anchor is the thing that was pressed, whatever it turns into. It
     * does not move to become the focus; the picture rearranges around it.
     */
    const pressedAt = useRef<{ target: string; dx: number; dy: number } | null>(null);
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

    // What the reader is looking at. The layout pin is scoped to it: navigating
    // draws a different picture, and a pin holding a column at a position from
    // the previous one has nothing to hold it to. Stamped rather than cleared
    // in an effect — a stale pin is simply not a pin, and deciding that during
    // render costs no extra pass.
    const view = subjectId;
    const activePin = pinned?.stamp === view ? pinned : null;
    const ctx = useMemo(
        () => makeContext(g.raw.nodes, g.raw.nameIndex, g.byId, g.raw.glossary, lang, plain),
        [g, lang, plain],
    );
    /**
     * The picture, drawn around the subject. Nothing else.
     *
     * There used to be a fallback here: if what the reader picked did not turn
     * up in the picture, rebuild around `owningBlock` of it instead. That is
     * the layout answering a question the reader did not ask — and since a
     * parameter never appeared in a block-rooted picture as a node, it fired
     * every time a map was picked, which is how selecting `kf_rf_soll` came to
     * show `rf_soll_calc` with the map itself nowhere and its other reader
     * missing. A picture that cannot draw the subject is a bug in the layout,
     * to be fixed there.
     */
    const diagram = useMemo(
        () =>
            buildDiagram(g, subjectId, {
                ctx,
                maxPorts: 14,
                showAllLines: showAll,
                showNoise,
                showEverything: everything,
                depth,
                expanded,
                highlight: subjectId,
                anchor: activePin ?? undefined,
            }),
        [g, subjectId, ctx, showAll, showNoise, everything, depth, expanded, activePin],
    );

    /**
     * The decompiler's own text, for blocks no statement was parsed out of.
     *
     * Fetched once, in the background, as soon as the tab is mounted — not on
     * the switch into CODE. 110 functions have nothing else to show, and
     * arriving a moment after the view would mean the reader first sees the
     * pane say there is nothing here. It is 169 KB over the wire beside a
     * catalog they have already paid 4.53 MB for.
     *
     * A failure is silent and leaves `corpus` null: the listing falls back to
     * naming the reason the block is empty, which is the behaviour that
     * shipped before this existed.
     */
    const [corpus, setCorpus] = useState<DecompCorpus | null>(null);
    useEffect(() => {
        let live = true;
        loadDecompCorpus()
            .then(c => { if (live) setCorpus(c); })
            .catch(() => {});
        return () => { live = false; };
    }, []);

    /**
     * The listing, built only while it is the view on screen.
     *
     * Every statement of every block the picture is showing, which at DEPTH 3
     * with SHOW ALL is a few thousand — not work to do behind a view nobody is
     * looking at.
     */
    const listing = useMemo(
        () => (viewMode === 'code' && diagram ? buildCode(g, diagram, ctx, { corpus }) : null),
        [viewMode, diagram, g, ctx, corpus],
    );

    /** The functions INSIDE could show for this subject, best first. */
    const insideChoices = useMemo(() => {
        const node = g.byId.get(subjectId);
        if (!node) return [];
        return node.t === 'func' ? [node] : usersOf(g, node);
    }, [g, subjectId]);

    /**
     * The function INSIDE is showing, or null while the reader still has to
     * say which. One candidate is not a choice, so it opens itself.
     */
    const insideNode = useMemo(() => {
        if (insideChoices.length === 1) return insideChoices[0];
        const chosen = insideAt?.stamp === subjectId ? insideAt.id : null;
        return insideChoices.find(n => n.id === chosen) ?? null;
    }, [insideChoices, insideAt, subjectId]);

    const inside = useMemo(
        () =>
            viewMode === 'inside' && insideNode
                ? buildInside(insideNode, ctx, { mode: insideMode, showNoise })
                : null,
        [viewMode, insideNode, ctx, insideMode, showNoise],
    );

    /**
     * The size of whatever is being drawn, for zooming and for FIT.
     *
     * Memoised because the gesture handlers close over it: a fresh object each
     * render gives `zoomAbout` a fresh identity, which re-runs the effect that
     * installs the wheel and pointer listeners — tearing the listeners down in
     * the middle of a pinch, which is exactly the failure `zoomRef` exists to
     * avoid on the other axis.
     */
    const canvas2d = useMemo(
        () =>
            inside
                ? { w: inside.width, h: inside.height }
                : diagram
                  ? { w: diagram.width, h: diagram.height }
                  : null,
        [inside, diagram],
    );
    /**
     * What the canvas is currently positioned FOR.
     *
     * Switching view, or switching which function is open inside, is a
     * different drawing in the same pane and has to be placed like any other.
     */
    const canvasKey = inside ? `inside|${inside.block.id}|${insideMode}` : `net|${diagram?.focus}`;

    /**
     * A symbol is lit for as long as the picture it was lit in is on screen.
     *
     * Stamped with the diagram's own focus rather than with `view`, which also
     * carries the selection: pressing a port lights the quantity AND opens it
     * in the panes, and the selection half of that one act was throwing the
     * lighting half away in the same frame.
     */
    const pickStamp = diagram?.focus ?? '';
    /**
     * The subject lights itself.
     *
     * Picking KF_RF_SOLL in the tree used to leave nothing lit: the map became
     * the subject of the picture, and the one thing the picture has for
     * following a quantity — the FOCUS highlight, which dims everything off its
     * path — stayed switched off until the reader worked out that the box was
     * pressable. Clicking that box did exactly this. So selecting does it too.
     *
     * Only when the subject is a QUANTITY. A block is not something that
     * travels along a wire, and lighting its name would dim the whole picture
     * to no purpose; a block subject is already marked by its own highlight.
     */
    const autoPick =
        diagram?.nodes.find(n => n.depth === 0 && n.kind !== 'block')?.label ?? null;
    // `pickedRaw.name === null` is a DELIBERATE clear, and has to outrank the
    // default — otherwise pressing × on the subject's own symbol would light it
    // straight back up.
    const picked = pickedRaw?.stamp === pickStamp ? pickedRaw.name : autoPick;
    /** Pressing the lit symbol again puts the picture back. */
    const pick = useCallback((name?: string) => {
        if (!name) return;
        setPicked(prev => ({
            name: prev?.stamp === pickStamp && prev.name === name ? null : name,
            stamp: pickStamp,
        }));
    }, [pickStamp]);
    /** Clear whatever is lit, and keep it cleared for this picture. */
    const clearPick = useCallback(() => setPicked({ name: null, stamp: pickStamp }), [pickStamp]);

    /**
     * Where the canvas's own top-left sits inside the scrolled content.
     *
     * Zero whenever the picture is bigger than the pane, which is most of the
     * time — but a picture smaller than the pane is centred by the grid, and
     * then every canvas coordinate is offset by half the slack. Measured rather
     * than recomputed, so the one place that decides it is the CSS.
     */
    const canvasOrigin = useCallback(() => {
        const el = scroller.current;
        const svg = canvas.current;
        if (!el || !svg) return { x: 0, y: 0 };
        const a = el.getBoundingClientRect();
        const b = svg.getBoundingClientRect();
        return { x: b.left - a.left + el.scrollLeft, y: b.top - a.top + el.scrollTop };
    }, []);

    const writeScroll = useCallback((left: number, top: number) => {
        const el = scroller.current;
        if (!el) return;
        el.scrollLeft = Math.max(0, left);
        el.scrollTop = Math.max(0, top);
    }, []);

    /**
     * Press a node: open it, and hold it still while the picture rebuilds.
     *
     * The offset is taken here, at the event, because after the rebuild there
     * is nothing left to measure it from — the old layout is gone.
     */
    const press = useCallback(
        (n: DiagramNode) => {
            if (!n.target) return;
            const el = scroller.current;
            // Pressing what is ALREADY the subject changes nothing, so there is
            // nothing to hold — and a hold nobody consumes is one that anchors
            // the next selection instead, wherever that selection comes from.
            // The two cases cannot be told apart after the fact (both were
            // measured in the picture being replaced), so it is settled here.
            if (el && n.target !== subjectId) {
                const z = zoomRef.current;
                const o = canvasOrigin();
                pressedAt.current = {
                    target: n.target,
                    dx: o.x + n.x * z - el.scrollLeft,
                    dy: o.y + n.y * z - el.scrollTop,
                };
            } else {
                pressedAt.current = null;
            }
            onSelect(n.target);
        },
        [onSelect, canvasOrigin, subjectId],
    );

    /**
     * The one place the canvas is allowed to move, and the rule it moves by.
     *
     * > **A change of subject puts the subject at ONE fixed point in the pane —
     * > its centre — computed from (subject, pane, zoom) and nothing else.**
     *
     * The canvas moves at exactly three other moments: a press on the canvas
     * holds the pressed node still; a relayout of the SAME picture applies the
     * anchor that control took at the event; the reader scrolls. History is
     * never consulted.
     *
     * That last clause is the whole fix, and four earlier attempts missed it by
     * improving WHO writes the scroll while leaving WHAT they write made of
     * history. The worst of it was `focusAt`: "put the new focus where the last
     * one was", a deliberate feature that is the exact opposite of what was
     * asked for, unstamped where every other piece of view state is stamped,
     * unclamped, and rewritten by scroll events, zoom, FIT and every layout
     * toggle — including scrolls made in the FUNCTION view, where it measured
     * NETWORK node coordinates against the FUNCTION drawing's origin. Panning
     * the subject to x = -143 and then picking a different parameter put the
     * new subject at x = -143 as well: off screen, twice running.
     *
     * So `focusAt`, `recordFocus`, `rememberFocus` and `lastWritten` are gone,
     * and the rule that used to apply only to the first picture of a session is
     * now the rule for every picture.
     *
     * Keyed on the DIAGRAM's focus rather than on the root: picking a parameter
     * that lives in another block rebuilds the picture around that block
     * without `rootId` changing at all, and a key that missed that rebuild left
     * the canvas pointing into the layout before it.
     */
    useLayoutEffect(() => {
        const el = scroller.current;
        if (!el || !canvas2d) return;
        const o = canvasOrigin();

        // A pane that changed size is a relayout like any other, and the focus
        // has to be put back into it — including the first one, where the pane
        // was measured after the picture was first placed.
        const paneKey = `${pane.w}x${pane.h}`;
        if (
            placedFor.current.focus !== canvasKey ||
            placedFor.current.pane !== paneKey ||
            placedFor.current.mount !== mount
        ) {
            placedFor.current = { focus: canvasKey, pane: paneKey, mount };
            restore.current = null;
            const pressed = pressedAt.current;
            pressedAt.current = null;

            // Inside one function there is no focus BLOCK to hold still — the
            // whole drawing is one function. So it is placed at its beginning,
            // which for the data flow is the right-hand edge: level 0 is what
            // the function reads before it computes anything, and the picture
            // runs right to left like every other one here.
            if (inside) {
                const lead =
                    insideMode === 'flow'
                        ? o.x + inside.width * zoom - el.clientWidth + 16
                        : o.x - 16;
                writeScroll(lead, o.y - 16);
                return;
            }
            if (!diagram) return;

            // Something in the picture was pressed and it is still in the
            // picture: hold IT still, whatever it became. This is the case that
            // matters, because the reader's eye is on the thing under their
            // hand, not on the block that used to be the focus.
            const held = pressed && diagram.nodes.find(n => n.target === pressed.target);
            if (held && pressed) {
                writeScroll(o.x + held.x * zoom - pressed.dx, o.y + held.y * zoom - pressed.dy);
                return;
            }

            // Nothing on the canvas was pressed — the tree, the breadcrumb, the
            // first picture of a session, a cross-reference in the listing.
            // Home, every time.
            const centre = diagram.nodes.find(n => n.depth === 0);
            if (centre) {
                const at = {
                    dx: Math.max(HOME_INSET, (el.clientWidth - centre.w * zoom) / 2),
                    dy: Math.max(HOME_INSET, (el.clientHeight - centre.h * zoom) / 2),
                };
                writeScroll(o.x + centre.x * zoom - at.dx, o.y + centre.y * zoom - at.dy);
            }
            return;
        }

        const r = restore.current;
        restore.current = null;
        if (!r) return;
        if (r.kind === 'scroll') {
            writeScroll(r.left, r.top);
            return;
        }
        const n = diagram?.nodes.find(x => x.id === r.id);
        if (!n) return;
        writeScroll(o.x + n.x * zoom - r.dx, o.y + n.y * zoom - r.dy);
    }, [diagram, inside, insideMode, canvas2d, canvasKey, mount, zoom, pane, canvasOrigin, writeScroll]);

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
            const o = canvasOrigin();
            restore.current = {
                kind: 'node',
                id: n.id,
                dx: o.x + n.x * z - el.scrollLeft,
                dy: o.y + n.y * z - el.scrollTop,
            };
        },
        [diagram, canvasOrigin],
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
        if (el && canvas2d) {
            // The SCROLL has to be read in step too, and reading it off the DOM
            // is not that: `zoomRef` advances at the event, the scroll only
            // when the layout effect runs. A pinch emits several moves per
            // frame, so the second and third of them were dividing a scroll
            // that still belonged to the zoom before the first by the zoom
            // after it — a small error per move, several moves per frame, and
            // the point under the fingers walked away from them. It is a touch
            // failure because a wheel rarely fires twice in one frame.
            const q = restore.current?.kind === 'scroll' ? restore.current : null;
            const o = canvasOrigin();
            const left = q ? q.left : el.scrollLeft;
            const top = q ? q.top : el.scrollTop;
            const px = (left - o.x + cx) / prev;
            const py = (top - o.y + cy) / prev;
            // Clamped to the canvas the NEXT zoom will have, for the same
            // reason: an unclamped shadow is a position the DOM will refuse,
            // and the move after it would build on a number that never was.
            // The origin is the padding, which is a pane and does not change
            // with the magnification.
            const [w, h] = [canvas2d.w * z, canvas2d.h * z];
            const clamp = (v: number, max: number) => Math.min(Math.max(0, v), Math.max(0, max));
            restore.current = {
                kind: 'scroll',
                left: clamp(px * z + pane.w - cx, w + pane.w * 2 - el.clientWidth),
                top: clamp(py * z + pane.h - cy, h + pane.h * 2 - el.clientHeight),
            };
        }
        // In step immediately, because a pinch emits several moves per frame and
        // each one has to see what the one before it decided.
        zoomRef.current = z;
        setZoom(z);
    }, [canvas2d, canvasOrigin, pane]);

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
        if (!el || !canvas2d) return;
        // Never past 1:1 — FIT is for seeing the whole chain, and blowing a
        // two-box diagram up to fill the pane is not what anyone means by it.
        const z = clampZoom(
            Math.min(1, (el.clientWidth - 8) / canvas2d.w, (el.clientHeight - 8) / canvas2d.h),
        );
        if (!Number.isFinite(z)) return;
        // Zero is the corner of the PADDING now, which is a pane away from the
        // drawing. FIT means "show me all of it", so centre what it fitted.
        restore.current = {
            kind: 'scroll',
            left: pane.w + (canvas2d.w * z - el.clientWidth) / 2,
            top: pane.h + (canvas2d.h * z - el.clientHeight) / 2,
        };
        zoomRef.current = z;
        setZoom(z);
    }, [canvas2d, pane]);

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

    /**
     * What this view is NOT showing, as one number with its breakdown on hover.
     *
     * One slot instead of four appearing-and-disappearing counters. A number
     * behind a hover is weaker than a number on screen, and that is the trade:
     * it buys a row whose shape does not depend on what happens to be hidden.
     */
    const hidden: Partial<Record<StringKey, number>> =
        viewMode === 'code'
            ? { linksHidden: listing?.hiddenLinks ?? 0 }
            : inside
              ? { showNoise: inside.hiddenNoise }
              : {
                    blocksHidden: diagram?.hiddenBlocks ?? 0,
                    portsHidden: diagram?.hiddenPorts ?? 0,
                    showAllLines: diagram?.hiddenLines ?? 0,
                    linksHidden: diagram?.hiddenLinks ?? 0,
                    showNoise: diagram?.hiddenNoise ?? 0,
                    loopsHidden: diagram?.hiddenLoops ?? 0,
                };
    const hiddenTotal = Object.values(hidden).reduce((a, b) => a + b, 0);
    const hiddenDetail = Object.entries(hidden)
        .map(([k, v]) => `${t(lang, k as StringKey)}: ${v}`)
        .join('\n');

    /**
     * Where the subject sits between the two ends of the ECU.
     *
     * The picture answers "what feeds this"; it cannot answer "is this near the
     * pedal or near the injector", because it only ever holds a dozen blocks
     * and the ends are usually further out than that. Only 230 of the 1,384
     * block pictures contain an end at all. So the distances are measured on the
     * whole graph and reported as numbers — the ruler — rather than drawn.
     *
     * Every slot is always present, including when the answer is "—". A row
     * whose contents appear and disappear is the thing this screen has been
     * corrected for twice.
     */
    const [mapOpen, setMapOpen] = useState(false);

    const ruler = useMemo(() => {
        const subject = g.byId.get(subjectId);
        // For a parameter, the reading is taken from the blocks that use it:
        // a map is not at a distance from anything, the code that reads it is.
        const blocks = subject
            ? subject.t === 'func'
                ? [subject]
                : usersOf(g, subject)
            : [];
        const r = reach(g);
        const best = (m: Map<string, number>) => {
            let at: number | null = null;
            for (const b of blocks) {
                const v = m.get(b.id);
                if (v != null && (at === null || v < at)) at = v;
            }
            return at;
        };
        let loop = 0;
        for (const b of blocks) loop = Math.max(loop, r.loopSize.get(b.id) ?? 1);
        return { sensor: best(r.fromInput), actuator: best(r.toOutput), loop };
    }, [g, subjectId]);

    /**
     * The return wires this picture draws.
     *
     * Zero is a real answer and gets said as one — but only after checking
     * whether the circle closes just outside the view, which for the maps
     * worth tuning it usually does.
     */
    const loops = diagram?.edges.filter(e => e.back).length ?? 0;

    /**
     * Is there an open box for the line controls to act on?
     *
     * PLUMBING and LINES change what a DRAWN formula shows. With a parameter
     * as the subject every box starts shut, so they change nothing until one
     * is opened — and a control that is lit while it cannot do anything is the
     * defect this row was rebuilt to remove.
     */
    const anythingOpen = Boolean(
        diagram?.nodes.some(n => n.kind === 'block' && n.lines && !n.closed),
    );

    /** What the one sentence answers to on hover, when there is more to say. */
    const noteHint = viewMode === 'network' && diagram ? t(lang, 'loopHint') : undefined;

    /** The one sentence this view adds. Exactly one, always the same slot. */
    const note = listing
        ? `${listing.blocks} / ${listing.statements} ${t(lang, 'codeCounts')}${
              listing.sourced ? ` · ${listing.sourced} ${t(lang, 'codeSourced')}` : ''
          } — ${t(lang, listing.sourced ? 'sourceHint' : 'codeHint')}`
        : inside
          ? !inside.rows.length
              ? t(lang, 'insideNoCode')
              : insideMode === 'branches' && inside.branches === 0
                ? t(lang, 'insideNoBranch')
                : `${inside.block.statements} ${t(lang, 'statementsUnit')} · ${inside.branches} ${t(lang, 'insideBranchCount')}${
                      inside.nesting > 1 ? ` (${t(lang, 'insideNesting')} ${inside.nesting})` : ''
                  }`
          : diagram
            ? `${diagram.paramFocus ? `${diagram.paramFocus} ${t(lang, 'diagramParamFocus')}` : t(lang, 'viewAxisHint')} · ${t(lang, 'loopCount')} ${loops}${
                  loops === 0 && diagram.loopsBeyond > 0 && depth < 3
                      ? `（${t(lang, 'loopDeeper').replace('%s', String(depth + 1))}）`
                      : ''
              }`
            : t(lang, 'viewAxisHint');

    /**
     * The trail, scrolled to its own end.
     *
     * `overflow-x-auto` starts at 0 and nothing moves it, so on a long trail
     * the crumb that matters — the one you are on, at the right — was the one
     * off screen. The guard on `trail.length > 1` is gone too: the height was
     * always reserved, so all that guard did was make the row's contents appear
     * out of nowhere on the second selection.
     */
    const crumbs = useRef<HTMLElement>(null);
    useLayoutEffect(() => {
        const el = crumbs.current;
        if (el) el.scrollLeft = el.scrollWidth;
    }, [trail]);

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
                ref={crumbs}
                className="h-[22px] flex-none flex items-center gap-1 px-1 overflow-x-auto no-scrollbar whitespace-nowrap text-[10px] font-mono"
                aria-label={t(lang, 'blockDiagram')}
            >
                {trail.map((id, i) => {
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
                {/* One row, one membership, one order, in every view.
                    What does not apply here is DARK, not gone, and it still
                    answers: a control the reader can see and cannot use has to
                    be able to say where it does work. Six of these used to be
                    conditionally rendered, so walking NETWORK -> FUNCTION ->
                    CODE changed the row's membership three times and then four;
                    PLUMBING lived in this row for NETWORK and in the honesty
                    line for FUNCTION, which is the operation jumping up and
                    down, literally. */}
                <div className="min-w-0 flex-1 flex items-center gap-3 overflow-x-auto no-scrollbar">
                {/* Outside in, always in this order, always the same three.
                    A reader who has learnt where they are in one view knows
                    where they will be in the next. */}
                <span className="flex-none flex items-center gap-1" title={t(lang, 'viewAxisHint')}>
                    {VIEWS.map(([m, key], i) => (
                        <span key={m} className="flex items-center gap-1">
                            {i > 0 && <span className="text-slate-700">›</span>}
                            <button
                                type="button"
                                className={`transition ${viewMode === m ? 'text-[#26AEE4]' : 'hover:text-slate-300'}`}
                                onClick={() => setViewMode(m)}
                            >
                                {t(lang, key)}
                            </button>
                        </span>
                    ))}
                </span>

                <Ctl
                    label={t(lang, 'insideFlow')}
                    on={insideMode === 'flow'}
                    off={viewMode !== 'inside'}
                    hint={t(lang, 'insideFlowHint')}
                    why={t(lang, 'onlyInFunction')}
                    act={() => setInsideMode('flow')}
                />
                <Ctl
                    label={t(lang, 'insideBranches')}
                    on={insideMode === 'branches'}
                    off={viewMode !== 'inside'}
                    hint={t(lang, 'insideBranchHint')}
                    why={t(lang, 'onlyInFunction')}
                    act={() => setInsideMode('branches')}
                />

                {/* DEPTH is how far the NETWORK reaches, and therefore also how
                    many blocks the listing holds. Inside one function there is
                    no further to reach. The slider keeps its width when dark so
                    nothing to its right moves. */}
                <label
                    className={`flex-none flex items-center gap-1.5 ${viewMode === 'inside' ? 'text-slate-700' : ''}`}
                    title={viewMode === 'inside' ? t(lang, 'notInFunction') : t(lang, 'depthHint')}
                >
                    {t(lang, 'diagramDepth')}
                    <input
                        type="range"
                        min={1}
                        /* Five, not three. Shut boxes made the extra levels
                           affordable — DEPTH 3 now draws a smaller canvas than
                           DEPTH 1 did with the formulas open — and reaching
                           further is what puts a sensor or an actuator in the
                           picture at all: 28 pictures at DEPTH 1, 187 at 3. */
                        max={5}
                        value={depth}
                        disabled={viewMode === 'inside'}
                        onChange={e => {
                            anchorOn();
                            setDepth(Number(e.target.value));
                        }}
                        className="w-16 h-1 accent-blue-500 disabled:accent-slate-700"
                    />
                    <span className={viewMode === 'inside' ? 'font-mono' : 'font-mono text-slate-300'}>{depth}</span>
                </label>

                <Ctl
                    label={t(lang, 'showEverything')}
                    on={everything}
                    off={viewMode === 'inside'}
                    hint={t(lang, 'showEverythingHint')}
                    why={t(lang, 'notInFunction')}
                    act={() => { anchorOn(); setEverything(v => !v); }}
                />
                <Ctl
                    label={t(lang, 'showAllLines')}
                    on={showAll}
                    // The listing draws every statement whatever this says, and
                    // while ALL is lit they are all drawn already.
                    off={viewMode !== 'network' || everything}
                    hint={t(lang, 'showAllLinesHint')}
                    why={everything ? t(lang, 'alreadyAll') : t(lang, 'onlyInNetwork')}
                    act={() => { anchorOn(); setShowAll(v => !v); }}
                />
                <Ctl
                    label={t(lang, 'showNoise')}
                    on={showNoise}
                    off={viewMode === 'code' || (viewMode === 'network' && !anythingOpen)}
                    hint={t(lang, 'showNoiseHint')}
                    why={viewMode === 'code' ? t(lang, 'notInCode') : t(lang, 'openABlockFirst')}
                    act={() => { anchorOn(); setShowNoise(v => !v); }}
                />
                <Ctl
                    label={t(lang, 'decompiledForm')}
                    on={!plain}
                    off={false}
                    hint={t(lang, 'rawFormHint')}
                    why=""
                    act={() => { anchorOn(); setPlain(v => !v); }}
                />
                </div>
                {/* Magnification is a property of the canvas. Dark in the
                    listing rather than absent — the row's shape is a constant. */}
                <span className="flex-none flex items-center gap-1.5">
                    <button
                        type="button"
                        title={viewMode === 'code' ? t(lang, 'notInCode') : t(lang, 'zoomOut')}
                        disabled={viewMode === 'code' || zoom <= ZOOM_MIN}
                        className="w-4 leading-none text-slate-400 transition hover:text-slate-200 disabled:text-slate-700"
                        onClick={() => nudgeZoom(1 / ZOOM_STEP)}
                    >
                        −
                    </button>
                    <span
                        className={`w-9 text-center font-mono tabular-nums ${viewMode === 'code' ? 'text-slate-700' : 'text-slate-300'}`}
                    >
                        {Math.round(zoom * 100)}%
                    </span>
                    <button
                        type="button"
                        title={viewMode === 'code' ? t(lang, 'notInCode') : t(lang, 'zoomIn')}
                        disabled={viewMode === 'code' || zoom >= ZOOM_MAX}
                        className="w-4 leading-none text-slate-400 transition hover:text-slate-200 disabled:text-slate-700"
                        onClick={() => nudgeZoom(ZOOM_STEP)}
                    >
                        +
                    </button>
                    <button
                        type="button"
                        title={viewMode === 'code' ? t(lang, 'notInCode') : t(lang, 'zoomFit')}
                        disabled={viewMode === 'code'}
                        className="transition hover:text-slate-300 disabled:text-slate-700"
                        onClick={fit}
                    >
                        FIT
                    </button>
                </span>
            </div>

            {/* The drawing area, whichever of the three is in it, with the
                map able to cover exactly this and nothing else. Positioned
                here so the row of controls above and the two readout rows
                below stay reachable while the map is open. */}
            <div className="relative flex flex-1 min-h-0 flex-col">
            {listing ? (
                <div className="flex-1 min-h-0">
                    <CalibrationCode
                        listing={listing}
                        lang={lang}
                        picked={picked}
                        onPick={pick}
                        onOpen={onSelect}
                        focusTarget={diagram?.focus}
                    />
                </div>
            ) : viewMode === 'inside' && !insideNode ? (
                /* Several functions use this parameter and none of them is
                   "the" one. Naming them is the answer; choosing one would be
                   the substitution this view exists to have removed. */
                <div className="flex-1 min-h-0 overflow-auto p-3">
                    <p className="text-[11px] text-slate-400">
                        <strong className="font-mono text-[#26AEE4]">
                            {displayName(g.byId.get(subjectId)?.name ?? '', g.byId.get(subjectId)?.t)}
                        </strong>{' '}
                        {t(lang, 'insidePick')}
                    </p>
                    <ul className="mt-2 space-y-1">
                        {insideChoices.map(n => (
                            <li key={n.id}>
                                <button
                                    type="button"
                                    className="font-mono text-[11.5px] text-slate-300 transition hover:text-[#26AEE4]"
                                    onClick={() => setInsideAt({ id: n.id, stamp: subjectId })}
                                >
                                    {displayName(n.name, 'func')}
                                </button>
                                <span className="ml-2 text-[9px] text-slate-600">
                                    {(n.stmts ?? []).length}
                                </span>
                            </li>
                        ))}
                        {!insideChoices.length && (
                            <li className="text-[11px] text-slate-500">{t(lang, 'noDiagram')}</li>
                        )}
                    </ul>
                </div>
            ) : (
            /* The canvas. `touch-action` keeps one-finger scrolling with the
               browser and reserves two fingers for the pinch handler above. */
            <div
                className="flex-1 min-h-0 overflow-auto"
                style={{ touchAction: 'pan-x pan-y' }}
                ref={attachScroller}
                tabIndex={-1}
                onKeyDown={e => { if (e.key === 'Escape') clearPick(); }}
                // A press on the canvas itself is the reader looking away from
                // whatever they had lit. Symbols stop the event before it gets
                // here; nothing else in the picture is meant to hold a choice.
                onClick={e => { if (e.target === e.currentTarget || (e.target as Element).tagName === 'svg') clearPick(); }}
            >
                {!canvas2d ? (
                    <p className="p-4 text-[11px] text-slate-500">{t(lang, 'noDiagram')}</p>
                ) : inside ? (
                    <div style={{ padding: `${pane.h}px ${pane.w}px`, width: 'max-content' }}>
                        <CalibrationInside
                            inside={inside}
                            lang={lang}
                            picked={picked}
                            onPick={pick}
                            canvasRef={canvas}
                            width={inside.width * zoom}
                            height={inside.height * zoom}
                        />
                    </div>
                ) : !diagram ? null : (
                    // A pane of slack on every side. `max-content` so the
                    // padding is added to the drawing rather than measured
                    // against the pane, which would give the two axes different
                    // amounts and only by coincidence the right ones.
                    <div style={{ padding: `${pane.h}px ${pane.w}px`, width: 'max-content' }}>
                    <svg
                        ref={canvas}
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
                            {/* Small, because it lands under a symbol rather
                                than on a box border. `context-stroke` keeps it
                                the colour of the line it ends, so a lit path
                                keeps its heads. */}
                            <marker
                                id="cal-tick"
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

                        {diagram.edges.map((e, i) => (
                            <path
                                key={i}
                                d={e.d}
                                /* A return wire gets the picture's one unused
                                   hue. It runs the other way round, and reading
                                   it as one more forward wire is the mistake
                                   worth spending a colour to prevent — so it is
                                   not a dash: dashes already mean "inferred"
                                   and "one of several tables" here.

                                   `indigo-*`, not `amber-*`: the instrument is
                                   restricted to the ///M tricolor and the amber
                                   ramp is remapped onto violet for machine
                                   state (armed / busy / caution). It would have
                                   painted the same pixels while claiming a role
                                   this wire does not have. See globals.css. */
                                className={`fill-none ${
                                    isLit(picked, e.signal)
                                        ? LIT_STROKE
                                        : e.back
                                          ? 'stroke-indigo-400'
                                          : e.kind === 'write'
                                            ? 'stroke-blue-500'
                                            : e.kind === 'call'
                                              ? 'stroke-slate-700 opacity-60'
                                              : 'stroke-slate-600'
                                }${e.inferred ? ' opacity-50' : ''}`}
                                strokeWidth={isLit(picked, e.signal) ? LIT_WIDTH : undefined}
                                strokeDasharray={e.inferred ? '2 3' : e.alternative ? '4 3' : undefined}
                                markerEnd={e.landed ? undefined : 'url(#cal-arrow)'}
                                opacity={dim(picked, e.signal)}
                            />
                        ))}

                        {/* Border to token. Drawn before the boxes so the
                            formula text sits on top of its own connector. */}
                        {diagram.leaders.map((l, i) => (
                            <path
                                key={`l${i}`}
                                d={l.d}
                                className={picked === l.name ? 'fill-none stroke-[#26AEE4]' : 'fill-none stroke-slate-600'}
                                strokeDasharray="1 2"
                                markerEnd={l.kind === 'in' ? 'url(#cal-tick)' : undefined}
                                opacity={dim(picked, l.name)}
                            />
                        ))}

                        {diagram.nodes.map(n =>
                            n.kind === 'block' ? (
                                <BlockBox
                                    key={n.id}
                                    n={n}
                                    lang={lang}
                                    picked={picked}
                                    onPick={pick}
                                    onPress={press}
                                    onToggle={toggle}
                                />
                            ) : (
                                <PortBox
                                    key={n.id}
                                    n={n}
                                    lang={lang}
                                    glossary={g.raw.glossary}
                                    picked={picked}
                                    onPick={pick}
                                    onPress={press}
                                />
                            ),
                        )}
                    </svg>
                    </div>
                )}
            </div>
            )}

            {mapOpen && (
                <SystemMapPanel
                    g={g}
                    lang={lang}
                    here={g.byId.get(subjectId)?.t === 'func' ? subjectId : (usersOf(g, g.byId.get(subjectId)!)[0]?.id ?? null)}
                    onClose={() => setMapOpen(false)}
                />
            )}
            </div>

            {/* Where this is, between the pedal and the injector.
                Its own row, always present and always the same shape, in all
                three views: the numbers are properties of the SUBJECT, not of
                whichever view happens to be drawing it. */}
            <div className="h-[20px] flex-none flex items-center gap-4 px-1 text-[9px] font-mono uppercase tracking-widest text-slate-600 overflow-hidden">
                <RulerSlot label={t(lang, 'rulerIn')} hint={t(lang, 'rulerInHint')}
                    value={diagram ? `${diagram.ends.inShown}/${diagram.ends.inTotal}` : '—'}
                    lit={Boolean(diagram?.ends.inShown)} />
                <RulerSlot label={t(lang, 'rulerOut')} hint={t(lang, 'rulerOutHint')}
                    value={diagram ? `${diagram.ends.outShown}/${diagram.ends.outTotal}` : '—'}
                    lit={Boolean(diagram?.ends.outShown)} />
                <RulerSlot label={t(lang, 'rulerSensor')}
                    hint={ruler.sensor === null ? t(lang, 'rulerUnreachable') : t(lang, 'rulerSensorHint')}
                    value={ruler.sensor === null ? t(lang, 'rulerNone') : String(ruler.sensor)}
                    lit={ruler.sensor === 0} />
                <RulerSlot label={t(lang, 'rulerActuator')}
                    hint={ruler.actuator === null ? t(lang, 'rulerUnreachable') : t(lang, 'rulerActuatorHint')}
                    value={ruler.actuator === null ? t(lang, 'rulerNone') : String(ruler.actuator)}
                    lit={ruler.actuator === 0} />
                <RulerSlot label={t(lang, 'rulerLoop')} hint={t(lang, 'rulerLoopHint')}
                    value={ruler.loop > 1 ? String(ruler.loop) : t(lang, 'rulerNone')}
                    lit={ruler.loop > 1} />
                <RulerSlot label={t(lang, 'rulerBlocks')} hint={t(lang, 'rulerBlocksHint')}
                    value={String(diagram?.nodes.filter(n => n.kind === 'block').length ?? 0)} />
                <span className="flex-1" />
                {/* The one control on this row, at its end, so the row's left
                    half stays a readout and nothing shifts when it opens. */}
                <button
                    type="button"
                    title={t(lang, 'mapHint')}
                    onClick={() => setMapOpen(v => !v)}
                    className={`flex-none px-1 font-bold transition ${mapOpen ? 'text-[#26AEE4]' : 'text-slate-500 hover:text-slate-300'}`}
                >
                    {t(lang, 'mapOpen')}
                </button>
            </div>

            {/* Three fixed slots, and NO controls. What used to sit here —
                SHOW PLUMBING and ALL LINES — is in the row above, where it now
                stays for every view. One operation must never appear in two
                different rows depending on what is on screen. */}
            <div className="h-[22px] flex-none flex items-center gap-3 px-1 text-[9px] font-mono text-slate-500 overflow-hidden">
                <span className="flex-none tabular-nums" title={hiddenDetail}>
                    {t(lang, 'hiddenLabel')} {hiddenTotal}
                </span>
                <span className="min-w-0 flex-1 truncate" title={noteHint}>
                    {note}
                </span>
                {/* What is lit, and how to stop it being lit. Fixed width, so a
                    long symbol name cannot push anything, and the instruction
                    stands in its place when nothing is lit — a control only
                    reachable by guessing you can press a word is not reachable. */}
                <span className="w-[210px] flex-none flex items-center justify-end gap-1.5">
                    {picked ? (
                        <>
                            <span className="uppercase tracking-widest font-sans font-bold text-slate-600">
                                {t(lang, 'focusLabel')}
                            </span>
                            <strong className="min-w-0 truncate text-[#26AEE4]">{picked}</strong>
                            <button
                                type="button"
                                title={t(lang, 'focusClear')}
                                className="flex-none px-1 leading-none text-slate-500 transition hover:text-slate-200"
                                onClick={clearPick}
                            >
                                ×
                            </button>
                        </>
                    ) : (
                        <span className="truncate text-slate-700">{t(lang, 'focusPrompt')}</span>
                    )}
                </span>
            </div>
        </div>
    );
}

/**
 * One reading on the ruler: a fixed label, a value, and an explanation.
 *
 * The label never changes and the value is `—` rather than absent when there
 * is no answer, so the row is the same width whatever is on screen. `lit` is
 * for "you are AT this end", which is the one state worth noticing at a
 * glance — a block that reads a sensor itself, or drives an actuator itself.
 */
function RulerSlot({
    label,
    value,
    hint,
    lit,
}: {
    label: string;
    value: string;
    hint: string;
    lit?: boolean;
}) {
    return (
        <span className="flex-none flex items-baseline gap-1" title={hint}>
            <span>{label}</span>
            <strong className={`tabular-nums font-bold ${lit ? 'text-[#26AEE4]' : 'text-slate-400'}`}>
                {value}
            </strong>
        </span>
    );
}

/**
 * The whole controller as named regions, with the unnamed part drawn at its
 * true size.
 *
 * Areas are proportional to the block count, so the region a reader notices
 * first is the one that is actually biggest — which here is "unclassified",
 * 1,232 of 1,705. That is the point of drawing it: the map's own coverage is
 * the first thing it tells you, before any of the names on it.
 */
function SystemMapPanel({
    g,
    lang,
    here,
    onClose,
}: {
    g: Indexed;
    lang: Lang;
    here: string | null;
    onClose: () => void;
}) {
    const map = useMemo(() => systemMap(g, lang), [g, lang]);
    const mine = here ? map.sectionOf.get(here) : undefined;
    const cells = [
        ...map.regions.map(r => ({
            key: r.section,
            title: r.title,
            n: r.blocks.length,
            named: true,
        })),
        {
            key: '',
            title: t(lang, 'mapUnplaced'),
            n: map.unplaced.length,
            named: false,
        },
    ].sort((a, b) => b.n - a.n);
    const placed = map.total - map.unplaced.length;

    return (
        <div className="absolute inset-0 z-20 flex flex-col bg-slate-950 p-3">
            <div className="flex-none flex items-baseline gap-3 pb-2 text-[9px] font-mono uppercase tracking-widest text-slate-500">
                <strong className="text-slate-300">{t(lang, 'mapTitle')}</strong>
                <span className="tabular-nums">
                    {t(lang, 'mapCoverage').replace('%s', String(placed)).replace('%s', String(map.total))}
                </span>
                <span className="flex-1" />
                <button
                    type="button"
                    onClick={onClose}
                    className="px-1 font-bold text-slate-500 transition hover:text-slate-200"
                >
                    {t(lang, 'mapClose')}
                </button>
            </div>
            <p className="flex-none pb-2 text-[10px] leading-relaxed text-slate-500">{t(lang, 'mapHint')}</p>
            <div className="flex min-h-0 flex-1 flex-wrap content-start gap-1 overflow-y-auto">
                {cells.map(c => {
                    // Area, not a row: the eye compares areas, and the honest
                    // comparison here is 1,232 against 147.
                    const side = Math.max(58, Math.round(Math.sqrt(c.n) * 13));
                    const isHere = c.named ? mine === c.key : Boolean(here) && mine === undefined;
                    return (
                        <div
                            key={c.key || 'none'}
                            title={c.named ? `${c.key} ${c.title} — ${c.n}` : t(lang, 'mapUnplacedHint')}
                            style={{ width: side, height: side }}
                            /* Dashed, always: which region a block belongs to is
                               voted for by what it touches, never stated. */
                            className={`flex flex-col justify-between overflow-hidden rounded-sm border border-dashed p-1 ${
                                isHere
                                    ? 'border-[#26AEE4] bg-[#26AEE4]/10'
                                    : c.named
                                      ? 'border-slate-700 bg-slate-900/60'
                                      : 'border-slate-800 bg-slate-900/30'
                            }`}
                        >
                            <span className={`text-[9px] leading-tight ${c.named ? 'text-slate-400' : 'text-slate-600'}`}>
                                {c.title}
                            </span>
                            <span className="flex items-baseline justify-between gap-1">
                                <span className="text-[10px] font-bold tabular-nums text-slate-500">{c.n}</span>
                                {isHere && (
                                    <span className="text-[8px] uppercase tracking-widest text-[#26AEE4]">
                                        {t(lang, 'mapYouAreHere')}
                                    </span>
                                )}
                            </span>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

/** The three views, in the one order they are ever drawn in. */
const VIEWS = [
    ['network', 'viewNetwork'],
    ['inside', 'viewFunction'],
    ['code', 'viewCode'],
] as const;

/**
 * One control, always in the same place, in one of three states.
 *
 * Lit is on, dim is off, DARK is "not in this view" — and dark still answers,
 * because a control the reader can see and cannot use has to be able to say
 * where it does work. `aria-disabled` rather than `disabled`: a disabled button
 * receives no mouse events, so its title would never appear and the dark state
 * would be mute.
 *
 * Dark is slate-700, not slate-800. Against this app's near-black ground
 * slate-800 was legible only as an absence — which is the thing being fixed,
 * arrived at by a different route.
 *
 * The label never changes with the state. It used to — PLAIN/AS DECOMPILED is 5
 * characters against 13, SHOW PLUMBING (+3)/HIDE PLUMBING is 18 against 13 —
 * and every one of those flips moved every control to its right.
 */
function Ctl({
    label,
    on,
    off,
    why,
    hint,
    act,
}: {
    label: string;
    on: boolean;
    off: boolean;
    /** What the control does. Shown when it is usable. */
    hint: string;
    /** Where it DOES work. Shown when it is dark. */
    why: string;
    act: () => void;
}) {
    return (
        <button
            type="button"
            aria-disabled={off}
            aria-pressed={!off && on}
            title={off ? why : hint}
            onClick={off ? undefined : act}
            className={`flex-none transition ${
                off ? 'cursor-default text-slate-700' : on ? 'text-[#26AEE4]' : 'hover:text-slate-300'
            }`}
        >
            {label}
        </button>
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

/** Everything not on the picked path recedes; nothing disappears. */
/**
 * How far everything OFF the lit path recedes.
 *
 * 0.25, and it made the rest of the picture unreadable rather than quiet — the
 * brightest formula text in the instrument is slate-300 (#C6C6CF), and on true
 * black at 0.25 that composites to #323232, a contrast ratio of **1.6:1**. Text
 * at 1.6:1 is not dim, it is gone. The picture always has something lit, too:
 * selecting a parameter lights it by itself, so this was the DEFAULT state of
 * every picture rather than something the reader opted into.
 *
 * 0.6 was the first correction and it was still too dark, because slate-300 is
 * not the text that matters: most of a formula is slate-400 symbols, and those
 * come to **3.1:1** at 0.6 — under the 4.5:1 anything read as prose needs. The
 * three weights the picture uses, over true black:
 *
 *              slate-300      slate-400      slate-600
 *     0.25      1.6:1          1.3:1          1.1:1     unreadable
 *     0.60      4.7:1          3.1:1          1.5:1     still under, for symbols
 *     0.85      8.8:1          5.5:1          2.1:1
 *
 * So 0.85: everything a reader reads clears 4.5:1, and only `plumbing` — which
 * is meant to recede and is folded away by default anyway — stays faint. The
 * question this view exists to answer is how the selection RELATES to the rest,
 * and that cannot be answered against a page that has been turned down.
 *
 * The focus is carried by ADDING to the lit path instead: the accent colour on
 * its wires, a heavier stroke, bold and an underline on its symbol, and a band
 * behind the row that uses it. Emphasis by addition survives being surrounded
 * by things you can still read; emphasis by subtraction does not.
 */
// The rule itself is in `focus.ts`, shared with FUNCTION and CODE. It was
// here, and they each had their own — see the note there.

/**
 * What an empty box says, and what it says on hover.
 *
 * A table rather than a nested ternary. The exporter has since stopped
 * dropping `FUN_` functions and the 1,061 duly moved: `noFormula` now
 * describes nobody and `sourceOnly` describes 321. The wording each state
 * carries stays findable in one place rather than folded into a render
 * expression, which is what made that move a one-line edit.
 */
const EMPTY_LABEL = {
    noFormula: 'blockNoFormula',
    sourceOnly: 'blockSourceOnly',
    allPlumbing: 'blockAllPlumbing',
} as const satisfies Record<string, StringKey>;

const EMPTY_HINT = {
    noFormula: 'blockNoFormulaHint',
    sourceOnly: 'blockSourceOnlyHint',
    allPlumbing: 'blockAllPlumbingHint',
} as const satisfies Record<string, StringKey>;

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
    picked,
    onPick,
    onPress,
}: {
    n: DiagramNode;
    lang: 'ja' | 'en';
    glossary: Record<string, string>;
    picked: string | null;
    onPick: (name?: string) => void;
    onPress: (n: DiagramNode) => void;
}) {
    // `n.key` is the LOCATION now (`master:N`, `shared:P_UMG`), so the glossary
    // has to be asked about the label, which is still the plain symbol.
    const reading = readMnemonic(n.label, glossary, lang)?.reading;
    const where = n.shared
        ? `\n${t(lang, 'sharedMemory')}`
        : n.detail
          ? `\n${t(lang, n.detail === 'master' ? 'masterOnly' : 'slaveOnly')}`
          : '';
    const edge = n.boundary ? BOUNDARY_TIP(lang, n.boundary) : '';
    const tip = `${n.label} — ${t(lang, KIND_LABEL[n.kind])}${where}${edge}${reading ? `\n${t(lang, 'mnemonicReading')}: ${reading}` : ''}`;
    const lit = picked === n.label;
    // Picking a port both lights its path and opens it in the panes, which is
    // one act: what a reader wants from a port is to look at that quantity.
    // Selecting a parameter deliberately leaves the picture where it is, so the
    // two do not fight — see useCalibrationWorkspace.
    const act = () => {
        onPick(n.label);
        onPress(n);
    };
    return (
        <g
            className="cursor-pointer"
            transform={`translate(${n.x} ${n.y})`}
            onClick={act}
            tabIndex={0}
            role="button"
            opacity={dim(picked, n.label)}
            {...pressGuards(act)}
        >
            <title>{tip}</title>
            <rect
                width={n.w}
                height={n.h}
                rx={n.kind === 'constant' ? n.h / 2 : 3}
                className={
                    n.highlight || lit
                        ? 'fill-slate-900 stroke-[#26AEE4]'
                        : n.boundary
                          ? 'fill-slate-900 stroke-slate-400'
                          : PORT_RECT[n.kind]
                }
                strokeWidth={n.highlight || lit ? 1.5 : 1}
            />
            <g transform={`translate(9 ${(n.h - 12) / 2})`}>
                <KindGlyph kind={n.kind} />
            </g>
            <text x={28} y={n.h / 2 + 4} className={`text-[11.5px] ${PORT_TEXT[n.kind]}${n.highlight ? ' font-bold' : ''}`}>
                {n.label}
            </text>
            {/* Which processor's memory this is, or that both can see it.
                The two CPUs each have their own `N`, at two different
                addresses, and now that they are two boxes rather than one weld
                the reader needs a letter to tell them apart. The label cannot
                carry it: wires and formula tokens are matched by the label. */}
            {(n.shared || n.detail) && (
                <text
                    x={n.w - (n.boundary ? 28 : 6)}
                    y={n.h / 2 + 3}
                    textAnchor="end"
                    className={`text-[8px] font-bold tracking-widest ${n.shared ? 'fill-[#26AEE4]/70' : 'fill-slate-600'}`}
                >
                    {n.shared ? 'DPR' : n.detail === 'master' ? 'M' : 'S'}
                </text>
            )}
            {/* This box is where the ECU meets the engine. Twenty-one registers
                the hardware sets and thirty-three the code drives; everything
                else on any picture is in between. Only 230 of the 1,384 block
                pictures contain one, which is why the ruler carries the
                distance for all the others. */}
            {n.boundary && (
                <text
                    x={n.w - 6}
                    y={n.h / 2 + 3}
                    textAnchor="end"
                    className="text-[8px] font-bold tracking-widest fill-slate-300"
                >
                    {n.boundary === 'in' ? 'IN' : 'OUT'}
                </text>
            )}
        </g>
    );
}

function BlockBox({
    n,
    lang,
    picked,
    onPick,
    onPress,
    onToggle,
}: {
    n: DiagramNode;
    lang: 'ja' | 'en';
    picked: string | null;
    onPick: (name?: string) => void;
    onPress: (n: DiagramNode) => void;
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
                className={`fill-slate-950 ${
                    n.highlight ? 'stroke-[#26AEE4]' : n.closed ? 'stroke-slate-600' : n.collapsed ? 'stroke-slate-800' : 'stroke-slate-700'
                }`}
                strokeWidth={n.highlight ? 1.5 : 1}
                strokeDasharray={n.collapsed && !n.closed ? '5 3' : undefined}
            />
            <rect width={n.w} height={24} rx={5} className="fill-blue-500/10" />

            {/* Row to row inside this block, in the left gutter so it never
                crosses text. A `writes` link — several rows that are successive
                values of one quantity — is the stronger claim of the two and
                carries the stronger line. */}
            {(n.rails ?? []).map((r, i) => {
                // A step brighter than they were. They were drawn at slate-700
                // while five out of six of them were missing; now that they are
                // all here they have to be findable without the reader having
                // to point at the exact word first.
                const stroke =
                    picked === r.name
                        ? 'stroke-[#26AEE4]'
                        : r.kind === 'writes'
                          ? 'stroke-slate-500'
                          : 'stroke-slate-600';
                const o = dim(picked, r.name);
                return (
                    <g key={`r${i}`}>
                        <path d={r.d} className={`fill-none ${stroke}`} opacity={o} />
                        {/* Each landing drawn on its own, because a marker only
                            ever goes on the end of a whole path. */}
                        {r.heads.map((h, k) => (
                            <path
                                key={k}
                                d={h}
                                className={`fill-none ${stroke}`}
                                markerEnd="url(#cal-tick)"
                                opacity={o}
                            />
                        ))}
                    </g>
                );
            })}

            <text
                className={`text-[12.5px] font-bold cursor-pointer ${n.collapsed ? 'fill-slate-300' : 'fill-[#26AEE4]'}`}
                x={textX}
                y={17}
                onClick={() => onPress(n)}
            >
                {n.label}
            </text>
            {/* On every box, the subject included. The subject used to be
                exempt because it was always drawn open; now that it starts
                shut like the rest, exempting it left the one box the reader
                came for with no way to open it. */}
            {(
                <g
                    className="cursor-pointer"
                    transform={`translate(${n.w - 24} 5)`}
                    onClick={open}
                    role="button"
                    tabIndex={0}
                    {...pressGuards(open)}
                >
                    {/* Shut, or open with more inside, both mean "press to see
                        more" — so both get the plus. It used to follow only the
                        second, which drew a minus on a box that was already
                        closed. */}
                    <title>{t(lang, n.closed || (n.moreLines ?? 0) > 0 ? 'expandBlock' : 'collapseBlock')}</title>
                    <rect width={16} height={14} rx={3} className="fill-slate-800 stroke-slate-700" />
                    <text x={8} y={11} textAnchor="middle" className="fill-slate-300 text-[11px]">
                        {n.closed || (n.moreLines ?? 0) > 0 ? '+' : '−'}
                    </text>
                </g>
            )}
            {/* Which processor this block runs on — on EVERY box now, not only
                the focus. The two CPUs are separate computers and a picture can
                hold both `dpr_sync` blocks at once; without the badge they are
                two boxes with one name and no way to tell which is which. */}
            {n.detail && (
                <text
                    className="fill-slate-500 text-[10px]"
                    x={n.depth === 0 ? n.w - 10 : n.w - 52}
                    y={17}
                    textAnchor="end"
                >
                    {t(lang, n.detail === 'master' ? 'master' : 'slave')}
                </text>
            )}
            {/* One condition over the run of rows it governs, with a bracket
                down their left. The condition used to be reprinted on every
                one of those rows, which said "these lines each have a
                condition" where the truth is "these lines are one branch". */}
            {(n.bands ?? []).map((b, i) => (
                <path key={`b${i}`} d={b.d} className="fill-none stroke-slate-700" />
            ))}
            {(n.guards ?? []).map((gd, i) => (
                <text key={`gd${i}`} className="fill-slate-500 italic text-[10.5px]" x={gd.x} y={gd.y}>
                    {/* The condition as decompiled, for checking the reading
                        against — the same courtesy the formula line has always had. */}
                    <title>{`${t(lang, 'rawCondition')}: ${gd.raw}`}</title>
                    {gd.text}
                </text>
            ))}

            {/* Where statements were passed over. Drawn muted and short: it is a
                gap in the listing, not a line of the block. */}
            {(n.elisions ?? []).map((e, i) => (
                <text key={`e${i}`} className="fill-slate-600 text-[9.5px]" x={e.x} y={e.y}>
                    <title>{t(lang, 'elidedHint')}</title>
                    {e.text}
                </text>
            ))}

            {rows.map((row, i) => {
                const line = lines[i];
                if (!line) return null;
                const out: ReactElement[] = [];
                // The row this box is on the picture FOR. A band behind it, so
                // the reader lands on it before reading: a block can be a
                // hundred rows tall and one of them is the reason it is here.
                if (row.subject) {
                    out.push(
                        <rect
                            key={`s${i}`}
                            x={2}
                            y={row.formulaY - 11}
                            width={n.w - 4}
                            height={15}
                            rx={2}
                            className="fill-[#26AEE4]/10 stroke-[#26AEE4]/30"
                        />,
                    );
                }
                out.push(
                    <Formula
                        key={`f${i}`}
                        x={row.x}
                        y={row.formulaY}
                        out={row.out}
                        tokens={row.tokens}
                        title={line.raw}
                        picked={picked}
                        onPick={onPick}
                    />,
                );
                if (row.glossY !== null) {
                    const clipped = Boolean(line.glossFull && line.glossFull !== line.gloss);
                    out.push(
                        <text key={`m${i}`} className="fill-slate-500 text-[10.5px]" x={row.x + 12} y={row.glossY}>
                            {clipped && <title>{line.glossFull}</title>}
                            {line.gloss}
                        </text>,
                    );
                }
                return out;
            })}
            {/* Why this box is empty, when it is. THREE different facts, and
                two of them the reader can act on. Saying nothing made a blank
                box read as a tool that had failed — and 68% of the block boxes
                drawn are blank; saying the same thing about all of them was
                worse, because for 110 it was untrue. */}
            {n.empty && (
                <text
                    className={`text-[10px] italic ${
                        n.empty === 'sourceOnly' ? 'fill-slate-500' : 'fill-slate-600'
                    }`}
                    x={textX}
                    y={n.h - 9}
                >
                    <title>{t(lang, EMPTY_HINT[n.empty])}</title>
                    {t(lang, EMPTY_LABEL[n.empty])}
                </text>
            )}
            {/* Shut: its size, and the fact that it opens. A row count is the
                one number worth carrying here — it is what the reader is
                deciding about when they decide whether to open it. */}
            {n.closed && (n.inside ?? 0) > 0 && (
                <text
                    className="fill-slate-600 text-[9px]"
                    x={n.w - 30}
                    y={16}
                    textAnchor="end"
                >
                    {n.inside}
                </text>
            )}
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
}) {
    const lit = (name?: string) => (name && name === picked ? ' font-bold underline' : '');
    return (
        <text className="text-[11.5px]" x={x} y={y}>
            {/* The decompiler's own wording, for checking the rewrite against. */}
            {title && <title>{title}</title>}
            <tspan
                className={`fill-blue-300 font-bold cursor-pointer${lit(out.name)}`}
                opacity={dim(picked, out.name)}
                onClick={() => onPick(out.name)}
            >
                {out.text}
            </tspan>
            <tspan className="fill-slate-500"> = </tspan>
            {tokens.map((tk, i) => (
                <tspan
                    key={i}
                    // Alternatives — one of several tables, chosen by engine
                    // state — keep the armed channel they have always had.
                    className={`${tk.alt ? 'fill-amber-400' : TOKEN_CLASS[tk.role]}${lit(tk.name)}${tk.name ? ' cursor-pointer' : ''}`}
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
