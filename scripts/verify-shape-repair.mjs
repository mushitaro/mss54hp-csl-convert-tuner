/**
 * The shape repair: what it may move, what it must not, and what it does on a real tune.
 *
 * The safety property this suite exists to hold is one sentence: A REPAIR CANNOT MOVE A MEASURED
 * CELL. Everything else about the feature is a judgement the operator makes with a chart in front
 * of them; that one is not negotiable, because a repair that can overwrite a measurement can turn
 * a drive's own result into whatever its parameters happen to say.
 *
 * The second property is nearly as important and much easier to lose: IT DOES NOT REPAIR THE BASE.
 * This car's factory table holds 34 falling pairs and 200 gradient steps at a 1.6 cap. A smoother
 * let loose on all of them would rewrite the calibration from a 52-minute drive and report it as
 * tidying up.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BinaryParser } from '../src/lib/binary-engine/parser.ts';
import {
    repairShape, analyseShape, SHAPE_REPAIR_DEFAULTS,
} from '../src/lib/ve-calculator/lowLoadShape.ts';

let fails = 0;
const check = (n, c, d) => { console.log('  ' + (c ? 'PASS' : 'FAIL') + '  ' + n + (c ? '' : ' — ' + (d ?? ''))); if (!c) fails++; };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

// A single column, laid out so every rule has something to bite on.
//   rows 0..5, opening axis 0, 1, 2, 3, 4, 5
//   anchors at row 1 (measured 4 % lean) and row 4 (measured 4 % lean)
const OPENING = [0, 1, 2, 3, 4, 5];
const col = (v) => v.map(x => [x]);
const BASE = col([0.10, 0.20, 0.30, 0.40, 0.50, 0.60]);
const TUNED = col([0.10, 0.208, 0.30, 0.40, 0.52, 0.60]);   // rows 1 and 4 moved by the tune
const ANCHOR = col([false, true, false, false, true, false]);
const ON = { ...SHAPE_REPAIR_DEFAULTS, blend: true };

console.log('\n# Anchors are frozen — the property everything else rests on\n');
{
    const r = repairShape(BASE, TUNED, ANCHOR, OPENING, { ...ON, monotone: true, smoothGain: true });
    check('the measured cell at row 1 is untouched', r.values[1][0] === TUNED[1][0], r.values[1][0]);
    check('the measured cell at row 4 is untouched', r.values[4][0] === TUNED[4][0], r.values[4][0]);
    check('no anchor is ever marked as shaped', !r.shaped[1][0] && !r.shaped[4][0]);
}

console.log('\n# BLEND carries the correction, and preserves the shape between anchors\n');
{
    const r = repairShape(BASE, TUNED, ANCHOR, OPENING, ON);
    // Both anchors read the same correction (0.208/0.20 = 1.04, 0.52/0.50 = 1.04), so every cell
    // between them is scaled by that one number and the BASE's own curvature is untouched.
    check('row 2 takes the interpolated correction', near(r.values[2][0], 0.30 * 1.04, 1e-9), r.values[2][0]);
    check('row 3 takes it too', near(r.values[3][0], 0.40 * 1.04, 1e-9), r.values[3][0]);
    check('both are marked shaped', r.shaped[2][0] && r.shaped[3][0]);
    // The property PAV cannot offer: with equal corrections the ratio between neighbours is
    // preserved exactly, so nothing about the factory's shape is quietly rewritten.
    const shapeBefore = BASE[3][0] / BASE[2][0];
    const shapeAfter = r.values[3][0] / r.values[2][0];
    check('the shape between the anchors is preserved exactly', near(shapeBefore, shapeAfter, 1e-12));
}

console.log('\n# Unequal anchors interpolate, they do not average\n');
{
    // row 1 wants +4 %, row 4 wants -4 %. Row 2 is one third of the way, row 3 two thirds.
    const T2 = col([0.10, 0.208, 0.30, 0.40, 0.48, 0.60]);
    const r = repairShape(BASE, T2, ANCHOR, OPENING, ON);
    const k = (t) => (1 - t) * 1.04 + t * 0.96;
    check('row 2 sits one third along', near(r.values[2][0], 0.30 * k(1 / 3), 1e-9), r.values[2][0]);
    check('row 3 sits two thirds along', near(r.values[3][0], 0.40 * k(2 / 3), 1e-9), r.values[3][0]);
}

console.log('\n# Nothing happens where nothing was asked for\n');
{
    const off = repairShape(BASE, TUNED, ANCHOR, OPENING, SHAPE_REPAIR_DEFAULTS);
    check('every option off means every cell untouched', off.shapedCount === 0);
    check('...and the grid comes back identical', off.values.every((row, r) => row[0] === TUNED[r][0]));

    // Outside the anchored span, with extrapolate off.
    const r = repairShape(BASE, TUNED, ANCHOR, OPENING, ON);
    check('row 0, below the lowest anchor, is untouched', r.values[0][0] === TUNED[0][0]);
    check('row 5, above the highest, is untouched', r.values[5][0] === TUNED[5][0]);

    // A column with one anchor has nothing to interpolate between.
    const oneAnchor = col([false, true, false, false, false, false]);
    const single = repairShape(BASE, TUNED, oneAnchor, OPENING, { ...ON, monotone: true });
    check('a column with a single anchor is left entirely alone', single.shapedCount === 0);
    const noAnchor = col([false, false, false, false, false, false]);
    check('a column with no anchor at all, likewise',
        repairShape(BASE, TUNED, noAnchor, OPENING, { ...ON, monotone: true }).shapedCount === 0);
}

console.log('\n# EXTRAPOLATE is opt-in, and flat when it runs\n');
{
    const r = repairShape(BASE, TUNED, ANCHOR, OPENING, { ...ON, extrapolate: true });
    check('row 0 now takes the nearest measured correction', near(r.values[0][0], 0.10 * 1.04, 1e-9), r.values[0][0]);
    check('row 5 takes the one above it', near(r.values[5][0], 0.60 * 1.04, 1e-9), r.values[5][0]);
    // Flat, not a continued slope: a gradient extended past the last measurement is invented data.
    check('...held CONSTANT, not extended as a gradient',
        near(r.values[0][0] / BASE[0][0], r.values[5][0] / BASE[5][0], 1e-12));
}

console.log('\n# The move bound reports rather than applies\n');
{
    // An anchor 30 % away from BASE drags the blended cells far past maxRepairFrac.
    const big = col([0.10, 0.26, 0.30, 0.40, 0.65, 0.60]);
    const r = repairShape(BASE, big, ANCHOR, OPENING, ON);
    check('cells wanting more than the bound are refused', r.refusedCount > 0, r.refusedCount);
    check('...and left at their un-repaired value',
        r.values[2][0] === big[2][0] && r.values[3][0] === big[3][0]);
    check('...and not counted as shaped', !r.shaped[2][0] && !r.shaped[3][0]);
}

console.log('\n# MONOTONE fixes the free side of a falling pair\n');
{
    //  row 2 sits ABOVE row 3 in the tuned grid: filling falling as the throttle opens.
    const bad = col([0.10, 0.20, 0.45, 0.40, 0.50, 0.60]);
    const flat = col([false, true, false, false, true, false]);
    const r = repairShape(BASE, bad, flat, OPENING, { ...SHAPE_REPAIR_DEFAULTS, monotone: true, maxRepairFrac: 0.5 });
    check('the reversal is gone', r.values[2][0] <= r.values[3][0] + 1e-12,
        `${r.values[2][0]} vs ${r.values[3][0]}`);
    check('both anchors still hold their measured values',
        r.values[1][0] === bad[1][0] && r.values[4][0] === bad[4][0]);
}

console.log('\n# Against the real car: it does not repair the factory table\n');

const binPath = here('fixtures/session-920-base.bin');
if (!fs.existsSync(binPath)) {
    console.log('  SKIP  fixtures/session-920-base.bin is absent.');
} else {
    const buf = fs.readFileSync(binPath);
    const parser = new BinaryParser(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    const ve = parser.getVETable();
    const rows = ve.yAxis.length, cols = ve.xAxis.length;
    const none = ve.data.map(r => r.map(() => false));

    const baseShape = analyseShape(ve.data, null, ve.yAxis);
    check('the factory table really does hold reversals to be tempted by', baseShape.falling > 20,
        baseShape.falling);
    check('...and a great many gradient steps at the 1.6 cap', baseShape.gainJumps > 100,
        baseShape.gainJumps);

    // With no anchors anywhere — which is what "a log that earned nothing" looks like — every
    // option on must still leave all 480 cells exactly as they were.
    const all = { ...SHAPE_REPAIR_DEFAULTS, monotone: true, blend: true, smoothGain: true, extrapolate: true };
    const r = repairShape(ve.data, ve.data, none, ve.yAxis, all);
    check('with nothing measured, nothing is repaired', r.shapedCount === 0, r.shapedCount);
    let same = true;
    for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) if (r.values[i][j] !== ve.data[i][j]) same = false;
    check('...and the factory table comes back byte for byte', same);
}

console.log('\n# The rpm direction: smoothness applies, monotonicity does not\n');
{
    // Five rpm breakpoints on one opening row. Filling FALLS with rpm at fixed opening, which is
    // what this table really does -- 0.331 at 600 rpm against 0.073 at 7900 on the 0.40 % row -- so
    // a monotone projection across rpm would rewrite the table into a shape no engine has.
    const RPM = [600, 1000, 2000, 3000, 4000];
    const B = [[0.50, 0.40, 0.30, 0.20, 0.10]];
    const T = [[0.52, 0.40, 0.30, 0.20, 0.104]];      // first and last measured, both +4 %
    const A = [[true, false, false, false, true]];
    const OPEN1 = [1];

    const r = repairShape(B, T, A, OPEN1, { ...SHAPE_REPAIR_DEFAULTS, blend: true, axis: 'rpm' }, RPM);
    check('the rpm direction fills between two measured speeds', r.shapedCount === 3, r.shapedCount);
    check('...taking the interpolated correction', near(r.values[0][2], 0.30 * 1.04, 1e-9), r.values[0][2]);
    check('...and leaving the measured ends alone',
        r.values[0][0] === T[0][0] && r.values[0][4] === T[0][4]);
    check('a row that falls with rpm is NOT straightened',
        r.values[0].every((v, i) => i === 0 || v <= r.values[0][i - 1] + 1e-12),
        r.values[0].map(v => v.toFixed(3)).join(' '));
    const mono = repairShape(B, T, A, OPEN1,
        { ...SHAPE_REPAIR_DEFAULTS, blend: true, monotone: true, axis: 'rpm' }, RPM);
    check('...even with MONOTONE on, because it cannot apply across rpm',
        mono.values[0].every((v, i) => i === 0 || v <= mono.values[0][i - 1] + 1e-12));

    const noAxis = repairShape(B, T, A, OPEN1, { ...SHAPE_REPAIR_DEFAULTS, blend: true, axis: 'rpm' });
    check('no rpm axis passed means no rpm pass', noAxis.shapedCount === 0, noAxis.shapedCount);
}

console.log('\n# BOTH fills by whichever direction brackets the cell, once\n');
{
    // A cross: the centre cell is bracketed in BOTH directions. It must be written once, by the
    // opening pass, and not overwritten by the rpm pass afterwards.
    const OPEN = [0, 1, 2];
    const RPM2 = [1000, 2000, 3000];
    const B = [[0.20, 0.20, 0.20], [0.30, 0.30, 0.30], [0.40, 0.40, 0.40]];
    const T = [[0.20, 0.208, 0.20], [0.312, 0.30, 0.312], [0.40, 0.416, 0.40]];
    const A = [[false, true, false], [true, false, true], [false, true, false]];
    const both = repairShape(B, T, A, OPEN, { ...SHAPE_REPAIR_DEFAULTS, blend: true, axis: 'both' }, RPM2);
    check('the centre is filled', both.shaped[1][1], `shaped ${both.shapedCount}`);
    check('...by the opening pass, at its interpolated correction',
        near(both.values[1][1], 0.30 * 1.04, 1e-9), both.values[1][1]);
    const openOnly = repairShape(B, T, A, OPEN, { ...SHAPE_REPAIR_DEFAULTS, blend: true, axis: 'opening' }, RPM2);
    check('...and BOTH puts it nowhere the opening pass alone would not',
        near(both.values[1][1], openOnly.values[1][1], 1e-12));
}


console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
