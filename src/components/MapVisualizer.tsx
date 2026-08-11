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

/**
 * Samples per axis for the resample above.
 *
 * Chosen against Plotly's own arithmetic rather than by eye. On an evenly spaced axis of n points
 * every `nums[i]` is n-1, so `resDst = 1 + LCM(...) = n`, which must land inside [120, 720] or it is
 * doubled up / divided down into range. 128 sits just above the 120 floor, so `scale` comes out 1 and
 * Plotly draws exactly the grid it is given: 128x128 = 16,384 vertices against the 366,561 it built
 * for itself, and no second interpolation on top of ours.
 *
 * It is also far denser than the 24x20 it is drawn from, so the shape is carried, not approximated.
 */
const RESAMPLE = 128;

interface Props {
    mapData: VEMap;
    title?: string;
    zAxisLabel?: string;
    /**
     * What the two horizontal axes ARE.
     *
     * These were written into the scene, and the Z label alone was a prop — which held for as long
     * as every surface here was a VE map. It is not: KF_RF_KORR_DRREL is rpm against **exhaust
     * temperature delta in °C**, and it was drawn with its rows announced as `RO %`, engine load.
     * Not a cosmetic slip. The axis name is the only thing on a 3D plot that says what the shape is
     * a function of, so a reader who trusted it read the map against the wrong variable entirely.
     *
     * Defaults reproduce the old strings exactly, so the five VE surfaces are unchanged.
     */
    xAxisLabel?: string;
    yAxisLabel?: string;
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
export const MapVisualizer: React.FC<Props> = React.memo(function MapVisualizer({
    mapData, title = 'VE Map', zAxisLabel = 'RF %',
    xAxisLabel = 'RPM', yAxisLabel = 'RO %',
    scale = 'magnitude', deviationMidpoint = 0,
}) {
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
     * The surface sits at the axes' real values — 600 RPM is at 600, 7900 is at 7900 — resampled onto
     * an evenly spaced grid spanning the same range.
     *
     * **Why it cannot just be handed the raw axes.** Plotly decides a surface's mesh resolution from
     * the *regularity* of the coordinate spacing, not from its size (`surface/convert.js`):
     *
     *     nums[i] = round(totalDist / spacing[i])      // how many times gap i divides the span
     *     resDst  = 1 + arrayLCM(nums)                 // then clamped to [120, 720]
     *
     * With even spacing every `nums[i]` is the same number, the LCM is that number, and `resDst`
     * lands just above it. With these axes nothing divides anything — RPM runs 600, 870, 1100, 1300,
     * 1400 … 7900 and RO % runs 0.1, 0.15, 0.2, 0.4 … 100 — so the LCM explodes, `resDst` pins to the
     * 720 ceiling on both axes, and a 24x20 map is bilinearly upsampled into a 723x507 mesh: 366,561
     * vertices for 480 numbers. Measured at 4x CPU throttle, that build blocked the main thread for
     * **75.3 seconds** and never produced a canvas inside a 60 s wait. On a head unit that is a hang.
     *
     * So we do the interpolation ourselves, at a resolution we choose, and hand Plotly something it
     * has no reason to upsample. Plotly was interpolating anyway; this is the same operation with the
     * output size stated instead of derived, so the picture is the one it always drew.
     *
     * An earlier attempt escaped the same problem by building on cell indices, which was cheap but
     * changed what the axes meant: every column the same width, RPM no longer a distance. That reads
     * fine as a table and wrong as a surface — the shape of a map *is* where its values sit relative
     * to one another. Fix the mesh, not the meaning.
     */
    const surface = useMemo(() => {
        const { xAxis, yAxis, data } = mapData;

        /** Evenly spaced samples across a monotonic axis, each carrying where it fell in the source. */
        const project = (axis: number[], n: number) => {
            const lo = axis[0], hi = axis[axis.length - 1];
            const ascending = hi >= lo;
            const out: Array<{ i: number; f: number; v: number }> = [];
            let i = 0;
            for (let k = 0; k < n; k++) {
                const v = lo + ((hi - lo) * k) / (n - 1);
                // The scan only ever moves forward, so this is linear over the whole axis, not n log n.
                while (i < axis.length - 2 && (ascending ? axis[i + 1] < v : axis[i + 1] > v)) i++;
                const span = axis[i + 1] - axis[i];
                const f = span === 0 ? 0 : (v - axis[i]) / span;
                out.push({ i, f: Math.min(1, Math.max(0, f)), v });
            }
            return out;
        };

        const px = project(xAxis, RESAMPLE);
        const py = project(yAxis, RESAMPLE);
        const z = py.map(({ i: r, f: fr }) => px.map(({ i: c, f: fc }) => {
            const row = data[r], next = data[r + 1] ?? row;
            const z00 = row[c], z01 = row[c + 1] ?? z00;
            const z10 = next[c] ?? z00, z11 = next[c + 1] ?? z01;
            return (z00 * (1 - fc) + z01 * fc) * (1 - fr) + (z10 * (1 - fc) + z11 * fc) * fr;
        }));

        return { x: px.map(p => p.v), y: py.map(p => p.v), z };
    }, [mapData]);

    const data: Data[] = useMemo(() => [
        {
            type: 'surface',
            z: surface.z, // [y][x], resampled onto the even grid below
            x: surface.x, // Columns — RPM, at its real value
            y: surface.y, // Rows — RO %, at its real value
            colorscale: isDeviation ? SCALE_DEVIATION : SCALE_MAGNITUDE,
            // cmid pins the neutral color to the value that means "no change" and lets Plotly balance
            // cmin/cmax around it, so one strong outlier cannot slide the whole map off-center.
            ...(isDeviation ? { cmid: deviationMidpoint } : {}),
            showscale: false,
        },
    ], [surface, isDeviation, deviationMidpoint]);

    const layout: Partial<Layout> = useMemo(() => ({
        title: { text: title, font: { color: '#F2F2F5' } },
        autosize: true,
        paper_bgcolor: 'rgba(0,0,0,0)',
        plot_bgcolor: 'rgba(0,0,0,0)',
        scene: {
            // Plotly picks its own ticks, which it can only do because the coordinates are real
            // numbers with real spacing. The explicit tickvals that used to be here existed solely
            // to put meaning back onto index positions, and they brought their own problem: forced
            // to draw every value it was given, Plotly smeared the dense low-load end into an
            // unreadable pile. Round numbers at sane intervals are the automatic behaviour.
            xaxis: { title: { text: xAxisLabel }, color: '#C6C6CF', gridcolor: '#2A2A33' },
            yaxis: { title: { text: yAxisLabel }, color: '#C6C6CF', gridcolor: '#2A2A33' },
            zaxis: { title: { text: zAxisLabel }, color: '#C6C6CF', gridcolor: '#2A2A33' },
            camera: {
                eye: { x: 1.6, y: -1.6, z: 0.6 }
            }
        },
        margin: { l: 0, r: 0, b: 0, t: 0 }, // Optimized margins
        // All four labels, not just the two that used to vary. A memo that omits one renders the
        // previous view's axis name after a switch — the exact class of bug this prop exists to fix.
    }), [title, zAxisLabel, xAxisLabel, yAxisLabel]);

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
