/**
 * Does the lambda trim cancel `TI_F_STAT`? Measured, on a car.
 *
 * This settles which of two readings of `KF_TI_N_RF` is right, and the two produce corrections
 * 15 % apart in exactly the cells an ordinary drive covers best.
 *
 *   READING A — "deliberate enrichment". The DME asks for extra fuel at low filling; at a lambda-1
 *     target the closed loop takes it straight back out, so a PERFECT air model shows a standing
 *     trim of 1/TI_F_STAT. The correction must therefore MULTIPLY by TI_F_STAT to undo it, and
 *     `STFT x TI_F_STAT = 1.000` means "change nothing".
 *   READING B — "part of the air-to-fuel conversion" (small-pulse injector compensation, which is
 *     the shape of the table: unity everywhere, rising to 1.148-1.297 only at the shortest pulses,
 *     and rising further with rpm). Then delivered mass is already proportional to RF, a perfect
 *     air model shows a trim of 1.000 whatever TI_F_STAT is, and multiplying by it INVENTS a
 *     correction that the car never asked for.
 *
 * Reading A is what `lowLoadTuner` shipped. It is wrong, and the car says so twice.
 *
 * THE FIXTURE: session #920, a 52-minute road drive. 1,479 warm closed-loop samples at 1000-2400
 * rpm with RF between 8 and 30 %, which straddles the `KF_TI_N_RF` y = 0.15 breakpoint where the
 * factor steps from ~1.17 down to exactly 1.000. Upstream filters (cold, purge, fuel cut) already
 * applied. Stratified at up to 70 samples per integer RF percent so the boundary stays populated.
 *
 * THE TEST: reading A predicts `STFT x TI_F_STAT` is flat across the boundary and `STFT` itself
 * jumps ~15 %. Reading B predicts the opposite. They cannot both be nearly flat, so one measurement
 * chooses.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BinaryParser } from '../src/lib/binary-engine/parser.ts';
import { readAlphaNTables, tiLoadFactorAt } from '../src/lib/ve-calculator/alphaNTable.ts';

let fails = 0;
const check = (n, c, d) => { console.log('  ' + (c ? 'PASS' : 'FAIL') + '  ' + n + (c ? '' : ' — ' + (d ?? ''))); if (!c) fails++; };

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const binPath = here('fixtures/session-920-base.bin');
if (!fs.existsSync(binPath)) {
    console.log('\n  SKIP  fixtures/session-920-base.bin is absent.');
    process.exit(0);
}
const buf = fs.readFileSync(binPath);
const parser = new BinaryParser(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const tables = readAlphaNTables(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const points = JSON.parse(fs.readFileSync(here('fixtures/session-920-ti-boundary.json'), 'utf8')).points;

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const trim = (p) => {
    const b = [p.stft1, p.stft2].filter(v => v !== undefined);
    return b.reduce((x, y) => x + y, 0) / b.length;
};

console.log('\n# The table this turns on\n');

check('KF_TI_N_RF decodes', !!tables);
if (!tables) { console.log('\n1 FAILURE(S)'); process.exit(1); }

// The shape reading B predicts and reading A does not explain: unity everywhere except the
// shortest pulses, and MORE compensation as rpm rises (a shorter pulse for the same filling).
check('TI_F_STAT is exactly 1.000 at RF 0.15 and above',
    [0.15, 0.20, 0.40, 0.80].every(rf => Math.abs(tiLoadFactorAt(tables, 1800, rf) - 1) < 1e-9));
check('TI_F_STAT at RF 0.10 is 1.15-1.20 at 1800 rpm',
    tiLoadFactorAt(tables, 1800, 0.10) > 1.15 && tiLoadFactorAt(tables, 1800, 0.10) < 1.20,
    tiLoadFactorAt(tables, 1800, 0.10));
check('...and larger still at high rpm, which is the small-pulse signature',
    tiLoadFactorAt(tables, 5800, 0.10) > tiLoadFactorAt(tables, 1800, 0.10),
    `${tiLoadFactorAt(tables, 5800, 0.10)} vs ${tiLoadFactorAt(tables, 1800, 0.10)}`);

console.log('\n# What the car does across the boundary\n');

// Below the breakpoint against above it, rpm held inside one band so the factor's own rpm
// dependence cannot masquerade as the effect being measured.
const band = points.filter(p => p.rpm >= 1000 && p.rpm < 2400 && p.rf !== undefined);
const below = band.filter(p => p.rf < 14.5);
const above = band.filter(p => p.rf >= 15.5 && p.rf <= 26);
check('both sides of the breakpoint are populated', below.length > 200 && above.length > 200,
    `${below.length} below, ${above.length} above`);

const tOf = (p) => tiLoadFactorAt(tables, p.rpm, p.rf / 100);
const trimBelow = median(below.map(trim));
const trimAbove = median(above.map(trim));
const prodBelow = median(below.map(p => trim(p) * tOf(p)));
const prodAbove = median(above.map(p => trim(p) * tOf(p)));
const tBelow = median(below.map(tOf));

console.log(`    below RF 14.5 %: n=${below.length}, median TI_F_STAT ${tBelow.toFixed(3)}, `
    + `median trim ${trimBelow.toFixed(4)}, median trim x TI_F_STAT ${prodBelow.toFixed(4)}`);
console.log(`    above RF 15.5 %: n=${above.length}, median TI_F_STAT 1.000, `
    + `median trim ${trimAbove.toFixed(4)}, median trim x TI_F_STAT ${prodAbove.toFixed(4)}\n`);

// The factor really is doing something on the low side, or the comparison is vacuous.
check('TI_F_STAT is meaningfully above 1 on the low side', tBelow > 1.05, tBelow);

// READING A's prediction: the trim carries a 1/TI_F_STAT step at the boundary. It would have to be
// most of the factor's own size to count as cancellation.
const trimStep = trimAbove / trimBelow - 1;
const predictedA = tBelow - 1;
check('the trim does NOT step by anything like 1/TI_F_STAT at the boundary',
    Math.abs(trimStep) < predictedA / 2,
    `trim steps ${(100 * trimStep).toFixed(1)} %, reading A predicts ${(100 * predictedA).toFixed(1)} %`);

// READING B's prediction: the trim is continuous across the boundary, and it is the PRODUCT that
// jumps, because the product multiplies in a factor the car never removed.
check('the trim is nearly continuous across the boundary', Math.abs(trimStep) < 0.04, trimStep);
check('...while trim x TI_F_STAT is NOT — the product is the discontinuous one',
    Math.abs(prodAbove / prodBelow - 1) > Math.abs(trimStep),
    `product steps ${(100 * (prodAbove / prodBelow - 1)).toFixed(1)} %`);

// The whole run, not only the boundary: if reading A held, the trim would trend down as the factor
// trends up. Correlate them and require the slope to be far from A's prediction of -1.
const xs = band.map(p => tOf(p) - 1);
const ys = band.map(p => trim(p) - 1);
const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
const my = ys.reduce((a, b) => a + b, 0) / ys.length;
let sxy = 0, sxx = 0;
for (let i = 0; i < xs.length; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
const slope = sxy / sxx;
console.log(`\n    regression of (trim - 1) on (TI_F_STAT - 1) over ${band.length} samples: `
    + `slope ${slope.toFixed(3)}  [reading A predicts about -1, reading B predicts about 0]\n`);
check('the regression slope is nowhere near reading A\'s -1', slope > -0.35, slope);

console.log('\n# The conclusion, stated as the rule the derivation must follow\n');

// This is the assertion that guards the code: no correction anywhere may carry TI_F_STAT. If a
// future change puts it back, this line is what says the car already answered.
const tunerSrc = fs.readFileSync(here('../src/lib/ve-calculator/lowLoadTuner.ts'), 'utf8');
const applied = /^\s*(?!\/\/|\s*\*)[^\n]*\btiFactor\b\s*[*/]|[*/]\s*tiFactor\b/m.test(tunerSrc);
check('no derivation multiplies or divides by TI_F_STAT', !applied,
    'lowLoadTuner still applies tiFactor to a correction');

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
