/**
 * The session log on the wire: does a round trip keep everything the local record held?
 *
 * Two things are being defended, and both are silent when they break.
 *
 * 1. **A restore must not delete the raw inertia samples.** The sync used to send
 *    `getSessionLog`'s projection — a `LogDataPoint[]` — while `putSessionRaw` writes the whole
 *    `SessionLogRecord`. So pulling your own session back overwrote the local record with one that
 *    had no `inertia`, destroying the only copy the estimator can read. `SessionLogRecord.inertia`
 *    says it "cost one real drive to discover"; it should not cost a second.
 *
 * 2. **Sessions synced BEFORE that change are still bare arrays in the store.** Ten of them, at the
 *    time of writing. If the reader only understood the new shape they would come back as an empty
 *    log with no error at all.
 *
 * `null` is checked explicitly because the schema draws a line there: `mdIndNe: null` means the RAM
 * read came back short, `mdIndNe: 0` means overrun with no combustion torque. Collapsing the first
 * into the second feeds the regression a fabricated anchor at its most sensitive point.
 */
import { nextLogRecord } from '../src/lib/db/sessionRepository.ts';
import { asLogRecord, gzipJson, gunzipJson, toBase64, fromBase64 } from '../src/lib/session-sync/client.ts';

let fails = 0;
const check = (n, c, d) => { console.log('  ' + (c ? 'PASS' : 'FAIL') + '  ' + n + (c ? '' : ' — ' + d)); if (!c) fails++; };

const ID = 'session-under-test';

const data = [
    { time: 0.0, rpm: 900, rawLoad: 0.4, stft1: 1.0, stft2: 1.0 },
    { time: 0.3, rpm: 3200, rawLoad: 44.0, stft1: 0.97, stft2: 0.98, rf: 61.2, exhaustTemp: 402 },
];
const inertia = [
    { time: 0.0, rpm: 6400, coolantTemp: 92, wdk1: 0, rf: 9.1, mdIndNe: 0, mdDynSt: 0 },
    // The two readings that must stay distinguishable.
    { time: 0.3, rpm: 6100, coolantTemp: 92, wdk1: 0, rf: 9.0, mdIndNe: null, mdDynSt: 0 },
];

console.log('\n[the shape a session is stored in today]');
{
    const record = { sessionId: ID, data, inertia };
    const back = asLogRecord(record, ID);
    check('data survives', back.data.length === 2 && back.data[1].rf === 61.2);
    check('inertia survives', back.inertia?.length === 2);
    check('mdIndNe null stays null', back.inertia?.[1].mdIndNe === null,
        'a short RAM read must not read back as "overrun, zero torque"');
    check('mdIndNe 0 stays 0', back.inertia?.[0].mdIndNe === 0);
}

console.log('\n[the shape sessions synced before the fix are stored in]');
{
    const back = asLogRecord(data, ID);
    check('a bare array still restores', back.data.length === 2 && back.data[0].rpm === 900,
        'the ten sessions already in the store would come back empty');
    check('it is keyed to the session asked for', back.sessionId === ID);
    check('it claims no inertia it never had', back.inertia === undefined);
}

console.log('\n[the id is the session\'s own, never the record\'s]');
{
    const back = asLogRecord({ sessionId: 'some-other-session', data, inertia }, ID);
    check('a mismatched record is re-keyed', back.sessionId === ID,
        'otherwise the log lands under a key nothing reads');
}

console.log('\n[full round trip: gzip -> base64 -> back]');
{
    const record = { sessionId: ID, data, inertia };
    const wire = toBase64(await gzipJson(record));
    const back = asLogRecord(await gunzipJson(fromBase64(wire)), ID);
    check('data intact', JSON.stringify(back.data) === JSON.stringify(data));
    check('inertia intact, nulls and all', JSON.stringify(back.inertia) === JSON.stringify(inertia));
}

console.log('\n[an inertia run whose projection came out empty]');
{
    // saveResearchRun writes the record when EITHER array has samples, so the sender has to match:
    // a run with raw samples and no projected ones is still a run worth having.
    const record = { sessionId: ID, data: [], inertia };
    const hasSamples = (record.data?.length ?? 0) > 0 || (record.inertia?.length ?? 0) > 0;
    check('still counts as having samples', hasSamples,
        'gating the upload on data.length alone would drop the raw samples');
}

// ---------------------------------------------------------------------------------------------
// What a save STORES. Added after a run recorded in the car came back with an empty log.
//
// Neither of the two bugs below could be reached from this file as it stood, because everything
// here tested the sync WIRE and both defects were in the repository's own write. `asLogRecord`
// carried `idle` faithfully — there was simply never an `idle` to carry.
console.log('\n[what a save decides to SEND]');
{
    // The THIRD copy of the same enumeration. `nextLogRecord` decides what a record HOLDS; the sync
    // decides what is worth SENDING, so they stay separate functions — but both have to name every
    // sample kind, and the sync did not name `idle`. An idle run whose projection came out empty
    // would have uploaded a session with no log at all — the same omission reaching a third file,
    // under a comment saying it matched the first.
    const worthSending = (log) => !!log && ((log.data?.length ?? 0) > 0
        || (log.inertia?.length ?? 0) > 0 || (log.idle?.length ?? 0) > 0);
    const idleOnly = [{ time: 0, rpm: 872, mdLlri: -6.9 }];
    check('an idle-only record is worth sending', worthSending({ sessionId: ID, data: [], idle: idleOnly }));
    check('...and so is an inertia-only one', worthSending({ sessionId: ID, data: [], inertia }));
    check('...and a projection-only one', worthSending({ sessionId: ID, data }));
    check('an empty record is not', !worthSending({ sessionId: ID, data: [] }));
    check('and neither is a missing one', !worthSending(null));
}

console.log('\n[what a save decides to store]');
{
    const idle = [
        { time: 0.0, rpm: 872, coolantTemp: 88, mdLlri: -6.9, llsTv: 37.3, lfrZustand: 2 },
        // The reading the whole estimate is made of, and the one the projection cannot hold.
        { time: 0.3, rpm: 869, coolantTemp: 88, mdLlri: null, llsTv: 37.3, lfrZustand: 2 },
    ];
    const projection = idle.map(s => ({ time: s.time, rpm: s.rpm, rawLoad: 0 }));

    // 1. An idle run must store its raw samples. This was accepted as a parameter and dropped.
    const stored = nextLogRecord(ID, undefined, { data: projection, idle });
    check('an idle run stores its raw samples', stored?.idle?.length === 2, JSON.stringify(stored?.idle));
    check('...and md_llri null survives, because null is not zero here',
        stored?.idle?.[1].mdLlri === null, stored?.idle?.[1].mdLlri);
    check('...alongside the projection, not instead of it', stored?.data.length === 2);

    // 2. Saving a tune afterwards must not delete them. This replaced the whole record.
    const afterTune = nextLogRecord(ID, stored ?? undefined, { data: projection });
    check('saving a tune afterwards keeps the raw samples',
        afterTune?.idle?.length === 2, JSON.stringify(afterTune?.idle));
    const withInertia = nextLogRecord(ID, { sessionId: ID, data, inertia }, { data: projection });
    check('...and keeps inertia samples too, which is the same bug', withInertia?.inertia?.length === 2);

    // 3. Nothing to store is a null, not an empty record that claims a drive happened.
    check('nothing to store returns null', nextLogRecord(ID, undefined, { data: [] }) === null);
    check('...but raw samples alone are still worth storing',
        nextLogRecord(ID, undefined, { data: [], idle })?.idle?.length === 2);
    check('an empty incoming array does not erase what is there',
        nextLogRecord(ID, { sessionId: ID, data, idle }, { data: projection })?.idle?.length === 2);
}

console.log(fails === 0 ? '\nAll checks passed.\n' : `\n${fails} check(s) FAILED.\n`);
process.exit(fails === 0 ? 0 : 1);
