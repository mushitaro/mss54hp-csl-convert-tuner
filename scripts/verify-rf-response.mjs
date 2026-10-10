/** Synthetic wire + real poll/preflight + response analysis + CSV/SYNC round trip.
 * No private road data, DME writes or deployment. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');
const bundle = await build({ stdin: { contents: `
export * from './src/lib/dme-link/ramMap';
export * from './src/lib/dme-link/responseCapture';
export * from './src/lib/log-engine/logProfile';
export * from './src/lib/log-engine/parser';
export * from './src/lib/log-engine/serializer';
export * from './src/lib/ve-calculator/rfResponseEvidence';
export { WebSerialDmeLink } from './src/lib/dme-link/webSerialDmeLink';
export { asLogRecord, gzipJson, gunzipJson } from './src/lib/session-sync/client';`,
    resolveDir: root, loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', write: false,
    alias: { '@': path.join(root, 'src') } });
const m = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log(`PASS ${name}`); };
const close = (a, b) => assert(Math.abs(a - b) < 1e-8, `${a} != ${b}`);
const word = v => Uint8Array.of(v >> 8 & 255, v & 255);
const wide = m.LAMBDA_RESPONSE_RAM_READ;
const bytes = new Uint8Array(32);
bytes.set(word(800), 0); bytes.set(word(100), 2);
bytes[8] = 1; bytes[9] = 0x81;
bytes.set(word(32768), 12); bytes.set(word(30000), 14);
bytes.set(word(32768), 16); bytes.set(word(32768), 18);
bytes[24] = 255; bytes[25] = 0; bytes.set(word(1088), 30);
const decoded = m.decodeLambdaResponse(bytes, 1, 0xff80be, 1100, 1180, 1000);

await check('addresses match the primary 0401 RAM graph and neutral factor encoding', () => {
    const graph = JSON.parse(fs.readFileSync(path.join(root, 'public/data/calibration-graph.json')));
    for (const name of ['USV1', 'USV2', 'LA_ST_EIN1', 'LA_ST_EIN2', 'LA_P_SPR_COUNT1', 'LA_P_SPR_COUNT2', 'BA_F_TI']) {
        const primary = graph.nodes.find(n => n.bank === 'master' && n.t === 'ram' && n.name === name);
        assert.equal(m.Mss54HpRamSignals[name].address, primary?.addr);
        const s = m.Mss54HpRamSignals[name];
        assert(s.segment === wide.segment && s.address >= wide.address && s.address + s.size <= wide.address + wide.count);
    }
    for (const [name, address] of [['K_LAS_R_FETT', 0x4820], ['K_LAS_R_MAGER', 0x4822]]) {
        assert.equal(graph.nodes.find(n => n.name === name)?.addr, address);
    }
    const decompPath = path.join(root, 'public/data/calibration-decomp.json');
    if (fs.existsSync(decompPath)) {
        const d = JSON.parse(fs.readFileSync(decompPath)).texts;
        assert.match(d['f:slave:017252'], /BA_F_TI = 0x400/);
        assert.match(d['f:slave:01d6a2'], /LA_ST_EIN1 & 1/);
        assert.match(d['f:slave:01d6a2'], /USV1 < K_LAS_R_FETT/);
        assert.match(d['f:slave:01d6a2'], /LA_P_SPR_COUNT1 = -1/);
    }
});
await check('one 32-byte decode retains two banks, state bits, zero and saturated counters', () => {
    assert.deepEqual(decoded, { o2Precat1Mv: 800, o2Precat2Mv: 100,
        lambdaState1: 1, lambdaState2: 129, lambdaPSteps1: 255, lambdaPSteps2: 0,
        baFTi: 1.0625, lambdaReadTime: .14, lambdaReadMs: 80, lambdaReadSource: 'ram-response-0401-unverified' });
    for (const b of [bytes.slice(0, 31), bytes.slice(0, 20), new Uint8Array()]) {
        assert.deepEqual(m.decodeLambdaResponse(b, 1, wide.address, 1100, 1180, 1000), {});
    }
    assert.deepEqual(m.decodeLambdaResponse(bytes, 4, wide.address, 1100, 1180, 1000), {});
    assert.deepEqual(m.decodeLambdaResponse(bytes, 1, wide.address, 1180, 1100, 1000), {});
    assert.deepEqual(m.decodeLambdaResponse(bytes, 1, wide.address, NaN, 1180, 1000), {});
});
await check('WORKS adds 24 bytes without another exchange; production retains its eight-byte read', () => {
    const works = m.LOG_PROFILES.VE.exchanges;
    const extended = works.find(x => x.address === wide.address);
    assert.equal(extended.count, 32);
    const production = m.productionExchanges(works);
    assert(!production.some(x => x.address === wide.address));
    const trim = production.find(x => x.address === 0xff80ca);
    assert.equal(trim.count, 8);
    assert.deepEqual(trim.provides, ['stft1', 'stft2', 'ltft1', 'ltft2']);
    close(m.exchangeMs(extended) - m.exchangeMs({ ...extended, count: 8 }), 27.5);
    assert(m.expectedHz(production) > 4.5 && m.expectedHz(production) < 4.6);
});

const link = new m.WebSerialDmeLink({ transport: {} });
link.connected = true;
link.withGate = fn => fn();
link.readLambdaTrimFromBlock19 = async () => 1;
let rejectWide = false;
const observedReads = [];
link.readMemoryChunk = async (segment, address, count) => {
    observedReads.push({ segment, address, count });
    if (rejectWide) return bytes.slice(0, 31);
    return bytes;
};
await check('preflight checks the actual wide request, and a short response selects the block fallback', async () => {
    let result = await link.verifyLambdaTrimSource(m.LOG_PROFILES.VE);
    assert.equal(result.proven, true);
    assert(observedReads.every(r => r.address === 0xff80be && r.count === 32));
    rejectWide = true;
    result = await link.verifyLambdaTrimSource(m.LOG_PROFILES.VE);
    assert.equal(result.proven, false);
    assert.deepEqual(result.exchanges, m.LOG_PROFILES.VE.fallback);
});

const standard = new Uint8Array(35);
standard.set(word(2400)); standard.set(word(900), 8); standard.set(word(2621), 20);
link.pollStandardBlock = async () => standard;
link.setLiveExchanges([{ kind: 'block', selection: 3 }, { kind: 'ram', name: 'response', ...wide }]);
let failure = false, resyncs = 0;
link.pollRamChunk = async () => { if (failure) throw new Error('synthetic link error'); return bytes; };
link.resyncTransport = async () => { resyncs++; };
await check('real poll captures read windows, isolates a failure and recovers without stale values', async () => {
    const first = await link.pollLiveMeasurementInner();
    assert.equal(first.stft1, 1); assert.equal(first.stft2, 30000 / 32768);
    assert.equal(first.o2Precat1Mv, 800); assert.equal(first.ltft1, 1);
    assert(first.standardReadTime <= first.lambdaReadTime && first.lambdaReadTime <= first.time);
    assert(!('o2Precat1Mv' in link.lastSlowLane));
    failure = true;
    const second = await link.pollLiveMeasurementInner();
    assert.equal(second.rpm, 2400); assert.equal(second.o2Precat1Mv, undefined);
    assert.equal(second.lambdaReadTime, undefined); assert.equal(second.lambdaReadSource, undefined);
    assert.equal(second.stft1, undefined); assert.equal(resyncs, 1);
    failure = false;
    assert.equal((await link.pollLiveMeasurementInner()).o2Precat1Mv, 800);
    link.pollRamChunk = async () => bytes.slice(0, 31);
    assert.equal((await link.pollLiveMeasurementInner()).stft1, undefined, 'short wide read must not license even its trim prefix');
});
await check('block fallback timestamps only its actual STFT read and cannot invent response channels', async () => {
    link.setLiveExchanges(m.LOG_PROFILES.VE.fallback);
    const op = new Uint8Array(90); op.set(word(32768), 40); op.set(word(32768), 42);
    link.exchange = async () => ({ payload: op, controlOrStatus: 0xa0 });
    const p = await link.pollLiveMeasurementInner();
    assert.equal(p.lambdaReadSource, 'block19'); assert.equal(p.stft1, 1);
    assert.equal(p.o2Precat1Mv, undefined); assert.equal(p.lambdaState1, undefined);
});

const calibration = { richMv: 510, leanMv: 400, trimMin: 22938 / 32768, trimMax: 42598 / 32768 };
const point = (t, overrides = {}) => ({ time: t, rpm: 2400, rawLoad: 8, rf: 90,
    stft1: .9, stft2: .91, ltft1: 1, ltft2: 1,
    ...decoded, baFTi: 1, o2Precat1Mv: 800, o2Precat2Mv: 100,
    standardReadTime: t - .2, standardReadMs: 60, lambdaReadTime: t - .1, lambdaReadMs: 80,
    rfKorrDirect: 1, rfKorrDirectTime: t - .04, rfKorrDirectReadMs: 30,
    rfDirectSource: 'ram-0401-unverified', ...overrides });
const trace = [point(1), point(1.4, { o2Precat1Mv: 450, o2Precat2Mv: 450, rfKorrDirect: 1.16 }),
    point(1.8, { o2Precat1Mv: 100, o2Precat2Mv: 800, stft1: .88 }),
    point(2.2, { rawLoad: 11, rfKorrDirect: 1 })];
await check('ordinary short passes count, with O2 hysteresis and conservative transition windows', () => {
    const untouched = structuredClone(trace);
    const report = m.summarizeRfResponse(trace, { calibration });
    assert.deepEqual(trace, untouched);
    assert.equal(report.coverage.completeRows, 4);
    assert.equal(report.passes.length, 1); assert.equal(report.passes[0].points, 3);
    close(report.passes[0].endSec - report.passes[0].startSec, .8);
    assert.deepEqual(report.passes[0].observedReversals, [1, 1]);
    assert.equal(report.banks[0].reversals, 2);
    assert.equal(report.events.filter(e => e.kind === 'rf-departed-unity').length, 1);
    const event = report.events.find(e => e.kind === 'rf-departed-unity');
    close(event.windowSec[0], .945); close(event.windowSec[1], 1.375);
    close(report.maxCaptureSpanMs, 205);
    assert.equal(report.observationOnly, true); assert.equal('map' in report, false);
});
await check('disabled control, missing data, reversed time, gaps and stale read times break response history', () => {
    const changes = [{ lambdaState1: 0 }, { o2Precat1Mv: undefined }, { lambdaReadSource: 'block19' },
        { lambdaReadTime: undefined }, { lambdaReadTime: .2 }, { lambdaReadTime: 30 },
        { lambdaReadMs: -1 }, { lambdaState1: 1.1 }];
    for (const change of changes) {
        const r = m.summarizeRfResponse([point(1), point(1.4, change), point(1.8, { o2Precat1Mv: 100 })], { calibration });
        assert.equal(r.banks[0].reversals, 0, JSON.stringify(change));
    }
    for (const t of [.5, 1, 5]) {
        assert.equal(m.summarizeRfResponse([point(1), point(t, { o2Precat1Mv: 100 })], { calibration }).banks[0].reversals, 0);
    }
    const noCalibration = m.summarizeRfResponse(trace, { calibration: null });
    assert.equal(noCalibration.coverage.completeRows, 4);
    assert.equal(noCalibration.banks[0].reversals, 0);
    assert.equal(noCalibration.banks[0].unclassified, 4);
});
await check('both banks keep their own enable and limit status; P-step saturation is not an O2 event', () => {
    const r = m.summarizeRfResponse([point(1), point(1.4, { lambdaState1: 0, o2Precat1Mv: 100,
        o2Precat2Mv: 800, stft2: calibration.trimMin, baFTi: 1.0625 })], { calibration });
    assert.equal(r.banks[0].off, 1); assert.equal(r.banks[0].reversals, 0);
    assert.equal(r.banks[1].reversals, 1); assert.equal(r.banks[1].nearClamp, 1);
    assert.equal(r.coverage.activeBoth, 1); assert.equal(r.coverage.baChanged, 1);
});
await check('old logs remain explicitly unmeasured, and missing load correction is not fabricated', () => {
    const old = trace.map(({ time, rpm, rawLoad, stft1, stft2, rf }) => ({ time, rpm, rawLoad, stft1, stft2, rf }));
    const r = m.summarizeRfResponse(old, { calibration });
    assert.equal(r.coverage.completeRows, 0); assert.equal(r.coverage.wideReads, 0);
    assert.equal(r.events.length, 0);
    assert.equal(m.summarizeRfResponse(trace, { calibration, correctLoad: true }).passes.length, 0);
    assert.equal(m.summarizeRfResponse(trace, { calibration, correctLoad: true, loadTable: [{ rpm: 2400, factor: 2 }] }).passes.length, 0);
});
await check('CSV and gzip/SYNC/restore retain numbers, native units, sources and genuine gaps', async () => {
    const raw = [point(1, { o2Precat1Mv: 0, lambdaState1: 0, lambdaPSteps2: 0,
        rfSollDirect: .8, rfSollDirectTime: .99, rfSollDirectReadMs: 10, rfMapIntegratorDirect: -.02 }),
        { time: 2, rpm: 2000, rawLoad: 7, stft1: 1, rf: 80 }];
    const csv = m.serializeLogFile(raw);
    const restored = m.parseLogFile(csv);
    for (const [key, value] of Object.entries(raw[0])) assert.equal(restored[0][key], value, key);
    for (const key of ['o2Precat1Mv', 'lambdaState1', 'lambdaReadTime', 'lambdaReadSource', 'rfKorrDirect']) assert.equal(restored[1][key], undefined);
    assert.equal(m.parseLogFile(csv.replace('ram-response-0401-unverified', 'invented-source'))[0].lambdaReadSource, undefined);
    const record = { sessionId: 'synthetic', data: raw };
    const wire = await m.gunzipJson(await m.gzipJson(record));
    assert.deepEqual(m.asLogRecord(wire, 'synthetic').data, raw);
    assert.deepEqual(m.asLogRecord(raw, 'synthetic').data, raw);
    assert.equal(m.readResponseCalibration(null), null);
    assert.equal(m.readResponseCalibration(new ArrayBuffer(0)), null);
});
console.log(`${passed} RF response checks passed. No Tune writer is used.`);
