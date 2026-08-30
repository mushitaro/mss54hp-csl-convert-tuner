/**
 * End-to-end check of the rf_korr derivation against a drive whose answer is known.
 *
 * PRACTICE mode's MockDrive computes its telemetry from the loaded binary's own tables and bakes in
 * one deliberate error: the real density effect is `MOCK_DENSITY_TRUTH` (0.75) of what
 * KF_RF_KORR_DRREL claims. A correct derivation must pull the table DOWN toward that fraction of
 * its excess over 1.000 — bounded by the per-run step limit, so one pass gets part of the way.
 *
 * This is the only check in the repo where the right answer is knowable rather than argued, which
 * is what makes it worth having: the real-log check (verify-rf-korr.mjs) can only prove the tuner
 * correctly refuses a log with no evidence in it. This one proves it still says something true when
 * the evidence IS there — the half a refusal-only test cannot distinguish from a broken feature.
 *
 *     node scripts/verify-rf-korr-practice.mjs <path to a 64 KB partial BIN>
 *
 * Any BASE the app can load will do, provided KL_RF_TAN_KORR and KL_RF_P_UMG_KORR decode from it:
 * rf_soll is the Alpha-N table TIMES RF_PT_KORR, so without those two curves `annotateRfKorr`
 * measures no rf_korr at all and there is nothing to check. scripts/verify-rf-korr.mjs's session
 * directory has a BASE inside binaries.json if you have no loose file.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const binPath = process.argv[2];
if (!binPath) {
    console.error('usage: node scripts/verify-rf-korr-practice.mjs <base.bin | dir with binaries.json>');
    process.exit(2);
}

const entry = path.join(root, 'scripts', '.rf-korr-practice-entry.ts');
fs.writeFileSync(entry, `
export { processLogData } from '@/lib/log-engine/filter';
export { VECalculator } from '@/lib/ve-calculator/calculator';
export { tuneRfKorrTable } from '@/lib/ve-calculator/rfKorrTuner';
export { readEgtTables } from '@/lib/ve-calculator/egtTables';
export { readRfPtKorrCurves, referenceOf, rfPtKorr } from '@/lib/ve-calculator/chargeTemp';
export { MockDrive, MOCK_DENSITY_TRUTH, MOCK_DRIVE_CYCLE_SECONDS } from '@/lib/dme-link/mockDrive';
export { BinaryParser } from '@/lib/binary-engine/parser';
export { APP_CONFIG } from '@/config/constants';
`);
const outfile = path.join(root, 'scripts', '.rf-korr-practice-bundle.mjs');
await build({
    entryPoints: [entry], outfile, bundle: true, format: 'esm', platform: 'node',
    logLevel: 'warning', alias: { '@': path.join(root, 'src') },
});
const {
    processLogData, VECalculator, tuneRfKorrTable, readEgtTables,
    readRfPtKorrCurves, referenceOf, rfPtKorr,
    MockDrive, MOCK_DENSITY_TRUTH, MOCK_DRIVE_CYCLE_SECONDS, BinaryParser, APP_CONFIG,
} = await import(pathToFileURL(outfile).href);
fs.rmSync(entry, { force: true });

// --- the binary ------------------------------------------------------------------------------
let bytes;
if (fs.statSync(binPath).isDirectory()) {
    bytes = Buffer.from(JSON.parse(fs.readFileSync(path.join(binPath, 'binaries.json'), 'utf8')).base, 'base64');
} else {
    bytes = fs.readFileSync(binPath);
}
const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const egt = readEgtTables(buffer);
if (!egt) throw new Error('readEgtTables refused this binary');

// `KL_RF_TAN_KORR` and `KL_RF_P_UMG_KORR`, which `annotateRfKorr` needs before it will measure
// an rf_korr at all: rf_soll is the Alpha-N table TIMES RF_PT_KORR, and a sample that cannot
// produce the factor is returned untouched rather than divided by an assumed 1.000. Passing them
// is not a formality — without this argument every sample of the drive comes back with no
// rf_korr and no rf_soll, the tuner counts all of them as `samplesNoMeasurement`, and every
// figure below reads zero including the ones that cannot both be zero.
const curves = readRfPtKorrCurves(buffer);
if (!curves) throw new Error('readRfPtKorrCurves refused this binary');
const reference = referenceOf(curves);
if (!reference) throw new Error('this binary has no RF_PT_KORR unity point');

const drive = new MockDrive();
if (!drive.load(buffer)) throw new Error('MockDrive could not load this binary');
const veMap = new BinaryParser(buffer).getVETable();

// --- drive it ---------------------------------------------------------------------------------
// Three cycles at 10 Hz. More than one because the per-run step limit means a single log cannot
// reach the answer, and the interesting property is the DIRECTION and that it does not overshoot.
const HZ = 10;
const seconds = MOCK_DRIVE_CYCLE_SECONDS * 3;
const points = [];
for (let i = 0; i < seconds * HZ; i++) {
    // Spread, not a hand-listed set of channels. Every field of a LiveMeasurement carries the
    // same name on a LogDataPoint, so the copy has nothing to decide — and the list this
    // replaced had gone stale twice over, dropping the throttle, the long-term stores and the
    // two air channels the measurement now depends on.
    points.push({ ...drive.sample(i / HZ) });
}
console.log(`PRACTICE drive: ${points.length} samples over ${seconds.toFixed(0)} s at ${HZ} Hz`);
console.log(`air           : ${reference.intakeTempC} degC / ${reference.pressureMbar} mbar`
    + ` -> RF_PT_KORR ${rfPtKorr(curves, reference.intakeTempC, reference.pressureMbar).toFixed(4)}`);

const cfg = {
    enableCorrection: true, enableMinTemp: true, minTemp: 65,
    enableTransient: true, transientWindow: 4, rpmStableThreshold: 10, tpsStableThreshold: 5,
    rfKorrSource: 'rf-ratio', enableOpenLoopExclusion: true,
};
const processed = processLogData(points, 'practice.csv', cfg, APP_CONFIG.MSS54HP.INTERPOLATION_TABLE);
const calc = new VECalculator();
const annotated = calc.annotateRfKorr(veMap, processed.rfKorrData, egt, { curves });
const tuned = tuneRfKorrTable(veMap, annotated, egt,
    { rpm: APP_CONFIG.MSS54HP.AXIS_RPM, load: APP_CONFIG.MSS54HP.AXIS_LOAD });

console.log(`filter        : ${points.length} raw -> ${processed.data.length} VE, ${processed.rfKorrData.length} rf_korr`);
// Ahead of the tuner, because a zero here explains every zero after it and nothing after it
// explains this one. `samplesNoMeasurement` is the tuner's first guard and it swallows a whole
// drive silently: the report then shows 0 gate-shut, 0 not-settled, 0 anchors — counters that
// cannot all be zero on a drive that produced samples, which is the shape this line names.
const measured = annotated.filter(p => p.rfKorr !== undefined).length;
console.log(`measured      : ${measured} samples carry an rf_korr`);
if (measured === 0) {
    console.log();
    console.log('No sample produced an rf_korr, so nothing downstream can say anything.');
    console.log('annotateRfKorr needs the RF_PT_KORR curves AND intakeTemp + ambientPressure on');
    console.log('every row; check that MockDrive still emits both channels.');
    process.exit(1);
}
if (!tuned) { console.log('tuner returned null'); process.exit(1); }

const r = tuned.report;
console.log(`gate shut     : ${r.samplesGateShut}`);
console.log(`not settled   : ${r.samplesNotSettled}`);
console.log(`hysteresis    : ${r.samplesHysteresis}`);
console.log(`anchors       : ${r.anchorSamples}   ratios: ${r.ratioSamples}   VE cells anchored: ${r.veCellsWithAnchor}`);
console.log(`cells updated : ${r.gridCellsUpdated}   acceptable: ${tuned.acceptable}`);

// --- the knowable answer ----------------------------------------------------------------------
// Target for a cell that stock holds at k: 1 + DENSITY_TRUTH*(k-1). A correct pass moves toward it
// and must not cross it.
console.log(`\ntruth         : real density effect is ${MOCK_DENSITY_TRUTH} of what the table claims`);
console.log('\n  Δ   rpm   stock  target  measured  written   verdict');
let good = 0, bad = 0;
for (let i = 0; i < tuned.tuned.length; i++) {
    for (let j = 0; j < tuned.tuned[i].length; j++) {
        if (!tuned.updated[i][j]) continue;
        const stock = tuned.stock[i][j];
        const target = 1 + MOCK_DENSITY_TRUTH * (stock - 1);
        const written = tuned.tuned[i][j];
        const measured = tuned.measuredMap[i][j];
        // Right direction, and no overshoot past the truth (a small tolerance for the 1/1024
        // quantisation of the table and the 16 °C TABG channel).
        const towards = stock <= 1.0005 ? Math.abs(written - stock) < 1e-6 : written < stock + 1e-9;
        const noOvershoot = written >= target - 0.01;
        const ok = towards && noOvershoot;
        if (ok) good++; else bad++;
        console.log(`${String(tuned.delta[i]).padStart(4)} ${String(tuned.rpm[j]).padStart(5)}  ${stock.toFixed(3)}  ${target.toFixed(3)}   ${measured.toFixed(3)}    ${written.toFixed(3)}   ${ok ? 'ok' : (!towards ? 'WRONG DIRECTION' : 'OVERSHOT')}`);
    }
}
console.log(`\n${good} cells moved toward the truth without overshooting, ${bad} did not.`);
process.exit(bad === 0 && r.gridCellsUpdated > 0 ? 0 : 1);
