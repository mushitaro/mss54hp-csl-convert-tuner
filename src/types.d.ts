declare module 'react-plotly.js';

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
