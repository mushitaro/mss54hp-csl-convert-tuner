/** Public synthetic checks for the opt-in operating-condition policy. No private road log or BIN.
 * Run: node --experimental-strip-types --import ./scripts/ts-resolve.mjs scripts/verify-steady-evidence.mjs
 * The forward fuel model below is independent of the correction implementation: it checks the
 * resulting controller demand, not just that an expected expression was copied into the code. */
import assert from 'node:assert/strict';
import {
    annotateSteadyEvidence, deriveOperatingCorrection, STEADY_EVIDENCE_DEFAULTS,
} from '../src/lib/ve-calculator/steadyEvidence.ts';

let passed = 0;
const check = (name, test) => { test(); passed++; console.log(`PASS ${name}`); };
const close = (a, b, eps = 1e-10) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);
const limits = {
    fMin: 0.7, fMax: 1.3,
    wotThreshold: { x: [1000, 6000], y: [60, 100], z: [[102.3, 102.3], [102.3, 102.3]] },
    loadThreshold: { x: [1000, 6000], y: [1.5, 1.5] },
};
const options = { lambdaLimits: limits };
const point = (time, overrides = {}) => ({
    time, rpm: 2400, rawLoad: 7.5, correctedLoad: 7.5, rf: 75,
    stft1: 1, stft2: 1, ltft1: 1, ltft2: 1, coolantTemp: 85, exhaustTemp: 400,
    wdk1: 23, tankVent: 0, vehicleSpeed: 55, rfKorrGateOpen: false,
    ...overrides,
});
const trace = (seconds = 12, dt = 0.25, override = () => ({})) =>
    Array.from({ length: Math.round(seconds / dt) + 1 }, (_, i) => point(i * dt, override(i * dt, i)));
const run = (raw, extra = {}) => annotateSteadyEvidence(raw, { ...options, ...extra });
const last = (raw, extra) => run(raw, extra).at(-1);

check('a full five seconds of complete stationary evidence is required', () => {
    const annotated = run(trace());
    assert.ok(annotated.slice(0, 20).every(p => !p.veEvidenceEligible));
    assert.equal(annotated[20].veEvidenceEligible, true);
    assert.equal(annotated[20].veSteadySeconds, 5);
    assert.ok(annotated.slice(20).every(p => p.veEvidenceEligible));
    assert.equal(last(trace(5, 1)).veEvidenceReason, 'thin-window');
});

check('the policy accepts stable non-neutral error, not only samples close to one', () => {
    for (const trim of [0.8, 0.94, 1, 1.18]) {
        const result = last(trace(6, 0.25, () => ({ stft1: trim, stft2: trim })));
        assert.equal(result.veEvidenceEligible, true, `${trim}: ${result.veEvidenceReason}`);
    }
});

check('bounded two-bank lambda dither is accepted while a continuing trend is refused', () => {
    const dither = trace(12, 0.25, t => ({
        stft1: 0.96 + 0.03 * Math.sin(2 * Math.PI * t),
        stft2: 0.95 - 0.03 * Math.sin(2 * Math.PI * t),
    }));
    assert.equal(last(dither).veEvidenceEligible, true);
    // Total range remains below 0.12: only the trend test can reject this five-second ramp.
    const moving = trace(5, 0.25, t => ({ stft1: 0.9 + 0.02 * t, stft2: 0.9 + 0.02 * t }));
    assert.equal(last(moving).veEvidenceReason, 'trim-moving');
    // Averaging the banks first would hide these opposite drifts.
    const opposite = trace(5, 0.25, t => ({ stft1: 0.9 + 0.02 * t, stft2: 1.1 - 0.02 * t }));
    assert.equal(last(opposite).veEvidenceReason, 'trim-moving');
});

check('rpm, corrected RO, RF, and learned-store excursions each invalidate the history', () => {
    for (const [field, value, reason] of [
        ['rpm', 2700, 'rpm-moving'], ['correctedLoad', 9, 'load-moving'],
        ['rf', 82, 'rf-moving'], ['ltft1', 1.01, 'ltft-moving'],
    ]) {
        const raw = trace(13, 0.25, t => t === 7 ? { [field]: value } : {});
        const result = run(raw);
        assert.equal(result[28].veEvidenceReason, reason);
        assert.ok(result.filter(p => p.time >= 7 && p.time < 12.25).every(p => !p.veEvidenceEligible));
        assert.equal(result.at(-1).veEvidenceEligible, true);
    }
});

check('missing or non-finite channels are not evidence and cannot be bridged by filtering', () => {
    for (const [field, value, reason] of [
        ['stft1', undefined, 'trim-unknown'], ['stft2', NaN, 'trim-unknown'],
        ['ltft1', undefined, 'ltft-unknown'], ['ltft2', Infinity, 'ltft-unknown'],
        ['rf', undefined, 'operating-point-unknown'], ['correctedLoad', NaN, 'operating-point-unknown'],
        ['tankVent', undefined, 'purge-unknown'], ['tankVent', 12, 'purge-active'],
        ['wdk1', undefined, 'lambda-state-unknown'], ['coolantTemp', undefined, 'lambda-state-unknown'],
        ['exhaustTemp', undefined, 'lambda-state-unknown'],
        ['vehicleSpeed', undefined, 'correction-state-unknown'],
        ['rfKorrGateOpen', undefined, 'correction-state-unknown'],
    ]) {
        const raw = trace(13, 0.25, t => t === 7 ? { [field]: value } : {});
        const result = run(raw);
        assert.equal(result[28].veEvidenceReason, reason, field);
        assert.ok(result.filter(p => p.time >= 7 && p.time < 12.25).every(p => !p.veEvidenceEligible), field);
        assert.equal(result.at(-1).veEvidenceEligible, true, field);
    }
});

check('controller clamp proximity is refused independently of legacy settle settings', () => {
    for (const stft of [0.7, 0.715, 0.72, 1.28, 1.3]) {
        assert.equal(last(trace(6, 0.25, () => ({ stft1: stft }))).veEvidenceReason, 'controller-clamp');
    }
    assert.equal(last(trace(), { lambdaLimits: undefined }).veEvidenceReason, 'controller-limits-unknown');
    assert.equal(last(trace(), { lambdaLimits: { ...limits, fMax: NaN } }).veEvidenceEligible, false);
});

check('cold, full-load, fuel-cut and cat-protection frames reset the same evidence window', () => {
    assert.equal(last(trace(6, 0.25, () => ({ coolantTemp: 60 }))).veEvidenceReason, 'cold-engine');
    assert.equal(last(trace(6, 0.25, () => ({ rf: 150 }))).veEvidenceReason, 'full-load');
    const stock = { ...limits, wotThreshold: { ...limits.wotThreshold, z: [[35, 35], [35, 35]] } };
    assert.equal(last(trace(6, 0.25, () => ({ wdk1: 40 })), { lambdaLimits: stock }).veEvidenceReason, 'full-load');
    assert.equal(last(trace(6, 0.25, () => ({ wdk1: 0, rawLoad: 0.3, correctedLoad: 0.3 }))).veEvidenceReason, 'fuel-cut');
    const heated = run(trace(33, 0.25, t => t === 7 ? { exhaustTemp: 860 } : {}));
    assert.ok(heated.filter(p => p.time >= 7 && p.time < 27).every(p => p.veEvidenceReason === 'cat-protect'));
    assert.equal(heated.find(p => p.time === 27).veEvidenceEligible, false);
    assert.equal(heated.find(p => p.time === 32).veEvidenceEligible, true);
    // Merely being in the hysteresis band without an arming event does not invent protection.
    assert.equal(last(trace(6, 0.25, () => ({ exhaustTemp: 845 }))).veEvidenceEligible, true);
});

check('gate opening, closing, and unknown dwell cannot reuse the preceding steady window', () => {
    const result = run(trace(20, 0.25, t => t >= 7 && t < 14
        ? { rfKorrGateOpen: true, rfKorrDwellSec: t - 7 } : {}));
    assert.equal(result.find(p => p.time === 7).veEvidenceReason, 'correction-transition');
    assert.ok(result.filter(p => p.time >= 7 && p.time < 12).every(p => !p.veEvidenceEligible));
    assert.equal(result.find(p => p.time === 12).veEvidenceEligible, true);
    assert.equal(result.find(p => p.time === 14).veEvidenceReason, 'correction-transition');
    assert.equal(result.find(p => p.time === 19).veEvidenceEligible, true);
    assert.equal(last(trace(6, 0.25, () => ({ rfKorrGateOpen: true }))).veEvidenceReason, 'correction-state-unknown');
    assert.equal(last(trace(6, 0.25, () => ({ rfKorrGateOpen: true, rfKorrDwellSec: 1 }))).veEvidenceReason, 'correction-settling');
});

check('sample gaps and duplicate/backward/invalid timestamps break evidence without mutating order', () => {
    const gap = trace(18).filter(p => p.time < 7 || p.time >= 10);
    const gapResult = run(gap);
    assert.equal(gapResult.find(p => p.time === 10).veEvidenceReason, 'sample-gap');
    assert.ok(gapResult.filter(p => p.time >= 10 && p.time < 15).every(p => !p.veEvidenceEligible));
    assert.equal(gapResult.find(p => p.time === 15).veEvidenceEligible, true);
    for (const t of [6.75, 0, NaN]) {
        const raw = trace(14); raw[28] = { ...raw[28], time: t };
        const result = run(raw);
        assert.equal(result[28].veEvidenceReason, Number.isNaN(t) ? 'invalid-time' : 'non-monotonic-time');
        assert.equal(result[29].veEvidenceEligible, false);
        assert.equal(result.at(-1).veEvidenceEligible, true);
    }
});

check('user-excluded intervals cannot be bridged even if no sample lands inside them', () => {
    const result = run(trace(15), { excludeTimeRanges: [[7, 8], [10.1, 10.15]] });
    assert.ok(result.filter(p => p.time >= 7 && p.time <= 8).every(p => p.veEvidenceReason === 'excluded'));
    assert.equal(result.find(p => p.time === 10.25).veEvidenceReason, 'excluded');
    assert.ok(result.filter(p => p.time >= 7).every(p => !p.veEvidenceEligible));
    const recovered = last(trace(16), { excludeTimeRanges: [[10.1, 10.15]] });
    assert.equal(recovered.veEvidenceEligible, true);
});

check('invalid configuration and malformed calibration fail closed; undefined options use defaults', () => {
    for (const invalid of [
        { windowSec: 0 }, { maxGapSec: Infinity }, { minSamples: 0 }, { minSamples: 2.5 },
        { maxStftRange: -1 }, { secondsPerTimeUnit: 0 }, { katsTabgOff: 900 },
        { excludeTimeRanges: [[4, 3]] },
    ]) assert.equal(last(trace(), invalid).veEvidenceReason, 'invalid-config');
    for (const malformed of [
        { ...limits, wotThreshold: undefined },
        { ...limits, loadThreshold: { x: [1000, 1000], y: [1.5, 1.5] } },
        { ...limits, wotThreshold: { ...limits.wotThreshold, z: [[NaN, NaN], [1, 1]] } },
    ]) assert.equal(last(trace(), { lambdaLimits: malformed }).veEvidenceReason, 'controller-limits-unknown');
    assert.equal(last(trace(), { windowSec: undefined }).veEvidenceEligible, true);
    assert.equal(STEADY_EVIDENCE_DEFAULTS.windowSec, 5);
});

check('the same historical prefix is identical live and after future samples arrive', () => {
    const raw = trace(35, 0.25, t => ({
        stft1: 0.96 + 0.025 * Math.sin(2 * Math.PI * t),
        stft2: 0.97 - 0.025 * Math.sin(2 * Math.PI * t),
        ...(t === 7 ? { tankVent: 5 } : {}),
        ...(t >= 15 && t < 24 ? { rfKorrGateOpen: true, rfKorrDwellSec: t - 15 } : {}),
    }));
    const before = structuredClone(raw), batch = run(raw);
    for (let end = 1; end <= raw.length; end++) assert.deepEqual(run(raw.slice(0, end)), batch.slice(0, end));
    assert.deepEqual(raw, before);
    assert.notEqual(batch[0], raw[0]);
    const frozen = Object.freeze(raw.map(p => Object.freeze({ ...p })));
    assert.deepEqual(run(frozen), batch);
});

check('seconds and milliseconds have identical evidence, including explicit exclusions', () => {
    const seconds = trace(15);
    const millis = seconds.map(p => ({ ...p, time: p.time * 1000 }));
    const resultA = run(seconds, { excludeTimeRanges: [[7, 8]] });
    const resultB = run(millis, { secondsPerTimeUnit: 0.001, excludeTimeRanges: [[7000, 8000]] });
    assert.deepEqual(resultA.map(p => [p.veEvidenceEligible, p.veEvidenceReason, p.veSteadySeconds]),
        resultB.map(p => [p.veEvidenceEligible, p.veEvidenceReason, p.veSteadySeconds]));
});

check('unverified lambdaFreeze and direct RAM-looking fields confer no evidence', () => {
    const ordinary = trace(7), opaque = ordinary.map(p => ({ ...p, lambdaFreeze: 255, rfKorrDirect: 9 }));
    assert.deepEqual(run(ordinary).map(p => p.veEvidenceEligible), run(opaque).map(p => p.veEvidenceEligible));
    assert.equal(last(trace(6, 0.25, () => ({ rfKorrGateOpen: undefined, lambdaFreeze: 0, rfKorrDirect: 1 }))).veEvidenceEligible, false);
});

check('a correctly compensated engine stays unchanged for every retained k and gain', () => {
    for (const k of [1, 1.07, 1.2, 1.371]) for (const eta of [0, 0.2, 0.5, 1]) {
        assert.equal(deriveOperatingCorrection({ trim: 1, kApplied: k, kPlanned: k, learningRate: eta }), 1);
    }
});

check('the proposed VE/k pair reproduces required fuel in an independent steady plant', () => {
    const airDemand = 0.96, veOld = 1, kApplied = 1.2;
    const controller = airDemand / (veOld * kApplied);
    for (const kPlanned of [1, 1.1, 1.2, 1.371]) {
        const proposal = deriveOperatingCorrection({ trim: controller, kApplied, kPlanned, learningRate: 1 });
        const veNew = veOld * proposal;
        close(airDemand / (veNew * kPlanned), 1);
    }
});

check('whole-demand damping preserves direction and repeated measured updates converge', () => {
    for (const demand of [0.8, 0.96, 1.04, 1.2]) for (const eta of [0, 0.2, 0.5, 1]) {
        const c = deriveOperatingCorrection({ trim: demand, kApplied: 1.2, kPlanned: 1.2, learningRate: eta });
        assert.ok(c >= Math.min(demand, 1) - 1e-12 && c <= Math.max(demand, 1) + 1e-12);
    }
    const airDemand = 0.96, k = 1.2; let ve = 1, lastError = Infinity;
    for (let pass = 0; pass < 12; pass++) {
        const trim = airDemand / (ve * k), error = Math.abs(Math.log(trim));
        assert.ok(error < lastError); lastError = error;
        ve *= deriveOperatingCorrection({ trim, kApplied: k, kPlanned: k, learningRate: 0.5 });
    }
    assert.ok(Math.abs(airDemand / (ve * k) - 1) < 0.001);
});

check('unknown/invalid factors or gain never silently become identity correction', () => {
    const good = { trim: 1, kApplied: 1.2, kPlanned: 1.2, learningRate: 0.5 };
    for (const field of ['trim', 'kApplied', 'kPlanned']) {
        for (const invalid of [undefined, null, NaN, Infinity, -1, 0]) {
            assert.equal(deriveOperatingCorrection({ ...good, [field]: invalid }), undefined);
        }
    }
    for (const gain of [undefined, NaN, Infinity, -0.1, 1.1]) {
        assert.equal(deriveOperatingCorrection({ ...good, learningRate: gain }), undefined);
    }
    assert.equal(deriveOperatingCorrection({ ...good, trim: Number.MAX_VALUE, kApplied: 2, kPlanned: 1 }), undefined);
});

console.log(`\n${passed} steady-evidence and operating-correction checks passed.`);
