// Checks the XDF math evaluator against the vendored catalog and against the
// handful of equations whose shape is a known trap.
//
//  - every distinct equation in the artifact compiles, except the pinned
//    k-linked pair (they reference another item's value and must refuse);
//  - `^` is exponentiation and binds tighter than `/`: x/2^14 at 16384 -> 1.0
//    (read as XOR, the same string is (16384/2)^14 — astronomically wrong);
//  - synthesized inverses round-trip: affine to float precision, bisection to
//    half a raw count;
//  - reciprocal forms invert direction and still land on the right raw;
//  - 5.12/x at raw 0 is the decoder's per-cell error, not an exception here.
//
// Runner: node --experimental-strip-types --import ./scripts/ts-resolve.mjs

import { readFileSync } from 'node:fs';
import { compileForward, buildScaling, rawDomain } from '../src/lib/calibration/xdfMath.ts';

let fails = 0;
function check(label, ok, detail = '') {
    if (ok) { console.log(`  ok  ${label}`); return; }
    fails += 1;
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
}

const graph = JSON.parse(readFileSync('public/data/calibration-graph.json', 'utf8'));

// ---- every distinct equation compiles (k-linked pinned) --------------------

const K_LINKED = new Set(['(X/k)*10', '2000000000/(x*K)']);
const equations = new Set();
for (const node of graph.nodes) {
    if (node.t !== 'param') continue;
    if (node.math) equations.add(node.math);
    for (const axis of Object.values(node.axes ?? {})) {
        if (axis.math) equations.add(axis.math);
    }
}
console.log(`${equations.size} distinct equations in the artifact`);

const failed = [];
for (const eq of equations) {
    const fn = compileForward(eq);
    if (fn === null && !K_LINKED.has(eq)) failed.push(eq);
    if (fn !== null && K_LINKED.has(eq)) failed.push(`${eq} (compiled but is k-linked)`);
}
check('every equation compiles except the k-linked pair', failed.length === 0, failed.join(' · '));

// ---- ^ is exponentiation, tighter than / ----------------------------------

const pow = compileForward('x/2^14');
check('x/2^14 at 16384 -> 1.0', pow !== null && Math.abs(pow(16384) - 1.0) < 1e-12, `got ${pow?.(16384)}`);
check('x/2^14 at 8192 -> 0.5', pow !== null && Math.abs(pow(8192) - 0.5) < 1e-12);

const negexp = compileForward('1.165e0*exp(x*4.426e-2)');
check('exp form at 0 -> 1.165', negexp !== null && Math.abs(negexp(0) - 1.165) < 1e-12, `got ${negexp?.(0)}`);
check('exp form at 50 matches Math.exp', negexp !== null && Math.abs(negexp(50) - 1.165 * Math.exp(50 * 0.04426)) < 1e-9);

const leadingDot = compileForward('.4*x');
check('.4*x parses', leadingDot !== null && Math.abs(leadingDot(10) - 4) < 1e-12);

const unaryNeg = compileForward('x*(-40)');
check('x*(-40) parses', unaryNeg !== null && unaryNeg(2) === -80);

// ---- inverse round trips ---------------------------------------------------

function roundTrip(eq, bits, signed, tolerance, expectKind) {
    const domain = rawDomain(bits, signed);
    const s = buildScaling(eq, domain);
    if (!s) { check(`${eq}: buildScaling`, false, 'returned null'); return; }
    if (expectKind) check(`${eq}: inverse is ${expectKind}`, s.inverse === expectKind, `got ${s.inverse}`);
    let worst = 0;
    const step = Math.max(1, Math.floor((domain.max - domain.min) / 97));
    for (let raw = domain.min; raw <= domain.max; raw += step) {
        const phys = s.toPhysical(raw);
        if (!Number.isFinite(phys)) continue;
        const back = s.toRaw(phys);
        worst = Math.max(worst, Math.abs(back - raw));
    }
    check(`${eq}: round trip within ${tolerance}`, worst <= tolerance, `worst |toRaw(toPhysical(r)) - r| = ${worst}`);
}

roundTrip('X', 16, false, 1e-9, 'affine');
roundTrip('X/1000', 16, false, 1e-6, 'affine');
roundTrip('x*0.0078125', 8, false, 1e-6, 'affine');
roundTrip('X-48', 8, false, 1e-9, 'affine');
roundTrip('(x-32768)/10', 16, false, 1e-6, 'affine');
roundTrip('x*3+500', 16, false, 1e-6, 'affine');
roundTrip('x/2^14', 16, false, 1e-6, 'affine');
roundTrip('-x/10', 8, true, 1e-6, 'affine');
roundTrip('5.12/x', 8, false, 0.5, 'bisection');
roundTrip('16384/(x*100)', 16, false, 0.5, 'bisection');
roundTrip('1.165e0*exp(x*4.426e-2)', 8, false, 0.5, 'bisection');

// ---- reciprocal direction inversion ---------------------------------------

{
    const s = buildScaling('5.12/x', rawDomain(8, false));
    const at2 = s.toPhysical(2);   // 2.56
    const at200 = s.toPhysical(200); // 0.0256
    check('5.12/x: larger raw means smaller physical', at2 > at200);
    check('5.12/x: toRaw(2.56) ~ 2', Math.abs(s.toRaw(2.56) - 2) <= 0.5, `got ${s.toRaw(2.56)}`);
    check('5.12/x: toRaw(0.0256) ~ 200', Math.abs(s.toRaw(0.0256) - 200) <= 0.5, `got ${s.toRaw(0.0256)}`);
    check('5.12/x at raw 0 is non-finite, not a throw', !Number.isFinite(s.toPhysical(0)));
}

// ---- k-linked refusal ------------------------------------------------------

check('(X/k)*10 refuses to compile', compileForward('(X/k)*10') === null);
check('2000000000/(x*K) refuses to compile', compileForward('2000000000/(x*K)') === null);

// ---- unknown identifiers refuse rather than guess --------------------------

check('unknown identifier refuses', compileForward('x*FOO') === null);
check('unknown function refuses', compileForward('sin(x)') === null);
check('trailing garbage refuses', compileForward('x/10 garbage') === null);

if (fails) {
    console.error(`\n${fails} check(s) failed`);
    process.exit(1);
}
console.log('\nall checks passed');
