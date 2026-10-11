/** New work uses history Tune; historical replay keeps the settings that produced it. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { build } from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');
const bundle = await build({
    stdin: { contents: `export { DEFAULT_FILTER_CONFIG } from './src/lib/log-engine/filterDefaults';
        export { freshTuneFilterConfig, replayTuneFilterConfig } from './src/lib/log-engine/tunePolicy';
        export { isVeHistoryPolicy } from './src/lib/types';
        export { LOG_PROFILES, productionExchanges } from './src/lib/log-engine/logProfile';`,
        resolveDir: root, loader: 'ts' },
    bundle: true, platform: 'node', format: 'esm', write: false,
    alias: { '@': path.join(root, 'src') },
});
const { DEFAULT_FILTER_CONFIG, freshTuneFilterConfig, replayTuneFilterConfig, isVeHistoryPolicy,
    LOG_PROFILES, productionExchanges } = await import(
    'data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));

assert.equal(DEFAULT_FILTER_CONFIG.veCorrectionPolicy, 'moving-response');
for (const policy of [undefined, 'legacy-nominal', 'steady-retain', 'dme-response', 'moving-response']) {
    const original = Object.freeze({ ...DEFAULT_FILTER_CONFIG, veCorrectionPolicy: policy, minTemp: 73, veLearningRate: .6 });
    const fresh = freshTuneFilterConfig(original);
    assert.notEqual(fresh, original);
    assert.equal(fresh.veCorrectionPolicy, 'moving-response');
    assert.equal(fresh.minTemp, 73);
    assert.equal(fresh.veLearningRate, .6);
    assert.equal(original.veCorrectionPolicy, policy, 'opening new work does not rewrite saved settings');
    const replay = replayTuneFilterConfig(original);
    assert.equal(replay.veCorrectionPolicy, policy ?? 'legacy-nominal');
    assert.equal(replay.minTemp, 73);
    assert.equal(replay.veLearningRate, .6);
}
assert.equal(freshTuneFilterConfig().veCorrectionPolicy, 'moving-response');
assert.equal(replayTuneFilterConfig(undefined).veCorrectionPolicy, 'legacy-nominal');
assert.equal(replayTuneFilterConfig(undefined, { ...DEFAULT_FILTER_CONFIG, minTemp: 71 }).minTemp, 71);
console.log('PASS fresh work always chooses history Tune; explicit and pre-policy saved histories preserve their original estimator without mutation');

const source = fs.readFileSync(path.join(root, 'src/app/page.tsx'), 'utf8');
const ast = ts.createSourceFile('page.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations = new Map();
const walk = node => {
    if (ts.isVariableDeclaration(node)) declarations.set(node.name.getText(ast), node.initializer);
    ts.forEachChild(node, walk);
};
walk(ast);
function executable(name, deps) {
    const init = declarations.get(name);
    assert(init, `actual ${name} handler exists`);
    const js = ts.transpileModule(`const ${name} = ${init.getText(ast)};`, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, jsx: ts.JsxEmit.React },
    }).outputText;
    return new Function(...Object.keys(deps), `${js}\nreturn ${name};`)(...Object.values(deps));
}

// Exercise the page's NEW handler with an old replay active. The creation alone
// must publish the new policy: needing a later settings click was the regression.
for (const policy of [undefined, 'legacy-nominal', 'steady-retain', 'dme-response']) {
    const calls = [];
    const created = { id: 'new-history-drive', status: 'draft' };
    const config = { ...DEFAULT_FILTER_CONFIG, veCorrectionPolicy: policy };
    const deps = {
        freshTuneFilterConfig, replayTuneFilterConfig, DEFAULT_FILTER_CONFIG,
        filterConfig: config, pendingConfig: null, pendingConfigRef: { current: null },
        sessionDb: { sessions: [], newDraft: async () => created,
            remove: async () => { throw Error('no historical records may be removed'); } },
        logFileState: { reprocess: value => { calls.push(['config', value]); return null; } },
        binaryFileState: { setWriteVe: value => calls.push(['writeVe', value]) },
        setActiveSessionId: value => calls.push(['active', value]),
        resetDerived: () => calls.push(['reset']), goToTab: value => calls.push(['tab', value]),
    };
    assert.equal(await executable('handleNewSession', deps)(), created);
    const published = calls.filter(c => c[0] === 'config').at(-1)?.[1];
    assert.equal(published?.veCorrectionPolicy, 'moving-response', 'NEW cannot inherit historical replay mode');
}
console.log('PASS actual NEW handler leaves old replay behind before the next drive');

const branch = declarations.get('handleNewFrom')?.getText(ast);
assert(branch?.includes('handleNewSession()'), 'NEW FROM must pass through the same fresh-work policy boundary');
const open = declarations.get('handleOpenSession')?.getText(ast);
assert(open?.includes('replayTuneFilterConfig('), 'saved log replay must resolve absent historical policy explicitly');
assert(open?.includes('freshTuneFilterConfig('), 'opening a base-only draft must use fresh Tune');
console.log('PASS NEW FROM shares the fresh-work boundary; session opening distinguishes fresh work from historical replay');

function openHarness(session) {
    const calls = [], base = new ArrayBuffer(4), recording = new ArrayBuffer(4);
    const raw = [{ time: 1, rpm: 2200, rawLoad: 8 }, { time: 2, rpm: 2500, rawLoad: 9 }];
    const reference = { version: 1, status: 'verified-start-checksums' };
    const map = { xAxis: [2000, 2500], yAxis: [5, 10], data: [[1, 1], [1, 1]] };
    const deps = {
        freshTuneFilterConfig, replayTuneFilterConfig, DEFAULT_FILTER_CONFIG, isVeHistoryPolicy,
        APP_CONFIG: { MSS54HP: { INTERPOLATION_TABLE: [{ rpm: 1000, factor: 1 }] } },
        filterConfig: { ...DEFAULT_FILTER_CONFIG, veCorrectionPolicy: 'dme-response', minTemp: 81 },
        interpolationTable: [{ rpm: 1000, factor: 2 }],
        sessionDb: { loadBinaries: async () => ({ baseBinaryBuffer: base }), sessions: [],
            loadLogRecord: async () => ({ data: raw, recordingCalibration: reference }) },
        resetDerived: () => calls.push(['reset']), setActiveSessionId: value => calls.push(['active', value]),
        goToTab: value => calls.push(['tab', value]), setNarrowPane: value => calls.push(['pane', value]),
        pendingCalEditsRef: { current: null }, pendingTabRef: { current: null },
        storedWriteRfKorr: settings => settings?.writeRfKorr ?? false,
        armedPatchesFromHistory: () => null,
        binaryFileState: { loadFromBuffer: async (...args) => { calls.push(['base', ...args]); return map; } },
        recordingCalibrationBuffer: async () => recording,
        setRecordingCalibration: value => calls.push(['recording', value]),
        setRecordingBinary: value => calls.push(['recordingBytes', value]),
        logFileState: {
            reprocess: config => { calls.push(['config', config]); return null; },
            loadRawLog: (...args) => { calls.push(['log', ...args]); return { rawData: raw, data: raw, rfKorrData: [] }; },
        },
        BinaryParser: class { constructor(buffer) { this.buffer = buffer; } readLambdaLimits() { return this.buffer; } },
        bytesAsRun: buffer => buffer, readEgtTables: () => null, readRfPtKorrCurves: () => null,
        veCalcOptionsFor: config => ({ veCorrectionPolicy: config.veCorrectionPolicy, originalConfig: config }),
        veCalc: { runCalculation: (...args) => calls.push(['calculate', ...args]) },
        comparison: { applyDefaultsAfterCalculation: () => {} }, cancelPendingFilterCompute: () => {},
        alert: message => { throw Error(`unexpected alert: ${message}`); },
        dialogText: () => ({ notReconstructed: 'not reconstructed', noStoredBinary: 'no binary' }),
    };
    return { calls, deps, invoke: () => executable('handleOpenSession', deps)(session) };
}

for (const savedPolicy of [undefined, 'legacy-nominal', 'steady-retain', 'dme-response', 'moving-response']) {
    const savedConfig = Object.freeze({ ...DEFAULT_FILTER_CONFIG, veCorrectionPolicy: savedPolicy, minTemp: 67 });
    const session = { id: 'recorded-drive', status: 'archived', hasLog: true,
        baseOrigin: { kind: 'upload' }, tuneSettings: { filterConfig: savedConfig, writeVe: true },
        sha256: 'immutable-fixture-hash' };
    const snapshot = JSON.stringify(session);
    const h = openHarness(session); await h.invoke();
    const cfg = h.calls.filter(c => c[0] === 'config').at(-1)?.[1];
    assert.equal(cfg?.veCorrectionPolicy, savedPolicy ?? 'legacy-nominal');
    assert.equal(cfg.minTemp, 67, 'historical filter values are retained');
    assert.equal(h.calls.find(c => c[0] === 'log')?.[3], cfg, 'filtering uses the resolved replay config');
    assert.equal(h.calls.find(c => c[0] === 'calculate')?.[3].originalConfig, cfg, 'solver uses the same resolved replay config');
    assert.equal(JSON.stringify(session), snapshot, 'opening cannot mutate archived settings or hash');
}
for (const baseOrigin of [null, { kind: 'upload' }]) {
    const h = openHarness({ id: 'empty-draft', status: 'draft', hasLog: false, baseOrigin,
        tuneSettings: { filterConfig: { ...DEFAULT_FILTER_CONFIG, veCorrectionPolicy: 'steady-retain' } } });
    await h.invoke();
    assert.equal(h.calls.filter(c => c[0] === 'config').at(-1)?.[1]?.veCorrectionPolicy, 'moving-response');
    assert(!h.calls.some(c => c[0] === 'calculate'), 'opening a base-only draft cannot invent a log calculation');
}
console.log('PASS actual OPEN publishes one consistent policy to filtering and calculation; archived records are unchanged and base-only drafts start history Tune');

// Execute START's actual exchange selection, since a new estimator whose input
// reads are still stripped in production would never get a usable measurement.
function nestedInitializer(parent, name) {
    let found;
    const visit = node => {
        if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) found = node.initializer;
        ts.forEachChild(node, visit);
    };
    visit(declarations.get(parent));
    assert(found, `${parent} defines ${name}`);
    return found.getText(ast);
}
const exchangeExpression = nestedInitializer('startTune', 'exchanges');
async function chosenExchanges(policy, verified = LOG_PROFILES.VE.exchanges) {
    let verifications = 0;
    const deps = {
        featurePreview: false, logProcess: 'VE', filterConfig: { veCorrectionPolicy: policy },
        isVeHistoryPolicy, productionExchanges, profile: LOG_PROFILES.VE,
        dmeLink: { verifyLogProfile: async () => { verifications++; return { exchanges: verified }; } },
    };
    const selected = await new Function(...Object.keys(deps), `return (async () => (${exchangeExpression}))();`)(...Object.values(deps));
    assert.equal(verifications, 1, 'START verifies the channel source once before choosing the recording list');
    return selected;
}
const required = ['rfKorrDirect', 'rfSollDirect', 'lambdaPSteps1', 'lambdaPSteps2', 'lambdaState1', 'lambdaState2',
    'o2Precat1Mv', 'o2Precat2Mv', 'baFTi', 'lambdaReadTime', 'lambdaReadMs',
    'injection1Ms', 'injection6Ms', 'injectionReadTime', 'injectionReadMs', 'llsSt'];
const movingReads = await chosenExchanges('moving-response');
const movingFields = new Set(movingReads.flatMap(read => read.provides ?? []));
for (const field of required) assert(movingFields.has(field), `production history Tune must record ${field}`);
assert.equal(movingReads.find(read => read.kind === 'block' && read.selection === 19)?.every ?? 1, 1,
    'history Tune retains injection on every sample');
assert.deepEqual(await chosenExchanges('legacy-nominal'), productionExchanges(LOG_PROFILES.VE.exchanges),
    'legacy production replay keeps its original recording profile');
assert.deepEqual(await chosenExchanges('moving-response', LOG_PROFILES.VE.fallback), LOG_PROFILES.VE.fallback,
    'a source-verification fallback must never silently regain unverified RAM reads');
console.log('PASS actual production START retains all required history signals while legacy retains its narrowed list and verification fallback remains authoritative');
