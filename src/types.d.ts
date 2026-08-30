/**
 * `react-plotly.js` ships no types and `@types/react-plotly.js` is not installed — this was a bare
 * `declare module`, which makes the default export `any` and every prop on it unchecked.
 *
 * Declared properly instead, against `@types/plotly.js` (which IS installed). Only the props this
 * app passes are listed: a wider declaration would be guessing at a library surface nothing here
 * calls, and the point of the exercise is that the props BELOW the `dynamic()` cast keep being
 * checked. Adding a prop means adding it here, which is the intended amount of friction.
 */
declare module 'react-plotly.js' {
    import type { Component } from 'react';
    import type { Data, Layout, Config, PlotMouseEvent } from 'plotly.js';

    export interface PlotParams {
        data: Data[];
        layout: Partial<Layout>;
        config?: Partial<Config>;
        style?: React.CSSProperties;
        className?: string;
        useResizeHandler?: boolean;
        onHover?: (event: Readonly<PlotMouseEvent>) => void;
        onClick?: (event: Readonly<PlotMouseEvent>) => void;
        /** Plotly's own div, handed back once it exists — `relayout` needs the element. */
        onInitialized?: (figure: { data: Data[]; layout: Partial<Layout> }, graphDiv: HTMLElement) => void;
        onUpdate?: (figure: { data: Data[]; layout: Partial<Layout> }, graphDiv: HTMLElement) => void;
        /** Bump to force a re-render when the data array is mutated in place. */
        revision?: number;
    }

    export default class Plot extends Component<PlotParams> { }
}

/**
 * The dist bundle, which @types/plotly.js does not cover — it types the `plotly.js` entry only.
 *
 * This path is deliberate rather than a shortcut: the bare `plotly.js` specifier resolves to the
 * source build, which reaches traces/image and its `require('buffer/')` Node polyfill and fails the
 * Turbopack build. The dist bundle is also what react-plotly.js itself imports, so asking for it by
 * name reuses that module instead of bundling Plotly a second time.
 *
 * Only the surface actually called is declared. Widening this to `any` would quietly re-admit every
 * Plotly call the typed entry already checks.
 */
declare module 'plotly.js/dist/plotly' {
    export function relayout(gd: HTMLElement, update: Record<string, unknown>): Promise<unknown>;
}
