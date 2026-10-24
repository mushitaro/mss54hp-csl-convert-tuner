/**
 * The whole map and the whole run, for the assistant in the car (#984 notebook, 2026-10-24).
 *
 *   veOverview   read off a real calculation — the app's own VECalculator on a tiny synthetic drive:
 *                the counts are the calculation's (written = coverage.withEvidence, driven cells =
 *                withAnyData plus the all-mid-ramp ones), a written cell's change is newMap / BASE,
 *                a refused cell says which gate and what to drive, only driven cells come back unless
 *                asked, a band narrows to its cells, the row cap keeps the heaviest evidence, and a
 *                whole map of driven cells stays under the size budget
 *   runOverview  a 70-minute synthetic run comes back under the size budget with the timeline
 *                coarsened (and saying so) to at most 200 rows; the grid's seconds plus the gaps are
 *                the run; RO is the session table's; a fuel cut with the pedal up is a cut and with
 *                it down is not; a knock retard is counted once at the time its counter dates it;
 *                gear changes, link gaps, marks and the closed-loop time are found; a limit cycle
 *                reads cycling and a walk does not; a window and a millisecond clock read the same
 *
 * What a wrong answer costs: an assistant telling the driver a cell is converging that the screen
 * paints refused, a 20-minute drive that cannot be read in one call, or a shift called a fuel cut.
 * Synthetic data only.
 */
import { VECalculator } from '../src/lib/ve-calculator/calculator.ts';
import { coverageRemedy } from '../src/lib/ve-calculator/cellCoverage.ts';
import { APP_CONFIG } from '../src/config/constants.ts';
import { veOverview, VE_COLUMNS, VE_MAX_ROWS } from '../src/lib/bridge/veOverview.ts';
import {
    runOverview, RUN_MAX_BYTES, RUN_MAX_TIMELINE_ROWS, RUN_STEP_DEFAULT_S, RUN_STEP_LADDER, PEDAL_UP_PCT,
} from '../src/lib/bridge/runOverview.ts';
import { KNOCK_AGE_NONE } from '../src/lib/bridge/moment.ts';

let fails = 0;
const check = (n, c, d) => { console.log('  ' + (c ? 'PASS' : 'FAIL') + '  ' + n + (c ? '' : ' — ' + (d ?? ''))); if (!c) fails++; };
const near = (a, b, tol) => typeof a === 'number' && Math.abs(a - b) <= tol;
const size = o => JSON.stringify(o).length;

const RPM = APP_CONFIG.MSS54HP.AXIS_RPM;
const LOAD = APP_CONFIG.MSS54HP.AXIS_LOAD;
const BASE = { xAxis: RPM, yAxis: LOAD, data: LOAD.map((ro, r) => RPM.map((_, c) => Math.round((0.2 + r * 0.03 + c * 0.005) * 1000) / 1000)) };
const col = (row, name) => row[VE_COLUMNS.indexOf(name)];
const rowAt = (rows, rpm, ro) => rows.find(r => r[0] === rpm && r[1] === ro);

/**
 * A tiny drive the calculator can judge, every sample dead on a node so each carries weight 1.0.
 * `kRamp: false` (post-ramp, by hand) except where a cell is meant to be all mid-ramp. Visits are
 * runs of samples 0.2 s apart; two visits are 5 s apart, past VISIT_GAP_SEC.
 */
function visits(rpm, ro, n, perVisit, trim, t0, extra = {}) {
    const out = [];
    for (let v = 0; v < n; v++) {
        for (let k = 0; k < perVisit; k++) {
            out.push({ time: t0 + v * 5 + k * 0.2, rpm, rawLoad: ro, correctedLoad: ro, stft1: trim, stft2: trim, rf: 30, kRamp: false, ...extra });
        }
    }
    return out;
}
const tinyDrive = [
    ...visits(2700, 7.5, 3, 5, 0.95, 0),          // A: three visits, written at -5 %
    ...visits(2200, 10, 1, 8, 1.04, 100),          // B: one visit — few-visits
    ...visits(3100, 15, 1, 2, 0.90, 200),          // C: two samples — thin-count
    ...visits(1600, 5, 3, 4, 0.92, 300, { kRamp: true }), // D: every sample mid-ramp — lambda-ramp
];
const calc = new VECalculator().calculateNewVEMap(BASE, tinyDrive, { applyRfKorr: false });

console.log('\n[veOverview reads the calculation, it does not redo it]');
{
    const o = veOverview({ currentMap: BASE, newMap: calc.newMap, calc, veWriteArmed: true, rowsArmed: ['ALPHA-N'] });
    check('the table is tuner_moment\'s shape: columns once, rows of arrays', JSON.stringify(o.columns) === JSON.stringify(VE_COLUMNS)
        && o.rows.every(r => Array.isArray(r) && r.length === VE_COLUMNS.length), JSON.stringify(o.columns));
    check('the axes come back whole', o.map.rpm.length === RPM.length && o.map.ro.length === LOAD.length && o.map.cells === 480);
    check('written cells = the calculation\'s withEvidence', o.counts.written + o.counts.settled === calc.coverage.withEvidence,
        `${o.counts.written}+${o.counts.settled} vs ${calc.coverage.withEvidence}`);
    const refusedWithSamples = Object.entries(o.counts.refused).filter(([k]) => k !== 'lambda-ramp').reduce((a, [, n]) => a + n, 0);
    check('written + refused-with-samples = the calculation\'s withAnyData',
        o.counts.written + o.counts.settled + refusedWithSamples === calc.coverage.withAnyData,
        `${o.counts.written + o.counts.settled + refusedWithSamples} vs ${calc.coverage.withAnyData}`);
    check('every cell is counted once', o.counts.written + o.counts.settled + Object.values(o.counts.refused).reduce((a, b) => a + b, 0) + o.counts.noData === 480);
    check('the refusals are the gate\'s own reasons', o.counts.refused['few-visits'] === 1 && o.counts.refused['thin-count'] >= 1 && o.counts.refused['lambda-ramp'] === 1,
        JSON.stringify(o.counts.refused));
    check('the armed rows are said back', o.tune.derived && o.tune.veWriteArmed === true && o.tune.rowsArmed?.[0] === 'ALPHA-N');

    const a = rowAt(o.rows, 2700, 7.5);
    const cell = calc.newMap.data[LOAD.indexOf(7.5)][RPM.indexOf(2700)];
    const now = BASE.data[LOAD.indexOf(7.5)][RPM.indexOf(2700)];
    check('A written: veNew is newMap\'s cell', a && col(a, 'state') === 'written' && near(col(a, 'veNew'), cell, 0.0006), JSON.stringify(a));
    check('...changePct is (newMap / BASE - 1) x 100', near(col(a, 'changePct'), (cell / now - 1) * 100, 0.05) && near(col(a, 'changePct'), -5, 0.05), String(a && col(a, 'changePct')));
    check('...askPct is the demand the samples made', near(col(a, 'askPct'), -5, 0.05), String(a && col(a, 'askPct')));
    const b = rowAt(o.rows, 2200, 10);
    check('B refused few-visits: no veNew, no change, but its ask', b && col(b, 'state') === 'few-visits' && col(b, 'veNew') === null
        && col(b, 'changePct') === null && near(col(b, 'askPct'), 4, 0.05), JSON.stringify(b));
    const d = rowAt(o.rows, 1600, 5);
    check('D all mid-ramp: listed as driven (lambda-ramp), with no ask to read', d && col(d, 'state') === 'lambda-ramp' && col(d, 'askPct') === null, JSON.stringify(d));
    check('only driven cells by default', o.rows.length === o.counts.written + o.counts.settled + Object.values(o.counts.refused).reduce((x, y) => x + y, 0),
        String(o.rows.length));
    check('largest.changed leads with the biggest move', o.largest.changed.length >= 1 && o.largest.changed[0][0] === 2700 && o.largest.changed[0][1] === 7.5);
    const ws = o.largest.refused.map(r => col(r, 'weight') ?? 0);
    check('largest.refused is by weight', ws.length >= 2 && ws.every((w, i) => i === 0 || w <= ws[i - 1]), JSON.stringify(ws));
    check('each refusal present carries the screen\'s remedy', o.remedies['few-visits'] === coverageRemedy('few-visits', 'en')
        && o.remedies['lambda-ramp'] === coverageRemedy('lambda-ramp', 'en') && !!o.remedies['no-data'], JSON.stringify(Object.keys(o.remedies)));
    check('no VIN, no file name', !/vin|fileName/i.test(JSON.stringify(o)));
}

console.log('\n[veOverview: a band, the empty cells, the row cap]');
{
    const o = veOverview({ currentMap: BASE, newMap: calc.newMap, calc }, { band: { rpm: [2600, 2800], ro: [5, 10] } });
    check('the band holds its cells: 2700 rpm x RO 5 / 7.5 / 10', o.band.cells === 3 && o.band.withData === 1, JSON.stringify(o.band));
    check('...and lists only the driven one', o.rows.length === 1 && o.rows[0][0] === 2700 && o.rows[0][1] === 7.5, JSON.stringify(o.rows));
    check('the counts stay the whole map\'s', o.counts.written === 1 && o.counts.noData > 400);
    const e = veOverview({ currentMap: BASE, newMap: calc.newMap, calc }, { band: { rpm: [2600, 2800], ro: [5, 10] }, includeEmpty: true });
    // RO 5 sits below the lowest row any sample was binned into (7.5 — D's samples were all mid-ramp,
    // so it holds none): buildCoverage calls that below the drive's reach, and so does this.
    check('includeEmpty lists the band\'s undriven cells, below reach where they are', e.rows.length === 3
        && JSON.stringify(e.rows.map(r => col(r, 'state'))) === '["below-reach","written","no-data"]',
        JSON.stringify(e.rows.map(r => col(r, 'state'))));
    const off = veOverview({ currentMap: BASE, newMap: calc.newMap, calc }, { band: { rpm: [9000, 9500] } });
    check('a band off the map says so', off.rows.length === 0 && /No cell/.test(off.notes.join(' ')), JSON.stringify(off.notes));
    const capped = veOverview({ currentMap: BASE, newMap: calc.newMap, calc }, { maxRows: 2 });
    check('maxRows keeps the heaviest evidence and says what it left out', capped.rows.length === 2
        && capped.rows.some(r => r[0] === 2700 && r[1] === 7.5) && /left out/.test(capped.notes.join(' ')), JSON.stringify(capped.rows));

    // A whole map of driven cells: the default call must still fit one answer.
    const full = {
        hitMap: LOAD.map(() => RPM.map(() => 37)), weightMap: LOAD.map(() => RPM.map((_, c) => 3 + c * 0.37)),
        correctionMap: LOAD.map((_, r) => RPM.map((__, c) => 1 + ((r * 7 + c * 3) % 21 - 10) / 1000)),
        demandMap: LOAD.map((_, r) => RPM.map((__, c) => 1 + ((r * 7 + c * 3) % 21 - 10) / 1000)),
        rejectMap: LOAD.map((_, r) => RPM.map((__, c) => ((r + c) % 3 === 0 ? 'few-visits' : null))),
    };
    const newMap = { ...BASE, data: BASE.data.map((row, r) => row.map((v, c) => (full.rejectMap[r][c] ? v : v * full.correctionMap[r][c]))) };
    const big = veOverview({ currentMap: BASE, newMap, calc: full });
    check(`480 driven cells: capped at ${VE_MAX_ROWS} rows`, big.rows.length === VE_MAX_ROWS, String(big.rows.length));
    check('...and the answer stays under 12 KB', size(big) <= 12_000, String(size(big)));
    console.log(`        (${size(big)} characters)`);

    const none = veOverview({ currentMap: BASE, newMap: null, calc: null });
    check('no calculation yet: said, with the axes', none.rows.length === 0 && /No VE calculation/.test(none.notes[0]) && none.map.cells === 480);
    check('no BIN: said', /No BIN/.test(veOverview({ currentMap: null, newMap: null, calc: null }).notes[0]));
    const thin = new VECalculator().calculateNewVEMap(BASE, visits(2200, 10, 1, 8, 1.04, 0), { applyRfKorr: false });
    const t = veOverview({ currentMap: BASE, newMap: thin.newMap, calc: thin });
    check('nothing cleared: no map derived, and said', !t.tune.derived && /derived no map/.test(t.notes.join(' ')));
}

// ---------------------------------------------------------------------------------------------------
/** The session table's shape: 0.7 at idle, 1.0 from 2400 rpm (the stock table). */
const TABLE = [
    { rpm: 0, factor: 0.7 }, { rpm: 900, factor: 0.7 }, { rpm: 1100, factor: 0.7 }, { rpm: 1300, factor: 0.75 },
    { rpm: 1400, factor: 0.8 }, { rpm: 1600, factor: 0.85 }, { rpm: 1800, factor: 0.9 }, { rpm: 2100, factor: 0.95 },
    { rpm: 2400, factor: 1 }, { rpm: 10000, factor: 1 },
];

/**
 * A run at 2.7 Hz, the VE profile's rate. The slow lanes as the logger has them: knock counters and
 * LA_ST_EIN one sample in eight, GANG one in sixteen. `at(t)` gives the fast channels; `retards` are
 * [time, cylinder]. Each counter is what the DME keeps — combustions of that cylinder, integrated over
 * the rpm the run actually had, restarted at a retard, saturating at 1275 — so a varying rpm moves
 * the count the way it does in a car and not by the rpm of the read.
 */
function run(seconds, at, { retards = [], gearAt = () => 4, loopClosed = () => true, hz = 2.7, t0 = 0 } = {}) {
    const out = [];
    const n = Math.floor(seconds * hz);
    const plan = [...retards].sort((a, b) => a[0] - b[0]);
    const count = [0, 1, 2, 3, 4, 5, 6].map(() => KNOCK_AGE_NONE);
    let next = 0;
    let prevT = null;
    for (let i = 0; i < n; i++) {
        const t = Math.round((t0 + i / hz) * 1000) / 1000;
        const p = { time: t, rpm: 2400, rawLoad: 8, stft1: 1.01, stft2: 1.0, ltft1: 1, ltft2: 1, wdk1: 12, pwg1: 20, vehicleSpeed: 80, coolantTemp: 85, ...at(t, i) };
        if (prevT !== null) for (let c = 1; c <= 6; c++) count[c] = Math.min(KNOCK_AGE_NONE, count[c] + (t - prevT) * p.rpm / 120);
        while (next < plan.length && plan[next][0] <= t) {
            const [rt, cyl] = plan[next++];
            count[cyl] = (t - rt) * p.rpm / 120;
        }
        if (i % 8 === 4) {
            for (let c = 1; c <= 6; c++) p[`knockAge${c}`] = Math.min(KNOCK_AGE_NONE, Math.floor(count[c]));
            p.laStEin1 = loopClosed(t) ? 79 : 78;
            p.laStEin2 = loopClosed(t) ? 79 : 78;
        }
        if (i % 16 === 8) p.gear = gearAt(t);
        out.push(p);
        prevT = t;
    }
    return out;
}

console.log('\n[runOverview on a 70-minute run: one answer, coarsened and saying so]');
{
    // Spread over the map like a real drive: rpm and opening wander, a fuel cut every 90 s, knock
    // every ~20 s somewhere, gears up and down.
    const retards = [];
    for (let t = 7; t < 4200; t += 19.3) retards.push([t, 1 + Math.floor(t) % 6]);
    const long = run(4200, (t) => {
        const cut = (t % 90) > 80 && (t % 90) < 85;
        const rpm = Math.round(2200 + 1000 * Math.sin(t / 47) + 400 * Math.sin(t / 7.3));
        const ro = 1.5 + 9 * Math.max(0, Math.sin(t / 33)) + 4 * Math.max(0, Math.sin(t / 5.1));
        const trim = 1 + 0.03 * Math.sin(t * 3.1) + 0.01 * Math.sin(t / 60);
        return cut
            ? { rpm, rawLoad: 0.4, wdk1: 0, pwg1: 0, stft1: 1, stft2: 1 }
            : { rpm, rawLoad: ro, wdk1: 4 + ro * 2, pwg1: 10 + ro * 2, stft1: trim, stft2: trim + 0.002, coolantTemp: 70 + Math.min(20, t / 60), vehicleSpeed: Math.round(rpm / 30) };
    }, { retards, gearAt: t => 2 + Math.floor(t / 37) % 4 });
    const o = runOverview({ samples: long, interpolationTable: TABLE, source: 'stored run 2' });
    console.log(`        (${long.length} samples → ${size(o)} characters, step ${o.timeline.stepS} s, ${o.timeline.rows.length} timeline rows, ${o.grid.rows.length} grid bins, ${o.events.rows.length} events)`);
    check('the default call fits the size budget', size(o) <= RUN_MAX_BYTES, String(size(o)));
    check(`the timeline holds at most ${RUN_MAX_TIMELINE_ROWS} rows`, o.timeline.rows.length <= RUN_MAX_TIMELINE_ROWS && o.timeline.rows.length > 20, String(o.timeline.rows.length));
    check('...on a step off the ladder, coarser than 5 s, and it says so', o.timeline.stepS > RUN_STEP_DEFAULT_S
        && RUN_STEP_LADDER.includes(o.timeline.stepS) && /Step raised from 5 to/.test(o.notes.join(' ')), `${o.timeline.stepS} ${JSON.stringify(o.notes)}`);
    check('the step is the finest that fits 200 rows, then the budget', o.timeline.stepS >= 4200 / RUN_MAX_TIMELINE_ROWS);
    check('tables are tuner_moment\'s shape', ['timeline', 'grid', 'events'].every(k => Array.isArray(o[k].columns) && o[k].rows.every(r => r.length === o[k].columns.length)));
    check('the source is said back', o.source === 'stored run 2');
    const gridS = o.grid.rows.reduce((a, r) => a + r[2], 0) + o.grid.otherS;
    check('grid seconds + otherS + gaps = the run', near(gridS + o.totals.gapS, o.totals.durationS, 0.05 * (o.grid.rows.length + 2)), `${gridS} + ${o.totals.gapS} vs ${o.totals.durationS}`);
    check('every planted retard is counted, once', o.totals.knockRetards === retards.length, `${o.totals.knockRetards} vs ${retards.length}`);
    check('...and the timeline\'s knock column adds up to it', o.timeline.rows.reduce((a, r) => a + r[o.timeline.columns.indexOf('knock')], 0) === retards.length);
    check('a fuel cut every 90 s, found', near(o.totals.fuelCuts, 4200 / 90, 1.5), String(o.totals.fuelCuts));
    check('the event list is capped and says what it left out', o.events.rows.length <= 60 && /Events not listed/.test(o.notes.join(' ')));
    const kinds = new Set(o.events.rows.map(r => r[1]));
    check('...keeping every kind, not 60 of the first one', kinds.has('knock') && kinds.has('cut') && kinds.has('gear'), JSON.stringify([...kinds]));
    const ts = o.events.rows.map(r => r[0]);
    check('...spread over the run', Math.max(...ts) - Math.min(...ts) > 3000, `${Math.min(...ts)}..${Math.max(...ts)}`);
    const tight = runOverview({ samples: long, interpolationTable: TABLE }, { maxBytes: 8000 });
    check('a smaller budget coarsens further and still fits', size(tight) <= 8000 && tight.timeline.stepS > o.timeline.stepS, `${size(tight)} step ${tight.timeline.stepS}`);
    const ax = runOverview({ samples: long, interpolationTable: TABLE }, { axes: { rpm: RPM, ro: LOAD } });
    check('binned on the VE map\'s nodes, a grid row is a map cell', ax.grid.rows.every(r => RPM.includes(r[0]) && LOAD.includes(r[1])) && /nodes/.test(ax.grid.bins));
    check('...and still fits', size(ax) <= RUN_MAX_BYTES, String(size(ax)));
    const ms = runOverview({ samples: long.map(p => ({ ...p, time: p.time * 1000 })), interpolationTable: TABLE });
    check('a millisecond clock (Testo CSV) reads the same run', ms.totals.durationS === o.totals.durationS && ms.timeline.stepS === o.timeline.stepS);
}

console.log('\n[runOverview on a short run: the step, RO, cuts, knock, gears, the loop]');
{
    // 120 s. 0-30 idle at 900 rpm, opening 0.7 (RO 1.0 through the table). 40-44 an overrun cut,
    // pedal up. 60-61 trims parked with the pedal at 30 %: a shift. Cylinders 3, 4, 5 retarded at
    // 70.0 / 70.5 / 71.0 s (one cluster); cylinder 2 at 85.0 and 85.3 s, both between the same two
    // reads (84.4 and 87.4 s), so the counter shows one; cylinder 1 at 100 s. 3rd to 4th at 50 s.
    // The loop reads open from 80 s.
    const s = run(120, (t) => {
        if (t < 30) return { rpm: 900, rawLoad: 0.7, wdk1: 0.5, pwg1: 0 };
        if (t >= 40 && t < 44) return { rawLoad: 0.4, wdk1: 0, pwg1: 0, stft1: 1, stft2: 1 };
        if (t >= 60 && t < 61) return { rawLoad: 0.4, wdk1: 0, pwg1: 30, stft1: 1, stft2: 1 };
        return {};
    }, { retards: [[70, 3], [70.5, 4], [71, 5], [85, 2], [85.3, 2], [100, 1]], gearAt: t => (t < 50 ? 3 : 4), loopClosed: t => t < 80, t0: 0 });
    const o = runOverview({ samples: s, interpolationTable: TABLE });
    check('a short run keeps the 5-s step and says nothing about it', o.timeline.stepS === 5 && !o.notes.some(n => /Step raised/.test(n)), JSON.stringify(o.notes));
    check('24 rows of 5 s', o.timeline.rows.length === 24, String(o.timeline.rows.length));
    const t0 = o.timeline.rows[0];
    check('RO is the session table\'s: 0.7 / 0.7 = 1.0 at idle', t0[o.timeline.columns.indexOf('ro')] === 1, JSON.stringify(t0));
    check('...and the grid bins it there', o.grid.rows.some(r => r[0] === 800 && r[1] === 0 && r[2] > 25));
    const ev = (kind) => o.events.rows.filter(r => r[1] === kind);
    check('one overrun cut, at 40 s, about 4 s long', ev('cut').length === 1 && near(ev('cut')[0][0], 40, 0.4) && /^4(\.\d)? s, pedal 0 %/.test(ev('cut')[0][2]),
        JSON.stringify(ev('cut')));
    check(`trims parked with the pedal at 30 % (> ${PEDAL_UP_PCT}) are a shift, not a cut`, ev('trimsReset').length === 1 && /pedal 30 %/.test(ev('trimsReset')[0][2]),
        JSON.stringify(ev('trimsReset')));
    check('the cut column holds the cut\'s seconds', near(o.timeline.rows.reduce((a, r) => a + r[o.timeline.columns.indexOf('cut')], 0), 4, 0.5));
    check('the trim leaves the parked samples out', o.timeline.rows.find(r => r[0] === 40)[o.timeline.columns.indexOf('trim')] !== 1);
    check('five retards counted: the two of cylinder 2 between one pair of reads are one', o.totals.knockRetards === 5, String(o.totals.knockRetards));
    const k = ev('knock');
    check('...in three clusters: 70-71 s (cylinders 3,4,5), 85.3 s (the later of cylinder 2\'s), 100 s',
        k.length === 3 && near(k[0][0], 70, 0.15) && /cyl 3,4,5: 3 retards in 1 s/.test(k[0][2])
        && near(k[1][0], 85.3, 0.15) && /cyl 2: 1 retard/.test(k[1][2]) && near(k[2][0], 100, 0.15),
        JSON.stringify(k));
    check('the gear change, at its read', ev('gear').length === 1 && /3 → 4/.test(ev('gear')[0][2]) && near(ev('gear')[0][0], 50, 6.5), JSON.stringify(ev('gear')));
    check('closed-loop time from LA_ST_EIN bit 0: about 80 of 120 s', near(o.totals.closedLoopS, 80, 4) && near(o.totals.loopKnownS, 119, 4),
        `${o.totals.closedLoopS} / ${o.totals.loopKnownS}`);
    check('coolant range', JSON.stringify(o.totals.coolant) === '[85,85]');

    const w = runOverview({ samples: s, interpolationTable: TABLE }, { from: 35, to: 65 });
    check('a window reads only its stretch', w.totals.from >= 35 && w.totals.to <= 65 && w.timeline.rows.every(r => r[0] >= 30 && r[0] < 65), JSON.stringify(w.totals));
    check('...and its events', w.events.rows.every(r => r[0] >= 35 && r[0] <= 65) && w.totals.knockRetards === 0);
    const late = runOverview({ samples: s, interpolationTable: TABLE }, { from: 500 });
    check('a window after the run says so', late.totals === null && /ends at/.test(late.notes[0]));
    check('no log: said', /no log/i.test(runOverview({ samples: [], interpolationTable: null }).notes[0]));
    const raw = runOverview({ samples: s, interpolationTable: null });
    check('no table (correction off): RO is the raw opening', raw.timeline.rows[0][raw.timeline.columns.indexOf('ro')] === 0.7);
}

console.log('\n[runOverview: a link gap and a mark]');
{
    const a = run(60, () => ({}));
    const b = run(60, () => ({}), { t0: 75 });
    b[0] = { ...b[0], linkGapS: b[0].time - a[a.length - 1].time };
    b[10] = { ...b[10], mark: 'step 1 done' };
    const o = runOverview({ samples: [...a, ...b], interpolationTable: TABLE });
    check('the gap is counted as no data', near(o.totals.gapS, b[0].time - a[a.length - 1].time, 0.06), String(o.totals.gapS));
    const gridS = o.grid.rows.reduce((x, r) => x + r[2], 0) + o.grid.otherS;
    check('grid seconds + the gap = the run', near(gridS + o.totals.gapS, o.totals.durationS, 0.2), `${gridS} + ${o.totals.gapS} vs ${o.totals.durationS}`);
    check('the gap and the mark are events', o.events.rows.some(r => r[1] === 'gap' && near(r[0], 75, 0.01)) && o.events.rows.some(r => r[1] === 'mark' && r[2] === 'step 1 done'));
}

console.log('\n[runOverview: a limit cycle reads cycling, a walk does not]');
{
    // 0-30 s at 2400 rpm: the trim swings ±0.01 about 1.00 and turns every 0.8 s — the limit cycle's
    // half-cycles, each well inside HALF_CYCLE_MAX_SEC. At 30 s the loop restarts (both banks exactly
    // 1.000), and 30-60 s at 3600 rpm the trim walks down at 0.02/s with no reversal. Bank 2 sits
    // 0.003 off bank 1: bit-identical banks read as a loop restart.
    const tooth = (t) => {
        const ph = (t % 1.6) / 1.6;
        return ph < 0.5 ? 1.01 - 0.04 * ph : 0.99 + 0.04 * (ph - 0.5);
    };
    const s = run(60, (t) => (t < 30
        ? { rpm: 2400, stft1: Math.round(tooth(t) * 1e4) / 1e4, stft2: Math.round((tooth(t) + 0.003) * 1e4) / 1e4 }
        : t < 30.1 ? { rpm: 3600, stft1: 1, stft2: 1 }
            : { rpm: 3600, stft1: 1 - 0.02 * (t - 30), stft2: 1.003 - 0.02 * (t - 30) }), { hz: 5 });
    const o = runOverview({ samples: s, interpolationTable: TABLE });
    const cyc = (rpm) => o.grid.rows.find(r => r[0] === rpm)?.[4];
    check('the saw-tooth bin reads mostly cycling', cyc(2400) > 0.6, String(cyc(2400)));
    check('the walk reads not cycling', cyc(3600) === 0, String(cyc(3600)));
}

console.log(fails === 0 ? '\nALL PASS' : '\n' + fails + ' FAILURE(S)');
process.exit(fails ? 1 : 0);
