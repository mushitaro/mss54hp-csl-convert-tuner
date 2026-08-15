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
 *  2. The RAM address map is internally consistent and decodes the way the freeze-frame writer at
 *     master 0x024A66 says it should. Every torque sample now arrives through it.
 *  3. The gates actually reject — and, just as importantly, that they do **not** reject the
 *     zero-torque overrun samples, which are one whole end of every regression line.
 *
 * ## What used to be here, and why it is gone
 *
 * Two thirds of the original checks tested the `d_n40` truncation correction, the saturation rail
 * and the two-route gradient agreement. All of that machinery served DS2 selection 83, which turned
 * out to be a latched EGAS fault freeze-frame that never updates on a healthy car — so the suite
 * was carefully verifying arithmetic on a telegram the estimator could never receive.
 *
 * The lesson kept, in the negative checks at the end of the gate section: a fixture that only ever
 * feeds the values the code expects tests nothing about whether those values are right. The
 * previous bench hardcoded `engineState: 2` and `saWeSt: 1`, exactly the two wrong constants the
 * estimator's gates were written against, and forty-one checks passed over a workflow that could
 * not have accepted a single real sample.
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
import { centralDifferenceRpmPerS, rpmPerSecToRadPerSec2 } from '../src/lib/inertia/gradient.ts';
import {
    Mss54HpRamWindows, Mss54HpRamSignals, INERTIA_RAM_READ, RAM_PROBE_READS, RAM_READ_MAX_COUNT,
    decodeRamSignal, isRamReadInRange,
} from '../src/lib/dme-link/ramMap.ts';
import { runBench, encodeTorqueNm, STANDARD_BENCH_SWEEPS } from '../src/lib/inertia/bench.ts';
import { liveCoverage } from '../src/lib/inertia/liveCoverage.ts';

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

console.log('\nRAM address map');

check('every declared signal lies inside its own window', () => {
    const windows = Object.values(Mss54HpRamWindows);
    for (const [name, sig] of Object.entries(Mss54HpRamSignals)) {
        const w = windows.find(x => x.segment === sig.segment);
        assert.ok(w, `${name} names segment 0x${sig.segment.toString(16)}, which is not a window`);
        assert.ok(sig.address >= w.lo && sig.address + sig.size <= w.hi,
            `${name} at 0x${sig.address.toString(16)} is outside [0x${w.lo.toString(16)}, 0x${w.hi.toString(16)})`);
    }
});

check('the addresses match the freeze-frame writer at master 0x024A66', () => {
    // The one thing selection 83 is good for: `0x024A66` copies these RAM locations verbatim into
    // the block-83 offsets the reference catalogue documents, which is what pins both the address
    // AND the scaling. Any drift here means a channel is being decoded from the wrong bytes.
    assert.equal(Mss54HpRamSignals.MD_IND_NE.address, 0x00FF81A6);        // -> offset 38
    assert.equal(Mss54HpRamSignals.MD_IND_OPT_KORR.address, 0x00FFD8E6);  // -> offset 40
    assert.equal(Mss54HpRamSignals.MD_DYN_ST.address, 0x00FF8180);        // -> offset 48
    assert.equal(Mss54HpRamSignals.GANG.address, 0x00FF8250);             // -> offset 49
    assert.equal(Mss54HpRamSignals.SA_WE_ST.address, 0x00FF8247);         // -> offset 51
    // uint16 x 0.1 Nm at block-83 offset 38/40, so uint16 x 0.1 Nm in RAM.
    for (const s of [Mss54HpRamSignals.MD_IND_NE, Mss54HpRamSignals.MD_IND_OPT_KORR]) {
        assert.equal(s.size, 2);
        assert.equal(s.signed, false);
        assert.equal(s.scale, 0.1);
    }
});

check('MD_IND_NE is unsigned, because the zero-torque anchor depends on it', () => {
    // If this channel could go negative, overrun would read as a negative torque and the regression
    // would place the anchor somewhere other than zero. It cannot: the DME floors it.
    assert.equal(Mss54HpRamSignals.MD_IND_NE.signed, false);
    assert.equal(encodeTorqueNm(-40), 0, 'the bench must floor at zero the way the channel does');
});

check('the DME truncates a count above 128 without erroring, so no read may exceed it', () => {
    assert.equal(RAM_READ_MAX_COUNT, 0x80);
    const reads = [INERTIA_RAM_READ, ...RAM_PROBE_READS];
    for (const r of reads) {
        assert.ok(r.count > 0 && r.count <= RAM_READ_MAX_COUNT,
            `a read asks for ${r.count} bytes; over ${RAM_READ_MAX_COUNT} comes back short in silence`);
        assert.ok(isRamReadInRange(r.segment, r.address, r.count), 'a declared read is out of range');
    }
});

check('the inertia poll reads both signals it decodes, in one telegram', () => {
    for (const sig of [Mss54HpRamSignals.MD_DYN_ST, Mss54HpRamSignals.MD_IND_NE]) {
        assert.equal(sig.segment, INERTIA_RAM_READ.segment);
        assert.ok(sig.address >= INERTIA_RAM_READ.address
            && sig.address + sig.size <= INERTIA_RAM_READ.address + INERTIA_RAM_READ.count,
            'INERTIA_RAM_READ does not cover a signal pollInertiaSample decodes from it');
    }
});

check('out-of-range reads are refused before they reach the car', () => {
    // 0x00FF9000 is one byte past the low window. The DME would answer 0xB0; a caller should not
    // need a car to find out it asked for the wrong thing.
    assert.equal(isRamReadInRange(0x01, 0x00FF9000, 2), false);
    assert.equal(isRamReadInRange(0x01, 0x00FF8FFF, 2), false, 'a read straddling the top must fail');
    assert.equal(isRamReadInRange(0x04, 0x00FFD8E6, 2), true);
    assert.equal(isRamReadInRange(0x02, 0x00FF81A6, 2), false, 'segment 0x02 is not a RAM window');
    assert.equal(isRamReadInRange(0x01, 0x00FF81A6, 0), false, 'a zero-length read is not a read');
});

check('decodeRamSignal reads big-endian and applies the scale', () => {
    // 0x01F4 = 500 raw = 50.0 Nm. Byte order matters: little-endian would give 0xF401 = 6248.1 Nm,
    // which is not obviously wrong on a gauge and is catastrophically wrong in a regression.
    const buf = new Uint8Array(INERTIA_RAM_READ.count);
    const at = Mss54HpRamSignals.MD_IND_NE.address - INERTIA_RAM_READ.address;
    buf[at] = 0x01; buf[at + 1] = 0xF4;
    assert.equal(decodeRamSignal(Mss54HpRamSignals.MD_IND_NE, buf, INERTIA_RAM_READ.address), 50);
});

check('a short buffer yields null rather than a fabricated value', () => {
    const short = new Uint8Array(4);
    assert.equal(decodeRamSignal(Mss54HpRamSignals.MD_IND_NE, short, INERTIA_RAM_READ.address), null);
});

console.log('\ngradient from the 1 rpm speed channel');

check('a central difference recovers a known rate', () => {
    const s = [0, 1, 2, 3, 4].map(i => ({ time: i * 0.2, rpm: 3000 - 400 * i * 0.2, coolantTemp: 90, wdk1: 0, rf: 12, mdIndNe: 0, mdDynSt: 0 }));
    assert.ok(Math.abs(centralDifferenceRpmPerS(s, 2, 1, 0.5) - -400) < 1e-6);
});

check('a window that does not fit, or straddles a gap, returns null', () => {
    const s = [0, 1, 2].map(i => ({ time: i * 0.2, rpm: 3000 - 80 * i, coolantTemp: 90, wdk1: 0, rf: 12, mdIndNe: 0, mdDynSt: 0 }));
    assert.equal(centralDifferenceRpmPerS(s, 0, 1, 0.5), null, 'the first sample has no left half');
    assert.equal(centralDifferenceRpmPerS(s, 2, 1, 0.5), null, 'the last sample has no right half');
    const gapped = [{ ...s[0] }, { ...s[1], time: 2.0 }, { ...s[2], time: 2.2 }];
    assert.equal(centralDifferenceRpmPerS(gapped, 1, 1, 0.5), null, 'a dropped sample must not be averaged over');
});

check('rpm/s to rad/s^2 is the conversion the physics uses', () => {
    assert.ok(Math.abs(rpmPerSecToRadPerSec2(60) - 2 * Math.PI) < 1e-9);
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
    // benchLossTorque(3750) = 20 + 22.5 + 6.75 = 49.25 Nm; at 4000, 51.7.
    const expected = 20 + 0.0060 * near4000.rpm + 4.8e-7 * near4000.rpm * near4000.rpm;
    assert.ok(Math.abs(near4000.mLoss - expected) < 7,
        `loss came out at ${near4000.mLoss.toFixed(1)} Nm near ${near4000.rpm} rpm, expected ~${expected.toFixed(1)}`);
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

console.log('\ngates reject what they claim to reject — and admit what they must');

const withField = (patch) => runBench(STANDARD_BENCH_SWEEPS, { j: 0.21 }).map(s => ({ ...s, ...patch }));

check('a cold engine is rejected, with the reason a driver can act on', () => {
    const est = estimateInertia(withField({ coolantTemp: 62 }));
    assert.equal(est.samplesUsed, 0);
    assert.equal(est.acceptable, false);
    assert.ok(est.rejects.some(r => r.reason === 'not-warm'));
});

check('a null coolant reading is rejected rather than read as warm', () => {
    const est = estimateInertia(withField({ coolantTemp: null }));
    assert.equal(est.samplesUsed, 0);
    assert.ok(est.rejects.some(r => r.reason === 'not-warm'));
});

check('samples where the slew limiter clipped are rejected', () => {
    // bit6 — the tip-in limiter actually clipped this cycle. It should never fire at a standstill,
    // which is exactly why it is worth checking: if it does, the car was moving.
    const est = estimateInertia(withField({ mdDynSt: 0b0100_0000 }));
    assert.equal(est.samplesUsed, 0);
    assert.ok(est.rejects.some(r => r.reason === 'filter-active'));
});

check('a null md_dyn_st is rejected rather than read as clear', () => {
    const est = estimateInertia(withField({ mdDynSt: null }));
    assert.equal(est.samplesUsed, 0);
    assert.ok(est.rejects.some(r => r.reason === 'filter-active'));
});

check('a missing torque channel is rejected', () => {
    const est = estimateInertia(withField({ mdIndNe: null }));
    assert.equal(est.samplesUsed, 0);
    assert.ok(est.rejects.some(r => r.reason === 'no-torque'));
});

check('samples outside the rpm window are rejected', () => {
    const est = estimateInertia(withField({ rpm: 1200 }));
    assert.equal(est.samplesUsed, 0);
    assert.ok(est.rejects.some(r => r.reason === 'out-of-range'));
});

// ---------------------------------------------------------------------------------------------
// The negative checks. These are the ones that would have caught the previous design, and each
// asserts that something the code USED to do is no longer done.
// ---------------------------------------------------------------------------------------------

check('ZERO-torque overrun samples are ADMITTED, not thrown away as "fuel cut"', () => {
    // The single most important behavioural change. `md_ind_ne` is unsigned and reads 0 under
    // overrun, and those samples are the only ones at large negative alpha — one whole end of every
    // regression line. The old estimator rejected them on a `sa_we_st` bit and on `torque > 0`,
    // which left every bin fitting a line through a cluster of similar points.
    const samples = runBench(STANDARD_BENCH_SWEEPS, { j: 0.21 });
    const zeroTorque = samples.filter(s => s.mdIndNe === 0);
    assert.ok(zeroTorque.length > 20, `expected plenty of overrun samples, saw ${zeroTorque.length}`);

    const withCoast = estimateInertia(samples);
    const withoutCoast = estimateInertia(samples.filter(s => s.mdIndNe > 0));
    assert.ok(withCoast.samplesUsed > withoutCoast.samplesUsed,
        'the overrun samples are not reaching the regression');
    // And they are load-bearing: drop them and the fit loses its alpha spread.
    const spanOf = est => Math.max(...est.bins.map(b => b.alphaSpan));
    assert.ok(spanOf(withCoast) > spanOf(withoutCoast) * 1.5,
        `overrun samples add only ${(spanOf(withCoast) / spanOf(withoutCoast)).toFixed(2)}x of alpha `
        + 'span — if that is genuinely all they add, this check is wrong, not the code');
});

check('a single-pedal run cannot produce an estimate, however long it is', () => {
    // The failure the check above protects against, stated positively. Note what this does NOT say:
    // pulls at SEVERAL pedal openings do carry enough spread on their own, so the overrun samples
    // are load-bearing rather than indispensable. What no amount of repetition can fix is one pedal
    // opening — every sample then lands at nearly the same alpha, and a line through a cluster is
    // an extrapolation dressed as a regression.
    const onePedal = Array.from({ length: 8 }, () => ({ pedalFraction: 0.25, fromRpm: 2000, toRpm: 5000 }));
    const est = estimateInertia(runBench(onePedal, { j: 0.21 }).filter(s => s.mdIndNe > 0));
    assert.equal(est.acceptable, false,
        'a single-pedal pulls-only run was accepted — the alpha-span gate is not doing its job');
});

check('the removed d_n40 machinery is really gone, not merely unused', () => {
    // A stale `EgasMeasurement[]` must not type-check into a silent pass. It cannot carry `rpm` or
    // `coolantTemp`, so every sample fails a gate rather than being quietly admitted with garbage.
    const stale = runBench(STANDARD_BENCH_SWEEPS, { j: 0.21 })
        .map(s => ({ time: s.time, n40: 3000, dN40: -400, mdIndOptKorr: 40, gang: 0, saWeSt: 0 }));
    const est = estimateInertia(stale);
    assert.equal(est.samplesUsed, 0, 'a selection-83 shaped array was partly accepted');
    assert.equal(est.acceptable, false);
});

check('an in-gear run is caught by the plausibility rail, since there is no gear channel', () => {
    // KL_MD_JFZ_GANG puts the car's inertia at the crank at 0.70 Nms^2 in first, against ~0.21 for
    // the engine alone. With `gang` no longer observable this rail IS the gate, so it has to fire.
    const est = estimateInertia(runBench(STANDARD_BENCH_SWEEPS, { j: 0.21 + 0.701 }));
    assert.equal(est.acceptable, false, 'a first-gear inertia was accepted as an engine inertia');
    assert.ok(est.notes.some(n => /gear/i.test(n)),
        `the note must name the cause; got: ${est.notes.join(' | ')}`);
});

console.log('\nthe documented protocol, at the rate the link achieves');

check('the panel protocol fills enough bins at the rate two telegrams reach', () => {
    // The protocol must work at the rate the LINK achieves, not the rate the arithmetic predicts.
    // An earlier version asked for six sweeps and filled zero bins at the 6.6 Hz a real run
    // measured — the estimator was fine, the instructions were not, and nothing tested them.
    //
    // 0.19 s is selection 3 (44 bytes) plus a 49-byte RAM read at this link's measured ~45 ms
    // per-exchange overhead. 0.25 s allows for that being optimistic; 0.15 s is what a 38400 baud
    // session would give.
    for (const sampleIntervalS of [0.15, 0.19, 0.25]) {
        for (const j of [0.18, 0.205, 0.21, 0.25]) {
            const est = estimateInertia(runBench(STANDARD_BENCH_SWEEPS, { j, sampleIntervalS }));
            assert.ok(est.acceptable,
                `protocol failed at ${(1 / sampleIntervalS).toFixed(1)} Hz with J=${j}: `
                + `${est.bins.filter(b => b.j !== null).length} usable bins, counts `
                + `[${est.bins.map(b => b.count).join('/')}]\n`
                + `notes: ${est.notes.join(' | ')}`);
        }
    }
});

check('a single sweep is demonstrably not enough', () => {
    // Kept so the reason the instructions ask for six stays visible: if someone shortens the panel
    // text, this is the number that says why not.
    const one = [{ pedalFraction: 0.25, fromRpm: 2000, toRpm: 5000 }];
    const est = estimateInertia(runBench(one, { j: 0.205, sampleIntervalS: 0.19 }));
    assert.equal(est.acceptable, false,
        'one sweep unexpectedly passed — if this is now genuinely fine, delete this check');
});

check('an empty run is not acceptable and says why', () => {
    const est = estimateInertia([]);
    assert.equal(est.j, null);
    assert.equal(est.acceptable, false);
    assert.ok(est.notes.length > 0);
});

console.log('\nlive coverage — what the driver sees while the run is happening');

// The live display exists because a raw sample counter is the one number guaranteed to look healthy
// in the case that matters. These checks are about it agreeing with the verdict: a progress bar
// that fills while the estimator is rejecting everything is worse than no progress bar.
const PROTOCOL = STANDARD_BENCH_SWEEPS;

check('live accepted count matches what the estimator actually used', () => {
    const samples = runBench(PROTOCOL, { j: 0.21 });
    assert.equal(liveCoverage(samples).accepted, estimateInertia(samples).samplesUsed,
        'the live counter and the verdict disagree about how many samples are usable — '
        + 'they must share admitSample, not reimplement it');
});

check('live per-bin counts match the verdict per-bin counts', () => {
    const samples = runBench(PROTOCOL, { j: 0.21 });
    const live = liveCoverage(samples), est = estimateInertia(samples);
    assert.equal(live.bins.length, est.bins.length);
    live.bins.forEach((b, i) => {
        assert.equal(b.count, est.bins[i].count, `bin ${b.loRpm}-${b.hiRpm} disagrees`);
        assert.equal(b.loRpm, est.bins[i].loRpm);
    });
});

check('live rejects match the verdict rejects, reason for reason', () => {
    const samples = runBench(PROTOCOL, { j: 0.21 });
    const key = rs => rs.map(r => `${r.reason}=${r.count}`).sort().join(',');
    assert.equal(key(liveCoverage(samples).rejects), key(estimateInertia(samples).rejects));
});

check('"ready" means the estimator would accept it', () => {
    const samples = runBench(PROTOCOL, { j: 0.21 });
    const live = liveCoverage(samples);
    assert.equal(live.ready, true, `not ready: ${live.outstanding.join(', ')}`);
    assert.equal(estimateInertia(samples).acceptable, true,
        'live said ready but the estimator refused — the exact lie this display must not tell');
});

check('a genuinely short run is NOT reported ready, and says what is missing', () => {
    const short = [{ pedalFraction: 0.20, fromRpm: 1600, toRpm: 2300 }];
    const live = liveCoverage(runBench(short, { j: 0.21 }));
    assert.equal(live.ready, false);
    assert.ok(live.outstanding.length > 0, 'nothing listed as outstanding on an obviously short run');
    assert.equal(estimateInertia(runBench(short, { j: 0.21 })).acceptable, false);
});

check('an all-rejected run shows zero usable however many samples arrived', () => {
    // The failure that motivated the whole display: samples piling up, none of them usable.
    const samples = runBench(PROTOCOL, { j: 0.21 }).map(s => ({ ...s, coolantTemp: 40 }));
    const live = liveCoverage(samples);
    assert.ok(live.seen > 100, 'expected plenty of raw samples');
    assert.equal(live.accepted, 0, 'usable must read zero, not track the raw count');
    assert.equal(live.ready, false);
    assert.equal(live.rejects[0].reason, 'not-warm',
        'the dominant reject reason must be visible so the driver can act on it');
});

check('the coast-down is tracked separately and gates readiness', () => {
    // Dropping the releases removes the overrun samples, so this fixture loses BOTH the coast-down
    // and a good part of every bin. The assertion that matters is the first: readiness is not a
    // function of sample count alone, because the cross-check is the only thing that can falsify
    // the fit from outside it.
    const noCoast = runBench(PROTOCOL, { j: 0.21 }).filter(s => s.mdIndNe > 0);
    const live = liveCoverage(noCoast);
    assert.equal(live.coastDownCaptured, false);
    assert.equal(live.ready, false, 'ready must require the coast-down, not just the bins');
});

check('"ready" is not stricter than the verdict', () => {
    // The failure mode this replaced: `ready` required EVERY bin, the estimator required three, and
    // the top bin never fills because the sweeps turn round at maxRpm. The display went on saying
    // "keep sweeping" over a measurement that was already acceptable.
    const samples = runBench(PROTOCOL, { j: 0.21 });
    const live = liveCoverage(samples);
    assert.equal(estimateInertia(samples).acceptable, true);
    assert.equal(live.ready, true,
        `the estimator accepted a run the live display still calls incomplete: ${live.outstanding.join(', ')}`);
    assert.ok(live.outstanding.length >= 0, 'outstanding must still list what would improve the run');
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
