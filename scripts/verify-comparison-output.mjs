/** Exercise the real artifact boundary independently of disabled UI controls. Public synthetic
 * inputs only. A server render supplies React's dispatcher; the captured hook's actual build and
 * download methods run unchanged. Rejection occurs before a BASE is read or a patcher is created. */
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useBinaryFile, writeClaimsTune } from '../src/hooks/useBinaryFile.ts';
import { isComparisonOnlyOutput, comparisonOnlyOutputMessage } from '../src/lib/ve-calculator/comparisonOutput.ts';

let passed = 0;
const check = (name, test) => { test(); passed++; console.log(`PASS ${name}`); };
const legacy = { xAxis: [2000, 3000], yAxis: [5, 10], data: [[0.6, 0.6], [0.8, 0.8]] };
const candidate = { ...legacy, calibrationStatus: 'comparison-only' };
const extras = {
    tunedShape: { data: [[0.7, 0.7], [0.9, 0.9]], applied: [[true, true], [true, true]] },
    tunedRfKorr: [[1.2]], tunedIdleTv: [[40]], tunedLlsTv: [{ row: 0, col: 0, value: 40 }],
    calibrationEdits: { edits: [{ paramId: 'test', raw: [1] }], conflictSpans: [] },
};

check('map metadata and current-policy state each independently forbid output', () => {
    assert.equal(isComparisonOnlyOutput(candidate), true);
    assert.equal(isComparisonOnlyOutput(candidate, { comparisonOnly: false }), true);
    assert.equal(isComparisonOnlyOutput(legacy, { comparisonOnly: true }), true);
    assert.equal(isComparisonOnlyOutput(null, { comparisonOnly: true }), true);
    assert.equal(isComparisonOnlyOutput({ ...candidate, data: [[9]] }), true);
    assert.equal(isComparisonOnlyOutput(structuredClone(candidate)), true);
    assert.equal(isComparisonOnlyOutput(legacy), false);
    assert.equal(isComparisonOnlyOutput(null, { comparisonOnly: false }), false);
});

check('comparison candidates never claim a writable tune, even with unrelated armed extras', () => {
    for (const writeVe of [true, false]) {
        assert.equal(writeClaimsTune(candidate, writeVe, extras), false);
        assert.equal(writeClaimsTune(legacy, writeVe, { ...extras, comparisonOnly: true }), false);
        assert.equal(writeClaimsTune(null, writeVe, { ...extras, comparisonOnly: true }), false);
    }
    assert.equal(writeClaimsTune(legacy, true), true);
    assert.equal(writeClaimsTune(null, false, { calibrationEdits: extras.calibrationEdits }), true);
    assert.equal(writeClaimsTune(null, false, { tunedIdleTv: [[40]] }), true);
    assert.equal(writeClaimsTune(null, false), false);
});

let binary;
function CaptureBoundary() { binary = useBinaryFile(); return null; }
renderToStaticMarkup(createElement(CaptureBoundary));
const priorAlert = globalThis.alert;
const notices = [];
globalThis.alert = message => notices.push(message);
try {
    check('the actual BIN builder refuses every toggle override before applying any writer', () => {
        for (const settings of [
            undefined, { writeVe: true }, { writeVe: false, writeWarmup: true },
            { writeVe: false, writeWarmup: false, restoreVe: true, restoreWarmup: true },
            { applyPatch: true, applyWotDisable: true, applyTankVentDisable: true, writeRfKorr: true },
        ]) {
            const count = notices.length;
            assert.equal(binary.buildPatchedBuffer(candidate, settings, extras), null);
            assert.equal(notices.length, count + 1);
            assert.equal(binary.buildPatchedBuffer(legacy, settings, { ...extras, comparisonOnly: true }), null);
            assert.equal(notices.length, count + 2);
        }
    });

    check('an active comparison policy also refuses no-map and stale-map BIN requests', () => {
        for (const map of [null, legacy]) {
            const count = notices.length;
            assert.equal(binary.buildPatchedBuffer(map, undefined, { comparisonOnly: true }), null);
            assert.equal(notices.length, count + 1);
        }
    });

    check('download cannot bypass the shared boundary or create a browser artifact', () => {
        const count = notices.length;
        // No DOM is provided. Reaching downloadBlob would throw instead of silently succeeding.
        assert.equal(binary.downloadBin(candidate, extras), undefined);
        assert.equal(binary.downloadBin(legacy, { ...extras, comparisonOnly: true }), undefined);
        assert.equal(notices.length, count + 2);
    });

    check('legacy/no-map operations are not classified as comparison-only', () => {
        const count = notices.length;
        // A BASE has not been loaded in this synthetic hook, so the old missing-buffer return is
        // expected. Crucially it must not emit the new refusal or change legacy writer policy.
        assert.equal(binary.buildPatchedBuffer(legacy, undefined, extras), null);
        assert.equal(binary.buildPatchedBuffer(null), null);
        assert.equal(notices.length, count);
    });
} finally {
    if (priorAlert === undefined) delete globalThis.alert;
    else globalThis.alert = priorAlert;
}

check('the refusal explains all artifact routes in Japanese and English', () => {
    assert.match(comparisonOnlyOutputMessage('ja'), /保存.*ダウンロード.*書き込み/);
    assert.match(comparisonOnlyOutputMessage('en'), /saving, download and ECU writing/);
    assert.ok(notices.every(message => typeof message === 'string' && message.length > 30));
});

console.log(`\n${passed} comparison-only output checks passed.`);
