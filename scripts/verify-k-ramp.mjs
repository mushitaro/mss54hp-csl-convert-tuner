/**
 * The k-ramp rule: a gate-open sample is VE evidence only once the lambda loop has taken back the
 * last rf_korr step.
 *
 *     after a K step the trim ramps at KF_LA_KI_NEG (0.0406/s in the band) until the lean switch,
 *     so in that window  trim x K = K (1 - 0.0406 t)  — the time since the step, not the VE error
 *
 *     EVENT    gate in/out, or |K - K_at_last_event| >= 0.02 while open
 *     RESTART  every bank exactly 1.000, both banks bit-identical, or a one-sample move > 0.10
 *     SETTLED  the bank's trim rose >= 0.8 x P+ above its running minimum since the event;
 *              P+ = KF_LA_KP_POS(N, RF) of the as-run binary, 0.020 without one — or, when the
 *              event LOWERED K by >= 0.04 (the gate shutting included), fell >= 0.8 x P- below its
 *              running maximum: the rich switch that ends the climb back;
 *              never while the trim sits on its clamp
 *     kRamp    any bank still pending or pinned
 *
 * and what the VE write and the census do with it, the K HOLD check that catches a hold that did
 * not take, and the latch's load fix. All synthetic: a flat Alpha-N table so rf_soll is one number,
 * flat air curves so RF_PT_KORR is 1, and the one binary the repo ships (public/mock) for the
 * P-jump tables. Nothing here reads archive/.
 *
 * The rule's thresholds were checked against the DME's own P-jump counters on archive sessions
 * #967/#968/#970 by a scratch replay (not shipped): settled precision 0.92, recall 0.61 over every
 * gate-open sample. See rampState.ts for the numbers and what each refinement bought.
 */
import fs from 'node:fs';
import {
    VECalculator, RF_TRUNCATION_MEAN_PERCENT, K_HOLD_IN_EFFECT_MAX_RATIO, K_HOLD_CHECK_MIN_SAMPLES,
} from '../src/lib/ve-calculator/calculator.ts';
import {
    KRampTracker, isKRampExcluded, readLambdaRampParams, lambdaPJumpAt,
    K_STEP_MIN, K_DROP_MIN, REVERSAL_FRACTION, TRIM_RESET_JUMP, LAMBDA_P_JUMP_FALLBACK,
} from '../src/lib/ve-calculator/rampState.ts';
import { isRfKorrFloorHeld, withStockRfKorrFloor, readEgtTables } from '../src/lib/ve-calculator/egtTables.ts';
import { EMPTY_CENSUS, withRfKorrRamp } from '../src/lib/log-engine/lambdaGates.ts';
import { buildCoverage, coverageRemedy } from '../src/lib/ve-calculator/cellCoverage.ts';
import { APP_CONFIG, RF_KORR_GATE_FLOOR } from '../src/config/constants.ts';

let fails = 0;
const check = (n, c, d) => { console.log('  ' + (c ? 'PASS' : 'FAIL') + '  ' + n + (c ? '' : ' — ' + d)); if (!c) fails++; };
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

const RPM = APP_CONFIG.MSS54HP.AXIS_RPM;
const LOAD = APP_CONFIG.MSS54HP.AXIS_LOAD;

// --- the lambda loop, as a sampled synthetic -----------------------------------------------------

const DT = 0.3;           // s per sample — the VE profile's ~3 Hz
const KI_NEG = 0.0406;    // /s, the rich-side ramp in the band
const KI_POS = 0.050;     // /s, the lean-side ramp
const P_POS = LAMBDA_P_JUMP_FALLBACK.pos;   // 0.020
const P_NEG = LAMBDA_P_JUMP_FALLBACK.neg;   // 0.0098

/**
 * The plan's synthetic, sample by sample: the trim flat before the K step; after it, ramping down
 * at KI_NEG until it has cancelled K, then the lean-switch jump — a sample that reads P+ = 0.020
 * above the one before — and from there the two-point limit cycle around the trim that cancels K.
 * `m` is the mixture error the VE map leaves (1.05 = 5 % rich), so the cycle centres on
 * `trim x K = 1 / m`. Bank 2 rides 0.004 below bank 1: two real banks never read the same code,
 * and two that do are a restart (see below).
 */
function stepRamp({ k = 1.16, m = 1.0, before = 4, after = 12, start = 1.0 } = {}) {
    const rows = [];
    let v = start, t = 0, phase = 'ramp';
    for (let i = 0; i < before; i++, t += DT) rows.push({ t, open: false, k: 1, v, switched: false });
    let since = 0;
    for (let i = 0; i < 400; i++, t += DT) {
        if (phase === 'ramp') {
            const next = v - KI_NEG * DT;
            if (next * k * m <= 1) { v += P_POS; phase = 'lean'; } else v = next;
        } else if (phase === 'lean') {
            v += KI_POS * DT;
            if (v * k * m >= 1) { v -= P_NEG; phase = 'rich'; }
        } else {
            v -= KI_NEG * DT;
            if (v * k * m <= 1) { v += P_POS; phase = 'lean'; }
        }
        const switched = phase !== 'ramp';
        rows.push({ t, open: true, k, v, switched });
        if (switched && ++since >= after) break;
    }
    return rows.map(r => ({ ...r, v1: r.v, v2: r.v - 0.004 }));
}

/**
 * The same controller in continuous time — 5 ms steps, the sensor seeing the mixture `delay` late,
 * the trim read every DT — so the lean switch can fall anywhere inside a sample interval and the
 * ramp before it partly cancels the jump. This is the case `REVERSAL_FRACTION < 1` exists for.
 */
function simulate({ kOf, openOf, m = 1.0, T = 14, delay = 0.12, trim0 = 1.0 }) {
    const dt = 0.005, lag = Math.round(delay / dt), every = Math.round(DT / dt);
    let trim = trim0, wasRich = null;
    const mix = [], out = [], leanSwitches = [], richSwitches = [];
    for (let i = 0; i * dt <= T; i++) {
        const t = i * dt;
        mix.push(trim * kOf(t) * m);
        const rich = mix[Math.max(0, i - lag)] > 1;
        if (wasRich !== null && rich !== wasRich) {
            trim += rich ? -P_NEG : P_POS;
            (rich ? richSwitches : leanSwitches).push(t);
        } else trim += (rich ? -KI_NEG : KI_POS) * dt;
        trim = Math.min(1.3, Math.max(0.7, trim));
        wasRich = rich;
        if (i % every === 0) {
            const q = Math.round(trim * 32768) / 32768;   // the channel's own LSB
            out.push({ t, open: openOf(t), k: kOf(t), v1: q, v2: Math.round((trim - 0.004) * 32768) / 32768 });
        }
    }
    return { rows: out, leanSwitches, richSwitches };
}

const track = (rows, params = null, rpm = 2500, rf = 60) => {
    const tr = new KRampTracker(params);
    return rows.map(r => tr.step({
        time: r.t, rpm: r.rpm ?? rpm, rf: r.rf ?? rf, stft1: r.v1, stft2: r.v2, gateOpen: r.open, k: r.k,
    }));
};

console.log('\n[a K step: kRamp until the trim rebounds, post-ramp after]');
{
    // The plan's case: K 1.00 -> 1.16, the trim down at 0.0406/s, a 0.020 rebound.
    const rows = stepRamp();
    const ramp = track(rows);
    const stepAt = rows.findIndex(r => r.open);
    const switchAt = rows.findIndex(r => r.switched);
    check('the synthetic does step K and does switch', stepAt > 0 && switchAt > stepAt, `${stepAt} ${switchAt}`);
    check('settled before the step (gate shut, trim steady)', ramp.slice(0, stepAt).every(x => x === false),
        ramp.slice(0, stepAt).join(','));
    check('kRamp from the step sample to the sample before the rebound',
        ramp.slice(stepAt, switchAt).every(x => x === true), ramp.slice(stepAt, switchAt).join(','));
    check('post-ramp from the rebound sample on, through the limit cycle after it',
        ramp.slice(switchAt).every(x => x === false), ramp.slice(switchAt).join(','));
    // The time it took is the ramp's, which is what makes the written trim mean something.
    const seconds = rows[switchAt].t - rows[stepAt].t;
    check('...after ~ (1 - 1/1.16) / 0.0406 = 3.4 s of ramp', seconds > 3.0 && seconds < 3.8, seconds.toFixed(2));

    // Continuous time, a 0.12 s sensor delay, the switch landing anywhere in an interval. The step is
    // placed just after a lean switch of the pre-step cycle, so the first switch the rule can see is
    // the one the K step forces.
    const pre = simulate({ kOf: () => 1, openOf: () => false, T: 4 });
    const tStep = pre.leanSwitches.find(t => t > 2) + 0.05;
    const sim = simulate({ kOf: t => (t < tStep ? 1 : 1.16), openOf: t => t >= tStep, T: 14 });
    const firstLean = sim.leanSwitches.find(t => t > tStep + 0.12);
    const r = track(sim.rows);
    const before = sim.rows.map((x, i) => [x, r[i]]).filter(([x]) => x.t >= tStep && x.t < firstLean);
    const after = sim.rows.map((x, i) => [x, r[i]]).filter(([x]) => x.t >= firstLean + DT);
    check('continuous-time loop: the step forces a long ramp', firstLean - tStep > 2.5, (firstLean - tStep).toFixed(2));
    check('...every sample between the step and that lean switch is kRamp', before.every(([, k]) => k),
        before.map(([, k]) => +k).join(''));
    check('...and the rule has seen the switch within one sample of it', after.every(([, k]) => !k),
        after.map(([, k]) => +k).join(''));
}

console.log('\n[the event threshold — a K wobble the loop absorbs is not a step]');
{
    const base = stepRamp({ after: 10 });
    const switchAt = base.findIndex(r => r.switched);
    // After the settle, K moves by just under the threshold, then by just over it.
    const wobble = base.map((r, i) => (i > switchAt + 2 ? { ...r, k: r.k + K_STEP_MIN * 0.9 } : r));
    const step = base.map((r, i) => (i > switchAt + 2 ? { ...r, k: r.k + K_STEP_MIN * 1.1 } : r));
    check('K_STEP_MIN is the plan\'s 0.02', K_STEP_MIN === 0.02);
    check('|dK| < 0.02 while open: still post-ramp', track(wobble).slice(switchAt).every(x => !x),
        track(wobble).slice(switchAt).join(','));
    check('|dK| >= 0.02 while open: a new ramp', track(step)[switchAt + 3] === true);
    // The gate shutting is a step whatever K reads.
    const exit = base.map((r, i) => (i > switchAt + 2 ? { ...r, open: false, k: 1 } : r));
    check('the gate shutting is an event', track(exit)[switchAt + 3] === true);
}

console.log('\n[a fall in K waits for the rich switch that ends the climb back]');
{
    // K 1.25 -> 1.08 with the gate open: the re-entry from the hold band, where DRREL is re-read at
    // a TABG that climbed while K was frozen. VE correct (m = 1), so every honest write is ~1.000.
    // The drop leans the mixture, the loop jumps P+ at once and climbs at KI_POS until it crosses
    // rich; until then trim x K is below 1 by the part of the drop not yet climbed back. Swept over
    // where the drop lands in the limit cycle.
    check('K_DROP_MIN is twice the event step', K_DROP_MIN === 2 * K_STEP_MIN);
    let climbs = 0, phases = 0;
    const leaked = [], lateSettle = [];
    for (let ph = 0; ph < 1.0; ph += 0.05) {
        const tDrop = 10 + ph;
        const sim = simulate({ kOf: t => (t < 2 ? 1 : t < tDrop ? 1.25 : 1.08), openOf: t => t >= 2, T: 18 });
        const firstRich = sim.richSwitches.find(t => t > tDrop + 0.12);
        const r = track(sim.rows);
        const pts = sim.rows.map((x, i) => ({ ...x, kRamp: r[i], rfKorrGateOpen: x.open, c: ((x.v1 + x.v2) / 2) * x.k }));
        const climb = pts.filter(p => p.t >= tDrop && p.t < firstRich);
        if (climb.some(p => p.c < 0.99)) climbs++;
        leaked.push(...climb.filter(p => !isKRampExcluded(p) && p.c < 0.99).map(p => p.c.toFixed(3)));
        if (pts.some(p => p.t >= firstRich + 4 * DT && p.kRamp)) lateSettle.push(ph.toFixed(2));
        phases++;
    }
    check('the synthetic does climb back lean after the drop (else this tests nothing)', climbs === phases, `${climbs}/${phases}`);
    check('no gate-open sample with trim x K < 0.99 is written before the first rich switch',
        leaked.length === 0, leaked.join(','));
    // Not always AT that switch: its rich half-cycle can be shorter than a sample (P- 0.0098 against
    // a P+ of 0.020), and then the fall is first seen on the next one. One limit-cycle period late.
    check('...and the bank settles within a limit-cycle period of it, so the climb is all it costs',
        lateSettle.length === 0, lateSettle.join(','));

    // The gate shutting on a stepped K is the same drop, K -> 1.000. Without a fuel cut the trim is
    // left at its K-cancelling level and climbs back over ~2.5 s. Those samples stay ramp until the
    // rich switch — the RF KORR anchor check reads gate-shut samples only when `kRamp === false` —
    // and the VE write still takes them: its exclusion is gate-open only (isKRampExcluded).
    const tExit = 10;
    const ex = simulate({ kOf: t => (t < 2 || t >= tExit ? 1 : 1.16), openOf: t => t >= 2 && t < tExit, T: 16 });
    const exitRich = ex.richSwitches.find(t => t > tExit + 0.12);
    const re = track(ex.rows);
    const shutClimb = ex.rows.map((x, i) => [x, re[i]]).filter(([x]) => x.t >= tExit && x.t < exitRich);
    check('a gate exit from K 1.16 without a fuel cut: kRamp until the rich switch',
        shutClimb.length > 3 && shutClimb.every(([, k]) => k), shutClimb.map(([, k]) => +k).join(''));
    check('...those gate-shut samples are still not excluded from the VE write',
        shutClimb.every(([x, k]) => !isKRampExcluded({ rfKorrGateOpen: x.open, kRamp: k })));
    // A small fall keeps the rise test: K 1.16 -> 1.13 is taken back by the one P+ jump it causes.
    const small = simulate({ kOf: t => (t < 2 ? 1 : t < 10.2 ? 1.16 : 1.13), openOf: t => t >= 2, T: 16 });
    const rs = track(small.rows);
    const after = small.rows.map((x, i) => [x, rs[i]]).filter(([x]) => x.t >= 10.2 + 3 * DT);
    check('a fall under K_DROP_MIN settles on the rise test, without waiting a half-cycle',
        after.every(([, k]) => !k), after.map(([, k]) => +k).join(''));
}

console.log('\n[a loop restart starts the ramp again]');
{
    // K 1.30: the settled trim sits near 0.77, far from the 1.000 a restart puts it back to.
    const k = 1.3;
    const rows = stepRamp({ k, after: 8 });
    const switchAt = rows.findIndex(r => r.switched);
    const at = switchAt + 3;
    /** After `at`: `hold` samples at exactly 1.000 (loop off), then the integrator restarts from
     *  1.000 — rich, because K is still 1.30 — with both banks identical until the first switch
     *  (`identical`), or 0.003 apart (`!identical`). */
    const restart = ({ hold, identical }) => {
        const tail = [];
        let v = 1.0, t = rows[at].t, switched = false;
        for (let i = 0; i < hold; i++) tail.push({ t: (t += DT), open: true, k, v1: 1, v2: 1, switched: false });
        for (let i = 0; i < 40; i++) {
            t += DT;
            if (!switched) { const n = v - KI_NEG * DT; if (n * k <= 1) { v += P_POS; switched = true; } else v = n; }
            else v += (v * k < 1 ? KI_POS : -KI_NEG) * DT;
            tail.push({ t, open: true, k, v1: v, v2: identical && !switched ? v : v - 0.003, switched });
        }
        return [...rows.slice(0, at + 1), ...tail];
    };
    const all = restart({ hold: 2, identical: false });
    const r = track(all);
    const restartAt = at + 1, reswitch = all.findIndex((x, i) => i > restartAt && x.switched);
    check('post-ramp before the restart', r[at] === false);
    check('exactly 1.000 on every bank: kRamp', r[restartAt] === true && r[restartAt + 1] === true);
    check('...through the new ramp down from 1.000', r.slice(restartAt, reswitch).every(x => x));
    check('...until that ramp switches', r.slice(reswitch).every(x => !x), r.slice(reswitch).join(','));

    // Bit-identical banks are the same fact without the 1.000 samples: both integrators restarted
    // together and ramp at the same gains, and stay identical until one of them switches.
    const ident = restart({ hold: 0, identical: true });
    const ri = track(ident);
    const sw = ident.findIndex((x, i) => i > at && x.switched);
    check('the log caught no 1.000 sample here', ident.slice(at + 1).every(x => x.v1 !== 1));
    check('the leap back from ~0.8 to ~1.0 is larger than one controller move',
        Math.abs(ident[at + 1].v1 - ident[at].v1) > TRIM_RESET_JUMP, String(ident[at + 1].v1 - ident[at].v1));
    check('identical banks off 1.000: kRamp until the first switch', ri.slice(at + 1, sw).every(x => x),
        ri.slice(at + 1, sw).join(','));
    check('...and post-ramp from it', ri.slice(sw).every(x => !x), ri.slice(sw).join(','));
    // A reset whose 1.000 sample the log missed, banks NOT identical: the leap alone says it.
    const jumped = restart({ hold: 0, identical: false });
    const rj = track(jumped);
    check('a one-sample leap back toward 1.000 is a restart', rj[at + 1] === true);
    check('...and the leap is NOT read as a lean switch', rj.slice(at + 1, sw).every(x => x),
        rj.slice(at + 1, sw).join(','));
    // Without the reset rule the leap WOULD read as the rise of a lean switch — which is what the
    // rule is for: the restart ramp after it would then be written as `trim ~ 1 x K`.
    check('...a leap that is, numerically, far more than 0.8 x P+',
        jumped[at + 1].v1 - jumped[at].v1 > REVERSAL_FRACTION * P_POS);
}

console.log('\n[a trim on its clamp is never settled]');
{
    // K 1.60: the trim would need 0.625, the clamp stops it at 0.70, the mixture stays rich.
    const rows = [];
    let v = 1.0, t = 0;
    for (let i = 0; i < 3; i++, t += DT) rows.push({ t, open: false, k: 1, v1: v, v2: v - 0.004 });
    for (let i = 0; i < 40; i++, t += DT) {
        v = Math.max(0.70, v - KI_NEG * DT);
        rows.push({ t, open: true, k: 1.6, v1: v, v2: Math.max(0.70, v - 0.004) });
    }
    const r = track(rows);
    check('pinned at 0.70 for the rest of the log: kRamp throughout', r.slice(3).every(x => x));
    // A bank pinned at the clamp is ramp even after it once settled.
    const settled = stepRamp({ after: 6 });
    const pin = [...settled, { t: settled.at(-1).t + DT, open: true, k: 1.16, v1: 0.7, v2: 0.8 }];
    check('a settled bank landing on the clamp is ramp again at that sample', track(pin).at(-1) === true);
}

console.log('\n[one bank reversed is not enough]');
{
    const rows = stepRamp({ after: 8 });
    const switchAt = rows.findIndex(r => r.switched);
    // Bank 2 keeps ramping down instead of switching.
    let v2 = rows[switchAt - 1].v2;
    const oneBank = rows.map((r, i) => (i < switchAt ? r : { ...r, v2: (v2 -= KI_NEG * DT) }));
    const r = track(oneBank);
    check('bank 1 switched, bank 2 still ramping: kRamp', r.slice(switchAt).every(x => x));
    // A single-bank log needs only its one bank.
    const single = rows.map(r => ({ ...r, v2: undefined }));
    check('a single-bank log settles on its one bank', track(single).slice(switchAt).every(x => !x));
}

console.log('\n[P+ comes from the as-run binary, and the fallback is the band value]');
{
    const buf = fs.readFileSync(new URL('../public/mock/csl-0401-community-patch-v1.partial.bin', import.meta.url));
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const params = readLambdaRampParams(ab);
    check('KF_LA_KP_POS/NEG and K_LA_FMIN/FMAX decode from the 0401 image', params !== null);
    const band = lambdaPJumpAt(params.pJumps, 2500, 0.6);
    check('P+ at 2500 rpm / RF 0.6 is 41 raw = 0.0200', near(band.pos, 41 / 2048, 1e-12), String(band.pos * 2048));
    check('P- there is 20 raw = 0.0098', near(band.neg, 20 / 2048, 1e-12), String(band.neg * 2048));
    check('the idle cell reads the XDF\'s 0.021484', near(lambdaPJumpAt(params.pJumps, 800, 0.15).pos, 44 / 2048, 1e-12));
    check('the clamps are 0.70 / 1.30', near(params.fMin, 0.70, 1e-4) && near(params.fMax, 1.30, 1e-4),
        `${params.fMin} ${params.fMax}`);
    check('no tables: the band\'s 0.020 / 0.0098', LAMBDA_P_JUMP_FALLBACK.pos === 0.020 && LAMBDA_P_JUMP_FALLBACK.neg === 0.0098);
    // The jump size matters: at 3500 rpm the table's P+ is 31 raw, so a rise of 0.013 is a switch
    // there and is not one at 2500 (41 raw x 0.8 = 0.016).
    const rise = 0.013;
    const rows = [
        { t: 0, open: false, k: 1, v1: 1.0, v2: 0.996 },
        { t: 0.3, open: true, k: 1.16, v1: 0.99, v2: 0.986 },
        { t: 0.6, open: true, k: 1.16, v1: 0.98, v2: 0.976 },
        { t: 0.9, open: true, k: 1.16, v1: 0.98 + rise, v2: 0.976 + rise },
    ];
    check('REVERSAL_FRACTION is the plan\'s 0.8', REVERSAL_FRACTION === 0.8);
    check('a 0.013 rise at 2500 rpm: not a switch', track(rows, params, 2500).at(-1) === true);
    check('the same rise at 3500 rpm (P+ 31 raw): a switch', track(rows, params, 3500).at(-1) === false);
    check('the EGT tables carry the same parameters for the walk', JSON.stringify(readEgtTables(ab)?.lambda) === JSON.stringify(params));
}

// --- through the calculator ----------------------------------------------------------------------

const FLAT_AIR = {
    curves: {
        tan: { x: [-40, 0, 20, 60, 100], values: [1, 1, 1, 1, 1] },
        pUmg: { x: [600, 800, 960.5, 1050, 1100], values: [1, 1, 1, 1, 1] },
    },
    loadTable: null,   // the samples carry the opening the map is indexed on
};
const KORR_RPM = [1100, 1600, 2200, 3000, 4000, 5100];
const row = (v) => KORR_RPM.map(() => v);
const egtWith = (floor) => ({
    rfKorr: { rpm: KORR_RPM, delta: [30, 40, 100, 200, 300, 400], values: [row(1), row(1.02), row(1.12), row(1.25), row(1.32), row(1.37)] },
    tabgModel: { rpm: KORR_RPM, rf: [0, 0.2, 0.4, 0.6, 0.8, 1.0], values: Array.from({ length: 6 }, () => row(400)) },
    rfKorrMin: { rpm: KORR_RPM, values: row(floor) },
    hys: 0.1,
    vMin: 20,
});
const EGT = egtWith(0.55);
const RF_SOLL = 0.70;
const MAP = { xAxis: RPM, yAxis: LOAD, data: LOAD.map(() => RPM.map(() => RF_SOLL)) };
const calc = new VECalculator();

/** Rows -> raw LogDataPoints the DME would report: RF = rf_soll x K, less the truncated step. */
const toLog = (rows, { rpm = 2200, load = 7.5 } = {}) => rows.map(r => ({
    time: r.t, rpm: r.rpm ?? rpm, rawLoad: r.load ?? load, correctedLoad: r.load ?? load,
    stft1: r.v1, stft2: r.v2, rf: 100 * RF_SOLL * r.k - RF_TRUNCATION_MEAN_PERCENT,
    // A gate-shut row is below the floor: rf_soll 0.70 is above it, so shut rows ride under 20 km/h.
    vehicleSpeed: r.open ? 80 : 10, intakeTemp: 20, ambientPressure: 960.5, exhaustTemp: 300,
}));
const cellOf = (rpm, load) => [LOAD.indexOf(load), RPM.indexOf(rpm)];

console.log('\n[the VE write: mid-ramp samples are not written, post-ramp ones are trim x K]');
{
    // The ramp at 2200 rpm / RO 7.5; once the trim has switched the car moves to 3100 rpm / RO 15,
    // so the two halves land in separate cells and each cell's verdict is about one half. The map
    // is 5 % rich there (m = 1.05) — the band's own sign — so the answer to expect is -4.8 %.
    const M = 1.05;
    const rows = stepRamp({ m: M, after: 14 });
    const switchAt = rows.findIndex(r => r.switched);
    const log = toLog(rows.map((r, i) => (i >= switchAt ? { ...r, rpm: 3100, load: 15 } : r)));
    const ann = calc.annotateRfKorr(MAP, log, EGT, FLAT_AIR, log);
    check('the walk marks the ramp on the annotated samples',
        ann.slice(rows.findIndex(r => r.open), switchAt).every(p => p.rfKorrGateOpen && p.kRamp === true));
    check('...and post-ramp after the switch', ann.slice(switchAt).every(p => p.rfKorrGateOpen && p.kRamp === false));
    const res = calc.calculateNewVEMap(MAP, ann, { minCellSamples: 3, minCellWeight: 0 });
    const [rr, rc] = cellOf(2200, 7.5);
    const [pr, pc] = cellOf(3100, 15);
    // The ramp cell also holds the four gate-shut samples from before the step. Take them out to see
    // the verdict on the ramp alone.
    const rampOnly = calc.calculateNewVEMap(MAP, ann.filter(p => p.rfKorrGateOpen), { minCellSamples: 3, minCellWeight: 0 });
    check('a cell whose every sample was mid-ramp is refused as k-ramp', rampOnly.rejectMap[rr][rc] === 'k-ramp',
        String(rampOnly.rejectMap[rr][rc]));
    check('...and reports no written sample', rampOnly.hitMap[rr][rc] === 0);
    check('with the pre-step gate-shut samples in it, the cell is not k-ramp (it has evidence)',
        res.rejectMap[rr][rc] !== 'k-ramp' && res.hitMap[rr][rc] > 0);
    const post = ann.slice(switchAt);
    const expected = post.reduce((a, p) => a + ((p.stft1 + p.stft2) / 2) * p.rfKorr, 0) / post.length;
    check('the post-ramp cell is written with mean(trim x K)', near(res.demandMap[pr][pc], expected, 1e-9),
        `${res.demandMap[pr][pc]} vs ${expected}`);
    // Within 3 %, not exactly: the limit cycle is asymmetric (P+ 0.020 up, P- 0.0098 down), so the
    // trim's mean sits above the crossing — the bias BMW's POS/NEG split exists to put there, and
    // the same on a gate-shut sample, so it is not an rf_korr artefact.
    check('...which is the VE error the synthetic has: down, by about 1 / 1.05',
        res.demandMap[pr][pc] < 0.99 && Math.abs(res.demandMap[pr][pc] - 1 / M) < 0.03, String(res.demandMap[pr][pc]));
    // The ramp is what used to be written: K (1 - 0.0406 t) — the clock since the step, on the
    // wrong side of 1 for a map that is too rich.
    const ramp = ann.filter(p => p.kRamp && p.rfKorrGateOpen);
    const rampDemand = ramp.reduce((a, p) => a + ((p.stft1 + p.stft2) / 2) * p.rfKorr, 0) / ramp.length;
    check('...where the ramp samples would have written a RISE', rampDemand > 1.03, String(rampDemand));
    check('isKRampExcluded is exactly gate-open AND not post-ramp',
        isKRampExcluded({ rfKorrGateOpen: true, kRamp: true }) && isKRampExcluded({ rfKorrGateOpen: true })
        && !isKRampExcluded({ rfKorrGateOpen: true, kRamp: false })
        && !isKRampExcluded({ rfKorrGateOpen: false, kRamp: true }) && !isKRampExcluded({}));
}

console.log('\n[the census and the cell detail]');
{
    check('the census has an rfKorrRamp count, zero by default', EMPTY_CENSUS.rfKorrRamp === 0);
    const c = { ...EMPTY_CENSUS, fuelCut: 3 };
    const merged = withRfKorrRamp(c, 7);
    check('withRfKorrRamp puts the count in', merged.rfKorrRamp === 7 && merged.fuelCut === 3);
    check('...on a copy: the filter\'s resume census is untouched', c.rfKorrRamp === 0);
    const tsx = fs.readFileSync(new URL('../src/components/DropCensus.tsx', import.meta.url), 'utf8');
    check('DropCensus labels it "k ramp"', /rfKorrRamp:\s*'k ramp'/.test(tsx));
    // What happened, then what to do — the cell detail's remedy, so the sheet names a cure too.
    check('...with what happened and the cure, in each language',
        /rfKorrRamp:\s*'rf_korr had just stepped, and the lambda loop had not yet taken it back\. Hold the throttle still for longer once it stops, or run with K HOLD\.'/.test(tsx)
        && /rfKorrRamp:\s*'rf_korr が掛かった直後で、ラムダがまだ戻していない。スロットルを止めてから長めに保つか、K HOLD で走る。'/.test(tsx));
    const grid = buildCoverage({
        hitMap: [[0, 0]], weightMap: [[0, 0]], correctionMap: [[1, 1]],
        rejectMap: [['k-ramp', 'no-evidence']], rows: 1, cols: 2,
    });
    check('a k-ramp cell reads as driven-and-refused, not as never driven',
        grid[0][0].state === 'refused' && grid[0][1].state === 'unvisited');
    check('...and not as below the engine\'s reach', grid[0][0].belowReach === false);
    check('its remedy names what to do, in both languages',
        coverageRemedy('k-ramp', 'ja') === 'スロットルを止めてから長めに保つか、K HOLD で走る'
        && /K HOLD/.test(coverageRemedy('k-ramp', 'en') ?? ''));
}

console.log('\n[batch and live walk the same ramp]');
{
    // The live run holds one walk across flushes; `annotateRfKorr` walks once. Stepped in uneven
    // chunks, the walk must give the same verdict on every sample.
    const rows = stepRamp({ after: 12 });
    const log = toLog(rows);
    const batch = calc.annotateRfKorr(MAP, log, EGT, FLAT_AIR, log).map(p => p.kRamp);
    const walk = calc.rfKorrWalk(MAP, EGT, FLAT_AIR);
    const live = [];
    for (const [a, b] of [[0, 3], [3, 4], [4, 11], [11, log.length]]) {
        for (const p of log.slice(a, b)) live.push(walk.step(p));
    }
    check('chunked live steps == the batch annotation', live.every((s, i) => !s.open || s.kRamp === batch[i]),
        JSON.stringify(live.map(s => s.kRamp)) + ' vs ' + JSON.stringify(batch));
}

console.log('\n[K HOLD that did not take: read the drive with the stock floor, and say so]');
{
    const HELD = egtWith(2.0);
    check('the held floor is exactly HELD_RAW in all six', RF_KORR_GATE_FLOOR.HELD_RAW === 2000 && isRfKorrFloorHeld(HELD));
    check('one point at 1.999 is not held', !isRfKorrFloorHeld({ ...HELD, rfKorrMin: { rpm: KORR_RPM, values: [2, 2, 2, 2, 2, 1.999] } }));
    check('a high but different floor is not held', !isRfKorrFloorHeld(egtWith(1.9)));
    check('stock is not held', !isRfKorrFloorHeld(EGT));
    const stock = withStockRfKorrFloor(HELD);
    check('the stock floor goes back on the binary\'s own rpm axis',
        JSON.stringify(stock.rfKorrMin.values) === JSON.stringify(RF_KORR_GATE_FLOOR.STOCK_RAW.map(v => v / 1000))
        && stock.rfKorrMin.rpm.join() === KORR_RPM.join());

    // The car applied K = 1.16 while the binary says held: RF / rf_soll reads 1.16 above the stock
    // floor. rf_soll 0.70 sits above stock 0.65 at 2200 rpm, so every moving sample is stock-open.
    const enriched = toLog(stepRamp({ k: 1.16, after: 14 }));
    const res = calc.resolveKHold(MAP, HELD, FLAT_AIR, enriched);
    check('the check fires: median RF / rf_soll >= 1.05', res.kHoldNotInEffect !== null
        && res.kHoldNotInEffect.medianRatio >= K_HOLD_IN_EFFECT_MAX_RATIO, JSON.stringify(res.kHoldNotInEffect));
    check('...over the stock-open samples', res.kHoldNotInEffect?.n === enriched.filter(p => p.vehicleSpeed > 20).length,
        String(res.kHoldNotInEffect?.n));
    check('...and hands back the stock floor', !isRfKorrFloorHeld(res.egt));
    const ann = calc.annotateRfKorr(MAP, enriched, HELD, FLAT_AIR, enriched);
    check('annotateRfKorr re-walks the latch on it: the gate opens', ann.some(p => p.rfKorrGateOpen === true));
    check('...and the ramp is marked again', ann.some(p => p.kRamp === true) && ann.some(p => p.rfKorrGateOpen && p.kRamp === false));

    // The hold in force: RF reads rf_soll, the check passes, every sample is gate-shut and the VE
    // write is the trim alone.
    const heldLog = toLog(stepRamp({ k: 1.16, after: 14 }).map(r => ({ ...r, k: 1 })));
    const ok = calc.resolveKHold(MAP, HELD, FLAT_AIR, heldLog);
    check('hold in force: no verdict', ok.kHoldNotInEffect === null && isRfKorrFloorHeld(ok.egt));
    const annHeld = calc.annotateRfKorr(MAP, heldLog, HELD, FLAT_AIR, heldLog);
    check('...every sample gate-shut, K exactly 1', annHeld.every(p => p.rfKorrGateOpen === false && p.rfKorr === 1));
    const w = calc.calculateNewVEMap(MAP, annHeld, { minCellSamples: 1, minCellWeight: 0 });
    const [r, c] = cellOf(2200, 7.5);
    const trimMean = annHeld.reduce((a, p) => a + (p.stft1 + p.stft2) / 2, 0) / annHeld.length;
    check('...and the cell is written with the trim alone', near(w.demandMap[r][c], trimMean, 1e-9),
        `${w.demandMap[r][c]} vs ${trimMean}`);
    // Too few stock-open samples to say anything: no verdict, whatever they read.
    const few = enriched.filter(p => p.vehicleSpeed > 20).slice(0, K_HOLD_CHECK_MIN_SAMPLES - 1);
    check(`fewer than ${K_HOLD_CHECK_MIN_SAMPLES} stock-open samples: no verdict`,
        calc.resolveKHold(MAP, HELD, FLAT_AIR, few).kHoldNotInEffect === null);
    check('a stock binary is never checked', calc.resolveKHold(MAP, EGT, FLAT_AIR, enriched).kHoldNotInEffect === null);
}

console.log('\n[the latch reads raw samples at the corrected load]');
{
    // A map that rises with opening, so rf_soll depends on WHICH opening it is read at. At 2100 rpm
    // the stock table's factor is 0.95: raw opening 6.0 is aq_rel_rf 6.316.
    const map = { xAxis: RPM, yAxis: LOAD, data: LOAD.map(l => RPM.map(() => l / 10)) };
    const egt = { ...EGT, rfKorrMin: { rpm: KORR_RPM, values: row(0.62) } };
    const factor = APP_CONFIG.MSS54HP.INTERPOLATION_TABLE;
    const raw = [0, 0.3, 0.6].map(t => ({
        time: t, rpm: 2100, rawLoad: 6.0, stft1: 1.0, stft2: 0.996, rf: 70,
        vehicleSpeed: 80, intakeTemp: 20, ambientPressure: 960.5, exhaustTemp: 300,
    }));
    // The filter's own output carries correctedLoad; the raw log does not.
    const data = raw.map(p => ({ ...p, correctedLoad: 6.0 / 0.95 }));
    const air = { ...FLAT_AIR, loadTable: factor };
    const fixed = calc.annotateRfKorr(map, data, egt, air, raw);
    check('rf_soll at the corrected 6.316 (0.632) clears a 0.62 floor: open', fixed.every(p => p.rfKorrGateOpen === true),
        JSON.stringify(fixed.map(p => p.rfKorrGateOpen)));
    const asCsv = calc.annotateRfKorr(map, data, egt, { ...FLAT_AIR, loadTable: null }, raw);
    check('loadTable null (correction off): the raw opening 6.0 (0.600) is below it: shut',
        asCsv.every(p => p.rfKorrGateOpen === false));
    const deflt = calc.annotateRfKorr(map, data, egt, { curves: FLAT_AIR.curves }, raw);
    check('no loadTable: the app\'s default table, which is the same correction here',
        deflt.every(p => p.rfKorrGateOpen === true));
}

console.log(fails === 0 ? '\nAll k-ramp checks passed.\n' : `\n${fails} check(s) FAILED.\n`);
process.exit(fails === 0 ? 0 : 1);
