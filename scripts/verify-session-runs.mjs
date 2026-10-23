/**
 * A second recording in the same session is kept beside the first, never written over it.
 *
 * Session #982 lost its first OBSERVE run (four tip-ins, 1842 samples) this way: START cleared the
 * samples in memory and the crash-recovery record, and the next SAVE replaced the stored `data`
 * with the second run. Nothing said so. These checks hold the three places that did it:
 *
 *   1. `nextLogRecord` — a save carrying a different run id keeps the stored run whole (projection
 *      and raw samples) in `runs`; a save of the same run, or one carrying no id, is a re-save.
 *   2. `handleStartTune` — the run on screen is stored before the new one replaces it in memory and
 *      before `beginLiveRun` clears the recovery store, and nothing starts if that store fails.
 *   3. Every SAVE hands the store the workspace's run id, and opening a session takes the stored one.
 *
 * Plus the two places a run count travels: the sync fingerprint (unchanged for every session with
 * one run, so nothing already sent is offered again) and the store's point count.
 *
 * And the way back to a kept run: LOG and GRAPH show an earlier run to read (useRunView), both
 * through one switch, without loading it into the workspace its maps and SAVE are about.
 */
import { readFileSync } from 'node:fs';
import { nextLogRecord, runCount, storedRunData } from '../src/lib/db/sessionRepository.ts';
import { sessionFingerprint, logWorthSending } from '../src/lib/session-sync/client.ts';

let fails = 0;
const check = (n, c, d) => { console.log('  ' + (c ? 'PASS' : 'FAIL') + '  ' + n + (c ? '' : ' — ' + d)); if (!c) fails++; };

const ID = 'session-under-test';
const run1 = [{ time: 0, rpm: 2000, rawLoad: 10, mark: 'OBSERVE: tip-in' }, { time: 0.4, rpm: 2600, rawLoad: 30 }];
const run2 = [{ time: 0, rpm: 1900, rawLoad: 12 }, { time: 0.4, rpm: 2400, rawLoad: 28 }, { time: 0.8, rpm: 2800, rawLoad: 31 }];
const run3 = [{ time: 0, rpm: 2100, rawLoad: 15 }];
const idle1 = [{ time: 0, rpm: 872, mdLlri: -6.9 }];

console.log('\n[a second run is kept, not written over]');
{
    const first = nextLogRecord(ID, undefined, { data: run1, runId: 'r1' });
    check('the first run is the current one', first?.runId === 'r1' && first?.data.length === 2 && !first?.runs);
    const second = nextLogRecord(ID, first ?? undefined, { data: run2, runId: 'r2' });
    check('a different run moves the stored one to runs', second?.runs?.length === 1, JSON.stringify(second?.runs));
    check('...whole, with its marks', second?.runs?.[0].data[0].mark === 'OBSERVE: tip-in');
    check('...under its own id', second?.runs?.[0].runId === 'r1');
    check('...and the new run is current', second?.runId === 'r2' && second?.data.length === 3);
    const third = nextLogRecord(ID, second ?? undefined, { data: run3, runId: 'r3' });
    check('a third keeps both, oldest first',
        third?.runs?.map(r => r.runId).join(',') === 'r1,r2' && third?.runId === 'r3');
    check('runCount counts every run', runCount(third) === 3, runCount(third));
}

console.log('\n[the same run again is a re-save]');
{
    const stored = nextLogRecord(ID, nextLogRecord(ID, undefined, { data: run1, runId: 'r1' }) ?? undefined,
        { data: run2, runId: 'r2' });
    const resaved = nextLogRecord(ID, stored ?? undefined, { data: run2.slice(0, 2), runId: 'r2' });
    check('the same id replaces the current run', resaved?.data.length === 2 && resaved?.runId === 'r2');
    check('...and leaves the earlier runs alone', resaved?.runs?.length === 1);
    const noId = nextLogRecord(ID, stored ?? undefined, { data: run2 });
    check('a save with no id is a re-save too (a calibration save, an old caller)',
        noId?.runs?.length === 1 && noId?.runId === 'r2');
}

console.log('\n[sessions stored before run ids existed]');
{
    const legacy = { sessionId: ID, data: run1 };   // no runId, no runs
    const reopened = nextLogRecord(ID, legacy, { data: run1 });
    check('re-saving an old log as it was does not grow a run', !reopened?.runs && runCount(reopened) === 1);
    const newRun = nextLogRecord(ID, legacy, { data: run2, runId: 'r2' });
    check('a new run on an old session keeps the old log as run 1',
        newRun?.runs?.length === 1 && newRun?.runs?.[0].runId === undefined && newRun?.runs?.[0].data.length === 2);
}

console.log('\n[raw samples go with their own run]');
{
    const idleRun = nextLogRecord(ID, undefined, { data: run1, idle: idle1, runId: 'r1' });
    const next = nextLogRecord(ID, idleRun ?? undefined, { data: run2, runId: 'r2' });
    check('the earlier run keeps its raw samples', next?.runs?.[0].idle?.length === 1);
    check('...and the new run does not inherit them', next?.idle === undefined,
        'one run\'s data paired with another run\'s raw samples');
    const egas = nextLogRecord(ID, { sessionId: ID, data: run1, egas: [{}] }, { data: run2, runId: 'r2' });
    check('the retired egas array stays on the record', egas?.egas?.length === 1);
}

console.log('\n[nothing is made out of nothing]');
{
    const empty = nextLogRecord(ID, { sessionId: ID, data: [] }, { data: run1, runId: 'r1' });
    check('an empty stored log is not kept as a run', !empty?.runs && empty?.runId === 'r1');
    check('nothing to store is still null', nextLogRecord(ID, undefined, { data: [], runId: 'r1' }) === null);
    const onlyRuns = nextLogRecord(ID, { sessionId: ID, data: [], runs: [{ data: run1 }] }, { data: [] });
    check('a record holding only earlier runs is kept', onlyRuns?.runs?.length === 1);
    check('runCount of nothing is 0', runCount(null) === 0);
    check('...and of earlier runs with an empty current one counts only those', runCount(onlyRuns) === 1);
    check('a record holding only earlier runs is still sent', logWorthSending({ sessionId: ID, data: [], runs: [{ data: run1 }] }));
}

console.log('\n[the sync fingerprint]');
{
    const s = { baseSha256: 'b', sha256: 't', logPointCount: 3, flashHistory: [], status: 'draft' };
    const before = sessionFingerprint(s);
    check('one run (or none recorded) leaves the fingerprint as it was', sessionFingerprint({ ...s, logRuns: 1 }) === before,
        'every session sent before runs existed would be offered again');
    check('...and so does a session from before the field', before === 'b|t|3|0|draft', before);
    check('a second run changes it, so the session is offered again', sessionFingerprint({ ...s, logRuns: 2 }) !== before);
}

console.log('\n[the page: START keeps the run on screen, SAVE carries the id]');
{
    const page = readFileSync(new URL('../src/app/page.tsx', import.meta.url), 'utf8');
    const start = page.indexOf('const handleStartTune = async');
    const body = page.slice(start, page.indexOf('dmeLink.startTuning(', start));
    const keep = body.indexOf('sessionDb.saveResearch(');
    const fresh = body.indexOf('workspaceRunIdRef.current = crypto.randomUUID()');
    const live = body.indexOf('liveRun.start(');
    check('START stores the run on screen', keep > 0);
    check('...before it takes a new run id', keep > 0 && fresh > keep);
    check('...before liveRun.start clears memory and the recovery store', keep > 0 && live > keep);
    check('...and refuses to start when that store fails', /catch \{\s*alert\(dialogText\(\)\.keepRunFailed\);\s*return;/.test(body));

    const save = page.slice(page.indexOf('const saveSession = async'), page.indexOf('const handleSaveSession'));
    const calls = save.match(/sessionDb\.(saveSessionTune|saveResearch)\(\{[\s\S]*?\}\);/g) ?? [];
    check('SAVE has its three store calls', calls.length === 3, calls.length);
    check('...and every one carries the run id', calls.every(c => c.includes('runId: workspaceRunIdRef.current')));

    const open = page.slice(page.indexOf('const handleOpenSession = async'), page.indexOf('const restoreRun = async'));
    check('opening a session takes its stored run id', open.includes('workspaceRunIdRef.current = record?.runId'));
    const reset = page.slice(page.indexOf('const resetDerived = () =>'), page.indexOf('const handleUploadBase'));
    check('a workspace reset forgets the run id', reset.includes('workspaceRunIdRef.current = undefined'));
}

console.log('\n[an earlier run, by number]');
{
    const record = { sessionId: ID, data: run3, runs: [{ data: run1 }, { data: run2 }] };
    check('run 1 is the oldest kept run', storedRunData(record, 1) === run1);
    check('run 2 is the next', storedRunData(record, 2) === run2);
    check('the last number is the current run', storedRunData(record, 3) === run3);
    check('past the last there is none', storedRunData(record, 4) === null);
    check('...nor before the first, nor between', storedRunData(record, 0) === null && storedRunData(record, 1.5) === null);
    check('a run that kept no log samples (inertia, idle) has none to show',
        storedRunData({ sessionId: ID, data: run2, runs: [{ data: [], idle: idle1 }] }, 1) === null);
    check('no record, no run', storedRunData(null, 1) === null);
}

console.log('\n[the page: an earlier run on LOG and GRAPH, to read]');
{
    const page = readFileSync(new URL('../src/app/page.tsx', import.meta.url), 'utf8');
    const hook = readFileSync(new URL('../src/hooks/useRunView.ts', import.meta.url), 'utf8');
    check('the chart and the table read one window, chosen in one place',
        page.includes('logWindow: viewLogWindow,') && page.split('data={deferredCharts.logWindow}').length === 3);
    check('...which is the earlier run\'s when one is shown',
        page.includes('const viewLogWindow = earlierOnView ? runView.rows : displayedLogWindow;'));
    check('...and one selection, converted once for both',
        page.includes('const windowRelativeSelection = viewSelectedIndex === null ? null : viewSelectedIndex - viewWindowStart;'));
    check('both views take their columns from the run they show',
        page.split('presenceData={viewRaw ?? undefined}').length === 3);
    check('the chart refits when the run changes', page.includes("#${viewedRun ?? 'workspace'}`}"));
    check('the chart\'s marks are the shown run\'s',
        page.includes('e.body.run === markedRun') && page.includes('for (const p of viewRaw ?? [])'));
    const show = page.slice(page.indexOf('const showRun = async'), page.indexOf('const jumpToLogTime'));
    check('an earlier run is read back from the store, never loaded into the workspace',
        show.includes('storedRunData(await sessionDb.loadLogRecord(id), n)')
        && !/loadRawLog|setWorkspaceRun|workspaceRunIdRef\.current =/.test(show));
    check('...and not while a log records', show.includes("dmeLink.state === 'tuning') return false"));
    check('the view is the opener\'s: none while recording, gone when the session or its run moves on',
        hook.includes('(o.recording ? null : `${o.sessionId}|${o.workspaceRun}`)') && hook.includes('shown.owner === key'));
    check('the assistant is told when an earlier run is on the log views', page.includes('viewing: { run: viewedRun,'));
    check('...and reads stored runs by the same numbering',
        page.includes('return storedRunData(await sessionDb.loadLogRecord(currentSession.id), run);'));
    const panel = readFileSync(new URL('../src/components/NotebookPanel.tsx', import.meta.url), 'utf8');
    check('NOTEBOOK jumps to a moment of any run, but only the live one while recording',
        panel.includes('(place[0] === run || (!recording && place[0] >= 1 && place[0] <= runs))'));
}

console.log(fails === 0 ? '\nAll checks passed.\n' : `\n${fails} check(s) FAILED.\n`);
process.exit(fails === 0 ? 0 : 1);
