/**
 * A datalog that loses its link mid-drive reconnects and keeps recording — and says where it was
 * blind.
 *
 *   the loop     runLivePoll (liveSupervisor.ts) against a scripted link on a fake clock: a drop
 *                is recovered on the policy's schedule, the first sample back carries the gap, a
 *                spent budget and a different DME end the run the way a link failure always did,
 *                STOP is answered in the middle of a wait or a reconnect, and a link with no
 *                reconnect behaves exactly as before;
 *   the filter   processLogData drops the LINK_GAP_HOLDOFF_S after a gap as `linkGap`, restarts
 *                the high-load clock there, starts the holdoff even when an operator's exclusion
 *                covers the gap sample, and agrees with itself across a resume landing inside it;
 *   the CSV      `Link Gap` goes out on the row a gap ended at and comes back as linkGapS, and a
 *                run that never lost its link has no such column.
 *
 * What a wrong answer costs: a run that ends at the first connector wobble (the old behaviour this
 * replaces), a run that quietly joins two cars or keeps polling after STOP, or VE evidence built
 * from samples compared across seconds nobody recorded. Synthetic data only.
 *
 *     node --experimental-strip-types --import ./scripts/ts-resolve.mjs scripts/verify-link-reconnect.mjs
 */
import {
    runLivePoll, differentDme, LIVE_RECONNECT_POLICY,
} from '../src/lib/dme-link/liveSupervisor.ts';
import { processLogData, LINK_GAP_HOLDOFF_S } from '../src/lib/log-engine/filter.ts';
import { DEFAULT_FILTER_CONFIG } from '../src/lib/log-engine/filterDefaults.ts';
import { serializeLogFile } from '../src/lib/log-engine/serializer.ts';
import { parseLogFile } from '../src/lib/log-engine/parser.ts';
import { APP_CONFIG } from '../src/config/constants.ts';

let fails = 0;
const check = (n, c, d) => { console.log('  ' + (c ? 'PASS' : 'FAIL') + '  ' + n + (c ? '' : ' — ' + (d ?? ''))); if (!c) fails++; };
const near = (a, b, tol = 1e-6) => Math.abs(a - b) < tol;

// Made-up identities in the mock DME's own shape — never a real-looking VIN in a public tree
// (check-public-tree refuses one).
const CAR = { vin: 'MOCKVIN0000000001', aif: 'AIF-1', softwareVersion: '0401', flashCounter: null, encodingChecksum: null };

/**
 * A scripted link on a fake clock. `script.failPolls` are the poll numbers (1-based) that throw;
 * `script.reconnects` is what each reconnect does in turn: 'fail', 'ok', an identity, or 'stop'
 * (resolve with CAR after flipping STOP, the race a press during a reconnect makes).
 */
function harness(script) {
    let clock = 0;
    let stopped = false;
    let polls = 0;
    const reconnectCalls = [];
    const reconnectEnds = [];
    const samples = [];
    const events = [];
    let disconnects = 0;
    const reconnects = [...(script.reconnects ?? [])];
    const deps = {
        poll: async () => {
            polls++;
            clock += 250;
            if (script.stopAfterPolls !== undefined && polls > script.stopAfterPolls) stopped = true;
            if ((script.failPolls ?? []).includes(polls)) throw new Error(`poll ${polls} timed out`);
            return { time: clock / 1000, rpm: 3000, rawLoad: 20 };
        },
        reconnect: script.noReconnect ? undefined : async (reason) => {
            reconnectCalls.push({ at: clock, reason });
            clock += 400;
            reconnectEnds.push(clock);
            const next = reconnects.shift() ?? 'fail';
            if (next === 'fail') throw new Error('cable did not answer');
            if (next === 'stop') { stopped = true; return CAR; }
            return next === 'ok' ? CAR : next;
        },
        disconnect: async () => { disconnects++; },
        shouldContinue: () => !stopped,
        onSample: (s, meta) => samples.push({ ...s, ...meta }),
        onGap: e => events.push(e),
        startIdentity: script.startIdentity === undefined ? CAR : script.startIdentity,
        policy: script.policy,
        now: () => clock,
        sleep: async (ms) => {
            clock += ms;
            if (script.stopAtMs !== undefined && clock >= script.stopAtMs) stopped = true;
        },
    };
    return {
        deps, samples, events, reconnectCalls, reconnectEnds,
        get polls() { return polls; }, get disconnects() { return disconnects; }, get clock() { return clock; },
    };
}

console.log('\n[the policy]');
check('half a second before the first attempt, rising to three', JSON.stringify(LIVE_RECONNECT_POLICY.delaysMs) === '[500,1000,2000,3000]');
check('a minute without the link ends the run', LIVE_RECONNECT_POLICY.budgetMs === 60_000);

console.log('\n[a drop, two refused reconnects, then the link is back]');
{
    const h = harness({ failPolls: [5], reconnects: ['fail', 'fail', 'ok'], stopAfterPolls: 12 });
    const failure = await runLivePoll(h.deps);
    check('the run ends on STOP, not on the drop', failure === null, String(failure));
    check('the events are lost, retrying x2, resumed', JSON.stringify(h.events.map(e => e.kind)) === '["lost","retrying","retrying","resumed"]',
        JSON.stringify(h.events.map(e => e.kind)));
    check('the lost event carries the poll\'s own error', h.events[0].error === 'poll 5 timed out', h.events[0].error);
    check('the reconnect is told what it is recovering from', h.reconnectCalls[0].reason === 'poll 5 timed out', h.reconnectCalls[0]?.reason);
    // The failed poll moved the clock to 1250 ms. Each wait is measured from where the previous
    // attempt ended, so the schedule is the policy's.
    const waits = h.reconnectCalls.map((c, i) => c.at - (i === 0 ? 1250 : h.reconnectEnds[i - 1]));
    check('the attempts wait 500, 1000, 2000 ms', JSON.stringify(waits) === '[500,1000,2000]', JSON.stringify(waits));
    check('three attempts are reported on resume', h.events[3].attempts === 3);
    const gapped = h.samples.filter(s => s.linkGapS !== undefined);
    check('exactly one sample carries the gap', gapped.length === 1, String(gapped.length));
    const before = h.samples[3];
    const after = h.samples[4];
    check('...and it is the first sample after the drop', gapped[0] === after);
    check('linkGapS is the time since the last sample before it', near(after.linkGapS, after.time - before.time),
        `${after.linkGapS} vs ${after.time - before.time}`);
    check('the gap covers the failed poll, the waits and the reconnects (5.2 s)', near(after.linkGapS, 5.2), String(after.linkGapS));
    check('blindMs runs from the last sample, not from the failure', near(h.events[3].blindMs, 5950 - 1000),
        String(h.events[3].blindMs));
    check('the run keeps recording after the gap', h.samples.length === 11, String(h.samples.length));
    check('time keeps running across the gap — no sample goes back to 0',
        h.samples.every((s, i) => i === 0 || s.time > h.samples[i - 1].time));
}

console.log('\n[a gap a second failure extends is ONE gap]');
{
    const h = harness({ failPolls: [3, 4], reconnects: ['ok', 'ok'], stopAfterPolls: 8 });
    await runLivePoll(h.deps);
    const gapped = h.samples.filter(s => s.linkGapS !== undefined);
    check('one sample carries a gap', gapped.length === 1, String(gapped.length));
    check('...measured from the last sample before the FIRST failure', near(gapped[0].linkGapS, gapped[0].time - h.samples[1].time),
        `${gapped[0].linkGapS}`);
    check('both losses are reported', h.events.filter(e => e.kind === 'lost').length === 2);
}

console.log('\n[the budget is spent]');
{
    const h = harness({ failPolls: [3], reconnects: [], policy: { delaysMs: [500, 1000, 2000, 3000], budgetMs: 10_000 } });
    const failure = await runLivePoll(h.deps);
    // From the loss: wait 0.5 + attempt 0.4 = 0.9 s, +1.0 +0.4 = 2.3, +2.0 +0.4 = 4.7, +3.0 +0.4 = 8.1.
    // The fifth wait would end at 11.1 s, past the 10 s budget, so it is never started.
    check('the run ends with a failure', typeof failure === 'string' && failure.includes('did not come back'), String(failure));
    check('four attempts were made — no wait is begun that would end past the budget', h.reconnectCalls.length === 4,
        String(h.reconnectCalls.length));
    check('the failure names the attempts and the last error', failure.includes('4 reconnect attempt(s)') && failure.includes('cable did not answer'), failure);
    check('the last event is gaveUp', h.events.at(-1).kind === 'gaveUp');
    check('no sample after the drop', h.samples.length === 2, String(h.samples.length));
    check('no poll after giving up', h.polls === 3, String(h.polls));
}

console.log('\n[a different DME answers]');
{
    const other = { ...CAR, vin: 'MOCKVIN0000099999' };
    const h = harness({ failPolls: [3], reconnects: [other], stopAfterPolls: 10 });
    const failure = await runLivePoll(h.deps);
    check('the run ends at once', typeof failure === 'string' && failure.startsWith('A different DME'), String(failure));
    check('the message names the field, not the value', failure.includes('VIN') && !failure.includes('99999'), failure);
    check('nothing from the other car joins the run', h.samples.length === 2, String(h.samples.length));
    check('reported as gaveUp', h.events.at(-1).kind === 'gaveUp');
    check('UNKNOWN on either side is a read that did not happen, not a different car',
        differentDme({ ...CAR, vin: 'UNKNOWN' }, other) === null && differentDme(CAR, { ...other, vin: 'UNKNOWN' }) === null);
    check('no identity at the start: nothing to compare', differentDme(null, other) === null);
    check('a different program number counts', differentDme(CAR, { ...CAR, softwareVersion: '0402' }) !== null);
}

console.log('\n[STOP is answered in the middle of a recovery]');
{
    const h = harness({ failPolls: [3], reconnects: ['fail', 'ok'], stopAtMs: 1600 });
    const failure = await runLivePoll(h.deps);
    // The failed poll leaves the clock at 750 ms; the first wait ends at 1250 and the attempt at 1650,
    // the second wait would pass 1600 on its first slice.
    check('STOP during a wait ends the run cleanly', failure === null, String(failure));
    check('...within a slice, without the next attempt', h.reconnectCalls.length === 1, String(h.reconnectCalls.length));
    check('...and no further poll', h.polls === 3, String(h.polls));
}
{
    const h = harness({ failPolls: [3], reconnects: ['stop'] });
    const failure = await runLivePoll(h.deps);
    check('STOP during a reconnect ends the run cleanly', failure === null, String(failure));
    check('...and closes the cable the late reconnect opened', h.disconnects === 1, String(h.disconnects));
    check('...and polls no more', h.polls === 3, String(h.polls));
    check('...and does not report the link as back', !h.events.some(e => e.kind === 'resumed'));
}
{
    const h = harness({ failPolls: [3], stopAfterPolls: 2 });
    const failure = await runLivePoll(h.deps);
    check('a poll that fails after STOP is not a failure', failure === null && h.events.length === 0, `${failure} ${h.events.length}`);
}

console.log('\n[a link that cannot reconnect ends the run as it always did]');
{
    const h = harness({ failPolls: [3], noReconnect: true });
    const failure = await runLivePoll(h.deps);
    check('the poll\'s own error is the failure', failure === 'poll 3 timed out', String(failure));
    check('no gap is reported', h.events.length === 0);
}

// ---------------------------------------------------------------------------------------------
// The filter.

/** Steady, warm, mid-load samples every 0.25 s over [t0, t1). Nothing in them trips another gate. */
const steady = (t0, t1, extra = {}) => {
    const out = [];
    for (let t = t0; t < t1 - 1e-9; t += 0.25) {
        out.push({
            time: Math.round(t * 1000) / 1000, rpm: 3000, rawLoad: 20, stft1: 1.02, stft2: 1.02,
            coolantTemp: 85, wdk1: 25, rf: 40, exhaustTemp: 500, ...extra,
        });
    }
    return out;
};
/** 0-10 s, then nothing for five seconds, then 15-25 s — with or without the marker. */
const gappedLog = (marked, extra) => {
    const a = steady(0, 10, extra);
    const b = steady(15, 25, extra);
    if (marked) b[0] = { ...b[0], linkGapS: 15 - a.at(-1).time };
    return [...a, ...b];
};
const cfg = { ...DEFAULT_FILTER_CONFIG };

console.log('\n[the filter leaves out the seconds after a gap]');
{
    check('the holdoff is two seconds', LINK_GAP_HOLDOFF_S === 2);
    const marked = processLogData(gappedLog(true), 'gap', cfg);
    const plain = processLogData(gappedLog(false), 'gap', cfg);
    check('without the marker nothing is charged to the link', plain.dropCensus.linkGap === 0);
    check('with it, the 2 s after the gap are dropped as linkGap (8 samples at 4 Hz)', marked.dropCensus.linkGap === 8,
        String(marked.dropCensus.linkGap));
    check('...and nothing else changes', marked.validCount === plain.validCount - 8, `${marked.validCount} vs ${plain.validCount}`);
    check('the first sample kept after it is 2 s past the gap',
        marked.data.find(p => p.time >= 15)?.time === 17, String(marked.data.find(p => p.time >= 15)?.time));
}

console.log('\n[the high-load clock does not count the gap as time held]');
{
    const hl = { ...cfg, highLoadSettleSec: 3 };
    const marked = processLogData(gappedLog(true, { rf: 60 }), 'hl', hl);
    const plain = processLogData(gappedLog(false, { rf: 60 }), 'hl', hl);
    // Both pay the first 3 s of the log. Only the marked one pays again, from 17 s (the first sample
    // the holdoff lets through) to 20 s: twelve samples.
    check('after a gap the settle starts again from the first sample kept',
        marked.dropCensus.highLoadSettle - plain.dropCensus.highLoadSettle === 12,
        `${marked.dropCensus.highLoadSettle} vs ${plain.dropCensus.highLoadSettle}`);
}

console.log('\n[an exclusion over the gap sample does not cancel the holdoff]');
{
    const ex = { ...cfg, excludeTimeRanges: [[15, 15.1]] };
    const out = processLogData(gappedLog(true), 'ex', ex);
    check('the gap sample is the operator\'s', out.dropCensus.excluded === 1, String(out.dropCensus.excluded));
    check('the seven after it are still the link\'s', out.dropCensus.linkGap === 7, String(out.dropCensus.linkGap));
}

console.log('\n[a live flush landing inside the holdoff agrees with the batch pass]');
{
    const log = gappedLog(true);
    const batch = processLogData(log, 'inc', cfg);
    const cut = log.findIndex(p => p.time === 15.5) + 1;
    const head = processLogData(log.slice(0, cut), 'inc', cfg);
    check('the resume carries where the gap ended', head.resume.linkGapResumedAt === 15, String(head.resume.linkGapResumedAt));
    const tail = processLogData(log, 'inc', cfg, undefined, undefined, head.resume);
    check('same samples kept', tail.validCount === batch.validCount, `${tail.validCount} vs ${batch.validCount}`);
    check('same census', JSON.stringify(tail.dropCensus) === JSON.stringify(batch.dropCensus),
        `${JSON.stringify(tail.dropCensus)} vs ${JSON.stringify(batch.dropCensus)}`);
}

console.log('\n[the CSV carries the gap]');
{
    const points = gappedLog(true);
    const csv = serializeLogFile(points);
    const header = csv.split(/\r?\n/)[0];
    check('a run with a gap has the column', header.includes(APP_CONFIG.CSV_MAPPING.LINK_GAP), header);
    const back = parseLogFile(csv);
    const gapped = back.filter(p => p.linkGapS !== undefined);
    check('it comes back on exactly one row', gapped.length === 1, String(gapped.length));
    check('...with the same value', near(gapped[0]?.linkGapS ?? NaN, points.find(p => p.linkGapS !== undefined).linkGapS),
        String(gapped[0]?.linkGapS));
    const none = serializeLogFile(gappedLog(false)).split(/\r?\n/)[0];
    check('a run that never lost its link has no such column', !none.includes(APP_CONFIG.CSV_MAPPING.LINK_GAP), none);
}

console.log(fails === 0 ? '\nALL PASS' : '\n' + fails + ' FAILURE(S)');
process.exit(fails ? 1 : 0);
