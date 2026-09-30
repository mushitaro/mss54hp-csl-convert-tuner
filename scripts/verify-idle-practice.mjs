/**
 * PRACTICE has to rehearse the ITERATION, not just the measurement.
 *
 * The rig ran on `KF_LLR_QVS_GRUND` until 2026-09-03 — a map with no consumer in the car and no
 * writer in this tool. Everything about a practice run looked right and one thing was impossible:
 * writing the proposal and running again showed exactly the same error, for ever, because the plant
 * had never heard of the map the correction went into. A driver rehearsing a campaign would have
 * learned that idle tuning does nothing.
 *
 * So this closes the loop end to end, in the units the write actually uses:
 *
 *     bench(stock) -> samples -> tuner -> proposal -> patch KF_LLS_TV -> bench(patched) -> samples
 *
 * and asserts the second pass measures a SMALLER standing error than the first. That single
 * assertion is the one a driver's whole campaign rests on.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readIdleTables, llsTvAt } from '../src/lib/idle/idleTables.ts';
import {
    MockIdleBench, mockValveAirForDuty, MOCK_IDLE_ML_REQUEST_KGH, MOCK_IDLE_CYCLE_SECONDS,
} from '../src/lib/idle/bench.ts';
import {
    tuneIdleFeedforward, idleCensus, rejectSample, sampleGates, idleGateNow, admissionMask,
    isWritableCell, rowsWithWarmEvidence, withPool,
} from '../src/lib/idle/tuner.ts';
import { IDLE_TUNE_DEFAULTS, withDefaults } from '../src/lib/idle/types.ts';
import { expectedHz, LOG_PROFILES } from '../src/lib/log-engine/logProfile.ts';

const binPath = fileURLToPath(new URL('../public/mock/csl-0401-community-patch-v1.partial.bin', import.meta.url));
const buf = fs.readFileSync(binPath);
const stock = readIdleTables(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

let fails = 0;
const check = (n, c, d) => { console.log('  ' + (c ? 'PASS' : 'FAIL') + '  ' + n + (c ? '' : ' — ' + (d ?? ''))); if (!c) fails++; };

/** The mock link's own wiring, without the link: the map end moves, the valve end does not. */
function benchFor(tables) {
    return new MockIdleBench({
        dutyAt: (rpm, ml) => llsTvAt(tables, rpm, ml),
        lossAnchorKgH: MOCK_IDLE_ML_REQUEST_KGH,
    });
}

/** One practice run, sampled at the profile's own rate — the rate the link is priced at. */
function practiceRun(tables) {
    const bench = benchFor(tables);
    const dt = 1 / expectedHz(LOG_PROFILES.IDLE.exchanges);
    const out = [];
    for (let t = 0; t < MOCK_IDLE_CYCLE_SECONDS; t += dt) {
        const r = bench.read(t);
        out.push({
            time: t, rpm: r.rpm, coolantTemp: r.tmot, wdk1: r.wdk1, rf: null,
            nSoll: r.nSoll, ub: r.ub,
            mdLlri: r.mdLlri, mdLlra: r.mdLlra, mdLlraKo: r.mdLlraKo,
            llsTv: r.llsTv, llrQvs: r.llrQvs, llrQsoll: r.llrQvs,
            mlSoll: r.mlSoll, mlSollLls: r.mlSollLls, mlSollMaxLls: r.mlSollMaxLls,
            engineState: r.engineState, kkosSt: r.kkosSt, llsSt: r.llsSt,
        });
    }
    return out;
}

/** Apply a proposal the way the patcher would: the tuned grid becomes the map. */
const applied = (tables, tuned) => ({ ...tables, llsTv: { ...tables.llsTv, values: tuned } });

console.log('\n[the valve is a fixed characteristic, and a stock map delivers what it asks for]');
{
    const duty = llsTvAt(stock, 880, MOCK_IDLE_ML_REQUEST_KGH);
    const air = mockValveAirForDuty(duty);
    check('a stock map is the identity through the valve',
        Math.abs(air - MOCK_IDLE_ML_REQUEST_KGH) < 0.05, `${air} vs ${MOCK_IDLE_ML_REQUEST_KGH}`);
    // More duty must mean more air, or the whole correction is pointed the wrong way.
    check('more duty is more air', mockValveAirForDuty(duty + 1.5) > air);
}

console.log('\n[pass 1: a practice run produces a writable proposal]');
const run1 = practiceRun(stock);
const res1 = tuneIdleFeedforward(run1, stock);
const moved1 = res1.cells.flat().filter(c => c.rejected === null);
{
    check('the run accepts more than one dwell — the script has three idle segments',
        res1.report.dwellsAccepted >= 2, res1.report.dwellsAccepted);
    check('...and the proposal is acceptable', res1.acceptable === true,
        JSON.stringify(res1.report.rejects));
    check('...moving the cells the DME reads at this idle', moved1.length === 2,
        moved1.map(c => `${c.row}:${c.col}`).join(' '));
    check('...upward, because the rig is short of air by design',
        moved1.every(c => c.tuned > c.stock), moved1.map(c => `${c.stock}->${c.tuned}`).join(' '));
}

console.log('\n[pass 2: writing it moves the engine]');
{
    const tuned = applied(stock, res1.tuned);
    const before = llsTvAt(stock, 880, MOCK_IDLE_ML_REQUEST_KGH);
    const after = llsTvAt(tuned, 880, MOCK_IDLE_ML_REQUEST_KGH);
    check('the patched map commands more duty at the operating point', after > before,
        `${before.toFixed(2)} -> ${after.toFixed(2)} %`);

    const run2 = practiceRun(tuned);
    const res2 = tuneIdleFeedforward(run2, tuned);
    check('the second run still measures', res2.report.dwellsAccepted >= 2, res2.report.dwellsAccepted);

    // THE ASSERTION THE WHOLE RIG EXISTS FOR.
    check('the standing error is SMALLER after the write',
        res2.report.worstErrorNm < res1.report.worstErrorNm - 0.2,
        `${res1.report.worstErrorNm.toFixed(2)} -> ${res2.report.worstErrorNm.toFixed(2)} Nm`);
    // ...and it did not overshoot into the other direction, which this DME recovers from worst.
    const e1 = res1.cells.flat().find(c => c.rejected === null)?.errorNm ?? 0;
    const e2 = res2.cells.flat().find(c => c.rejected === null)?.errorNm ?? 0;
    check('...without crossing to the other side of the target in one pass',
        Math.sign(e2) === Math.sign(e1) || Math.abs(e2) < 0.5, `${e1.toFixed(2)} -> ${e2.toFixed(2)}`);
    console.log(`         pass 1 error ${e1.toFixed(2)} Nm  ->  pass 2 error ${e2.toFixed(2)} Nm`
        + `   (duty ${before.toFixed(2)} -> ${after.toFixed(2)} %)`);
}

/**
 * A CAMPAIGN, not a pass.
 *
 * Two passes was not enough to catch the defect that mattered. The rig synthesised its reported
 * `LLS_TV` from a hardcoded line -- `21 + (qvs - 14) * 2.35` -- that knew nothing about the table
 * being written, so RAM and map drifted apart by about 0.9 % per pass while the correction climbed.
 * Passes 1 and 2 wrote fine, and pass 3 crossed `maxModelDeltaPct` and refused EVERY dwell
 * `model-disagrees`: a practice campaign that dies on its third run, having looked healthy twice.
 *
 * So the assertion is monotone convergence over four, which is the shape a driver is being asked to
 * trust when they spend three minutes a pass on it.
 */
console.log('\n[four passes: the campaign converges instead of dying]');
{
    let tables = stock;
    const errs = [];
    for (let pass = 1; pass <= 4; pass++) {
        const res = tuneIdleFeedforward(practiceRun(tables), tables);
        const moved = res.cells.flat().filter(c => c.rejected === null);
        check(`pass ${pass} still accepts dwells`, res.report.dwellsAccepted >= 2,
            `${res.report.dwellsAccepted} dwells, rejects ${JSON.stringify(res.report.rejects)}`);
        check(`...and still writes`, moved.length === 2, moved.length);
        errs.push(moved[0]?.errorNm ?? NaN);
        tables = applied(tables, res.tuned);
    }
    check('the error falls on every pass',
        errs.every((e, i) => i === 0 || Math.abs(e) < Math.abs(errs[i - 1])),
        errs.map(e => e.toFixed(2)).join(' -> '));
    check('...and never crosses the target', errs.every(e => e > 0),
        errs.map(e => e.toFixed(2)).join(' '));
    check('...reaching under 0.5 Nm by the fourth', Math.abs(errs[3]) < 0.5, errs[3].toFixed(2));
    console.log('         ' + errs.map(e => e.toFixed(2) + ' Nm').join('  ->  '));
}

/**
 * The reported channels ARE the chain, not a parallel invention of it.
 *
 * The check that would have caught the hardcoded line on day one: whatever the map says at the
 * operating point is what `LLS_TV` must read, and the demand must stay the demand rather than
 * become the air the valve happened to deliver.
 */
console.log('\n[the rig reports the chain it runs]');
{
    const tuned = applied(stock, tuneIdleFeedforward(practiceRun(stock), stock).tuned);
    for (const [name, t] of [['stock', stock], ['after one write', tuned]]) {
        const rows = practiceRun(t).filter(x => x.llsTv !== null && x.engineState === 4);
        const last = rows[rows.length - 1];
        check(`${name}: LLS_TV is the map's own answer at the operating point`,
            Math.abs(last.llsTv - llsTvAt(t, last.rpm, last.mlSollLls)) < 1e-6,
            `${last.llsTv} vs ${llsTvAt(t, last.rpm, last.mlSollLls)}`);
        check(`${name}: the demand stays the demand`,
            Math.abs(last.mlSollLls - MOCK_IDLE_ML_REQUEST_KGH) < 1e-6, last.mlSollLls);
    }
}

/**
 * THE LIVE RAIL — what the driver watches for three minutes.
 *
 * The picture under the trace now says, while the engine is running, which conditions hold and how
 * much longer the window has to be held. That is a countdown, and a countdown computed a second way
 * is a countdown that can reach zero without the dwell being accepted — which is worse than none,
 * because the driver would stop holding on its word.
 *
 * So the assertions here are all one shape: the LIVE answer and the FINAL answer come from the same
 * functions and must not be able to disagree.
 */
console.log('\n[the rail agrees with the verdict it is counting down to]');
{
    const samples = practiceRun(stock);
    const o = withDefaults(undefined);
    const ctx = {
        hasLlBit: samples.some(s => s.engineState !== null),
        hasCompressor: samples.some(s => s.kkosSt !== null),
    };

    // 1. One list, two consumers. The chips are lit from `sampleGates`; the census counts
    //    `rejectSample`. They were one function before the rail existed and they still are.
    let mismatch = 0;
    for (const s of samples) {
        const first = sampleGates(s, o, ctx).find(g => g.ok === false)?.reason ?? null;
        if (first !== rejectSample(s, o, ctx)) mismatch++;
    }
    check('every chip that goes dark is the rejection the census counts', mismatch === 0, mismatch);

    // 2. The ribbon IS the admission, not a redrawing of it.
    const rep = idleCensus(samples, stock);
    const lit = admissionMask(samples).filter(Boolean).length;
    check('the ribbon lights exactly the admitted samples', lit === rep.samplesAdmitted,
        `${lit} lit vs ${rep.samplesAdmitted} admitted`);

    // 3. THE COUNTDOWN. At the instant each accepted dwell closes, the rail must already be
    //    reporting a full hold and no blockage — the driver was told to keep holding right up to
    //    the moment the window was taken.
    const accepted = rep.dwells.filter(d => !d.rejected);
    check('the run produced windows to check', accepted.length >= 2, accepted.length);
    let early = 0;
    let blockedAtClose = 0;
    for (const d of accepted) {
        const now = idleGateNow(samples.slice(0, d.endIndex + 1));
        if (!now || now.heldSec < now.needSec) early++;
        if (now?.blocking) blockedAtClose++;
    }
    check('the HOLD bar is full at the moment every accepted window closes', early === 0, early);
    check('...and no chip is dark there', blockedAtClose === 0, blockedAtClose);

    // 4. And it is not simply always full: a rev segment must read as blocked, with the reason the
    //    census would file it under.
    const revving = samples.findIndex(s => s.rpm > 1500);
    check('the script contains a segment outside the gates', revving > 0, revving);
    const off = idleGateNow(samples.slice(0, revving + 1));
    check('...where the rail says NOT RECORDING', off?.blocking !== null && off?.blocking !== undefined,
        off?.blocking);
    check('...naming the same reason the census would', off?.blocking === rejectSample(samples[revving], o, ctx),
        `${off?.blocking} vs ${rejectSample(samples[revving], o, ctx)}`);
    check('...and the hold has collapsed to nothing', (off?.heldSamples ?? -1) === 0, off?.heldSamples);
}

/**
 * THE PROPOSAL TABLE shows cells the correction can reach.
 *
 * It used to show `cells[cells.length - 1]` — the LAST air row, 85 kg/h, refused `cold-row` on
 * every run there will ever be — under a heading that read "85 °C". Wrong row, wrong unit, and a
 * table of proposals in which nothing could ever be proposed. Both ends now read `isWritableCell`.
 */
console.log('\n[the proposal table can contain a proposal]');
{
    const res = tuneIdleFeedforward(practiceRun(stock), stock);
    const shown = res.cells.flat().filter(c => isWritableCell(c.row, c.col));
    check('the writable set is not empty', shown.length > 0, shown.length);
    check('...and excludes the stall column', shown.every(c => c.col > 0));
    check('...and the authority floor row', shown.every(c => c.row > 0));
    // NOT `row <= 1` any more. That was an assumption about where warm idle sits — around 14 kg/h,
    // which lands on rows 0-1 — and session #936 idles at 18.15, putting 63 % of the DME's own
    // lookup weight on the 20 kg/h row the rule refused. `isWritableCell` is now structural only.
    check('...and nothing else structurally', shown.length === (res.cells.length - 1) * (res.cells[0].length - 1),
        `${shown.length} of ${(res.cells.length - 1) * (res.cells[0].length - 1)}`);

    // WHICH rows a run may write is the evidence's answer now. The bench idles at 14 kg/h, so its
    // warm dwells read rows 0 and 1 — row 0 is the floor, leaving row 1, which is exactly what it
    // wrote before. The rule changed; this rig's behaviour did not, and the four-pass convergence
    // above is the same numbers it always was.
    const acc = idleCensus(practiceRun(stock), stock).dwells.filter(d => !d.rejected);
    const rows = rowsWithWarmEvidence(stock.llsTv, acc);
    check('the writable rows come from the evidence', rows.size > 0, [...rows].join(' '));
    check('...and on this rig that is where it idles', [...rows].every(r => stock.llsTv.y[r] <= 15),
        [...rows].map(r => stock.llsTv.y[r]).join(' '));

    // The thing that makes the table worth reading: what actually moved is inside what is shown.
    const moved = res.cells.flat().filter(c => c.tuned !== c.stock);
    check('every cell that moves is on screen', moved.length > 0
        && moved.every(m => shown.some(c => c.row === m.row && c.col === m.col)),
        moved.map(c => `${c.row}:${c.col}`).join(' '));
    check('...and only on rows the warm evidence reached', moved.every(c => rows.has(c.row)),
        moved.map(c => c.row).join(' '));
    // A row nothing measured is refused for that, not for being "cold".
    const far = res.cells.flat().find(c => c.row > 2 && c.col > 0);
    check('a row with no warm evidence is refused no-evidence', far?.rejected === 'no-evidence',
        `${far?.row}:${far?.col} ${far?.rejected}`);
    // And the heading beside it is air, not coolant — 15 kg/h, the second breakpoint of the y axis.
    check('the row heading is the air breakpoint', moved[0].tmot === stock.llsTv.y[1],
        `${moved[0].tmot} vs ${stock.llsTv.y[1]}`);
}

/**
 * THE RACK CAN ONLY DRAW A GATE THAT DECIDES.
 *
 * The first version of the gauge pane drew twelve bars and five came from `evaluateIdlePreflight`,
 * whose only consumer in the whole app was that component — nothing in the write path has ever read
 * it. A driver watched LWS_LRW and EVAN1_IST change colour beside gates that were throwing the run
 * away, with nothing on screen saying which was which. Meanwhile four gates that DO refuse a window
 * were not drawn at all.
 *
 * The fix was structural: the rack reads its readings off the `IdleDwell` that `judgeWindow`
 * produces, so it cannot show a number the verdict did not use. These assertions pin that.
 */
console.log('\n[the bars are the verdict, not a second opinion]');
{
    const samples = practiceRun(stock);
    const o = IDLE_TUNE_DEFAULTS;
    const rep = idleCensus(samples, stock);
    check('the run produced windows to check', rep.dwells.length >= 3, rep.dwells.length);

    // 1. Every window statistic the rack draws is on the dwell, and agrees with the gate it feeds.
    let missing = 0;
    let disagree = 0;
    for (const d of rep.dwells) {
        for (const k of ['ubDrift', 'ubOffset', 'nSollDrift', 'statDisagree', 'errorDrift']) {
            if (typeof d[k] !== 'number' || !Number.isFinite(d[k])) missing++;
        }
        if (d.rejected === 'electrical-load'
            && !(d.ubDrift > o.maxUbDriftV || d.ubOffset > o.maxUbDriftV)) disagree++;
        if (d.rejected === 'target-moving' && !(d.nSollDrift > o.maxNSollDriftRpm)) disagree++;
        if (d.rejected === 'unsteady' && !(d.statDisagree > o.maxStatDisagreeNm)) disagree++;
        if (d.rejected === 'integrator-drifting' && !(d.errorDrift > o.maxMdLlriDriftNm)) disagree++;
        if (d.rejected === 'model-disagrees'
            && !(d.modelDeltaPct !== null && Math.abs(d.modelDeltaPct) > o.maxModelDeltaPct)) disagree++;
    }
    check('every statistic the rack draws is on the dwell', missing === 0, `${missing} missing`);
    check('...and a refusal is always consistent with the number shown for it', disagree === 0, disagree);

    // 2. The LIVE window is the same judgement, not a parallel one.
    const accepted = rep.dwells.filter(d => !d.rejected);
    let mismatched = 0;
    for (const d of accepted) {
        const w = idleGateNow(samples.slice(0, d.endIndex + 1), stock)?.window;
        if (!w || w.rejected !== null
            || Math.abs(w.errorDrift - d.errorDrift) > 1e-9
            || Math.abs(w.statDisagree - d.statDisagree) > 1e-9
            || Math.abs(w.ubDrift - d.ubDrift) > 1e-9) mismatched++;
    }
    check('the live window IS the census window at the moment it closes', mismatched === 0, mismatched);

    // 3. The gates that were invisible now have readings. `model-disagrees` above all: it is the one
    //    that says whether KF_LLS_TV is the map driving the valve at all.
    const w = idleGateNow(samples, stock)?.window;
    check('the model gate has a reading', w != null && w.modelDeltaPct !== null, w?.modelDeltaPct);
    check('...and on a stock rig the map agrees with the duty',
        w != null && Math.abs(w.modelDeltaPct) < o.maxModelDeltaPct, w?.modelDeltaPct);
    check('the voltage gate has a reading', typeof w?.ubDrift === 'number', w?.ubDrift);
    check('the target-drift gate has a reading', typeof w?.nSollDrift === 'number', w?.nSollDrift);
    check('the statistic gate has a reading', typeof w?.statDisagree === 'number', w?.statDisagree);
}

/**
 * The preflight is DIAGNOSIS, and nothing in the write path reads it.
 *
 * Stated as a test rather than a comment because it is the finding that caused the rack to be
 * rebuilt, and because it is the sort of thing that quietly stops being true. If a later change
 * makes the tuner consult the preconditions, this fails and the rack should gain them back.
 */
console.log('\n[the preflight gates nothing, and the tuner says so]');
{
    const src = fs.readFileSync(fileURLToPath(new URL('../src/lib/idle/tuner.ts', import.meta.url)), 'utf8');
    check('the write path does not consult evaluateIdlePreflight', !src.includes('evaluateIdlePreflight'));
    check('...nor import that module at all', !src.includes("from './preflight'"));
}

/**
 * LIMP-HOME IS A STATE, NOT A DUTY A RUN PASSES THROUGH.
 *
 * `limpSeen` scanned every sample for a duty within 1 % of `K_LLS_TV_NOTLAUF_MIN` (3 %) or
 * `_MAX` (75 %), and it is fatal to the whole run. On any log with driving in it the valve sweeps
 * the range as the throttle opens, so it crosses 75 % every time — sessions #937 and #938 are
 * ordinary drives with idles in them, their accepted windows sat at 35.8-36.4 % duty, and both were
 * refused on the strength of a sample taken at 2400 rpm.
 */
console.log('\n[a throttle sweep is not limp-home]');
{
    const base = practiceRun(stock);
    const warm = base.filter(s => s.coolantTemp >= 80 && s.engineState === 4);
    check('the rig has warm samples to work with', warm.length > 50, warm.length);

    // One sample at the limp duty, while the throttle is open and the engine is off idle: exactly
    // what a gearchange looks like. It must not condemn the run.
    const t = base[base.length - 1].time;
    const sweep = [...base, { ...base[base.length - 1], time: t + 1, rpm: 2400, wdk1: 25, llsTv: 75.0 }];
    const withSweep = idleCensus(sweep, stock);
    check('a limp duty at open throttle does not flag the run',
        withSweep.limpSeen === false, `limpSeen=${withSweep.limpSeen}`);
    check('...and the run still writes', tuneIdleFeedforward(sweep, stock).acceptable === true);

    // The same duty at warm settled idle IS the valve parked on its rail, and still condemns it.
    const parked = base.map(s => (s.coolantTemp >= 80 && s.engineState === 4 && (s.wdk1 ?? 0) <= 0.8
        ? { ...s, llsTv: 75.0 } : s));
    check('a limp duty AT IDLE still flags the run', idleCensus(parked, stock).limpSeen === true);
    check('...and the run is refused', tuneIdleFeedforward(parked, stock).acceptable === false);
}

/**
 * POOLING — three drives on three occasions are three independent observations.
 *
 * `minCellDwells` wants two INDEPENDENT dwells, and this car produced exactly one accepted window
 * per run across four runs on the same BASE. Every session refused to write because it could only
 * see its own, which is a filing technicality rather than a fact about the evidence.
 *
 * `withPool` lays earlier runs end to end in front of the current one with a seam wider than
 * `compressorLockoutSec`, so windows cannot merge across a seam and an exclusion in one run cannot
 * reach into another.
 */
console.log('\n[earlier runs on the same BASE are evidence]');
{
    // One run, cut down until it yields a single accepted window — the shape every real run had.
    const full = practiceRun(stock);
    const oneWindow = full.filter(s => s.time < 95);
    const alone = idleCensus(oneWindow, stock);
    check('a single 90 s idle gives exactly one window', alone.dwellsAccepted === 1, alone.dwellsAccepted);
    check('...and alone it cannot write', tuneIdleFeedforward(oneWindow, stock).acceptable === false);

    // Two such runs, pooled, are two observations and clear the gate.
    const pooled = withPool(oneWindow, oneWindow);
    const rep = idleCensus(pooled, stock);
    check('two of them pooled are two windows', rep.dwellsAccepted === 2, rep.dwellsAccepted);
    check('...and now it writes', tuneIdleFeedforward(pooled, stock).acceptable === true);

    // THE SEAM. The two runs must not merge into one window, or pooling would manufacture evidence
    // rather than collect it.
    const durations = rep.dwells.filter(d => !d.rejected).map(d => Math.round(d.durationSec));
    check('the seam keeps them apart', durations.length === 2
        && durations.every(d => d < 95), durations.join(' '));

    // An empty pool changes nothing, which is what makes this safe to apply unconditionally.
    check('an empty pool is the identity', withPool([], oneWindow).length === oneWindow.length);
    check('...and leaves the verdict alone',
        idleCensus(withPool([], oneWindow), stock).dwellsAccepted === alone.dwellsAccepted);
}

console.log('\n' + (fails ? `\n${fails} FAILURE(S)` : '\nALL PASS'));
process.exit(fails ? 1 : 0);
