/**
 * Does a BRIEF lift really restart the high-load excursion, or only the clock that models it?
 *
 * The settle gate resets the moment filling drops below `kl_rf_korr_rf_min`, on the reasoning that
 * the DME's correction shuts, `rf_korr` snaps to 1.000, and re-entry is a fresh step the lambda
 * trim has to walk after again. That reasoning is right about the mechanism and says nothing about
 * the TIME CONSTANT, and the difference is the whole cost of the gate to whoever is driving: a
 * gearchange, a bump, a corner, a car pulling out — each throws away every second banked so far.
 *
 * The state that makes a re-entry "fresh" is not the filling. It is
 *
 *     Delta = model - TABG
 *
 * because that is what `KF_RF_KORR_DRREL` is indexed on. TABG is an exhaust-gas temperature behind a
 * sensor with a lag measured in seconds; a 0.4 s lift cannot move it far. If Delta is where it was,
 * the correction steps back to the value the trim had ALREADY caught up to, and the trim — whose
 * integrator also does not reset — is still converged. Nothing about that is a fresh excursion.
 *
 * So this measures, over every stored drive:
 *
 *   1. how far TABG actually moves across a dip, against the dip's duration
 *   2. and the test that settles it: after re-entry, is the correction biased the way a FRESH
 *      excursion is (about +10 % at age 0-2 s, from the table in filter.ts), or is it sitting where
 *      the converged samples before the dip were?
 *
 * (2) is the one that matters. (1) only explains it.
 *
 *     node scripts/analyze-dip-tolerance.mjs <session-dir> [<session-dir> ...]
 */
import fs from 'node:fs';
import path from 'node:path';

const NL = '\n';
const dirs = process.argv.slice(2);
if (!dirs.length) {
    console.error('usage: node scripts/analyze-dip-tolerance.mjs <session-dir> [...]');
    process.exit(2);
}

const RF_FLOOR = 55;
/** Age at which filter.ts considers the excursion over — the bar this is asking to relax. */
const SETTLED_AGE_S = 6;

/** Seconds per time unit, by the same discrimination the filter uses. */
const scale = (log) => {
    const steps = [];
    for (let i = 1; i < Math.min(log.length, 201); i++) {
        const d = log[i].time - log[i - 1].time;
        if (d > 0) steps.push(d);
    }
    steps.sort((a, b) => a - b);
    const med = steps[Math.floor(steps.length / 2)] ?? 1;
    return med >= 5 ? 0.001 : 1;
};

/** trim x rf_korr is what the VE correction is built from; without rf_korr the trim alone is it. */
const corr = (p) => {
    const t1 = p.stft1, t2 = p.stft2;
    if (t1 === undefined && t2 === undefined) return null;
    const trim = ((t1 ?? t2) + (t2 ?? t1)) / 2;
    const l1 = p.ltft1 ?? 1, l2 = p.ltft2 ?? 1;
    return trim * ((l1 + l2) / 2);
};

const dips = [];
let totalAbove = 0;

for (const dir of dirs) {
    const log = JSON.parse(fs.readFileSync(path.join(dir, 'log.json'), 'utf8'));
    const spu = scale(log);
    const name = path.basename(dir);

    let runStart = null;          // index where the current above-floor run began
    let i = 0;
    while (i < log.length) {
        const above = (log[i].rf ?? 0) >= RF_FLOOR;
        if (above && runStart === null) runStart = i;
        if (!above && runStart !== null) {
            // A run ended. Measure the dip that follows and, if the run resumes, what came back.
            const lastAbove = i - 1;
            const ageBefore = (log[lastAbove].time - log[runStart].time) * spu;
            totalAbove++;
            let j = i;
            while (j < log.length && (log[j].rf ?? 0) < RF_FLOOR) j++;
            if (j < log.length && ageBefore >= SETTLED_AGE_S) {
                const dipSec = (log[j].time - log[lastAbove].time) * spu;
                // What the pull had converged to, over its last 2 s above the floor.
                const tailFrom = log.findIndex((p, k) => k <= lastAbove && k >= runStart
                    && (log[lastAbove].time - p.time) * spu <= 2);
                const tail = log.slice(Math.max(tailFrom, runStart), lastAbove + 1)
                    .map(corr).filter(v => v !== null);
                // What the first 2 s after re-entry read.
                const headEnd = log.findIndex((p, k) => k >= j
                    && (p.time - log[j].time) * spu > 2);
                const head = log.slice(j, headEnd < 0 ? log.length : headEnd)
                    .map(corr).filter(v => v !== null);
                const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
                if (tail.length >= 3 && head.length >= 3) {
                    dips.push({
                        name, dipSec,
                        tabgBefore: log[lastAbove].exhaustTemp,
                        tabgAfter: log[j].exhaustTemp,
                        before: mean(tail), after: mean(head),
                        ageBefore,
                    });
                }
            }
            runStart = null;
            i = j;
            continue;
        }
        i++;
    }
}

console.log(NL + '='.repeat(92));
console.log('WHAT A DIP BELOW ' + RF_FLOOR + ' %RF ACTUALLY COSTS');
console.log('='.repeat(92));
console.log('  drives            ' + dirs.length);
console.log('  above-floor runs  ' + totalAbove);
console.log('  usable dips       ' + dips.length
    + '   (run reached ' + SETTLED_AGE_S + ' s before the dip, and resumed)');

if (!dips.length) {
    console.log(NL + '  Nothing to measure. No stored drive lifts out of a settled pull and returns.');
    process.exit(0);
}

const bands = [[0, 0.5], [0.5, 1], [1, 2], [2, 5], [5, 1e9]];
console.log(NL + '  dip length      n    |dTABG|      correction before -> after      shift');
for (const [lo, hi] of bands) {
    const g = dips.filter(d => d.dipSec >= lo && d.dipSec < hi);
    if (!g.length) continue;
    const m = (f) => g.map(f).reduce((s, v) => s + v, 0) / g.length;
    const dt = g.filter(d => d.tabgBefore !== undefined && d.tabgAfter !== undefined);
    const dTabg = dt.length ? dt.map(d => Math.abs(d.tabgAfter - d.tabgBefore))
        .reduce((s, v) => s + v, 0) / dt.length : NaN;
    const shift = m(d => d.after - d.before);
    console.log('  ' + (hi > 1e8 ? `${lo}+ s` : `${lo}-${hi} s`).padStart(10)
        + String(g.length).padStart(6)
        + (Number.isNaN(dTabg) ? '      —' : (dTabg.toFixed(0) + ' °C').padStart(9))
        + '      ' + m(d => d.before).toFixed(4) + ' -> ' + m(d => d.after).toFixed(4)
        + '     ' + (shift >= 0 ? '+' : '') + (100 * shift).toFixed(2) + ' %');
}

console.log(NL + '  READ IT AGAINST THE FRESH-EXCURSION NUMBER. filter.ts measured a fresh entry at');
console.log('  +9.3 to +9.6 % over its first 2 s. A dip band whose shift is FAR below that did not');
console.log('  restart the excursion, whatever the gate assumed — and the clock could have kept');
console.log('  running through it.');

console.log(NL + '  every dip, longest first:');
console.log('    drive     age before   dip     TABG          before -> after     shift');
for (const d of dips.sort((a, b) => b.dipSec - a.dipSec).slice(0, 40)) {
    console.log('    ' + d.name.padEnd(8)
        + (d.ageBefore.toFixed(1) + ' s').padStart(10)
        + (d.dipSec.toFixed(2) + ' s').padStart(9)
        + ((d.tabgBefore ?? '?') + '->' + (d.tabgAfter ?? '?')).padStart(13)
        + '      ' + d.before.toFixed(4) + ' -> ' + d.after.toFixed(4)
        + '     ' + ((d.after - d.before) >= 0 ? '+' : '') + (100 * (d.after - d.before)).toFixed(2) + ' %');
}
