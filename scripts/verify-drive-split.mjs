/**
 * The drive-split detector: does it fire on two populations, and stay quiet on one?
 *
 * Both halves matter equally. A detector that misses a split lets a -1 % drive read as -4 % —
 * session #920, the drive this exists for. A detector that invents one teaches the operator to
 * dismiss it, and then it is worse than nothing, because the next real split gets dismissed too.
 * The quiet cases below are therefore not filler: they are the ones that decide whether anybody
 * believes the loud one.
 *
 * Thresholds under test come from measured data — cross-drive agreement on this car is 1.03 %
 * median / 2.47 % max over 52 shared cells, and the #920 episode was 5-7 %. See driveSplit.ts.
 */
import { detectDriveSplit, activeExclusion, DRIVE_SPLIT_DEFAULTS } from '../src/lib/log-engine/driveSplit.ts';

let fails = 0;
const check = (n, c, d) => { console.log('  ' + (c ? 'PASS' : 'FAIL') + '  ' + n + (c ? '' : ' — ' + d)); if (!c) fails++; };

const RPM = [1100, 1400, 1800, 2200, 2700, 3100];
const LOAD = [0.2, 0.4, 0.6, 0.8, 1.1, 1.6];
const AXES = { rpm: RPM, load: LOAD };

/**
 * A drive that visits every cell repeatedly, at 4 Hz.
 *
 * `factorAt(t)` is the mixture story: 1.0 means "the table is right here". The cell walk is
 * deliberately independent of time, so that a detector keying on WHAT WAS DRIVEN rather than on
 * how it burned cannot pass — the first version of this analysis did exactly that.
 */
const drive = (seconds, factorAt, opts = {}) => {
    const rows = [];
    const n = seconds * 4;
    for (let i = 0; i < n; i++) {
        const t = i / 4;
        const r = RPM[i % RPM.length];
        const l = LOAD[Math.floor(i / RPM.length) % LOAD.length];
        // A per-cell offset, so cells genuinely differ from one another and a detector that forgets
        // to pair them sees noise far larger than the split it is looking for.
        const cellBias = 1 + ((i % RPM.length) * 0.013) + ((Math.floor(i / RPM.length) % LOAD.length) * 0.021);
        const wobble = 1 + 0.004 * Math.sin(i / 3);
        rows.push({
            time: t, rpm: r, rawLoad: l, correctedLoad: l, rf: 30 + l * 20,
            stft1: cellBias * factorAt(t) * wobble, stft2: cellBias * factorAt(t) * wobble,
            rfKorr: 1.0, coolantTemp: 85, ...opts,
        });
    }
    return rows;
};

console.log('\n[a homogeneous drive is not a split]');
{
    const out = detectDriveSplit(drive(900, () => 1.0), AXES);
    check('flat drive: silent', out === null, JSON.stringify(out));
    // Slow drift is not two populations. It is one population moving, and excluding "the second
    // half" of a drift would be arbitrary — the honest report for drift is a different feature.
    const drift = detectDriveSplit(drive(900, t => 1.0 - 0.02 * (t / 900)), AXES);
    check('2 % linear drift over 15 min: silent', drift === null, JSON.stringify(drift));
    const noisy = detectDriveSplit(drive(900, t => 1.0 + 0.02 * Math.sin(t / 7)), AXES);
    check('2 % oscillation: silent', noisy === null, JSON.stringify(noisy));
}

console.log('\n[an episode in the middle is found, and named]');
{
    // 6 % lower for minutes 5-15 of a 25-minute drive — #920's shape and roughly its size.
    const out = detectDriveSplit(drive(1500, t => (t >= 300 && t < 900) ? 0.94 : 1.0), AXES);
    check('fires', out !== null);
    if (out) {
        check('gap is about -6 %', Math.abs(out.gapPct + 6) < 1.2, out.gapPct.toFixed(2));
        check('start is found within 30 s', Math.abs(out.odd.from - 300) <= 30, String(out.odd.from));
        check('end is found within 30 s', Math.abs(out.odd.to - 900) <= 30, String(out.odd.to));
        check('the ODD stretch is the minority, not the drive', out.oddFraction < 0.5, out.oddFraction.toFixed(2));
        check('enough shared cells to mean something', out.sharedCells >= DRIVE_SPLIT_DEFAULTS.minSharedCells,
            String(out.sharedCells));
    }
}

console.log('\n[a step at the end is found too]');
{
    const out = detectDriveSplit(drive(1200, t => t >= 800 ? 1.05 : 1.0), AXES);
    check('fires', out !== null);
    if (out) {
        check('gap is about +5 %', Math.abs(out.gapPct - 5) < 1.2, out.gapPct.toFixed(2));
        check('names the tail, not the head', out.odd.from > 700, String(out.odd.from));
    }
}

console.log('\n[the threshold sits between measured agreement and a real episode]');
{
    // 2.4 % is this car's worst cross-drive cell disagreement. It must not read as a split.
    const quiet = detectDriveSplit(drive(1500, t => (t >= 300 && t < 900) ? 0.976 : 1.0), AXES);
    check('2.4 % episode: silent (that is measurement scatter)', quiet === null, JSON.stringify(quiet));
    const loud = detectDriveSplit(drive(1500, t => (t >= 300 && t < 900) ? 0.955 : 1.0), AXES);
    check('4.5 % episode: fires', loud !== null);
}

console.log('\n[what it refuses to judge]');
{
    check('too few samples', detectDriveSplit(drive(20, () => 1.0), AXES) === null);
    const short = drive(180, t => t >= 60 && t < 90 ? 0.9 : 1.0);
    check('a 30 s excursion is an event, not a population', detectDriveSplit(short, AXES) === null);
    // No rfKorr means the correction cannot be compared across stretches at all.
    const noKorr = drive(900, t => (t >= 300 && t < 600) ? 0.94 : 1.0).map(({ rfKorr, ...r }) => r);
    check('no rfKorr: silent rather than guessing', detectDriveSplit(noKorr, AXES) === null);
}

console.log('\n[a log that counts in milliseconds is judged in the same seconds]');
{
    const ms = drive(1500, t => (t >= 300 && t < 900) ? 0.94 : 1.0).map(r => ({ ...r, time: r.time * 1000 }));
    const wrong = detectDriveSplit(ms, AXES);
    const right = detectDriveSplit(ms, AXES, { secondsPerUnit: 0.001 });
    check('told the scale, it finds the same episode', right !== null && Math.abs(right.gapPct + 6) < 1.2,
        JSON.stringify(right));
    check('and the span is the same 10 minutes', right !== null
        && Math.abs((right.odd.to - right.odd.from) / 1000 - 600) <= 60,
        right ? String((right.odd.to - right.odd.from) / 1000) : '-');
    // Not asserting `wrong === null`: without the scale the seconds-based guards are simply wrong,
    // and what they do then is undefined behaviour, not a contract. The point is that the caller
    // passes the scale — useVeCalculation reads it from timeScaleSeconds, same as the filters.
    check('the scale is what makes it right, not luck', JSON.stringify(wrong) !== JSON.stringify(right));
}

console.log('\n[the notice survives its own decision]');
{
    // The regression this section exists for. EXCLUDE removes the odd stretch from the log, so the
    // detector then correctly finds NOTHING -- and the first version drove the whole notice off the
    // detector, so chip, bar and RESTORE all vanished while the exclusion stayed in force. A
    // control must not strand the value it set, so the excluded state is read from the config.
    const split = detectDriveSplit(drive(1500, t => (t >= 300 && t < 900) ? 0.94 : 1.0), AXES);
    check('a split is found to act on', split !== null);

    const cfg = { excludeTimeRanges: [[split.odd.from, split.odd.to]] };
    const span = activeExclusion(cfg);
    check('the config still names the stretch after the log stops containing it', span !== null
        && span.from === split.odd.from && span.to === split.odd.to, JSON.stringify(span));

    const remaining = drive(1500, t => (t >= 300 && t < 900) ? 0.94 : 1.0)
        .filter(r => !(r.time >= split.odd.from && r.time < split.odd.to));
    check('the detector goes quiet on what remains -- as it should',
        detectDriveSplit(remaining, AXES) === null);
    check('...and the notice is still shown, because the CONFIG says so',
        activeExclusion(cfg) !== null);

    check('no exclusion, no notice', activeExclusion({}) === null && activeExclusion(undefined) === null
        && activeExclusion({ excludeTimeRanges: [] }) === null);
    check('a nonsense range is not a state to be stuck in',
        activeExclusion({ excludeTimeRanges: [[500, 500]] }) === null
        && activeExclusion({ excludeTimeRanges: [[900, 300]] }) === null);
}

console.log(fails === 0 ? '\nAll drive-split checks passed.\n' : `\n${fails} check(s) FAILED.\n`);
process.exit(fails ? 1 : 0);
