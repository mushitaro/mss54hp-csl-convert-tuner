/**
 * Replays a recorded session through the REAL log filter, VE calculation and rf_korr tuner.
 *
 * The point of it is that it imports `src/`, rather than reproducing it. A hand-written model of
 * the pipeline agrees with the pipeline right up until the moment it matters — and the bug this
 * script was written to lock down (the tuner deriving KF_RF_KORR_DRREL from samples where the DME's
 * gate was shut, which pulled the table LEAN) was invisible to every check that did not run the
 * actual code on actual bytes.
 *
 * Input is a directory holding the three blobs of a session, already gunzipped:
 *
 *     log.json        LogDataPoint[]      (sessionLogs store)
 *     session.json    TuningSession       (sessions store — needs tuneSettings + veMapSnapshot)
 *     binaries.json   { base, tuned }     (sessionBinaries store, base64)
 *
 * To pull them out of D1:
 *
 *     npx wrangler d1 execute mss54hp-tuner-runs --remote --json --command \
 *       "SELECT hex(log_json_gz) log, hex(session_json_gz) sess, hex(binaries_json_gz) bins \
 *        FROM sessions WHERE id='<uuid>'" > raw.json
 *
 * then hex -> Buffer -> gunzip each column into the three files above.
 *
 *     node scripts/verify-rf-korr.mjs <dir>
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const dir = process.argv[2];
if (!dir) {
    console.error('usage: node scripts/verify-rf-korr.mjs <dir with log.json, session.json, binaries.json>');
    process.exit(2);
}

// --- bundle the pieces of src/ this needs, resolving the `@/` alias ---------------------------
// Bundled to one file rather than loaded through a resolver hook: these modules import each other
// and `@/config/constants`, and a hook that got one of those wrong would fail by silently loading
// something else.
const entry = path.join(root, 'scripts', '.rf-korr-entry.ts');
fs.writeFileSync(entry, `
export { processLogData } from '@/lib/log-engine/filter';
export { VECalculator } from '@/lib/ve-calculator/calculator';
export { tuneRfKorrTable, RF_KORR_TUNE_DEFAULTS } from '@/lib/ve-calculator/rfKorrTuner';
export { readEgtTables } from '@/lib/ve-calculator/egtTables';
export { rfKorrRouteAgreement } from '@/lib/ve-calculator/rfKorrRoutes';
export { APP_CONFIG } from '@/config/constants';
`);
const outfile = path.join(root, 'scripts', '.rf-korr-bundle.mjs');
await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'warning',
    alias: { '@': path.join(root, 'src') },
});
const {
    processLogData, VECalculator, tuneRfKorrTable, readEgtTables, rfKorrRouteAgreement, APP_CONFIG,
} = await import(pathToFileURL(outfile).href);
fs.rmSync(entry, { force: true });

// --- load the session -------------------------------------------------------------------------
const read = name => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
const rawLog = read('log.json');
const session = read('session.json');
const binaries = read('binaries.json');

const cfg = session.tuneSettings?.filterConfig;
const table = session.tuneSettings?.interpolationTable;
const veMap = session.veMapSnapshot;
if (!cfg || !table || !veMap) throw new Error('session.json is missing tuneSettings / veMapSnapshot');

const base = Buffer.from(binaries.base, 'base64');
const egt = readEgtTables(base.buffer.slice(base.byteOffset, base.byteOffset + base.byteLength));
if (!egt) throw new Error('readEgtTables refused the BASE binary — wrong image or wrong addresses');

console.log(`session : ${session.label}  (${rawLog.length} points)`);
console.log(`gate    : kl_rf_korr_rf_min  ${egt.rfKorrMin.rpm.map((r, i) => `${r}:${egt.rfKorrMin.values[i]}`).join('  ')}`);

// --- run the real pipeline --------------------------------------------------------------------
const processed = processLogData(rawLog, session.baseFileName ?? 'replay.csv', cfg, table);
const calc = new VECalculator();
const veAxes = { rpm: APP_CONFIG.MSS54HP.AXIS_RPM, load: APP_CONFIG.MSS54HP.AXIS_LOAD };

const annotatedVe = calc.annotateRfKorr(veMap, processed.data, egt);
// Falls back so this script can be pointed at an older revision to compare the VE checksum against.
// Before the split there was one sample set and the tuner shared the VE one.
if (!processed.rfKorrData) console.log('note: this build predates ProcessedLog.rfKorrData — tuner is reading the VE set');
const annotatedTuner = calc.annotateRfKorr(veMap, processed.rfKorrData ?? processed.data, egt);
const tuned = tuneRfKorrTable(veMap, annotatedTuner, egt, veAxes);

console.log(`\nfilter  : ${rawLog.length} raw -> ${processed.data.length} for VE, ${annotatedTuner.length} for rf_korr`);

const gateOpen = annotatedTuner.filter(p =>
    p.rfSoll !== undefined
    && p.rfSoll > interp(egt.rfKorrMin.rpm, egt.rfKorrMin.values, p.rpm)).length;
console.log(`gate    : ${gateOpen} of ${annotatedTuner.length} tuner samples had the DME's gate OPEN`);

if (!tuned) {
    console.log('\ntuner   : returned null (no exhaust-temperature channel)');
} else {
    const r = tuned.report;
    console.log('\ntuner report:');
    for (const [k, v] of Object.entries(r)) {
        if (k === 'rejectedByReason') continue;
        console.log(`  ${k.padEnd(22)} ${v}`);
    }
    console.log(`  rejectedByReason       ${JSON.stringify(r.rejectedByReason)}`);
    console.log(`\n  acceptable             ${tuned.acceptable}`);

    const changed = [];
    for (let i = 0; i < tuned.tuned.length; i++) {
        for (let j = 0; j < tuned.tuned[i].length; j++) {
            const d = tuned.tuned[i][j] - tuned.stock[i][j];
            if (Math.abs(d) > 1e-9) {
                changed.push(`Δ=${tuned.delta[i]} rpm=${tuned.rpm[j]}  ${tuned.stock[i][j].toFixed(3)} -> ${tuned.tuned[i][j].toFixed(3)}  (${(100 * d / tuned.stock[i][j]).toFixed(1)}%)`);
            }
        }
    }
    console.log(`  cells changed          ${changed.length}`);
    for (const c of changed) console.log(`    ${c}`);
    const leaned = changed.filter(c => c.includes('(-')).length;
    if (leaned) console.log(`  ** ${leaned} cell(s) moved DOWN — that is the lean direction **`);
}

// --- the VE map, which must be unaffected by any of the above ---------------------------------
const ve = calc.calculateNewVEMap(veMap, annotatedVe, { egt, ...resolveOpts(cfg) });
const sum = ve.newMap.data.flat().reduce((a, b) => a + b, 0);
console.log(`\nVE map  : ${ve.newMap.data.length}x${ve.newMap.data[0].length}, checksum ${sum.toFixed(9)}`);
console.log('          (compare across revisions — the rf_korr work must not move this)');

// Both scopings, because the difference between them is the point. The whole-log number is the one
// the app used to show, and on a road drive it passes for the trivial reason that almost every
// sample sits below the gate where both routes are pinned at 1.000.
const gated = rfKorrRouteAgreement(annotatedTuner, egt);
const whole = rfKorrRouteAgreement(annotatedTuner);
const fmt = (a) => a
    ? `n=${String(a.n).padStart(5)} meanGap=${a.meanAbsGap.toFixed(4)} maxGap=${a.maxAbsGap.toFixed(4)} flat=${a.ratioFlatWhileTableHigh}  ${a.meanAbsGap <= 0.02 ? 'within tolerance' : 'OUTSIDE tolerance'}`
    : '(nothing to compare)';
console.log(`\nroutes, gate-open only : ${fmt(gated)}`);
console.log(`routes, whole log      : ${fmt(whole)}`);

function resolveOpts(c) {
    return { rfKorrSource: c.rfKorrSource, rfKorrMode: c.rfKorrMode, applyRfKorr: c.applyRfKorr };
}
function interp(x, v, q) {
    if (!(q > x[0])) return v[0];
    const last = x.length - 1;
    if (!(q < x[last])) return v[last];
    for (let i = 0; i < last; i++) {
        if (q >= x[i] && q <= x[i + 1]) {
            const s = x[i + 1] - x[i];
            return s === 0 ? v[i] : v[i] + ((q - x[i]) / s) * (v[i + 1] - v[i]);
        }
    }
    return v[last];
}
