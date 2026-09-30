'use client';

import createPlotComponent from 'react-plotly.js/factory';
import Plotly from 'plotly.js/dist/plotly-gl3d';

/**
 * The Plotly component both charts mount, built from the **gl3d partial bundle**.
 *
 * ## Why not `react-plotly.js` itself
 *
 * That package's default export is its factory already applied to `plotly.js/dist/plotly` — the
 * FULL bundle: every trace type, mapbox, maplibre, regl, d3. 4.8 MB minified, and this app draws
 * exactly two kinds of thing: a `surface` (MapVisualizer) and SVG `scatter` traces
 * (LogTimeSeriesChart). The `gl3d` partial carries `cone`, `isosurface`, `mesh3d`, `scatter`,
 * `scatter3d`, `streamtube`, `surface` and `volume` — both of ours — at 1.68 MB.
 *
 * On a desk the difference is a download. On a head unit it is parse, compile and heap, paid the
 * first time a chart tab is opened, on a CPU several times slower than the phone this was tested on.
 *
 * ## One specifier, in three places
 *
 * `plotly.js/dist/plotly-gl3d` is also what `MapVisualizer` and `LogTimeSeriesChart` import for
 * `relayout`. They must stay in step: a different specifier is a different module, and Plotly would
 * be bundled twice — which is the failure this file exists to avoid, in its worst form.
 *
 * The bare `plotly.js` specifier is still wrong for all three: it resolves to the source build,
 * which reaches `traces/image` and its `require('buffer/')` Node polyfill and fails the Turbopack
 * build. The dist bundles do not.
 *
 * Mounted through `next/dynamic` with `ssr: false` at both call sites, because evaluating Plotly
 * needs a DOM and the export is prerendered.
 */
export default createPlotComponent(Plotly);
