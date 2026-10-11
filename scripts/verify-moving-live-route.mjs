/** The real hook must retain the measured grid independently of the asynchronous Tune result. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { build } from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');
const state = globalThis.__movingLiveRoute = {
    states: [], refs: [], cursor: 0, refCursor: 0, jobs: [], calls: [],
};
const bundled = await build({
    stdin: {
        contents: `export { useVeCalculation } from './src/hooks/useVeCalculation';
            export { buildCoverage, coverageCensus } from './src/lib/ve-calculator/cellCoverage';`,
        resolveDir: root, loader: 'ts',
    },
    bundle: true, platform: 'node', format: 'esm', write: false,
    alias: { '@': path.join(root, 'src') },
    plugins: [{ name: 'moving-live-hook-harness', setup(builder) {
        builder.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'fixture' }));
        builder.onResolve({ filter: /movingResponseWorker/ }, () => ({ path: 'worker', namespace: 'fixture' }));
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'js', contents: args.path === 'react' ? `
            const h = globalThis.__movingLiveRoute;
            export function useState(initial) {
                const i = h.cursor++;
                if (!(i in h.states)) h.states[i] = typeof initial === 'function' ? initial() : initial;
                return [h.states[i], v => { h.states[i] = typeof v === 'function' ? v(h.states[i]) : v; }];
            }
            export function useRef(initial) {
                const i = h.refCursor++;
                return h.refs[i] ?? (h.refs[i] = { current: initial });
            }
            export function useEffect() {}
        ` : `
            export function startMovingResponseWorker(request) {
                const h = globalThis.__movingLiveRoute;
                h.calls.push(request);
                let resolve, reject;
                const result = new Promise((ok, fail) => { resolve = ok; reject = fail; });
                const job = { result, resolve, reject, cancelled: false,
                    cancel() { this.cancelled = true; resolve(null); } };
                h.jobs.push(job);
                return job;
            }
        ` }));
    } }],
});
const { useVeCalculation, buildCoverage, coverageCensus } = await import('data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64'));
function render() { state.cursor = 0; state.refCursor = 0; return useVeCalculation(); }
const map = { xAxis: [2000, 2500], yAxis: [5, 10], data: [[1, 1], [1, 1]] };
const raw = Array.from({ length: 6 }, (_, i) => ({
    time: 1 + .5 * i, rpm: 2100 + 50 * i, rawLoad: 7,
    stft1: .9, stft2: .91, coolantTemp: 90,
}));
const options = {
    veCorrectionPolicy: 'moving-response', steadyCalibrationHold: 'binary-missing', movingCalibration: null,
    steadyFilterConfig: { enableCorrection: false },
};
const process = rows => ({ rawData: rows, data: [], rfKorrData: [], validCount: 0,
    droppedCount: rows.length, dropCensus: {} });
const finished = {
    newMap: null, diffMap: [[100, 100], [100, 100]], hitMap: [[0, 0], [0, 0]],
    correctionMap: [[1, 1], [1, 1]], weightMap: [[0, 0], [0, 0]],
    acceptedMap: [[false, false], [false, false]], rejectMap: [['no-data', 'no-data'], ['no-data', 'no-data']],
    demandMap: [[1, 1], [1, 1]], realisedMap: [[1, 1], [1, 1]],
    rfKorrMap: [[1, 1], [1, 1]], rfKorrSpreadMap: [[0, 0], [0, 0]],
    coverage: { withEvidence: 0, withAnyData: 0, total: 4 },
};

render().appendCalculation(map, process(raw.slice(0, 2)), options);
assert.equal(state.calls.length, 0, 'LIVE must not launch the full solver');
assert.equal(render().liveAcquisition.observedRows, 2, 'RAW coordinates remain visible when every legacy filtered row was dropped');
assert.equal(render().liveAcquisition.candidateRows, 0, 'missing calibration cannot masquerade as candidate evidence');
assert.equal(render().newMap, null);
assert.equal(render().acceptedMap, null);
assert.equal(render().correctionMap, null, 'LIVE counts are not lambda corrections');
render().appendCalculation(map, process(raw.slice(0, 2)), options);
assert.equal(render().liveAcquisition.observedRows, 2, 'duplicate flush does not double-count the drive');
render().appendCalculation(map, process(raw), options);
assert.equal(render().liveAcquisition.observedRows, 6, 'the collected grid survives each growing flush');
assert.equal(state.calls.length, 0);
console.log('PASS LIVE retains RAW measurement coverage across flushes without inventing accepted cells or launching the solver');

const stopping = render().runCalculation(map, process(raw), options);
assert.equal(render().isCalculating, true);
assert.equal(render().liveAcquisition.observedRows, 6, 'STOP must keep the collection grid while the worker is pending');
assert.equal(render().newMap, null);
assert.equal(state.calls.at(-1).raw.length, 6);
state.jobs.at(-1).resolve(finished);
await stopping;
assert.equal(render().isCalculating, false);
assert.equal(render().liveAcquisition.observedRows, 6, 'zero adopted cells must not erase the measured area');
assert.equal(render().newMap, null);
const failing = render().runCalculation(map, process(raw), options);
state.jobs.at(-1).reject(new Error('Fixture worker failure'));
await failing;
assert.equal(render().movingError, 'Fixture worker failure');
assert.equal(render().liveAcquisition.observedRows, 6, 'worker errors must not erase the measurements');
assert.equal(render().newMap, null);
console.log('PASS STOP, zero adoption, and worker failure preserve the measured grid without preserving writable stale results');

render().reset();
assert.equal(render().liveAcquisition, null, 'explicit session/log reset clears the collected grid');
render().appendCalculation(map, process(raw), options);
render().appendCalculation(map, process(raw.slice(0, 1)), options);
assert.equal(render().liveAcquisition.observedRows, 1, 'a new shorter drive cannot inherit old hits');
const otherMap = { ...map, yAxis: [1, 5], data: [[.99, 1], [1, 1]] };
render().appendCalculation(otherMap, process(raw.slice(0, 2)), options);
assert.equal(render().liveAcquisition.observedRows, 2, 'another BASE cannot inherit the previous grid');
assert(render().liveAcquisition.cells[0].every(cell => cell.recorded === 0), 'a changed BASE rebins the retained RAW on its own axes');
render().appendCalculation(otherMap, process(raw.slice(0, 2)), {
    ...options, steadyFilterConfig: { enableCorrection: true },
    steadyLoadTable: [{ rpm: 0, factor: 2 }, { rpm: 10000, factor: 2 }],
});
assert.equal(render().liveAcquisition.observedRows, 2, 'configuration reprocessing replaces counts instead of appending them');
assert(render().liveAcquisition.cells[0].some(cell => cell.recorded === 2), 'changed load correction rebins previous RAW, too');
const replacementRaw = raw.slice(0, 2).map(row => ({ ...row, time: row.time + 20, rawLoad: 10 }));
render().appendCalculation(map, process(raw.slice(0, 2)), options);
render().appendCalculation(map, process(replacementRaw), options);
assert.equal(render().liveAcquisition.observedRows, 2);
assert(render().liveAcquisition.cells[0].every(cell => cell.recorded === 0), 'a replacement log of equal length replaces the measured coordinates');
console.log('PASS explicit reset, replaced RAW run, changed BASE and changed calibration inputs cannot inherit stale coverage');

// The filter/table controls call this page wrapper rather than the periodic
// flush. They must not accidentally take the STOP solver path during recording.
const page = fs.readFileSync(path.join(root, 'src/app/page.tsx'), 'utf8');
const ast = ts.createSourceFile('page.tsx', page, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function variable(name) {
    let found;
    function visit(node) {
        if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) found = node.initializer;
        ts.forEachChild(node, visit);
    }
    visit(ast);
    assert(found, `page declaration ${name} must exist`);
    return found;
}
const wrapperCode = ts.transpileModule(`const runCalculation = ${variable('runCalculation').getText(ast)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
const routeCalls = [], link = { state: 'tuning' };
const wrapperDeps = {
    veCalcOptions: options, dmeLink: link,
    veCalc: {
        appendCalculation: (...args) => routeCalls.push(['live', ...args]),
        runCalculation: (...args) => routeCalls.push(['batch', ...args]),
    },
    comparison: { applyDefaultsAfterCalculation() {} },
};
const reprocess = new Function(...Object.keys(wrapperDeps), `${wrapperCode}\nreturn runCalculation;`)(...Object.values(wrapperDeps));
reprocess(map, process(raw));
assert.equal(routeCalls.at(-1)[0], 'live', 'changing filters during moving LIVE must update only acquisition');
assert.equal(routeCalls.at(-1)[2].rawData, raw);
link.state = 'connected';
reprocess(map, process(raw));
assert.equal(routeCalls.at(-1)[0], 'batch', 'reprocessing after STOP still runs the estimator');
link.state = 'tuning';
reprocess(map, process(raw), { veCorrectionPolicy: 'legacy' });
assert.equal(routeCalls.at(-1)[0], 'batch', 'legacy replay remains on its previous route');
console.log('PASS filter/table reprocessing during moving LIVE cannot launch a full solve behind the acquisition grid');

const emptyCoverage = buildCoverage({ rows: 2, cols: 2, hitMap: null, weightMap: null,
    correctionMap: null, rejectMap: null });
assert.deepEqual(coverageCensus(emptyCoverage), { written: 0, refused: 0, settled: 0, unvisited: 4 });
assert(emptyCoverage.flat().every(cell => !cell.belowReach && cell.state !== 'settled' && cell.state !== 'written'));
console.log('PASS a missing final verdict cannot mark the entire BASE as settled or turn it into measured SHAPE anchors');

function evaluate(node, deps) {
    const compiled = ts.transpileModule(`const value = ${node.getText(ast)};`, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
    }).outputText;
    return new Function(...Object.keys(deps), `${compiled}\nreturn value;`)(...Object.values(deps));
}
const acquired = render().liveAcquisition;
const display = {
    filterConfig: { veCorrectionPolicy: 'moving-response' }, dmeLink: { state: 'tuning' }, newMap: null,
    veCalc: { liveAcquisition: acquired, isCalculating: false, movingError: null },
};
const measured = () => evaluate(variable('movingAcquisition'), display);
assert.equal(measured(), acquired);
display.dmeLink.state = 'connected';
display.veCalc.isCalculating = true;
assert.equal(measured(), acquired, 'the displayed acquisition remains available while solving');
assert.equal(evaluate(variable('movingAcquisitionPhase'), display), 'analyzing');
display.veCalc.isCalculating = false;
assert.equal(measured(), acquired, 'zero accepted result keeps the measured grid');
display.veCalc.movingError = 'worker failure';
assert.equal(measured(), acquired, 'error keeps the measured grid');
assert.equal(evaluate(variable('movingAcquisitionPhase'), display), 'error');
display.veCalc.movingError = null;

let lambdaTab, pendingEffect;
function findPageRouting(node) {
    if (ts.isObjectLiteralExpression(node)
        && node.properties.some(property => ts.isPropertyAssignment(property)
            && property.name.getText(ast) === 'id' && property.initializer.getText(ast) === "'lambda'")
        && node.properties.some(property => ts.isPropertyAssignment(property) && property.name.getText(ast) === 'enabled')) lambdaTab = node;
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect'
        && node.arguments[0]?.getText(ast).includes('const want = pendingTabRef.current;')) pendingEffect = node.arguments[0];
    ts.forEachChild(node, findPageRouting);
}
findPageRouting(ast);
assert(lambdaTab); assert(pendingEffect);
const measurementTab = evaluate(lambdaTab, { movingAcquisition: acquired, correctionMap: null });
assert.equal(measurementTab.enabled, true);
assert.equal(measurementTab.label, 'MEASUREMENT');
const measurementGrid = evaluate(variable('lambdaVisualMap'), {
    currentMap: map, movingAcquisition: acquired, correctionMap: null, useMemo: fn => fn(),
});
assert.deepEqual(measurementGrid.data, acquired.cells.map(row => row.map(cell => cell.recorded)));
const pending = { current: 'lambda' }, navigation = [];
const navDeps = {
    pendingTabRef: pending, TABS: [measurementTab, { id: 'new', enabled: false }],
    veCalc: display.veCalc, newMap: null, correctionMap: null, movingAcquisition: acquired,
    setActiveTab: tab => navigation.push(['tab', tab]), setNarrowPane: pane => navigation.push(['pane', pane]),
};
evaluate(pendingEffect, navDeps)();
assert.deepEqual(navigation, [['tab', 'lambda'], ['pane', 'map']]);
assert.equal(pending.current, null, 'START navigation completes without needing a lambda correction');
pending.current = 'new';
display.veCalc.isCalculating = true;
evaluate(pendingEffect, navDeps)();
assert.equal(pending.current, 'new');
display.veCalc.isCalculating = false;
evaluate(pendingEffect, navDeps)();
assert.equal(pending.current, null);
assert.deepEqual(navigation.slice(-2), [['tab', 'lambda'], ['pane', 'map']], 'no adopted VE remains on MEASUREMENT');
display.newMap = { ...map, calibrationStatus: 'moving-validated' };
assert.equal(measured(), null, 'a completed accepted result leaves the preliminary acquisition view');
const feedbackTab = evaluate(lambdaTab, { movingAcquisition: null, correctionMap: finished.correctionMap });
assert.equal(feedbackTab.label, 'LAMBDA FEEDBACK');
assert.equal(feedbackTab.enabled, true);
pending.current = 'new';
navDeps.newMap = display.newMap;
navDeps.TABS = [feedbackTab, { id: 'new', enabled: true }];
navDeps.movingAcquisition = null;
evaluate(pendingEffect, navDeps)();
assert.deepEqual(navigation.slice(-2), [['tab', 'new'], ['pane', 'map']]);
display.filterConfig.veCorrectionPolicy = 'legacy';
display.newMap = null;
assert.equal(measured(), null, 'changing policy cannot retain moving acquisition in a legacy display');
console.log('PASS START opens MEASUREMENT without a correction; STOP preserves it until a validated TUNED result is available');

delete globalThis.__movingLiveRoute;
