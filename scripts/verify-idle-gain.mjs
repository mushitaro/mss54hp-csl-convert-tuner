/**
 * The idle campaign's gain learner, and the arming record the write reproduces from.
 *
 * `gain.ts` shipped able to learn and with no caller for as long as the write was sealed. This is
 * the suite for the half that was missing — `campaign.ts` — plus the two facts the reproduction
 * depends on: the pair is measured AT THE OPERATING POINT, and `writeIdle` is what says a session
 * armed one.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readIdleTables, llsTvAt as llsTvAtTables } from '../src/lib/idle/idleTables.ts';
import { llsTvAt, llsTvSlopePctPerKgH } from '../src/lib/idle/valveModel.ts';
import { runPoint, pairFromRuns, learnIdleGain } from '../src/lib/idle/campaign.ts';
import { learnGain, GAIN_LEARN_DEFAULTS } from '../src/lib/idle/gain.ts';
import { IDLE_TUNE_DEFAULTS } from '../src/lib/idle/types.ts';

const binPath = fileURLToPath(new URL('../public/mock/csl-0401-community-patch-v1.partial.bin', import.meta.url));
const buf = fs.readFileSync(binPath);
const base = readIdleTables(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

let fails = 0;
const check = (n, c, d) => { console.log('  ' + (c ? 'PASS' : 'FAIL') + '  ' + n + (c ? '' : ' — ' + (d ?? ''))); if (!c) fails++; };

const RPM = 880;
const AIR = 14;

/** A run held at one operating point with a given standing error. Two dwells, as the cell gate wants. */
function run(mdLlri, tables, rpm = RPM, air = AIR) {
    const duty = llsTvAtTables(tables, rpm, air);
    const mk = t => ({
        time: t, rpm, coolantTemp: 85, wdk1: 0.4, rf: null, nSoll: rpm, ub: 14.1,
        mdLlri, mdLlra: 0, mdLlraKo: 0, llsTv: duty, llrQvs: air, llrQsoll: air,
        mlSoll: air, mlSollLls: air, mlSollMaxLls: 40, engineState: 4, kkosSt: 0,
    });
    const out = [];
    for (let t = 0; t < 25; t += 1 / 3) out.push(mk(t));
    out.push({ ...mk(30), wdk1: 3 });
    for (let t = 60; t < 85; t += 1 / 3) out.push(mk(t));
    return out;
}

/** The same tables with a duty delta written into the two cells the operating point reads. */
function withDelta(tables, deltaPct) {
    const values = tables.llsTv.values.map(r => [...r]);
    values[1][2] += deltaPct;
    values[1][3] += deltaPct;
    return { ...tables, llsTv: { ...tables.llsTv, values } };
}

console.log('\n[a run reduces to one operating point]');
{
    const p = runPoint(run(-4, base), base);
    check('a run with accepted dwells yields a point', !!p);
    check('...at the rpm it was held at', Math.abs(p.rpm - RPM) < 1, p.rpm);
    check('...at the air it was held at', Math.abs(p.air - AIR) < 0.1, p.air);
    // md_llri -4, md_llra 0, target -7 -> error +3.
    check('...with the error the fixture holds', Math.abs(p.errorNm - 3.0) < 0.2, p.errorNm);
    check('...and both dwells behind it', p.dwells === 2, p.dwells);

    const none = runPoint(run(-4, base).slice(0, 5), base);
    check('a run that accepts nothing yields no point, not a weak one', none === null);
}

console.log('\n[the pair is measured at the operating point, not at a breakpoint]');
{
    // Both cells moved by +2.0 %, so the duty AT the point moves by 2.0 x (0.350 + 0.400) = 1.5 %.
    // A cell-delta implementation would report 2.0 and learn a gain 33 % too small.
    const after = withDelta(base, 2.0);
    const pair = pairFromRuns(
        { samples: run(-4, base), tables: base },
        { samples: run(-5.5, after), tables: after });
    check('a pair is formed', !!pair);
    const atPoint = llsTvAt(after.llsTv, RPM, AIR) - llsTvAt(base.llsTv, RPM, AIR);
    check('the duty delta is the one the DME sees',
        Math.abs(pair.deltaDutyPct - atPoint) < 1e-6, `${pair.deltaDutyPct} vs ${atPoint}`);
    check('...which is LESS than the cell delta, because the point sits between cells',
        pair.deltaDutyPct < 2.0 - 1e-9, pair.deltaDutyPct.toFixed(3));
    check('the error delta is the change in standing effort',
        Math.abs(pair.deltaErrorNm - (-1.5)) < 0.2, pair.deltaErrorNm);
    check('...and the rpm is carried so the pool can normalise it',
        Math.abs(pair.rpm - RPM) < 1, pair.rpm);

    const none = pairFromRuns(
        { samples: run(-4, base).slice(0, 5), tables: base },
        { samples: run(-5.5, after), tables: after });
    check('a pair against a run that measured nothing is null', none === null);
}

console.log('\n[the learner recovers a gain it was given]');
{
    // Build a synthetic campaign whose true gain is known. Duty moves by d; the error responds by
    // -d/g. Pick g = 0.80 %/Nm, comfortably inside gainMin..gainMax.
    const G = 0.80;
    const err0 = 3.0;
    const runs = [{ samples: run(-4, base), tables: base }];
    for (const d of [2.0, 4.0]) {
        const t = withDelta(base, d);
        const atPoint = llsTvAt(t.llsTv, RPM, AIR) - llsTvAt(base.llsTv, RPM, AIR);
        const err = err0 - atPoint / G;
        runs.push({ samples: run(-7 + err, t), tables: t });
    }
    const learned = learnIdleGain(runs);
    check('it reports having learned', learned.learned === true);
    check('...and lands near the gain the campaign actually had',
        Math.abs(learned.gain - G) < 0.15, learned.gain.toFixed(3));
    check('...inside the plausibility rails',
        learned.gain >= IDLE_TUNE_DEFAULTS.gainMin && learned.gain <= IDLE_TUNE_DEFAULTS.gainMax, learned.gain);

    check('one run alone cannot learn anything', learnIdleGain(runs.slice(0, 1)).learned === false);
    // THE UNIT PIN. The fallback is the prior CONVERTED into the map's own unit -- slope x g_air,
    // 2.25 x 0.40 = 0.90 %/Nm -- not the raw 0.40 (kg/h)/Nm the options hold. Handing the air
    // number to a duty learner is what pulled a true 0.80 down to 0.606 before this existed, and it
    // failed quietly: the pool came back plausible and wrong.
    const one = learnIdleGain(runs.slice(0, 1));
    const slope = llsTvSlopePctPerKgH(base.llsTv, RPM, AIR);
    check('...and falls back to the prior CONVERTED into %/Nm, not the raw air gain',
        Math.abs(one.gain - slope * IDLE_TUNE_DEFAULTS.gainKgHPerNm) < 1e-9,
        `${one.gain} vs ${slope * IDLE_TUNE_DEFAULTS.gainKgHPerNm}`);
    check('...which is NOT the air constant itself',
        Math.abs(one.gain - IDLE_TUNE_DEFAULTS.gainKgHPerNm) > 0.1, one.gain);
    check('an empty campaign is not an error', learnIdleGain([]).learned === false);
}

console.log('\n[what the learner refuses]');
{
    const mk = (deltaDutyPct, deltaErrorNm) => ({ deltaDutyPct, deltaErrorNm, rpm: RPM });
    const opts = { gainMin: IDLE_TUNE_DEFAULTS.gainMin, gainMax: IDLE_TUNE_DEFAULTS.gainMax, gainRefRpm: IDLE_TUNE_DEFAULTS.gainRefRpm };
    const why = (pairs) => learnGain(pairs, IDLE_TUNE_DEFAULTS.gainKgHPerNm, opts).rejected.map(r => r.why);

    check('a pass that barely moved the error is not divided by',
        why([mk(2.0, -0.2)])[0] === 'delta-too-small');
    check('a pass that barely wrote anything is refused',
        why([mk(0.01, -2.0)])[0] === 'step-too-small');
    // MORE duty and MORE standing effort. Something other than the feedforward moved.
    check('a sign-inverted pass STOPS the iteration rather than averaging in',
        why([mk(2.0, +2.0)])[0] === 'sign-inverted');
    check('an implausible slope is refused',
        why([mk(20.0, -1.5)])[0] === 'implausible-gain');
    check('...and a refused-only pool reports NOT learned',
        learnGain([mk(2.0, +2.0)], IDLE_TUNE_DEFAULTS.gainKgHPerNm, opts).learned === false);
    check('the step threshold is well above one LSB of KF_LLS_TV',
        GAIN_LEARN_DEFAULTS.minStepPct > base.llsTvStepPct * 5,
        `${GAIN_LEARN_DEFAULTS.minStepPct} vs ${base.llsTvStepPct}`);
}

console.log('\n' + (fails ? `\n${fails} FAILURE(S)` : '\nALL PASS'));
process.exit(fails ? 1 : 0);
