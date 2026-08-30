/**
 * Rebuilds a stored session's flash artifact offline, through the same composition the app uses.
 *
 * Two jobs, and the first is what makes the second trustworthy:
 *
 *   1. REPRODUCE. A session that has been flashed carries the bytes that went into the ECU
 *      (`binaries.tuned`, sha pinned by `flashHistory`). Rebuilding from `binaries.base` plus the
 *      log and comparing sha256 says whether this offline path is the same path the app took. If
 *      the two disagree, nothing else this script prints means anything.
 *   2. REBUILD. With the derivation changed — a fixed gate, a different method — the same call
 *      produces the artifact that SHOULD have gone in, and the diff against the flashed file is
 *      exactly what a re-flash would change.
 *
 * It is not a second implementation of the write. `writtenVeGrid`, `setVETableData`,
 * `generateWarmupMap`, `setWarmupTable` and `applyChecksumCorrection` are the same calls
 * `buildPatchedBuffer` makes, in the same order, so a layout mistake here cannot make a wrong file
 * look right — the same property `analyze:write-preview` has, extended to the whole artifact
 * rather than the VE table alone.
 *
 *     node scripts/rebuild-session-write.mjs <session-dir> [out.bin]
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const NL = '\n';
const root = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const dir = process.argv[2];
const outPath = process.argv[3];
if (!dir) {
    console.error('usage: node scripts/rebuild-session-write.mjs <session-dir> [out.bin]');
    process.exit(2);
}

const entry = path.join(root, 'scripts', '.rebuild-entry.ts');
fs.writeFileSync(entry, [
    "export { processLogData } from '@/lib/log-engine/filter';",
    "export { VECalculator } from '@/lib/ve-calculator/calculator';",
    "export { readEgtTables } from '@/lib/ve-calculator/egtTables';",
    "export { readRfPtKorrCurves } from '@/lib/ve-calculator/chargeTemp';",
    "export { readAlphaNTables } from '@/lib/ve-calculator/alphaNTable';",
    "export { tuneLowLoad } from '@/lib/ve-calculator/lowLoadTuner';",
    "export { writtenVeGrid } from '@/lib/ve-calculator/composeVeGrid';",
    "export { BinaryPatcher } from '@/lib/binary-engine/patcher';",
    "export { APP_CONFIG } from '@/config/constants';",
].join(NL));
const outfile = path.join(root, 'scripts', '.rebuild-bundle.mjs');
await build({
    entryPoints: [entry], outfile, bundle: true, format: 'esm', platform: 'node',
    logLevel: 'warning', alias: { '@': path.join(root, 'src') },
});
const M = await import(pathToFileURL(outfile).href);
fs.rmSync(entry, { force: true });

const read = (n) => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
const session = read('session.json');
const binaries = read('binaries.json');
const rawLog = read('log.json');
const cfg = session.tuneSettings.filterConfig;
const set = session.tuneSettings;

const base = Buffer.from(binaries.base, 'base64');
const ab = base.buffer.slice(base.byteOffset, base.byteOffset + base.byteLength);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

const RULE = '='.repeat(96);
console.log(NL + RULE);
console.log('REBUILD — ' + session.label + '   ' + new Date(session.createdAt).toISOString().slice(0, 16).replace('T', ' '));
console.log(RULE);
console.log('  base        ' + session.baseFileName);
console.log('  base sha    ' + sha(base) + (sha(base) === session.baseSha256 ? '  (matches the record)' : '  MISMATCH'));
console.log('  settings    writeVe=' + set.writeVe + '  writeLowLoad=' + set.writeLowLoad
    + '  writeWarmup=' + set.writeWarmup + '  writeRfKorr=' + set.writeRfKorr);
console.log('              applyPatch=' + set.applyPatch + '  applyWotDisable=' + set.applyWotDisable
    + '  applyTankVentDisable=' + set.applyTankVentDisable);
console.log('              veMethod=' + (cfg.veMethod ?? '(default)'));

// ---------------------------------------------------------------- the derivation
// NO `lambdaLimits`, and that is a decision rather than an omission.
//
// `processLogData` takes them fifth, and `page.tsx` reads them from
// `bytesAsRun(base, { applyPatch, applyWotDisable, applyTankVentDisable })` — the toggles as they
// stand NOW. On an archived session those are the toggles at FLASH time, not at DRIVE time, and on
// session #926 the two are opposite: the drive ran on a `PatchON` base whose `KF_BZ_WDK_VL` reads
// 102.3 % everywhere (the lambda controller never shuts down, so full-load samples are real
// closed-loop evidence), while the stored `applyWotDisable: false` makes `bytesAsRun` write the
// STOCK 35/55/63/65 % back before the limits are read. Passing that filters 16 high-opening cells
// out of a derivation the DME's own bytes say are valid.
//
// Omitting it is what reproduces the flashed file byte for byte, which is the evidence that this
// is the derivation the app actually ran. See the `IDENTICAL` line below: it is the whole warrant
// for anything this script prints afterwards.
const veMap = new M.BinaryPatcher(ab).getVETable();
const egt = M.readEgtTables(ab);
const curves = M.readRfPtKorrCurves(ab);
const alphaN = M.readAlphaNTables(ab);

const processed = M.processLogData(rawLog, session.baseFileName, cfg, set.interpolationTable);
const calc = new M.VECalculator();
const annotated = calc.annotateRfKorr(veMap, processed.data, egt,
    { curves, assumedPressureMbar: cfg.assumedAmbientPressure });

// The same option object `veCalcOptionsFor` builds, with the session's own thresholds.
const res = calc.calculateNewVEMap(veMap, annotated, {
    rfKorrSource: cfg.rfKorrSource, rfKorrMode: cfg.rfKorrMode, applyRfKorr: cfg.applyRfKorr,
    writeRfKorr: set.writeRfKorr,
    veMethod: cfg.veMethod, directAuthority: cfg.directAuthority,
    ...(cfg.enableVeCellGate === false
        ? { minCellSamples: 1, minCellWeight: 0 }
        : { minCellSamples: cfg.minVeCellSamples, minCellWeight: cfg.minVeCellWeight }),
    normaliseTo: cfg.normaliseChargeTemp ? curves : null,
    rfKorrAir: { curves, assumedPressureMbar: cfg.assumedAmbientPressure },
    egt,
});
const newMap = res.newMap;

const lowLoad = alphaN && processed.data.length ? M.tuneLowLoad(processed.data, alphaN, veMap) : null;
const lowLoadWrite = set.writeLowLoad && lowLoad?.acceptable
    ? { grid: lowLoad.tuned, owned: lowLoad.owned } : null;

// ---------------------------------------------------------------- the artifact
// buildPatchedBuffer's order, and only the writers this session armed.
const patcher = new M.BinaryPatcher(ab);
const written = M.writtenVeGrid(set.writeVe ? newMap?.data ?? null : null, lowLoadWrite, null);
if (written) patcher.setVETableData(written);
if (newMap && set.writeWarmup) {
    const source = written ? { ...newMap, data: written } : newMap;
    patcher.setWarmupTable(new M.VECalculator().generateWarmupMap(source));
}
if (set.applyPatch) patcher.disableMapCorrection(); else patcher.enableMapCorrection();
if (set.restoreWotFuel) patcher.restoreWotFuel();
if (set.restoreVe) patcher.restoreVeTable();
if (set.restoreWarmup) patcher.restoreWarmupTable();
patcher.setWOTThreshold(set.applyWotDisable);
patcher.setTankVentDisable(set.applyTankVentDisable);
patcher.applyChecksumCorrection();
const out = Buffer.from(patcher.getBuffer());

// ---------------------------------------------------------------- what it says
const flashed = binaries.tuned ? Buffer.from(binaries.tuned, 'base64') : null;
console.log(NL + '  cells written   VE ' + (res.acceptedMap.flat().filter(Boolean).length)
    + '   LOW LOAD ' + (lowLoadWrite ? lowLoad.report.cellsMeasured : 0)
    + (lowLoadWrite ? '' : ' (not armed or not acceptable)'));
console.log('  rebuilt sha     ' + sha(out));

if (flashed) {
    console.log('  flashed sha     ' + sha(flashed)
        + (session.sha256 === sha(flashed) ? '  (matches the record)' : '  MISMATCH'));
    if (sha(out) === sha(flashed)) {
        console.log(NL + '  IDENTICAL — this script reproduces what the app flashed, byte for byte.');
    } else {
        let n = 0;
        const cells = [];
        for (let a = 0; a < Math.min(out.length, flashed.length); a++) if (out[a] !== flashed[a]) n++;
        console.log(NL + '  DIFFERS from the flashed file in ' + n + ' bytes.');
        // Which VE cells moved, decoded rather than counted: kf_rf_soll is two bytes per cell at
        // 0xD356 + (row * 20 + col) * 2, raw = value * 1000. Read back through the parser so this
        // is not a second opinion about the layout.
        const flashedMap = new M.BinaryPatcher(
            flashed.buffer.slice(flashed.byteOffset, flashed.byteOffset + flashed.byteLength)).getVETable();
        const rebuiltMap = new M.BinaryPatcher(
            out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength)).getVETable();
        const rpmAxis = veMap.xAxis ?? M.APP_CONFIG.MSS54HP.AXIS_RPM;
        const loadAxis = veMap.yAxis ?? M.APP_CONFIG.MSS54HP.AXIS_LOAD;
        for (let i = 0; i < rebuiltMap.data.length; i++) {
            for (let j = 0; j < rebuiltMap.data[i].length; j++) {
                const a = flashedMap.data[i][j], b = rebuiltMap.data[i][j];
                if (Math.abs(a - b) < 1e-9) continue;
                cells.push({ load: loadAxis[i], rpm: rpmAxis[j], base: veMap.data[i][j], a, b });
            }
        }
        if (cells.length) {
            console.log(NL + '  kf_rf_soll cells that change, against the file now in the ECU:' + NL);
            console.log('   aq_rel_rf    rpm     base      in ECU    rebuilt    move');
            for (const c of cells.sort((x, y) => Math.abs(y.b - y.a) - Math.abs(x.b - x.a))) {
                const move = 100 * (c.b / c.a - 1);
                console.log('   ' + String(c.load).padStart(8) + ' %' + String(c.rpm).padStart(7)
                    + '    ' + c.base.toFixed(3) + '     ' + c.a.toFixed(3) + '     ' + c.b.toFixed(3)
                    + '    ' + (move >= 0 ? '+' : '') + move.toFixed(2) + ' %');
            }
        }
    }
}

if (outPath) {
    fs.writeFileSync(outPath, out);
    console.log(NL + '  written to      ' + outPath + '   (' + out.length + ' bytes)');
}
