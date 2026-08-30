/**
 * Exactly which bytes a flash would change, from a stored session, before it is flashed.
 *
 * The app builds the artifact from the session in the browser; this builds it from the same base
 * and the same log through the same code, so the two can be compared before anything reaches the
 * car. It exists because a flash has already gone in once carrying nothing — the manifest toggle
 * was off, the file was still named `Tune_`, and the only thing that would have caught it was a
 * byte diff nobody ran.
 *
 * Reports every changed byte with its address, the raw counts either side, and the table value
 * they decode to. A `kf_rf_soll` cell is two bytes at `0xD356 + (row * 20 + col) * 2`, raw =
 * value * 1000 — but nothing here computes that: the grid goes through `writtenVeGrid` and
 * `BinaryPatcher.setVETableData`, the same two calls the download and the flash use, so a layout
 * mistake in this script cannot make a wrong file look right.
 *
 *     node scripts/analyze-write-preview.mjs <session-dir>
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const NL = '\n';
const root = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const dir = process.argv[2];
if (!dir) {
    console.error('usage: node scripts/analyze-write-preview.mjs <session-dir>');
    process.exit(2);
}

const entry = path.join(root, 'scripts', '.wp-entry.ts');
fs.writeFileSync(entry, [
    "export { processLogData } from '@/lib/log-engine/filter';",
    "export { VECalculator } from '@/lib/ve-calculator/calculator';",
    "export { readEgtTables } from '@/lib/ve-calculator/egtTables';",
    "export { readRfPtKorrCurves } from '@/lib/ve-calculator/chargeTemp';",
    "export { writtenVeGrid } from '@/lib/ve-calculator/composeVeGrid';",
    "export { BinaryPatcher } from '@/lib/binary-engine/patcher';",
    "export { APP_CONFIG } from '@/config/constants';",
].join(NL));
const outfile = path.join(root, 'scripts', '.wp-bundle.mjs');
await build({
    entryPoints: [entry], outfile, bundle: true, format: 'esm', platform: 'node',
    logLevel: 'warning', alias: { '@': path.join(root, 'src') },
});
const M = await import(pathToFileURL(outfile).href);
fs.rmSync(entry, { force: true });

const read = (n) => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
const session = read('session.json');
const binaries = read('binaries.json');
const cfg = session.tuneSettings.filterConfig;
const base = Buffer.from(binaries.base, 'base64');
const ab = base.buffer.slice(base.byteOffset, base.byteOffset + base.byteLength);
// THE BASE TABLE, read from the binary — NOT `session.veMapSnapshot`.
//
// `veMapSnapshot` is the TUNED map (db/schema.ts: "TUNED map. Read by useComparison for the db:
// diff variants"). Feeding it in as the current map derives a correction on top of a correction,
// and on session #1 the two differ in 21 cells — including all three the gate accepts, so every
// number would have been computed against a value the binary does not hold.
const veMap = new M.BinaryPatcher(ab).getVETable();

const processed = M.processLogData(read('log.json'), session.baseFileName, cfg,
    session.tuneSettings.interpolationTable);
const calc = new M.VECalculator();
const ve = calc.annotateRfKorr(veMap, processed.data, M.readEgtTables(ab),
    { curves: M.readRfPtKorrCurves(ab) });
const res = calc.calculateNewVEMap(veMap, ve, { egt: M.readEgtTables(ab) });

console.log(NL + '='.repeat(92));
console.log('WRITE PREVIEW — ' + session.label);
console.log('='.repeat(92));
console.log('  base       ' + session.baseFileName);
console.log('  base sha   ' + (session.baseSha256 ?? '?'));
console.log('  ALPHA-N    assumed ON (this is what the toggle would produce)');

if (!res.newMap) {
    console.log(NL + '  The log earns NO cell. There is nothing to flash — the artifact would be the');
    console.log('  BASE with the logic patches, and the app would name it Base_, not Tune_.');
    process.exit(0);
}

// The same two calls the download and the flash make. Nothing here knows the table's layout.
const written = M.writtenVeGrid(res.newMap.data, null, null);
const patcher = new M.BinaryPatcher(ab);
if (written) patcher.setVETableData(written);
const out = Buffer.from(patcher.getBuffer ? patcher.getBuffer() : patcher.buffer);

const rpmAxis = veMap.xAxis ?? M.APP_CONFIG.MSS54HP.AXIS_RPM;
const loadAxis = veMap.yAxis ?? M.APP_CONFIG.MSS54HP.AXIS_LOAD;

// What the derivation decided, cell by cell.
const moved = [];
for (let i = 0; i < res.acceptedMap.length; i++) {
    for (let j = 0; j < res.acceptedMap[i].length; j++) {
        if (!res.acceptedMap[i][j]) continue;
        moved.push({
            i, j, load: loadAxis[i], rpm: rpmAxis[j],
            old: veMap.data[i][j], nw: res.newMap.data[i][j],
            demand: res.demandMap[i][j], n: res.hitMap[i][j],
        });
    }
}
console.log(NL + '  cells the gate accepted: ' + moved.length + NL);
console.log('  aq_rel_rf    rpm    n     base ->  written    demanded    realised (shrunk to)');
for (const m of moved.sort((a, b) => Math.abs(b.nw / b.old - 1) - Math.abs(a.nw / a.old - 1))) {
    const wrote = 100 * (m.nw / m.old - 1);
    const asked = 100 * (m.demand - 1);
    console.log('  ' + String(m.load).padStart(8) + ' %' + String(m.rpm).padStart(7)
        + String(m.n).padStart(6)
        + '   ' + m.old.toFixed(3) + ' -> ' + m.nw.toFixed(3)
        + '   ' + (asked >= 0 ? '+' : '') + asked.toFixed(2) + ' %'
        + '      ' + (wrote >= 0 ? '+' : '') + wrote.toFixed(2) + ' %'
        + '   (' + (100 * wrote / asked).toFixed(0) + ' % of the demand)');
}

// And the bytes, which is the part that can be checked against the file the app produces.
const diffs = [];
for (let a = 0; a < Math.min(base.length, out.length); a++) if (base[a] !== out[a]) diffs.push(a);
const runs = [];
for (const d of diffs) {
    const last = runs[runs.length - 1];
    if (last && d === last.end + 1) last.end = d; else runs.push({ start: d, end: d });
}
console.log(NL + '  BYTES: ' + diffs.length + ' changed, in ' + runs.length + ' runs' + NL);
console.log('  address     base -> written      value                cell');
for (const r of runs) {
    // Two-byte words in the VE table; anything else is reported raw so a surprise is visible.
    if (r.end - r.start === 1) {
        const off = r.start - 0xD356;
        const idx = off / 2;
        const inTable = off >= 0 && off % 2 === 0 && idx < 24 * 20;
        const row = inTable ? Math.floor(idx / 20) : null;
        const col = inTable ? idx % 20 : null;
        const rawOld = base.readUInt16BE(r.start);
        const rawNew = out.readUInt16BE(r.start);
        console.log('  0x' + r.start.toString(16).toUpperCase().padStart(5, '0')
            + '     ' + String(rawOld).padStart(5) + ' -> ' + String(rawNew).padStart(5)
            + '      ' + (rawOld / 1000).toFixed(3) + ' -> ' + (rawNew / 1000).toFixed(3)
            + '     ' + (inTable
                ? `aq_rel_rf ${loadAxis[row]} % @ ${rpmAxis[col]} rpm`
                : '(outside kf_rf_soll — checksum or another table)'));
    } else {
        console.log('  0x' + r.start.toString(16).toUpperCase().padStart(5, '0')
            + ' - 0x' + r.end.toString(16).toUpperCase().padStart(5, '0')
            + '   (' + (r.end - r.start + 1) + ' bytes)');
    }
}
console.log(NL + '  Check the file the app produces against this before flashing: same count, same');
console.log('  addresses, same raw values. A Tune_ prefix with no kf_rf_soll bytes means the');
console.log('  ALPHA-N toggle was off.');
