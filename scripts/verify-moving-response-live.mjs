/** LIVE is an acquisition census; it must never manufacture a writable VE result. */
import assert from 'node:assert/strict';
import path from 'node:path';
import { build } from 'esbuild';
const root = path.resolve(import.meta.dirname, '..');
const bundle = await build({ stdin: { contents: `export * from './src/lib/ve-calculator/movingResponseLive';`,
    resolveDir: root, loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', write: false,
    alias: { '@': path.join(root, 'src') } });
const m = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
let count = 0;
const test = (name, fn) => { fn(); count++; console.log('PASS ' + name); };
const map = { xAxis: [2000, 2500], yAxis: [5, 10], data: [[.5, .8], [.9, 1.1]] };
const calibration = { richMv: 510, leanMv: 400, trimMin: .7, trimMax: 1.3, recordedVe: map,
    baOffPositive: 1.04, baOffNegative: .94,
    gains: { positiveI: 0, negativeI: 0, positiveP: 0, negativeP: 0, tickSec: .01 },
    sensor: { richMv: 510, leanMv: 400, inputMinMv: 0, inputMaxMv: 1113, maxFilterDivisor: 8, tickSec: .01 },
    tiStat: { rpm: [1000, 4000], rf: [0, 1], values: [[1, 1], [1, 1]] } };
const options = { veCorrectionPolicy: 'moving-response', movingCalibration: calibration, egt: {}, steadyCalibrationHold: null,
    steadyLambdaLimits: { wotThreshold: { x: [1000, 4000], y: [0, 120], z: [[100, 100], [100, 100]] },
        loadThreshold: { x: [1000, 4000], y: [100, 100] }, fMin: .7, fMax: 1.3 },
    steadyFilterConfig: { enableCorrection: false, minTemp: 65 }, veLearningRate: 1 };
function row(i, extra = {}) {
    const t = 1 + i * .5;
    return { time: t, rpm: 2100 + i % 9 * 30, rawLoad: 6 + i % 7 * .3,
        stft1: .85, stft2: .85, wdk1: 5, llsSt: 0, coolantTemp: 90, tankVent: 0, ltft1: 1, ltft2: 1,
        vehicleSpeed: 40, exhaustTemp: 600, lambdaState1: 1, lambdaState2: 1,
        lambdaPSteps1: 0, lambdaPSteps2: 0, o2Precat1Mv: 800, o2Precat2Mv: 800, baFTi: 1,
        standardReadTime: t - .4, standardReadMs: 10,
        lambdaReadTime: t - .3, lambdaReadMs: 10, lambdaReadSource: 'ram-response-0401-unverified',
        injectionReadTime: t - .2, injectionReadMs: 10, injectionReadSource: 'block19-0401-unverified',
        injection1Ms: 4.25, injection2Ms: 4.25, injection3Ms: 4.25, injection4Ms: 4.25, injection5Ms: 4.25, injection6Ms: 4.25,
        injectionStft1: .85, injectionStft2: .85, injectionBlankActual: 0, injectionBlankTarget: 0,
        rfSollDirect: .5, rfSollDirectTime: t - .1, rfSollDirectReadMs: 10,
        rfKorrDirect: 1.2, rfKorrDirectTime: t - .05, rfKorrDirectReadMs: 10, rfDirectSource: 'ram-0401-unverified', ...extra };
}
const run = (raw, opt = options) => m.appendMovingLive(m.createMovingLiveAccumulator(map, opt), raw);
const raw = Array.from({ length: 80 }, (_, i) => row(i));

test('incremental RAW acquisition equals batch with one-row and irregular append boundaries', () => {
    const expected = run(raw), one = m.createMovingLiveAccumulator(map, options), chunks = m.createMovingLiveAccumulator(map, options);
    let actual;
    for (let i = 1; i <= raw.length; i++) actual = m.appendMovingLive(one, raw.slice(0, i));
    assert.deepEqual(actual, expected);
    for (const end of [1, 3, 11, 27, 79, 80]) actual = m.appendMovingLive(chunks, raw.slice(0, end));
    assert.deepEqual(actual, expected);
    assert.equal(expected.observedRows, 80); assert.equal(expected.candidateRows, 80);
    assert(expected.cells.flat().every(c => c.state === 'collecting' && c.passes === 1));
});
test('repeated appends do not duplicate rows, visits or previously returned snapshots', () => {
    const acc = m.createMovingLiveAccumulator(map, options), first = m.appendMovingLive(acc, raw.slice(0, 1));
    const snapshot = JSON.stringify(first), second = m.appendMovingLive(acc, raw.slice(0, 10));
    assert.equal(JSON.stringify(first), snapshot); assert.deepEqual(m.appendMovingLive(acc, raw.slice(0, 10)), second);
    assert.equal(acc.consumed, 10);
});
test('warm-up, exclusions, purge, acceleration and learning are recorded without claiming candidates', () => {
    const states = [
        [{ coolantTemp: 50 }, 'warming-up'], [{ tankVent: .1 }, 'purge-active'],
        [{ baFTi: 1.05 }, 'acceleration-active'], [{ ltft2: .99 }, 'adaptation-active'],
        [{ injectionBlankTarget: 6 }, 'fuel-cut'], [{ injection4Ms: 0, injection5Ms: 0, injection6Ms: 0 }, 'fuel-cut'],
    ];
    for (const [extra, reason] of states) {
        const r = run([row(0, extra)]); assert.equal(r.observedRows, 1); assert.equal(r.candidateRows, 0);
        assert(r.cells.flat().every(c => c.recorded === 1 && c.state === 'blocked' && c.reasons[reason] === 1));
    }
    const excluded = run([row(0)], { ...options, steadyFilterConfig: { ...options.steadyFilterConfig, excludeTimeRanges: [[0, 3]] } });
    assert.equal(excluded.candidateRows, 0); assert.equal(excluded.cells[0][0].reasons.excluded, 1);
});
test('missing TI, RF, read timings and physical history channels remain visible', () => {
    for (const [extra, reason] of [[{ injectionReadSource: undefined }, 'injection-missing'],
        [{ rfKorrDirectTime: undefined }, 'read-missing'], [{ standardReadMs: undefined }, 'read-missing'],
        [{ vehicleSpeed: undefined }, 'read-missing'], [{ exhaustTemp: undefined }, 'read-missing']]) {
        const r = run([row(0, extra)]); assert.equal(r.observedRows, 1); assert.equal(r.candidateRows, 0);
        assert.equal(r.cells[0][0].reasons[reason], 1);
    }
});
test('both banks must be active and unclamped; one valid bank oxygen point is retained', () => {
    for (const bank of [1, 2]) {
        const off = run([row(0, { [`lambdaState${bank}`]: 0 })]);
        assert.equal(off.candidateRows, 0); assert.equal(off.cells[0][0].reasons['lambda-off'], 1);
        const clamp = run([row(0, { [`stft${bank}`]: .7 })]);
        assert.equal(clamp.candidateRows, 0); assert.equal(clamp.cells[0][0].reasons['controller-clamp'], 1);
        assert.equal(run([row(0, { [`o2Precat${bank}Mv`]: 450 })]).candidateRows, 1);
    }
});
test('neutral oxygen requires fresh threshold crossings, preserved across append boundaries', () => {
    const neutral = Array.from({ length: 3 }, (_, i) => row(i, { o2Precat1Mv: 450, o2Precat2Mv: 450,
        lambdaPSteps1: i === 0 ? 0 : i === 1 ? 2 : 5 }));
    const all = run(neutral), acc = m.createMovingLiveAccumulator(map, options);
    assert.equal(all.candidateRows, 1); assert.equal(all.cells[0][0].reasons['oxygen-pending'], 2);
    for (let i = 1; i <= neutral.length; i++) assert.deepEqual(m.appendMovingLive(acc, neutral.slice(0, i)), run(neutral.slice(0, i)));
});
test('unsupported previous TI_STAT regions cannot manufacture fresh crossings', () => {
    for (const unsupported of [{ llsSt: 128 }, { wdk1: 110 }, { llsSt: undefined }]) {
        const a = row(0, { ...unsupported, o2Precat1Mv: 450, o2Precat2Mv: 450 });
        const b = row(1, { o2Precat1Mv: 450, o2Precat2Mv: 450, lambdaPSteps1: 3 });
        const r = run([a, b]); assert.equal(r.observedRows, 2); assert.equal(r.candidateRows, 0);
    }
});
test('recording BIN or calibration hold cannot hide observed cells or authorize candidates', () => {
    for (const change of [{ movingCalibration: null }, { steadyCalibrationHold: 'binary-missing' }, { egt: undefined },
        { steadyLambdaLimits: undefined }, { writeRfKorr: true },
        { movingCalibration: { ...calibration, recordedVe: { ...map, data: [[.6, .8], [.9, 1.1]] } } }]) {
        const r = run([row(0)], { ...options, ...change }); assert.equal(r.observedRows, 1); assert.equal(r.candidateRows, 0);
        assert.equal(r.cells[0][0].reasons['calibration-held'], 1);
    }
});
test('load correction follows recording options and ignores stale processed correctedLoad', () => {
    const input = [row(0, { rpm: 2250, rawLoad: 14, correctedLoad: 100 })];
    const r = run(input, { ...options, steadyFilterConfig: { ...options.steadyFilterConfig, enableCorrection: true },
        steadyLoadTable: [{ rpm: 1000, factor: 2 }, { rpm: 4000, factor: 2 }] });
    assert(r.cells.flat().every(c => c.recorded === 1)); assert.equal(r.candidateRows, 1);
    const uncorrected = run(input); assert.equal(uncorrected.cells[0][0].state, 'unvisited');
    assert.equal(input[0].correctedLoad, 100);
});
test('revisits are separated by time away and no steady operating point is required', () => {
    const drive = Array.from({ length: 40 }, (_, i) => row(i,
        { rpm: i < 4 || i >= 36 ? 2000 : 2500, rawLoad: i < 4 || i >= 36 ? 5 : 10 }));
    const r = run(drive); assert.equal(r.candidateRows, drive.length);
    assert.equal(r.cells[0][0].passes, 2); assert.equal(r.cells[0][0].state, 'revisited');
    assert.equal(r.cells[1][1].passes, 1); assert.equal(r.cells[1][1].state, 'collecting');
    const rolling = run(raw); assert.equal(rolling.candidateRows, raw.length);
    assert.equal('acceptedMap' in r, false); assert.equal('newMap' in r, false);
    assert.equal('correctionMap' in r, false);
});
test('shortened RAW and a late timestamp-unit decision reset counts consistently', () => {
    const acc = m.createMovingLiveAccumulator(map, options);
    m.appendMovingLive(acc, raw); assert.deepEqual(m.appendMovingLive(acc, raw.slice(0, 2)), run(raw.slice(0, 2)));
    assert.deepEqual(m.appendMovingLive(acc, []), run([]));
    const millis = raw.slice(0, 10).map(p => ({ ...p, time: p.time * 1000 }));
    const msAcc = m.createMovingLiveAccumulator(map, options);
    m.appendMovingLive(msAcc, millis.slice(0, 1));
    assert.deepEqual(m.appendMovingLive(msAcc, millis), run(millis));
    assert.equal(msAcc.secondsPerTimeUnit, .001);
});
test('non-finite positions are not placed into a plausible corner', () => {
    const r = run([row(0, { rpm: NaN }), row(1, { rawLoad: NaN })]);
    assert.equal(r.observedRows, 0); assert.equal(r.candidateRows, 0);
    assert(r.cells.flat().every(c => c.state === 'unvisited'));
});
test('reason captions are available in Japanese and English', () => {
    assert.equal(m.movingLiveReasonLabel('injection-missing'), '噴射指令の計測が不足');
    assert.equal(m.movingLiveReasonLabel('injection-missing', 'en'), 'Injection command missing');
});
console.log(`${count} moving-response LIVE checks passed`);
