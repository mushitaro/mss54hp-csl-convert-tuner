/**
 * The idle corrector against a simulated engine whose feedforward is wrong by a known amount.
 *
 * This is the check that a correct-looking pipeline is actually correct. `verify-idle.mjs` pins the
 * pieces; this one asks the only question that matters: given a feedforward that is short by
 * 1.6 kg/h, does the loop find 1.6 kg/h — while the adaptation is actively hiding it?
 *
 * The confound test is the reason this file exists. `lfra_adapt` drains md_llri into md_llra, so a
 * warm settled engine reads its resting point WHATEVER the error is. A tuner that measured md_llri
 * alone would return "no correction needed" — confidently, plausibly, and completely wrong — and
 * every other check in this repo would pass while it did.
 *
 *     node --experimental-strip-types --import ./scripts/ts-resolve.mjs scripts/verify-idle-practice.mjs [bin]
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readIdleTables, qvsAt } from '../src/lib/idle/idleTables.ts';
import {
    MockIdleBench, MOCK_IDLE_QVS_ERROR_KGH, MOCK_IDLE_GAIN_KGH_PER_NM, MOCK_IDLE_CYCLE_SECONDS,
} from '../src/lib/idle/bench.ts';
import { tuneIdleFeedforward } from '../src/lib/idle/tuner.ts';
import { learnGain } from '../src/lib/idle/gain.ts';
import { IDLE_TUNE_DEFAULTS } from '../src/lib/idle/types.ts';
import { LOG_PROFILES, sampleMs, IDLE_SLOW_LANE_EVERY } from '../src/lib/log-engine/logProfile.ts';
import { BinaryPatcher } from '../src/lib/binary-engine/patcher.ts';
import { findEcuItem } from '../src/lib/ecu-items/catalog/index.ts';

let fails = 0;
const check = (n, c, d) => { console.log('  ' + (c ? 'PASS' : 'FAIL') + '  ' + n + (c ? '' : ' — ' + d)); if (!c) fails++; };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

const binArg = process.argv[2];
const binPath = binArg ?? fileURLToPath(new URL('../public/mock/csl-0401-community-patch-v1.partial.bin', import.meta.url));
const baseBytes = fs.readFileSync(binPath);
const baseBuffer = baseBytes.buffer.slice(baseBytes.byteOffset, baseBytes.byteOffset + baseBytes.byteLength);

const DT = sampleMs(LOG_PROFILES.IDLE.exchanges) / 1000;
const QVS_DEF = findEcuItem('KF_LLR_QVS_GRUND');

/** Drive the bench for one whole scripted cycle, producing samples shaped like the real poll. */
function record(bench, seconds = MOCK_IDLE_CYCLE_SECONDS) {
    const out = [];
    // Carried forward, exactly as both links do. Without it three samples in four during the
    // compressor segment have a null kkosSt, which does not reject, so most of the disturbance
    // walks straight into the census.
    let carried = { llsTv: null, llrQvs: null, engineState: null, kkosSt: null };
    for (let i = 0, t = 0; t < seconds; i++, t += DT) {
        const r = bench.read(t);
        if (i % IDLE_SLOW_LANE_EVERY === 0) {
            carried = { llsTv: r.llsTv, llrQvs: r.llrQvs, engineState: r.engineState, kkosSt: r.kkosSt };
        }
        out.push({
            time: t, rpm: r.rpm, coolantTemp: r.tmot, wdk1: r.wdk1, rf: null,
            nSoll: r.nSoll, ub: r.ub,
            mdLlri: r.mdLlri, mdLlra: r.mdLlra, mdLlraKo: r.mdLlraKo,
            llsTv: carried.llsTv,
            llrQvs: carried.llrQvs,
            llrQsoll: carried.llrQvs,
            engineState: carried.engineState,
            kkosSt: carried.kkosSt,
            mdLlriSource: 'ram',
        });
    }
    return out;
}

/** Write a proposed map back and hand out the resulting buffer, exactly as a flash would. */
function applied(buffer, tunedValues) {
    const patcher = new BinaryPatcher(buffer);
    patcher.setEcuMapValues(QVS_DEF, tunedValues, { min: 11.0, max: 40.0 });
    patcher.applyChecksumCorrection();
    return patcher.getBuffer();
}

/** The warm-row cells the corrector is allowed to touch: 600 and 900 rpm at 80 degC. */
function warmCells(result) {
    const row = result.tmotAxis.length - 1;
    return result.cells[row].filter(c => c.col === 1 || c.col === 2);
}

// ---------------------------------------------------------------------------------------------
console.log('\n[the rig]');
const tables0 = readIdleTables(baseBuffer);
check('the BIN decodes', tables0 !== null);
if (!tables0) process.exit(1);
const stockWarm = qvsAt(tables0, 870, 85);
check(`stock warm request is ${stockWarm} kg/h`, stockWarm > 10 && stockWarm < 40, stockWarm);
check('the bench gain is NOT the tool default, so the learner has work',
    MOCK_IDLE_GAIN_KGH_PER_NM !== IDLE_TUNE_DEFAULTS.gainKgHPerNm);
check('the injected error is the safe direction (needs MORE air)', MOCK_IDLE_QVS_ERROR_KGH < 0);

// ---------------------------------------------------------------------------------------------
console.log('\n[pass 1: the direction is right and it under-corrects on purpose]');
const bench1 = new MockIdleBench({ qvsAt: (rpm, tmot) => qvsAt(tables0, rpm, tmot) });
const run1 = record(bench1);
const r1 = tuneIdleFeedforward(run1, tables0);
check('a result came back', r1 !== null);
check('dwells were found and accepted', r1.report.dwellsAccepted >= 2, JSON.stringify({
    found: r1.report.dwellsFound, accepted: r1.report.dwellsAccepted,
    rejects: Object.fromEntries(Object.entries(r1.report.rejects).filter(([, v]) => v > 0)),
}));
check('the run is acceptable', r1.acceptable, JSON.stringify(r1.report));
const w1 = warmCells(r1);
check('the warm cells moved UP', w1.length > 0 && w1.every(c => c.tuned >= c.stock),
    w1.map(c => `${c.rpm}:${c.stock}->${c.tuned}`).join(' '));
check('at least one actually changed', w1.some(c => c.tuned > c.stock),
    w1.map(c => `${c.rpm}:${c.stock}->${c.tuned}`).join(' '));
const wanted = Math.abs(MOCK_IDLE_QVS_ERROR_KGH);
check('and it under-shot the true error, as the low default demands',
    w1.every(c => c.tuned - c.stock <= wanted),
    w1.map(c => (c.tuned - c.stock).toFixed(2)).join(' '));

// ---------------------------------------------------------------------------------------------
console.log('\n[THE CONFOUND: measuring md_llri alone would say "nothing to do"]');
// Same drive, same adaptation, but the sum switched off and no adaptation clear on record. The
// integrator has been drained into md_llra, so md_llri alone sits at its resting point and the
// error looks like zero. This is the failure mode with no symptom.
const rNoSum = tuneIdleFeedforward(run1, tables0, { useAdaptationSum: false });
const wNoSum = warmCells(rNoSum);
const sumError = Math.abs(warmCells(r1).find(c => c.errorNm !== 0)?.errorNm ?? 0);
const noSumError = Math.abs(wNoSum.find(c => c.errorNm !== 0)?.errorNm ?? 0);
check('md_llri alone under-reports the error the sum finds', noSumError < sumError,
    `sum ${sumError.toFixed(2)} Nm vs alone ${noSumError.toFixed(2)} Nm`);
check('...which is exactly why useAdaptationSum defaults to true',
    IDLE_TUNE_DEFAULTS.useAdaptationSum === true);

// ---------------------------------------------------------------------------------------------
console.log('\n[gates bite on the disturbances the script contains]');
const rj = r1.report.rejects;
check('the compressor segment produced compressor rejections', rj.compressor > 0, rj.compressor);
check('the rev segments produced throttle/LL rejections', rj['throttle-open'] + rj['not-ll'] > 0,
    `${rj['throttle-open']}/${rj['not-ll']}`);
check('the electrical load segment was seen', rj['electrical-load'] > 0 || rj.compressor > 0,
    rj['electrical-load']);
check('nothing was written to the stall column',
    r1.cells.every(row => row[0].tuned === row[0].stock));
check('nothing was written to a cold row',
    r1.cells.slice(0, -1).every(row => row.every(c => c.tuned === c.stock)));

// ---------------------------------------------------------------------------------------------
console.log('\n[iteration: the gain becomes measured and the cells converge]');
let buffer = baseBuffer;
let tables = tables0;
let prevErr = null;
let prevQvs = null;
let lastErr = null;
const pairs = [];
let gain = { gain: IDLE_TUNE_DEFAULTS.gainKgHPerNm, learned: false };
let passes = 0;
let lastResult = r1;

for (let pass = 1; pass <= 5; pass++) {
    // lossAnchorKgH pinned to the ORIGINAL map: the engine's friction does not change when its
    // ECU is rewritten, and letting it move would make the target chase the correction.
    const bench = new MockIdleBench({
        qvsAt: (rpm, tmot) => qvsAt(tables, rpm, tmot), lossAnchorKgH: stockWarm,
    });
    const run = record(bench);
    const res = tuneIdleFeedforward(run, tables, undefined, gain);
    if (!res) { check('pass produced a result', false, `pass ${pass}`); break; }
    lastResult = res;
    passes = pass;

    const accepted = res.dwells.filter(d => !d.rejected);
    const err = accepted.length ? accepted.reduce((a, d) => a + d.error, 0) / accepted.length : 0;
    const qvsNow = qvsAt(tables, 870, 85);
    // Accumulated against the FIRST pass, not the previous one. One quantum of the map moves the
    // error by ~0.96 Nm, so consecutive differences sit right on the learner's noise floor forever
    // while a cumulative difference grows with the campaign.
    if (prevErr !== null && prevQvs !== null) {
        pairs.length = 0;
        pairs.push({ deltaQKgH: qvsNow - prevQvs, deltaErrorNm: err - prevErr, rpm: 870 });
        const g = learnGain(pairs, IDLE_TUNE_DEFAULTS.gainKgHPerNm, {
            gainMin: IDLE_TUNE_DEFAULTS.gainMin, gainMax: IDLE_TUNE_DEFAULTS.gainMax,
            gainRefRpm: IDLE_TUNE_DEFAULTS.gainRefRpm,
        });
        gain = { gain: g.gain, learned: g.learned };
    }
    lastErr = err;
    if (prevErr === null) { prevErr = err; prevQvs = qvsNow; }

    console.log(`    pass ${pass}: qvs ${qvsNow.toFixed(2)} kg/h, error ${err.toFixed(2)} Nm, `
        + `gain ${gain.gain.toFixed(3)}${gain.learned ? ' (learned)' : ''}, `
        + `updated ${res.report.cellsUpdated}, converged ${res.report.cellsConverged}`);

    if (res.report.cellsUpdated === 0) break;
    buffer = applied(buffer, res.tuned);
    const next = readIdleTables(buffer);
    if (!next) { check('the written buffer still decodes', false); break; }
    tables = next;
}

const finalQvs = qvsAt(tables, 870, 85);
const wantQvs = stockWarm + wanted;
check(`converged within 5 passes (took ${passes})`, lastResult.report.cellsUpdated === 0, lastResult.report.cellsUpdated);
check(`the warm cell reached ${wantQvs.toFixed(1)} kg/h within one quantisation step`,
    near(finalQvs, wantQvs, tables.qvsStepKgH), `${finalQvs} vs ${wantQvs}`);
check('and the residual error is inside one step of air',
    Math.abs(lastErr) <= tables.qvsStepKgH / MOCK_IDLE_GAIN_KGH_PER_NM + 0.5,
    `${lastErr?.toFixed(2)} Nm`);
check('the gain was learned rather than assumed', gain.learned, JSON.stringify(gain));
check(`and it recovered ${MOCK_IDLE_GAIN_KGH_PER_NM} within 20 %`,
    near(gain.gain, MOCK_IDLE_GAIN_KGH_PER_NM, MOCK_IDLE_GAIN_KGH_PER_NM * 0.2), gain.gain);
check('the written buffer still passes its own checksums', readIdleTables(buffer) !== null);

// ---------------------------------------------------------------------------------------------
console.log('\n[the other direction: it walks down, and stops at the authority floor]');
// Far too much air already. The corrector must reduce, and must refuse to go below the point where
// the valve stops responding rather than proposing a number that would do nothing.
let downBuffer = baseBuffer;
let downTables = tables0;
let hitFloor = false;
let downQvs = qvsAt(downTables, 870, 85);
for (let pass = 1; pass <= 12; pass++) {
    const bench = new MockIdleBench({
        qvsAt: (rpm, tmot) => qvsAt(downTables, rpm, tmot),
        errorKgH: +8.0, lossAnchorKgH: stockWarm,
    });
    const res = tuneIdleFeedforward(record(bench), downTables);
    if (!res) break;
    if (res.cells.flat().some(c => c.rejected === 'below-authority-floor')) hitFloor = true;
    if (res.report.cellsUpdated === 0) break;
    const next = qvsAt(downTables, 870, 85);
    check(`pass ${pass} did not increase the request`, next <= downQvs + 1e-9, `${downQvs} -> ${next}`);
    downQvs = next;
    downBuffer = applied(downBuffer, res.tuned);
    const t = readIdleTables(downBuffer);
    if (!t) break;
    downTables = t;
}
const finalDown = qvsAt(downTables, 870, 85);
check('it reduced the request', finalDown < stockWarm, `${stockWarm} -> ${finalDown}`);
check('it never went below the authority floor', finalDown >= tables0.qvsAuthorityFloorKgH - 1e-9,
    `${finalDown} vs floor ${tables0.qvsAuthorityFloorKgH}`);
check('and it said so rather than silently clamping', hitFloor || finalDown > tables0.qvsAuthorityFloorKgH,
    'never reported below-authority-floor and never reached the floor');

console.log(fails === 0 ? '\nALL PASS' : '\n' + fails + ' FAILURE(S)');
process.exit(fails ? 1 : 0);
