// Pins the idle-valve ring against the notes it was derived from — docs/low_load_surge.md 9.8-9.11
// in the disassembly repo — so that the numbers in that document and the numbers this app computes
// cannot drift apart silently.
//
// What it would cost not to have this:
//
//  - KL_AQ_ABS_LLS is indexed by duty x 50, not duty %. Handing it a percentage lands left of the
//    first breakpoint and returns 0 mm² for every cell, so the whole ring collapses to RF = floor
//    and solveLlsTv happily emits a table of 14 % rails. Nothing throws. The hand-worked cell is
//    the only thing that catches it.
//  - KL_FR_INEG is read from the VALUE run at 0xDFEA. The catalog node is 0xDFDA, the x axis 16
//    bytes earlier, and reading that instead gives Ki = 100 instead of 5.37 — a phase margin off
//    by a factor of twenty, in the safe-looking direction.
//  - The anchor row and the rows outside the measured duty band must not move. The first draft of
//    the notes moved rows 11 and 15 and withdrew it; row 11 in particular carries the strongest
//    empirical evidence on this car, and a solver that quietly rewrites it would undo a change the
//    owner made deliberately.
//  - kf_rf_soll is an input. The two maps are only valid as a matched pair, and a module that
//    wrote both would hide that dependency rather than surface it.
//
// The mock image in public/mock exercises the reader on a real buffer. The measured numbers come
// from scripts/fixtures/session-954-lls.json, baked from the owner's 0645 image and Session 954
// because verify:* has to run on a bare clone — see that file's provenance block.
//
// Runner: node --experimental-strip-types --import ./scripts/ts-resolve.mjs

import { readFileSync } from 'node:fs';
import { buildCatalog } from '../src/lib/calibration/catalog.ts';
import {
    readRingTables, kiAt, aqAbsLlsAt, aqAbsLlsInv, aqRelRfAt, rfSollAt, rfSollInv,
    ringRf, ringElasticity, phaseMargin, solveLlsTv, mlFromAqRel, dutyFromAqRel, withEdits,
    RING_GAIN_DEFAULTS, NOTES_ANCHOR, ringDrift, LLS_TV_STEP_PCT,
} from '../src/lib/lls/ringGain.ts';
import { interp2d } from '../src/lib/idle/idleTables.ts';
import {
    rollingOnly, sampleRateHz, cadenceHz, firstPeriod, summariseSession, reachedRows,
    REFERENCE_BAND, onTarget,
} from '../src/lib/lls/fromLog.ts';
import { composeLlsTv, reachAt, ownerCounts, idleReachIfLlsTakes, WARM_IDLE_POINT } from '../src/lib/lls/composeLlsTv.ts';
import { writeClaimsTune } from '../src/hooks/useBinaryFile.ts';

let fails = 0;
const check = (n, c, d) => { console.log('  ' + (c ? 'PASS' : 'FAIL') + '  ' + n + (c ? '' : ' — ' + d)); if (!c) fails++; };
const near = (a, b, tol) => Number.isFinite(a) && Math.abs(a - b) <= tol;

const fixture = JSON.parse(readFileSync('scripts/fixtures/session-954-lls.json', 'utf8'));
const T = fixture.tables;

// ---- the reader, against a real image -------------------------------------

console.log('\n[the ring reads out of a real image]');
{
    const graph = JSON.parse(readFileSync('public/data/calibration-graph.json', 'utf8'));
    const cat = buildCatalog(graph);
    const bin = readFileSync('public/mock/csl-0401-community-patch-v1.partial.bin');
    const t = readRingTables(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength), cat);

    check('readRingTables returns all six tables', t !== null, 'got null');
    check('KF_LLS_TV is 13 rows x 10 columns', t.llsTv.y.length === 13 && t.llsTv.x.length === 10,
        `${t.llsTv.y.length}x${t.llsTv.x.length}`);
    check('kf_rf_soll is 24 rows x 20 columns', t.rfSoll.y.length === 24 && t.rfSoll.x.length === 20,
        `${t.rfSoll.y.length}x${t.rfSoll.x.length}`);
    check('K_AQ_ABS_MAX is 11918 mm²', t.kAqAbsMaxMm2 === 11918, String(t.kAqAbsMaxMm2));
    check('the duty rails are 14 and 97 %', t.llsTvMinPct === 14 && t.llsTvMaxPct === 97,
        `${t.llsTvMinPct} / ${t.llsTvMaxPct}`);

    // The trap in the header: KL_AQ_ABS_LLS's axis is raw duty counts, not percent.
    check('KL_AQ_ABS_LLS(49.0 %) is 53.85 mm²', near(aqAbsLlsAt(t, 49.0), 53.85, 0.005),
        `${aqAbsLlsAt(t, 49.0).toFixed(3)} — the axis is duty x 50, so 49 % is 2450`);
    check('...and it inverts back to 49.0 %', near(aqAbsLlsInv(t, 53.85), 49.0, 0.005),
        String(aqAbsLlsInv(t, 53.85)));
    // Recovered from the ratio rather than read again, so this pins the divisor the ring actually
    // applies. The stored value is 0.7000122; the notes print it to three places.
    const fakt950 = (aqAbsLlsAt(t, 49.0) / t.kAqAbsMaxMm2 * 100) / aqRelRfAt(t, 950, 49.0);
    check('kl_aq_rel_rf_fakt(950 rpm) is 0.700', near(fakt950, 0.700, 0.001), fakt950.toFixed(7));

    // ---- invariant 4 ------------------------------------------------------
    console.log('\n[KL_FR_INEG comes from the value run at 0xDFEA, not the axis at 0xDFDA]');
    check('Ki at an RF error of 0.015 is 5.37 /s', near(kiAt(t, 0.015), 5.366, 0.01),
        `${kiAt(t, 0.015)} — 100 means the x axis at 0xDFDA was read as the step`);
    check('Ki at 0.03 is 5.00 /s', near(kiAt(t, 0.03), 5.00, 0.01), String(kiAt(t, 0.03)));
    check('Ki at 0.05 is 4.00 /s', near(kiAt(t, 0.05), 4.00, 0.01), String(kiAt(t, 0.05)));
    check('Ki at 0.075 is 2.00 /s', near(kiAt(t, 0.075), 2.00, 0.01), String(kiAt(t, 0.075)));
    check('Ki at 0.1 is 0.80 /s', near(kiAt(t, 0.1), 0.80, 0.01), String(kiAt(t, 0.1)));
    check('Ki falls off the small-error end, so the adopted 5.33 is the peak',
        kiAt(t, 0.015) > kiAt(t, 0.03) && kiAt(t, 0.03) > kiAt(t, 0.1), 'the bell is not descending');
    check('Ki at a zero error refuses rather than dividing by zero', kiAt(t, 0) === null, String(kiAt(t, 0)));
    // The notes adopt 5.33, which is 0.0008 x 100 / 0.015 — their own table rounded the display
    // value to four places first. The image actually holds 422/524288 = 0.00080490, so 5.366.
    check('the adopted default sits within a rounding step of the image', near(RING_GAIN_DEFAULTS.kiPerS, kiAt(t, 0.015), 0.05),
        `default ${RING_GAIN_DEFAULTS.kiPerS} vs image ${kiAt(t, 0.015).toFixed(3)}`);
}

// ---- acceptance 1: the hand-worked cell -----------------------------------

console.log('\n[the hand calculation in 9.9-6, cell by cell]');
{
    const D30 = T.llsTv.values[T.llsTv.y.indexOf(30)][T.llsTv.x.indexOf(950)];
    check('the anchor duty at 950 rpm is 49.0 %', near(D30, 49.0, 0.005), String(D30));
    check('KL_AQ_ABS_LLS(49.0) is 53.85 mm²', near(aqAbsLlsAt(T, D30), 53.85, 0.005), String(aqAbsLlsAt(T, D30)));

    const q30 = aqAbsLlsAt(T, D30) / T.kAqAbsMaxMm2 * 100;
    check('AQ_REL is 0.4518 %', near(q30, 0.4518, 0.0001), q30.toFixed(5));

    const y30 = aqRelRfAt(T, 950, D30);
    check('aq_rel_rf is 0.6455 %', near(y30, 0.6455, 0.0001), y30.toFixed(5));

    const rf30 = rfSollAt(T, 950, y30);
    check('RF at the anchor is 0.2734', near(rf30, 0.2734, 0.0001), rf30.toFixed(5));

    const k = rf30 / 30;
    check('k is 0.009114 RF per kg/h', near(k, 0.009114, 0.0000005), k.toFixed(7));
    check('the target RF at ml = 20 is 0.1823', near(k * 20, 0.1823, 0.0001), (k * 20).toFixed(5));

    const y = rfSollInv(T, 950, k * 20);
    check('kf_rf_soll inverts to aq_rel_rf 0.3875 %', near(y, 0.3875, 0.0002), String(y));

    const area = y * 0.700 / 100 * T.kAqAbsMaxMm2;
    check('the area is 32.32 mm²', near(area, 32.32, 0.01), area.toFixed(3));
    check('ACCEPTANCE 1 — 950 rpm / 20 kg/h solves to 39.0 % (was 40.0)',
        near(aqAbsLlsInv(T, area), 39.0, 0.05), String(aqAbsLlsInv(T, area)));
}

// ---- acceptance 2: the whole inverse table --------------------------------

console.log('\n[the inverse table in 9.8]');
{
    // XDF display %, exactly as the notes print them.
    const DOC = {
        20: { 800: 37.7, 950: 39.0, 1400: 41.5, 1700: 42.9 },
        25: { 800: 46.2, 950: 44.5, 1400: 44.7, 1700: 46.0 },
        40: { 800: 63.5, 950: 54.8, 1400: 54.5, 1700: 55.5 },
        50: { 800: 97.0, 950: 66.0, 1400: 62.5, 1700: 65.1 },
    };
    const BEFORE = {
        20: { 800: 40.0, 950: 40.0, 1400: 38.0, 1700: 37.0 },
        25: { 800: 45.0, 950: 44.0, 1400: 43.0, 1700: 43.0 },
        40: { 800: 65.0, 950: 58.0, 1400: 55.0, 1700: 54.0 },
        50: { 800: 97.0, 950: 83.0, 1400: 62.5, 1700: 60.2 },
    };
    // Solved on the NOTES' anchor, not the shipped default. The published table is an anchor-30
    // result, and it has to stay reproducible after the default moved to 20 — otherwise the one
    // check tying this code to the derivation it came from would have been quietly deleted.
    const edits = solveLlsTv(T, NOTES_ANCHOR);
    check('the solver returns 16 cells on the notes anchor', edits.length === 16, String(edits.length));

    let off = 0;
    for (const e of edits) {
        if (!near(e.afterPct, DOC[e.mlKgH][e.rpm], 0.05)) off++;
        if (!near(e.beforePct, BEFORE[e.mlKgH][e.rpm], 0.005)) off++;
    }
    check('ACCEPTANCE 2 — every cell matches 9.8 to its printed precision', off === 0, `${off} cells off`);

    // The two the notes call out as unchanged, for the two different reasons.
    const at = (ml, rpm) => edits.find(e => e.mlKgH === ml && e.rpm === rpm);
    check('800 / 50 stays at 97.0, held by K_LLS_TV_MAX', near(at(50, 800).afterPct, 97.0, 0.005),
        String(at(50, 800).afterPct));
    check('1400 / 50 lands back on 62.5 on its own', near(at(50, 1400).afterPct, 62.5, 0.05),
        String(at(50, 1400).afterPct));
    check('950 / 50 is the big mover, 83.0 to 66.0', near(at(50, 950).afterPct, 66.0, 0.05),
        String(at(50, 950).afterPct));

    // ---- invariants 1 and 2, on whatever anchor is shipped ----------------
    console.log('\n[the anchor holds and nothing outside the measured band moves]');

    // Stated against RING_GAIN_DEFAULTS rather than a literal, so moving the anchor cannot leave
    // these checks pinning a row nobody holds any more.
    const ANCHOR = RING_GAIN_DEFAULTS.anchorMlKgH;
    const WRITABLE = [...RING_GAIN_DEFAULTS.writableMlKgH].sort((a, b) => a - b);
    const live = solveLlsTv(T);

    check('the shipped anchor is row 20, the row this car idles on', ANCHOR === 20, String(ANCHOR));
    check('the anchor is never also writable', !WRITABLE.includes(ANCHOR), WRITABLE.join(','));
    check('the writable rows never reach below the measured band',
        !WRITABLE.some(ml => ml < 20), WRITABLE.join(','));

    check('INVARIANT 1 — no edit touches the anchor row',
        live.every(e => e.mlKgH !== ANCHOR), 'the anchor was rewritten');

    const after = withEdits(T, live);
    const rA = T.llsTv.y.indexOf(ANCHOR);
    check('...and the anchor row is identical after applying them',
        after.llsTv.values[rA].every((v, i) => v === T.llsTv.values[rA][i]), 'the anchor row moved');
    check('...so the commanded duty at warm idle does not move at all',
        near(interp2d(after.llsTv, 880, 18.15), interp2d(T.llsTv, 880, 18.15), 1e-9),
        `${interp2d(T.llsTv, 880, 18.15)} -> ${interp2d(after.llsTv, 880, 18.15)}`);

    const touched = [...new Set(live.map(e => e.mlKgH))].sort((a, b) => a - b);
    check('INVARIANT 2 — only the writable rows are written',
        touched.join(',') === WRITABLE.join(','), `${touched.join(',')} vs ${WRITABLE.join(',')}`);

    const untouched = T.llsTv.y.filter(ml => !WRITABLE.includes(ml));
    check('...so rows 11, 15, 20 and 60 upward are byte-identical',
        untouched.every(ml => {
            const r = T.llsTv.y.indexOf(ml);
            return after.llsTv.values[r].every((v, i) => v === T.llsTv.values[r][i]);
        }), 'a row outside the band moved');

    check('every solved duty is inside the rails',
        live.every(e => e.afterPct >= T.llsTvMinPct && e.afterPct <= T.llsTvMaxPct)
        && edits.every(e => e.afterPct >= T.llsTvMinPct && e.afterPct <= T.llsTvMaxPct),
        'a cell escaped the rails');

    // The anchor is NOT only a level, and this is the check that proved it. The target RF = k*ML
    // is the same relation either way, but the map interpolates duty linearly while duty to RF is
    // not linear, so between breakpoints the realised elasticity depends on which rows were solved
    // and on k. Pinned as a measured difference rather than an assumed equivalence.
    const notesTab = withEdits(T, edits);
    const flatness = (tab) => {
        let sum = 0;
        let n = 0;
        for (let ml = 20; ml <= 50; ml += 0.25) {
            const e = ringElasticity(tab, 950, ml);
            if (e !== null) { sum += Math.abs(e - 1); n++; }
        }
        return n ? sum / n : null;
    };
    const fStock = flatness(T);
    const fNotes = flatness(notesTab);
    const fShipped = flatness(after);
    check('both anchors flatten the ring well clear of stock',
        fNotes < fStock * 0.6 && fShipped < fStock * 0.7, `stock ${fStock} notes ${fNotes} shipped ${fShipped}`);
    check('the notes anchor flattens it further — 0.202 against 0.285',
        near(fNotes, 0.202, 0.01) && near(fShipped, 0.285, 0.01) && fNotes < fShipped,
        `notes ${fNotes?.toFixed(4)} shipped ${fShipped?.toFixed(4)}`);
    check('...which is the price of an undisturbed idle, and it is on the record',
        near(fStock, 0.466, 0.01), fStock?.toFixed(4));

    // ---- invariant 3 ------------------------------------------------------
    console.log('\n[kf_rf_soll is an input and stays one]');
    const src = readFileSync('src/lib/lls/ringGain.ts', 'utf8');
    const writers = ['alphaNTable', 'calibration/apply', 'calibration/edits', 'setEcuMapValues', 'buildPatchedBuffer'];
    const found = writers.filter(w => src.includes(w));
    check('INVARIANT 3 — the module imports no map writer', found.length === 0, found.join(' '));
    check('...and solveLlsTv leaves kf_rf_soll untouched',
        after.rfSoll.values.every((row, r) => row.every((v, c) => v === T.rfSoll.values[r][c])), 'kf_rf_soll changed');

    const snapshot = JSON.stringify(T.llsTv.values);
    solveLlsTv(T);
    check('...and does not mutate the tables it was handed', JSON.stringify(T.llsTv.values) === snapshot,
        'solveLlsTv mutated its input');
}

// ---- acceptance 3: the session replay -------------------------------------

console.log('\n[the 320 measured points, replayed]');
{
    check('the log is 362 rows', fixture.samples.length === 362, String(fixture.samples.length));
    const pts = rollingOnly(fixture.samples);
    check('the rolling section is 320 points', pts.length === 320, String(pts.length));

    const sorted = v => [...v].sort((a, b) => a - b);
    const pct = (v, p) => v[Math.min(v.length - 1, Math.floor(p * (v.length - 1)))];
    const mean = v => v.reduce((s, x) => s + x, 0) / v.length;

    // The operating band the notes read off this session, and which decided the writable rows.
    const duty = sorted(pts.map(p => dutyFromAqRel(T, p.aqRelPct)));
    const ml = sorted(pts.map(p => mlFromAqRel(T, p.rpm, p.aqRelPct)));
    check('the measured duty band is 36 to 66 %', near(duty[0], 36.5, 0.5) && near(duty[duty.length - 1], 65.6, 0.5),
        `${duty[0].toFixed(1)} to ${duty[duty.length - 1].toFixed(1)}`);
    check('the measured air band is 18.5 to 45.3 kg/h', near(ml[0], 18.5, 0.1) && near(ml[ml.length - 1], 45.3, 0.1),
        `${ml[0].toFixed(2)} to ${ml[ml.length - 1].toFixed(2)}`);
    check('...with p5 19.2 and p95 36.4', near(pct(ml, 0.05), 19.2, 0.1) && near(pct(ml, 0.95), 36.4, 0.1),
        `${pct(ml, 0.05).toFixed(2)} / ${pct(ml, 0.95).toFixed(2)}`);
    check('every point sits inside rows 20 to 50, so the writable set covers the session',
        ml[0] >= 20 - 2 && ml[ml.length - 1] <= 50, `${ml[0].toFixed(1)} to ${ml[ml.length - 1].toFixed(1)}`);

    const e0 = sorted(pts.map(p => ringElasticity(T, p.rpm, mlFromAqRel(T, p.rpm, p.aqRelPct))));
    check('elasticity before is 1.34 mean', near(mean(e0), 1.34, 0.01), mean(e0).toFixed(3));
    check('...1.36 median', near(pct(e0, 0.5), 1.36, 0.01), pct(e0, 0.5).toFixed(3));
    check('...1.61 at p90', near(pct(e0, 0.9), 1.61, 0.01), pct(e0, 0.9).toFixed(3));
    check('...and 88.4 % of points above 1.0',
        near(100 * e0.filter(x => x > 1).length / e0.length, 88.4, 0.1),
        (100 * e0.filter(x => x > 1).length / e0.length).toFixed(1));

    // The logged opening is the measurement, so after the rewrite the same duty is reached by a
    // different ML request — ml is re-derived through whichever table is being evaluated. Holding
    // the old ml instead reports 33.7 at p10 rather than 37.0, and is the wrong question.
    const margins = tab => sorted(pts
        .map(p => phaseMargin(tab, p.rpm, mlFromAqRel(tab, p.rpm, p.aqRelPct), { measuredRf: p.rf }))
        .filter(Boolean).map(x => x.pmDeg));

    const before = margins(T);
    check('phase margin before is 39 deg mean', near(mean(before), 39, 1), mean(before).toFixed(1));
    check('...38 median', near(pct(before, 0.5), 38, 1), pct(before, 0.5).toFixed(1));
    check('...26 at p10', near(pct(before, 0.1), 26, 1), pct(before, 0.1).toFixed(1));
    check('...and 25.3 % of points below 30 deg',
        near(100 * before.filter(x => x < 30).length / before.length, 25.3, 0.2),
        (100 * before.filter(x => x < 30).length / before.length).toFixed(1));

    // The notes' own anchor, which is what 9.9-8 measured.
    const after = margins(withEdits(T, solveLlsTv(T, NOTES_ANCHOR)));
    check('ACCEPTANCE 3 — phase margin after is 47 deg mean', near(mean(after), 47, 1), mean(after).toFixed(1));
    check('...48 median', near(pct(after, 0.5), 48, 1), pct(after, 0.5).toFixed(1));
    check('...37 at p10', near(pct(after, 0.1), 37, 1), pct(after, 0.1).toFixed(1));
    check('...and the tail below 30 deg shrinks from 25.3 % to 2.8 %',
        near(100 * after.filter(x => x < 30).length / after.length, 2.8, 0.2),
        (100 * after.filter(x => x < 30).length / after.length).toFixed(1));

    // And what the SHIPPED anchor actually buys, which is less. Pinned separately so the trade is
    // on the record rather than inferred from the anchor-30 numbers above.
    const shipped = margins(withEdits(T, solveLlsTv(T)));
    const shippedThin = 100 * shipped.filter(x => x < 30).length / shipped.length;
    check('the shipped anchor 20 reaches 45.9 deg mean, not 47.0', near(mean(shipped), 45.9, 0.5),
        mean(shipped).toFixed(1));
    check('...33 at p10, against 37 on the notes anchor', near(pct(shipped, 0.1), 33.0, 0.5),
        pct(shipped, 0.1).toFixed(1));
    check('...and leaves 7.2 % under 30 deg, against 2.8 %', near(shippedThin, 7.2, 0.3),
        shippedThin.toFixed(1));
    check('...still a large improvement on the 25.3 % it started from',
        shippedThin < 10 && mean(shipped) > mean(before) + 5,
        `${shippedThin.toFixed(1)} % / +${(mean(shipped) - mean(before)).toFixed(1)} deg`);
    // The body of the distribution is what the fix is for, and it moves as a block: +11.4 at p10
    // down to +4.5 at p80.
    check('the margin improves right through p10 to p80', [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]
        .every(p => pct(after, p) - pct(before, p) > 4), 'a decile in the body gained less than 4 deg');

    // And the top end loses, which is the trade this solution makes rather than a defect in it.
    // 9.9-4: omegaC scales with RF as well as with e, so levelling the elasticity RAISES it where
    // it used to sit below 1 — the high-filling end. Pinned so the cost stays visible: a change
    // that moved these would be changing the shape of the answer, not just tightening it.
    check('the top decile erodes, as 9.9-4 predicts for a uniform elasticity',
        pct(after, 0.9) < pct(before, 0.9) && pct(after, 0.9) > 55,
        `${pct(before, 0.9).toFixed(1)} -> ${pct(after, 0.9).toFixed(1)}`);
    check('...and the worst single point stays the worst',
        after[0] < before[0] && before[0] < 0,
        `${before[0].toFixed(1)} -> ${after[0].toFixed(1)}`);

    // ringRf and phaseMargin have to refuse rather than invent when a channel is missing.
    check('a non-finite rpm has no ring', ringRf(T, NaN, 30) === null, 'NaN rpm answered');
    check('a non-finite air mass has no elasticity', ringElasticity(T, 950, NaN) === null, 'NaN ml answered');
    check('a zero air mass has no elasticity', ringElasticity(T, 950, 0) === null, 'zero ml answered');
}

// ---- what the drive itself measures ---------------------------------------

console.log('\n[the session, read as a drive rather than a set of points]');
{
    const all = fixture.samples;
    const s = summariseSession(T, all);

    check('the stopped rows are dropped, 362 to 320', s.samples === 362 && s.rolling === 320,
        `${s.samples} -> ${s.rolling}`);

    // Two rates, because they answer different questions and only one converts a lag.
    check('the cadence is 5.17 Hz', near(s.cadenceHz, 5.17, 0.02), String(s.cadenceHz));
    check('the mean rate is 4.29 Hz, lower because samples were dropped',
        near(s.sampleRateHz, 4.29, 0.02) && s.sampleRateHz < s.cadenceHz, String(s.sampleRateHz));
    check('a rate is refused rather than guessed from one sample',
        sampleRateHz(all.slice(0, 1)) === null && cadenceHz(all.slice(0, 2)) === null, 'answered anyway');
    check('a zero time span is refused, and so is a NaN one',
        sampleRateHz([{ tS: 5, speedKmH: 1 }, { tS: 5, speedKmH: 1 }]) === null
        && sampleRateHz([{ tS: NaN, speedKmH: 1 }, { tS: 1, speedKmH: 1 }]) === null, 'answered anyway');

    // ACCEPTANCE-adjacent: Td is the one constant the phase margin rests on, and it is measured.
    // The notes' 0.58 s is the INTEGER peak; the sub-sample refinement puts the vertex at 0.63.
    // Both are pinned, and so is the step they live inside, because a refinement smaller than one
    // step would not be evidence of anything.
    check('Td at whole-sample resolution is the notes 0.58 s',
        s.td !== null && near(s.td.coarseLagS, 0.58, 0.02), s.td ? `${s.td.coarseLagS} s` : 'null');
    check('...refined sub-sample it is 0.63 s', s.td !== null && near(s.td.lagS, 0.63, 0.02),
        s.td ? `${s.td.lagS} s` : 'null');
    check('...and the refinement stays inside one lag step',
        s.td !== null && Math.abs(s.td.lagS - s.td.coarseLagS) <= s.td.stepS,
        s.td ? `${Math.abs(s.td.lagS - s.td.coarseLagS)} vs step ${s.td.stepS}` : 'null');
    check('...and duty leads rpm, so the sign says the valve moves first',
        s.td !== null && s.td.lagS > 0 && s.td.r > 0, s.td ? `lag ${s.td.lagS} r ${s.td.r}` : 'null');
    check('Td converts on the cadence, not the mean rate — the mean would report 0.70 s',
        near(0.58 * (s.cadenceHz / s.sampleRateHz), 0.70, 0.02),
        String(0.58 * (s.cadenceHz / s.sampleRateHz)));
    check('this log is reconstructed, not read — it predates the ring channels',
        s.source === 'reconstructed', s.source);
    check('...so it carries no FR_REGLER, and says so rather than showing zero',
        s.frRegler === null, JSON.stringify(s.frRegler));

    // 9.4: over a whole session there is no clean periodicity. A weak peak is the finding.
    check('the whole-log period peak is weak, under r = 0.24', s.period !== null && s.period.r < 0.24,
        s.period ? String(s.period.r) : 'null');
    check('a period peak must be a positive correlation',
        firstPeriod([1, -1, 1, -1, 1, -1, 1, -1, 1, -1, 1, -1, 1, -1, 1, -1, 1, -1], 2, 8, 5) === null
        || firstPeriod([1, -1, 1, -1, 1, -1, 1, -1, 1, -1, 1, -1, 1, -1, 1, -1, 1, -1], 2, 8, 5).r > 0,
        'an anticorrelated turning point was returned as a period');

    // The rows a solve may write are derived from the drive, not from the notes.
    // Derived from the drive, with the anchor excluded because it is held by definition. On the
    // notes anchor that is 20/25/40/50; on the shipped one, 25/30/40/50. Either way the SET the
    // band reaches is the same five rows — which anchor holds one of them is the only difference.
    // reachedRows now reports the DRIVE and nothing else — it used to subtract the anchor, which
    // made it depend on a choice that has nothing to do with where the car went.
    const reached = reachedRows(T, rollingOnly(all));
    check('the drive reached rows 20 / 25 / 30 / 40 / 50',
        reached.join(',') === '20,25,30,40,50', reached.join(','));
    check('...and it does not depend on the anchor',
        reachedRows(T, rollingOnly(all)).join(',') === reached.join(','), 'the anchor leaked in');

    // Whatever the anchor, the solver writes the reached rows minus that one.
    for (const anchor of [20, 30]) {
        const written = [...new Set(solveLlsTv(T, { anchorMlKgH: anchor, writableMlKgH: reached })
            .map(e => e.mlKgH))].sort((a, b) => a - b);
        check(`anchor ${anchor}: the solver writes the reached rows minus the anchor`,
            written.join(',') === reached.filter(r => r !== anchor).join(','),
            `${written.join(',')} vs ${reached.filter(r => r !== anchor).join(',')}`);
    }

    check('the measured band agrees with the point replay', near(s.ml.min, 18.5, 0.1) && near(s.ml.max, 45.3, 0.1),
        `${s.ml.min} to ${s.ml.max}`);
    check('the thin-margin share is the same 25.3 %', near(s.thinMarginShare * 100, 25.3, 0.2),
        String(s.thinMarginShare * 100));
    check('an empty drive reports nothing rather than zero',
        summariseSession(T, []).sampleRateHz === null && summariseSession(T, []).td === null,
        'zeros were reported');
}

// ---- two workflows, one table --------------------------------------------

console.log('\n[KF_LLS_TV has exactly one owner per cell]');
{
    const stock = T.llsTv.values;
    const axes = { rpm: T.llsTv.x, mlKgH: T.llsTv.y };
    const edits = solveLlsTv(T);
    const r = (ml) => T.llsTv.y.indexOf(ml);
    const c = (rpm) => T.llsTv.x.indexOf(rpm);

    // What IDLE does on this car: it moves the rows warm evidence reaches, 15 and 20.
    const idleProposal = stock.map(row => [...row]);
    idleProposal[r(15)][c(800)] += 1.4;
    idleProposal[r(15)][c(950)] += 1.4;
    idleProposal[r(20)][c(800)] += 1.2;
    idleProposal[r(20)][c(950)] += 1.2;

    check('nothing armed composes to nothing, so BASE is not rewritten',
        composeLlsTv(stock, { idle: null, lls: null }, axes) === null, 'a table was produced anyway');
    check('an empty LLS edit list is also nothing',
        composeLlsTv(stock, { idle: null, lls: [] }, axes) === null, 'a table was produced anyway');

    {
        const only = composeLlsTv(stock, { idle: null, lls: edits }, axes);
        const n = ownerCounts(only.owner);
        check('LLS alone owns its 16 cells and claims nothing else',
            n.lls === 16 && n.idle === 0 && n.base === 130 - 16, JSON.stringify(n));
        check('...and every other cell still reads BASE',
            only.values.every((row, i) => row.every((v, j) =>
                only.owner[i][j] === 'lls' || v === stock[i][j])), 'a BASE cell moved');
    }

    {
        const only = composeLlsTv(stock, { idle: idleProposal, lls: null }, axes);
        const n = ownerCounts(only.owner);
        check('IDLE alone owns only the four cells it moved', n.idle === 4 && n.lls === 0, JSON.stringify(n));
        check('a proposed cell identical to BASE is not a claim',
            only.owner[r(25)][c(800)] === 'base', only.owner[r(25)][c(800)]);
        check('...and with LLS unarmed, IDLE reaches all of its operating point',
            near(reachAt(T.llsTv, only.owner, 'idle', 880, 18.15), 1.0, 1e-9),
            String(reachAt(T.llsTv, only.owner, 'idle', 880, 18.15)));
    }

    // The shipped anchor holds row 20, so LLS never claims it and there is nothing to arbitrate.
    // That is the point of anchoring there: the collision was created by the constant, not by the
    // two modes wanting the same thing.
    {
        const both = composeLlsTv(stock, { idle: idleProposal, lls: edits }, axes);
        check('on the shipped anchor the two modes do not contend at all', both.cededCells === 0,
            `${both.cededCells} cells ceded`);
        check('...IDLE keeps both of the rows it moved', both.owner[r(15)][c(800)] === 'idle'
            && both.owner[r(20)][c(800)] === 'idle' && both.owner[r(20)][c(950)] === 'idle',
            `${both.owner[r(15)][c(800)]} / ${both.owner[r(20)][c(800)]}`);
        check('...so its reach at warm idle stays whole', 
            near(reachAt(T.llsTv, both.owner, 'idle', 880, 18.15), 1.0, 1e-9),
            String(reachAt(T.llsTv, both.owner, 'idle', 880, 18.15)));
        check('...and LLS still owns its own four rows',
            ownerCounts(both.owner).lls === 16, JSON.stringify(ownerCounts(both.owner)));
        check('no cell is owned twice and every cell is accounted for',
            ownerCounts(both.owner).base + ownerCounts(both.owner).idle + ownerCounts(both.owner).lls === 130,
            JSON.stringify(ownerCounts(both.owner)));
    }

    // Move the anchor back to the notes value and the contention returns — which is what the
    // composer is for. It stays because the anchor is a choice, and the other choice collides.
    {
        const notesEdits = solveLlsTv(T, NOTES_ANCHOR);
        const both = composeLlsTv(stock, { idle: idleProposal, lls: notesEdits }, axes);
        check('on the notes anchor LLS takes row 20, and the cession is counted',
            both.owner[r(20)][c(800)] === 'lls' && both.owner[r(20)][c(950)] === 'lls' && both.cededCells === 2,
            `${both.owner[r(20)][c(800)]} / ${both.owner[r(20)][c(950)]} / ceded ${both.cededCells}`);
        check('...IDLE keeps row 15, which LLS never claims either way',
            both.owner[r(15)][c(800)] === 'idle' && near(both.values[r(15)][c(800)], stock[r(15)][c(800)] + 1.4, 1e-9),
            both.owner[r(15)][c(800)]);
        check('...and the row-20 value is the solve, not the idle nudge',
            near(both.values[r(20)][c(950)], notesEdits.find(e => e.mlKgH === 20 && e.rpm === 950).afterPct, 1e-9),
            String(both.values[r(20)][c(950)]));

        // The number the whole arbitration turns on, computed from the DME's own corners.
        const reach = reachAt(T.llsTv, both.owner, 'idle', 880, 18.15);
        check('IDLE reach at warm idle falls to 37 %, exactly the documented shortfall',
            near(reach * 100, 37, 1), (reach * 100).toFixed(1) + ' %');
        const llsReach = reachAt(T.llsTv, both.owner, 'lls', 880, 18.15);
        check('...which is the row-20 weight of 63 % changing hands', near(llsReach * 100, 63, 1),
            (llsReach * 100).toFixed(1) + ' %');
        check('...and the two shares account for the whole operating point',
            near(reach + llsReach, 1, 1e-9), String(reach + llsReach));
    }

    // An edit list carries axis values, so it cannot land on a same-indexed cell of another image.
    {
        const shifted = { rpm: T.llsTv.x, mlKgH: T.llsTv.y.map(v => v + 1) };
        const out = composeLlsTv(stock, { idle: null, lls: edits }, shifted);
        check('edits that match no breakpoint are dropped rather than placed by index',
            out === null || ownerCounts(out.owner).lls === 0,
            JSON.stringify(out && ownerCounts(out.owner)));
    }
}

// ---- one verdict, live and afterwards -------------------------------------

console.log('\n[the operating point a drive has to hit to be comparable]');
{
    const s = summariseSession(T, fixture.samples);
    const at = (o) => onTarget(REFERENCE_BAND, o);

    // 954 IS the reference, so it must largely pass its own band. Not all of it: the band is p5-p95
    // of this very drive, so a tenth sits outside by construction and a check demanding 100 % would
    // be demanding something the definition rules out.
    check('954 is mostly inside the band it defines',
        s.onTargetShare !== null && s.onTargetShare > 0.6, String(s.onTargetShare));
    check('...but not all of it, because the band is p5 to p95 of itself',
        s.onTargetShare !== null && s.onTargetShare < 1, String(s.onTargetShare));

    // The three drives that could not be compared, as coordinates rather than as a story.
    check('954 at its own median is on point',
        at({ rpm: 1162, speedKmH: 10, airKgH: 28, throttlePct: 0 }).all,
        'the reference misses its own centre');
    check('957 at 900 rpm / 6 km/h is out on BOTH rpm and speed',
        !at({ rpm: 900, speedKmH: 6, airKgH: 22, throttlePct: 0 }).speed
        && !at({ rpm: 900, speedKmH: 6, airKgH: 22, throttlePct: 0 }).rpm,
        'the drive that could not be compared reads as comparable');
    check('956 at 932 rpm / 7 km/h is out on speed',
        !at({ rpm: 932, speedKmH: 7, airKgH: 25, throttlePct: 0 }).all, 'reads as comparable');

    // An open throttle is not a micro-throttle sample whatever else it looks like.
    check('an open throttle fails the gate',
        !at({ rpm: 1100, speedKmH: 10, airKgH: 28, throttlePct: 3 }).throttle, 'a throttled sample passed');

    // A channel that is not there cannot fail. An absent reading is not evidence of being off.
    check('a missing channel neither passes nor fails on its own',
        at({ rpm: 1100, speedKmH: 10 }).all && at({}).all, 'an absent channel was scored');

    // The rule the whole arrangement exists for: the live gate is not a second opinion.
    const strip = readFileSync('src/components/LlsLiveStrip.tsx', 'utf8');
    check('the live strip imports the verdict rather than restating it',
        /import[^;]*onTarget[^;]*from '@\/lib\/lls\/fromLog'/.test(strip),
        'LlsLiveStrip does not import onTarget from fromLog');
    check('...and carries no thresholds of its own',
        !/rpmMin\s*[:=]\s*\d/.test(strip), 'the strip states its own band');
}

// ---- what an anchor costs the other mode ----------------------------------

console.log('\n[the anchor is a choice, and its cost is computable before it is armed]');
{
    const idleRows = [15, 20];   // where warm evidence reaches on this car (idle/tuner.ts)
    const pct = (rows) => {
        const v = idleReachIfLlsTakes(T.llsTv, rows);
        return v === null ? null : Math.round(v * 100);
    };
    check('the warm idle point is 880 rpm / 18.15 kg/h',
        WARM_IDLE_POINT.rpm === 880 && WARM_IDLE_POINT.mlKgH === 18.15, JSON.stringify(WARM_IDLE_POINT));
    check('LLS taking neither of IDLE rows leaves it whole', pct([]) === 100, String(pct([])));
    check('...taking row 20 leaves 37 %', pct([20]) === 37, String(pct([20])));
    check('...taking row 15 leaves 63 %', pct([15]) === 63, String(pct([15])));
    check('...and taking BOTH leaves nothing at all', pct(idleRows) === 0, String(pct(idleRows)));

    // The two shares are the row weights, so they must complete each other.
    check('the two rows account for the whole point',
        pct([20]) + pct([15]) === 100, `${pct([20])} + ${pct([15])}`);

    // A row the drive never reached cannot be taken, whatever the anchor is set to.
    const reached = reachedRows(T, rollingOnly(fixture.samples));
    check('row 11 is never written, because no drive has reached it',
        !reached.includes(11) && !solveLlsTv(T, { writableMlKgH: reached }).some(e => e.mlKgH === 11),
        'row 11 was written');

    // The panel must be able to say this, not just compute it.
    const panel = readFileSync('src/components/LlsPanel.tsx', 'utf8');
    check('the panel states the cost rather than only the cell count',
        panel.includes('idleReach') && /idleZero/.test(panel), 'no idle-reach line on the panel');
    check('...and the anchor is selectable there',
        /onAnchorChange/.test(panel) && /<select/.test(panel), 'the anchor is not on the surface');
}

// ---- the hub can actually reach the write ---------------------------------

console.log('\n[a mode whose artifact is not a VE map still has a way to WRITE]');
{
    /*
     * The defect this pins, twice over.
     *
     * The hub's action is one long conditional whose first test is `newMap`. A run that derives no
     * VE map falls through it and lands on `tune`, so the ring offers START TUNE while a proposal
     * sits armed and WRITE is unreachable. IDLE hit this, was fixed, and the fix carried a comment
     * saying exactly what had gone wrong — and LLS reproduced it anyway, because the comment lived
     * in a branch nobody had to touch to add a second such mode (operator, 2026-09-22).
     *
     * Structural, reading the source, because the expression sits inside a React component with no
     * seam to call. The extraction fails loudly rather than finding nothing.
     */
    const page = readFileSync('src/app/page.tsx', 'utf8');
    const start = page.indexOf('const idleAction');
    const end = page.indexOf(": 'read';", start);
    check('the hub action chain was found', start >= 0 && end > start, `${start} / ${end}`);
    const chain = page.slice(start, end);

    for (const mode of ['IDLE', 'LLS']) {
        const at = chain.indexOf(`logProcess === '${mode}'`);
        check(`${mode} has its own branch in the chain`, at >= 0, 'no branch — it will fall through to tune');
        check(`...and it is tested BEFORE newMap`, at >= 0 && at < chain.indexOf('newMap ?'),
            'the VE test runs first, so this mode can never reach a write');
    }
    check('the LLS branch offers a write when its proposal has cells',
        /logProcess === 'LLS'[\s\S]{0,600}llsMovedCells > 0[\s\S]{0,120}'writePatch'/.test(chain),
        'the LLS branch does not reach writePatch on its own proposal');
    check('...and falls back to starting a run, not to READ, when the image decodes',
        /logProcess === 'LLS'[\s\S]{0,900}llsTables && currentSession[\s\S]{0,60}'tune'/.test(chain),
        'no route to START TUNE in LLS mode');
}

// ---- a write that carries a table says so ---------------------------------

console.log('\n[the artifact is named, in all four places that name it]');
{
    /*
     * Four consumers asked "does this write carry a tune" separately, and each was written when the
     * answer was "is there a VE map": the filename prefix, the hub label, the confirmation dialog
     * and the flash record. Every mode added since produces a tune with no VE map behind it.
     *
     * `tunedRfKorr`, `tunedShape` and `calibrationEdits` were remembered. `tunedIdleTv` was not —
     * an idle tune downloaded as Base_ and flashed as tuned:false. `tunedLlsTv` was not either, so
     * the hub offered WRITE PATCH-OFF over a derived KF_LLS_TV (operator, 2026-09-22).
     */
    const edits = solveLlsTv(T);
    check('an armed LLS table claims a tune',
        writeClaimsTune(null, false, { tunedLlsTv: edits }) === true, 'reads as configuration only');
    check('...and so does an armed IDLE table',
        writeClaimsTune(null, false, { tunedIdleTv: T.llsTv.values }) === true, 'reads as configuration only');
    check('an EMPTY LLS edit list does not', writeClaimsTune(null, false, { tunedLlsTv: [] }) === false,
        'an empty list claimed a tune');
    check('patches alone do not', writeClaimsTune(null, false, {}) === false, 'configuration claimed a tune');
    check('a VE map still does', writeClaimsTune({ xAxis: [], yAxis: [], data: [] }, true, {}) === true,
        'the original case regressed');

    // One expression, four readers — the point of the fix, pinned structurally.
    const page = readFileSync('src/app/page.tsx', 'utf8');
    const hook = readFileSync('src/hooks/useBinaryFile.ts', 'utf8');
    check('the filename prefix uses it', /claimsTune = writeClaimsTune\(/.test(hook),
        'buildFileName still has its own copy');
    check('the confirmation dialog uses it',
        /tuned: writeClaimsTune\(/.test(page), 'the dialog still asks Boolean(newMap)');
    check('the flash record uses it',
        /tuned: finalizeArmedRef\.current \|\| writeClaimsTune\(/.test(page), 'the record still asks separately');
    check('the hub label names LLS and IDLE above the patch state',
        page.indexOf("'WRITE LLS'") > 0 && page.indexOf("'WRITE IDLE'") > 0
        && page.indexOf("'WRITE LLS'") < page.indexOf("'WRITE PATCH-ON'"),
        'a derived table would be labelled by the patch state');
}

// ---- the ring says when it has gone stale ---------------------------------

console.log('\n[a VE write invalidates KF_LLS_TV, and the app has to say so]');
{
    /*
     * `kf_rf_soll` is an INPUT to the solve. Write a VE map and the idle-valve table is no longer
     * the answer to anything — the notes call the two "valid only as a matched pair" (9.9-11) and
     * record that this app writes them from two places that do not know about each other.
     *
     * Asked by solving again rather than by a threshold on elasticity: measured over the reference
     * band, four real images run 0.14 to 0.37 with an UNCORRECTED community patch at 0.22 sitting
     * between two corrected tables, so any line through that misclassifies a real image.
     */
    const before = ringDrift(T, NOTES_ANCHOR);
    check('the 0645 image reads as stale — it predates the correction',
        before.staleCells > 0 && !before.converged, JSON.stringify(before));

    // And it closes itself, exactly once. This is the whole contract for a derived warning.
    const solved = withEdits(T, solveLlsTv(T, NOTES_ANCHOR));
    const after = ringDrift(solved, NOTES_ANCHOR);
    check('...and writing the solve makes it converged', after.converged && after.staleCells === 0,
        JSON.stringify(after));
    const again = ringDrift(withEdits(solved, solveLlsTv(solved, NOTES_ANCHOR)), NOTES_ANCHOR);
    check('...and it stays converged — the solve is a fixed point in one step',
        again.converged && again.staleCells === 0, JSON.stringify(again));

    // Compared on the storage grid, because a difference that cannot be written is not a difference.
    check('one raw count is 0.02 %', LLS_TV_STEP_PCT === 0.02, String(LLS_TV_STEP_PCT));
    // The real case, not a synthetic one: a WRITE stores the quantised value, so the next solve's
    // float output and the stored count never match exactly. Drift must be read off the bytes that
    // would change, or every image would report itself stale forever the moment it was written.
    const q = (v) => Math.round(v / LLS_TV_STEP_PCT) * LLS_TV_STEP_PCT;
    const asWritten = withEdits(T, solveLlsTv(T, NOTES_ANCHOR).map(e => ({ ...e, afterPct: q(e.afterPct) })));
    const afterWrite = ringDrift(asWritten, NOTES_ANCHOR);
    check('a table stored at the 0.02 % grid reads as converged, not as forever-stale',
        afterWrite.converged, JSON.stringify(afterWrite));
    check('...and the floats really do differ, so that was the grid doing the work',
        solveLlsTv(asWritten, NOTES_ANCHOR).some(e => e.afterPct !== e.beforePct),
        'the floats matched, so this check proved nothing');

    // The hub has to carry it, and only where the tables are already loaded.
    const page = readFileSync('src/app/page.tsx', 'utf8');
    check('the hub notice line carries it', /ringStale/.test(page) && /\?\? ringStale/.test(page),
        'the drift is computed and never shown');
    check('...only in LLS mode, so no other session pays the 6 MB catalog fetch',
        /logProcess === 'LLS' && llsRingDrift/.test(page), 'it would fire in every mode');
    check('...and below the faults rather than above them',
        page.indexOf('?? ringStale') > page.indexOf('?? warning'),
        'a stale derivation would displace a cable fault');
}

console.log(fails === 0 ? '\nALL PASS' : '\n' + fails + ' FAILURE(S)');
process.exit(fails ? 1 : 0);
