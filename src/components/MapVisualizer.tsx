'use client';

import React, { useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { VEMap } from '@/lib/types';
import { Layout, Data } from 'plotly.js';
import { RotateCcw } from 'lucide-react';
import { ChartLoading } from './ChartLoading';

// Dynamic import for Plotly to avoid SSR issues
const Plot = dynamic(() => import('react-plotly.js'), { ssr: false }) as any;

/** Sequential — absolute magnitude (RF %). The ///M tricolor in one climb, weighted so blue owns the
 *  body of the range and red is the top note rather than the subject: deep blue → M-blue → violet →
 *  red → warm near-white. Monotonically lighter throughout (L 0.031 → 0.200 → 0.293 → 0.354 →
 *  0.752), so the surface still reads low-to-high in greyscale or with any colour vision.
 *
 *  Two constraints fix the shape, and they pull against each other:
 *
 *  1. **Red can only be the top.** M-red #F11A22 sits at L 0.196 and blue-600 #0883BD at L 0.200 —
 *     near-identical. Any ramp running blue *through* red on the way up has a flat band there where
 *     the surface stops encoding height at all. Red is structurally dark (green carries 0.7152 of
 *     the luminance weight), so on a lightness-ordered ramp its light tints are the only way to
 *     reach the top.
 *  2. **Therefore the saturated logo red cannot appear here.** Letting blue reach the midtones
 *     spends the luminance #F11A22 would need. Only #F87A7F survives. That is the price of blue
 *     keeping the middle of the range, and it is the right trade: the logo red stays exclusively
 *     the "more" end of SCALE_DEVIATION, where it is a reading rather than a magnitude.
 *
 *  The violet step is a hue bridge, not decoration — interpolating M-blue straight to red passes
 *  through a dead grey, and violet is the only M hue that sits between them.
 *
 *  It discriminates less finely than the perceptually-uniform Viridis it replaces; that is the cost
 *  of holding the instrument to the tricolor, and it is why the deviation views get their own scale
 *  instead of being read off this one. */
const SCALE_MAGNITUDE: Array<[number, string]> = [
    [0, '#06354E'],    // blue-900     — darkest anchor
    [0.32, '#0883BD'], // blue-600
    [0.55, '#9B84E8'], // M-violet 400 — hue bridge
    [0.75, '#F87A7F'], // M-red 300
    [1, '#FBD9DA'],    // M-red 100    — warm near-white
];

/** Diverging — signed deviation, anchored on a neutral midpoint by `deviationMidpoint`. Same
 *  convention as the 2D MapEditor sitting next to it: M-blue = negative (leaner / less fuel),
 *  M-red = positive (richer / more fuel). Dark in the middle rather than light, because the scene
 *  is black: no-change recedes and deviation pops, matching the table's transparent dead-band. */
const SCALE_DEVIATION: Array<[number, string]> = [
    [0, '#6CCBEF'],    // blue-300 — strongest negative
    [0.25, '#0A9BDB'], // blue-500
    [0.5, '#2A2A33'],  // slate-700 — neutral
    [0.75, '#F11A22'], // red-500
    [1, '#F87A7F'],    // red-300 — strongest positive
];

interface Props {
    mapData: VEMap;
    title?: string;
    zAxisLabel?: string;
    /** 'magnitude' (default) for absolute maps, 'deviation' for signed ones. A signed map on the
     *  sequential scale has no visual zero, which is what made the Diff view unreadable: the color
     *  of "no change" drifted with whatever the min/max of that particular comparison happened to be. */
    scale?: 'magnitude' | 'deviation';
    /** Value that must land on the neutral middle of the deviation scale — 0 for a % difference,
     *  1.0 for a lambda correction factor. Ignored when scale is 'magnitude'. */
    deviationMidpoint?: number;
}

/**
 * Memoised, and its Plotly payload with it.
 *
 * react-plotly calls `Plotly.react()` whenever it re-renders, and `data`/`layout` were rebuilt as
 * fresh objects on every pass — so any state change anywhere in the page (opening the menu, moving
 * a toggle, switching panes) had Plotly diff and redraw a 480-point 3D surface. Measured on a
 * 6x-throttled CPU that was the bulk of a 4.3 s menu open.
 */
export const MapVisualizer: React.FC<Props> = React.memo(function MapVisualizer({ mapData, title = 'VE Map', zAxisLabel = 'RF %', scale = 'magnitude', deviationMidpoint = 0 }) {
    // Bumped by the reset button to remount Plotly, which is what re-applies `scene.camera`
    // below. Plotly keeps the camera in its own internal state after the first render.
    const [cameraNonce, setCameraNonce] = useState(0);

    /**
     * Paint the placeholder before building the surface, not alongside it.
     *
     * Mounting <Plot> blocks the main thread for the whole build — measured at ~1.3 s on a
     * 4x-throttled phone profile even after the mesh fix below — and if it mounts in the same
     * commit as the placeholder, the browser never gets a frame in which to show the placeholder.
     * The screen simply stops, which is what reads as a crash. Two rAFs guarantee one painted
     * frame of "Rendering…" before the thread goes away.
     *
     * Keyed on cameraNonce so the reset button gets the same treatment: it remounts Plotly, which
     * costs the same rebuild.
     */
    const [readyFor, setReadyFor] = useState(-1);
    const ready = readyFor === cameraNonce;
    useEffect(() => {
        let inner = 0;
        const outer = requestAnimationFrame(() => { inner = requestAnimationFrame(() => setReadyFor(cameraNonce)); });
        return () => { cancelAnimationFrame(outer); cancelAnimationFrame(inner); };
    }, [cameraNonce]);

    // Plotly expects [x, y, z].
    // Surface plot format: z is Data[y][x], x, y are axes.

    const isDeviation = scale === 'deviation';

    /**
     * The surface is built on cell INDICES, not on the axis values, and the values come back as tick
     * labels below. This is a performance fix with a visual consequence, and both are deliberate.
     *
     * Plotly sizes a surface mesh from the spacing of its coordinates: `estimateScale` takes
     * 1 + arrayLCM(spacings) and clamps at MAX_RESOLUTION. These axes are wildly irregular — RPM
     * runs 600, 870, 1100, 1300, 1400 … 7900 and RO% runs 0.1, 0.15, 0.2, 0.4 … 100 — so it
     * returned dataScale 36 x 21 and bilinearly upsampled a 24 x 20 map into a 723 x 507 mesh:
     * 366,561 vertices for 480 numbers, 764x more than the data has. Measured at 4x CPU throttle,
     * one update cost 1338-1496 ms with 2511-2643 ms of blocking tasks. On indices the scale is
     * 8 x 8, the mesh 193 x 161, and an update 169-371 ms.
     *
     * The consequence: the RPM and RO% axes are now evenly spaced in the 3D view instead of
     * proportional to their values. That matches the 2D grid beside it, whose columns have always
     * been a flat 50px regardless of RPM — and on a map you read cell by cell it is arguably the
     * more honest picture, since the value-proportional version squeezed the whole low-load half of
     * the map into a sliver.
     */
    const indexX = useMemo(() => mapData.xAxis.map((_, i) => i), [mapData.xAxis]);
    const indexY = useMemo(() => mapData.yAxis.map((_, i) => i), [mapData.yAxis]);

    /**
     * Thin the tick labels to about eight per axis.
     *
     * Handing Plotly a tickval for every cell means it draws every one of them — 20 RPM values and
     * 24 load values, rotated and overlapping into an illegible smear. It only became visible once
     * the graph got a pane of its own; in a 72px strip there was nothing to read either way.
     *
     * Plotly's own automatic thinning is not available here: `tickmode: 'array'` is what puts the
     * real values on index positions in the first place, and it draws exactly what it is given.
     * Both ends are always kept, so the axis still states its range.
     */
    const thin = <T,>(values: readonly T[], target = 8) => {
        const step = Math.max(1, Math.ceil(values.length / target));
        const keep: number[] = [];
        for (let i = 0; i < values.length; i += step) keep.push(i);
        const last = values.length - 1;
        if (keep[keep.length - 1] !== last) keep.push(last);
        return keep;
    };
    const tickX = useMemo(() => thin(mapData.xAxis), [mapData.xAxis]);
    const tickY = useMemo(() => thin(mapData.yAxis), [mapData.yAxis]);

    const data: Data[] = useMemo(() => [
        {
            type: 'surface',
            z: mapData.data, // 2D array [row][col] -> [y][x]
            x: indexX, // Columns — index, labelled with the RPM below
            y: indexY, // Rows — index, labelled with the RO % below
            colorscale: isDeviation ? SCALE_DEVIATION : SCALE_MAGNITUDE,
            // cmid pins the neutral color to the value that means "no change" and lets Plotly balance
            // cmin/cmax around it, so one strong outlier cannot slide the whole map off-center.
            ...(isDeviation ? { cmid: deviationMidpoint } : {}),
            showscale: false,
        },
    ], [mapData, indexX, indexY, isDeviation, deviationMidpoint]);

    const layout: Partial<Layout> = useMemo(() => ({
        title: { text: title, font: { color: '#F2F2F5' } },
        autosize: true,
        paper_bgcolor: 'rgba(0,0,0,0)',
        plot_bgcolor: 'rgba(0,0,0,0)',
        scene: {
            // The real values return here as labels on the index positions, so the axes still read
            // in RPM and RO % even though the mesh underneath is built on 0..n-1.
            xaxis: {
                title: { text: 'RPM' }, color: '#C6C6CF', gridcolor: '#2A2A33',
                tickmode: 'array', tickvals: tickX, ticktext: tickX.map(i => String(mapData.xAxis[i])),
            },
            yaxis: {
                title: { text: 'RO %' }, color: '#C6C6CF', gridcolor: '#2A2A33',
                tickmode: 'array', tickvals: tickY, ticktext: tickY.map(i => mapData.yAxis[i].toFixed(1)),
            },
            zaxis: { title: { text: zAxisLabel }, color: '#C6C6CF', gridcolor: '#2A2A33' },
            camera: {
                eye: { x: 1.6, y: -1.6, z: 0.6 }
            }
        },
        margin: { l: 0, r: 0, b: 0, t: 0 }, // Optimized margins
    }), [title, zAxisLabel, tickX, tickY, mapData.xAxis, mapData.yAxis]);

    return (
        // `touch-pan-y` so a vertical swipe still scrolls the pane this sits in. Plotly's 3D scene
        // claims every touch for the turntable otherwise, which on a phone means the surface is a
        // dead zone you cannot scroll past. The 2D chart already declares the same thing.
        <div className="w-full h-full relative touch-pan-y">
            {ready
                ? (
                    <Plot
                        key={cameraNonce}
                        data={data}
                        layout={layout}
                        useResizeHandler={true}
                        className="w-full h-full"
                        config={{ responsive: true, displayModeBar: false }}
                    />
                )
                : <ChartLoading />}
            {/* The way back. The modebar is off — it is desktop furniture and its buttons are far
                below any touch size — so a turntable drag was one-way: the initial eye above is
                applied on mount and never again, and one accidental swipe left the map at an angle
                with no control anywhere to undo it. Remounting Plotly is what restores the camera;
                `uirevision` would preserve the user's rotation, which is the opposite of the ask. */}
            <button
                type="button"
                onClick={() => setCameraNonce(n => n + 1)}
                title="Reset the 3D view"
                aria-label="Reset the 3D view"
                className="absolute top-1 right-1 z-10 p-2 text-slate-600 hover:text-slate-300 transition-colors cursor-pointer"
            >
                <RotateCcw className="w-3.5 h-3.5" />
            </button>
        </div>
    );
});
