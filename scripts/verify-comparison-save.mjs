/** Verify the real page handler's log-only branch, not a second implementation of its dispatch.
 * The TypeScript parser extracts handleSaveSession and transpiles it unchanged; dependencies are
 * recording fakes, so any attempt to produce a BIN fails this test. Storage metadata uses the
 * same pure function saveResearchRun calls before its IndexedDB put. Public synthetic data only. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { researchSessionUpdate } from '../src/lib/db/sessionRepository.ts';
import { sessionFingerprint, needsSync, gzipJson, gunzipJson } from '../src/lib/session-sync/client.ts';

const source = fs.readFileSync(new URL('../src/app/page.tsx', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('page.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let initializer, newSessionInitializer, saveInputsInitializer;
function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(parsed) === 'handleSaveSession') initializer = node.initializer;
    if (ts.isVariableDeclaration(node) && node.name.getText(parsed) === 'handleNewSession') newSessionInitializer = node.initializer;
    if (ts.isVariableDeclaration(node) && node.name.getText(parsed) === 'saveInputs') saveInputsInitializer = node.initializer;
    ts.forEachChild(node, visit);
}
visit(parsed);
assert.ok(initializer && ts.isArrowFunction(initializer), 'the real SAVE handler must be located');
const compiled = ts.transpileModule(`const handleSaveSession = ${initializer.getText(parsed)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

const raw = [{ time: 0, rpm: 2400, rawLoad: 7.5, stft1: 0.94, stft2: 0.95,
    rfKorrDirect: 1.2, rfKorrDirectTime: 0.01, rfDirectSource: 'ram-0401-unverified' }];
const settings = {
    filterConfig: { veCorrectionPolicy: 'steady-retain', veLearningRate: 0.5 },
    interpolationTable: [{ rpm: 2400, factor: 0.95 }], applyPatch: false, applyWotDisable: true,
    writeWarmup: true, writeVe: true, writeRfKorr: true,
    calibrationEdits: [{ paramId: 'pending-manual-edit', raw: [1] }],
};
const draft = {
    id: 'draft', seq: 1, label: 'Session #1', createdAt: 1, status: 'draft',
    baseOrigin: { kind: 'upload', fileName: 'synthetic.bin' }, baseSha256: 'base-sha',
    hasLog: true, logPointCount: raw.length, flashHistory: [], syncedAt: 10,
};
const candidate = { xAxis: [], yAxis: [], data: [], calibrationStatus: 'comparison-only' };
const ordinary = { xAxis: [], yAxis: [], data: [] };
let passed = 0;
const check = async (name, test) => { await test(); passed++; console.log(`PASS ${name}`); };

function harness({ target = draft, map = candidate, policy = 'steady-retain', log = raw,
    edited = false, failSave = false } = {}) {
    const calls = [], base = new Uint8Array([1, 2, 3, 4]).buffer;
    const newDraft = { ...draft, id: 'comparison-draft', baseOrigin: null, baseSha256: undefined, hasLog: false, logPointCount: 0 };
    const dependencies = {
        filterConfig: { ...settings.filterConfig, veCorrectionPolicy: policy }, newMap: map,
        currentSession: target,
        logFileState: { rawLogData: log }, ensureDraft: async () => { throw new Error('comparison SAVE must not reset the workspace through ensureDraft'); },
        sessionDb: {
            loadBinaries: async id => { calls.push(['loadBinaries', id]); return { baseBinaryBuffer: base }; },
            newDraft: async () => { calls.push(['newDraft']); return newDraft; },
            setBase: async input => { calls.push(['setBase', input]); return { ...newDraft, ...input, id: input.sessionId }; },
            saveResearch: async input => {
                calls.push(['saveResearch', input]);
                if (failSave) throw new Error('synthetic save failure');
            },
            saveSessionTune: () => { throw new Error('comparison must not call saveSessionTune'); },
        },
        binaryFileState: { buildPatchedBuffer: () => { throw new Error('comparison must not build a BIN'); } },
        binaryBuffer: base, calEdits: { armedEdits: edited ? settings.calibrationEdits : [] },
        writeExtras: { comparisonOnly: true }, logProcess: 'VE',
        buildSettings: () => structuredClone(settings), saveInputs: { sessionId: target.id, map },
        setSavedInputs: input => calls.push(['saved', input]),
        setActiveSessionId: id => calls.push(['active', id]),
        discardLiveRun: async () => { calls.push(['discardRecovery']); },
        liveRun: { runIdRef: { current: 'recoverable-run' } },
    };
    const invoke = new Function(...Object.keys(dependencies), `${compiled}\nreturn handleSaveSession;`)(...Object.values(dependencies));
    return { invoke, calls, dependencies, base };
}

await check('comparison SAVE stores raw and settings whether a candidate or manual edits exist', async () => {
    for (const map of [candidate, null]) for (const edited of [false, true]) {
        const h = harness({ map, edited }); await h.invoke();
        const save = h.calls.find(c => c[0] === 'saveResearch')?.[1];
        assert.ok(save); assert.equal(save.log, raw); assert.equal(save.sessionId, 'draft');
        assert.equal(save.tuneSettings.filterConfig.veCorrectionPolicy, 'steady-retain');
        assert.equal(save.tuneSettings.writeVe, false);
        assert.equal(save.tuneSettings.writeRfKorr, false);
        assert.equal(save.tuneSettings.writeWarmup, false);
        assert.deepEqual(save.tuneSettings.calibrationEdits, settings.calibrationEdits);
        assert.equal(h.dependencies.liveRun.runIdRef.current, null);
        assert.ok(h.calls.findIndex(c => c[0] === 'saveResearch') < h.calls.findIndex(c => c[0] === 'discardRecovery'));
    }
});

await check('a tagged candidate still saves observations after a UI policy change', async () => {
    const h = harness({ policy: 'legacy-nominal' }); await h.invoke();
    assert.equal(h.calls.find(c => c[0] === 'saveResearch')[1].tuneSettings.filterConfig.veCorrectionPolicy, 'steady-retain');
});

await check('a stale untagged map during comparison-mode recomputation cannot route SAVE to BIN', async () => {
    const h = harness({ map: ordinary }); await h.invoke();
    assert.ok(h.calls.some(c => c[0] === 'saveResearch'));
});

await check('existing TUNED history gets a separate draft with the exact stored BASE', async () => {
    const existing = { ...draft, sha256: 'old-tuned-sha', tuneSettings: { original: true } };
    const before = structuredClone(existing), h = harness({ target: existing }); await h.invoke();
    const base = h.calls.find(c => c[0] === 'setBase')[1];
    assert.equal(base.baseBinaryBuffer, h.base);
    assert.deepEqual(base.baseOrigin, { kind: 'session', sessionId: 'draft', which: 'base' });
    assert.equal(h.calls.find(c => c[0] === 'saveResearch')[1].sessionId, 'comparison-draft');
    assert.equal(h.calls.find(c => c[0] === 'active')[1], 'comparison-draft');
    assert.deepEqual(existing, before);
});

await check('an archived session branches directly without generic draft cleanup or workspace reset', async () => {
    for (const sha256 of [undefined, 'old-tuned-sha']) {
        const h = harness({ target: { ...draft, status: 'archived', sha256 } }); await h.invoke();
        assert.equal(h.calls.filter(c => c[0] === 'newDraft').length, 1);
        assert.equal(h.calls.find(c => c[0] === 'setBase')[1].baseBinaryBuffer, h.base);
        assert.equal(h.calls.find(c => c[0] === 'saveResearch')[1].sessionId, 'comparison-draft');
    }
});

await check('unknown BASE origin remains unknown without preventing observation storage', async () => {
    const h = harness({ target: { ...draft, sha256: 'old-tuned-sha', baseOrigin: null } }); await h.invoke();
    assert.ok(!h.calls.some(c => c[0] === 'setBase'));
    assert.ok(h.calls.some(c => c[0] === 'saveResearch'));
    const incomplete = harness({ target: { ...draft, baseOrigin: null } }); await incomplete.invoke();
    assert.equal(incomplete.calls.find(c => c[0] === 'saveResearch')[1].sessionId, 'draft');
});

await check('a failed save leaves the recovery copy intact and never claims SAVED', async () => {
    const h = harness({ failSave: true }); await assert.rejects(h.invoke(), /synthetic save failure/);
    assert.equal(h.dependencies.liveRun.runIdRef.current, 'recoverable-run');
    assert.ok(!h.calls.some(c => ['discardRecovery', 'saved'].includes(c[0])));
    const empty = harness({ log: [] }); await empty.invoke();
    assert.deepEqual(empty.calls, []);
});

await check('metadata keeps BASE provenance, does not manufacture a TUNED, and marks equal-size logs dirty', () => {
    const synced = { ...draft, syncedFingerprint: sessionFingerprint(draft) };
    assert.equal(needsSync(synced), false);
    const before = structuredClone(synced);
    const updated = researchSessionUpdate(synced, { process: 'VE', log: raw, tuneSettings: settings });
    assert.equal(updated.sha256, undefined);
    assert.equal(updated.baseOrigin, synced.baseOrigin); assert.equal(updated.baseSha256, synced.baseSha256);
    assert.equal(updated.syncedAt, synced.syncedAt); assert.equal(updated.syncedFingerprint, undefined);
    assert.equal(needsSync(updated), true); assert.equal(updated.tuneSettings, settings);
    assert.deepEqual(synced, before);
    assert.equal(researchSessionUpdate({ ...draft, baseOrigin: null }, { process: 'VE', log: raw }).baseOrigin, null);
    assert.throws(() => researchSessionUpdate({ ...draft, sha256: 'tuned' }, {
        process: 'VE', log: raw, tuneSettings: settings,
    }), /new draft/);
});

await check('old research callers remain compatible and D1 codecs retain raw channels/settings', async () => {
    const old = { ...draft, tuneSettings: { old: true } };
    assert.deepEqual(researchSessionUpdate(old, { process: 'VE', log: raw }).tuneSettings, old.tuneSettings);
    const metadata = researchSessionUpdate(draft, { process: 'VE', log: raw, tuneSettings: settings });
    const wire = { session: metadata, log: { sessionId: metadata.id, data: raw } };
    assert.deepEqual(await gunzipJson(await gzipJson(wire)), JSON.parse(JSON.stringify(wire)));
});

await check('NEW deletes only empty drafts and preserves BASE-unknown recorded data', async () => {
    assert.ok(newSessionInitializer);
    const code = ts.transpileModule(`const handleNewSession = ${newSessionInitializer.getText(parsed)};`, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
    }).outputText;
    const erased = [], sessions = [
        { id: 'empty', status: 'draft', baseOrigin: null, hasLog: false, logPointCount: 0 },
        { id: 'has-log', status: 'draft', baseOrigin: null, hasLog: true, logPointCount: 0 },
        { id: 'has-points', status: 'draft', baseOrigin: null, hasLog: false, logPointCount: 2 },
        { id: 'has-tuned', status: 'draft', baseOrigin: null, hasLog: false, logPointCount: 0, sha256: 'tuned' },
        { ...draft, id: 'has-base' },
    ];
    const deps = {
        sessionDb: { sessions, remove: async id => erased.push(id), newDraft: async () => ({ id: 'new' }) },
        setActiveSessionId: () => {}, resetDerived: () => {}, goToTab: () => {},
    };
    const invoke = new Function(...Object.keys(deps), `${code}\nreturn handleNewSession;`)(...Object.values(deps));
    await invoke(); assert.deepEqual(erased, ['empty']);
});

await check('SAVE dirtiness includes raw identity and analysis settings when no map exists', () => {
    assert.ok(saveInputsInitializer && ts.isObjectLiteralExpression(saveInputsInitializer));
    const properties = new Map(saveInputsInitializer.properties.map(p => [p.name?.getText(parsed), p.getText(parsed)]));
    assert.match(properties.get('rawLog'), /logFileState\.rawLogData/);
    assert.ok(properties.has('filterConfig'));
    assert.ok(properties.has('interpolationTable'));
});

console.log(`\n${passed} comparison observation-save checks passed.`);
