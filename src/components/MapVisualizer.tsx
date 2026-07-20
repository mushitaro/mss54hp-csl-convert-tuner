'use client';

import React from 'react';
import dynamic from 'next/dynamic';
import { VEMap } from '@/lib/types';
import { Layout, Data } from 'plotly.js';

// Dynamic import for Plotly to avoid SSR issues
const Plot = dynamic(() => import('react-plotly.js'), { ssr: false }) as any;

interface Props {
    mapData: VEMap;
    title?: string;
    zAxisLabel?: string;
}

export const MapVisualizer: React.FC<Props> = ({ mapData, title = 'VE Map', zAxisLabel = 'RF %' }) => {
    // Plotly expects [x, y, z].
    // Surface plot format: z is Data[y][x], x, y are axes.

    const data: Data[] = [
        {
            type: 'surface',
            z: mapData.data, // 2D array [row][col] -> [y][x]
            x: mapData.xAxis, // Columns
            y: mapData.yAxis, // Rows
            colorscale: 'Viridis',
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
