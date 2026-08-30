/**
 * The low-load correction: the operator, the refusal, and the shape repair.
 *
 * The first section is the most important thing in this file and possibly in the feature. The term
 * that turns a lambda trim at the lowest filling into an air-model error is a MULTIPLY by
 * KF_TI_N_RF, not a divide, and not an omission. All three produce a number; only one is right.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readAlphaNTables, tiLoadFactorAt, tiIdleFactorAt, tiBranchAmbiguous } from '../src/lib/ve-calculator/alphaNTable.ts';
import { processLogData } from '../src/lib/log-engine/filter.ts';
import { tuneLowLoad, LOW_LOAD_TUNE_DEFAULTS } from '../src/lib/ve-calculator/lowLoadTuner.ts';
import { repairLowLoadShape, isotonicWeighted, gains, LOW_LOAD_SHAPE_DEFAULTS } from '../src/lib/ve-calculator/lowLoadShape.ts';

let fails = 0;
const check = (n, c, d) => { console.log('  ' + (c ? 'PASS' : 'FAIL') + '  ' + n + (c ? '' : ' — ' + d)); if (!c) fails++; };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

const b = fs.readFileSync(fileURLToPath(new URL('../public/mock/csl-0401-community-patch-v1.partial.bin', import.meta.url)));
const t = readAlphaNTables(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));

console.log('\n[the tables]');
check('readAlphaNTables decodes', t !== null);
if (!t) { console.log('cannot continue'); process.exit(1); }
check('KF_TI_N_RF is 12 x 18', t.tiLoad.values.length === 12 && t.tiLoad.values[0].length === 18);
check('the rf = 0.10 row is enriched', t.tiLoad.values[0].every(v => v > 1.1), t.tiLoad.values[0].slice(0, 3));
check('every row at rf >= 0.15 is EXACTLY 1.000',
    t.tiLoad.values.slice(1).every(r => r.every(v => v === 1)));
check('K_LA_TI_MIN is 1.05 ms', near(t.tiMinMs, 1.05, 1e-9), t.tiMinMs);
check('the kf_rf_soll axes come from the BINARY, not the constants',
    near(t.sollOpening[9], 1.391602, 1e-4) && near(t.sollOpening[10], 1.611328, 1e-4),
    `${t.sollOpening[9]} / ${t.sollOpening[10]}`);
check('...and APP_CONFIG would have rounded them onto the hump', !near(t.sollOpening[9], 1.40, 1e-6));

console.log('\n[THE OPERATOR - TI_F_STAT is NOT in it, and the car is why]');
// This block used to assert the opposite. It read KF_TI_N_RF as a deliberate low-filling
// enrichment that a lambda-1 loop takes back out, so a perfect air model would show a standing
// trim of 1/TI_F_STAT and the correction had to multiply the factor back in.
//
// Session #920 measured it, and the loop does no such thing. Across the table's y = 0.15
// breakpoint, rpm held inside one band, 1,479 warm closed-loop samples:
//
//     median trim              0.9685 below  ->  0.9699 above   (+0.1 %)
//     median trim x TI_F_STAT  1.0728 below  ->  0.9699 above   (-9.6 %)
//     regression of (trim - 1) on (TI_F_STAT - 1):  slope -0.025, against -1 for enrichment
//
// The trim is continuous and the PRODUCT is the discontinuous one, so the factor is not
// something the loop removes. verify:ti-factor is that measurement; this is its unit consequence.
const tiF = tiLoadFactorAt(t, 870, 0.10);
check('TI_F_STAT at 870 rpm / rf 0.10', near(tiF, 1.1484, 0.002), tiF);
check('a perfect air model reads trim 1.000, whatever TI_F_STAT says', near(1.0, 1.0, 1e-12));
check('multiplying it in would invent a 15 % correction out of nothing',
    near(1.0 * tiF, 1.148, 0.002), (1.0 * tiF).toFixed(4));

console.log('\n[the factor is still worth SEEING, which is why it is still computed]');
for (const rf of [0.15, 0.2, 0.5, 0.9, 1.1]) {
    check(`TI_F_STAT at rf ${rf} is exactly 1`, tiLoadFactorAt(t, 3000, rf) === 1, tiLoadFactorAt(t, 3000, rf));
}
check('and above 1 only at the shortest pulses, which is the small-pulse signature',
    tiLoadFactorAt(t, 3000, 0.10) > 1.1, tiLoadFactorAt(t, 3000, 0.10));

console.log('\n[the unresolved branch is localised, not hand-waved]');
check('KL_TI_N_ZWD_LL reads BELOW 1.0 above 800 rpm', tiIdleFactorAt(t, 870) < 1, tiIdleFactorAt(t, 870));
check('so at idle the two branches disagree — nothing may be derived there',
    tiBranchAmbiguous(t, 870, 0.10));
check("but above the idle curve's own 1800 rpm axis the idle branch is not a candidate at all",
    !tiBranchAmbiguous(t, 3000, 0.5));
check('so the open question costs the idle rows, not the whole band',
    tiBranchAmbiguous(t, 870, 0.10) && !tiBranchAmbiguous(t, 2400, 0.5));

console.log('\n[refusal, not defaulting]');
const zeroed = new Uint8Array(b.byteLength);
check('a buffer of zeros decodes to null', readAlphaNTables(zeroed.buffer) === null);
// Break the fingerprint: make one rf >= 0.15 cell non-unity.
const broken = new Uint8Array(b.slice());
broken[0x08FA + 18] = 0x90;   // row 1, col 0 -> 1.125
check('a binary whose rf >= 0.15 rows are not flat is REFUSED',
    readAlphaNTables(broken.buffer.slice(broken.byteOffset, broken.byteOffset + broken.byteLength)) === null);

console.log('\n[shape repair — R1, monotone filling]');
const x = t.sollOpening.slice(0, 13);
// The real defect (c): 1600 rpm, 0.098 -> 0.146 %, filling FALLS.
const inverted = [0.088, 0.084, 0.090, 0.104, 0.124, 0.140, 0.152, 0.160, 0.168, 0.180, 0.196, 0.220, 0.240];
const w = inverted.map(() => 1);
// The grid is [openingRow][rpmCol], so a single rpm column is 13 rows of one value each.
const col = a => a.map(v => [v]);
const r1 = repairLowLoadShape(col(inverted), x, col(w), 12, { maxRepairFrac: 1 });
const fixed = r1.values.map(r => r[0]);
check('the inversion is gone', fixed.every((v, i) => i === 0 || v >= fixed[i - 1] - 1e-12), fixed.slice(0, 3));
const movedCount = r1.repaired.filter(r => r[0]).length;
check('and only the offending pair moved', movedCount <= 3, String(movedCount));

console.log('\n[shape repair — idempotence on clean data, which is what stops it being a smoother]');
// Constant gain, so every adjacent ratio is exactly 1.0 and the column is healthy by BOTH rules.
// It has to be built FROM the real axis: the breakpoints are wildly non-uniform (0.098 to 3.198 %
// in thirteen steps), so evenly-spaced VALUES would have wildly varying gains and would be a
// legitimately defective column dressed up as a clean one.
const clean = x.map(v => 0.05 + 0.1 * v);
const r2 = repairLowLoadShape(col(clean), x, col(clean.map(() => 1)), 12);
check('a healthy column comes back BIT-IDENTICAL', r2.values.every((r, i) => r[0] === clean[i]),
    r2.values.map(r => r[0].toFixed(3)).join(','));
check('and nothing is marked repaired', r2.repaired.every(r => !r[0]));

console.log('\n[shape repair — R2, the gain hump]');
// The real defect (b) at 1600 rpm: gain 0.092 then 0.437 across 1.20 / 1.39 / 1.61 %.
const humpX = [1.196289, 1.391602, 1.611328];
const hump = [0.300, 0.318, 0.414];
const gBefore = gains(hump, humpX);
check('the injected ratio really is the 4.75x from the notes',
    near(gBefore[1] / gBefore[0], 4.75, 0.3), (gBefore[1] / gBefore[0]).toFixed(2));
const r3 = repairLowLoadShape(col(hump), humpX, col([1, 1, 1]), 2, { maxRepairFrac: 1 });
const after3 = r3.values.map(r => r[0]);
const gAfter = gains(after3, humpX);
check('after repair the ratio is at the 1.6 cap', gAfter[1] / gAfter[0] <= 1.6 + 1e-6,
    (gAfter[1] / gAfter[0]).toFixed(3));
check('and the column TOTAL RISE is unchanged — the repair is local, not a rescale',
    near(after3[2] - after3[0], hump[2] - hump[0], 1e-9),
    `${(after3[2] - after3[0]).toFixed(6)} vs ${(hump[2] - hump[0]).toFixed(6)}`);
check('the endpoints did not move', after3[0] === hump[0] && after3[2] === hump[2]);

console.log('\n[shape repair — refusal when it wants too much]');
const violent = [0.300, 0.301, 0.900];
const r4 = repairLowLoadShape(col(violent), humpX, col([1, 1, 1]), 2, { maxRepairFrac: 0.06 });
check('a cell needing more than maxRepairFrac is REVERTED to the measured value',
    r4.values[1][0] === violent[1], r4.values[1][0]);
check('and reported as refused rather than silently applied', r4.refused[1][0] === true);

console.log('\n[isotonic is a projection, not a filter]');
const already = [1, 2, 3, 4];
check('monotone input is returned unchanged', isotonicWeighted(already, [1, 1, 1, 1]).every((v, i) => v === already[i]));
const dip = isotonicWeighted([1, 5, 2, 6], [1, 1, 1, 1]);
check('a dip is pooled to the weighted mean, not smoothed away',
    near(dip[1], 3.5, 1e-9) && near(dip[2], 3.5, 1e-9), dip.join(','));
check('the default cap is the measured 1.6', LOW_LOAD_SHAPE_DEFAULTS.gainRatioMax === 1.6);


console.log('\n[the filter: a third sample set, and NOTHING else moved]');
// The whole justification for touching filter.ts is that the VE map's inputs are untouched. That is
// an invariant rather than an intention, so it is pinned here against a log that exercises the
// gates it interacts with.
const rows = [];
for (let i = 0; i < 60; i++) {
    const idle = i % 3 === 0;                        // closed throttle, low rpm -> the idle gate
    const cold = i > 0 && i % 17 === 0;              // below minTemp -> coldEngine, checked FIRST
    rows.push({
        time: i * 0.3,
        rpm: idle ? 850 : 3000,
        rawLoad: idle ? 0.8 : 40,
        stft1: 0.95, stft2: 0.95,
        coolantTemp: cold ? 40 : 85,
        rf: idle ? 5 : 60,
    });
}
const fcfg = { enableCorrection: false, enableMinTemp: true, minTemp: 65, enableTransient: false };
const out = processLogData(rows, 'test.csv', fcfg);

// ONE dataset now. The filter used to hold two — `validData` without the idle rows, and
// `lowLoadData` with them — because the VE correction would otherwise have written the low band
// from its own looser evidence bar. That split is gone: the VE calculator refuses everything at or
// below LOW_LOAD_TOP_ROW outright, so there is nothing left for a second array to protect.
check('idle samples now survive the filter', out.data.some(p => p.rawLoad <= 1.0 && p.rpm < 1000),
    `${out.data.filter(p => p.rawLoad <= 1.0 && p.rpm < 1000).length} idle rows kept`);
check('nothing is dropped as `idle` any more', (out.dropCensus.idle ?? 0) === 0, out.dropCensus.idle);
check('rfKorrData is the same set', out.rfKorrData.length === out.data.length,
    `${out.rfKorrData.length} vs ${out.data.length}`);
check('the census still sums to the drop count',
    Object.values(out.dropCensus).reduce((a, b) => a + b, 0) === out.droppedCount,
    `${Object.values(out.dropCensus).reduce((a, b) => a + b, 0)} vs ${out.droppedCount}`);
// The cold-engine gate is what the idle gate used to double-count against. With the idle gate gone
// it has to keep counting exactly its own rows and no more.
check('a cold idle sample is counted ONCE, as cold — never twice',
    out.dropCensus.coldEngine === rows.filter((r, i) => i > 0 && i % 17 === 0).length,
    `${out.dropCensus.coldEngine}`);

console.log('\n[the tuner: the negative conclusion is a result, not an absence]');
const veMap = { xAxis: t.sollRpm, yAxis: t.sollOpening, data: t.sollOpening.map(() => t.sollRpm.map(() => 0.2)) };
const ROW = 5;                                   // 0.806 % opening — inside the idle gate's band
const mk = (n, over) => {
    // `over` is how much the air model reads HIGH. TI_F_STAT is part of the air-to-fuel
    // conversion rather than an enrichment the loop removes (verify:ti-factor), so a PERFECT
    // model shows a trim of exactly 1.000 whatever the factor reads, and an over-reading one
    // shows 1/over. This rig used to build 1/(TI_F_STAT * over), which is what a test written
    // from the wrong physics looks like: it passed against a correction carrying the same error.
    const trim = 1 / over;
    const out = [];
    for (let i = 0; i < n; i++) {
        // A real two-point controller oscillates by construction. A dead-flat trim is the FROZEN
        // case, which the tuner must refuse, so the rig has to move or it tests the wrong thing.
        const wobble = 1 + (i % 2 ? 0.01 : -0.01);
        out.push({
            time: i * 7,                                 // 7 s apart -> every sample its own visit
            rpm: 870, rawLoad: t.sollOpening[ROW], rf: 10,
            stft1: trim * wobble, stft2: trim * wobble, rfKorr: 1,
        });
    }
    return out;
};

// The guard USED to be on by default: at idle the two candidate TI_F_STAT tables disagree by 14 %,
// so nothing could be derived there at all. It is off now, because the branch is settled —
// ti_load_factor (slave 0x01C6CA) reads the 0.859 curve only while LLS_ST bit 7 is set, and that
// bit is set by the idle-valve diagnosis, so a healthy valve leaves KF_TI_N_RF running.
//
// Both directions are pinned: the default derives, and asking for the guard still refuses. The
// second half matters because turning it back on is what a car WITH bit 7 set would need.
const byDefault = tuneLowLoad(mk(40, 1.12), t, veMap);
check('by default the idle rows are now derived, not refused',
    byDefault.cells[ROW][1].rejected !== 'ti-branch-unproven', byDefault.cells[ROW][1].rejected);
const guarded = tuneLowLoad(mk(40, 1.12), t, veMap, { requireTiBranchProven: true });
check('...and asking for the guard still refuses them',
    guarded.cells[ROW][1].rejected === 'ti-branch-unproven', guarded.cells[ROW][1].rejected);

// The arithmetic, with the guard explicitly off so the test states what it is exercising.
const lifted = { requireTiBranchProven: false };
const perfect = tuneLowLoad(mk(40, 1.0), t, veMap, lifted);
const perfectCell = perfect.cells[ROW][1];
check('a PERFECT air model at the enriched row proposes NO change',
    perfectCell.rejected === 'no-change-needed', `${perfectCell.rejected} corr=${perfectCell.correction?.toFixed(4)}`);
check('...and its correction really is 1.000, not merely close',
    near(perfectCell.correction, 1.0, 0.005), perfectCell.correction);
// The withdrawn term, priced. Had it stayed, this same perfect-model log would have been told to
// add 15 % filling at the one row where the DME compensates for short pulses -- and 17 of the 109
// cells a real 52-minute drive earns sit in that band with the lambda loop closed.
check('WITH the TI_F_STAT term the same log would have been pushed 15 % rich',
    near(perfectCell.correction * tiLoadFactorAt(t, 870, 0.10), 1.148, 0.01));

const over = tuneLowLoad(mk(40, 1.12), t, veMap, lifted);
const overCell = over.cells[ROW][1];
check('a genuinely 12 % over-reading model IS corrected', overCell.rejected === null, overCell.rejected);
check('and downward, toward less filling', overCell.tuned < overCell.stock, `${overCell.stock} -> ${overCell.tuned}`);
check('with the step limited to maxStepDownFrac',
    near(overCell.tuned, overCell.stock * 0.95, 1e-9), overCell.tuned);

console.log('\n[the tuner: evidence gates]');
check('one visit is refused however many samples it holds',
    tuneLowLoad(mk(40, 1.12).map(s => ({ ...s, time: 0 })), t, veMap, lifted).cells[ROW][1].rejected === 'few-visits');
check('too few samples is refused', tuneLowLoad(mk(5, 1.12), t, veMap, lifted).cells[ROW][1].rejected === 'thin-count');
const frozen = mk(40, 1.12).map(s => ({ ...s, stft1: 0.8, stft2: 0.8 }));
check('a FROZEN trim is refused — it reads the same as a converged one',
    tuneLowLoad(frozen, t, veMap, lifted).cells[ROW][1].rejected === 'trim-rigid');
check('no tables -> null, never a correction from an assumed TI_F_STAT',
    tuneLowLoad(mk(40, 1.12), null, veMap) === null);
check('the census reports how much evidence depended on the divisor at all',
    over.report.samplesWithEnrichment === 40, over.report.samplesWithEnrichment);
check('and reports the idle rf it actually saw rather than asserting one',
    over.report.medianIdleRf !== null && near(over.report.medianIdleRf, 0.10, 1e-9), over.report.medianIdleRf);
check('rows above the band are never touched',
    over.cells[20][1].rejected === 'out-of-band' && over.tuned[20][1] === over.stock[20][1]);


console.log('\n[the standing error is stft x ltft, not stft alone]');
{
    // Why this is the whole point of the corrector. `stft` (la_f_regler) is the SHORT-term lambda
    // controller — a two-point regulator that oscillates by construction. `ltft` (laa_f) is the
    // LONG-term store the DME learns its mean into, and Funktionsrahmen 7.2 says it learns in
    // exactly the warm, stationary, idle window this band lives in. So at a settled idle the short
    // -term trim drifts back toward 1.000 BECAUSE the long-term store took the offset, and reading
    // it alone measures what is left after the DME has already corrected.
    //
    // Session #920's idle cell is the case: stft reported 0.998 / 0.985, a 0.9 % correction, which
    // sits under the no-change band and was reported as "nothing to do".
    const mkPair = (n, stft, ltft) => Array.from({ length: n }, (_, i) => ({
        time: i * 7, rpm: 870, rawLoad: t.sollOpening[ROW], rf: 10,
        stft1: stft * (1 + (i % 2 ? 0.01 : -0.01)), stft2: stft * (1 + (i % 2 ? 0.01 : -0.01)),
        ltft1: ltft, ltft2: ltft, rfKorr: 1,
    }));
    const opts = { requireTiBranchProven: false };

    // NEUTRAL is 1.000, at every row. It was 0.871 here on the reading that KF_TI_N_RF is a
    // deliberate enrichment the loop cancels; session #920 measured the trim across that table's
    // breakpoint and found it continuous, so a perfect air model reads 1.000 whatever the factor
    // says. See verify:ti-factor, and the operator block at the top of this file.
    const NEUTRAL = 1.0;

    // A short-term trim sitting exactly at neutral, over a long-term store holding a real 5 %.
    const hidden = tuneLowLoad(mkPair(40, NEUTRAL, 0.95), t, veMap, opts);
    const cell = hidden.cells[ROW][1];
    check('a 5 % offset parked in ltft is SEEN', cell.rejected !== 'no-change-needed', cell.rejected);
    check('...and the correction is the product, not the short term',
        Math.abs(cell.correction - NEUTRAL * 0.95) < 5e-3, cell.correction);
    check('...which is about 5 % away from neutral', Math.abs(cell.correction - 0.95) < 0.01,
        cell.correction);

    // The same log with ltft at unity is the old behaviour: nothing worth writing.
    const plain = tuneLowLoad(mkPair(40, NEUTRAL, 1.0), t, veMap, opts);
    check('with nothing learned, the same short-term trim proposes no change',
        plain.cells[ROW][1].rejected === 'no-change-needed', plain.cells[ROW][1].rejected);

    // Old logs have no ltft channel at all. They must behave exactly as they did, not be refused.
    const legacy = tuneLowLoad(mkPair(40, NEUTRAL, 1.0).map(r => { const c = { ...r }; delete c.ltft1; delete c.ltft2; return c; }), t, veMap, opts);
    check('a log with no ltft column falls back to 1.0 rather than refusing',
        legacy.cells[ROW][1].rejected === 'no-change-needed', legacy.cells[ROW][1].rejected);

    // The rigidity test asks whether the lambda loop was correcting at all, and only the short-term
    // channel can answer — laa_f is SUPPOSED to sit still, so a product would read healthy as frozen.
    const frozen = Array.from({ length: 40 }, () => ({
        time: 0, rpm: 870, rawLoad: t.sollOpening[ROW], rf: 10,
        stft1: NEUTRAL, stft2: NEUTRAL, ltft1: 0.95, ltft2: 0.95, rfKorr: 1,
    })).map((r, i) => ({ ...r, time: i * 7 }));
    check('a frozen SHORT-term trim is still refused, whatever ltft says',
        tuneLowLoad(frozen, t, veMap, opts).cells[ROW][1].rejected === 'trim-rigid',
        tuneLowLoad(frozen, t, veMap, opts).cells[ROW][1].rejected);
}

console.log('\n[the gates, at the values they now hold]');
{
    check('minVisits is 2 — ltft replaced the third', LOW_LOAD_TUNE_DEFAULTS.minVisits === 2,
        LOW_LOAD_TUNE_DEFAULTS.minVisits);
    // 1 %, against a quantisation step of 0.5 % at the idle cell (kf_rf_soll stores raw/1000, so
    // one bit is 0.001 on a value of 0.200). Two steps, not four.
    check('noChangeBand is 1 %, two quantisation steps', LOW_LOAD_TUNE_DEFAULTS.noChangeBand === 0.01,
        LOW_LOAD_TUNE_DEFAULTS.noChangeBand);
    check('the ti branch guard is off by default',
        LOW_LOAD_TUNE_DEFAULTS.requireTiBranchProven === false);
}




console.log('\n[the scatter gates, which used to be one range test]');
{
    // `max - min > 0.12` refused 64 of the 66 cells session #920 earned, for two reasons that both
    // had to be fixed: the threshold sat BELOW the normal value (median measured range 0.161), and
    // a range is an extreme, so it WIDENS with evidence -- median 0.161 at n >= 30, 0.253 at
    // n >= 900. A cell measured better was refused harder.
    check('the scatter bound is a standard deviation, not a range',
        near(LOW_LOAD_TUNE_DEFAULTS.maxSampleSd, 0.08, 1e-9), LOW_LOAD_TUNE_DEFAULTS.maxSampleSd);
    check('...set above the measured limit cycle, not below it',
        LOW_LOAD_TUNE_DEFAULTS.maxSampleSd > 0.043, 'p90 of measured sd on #920 is 0.043');
    check('the precision bound is one quantisation step of the idle cell',
        near(LOW_LOAD_TUNE_DEFAULTS.maxStdErr, 0.005, 1e-9), LOW_LOAD_TUNE_DEFAULTS.maxStdErr);

    const cell = (pts) => tuneLowLoad(pts, t, veMap, { requireTiBranchProven: false }).cells[ROW][1];
    // An ordinary limit cycle: +/-3.4 % about a real 6 % correction, which is #920's median sd.
    const cycle = (n, mean, amp) => Array.from({ length: n }, (_, i) => ({
        time: i * 7, rpm: 870, rawLoad: t.sollOpening[ROW], rf: 10,
        stft1: mean * (1 + (i % 2 ? amp : -amp)), stft2: mean * (1 + (i % 2 ? amp : -amp)), rfKorr: 1,
    }));
    // 60 samples, not 40: at the measured limit-cycle sd of 0.034 the standard error is
    // 0.034/sqrt(40) = 0.0054, which is still outside one quantisation step, and the tuner is
    // right to say so. sqrt(47) is where it crosses. This is the gate doing arithmetic rather
    // than the gate being lenient, and it is worth pinning that the two bounds are independent:
    // the SCATTER is fine here at any n, the PRECISION only arrives with enough of it.
    check('a normal limit cycle is not read as disagreement, once enough of it is held',
        cell(cycle(60, 0.94, 0.034)).rejected === null, cell(cycle(60, 0.94, 0.034)).rejected);
    check('...the same cycle at 40 samples is refused for PRECISION, never for scatter',
        cell(cycle(40, 0.94, 0.034)).rejected === 'imprecise', cell(cycle(40, 0.94, 0.034)).rejected);
    check('...and MORE of the same evidence still passes, which a range test could not promise',
        cell(cycle(400, 0.94, 0.034)).rejected === null, cell(cycle(400, 0.94, 0.034)).rejected);
    // Two populations in one cell: the inhomogeneity the scatter test exists to catch.
    const split = Array.from({ length: 40 }, (_, i) => ({
        time: i * 7, rpm: 870, rawLoad: t.sollOpening[ROW], rf: 10,
        stft1: i % 2 ? 1.15 : 0.85, stft2: i % 2 ? 1.15 : 0.85, rfKorr: 1,
    }));
    check('a cell holding two populations IS refused, and for scatter',
        cell(split).rejected === 'spread', cell(split).rejected);
    // Few samples of a real cycle: the mean is not pinned yet, and the remedy differs.
    const thin = cycle(31, 0.94, 0.06);
    check('a barely-sampled cell is refused as imprecise, not as disagreement',
        cell(thin).rejected === 'imprecise', cell(thin).rejected);
}

console.log(fails === 0 ? '\nALL PASS' : '\n' + fails + ' FAILURE(S)');
process.exit(fails ? 1 : 0);
