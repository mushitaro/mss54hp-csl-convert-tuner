/**
 * WHAT ONE RECORDED IDLE RUN SAYS — replayed through the real tuner, against the car's own BASE.
 *
 * `verify:idle-practice` closes the loop against `MockIdleBench`, and that bench is built from the
 * premise the whole retarget rests on: its `dutyAt` IS `llsTvAt(tables, ...)`, so the model gate is
 * tautologically satisfied there and cannot refute anything. This script is the other half — the
 * same functions over samples a car produced, where that gate can come back open.
 *
 * The headline is therefore MODEL: measured `LLS_TV` against `KF_LLS_TV(rpm, ML_SOLL_LLS)`. If it
 * agrees, the map this feature writes is the map driving the valve. If it does not, the target is
 * wrong again and nothing below it means anything.
 *
 *     node scripts/analyze-idle-session.mjs <dir>   # holding session.json, idle.json, binaries.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readIdleTables, llsTvAt } from '../src/lib/idle/idleTables.ts';
import { idleCensus, tuneIdleFeedforward, idleGateNow, rejectSample, sampleGates } from '../src/lib/idle/tuner.ts';
import { evaluateIdlePreflight } from '../src/lib/idle/preflight.ts';
import { IDLE_TUNE_DEFAULTS, withDefaults } from '../src/lib/idle/types.ts';
import { llsTvSlopePctPerKgH, lookupNodes } from '../src/lib/idle/valveModel.ts';

const dir = process.argv[2];
if (!dir) { console.error('usage: <dir>'); process.exit(2); }
const read = (n) => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
const sess = read('session.json');
const idle = read('idle.json');
const bins = read('binaries.json');

const baseBuf = Buffer.from(bins.base, 'base64');
const tables = readIdleTables(baseBuf.buffer.slice(baseBuf.byteOffset, baseBuf.byteOffset + baseBuf.byteLength));
const o = withDefaults(undefined);

const N = (v, d = 2) => (v === null || v === undefined || Number.isNaN(v) ? '—' : v.toFixed(d));
const hr = (s) => console.log('\n' + s + '\n' + '─'.repeat(s.length));

console.log(`${sess.label}  ·  ${idle.length} samples  ·  ${sess.averageHz?.toFixed(2)} Hz  ·  BASE ${sess.baseFileName}`);
if (!tables) { console.log('the idle tables could not be read from this BASE'); process.exit(1); }

// ── what the run actually was ──────────────────────────────────────────────────────────────────
hr('THE RUN');
const span = idle[idle.length - 1].time - idle[0].time;
const rng = (k) => { const v = idle.map(s => s[k]).filter(x => x !== null && x !== undefined); return v.length ? [Math.min(...v), Math.max(...v), v.length] : null; };
for (const k of ['rpm', 'nSoll', 'coolantTemp', 'wdk1', 'mdLlri', 'mdLlra', 'llsTv', 'mlSollLls', 'mlSollMaxLls', 'ub', 'lfrZustand']) {
    const r = rng(k);
    console.log(`  ${k.padEnd(13)} ${r ? `${N(r[0])} … ${N(r[1])}   (${r[2]}/${idle.length} present)` : 'NEVER ARRIVED'}`);
}
console.log(`  duration      ${N(span, 1)} s`);
const srcs = [...new Set(idle.map(s => s.mdLlriSource).filter(Boolean))];
console.log(`  MD_LLRI from  ${srcs.join(' + ') || 'unknown'}`);

// ── THE MODEL GATE ─────────────────────────────────────────────────────────────────────────────
hr('MODEL — is KF_LLS_TV the map driving the valve?');
const usable = idle.filter(s => s.llsTv !== null && s.rpm !== null && s.mlSollLls !== null);
const deltas = usable.map(s => ({ t: s.time, tmot: s.coolantTemp, rpm: s.rpm, ml: s.mlSollLls,
    meas: s.llsTv, map: llsTvAt(tables, s.rpm, s.mlSollLls) }))
    .map(x => ({ ...x, d: x.meas - x.map }));
const ds = deltas.map(x => x.d).sort((a, b) => a - b);
const pct = (p) => ds.length ? ds[Math.min(ds.length - 1, Math.floor(p * ds.length))] : NaN;
console.log(`  samples with all three channels : ${usable.length}`);
console.log(`  measured − map, %               : median ${N(pct(0.5))}   p05 ${N(pct(0.05))}   p95 ${N(pct(0.95))}`);
console.log(`  |delta| <= ${N(o.maxModelDeltaPct, 1)} %                : `
    + `${ds.filter(d => Math.abs(d) <= o.maxModelDeltaPct).length} / ${ds.length}`
    + ` (${N(100 * ds.filter(d => Math.abs(d) <= o.maxModelDeltaPct).length / ds.length, 0)} %)`);
// Warm only, which is where the gate is actually applied.
const warm = deltas.filter(x => x.tmot !== null && x.tmot >= o.minCoolantC && x.tmot <= o.maxCoolantC);
if (warm.length) {
    const wd = warm.map(x => x.d).sort((a, b) => a - b);
    console.log(`  WARM ONLY (${warm.length}) median          : ${N(wd[Math.floor(wd.length / 2)])} %`
        + `   inside: ${wd.filter(d => Math.abs(d) <= o.maxModelDeltaPct).length}/${wd.length}`);
}
console.log('  a few samples, spread across the run:');
for (let i = 0; i < deltas.length; i += Math.max(1, Math.floor(deltas.length / 8))) {
    const x = deltas[i];
    console.log(`    t=${String(Math.round(x.t)).padStart(4)}s  tmot ${String(x.tmot).padStart(3)}  `
        + `n ${String(x.rpm).padStart(4)}  ml ${N(x.ml, 1).padStart(5)}  `
        + `meas ${N(x.meas).padStart(6)}  map ${N(x.map).padStart(6)}  Δ ${N(x.d).padStart(7)}`);
}

// ── what the gates make of it ──────────────────────────────────────────────────────────────────
hr('ADMISSION — why samples were kept or dropped');
const ctx = { hasLlBit: idle.some(s => s.engineState !== null), hasCompressor: idle.some(s => s.kkosSt !== null) };
const tally = {};
for (const s of idle) { const r = rejectSample(s, o, ctx) ?? 'ADMITTED'; tally[r] = (tally[r] ?? 0) + 1; }
for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(22)} ${String(v).padStart(4)}`);
}
// Which gates could not run at all, because the channel never came.
const g0 = sampleGates(idle[0], o, ctx);
const dead = g0.filter(g => g.ok === null).map(g => g.id);
console.log(`  gates that cannot fire on this run: ${dead.length ? dead.join(', ') : 'none'}`);
const noUb = idle.every(s => s.ub === null || s.ub === undefined);
if (noUb) console.log('  UB never arrived, so BOTH electrical-load gates passed without testing anything.');

hr('CENSUS — what the tuner keeps');
const rep = idleCensus(idle, tables);
console.log(`  samples ${rep.samplesSeen} seen / ${rep.samplesAdmitted} admitted`);
console.log(`  dwells  ${rep.dwellsFound} found / ${rep.dwellsAccepted} accepted     worst |error| ${N(rep.worstErrorNm)} Nm`);
console.log(`  gain    ${N(rep.gainUsed, 3)} %/Nm${rep.gainLearned ? ' (learned)' : ' (prior)'}   source ${rep.source}`);
for (const [k, v] of Object.entries(rep.rejects).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${k.padEnd(22)} ${String(v).padStart(4)}`);
}
if (rep.dwells.length) {
    console.log('  windows:');
    for (const d of rep.dwells) {
        console.log(`    ${N(d.durationSec, 0).padStart(5)}s  ${String(d.samples).padStart(4)} smp  `
            + `n ${N(d.rpmMean, 0).padStart(4)}  tmot ${N(d.tmotMean, 0).padStart(3)}  ml ${N(d.mlSollLlsMean, 1).padStart(5)}  `
            + `llri ${N(d.mdLlriTrimmedMean).padStart(7)}  llra ${N(d.mdLlraMean).padStart(6)}  `
            + `err ${N(d.error).padStart(7)}  model ${N(d.modelDeltaPct).padStart(6)}  ${d.rejected ?? 'ACCEPTED'}`);
    }
}

// ── the target, from THIS car's binary ─────────────────────────────────────────────────────────
hr('THE TARGET AND THE ERROR');
console.log(`  idle target (−K_LFR_MDADAPT_OFFSET) : ${N(tables.idleTargetNm)} Nm`);
console.log(`  MD_LLRI clamps                      : ${N(tables.mdLlriRange.min)} … ${N(tables.mdLlriRange.max)} Nm`);
console.log(`  valve rails K_LLS_TV_MIN/MAX        : ${N(tables.tvMin, 1)} … ${N(tables.tvMax, 1)} %`);
console.log(`  authority floor (KF_LLS_TV y[0])    : ${N(tables.qvsAuthorityFloorKgH, 1)} kg/h`
    + `   railed=${tables.authorityFloorIsRailed}`);
const lastWarm = [...idle].reverse().find(s => s.coolantTemp !== null && s.coolantTemp >= o.minCoolantC);
if (lastWarm) {
    const sum = (lastWarm.mdLlri ?? 0) + (lastWarm.mdLlra ?? 0);
    console.log(`  last warm sample: md_llri ${N(lastWarm.mdLlri)} + md_llra ${N(lastWarm.mdLlra)}`
        + ` = ${N(sum)}   vs target ${N(tables.idleTargetNm)}   →  error ${N(sum - tables.idleTargetNm)} Nm`);
    const slope = llsTvSlopePctPerKgH(tables.llsTv, lastWarm.rpm, lastWarm.mlSollLls);
    console.log(`  map slope at that point             : ${N(slope)} %/(kg/h)`);
    const nodes = lookupNodes(tables.llsTv, lastWarm.rpm, lastWarm.mlSollLls);
    console.log('  cells the DME reads there:');
    for (const n of nodes) {
        console.log(`    row ${n.row} (${tables.llsTv.y[n.row]} kg/h) col ${n.col} (${tables.llsTv.x[n.col]} rpm)  `
            + `w ${N(n.weight, 3)}  value ${N(tables.llsTv.values[n.row][n.col])} %`);
    }
}

// ── the preconditions, which gate nothing but say what state the governor was in ───────────────
hr('PRECONDITIONS (diagnosis, not admission)');
const pre = evaluateIdlePreflight(idle, tables, 60);
if (!pre) console.log('  no verdict');
else for (const t of pre.tests) {
    console.log(`  ${t.status === 'ok' ? 'ok  ' : t.status === 'fail' ? 'FAIL' : ' ?  '} ${t.id.padEnd(28)} `
        + `${N(t.value)}${t.against !== null ? ' / ' + N(t.against) : ''}  ${t.unit}  rule ${t.rule}`);
}

hr('WHAT IT WOULD WRITE');
const res = tuneIdleFeedforward(idle, tables);
if (!res) console.log('  nothing — the tuner refused the run');
else {
    console.log(`  acceptable ${res.acceptable}   converged ${res.converged}   `
        + `cells updated ${res.report.cellsUpdated}`);
    const moved = res.cells.flat().filter(c => c.tuned !== c.stock);
    for (const c of moved) {
        console.log(`    ${c.rpm} rpm · ${c.tmot} kg/h   ${N(c.stock)} → ${N(c.tuned)}  `
            + `(${c.tuned > c.stock ? '+' : ''}${N(c.tuned - c.stock)})   from ${N(c.errorNm)} Nm`);
    }
    if (!moved.length) {
        const why = {};
        for (const c of res.cells.flat()) if (c.rejected) why[c.rejected] = (why[c.rejected] ?? 0) + 1;
        console.log('    nothing moves:', JSON.stringify(why));
    }
}
void idleGateNow;
void IDLE_TUNE_DEFAULTS;
void fileURLToPath;
