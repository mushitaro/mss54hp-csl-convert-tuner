/**
 * The PULL clock on the live drive strip — how long the pedal has been held still.
 *
 *     start     wdk1 >= 15 %                         (PULL_MIN_WDK)
 *     continue  |wdk1 − wdk1 at the start| <= 2      (PULL_WDK_BAND), still >= 15 %
 *     end       out of the band, or lifted under 15 % — a new hold may start on that sample
 *     shown     the running hold, live, once it reaches 2 s (PULL_SHOWN_MIN_SEC); until then the
 *               last hold of 2 s or more, dimmed; the running one from zero if there is none
 *
 * What a wrong answer costs is a driver reading a number that is not the pull they just made: a
 * short wobble that wiped the last pull off the screen, or a hold that kept counting after the
 * pedal moved. Synthetic samples only; time in seconds, as the live links stamp it.
 */
import {
    stepPullClock, pullReading, EMPTY_PULL_CLOCK,
    PULL_MIN_WDK, PULL_WDK_BAND, PULL_SHOWN_MIN_SEC,
} from '../src/lib/log-engine/pullClock.ts';

let fails = 0;
const check = (n, c, d) => { console.log('  ' + (c ? 'PASS' : 'FAIL') + '  ' + n + (c ? '' : ' — ' + d)); if (!c) fails++; };
const near = (a, b) => Math.abs(a - b) < 1e-9;

/** Runs [time, wdk] pairs through the clock; returns the final state. */
const run = (samples, from = EMPTY_PULL_CLOCK) =>
    samples.reduce((s, [time, wdk]) => stepPullClock(s, { time, wdk }), from);
/** wdk held at `w` from t0 to t1 inclusive, every `dt` seconds. */
const hold = (t0, t1, w, dt = 0.25) => {
    const out = [];
    for (let t = t0; t <= t1 + 1e-9; t += dt) out.push([Math.round(t * 1000) / 1000, w]);
    return out;
};
const fmt = (r) => r === null ? 'null' : `${r.sec.toFixed(2)} s ${r.live ? 'live' : 'dim'}`;

console.log('\n[the constants are the ones the analysis and the drive data justify]');
check('a hold starts at 15 %', PULL_MIN_WDK === 15);
check('the band is ±2 points — the log analysis\'s pedal-hold band', PULL_WDK_BAND === 2);
check('a hold has to reach 2 s to replace the one on screen', PULL_SHOWN_MIN_SEC === 2);

console.log('\n[a hold starts at 15 % and not below]');
{
    check('nothing yet reads —', pullReading(EMPTY_PULL_CLOCK) === null);
    check('14.9 % starts nothing', run([[0, 14.9], [1, 14.9], [3, 14.9]]).active === null);
    const s = run([[0, 15]]);
    check('15 % starts a hold', s.active !== null && s.active.startWdk === 15, JSON.stringify(s));
    check('an absent WDK starts nothing', run([[0, undefined], [1, null], [2, NaN]]).active === null);
}

console.log('\n[the active hold shows live seconds]');
{
    // The first hold of the run: nothing earlier to keep, so it shows from zero.
    const s = run(hold(10, 11.5, 30));
    const r = pullReading(s);
    check('1.5 s into the first hold: 1.5 s, live', r !== null && r.live && near(r.sec, 1.5), fmt(r));
    const t = run(hold(10, 16, 30));
    const q = pullReading(t);
    check('6 s in: 6.0 s, live', q !== null && q.live && near(q.sec, 6), fmt(q));
}

console.log('\n[it continues inside ±2 of where it started]');
{
    // Wander up to the edge of the band either way — still one hold.
    const s = run([[0, 30], [1, 31.5], [2, 32], [3, 28], [4, 29.2], [5, 30.8]]);
    const r = pullReading(s);
    check('30 → 32 → 28 → 30.8 over 5 s is one 5 s hold', r !== null && r.live && near(r.sec, 5), fmt(r));
    check('...measured from where it started', s.active?.startWdk === 30 && s.active?.startTime === 0, JSON.stringify(s.active));
    // The band is anchored on the start, not dragged along: a slow creep is not a hold.
    const creep = run([[0, 30], [1, 31.5], [2, 33], [3, 34.5]]);
    check('a slow creep out of the start band ends it (anchored, not trailing)',
        creep.active?.startWdk === 33, JSON.stringify(creep.active));
}

console.log('\n[it ends on leaving the band, or on a lift]');
{
    // Held 5 s at 30 %, then squeezed to 40 %: the hold ends at its last in-band sample, and a new
    // one starts at 40.
    const s = run([...hold(0, 5, 30), [5.25, 40]]);
    check('leaving the band ends it: 5 s kept as the last hold', near(s.lastSec, 5), String(s.lastSec));
    check('...and a new hold starts at the new position', s.active?.startWdk === 40 && s.active?.startTime === 5.25,
        JSON.stringify(s.active));
    const r = pullReading(s);
    check('...while the new one is under 2 s the screen keeps 5.0 s, dimmed', r !== null && !r.live && near(r.sec, 5), fmt(r));

    // Lift to 10 %: no new hold.
    const lift = run([...hold(0, 4, 30), [4.25, 10]]);
    check('a lift under 15 % ends it with no new hold', lift.active === null && near(lift.lastSec, 4),
        JSON.stringify(lift));
    const l = pullReading(lift);
    check('...and 4.0 s stays up, dimmed', l !== null && !l.live && near(l.sec, 4), fmt(l));

    // A sample the link did not report ends it too.
    const gap = run([...hold(0, 3, 30), [3.25, undefined]]);
    check('a sample with no WDK ends it', gap.active === null && near(gap.lastSec, 3), JSON.stringify(gap));
}

console.log('\n[a hold under 2 s does not replace the last one shown]');
{
    // An 8 s pull, then part-throttle wobble: holds of 0.5-1.5 s at 18-25 %.
    const pull = run([...hold(0, 8, 30), [8.25, 5]]);
    const wobble = run([
        ...hold(10, 11.5, 18), ...hold(11.75, 12.25, 22), ...hold(12.5, 13.75, 25), [14, 5],
    ], pull);
    check('the wobble left lastSec at the 8 s pull', near(wobble.lastSec, 8), String(wobble.lastSec));
    const r = pullReading(wobble);
    check('the screen still shows 8.0 s, dimmed', r !== null && !r.live && near(r.sec, 8), fmt(r));

    // During one of those short holds, too — not just after it.
    const mid = run(hold(10, 11, 18), pull);
    const m = pullReading(mid);
    check('a running hold of 1 s does not take the screen from 8.0 s', m !== null && !m.live && near(m.sec, 8), fmt(m));

    // A new hold that reaches 2 s does replace it — live from that moment.
    const next = run(hold(20, 22, 26), wobble);
    const n = pullReading(next);
    check('a new hold at 2.0 s takes the screen, live', n !== null && n.live && near(n.sec, 2), fmt(n));
    const done = run([[22.25, 5]], next);
    const d = pullReading(done);
    check('...and when it ends it is the one kept', d !== null && !d.live && near(d.sec, 2), fmt(d));
}

console.log(fails === 0 ? '\nALL PASS' : '\n' + fails + ' FAILURE(S)');
process.exit(fails ? 1 : 0);
