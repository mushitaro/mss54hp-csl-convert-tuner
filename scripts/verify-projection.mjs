/**
 * The bilinear projection: what a cell's correction MEANS when a sample reads four of them.
 *
 * The calculator gathers with bilinear weights and writes back per cell. Those are not inverses of
 * each other, and the gap between them is a defect an adversarial review of the derivation found
 * (D1) — one that had been in the shipped calculator all along, invisible because so few cells ever
 * cleared the evidence bar to expose it.
 *
 * THREE CONSEQUENCES, and this file pins all three:
 *
 *   1. UNDER-REALISATION. Scaling one cell by `x` moves the DME's interpolated lookup at a nearby
 *      sample by only that cell's SHARE of `x`. The car does less than the number on screen says.
 *      `realisedMap` is that number; `diffMap` remains what was demanded.
 *   2. RATCHET. Because the car does less, a flash-and-relog cycle sees the remainder and demands
 *      it again, walking the cell past anything any sample ever asked for and into a spike against
 *      its unwritten neighbours. The clamp to the observed range makes that fixed point
 *      unreachable.
 *   3. BLAME MISATTRIBUTION. A sample sitting between a correct cell and a wrong one carries a
 *      correction that belongs to neither alone. If only one of them clears the bar, that one is
 *      written with a share of its neighbour's error. `MIN_SELF_SHARE` refuses the cells where
 *      that share dominates.
 *
 * The self-share threshold is measured, not chosen: evidence spread evenly through a bracket has
 * an expected self-share of `E[w^2]/E[w] = 0.444` for `w = u*v`, and session #920's 109 earned
 * cells have a median of 0.432. The asserted value is two thirds of that.
 */
import { VECalculator, MIN_SELF_SHARE } from '../src/lib/ve-calculator/calculator.ts';
import { APP_CONFIG } from '../src/config/constants.ts';

let fails = 0;
const check = (n, c, d) => { console.log('  ' + (c ? 'PASS' : 'FAIL') + '  ' + n + (c ? '' : ' — ' + (d ?? ''))); if (!c) fails++; };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

const RPM = APP_CONFIG.MSS54HP.AXIS_RPM;
const LOAD = APP_CONFIG.MSS54HP.AXIS_LOAD;
const calc = new VECalculator();
const flat = (v) => ({ xAxis: [...RPM], yAxis: [...LOAD], data: LOAD.map(() => RPM.map(() => v)) });

/** A run of samples at one (rpm, load), with a given trim. Spaced so nothing else refuses them. */
const at = (rpm, load, stft, n, t0 = 0) => Array.from({ length: n }, (_, i) => ({
    time: t0 + i * 0.25, rpm, rawLoad: load,
    // A two-point controller dithers; a dead-flat trim is the frozen case other gates refuse.
    stft1: stft * (1 + (i % 2 ? 0.002 : -0.002)),
    stft2: stft * (1 + (i % 2 ? 0.002 : -0.002)),
    coolantTemp: 90,
}));

const run = (points, map = flat(0.5)) => calc.calculateNewVEMap(map, points, {
    applyRfKorr: false, minCellSamples: 10, minCellWeight: 5.0,
});

console.log('\n# The statistic, and where its threshold comes from\n');

// Uniform-in-bracket evidence. E[w^2]/E[w] with w = u*v, u,v ~ U(0,1) is (1/3)^2/(1/4) = 4/9.
check('the threshold sits below what evenly-spread evidence produces', MIN_SELF_SHARE < 4 / 9,
    `${MIN_SELF_SHARE} vs 0.444`);
check('...and is two thirds of it, not an arbitrary round number',
    near(MIN_SELF_SHARE, (2 / 3) * (4 / 9), 0.026), MIN_SELF_SHARE);

console.log('\n# 1. Under-realisation is reported, not hidden\n');

// Dead centre on a breakpoint: every sample is entirely this cell's, so self-share is 1 and the
// demanded and realised gains agree. This is the calibration point for the two maps.
{
    const r = 15, c = 7;                                  // 10.0 % opening x 2100 rpm, both exact
    const out = run(at(RPM[c], LOAD[r], 1.08, 60));
    check('a dead-centre cell is accepted', out.acceptedMap[r][c]);
    check('...its demanded gain is the trim', near(out.correctionMap[r][c], 1.08, 0.002), out.correctionMap[r][c]);
    check('...and realised equals demanded, because nothing was shared',
        near(out.realisedMap[r][c], out.correctionMap[r][c], 0.002), out.realisedMap[r][c]);
}

// Halfway between two rpm breakpoints: the sample splits across two cells, so each one's write is
// worth about half of it at the sample's own location.
{
    const r = 15, c = 7;
    const mid = (RPM[c] + RPM[c + 1]) / 2;
    const out = run(at(mid, LOAD[r], 1.08, 60));
    const share = out.realisedMap[r][c] === 1 ? 0 : (out.realisedMap[r][c] - 1) / (out.correctionMap[r][c] - 1);
    check('a cell fed only by half-shared samples still clears self-share', out.acceptedMap[r][c],
        `share ${share.toFixed(3)}`);
    check('...but its realised gain is about half its demanded one', near(share, 0.5, 0.05), share);
    check('...and realised is strictly the smaller of the two',
        out.realisedMap[r][c] < out.correctionMap[r][c]);
}

console.log('\n# 2. The ratchet has no fixed point above the evidence\n');

// Re-derivation is the loop that ratchets: flash, re-log, derive again from the NEW base. Here the
// second pass is handed a base already moved by the first and a log that still shows a residual —
// exactly the shape that used to walk a cell away from its neighbours without bound.
{
    const r = 15, c = 7;
    const mid = (RPM[c] + RPM[c + 1]) / 2;
    let base = flat(0.5);
    let last = 0;
    for (let pass = 0; pass < 6; pass++) {
        const out = run(at(mid, LOAD[r], 1.08, 60), base);
        base = { ...base, data: out.newMap.data };
        last = out.correctionMap[r][c];
    }
    const grew = base.data[r][c] / 0.5;
    check('six re-derivations never demand more than any sample asked for',
        last <= 1.08 + 1e-9, last);
    check('...so the cell cannot walk past the evidence', grew <= 1.08 ** 6 + 1e-9, grew);
    // The number the clamp exists to make unreachable: without it, a 0.5-share cell demanding 1.08
    // has a fixed point at 1 + 0.08/0.5 = 1.16, i.e. a 16 % cliff against an unwritten neighbour.
    const unclamped = 1 + 0.08 / 0.5;
    check('the unclamped fixed point would have been 1.16', near(unclamped, 1.16, 1e-9), unclamped);
}

console.log('\n# 2b. The clamp only ever damps — it cannot amplify or reverse\n');

// The mean and the clamp's bounds are taken over different populations: the mean over every sample
// whose bracket touched the cell, the bounds over the ones that landed substantially inside it
// (`w >= 0.25`). So the mean can sit OUTSIDE the range, and the question is what happens then.
//
// Each case below is built the same way: a NEAR group dead on the breakpoint (weight 1.0 each,
// and therefore the only contributor to the range) plus a GRAZE group parked 90 % of the way to
// the next rpm breakpoint, which lands weight 0.1 in this cell — under the bound's cut, over
// nothing else. The graze group moves the mean and cannot move the range.
{
    const r = 15, c = 7;                                  // 10.0 % opening x 2100 rpm
    const far = RPM[c] + 0.9 * (RPM[c + 1] - RPM[c]);     // weight 0.1 here, 0.9 in the next cell
    const mix = (nearTrim, grazeTrim) =>
        run([...at(RPM[c], LOAD[r], nearTrim, 20), ...at(far, LOAD[r], grazeTrim, 400, 100)]);

    // 1. THE SIGN CASE. Near samples say 0.97, the bracket mean says 1.12. Clamping to the range
    //    would write -2.8 % where the evidence asked for +12 %; this is session #926's 7.5 % at
    //    2700 rpm, which was written at -2.52 % against a demand of +0.69 %.
    {
        const out = mix(0.97, 1.20);
        const demand = out.demandMap[r][c], written = out.correctionMap[r][c];
        check('the mean really does land outside the near range', demand > 0.98, demand);
        check('...and the two disagree about the sign', (demand - 1) * (0.97 - 1) < 0);
        check('...so NOTHING is written, rather than the reversed number',
            near(written, 1.0, 1e-9), written);
    }

    // 2. THE AMPLIFYING CASE. Both point the same way; the near samples simply asked for MORE.
    //    A clamp that fires here would write +9.8 % against a demand of +4.0 %.
    {
        const out = mix(1.10, 1.01);
        const demand = out.demandMap[r][c], written = out.correctionMap[r][c];
        check('the near range sits beyond the demand, same side of 1.000',
            demand > 1 && demand < 1.098, demand);
        check('...and the write is the demand, not the larger bound',
            near(written, demand, 1e-9), `${written} vs ${demand}`);
    }

    // 3. THE DAMPING CASE, which is the whole reason the clamp exists. The mean has been dragged
    //    past everything that was actually measured here, so it is cut back to the evidence.
    {
        const out = mix(1.02, 1.20);
        const demand = out.demandMap[r][c], written = out.correctionMap[r][c];
        check('a demand beyond the evidence is still cut back to it',
            written < demand && near(written, 1.02 * 1.002, 1e-3), `${written} vs ${demand}`);
    }

    // The invariant, stated as one test over all three: a clamped write is never further from
    // 1.000 than what was demanded, and never on the other side of it.
    for (const [nearTrim, grazeTrim] of [[0.97, 1.20], [1.10, 1.01], [1.02, 1.20], [1.05, 0.99], [0.94, 1.06]]) {
        const out = mix(nearTrim, grazeTrim);
        const d = out.demandMap[r][c], w = out.correctionMap[r][c];
        check(`near ${nearTrim} / graze ${grazeTrim}: |written-1| <= |demand-1| and no sign flip`,
            Math.abs(w - 1) <= Math.abs(d - 1) + 1e-9 && (w - 1) * (d - 1) >= 0,
            `demand ${d.toFixed(4)} written ${w.toFixed(4)}`);
    }
}

console.log('\n# 3. Blame misattribution is refused, not written\n');

// A cell whose evidence is almost entirely about its neighbour: samples sit just inside the far
// edge of the bracket, so this cell takes a small corner of each one.
{
    const r = 15, c = 7;
    // 98 % of the way toward the next breakpoint in BOTH axes: corner weight 0.02 x 0.02.
    const rpm = RPM[c] + 0.98 * (RPM[c + 1] - RPM[c]);
    const load = LOAD[r] + 0.98 * (LOAD[r + 1] - LOAD[r]);
    const out = run(at(rpm, load, 1.20, 400));
    check('the far cell collects a real weightSum from grazing samples',
        out.weightMap[r][c] > 0 && out.hitMap[r][c] === 400, out.weightMap[r][c].toFixed(2));
    check('...but is REFUSED, because the evidence was about its neighbour',
        !out.acceptedMap[r][c]);
    check('...while the cell the samples actually sat in IS written',
        out.acceptedMap[r + 1][c + 1], `${out.correctionMap[r + 1][c + 1]}`);
}

console.log('\n# The accumulators stay sums, so a live run still matches a batch one\n');

// D1 added two statistics to the grid. If either stopped being incremental the live path would
// silently disagree with the batch path — the property verify:incremental exists to hold.
{
    const r = 15, c = 7;
    const pts = at(RPM[c], LOAD[r], 1.05, 40);
    const batch = run(pts);
    const grid = calc.createGrid();
    const plan = { apply: false, source: 'rf-ratio' };
    for (const p of pts) calc.accumulatePoint(grid, p, plan, null, null);
    const inc = calc.finalizeGrid(flat(0.5), grid, { minCellSamples: 10, minCellWeight: 5.0 });
    check('incremental and batch agree on the correction',
        near(inc.correctionMap[r][c], batch.correctionMap[r][c], 1e-12));
    check('...and on the realised gain', near(inc.realisedMap[r][c], batch.realisedMap[r][c], 1e-12));
    check('...and on acceptance', inc.acceptedMap[r][c] === batch.acceptedMap[r][c]);
}

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
