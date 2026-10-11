import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { captureRecordingCalibration, recordingCalibrationBuffer, recoverHistoricalRecordingCalibration } from '../src/lib/db/recordingCalibration.ts';
import { patchOnImage } from '../src/lib/binary-engine/patcher.ts';
import { analyzeDataChecksum, readStoredChecksums } from '../src/lib/checksum/dmeDataChecksum.ts';
import { operatingCalibrationHold } from '../src/lib/ve-calculator/operatingPolicy.ts';
import { nextLogRecord } from '../src/lib/db/sessionRepository.ts';
import { asLogRecord, gzipJson, gunzipJson } from '../src/lib/session-sync/client.ts';

const file = fs.readFileSync(new URL('../public/mock/csl-0401-community-patch-v1.partial.bin', import.meta.url));
const source = file.buffer.slice(file.byteOffset, file.byteOffset + file.length);
const off = { applyPatch: false, applyWotDisable: false, applyTankVentDisable: false, applyRfKorrGateDrop: false };
const on = { ...off, applyPatch: true, applyWotDisable: true, applyTankVentDisable: true };
const base = patchOnImage(source, off), flashed = patchOnImage(base, on);
const hash = b => crypto.createHash('sha256').update(new Uint8Array(b)).digest('hex');
const session = { id: 'earlier', seq: 965, createdAt: 10, baseOrigin: { kind: 'dme', vin: 'fixture', readAt: 10 },
    baseSha256: hash(base), flashHistory: [{ at: 20, tuned: false, practice: false, sha256: hash(flashed), settings: on }] };
const later = { ...session, id: 'later', seq: 968, createdAt: 30, tuneSettings: off, flashHistory: [] };
const bins = { baseBinaryBuffer: base, tunedBinaryBuffer: null };
const input = { sessions: [later, session], loadBinaries: async () => bins, readChecksums: async () => readStoredChecksums(new Uint8Array(flashed)),
    vin: 'fixture', mock: false, now: () => 40 };
const record = await captureRecordingCalibration(input);
assert.equal(record.status, 'matched');
assert.equal(record.reference.source.kind, 'patch-flash');
assert.equal(record.reference.sha256, hash(flashed));
assert.equal(operatingCalibrationHold(base), 'air-model-active');
assert.equal(operatingCalibrationHold(await recordingCalibrationBuffer(record), base), null);
assert.equal(operatingCalibrationHold(null), 'binary-missing');
console.log('PASS prior-session real patch flash, stale BASE, and future OFF toggles resolve to the checksum-matched image');

for (const changes of [{ practice: true }, { at: 50 }, { sha256: '0'.repeat(64) }, { tuned: true }]) {
    const altered = { ...session, flashHistory: [{ ...session.flashHistory[0], ...changes }] };
    assert.equal((await captureRecordingCalibration({ ...input, sessions: [later, altered] })).reason, 'no-reference');
}
assert.equal((await captureRecordingCalibration({ ...input, vin: 'other' })).reason, 'no-reference');
assert.equal((await captureRecordingCalibration({ ...input, vin: null })).reason, 'vehicle-unknown');
assert.equal((await captureRecordingCalibration({ ...input, mock: true })).reason, 'mock');
assert.equal((await captureRecordingCalibration({ ...input, readChecksums: async () => { throw Error('offline'); } })).reason, 'read-failed');
assert.equal((await captureRecordingCalibration({ ...input, readChecksums: async () => ({ master: NaN, slave: 0 }) })).reason, 'read-failed');
console.log('PASS practice, future, changed SHA, absent tuned artifact, foreign vehicle and failed reads never establish a recording reference');

// Construct a second, DIFFERENT calibration with the same CRC pair by solving a
// 16-bit linear CRC system. Independent collision fixture: a CRC match is not a SHA/readback.
const collision = new Uint8Array(flashed.slice(0));
collision[0xd356] ^= 1; // change a VE table value
const wanted = readStoredChecksums(collision).master;
const calc = () => analyzeDataChecksum(collision)[1].calculatedChecksum;
const zero = calc(), basis = [];
for (let bit = 0; bit < 16; bit++) {
    collision[0xff00 + (bit >> 3)] ^= 1 << (bit & 7);
    basis.push(calc() ^ zero);
    collision[0xff00 + (bit >> 3)] ^= 1 << (bit & 7);
}
const pivots = new Array(16);
for (let i = 0; i < 16; i++) {
    let value = basis[i], mask = 1 << i;
    for (let bit = 15; bit >= 0; bit--) if (value & (1 << bit)) {
        if (pivots[bit]) { value ^= pivots[bit].value; mask ^= pivots[bit].mask; }
        else { pivots[bit] = { value, mask }; break; }
    }
}
let residual = wanted ^ zero, mask = 0;
for (let bit = 15; bit >= 0; bit--) if (residual & (1 << bit)) {
    assert.ok(pivots[bit]); residual ^= pivots[bit].value; mask ^= pivots[bit].mask;
}
assert.equal(residual, 0);
for (let bit = 0; bit < 16; bit++) if (mask & (1 << bit)) collision[0xff00 + (bit >> 3)] ^= 1 << (bit & 7);
assert.ok(analyzeDataChecksum(collision).every(c => c.isValid));
assert.deepEqual(readStoredChecksums(collision), await input.readChecksums());
assert.notEqual(hash(collision.buffer), hash(flashed));
const extra = { ...session, id: 'collision', baseSha256: hash(collision.buffer), flashHistory: [] };
const ambiguous = await captureRecordingCalibration({ ...input, sessions: [session, extra],
    loadBinaries: async id => id === extra.id ? { ...bins, baseBinaryBuffer: collision.buffer } : bins });
assert.equal(ambiguous.reason, 'ambiguous-reference');
assert.equal(operatingCalibrationHold(flashed, collision.buffer), 'recording-map-mismatch');
console.log('PASS distinct images with identical CRCs are ambiguous; a different VE basis cannot adopt the drive');

const data = [{ time: 0, rpm: 2400, rawLoad: 7.5 }];
const saved = nextLogRecord('later', undefined, { data, recordingCalibration: record });
const synced = asLogRecord(await gunzipJson(await gzipJson(saved)), 'later');
assert.equal(hash(await recordingCalibrationBuffer(synced.recordingCalibration)), hash(flashed));
assert.equal(nextLogRecord('later', saved, { data, recordingCalibration: record }).recordingCalibration, record);
assert.equal(nextLogRecord('later', saved, { data: [{ ...data[0], time: 2 }] }).recordingCalibration, undefined);
assert.equal(nextLogRecord('later', saved, { data, recordingCalibration: null }).recordingCalibration, undefined);
const corrupt = structuredClone(record); corrupt.reference.bytes[0xd356] ^= 1;
assert.equal(await recordingCalibrationBuffer(corrupt), null);
const wrongSha = structuredClone(record); wrongSha.reference.sha256 = '0'.repeat(64);
assert.equal(await recordingCalibrationBuffer(wrongSha), null);
console.log('PASS SAVE/SYNC preserves the self-contained reference, imported replacement clears it, corrupted references fail verification');

const historicalInput={recordingSession:later,sessions:[session,later],loadBinaries:async()=>bins,logDurationSec:2};
const historical=await recoverHistoricalRecordingCalibration(historicalInput);
assert.equal(historical.status,'recorded-flash-reference');assert.equal(historical.ecuChecksums,undefined);
assert.equal(historical.historical.recordingSessionId,later.id);
assert.equal(hash(await recordingCalibrationBuffer(historical)),hash(flashed));
const historicalSaved=asLogRecord(await gunzipJson(await gzipJson(nextLogRecord('later',undefined,{data,recordingCalibration:historical}))),'later');
assert.equal(historicalSaved.recordingCalibration.status,'recorded-flash-reference');
assert.equal(hash(await recordingCalibrationBuffer(historicalSaved.recordingCalibration)),hash(flashed));
console.log('PASS old-log recovery preserves hash-verified historical provenance without inventing START checksums, through SAVE/SYNC');

for(const changes of [{practice:undefined},{sha256:'0'.repeat(64)},{tuned:true}]){
    const bad={...session,flashHistory:[{...session.flashHistory[0],...changes}]};
    assert.equal(await recoverHistoricalRecordingCalibration({...historicalInput,sessions:[bad,later]}),null);
}
const newerBad={...session,id:'unavailable',flashHistory:[{...session.flashHistory[0],at:25,sha256:'0'.repeat(64)}]};
assert.equal(await recoverHistoricalRecordingCalibration({...historicalInput,sessions:[session,newerBad,later]}),null);
const during={...session,id:'during',flashHistory:[{...session.flashHistory[0],at:31}]};
assert.equal(await recoverHistoricalRecordingCalibration({...historicalInput,sessions:[session,during,later]}),null);
const unknownPractice={...session,id:'uncertain',flashHistory:[{...session.flashHistory[0],at:25,practice:undefined}]};
assert.equal(await recoverHistoricalRecordingCalibration({...historicalInput,sessions:[session,unknownPractice,later]}),null);
const tamperedHistorical=structuredClone(historical);tamperedHistorical.ecuChecksums=await input.readChecksums();
assert.equal(await recordingCalibrationBuffer(tamperedHistorical),null);
assert.equal(await recoverHistoricalRecordingCalibration({...historicalInput,loadBinaries:async id=>id===later.id?{...bins,baseBinaryBuffer:collision.buffer}:bins}),null);
console.log('PASS newer unverifiable writes, unknown practice, in-log writes, mismatched BASE and counterfeit checksum claims block historical recovery');
