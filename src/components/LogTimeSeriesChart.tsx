import React, { useMemo } from 'react';
import dynamic from 'next/dynamic';
import { LogDataPoint } from '@/lib/types';
import { Layout, Config, Data } from 'plotly.js';
import { FieldKey, LOG_FIELD_REGISTRY, isFieldPresent, DEFAULT_FIELD_VISIBILITY } from '@/lib/field-registry/registry';
import type { PlotParams } from 'react-plotly.js';
import type { PlotMouseEvent } from 'plotly.js';

// Dynamically import Plotly to avoid SSR issues
// Typed as react-plotly.js's own props: `dynamic()` widens the component to one with no props, so
// a cast is unavoidable, but casting to the real type keeps every prop below checked.
const Plot = dynamic(() => import('react-plotly.js'), { ssr: false }) as React.ComponentType<PlotParams>;

/** Three scales on one time axis, so three y-axes: RPM left, Load and Lambda overlaid right.
 *
 *  Module scope on purpose. react-plotly.js decides whether to re-run Plotly.react purely by
 *  reference-comparing data / layout / config (its factory's componentDidUpdate), so anything rebuilt
 *  per render forces a full pass — this used to fire on every live sample. Everything that does not
 *  depend on props lives here and is therefore referentially frozen for the life of the module. */
const BASE_LAYOUT: Partial<Layout> = {
    paper_bgcolor: 'transparent',
    plot_bgcolor: 'transparent',
    margin: { l: 60, r: 60, t: 30, b: 40 },
    showlegend: true,
    hovermode: 'x unified',
    clickmode: 'event',
    dragmode: 'pan',
    hoverlabel: {
        bgcolor: 'rgba(23, 23, 28, 0.95)', // panel charcoal with slight opacity
        bordercolor: '#2A2A33',
        font: { family: 'sans-serif', size: 12, color: '#F2F2F5' }, // near-white
        namelength: -1,
    },
    legend: {
        orientation: 'h',
        y: 1.1,
        x: 0,
        font: { color: '#9A9AA8' },
        bgcolor: 'rgba(0,0,0,0)',
    },
    xaxis: {
        title: { text: 'Time (s)' },
        color: '#70707E',
        gridcolor: '#17171C',
        zerolinecolor: '#2A2A33',
        domain: [0, 1],
        showspikes: true,
        spikethickness: 1,
        spikedash: 'solid',
        spikemode: 'across',
        spikecolor: 'rgba(154, 154, 168, 0.2)', // slate-400 charcoal at 20% — very subtle
    },
    // RPM (left)
    yaxis: {
        title: { text: 'RPM', font: { color: '#9A9AA8' } },
        tickfont: { color: '#9A9AA8' },
        side: 'left',
        range: [0, 9000],
        gridcolor: '#17171C',
        tickmode: 'array',
        tickvals: [0, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000],
        ticktext: ['0', '1k', '2k', '3k', '4k', '5k', '6k', '7k', '8k', '9k'],
        fixedrange: true,
        showspikes: false, // only the vertical spike
    },
    // Lambda (right)
    yaxis2: {
        title: { text: 'Lambda', font: { color: LOG_FIELD_REGISTRY.stft1.color } },
        tickfont: { color: LOG_FIELD_REGISTRY.stft1.color },
        overlaying: 'y',
        side: 'right',
        range: [0.65, 1.35],
        showgrid: false,
        fixedrange: true,
        showspikes: false,
        // Pinned visible so hiding both lambda traces cannot drop the axis and re-widen the plotting
        // area — that resize would read as exactly the rebuild this component is arranged to avoid.
        visible: true,
    },
    // Load (right, overlaid). Load is 0-120 against RPM's 0-9000; sharing the left axis would park it
    // in the bottom 1% of the plot.
    yaxis3: {
        title: { text: 'Load %', font: { color: '#0A9BDB' } },
        tickfont: { color: '#0A9BDB' },
        overlaying: 'y',
        side: 'right',
        range: [0, 120],
        position: 0.95,
        anchor: 'x',
        showgrid: false,
        fixedrange: true,
        showspikes: false,
    },
};

/** Resolved once, at module load, so the pre-paint correction below can call it synchronously.
 *  Awaiting the dynamic import inside the effect is what deferred the fix past the browser's paint
 *  and drew the frame twice — once at the stale range, once right. That is what tore.
 *
 *  'plotly.js/dist/plotly', not 'plotly.js': the bare specifier resolves to the source build, which
 *  reaches traces/image and its `require('buffer/')` Node polyfill and fails the Turbopack build.
 *  This is also the module react-plotly.js itself loads, so nothing is bundled twice. */
let plotlyModule: { relayout: (gd: HTMLElement, update: Record<string, unknown>) => Promise<unknown> } | null = null;
if (typeof window !== 'undefined') {
    void import('plotly.js/dist/plotly').then(m => { plotlyModule = m; });
}

/** Also module scope, for the same reference-equality reason as BASE_LAYOUT. */
const PLOT_CONFIG: Partial<Config> = {
    displayModeBar: false,
    scrollZoom: true,
    responsive: true,
    doubleClick: false,
};

/** Tween only when it can actually look like one. Above this many points a redraw beats an animation,
 *  and the "smooth" setting makes the toggle feel slower rather than softer. */
const TRANSITION_MAX_POINTS = 500;
const TOGGLE_TRANSITION: Partial<Layout>['transition'] = { duration: 250, easing: 'cubic-in-out' };

interface Props {
    data: LogDataPoint[];
    selectedIndex?: number | null;
    onPointClick?: (index: number) => void;
    visibleFields?: Record<FieldKey, boolean>;
    /** Full/raw log used only to decide which optional series exist, so the trace set stays stable
     *  even when the filtered view (`data`) is empty. Falls back to `data` when not provided. */
    presenceData?: LogDataPoint[];
    /** True while the DME is recording. Suppresses the transition: the series grows on every flush,
     *  and tweening a lengthening line makes it crawl instead of extend. */
    live?: boolean;
    /** Bump to drop the user's zoom and re-fit the window. Feeds uirevision — see the layout memo
     *  for why an explicit autorange is not enough on its own. */
    fitToken?: number;
    /** Scroll the SHARED window by a signed number of points. The same call the slider makes, so a
     *  horizontal swipe and a slider drag are one operation. Omit and horizontal swipes are ignored. */
    onPanWindow?: (deltaPoints: number) => void;
    /** Whether the window can actually move — i.e. the log is longer than one window. False means
     *  `onPanWindow` would clamp straight back to 0, and a horizontal swipe pans the zoomed axis
     *  instead. The chart cannot work this out for itself: it only ever sees the window, which looks
     *  identical whether it is the whole log or a slice of one. */
    canPanWindow?: boolean;
    /** Identifies the log on screen, NOT the window into it. Feeds uirevision: a new log should drop
     *  the zoom, scrubbing the same log should not. Live logging keeps one key while data grows. */
    logKey?: string;
}

/** Wrapped in React.memo so the page's per-sample re-render during a log run stops at this boundary.
 *  Without it the live HUD's state updates would drag a full Plotly pass along ~8 times a second. */
export const LogTimeSeriesChart = React.memo(function LogTimeSeriesChart({
    data, selectedIndex, onPointClick, visibleFields = DEFAULT_FIELD_VISIBILITY, presenceData, live = false, fitToken = 0, onPanWindow, canPanWindow = false, logKey = 'none',
}: Props) {
    const lastHoveredIndex = React.useRef<number | null>(null);
    const wrapperRef = React.useRef<HTMLDivElement>(null);
    /**
     * The current window, for the gesture effect to read WITHOUT depending on it.
     *
     * `data` in that effect's dependency list is a gesture killer, and it killed this one: a pan
     * moves the window, the window is `data`, so the effect tore down and re-added its listeners in
     * the middle of the drag — resetting `tracking`, `decided` and the pointer id. The drag stopped
     * dead after its first frame while the finger was still down, and Plotly (which had the touch
     * stream all along, see below) went on moving the chart. That is most of what "the position is
     * wrong when I let go" was.
     */
    const dataRef = React.useRef(data);
    // After every render, never during one: the gesture handlers read this from user events, which
    // are always later than the commit that set it.
    React.useEffect(() => { dataRef.current = data; });
    /** First timestamp of the previous window, read only inside the layout effect below. */
    const prevFirstTimeRef = React.useRef<number | null>(null);
    const presenceSource = presenceData && presenceData.length > 0 ? presenceData : data;

    /**
     * Two-finger horizontal swipe scrolls the shared data WINDOW. Vertical and pinch keep zooming the
     * chart's own axis. On a touchscreen the same split, by finger count: one finger sideways moves
     * the window, two fingers magnify (see `pinch` below).
     *
     * The distinction is the whole point. Panning Plotly's x-range would move this chart and nothing
     * else, and the row table sitting beside it would go on showing a different slice of the log —
     * which is exactly the desync that made clicking a point stop jumping to its row. So a horizontal
     * swipe is routed to the same `panWindow` the slider calls: one window, both views, one gesture.
     *
     * Zoom stays chart-local on purpose. It is a magnification of what is already on screen, not a
     * change of which data is on screen, so there is nothing for the table to follow.
     *
     * Plotly reads only `deltaY` — measured, a pure horizontal wheel moves nothing at all while still
     * being preventDefault'd, so the gesture just dies, and a diagonal swipe zooms even when the
     * horizontal component clearly dominates. The split therefore has to happen before Plotly's own
     * handler on the drag layer, hence capture phase. ctrlKey (pinch on every precision trackpad) is
     * handed straight through.
     *
     * Pixels are converted to points against the plotting area so the data tracks the fingers 1:1,
     * and coalesced onto an animation frame — a swipe emits wheel events far faster than re-slicing a
     * 2,000-row window and rebuilding the table costs.
     *
     * When there is NO window to move — a log that fits inside LOG_WINDOW_SIZE, so `maxWindowStart`
     * is 0 and panWindow can only ever clamp back to 0 — the swipe pans the zoomed axis instead.
     * Without that branch the gesture died outright on every short log: panWindow did nothing while
     * preventDefault had already taken the event away from Plotly, so a zoomed chart could not be
     * scrolled at all. The fallback is safe precisely because the window is degenerate here: every
     * row is already on screen in the table, so moving the chart's own range cannot desync the two.
     */
    React.useEffect(() => {
        const wrapper = wrapperRef.current;
        if (!wrapper) return;
        let pendingPx = 0;
        /** Sub-point remainder of the pan, kept across frames. See where it is spent. */
        let pendingPoints = 0;
        let frame = 0;

        const apply = () => {
            frame = 0;
            const px = pendingPx;
            pendingPx = 0;
            const data = dataRef.current;
            // Plotly hangs the resolved layout off the graph div; not in @types/plotly.js because it
            // is internal, so name only the fields actually read rather than reaching for `any`.
            type ResolvedAxis = { range?: [number, number]; autorange?: boolean | string };
            type ResolvedLayout = { width?: number; margin?: { l: number; r: number }; xaxis?: ResolvedAxis };
            const gd = wrapper.querySelector('.js-plotly-plot') as (HTMLElement & { _fullLayout?: ResolvedLayout }) | null;
            const full = gd?._fullLayout;
            if (!gd || full?.width === undefined || !full.margin) return;
            const plotWidth = full.width - full.margin.l - full.margin.r;
            if (!(plotWidth > 0) || data.length === 0) return;

            const ax = full.xaxis;

            if (canPanWindow && onPanWindow) {
                // Points per pixel across what is ON SCREEN — not across the window.
                //
                // The two are the same only when nothing is magnified, and this used to assume it
                // always: a pixel moved `data.length / plotWidth` points whatever the axis range
                // was, so at 2x zoom the log went past at twice the speed of the finger and at 10x,
                // ten times. Measured at 375px on a 2,000-point window magnified 2x: a 30px drag
                // moved the window 235 points where the finger had asked for 118.
                //
                // `zoom` is the fraction of the window the axis is showing — 1 fitted, 1/4 at 4x —
                // and it is exactly the factor the rate was out by.
                const windowSpan = data.length > 1 ? data[data.length - 1].time - data[0].time : 0;
                const zoom = ax?.range && windowSpan > 0
                    ? Math.min(1, (ax.range[1] - ax.range[0]) / windowSpan)
                    : 1;
                // Whole points only, with the remainder kept: `panWindow` rounds, so at a deep zoom
                // a frame's worth of movement is a fraction of a point and rounding it away would
                // stall the drag completely. The accumulator lives in this closure, which now
                // survives the whole gesture — see `dataRef`.
                pendingPoints += (px / plotWidth) * data.length * zoom;
                const whole = Math.trunc(pendingPoints);
                if (whole !== 0) { pendingPoints -= whole; onPanWindow(whole); }
                return;
            }

            // Not zoomed means the whole log is already visible and there is nowhere to pan to.
            // Relayouting here would also cancel autorange and silently lock the view.
            if (!ax?.range || ax.autorange || !plotlyModule) return;
            const [r0, r1] = ax.range;
            const first = data[0].time;
            const last = data[data.length - 1].time;
            // Zoomed out past the data (Plotly's scroll-zoom allows it): everything is already on
            // screen, so there is nothing to pan to. Returning is not just an optimisation — the
            // clamp below would have to shrink the range to fit, which is a silent zoom change made
            // while the finger is still moving.
            if (r1 - r0 >= last - first) return;
            const shift = (px / plotWidth) * (r1 - r0);
            let lo = r0 + shift;
            let hi = r1 + shift;
            // Clamped as a whole, so the magnification survives hitting either end — moving one edge
            // alone would zoom instead of stopping.
            if (lo < first) { hi += first - lo; lo = first; }
            if (hi > last) { lo -= hi - last; hi = last; }
            void plotlyModule.relayout(gd, { 'xaxis.range': [lo, hi] });
        };

        const onWheel = (e: WheelEvent) => {
            if (e.ctrlKey) return;                               // pinch → let Plotly zoom
            if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return; // vertical-dominant → let Plotly zoom
            e.preventDefault();
            e.stopPropagation();                                 // Plotly must not also see it
            pendingPx += e.deltaX;
            if (!frame) frame = requestAnimationFrame(apply);
        };

        /**
         * The same gesture for a finger.
         *
         * A touch drag emits no wheel event, so on a touchscreen the handler above never ran — and
         * because Plotly's dragmode is 'pan', the drag fell through to Plotly and panned the
         * chart's own x-range. That is precisely the desync this whole effect exists to prevent:
         * the chart moves, the row table beside it goes on showing a different slice, and clicking
         * a point stops jumping to its row. So touch was not merely unsupported here, it actively
         * defeated the protection. Routing pointer drags into the same `apply()` restores the rule
         * the comment above states — one window, both views, one gesture.
         *
         * Horizontal-dominant only, decided once per gesture from the first few pixels, because a
         * vertical drag on a phone is a page gesture and a diagonal one should not steal it. Sign
         * is inverted against the wheel: dragging content right moves the window left.
         *
         * Pointer events rather than touch events so a stylus and a mouse drag behave identically;
         * `pointerType === 'mouse'` is skipped because a mouse already has the wheel, and
         * intercepting its drag would take Plotly's own box-pan away.
         */
        let tracking = false;
        let decided: 'horizontal' | 'vertical' | null = null;
        let lastX = 0, startX = 0, startY = 0, pointerId = -1;

        /**
         * Two fingers magnify. One finger moves the window.
         *
         * The same split the trackpad has had all along — a pinch there arrives as a ctrlKey wheel
         * and is handed to Plotly untouched — and a touchscreen had no half of it: the chart could
         * be moved but never magnified, so a stretch of a long log could be reached and not read
         * (operator, 2026-08-25). Zoom stays chart-local for the reason stated above: it changes
         * how much of the window is on screen, not which window that is, so the table has nothing
         * to follow.
         *
         * Written here rather than left to Plotly's own touch handling because this wrapper already
         * intercepts the pointer stream in the capture phase, and a pinch whose first finger is
         * claimed as a horizontal drag is a window pan with a second finger resting on it. The two
         * gestures have to be decided in one place or they arbitrate by accident.
         *
         * The magnification is anchored under the fingers: the time at the midpoint of the pinch
         * stays where it is, so the chart stretches about the thing being looked at rather than
         * about its own centre. It cannot open wider than the window — beyond that there is nothing
         * to show, and letting it would put a range on the axis that the data does not cover.
         */
        const active = new Map<number, { x: number; y: number }>();
        let pinch: { dist: number; frac: number; range: [number, number] } | null = null;
        let zoomFrame = 0;

        /** The plotting area's geometry and the range on screen, or null if Plotly is not ready. */
        const plotState = () => {
            type ResolvedAxis = { range?: [number, number] };
            type ResolvedLayout = { width?: number; margin?: { l: number; r: number }; xaxis?: ResolvedAxis };
            const gd = wrapper.querySelector('.js-plotly-plot') as (HTMLElement & { _fullLayout?: ResolvedLayout }) | null;
            const full = gd?._fullLayout;
            if (!gd || !full || full.width === undefined || !full.margin || !full.xaxis?.range) return null;
            const width = full.width - full.margin.l - full.margin.r;
            if (!(width > 0)) return null;
            // `range` is resolved whether or not the axis is autoranging, so a pinch that starts
            // from the fitted view magnifies from exactly what is on screen.
            return { gd, left: full.margin.l, width, range: full.xaxis.range };
        };

        const spread = () => {
            const [a, b] = [...active.values()];
            return Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
        };

        const startPinch = () => {
            const st = plotState();
            if (!st) return;
            // A finger already tracking a drag is now half of a pinch — end the drag rather than
            // letting both run: the window would slide while the axis stretched.
            if (decided === 'horizontal' && pointerId >= 0) {
                try { wrapper.releasePointerCapture(pointerId); } catch { /* never captured */ }
            }
            tracking = false; decided = null; pointerId = -1; pendingPx = 0;

            const [a, b] = [...active.values()];
            const mid = (a.x + b.x) / 2 - wrapper.getBoundingClientRect().left - st.left;
            pinch = {
                dist: spread(),
                frac: Math.min(1, Math.max(0, mid / st.width)),
                range: [st.range[0], st.range[1]],
            };
        };

        const applyZoom = () => {
            zoomFrame = 0;
            const st = plotState();
            const data = dataRef.current;
            if (!st || !pinch || active.size < 2 || !plotlyModule || data.length === 0) return;
            const [r0, r1] = pinch.range;
            const span0 = r1 - r0;
            const first = data[0].time;
            const last = data[data.length - 1].time;
            // Five points is as far in as magnifying a line of samples can usefully go; past that
            // the trace is two segments and the axis labels are noise.
            const minSpan = Math.max(1e-6, (last - first) * (5 / data.length));
            const span = Math.min(last - first, Math.max(minSpan, span0 * (pinch.dist / spread())));
            const anchor = r0 + pinch.frac * span0;
            let lo = anchor - pinch.frac * span;
            let hi = lo + span;
            // Clamped as a whole, exactly as the pan is: moving one edge alone would change the
            // magnification the fingers are holding.
            if (lo < first) { hi += first - lo; lo = first; }
            if (hi > last) { lo -= hi - last; hi = last; }
            void plotlyModule.relayout(st.gd, { 'xaxis.range': [lo, hi] });
        };

        const onPointerDown = (e: PointerEvent) => {
            if (e.pointerType === 'mouse') return;
            active.set(e.pointerId, { x: e.clientX, y: e.clientY });
            if (active.size === 2) { startPinch(); return; }
            if (!e.isPrimary || active.size > 2) return;
            tracking = true; decided = null; pointerId = e.pointerId;
            startX = lastX = e.clientX; startY = e.clientY;
        };

        const onPointerMove = (e: PointerEvent) => {
            const held = active.get(e.pointerId);
            if (held) { held.x = e.clientX; held.y = e.clientY; }
            if (pinch) {
                e.preventDefault();
                e.stopPropagation();
                if (!zoomFrame) zoomFrame = requestAnimationFrame(applyZoom);
                return;
            }
            if (!tracking || e.pointerId !== pointerId) return;
            if (decided === null) {
                const dx = Math.abs(e.clientX - startX), dy = Math.abs(e.clientY - startY);
                if (dx < 6 && dy < 6) return;          // below the slop threshold, no verdict yet
                decided = dx > dy ? 'horizontal' : 'vertical';
                // Throws for a pointer the browser has no record of — every synthetic one, which is
                // how this gesture is exercised in a test. A capture that cannot be taken costs the
                // drag nothing here: the listeners are on the wrapper and the finger is inside it.
                if (decided === 'horizontal') {
                    try { wrapper.setPointerCapture(e.pointerId); } catch { /* not a live pointer */ }
                }
            }
            if (decided !== 'horizontal') return;
            e.preventDefault();
            e.stopPropagation();
            pendingPx -= e.clientX - lastX;            // drag right → window left, as the wheel does
            lastX = e.clientX;
            if (!frame) frame = requestAnimationFrame(apply);
        };

        const endPointer = (e: PointerEvent) => {
            active.delete(e.pointerId);
            // A pinch ends when it stops being two fingers. The one that is left does NOT become a
            // drag: its start position is from before the stretch, so resuming would jump the
            // window by however far the pinch moved it. It takes a fresh touch.
            if (pinch && active.size < 2) pinch = null;
            if (e.pointerId !== pointerId) return;
            if (decided === 'horizontal' && wrapper.hasPointerCapture(e.pointerId)) {
                wrapper.releasePointerCapture(e.pointerId);
            }
            tracking = false; decided = null; pointerId = -1;
        };

        /**
         * Plotly gets no touches. It was getting all of them.
         *
         * A capture-phase POINTER listener cannot stop a TOUCH event — they are separate streams
         * off the same finger — and Plotly binds its own `touchstart` on the drag layer, then
         * `touchmove` on the document. So the note above, that routing pointer drags into `apply()`
         * stopped Plotly panning its own axis, was simply wrong about touch: BOTH ran on every
         * finger. Measured with the pointer handlers left untouched, a bare touch drag moved
         * Plotly's x-range from [0, 499.75] to [137, 637] — past the end of the data — while the
         * shared window stayed at 0. The chart moved by our pan PLUS Plotly's, which is the rest of
         * "the position is wrong when I let go", and two fingers had Plotly's pinch fighting ours
         * for the magnification.
         *
         * stopPropagation and NOT preventDefault, deliberately: preventing the default on a touch
         * is what stops the browser synthesising the compatibility mouse events, and those are what
         * deliver hover and the tap that selects a point. The gesture is taken away from Plotly;
         * the tap is left alone.
         */
        const swallowTouch = (e: TouchEvent) => { e.stopPropagation(); };

        wrapper.addEventListener('touchstart', swallowTouch, { capture: true });
        wrapper.addEventListener('touchmove', swallowTouch, { capture: true });
        wrapper.addEventListener('wheel', onWheel, { capture: true, passive: false });
        wrapper.addEventListener('pointerdown', onPointerDown, { capture: true });
        wrapper.addEventListener('pointermove', onPointerMove, { capture: true, passive: false });
        wrapper.addEventListener('pointerup', endPointer, { capture: true });
        wrapper.addEventListener('pointercancel', endPointer, { capture: true });
        return () => {
            wrapper.removeEventListener('touchstart', swallowTouch, { capture: true });
            wrapper.removeEventListener('touchmove', swallowTouch, { capture: true });
            wrapper.removeEventListener('wheel', onWheel, { capture: true });
            wrapper.removeEventListener('pointerdown', onPointerDown, { capture: true });
            wrapper.removeEventListener('pointermove', onPointerMove, { capture: true });
            wrapper.removeEventListener('pointerup', endPointer, { capture: true });
            wrapper.removeEventListener('pointercancel', endPointer, { capture: true });
            if (frame) cancelAnimationFrame(frame);
            if (zoomFrame) cancelAnimationFrame(zoomFrame);
        };
        // NOT `data`. The window changes on every frame of a pan, and re-running this effect in the
        // middle of a gesture throws its state away — see `dataRef`, which is how the handlers read
        // the current window without depending on it.
    }, [onPanWindow, canPanWindow]);

    /**
     * Carries an active zoom along with the window, in the same frame the new data lands in.
     *
     * uirevision is keyed on the log, so Plotly holds the user's range across a scrub — but the data
     * underneath has moved, and that range would point at time the new window does not cover. Shifting
     * it by exactly the window's time delta preserves both the magnification and the position within
     * the window, which is what sliding at a chosen zoom means.
     *
     * useLayoutEffect, not useEffect, and with Plotly already resolved: react-plotly.js performs its
     * Plotly.react in componentDidUpdate, this runs straight after in the same commit, and the browser
     * paints once — after the correction rather than either side of it. The earlier version awaited a
     * dynamic import here, which pushed the correction past the paint and showed a stale frame first.
     *
     * Keyed on the data, so the slider and the trackpad both get it. Skipped while autoranging:
     * nothing is zoomed, and Plotly has already fitted the new window.
     */
    React.useLayoutEffect(() => {
        const first = data.length > 0 ? data[0].time : null;
        const prev = prevFirstTimeRef.current;
        prevFirstTimeRef.current = first;
        if (prev === null || first === null || first === prev || !plotlyModule) return;

        type ZoomAxis = { range?: [number, number]; autorange?: boolean | string };
        const gd = wrapperRef.current?.querySelector('.js-plotly-plot') as (HTMLElement & { _fullLayout?: { xaxis?: ZoomAxis } }) | null;
        const ax = gd?._fullLayout?.xaxis;
        if (!gd || !ax?.range || ax.autorange) return;

        const dt = first - prev;
        void plotlyModule.relayout(gd, { 'xaxis.range': [ax.range[0] + dt, ax.range[1] + dt] });
    }, [data]);

    /** Always five traces, in a fixed order, with the axis each one belongs to already assigned.
     *
     *  Both properties are load-bearing. Pushing the lambda traces conditionally made the array 3, 4
     *  or 5 long and shifted bank 2's index when bank 1 was toggled; Plotly cannot diff across a
     *  changed trace count and tears the figure down and rebuilds it, which is the "batch redraw" this
     *  looked like. Hiding via `visible` keeps every index put, so a toggle updates the figure.
     *
     *  `false` rather than 'legendonly': the legend would otherwise become a second toggle surface
     *  competing with FieldVisibilityPanel over the same state. */
    const chartData = useMemo((): Data[] => {
        const points = data ?? [];
        const times = points.map(d => d.time);

        const showLambda1 = !!visibleFields.stft1 && isFieldPresent('stft1', presenceSource);
        const showLambda2 = !!visibleFields.stft2 && isFieldPresent('stft2', presenceSource);
        const showEgt = !!visibleFields.exhaustTemp && isFieldPresent('exhaustTemp', presenceSource);
        const showRf = !!visibleFields.rf && isFieldPresent('rf', presenceSource);
        const showRfKorr = !!visibleFields.rfKorr && isFieldPresent('rfKorr', presenceSource);
        const showEgtDerived = !!visibleFields.egtFromRfKorr
            && isFieldPresent('egtFromRfKorr', presenceSource);
        const showRfKorrDerived = !!visibleFields.rfKorrFromEgt
            && isFieldPresent('rfKorrFromEgt', presenceSource);

        return [
            {
                x: times,
                y: points.map(d => d.rpm),
                type: 'scatter', // SVG, for hover/click precision
                mode: 'lines',
                name: LOG_FIELD_REGISTRY.rpm.symbol,
                line: { color: LOG_FIELD_REGISTRY.rpm.color, width: 1 },
                yaxis: 'y',
            },
            {
                x: times,
                y: points.map(d => d.rawLoad),
                type: 'scatter',
                mode: 'lines',
                name: LOG_FIELD_REGISTRY.rawLoad.symbol,
                line: { color: LOG_FIELD_REGISTRY.rawLoad.color, width: 1, dash: 'dot' },
                yaxis: 'y3',
            },
            {
                x: times,
                y: points.map(d => d.correctedLoad ?? d.rawLoad), // fall back when uncorrected
                type: 'scatter',
                mode: 'lines',
                name: LOG_FIELD_REGISTRY.correctedLoad.symbol,
                line: { color: LOG_FIELD_REGISTRY.correctedLoad.color, width: 2 },
                yaxis: 'y3',
            },
            {
                x: times,
                y: points.map(d => d.stft1) as number[],
                type: 'scatter',
                mode: 'lines',
                name: LOG_FIELD_REGISTRY.stft1.symbol,
                line: { color: LOG_FIELD_REGISTRY.stft1.color, width: 1.5 },
                yaxis: 'y2',
                visible: showLambda1,
            },
            {
                x: times,
                y: points.map(d => d.stft2) as number[],
                type: 'scatter',
                mode: 'lines',
                name: LOG_FIELD_REGISTRY.stft2.symbol,
                line: { color: LOG_FIELD_REGISTRY.stft2.color, width: 1.5, dash: 'dash' },
                yaxis: 'y2',
                visible: showLambda2,
            },
            {
                // EGT rides y1 with RPM. Its own axis would be a fourth scale on a chart that
                // already carries three, and the two are the same order of magnitude, so the
                // shared axis costs nothing readable.
                x: times,
                y: points.map(d => d.exhaustTemp) as number[],
                type: 'scatter',
                mode: 'lines',
                name: LOG_FIELD_REGISTRY.exhaustTemp.symbol,
                line: { color: LOG_FIELD_REGISTRY.exhaustTemp.color, width: 1.5 },
                yaxis: 'y',
                visible: showEgt,
            },
            {
                // RF next to the two load traces it belongs with: rawLoad is what the throttle is
                // doing, RF is what the DME concluded the cylinder actually got.
                x: times,
                y: points.map(d => d.rf) as number[],
                type: 'scatter',
                mode: 'lines',
                name: LOG_FIELD_REGISTRY.rf.symbol,
                line: { color: LOG_FIELD_REGISTRY.rf.color, width: 1.5, dash: 'dashdot' },
                yaxis: 'y3',
                visible: showRf,
            },
            {
                // rf_korr sits on the lambda axis because it lives in the same 1.0-centred range,
                // and because reading it against the trim is the whole point: a trim that dips
                // exactly where rf_korr rises is the loop cancelling the enrichment.
                x: times,
                y: points.map(d => d.rfKorr) as number[],
                type: 'scatter',
                mode: 'lines',
                name: LOG_FIELD_REGISTRY.rfKorr.symbol,
                line: { color: LOG_FIELD_REGISTRY.rfKorr.color, width: 2, dash: 'dot' },
                yaxis: 'y2',
                visible: showRfKorr,
            },
            // The cross-check pair, appended at the END. Trace order is an index the click handler
            // and the marker overlay both count on — see the note above — so new traces go here
            // and nowhere else.
            //
            // Each rides its measured counterpart's axis so the residual reads as the gap between
            // two adjacent lines. Dashed against that counterpart's solid/dotted: the point is to
            // see them diverge, not to tell them apart at a glance.
            {
                x: times,
                y: points.map(d => d.egtFromRfKorr) as number[],
                type: 'scatter',
                mode: 'lines',
                name: LOG_FIELD_REGISTRY.egtFromRfKorr.symbol,
                line: { color: LOG_FIELD_REGISTRY.egtFromRfKorr.color, width: 1.5, dash: 'dash' },
                yaxis: 'y',
                // Gaps are the normal case here, not missing data: the correction profile is only
                // invertible over part of the rpm axis. Plotly breaks the line at each undefined,
                // which is the honest rendering — connectgaps would draw a straight run across a
                // region the column has nothing to say about.
                connectgaps: false,
                visible: showEgtDerived,
            },
            {
                x: times,
                y: points.map(d => d.rfKorrFromEgt) as number[],
                type: 'scatter',
                mode: 'lines',
                name: LOG_FIELD_REGISTRY.rfKorrFromEgt.symbol,
                line: { color: LOG_FIELD_REGISTRY.rfKorrFromEgt.color, width: 1.5, dash: 'dash' },
                yaxis: 'y2',
                connectgaps: false,
                visible: showRfKorrDerived,
            },
        ];
    }, [
        data, presenceSource,
        visibleFields.stft1, visibleFields.stft2,
        visibleFields.exhaustTemp, visibleFields.rf, visibleFields.rfKorr,
        visibleFields.egtFromRfKorr, visibleFields.rfKorrFromEgt,
    ]);

    /** Zoom persistence, and the way out of it.
     *
     *  `autorange: true` is stated explicitly, and that is the load-bearing part. Plotly only reverts
     *  a user's zoom to something the supplied layout actually names — omitting the key is not the
     *  same as asking for autorange, it means "nothing to revert to", and the axis keeps whatever the
     *  scroll wheel last set. That is what made the old scrub slider look dead: the data underneath
     *  changed on every step while the axis stayed pinned where the zoom left it.
     *
     *  uirevision is keyed on the LOG, not on the window. Keying it on the window's first timestamp
     *  meant every scrub counted as "something else is on screen now" and threw the zoom away — you
     *  could not scroll along a log at a chosen magnification, which is the normal way to read one.
     *  Holding it steady across scrubs keeps the zoom, and the effect below carries the view along
     *  with the window so the preserved range still points at data. It changes when a different log
     *  loads, or when FIT bumps its token, and either of those re-fits. */
    const layout = useMemo((): Partial<Layout> => ({
        ...BASE_LAYOUT,
        xaxis: { ...BASE_LAYOUT.xaxis, autorange: true },
        uirevision: `${logKey}:${fitToken}`,
        transition: (!live && data.length <= TRANSITION_MAX_POINTS) ? TOGGLE_TRANSITION : undefined,
        shapes: selectedIndex !== undefined && selectedIndex !== null && data[selectedIndex] ? [
            {
                type: 'line',
                x0: data[selectedIndex].time,
                x1: data[selectedIndex].time,
                y0: 0,
                y1: 1,
                xref: 'x',
                yref: 'paper',
                line: {
                    // Neutral on purpose. This is a pointer, not a status, and with the accent set
                    // down to three hues a crosshair that borrowed one would read as a reading.
                    color: '#F2F2F5', // slate-100
                    width: 2,
                    dash: 'solid',
                },
            },
        ] : [],
    }), [data, selectedIndex, live, fitToken, logKey]);

    return (
        <div
            ref={wrapperRef}
            // touch-action: pan-y. Without it the browser claims a horizontal drag as a scroll or a
            // back-navigation gesture before pointermove is ever delivered, so the window pan below
            // could never start. `pan-y` gives up only the axis this chart does not use, leaving a
            // vertical swipe as the ordinary page gesture it should be.
            className="w-full h-full min-h-[300px] touch-pan-y"
            onClick={(e) => {
                if (onPointClick) {
                    // [FIX] Global Bounds Check first: Ignore clicks in margins (Legend, X-Axis)
                    const rect = e.currentTarget.getBoundingClientRect();
                    const y = e.clientY - rect.top;

                    const marginT = 30; // Matches BASE_LAYOUT.margin.t (Legend Area)
                    const marginB = 40; // Matches BASE_LAYOUT.margin.b (Axis Area)

                    if (y < marginT || y > rect.height - marginB) {
                        return;
                    }

                    // Method 1: Use last hovered point (Most accurate, handles Zoom/Pan)
                    if (lastHoveredIndex.current !== null) {
                        onPointClick(lastHoveredIndex.current);
                        return;
                    }

                    // Method 2: Fallback Geometric Calculation (Handles "Immediate Click" before hover)
                    // Assumption: Default View (Not zoomed/panned yet)
                    // If user is zooming/panning, they likely hovered recently, so Method 1 should trigger.
                    // This fallback purely fixes the "Just uploaded, click immediately" dead zone.
                    const x = e.clientX - rect.left;

                    const marginL = 60; // Matches BASE_LAYOUT.margin.l
                    const marginR = 60; // Matches BASE_LAYOUT.margin.r

                    const plotWidth = rect.width - marginL - marginR;

                    // Ratio within the plotting area, clamped to avoid out of bounds
                    const ratio = Math.max(0, Math.min(1, (x - marginL) / plotWidth));

                    if (data.length > 0) {
                        const idx = Math.round(ratio * (data.length - 1));
                        onPointClick(idx);
                    }
                }
            }}
        >
            <Plot
                data={chartData}
                style={{ width: '100%', height: '100%', pointerEvents: 'auto' }} // [FIX] Enable pointer events for Zoom/Pan
                layout={layout}
                config={PLOT_CONFIG}
                useResizeHandler={true}
                onHover={(e: Readonly<PlotMouseEvent>) => {
                    if (e.points && e.points.length > 0) {
                        lastHoveredIndex.current = e.points[0].pointIndex ?? null;
                    }
                }}
            // Click is handled on the wrapper above, not here, to avoid double triggers.
            />
        </div>
    );
});
