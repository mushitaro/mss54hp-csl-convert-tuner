/**
 * The k-ramp rule: a sample is VE evidence only once the lambda loop has taken back its last step —
 * an rf_korr step or a loop restart to 1.000 — gate open or shut.
 *
 *     after a K step the trim ramps at KF_LA_KI_NEG (0.0406/s in the band) until the lean switch,
 *     so in that window  trim x K = K (1 - 0.0406 t)  — the time since the step, not the VE error;
 *     after a restart the same clock runs from 1.000 with K = 1:  trim = 1 - 0.0406 t
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
 * and what the VE write and the census do with it — it excludes every sample with kRamp !== false,
 * GATE OPEN OR SHUT, because a restart after a fuel cut is the same clock without K (rampState.ts) —
 * the visit gate that comes after it (a cell's substantial samples from >= 3 runs, a gap over 1.0 s
 * starting the next, and worth >= 2 equal runs by weight: (Sum W_v)^2 / Sum W_v^2), the K HOLD check that catches a hold that did not take, and the latch's load
 * fix. Then the second, independent question — is the loop limit-cycling, or walking from the last
 * cell's error to this one's:
 *
 *     REVERSAL       falling phase: the trim rose >= 0.8 x P+ above its minimum since the last
 *                    reversal; rising phase: fell >= 0.8 x P- below its maximum. Direction flips.
 *     RESET          every bank exactly 1.000, both banks bit-identical, a one-sample move > 0.10,
 *                    or no reading: the half-cycle is void, direction set by the next move
 *     lambdaCycling  for every present bank, off its clamp, the half-cycle the sample sits in —
 *                    last reversal to next, no reset between — is in the log and lasts at most
 *                    HALF_CYCLE_MAX_SEC (1.5 s, in SECONDS: the log's unit converted with
 *                    timeScaleSeconds). A walk is not cycling from its first sample; the end of a
 *                    log (a live prefix) is not cycling until its half-cycle closes.
 *
 * All synthetic: a flat Alpha-N table so rf_soll is one number, flat air curves so RF_PT_KORR is 1,
 * and the one binary the repo ships (public/mock) for the P-jump tables. Nothing here reads
 * archive/.
 *
 * The rule's thresholds were checked against the DME's own P-jump counters on archive sessions
 * #967/#968/#970 by a scratch replay (not shipped): settled precision 0.92, recall 0.61 over every
 * gate-open sample. See rampState.ts for the numbers and what each refinement bought.
 */
import fs from 'node:fs';
import {
    VECalculator, RF_TRUNCATION_MEAN_PERCENT, K_HOLD_IN_EFFECT_MAX_RATIO, K_HOLD_CHECK_MIN_SAMPLES,
    VE_MIN_VISITS, VISIT_GAP_SEC, VE_MIN_EFFECTIVE_VISITS,
} from '../src/lib/ve-calculator/calculator.ts';
import {
    KRampTracker, LambdaCycleTracker, isLambdaRampExcluded, readLambdaRampParams, lambdaPJumpAt, lambdaCyclingFlags,
    K_STEP_MIN, K_DROP_MIN, REVERSAL_FRACTION, TRIM_RESET_JUMP, LAMBDA_P_JUMP_FALLBACK, HALF_CYCLE_MAX_SEC,
} from '../src/lib/ve-calculator/rampState.ts';
import { timeScaleSeconds } from '../src/lib/log-engine/filter.ts';
import { isRfKorrFloorHeld, withStockRfKorrFloor, readEgtTables } from '../src/lib/ve-calculator/egtTables.ts';
import { EMPTY_CENSUS, withLambdaRamp } from '../src/lib/log-engine/lambdaGates.ts';
import { resolveRfKorr } from '../src/lib/types.ts';
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
 * `mOf` moves the VE error over time — the car driving into a cell the map has wrong by another
 * amount — with no K step at all.
 */
function simulate({ kOf, openOf, m = 1.0, mOf = () => m, T = 14, delay = 0.12, trim0 = 1.0 }) {
    const dt = 0.005, lag = Math.round(delay / dt), every = Math.round(DT / dt);
    let trim = trim0, wasRich = null;
    const mix = [], out = [], leanSwitches = [], richSwitches = [];
    for (let i = 0; i * dt <= T; i++) {
        const t = i * dt;
        mix.push(trim * kOf(t) * mOf(t));
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
        leaked.push(...climb.filter(p => !isLambdaRampExcluded(p) && p.c < 0.99).map(p => p.c.toFixed(3)));
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
    // and the VE write leaves them out too: its exclusion reads `kRamp` whatever the gate says
    // (isLambdaRampExcluded), so the climb is no longer written as a lean VE error.
    const tExit = 10;
    const ex = simulate({ kOf: t => (t < 2 || t >= tExit ? 1 : 1.16), openOf: t => t >= 2 && t < tExit, T: 16 });
    const exitRich = ex.richSwitches.find(t => t > tExit + 0.12);
    const re = track(ex.rows);
    const shutClimb = ex.rows.map((x, i) => [x, re[i]]).filter(([x]) => x.t >= tExit && x.t < exitRich);
    check('a gate exit from K 1.16 without a fuel cut: kRamp until the rich switch',
        shutClimb.length > 3 && shutClimb.every(([, k]) => k), shutClimb.map(([, k]) => +k).join(''));
    check('...and those gate-shut samples are excluded from the VE write as well',
        shutClimb.every(([x, k]) => !x.open && isLambdaRampExcluded({ rfKorrGateOpen: x.open, kRamp: k })));
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

// --- the limit-cycle flag (lambdaCyclingFlags) ---------------------------------------------------

/** The flags over rows of { t, v1, v2 }, `t` in `secondsPerUnit`. */
const cycles = (rows, { params = null, secondsPerUnit = 1, rpm = 2500, rf = 60 } = {}) => lambdaCyclingFlags(
    rows.map(r => ({ time: r.t, rpm: r.rpm ?? rpm, rf: r.rf ?? rf, stft1: r.v1, stft2: r.v2 })), params, secondsPerUnit);
/** The sample indices at which the tracker sees bank 1 reverse (the synthetic's banks move as one). */
const reversalsAt = (rows) => {
    const tr = new LambdaCycleTracker(null);
    return rows.map((r, i) => (tr.step({ time: r.t, rpm: 2500, rf: 60, stft1: r.v1, stft2: r.v2 }).event[0] === 'reversal' ? i : -1))
        .filter(i => i >= 0);
};
const bits = (xs) => xs.map(x => +x).join('');
/** The flags over an index range [a, b), as bits for a failure message. */
const span = (c, a, b) => c.slice(a, b);
/**
 * The loop's dead time for these checks: 0.4 s, gas transport plus sensor. With it the synthetic's
 * half-cycles run 0.40-0.75 s; the DME's own P-jump counters on #967/#968/#970 put the car's at
 * 0.52 s (p10) and 0.89 s (median), so the car is at least this slow. The 0.12 s the k-ramp checks
 * above use makes a lean phase shorter than the 0.3 s sample, whose P+ and the P- after it net to
 * 0.016 in one interval — exactly the 0.8 x P+ threshold — so pairs of reversals vanish and the
 * half-cycles around them read long: the safe side, and the price of a 3 Hz log on a loop faster
 * than the car's.
 */
const CYCLE_DELAY = 0.4;
const loop = (opts) => simulate({ kOf: () => 1, openOf: () => false, delay: CYCLE_DELAY, ...opts });
/** A gate-shut loop at λ = 1 that, at `T_MOVE`, drives into a cell `m` times rich: the trim walks
 *  from 1.000 to 1/m at KI_NEG with no switch, then cycles there. No K step anywhere. */
const T_MOVE = 10;
const cellWalk = (m = 1.12, T = 20) => loop({ mOf: t => (t < T_MOVE ? 1.0 : m), T });
/** Every switch of a simulated loop, in time order. */
const switches = (sim) => [...sim.leanSwitches, ...sim.richSwitches].sort((a, b) => a - b);

console.log('\n[the reversals are the loop\'s switches]');
{
    const lc = loop({ T: 20 });
    const sw = switches(lc), rev = reversalsAt(lc.rows);
    check('every reversal the tracker counts follows a switch of the loop by at most two samples',
        rev.length > 15 && rev.every(i => sw.some(t => t <= lc.rows[i].t && t > lc.rows[i].t - 2 * DT)),
        rev.map(i => lc.rows[i].t.toFixed(1)).join(' '));
    check('...and no switch goes uncounted while the loop cycles at λ = 1',
        sw.filter(t => t > 1 && t < lc.rows.at(-1).t - 2 * DT).every(t => rev.some(i => lc.rows[i].t >= t && lc.rows[i].t < t + 2 * DT)));
    // A monotone ramp crosses either threshold within a fraction of a second; only the move against
    // the phase's direction is a reversal.
    const ramp = Array.from({ length: 12 }, (_, i) => ({ t: i * DT, v1: 1 - KI_NEG * DT * i, v2: 0.996 - KI_NEG * DT * i }));
    check('a monotone ramp has no reversal at all', reversalsAt(ramp).length === 0);
}

console.log('\n[lambdaCycling: a limit cycle reads cycling, a walk does not — from its first sample]');
{
    check('HALF_CYCLE_MAX_SEC is 1.5 s', HALF_CYCLE_MAX_SEC === 1.5);
    const lc = loop({ T: 20 });
    const sw = switches(lc);
    const halves = sw.slice(1).map((t, i) => t - sw[i]);
    check('the synthetic\'s half-cycles are inside the bound', halves.length > 10 && Math.max(...halves) < HALF_CYCLE_MAX_SEC,
        Math.max(...halves).toFixed(2));
    const c = cycles(lc.rows);
    const rev = reversalsAt(lc.rows);
    check('a limit cycle reads cycling on every sample from its first reversal to its last',
        rev.at(-1) - rev[0] > 30 && span(c, rev[0], rev.at(-1)).every(x => x), bits(span(c, rev[0], rev.at(-1))));
    check('...and not before its first: the half-cycle it is in has no start', span(c, 0, rev[0]).every(x => !x));
    check('...nor from its last on: the log ended before that half-cycle closed', span(c, rev.at(-1), c.length).every(x => !x),
        bits(span(c, rev.at(-1), c.length)));

    // Into a cell 12 % rich at T_MOVE: the trim walks 1.00 -> 0.89 at 0.0406/s with no switch. The
    // half-cycle it sits in opens at the last reversal before the move reached the sensor and closes
    // at the lean switch that ends it.
    const w = cellWalk();
    const cw = cycles(w.rows);
    const kr = track(w.rows);
    const wrev = reversalsAt(w.rows);
    const tIn = T_MOVE + CYCLE_DELAY;
    const open = wrev.filter(i => w.rows[i].t <= tIn).at(-1), close = wrev.find(i => w.rows[i].t > tIn);
    check('the walk\'s half-cycle lasts more than 2 s (else this tests nothing)', w.rows[close].t - w.rows[open].t > 2.0,
        (w.rows[close].t - w.rows[open].t).toFixed(2));
    check('a walk reads NOT cycling on every sample, from the reversal it opens with',
        close - open >= 6 && span(cw, open, close).every(x => !x), bits(span(cw, open, close)));
    check('...those within 1.5 s of that reversal included: what a backward look would have passed',
        span(w.rows, open, close).filter(x => x.t - w.rows[open].t <= HALF_CYCLE_MAX_SEC).length >= 4);
    check('...on samples kRamp calls settled: the case the flag exists for', span(kr, open, close).every(k => k === false));
    const first = w.rows.findIndex(x => x.t >= 2);
    check('...and cycling before it', span(cw, first, open).length > 20 && span(cw, first, open).every(x => x),
        bits(span(cw, first, open)));
    check('...and again once the loop cycles around the new trim', wrev.at(-1) - close > 5
        && span(cw, close, wrev.at(-1)).every(x => x), bits(span(cw, close, wrev.at(-1))));
}

console.log('\n[lambdaCycling resets: loop off, identical banks, a leap, a missing reading]');
{
    const rows = loop({ T: 14 }).rows;
    const at = rows.findIndex(x => x.t >= 6);
    const plain = cycles(rows);
    check('cycling around the sample the resets go on', plain[at - 1] && plain[at] && plain[at + 1]);
    const variants = {
        'loop off (both banks exactly 1.000)': r => ({ ...r, v1: 1, v2: 1 }),
        'both banks bit-identical': r => ({ ...r, v2: r.v1 }),
        [`a one-sample leap over TRIM_RESET_JUMP (${TRIM_RESET_JUMP})`]: r => ({ ...r, v1: r.v1 - 0.15, v2: r.v2 - 0.15 }),
    };
    for (const [name, f] of Object.entries(variants)) {
        const changed = rows.map((r, i) => (i === at ? f(r) : r));
        const c = cycles(changed);
        const rev = reversalsAt(changed);
        // The half-cycle the reset falls in is void both ways: from the reversal before it, and up
        // to the first reversal the tracker counts after it.
        const before = rev.filter(i => i < at).at(-1), after = rev.find(i => i > at);
        check(`${name}: not cycling from the reversal before it to the first one after`,
            span(c, before, after).every(x => !x), bits(span(c, before - 1, after + 1)));
        check('...and cycling again from there', rev.at(-1) - after > 5 && span(c, after, rev.at(-1)).every(x => x),
            bits(span(c, after, rev.at(-1))));
    }
    // A bank with no reading: the sample is judged on the bank that has one; the missing bank's
    // half-cycle is cut there, both ways.
    const gap = cycles(rows.map((r, i) => (i === at ? { ...r, v1: undefined } : r)));
    check('bank 1 missing: the sample reads bank 2 alone (cycling)', gap[at] === true);
    check('...and either side of it bank 1\'s half-cycle has no end, or no start: not cycling',
        gap[at - 1] === false && gap[at + 1] === false, bits(gap.slice(at - 2, at + 3)));
    const none = cycles(rows.map((r, i) => (i === at ? { ...r, v1: undefined, v2: undefined } : r)));
    check('no bank present: not cycling', none[at] === false);
}

console.log('\n[a trim on its clamp is never cycling]');
{
    // Reversing every sample against the clamp — it switches, and it is still reporting a bound.
    for (const [clamp, other] of [[0.70, 0.73], [1.30, 1.27]]) {
        const rows = Array.from({ length: 16 }, (_, i) => {
            const v = i % 2 ? clamp : other;
            return { t: i * DT, v1: v, v2: v + (clamp < 1 ? 0.004 : -0.004) };
        });
        const c = cycles(rows);
        const inner = rows.map((r, i) => [r, c[i]]).slice(3, -1);
        check(`pinned at ${clamp}: never cycling on a clamp sample`, inner.filter(([r]) => r.v1 === clamp).every(([, x]) => !x));
        check('...though the samples off it, reversing as often, are', inner.filter(([r]) => r.v1 !== clamp).every(([, x]) => x),
            bits(inner.map(([, x]) => x)));
    }
}

console.log('\n[one bank walking is not cycling]');
{
    const rows0 = loop({ T: 14 }).rows;
    const at = rows0.findIndex(x => x.t >= 6);
    let v2 = rows0[at].v2;
    const rows = rows0.map((r, i) => (i <= at ? r : { ...r, v2: (v2 -= KI_NEG * DT) }));
    const c = cycles(rows);
    check('bank 1 cycling, bank 2 walking from 6 s on: not cycling anywhere in the walk',
        span(c, at + 1, c.length).every(x => !x), bits(span(c, at + 1, c.length)));
    const single = cycles(rows0.map(r => ({ ...r, v2: undefined })));
    const rev = reversalsAt(rows0);
    check('a single-bank log reads its one bank', span(single, rev[0], rev.at(-1)).every(x => x),
        bits(span(single, rev[0], rev.at(-1))));
}

console.log('\n[a prefix reads its open half-cycle not cycling, and the rest as the whole log does]');
{
    // What a live census sees: it re-annotates the raw prefix each flush, and the half-cycle the
    // prefix ends in has not closed yet.
    const rows = cellWalk().rows;
    const full = cycles(rows);
    for (const n of [25, 40, 52]) {
        const pre = cycles(rows.slice(0, n));
        const differ = pre.map((x, i) => (x !== full[i] ? i : -1)).filter(i => i >= 0);
        check(`prefix of ${n} samples (to ${rows[n - 1].t.toFixed(1)} s): cycling only where the whole log says so`,
            pre.every((x, i) => !x || full[i]));
        // A half-cycle the whole log calls cycling is at most 1.5 s long, so if it runs past the
        // prefix's end, its samples are all within 1.5 s of it.
        check(`...and different only within ${HALF_CYCLE_MAX_SEC} s of its end`,
            differ.every(i => rows[n - 1].t - rows[i].t < HALF_CYCLE_MAX_SEC) && (n === 40 || differ.length > 0),
            JSON.stringify(differ));
    }
}

console.log('\n[the bound is in seconds: a millisecond log is converted, not assumed]');
{
    // Stretched 1 % so no half-cycle lands exactly on 1.5 s, where float rounding in either unit
    // could tip a comparison and the two would differ for a reason that is not the unit.
    const sec = cellWalk().rows.map(r => ({ ...r, t: +(r.t * 1.01).toFixed(4) }));
    const ms = sec.map(r => ({ ...r, t: Math.round(r.t * 1e4) / 10 }));
    check('timeScaleSeconds reads the ms log as 0.001 s per unit, the seconds log as 1',
        timeScaleSeconds(ms.map(r => ({ time: r.t }))) === 0.001 && timeScaleSeconds(sec.map(r => ({ time: r.t }))) === 1);
    const want = cycles(sec);
    check('the ms log with its unit reads exactly what the seconds log reads',
        JSON.stringify(cycles(ms, { secondsPerUnit: 0.001 })) === JSON.stringify(want) && want.some(x => x) && want.some(x => !x));
    check('...and taken as seconds it would not: the unit decides the verdict',
        JSON.stringify(cycles(ms, { secondsPerUnit: 1 })) !== JSON.stringify(want));
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
    // One visit per cell here (`minCellVisits: 1`): this section is about the ramp; the visit gate
    // has its own below.
    const res = calc.calculateNewVEMap(MAP, ann, { minCellSamples: 3, minCellWeight: 0, minCellVisits: 1 });
    const [rr, rc] = cellOf(2200, 7.5);
    const [pr, pc] = cellOf(3100, 15);
    // The ramp cell also holds the four gate-shut samples from before the step. Take them out to see
    // the verdict on the ramp alone.
    const rampOnly = calc.calculateNewVEMap(MAP, ann.filter(p => p.rfKorrGateOpen),
        { minCellSamples: 3, minCellWeight: 0, minCellVisits: 1 });
    check('a cell whose every sample was mid-ramp is refused as lambda-ramp', rampOnly.rejectMap[rr][rc] === 'lambda-ramp',
        String(rampOnly.rejectMap[rr][rc]));
    check('...and reports no written sample', rampOnly.hitMap[rr][rc] === 0);
    check('with the pre-step gate-shut samples in it, the cell is not lambda-ramp (it has evidence)',
        res.rejectMap[rr][rc] !== 'lambda-ramp' && res.hitMap[rr][rc] > 0);
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
    check('isLambdaRampExcluded is exactly "not post-ramp", whatever the gate says',
        isLambdaRampExcluded({ rfKorrGateOpen: true, kRamp: true }) && isLambdaRampExcluded({ rfKorrGateOpen: true })
        && !isLambdaRampExcluded({ rfKorrGateOpen: true, kRamp: false })
        && isLambdaRampExcluded({ rfKorrGateOpen: false, kRamp: true }) && isLambdaRampExcluded({ kRamp: true })
        && !isLambdaRampExcluded({ rfKorrGateOpen: false, kRamp: false }) && !isLambdaRampExcluded({ kRamp: false })
        && isLambdaRampExcluded({}));
}

console.log('\n[the census and the cell detail]');
{
    check('the census has a lambdaRamp count, zero by default', EMPTY_CENSUS.lambdaRamp === 0);
    const c = { ...EMPTY_CENSUS, fuelCut: 3 };
    const merged = withLambdaRamp(c, 7);
    check('withLambdaRamp puts the count in', merged.lambdaRamp === 7 && merged.fuelCut === 3);
    check('...on a copy: the filter\'s resume census is untouched', c.lambdaRamp === 0);
    // The census sheet and the assistant bridge both read their names and sentences from here.
    const tsx = fs.readFileSync(new URL('../src/lib/log-engine/dropReasons.ts', import.meta.url), 'utf8');
    check('the census labels it "lambda ramp"', /lambdaRamp:\s*'lambda ramp'/.test(tsx));
    // What happened, then what to do — in each language, and the instruction is the pedal.
    check('...with what happened and the cure, in each language',
        /lambdaRamp:\s*'The lambda trim was still ramping back from a fuel cut, a loop restart or an rf_korr step, so it read the seconds since then rather than the map\. After a lift-off or a tip-in, hold the pedal steady for a few seconds — the cell counts from there\.'/.test(tsx)
        && /lambdaRamp:\s*'燃料カット・ループ再始動・rf_korr の段差のあとで λ トリムがまだ戻る途中にあり、マップではなく経過秒数を読んでいました。アクセルを戻した後や踏み込んだ後は、数秒ペダルを一定に保ってください — そこからがセルに数えられます。'/.test(tsx));
    const grid = buildCoverage({
        hitMap: [[0, 0, 5]], weightMap: [[0, 0, 4]], correctionMap: [[1, 1, 0.95]],
        rejectMap: [['lambda-ramp', 'no-evidence', 'few-visits']], rows: 1, cols: 3,
    });
    check('a lambda-ramp cell reads as driven-and-refused, not as never driven',
        grid[0][0].state === 'refused' && grid[0][1].state === 'unvisited');
    check('...and not as below the engine\'s reach', grid[0][0].belowReach === false);
    check('a few-visits cell is driven-and-refused', grid[0][2].state === 'refused');
    check('the ramp remedy names the pedal, in both languages',
        coverageRemedy('lambda-ramp', 'en') === 'after a lift-off or tip-in, hold the pedal steady for a few seconds before the cell counts'
        && coverageRemedy('lambda-ramp', 'ja') === 'アクセルを戻した後や踏み込んだ後は、数秒ペダルを一定に保つ —— セルに数えられるのはそこから');
    check('the visit remedy names the three occasions, in both languages',
        /3 separate occasions/.test(coverageRemedy('few-visits', 'en') ?? '')
        && /別々の機会に 3 回/.test(coverageRemedy('few-visits', 'ja') ?? ''));
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
    check('chunked live steps == the batch annotation', live.every((s, i) => s.kRamp === batch[i]),
        JSON.stringify(live.map(s => s.kRamp)) + ' vs ' + JSON.stringify(batch));
    check('the walk carries no cycle flag: that needs the half-cycle to end', live.every(s => !('cycling' in s)));
}

console.log('\n[lambdaCycling on the annotated log, and the VE write does not read it]');
{
    // The cell walk through the calculator: gate shut throughout (K HOLD looks the same), and the
    // walk samples come out kRamp false, lambdaCycling false.
    const rows = cellWalk().rows.map(r => ({ ...r, t: +(r.t * 1.01).toFixed(4) }));
    const log = toLog(rows);
    const ann = calc.annotateRfKorr(MAP, log, EGT, FLAT_AIR, log);
    check('every annotated sample carries the flag beside kRamp',
        ann.every(p => typeof p.lambdaCycling === 'boolean' && p.kRamp !== undefined));
    check('...and agrees with lambdaCyclingFlags run on its own',
        JSON.stringify(ann.map(p => p.lambdaCycling)) === JSON.stringify(cycles(rows, { rpm: 2200, rf: 70 })));
    check('the walk samples: post-ramp by kRamp, not cycling', ann.some(p => p.kRamp === false && p.lambdaCycling === false));
    // What the live census does each flush: annotate the raw prefix that has arrived.
    for (const n of [30, 45]) {
        const pre = calc.annotateRfKorr(MAP, log.slice(0, n), EGT, FLAT_AIR, log.slice(0, n));
        check(`annotateRfKorr over a ${n}-sample prefix: cycling only where the whole drive says so, and the same `
            + `${HALF_CYCLE_MAX_SEC} s back from its end`,
            pre.every((p, i) => !p.lambdaCycling || ann[i].lambdaCycling)
            && pre.every((p, i) => p.lambdaCycling === ann[i].lambdaCycling || log[n - 1].time - log[i].time < HALF_CYCLE_MAX_SEC * 1.01));
    }
    // The annotation of the same drive in milliseconds decides the unit itself.
    const logMs = log.map(p => ({ ...p, time: Math.round(p.time * 1e4) / 10 }));
    const annMs = calc.annotateRfKorr(MAP, logMs, EGT, FLAT_AIR, logMs);
    check('annotateRfKorr on the same drive in ms: the same flag, sample for sample',
        JSON.stringify(annMs.map(p => p.lambdaCycling)) === JSON.stringify(ann.map(p => p.lambdaCycling)));
    // Outside the latch source there is no history: no kRamp and no lambdaCycling.
    const stray = { ...log[5], time: log[5].time + 0.05 };
    const [s] = calc.annotateRfKorr(MAP, [stray], EGT, FLAT_AIR, log);
    check('a sample the walk did not cover gets neither flag', s.kRamp === undefined && s.lambdaCycling === undefined);
    // The VE write never reads it: flipped or stripped, the same map.
    const opts = { minCellSamples: 1, minCellWeight: 0, minCellVisits: 1 };
    const a = calc.calculateNewVEMap(MAP, ann, opts);
    const b = calc.calculateNewVEMap(MAP, ann.map(p => ({ ...p, lambdaCycling: !p.lambdaCycling })), opts);
    const c = calc.calculateNewVEMap(MAP, ann.map(({ lambdaCycling, ...p }) => p), opts);
    const same = (x, y) => JSON.stringify([x.newMap, x.demandMap, x.hitMap]) === JSON.stringify([y.newMap, y.demandMap, y.hitMap]);
    check('the VE write: the same map with lambdaCycling flipped or absent', same(a, b) && same(a, c));
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
    const w = calc.calculateNewVEMap(MAP, annHeld, { minCellSamples: 1, minCellWeight: 0, minCellVisits: 1 });
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

// --- the gate-shut restart, and the visit gate ---------------------------------------------------

/**
 * A gate-shut limit cycle around `c` — the trim that holds λ = 1 at (`rpm`, `load`) — for `n`
 * samples from `t0`: down at KI_NEG until it would pass c - 0.01, then the P+ jump; up at KI_POS
 * until it would pass c + 0.01, then the P- jump. Bank 2 rides 0.003 below: two working banks never
 * read the same code. K is 1 and the gate shut throughout — K HOLD's case.
 */
function cycleRows({ c, n, t0, rpm, load, v0 = c + 0.005, dir0 = -1 }) {
    const rows = [];
    let v = v0, dir = dir0, t = t0;
    for (let i = 0; i < n; i++, t += DT) {
        if (dir < 0) { const next = v - KI_NEG * DT; if (next <= c - 0.01) { v += P_POS; dir = 1; } else v = next; }
        else { const next = v + KI_POS * DT; if (next >= c + 0.01) { v -= P_NEG; dir = -1; } else v = next; }
        rows.push({ t, open: false, k: 1, v1: v, v2: v - 0.003, rpm, load });
    }
    return rows;
}

/**
 * A lift-off fuel cut and the restart after it, gate shut: `cut` samples with both banks exactly
 * 1.000 (the loop off — the VE filter drops them, the walk does not), then the integrator from 1.000
 * ramping at KI_NEG with both banks bit-identical for `rampSec` — the clock, whatever the cell
 * needs — then the lean switch (P+, the banks part) and the limit cycle around `c`.
 */
function restartRows({ c, t0, rpm, load, cut = 3, rampSec, n }) {
    const rows = [];
    let t = t0;
    for (let i = 0; i < cut; i++, t += DT) rows.push({ t, open: false, k: 1, v1: 1, v2: 1, rpm, load: 0.4, cut: true });
    let v = 1.0;
    for (let i = 0, steps = Math.round(rampSec / DT); i < steps; i++, t += DT) {
        v -= KI_NEG * DT;
        rows.push({ t, open: false, k: 1, v1: v, v2: v, rpm, load, ramp: true });
    }
    v += P_POS;
    rows.push({ t, open: false, k: 1, v1: v, v2: v - 0.003, rpm, load, switched: true });
    rows.push(...cycleRows({ c, n, t0: t + DT, rpm, load, v0: v, dir0: 1 }));
    return rows;
}

/** The VE stream of a raw log: what the filter would leave — the fuel-cut samples out. */
const veStream = (raw, rows) => raw.filter((_, i) => !rows[i].cut);
const trimOf = (p) => (p.stft1 + p.stft2) / 2;
const meanTrim = (ps) => ps.reduce((a, p) => a + trimOf(p), 0) / ps.length;

console.log('\n[a restart with the gate shut is the same clock: excluded until the reversal, written after]');
{
    // Cruise at 1800 rpm / RO 5 with the loop switching, then a fuel cut, and fuelling resumes at
    // 2700 rpm / RO 7.5 — a cell 10 % rich, so the trim it needs is 0.90. From the restart the trim
    // ramps 1.000 -> 0.89 over 2.7 s with the gate SHUT; then the lean switch, and the cycle at 0.90.
    const C_B = 0.90;
    const cruise = cycleRows({ c: 0.98, n: 20, t0: 0, rpm: 1800, load: 5 });
    const rows = [...cruise, ...restartRows({ c: C_B, t0: cruise.at(-1).t + DT, rpm: 2700, load: 7.5, rampSec: 2.7, n: 24 })];
    const raw = toLog(rows);
    const data = veStream(raw, rows);
    const ann = calc.annotateRfKorr(MAP, data, EGT, FLAT_AIR, raw);
    const kept = rows.filter(r => !r.cut);
    const isRamp = kept.map(r => !!r.ramp), afterSwitch = kept.map((r, i) => i >= kept.findIndex(x => x.switched));
    check('every sample is gate-shut and carries a ramp verdict',
        ann.every(p => p.rfKorrGateOpen === false && typeof p.kRamp === 'boolean'));
    check('the cruise before the cut: post-ramp throughout (the cruise is unaffected)',
        ann.slice(0, cruise.length).every(p => p.kRamp === false));
    check('every sample of the restart ramp, gate shut, is kRamp',
        ann.filter((_, i) => isRamp[i]).length === 9 && ann.filter((_, i) => isRamp[i]).every(p => p.kRamp === true));
    check('...and from the lean switch on, post-ramp', ann.filter((_, i) => afterSwitch[i]).every(p => p.kRamp === false),
        bits(ann.filter((_, i) => afterSwitch[i]).map(p => p.kRamp)));
    check('...so the predicate excludes the ramp, and only the ramp',
        ann.every((p, i) => isLambdaRampExcluded(p) === isRamp[i]));

    const res = calc.calculateNewVEMap(MAP, ann, { minCellVisits: 1 });
    const [br, bc] = cellOf(2700, 7.5), [ar, ac] = cellOf(1800, 5);
    const post = ann.filter((_, i) => afterSwitch[i]);
    check('the restart cell is written from the post-switch samples alone',
        res.acceptedMap[br][bc] && res.hitMap[br][bc] === post.length && near(res.demandMap[br][bc], meanTrim(post), 1e-12),
        `${res.hitMap[br][bc]} hits, ${res.demandMap[br][bc]} vs ${meanTrim(post)}`);
    check('...which is the cell\'s own error, 1 / 1.10 to within the cycle\'s asymmetry',
        Math.abs(res.demandMap[br][bc] - C_B) < 0.01, String(res.demandMap[br][bc]));
    // What the ramp says instead: 1 - 0.0406 t, the seconds since fuelling resumed — 0.94 on
    // average over its 2.7 s, whatever the cell needed.
    const rampMean = meanTrim(ann.filter((_, i) => isRamp[i]));
    check('...where the ramp samples, written, would have read 3 % or more nearer 1.000 than the cell',
        rampMean - res.demandMap[br][bc] > 0.03, `${rampMean.toFixed(4)} vs ${res.demandMap[br][bc].toFixed(4)}`);
    check('the cruise cell is written from every one of its samples',
        res.hitMap[ar][ac] === cruise.length && near(res.demandMap[ar][ac], meanTrim(ann.slice(0, cruise.length)), 1e-12));
    // The same restart with every sample of the cell inside the ramp: nothing written, and it says so.
    const short = [...cruise, ...restartRows({ c: C_B, t0: cruise.at(-1).t + DT, rpm: 2700, load: 7.5, rampSec: 2.7, n: 0 })]
        .filter(r => !r.switched);
    const shortRaw = toLog(short);
    const rampOnly = calc.calculateNewVEMap(MAP, calc.annotateRfKorr(MAP, veStream(shortRaw, short), EGT, FLAT_AIR, shortRaw),
        { minCellVisits: 1 });
    check('a cell reached only inside a gate-shut ramp is refused as lambda-ramp, with no written sample',
        rampOnly.rejectMap[br][bc] === 'lambda-ramp' && rampOnly.hitMap[br][bc] === 0, String(rampOnly.rejectMap[br][bc]));
}

console.log('\n[the visit gate: a cell needs three separate visits]');
{
    // Cell C (2400 rpm / RO 10, needs 0.95) is visited `k` times for 8 samples each, the car going to
    // cell D (3100 rpm / RO 15) for `away` samples in between. Every sample sits on a breakpoint
    // (w = 1), so each visit is 8 samples and W 8: the count and the weight bars are cleared by any
    // one visit, and only the visit gate can refuse.
    check(`VE_MIN_VISITS is 3 and VISIT_GAP_SEC ${VISIT_GAP_SEC} s`, VE_MIN_VISITS === 3 && VISIT_GAP_SEC === 1.0);
    const tour = (k, away, middle = 'cycle') => {
        const rows = [];
        let t = 0;
        for (let v = 0; v < k; v++) {
            const visit = v === 1 && middle === 'ramp'
                // The middle visit made of nothing but a restart ramp: a fuel cut at D, fuelling back
                // in C, and the car gone to D again before the switch (the banks identical throughout).
                ? restartRows({ c: 0.95, t0: t, rpm: 2400, load: 10, rampSec: 2.4, n: 0 }).filter(r => !r.switched)
                : cycleRows({ c: 0.95, n: 8, t0: t, rpm: 2400, load: 10 });
            rows.push(...visit);
            t = rows.at(-1).t + DT;
            if (v < k - 1) {
                const d = middle === 'ramp' && v === 1
                    ? restartRows({ c: 1.0, t0: t, rpm: 3100, load: 15, cut: 0, rampSec: 0.6, n: away })
                    : cycleRows({ c: 1.0, n: away, t0: t, rpm: 3100, load: 15 });
                rows.push(...d);
                t = rows.at(-1).t + DT;
            }
        }
        return rows;
    };
    const verdict = (rows) => {
        const raw = toLog(rows);
        const ann = calc.annotateRfKorr(MAP, veStream(raw, rows), EGT, FLAT_AIR, raw);
        return { res: calc.calculateNewVEMap(MAP, ann, {}), ann };
    };
    const [cr, cc] = cellOf(2400, 10);
    // `away` samples at D put the gap between C's last and next sample at (away + 1) x 0.3 s.
    const two = verdict(tour(2, 5)).res, three = verdict(tour(3, 5)).res;
    check('two visits 1.8 s apart: refused as few-visits', two.rejectMap[cr][cc] === 'few-visits', String(two.rejectMap[cr][cc]));
    check('...though its 16 samples and W 16 clear the count and weight bars', two.hitMap[cr][cc] === 16 && two.weightMap[cr][cc] >= 16 - 1e-9);
    check('...and its demand is still reported', Math.abs(two.demandMap[cr][cc] - 0.95) < 0.01, String(two.demandMap[cr][cc]));
    check('three visits 1.8 s apart: written', three.rejectMap[cr][cc] === null && three.acceptedMap[cr][cc],
        String(three.rejectMap[cr][cc]));
    const near3 = verdict(tour(3, 2)).res;
    check('three runs only 0.9 s apart are ONE visit: refused', near3.rejectMap[cr][cc] === 'few-visits',
        String(near3.rejectMap[cr][cc]));
    const justOver = verdict(tour(3, 3)).res;
    check('three runs 1.2 s apart are three: written', justOver.rejectMap[cr][cc] === null, String(justOver.rejectMap[cr][cc]));
    // A visit is made of samples the write TAKES: one that was all ramp does not count.
    const rampMiddle = verdict(tour(3, 5, 'ramp'));
    const rampSamples = rampMiddle.ann.filter(p => p.rpm === 2400 && p.kRamp === true).length;
    check('the middle visit is a restart ramp in C, every sample of it kRamp (else this tests nothing)', rampSamples === 8,
        String(rampSamples));
    check('...so C has two visits that count, and is refused as few-visits', rampMiddle.res.rejectMap[cr][cc] === 'few-visits',
        String(rampMiddle.res.rejectMap[cr][cc]));

    // THREE VISITS, ONE OF THEM THE CELL. #974's 10 % / 2700 rpm had substantial samples 1 + 9 + 3,
    // the middle visit 72 % of the weight: three visits by count, (Sum W_v)^2 / Sum W_v^2 = 1.76 by
    // weight. Here every sample sits on the breakpoint (w = 1), so W_v is the visit's sample count.
    check(`VE_MIN_EFFECTIVE_VISITS is ${VE_MIN_EFFECTIVE_VISITS}`, VE_MIN_EFFECTIVE_VISITS === 2);
    const visitsOf = (ns, away = 5) => {
        const rows = [];
        let t = 0;
        ns.forEach((n, v) => {
            rows.push(...cycleRows({ c: 0.95, n, t0: t, rpm: 2400, load: 10 }));
            t = rows.at(-1).t + DT;
            if (v < ns.length - 1) { rows.push(...cycleRows({ c: 1.0, n: away, t0: t, rpm: 3100, load: 15 })); t = rows.at(-1).t + DT; }
        });
        return verdict(rows).res;
    };
    const lopsided = visitsOf([1, 9, 3]);
    check('visits of 1 + 9 + 3 samples (worth 1.86 by weight): refused as few-visits, though three by count',
        lopsided.rejectMap[cr][cc] === 'few-visits' && lopsided.hitMap[cr][cc] === 13 && lopsided.weightMap[cr][cc] >= 13 - 1e-9,
        `${lopsided.rejectMap[cr][cc]}, ${lopsided.hitMap[cr][cc]} hits`);
    check('...and a fourth visit of 3 makes it worth 2.6: written', visitsOf([1, 9, 3, 3]).rejectMap[cr][cc] === null,
        String(visitsOf([1, 9, 3, 3]).rejectMap[cr][cc]));
    check('unequal is not lopsided — 8 + 4 + 4 (worth 2.67): written', visitsOf([8, 4, 4]).rejectMap[cr][cc] === null,
        String(visitsOf([8, 4, 4]).rejectMap[cr][cc]));
    check('a script that turns the visit gate off (minCellVisits 0) turns the weight half off too',
        (() => { const raw = toLog(tour(1, 5)); const ann = calc.annotateRfKorr(MAP, raw, EGT, FLAT_AIR, raw);
            return calc.calculateNewVEMap(MAP, ann, { minCellVisits: 0 }).rejectMap[cr][cc] === null; })());
}

console.log('\n[live and batch agree: ramp, visits, verdicts]');
{
    // The two drives above back to back — the restart and the three-visit tour — with the fuel-cut
    // samples in the raw log only. The batch is runCalculation's: annotate `data` off one walk over
    // `rawData`, then calculateNewVEMap. The live is appendCalculation's: ONE walk held across
    // flushes, raw samples stepped as they arrive, each data sample annotated with the walk's
    // `kRamp` and binned with the log's time unit.
    const a = [...cycleRows({ c: 0.98, n: 20, t0: 0, rpm: 1800, load: 5 })];
    a.push(...restartRows({ c: 0.90, t0: a.at(-1).t + DT, rpm: 2700, load: 7.5, rampSec: 2.7, n: 24 }));
    let t = a.at(-1).t + DT;
    for (let v = 0; v < 3; v++) {
        a.push(...cycleRows({ c: 0.95, n: 8, t0: t, rpm: 2400, load: 10 }));
        t = a.at(-1).t + DT;
        a.push(...cycleRows({ c: 1.0, n: 5, t0: t, rpm: 3100, load: 15 }));
        t = a.at(-1).t + DT;
    }
    const raw = toLog(a);
    const data = veStream(raw, a);
    const ann = calc.annotateRfKorr(MAP, data, EGT, FLAT_AIR, raw);
    // runCalculation hands the visit gap the RAW log's unit; appendCalculation reads the raw prefix.
    const batch = calc.calculateNewVEMap(MAP, ann, { secondsPerUnit: timeScaleSeconds(raw) });
    const gridB = calc.createGrid();
    const plan = resolveRfKorr({});
    for (const p of ann) calc.accumulatePoint(gridB, p, plan, undefined, timeScaleSeconds(raw));

    const walk = calc.rfKorrWalk(MAP, EGT, FLAT_AIR);
    const track = new Map();
    const gridL = calc.createGrid();
    let rawAt = 0, dataAt = 0, rampLive = 0;
    for (const chunk of [3, 1, 11, 7, 40, 1000]) {
        // Raw arrives first and runs ahead of the filtered stream, as on the car.
        const rawEnd = Math.min(raw.length, rawAt + chunk + 2);
        for (; rawAt < rawEnd; rawAt++) track.set(raw[rawAt].time, walk.step(raw[rawAt]));
        const dataEnd = data.findIndex(p => p.time > raw[rawAt - 1].time);
        const upto = dataEnd < 0 ? data.length : dataEnd;
        const spu = timeScaleSeconds(raw.slice(0, rawAt));
        for (; dataAt < upto; dataAt++) {
            const st = track.get(data[dataAt].time);
            const p0 = calc.annotateRfKorrPoint(MAP, data[dataAt], EGT, FLAT_AIR, st ? st.open : null);
            const p = st ? { ...p0, kRamp: st.kRamp } : p0;
            if (isLambdaRampExcluded(p)) rampLive++;
            calc.accumulatePoint(gridL, p, plan, undefined, spu);
        }
        calc.finalizeGrid(MAP, gridL, {});   // every flush finalises; it must not disturb the grid
    }
    const live = calc.finalizeGrid(MAP, gridL, {});
    check('the live run consumed every sample', rawAt === raw.length && dataAt === data.length);
    check('the drive has ramp samples and a three-visit cell (else this compares nothing)',
        rampLive > 5 && batch.rejectMap[cellOf(2400, 10)[0]][cellOf(2400, 10)[1]] === null, `${rampLive}`);
    check('the same ramp count: live counter == the batch census', rampLive === ann.filter(isLambdaRampExcluded).length,
        `${rampLive} vs ${ann.filter(isLambdaRampExcluded).length}`);
    check('the same visits in every cell', JSON.stringify(gridB.map(r => r.map(c => c.visits)))
        === JSON.stringify(gridL.map(r => r.map(c => c.visits))));
    check('the same visit weights in every cell (the sums the effective count reads)',
        JSON.stringify(gridB.map(r => r.map(c => [c.visitWeightSum, c.visitWeight, c.visitWeightSqDone])))
        === JSON.stringify(gridL.map(r => r.map(c => [c.visitWeightSum, c.visitWeight, c.visitWeightSqDone]))));
    check('the same ramp exclusions in every cell', JSON.stringify(gridB.map(r => r.map(c => c.lambdaRampCount)))
        === JSON.stringify(gridL.map(r => r.map(c => c.lambdaRampCount))));
    check('the same verdict in every cell', JSON.stringify(batch.rejectMap) === JSON.stringify(live.rejectMap));
    check('the same demand, hits and map', JSON.stringify([batch.demandMap, batch.hitMap, batch.newMap])
        === JSON.stringify([live.demandMap, live.hitMap, live.newMap]));
}

console.log('\n[the visit gap\'s unit comes off the raw log, on both paths]');
{
    // The filtered stream can open sparse while the raw log is dense: here the first VE sample is in
    // cell D at 100 s and the next in C at 106 s, everything between filtered out. Read off that
    // prefix the median step is 6 — a millisecond log by `timeScaleSeconds` — and C's first sample
    // is stored as 0.106 s; the next flush reads seconds and opens a visit that is not one. C is
    // visited twice (106 s, 200 s), four samples each.
    const rows = [];
    const seg = (c, n, rpm, load) => {
        const t0 = rows.length ? rows.at(-1).t + DT : 100;
        rows.push(...cycleRows({ c, n, t0, rpm, load }));
    };
    seg(1.0, 20, 3100, 15); seg(0.95, 4, 2400, 10); seg(1.0, 310, 3100, 15); seg(0.95, 4, 2400, 10);
    const raw = toLog(rows);
    const data = raw.filter((p, i) => i === 0 || p.rpm === 2400);
    const [cr, cc] = cellOf(2400, 10);
    check('the filtered prefix reads as milliseconds, the raw log as seconds (else this tests nothing)',
        timeScaleSeconds(data.slice(0, 2)) === 0.001 && timeScaleSeconds(raw.slice(0, 21)) === 1
        && timeScaleSeconds(data) === 1);
    const ann = calc.annotateRfKorr(MAP, data, EGT, FLAT_AIR, raw);
    const batch = calc.calculateNewVEMap(MAP, ann, { secondsPerUnit: timeScaleSeconds(raw) });
    check('the batch: two visits, refused as few-visits', batch.rejectMap[cr][cc] === 'few-visits',
        String(batch.rejectMap[cr][cc]));
    // appendCalculation over flushes ending at data lengths 2, 3, 4, all — once on the raw prefix's
    // unit (what the hook reads), once on the filtered prefix's (what it used to read).
    const plan = resolveRfKorr({});
    const live = (unitOf) => {
        const walk = calc.rfKorrWalk(MAP, EGT, FLAT_AIR), track = new Map(), grid = calc.createGrid();
        let rawAt = 0, dataAt = 0;
        for (const upto of [2, 3, 4, data.length]) {
            for (; rawAt < raw.length && raw[rawAt].time <= data[upto - 1].time; rawAt++) {
                track.set(raw[rawAt].time, walk.step(raw[rawAt]));
            }
            const spu = unitOf(rawAt, upto);
            for (; dataAt < upto; dataAt++) {
                const st = track.get(data[dataAt].time);
                const p0 = calc.annotateRfKorrPoint(MAP, data[dataAt], EGT, FLAT_AIR, st ? st.open : null);
                calc.accumulatePoint(grid, st ? { ...p0, kRamp: st.kRamp } : p0, plan, undefined, spu);
            }
        }
        return { grid, res: calc.finalizeGrid(MAP, grid, {}) };
    };
    const now = live((rawAt) => timeScaleSeconds(raw.slice(0, rawAt)));
    const before = live((_, upto) => timeScaleSeconds(data.slice(0, upto)));
    check('live on the raw unit: the same two visits and the same verdict as the batch',
        now.grid[cr][cc].visits === 2 && now.res.rejectMap[cr][cc] === 'few-visits'
        && JSON.stringify(now.res.rejectMap) === JSON.stringify(batch.rejectMap), `${now.grid[cr][cc].visits} visits`);
    check('...where the filtered prefix\'s unit counted three and wrote the cell', before.grid[cr][cc].visits === 3
        && before.res.rejectMap[cr][cc] === null, `${before.grid[cr][cc].visits} visits, ${before.res.rejectMap[cr][cc]}`);
}

console.log(fails === 0 ? '\nAll k-ramp checks passed.\n' : `\n${fails} check(s) FAILED.\n`);
process.exit(fails === 0 ? 0 : 1);
