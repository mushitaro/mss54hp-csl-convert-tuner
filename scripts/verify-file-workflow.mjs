/**
 * The file workflow, pinned to the bytes the app hands back.
 *
 * README "A. File workflow": UPLOAD BIN (a partial BIN), TESTO CSV (a drive log), DOWNLOAD TUNED.
 * This runs that path headlessly under a first load's defaults and checks the tuned BIN against a
 * golden SHA-256 that was measured from the APP — the production build in headless Chrome, the
 * fixture files set on the two upload inputs and the Download Tuned blob hashed — not from this
 * script. The two agreeing is what makes the hash mean "what the app produces" rather than "what
 * this script produces".
 *
 * Why it exists: the next step is the same computation outside the browser (a tool an LLM can call
 * — no screen, no hooks). A second path to these bytes is only safe if a difference from the first
 * one fails somewhere, and this is that somewhere.
 *
 * ## What is the app's, and what is re-composed here
 *
 * Every function the bytes pass through is the app's own, imported from src/: parseLogFile,
 * processLogData, the VECalculator, tuneRfKorrTable, writtenVeGrid, the BinaryPatcher and the
 * checksum. The defaults are the app's too (DEFAULT_FILTER_CONFIG, moved out of useLogFile into
 * lib/log-engine/filterDefaults.ts for this). The ORDER is re-composed, because the app composes
 * inside React hooks this cannot call:
 *
 *     useBinaryFile.uploadBinary        toggles detected from the bytes (useBinaryFile.ts ~290)
 *     page.tsx asRunBuffer memo         bytesAsRun(BASE, toggles) — both readers below (page.tsx ~723)
 *     page.tsx egtTables / lambdaLimits read from that as-run image                   (page.tsx ~743)
 *     useLogFile.parseAndSetLog         parseLogFile → processLogData                (useLogFile.ts ~164)
 *     page.tsx veCalcOptionsFor         the options object                            (page.tsx ~655)
 *     useVeCalculation.runCalculation   K HOLD check → annotate → tune rf_korr → calculateNewVEMap
 *                                                                                     (useVeCalculation.ts ~158)
 *
 * So a change INSIDE any of those functions moves the hash here, and a change to the composition
 * in the hooks does not. The LAST step is no longer re-composed: the build moved into one pure
 * function, lib/binary-engine/buildImage.ts, which `useBinaryFile.buildPatchedBuffer` (DOWNLOAD
 * TUNED, SAVE, WRITE) and the hub's write gate all run — and this imports it, so the golden now
 * pins that function's composition directly. Re-measure the golden from the app whenever a hash
 * change here is intended (see GOLDEN).
 *
 * ## Inputs
 *
 * The BASE is PRACTICE's community partial (public/mock — the file .public-tree-allow already lets
 * this repository publish). The log is scripts/fixtures/practice-drive.testo.csv, a PRACTICE drive
 * over that BASE, written by scripts/make-practice-log.mjs through the app's own exporter.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseLogFile } from '../src/lib/log-engine/parser.ts';
import { processLogData, timeScaleSeconds } from '../src/lib/log-engine/filter.ts';
import { DEFAULT_FILTER_CONFIG } from '../src/lib/log-engine/filterDefaults.ts';
import { VECalculator } from '../src/lib/ve-calculator/calculator.ts';
import { tuneRfKorrTable } from '../src/lib/ve-calculator/rfKorrTuner.ts';
import { readEgtTables } from '../src/lib/ve-calculator/egtTables.ts';
import { readRfPtKorrCurves } from '../src/lib/ve-calculator/chargeTemp.ts';
import { BinaryParser } from '../src/lib/binary-engine/parser.ts';
import { readLogicPatches, bytesAsRun } from '../src/lib/binary-engine/patcher.ts';
import { buildImage } from '../src/lib/binary-engine/buildImage.ts';
import { analyzeDataChecksum } from '../src/lib/checksum/dmeDataChecksum.ts';
import { APP_CONFIG, MAP_DIMENSIONS } from '../src/config/constants.ts';

const M = {
    parseLogFile, processLogData, DEFAULT_FILTER_CONFIG, VECalculator, tuneRfKorrTable, readEgtTables,
    readRfPtKorrCurves, BinaryParser, readLogicPatches, bytesAsRun, buildImage,
    analyzeDataChecksum, APP_CONFIG, MAP_DIMENSIONS,
};

const root = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const BIN = path.join(root, 'public', 'mock', 'csl-0401-community-patch-v1.partial.bin');
const CSV = path.join(root, 'scripts', 'fixtures', 'practice-drive.testo.csv');

/**
 * SHA-256 of the TUNED BIN the production build's DOWNLOAD TUNED returned for BIN + CSV above.
 * When a change is MEANT to move the tuned bytes, measure it again from the app — never paste this
 * script's own output here, which would turn the check into "the script agrees with itself".
 *
 * Re-measured 2026-10-15 from `next build`'s static export in headless Chromium 1179 (every request
 * fulfilled from the export on disk at a loopback origin, which the app needs for
 * `crypto.randomUUID`), through the first-load disclaimer, NEW SESSION, UPLOAD BIN, TESTO CSV and
 * DOWNLOAD TUNED, the downloaded blob hashed. The same harness on the previous tree (6d1914a)
 * returned the previous golden (e8309ff0…) first, so the two numbers are measured the same way.
 * It moved on purpose, and by two rules, from 11 moved cells to 5:
 *
 *   - the ramp exclusion reads `kRamp` whatever the gate says. The drive opens at 1602 rpm with the
 *     gate open and the gate shuts at 1.6 s on a stepped K — a drop, so the banks wait for the rich
 *     switch — and the four idle-edge cells RO 1.0-1.4 % / 870 rpm were fed only by those first
 *     seconds: written +3.4 % before, refused as lambda-ramp now (303 of the 979 VE samples are
 *     ramps either way; 35 of them gate-shut, which the old rule wrote);
 *   - the visit gate. RO 30 % / 1600 rpm (+3.6 %, 14 samples) and RO 45 % / 1800 rpm (+3.0 %, 15)
 *     each came from two visits, and are refused as few-visits.
 *
 * The five at RO 2.4-7.5 % / 1100-1300 rpm are written as before.
 */
const GOLDEN = '881233375714d5e85f3a525803aa06eec9a7f5791d464371a50ffd274b2a538f';

let fails = 0;
const check = (n, c, d) => { console.log('  ' + (c ? 'PASS' : 'FAIL') + '  ' + n + (c ? '' : ' — ' + (d ?? ''))); if (!c) fails++; };

// --- UPLOAD BIN ----------------------------------------------------------------------------------
const baseBytes = fs.readFileSync(BIN);
const base = baseBytes.buffer.slice(baseBytes.byteOffset, baseBytes.byteOffset + baseBytes.byteLength);
const map = new M.BinaryParser(base).getVETable();
// What uploadBinary arms from the bytes on a fresh load; the rest of its toggles default off, and
// writeVe on (useBinaryFile.ts ~285-300). `readLogicPatches` reports the floor both ways, as
// patchStatus does: held seeds K HOLD, and a dropped floor rides into the as-run image unarmed.
const toggles = M.readLogicPatches(base);
// The as-run image, and both of its readers — the EGT tables (the rf_korr floor is one of them)
// and the full-load gate. The curves come off the BASE: no patch touches them.
const asRun = M.bytesAsRun(base, toggles);
const egtAsRun = M.readEgtTables(asRun);
const curves = M.readRfPtKorrCurves(base);
const lambdaLimits = new M.BinaryParser(asRun).readLambdaLimits();

// --- TESTO CSV -----------------------------------------------------------------------------------
const cfg = M.DEFAULT_FILTER_CONFIG;
const raw = M.parseLogFile(fs.readFileSync(CSV, 'utf8'));
const processed = M.processLogData(raw, path.basename(CSV), cfg, M.APP_CONFIG.MSS54HP.INTERPOLATION_TABLE, lambdaLimits);

// veCalcOptionsFor(cfg, egtTables, curves, interpolationTable, highDeltaGuard = null), field for
// field. A fresh workspace has no session behind it, so no ancestor guard either.
const table = M.APP_CONFIG.MSS54HP.INTERPOLATION_TABLE;
const options = {
    rfKorrSource: cfg.rfKorrSource,
    rfKorrMode: cfg.rfKorrMode,
    applyRfKorr: cfg.applyRfKorr,
    veMethod: cfg.veMethod,
    directAuthority: cfg.directAuthority,
    ...(cfg.enableVeCellGate === false
        ? { minCellSamples: 1, minCellWeight: 0 }
        : { minCellSamples: cfg.minVeCellSamples, minCellWeight: cfg.minVeCellWeight }),
    normaliseTo: cfg.normaliseChargeTemp ? curves : null,
    rfKorrAir: {
        curves, assumedPressureMbar: cfg.assumedAmbientPressure,
        loadTable: cfg.enableCorrection === false ? null : table,
    },
    rfKorrThresholds: {
        ...(cfg.enableRfKorrCellGate === false
            ? { minCellSamples: 1, minCellWeight: 0 }
            : { minCellSamples: cfg.rfKorrMinCellSamples, minCellWeight: cfg.rfKorrMinCellWeight }),
        highDeltaGuard: null,
    },
    egt: egtAsRun,
};

// runCalculation, in its order: the K HOLD check first, then everything on the tables it settles.
const calc = new M.VECalculator();
const hold = options.egt
    ? calc.resolveKHold(map, options.egt, options.rfKorrAir, processed.rawData) : null;
const egt = hold ? hold.egt : (options.egt ?? null);
const annotated = calc.annotateRfKorr(map, processed.data, egt, options.rfKorrAir, processed.rawData);
const annotatedForRfKorr = calc.annotateRfKorr(map, processed.rfKorrData, egt, options.rfKorrAir, processed.rawData);
const rfKorr = egt
    ? M.tuneRfKorrTable(map, annotatedForRfKorr, egt,
        { rpm: M.APP_CONFIG.MSS54HP.AXIS_RPM, load: M.APP_CONFIG.MSS54HP.AXIS_LOAD }, options.rfKorrThresholds ?? {})
    : null;
// The table is derived and, on a first load, not armed (writeRfKorr defaults off) — so it is
// computed for parity with the hook and goes nowhere, as in the app.
void rfKorr;
// The visit gap's unit off the RAW log, as runCalculation passes it.
const result = calc.calculateNewVEMap(map, annotated,
    { ...options, egt, secondsPerUnit: timeScaleSeconds(processed.rawData) });
const newMap = result.newMap;

// --- DOWNLOAD TUNED: buildPatchedBuffer(newMap, no overrides, extras all null) -----------------
// The app's own build, called as the hook calls it. A fresh session has never written, so its car
// image is its BASE: the build starts from the same image it falls back to.
const tuned = new Uint8Array(M.buildImage({
    source: base, base, newMap,
    toggles: {
        applyPatch: toggles.applyPatch, applyWotDisable: toggles.applyWotDisable,
        applyTankVentDisable: toggles.applyTankVentDisable, applyRfKorrHold: !!toggles.applyRfKorrHold,
        // A first load's defaults: every derived row off, ALPHA-N armed (useBinaryFile.uploadBinary).
        writeWarmup: false, restoreWotFuel: false, restoreVe: false, restoreWarmup: false, writeVe: true,
    },
    extras: {},
}));
const hash = crypto.createHash('sha256').update(tuned).digest('hex');

// --- what the run did ----------------------------------------------------------------------------
const baseU8 = new Uint8Array(base);
const cells = [];
if (newMap) {
    map.data.forEach((row, r) => row.forEach((v, c) => {
        if (Math.round(v * 1000) !== Math.round(newMap.data[r][c] * 1000)) cells.push([r, c]);
    }));
}
console.log(`BASE    ${path.relative(root, BIN)} (${baseU8.length} B), toggles ${JSON.stringify(toggles)}`);
console.log(`LOG     ${path.relative(root, CSV)}: ${raw.length} rows → ${processed.data.length} for VE`);
console.log(`TUNED   ${cells.length} of ${map.data.length * map.data[0].length} VE cells moved`);
console.log(`sha256  ${hash}`);

console.log('\n[the tuned BIN]');
check('the drive moved some VE cells — a golden of an unchanged BASE would pin nothing', cells.length > 0);
const slots = M.analyzeDataChecksum(tuned);
check('both checksum slots validate', slots.length > 0 && slots.every(s => s.isValid),
    JSON.stringify(slots.map(s => ({ name: s.name, stored: s.storedChecksum, calculated: s.calculatedChecksum, valid: s.isValid }))));
{
    // Nothing outside the VE table and the checksum slots may differ from the BASE: this BASE carries
    // no logic patch, so every "restore" writer must write back what was already there.
    const VE_START = M.APP_CONFIG.MSS54HP.VE_TABLE.ADDRESS_DATA;
    const VE_END = VE_START + M.MAP_DIMENSIONS.rows * M.MAP_DIMENSIONS.cols * 2;
    const inSlot = (i) => slots.some(s => i >= s.offset && i < s.offset + 4);
    const stray = [];
    for (let i = 0; i < tuned.length; i++) {
        if (tuned[i] !== baseU8[i] && !(i >= VE_START && i < VE_END) && !inSlot(i)) stray.push(i);
    }
    check('only the VE table and the checksum slots differ from the BASE', stray.length === 0,
        stray.slice(0, 8).map(i => '0x' + i.toString(16).toUpperCase()).join(', '));
}

console.log('\n[pinned to the app]');
if (GOLDEN === null) {
    console.log('  NOT PINNED — measure the golden from the app and write it into GOLDEN.');
    process.exit(2);
}
check('the tuned BIN is byte-for-byte what the app downloads', hash === GOLDEN, `got ${hash}, the app gave ${GOLDEN}`);

console.log(fails ? `\n${fails} FAIL` : '\nall PASS');
process.exit(fails ? 1 : 0);
