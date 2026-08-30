/**
 * The model gate, against a real car.
 *
 * This is the check the whole tuning methodology stands on: before a single byte is derived, the
 * binary's own arithmetic has to reproduce a number the DME computed itself. It is the only test
 * in the suite that exercises the entire chain at once — axis decode, map decode, scaling, the rpm
 * factor, and the density correction — so it is also the only one that can catch an error that
 * every piece-wise test passes.
 *
 * The fixture is 180 real samples from session 920 (a 52-minute drive, coolant 51 -> 90 C), split
 * by the state they were taken in. Real rather than synthetic on purpose: a synthetic sample can
 * only confirm the arithmetic I wrote, and the two errors this gate actually caught — `rawLoad`
 * being AQ_REL rather than the y axis, and RF_PT_KORR being absent — were both invisible to
 * arithmetic and obvious against a car.
 *
 * The binary is the BASE that drive ran against, carried beside the fixture. Comparing a log to any
 * other image is comparing it to a table the DME never read.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BinaryParser } from '../src/lib/binary-engine/parser.ts';
import { readRfPtKorrCurves, rfPtKorr } from '../src/lib/ve-calculator/chargeTemp.ts';
import {
    evaluateModelGate, predictRf, aqRelRf, GATE_MAX_WDK_PCT, GATE_PASS,
} from '../src/lib/ve-calculator/modelGate.ts';
import { findEcuItem } from '../src/lib/ecu-items/catalog/index.ts';
import { LOW_LOAD_TUNE_DEFAULTS } from '../src/lib/ve-calculator/lowLoadTuner.ts';
import { readAlphaNTables, tiBranchAmbiguous } from '../src/lib/ve-calculator/alphaNTable.ts';

let fails = 0;
const check = (n, c, d) => { console.log('  ' + (c ? 'PASS' : 'FAIL') + '  ' + n + (c ? '' : ' — ' + (d ?? ''))); if (!c) fails++; };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const fixture = JSON.parse(fs.readFileSync(here('fixtures/session-920-idle.json'), 'utf8'));
const binPath = here('fixtures/session-920-base.bin');

if (!fs.existsSync(binPath)) {
    console.log('\n  SKIP  fixtures/session-920-base.bin is absent — the gate cannot run without the '
        + 'binary the drive was recorded against.');
    process.exit(0);
}
const buf = fs.readFileSync(binPath);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

const parser = new BinaryParser(ab);
const ve = parser.getVETable();
const fakt = parser.readItem(findEcuItem('kl_aq_rel_rf_fakt'));
const tables = {
    sollRpm: ve.xAxis, sollOpening: ve.yAxis, sollValues: ve.data,
    faktRpm: fakt.x, faktValues: fakt.values,
    ptKorr: readRfPtKorrCurves(ab),
};

console.log('\n[the tables the gate reads]');
check('kf_rf_soll decodes 24 x 20', tables.sollValues.length === 24 && tables.sollValues[0].length === 20,
    `${tables.sollValues.length}x${tables.sollValues[0]?.length}`);
check('its rpm axis carries the idle breakpoint', tables.sollRpm.includes(870), tables.sollRpm.slice(0, 3).join(','));
check('kl_aq_rel_rf_fakt decodes, and is BELOW 1 at idle', tables.faktValues[0] < 1 && tables.faktValues[0] > 0.5,
    tables.faktValues[0]);
check('...which makes aq_rel_rf LARGER than AQ_REL — it is a divisor',
    aqRelRf(tables, 870, 0.30) > 0.30, aqRelRf(tables, 870, 0.30));
check('RF_PT_KORR curves decode', !!tables.ptKorr);

console.log('\n[the density correction, at the conditions the drive saw]');
{
    // 503 m of altitude and a 42-56 C intake: both corrections pull DOWN, and neither is negligible.
    check('a hot intake reduces predicted filling', rfPtKorr(tables.ptKorr, 56, 1013) < rfPtKorr(tables.ptKorr, 20, 1013));
    check('thinner air reduces it too', rfPtKorr(tables.ptKorr, 20, 954) < rfPtKorr(tables.ptKorr, 20, 1013));
    const pt = rfPtKorr(tables.ptKorr, 42.5, 959);
    check('the drive’s own conditions land near 0.98', near(pt, 0.9835, 0.01), pt);
    check('...which is 1.7 %, i.e. three times the resolution of rf — not ignorable', Math.abs(1 - pt) > 0.005);
}

console.log('\n[THE GATE: does the binary reproduce this car’s own rf]');
{
    const r = evaluateModelGate(fixture.idleState, tables);
    console.log(`        ${r.detail}`);
    check('it passes at a settled idle', r.passed, `ratio ${r.ratio?.toFixed(4)} spread ${r.spread?.toFixed(4)}`);
    check('the residual is centred on 1.000', near(r.ratio, 1.0, GATE_PASS.centreTolerance), r.ratio);
    check('...and TIGHT, not merely centred', r.spread < 0.01, r.spread);
    check('it used the samples it was given', r.used >= 100, r.used);
}

console.log('\n[the two readings this gate caught, kept as regressions]');
{
    // 1. rawLoad taken as the y axis directly. Passes every piece-wise test; misses by ~18 %.
    const wrongAxis = { ...tables, faktRpm: [0, 10000], faktValues: [1, 1] };
    const r = evaluateModelGate(fixture.idleState, wrongAxis);
    check('treating rawLoad AS aq_rel_rf fails the gate', !r.passed, `ratio ${r.ratio?.toFixed(4)}`);
    check('...and it fails by being off-centre, which is what names the fault',
        Math.abs(r.ratio - 1) > 0.05, r.ratio);

    // 2. RF_PT_KORR omitted. This one does NOT move the centre, and that is exactly why it survived
    //    so long: the drive spans 42 to 56 C of intake air, the correction pulls the two ends in
    //    opposite directions, and a median over the whole run averages the damage away. What it
    //    does is SCATTER — which is the case the gate's spread bound exists for.
    const flatPt = { tan: { x: [-40, 100], values: [1, 1] }, pUmg: { x: [500, 1200], values: [1, 1] } };
    const withPt = evaluateModelGate(fixture.idleState, tables);
    const noPt = evaluateModelGate(fixture.idleState, { ...tables, ptKorr: flatPt });
    check('omitting RF_PT_KORR barely moves the median — this is the trap',
        Math.abs(noPt.ratio - withPt.ratio) < 0.005, `${withPt.ratio.toFixed(4)} -> ${noPt.ratio.toFixed(4)}`);
    check('...but it nearly doubles the spread, which is what the gate catches',
        noPt.spread > withPt.spread * 1.5, `${withPt.spread.toFixed(4)} -> ${noPt.spread.toFixed(4)}`);

    // The sharpest statement of why the term is real: two segments of the same drive, 14 C apart,
    // agree only when it is applied. A model that reproduces one temperature and not the other is
    // not reproducing the engine.
    const seg = (f) => {
        const g = fixture.idleState.filter(f);
        const r = g.map(x => x.rf / predictRf(tables, x)).sort((a, b) => a - b);
        const rn = g.map(x => x.rf / predictRf({ ...tables, ptKorr: flatPt }, x)).sort((a, b) => a - b);
        return { withPt: r[r.length >> 1], noPt: rn[rn.length >> 1], n: g.length };
    };
    const cold = seg(s => s.coolantTemp < 80), hot = seg(s => s.coolantTemp >= 85);
    check('with it, a 42 C segment and a 56 C segment agree',
        Math.abs(cold.withPt - hot.withPt) < 0.01, `${cold.withPt.toFixed(4)} vs ${hot.withPt.toFixed(4)}`);
    check('without it, the same two segments disagree by ~2.5 %',
        Math.abs(cold.noPt - hot.noPt) > 0.015, `${cold.noPt.toFixed(4)} vs ${hot.noPt.toFixed(4)}`);
}

console.log('\n[where the gate stops being true]');
{
    // Above KL_BZ_WDK_LL the same arithmetic lands 15 % low. The gate must not be quoted there, and
    // the way it refuses is by excluding those samples rather than by averaging them in.
    const r = evaluateModelGate(fixture.partLoad, tables);
    check('part-load samples are all excluded, not judged', r.used === 0 && r.rejected.throttleOpen === fixture.partLoad.length,
        `used ${r.used}, throttleOpen ${r.rejected.throttleOpen}`);
    check('...and the verdict says why rather than passing', !r.passed && /settled idle/.test(r.detail));

    // Judged anyway, they show the term the idle chain does not carry — recorded so the number is
    // not rediscovered from scratch.
    const forced = fixture.partLoad.map(s => ({ ...s, wdk1: 0 }));
    const r2 = evaluateModelGate(forced, tables);
    check('forced through, part load reads ~15 % low', r2.ratio !== null && r2.ratio < 0.9, r2.ratio);
    check('...which is a different fault from noise: it is tight about its own wrong centre',
        r2.spread < 0.05, r2.spread);
}

console.log('\n[the gate refuses rather than guesses]');
{
    check('no tables -> no pass', !evaluateModelGate(fixture.idleState, null).passed);
    check('too few samples -> no pass', !evaluateModelGate(fixture.idleState.slice(0, 5), tables).passed);
    check('...and says how many it needed', /needs 20/.test(evaluateModelGate(fixture.idleState.slice(0, 5), tables).detail));
    const holed = fixture.idleState.map(s => ({ ...s, intakeTemp: undefined }));
    const r = evaluateModelGate(holed, tables);
    check('a missing channel is counted, never defaulted', r.rejected.incomplete === holed.length && !r.passed);
    check('a moving sample is excluded — rf_korr is live above 20 km/h',
        evaluateModelGate(fixture.idleState.map(s => ({ ...s, vehicleSpeed: 40 })), tables).rejected.moving === fixture.idleState.length);
    check('predictRf answers in the log’s own units (percent)',
        predictRf(tables, fixture.idleState[0]) > 5 && predictRf(tables, fixture.idleState[0]) < 60,
        predictRf(tables, fixture.idleState[0]));
    check('the boundary is stated, not inlined', GATE_MAX_WDK_PCT === 1.0);
}

console.log('\n[the terms the gate DROPS, and the proof it may drop them]');
{
    // The gate predicts rf from kf_rf_soll alone. `rf_soll_calc` (master 0x01A9D2) actually carries
    // three more terms, and each is dropped under a stated condition rather than because it is
    // small. Pinned here because the measurement plan in 66-tuning-methodology.md turns on them.
    const dv = new DataView(ab);
    const soll = (r, c) => dv.getUint16(0xD356 + (r * 20 + c) * 2, false) / 1000;
    const kath = (r, c) => dv.getUint16(0xD770 + (r * 20 + c) * 2, false) / 1000;

    // 1. The catalyst-heating blend:
    //      rf_soll_no_filter = kf_rf_soll + (AVAN1_SOLL_FAKTOR * (kf_rf_soll_kath - kf_rf_soll)) >> 14
    //
    // THE TWO TABLES DO NOT SHARE AXES, and comparing them by row index is the mistake this block
    // exists to prevent. kf_rf_soll's y runs 0.098/0.146/0.195/0.391/... and the cold table's runs
    // 0.098/0.195/0.391/0.610/... — no 0.146 — so row 3 is y=0.391 in one and y=0.610 in the other.
    // Read by index the blend looks like +44 % at idle. Read at a common y it is +3.6 %. Both maps
    // must therefore be interpolated at the SAME (rpm, y), never indexed in parallel.
    const rpmS = Array.from({ length: 20 }, (_, i) => dv.getUint16(0xD2FE + i * 2, false));
    const yS = Array.from({ length: 24 }, (_, i) => dv.getUint16(0xD326 + i * 2, false) * 100 / 32768);
    const rpmK = Array.from({ length: 20 }, (_, i) => dv.getUint16(0xD718 + i * 2, false));
    const yK = Array.from({ length: 24 }, (_, i) => dv.getUint16(0xD740 + i * 2, false) * 100 / 32768);
    const lin = (xs, ys, x) => {
        if (x <= xs[0]) return ys[0];
        if (x >= xs[xs.length - 1]) return ys[ys.length - 1];
        for (let i = 0; i < xs.length - 1; i++) {
            if (x >= xs[i] && x <= xs[i + 1]) return ys[i] + (ys[i + 1] - ys[i]) * ((x - xs[i]) / (xs[i + 1] - xs[i]));
        }
        return ys[ys.length - 1];
    };
    const at = (f, xs, ys, rpm, y) => lin(ys,
        Array.from({ length: 24 }, (_, r) => lin(xs, Array.from({ length: 20 }, (_, c) => f(r, c)), rpm)), y);

    check('kf_rf_soll_kath decodes as a second 24x20 table at 0xD770',
        kath(0, 0) > 0 && kath(23, 19) > 0, kath(0, 0) + ' .. ' + kath(23, 19));
    check('the two tables do NOT share a y axis — 0.146 % exists only in the warm one',
        yS.some(v => Math.abs(v - 0.1465) < 0.001) && !yK.some(v => Math.abs(v - 0.1465) < 0.001),
        yS.slice(0, 5).map(v => v.toFixed(3)).join('/') + ' vs ' + yK.slice(0, 5).map(v => v.toFixed(3)).join('/'));
    // Indexed by row the difference is 44 %; that number is an artefact and is kept as a regression.
    check('indexing both by row 3 invents a 44 % blend that is not there',
        Math.abs(kath(3, 1) / soll(3, 1) - 1.44) < 0.02, (kath(3, 1) / soll(3, 1)).toFixed(3));
    // The real blend, at the operating point this car's settled idle actually occupies.
    const opSoll = at(soll, rpmS, yS, 875, 0.4534), opKath = at(kath, rpmK, yK, 875, 0.4534);
    check('at the real idle operating point the blend is small — about 6 %',
        opKath / opSoll > 1.03 && opKath / opSoll < 1.10,
        opSoll.toFixed(4) + ' -> ' + opKath.toFixed(4) + ' (+' + ((opKath / opSoll - 1) * 100).toFixed(1) + ' %)');
    // ...but it is NOT small where catalyst-heating idle actually sits, which is where to measure it.
    const hiSoll = at(soll, rpmS, yS, 1100, 0.391), hiKath = at(kath, rpmK, yK, 1100, 0.391);
    check('...and large at 1100 rpm, which is where a cold-start run can see it', hiKath / hiSoll > 1.3,
        hiSoll.toFixed(4) + ' -> ' + hiKath.toFixed(4) + ' (+' + ((hiKath / hiSoll - 1) * 100).toFixed(0) + ' %)');
    // The blend raises rf, so the gate ratio rises ABOVE 1 during catalyst heating. A run rejected
    // for failing to drop to 0.7 is a correctly recorded run being thrown away.
    check('so the gate ratio during catalyst heating goes ABOVE 1, never to 0.7', hiKath > hiSoll);

    // The third term of rf_soll_calc. Zero in this binary — so it is a term to write as 0, not a
    // term that is absent. It starts acting the moment the gate is extended past the low rows.
    let askSum = 0;
    for (let i = 0; i < 480; i++) askSum += dv.getUint16(0xDB8A + i * 2, false);
    check('kf_rf_soll_ask is zero in all 480 cells here, so the ASK term drops out', askSum === 0, askSum);

    // 2. The MAP integrator. `rf_calc` adds rf_p_saug_i to RF when k_rf_cfg bit 4 is set, which
    //    would be an unmodelled term on every sample. It is clear in the binary this drive ran
    //    against — which is what lets the gate omit it, and why it is NOT the part-load fault.
    const kRfCfg = dv.getUint8(0xE5E4);
    check('k_rf_cfg has bit 4 CLEAR, so no MAP integral reaches RF', (kRfCfg & 0x10) === 0,
        '0x' + kRfCfg.toString(16));
    check('...and bits 0 and 2 too, so RF is pure Alpha-N', (kRfCfg & 0x05) === 0,
        '0x' + kRfCfg.toString(16));

    // 3. The throttle dead zone in `aq_rel_calc` — the only state-dependent branch in the whole aq
    //    chain. It sits at 0.3 %, below both sample populations, so it is not the LL/TL step either.
    const nullage = dv.getUint8(0xD220) / 10;
    check('k_aq_rel_wdk_segm_nullage is below every sample in both populations', nullage < 0.8,
        nullage + ' %');
}

console.log('\n[the AIR side: does the idle valve map reproduce the logged AQ_REL]');
{
    // The gate above proves the binary MEASURES the air correctly. This proves it PRODUCES it —
    // KF_LLS_TV -> duty -> KL_AQ_ABS_LLS -> mm2, plus the throttle's own area, against the same
    // drive's rawLoad. It matters because KF_LLS_TV decides which kf_rf_soll row idle sits in, so
    // LOW LOAD's evidence is only about the row this map puts the engine on.
    const dv = new DataView(ab);
    const u16 = (a) => dv.getUint16(a, false);
    const line = (xs, ys, x) => {
        if (x <= xs[0]) return ys[0];
        if (x >= xs[xs.length - 1]) return ys[ys.length - 1];
        for (let i = 0; i < xs.length - 1; i++) {
            if (x >= xs[i] && x <= xs[i + 1]) {
                return ys[i] + (ys[i + 1] - ys[i]) * ((x - xs[i]) / (xs[i + 1] - xs[i]));
            }
        }
        return ys[ys.length - 1];
    };
    const tvRpm = Array.from({ length: 10 }, (_, i) => u16(0x9DE2 + i * 2));
    const tvMl = Array.from({ length: 13 }, (_, i) => u16(0x9DF6 + i * 2) / 40);
    const tvZ = (r, c) => u16(0x9E10 + (r * 10 + c) * 2) / 50;
    const lsX = Array.from({ length: 8 }, (_, i) => u16(0xE014 + i * 2));
    const lsY = Array.from({ length: 8 }, (_, i) => u16(0xE024 + i * 2));
    const wdkX = Array.from({ length: 8 }, (_, i) => u16(0xE036 + i * 2));
    const wdkY = Array.from({ length: 8 }, (_, i) => u16(0xE046 + i * 2));
    // The reference calibration's own KF_LLS_TV, kept as the thing this binary is compared against.
    const REF = [[14, 14, 14, 14, 14, 14, 14, 14, 14, 14], [23.9, 23.9, 23, 23, 24, 25, 25, 25, 25, 25],
        [33.8, 33.8, 33.6, 33.2, 31, 30, 30, 30, 30, 30], [40.5, 40.5, 38, 37.2, 36.9, 36.6, 36.6, 36.6, 36.6, 36.6]];

    const duty = (z, rpm, ml) => line(tvMl,
        Array.from({ length: 13 }, (_, r) => line(tvRpm, Array.from({ length: 10 }, (_, c) => z(r, c)), rpm)), ml);
    // AQ_REL is AQ_ABS as a percentage of the throttle curve's own full-open area.
    const aqRel = (z, rpm, ml, wdkPct) =>
        (line(lsX, lsY, duty(z, rpm, ml) * 50) + line(wdkX, wdkY, wdkPct * 10)) / wdkY[wdkY.length - 1] * 100;

    const logged = 0.317;   // median rawLoad over the settled idle population of this same drive
    const mine = aqRel(tvZ, 870, 18.35, 0.9);
    const ref = aqRel((r, c) => (REF[r] ? REF[r][c] : tvZ(r, c)), 870, 18.35, 0.9);
    check('this binary’s KF_LLS_TV reproduces the logged AQ_REL at idle',
        Math.abs(mine - logged) < 0.03, `${mine.toFixed(3)} vs logged ${logged}`);
    check('...and the reference calibration’s does NOT — so this map is the one in the car',
        logged - ref > 0.1, `${ref.toFixed(3)} vs logged ${logged}`);
    check('the valve is far more open here than in the reference', duty(tvZ, 870, 18.35) - duty((r, c) => (REF[r] ? REF[r][c] : tvZ(r, c)), 870, 18.35) > 5,
        `${duty(tvZ, 870, 18.35).toFixed(1)} % vs ${duty((r, c) => (REF[r] ? REF[r][c] : tvZ(r, c)), 870, 18.35).toFixed(1)} %`);
    check('...which is roughly double the area, because KL_AQ_ABS_LLS is steepest exactly there',
        line(lsX, lsY, duty(tvZ, 870, 18.35) * 50) / line(lsX, lsY, duty((r, c) => (REF[r] ? REF[r][c] : tvZ(r, c)), 870, 18.35) * 50) > 1.7,
        line(lsX, lsY, duty(tvZ, 870, 18.35) * 50).toFixed(1) + ' mm2');

    // The two structural gaps in the idle controller, pinned so they are not rediscovered.
    const dqp = Array.from({ length: 16 }, (_, i) => dv.getInt16(0x9ADE + i * 2) / 80);
    const tzNeg = Array.from({ length: 16 }, (_, i) => dv.getInt16(0x9D06 + i * 2));
    check('KL_LFR_DQP_POS is zero across the first 60 rpm of droop — a P deadband',
        dqp[0] === 0 && dqp[3] === 0 && dqp[5] > 0, dqp.slice(0, 6).join(', '));
    check('KL_LFR_TZ_NEG is all zero — no ignition pull-back on the overshoot side',
        tzNeg.every(v => v === 0));
    // ...but writing it would change nothing at a straight-ahead idle, and that is the part that
    // matters. lfr_calc 0x026A4C tests MD_RES_LRW_ST bit 1 and clears MD_LLR_TZ unconditionally when
    // it is low; the bit only sets once KL_MD_RES_LRW returns non-zero, and this binary's x axis
    // starts at 460 deg of steering angle — near lock. So the whole fast ignition path, TZ_POS as
    // well as TZ_NEG, is inactive in exactly the state an idle log is recorded in.
    const lrwDeg = Array.from({ length: 4 }, (_, i) => dv.getUint16(0x97D8 + i * 2, false) * 0.04375);
    check('...and the fast ignition path is gated behind ~460 deg of steering, so it is inert at idle',
        lrwDeg[0] > 400, lrwDeg.map(v => v.toFixed(0)).join('/') + ' deg');
}

console.log('\n[LOW LOAD cannot write an idle cell in this build]');
{
    // The single most consequential fact for the procedure, and it is a property of the app rather
    // than of the car: page.tsx calls tuneLowLoad with no options, so requireTiBranchProven is true,
    // and tiBranchAmbiguous is true at every idle operating point because KF_TI_N_RF (1.000 above
    // rf 0.15) and KL_TI_N_ZWD_LL (0.859 at idle rpm) disagree by 0.141. Every idle-band cell is
    // therefore rejected as `ti-branch-unproven` before any correction is even computed.
    const tables = readAlphaNTables(ab);
    // The gate is OFF now. `ti_load_factor` (slave 0x01C6CA) reads the 0.859 curve KL_TI_N_ZWD_LL
    // only while LLS_ST bit 7 is set, and that bit is set by the idle-valve diagnosis — a healthy
    // valve leaves KF_TI_N_RF running. The ambiguity the gate was protecting against is still real
    // as a property of the two tables; what changed is that the CODE says which one runs.
    check('the branch gate is off by default', LOW_LOAD_TUNE_DEFAULTS.requireTiBranchProven === false);
    check('...but the two tables really do still disagree, so the gate has something to guard',
        !!tables && tiBranchAmbiguous(tables, 870, 0.20) && tiBranchAmbiguous(tables, 870, 0.10));
    check('the Alpha-N side tables decode', !!tables);
    // 1 %, against a quantisation step of 0.5 % at the idle cell — kf_rf_soll stores raw/1000, so
    // one bit is 0.001 on a cell holding 0.200. Two steps. It was four while the correction was
    // built from the short-term trim alone and therefore understated the error.
    check('noChangeBand is two quantisation steps of the idle cell, not four',
        Math.abs(LOW_LOAD_TUNE_DEFAULTS.noChangeBand - 0.01) < 1e-9, LOW_LOAD_TUNE_DEFAULTS.noChangeBand);
}

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
