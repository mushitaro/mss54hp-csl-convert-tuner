/** Synthetic crash-recovery records: START settings survive asynchronous persistence and reload. */
import assert from 'node:assert/strict';
import path from 'node:path';
import { build } from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');
const built = await build({
    stdin: { contents: `export * from './src/lib/db/liveRunRepository';
        export { useLiveRun } from './src/hooks/useLiveRun';
        export { DEFAULT_FILTER_CONFIG } from './src/lib/log-engine/filterDefaults';`,
    resolveDir: root, loader: 'ts' },
    bundle: true, platform: 'node', format: 'esm', write: false, alias: { '@': path.join(root, 'src') },
    plugins: [{ name: 'hook-store', setup(b) {
        b.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'fixture' }));
        b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `
            export function useRef(value) { return { current: value }; }
            export function useCallback(fn) { return fn; }
            export function useSyncExternalStore() {}`, loader: 'js' }));
    } }],
});

// Minimal asynchronous IndexedDB fixture. Values clone on put/get, transactions finish after all
// queued requests, and compound chunk keys respect the range used by the production repository.
const stores = new Map();
globalThis.IDBKeyRange = { bound: (lower, upper) => ({ lower, upper }) };
const inRange = (key, range) => !range || (key[0] === range.lower[0]
    && key[1] >= range.lower[1] && key[1] <= range.upper[1]);
globalThis.indexedDB = { open(name, version) {
    assert.equal(name, 'mss54hp-tuner-live'); assert.equal(version, 1);
    const opening = {};
    setTimeout(() => {
        const fresh = stores.size === 0;
        opening.result = {
            objectStoreNames: { contains: name => stores.has(name) },
            createObjectStore(name, { keyPath }) { stores.set(name, { keyPath, records: new Map() }); },
            close() {},
            transaction() {
                const tx = { pending: 0, timer: null, objectStore(name) {
                    const store = stores.get(name);
                    const request = work => {
                        const req = {};
                        tx.pending++;
                        clearTimeout(tx.timer);
                        queueMicrotask(() => {
                            try { req.result = structuredClone(work()); req.onsuccess?.(); }
                            catch (error) { req.error = error; req.onerror?.(); tx.error = error; tx.onerror?.(); }
                            tx.pending--;
                            tx.timer = setTimeout(() => { if (!tx.pending) tx.oncomplete?.(); }, 0);
                        });
                        return req;
                    };
                    return {
                        clear: () => request(() => store.records.clear()),
                        put(value) {
                            const clone = structuredClone(value);
                            const key = Array.isArray(store.keyPath)
                                ? store.keyPath.map(part => clone[part]) : clone[store.keyPath];
                            return request(() => { store.records.set(JSON.stringify(key), clone); return key; });
                        },
                        get: key => request(() => store.records.get(JSON.stringify(key))),
                        getAll: range => request(() => [...store.records.entries()]
                            .filter(([key]) => inRange(JSON.parse(key), range)).map(([, value]) => value)),
                    };
                }, abort() { tx.onabort?.(); } };
                return tx;
            },
        };
        if (fresh) opening.onupgradeneeded?.();
        opening.onsuccess?.();
    }, 0);
    return opening;
} };

const m = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'));
const snapshot = () => ({
    filterConfig: { ...structuredClone(m.DEFAULT_FILTER_CONFIG), veCorrectionPolicy: 'moving-response',
        excludeTimeRanges: [{ start: 2, end: 4 }] },
    interpolationTable: [{ rpm: 2000, factor: 1.03 }, { rpm: 3000, factor: 1.08 }],
});
const point = { time: 1, rpm: 2400, rawLoad: 7.5 };
const settings = snapshot(), expected = structuredClone(settings);
const opening = m.beginLiveRun({ sessionId: 'synthetic', mock: true, calculationSnapshot: settings });
// This mutation happens before IndexedDB's asynchronous open completes.
settings.filterConfig.veCorrectionPolicy = 'legacy';
settings.filterConfig.excludeTimeRanges[0].end = 99;
settings.interpolationTable[0].factor = 9;
const id = await opening;
await m.appendLiveChunk(id, 0, [point]);
await m.appendLiveChunk(id, 1, [{ ...point, time: 2 }]);
await m.endLiveRun(id);
const record = await m.findRecoverableRun();
assert.deepEqual(record.calculationSnapshot, expected);
assert.equal(record.pointCount, 2); assert.equal(typeof record.endedAt, 'number');
assert.deepEqual(await m.loadLiveRunPoints(id), [point, { ...point, time: 2 }]);
record.calculationSnapshot.interpolationTable[0].factor = 77;
assert.deepEqual((await m.findRecoverableRun()).calculationSnapshot, expected);
console.log('PASS START snapshots clone before async open; append, STOP and reread preserve independent filter/table values');

const oldId = await m.beginLiveRun({ sessionId: 'old-synthetic', mock: true });
await m.appendLiveChunk(oldId, 0, [point]);
const legacy = await m.findRecoverableRun();
assert.equal(legacy.calculationSnapshot, undefined);
assert.equal(legacy.sessionId, 'old-synthetic');
assert.deepEqual(await m.loadLiveRunPoints(oldId), [point]);
console.log('PASS records without snapshots still recover RAW and leave settings fallback explicit to the caller');

const hook = m.useLiveRun({ flush() {} });
const hookedSettings = snapshot(), hookedExpected = structuredClone(hookedSettings);
hook.start({ sessionId: 'hook-synthetic', mock: true, exchanges: [], calculationSnapshot: hookedSettings });
hookedSettings.filterConfig.veCorrectionPolicy = 'dme-response';
hookedSettings.interpolationTable[0].factor = 55;
for (let n = 0; !hook.runIdRef.current && n < 100; n++) await new Promise(resolve => setTimeout(resolve, 1));
assert.ok(hook.runIdRef.current);
await m.appendLiveChunk(hook.runIdRef.current, 0, [point]);
assert.deepEqual((await m.findRecoverableRun()).calculationSnapshot, hookedExpected);
console.log('PASS the production useLiveRun START forwards the calculation snapshot to durable recovery');
