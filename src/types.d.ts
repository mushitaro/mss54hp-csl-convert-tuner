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
 * Turbopack build.
 *
 * `-gl3d` is the partial bundle the app is built from — see `components/PlotGl3d.tsx`. It has to be
 * the SAME specifier that file hands to the factory, or Plotly is bundled twice.
 *
 * Only the surface actually called is declared. Widening this to `any` would quietly re-admit every
 * Plotly call the typed entry already checks.
 */
declare module 'plotly.js/dist/plotly-gl3d' {
    export function relayout(gd: HTMLElement, update: Record<string, unknown>): Promise<unknown>;
    const Plotly: { relayout: typeof relayout };
    export default Plotly;
}

/**
 * The factory react-plotly.js exposes so a caller can supply its own Plotly build. Untyped in the
 * package; declared here against the same PlotParams the default export is declared with, so the
 * component this produces is checked exactly like the one it replaces.
 */
declare module 'react-plotly.js/factory' {
    import type { ComponentType } from 'react';
    import type { PlotParams } from 'react-plotly.js';
    export default function createPlotComponent(plotly: unknown): ComponentType<PlotParams>;
}
