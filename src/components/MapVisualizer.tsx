'use client';

import React from 'react';
import dynamic from 'next/dynamic';
import { VEMap } from '@/lib/types';
import { Layout, Data } from 'plotly.js';

// Dynamic import for Plotly to avoid SSR issues
const Plot = dynamic(() => import('react-plotly.js'), { ssr: false }) as any;

/** Sequential — absolute magnitude (RF %). Logo navy → M-blue → ice, monotonically lighter, so the
 *  surface still reads low-to-high in greyscale or with any color vision. It discriminates less
 *  finely than the perceptually-uniform Viridis it replaces; that is the cost of holding the
 *  instrument to the ///M tricolor, and it is why the deviation views below get their own scale
 *  instead of being read off this one. */
const SCALE_MAGNITUDE: Array<[number, string]> = [
    [0, '#2B115A'],    // M-violet 900 — the logo navy, darkest anchor
    [0.25, '#06354E'], // blue-900
    [0.5, '#0883BD'],  // blue-600
    [0.75, '#26AEE4'], // blue-400
    [1, '#B6E4F5'],    // ice
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

export const MapVisualizer: React.FC<Props> = ({ mapData, title = 'VE Map', zAxisLabel = 'RF %', scale = 'magnitude', deviationMidpoint = 0 }) => {
    // Plotly expects [x, y, z].
    // Surface plot format: z is Data[y][x], x, y are axes.

    const isDeviation = scale === 'deviation';

    const data: Data[] = [
        {
            type: 'surface',
            z: mapData.data, // 2D array [row][col] -> [y][x]
            x: mapData.xAxis, // Columns
            y: mapData.yAxis, // Rows
            colorscale: isDeviation ? SCALE_DEVIATION : SCALE_MAGNITUDE,
            // cmid pins the neutral color to the value that means "no change" and lets Plotly balance
            // cmin/cmax around it, so one strong outlier cannot slide the whole map off-center.
            ...(isDeviation ? { cmid: deviationMidpoint } : {}),
            showscale: false,
        },
    ];

    const layout: Partial<Layout> = {
        title: { text: title, font: { color: '#F2F2F5' } },
        autosize: true,
        paper_bgcolor: 'rgba(0,0,0,0)',
        plot_bgcolor: 'rgba(0,0,0,0)',
        scene: {
            xaxis: { title: { text: 'RPM' }, color: '#C6C6CF', gridcolor: '#2A2A33' },
            yaxis: { title: { text: 'RO %' }, color: '#C6C6CF', gridcolor: '#2A2A33' },
            zaxis: { title: { text: zAxisLabel }, color: '#C6C6CF', gridcolor: '#2A2A33' },
            camera: {
                eye: { x: 1.6, y: -1.6, z: 0.6 }
            }
        },
        margin: { l: 0, r: 0, b: 0, t: 0 }, // Optimized margins
    };

    return (
        <div className="w-full h-full relative">
            <Plot
                data={data}
                layout={layout}
                useResizeHandler={true}
                className="w-full h-full"
                config={{ responsive: true, displayModeBar: false }}
            />
        </div>
    );
};
