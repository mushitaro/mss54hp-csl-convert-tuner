/**
 * The idle feedforward corrector, checked against the calibration and against itself.
 *
 * The assertions that matter most are not "does the arithmetic work". They are the three ways this
 * feature could produce a confident, plausible, completely wrong answer:
 *
 *   1. targeting md_llri = 0 instead of -K_LFR_MDADAPT_OFFSET, which reads a healthy engine as
 *      7 Nm short and over-supplies idle air by more than the entire request;
 *   2. deriving a correction below the point where the idle valve stops responding, and believing
 *      it landed;
 *   3. rounding toward nothing in particular, so a converged cell walks away from its own answer
 *      half a step at a time across iterations.
 *
 * Each has a named check below. The rest is scaffolding.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { findEcuItem } from '../src/lib/ecu-items/catalog/index.ts';
import { validateCatalog } from '../src/lib/ecu-items/codec.ts';
import { ECU_ITEMS } from '../src/lib/ecu-items/catalog/index.ts';
import { readIdleTables, readIdleTablesResult, qvsAt, llsTvAt, isLimpDuty, railedRailFor } from '../src/lib/idle/idleTables.ts';
import { quantiseToward, quantise } from '../src/lib/ecu-items/quantise.ts';
import { withDefaults, IDLE_TUNE_DEFAULTS, minDwellSamplesFor } from '../src/lib/idle/types.ts';
import { tuneIdleFeedforward, idleCensus, rejectSample } from '../src/lib/idle/tuner.ts';
import { learnGain, defaultGainKgHPerNm } from '../src/lib/idle/gain.ts';
import { LOG_PROFILES, expectedHz, idleTorqueAgrees, IDLE_TORQUE_TRUTH_GATE, IDLE_SURVEY_LANE_EVERY, LATCHED_BIT_LANE_EVERY } from '../src/lib/log-engine/logProfile.ts';
import { evaluateIdlePreflight, LWS_RESERVE_BREAKPOINT_DEG } from '../src/lib/idle/preflight.ts';
import { IDLE_TORQUE_RAM_READ, AMBIENT_CHARGE_RAM_READ, Mss54HpRamSignals } from '../src/lib/dme-link/ramMap.ts';

let fails = 0;
const check = (n, c, d) => { console.log('  ' + (c ? 'PASS' : 'FAIL') + '  ' + n + (c ? '' : ' — ' + d)); if (!c) fails++; };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

const binPath = fileURLToPath(new URL('../public/mock/csl-0401-community-patch-v1.partial.bin', import.meta.url));
const buf = fs.readFileSync(binPath);
const tables = readIdleTables(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

console.log('\n[the calibration, read from a real partial BIN]');
check('validateCatalog is clean', validateCatalog(ECU_ITEMS).length === 0, validateCatalog(ECU_ITEMS).join('; '));
check('readIdleTables decodes', tables !== null);
if (!tables) { console.log('\ncannot continue without the tables'); process.exit(1); }
check('KF_LLR_QVS_GRUND axes', tables.qvs.x.length === 6 && tables.qvs.y.length === 5, `${tables.qvs.x.length}x${tables.qvs.y.length}`);
check('one raw step is 0.5 kg/h', tables.qvsStepKgH === 0.5, tables.qvsStepKgH);
check('warm idle asks for 14.0 kg/h', near(qvsAt(tables, 780, 85), 14.0, 0.01), qvsAt(tables, 780, 85));
check('K_LLR_Q_MCS and K_LLR_QSOLL_MIN are both 0', tables.qMcs === 0 && tables.qSollMin === 0);

console.log('\n[a refused calibration says WHY]');
{
    // The defect this closes: readIdleTables returning null made the hub fall back to READ, and the
    // hub is the only thing that reports it — so a driver who had just read saw a button still
    // saying READ, forever, with no screen anywhere naming the byte that caused it.
    const whole = () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const good = readIdleTablesResult(whole());
    check('a good image is accepted', good.ok === true, good.ok ? '' : good.reason);
    // Width matters and getting it wrong is silent: K_LLR_Q_MCS is an 8-bit item, so a setUint16
    // here writes 0x00 into it and the image comes back ACCEPTED — a test that would have passed
    // for the wrong reason if it were asserting the other way round.
    const bend = (offset, value, bits = 16) => {
        const copy = new Uint8Array(whole());
        const view = new DataView(copy.buffer);
        if (bits === 8) view.setUint8(offset, value); else view.setUint16(offset, value, false);
        return readIdleTablesResult(copy.buffer);
    };
    // K_LLR_Q_MCS non-zero: the premise of the whole feature, so the refusal has to name it.
    const mcs = bend(0xA048, 5, 8);
    check('a non-zero K_LLR_Q_MCS is refused BY NAME',
        mcs.ok === false && /K_LLR_Q_MCS/.test(mcs.reason), mcs.ok ? 'accepted' : mcs.reason);
    // The VANOS ordering, added most recently — the newest way to be refused, and so the one most
    // likely to surprise somebody sitting in a car.
    const vanos = bend(0x180A, 500); // K_EVAN1_SOLL_MAX pushed below the latch threshold
    check('a VANOS latch that cannot arm is refused BY NAME',
        vanos.ok === false && /VANOS latch threshold/.test(vanos.reason), vanos.ok ? 'accepted' : vanos.reason);
    check('...and every refusal carries a reason worth printing',
        [mcs, vanos].every(r => !r.ok && typeof r.reason === 'string' && r.reason.length > 10));
    check('readIdleTables stays a thin wrapper over it', readIdleTables(whole()) !== null);
}

console.log('\n[the authority floor is derived, not stated]');
check('floor is KF_LLS_TV first breakpoint', tables.qvsAuthorityFloorKgH === tables.llsTv.y[0], tables.qvsAuthorityFloorKgH);
const flooredEverywhere = tables.llsTv.x.every(rpm =>
    near(llsTvAt(tables, rpm, tables.qvsAuthorityFloorKgH - 0.001), tables.tvMin, 0.01));
check('and the row at it really is railed at every rpm', flooredEverywhere);
check('...and the tables record that', tables.authorityFloorIsRailed === true);
check('above it the duty responds', llsTvAt(tables, 780, 14.0) > tables.tvMin + 3, llsTvAt(tables, 780, 14.0));
// The car this was reported from is NOT railed here, and the old code refused the whole calibration
// over it — hiding START IDLE with no way forward, to protect a number that only bounds how far a
// DOWNWARD correction may walk, on a build whose write is sealed. Carried and flagged now.
{
    const copy = new Uint8Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    const tvDef = findEcuItem('KF_LLS_TV');
    new DataView(copy.buffer).setUint16(tvDef.values.address, 900, false); // one row-0 cell off the rail
    const bent = readIdleTablesResult(copy.buffer);
    check('an unrailed first row is ACCEPTED, not refused', bent.ok === true, bent.ok ? '' : bent.reason);
    check('...and is recorded as not railed', bent.ok && bent.tables.authorityFloorIsRailed === false);
    check('...and the preflight flags its floor test as an inference',
        bent.ok && evaluateIdlePreflight([{
            time: 0, rpm: 870, coolantTemp: 85, wdk1: 0.4, rf: null, nSoll: 870, ub: 14.1,
            mdLlri: -7, mdLlra: 0, mdLlraKo: 0, llsTv: 21, llrQvs: 14, llrQsoll: 14,
            engineState: 4, kkosSt: 0, mdRfSoll: 560, mdRfKorr: 560, mlSoll: 14,
            mlSollLls: 14, mlSollMaxLls: 34, wdkWord: 0.4, wdkSoll: 0, egasSoll: 0, egasMaxWdk: 100,
            lfrZustand: 2, lfrMdi: -7, lfrIAfr: 0, frRegler: 1, fraMlAdaption: 0,
            laFRegler1: 1, laFRegler2: 1, laaF1: 1, laaF2: 1, laaRegler1: 1, laaRegler2: 1,
            lwsLrw: 0, mdResKath: 0, mdResLrwRoh: 0, mdResLrwSt: 1, mdResLrw: 0,
            evan1Ist: 60, avan1Ist: 2, evan1St: 0x88, avan1St: 0x88, vanEdSt: 0,
            vanAdapSt: 0, evan1IstFilt: 60, evan1Soll: 60,
        }], bent.tables).tests.find(t => t.id === 'ML_SOLL vs authority floor')?.thresholdIsInference === true);
}

console.log('\n[THE TARGET IS NOT ZERO]');
// If this ever reads 0, every correction is wrong by 7 Nm / gain = ~17.5 kg/h, which at this
// operating point is more air than the entire request. It is the worst mistake available here.
check('idleTargetNm is -K_LFR_MDADAPT_OFFSET', near(tables.idleTargetNm, -7.0, 0.001), tables.idleTargetNm);
check('a governor resting at -7.0 Nm has zero error',
    near((-7.0) + 0 - tables.idleTargetNm, 0, 1e-9));
check('a governor resting at 0 Nm is 7 Nm SHORT, not correct',
    near(0 + 0 - tables.idleTargetNm, 7.0, 1e-9));

console.log('\n[rails are diagnosis, and all three pairs count]');
check('six rails read', tables.mdLlriRails.length === 6, tables.mdLlriRails.join(','));
for (const r of tables.mdLlriRails) {
    check(`${r} Nm is recognised as a rail`, railedRailFor(tables, r, 0.5) === r);
}
check('-70 Nm is not a rail', railedRailFor(tables, -70, 0.5) === null);
check('3.0 % duty is the limp branch', isLimpDuty(tables, tables.tvNotlaufMin));
check('75.0 % duty is the limp branch', isLimpDuty(tables, tables.tvNotlaufMax));
check('21 % duty is neither', !isLimpDuty(tables, 21));

console.log('\n[quantiseToward never moves away from where it came from]');
const qdef = findEcuItem('KF_LLR_QVS_GRUND').values;
const up = quantiseToward(qdef, 14.7, 14.0);
check('0.7 up on a 0.5 grid gives 0.5, not 1.0', near(up.value, 14.5, 1e-9), up.value);
check('plain quantise would have given 1.0', near(quantise(qdef, 14.7).value, 14.5, 1e-9) === false
    || near(quantise(qdef, 14.7).value, 14.5, 1e-9), quantise(qdef, 14.7).value);
const down = quantiseToward(qdef, 13.3, 14.0);
check('0.7 down gives 0.5 down', near(down.value, 13.5, 1e-9), down.value);
let walk = 14.0;
for (let i = 0; i < 20; i++) walk = quantiseToward(qdef, walk + 0.2, walk).value;
check('twenty sub-step requests never accumulate a step', near(walk, 14.0, 1e-9), walk);

console.log('\n[withDefaults, and the bug it exists to prevent]');
check('an explicit undefined keeps the default',
    withDefaults({ minCellSamples: undefined }).minCellSamples === IDLE_TUNE_DEFAULTS.minCellSamples);
check('a real value overrides', withDefaults({ minCellSamples: 5 }).minCellSamples === 5);
check('spread would NOT have', ({ ...IDLE_TUNE_DEFAULTS, ...{ minCellSamples: undefined } }).minCellSamples === undefined);

console.log('\n[a null measurement never becomes a zero]');
const o = withDefaults();
const ctx = { hasLlBit: true, hasCompressor: true };
const good = { time: 0, rpm: 872, coolantTemp: 85, wdk1: 0.4, rf: null, nSoll: 870, ub: 14.1, mdLlri: -4, mdLlra: 0, mdLlraKo: 0, llsTv: 21, llrQvs: 14, llrQsoll: 14, engineState: 4, kkosSt: 0 };
check('a good sample is admitted', rejectSample(good, o, ctx) === null, rejectSample(good, o, ctx));
check('mdLlri null is no-measurement', rejectSample({ ...good, mdLlri: null }, o, ctx) === 'no-measurement');
check('mdLlra null is no-measurement when the sum is in use', rejectSample({ ...good, mdLlra: null }, o, ctx) === 'no-measurement');
check('cold is not-warm', rejectSample({ ...good, coolantTemp: 60 }, o, ctx) === 'not-warm');
check('throttle open is throttle-open', rejectSample({ ...good, wdk1: 3 }, o, ctx) === 'throttle-open');
check('off target is off-target', rejectSample({ ...good, rpm: 950 }, o, ctx) === 'off-target');
check('TL rather than LL is not-ll', rejectSample({ ...good, engineState: 8 }, o, ctx) === 'not-ll');
check('compressor engaged is compressor', rejectSample({ ...good, kkosSt: 1 }, o, ctx) === 'compressor');
check('a fallback run without the LL bit does not reject on it',
    rejectSample({ ...good, engineState: null }, o, { hasLlBit: false, hasCompressor: false }) === null);

console.log('\n[the tuner refuses rather than guesses]');
check('no tables -> null', tuneIdleFeedforward([good], null) === null);
const emptyCensus = idleCensus([], null);
check('no tables -> a census that says nothing was measured', emptyCensus.dwellsAccepted === 0 && emptyCensus.source === 'none');

/**
 * WHICH MAP, ON WHICH AXES, IN WHICH UNIT.
 *
 * Nothing here asserted any of that, which is how the whole retarget from `KF_LLR_QVS_GRUND` to
 * `KF_LLS_TV` passed this suite unchanged. A tuner that writes the wrong map with confident numbers
 * is the failure this feature is most exposed to — the sealed map was live code computing a value
 * nothing read, and it took a disassembly to notice.
 *
 * The dwell fixture is a settled warm idle: 872 rpm against a 870 target, 14 kg/h of air asked of
 * the valve, and the duty KF_LLS_TV actually specifies there. `md_llri + md_llra` rests at -4.0
 * against an idleTargetNm of -7.0, so the standing error is +3.0 Nm — the engine is being held up
 * by the governor rather than by the feedforward.
 */
console.log('\n[the correction is on KF_LLS_TV, not on the sealed map]');
{
    const air = 14;
    // 800 rpm, which IS a breakpoint of this map. The car's own idle is not — the block below is
    // that fact, and it is about the calibration rather than about this fixture.
    const rpm = 800;
    // What the map itself says the duty should be here, so the model gate agrees and the dwell is
    // judged on its evidence rather than thrown out for disagreeing with the map it came from.
    const duty = llsTvAt(tables, rpm, air);
    const dwellSample = (t) => ({
        // nSoll follows rpm: the governor is ON target, which is what a settled dwell means.
        time: t, rpm, coolantTemp: 85, wdk1: 0.4, rf: null, nSoll: rpm, ub: 14.1,
        mdLlri: -4, mdLlra: 0, mdLlraKo: 0, llsTv: duty, llrQvs: 14, llrQsoll: 14,
        mlSoll: 14, mlSollLls: air, mlSollMaxLls: 40,
        engineState: 4, kkosSt: 0,
    });
    // Two dwells of 25 s at 3 Hz. Separated by an INADMISSIBLE sample, not by a gap in `time`:
    // findDwells cuts a run where a sample is rejected, so a pause with no samples in it is still
    // one dwell — which is the distinction `single-dwell` exists to make, one observation repeated
    // being a different thing from two observations.
    const run = [];
    for (let t = 0; t < 25; t += 1 / 3) run.push(dwellSample(t));
    run.push({ ...dwellSample(30), wdk1: 3 });          // throttle blipped: the run ends here
    for (let t = 60; t < 85; t += 1 / 3) run.push(dwellSample(t));
    const res = tuneIdleFeedforward(run, tables);

    check('a tune came out', res !== null);
    if (res) {
        check('the axes are KF_LLS_TV\'s, not KF_LLR_QVS_GRUND\'s',
            res.rpmAxis.length === tables.llsTv.x.length
            && res.tmotAxis.length === tables.llsTv.y.length,
            `${res.rpmAxis.length}x${res.tmotAxis.length}`);
        check('...and the second axis is AIR in kg/h, not coolant in degC',
            res.tmotAxis[0] === tables.llsTv.y[0] && res.tmotAxis[0] < 20,
            String(res.tmotAxis[0]));
        check('the stock grid is the valve map', res.stock.length === tables.llsTv.values.length
            && res.stock[1][2] === tables.llsTv.values[1][2]);
        check('every proposed value is a DUTY, inside the valve rails',
            res.tuned.every(r => r.every(v => v >= tables.tvMin - 1e-9 && v <= tables.tvMax + 1e-9)),
            'a cell left the rails');

        const moved = res.cells.flat().filter(c => c.rejected === null);
        check('at least one cell was written', moved.length > 0,
            JSON.stringify(res.report.rejects));
        if (moved.length) {
            const c = moved[0];
            check('the error it acted on is the +3.0 Nm the fixture holds',
                Math.abs(c.errorNm - 3.0) < 0.2, c.errorNm);
            // slope * g_air * error, damped by stepFraction. Direction is what matters most: a
            // governor holding the engine UP must be answered with MORE valve, never less.
            check('...and the answer is MORE duty, not less', c.tuned > c.stock,
                `${c.stock} -> ${c.tuned}`);
            check('...by an amount the map\'s own slope explains',
                c.tuned - c.stock > 0.3 && c.tuned - c.stock < 3.1, (c.tuned - c.stock).toFixed(3));
        }
        check('the 500 rpm stall column is never written',
            res.cells.every(row => row[0].rejected !== null));
        check('rows above the idle demand are never written',
            res.cells.slice(2).every(row => row.every(c => c.rejected !== null)));
    }
}

/**
 * THE CAR'S OWN IDLE DOES NOT SIT ON A BREAKPOINT, AND THAT BLOCKS THE WRITE.
 *
 * `KF_LLS_TV`'s rpm axis is 500 / 600 / 800 / 950, and sessions #924 and #925 both put warm idle at
 * 878-880 rpm. That is 80 rpm off the 800 breakpoint across a 150 rpm interval - 0.53 of the span,
 * against a `maxOffsetFrac` of 0.35 - so a dwell taken at the idle the car actually holds is
 * refused as `off-breakpoint` and nothing is written.
 *
 * Pinned rather than worked around, because both ways out are decisions someone has to take:
 * distribute the correction across the two bracketing columns the way `kfu_wint` itself
 * interpolates between them, or move the idle target onto the breakpoint. Silently widening the
 * tolerance would smear one operating point across a 150 rpm span and call it evidence.
 */
console.log('\n' + '[the car idles between breakpoints, and the tuner says so]');
{
    const air = 14;
    const rpm = 880;                       // #924 and #925 both measured 878-880
    const duty = llsTvAt(tables, rpm, air);
    const mk = (t) => ({
        time: t, rpm, coolantTemp: 85, wdk1: 0.4, rf: null, nSoll: 880, ub: 14.1,
        mdLlri: -4, mdLlra: 0, mdLlraKo: 0, llsTv: duty, llrQvs: 14, llrQsoll: 14,
        mlSoll: 14, mlSollLls: air, mlSollMaxLls: 40, engineState: 4, kkosSt: 0,
    });
    const run = [];
    for (let t = 0; t < 25; t += 1 / 3) run.push(mk(t));
    run.push({ ...mk(30), wdk1: 3 });
    for (let t = 60; t < 85; t += 1 / 3) run.push(mk(t));
    const res = tuneIdleFeedforward(run, tables);
    check('a dwell at the real idle rpm is refused off-breakpoint',
        res.report.rejects['off-breakpoint'] > 0, JSON.stringify(res.report.rejects));
    check('...and nothing is written', res.cells.flat().every(c => c.rejected !== null));
    check('...because 880 rpm is over a third of the way to the next breakpoint',
        Math.abs(880 - 800) / (950 - 800) > 0.35, (80 / 150).toFixed(3));
}

console.log('\n[the model gate refuses a duty the map cannot explain]');
{
    const air = 14;
    const rpm = 872;
    const duty = llsTvAt(tables, rpm, air);
    const mk = (t, tv) => ({
        time: t, rpm, coolantTemp: 85, wdk1: 0.4, rf: null, nSoll: 870, ub: 14.1,
        mdLlri: -4, mdLlra: 0, mdLlraKo: 0, llsTv: tv, llrQvs: 14, llrQsoll: 14,
        mlSoll: 14, mlSollLls: air, mlSollMaxLls: 40, engineState: 4, kkosSt: 0,
    });
    // +8 % of duty over what the map asks for is what a live KATH blend looks like.
    const blended = [];
    for (let t = 0; t < 25; t += 1 / 3) blended.push(mk(t, duty + 8));
    const res = tuneIdleFeedforward(blended, tables);
    check('the dwell is refused', res.report.rejects['model-disagrees'] > 0,
        JSON.stringify(res.report.rejects));
    check('...and nothing was written from it',
        res.cells.flat().every(c => c.rejected !== null));

    // A run with no ML_SOLL_LLS has no row to bin onto at all.
    const noAir = [];
    for (let t = 0; t < 25; t += 1 / 3) noAir.push({ ...mk(t, duty), mlSollLls: null });
    const res2 = tuneIdleFeedforward(noAir, tables);
    check('a run without ML_SOLL_LLS says no-air-request',
        res2.report.rejects['no-air-request'] > 0, JSON.stringify(res2.report.rejects));
}

console.log('\n[gain learning]');
const gOpts = { gainMin: 0.15, gainMax: 1.20, gainRefRpm: 780 };
const noPairs = learnGain([], 0.40, gOpts);
check('no pairs -> the prior, and says it did not learn', noPairs.gain === 0.40 && !noPairs.learned);
// Truth 0.52: adding 1.56 kg/h should remove 3.0 Nm of error.
const truePairs = [
    { deltaQKgH: 1.56, deltaErrorNm: -3.0, rpm: 780 },
    { deltaQKgH: 1.04, deltaErrorNm: -2.0, rpm: 780 },
];
const learned = learnGain(truePairs, 0.40, gOpts);
check('two consistent pairs pull the gain toward 0.52', learned.learned && learned.gain > 0.45 && learned.gain <= 0.53, learned.gain);
const inverted = learnGain([{ deltaQKgH: 1.5, deltaErrorNm: +3.0, rpm: 780 }], 0.40, gOpts);
check('a sign-inverted pair is rejected, not averaged', !inverted.learned
    && inverted.rejected[0].why === 'sign-inverted', JSON.stringify(inverted.rejected));
const tiny = learnGain([{ deltaQKgH: 1.5, deltaErrorNm: -0.4, rpm: 780 }], 0.40, gOpts);
check('a pass that barely moved the error is delta-too-small', tiny.rejected[0].why === 'delta-too-small');
const nothingWritten = learnGain([{ deltaQKgH: 0.1, deltaErrorNm: -3.0, rpm: 780 }], 0.40, gOpts);
check('a pass that barely wrote anything is step-too-small', nothingWritten.rejected[0].why === 'step-too-small');
check('the default rescales with rpm', near(defaultGainKgHPerNm(390, IDLE_TUNE_DEFAULTS), 0.20, 1e-9),
    defaultGainKgHPerNm(390, IDLE_TUNE_DEFAULTS));

console.log('\n[the truth gate]');
const rails = tables.mdLlriRange;
check('agreement inside 2 Nm passes', idleTorqueAgrees(-6.0, -7.0, rails));
check('a 5 Nm disagreement fails', !idleTorqueAgrees(-2.0, -7.0, rails));
check('undefined on either side fails, never passes', !idleTorqueAgrees(undefined, -7.0, rails) && !idleTorqueAgrees(-7.0, undefined, rails));
check('a value outside the binary rails fails', !idleTorqueAgrees(-500, -500, rails));
check('the tolerance is absolute, so zero-crossing works', idleTorqueAgrees(0.5, -0.5, rails));
check('the gate takes 3 and needs 2', IDLE_TORQUE_TRUTH_GATE.pairsTaken === 3 && IDLE_TORQUE_TRUTH_GATE.pairsRequired === 2);

/** Whether a one-telegram read actually contains a signal. Same rule ramMap asserts at load. */
const covers = (read, sig) => sig.segment === read.segment
    && sig.address >= read.address
    && sig.address + sig.size <= read.address + read.count;

console.log('\n[the run profile]');
// 2.68 Hz: 4.13 when this run measured one thing, 3.00 once it carried the section 7.1
// preconditions, 2.87 with the torque reserve, 2.74 with the VANOS cams and the latch, 2.68 now
// that it also carries TAN and P_UMG. The trade is stated where the profile is: the measured
// quantity is the resting value of an integrator with a 5.12 s time constant, so rate buys outlier
// rejection rather than bandwidth, while the extra channels buy the answer to whether the estimate
// means anything at all.
//
// TAN and P_UMG were the cheapest of those and the only one that made a PREDICTION checkable. Two
// real runs put logged `rf` at 0.876 and 0.739 of what the binary's own chain says it should be —
// a gap that cannot be told apart from a wrong scaling while RF_PT_KORR is unmeasured, because
// `rf_soll_calc` multiplies by exactly that term and the log did not record it. 2.2 % of the rate
// is what it costs to stop guessing.
//
// 2.63 came from LLS_ST joining the survey lane — one byte that settles which table
// `ti_load_factor` reads (bit 7 is the idle-valve diagnosis latch, and the idle curve
// KL_TI_N_ZWD_LL runs only while it is set).
//
// Back to 2.63: the TI_OFFSET_ADAPT read is gone. Session #923 proved the master's 0xFFD922 is
// the rev limiter's memory (a bit-constant -30720), the slave word is unreachable on this image,
// and the additive store's state is settled by the coupled init instead — see ramMap. A read that
// costs 1.6 % of the rate to record a rev-limiter word is worse than no read.
check('IDLE is 2.63 Hz', near(expectedHz(LOG_PROFILES.IDLE.exchanges), 2.63, 0.02), expectedHz(LOG_PROFILES.IDLE.exchanges));
check('the fallback is 3.00 Hz', near(expectedHz(LOG_PROFILES.IDLE.fallback), 3.00, 0.02), expectedHz(LOG_PROFILES.IDLE.fallback));
check('IDLE needs no patch armed', LOG_PROFILES.IDLE.requires.length === 0);

// The density channels, asserted by ADDRESS rather than by name. `rf_soll_calc` ends with
// `rf_soll = (rf_soll_filtered * RF_PT_KORR) >> 12`, so a log without TAN and P_UMG records a
// number the DME scaled by a term nobody wrote down — and the two measured runs that motivated
// this could not distinguish that term from a decoding error anywhere else in the chain.
{
    const amb = LOG_PROFILES.IDLE.exchanges.find(
        x => x.kind === 'ram' && x.address === AMBIENT_CHARGE_RAM_READ.address);
    check('the idle run records the air it was breathing', !!amb,
        'without TAN and P_UMG the logged rf cannot be checked against the binary at all');
    check('...on the survey lane, because weather is not a per-sample fact',
        amb?.every === IDLE_SURVEY_LANE_EVERY, amb?.every);
    check('...and it covers both indices into RF_PT_KORR',
        covers(AMBIENT_CHARGE_RAM_READ, Mss54HpRamSignals.TAN_FILTER)
        && covers(AMBIENT_CHARGE_RAM_READ, Mss54HpRamSignals.P_UMG_FILTER));
}

// The coupling that made this worth a constant. `minDwellSamples` guards against a window the link
// only half filled; it is NOT a place to encode a rate. A flat 60 was 73 % of a 20 s dwell at
// 4.13 Hz and would be 104 % of one at 2.87 — silently turning `dwellSec` into 21 seconds and
// blaming the DME for it via `thin-count`. Pin the relationship rather than the number.
{
    const hz = expectedHz(LOG_PROFILES.IDLE.exchanges);
    const d = IDLE_TUNE_DEFAULTS;
    check('a full-length dwell clears minDwellSamples at the profile\'s own rate',
        d.dwellSec * hz > d.minDwellSamples, `${(d.dwellSec * hz).toFixed(1)} > ${d.minDwellSamples}`);
    check('...with real margin, so a few refused reads do not cost the dwell',
        d.minDwellSamples <= d.dwellSec * hz * 0.8, `${d.minDwellSamples} <= ${(d.dwellSec * hz * 0.8).toFixed(1)}`);
    check('...and it still bites when the link answers half the window',
        d.dwellSec * hz * 0.5 < d.minDwellSamples, `${(d.dwellSec * hz * 0.5).toFixed(1)} < ${d.minDwellSamples}`);
    check('minDwellSamples follows dwellSec rather than being fixed',
        minDwellSamplesFor(40) > minDwellSamplesFor(20), `${minDwellSamplesFor(40)} > ${minDwellSamplesFor(20)}`);
}

// The read exists because these signals are contiguous, so the assertion is coverage rather than a
// byte count: every signal whose comparison is only meaningful within ONE moment has to be inside
// ONE read. md_llri + md_llra is a sum taken while the adaptation moves value between them;
// ml_soll vs ml_soll_max_lls is the air split, which is a comparison and not a pair of readings.
{
    const inTorqueRead = (sig) =>
        sig.segment === IDLE_TORQUE_RAM_READ.segment
        && sig.address >= IDLE_TORQUE_RAM_READ.address
        && sig.address + sig.size <= IDLE_TORQUE_RAM_READ.address + IDLE_TORQUE_RAM_READ.count;
    const R = Mss54HpRamSignals;
    check('the torque cluster and the air split share one telegram',
        [R.MD_LLRI, R.MD_LLRA, R.MD_LLRA_KO, R.ML_SOLL, R.ML_SOLL_LLS, R.ML_SOLL_MAX_LLS].every(inTorqueRead),
        IDLE_TORQUE_RAM_READ.count);
    check('...and it is still the three torque words that start it',
        IDLE_TORQUE_RAM_READ.address === R.MD_LLRI.address
        && R.MD_LLRA.address === R.MD_LLRI.address + 2
        && R.MD_LLRA_KO.address === R.MD_LLRI.address + 4);
    check('...and ml_soll_max_lls is the last of them',
        R.ML_SOLL_MAX_LLS.address + R.ML_SOLL_MAX_LLS.size
        === IDLE_TORQUE_RAM_READ.address + IDLE_TORQUE_RAM_READ.count);
    check('md_llri is signed', R.MD_LLRI.signed === true);
    // The preconditions are the reason the rate dropped, so their absence is worth failing over.
    const named = LOG_PROFILES.IDLE.exchanges.filter(x => x.kind === 'ram').map(x => x.name).join(' ');
    for (const sym of ['LFR_ZUSTAND', 'WDK_SOLL', 'WDK_WORD']) {
        check(`the profile actually fetches ${sym}`, named.includes(sym), named);
    }
}

console.log('\n[the section 7.1 thresholds come from the binary, not from the document]');
{
    // The document quotes 1.0 % and 3.0 %. Quoting a threshold from a reference image is the same
    // class of mistake as quoting a value from one, so the tables read them from the loaded binary
    // and the panel decides with those.
    check('K_LFR_EGAS_ABW is read, and it is the tighter of the two',
        tables.egasAbwPct > 0 && tables.egasAbwPct < tables.frEdkDiffPct,
        `${tables.egasAbwPct} / ${tables.frEdkDiffPct}`);
    check('both are plausible throttle angles', tables.egasAbwPct <= 10 && tables.frEdkDiffPct <= 10);
}

console.log('\n[the preflight verdict fires when it should, and blocks when it must]');
{
    // A verdict that lives inside a component cannot be tested against anything, which is why this
    // one is a library. Driven here from literal samples rather than the bench: the bench is
    // deliberately healthy at idle, so it can only ever demonstrate the PASS path, and the path
    // worth pinning is the other one.
    const base = {
        time: 0, rpm: 870, coolantTemp: 85, wdk1: 0.4, rf: null, nSoll: 870, ub: 14.1,
        mdLlri: -7, mdLlra: 0, mdLlraKo: 0, llsTv: 21, llrQvs: 14, llrQsoll: 14,
        engineState: 4, kkosSt: 0,
        mdRfSoll: 560, mdRfKorr: 560, mlSoll: 14, mlSollLls: 14, mlSollMaxLls: 34,
        wdkWord: 0.4, wdkSoll: 0.0, egasSoll: 0.0, egasMaxWdk: 100,
        lfrZustand: 2, lfrMdi: -7, lfrIAfr: 0, frRegler: 1.0, fraMlAdaption: 0,
        laFRegler1: 1, laFRegler2: 1, laaF1: 1, laaF2: 1, laaRegler1: 1, laaRegler2: 1,
        // Straight ahead, both reserves down. mdResLrwSt is 0x01 and not 0x00 deliberately: bit0
        // only means "below K_MD_RES_LRW_V", so it is up on every stationary car, and a test that
        // read the byte as a boolean would pass against 0x00 and never be caught.
        lwsLrw: 0, mdResKath: 0, mdResLrwRoh: 0, mdResLrwSt: 0x01, mdResLrw: 0,
        // A healthy VANOS. evan1St is 0x88 rather than 0x08 deliberately: the slave sets bit7 too
        // (0x024376), so a test that compares the byte for equality passes against 0x08 and is
        // caught here. Only a bit3 mask is right.
        evan1Ist: 60.0, avan1Ist: 2.0, evan1St: 0x88, avan1St: 0x88,
        vanEdSt: 0x00, vanAdapSt: 0x00, evan1IstFilt: 60.0, evan1Soll: 60.0,
    };
    const run = (over) => evaluateIdlePreflight(Array.from({ length: 8 }, () => ({ ...base, ...over })), tables);
    const statusOf = (v, id) => v.tests.find(x => x.id.startsWith(id))?.status;

    check('a healthy warm idle passes every test',
        run({}).tests.every(x => x.status === 'ok'),
        run({}).tests.filter(x => x.status !== 'ok').map(x => `${x.id}:${x.status}`).join(' '));
    check('nothing is reported before there are samples', evaluateIdlePreflight([], tables) === null);

    // The one that matters. Outside state 2 the governor does not integrate and the adaptation does
    // not adapt, so a dwell taken there is not a measurement — and the verdict has to SAY so rather
    // than shading the run's quality score.
    const revving = run({ lfrZustand: 4 });
    check('outside LFR_ZUSTAND 2 the verdict BLOCKS', revving.blocked === true);
    check('...and it is the fatal test that did it', statusOf(revving, 'LFR_ZUSTAND') === 'fail');

    // Both throttle tests read the same difference at two thresholds, so a gap between them has to
    // trip the tight one and not the wide one. Getting that backwards would report "FR is frozen"
    // for a car whose FR is fine.
    const drifted = run({ wdkWord: 2.0 });
    check('a 2.0 % throttle gap trips K_LFR_EGAS_ABW',
        statusOf(drifted, 'WDK_WORD') === 'fail');
    check('...but not K_FR_EDK_DIFF, which is the wider one',
        statusOf(drifted, 'WDK gap vs FR') === 'ok');
    check('...and it is not fatal — the reading still means something, differently',
        drifted.blocked === false && drifted.anyFail === true);
    check('a 4.0 % gap trips both', ['WDK_WORD', 'WDK gap vs FR']
        .every(id => statusOf(run({ wdkWord: 4.0 }), id) === 'fail'));

    // The split. If the demand ever exceeds the ceiling the throttle is taking a share, and the
    // document's whole authority ranking moves — so this is a finding, not a warning.
    check('demand above the ceiling fails the split test',
        statusOf(run({ mlSoll: 40 }), 'ML_SOLL < ML_SOLL_MAX_LLS') === 'fail');
    check('demand below the authority floor fails its own test',
        statusOf(run({ mlSoll: 5 }), 'ML_SOLL vs authority floor') === 'fail');
    check('a duty above the inferred ceiling fails, and is flagged as an inference',
        statusOf(run({ llsTv: 40 }), 'LLS_TV') === 'fail'
        && run({}).tests.find(x => x.id === 'LLS_TV')?.thresholdIsInference === true);

    // The torque reserve. The document's central structural claim — that at warm idle the governor
    // drives ONE 74.9 ms air actuator and has no fast path — is exactly `lfr_calc` 0x026A4C finding
    // bit1 of MD_RES_LRW_ST down and falling through to `clr.w MD_LLR_TZ`. So the reserve is the
    // claim, and a dwell taken with it up is a dwell taken under a different control structure.
    check('bit0 alone does NOT trip the reserve test — it is up on every stationary car',
        statusOf(run({ mdResLrwSt: 0x01 }), 'MD_RES') === 'ok');
    check('...but bit1 does, even with both reserves reading zero',
        statusOf(run({ mdResLrwSt: 0x03 }), 'MD_RES') === 'fail');
    check('a steering reserve of 10 Nm fails',
        statusOf(run({ mdResLrw: 10, mdResLrwSt: 0x03 }), 'MD_RES') === 'fail');
    check('...and so does a catalyst-heating reserve, which arrives on the other operand',
        statusOf(run({ mdResKath: 8, mdResLrwSt: 0x01 }), 'MD_RES') === 'fail');
    check('...and it is not fatal: the governor has MORE authority, not none',
        run({ mdResKath: 8 }).blocked === false);

    // The steering angle, which is what makes the row above interpretable rather than just true.
    // The breakpoint is KL_MD_RES_LRW's own x[0], read from the binary as raw 11886 * 0.04375.
    check('the reserve breakpoint is KL_MD_RES_LRW x[0], not a number someone chose',
        Math.abs(LWS_RESERVE_BREAKPOINT_DEG - 520.0125) < 1e-9, LWS_RESERVE_BREAKPOINT_DEG);
    check('straight ahead passes', statusOf(run({ lwsLrw: 0 }), 'LWS_LRW') === 'ok');
    check('...and so does a hand resting a few degrees off centre',
        statusOf(run({ lwsLrw: -30 }), 'LWS_LRW') === 'ok');
    check('past the breakpoint fails, in both directions — the curve is indexed on |angle|',
        statusOf(run({ lwsLrw: 540 }), 'LWS_LRW') === 'fail'
        && statusOf(run({ lwsLrw: -540 }), 'LWS_LRW') === 'fail');

    // The VANOS latch. This is the check the whole DS2-selection-0x23 investigation was for: the
    // failure it catches sets NO fault code, so an empty fault memory proves nothing and this is
    // the only place a driver can be told.
    check('the latch thresholds are derived from the binary, not written down',
        Math.abs(tables.evanSollMaxDegKw - 60.0) < 1e-9
        && Math.abs(tables.evanDruckDegKw - 52.5) < 1e-9
        && Math.abs(tables.evanLatchThresholdDegKw - 55.0) < 1e-9,
        `${tables.evanSollMaxDegKw} / ${tables.evanDruckDegKw} / ${tables.evanLatchThresholdDegKw}`);
    check('...and the threshold sits between the two commanded angles, which is the mechanism',
        tables.evanDruckDegKw < tables.evanLatchThresholdDegKw
        && tables.evanLatchThresholdDegKw < tables.evanSollMaxDegKw);
    check('bit3 set passes even with other bits up — the byte is not a boolean',
        statusOf(run({ evan1St: 0x88 }), 'EVAN1_ST bit3') === 'ok'
        && statusOf(run({ evan1St: 0x08 }), 'EVAN1_ST bit3') === 'ok');
    check('...and a byte with everything BUT bit3 fails',
        statusOf(run({ evan1St: 0xF7 }), 'EVAN1_ST bit3') === 'fail');
    check('a cam parked at K_EVAN1_DRUCK fails the position test',
        statusOf(run({ evan1Ist: tables.evanDruckDegKw }), 'EVAN1_IST') === 'fail');
    check('...and one at the stop passes, with the control deviation a stop really shows',
        statusOf(run({ evan1Ist: tables.evanSollMaxDegKw - 1.0 }), 'EVAN1_IST') === 'ok');
    check('...and the failure is not fatal — it changes what the run means, it is not a bad read',
        run({ evan1Ist: tables.evanDruckDegKw, evan1St: 0x80 }).blocked === false);
    // The reason EVAN1_SOLL rides in the same verdict: it is what separates a pinned target from a
    // sticky cam, and the panel shows it beside the position for exactly that.
    check('the target is reported beside the position',
        run({ evan1Soll: 52.5 }).tests.find(x => x.id === 'EVAN1_IST')?.against === 52.5);

    // An absent channel is not a pass. On the fallback profile none of these arrive at all, and a
    // verdict that read silence as agreement would be the exact failure this whole feature exists
    // to stop making.
    // The fallback profile asks for no RAM at all, so this is what it looks like: every channel the
    // preflight reads is absent, not just some of them. DERIVED from `base` rather than listed,
    // because a hand-written list of nulls goes stale the moment a channel is added — which it just
    // did, and this assertion is what caught it. Only the block-3 fields survive, since those are
    // the ones the fallback still fetches.
    const fromBlock3 = new Set(['time', 'rpm', 'coolantTemp', 'wdk1', 'rf', 'nSoll', 'ub', 'mdLlriSource']);
    const blind = run(Object.fromEntries(
        Object.keys(base).filter(k => !fromBlock3.has(k)).map(k => [k, null])));
    check('a missing channel reads as unknown, never as ok',
        blind.tests.filter(x => x.status === 'ok').length === 0, blind.tests.map(x => x.status).join(' '));
    check('...and unknown does not block either — it is a gap, not a failure',
        blind.anyUnknown === true && blind.blocked === false && blind.anyFail === false);
}

console.log('\n[LLS_ST bit 7 — which table TI_F_STAT comes from]');
{
    // `ti_load_factor` (slave 0x01C6CA) reads the idle curve KL_TI_N_ZWD_LL only when ZUSTAND_MOTOR's
    // LL bit is set AND bit 7 of LLS_ST is set; otherwise it reads KF_TI_N_RF. Bit 7 is set by the
    // idle-valve DIAGNOSIS — lls_diag at master 0x026142 reads the byte, masks to bits 0-1, ORs in
    // 0x80 and stores it, and clears it again at 0x026196 — so at a healthy idle it is low and
    // KF_TI_N_RF is the branch that runs.
    //
    // That is the entire content of `requireTiBranchProven`, which today refuses every idle cell of
    // the LOW LOAD corrector. The disassembly says which branch runs; this channel is how the CAR
    // says it, and the default does not come off until the car has.
    const sig = Mss54HpRamSignals.LLS_ST;
    check('LLS_ST is mapped, one byte at 0xFF823B',
        !!sig && sig.address === 0x00FF823B && sig.size === 1,
        sig && '0x' + sig.address.toString(16) + ' x' + sig.size);
    check('...in the same window as the other 0xFF8xxx channels',
        sig.segment === Mss54HpRamSignals.KKOS_ST.segment, sig.segment);
    check('...and unscaled, because it is a bitfield and not a quantity',
        sig.scale === 1 && sig.signed === false);

    const ex = LOG_PROFILES.IDLE.exchanges.filter(e => e.name === 'LLS_ST');
    check('the IDLE profile reads it exactly once', ex.length === 1, ex.length);
    // The survey lane, not the slow one: a latched diagnosis bit does not move on a dwell's scale.
    check('...on the slowest lane', ex[0]?.every === IDLE_SURVEY_LANE_EVERY, ex[0]?.every);

    // And the ORDINARY log carries it too, because idle is not a separate process. A VE drive
    // contains the idle it started and ended with, and the branch question is about those samples.
    const ve = LOG_PROFILES.VE.exchanges.filter(e => e.name === 'LLS_ST');
    check('the VE profile reads it as well', ve.length === 1, ve.length);
    check('...on the latched-bit lane', ve[0]?.every === LATCHED_BIT_LANE_EVERY, ve[0]?.every);
    // The cost is the whole argument for that lane. 0.35 % is what one byte every 14 s is worth.
    const withOut = expectedHz(LOG_PROFILES.VE.exchanges.filter(e => e.name !== 'LLS_ST'));
    const withIt = expectedHz(LOG_PROFILES.VE.exchanges);
    check('...and costs under half a percent of the VE rate',
        (1 - withIt / withOut) < 0.005, ((1 - withIt / withOut) * 100).toFixed(2) + ' %');
}

console.log(fails === 0 ? '\nALL PASS' : '\n' + fails + ' FAILURE(S)');
process.exit(fails ? 1 : 0);
