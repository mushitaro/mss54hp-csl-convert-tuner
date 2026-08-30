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
 * then hex -> Buffer -> gunzip each column into the three files above. The log column holds
 * `{ sessionId, data }`; log.json is that `data` array.
 *
 *     node scripts/verify-rf-korr.mjs <dir> [--assumed-pressure=<mbar>]
 *
 * BASE is not read only for the EGT tables. The DME's rf_soll is the Alpha-N table TIMES
 * RF_PT_KORR, so `annotateRfKorr` also needs KL_RF_TAN_KORR and KL_RF_P_UMG_KORR out of that
 * binary, and a sample it cannot produce the factor for is returned untouched rather than divided
 * by an assumed 1.000. See the `air` argument below for what passing them is worth.
 *
 * `--assumed-pressure` is for a log recorded before the P_UMG channel existed (the #911/#912
 * campaign, 888 and 993 mbar). Those rows carry an intake temperature and no pressure, and one
 * half of the factor measures nothing. It is deliberately NOT defaulted: a wrong assumed pressure
 * is the same failure as no correction at all, so it has to be stated. With the flag absent the
 * session's own stored `assumedAmbientPressure` is used, which is what the app does with it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const args = process.argv.slice(2);
const dir = args.find(a => !a.startsWith('--'));
if (!dir) {
    console.error('usage: node scripts/verify-rf-korr.mjs <dir with log.json, session.json, binaries.json>');
    console.error('       [--assumed-pressure=<mbar>]   a log recorded before the P_UMG channel needs this');
    process.exit(2);
}
const PRESSURE_FLAG = '--assumed-pressure=';
const pressureArg = args.find(a => a.startsWith(PRESSURE_FLAG));
const flagPressure = pressureArg ? Number(pressureArg.slice(PRESSURE_FLAG.length)) : undefined;
if (pressureArg && !Number.isFinite(flagPressure)) {
    console.error(`${PRESSURE_FLAG}<mbar> wants a number; got "${pressureArg.slice(PRESSURE_FLAG.length)}"`);
    process.exit(2);
}
// Refused rather than ignored, and `--assumed-pressure 993` lands here too. An option this script
// silently dropped would run to completion on a pre-channel log and stop saying "assumed pressure
// none" at an operator who is sure they supplied one.
const unknown = args.filter(a => a.startsWith('--') && !a.startsWith(PRESSURE_FLAG));
if (unknown.length) {
    console.error(`unknown option "${unknown[0]}" — the only one is ${PRESSURE_FLAG}<mbar>, with the =`);
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
export { readRfPtKorrCurves, rfPtKorrFor } from '@/lib/ve-calculator/chargeTemp';
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
    processLogData, VECalculator, tuneRfKorrTable, readEgtTables,
    readRfPtKorrCurves, rfPtKorrFor, rfKorrRouteAgreement, APP_CONFIG,
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
const baseBuffer = base.buffer.slice(base.byteOffset, base.byteOffset + base.byteLength);
const egt = readEgtTables(baseBuffer);
if (!egt) throw new Error('readEgtTables refused the BASE binary — wrong image or wrong addresses');

/**
 * What the app passes as `options.rfKorrAir`, built from the same two things page.tsx builds it
 * from: the curves read from THAT session's BASE, and the config's `assumedAmbientPressure`.
 *
 * Not optional and not decorative. `annotateRfKorrPoint` divides its measurement by RF_PT_KORR and
 * returns the sample UNTOUCHED — no rfKorr, no rfSoll — when it cannot compute one. Called without
 * this argument the curves are null, every sample is refused, and the tuner drops the whole log at
 * its first guard while printing a report of zeroes. That is not hypothetical: it is what this
 * script did from 41b82e8, the commit that started dividing by RF_PT_KORR, until the `measured`
 * line below was added to say so.
 *
 * A binary whose curves do not decode is left to that line rather than thrown on here, so that one
 * place explains a log with no measurement in it and names every cause at once.
 */
const curves = readRfPtKorrCurves(baseBuffer);
const assumedPressureMbar = flagPressure ?? cfg.assumedAmbientPressure;
const air = { curves, assumedPressureMbar };

console.log(`session : ${session.label}  (${rawLog.length} points)`);
console.log(`gate    : kl_rf_korr_rf_min  ${egt.rfKorrMin.rpm.map((r, i) => `${r}:${egt.rfKorrMin.values[i]}`).join('  ')}`);
console.log(`air     : ${curves ? 'RF_PT_KORR curves read from BASE' : 'NO RF_PT_KORR CURVES — they did not decode from BASE'}`
    + (assumedPressureMbar === undefined
        ? ''
        : `, assuming ${assumedPressureMbar} mbar (${flagPressure === undefined ? "session's stored config" : PRESSURE_FLAG.slice(0, -1)})`));

// --- run the real pipeline --------------------------------------------------------------------
const processed = processLogData(rawLog, session.baseFileName ?? 'replay.csv', cfg, table);
const calc = new VECalculator();
const veAxes = { rpm: APP_CONFIG.MSS54HP.AXIS_RPM, load: APP_CONFIG.MSS54HP.AXIS_LOAD };

const annotatedVe = calc.annotateRfKorr(veMap, processed.data, egt, air);
// Falls back so this script can be pointed at an older revision to compare the VE checksum against.
// Before the split there was one sample set and the tuner shared the VE one.
if (!processed.rfKorrData) console.log('note: this build predates ProcessedLog.rfKorrData — tuner is reading the VE set');
const tunerSamples = processed.rfKorrData ?? processed.data;
const annotatedTuner = calc.annotateRfKorr(veMap, tunerSamples, egt, air);

console.log(`\nfilter  : ${rawLog.length} raw -> ${processed.data.length} for VE, ${annotatedTuner.length} for rf_korr`);

// Ahead of the tuner, because a zero here explains every zero after it and nothing after it
// explains this one. `samplesNoMeasurement` is the tuner's first guard and it swallows a whole
// drive silently: the report then reads 0 gate-open, 0 gate-shut, 0 anchors — counters that cannot
// all be zero on a log which produced samples, and the only sign that the check had stopped
// measuring anything at all. Three days of "this session has no evidence in it" is what the
// missing line cost.
const measured = annotatedTuner.filter(p => p.rfKorr !== undefined).length;
const measuredVe = annotatedVe.filter(p => p.rfKorr !== undefined).length;
console.log(`measured: ${measured} of ${annotatedTuner.length} tuner samples carry an rf_korr`
    + `, ${measuredVe} of ${annotatedVe.length} VE samples`);

if (measured === 0) {
    // The inputs `rfPtKorrFor` reads, counted and reported rather than re-decided here: this names
    // which precondition the log fails instead of leaving it to be guessed from a screen of zeroes.
    const n = pred => tunerSamples.filter(pred).length;
    const withPressure = n(p => Number.isFinite(p.ambientPressure));
    const pressures = tunerSamples.map(p => p.ambientPressure).filter(Number.isFinite);
    console.log();
    console.log('No sample produced an rf_korr, so nothing below this line could say anything and');
    console.log('the run stops here. rf_soll is the Alpha-N table TIMES RF_PT_KORR, so measuring a');
    console.log('correction needs the curves out of BASE AND, on every row, an intake temperature');
    console.log('plus an ambient pressure that is a real reading. This log:');
    console.log(`  RF_PT_KORR curves        ${curves ? 'read from BASE' : 'DID NOT DECODE from BASE'}`);
    console.log(`  rows with intakeTemp     ${n(p => Number.isFinite(p.intakeTemp))} of ${tunerSamples.length}`);
    console.log(`  rows with P_UMG          ${withPressure} of ${tunerSamples.length}`
        + (pressures.length ? `  (${Math.min(...pressures)} .. ${Math.max(...pressures)} mbar)` : ''));
    console.log(`  rows with a SUBSTITUTED pressure  ${n(p => p.ambientPressureSubstituted === true)}`
        + '  (refused outright — the DME re-learns that number, it is not a measurement)');
    console.log(`  assumed pressure         ${assumedPressureMbar ?? 'none'}`);
    if (withPressure === 0 && assumedPressureMbar === undefined) {
        console.log();
        console.log(`This log carries no P_UMG at all. Pass ${PRESSURE_FLAG}<mbar> for the altitude it`);
        console.log('was driven at; it is not defaulted because a wrong one is the same failure as no');
        console.log('correction. Outside 400-1150 mbar the DME clamps and the sample is refused.');
    }
    process.exit(1);
}

// The divisor the measurement actually took. A flat 1.0000 would mean the factor changed nothing
// on this drive and every number below it is the old contaminated ratio under a new name.
const divisors = annotatedTuner
    .map(p => rfPtKorrFor(p, curves, assumedPressureMbar))
    .filter(f => f !== undefined);
console.log(`divisor : RF_PT_KORR ${Math.min(...divisors).toFixed(4)} .. ${Math.max(...divisors).toFixed(4)}`
    + '  (1.0000 is the reference air; rf_soll is the table times this)');

const tuned = tuneRfKorrTable(veMap, annotatedTuner, egt, veAxes);

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
//
// One exception, and it is this commit. `resolveRfKorr` defaults `applyRfKorr` ON, so the
// correction is `STFT x rf_korr` — and while this script called `annotateRfKorr` without the air,
// there was no rf_korr to multiply by and the calculation quietly ran on the trim alone. Feeding
// it what the app feeds it moves the number: session #920 went 229.944091699 -> 229.964866582.
// The script agrees with the app now and did not before, which is the direction that matters.
// Across any other pair of revisions the rf_korr work must still leave this alone.
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
