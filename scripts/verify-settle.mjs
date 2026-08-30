/**
 * The high-load settle: evidence from a pull only after the lambda trim has caught up.
 *
 * Crossing the EGT-correction floor (55 %RF, `kl_rf_korr_rf_min`'s lowest node) makes the DME's
 * `rf_korr` STEP up off a lagging TABG while the lambda trim walks after it at a few percent per
 * second. Until it lands, `trim × rf_korr` — the product the VE correction is built from — reads
 * high. Measured on two same-day drives, binned by age in the pull, both lay on one decay curve:
 * 1.096 at 0-2 s down to ~0.98 converged. One drive was short stabs and sampled the top; the other
 * held 29.8 s and sampled the bottom; their high-load cells disagreed by 5.2 %, and by 1.1 % with
 * age >= 6 s required. Rate-of-change filters cannot catch this — at the start of a pull the trim
 * has not begun to move, so its rate is smallest exactly where the sample is worst.
 *
 * MOVED 2026-08-30, and the measurement is the reason. The settle used to take these samples out
 * of `validData` — the VE stream — and leave `rfKorrData` untouched, because it sits after that
 * push. But every line of the argument above is about `rf_korr`, so rf_korr is the derivation that
 * should wait for the trim to cover the step. Two things settled it:
 *
 *   - the premise does not hold for VE. On #928/#929 with the filling held to 75-85 %RF, rf_korr
 *     moves ~3 % across a pull while `trim x rf_korr` moves 7-9 %. The walk is the lambda
 *     integrator settling after a LOAD step, which is the transient test's job.
 *   - it was charged to the wrong stream in fact as well as in principle: on session #931 the
 *     rf_korr sample count is identical with the settle at 6 s and at 0, and the VE stream paid
 *     158 samples. Turning it off and sizing the transient test at the loop's own response time
 *     turned that drive from 0 written cells into 8.
 *
 * So: the settle now gates `rfKorrData`, `validData` is left to the transient test, and the default
 * is OFF. The census still counts what it excluded, but `droppedCount` does not — the sample stays
 * in the log and can still earn a VE cell.
 *
 * These checks pin six things:
 *   1. the clock starts at ENTRY into the region and rejects until the settle has passed,
 *   2. a dip below the floor resets it — re-entry is a fresh step and a fresh excursion,
 *   3. a live run flushed mid-pull produces byte-identical output to one batch pass — the entry
 *      time AND the restep reference ride in FilterResume, and losing either at a flush
 *      boundary would silently keep samples
 *      a batch pass drops,
 *   4. off means off: absent or 0 reproduces the pre-settle behaviour exactly, so archived
 *      sessions rebuild the maps they recorded — including the two gates added 2026-08-22,
 *   5. a stab WITHIN the region restarts the clock (found by #917: cruise at 60-70 %, then WOT —
 *      rf_korr steps as at entry while the entry clock has long expired) but a pull's own climb
 *      does not (measured <= 10.5 %RF per 1.5 s against stabs of 19-47),
 *   6. a trim within TRIM_CLAMP_MARGIN of its clamp inside the region is a bound, not a reading,
 *      and is rejected regardless of age (found on the same log: 0.721-0.766 against a 0.700
 *      floor, eleven seconds past the clock).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { processLogData, HIGH_LOAD_SETTLE_RF_MIN } from '../src/lib/log-engine/filter.ts';
import { TRANSIENT_SETTLE_SEC_DEFAULT } from '../src/lib/types.ts';
import { APP_CONFIG } from '../src/config/constants.ts';

let fails = 0;
const check = (n, c, d) => { console.log('  ' + (c ? 'PASS' : 'FAIL') + '  ' + n + (c ? '' : ' — ' + d)); if (!c) fails++; };

/** A healthy sample every 0.25 s: warm, off idle, trim present, no purge. */
const sample = (time, rf) => ({
    time, rpm: 3000, rawLoad: rf >= HIGH_LOAD_SETTLE_RF_MIN ? 70 : 30, rf,
    stft1: 1.0, stft2: 1.0, coolantTemp: 85, tankVent: 0,
});
const drive = (spans) => {
    const rows = [];
    let t = 0;
    for (const [seconds, rf] of spans) {
        for (let i = 0; i < seconds * 4; i++) { rows.push(sample(t, rf)); t += 0.25; }
    }
    return rows;
};
// Steady state throughout, so the rpm/TPS transient test never fires and every drop below is the
// settle's own. Idle/temp gates likewise never fire.
const CFG = {
    enableCorrection: false, enableMinTemp: true, minTemp: 65,
    enableTransient: true, transientWindow: 4, transientSettleSec: 2.0,
    rpmStableThreshold: 10, tpsStableThreshold: 5,
    highLoadSettleSec: 6.0,
};
const run = (rows, cfg = CFG, resume) =>
    processLogData(rows, 'settle-test', cfg, APP_CONFIG.MSS54HP.INTERPOLATION_TABLE, null, resume);

console.log('\n[the clock starts at entry and holds for the settle]');
{
    // 10 s cruise below the floor, then a 12 s pull above it.
    const rows = drive([[10, 30], [12, 80]]);
    const out = run(rows);
    const hi = out.data.filter(r => r.rf >= HIGH_LOAD_SETTLE_RF_MIN);
    check('cruise samples are untouched', out.data.filter(r => r.rf < 55).length === 40,
        String(out.data.filter(r => r.rf < 55).length));
    // The settle acts on rf_korr's stream now, so that is where the first 6 s go missing.
    const rk = out.rfKorrData.filter(r => r.rf >= HIGH_LOAD_SETTLE_RF_MIN);
    const rkFirst = Math.min(...rk.map(r => r.time));
    check('the first 6 s of the pull leave the rf_korr evidence', rkFirst >= 10 + 6, String(rkFirst));
    check('...and no more than that', rkFirst < 10 + 6.5, String(rkFirst));
    check('the rest of the pull is rf_korr evidence', rk.length === 24, String(rk.length));
    check('the census names them short-pull', out.dropCensus.highLoadSettle === 24,
        String(out.dropCensus.highLoadSettle));
    // The VE stream is untouched by the settle. 47, not 40, since the settle stopped being the
    // transient test's look-back too: that test now reads the sample immediately before this one,
    // which at this log's 4 Hz is 0.25 s rather than 2.0 s, so only the step itself is transient.
    // The equality that IS the change is pinned below — settle 2.0 and settle 0 agree exactly.
    check('the VE stream is not charged for the settle', hi.length === 47, String(hi.length));
    check('...and the transient test still does its own work', out.dropCensus.transient === 1,
        String(out.dropCensus.transient));
    check('a settle exclusion is not counted as a dropped sample',
        out.droppedCount === out.dropCensus.transient + out.dropCensus.coldEngine
            + out.dropCensus.idle + out.dropCensus.catProtect + out.dropCensus.fullLoad
            + out.dropCensus.controllerStop + out.dropCensus.fuelCut + out.dropCensus.excluded,
        `${out.droppedCount} vs census without highLoadSettle`);
}

console.log('\n[a dip below the floor resets the clock]');
{
    // 10 s cruise, 5 s pull (all inside the settle), 1 s lift, 12 s pull.
    const rows = drive([[10, 30], [5, 80], [1, 30], [12, 80]]);
    const out = run(rows);
    const rk = out.rfKorrData.filter(r => r.rf >= HIGH_LOAD_SETTLE_RF_MIN);
    check('the first stab is no rf_korr evidence', rk.every(r => r.time >= 16), String(Math.min(...rk.map(r => r.time))));
    const firstKept = Math.min(...rk.map(r => r.time));
    check('the second pull starts its own 6 s from re-entry', firstKept >= 16 + 6 && firstKept < 16 + 6.5,
        String(firstKept));
    // 5 s + 6 s of the second pull rejected = 44 samples.
    check('the census counts both excursions', out.dropCensus.highLoadSettle === 44,
        String(out.dropCensus.highLoadSettle));
}

console.log('\n[a flush boundary mid-pull does not restart the clock]');
{
    const rows = drive([[10, 30], [12, 80]]);
    const batch = run(rows);
    // Live: three flushes, the second landing 2 s INTO the pull — the exact boundary that loses
    // the entry time if it is not carried in FilterResume.
    // Chained, never reused: the resume carries the accumulating arrays themselves, so handing one
    // resume to two calls would double-push — a mistake a real live run cannot make, because each
    // flush consumes the previous flush's resume exactly once.
    const cut1 = rows.findIndex(r => r.time >= 8);
    const cut2 = rows.findIndex(r => r.time >= 12);   // 2 s INTO the pull — the boundary that matters
    const f1 = run(rows.slice(0, cut1));
    const f2 = run(rows.slice(0, cut2), CFG, f1.resume);
    const live = run(rows, CFG, f2.resume);
    check('live and batch keep the same samples',
        live.data.length === batch.data.length
        && live.data.every((r, i) => r.time === batch.data[i].time),
        `${live.data.length} vs ${batch.data.length}`);
    check('and the same census', JSON.stringify(live.dropCensus) === JSON.stringify(batch.dropCensus),
        JSON.stringify(live.dropCensus));
    check('the entry time rides in the resume', typeof batch.resume.highLoadEnteredAt !== 'undefined');
}

console.log('\n[off means off]');
{
    const rows = drive([[10, 30], [12, 80]]);
    for (const [name, cfg] of [
        ['absent (an archived session)', { ...CFG, highLoadSettleSec: undefined }],
        ['zero', { ...CFG, highLoadSettleSec: 0 }],
    ]) {
        const out = run(rows, cfg);
        // 47, not 48: the rpm/TPS transient filter — which predates the settle and no longer shares
        // a look-back with it — drops the one sample that IS the load step. `highLoadSettleSec` is
        // what varies here; `transientSettleSec` stays at CFG's 2.0 and no longer reaches this
        // stream, which is why both rows read the same as the settle-2.0 case above.
        check(`${name} keeps what the old filters kept`, out.data.filter(r => r.rf >= 55).length === 47,
            String(out.data.filter(r => r.rf >= 55).length));
        check(`${name} labels those transient, as before`, out.dropCensus.transient === 1,
            String(out.dropCensus.transient));
        check(`${name} counts nothing as short-pull`, out.dropCensus.highLoadSettle === 0);
    }
}

console.log('\n[the settle does not double-count or starve the other outputs]');
{
    const rows = drive([[10, 30], [12, 80]]);
    const out = run(rows);
    // The two streams now answer different questions and neither pays the other's gate. rfKorrData
    // still skips the transient machinery — its ratio does not need the loop converged — and pays
    // the settle instead, because rf_korr's step is what the settle is about.
    check('rfKorrData pays the settle and nothing else',
        out.rfKorrData.filter(r => r.rf >= 55).length === 24,
        String(out.rfKorrData.filter(r => r.rf >= 55).length));
    check('validData pays the transient test and nothing else',
        out.data.filter(r => r.rf >= 55).length === 47,
        String(out.data.filter(r => r.rf >= 55).length));
    // There is no idle gate any more — the VE calculator refuses the low band at the derivation
    // instead, so the filter keeps those rows and this settle is free to judge them on its own
    // terms. What used to be "not counted twice" is now "counted once, by whichever gate applies".
    const idleRows = drive([[10, 30]]).map(r => ({ ...r, rawLoad: 0.5, rpm: 800, rf: 80 }));
    const idleOut = run(idleRows);
    check('a low-opening sample is no longer dropped as idle', (idleOut.dropCensus.idle ?? 0) === 0,
        JSON.stringify(idleOut.dropCensus));
    // `highLoadSettle` is an EXCLUSION FROM rf_korr, not a drop from the log, so it is the one
    // census entry that must not appear in droppedCount. Everything else still balances exactly.
    const dropped = Object.entries(idleOut.dropCensus)
        .filter(([k]) => k !== 'highLoadSettle').reduce((a, [, v]) => a + v, 0);
    check('...and every drop it does take is counted exactly once',
        dropped === idleOut.droppedCount, `${dropped} vs ${idleOut.droppedCount}`);
    // A sample with no rf channel cannot enter the region.
    const noRf = drive([[10, 30], [12, 80]]).map(r => ({ ...r, rf: undefined }));
    const noRfOut = run(noRf);
    check('no rf channel, no settle gate', noRfOut.dropCensus.highLoadSettle === 0);
}

console.log('\n[a stab WITHIN the region restarts the clock]');
{
    // 10 s cruise, 10 s at 60 % (the entry settle passes at t=16), then a stab to 90 % for 12 s.
    // rawLoad is 70 for both high-load levels (see `sample`), so the rpm/TPS transient test never
    // fires at the stab and every drop below is the settle's own.
    const rows = drive([[10, 30], [10, 60], [12, 90]]);
    const out = run(rows);
    const at60 = out.rfKorrData.filter(r => r.rf === 60).map(r => r.time);
    const at90 = out.rfKorrData.filter(r => r.rf === 90).map(r => r.time);
    check('the 60 % cruise settles once, at entry', Math.min(...at60) >= 16 && at60.length === 16,
        `${Math.min(...at60)} n=${at60.length}`);   // rf_korr evidence, not the VE stream
    check('the stab to 90 starts its own 6 s', Math.min(...at90) >= 26 && Math.min(...at90) < 26.5,
        String(Math.min(...at90)));
    check('and the held stab is kept after it', at90.length === 24, String(at90.length));
    check('the census counts both excursions', out.dropCensus.highLoadSettle === 48,
        String(out.dropCensus.highLoadSettle));
}

console.log('\n[a pull\'s own climb does not restart the clock]');
{
    // 60 -> 100 %RF over 27 s (~1.5 %RF/s, the measured shape of a real 30 s pull). Only the
    // entry settle may reject; a restart mid-climb would eat the whole pull.
    const rows = [];
    let t = 0;
    for (let i = 0; i < 10 * 4; i++) { rows.push(sample(t, 30)); t += 0.25; }
    for (let i = 0; i < 27 * 4; i++) { rows.push(sample(t, 60 + (i / (27 * 4)) * 40)); t += 0.25; }
    const out = run(rows);
    const rk = out.rfKorrData.filter(r => r.rf >= HIGH_LOAD_SETTLE_RF_MIN);
    check('only the entry settle rejects', out.dropCensus.highLoadSettle === 24,
        String(out.dropCensus.highLoadSettle));
    check('the rest of the climb is rf_korr evidence', rk.length === 27 * 4 - 24, String(rk.length));
    // And the VE stream keeps the climb but for the step INTO it: `sample()` moves rawLoad 30 -> 70
    // at the floor, which is a real load step and the transient test's own business — for ONE
    // sample now, not eight, because the test's reference is the sample before this one rather than
    // one 2.0 s back. Nothing after that is refused: a 1.5 %RF/s ramp is not a transient, where the
    // settle used to take 24. That difference is the case this move was made for.
    check('the VE stream keeps the climb but for the step into it',
        out.data.filter(r => r.rf >= HIGH_LOAD_SETTLE_RF_MIN).length === 27 * 4 - 1,
        String(out.data.filter(r => r.rf >= HIGH_LOAD_SETTLE_RF_MIN).length));
}

console.log('\n[a trim against its clamp is a bound, not a measurement]');
{
    const LIMITS = {
        wotThreshold: { x: [1300, 2000, 3000, 4000], y: [48, 68, 88, 108],
            z: [[102.3, 102.3, 102.3, 102.3], [102.3, 102.3, 102.3, 102.3],
                [102.3, 102.3, 102.3, 102.3], [102.3, 102.3, 102.3, 102.3]] },
        loadThreshold: { x: [3000, 4000, 4500, 5000, 5600, 5800, 6400], y: [999, 999, 999, 999, 999, 999, 999] },
        fMax: 1.3, fMin: 0.7,
    };
    const trimmed = (v) => drive([[10, 30], [20, 80]])
        .map(r => r.rf >= 55 ? { ...r, stft1: v, stft2: v } : r);
    const runL = (rows, cfg = CFG) =>
        processLogData(rows, 'settle-test', cfg, APP_CONFIG.MSS54HP.INTERPOLATION_TABLE, LIMITS);
    const near = runL(trimmed(0.75));   // within 0.10 of the 0.70 floor
    check('0.75 against a 0.70 floor: no high-load sample is rf_korr evidence',
        near.rfKorrData.filter(r => r.rf >= 55).length === 0 && near.dropCensus.highLoadSettle === 80,
        JSON.stringify(near.dropCensus));
    const clear = runL(trimmed(0.85));
    check('0.85 is a reading and is kept past the settle',
        clear.rfKorrData.filter(r => r.rf >= 55).length === 80 - 24,
        String(clear.rfKorrData.filter(r => r.rf >= 55).length));
    const off = runL(trimmed(0.75), { ...CFG, highLoadSettleSec: 0 });
    check('with the settle off the clamp gate is off too (archived behaviour)',
        off.dropCensus.highLoadSettle === 0, JSON.stringify(off.dropCensus));
    const noLimits = run(trimmed(0.75));
    check('no binary, no clamp gate — the settle alone still runs',
        noLimits.dropCensus.highLoadSettle === 24, String(noLimits.dropCensus.highLoadSettle));
}

console.log('\n[a flush landing mid-stab does not forget the level the stab rose from]');
{
    const rows = drive([[10, 30], [10, 60], [12, 90]]);
    const batch = run(rows);
    const cut = rows.findIndex(r => r.time >= 21);   // 1 s INTO the stab
    const f1 = run(rows.slice(0, cut));
    const live = run(rows, CFG, f1.resume);
    check('live and batch keep the same samples across the stab boundary',
        live.data.length === batch.data.length && live.data.every((r, i) => r.time === batch.data[i].time),
        `${live.data.length} vs ${batch.data.length}`);
    check('the restep reference rides in the resume', typeof batch.resume.highLoadRefRf !== 'undefined');
}

/**
 * The wait, and the range the panel offers it over, as LITERALS.
 *
 * Both are one number in one place, and neither had anything holding it: the default moved 2.0 ->
 * 1.0 -> 0 across three days on three different arguments, and nothing would have noticed a fourth
 * that nobody meant. The range matters for the same reason in the other direction — the slider used
 * to start at 0.5, so the default this file now pins was not reachable from the control that sets
 * it, and a range edit that put the floor back would silently make it unreachable again.
 *
 * Read from the SOURCE TEXT because the props are JSX inside a component with no seam to call. That
 * is a weakness — a refactor that moves the Slider defeats it — so the extraction fails loudly
 * rather than quietly finding nothing, which is the failure mode that would make this worthless.
 */

console.log('\n[the settle charges rf_korr and leaves the VE stream alone]');
{
    // The whole of the 2026-08-30 second move, in three comparisons. Without these the settle can be
    // wired back onto `validData` — where it spent its entire life until today — and every check
    // above still passes, because they were written against the arrangement it is moving OUT of.
    const rows = drive([[10, 30], [12, 80]]);
    const veOf = (o) => o.data.map(r => r.time).join(',');

    // 1. THE EQUALITY THAT IS THE CHANGE. A 2 s wait and no wait at all must give the VE stream the
    //    same samples, because the wait is not its any more.
    const at2 = run(rows, { ...CFG, transientSettleSec: 2.0 });
    const at0 = run(rows, { ...CFG, transientSettleSec: 0 });
    check('settle 2.0 and settle 0 give the VE stream the same samples',
        veOf(at2) === veOf(at0), at2.data.length + ' vs ' + at0.data.length);
    check('...and the same transient count',
        at2.dropCensus.transient === at0.dropCensus.transient,
        at2.dropCensus.transient + ' vs ' + at0.dropCensus.transient);

    // 2. IT DOES REACH rf_korr — as a FLAG on the row, not as a deletion.
    //    `rfKorrTuner.settledFlags` walks this array with a window bounded on timestamps, so a gap
    //    shorter than its own settle is spanned rather than seen. Deleting these rows made exactly
    //    those gaps, in the middle of pulls, and only ever loosened the tuner's own verdict — the
    //    rows removed are the unsteady ones, so their neighbours had nothing left to look at. The
    //    array must therefore stay INTACT and carry the flag instead.
    const hlOff = run(rows, { ...CFG, transientSettleSec: 2.0, highLoadSettleSec: 0 });
    const noSettle = run(rows, { ...CFG, transientSettleSec: 0, highLoadSettleSec: 0 });
    check('the settle removes NO row from the rf_korr series',
        hlOff.rfKorrData.length === noSettle.rfKorrData.length,
        hlOff.rfKorrData.length + ' vs ' + noSettle.rfKorrData.length);
    const flagged = hlOff.rfKorrData.filter(r => r.settleUnsteady).length;
    check('it marks them instead', flagged > 0, String(flagged));
    check('...and the census names exactly those', hlOff.dropCensus.settle === flagged,
        hlOff.dropCensus.settle + ' against ' + flagged);
    check('with no settle nothing is marked and the census counts none',
        noSettle.dropCensus.settle === 0
        && noSettle.rfKorrData.every(r => !r.settleUnsteady), String(noSettle.dropCensus.settle));
    check('the timestamps are unchanged, one for one',
        hlOff.rfKorrData.map(r => r.time).join(',') === noSettle.rfKorrData.map(r => r.time).join(','));

    // 3. NO DOUBLE COUNTING, and the ORDER that makes the sum work. The high-load settle is the only
    //    thing that REMOVES a row, so everything kept plus that tally is everything the gates were
    //    offered — which is every sample that survived the gates ABOVE them. `transient` is not
    //    among those: the rf_korr push sits above the transient test deliberately, so a sample the
    //    VE stream calls transient has already been counted as rf_korr evidence.
    const both = run(rows, { ...CFG, transientSettleSec: 2.0, highLoadSettleSec: 6.0 });
    const offered = both.rfKorrData.length + both.dropCensus.highLoadSettle;
    const survived = rows.length - (both.droppedCount - both.dropCensus.transient);
    check('every sample offered to rf_korr is either kept or removed exactly once',
        offered === survived, offered + ' vs ' + survived);
    check('...and the transient test runs after that offer, not before',
        both.dropCensus.transient > 0, String(both.dropCensus.transient));
}

console.log('\n[the wait, and the range the panel offers it over]');
{
    check('the default is 0 s — compare against the immediately preceding sample',
        TRANSIENT_SETTLE_SEC_DEFAULT === 0, String(TRANSIENT_SETTLE_SEC_DEFAULT));

    const root = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
    const src = fs.readFileSync(
        path.join(root, 'src', 'components', 'FilterConfigPanel.tsx'), 'utf8');
    const m = src.match(
        /<Slider\s+min=\{([\d.]+)\}\s+max=\{([\d.]+)\}\s+step=\{([\d.]+)\}\s+value=\{settleSec\}/);
    check('the Settle Time slider was found and reads the way this check assumes', !!m,
        'looked for `<Slider min={..} max={..} step={..} value={settleSec}` in FilterConfigPanel.tsx. '
        + 'If it was restructured, update this check — do not delete it.');
    if (m) {
        const [, min, max, step] = m.map(Number);
        check('it reaches the default', min === 0, `min ${min}`);
        check('it stops at 3 s', max === 3, `max ${max}`);
        check('it steps in 0.1 s', step === 0.1, `step ${step}`);
        // A label at one decimal is only honest while the step is at least 0.1.
        check('the readout carries enough decimals for the step',
            /settleSec\.toFixed\(1\)/.test(src) && step >= 0.1, `step ${step}`);
    }
}

console.log(fails === 0 ? '\nAll settle checks passed.\n' : `\n${fails} check(s) FAILED.\n`);
process.exit(fails === 0 ? 0 : 1);
