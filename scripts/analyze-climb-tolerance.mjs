/**
 * At high load, does the rpm-stability test still buy anything the settle clock has not already?
 *
 * A cell at 65-100 % opening and 1800-2400 rpm needs FOUR things at once:
 *
 *     throttle 65 %+ open          the row axis is opening, not filling
 *     filling >= 55 %RF for 6 s    the settle clock, measured, keeps 5.2 % of bias out
 *     rpm climbing < 10 % / 2 s    the transient test — about 90 rpm/s at 1800
 *     opening moving < 5 pts / 2 s the same test on the other axis
 *
 * The third one is the problem. Open an E46 M3's throttle two thirds in any gear it will pull from
 * 1800 rpm and it climbs far faster than 90 rpm/s; the combination is reachable on a long gradient
 * and close to unreachable on flat road. Session #924 is what that looks like from the driver's
 * seat: 399 raw samples above the filling floor in that rpm window, 92 surviving, and every one of
 * them at 3-7 % opening because the only way to be there for long is to barely open the throttle.
 *
 * So: is the rpm test doing work at high load, or is it a second proxy for the convergence the
 * settle clock already timed? Both exist for the SAME reason — that the lambda trim lags what the
 * engine just did — and one of them is measured while the other is a default.
 *
 * The test: among samples that ALREADY cleared the settle clock, plot the correction against how
 * fast rpm was climbing. If the correction does not move with climb rate, the rpm test is refusing
 * evidence that is no different from the evidence it keeps.
 *
 *     node scripts/analyze-climb-tolerance.mjs <session-dir> [<session-dir> ...]
 */
import fs from 'node:fs';
import path from 'node:path';

const NL = '\n';
const dirs = process.argv.slice(2);
if (!dirs.length) {
    console.error('usage: node scripts/analyze-climb-tolerance.mjs <session-dir> [...]');
    process.exit(2);
}

const RF_FLOOR = 55;
const SETTLE_S = 6;

const scale = (log) => {
    const steps = [];
    for (let i = 1; i < Math.min(log.length, 201); i++) {
        const d = log[i].time - log[i - 1].time;
        if (d > 0) steps.push(d);
    }
    steps.sort((a, b) => a - b);
    return (steps[Math.floor(steps.length / 2)] ?? 1) >= 5 ? 0.001 : 1;
};

const corr = (p) => {
    if (p.stft1 === undefined && p.stft2 === undefined) return null;
    const trim = ((p.stft1 ?? p.stft2) + (p.stft2 ?? p.stft1)) / 2;
    return trim * (((p.ltft1 ?? 1) + (p.ltft2 ?? 1)) / 2);
};

const rows = [];
for (const dir of dirs) {
    const log = JSON.parse(fs.readFileSync(path.join(dir, 'log.json'), 'utf8'));
    const spu = scale(log);
    let enteredAt = null;
    for (let i = 0; i < log.length; i++) {
        const p = log[i];
        const rf = p.rf ?? 0;
        if (rf < RF_FLOOR) { enteredAt = null; continue; }
        if (enteredAt === null) enteredAt = p.time;
        const age = (p.time - enteredAt) * spu;
        if (age < SETTLE_S) continue;                       // already settled only
        // Climb rate over the same 2 s window the transient test looks back across.
        let j = i;
        while (j > 0 && (p.time - log[j].time) * spu < 2) j--;
        const dt = (p.time - log[j].time) * spu;
        if (dt <= 0 || log[j].rpm <= 0) continue;
        const c = corr(p);
        if (c === null) continue;
        rows.push({
            climbPct: Math.abs((p.rpm - log[j].rpm) / log[j].rpm) * 100,
            climbRpmS: (p.rpm - log[j].rpm) / dt,
            openDelta: Math.abs(p.rawLoad - log[j].rawLoad),
            corr: c, rpm: p.rpm, rf, age,
        });
    }
}

console.log(NL + '='.repeat(92));
console.log('DOES THE CORRECTION MOVE WITH RPM CLIMB, ONCE THE PULL HAS SETTLED?');
console.log('='.repeat(92));
console.log('  settled high-load samples: ' + rows.length + '  (rf >= ' + RF_FLOOR
    + ' %RF held ' + SETTLE_S + ' s+)');
if (rows.length < 30) {
    console.log(NL + '  Too few to say anything. Nothing is concluded from this.');
    process.exit(0);
}

const stat = (g) => {
    const v = g.map(r => r.corr).sort((a, b) => a - b);
    const mean = v.reduce((s, x) => s + x, 0) / v.length;
    const sd = Math.sqrt(v.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, v.length - 1));
    return { n: v.length, mean, sd, se: sd / Math.sqrt(v.length) };
};

const bands = [[0, 2.5], [2.5, 5], [5, 10], [10, 20], [20, 1e9]];
console.log(NL + '  rpm change over 2 s      n     correction        vs the stable band');
const base = stat(rows.filter(r => r.climbPct < 2.5));
for (const [lo, hi] of bands) {
    const g = rows.filter(r => r.climbPct >= lo && r.climbPct < hi);
    if (g.length < 5) continue;
    const s = stat(g);
    const d = s.mean - base.mean;
    const se = Math.sqrt(s.se ** 2 + base.se ** 2);
    console.log('  ' + (hi > 1e8 ? `${lo}%+` : `${lo}-${hi} %`).padStart(12)
        + String(s.n).padStart(9)
        + '   ' + s.mean.toFixed(4) + ' +/- ' + s.se.toFixed(4)
        + '     ' + (d >= 0 ? '+' : '') + (100 * d).toFixed(2) + ' % +/- ' + (100 * se).toFixed(2)
        + (Math.abs(d) > 2 * se ? '   <- differs' : ''));
}

console.log(NL + '  THE CURRENT BAR IS 10 %. Everything above it is refused today. If those bands sit');
console.log('  on top of the stable one, the test is refusing evidence no different from what it');
console.log('  keeps — and it is the reason a 65 % opening at 1800 rpm cannot be logged on a road.');

// The same question asked of the OTHER half of the transient test.
console.log(NL + '  opening change over 2 s   n     correction        vs the steady band');
const obase = stat(rows.filter(r => r.openDelta < 2.5));
for (const [lo, hi] of [[0, 2.5], [2.5, 5], [5, 10], [10, 1e9]]) {
    const g = rows.filter(r => r.openDelta >= lo && r.openDelta < hi);
    if (g.length < 5) continue;
    const s = stat(g);
    const d = s.mean - obase.mean;
    const se = Math.sqrt(s.se ** 2 + obase.se ** 2);
    console.log('  ' + (hi > 1e8 ? `${lo}+ pts` : `${lo}-${hi} pts`).padStart(13)
        + String(s.n).padStart(8)
        + '   ' + s.mean.toFixed(4) + ' +/- ' + s.se.toFixed(4)
        + '     ' + (d >= 0 ? '+' : '') + (100 * d).toFixed(2) + ' % +/- ' + (100 * se).toFixed(2)
        + (Math.abs(d) > 2 * se ? '   <- differs' : ''));
}

/**
 * The 5-10 % climb band came out high while the bands ABOVE it did not, which is not what a real
 * dependence on climb rate looks like. The obvious confound is the other half of the same test: a
 * sample whose rpm is climbing is often one whose throttle was just moved. So ask the question
 * again with the throttle held still, and then with it moving.
 */
console.log(NL + '  CONTROLLING FOR THE THROTTLE. Correction vs rpm climb, split by opening delta:');
for (const [olo, ohi, label] of [[0, 5, 'throttle STILL (<5 pts / 2 s)'], [5, 1e9, 'throttle MOVING (5+ pts)']]) {
    const sub = rows.filter(r => r.openDelta >= olo && r.openDelta < ohi);
    if (sub.length < 30) continue;
    const b = stat(sub.filter(r => r.climbPct < 2.5));
    console.log(NL + '    ' + label + '   n=' + sub.length);
    console.log('      rpm change      n     correction        vs stable');
    for (const [lo, hi] of bands) {
        const g = sub.filter(r => r.climbPct >= lo && r.climbPct < hi);
        if (g.length < 5) continue;
        const s = stat(g);
        const d = s.mean - b.mean;
        const se = Math.sqrt(s.se ** 2 + b.se ** 2);
        console.log('      ' + (hi > 1e8 ? `${lo}%+` : `${lo}-${hi} %`).padStart(10)
            + String(s.n).padStart(7)
            + '   ' + s.mean.toFixed(4) + ' +/- ' + s.se.toFixed(4)
            + '     ' + (d >= 0 ? '+' : '') + (100 * d).toFixed(2) + ' % +/- ' + (100 * se).toFixed(2)
            + (Math.abs(d) > 2 * se ? '   <- differs' : ''));
    }
}
