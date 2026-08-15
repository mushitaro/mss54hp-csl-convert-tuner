/**
 * Checks the inertia estimator against a simulated engine whose J is known in advance.
 *
 * Run with:  node --experimental-strip-types scripts/verify-inertia.mjs
 *
 * There is no test framework in this repo and this does not add one — Node 22 strips TypeScript
 * types natively, so the modules under test are imported directly and asserted against here, in the
 * same `scripts/*.mjs` shape the build steps already use.
 *
 * What is actually being checked, in order of what would hurt most if it were wrong:
 *
 *  1. The estimator recovers the bench's J. Everything downstream is a multiple of this number.
 *  2. The `d_n40` truncation correction is applied to the negative branch and NOT to the positive
 *     one. Correcting both would bias every deceleration measurement, and the shape of the DME's
 *     expression is the only evidence for which branch needs it.
 *  3. The gates actually reject. A filter that admits everything produces a confident wrong answer,
 *     which is the failure mode this whole design is arranged against.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { estimateInertia } from '../src/lib/inertia/estimator.ts';
import { proposeCorrections, quantise, effectiveRatio } from '../src/lib/inertia/corrections.ts';
import { INERTIA_ITEMS } from '../src/lib/ecu-items/catalog/inertia.ts';
import { findEcuItem } from '../src/lib/ecu-items/catalog/index.ts';
import { validateCatalog } from '../src/lib/ecu-items/codec.ts';
import { BinaryParser } from '../src/lib/binary-engine/parser.ts';
import { checkLineage } from '../src/lib/lineage/preflight.ts';
import { readStoredChecksums, correctDataChecksum } from '../src/lib/checksum/dmeDataChecksum.ts';
import {
    correctDN40, isDN40Saturated, dn40UncertaintyHalfWidth, DN40_LSB_RPM_S,
} from '../src/lib/inertia/gradient.ts';
import { runBench, encodeDN40, STANDARD_BENCH_SWEEPS } from '../src/lib/inertia/bench.ts';

let failures = 0;
const check = (name, fn) => {
    try {
        fn();
        console.log(`  ok    ${name}`);
    } catch (e) {
        failures++;
        console.log(`  FAIL  ${name}\n        ${e.message.split('\n').join('\n        ')}`);
    }
};

console.log('\nd_n40 truncation correction');

check('positive readings are already unbiased and must not be shifted', () => {
    for (const trueRate of [37, 120, 480, 1503, 2999]) {
        const reported = encodeDN40(trueRate);
        assert.equal(correctDN40(reported), reported, `reported ${reported} was shifted`);
        // The interval a positive reading implies is [reported-20, reported+20).
        assert.ok(Math.abs(correctDN40(reported) - trueRate) <= DN40_LSB_RPM_S / 2,
            `true ${trueRate} -> reported ${reported}, off by more than half an LSB`);
    }
});

check('negative readings sit one LSB high and are corrected down', () => {
    for (const trueRate of [-139, -480, -1503, -2999]) {
        const reported = encodeDN40(trueRate);
        assert.ok(reported < 0, `expected ${trueRate} to encode negative, got ${reported}`);
        assert.equal(correctDN40(reported), reported - DN40_LSB_RPM_S);
        assert.ok(Math.abs(correctDN40(reported) - trueRate) <= DN40_LSB_RPM_S / 2,
            `true ${trueRate} -> reported ${reported} -> corrected ${correctDN40(reported)}, `
            + `off by more than half an LSB`);
    }
});

check('zero is a double-width dead zone spanning -60..+20, not "no acceleration"', () => {
    // Both truncation branches collapse into k = 0, so this bucket is twice as wide as the rest
    // and is centred at -20 rather than at 0. Missing this is the subtle way to bias every
    // near-idle gradient.
    for (const trueRate of [-59, -37, -20, 0, 19]) {
        assert.equal(Math.abs(encodeDN40(trueRate)), 0,
            `true ${trueRate} should fall in the zero bucket, encoded ${encodeDN40(trueRate)}`);
    }
    assert.equal(encodeDN40(-61) < 0, true, '-61 must fall outside the zero bucket');
    assert.equal(encodeDN40(21) > 0, true, '+21 must fall outside the zero bucket');
    assert.equal(correctDN40(0), -20);
    assert.equal(correctDN40(-0), -20, 'a -0 from the encoder must be treated as the zero bucket');
    assert.equal(dn40UncertaintyHalfWidth(0), DN40_LSB_RPM_S);
    assert.equal(dn40UncertaintyHalfWidth(-120), DN40_LSB_RPM_S / 2);
});

check('the documented case: true -139 rpm/s is reported as -80', () => {
    assert.equal(encodeDN40(-139), -80);
    assert.equal(correctDN40(-80), -120);
});

check('uncorrected negative readings would be biased toward zero', () => {
    // The point of the correction, stated as a test: without it every deceleration reads low.
    const trueRates = [-139, -480, -1503];
    const rawError = trueRates.reduce((s, r) => s + (encodeDN40(r) - r), 0) / trueRates.length;
    const fixedError = trueRates.reduce((s, r) => s + (correctDN40(encodeDN40(r)) - r), 0) / trueRates.length;
    assert.ok(rawError > 15, `expected a large toward-zero bias, saw ${rawError.toFixed(1)} rpm/s`);
    assert.ok(Math.abs(fixedError) < 8, `correction left ${fixedError.toFixed(1)} rpm/s of bias`);
});

check('saturation is detected at both rails', () => {
    assert.ok(isDN40Saturated(5080));
    assert.ok(isDN40Saturated(-5120));
    assert.ok(!isDN40Saturated(5040));
    assert.ok(!isDN40Saturated(-5040));
});

console.log('\nestimator against a known inertia');

check('recovers the bench J to within 3 %', () => {
    const j = 0.2100;
    const samples = runBench(STANDARD_BENCH_SWEEPS, { j });
    const est = estimateInertia(samples);
    assert.ok(est.j !== null, `no J produced; notes: ${est.notes.join(' | ')}`);
    const error = Math.abs(est.j - j) / j;
    assert.ok(error < 0.03,
        `J = ${est.j.toFixed(4)} against a true ${j} (${(100 * error).toFixed(1)} % error)\n`
        + `notes: ${est.notes.join(' | ')}`);
});

check('recovers a stock-weight J too, so the fit is not tuned to one value', () => {
    const j = 0.2687;
    const samples = runBench(STANDARD_BENCH_SWEEPS, { j, seed: 777 });
    const est = estimateInertia(samples);
    assert.ok(est.j !== null, `no J produced; notes: ${est.notes.join(' | ')}`);
    assert.ok(Math.abs(est.j - j) / j < 0.03, `J = ${est.j.toFixed(4)} against a true ${j}`);
});

check('reports the measurement as acceptable', () => {
    const est = estimateInertia(runBench(STANDARD_BENCH_SWEEPS, { j: 0.21 }));
    assert.ok(est.acceptable, `not acceptable; notes: ${est.notes.join(' | ')}`);
});

check('J is consistent across rpm bins', () => {
    const est = estimateInertia(runBench(STANDARD_BENCH_SWEEPS, { j: 0.21 }));
    assert.ok(est.jSpread !== null && est.j !== null);
    assert.ok(est.jSpread / est.j < 0.10,
        `spread ${(100 * est.jSpread / est.j).toFixed(1)} % — inertia must not vary with engine speed`);
});

check('recovers the loss torque, which is the only rail on a torque-model scale error', () => {
    const est = estimateInertia(runBench(STANDARD_BENCH_SWEEPS, { j: 0.21 }));
    const near4000 = est.mLossCurve.reduce((best, p) =>
        Math.abs(p.rpm - 4000) < Math.abs(best.rpm - 4000) ? p : best);
    // benchLossTorque(4000) = 12 + 18 + 5.6 = 35.6 Nm
    assert.ok(Math.abs(near4000.mLoss - 35.6) < 6,
        `loss came out at ${near4000.mLoss.toFixed(1)} Nm near ${near4000.rpm} rpm, expected ~35.6`);
});

check('the free-deceleration cross-check runs and agrees', () => {
    const est = estimateInertia(runBench(STANDARD_BENCH_SWEEPS, { j: 0.21 }));
    assert.ok(est.freeDecel.found, 'no coast-down found in a run that contains one');
    assert.equal(est.freeDecel.agrees, true,
        `cross-check disagreed by ${(100 * (est.freeDecel.relativeError ?? 0)).toFixed(0)} %`);
});

check('measures the sample interval rather than assuming it', () => {
    const est = estimateInertia(runBench(STANDARD_BENCH_SWEEPS, { j: 0.21, sampleIntervalS: 0.11 }));
    assert.ok(est.medianSampleIntervalS !== null);
    assert.ok(Math.abs(est.medianSampleIntervalS - 0.11) < 0.02,
        `median interval ${est.medianSampleIntervalS?.toFixed(3)} s`);
});

console.log('\ngates reject what they claim to reject');

const withField = (patch) => runBench(STANDARD_BENCH_SWEEPS, { j: 0.21 }).map(s => ({ ...s, ...patch }));

check('in-gear samples are rejected', () => {
    const est = estimateInertia(withField({ gang: 2 }));
    assert.equal(est.samplesUsed, 0);
    assert.equal(est.acceptable, false);
    assert.ok(est.rejects.some(r => r.reason === 'not-neutral'));
});

check('a null gear is rejected rather than read as neutral', () => {
    const est = estimateInertia(withField({ gang: null }));
    assert.equal(est.samplesUsed, 0);
    assert.ok(est.rejects.some(r => r.reason === 'not-neutral'));
});

check('rolling samples are rejected', () => {
    const est = estimateInertia(withField({ vAntrieb: 12 }));
    assert.equal(est.samplesUsed, 0);
    assert.ok(est.rejects.some(r => r.reason === 'moving'));
});

check('samples where the slew limiter clipped are rejected', () => {
    // bit6 — the tip-in limiter actually clipped this cycle.
    const est = estimateInertia(withField({ mdDynSt: 0b0100_0000 }));
    assert.equal(est.samplesUsed, 0);
    assert.ok(est.rejects.some(r => r.reason === 'filter-active'));
});

check('saturated gradients are rejected', () => {
    const est = estimateInertia(withField({ dN40: 5080 }));
    assert.equal(est.samplesUsed, 0);
    assert.ok(est.rejects.some(r => r.reason === 'saturated-gradient'));
});

check('a d_n40 that disagrees with the n40 difference is rejected', () => {
    const samples = runBench(STANDARD_BENCH_SWEEPS, { j: 0.21 });
    // Corrupt the DME's gradient channel alone. n40 still tells the truth, so the two disagree.
    const corrupted = samples.map(s => ({ ...s, dN40: s.dN40 === null ? null : s.dN40 + 2000 }));
    const est = estimateInertia(corrupted);
    assert.ok(est.rejects.some(r => r.reason === 'gradient-disagree'),
        'a corrupted gradient channel went undetected');
    assert.equal(est.acceptable, false);
});

check('an empty run is not acceptable and says why', () => {
    const est = estimateInertia([]);
    assert.equal(est.j, null);
    assert.equal(est.acceptable, false);
    assert.ok(est.notes.length > 0);
});

console.log('\ncatalog and corrections, against the shipped reference binary');

const binPath = new URL('../public/mock/csl-0401-community-patch-v1.partial.bin', import.meta.url);
const image = readFileSync(binPath);
const buffer = image.buffer.slice(image.byteOffset, image.byteOffset + image.byteLength);

check('the catalog is structurally sound', () => {
    const problems = validateCatalog(INERTIA_ITEMS);
    assert.equal(problems.length, 0, problems.join('\n'));
});

check('the partial BIN is the size every address here assumes', () => {
    assert.equal(buffer.byteLength, 0x10000,
        `expected 65536 bytes, got ${buffer.byteLength} — every address in the catalog is a raw `
        + 'offset into this, so a different length means they all point somewhere else');
});

check('decoded values match what the disassembly says they are', () => {
    const parser = new BinaryParser(buffer);
    const read = symbol => parser.readItem(findEcuItem(symbol));

    // Each of these was read out of the binary independently by the q.py graph query. Any drift
    // here means an address or a scaling in the catalog is wrong, and the whole correction plan is
    // computed from these numbers.
    const near = (actual, expected, tol, what) => assert.ok(Math.abs(actual - expected) <= tol,
        `${what}: got ${actual}, expected ~${expected}`);

    near(read('K_SMG_J_MOTOR').value, 0.25, 0.004, 'K_SMG_J_MOTOR');
    near(read('K_MD_J_MOTOR').value, 0.268657, 0.004, 'K_MD_J_MOTOR');
    near(read('K_SMG_R_RAD_DYN').value, 307, 0.5, 'K_SMG_R_RAD_DYN');
    near(read('K_SMG_I_HA').value, 3.6333, 0.01, 'K_SMG_I_HA');
    near(read('K_LFR_TAU_IA1').value, 5.12, 0.01, 'K_LFR_TAU_IA1');
    near(read('K_LFR_TAU_IA2_KKS').value, 0.0201, 0.001, 'K_LFR_TAU_IA2_KKS');
    near(read('K_N_TAU_DN').value, 0.0985, 0.001, 'K_N_TAU_DN');
    near(read('K_WE_DN40_HARD').value, -5000, 1, 'K_WE_DN40_HARD');
    near(read('K_SMG_N_ZIEL_ABWUERG').value, 1200, 1, 'K_SMG_N_ZIEL_ABWUERG');

    const gears = read('K_SMG_I_GANG').values;
    assert.deepEqual(gears.map(g => Number(g.toFixed(3))),
        [4.233, 2.533, 1.667, 1.233, 1.000, 0.833], 'gear ratios');

    const jfz = read('KL_MD_JFZ_GANG').values;
    assert.equal(jfz[0], 0, 'neutral must carry zero vehicle inertia');
    [0.701, 1.601, 3.399, 5.0, 8.0, 12.0].forEach((expected, i) =>
        near(jfz[i + 1], expected, 0.01, `KL_MD_JFZ_GANG gear ${i + 1}`));

    const saN40 = read('KL_SA_N40_GANG').values;
    near(saN40[0], 320, 1, 'KL_SA_N40_GANG index 0');
    const hys = read('KL_SA_N40_HYS_GANG').values;
    near(hys[0], 120, 1, 'KL_SA_N40_HYS_GANG index 0');

    // All sixteen zero is the finding, not an accident — it is why the F3 pair exists.
    assert.ok(read('KL_LFR_TZ_NEG').values.every(v => v === 0),
        'KL_LFR_TZ_NEG should be entirely zero in stock 0401');
    assert.equal(read('KL_MD_RES_LRW').values[0], 0, 'KL_MD_RES_LRW y[0] gate should be shut');

    const ls = read('KF_MD_LS_KOMF');
    near(ls.values[0][2], 1.7, 0.05, 'KF_MD_LS_KOMF at 1500 rpm / 100 Nm');
    near(ls.y[0], 1500, 1, 'KF_MD_LS_KOMF rpm axis starts at 1500');

    // XDF-undefined, recovered from the disassembly. First gear held down hardest is the shape
    // that independently confirms "larger means more direct".
    const lsGear = read('KF_MD_LS_GANG_FAKTOR').values;
    near(lsGear[1], 0.75, 0.01, 'tip-in gear factor, 1st');
    near(lsGear[2], 0.80, 0.01, 'tip-in gear factor, 2nd');
    const dpGear = read('KF_MD_DASHPOT_GANG_FAKTOR').values;
    near(dpGear[1], 0.60, 0.01, 'dashpot gear factor, 1st');
});

check('quantisation reports what can actually be written', () => {
    const def = findEcuItem('K_SMG_J_MOTOR');
    // 8-bit, X/128 — step 0.0078125, so 0.205 is not a value that exists.
    const q = quantise(def, 0.205);
    assert.ok(Math.abs(q.value - 0.203125) < 1e-9, `got ${q.value}`);
    assert.equal(q.exact, false);
    assert.ok(Math.abs(q.step - 0.0078125) < 1e-9);
    // 0.25 is exact.
    assert.equal(quantise(def, 0.25).exact, true);
});

check('reciprocal scalings report a step that varies across the range', () => {
    const def = findEcuItem('K_LFR_TAU_IA1');
    // 5.12/x: raw 1 -> 5.12 s, raw 2 -> 2.56 s. The step near the slow end is 2.56 s.
    const slow = quantise(def, 5.12);
    const fast = quantise(def, 0.1);
    assert.ok(slow.step > 2, `step near the slow rail should be huge, got ${slow.step}`);
    assert.ok(fast.step < 0.01, `step near the fast rail should be tiny, got ${fast.step}`);
    // 1.707 is what the plan asks for; confirm it is a real writable value (raw 3).
    assert.ok(Math.abs(quantise(def, 1.707).value - 5.12 / 3) < 1e-9);
});

check('40 rpm quantisation makes the obvious recommendation unwritable', () => {
    const def = findEcuItem('KL_SA_N40_GANG');
    // "raise 320 by 70 rpm" -> 390, which does not exist on a X*40 axis.
    const q = quantise(def.values, 390);
    assert.equal(q.exact, false);
    assert.equal(q.value, 400);
    assert.equal(q.step, 40);
});

check('effective ratio collapses toward 1 as the gear gets taller', () => {
    // The headline correction of the whole investigation: a 20 % lighter flywheel is a 5 % change
    // in first gear and well under 1 % in sixth, because the car is in the loop.
    const jOld = 0.2687;
    const jNew = 0.2687 * 0.82;
    const first = effectiveRatio(jNew, jOld, 0.701);
    const sixth = effectiveRatio(jNew, jOld, 12.0);
    assert.ok(Math.abs(first - 0.950) < 0.005, `first gear r_eff = ${first.toFixed(4)}, expected ~0.950`);
    assert.ok(Math.abs(sixth - 0.996) < 0.002, `sixth gear r_eff = ${sixth.toFixed(4)}, expected ~0.996`);
    assert.ok(first > 0.82 + 0.10,
        'r_eff in first must be far from the raw inertia ratio — that gap is the finding');
});

check('a plan is produced, and every proposal is writable', () => {
    const est = estimateInertia(runBench(STANDARD_BENCH_SWEEPS, { j: 0.21 }));
    const plan = proposeCorrections(est, buffer);
    assert.ok(plan !== null, 'no plan from an acceptable estimate');
    assert.ok(plan.proposals.length > 0, 'plan proposed nothing');
    for (const p of plan.proposals) {
        assert.ok(Number.isFinite(p.proposed), `${p.symbol}: proposed ${p.proposed}`);
        assert.ok(p.reason.length > 20, `${p.symbol}: reason is too thin to act on`);
        assert.ok(p.risk.length > 10, `${p.symbol}: no stated risk`);
        assert.ok(p.address >= 0 && p.address < 0x10000, `${p.symbol}: address out of range`);
        const expectedBank = p.address < 0x8000 ? 'slave' : 'master';
        assert.equal(p.bank, expectedBank, `${p.symbol}: bank disagrees with address`);
    }
});

check('an unacceptable estimate proposes nothing at all', () => {
    const est = estimateInertia([]);
    assert.equal(proposeCorrections(est, buffer), null,
        'a failed measurement must not produce a change list');
});

check('F1 reverts K_SMG_J_MOTOR when the image has been lowered', () => {
    // Simulate the user's car: 0.20 written over the factory 0.25.
    const patched = buffer.slice(0);
    new DataView(patched).setUint8(0x280A, Math.round(0.20 * 128));
    const est = estimateInertia(runBench(STANDARD_BENCH_SWEEPS, { j: 0.21 }));
    const plan = proposeCorrections(est, patched);
    const f1 = plan.proposals.filter(p => p.group === 'F1');
    assert.equal(f1.length, 1, 'F1 should hold exactly one change — it is the diagnostic');
    assert.equal(f1[0].symbol, 'K_SMG_J_MOTOR');
    assert.ok(Math.abs(f1[0].proposed - 0.25) < 1e-9, `F1 proposed ${f1[0].proposed}`);
    assert.ok(f1[0].current < 0.21, 'F1 should report the lowered current value');
});

check('F1 is absent when the image already holds the factory value', () => {
    const est = estimateInertia(runBench(STANDARD_BENCH_SWEEPS, { j: 0.21 }));
    const plan = proposeCorrections(est, buffer);
    assert.equal(plan.proposals.filter(p => p.group === 'F1').length, 0,
        'nothing to revert when the value is already stock');
});

check('the xref-only pair is alone in its own flash', () => {
    const est = estimateInertia(runBench(STANDARD_BENCH_SWEEPS, { j: 0.21 }));
    const plan = proposeCorrections(est, buffer);
    const f3 = plan.proposals.filter(p => p.group === 'F3');
    assert.ok(f3.length > 0, 'the down-authority pair should be proposed on stock 0401');
    const symbols = new Set(f3.map(p => p.symbol));
    assert.deepEqual([...symbols].sort(), ['KL_LFR_TZ_NEG', 'KL_MD_RES_LRW']);
    assert.ok(f3.every(p => p.evidence === 'xref-only'),
        'F3 exists precisely because its evidence is xref-only');
    // The gate and the ramp must never be separable.
    assert.ok(symbols.has('KL_MD_RES_LRW'), 'the gate is missing — the ramp alone does nothing');
});

check('gear factors are held back and say so rather than being silently absent', () => {
    const est = estimateInertia(runBench(STANDARD_BENCH_SWEEPS, { j: 0.21 }));
    const plan = proposeCorrections(est, buffer);
    assert.equal(plan.proposals.filter(p => p.group === 'F4').length, 0);
    assert.ok(plan.blocked.some(b => b.symbol.includes('GANG_FAKTOR')),
        'a held-back item must appear in `blocked`, not just vanish');
});

check('class B uses the per-gear ratio, not the raw one', () => {
    const est = estimateInertia(runBench(STANDARD_BENCH_SWEEPS, { j: 0.21 }));
    const plan = proposeCorrections(est, buffer, { includeGearFactors: true });
    const f4 = plan.proposals.filter(p => p.group === 'F4');
    assert.ok(f4.length > 0, 'no gear-factor proposals when explicitly enabled');
    for (const p of f4) {
        const shrink = p.target / p.current;
        assert.ok(shrink > plan.r + 0.05,
            `${p.symbol} ${p.at}: shrank by ${shrink.toFixed(4)}, which is at or below the raw ratio `
            + `${plan.r.toFixed(4)} — the whole point is that in gear the correction is far milder`);
        assert.ok(shrink <= 1.0, `${p.symbol} ${p.at}: correction should not increase the allowance`);
    }
});

check('the plan reports r_eff for every gear, sourced from the image', () => {
    const est = estimateInertia(runBench(STANDARD_BENCH_SWEEPS, { j: 0.21 }));
    const plan = proposeCorrections(est, buffer);
    assert.equal(plan.rEff.length, 8);
    assert.equal(plan.rEff[0].jFz, 0, 'index 0 is neutral');
    // Monotonic: taller gear, more vehicle inertia, ratio closer to 1.
    for (let g = 2; g <= 6; g++) {
        assert.ok(plan.rEff[g].rEff > plan.rEff[g - 1].rEff,
            `r_eff should rise with gear: ${plan.rEff[g - 1].rEff} -> ${plan.rEff[g].rEff}`);
    }
});

console.log('\nlineage preflight — the guard on the one real VE/inertia conflict');

const asyncCheck = async (name, fn) => {
    try {
        await fn();
        console.log(`  ok    ${name}`);
    } catch (e) {
        failures++;
        console.log(`  FAIL  ${name}\n        ${e.message.split('\n').join('\n        ')}`);
    }
};

await asyncCheck('passes when the ECU holds the BASE this tune was built on', async () => {
    const stored = readStoredChecksums(new Uint8Array(buffer));
    const result = await checkLineage(buffer, async () => stored);
    assert.equal(result.verdict, 'match');
    assert.equal(result.blocking, false);
});

await asyncCheck('blocks when the ECU holds something else', async () => {
    const stored = readStoredChecksums(new Uint8Array(buffer));
    const result = await checkLineage(buffer, async () => ({ ...stored, master: stored.master ^ 0x1234 }));
    assert.equal(result.verdict, 'diverged');
    assert.equal(result.blocking, true);
    assert.ok(/65536/.test(result.summary),
        'the message must say the whole image is rewritten — that is the fact people do not know');
});

await asyncCheck('a one-bank difference is enough to block', async () => {
    const stored = readStoredChecksums(new Uint8Array(buffer));
    const result = await checkLineage(buffer, async () => ({ ...stored, slave: stored.slave ^ 1 }));
    assert.equal(result.verdict, 'diverged');
});

await asyncCheck('a failed read blocks rather than passing', async () => {
    const result = await checkLineage(buffer, async () => { throw new Error('link down'); });
    assert.equal(result.verdict, 'unknown');
    assert.equal(result.blocking, true, '"could not tell" must never be treated as "fine"');
});

await asyncCheck('a missing BASE blocks', async () => {
    const stored = readStoredChecksums(new Uint8Array(buffer));
    const result = await checkLineage(null, async () => stored);
    assert.equal(result.verdict, 'unknown');
    assert.equal(result.blocking, true);
});

await asyncCheck('the scenario this exists for: two tunes, disjoint addresses, still conflicting', async () => {
    // Branch two tunes off the same BASE. One edits an Alpha-N cell; the other edits
    // K_SMG_J_MOTOR. No overlap whatsoever.
    const veTune = buffer.slice(0);
    new DataView(veTune).setUint16(0xD356, 1234);          // VE table region
    correctDataChecksum(new Uint8Array(veTune));

    const inertiaTune = buffer.slice(0);
    new DataView(inertiaTune).setUint8(0x280A, 26);         // K_SMG_J_MOTOR
    correctDataChecksum(new Uint8Array(inertiaTune));

    // The VE tune is flashed. The car now holds veTune.
    const inCar = readStoredChecksums(new Uint8Array(veTune));

    // The inertia tune, built on the ORIGINAL base, is offered next. Its own diff is one byte and
    // touches nothing the VE tune touched — and flashing it would still revert the VE tune whole,
    // because the write is all 65536 bytes.
    const result = await checkLineage(buffer, async () => inCar);
    assert.equal(result.verdict, 'diverged',
        'this is the exact case the guard exists for and it must not pass');

    // Rebuilt on a fresh read of the car, it passes.
    const rebuilt = await checkLineage(veTune, async () => inCar);
    assert.equal(rebuilt.verdict, 'match', 're-basing on what the car holds is the way through');
});

console.log(failures === 0
    ? '\nAll inertia checks passed.\n'
    : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
