/**
 * The long-term trim store gate, against the car that motivated it.
 *
 * `New = Old x STFT x ...` is only true while STFT carries the whole fuel-path error. Two DME
 * stores absorb exactly that error and only one is readable here, so the app has to PROVE the
 * assumption per log instead of believing it. This checks the proof, its inputs, and — the part
 * that matters most — that it fails closed on the shapes that should refuse a write.
 *
 * The fixture is session #923, the first real log to carry `ltft`: a 606-point warm idle dwell,
 * thinned 1-in-10. Its BASE is byte-identical to `session-920-base.bin`, so the binary that drive
 * ran against is the one already in the fixtures.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BinaryParser } from '../src/lib/binary-engine/parser.ts';
import { trimNeutrality, learnersFrozen } from '../src/lib/log-engine/trimNeutrality.ts';
import { MANIFEST_TEXT } from '../src/lib/manifest-text.ts';

/**
 * The sentence the hub shows for a verdict, in one language, so the assertions below can keep
 * checking that the reader is told the right thing. The selection lives in page.tsx's manifest and
 * is mirrored here deliberately: what these checks are about is that each verdict HAS a distinct
 * remedy naming a next action, which is a property of the copy table, not of the wiring.
 */
const remedy = (n) => {
    const t = MANIFEST_TEXT.en;
    if (n.verdict === 'neutral') return undefined;
    if (n.verdict === 'learned') return t.trimLearned(n.worst.toFixed(4));
    return n.samples === 0 ? t.trimNoChannel : t.trimWindowOpen(n.frozen === null);
};

let fails = 0;
const check = (n, c, d) => { console.log('  ' + (c ? 'PASS' : 'FAIL') + '  ' + n + (c ? '' : ' — ' + (d ?? ''))); if (!c) fails++; };

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const fixture = JSON.parse(fs.readFileSync(here('fixtures/session-923-idle.json'), 'utf8'));
const points = fixture.points;
const binPath = here('fixtures/session-920-base.bin');

console.log('\n# The window the DME learns in, out of the binary\n');

let window = null;
if (!fs.existsSync(binPath)) {
    console.log('  SKIP  fixtures/session-920-base.bin is absent.');
} else {
    const buf = fs.readFileSync(binPath);
    const parser = new BinaryParser(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    window = parser.readLtftLearnWindow();

    // The PATCH's whole effect on lambda learning, read back out of the bytes it wrote. 100 degC
    // against a MAX of 100 degC is not "a high threshold" — it is an EMPTY interval, and
    // `laa_st_calc` clears the enable bits for BOTH learners outside it.
    check('K_LAA_TMOT_MIN decodes as 100 C', window.tmotMin === 100, window.tmotMin);
    check('K_LAA_TMOT_MAX decodes as 100 C', window.tmotMax === 100, window.tmotMax);
    check('so the window is empty and both learners are frozen', learnersFrozen(window));

    // The direction that must NOT read as frozen: a stock window is 69-100 degC, which is open
    // across every temperature a warm engine runs at.
    check('a stock 69-100 C window reads as NOT frozen',
        !learnersFrozen({ tmotMin: 69, tmotMax: 100 }));
}

console.log('\n# The verdict on session #923\n');

check('the fixture carries ltft at all', points.every(p => p.ltft1 !== undefined && p.ltft2 !== undefined));

if (window) {
    const n = trimNeutrality(points, window);
    check('#923 is NEUTRAL', n.verdict === 'neutral', n.verdict);
    check('every sample is at init', n.atInit === n.samples, `${n.atInit}/${n.samples}`);
    check('the worst departure from 1.000 is exactly zero', n.worst === 1, n.worst);
    check('a neutral verdict offers no remedy', remedy(n) === undefined);

    // The same log against a binary that leaves the learners enabled. The store readings are
    // identical; the CONCLUSION is not, because a store that reads 1.000 while it is still allowed
    // to move says nothing about the store that will exist by the end of the next drive.
    const open = trimNeutrality(points, { tmotMin: 69, tmotMax: 100 });
    check('the same log against a stock window is UNCHECKED, not neutral', open.verdict === 'unknown', open.verdict);
    check('...and it says to arm PATCH', (remedy(open) ?? '').includes('PATCH'));
}

console.log('\n# It fails closed\n');

const W = { tmotMin: 100, tmotMax: 100 };

// ONE sample off init out of sixty-one. The store moved, therefore a learner ran, therefore the
// unreadable store beside it may have moved too — and 0.999 is exactly the size of departure a
// tolerance-based test would have waved through.
const oneOff = points.map((p, i) => (i === 30 ? { ...p, ltft1: 0.999 } : p));
const learned = trimNeutrality(oneOff, W);
check('one sample at 0.999 out of 61 is LEARNED', learned.verdict === 'learned', learned.verdict);
check('...and the verdict names the value the reader will see',
    (remedy(learned) ?? '').includes('0.9990'));

// The half-bank case: a log where only bank 2 has learned. `every` over the banks present is what
// catches it; `some` or an average would let one healthy bank hide the other.
const oneBank = points.map((p, i) => (i === 10 ? { ...p, ltft2: 1.02 } : p));
check('a single learned BANK is LEARNED', trimNeutrality(oneBank, W).verdict === 'learned');

// No channel: the block-19 fallback. Not an old-log case — the car can refuse the RAM read on any
// run — so it must be reported as unchecked rather than assumed either way.
const noLtft = points.map(({ ltft1: _1, ltft2: _2, ...rest }) => rest);
const blind = trimNeutrality(noLtft, W);
check('a log with no ltft is UNCHECKED', blind.verdict === 'unknown', blind.verdict);
check('...and it counts zero samples rather than claiming init', blind.samples === 0 && blind.atInit === 0);
check('...and its remedy names block 19', (remedy(blind) ?? '').includes('block 19'));

// No binary at all. `frozen` is null, which is NOT the same as false and must not become a
// neutral verdict by omission.
const noBin = trimNeutrality(points, null);
check('no binary means UNCHECKED, never neutral', noBin.verdict === 'unknown', noBin.verdict);
check('...with frozen null rather than false', noBin.frozen === null);

// An empty log. Nothing to prove, so nothing is proven.
check('an empty log is UNCHECKED', trimNeutrality([], W).verdict === 'unknown');

console.log('\n# LLS_ST, the other thing #923 settled\n');

// Bit 7 is the idle-valve diagnosis latch, and it is what `ti_load_factor` branches on: set, the
// DME reads the 0.859 idle curve; clear, it reads KF_TI_N_RF. The whole default of
// `requireTiBranchProven: false` rests on this byte being clear on this car.
check('LLS_ST bit 7 is clear on every sample', points.every(p => (p.llsSt & 0x80) === 0));
check('LLS_ST is 0x00 throughout', points.every(p => p.llsSt === 0));

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
