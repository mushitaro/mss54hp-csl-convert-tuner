/** Render the production UI: live acquisition must never claim final acceptance or hold time. */
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const bundle = await build({
    stdin: { contents: `export {MapEditor} from './src/components/MapEditor'; export {MovingAcquisitionSummary} from './src/components/MovingAcquisitionSummary'; export {LiveDriveStrip} from './src/components/LiveDriveStrip';`, resolveDir: root },
    bundle: true, platform: 'node', format: 'cjs', write: false, packages: 'external', alias: { '@': path.join(root, 'src') },
});
const compiled = { exports: {} };
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(createRequire(import.meta.url), compiled, compiled.exports);
const { MapEditor, MovingAcquisitionSummary, LiveDriveStrip } = compiled.exports;

const map = { xAxis: [2200, 2400, 2700, 3000], yAxis: [7.5], data: [[.758, .841, .875, .8]] };
const coverage = {
    observedRows: 29, candidateRows: 12,
    cells: [[
        { recorded: 0, candidates: 0, passes: 0, state: 'unvisited', reasons: {} },
        { recorded: 8, candidates: 0, passes: 0, state: 'blocked', reasons: { 'injection-missing': 5, 'warming-up': 3 } },
        { recorded: 7, candidates: 5, passes: 1, state: 'collecting', reasons: { 'fuel-cut': 2 } },
        { recorded: 14, candidates: 7, passes: 2, state: 'revisited', reasons: { 'oxygen-pending': 7 } },
    ]],
};
const render = (Component, props) => renderToStaticMarkup(createElement(Component, props));
const live = render(MapEditor, {
    mapData: map, liveAcquisition: coverage,
    // A stale finalized map must have no power to paint a candidate as accepted/rich/lean.
    hitData: [[99, 99, 99, 99]], acceptedData: [[true, true, true, true]], diffData: [[10, -10, 10, -10]],
    mutedCells: [[true, true, true, true]], cellTint: () => 'text-red-100',
    selected: { row: 0, col: 1 }, onCellSelect() {},
});
for (const state of ['unvisited', 'blocked', 'collecting', 'revisited']) {
    assert.equal((live.match(new RegExp(`data-acquisition-state="${state}"`, 'g')) ?? []).length, 1);
}
assert(live.includes('repeating-linear-gradient'));
assert(!live.includes('143, 216, 242'));
assert(!live.includes('rgba(241'));
assert(!live.includes('text-red-100'));
assert(!live.includes('opacity-40'));
assert(live.includes('0.841'));
assert(!live.includes('+0.8%'));
assert.equal((live.match(/tabindex="0"/g) ?? []).length, 4);
assert(live.includes('aria-pressed="true"'));
assert(live.includes('記録 8件 · 候補 0件 · 通過 0回'));
console.log('PASS rendered live grid has four distinct, accessible preliminary states and suppresses stale final-result colours/values');

const counts = render(MapEditor, {
    mapData: { ...map, data: coverage.cells.map(row => row.map(cell => cell.candidates)) },
    liveAcquisition: coverage, valueFormat: String,
});
assert(counts.includes('>0</span>'));
assert(counts.includes('>7</span>'));
assert(!counts.includes('7.000'));

const legacy = render(MapEditor, { mapData: map, hitData: [[0, 3, 15, 35]], acceptedData: [[false, false, true, true]] });
assert(!legacy.includes('data-acquisition-state'));
assert(legacy.includes('143, 216, 242'));
console.log('PASS acquisition count grid shows integer observations while the existing final-result grid keeps its original fill');

for (const [phase, label] of Object.entries({ recording: '収録中', analyzing: '解析中', unresolved: '補正採用なし', error: '解析未完了' })) {
    const summary = render(MovingAcquisitionSummary, { coverage, mapData: map, phase, selected: { row: 0, col: 1 }, onClose() {} });
    assert(summary.includes('height:96px'));
    assert(summary.includes(label));
    assert(summary.includes('記録 29件 · 解析候補 12件'));
    assert(summary.includes('未記録') && summary.includes('条件外／欠測') && summary.includes('解析候補') && summary.includes('複数通過'));
    assert(summary.includes('補正への採用はSTOP後に判定します'));
    assert(summary.includes('<details'));
    assert(summary.includes('injection-missing') === false); // The operator sees an explanation, never an internal reason key.
    assert(summary.includes('5</p>') && summary.includes('3</p>'));
}
console.log('PASS every STOP/analysis phase preserves the 96px legend and selected-cell details, including all touch-accessible reasons');

const snapshot = { sample: { rpm: 2400, rawLoad: 7.5, time: 8 }, heldSec: 8, hz: 2, count: 29 };
const feed = { subscribe: () => () => {}, getSnapshot: () => snapshot, getServerSnapshot: () => snapshot };
const stripProps = { feed, settleSec: 5, view: 've', views: ['ve'], onViewChange() {},
    hitMap: [[99, 99, 99, 99]], rpmAxis: map.xAxis, loadAxis: map.yAxis, coverageOk: 30, cues: false };
const strip = render(LiveDriveStrip, { ...stripProps, acquisition: coverage });
assert(strip.includes('測定点の状態'));
assert(strip.includes('条件外'));
assert(strip.includes('候補数 · 通過回数'));
assert(!strip.includes('HELD IN CELL'));
assert(!strip.includes('TO COVERED'));
assert(!strip.includes('done'));
const oldStrip = render(LiveDriveStrip, stripProps);
assert(oldStrip.includes('HELD IN CELL') && oldStrip.includes('TO COVERED'));
console.log('PASS live moving-response readout reports acquisition and visits instead of a hold-time or done claim; legacy mode is unchanged');
