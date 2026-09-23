/**
 * The rule that decides when SHAPE is allowed to run.
 *
 * SHAPE projects a surface onto a constraint set — monotone, bounded gain. Applied to a converged
 * map that removes calibration defects; applied to one drive's output it removes the DRIVE's noise
 * and leaves a smooth, monotone, deliberate-looking error. So the gate is not "is there a tune" but
 * "has the tune stopped moving", and this pins the difference.
 *
 * The property that matters most is the LAST one: an unmeasured map must not read as a converged
 * one. Both have nothing asking to move, and only one of them is finished.
 *
 *     node scripts/verify-convergence.mjs
 */
import {
    summariseConvergence, CONVERGED_BAND, CONVERGENCE_MIN_SAMPLES,
} from '../src/lib/ve-calculator/convergence.ts';

let fails = 0;
const check = (name, ok, got) => {
    if (!ok) fails++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok || got === undefined ? '' : ' — ' + got}`);
};

/** A grid of `d` everywhere, with `n` samples in every cell. */
const grid = (rows, cols, d) => Array.from({ length: rows }, () => Array(cols).fill(d));
const hits = (rows, cols, n) => Array.from({ length: rows }, () => Array(cols).fill(n));

console.log('\n[a settled map is converged]');
{
    const r = summariseConvergence(grid(4, 4, 1.005), hits(4, 4, 20));
    check('nothing is unsettled', r.unsettled === 0, String(r.unsettled));
    check('every cell was evaluated', r.evaluated === 16, String(r.evaluated));
    check('converged', r.converged === true);
    check('the worst is reported even when it passes',
        Math.abs(r.worst - 0.005) < 1e-9, r.worst.toFixed(4));
}

console.log('\n[one cell still moving is enough to refuse]');
{
    const d = grid(4, 4, 1.005);
    d[2][3] = 1.16;
    const r = summariseConvergence(d, hits(4, 4, 20));
    check('not converged', r.converged === false);
    check('exactly one cell is unsettled', r.unsettled === 1, String(r.unsettled));
    check('the worst is that cell', Math.abs(r.worst - 0.16) < 1e-9, r.worst.toFixed(4));
    check('and it is named', r.worstAt?.row === 2 && r.worstAt?.col === 3, JSON.stringify(r.worstAt));
}

console.log('\n[the band is the band]');
{
    const inside = grid(2, 2, 1 + CONVERGED_BAND - 1e-6);
    const outside = grid(2, 2, 1 + CONVERGED_BAND + 1e-6);
    check('just inside converges', summariseConvergence(inside, hits(2, 2, 20)).converged === true);
    check('just outside does not', summariseConvergence(outside, hits(2, 2, 20)).converged === false);
    check('a NEGATIVE demand of the same size counts too',
        summariseConvergence(grid(2, 2, 1 - CONVERGED_BAND - 1e-6), hits(2, 2, 20)).converged === false,
        'only over-fuelling was counted');
}

console.log('\n[a thin cell is not evidence either way]');
{
    const d = grid(3, 3, 1.0);
    d[0][0] = 1.40;                       // a wild demand...
    const h = hits(3, 3, 20);
    h[0][0] = CONVERGENCE_MIN_SAMPLES - 1; // ...from a cell too thin to judge
    const r = summariseConvergence(d, h);
    check('the thin cell is skipped', r.evaluated === 8, String(r.evaluated));
    check('...so it cannot block on its own', r.converged === true);
    check('...and does not set the worst', r.worst === 0, r.worst.toFixed(4));
}

/**
 * THE ONE THAT MATTERS.
 *
 * "Nothing is asking to move" is true of a converged map AND of a map nobody measured. Reading the
 * second as the first would unlock SHAPE on exactly the surface it must never touch: a base that
 * has never been driven, where every kink is the calibration's and none of it has been confirmed.
 */
console.log('\n[an unmeasured map is NOT a converged one]');
{
    const r = summariseConvergence(grid(4, 4, 1.0), hits(4, 4, 0));
    check('nothing was evaluated', r.evaluated === 0, String(r.evaluated));
    check('nothing is unsettled either', r.unsettled === 0);
    check('and it is still NOT converged', r.converged === false, 'an empty map unlocked SHAPE');
    check('a null map is not converged', summariseConvergence(null, null).converged === false);
    check('a map with no hits is not converged',
        summariseConvergence(grid(2, 2, 1.0), null).converged === false);
}

console.log('\n[the row window, so a caller can ask about one band]');
{
    const d = grid(6, 4, 1.0);
    d[0][0] = 1.5;                     // trouble only in the bottom row
    const h = hits(6, 4, 20);
    check('the whole table sees it',
        summariseConvergence(d, h).converged === false);
    check('a window above it does not',
        summariseConvergence(d, h, { rowFrom: 1 }).converged === true);
    check('a window ending below it does',
        summariseConvergence(d, h, { rowTo: 0 }).converged === false);
}

console.log('\n[a demand that is not a number cannot pass or block]');
{
    const d = grid(2, 2, 1.0);
    d[0][0] = NaN; d[0][1] = 0; d[1][0] = Infinity;
    const r = summariseConvergence(d, hits(2, 2, 20));
    check('only the real one is evaluated', r.evaluated === 1, String(r.evaluated));
    check('and it converges on it', r.converged === true);
}

console.log(fails === 0 ? '\nALL PASS' : '\n' + fails + ' FAILURE(S)');
process.exit(fails ? 1 : 0);
