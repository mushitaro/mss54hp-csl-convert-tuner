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
 *     useBinaryFile.uploadBinary        toggles detected from the bytes (useBinaryFile.ts ~255)
 *     page.tsx lambdaLimits memo        read from bytesAsRun(BASE, toggles)          (page.tsx ~722)
 *     useLogFile.parseAndSetLog         parseLogFile → processLogData                (useLogFile.ts ~164)
 *     page.tsx veCalcOptionsFor         the options object                            (page.tsx ~633)
 *     useVeCalculation.runCalculation   annotate → tune rf_korr → calculateNewVEMap   (useVeCalculation.ts ~115)
 *     useBinaryFile.buildPatchedBuffer  VE grid, logic patches both ways, checksum    (useBinaryFile.ts ~291)
 *
 * So a change INSIDE any of those functions moves the hash here, and a change to the composition
 * in the hooks does not — until that composition moves into one pure function the app and a
 * headless caller both run, and this imports it. Re-measure the golden from the app whenever
 * a hash change here is intended (see GOLDEN).
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
import { processLogData } from '../src/lib/log-engine/filter.ts';
import { DEFAULT_FILTER_CONFIG } from '../src/lib/log-engine/filterDefaults.ts';
import { VECalculator } from '../src/lib/ve-calculator/calculator.ts';
import { tuneRfKorrTable } from '../src/lib/ve-calculator/rfKorrTuner.ts';
import { readEgtTables } from '../src/lib/ve-calculator/egtTables.ts';
import { readRfPtKorrCurves } from '../src/lib/ve-calculator/chargeTemp.ts';
import { writtenVeGrid } from '../src/lib/ve-calculator/composeVeGrid.ts';
import { BinaryParser } from '../src/lib/binary-engine/parser.ts';
import { BinaryPatcher, readLogicPatches, bytesAsRun } from '../src/lib/binary-engine/patcher.ts';
import { analyzeDataChecksum } from '../src/lib/checksum/dmeDataChecksum.ts';
import { APP_CONFIG, MAP_DIMENSIONS } from '../src/config/constants.ts';

const M = {
    parseLogFile, processLogData, DEFAULT_FILTER_CONFIG, VECalculator, tuneRfKorrTable, readEgtTables,
    readRfPtKorrCurves, writtenVeGrid, BinaryParser, BinaryPatcher, readLogicPatches, bytesAsRun,
    analyzeDataChecksum, APP_CONFIG, MAP_DIMENSIONS,
};

const root = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const BIN = path.join(root, 'public', 'mock', 'csl-0401-community-patch-v1.partial.bin');
const CSV = path.join(root, 'scripts', 'fixtures', 'practice-drive.testo.csv');

/**
 * SHA-256 of the TUNED BIN the production build's DOWNLOAD TUNED returned for BIN + CSV above.
 * Measured 2026-09-30 from `npm run build` served statically, in headless Chrome 140. When a
 * change is MEANT to move the tuned bytes, measure it again from the app — never paste this
 * script's own output here, which would turn the check into "the script agrees with itself".
 */
const GOLDEN = 'bb6214a8823d94e599b8b5d7bc12dba3243620db94de738d5d60323da1d1302d';

let fails = 0;
const check = (n, c, d) => { console.log('  ' + (c ? 'PASS' : 'FAIL') + '  ' + n + (c ? '' : ' — ' + (d ?? ''))); if (!c) fails++; };

// --- UPLOAD BIN ----------------------------------------------------------------------------------
const baseBytes = fs.readFileSync(BIN);
const base = baseBytes.buffer.slice(baseBytes.byteOffset, baseBytes.byteOffset + baseBytes.byteLength);
const map = new M.BinaryParser(base).getVETable();
// What uploadBinary arms from the bytes on a fresh load; the rest of its toggles default off, and
// writeVe on (useBinaryFile.ts ~255-272).
const toggles = M.readLogicPatches(base);
const egt = M.readEgtTables(base);
const curves = M.readRfPtKorrCurves(base);
const lambdaLimits = new M.BinaryParser(M.bytesAsRun(base, toggles)).readLambdaLimits();

// --- TESTO CSV -----------------------------------------------------------------------------------
const cfg = M.DEFAULT_FILTER_CONFIG;
const raw = M.parseLogFile(fs.readFileSync(CSV, 'utf8'));
const processed = M.processLogData(raw, path.basename(CSV), cfg, M.APP_CONFIG.MSS54HP.INTERPOLATION_TABLE, lambdaLimits);

// veCalcOptionsFor(cfg, egt, writeRfKorr = false, curves), field for field.
const options = {
    rfKorrSource: cfg.rfKorrSource,
    rfKorrMode: cfg.rfKorrMode,
    applyRfKorr: cfg.applyRfKorr,
    writeRfKorr: false,
    veMethod: cfg.veMethod,
    directAuthority: cfg.directAuthority,
    rfKorrSettleSec: cfg.rfKorrSettleSec,
    ...(cfg.enableVeCellGate === false
        ? { minCellSamples: 1, minCellWeight: 0 }
        : { minCellSamples: cfg.minVeCellSamples, minCellWeight: cfg.minVeCellWeight }),
    normaliseTo: cfg.normaliseChargeTemp ? curves : null,
    rfKorrAir: { curves, assumedPressureMbar: cfg.assumedAmbientPressure },
    rfKorrThresholds: cfg.enableRfKorrCellGate === false
        ? { minCellSamples: 1, minCellWeight: 0 }
        : { minCellSamples: cfg.rfKorrMinCellSamples, minCellWeight: cfg.rfKorrMinCellWeight },
    egt,
};

// runCalculation, in its order.
const calc = new M.VECalculator();
const annotated = calc.annotateRfKorr(map, processed.data, options.egt, options.rfKorrAir, processed.rawData);
const annotatedForRfKorr = calc.annotateRfKorr(map, processed.rfKorrData, options.egt, options.rfKorrAir, processed.rawData);
const rfKorr = options.egt
    ? M.tuneRfKorrTable(map, annotatedForRfKorr, options.egt,
        { rpm: M.APP_CONFIG.MSS54HP.AXIS_RPM, load: M.APP_CONFIG.MSS54HP.AXIS_LOAD }, options.rfKorrThresholds ?? {})
    : null;
const result = calc.calculateNewVEMap(map, annotated, { ...options, tunedRfKorr: rfKorr });
const newMap = result.newMap;

// --- DOWNLOAD TUNED: buildPatchedBuffer(newMap, no overrides, extras all null) -----------------
const patcher = new M.BinaryPatcher(base);
const written = M.writtenVeGrid(newMap?.data ?? null, null);
if (written) patcher.setVETableData(written);
if (toggles.applyPatch) patcher.disableMapCorrection(); else patcher.enableMapCorrection();
patcher.setWOTThreshold(toggles.applyWotDisable);
patcher.setTankVentDisable(toggles.applyTankVentDisable);
patcher.setRfKorrGateFloor(!!toggles.applyRfKorrGateDrop);
patcher.applyChecksumCorrection();
const tuned = new Uint8Array(patcher.getBuffer());
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
