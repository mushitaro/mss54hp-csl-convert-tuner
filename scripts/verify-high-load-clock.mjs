/**
 * The settle clock the dashboard reads and the filter drops samples with — one state machine.
 *
 * It was extracted from `processLogData` so the driver can see it. That only helps if the two agree
 * forever, so this pins the machine itself and `verify:settle` pins that the filter still behaves
 * identically through it.
 *
 * The case that matters most is the DIP. A pull that eases below the floor at nine seconds and
 * comes straight back has banked nothing, because the DME's correction shut and re-stepped — and a
 * readout that kept counting through that would send someone home believing they had the samples.
 *
 *     node scripts/verify-high-load-clock.mjs
 */
import {
    stepHighLoadClock, heldSeconds, EMPTY_HIGH_LOAD_CLOCK,
    HIGH_LOAD_SETTLE_RF_MIN, HIGH_LOAD_RESTEP_RF, HIGH_LOAD_REF_PERIOD_S,
} from '../src/lib/log-engine/highLoadClock.ts';

let fails = 0;
const check = (name, ok, got) => {
    if (!ok) fails++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok || got === undefined ? '' : ' — ' + got}`);
};

/** Run a list of [rf, t] through the clock at one second per unit, returning held seconds each step. */
const run = (steps, spu = 1) => {
    let c = EMPTY_HIGH_LOAD_CLOCK;
    return steps.map(([rf, t]) => {
        c = stepHighLoadClock(c, rf, t, spu);
        return heldSeconds(c, t, spu);
    });
};

console.log('\n[below the floor there is no clock]');
{
    const h = run([[10, 0], [40, 1], [HIGH_LOAD_SETTLE_RF_MIN - 0.01, 2]]);
    check('nothing counts under the floor', h.every(x => x === null), JSON.stringify(h));
    check('the floor itself DOES count',
        run([[HIGH_LOAD_SETTLE_RF_MIN, 0]])[0] === 0, 'the boundary was excluded');
}

console.log('\n[a held pull accumulates]');
{
    const h = run([[60, 0], [60, 1], [60, 2], [60, 3]]);
    check('starts at zero', h[0] === 0, String(h[0]));
    check('counts up with time', h[3] === 3, String(h[3]));
    check('monotone', h.every((x, i) => i === 0 || x > h[i - 1]));
}

console.log('\n[a dip resets it — the case the driver has to see]');
{
    const h = run([[60, 0], [60, 5], [60, 9], [50, 10], [60, 11], [60, 12]]);
    check('nine seconds banked before the dip', h[2] === 9, String(h[2]));
    check('the dip itself reports nothing', h[3] === null, String(h[3]));
    check('re-entry starts from ZERO, not from nine', h[4] === 0, String(h[4]));
    check('and counts again from there', h[5] === 1, String(h[5]));
}

console.log('\n[a re-stab inside the region restarts it]');
{
    // Cruise at 60, then floor it: rf_korr steps as hard as at entry, so the clock must restart.
    const big = 60 + HIGH_LOAD_RESTEP_RF;
    const h = run([[60, 0], [60, 2], [60, 4], [big, 5], [big, 6]]);
    check('four seconds banked at cruise', h[2] === 4, String(h[2]));
    check('the stab restarts the clock', h[3] === 0, String(h[3]));
    check('...and it counts from the stab', h[4] === 1, String(h[4]));
}

console.log('\n[a pull climbing at its own rate does NOT restart it]');
{
    // Measured climb is about 1.7 %RF/s; the restep bar is 15 against a reference at most ~3 s old,
    // so an honest pull must never trip it. This is the false-positive that would make the readout
    // useless: a clock that resets under the driver every few seconds.
    const steps = [];
    for (let t = 0; t <= 20; t++) steps.push([56 + 1.7 * t, t]);
    const h = run(steps);
    check('never restarts during a 20 s climb',
        h.every((x, i) => i === 0 || x > h[i - 1]), JSON.stringify(h.slice(0, 8)));
    check('and reaches the full duration', h[h.length - 1] === 20, String(h[h.length - 1]));
}

console.log('\n[the reference rotates, so a slow climb eventually re-arms the restep test]');
{
    // The reference is refreshed every HIGH_LOAD_REF_PERIOD_S, which is what keeps the restep test
    // measuring a STEP rather than the total climb since entry.
    check('the period is the one the filter documented', HIGH_LOAD_REF_PERIOD_S === 1.5,
        String(HIGH_LOAD_REF_PERIOD_S));
    let c = EMPTY_HIGH_LOAD_CLOCK;
    c = stepHighLoadClock(c, 60, 0, 1);
    const first = c.refTime;
    c = stepHighLoadClock(c, 61, 1, 1);
    check('not rotated before the period elapses', c.refTime === first, String(c.refTime));
    c = stepHighLoadClock(c, 62, 2, 1);
    check('rotated after it', c.refTime === 2, String(c.refTime));
}

console.log('\n[units, so a millisecond log is not a thousand-fold longer pull]');
{
    const ms = run([[60, 0], [60, 6000]], 0.001);
    check('milliseconds scale to seconds', ms[1] === 6, String(ms[1]));
    const sec = run([[60, 0], [60, 6]], 1);
    check('seconds stay seconds', sec[1] === 6, String(sec[1]));
}

console.log('\n[a missing filling reading cannot hold the region open]');
{
    const h = run([[60, 0], [60, 4], [undefined, 5], [60, 6]]);
    check('four seconds banked', h[1] === 4, String(h[1]));
    check('an undefined rf reads as below the floor', h[2] === null, String(h[2]));
    check('...so re-entry is fresh', h[3] === 0, String(h[3]));
}

console.log('\n[the state is serialisable, because the resume carries it]');
{
    let c = EMPTY_HIGH_LOAD_CLOCK;
    c = stepHighLoadClock(c, 60, 0, 1);
    c = stepHighLoadClock(c, 60, 1, 1);
    const revived = JSON.parse(JSON.stringify(c));
    check('a round trip keeps the held time',
        heldSeconds(revived, 5, 1) === heldSeconds(c, 5, 1), String(heldSeconds(revived, 5, 1)));
    check('the empty clock is empty', EMPTY_HIGH_LOAD_CLOCK.enteredAt === null
        && EMPTY_HIGH_LOAD_CLOCK.refTime === null && EMPTY_HIGH_LOAD_CLOCK.refRf === null);
}

console.log(fails === 0 ? '\nALL PASS' : '\n' + fails + ' FAILURE(S)');
process.exit(fails ? 1 : 0);
