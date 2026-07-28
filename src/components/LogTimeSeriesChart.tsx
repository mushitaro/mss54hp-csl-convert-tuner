import React, { useMemo } from 'react';
import dynamic from 'next/dynamic';
import { LogDataPoint } from '@/lib/types';
import { Layout, Config, Data } from 'plotly.js';
import { FieldKey, LOG_FIELD_REGISTRY, isFieldPresent, DEFAULT_FIELD_VISIBILITY } from '@/lib/field-registry/registry';

// Dynamically import Plotly to avoid SSR issues
const Plot = dynamic(() => import('react-plotly.js'), { ssr: false }) as React.ComponentType<any>;

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
        title: { text: 'Lambda', font: { color: LOG_FIELD_REGISTRY.lambda1.color } },
        tickfont: { color: LOG_FIELD_REGISTRY.lambda1.color },
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
    /** Bump to drop the user's zoom and re-fit the whole log. Feeds uirevision — see the layout memo
     *  for why an explicit autorange is not enough on its own. */
    fitToken?: number;
}

/** Wrapped in React.memo so the page's per-sample re-render during a log run stops at this boundary.
 *  Without it the live HUD's state updates would drag a full Plotly pass along ~8 times a second. */
export const LogTimeSeriesChart = React.memo(function LogTimeSeriesChart({
    data, selectedIndex, onPointClick, visibleFields = DEFAULT_FIELD_VISIBILITY, presenceData, live = false, fitToken = 0,
}: Props) {
    const lastHoveredIndex = React.useRef<number | null>(null);
    const presenceSource = presenceData && presenceData.length > 0 ? presenceData : data;

    /** Always five traces, in a fixed order, with the axis each one belongs to already assigned.
     *
     *  Both properties are load-bearing. Pushing the lambda traces conditionally made the array 3, 4
     *  or 5 long and shifted lambda2's index when lambda1 was toggled; Plotly cannot diff across a
     *  changed trace count and tears the figure down and rebuilds it, which is the "batch redraw" this
     *  looked like. Hiding via `visible` keeps every index put, so a toggle updates the figure.
     *
     *  `false` rather than 'legendonly': the legend would otherwise become a second toggle surface
     *  competing with FieldVisibilityPanel over the same state. */
    const chartData = useMemo((): Data[] => {
        const points = data ?? [];
        const times = points.map(d => d.time);

        const showLambda1 = !!visibleFields.lambda1 && isFieldPresent('lambda1', presenceSource);
        const showLambda2 = !!visibleFields.lambda2 && isFieldPresent('lambda2', presenceSource);

        return [
            {
                x: times,
                y: points.map(d => d.rpm),
                type: 'scatter', // SVG, for hover/click precision
                mode: 'lines',
                name: LOG_FIELD_REGISTRY.rpm.label,
                line: { color: LOG_FIELD_REGISTRY.rpm.color, width: 1 },
                yaxis: 'y',
            },
            {
                x: times,
                y: points.map(d => d.rawLoad),
                type: 'scatter',
                mode: 'lines',
                name: LOG_FIELD_REGISTRY.rawLoad.label,
                line: { color: LOG_FIELD_REGISTRY.rawLoad.color, width: 1, dash: 'dot' },
                yaxis: 'y3',
            },
            {
                x: times,
                y: points.map(d => d.correctedLoad ?? d.rawLoad), // fall back when uncorrected
                type: 'scatter',
                mode: 'lines',
                name: LOG_FIELD_REGISTRY.correctedLoad.label,
                line: { color: LOG_FIELD_REGISTRY.correctedLoad.color, width: 2 },
                yaxis: 'y3',
            },
            {
                x: times,
                y: points.map(d => d.lambda1) as number[],
                type: 'scatter',
                mode: 'lines',
                name: LOG_FIELD_REGISTRY.lambda1.label,
                line: { color: LOG_FIELD_REGISTRY.lambda1.color, width: 1.5 },
                yaxis: 'y2',
                visible: showLambda1,
            },
            {
                x: times,
                y: points.map(d => d.lambda2) as number[],
                type: 'scatter',
                mode: 'lines',
                name: LOG_FIELD_REGISTRY.lambda2.label,
                line: { color: LOG_FIELD_REGISTRY.lambda2.color, width: 1.5, dash: 'dash' },
                yaxis: 'y2',
                visible: showLambda2,
            },
        ];
    }, [data, presenceSource, visibleFields.lambda1, visibleFields.lambda2]);

    /** Zoom persistence, and the way out of it.
     *
     *  `autorange: true` is stated explicitly, and that is the load-bearing part. Plotly only reverts
     *  a user's zoom to something the supplied layout actually names — omitting the key is not the
     *  same as asking for autorange, it means "nothing to revert to", and the axis keeps whatever the
     *  scroll wheel last set. That is what made the old scrub slider look dead: the data underneath
     *  changed on every step while the axis stayed pinned where the zoom left it.
     *
     *  uirevision then decides when that revert happens. It holds steady while the same log is on
     *  screen — including as it grows during a live run, since the first timestamp does not move — so
     *  a zoom survives re-renders. It changes when a different log loads, or when the FIT button
     *  bumps its token, and either of those re-fits the view. */
    const layout = useMemo((): Partial<Layout> => ({
        ...BASE_LAYOUT,
        xaxis: { ...BASE_LAYOUT.xaxis, autorange: true },
        uirevision: `${data.length > 0 ? data[0].time : 'init'}:${fitToken}`,
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
    }), [data, selectedIndex, live, fitToken]);

    return (
        <div
            className="w-full h-full min-h-[300px]"
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
                onHover={(e: any) => {
                    if (e.points && e.points.length > 0) {
                        lastHoveredIndex.current = e.points[0].pointIndex;
                    }
                }}
            // Click is handled on the wrapper above, not here, to avoid double triggers.
            />
        </div>
    );
});
