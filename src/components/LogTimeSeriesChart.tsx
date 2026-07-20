import React, { useMemo } from 'react';
import dynamic from 'next/dynamic';
import { LogDataPoint } from '@/lib/types';
import { Layout, Data } from 'plotly.js';
import { FieldKey, LOG_FIELD_REGISTRY, isFieldPresent, DEFAULT_FIELD_VISIBILITY } from '@/lib/field-registry/registry';

// Dynamically import Plotly to avoid SSR issues
const Plot = dynamic(() => import('react-plotly.js'), { ssr: false }) as React.ComponentType<any>;

interface Props {
    data: LogDataPoint[];
    selectedIndex?: number | null;
    onPointClick?: (index: number) => void;
    visibleFields?: Record<FieldKey, boolean>;
    /** Full/raw log used only to decide which optional series exist, so the trace set stays stable
     *  even when the filtered view (`data`) is empty. Falls back to `data` when not provided. */
    presenceData?: LogDataPoint[];
}

export const LogTimeSeriesChart: React.FC<Props> = ({ data, selectedIndex, onPointClick, visibleFields = DEFAULT_FIELD_VISIBILITY, presenceData }) => {
    const lastHoveredIndex = React.useRef<number | null>(null);
    const presenceSource = presenceData && presenceData.length > 0 ? presenceData : data;

    // Memoize data preparation for performance
    const chartData = useMemo((): Data[] => {
        if (!data || data.length === 0) return [];

        const times = data.map(d => d.time);
        const rpms = data.map(d => d.rpm);
        const rawLoads = data.map(d => d.rawLoad);
        const correctedLoads = data.map(d => d.correctedLoad ?? d.rawLoad); // Fallback if no correction

        const traces: Data[] = [
            // Y1 Axis: RPM & Load
            {
                x: times,
                y: rpms,
                type: 'scatter', // SVG for better interaction
                mode: 'lines',
                name: LOG_FIELD_REGISTRY.rpm.label,
                line: { color: LOG_FIELD_REGISTRY.rpm.color, width: 1 },
                yaxis: 'y1',
            },
            {
                x: times,
                y: rawLoads,
                type: 'scatter',
                mode: 'lines',
                name: LOG_FIELD_REGISTRY.rawLoad.label,
                line: { color: LOG_FIELD_REGISTRY.rawLoad.color, width: 1, dash: 'dot' },
                yaxis: 'y1',
            },
            {
                x: times,
                y: correctedLoads,
                type: 'scatter',
                mode: 'lines',
                name: LOG_FIELD_REGISTRY.correctedLoad.label,
                line: { color: LOG_FIELD_REGISTRY.correctedLoad.color, width: 2 },
                yaxis: 'y1',
            },
        ];

        // Y2 Axis: Lambda (each toggleable; charted when the log source provides the channel — a
        // stable check against presenceSource, not the possibly-empty filtered view)
        if (visibleFields.lambda1 && isFieldPresent('lambda1', presenceSource)) {
            traces.push({
                x: times,
                y: data.map(d => d.lambda1) as number[],
                type: 'scatter',
                mode: 'lines',
                name: LOG_FIELD_REGISTRY.lambda1.label,
                line: { color: LOG_FIELD_REGISTRY.lambda1.color, width: 1.5 },
                yaxis: 'y2',
            });
        }

        if (visibleFields.lambda2 && isFieldPresent('lambda2', presenceSource)) {
            traces.push({
                x: times,
                y: data.map(d => d.lambda2) as number[],
                type: 'scatter',
                mode: 'lines',
                name: LOG_FIELD_REGISTRY.lambda2.label,
                line: { color: LOG_FIELD_REGISTRY.lambda2.color, width: 1.5, dash: 'dash' },
                yaxis: 'y2',
            });
        }

        return traces;
    }, [data, presenceSource, visibleFields.lambda1, visibleFields.lambda2]);

    const layout: Partial<Layout> = {
        paper_bgcolor: 'transparent',
        plot_bgcolor: 'transparent',
        margin: { l: 50, r: 50, t: 30, b: 40 }, // Balanced margins
        showlegend: true,
        legend: {
            orientation: 'h',
            y: 1.1,         // Top
            x: 0,           // Left aligned
            font: { color: '#9A9AA8' },
            bgcolor: 'rgba(0,0,0,0)',
        },
        xaxis: {
            title: { text: 'Time (s)' },
            color: '#70707E',
            gridcolor: '#17171C',
            zerolinecolor: '#2A2A33',
        },
        yaxis: {
            title: { text: 'RPM / Load' },
            color: '#9A9AA8',
            gridcolor: '#17171C',
            zerolinecolor: '#2A2A33',
            side: 'left',
            range: [0, 8500], // Correct range for RPM/Load? Load is 0-100, RPM 0-8000.
            // Problem: RPM (8000) and Load (100) are vastly different scales.
            // Standard practice: Use 2 separate Y axes on left? OR just normalize?
            // User requested "2D Time-Series Chart". Usually tuning tools overlay them.
            // Adjusting range to accommodate both:
            // If I stick to one Y1 axis, Load (100) will be tiny at bottom of RPM (8000).
            // Solution: Use Y1 for RPM, Y3 for Load? Plotly supports multiple axes.
            // Or Y1: RPM, Y2: Lambda. Where does Load go?
            // Usually Load and RPM are on different scales.
            // Let's try Y1 Left for RPM, Y2 Right for Lambda.
            // WE NEED A 3RD AXIS or share Y1. 
            // If I share Y1 (0-8000), Load (0-100) is invisible.
            // Let's make Y1: RPM. Y2: Lambda.
            // Make Y3: Load (Overlaying Y1 or Y2?).
            // Let's try Multi-Axis:
            // Y1: RPM (Left)
            // Y2: Lambda (Right)
            // Y3: Load (Left, overlaying Y1, or Right, overlaying Y2?)
            // Let's put Load on Left (Y3) with an offset or just overlay.
            // Actually, simplest for "Quick View" is:
            // Y1: RPM (0-8000)
            // Y2: Lambda (0.7-1.3)
            // Load... maybe scalable?
            // No, standard tuning logs usually have specific axes.
            // Let's create Y3 for Load on the right side next to Lambda? Or Left?
            // Let's put Load on Y1 but scale it? No, that's confusing.
            // Let's define:
            // Y1: RPM (Left)
            // Y2: Lambda (Right)
            // Y3: Load (Right, overlaid) or Left overlaid.
            // Let's try Y3 on the Right for Load.
        },
    };

    // REVISION: To handle 3 distinct scales (RPM, Load, Lambda), we need multiple axes.
    // Y1: RPM (Left)
    // Y2: Lambda (Right)
    // Y3: Load (Right, position 0.85?) or Left (position 0.15?)

    // Simpler approach often used:
    // Y1 (Left): RPM (0-9000)
    // Y2 (Right): Lambda (0.5-1.5)
    // Y3 (Left, overlay): Load (0-120) -> matches RPM scale if we multiply by X? No.

    // Let's try:
    // yaxis: { title: 'RPM', side: 'left' }
    // yaxis2: { title: 'Lambda', side: 'right', overlaying: 'y' }
    // yaxis3: { title: 'Load %', side: 'left', overlaying: 'y', position: 0.15? No, just standard dual axis is usually RPM/Lambda. Load is tricky.

    // Alternative: Put Load on Y2 (Right) along with Lambda? No, 100 vs 1.0.
    // 
    // Let's enable Y3 for Load.
    // Y1: RPM (Left)
    // Y2: Lambda (Right)
    // Y3: Load (Right, offset?)

    // Let's iterate. I'll code Y1=RPM, Y2=Lambda, Y3=Load (Left, overlaying Y1 but hidden axis? or separate).
    // Actually, simply putting Load on Y1 (Left) is bad.

    // Let's set up:
    // yaxis (RPM): Left
    // yaxis2 (Lambda): Right
    // yaxis3 (Load): Right (Overlaying y2, but with different range? Plotly allows this).

    const advancedLayout: Partial<Layout> = {
        paper_bgcolor: 'transparent',
        plot_bgcolor: 'transparent',
        margin: { l: 60, r: 60, t: 30, b: 40 },
        showlegend: true,
        hovermode: 'x unified', // [NEW] Link all traces in hover
        // [NEW] Modern Tooltip Styling
        hoverlabel: {
            bgcolor: 'rgba(23, 23, 28, 0.95)', // panel charcoal with slight opacity
            bordercolor: '#2A2A33', // border charcoal
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
            // [NEW] Sleek Spike Line - Minimalist
            showspikes: true,
            spikethickness: 1,
            spikedash: 'solid',
            spikemode: 'across',
            spikecolor: 'rgba(154, 154, 168, 0.2)', // slate-400 charcoal, 20% opacity (Very subtle)
        },
        // RPM (Left)
        yaxis: {
            title: { text: 'RPM', font: { color: '#9A9AA8' } },
            tickfont: { color: '#9A9AA8' },
            side: 'left',
            range: [0, 9000],
            gridcolor: '#17171C',
            // Custom Ticks: 1k, 2k, ...
            tickmode: 'array',
            tickvals: [0, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000],
            ticktext: ['0', '1k', '2k', '3k', '4k', '5k', '6k', '7k', '8k', '9k'],
            fixedrange: true, // [NEW] Lock Y-axis zoom
            showspikes: false, // Only vertical spike
        },
        // Lambda (Right)
        yaxis2: {
            title: { text: 'Lambda', font: { color: '#4ade80' } },
            tickfont: { color: '#4ade80' },
            overlaying: 'y',
            side: 'right',
            range: [0.65, 1.35],
            showgrid: false,
            fixedrange: true, // [NEW] Lock Y-axis zoom
            showspikes: false,
        },
        // Load (Right, overlaid)
        // To avoid clutter, let's put Load on Left as well but strictly ranged 0-100?
        // If I put Load on Left, visually 100 sits at the very bottom of the 9000 RPM range.
        // I will map Load to Y3, on the Left, overlaid, range 0-120.
        yaxis3: {
            title: { text: 'Load %', font: { color: '#0A9BDB' } },
            tickfont: { color: '#0A9BDB' },
            overlaying: 'y',
            side: 'right',
            range: [0, 120],
            position: 0.95, // Shift slightly if needed, but overlaying 'y' standard works.
            anchor: 'x', // [UPDATED] Anchor to X to ensure sync
            showgrid: false,
            fixedrange: true, // Lock Y-axis zoom
            showspikes: false,
        },
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
                    color: '#f59e0b', // Amber-500
                    width: 2,
                    dash: 'solid'
                }
            }
        ] : [],
    };

    // wait, react-plotly types might need casting for multi-axis

    return (
        <div
            className="w-full h-full min-h-[300px]"
            onClick={(e) => {
                if (onPointClick) {
                    // [FIX] Global Bounds Check first: Ignore clicks in margins (Legend, X-Axis)
                    const rect = e.currentTarget.getBoundingClientRect();
                    const y = e.clientY - rect.top; // [NEW] Get Y coordinate

                    const marginT = 30; // Matches advancedLayout.margin.t (Legend Area)
                    const marginB = 40; // Matches advancedLayout.margin.b (Axis Area)

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

                    const marginL = 60; // Matches advancedLayout.margin.l
                    const marginR = 60; // Matches advancedLayout.margin.r


                    const plotWidth = rect.width - marginL - marginR;

                    // Ratio within the plotting area
                    // Clamp to 0-1 to avoid out of bounds
                    const ratio = Math.max(0, Math.min(1, (x - marginL) / plotWidth));

                    // Map to data index
                    if (data.length > 0) {
                        const idx = Math.round(ratio * (data.length - 1));
                        onPointClick(idx);
                    }
                }
            }}
            onMouseLeave={() => {
                // Optional: Clear hover index on leave? 
                // Better keep it to allow "slack" clicking
                // lastHoveredIndex.current = null; 
            }}
        >
            <Plot
                data={[
                    { ...chartData[0], yaxis: 'y' } as Data, // RPM
                    { ...chartData[1], yaxis: 'y3' } as Data, // Raw RO
                    { ...chartData[2], yaxis: 'y3' } as Data, // Corr RO
                    ...(chartData.slice(3).map(d => ({ ...d, yaxis: 'y2' }))) as Data[] // Lambdas
                ]}
                style={{ width: '100%', height: '100%', pointerEvents: 'auto' }} // [FIX] Enable pointer events for Zoom/Pan
                // uirevision: used to preserve state (zoom/pan) across re-renders.
                // We use data[0].time as revision key.
                // If data shifts (window slide), time changes -> Reset Zoom (Good).
                // If toggle button clicked -> data identical -> Preserve Zoom (Good).
                layout={{
                    ...advancedLayout,
                    clickmode: 'event', // Force click events
                    dragmode: 'pan',
                    uirevision: data.length > 0 ? data[0].time : 'init'
                }}
                config={{
                    displayModeBar: false,
                    scrollZoom: true,
                    responsive: true,
                    doubleClick: false,
                }}
                useResizeHandler={true}
                onHover={(e: any) => {
                    if (e.points && e.points.length > 0) {
                        lastHoveredIndex.current = e.points[0].pointIndex;
                    }
                }}
            // Remove direct onClick to avoid double triggers, rely on Wrapper
            />
        </div>
    );
};
