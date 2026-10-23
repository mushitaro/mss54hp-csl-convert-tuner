/**
 * The experiment notebook: its rules, its merge, the OBSERVE plan kept in it, and the store's API.
 *
 *   the rules   a note is the driver's own words — the assistant and the desk ask instead; a fact
 *               carries run, range and channels; entries are only added, and two writers' entries
 *               merge by id; a plan rewrites the one it names, and two rewrites of one plan are a
 *               fork the driver chooses between; a reading that points at another disputes it
 *   the plan    the OBSERVE plan on screen round-trips through a plan entry, and the same plan is
 *               recognised as the same, so a run does not write a new version for nothing
 *   the store   POST adds an entry once, only to the caller's own session, and refuses a broken one
 *               with the rule's own sentence; GET returns them in order; deleting the session deletes
 *               its notebook — a stand-in D1, nothing leaves this machine
 *   the page    START writes the plan an OBSERVE run uses, opening a session brings its plan back,
 *               NEXT carries it to the child, SYNC sends and fetches the notebook, a restore fetches it
 *   the desk    `npm run notebook` reads a plan file, writes only as DESK and never a note, answers
 *               only questions put to the desk, adds each entry once under the session's own owner
 *               (run against the real migrations in an in-memory SQLite), and its notebook.md puts
 *               the questions waiting first and quotes only what a person said
 *
 * What a wrong answer costs: the desk inferring what the driver did, a plan lost on reload, or a
 * note in the driver's name that the driver never said.
 */
import { readFileSync } from 'node:fs';
import { entryProblem, mergeEntries, currentPlan, nextPlanVersion, statusOf, openAsks, stepsDone, lastNote, notebookLine } from '../src/lib/notebook/rules.ts';
import { planEntryFromObserve, observeFromPlanEntry, samePlan } from '../src/lib/notebook/observePlan.ts';
import { sessionFingerprint } from '../src/lib/session-sync/client.ts';
import { onRequestGet, onRequestPost } from '../functions/api/sessions/[id]/notebook.ts';
import { onRequestDelete } from '../functions/api/sessions/[id].ts';
import { DatabaseSync } from 'node:sqlite';
import {
    parsePlanFile, parseEvidence, deskEntry, planBody, answerBody, mustExist, insertSql, entriesOf, renderNotebook,
} from './notebook-desk.mjs';

let fails = 0;
const check = (n, c, d) => { console.log('  ' + (c ? 'PASS' : 'FAIL') + '  ' + n + (c ? '' : ' — ' + (d ?? ''))); if (!c) fails++; };

const S = 'session-0000-982';
let seq = 0;
const id = () => `entry-${String(++seq).padStart(4, '0')}`;
const e = (by, body, at = 1_000 + seq) => ({ id: id(), sessionId: S, at, by, body });
const ev = { run: 2, from: 355.7, to: 362.0, channels: ['pedal', 'wdk1', 'rpm'] };

console.log('\n[the rules]');
{
    check('a driver\'s note is accepted', entryProblem(e('driver', { kind: 'note', run: 2, t: 359, text: '2速から3速に上げて、そのまま踏んだ', via: 'voice' })) === null);
    check('...and the owner\'s, typed on the screen', entryProblem(e('owner', { kind: 'note', run: null, t: null, text: 'fuel: 100 RON', via: 'screen' })) === null);
    const byChat = entryProblem(e('chat', { kind: 'note', run: 2, t: 359, text: '踏む直前に燃料カット', via: 'voice' }));
    check('a note in the driver\'s name by the assistant is refused', /ask instead/.test(byChat ?? ''), byChat);
    check('...and by the desk', /ask instead/.test(entryProblem(e('desk', { kind: 'note', run: null, t: null, text: 'x', via: 'screen' })) ?? ''));
    check('the desk asks instead', entryProblem(e('desk', { kind: 'ask', to: 'driver', text: '急 1 回目の直前、アクセルは戻しましたか', about: ev })) === null);
    const bare = entryProblem(e('desk', { kind: 'fact', text: 'trim 1.02 → 0.93 → 1.00' }));
    check('a fact without evidence is refused', /evidence is required/.test(bare ?? ''), bare);
    check('a fact with run, range and channels is accepted', entryProblem(e('desk', { kind: 'fact', text: 'trim 1.02 → 0.93 → 1.00', evidence: ev })) === null);
    check('...but not one whose range runs backwards', entryProblem(e('desk', { kind: 'fact', text: 't', evidence: { ...ev, from: 9, to: 1 } })) !== null);
    check('the driver\'s word is a note, not a fact', /note/.test(entryProblem(e('driver', { kind: 'fact', text: 't', evidence: ev })) ?? ''));
    check('a reading says how sure', entryProblem(e('desk', { kind: 'read', text: 'fuel cut', sure: 'maybe' })) !== null);
    check('a note needs run and t together', entryProblem(e('driver', { kind: 'note', run: 2, t: null, text: 'x', via: 'voice' })) !== null);
    check('an unknown author is refused', entryProblem(e('robot', { kind: 'note', run: null, t: null, text: 'x', via: 'voice' })) !== null);
    check('a bad id is refused', entryProblem({ ...e('owner', { kind: 'ask', to: 'desk', text: 'x' }), id: 'x' }) !== null);
    const steps = [{ n: 1, do: 'RO 6–8 × 2400–2800 rpm, 4–5 速で 3–4 s 保持', rpm: [2400, 2800], ro: [6, 8], holdS: 3, times: 4 }];
    check('a plan with numbered steps is accepted', entryProblem(e('desk', { kind: 'plan', v: 1, purpose: 'RO 6–8 の薄さ', steps })) === null);
    check('...but not one whose steps skip a number', entryProblem(e('desk', { kind: 'plan', v: 1, purpose: 'p', steps: [{ n: 2, do: 'x' }] })) !== null);
    check('...nor one watching an address that is not six hex digits', entryProblem(e('chat', { kind: 'plan', v: 1, purpose: 'p', steps: [], watch: [{ address: '0xFFEBAC', bytes: 2, every: 2 }] })) !== null);
    check('an answer points at its question', entryProblem(e('driver', { kind: 'answer', re: 'nope', text: 'x' })) !== null);
}

console.log('\n[two writers, one book]');
{
    const a = e('driver', { kind: 'note', run: 1, t: 10, text: 'a', via: 'voice' }, 100);
    const b = e('desk', { kind: 'ask', to: 'driver', text: 'b' }, 50);
    const c = e('chat', { kind: 'fact', text: 'c', evidence: ev }, 75);
    const merged = mergeEntries([a, c], [b, a]);
    check('the union, each entry once', merged.length === 3);
    check('...in the order written', merged.map(x => x.at).join(',') === '50,75,100');
}

console.log('\n[the plan: versions and forks]');
{
    const p1 = e('desk', { kind: 'plan', v: 1, purpose: 'v1', steps: [] }, 10);
    const p2 = e('chat', { kind: 'plan', v: 2, re: p1.id, purpose: 'v2', steps: [] }, 20);
    check('one plan is the plan', currentPlan([p1]).plan?.id === p1.id && !currentPlan([p1]).forked);
    check('a rewrite replaces what it rewrites', currentPlan([p1, p2]).plan?.id === p2.id && !currentPlan([p1, p2]).forked);
    check('the next version follows the highest', nextPlanVersion([p1, p2]) === 3);
    const p2b = e('desk', { kind: 'plan', v: 2, re: p1.id, purpose: 'v2 from the desk', steps: [] }, 25);
    const f = currentPlan([p1, p2, p2b]);
    check('two rewrites of one plan are a fork', f.forked && f.heads.length === 2, JSON.stringify(f.heads.map(h => h.body.purpose)));
    check('...shown newest, never silently chosen as the only one', f.plan?.id === p2b.id && f.heads.some(h => h.id === p2.id));
    check('no plan at all is no plan', currentPlan([]).plan === null && nextPlanVersion([]) === 1);
}

console.log('\n[standing beside, not replacing]');
{
    const claim = e('desk', { kind: 'read', text: '踏む直前の燃料カット', sure: 'mid', evidence: ev }, 10);
    const note = e('driver', { kind: 'note', run: 2, t: 359, text: '変速してそのまま踏んだ', via: 'voice' }, 20);
    const counter = e('chat', { kind: 'read', text: 'ペダル 44 % のまま回転が落ちた：変速の形', sure: 'high', evidence: ev, re: claim.id }, 30);
    check('a reading that points at another disputes it', statusOf([claim, note, counter], claim.id) === 'disputed');
    check('...and both are still there', mergeEntries([claim, note, counter]).length === 3);
    const withdrawn = e('desk', { kind: 'status', re: claim.id, to: 'withdrawn' }, 40);
    check('the latest status decides', statusOf([claim, counter, withdrawn], claim.id) === 'withdrawn');
    const ask = e('desk', { kind: 'ask', to: 'driver', text: 'アクセルは戻しましたか' }, 50);
    check('an unanswered question is open', openAsks([ask]).length === 1);
    const ans = e('driver', { kind: 'answer', re: ask.id, text: '戻していない。変速した' }, 60);
    check('...and answered, it is not', openAsks([ask, ans]).length === 0);
}

console.log('\n[the OBSERVE plan kept in the notebook]');
{
    const screen = { title: 'tabg_delta と rf_korr', reads: [{ address: 0xFFEBAC, count: 2, every: 2, label: 'tabg_delta' }], steps: ['アイドル', '', 'ターゲットバンドで踏み込み'] };
    const entry = planEntryFromObserve(screen, { id: id(), sessionId: S, at: 1, by: 'chat', v: 1 });
    check('the plan on screen is a valid plan entry', entryProblem(entry) === null, entryProblem(entry));
    check('...its address as six hex digits', entry.body.watch?.[0].address === 'FFEBAC');
    check('...and its steps numbered, blank lines dropped', entry.body.steps.map(s => `${s.n}:${s.do}`).join('|') === '1:アイドル|2:ターゲットバンドで踏み込み');
    const back = observeFromPlanEntry(entry);
    check('it comes back as the same plan', back.title === screen.title && back.reads[0].address === 0xFFEBAC && back.steps.length === 2);
    check('the same plan is recognised as the same', samePlan(screen, entry));
    check('...and an edited one is not', !samePlan({ ...screen, steps: ['アイドル'] }, entry));
    const untitled = planEntryFromObserve({ title: '', reads: screen.reads, steps: [] }, { id: id(), sessionId: S, at: 1, by: 'owner', v: 1 });
    check('a plan with no title still has a purpose', entryProblem(untitled) === null && untitled.body.purpose === 'OBSERVE FFEBAC', untitled.body.purpose);
}

console.log('\n[the sync fingerprint]');
{
    const s = { baseSha256: 'b', sha256: 't', logPointCount: 3, flashHistory: [], status: 'draft' };
    check('a session with no notebook keeps its fingerprint', sessionFingerprint(s) === 'b|t|3|0|draft');
    check('writing in the notebook makes it outstanding', sessionFingerprint({ ...s, notebookAt: 5 }) !== sessionFingerprint(s));
}

console.log('\n[the store]');
{
    function fakeDb() {
        const sessions = new Map([[S, 'owner-1234-abcd'], ['someone-elses', 'owner-9999-zzzz']]);
        const rows = new Map();
        const stmt = (sql) => ({
            bind(...v) {
                return {
                    sql, v,
                    async first() {
                        if (/^SELECT 1 AS one FROM sessions/.test(sql)) return sessions.get(v[0]) === v[1] ? { one: 1 } : null;
                        throw new Error(`unexpected first(): ${sql}`);
                    },
                    async all() {
                        const [owner, sid, since] = v;
                        const results = [...rows.values()].filter(r => r.owner === owner && r.session_id === sid && r.stored_at > since)
                            .sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
                        return { results };
                    },
                    async run() {
                        if (/^DELETE FROM sessions/.test(sql)) {
                            const had = sessions.get(v[0]) === v[1]; if (had) sessions.delete(v[0]);
                            return { meta: { changes: had ? 1 : 0 } };
                        }
                        if (/^DELETE FROM notebook_entries/.test(sql)) {
                            let n = 0; for (const [k, r] of rows) if (r.session_id === v[0] && r.owner === v[1]) { rows.delete(k); n++; }
                            return { meta: { changes: n } };
                        }
                        throw new Error(`unexpected run(): ${sql}`);
                    },
                };
            },
        });
        return {
            rows, sessions,
            prepare: (sql) => stmt(sql.trim()),
            async batch(bound) {
                return bound.map(b => {
                    const [rid, session_id, owner, at, author, kind, body_json, stored_at] = b.v;
                    if (rows.has(rid)) return { meta: { changes: 0 } };
                    rows.set(rid, { id: rid, session_id, owner, at, author, kind, body_json, stored_at });
                    return { meta: { changes: 1 } };
                });
            },
        };
    }
    const ctx = (db, sid, init, owner = 'owner-1234-abcd') => ({
        env: { RUNS_DB: db }, params: { id: sid }, data: { owner: { id: owner } },
        request: new Request(`https://x/api/sessions/${sid}/notebook`, init),
    });
    const post = async (db, sid, entries, owner) => {
        const res = await onRequestPost(ctx(db, sid, { method: 'POST', body: JSON.stringify({ entries }), headers: { 'content-type': 'application/json' } }, owner));
        return { status: res.status, json: await res.json() };
    };
    const get = async (db, sid, owner) => {
        const res = await onRequestGet(ctx(db, sid, { method: 'GET' }, owner));
        return { status: res.status, json: await res.json() };
    };

    const db = fakeDb();
    const note = e('driver', { kind: 'note', run: 2, t: 359, text: '変速した', via: 'voice' }, 20);
    const ask = e('desk', { kind: 'ask', to: 'driver', text: '戻しましたか' }, 10);
    const first = await post(db, S, [note, ask]);
    check('entries are added to the owner\'s session', first.status === 200 && first.json.added === 2, JSON.stringify(first));
    const again = await post(db, S, [note]);
    check('the same entry again adds nothing, and is still answered for', again.status === 200 && again.json.added === 0 && again.json.ids[0] === note.id, JSON.stringify(again));
    const fake = await post(db, S, [e('chat', { kind: 'note', run: 2, t: 359, text: '燃料カット', via: 'voice' })]);
    check('a note in the driver\'s name by the assistant is refused here too, in the rule\'s words', fake.status === 422 && /ask instead/.test(fake.json.error), JSON.stringify(fake));
    const foreign = await post(db, 'someone-elses', [{ ...ask, id: id(), sessionId: 'someone-elses' }]);
    check('another owner\'s session answers 404', foreign.status === 404, JSON.stringify(foreign));
    const mixed = await post(db, S, [{ ...ask, id: id(), sessionId: 'other-session-01' }]);
    check('an entry for another session is refused', mixed.status === 422, JSON.stringify(mixed));
    const back = await get(db, S);
    check('GET returns them, oldest first', back.status === 200 && back.json.entries.map(x => x.id).join(',') === [ask.id, note.id].join(','), JSON.stringify(back.json.entries?.map(x => x.id)));
    check('...whole, with who wrote them', back.json.entries[1].by === 'driver' && back.json.entries[1].body.text === '変速した');
    check('someone else gets 404 for it', (await get(db, S, 'owner-9999-zzzz')).status === 404);
    const del = await onRequestDelete({ env: { RUNS_DB: db }, params: { id: S }, data: { owner: { id: 'owner-1234-abcd' } } });
    check('deleting the session deletes its notebook', del.status === 204 && [...db.rows.values()].every(r => r.session_id !== S), `${del.status} ${db.rows.size}`);
}

console.log('\n[the page and the sync client]');
{
    const src = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
    const page = src('../src/app/page.tsx');
    const start = page.slice(page.indexOf('const handleStartTune = async'), page.indexOf('dmeLink.startTuning(', page.indexOf('const handleStartTune = async')));
    check('START writes the plan an OBSERVE run uses, before the run starts',
        start.includes("logProcess === 'OBSERVE' && currentSession) await keepObservePlan(") && start.indexOf('keepObservePlan(') < start.indexOf('liveRun.start('));
    const open = page.slice(page.indexOf('const handleOpenSession = async'), page.indexOf('const restoreRun = async'));
    check('opening a session brings its plan back', open.includes('void adoptNotebookPlan(session.id)'));
    check('...without replacing a plan already on screen', /if \(onScreen\.title\.trim\(\) \|\| onScreen\.reads\.length \|\| activeSteps\(onScreen\)\.length\) return onScreen;/.test(page));
    const next = page.slice(page.indexOf('const handleNext = async'), page.indexOf('const saveSession = async'));
    check('NEXT carries the plan to the child', next.includes('void carryNotebookPlan(parent.id, created.id)'));
    check('the assistant and the owner are told apart as the plan\'s writer',
        page.includes("observePlanByRef.current = 'chat';") && page.includes("observePlanByRef.current = 'owner'; setObservePlan(p);"));
    const client = src('../src/lib/session-sync/client.ts');
    const sync = client.slice(client.indexOf('export async function syncSession'), client.indexOf('// --- Notebook'));
    check('SYNC sends the notebook after the session row, then fetches', sync.indexOf('await pushNotebook(session.id)') > sync.indexOf("call<SyncResult>('/api/sessions'") && sync.includes('await pullNotebook(session.id)'));
    const restore = client.slice(client.indexOf('export async function restoreSession'), client.indexOf('export async function deleteStoredSession'));
    check('a restore fetches the notebook too', restore.includes('pullNotebook(session.id)'));
    const db = src('../src/hooks/useSessionDb.ts');
    check('deleting a session on the device deletes its notebook', /await deleteSession\(id\);[\s\S]{0,200}deleteSessionEntries\(id\)/.test(db));
    check('writing in the notebook marks the session outstanding', /addEntries\(entries, \{ sent: false \}\)[\s\S]{0,120}touchNotebook\(/.test(db));
    const store = src('../src/lib/notebook/store.ts');
    check('a build that never wrote a notebook does not create its database by reading',
        ['sessionEntries', 'unsentEntries', 'deleteSessionEntries'].every(f => new RegExp(`function ${f}[\\s\\S]{0,120}notebookDbExists\\(\\)`).test(store)));
}

console.log('\n[what the screens read: the strip, the plan\'s ticks, the menu\'s line]');
{
    const p1 = e('desk', { kind: 'plan', v: 1, purpose: 'v1', steps: [{ n: 1, do: 'a' }, { n: 2, do: 'b' }, { n: 3, do: 'c' }] }, 10);
    const p2 = e('chat', { kind: 'plan', v: 2, re: p1.id, purpose: 'v2 chat', steps: [{ n: 1, do: 'a' }] }, 20);
    const p2b = e('desk', { kind: 'plan', v: 2, re: p1.id, purpose: 'v2 desk', steps: [{ n: 1, do: 'a' }, { n: 2, do: 'b' }, { n: 3, do: 'c' }] }, 25);
    const chose = e('owner', { kind: 'status', re: p2.id, to: 'withdrawn' }, 30);
    check('a fork is a fork until the driver chooses', currentPlan([p1, p2, p2b]).forked);
    const after = currentPlan([p1, p2, p2b, chose]);
    check('...and choosing one sets the other aside, without deleting it', !after.forked && after.plan?.id === p2b.id);
    const s1 = e('owner', { kind: 'step', run: 6, t: 12, n: 1 }, 40);
    const s1again = e('chat', { kind: 'step', run: 6, t: 15, n: 1 }, 41);
    const s1old = e('owner', { kind: 'step', run: 5, t: 3, n: 2 }, 42);
    const done = stepsDone([s1, s1again, s1old], 6);
    check('steps done are this run\'s only, the first mark kept', done.size === 1 && done.get(1) === 12);
    check('...and none for a run with no workspace', stepsDone([s1], null).size === 0);
    const n1 = e('driver', { kind: 'note', run: 6, t: 20, text: 'first', via: 'voice' }, 50);
    const n2 = e('owner', { kind: 'note', run: null, t: null, text: 'last', via: 'screen' }, 60);
    check('the strip shows the last note', lastNote([n1, n2])?.id === n2.id);
    const ask = e('desk', { kind: 'ask', to: 'driver', text: 'q' }, 70);
    check('the menu\'s line: plan, step, questions', notebookLine([p1, p2, p2b, chose, s1, ask], 6) === 'PLAN v2 · STEP 2/3 · ASK 1', notebookLine([p1, p2, p2b, chose, s1, ask], 6));
    check('...says a fork', /PLAN v2 ×2/.test(notebookLine([p1, p2, p2b], 6) ?? ''));
    check('...and nothing for an empty notebook', notebookLine([], 1) === null);
}

console.log('\n[the screens]');
{
    const src = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
    const page = src('../src/app/page.tsx');
    check('the DASH strip is drawn whenever the notebook is on, session or not — it never comes and goes',
        /\{notebookOn && \(\s*<NotebookStrip/.test(page));
    const strip = src('../src/components/NotebookStrip.tsx');
    check('...in a fixed 40px', strip.includes('h-[40px] flex-none'));
    check('...and its step line is DONE only while a log records', strip.includes('const canMark = recording && !!next && !forked'));
    const mark = page.slice(page.indexOf('const markNow = ('), page.indexOf('const jumpToLogTime'));
    check('a step marked done becomes a notebook entry on this run', mark.includes("kind: 'step', run, t:") && mark.includes('workspaceRunRef.current'));
    check('...written as the assistant\'s when the assistant marked it', page.includes("mark: (label: string) => markNow(label, 'chat')"));
    check('the log chart is given the marks', page.includes('marks={chartMarks}'));
    check('...the driver\'s notes on the run the log views show among them (an earlier one when it is shown)',
        /e\.body\.kind === 'note' && e\.body\.run === markedRun/.test(page) && page.includes('const markedRun = viewedRun ?? workspaceRun;'));
    check('the M menu carries the notebook\'s line where the notebook is on', page.includes('notebook={notebookOn ? notebookLine(notebook.entries, workspaceRun) : undefined}'));
    const chart = src('../src/components/LogTimeSeriesChart.tsx');
    check('the chart draws only the marks inside the window', /marks\.filter\(m => m\.t >= first && m\.t <= last\)/.test(chart));
    check('...and a tap on a label opens its words', chart.includes('captureevents: true') && chart.includes('onClickAnnotation'));
    const panel = src('../src/components/NotebookPanel.tsx');
    check('NOTEBOOK takes no note while a log records', panel.includes('{!recording && <NoteInput'));
    check('...and answers are closed then too', panel.includes('disabled={recording} onAnswer'));
    check('...and a fork is chosen by setting the others aside', /heads\.filter\(h => h\.id !== keep\)[\s\S]{0,120}to: 'withdrawn'/.test(panel));
    check('a note on the screen is the owner\'s, by the screen', panel.includes("by: 'owner', body: { kind: 'note', run: null, t: null, text, via: 'screen' }"));
}

console.log('\n[the desk: npm run notebook]');
{
    const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re.test(String(e.message)); } };
    const md = [
        '# Hold RO 6-8 four times',
        '',
        '仮説: the trims stay above 1.05',
        'Criteria: mean trim over the holds > 1.05',
        'Reasoning in prose that the notebook does not need.',
        '## Steps',
        '1. Idle 30 s',
        '2. Slow tip-in {gear: 3, rpm: 2400-2800, ro: 6-8, hold: 3, times: 4}',
        '## Watch',
        '- DAT_00ffd1a2 2 every 2 candidate flag',
    ].join('\n');
    const plan = parsePlanFile(md, 'plan.md');
    check('a plan file gives the purpose, hypothesis and criteria (English or Japanese keys)',
        plan.purpose === 'Hold RO 6-8 four times' && plan.hypothesis === 'the trims stay above 1.05' && plan.criteria === 'mean trim over the holds > 1.05');
    check('...numbered steps with their ranges', JSON.stringify(plan.steps[1]) === JSON.stringify({ n: 2, do: 'Slow tip-in', gear: '3', rpm: [2400, 2800], ro: [6, 8], holdS: 3, times: 4 }), JSON.stringify(plan.steps));
    check('...the watch as the notebook keeps it, six hex digits', JSON.stringify(plan.watch) === JSON.stringify([{ address: 'FFD1A2', bytes: 2, every: 2, label: 'candidate flag' }]), JSON.stringify(plan.watch));
    check('...and leaves the prose out', !JSON.stringify(plan).includes('Reasoning'));
    const fromJson = parsePlanFile(JSON.stringify({ purpose: 'p', steps: ['a', { do: 'b', hold_s: 2 }] }), 'plan.json');
    check('a JSON plan reads the same way', fromJson.steps[0].do === 'a' && fromJson.steps[1].holdS === 2 && fromJson.steps[1].n === 2);
    check('a watched address outside the RAM the DME serves is refused with the OBSERVE panel\'s sentence',
        throws(() => parsePlanFile('# p\n## Watch\n- 0x123456 2 every 2', 'plan.md'), /outside the RAM the DME serves/));
    check('an unknown step attribute is refused', throws(() => parsePlanFile('# p\n## Steps\n1. a {speed: 80}', 'plan.md'), /unknown "speed"/));
    check('evidence reads as RUN:FROM-TO:CHANNELS[:DECODE]',
        JSON.stringify(parseEvidence('2:361-367:stft1,pwg1:u16/32768')) === JSON.stringify({ run: 2, from: 361, to: 367, channels: ['stft1', 'pwg1'], decode: 'u16/32768' }));
    check('...and anything else is refused with the form to use', throws(() => parseEvidence('run 2'), /RUN:FROM-TO:CHANNELS/));

    const SID = 'session-0000-desk';
    check('the desk writes as DESK', deskEntry(SID, { kind: 'ask', to: 'driver', text: 'Was the pedal down?' }).by === 'desk');
    check('...and cannot write a note in anyone\'s name: it asks instead',
        throws(() => deskEntry(SID, { kind: 'note', run: 1, t: 2, text: 'lifted', via: 'screen' }), /the assistant and the desk ask instead/));
    check('...nor a fact without its evidence', throws(() => deskEntry(SID, { kind: 'fact', text: 'trim fell' }), /evidence is required/));

    const at = (n) => 1_800_000_000_000 + n * 1000;
    const p1 = { id: 'plan-0000-0001', sessionId: SID, at: at(1), by: 'chat', body: { kind: 'plan', v: 1, purpose: 'a', steps: [{ n: 1, do: 'Slow tip-in' }] } };
    const next = planBody([p1], { purpose: 'b', steps: [] });
    check('a desk plan is the next version and rewrites the plan to drive by', next.v === 2 && next.re === p1.id);
    const forkA = { id: 'plan-0000-000a', sessionId: SID, at: at(2), by: 'chat', body: { kind: 'plan', v: 2, re: p1.id, purpose: 'x', steps: [] } };
    const forkB = { id: 'plan-0000-000b', sessionId: SID, at: at(3), by: 'desk', body: { kind: 'plan', v: 3, re: p1.id, purpose: 'y', steps: [] } };
    check('...refused while two rewrites are open: the driver chooses, not the desk',
        throws(() => planBody([p1, forkA, forkB], { purpose: 'z', steps: [] }), /driver chooses/));
    const toDesk = { id: 'ask-0000-desk', sessionId: SID, at: at(4), by: 'chat', body: { kind: 'ask', to: 'desk', text: 'Which code sets it?' } };
    const toDriver = { id: 'ask-0000-drvr', sessionId: SID, at: at(5), by: 'desk', body: { kind: 'ask', to: 'driver', text: 'Clutch in?' } };
    check('the desk answers a question put to the desk', answerBody([toDesk], toDesk.id, 'rf_init').re === toDesk.id);
    check('...and not one put to the driver', throws(() => answerBody([toDriver], toDriver.id, 'yes'), /for the driver/));
    check('a reference must be an entry of this notebook', throws(() => mustExist([toDesk], 'nope-0000-0'), /not an entry/));

    // The insert, against the store's own migrations.
    const db = new DatabaseSync(':memory:');
    for (const f of ['0001_create_runs', '0002_sessions', '0003_diagnostics', '0004_diagnostics_retries', '0005_sessions_idle', '0006_owner', '0007_notebook']) {
        db.exec(readFileSync(new URL(`../migrations/${f}.sql`, import.meta.url), 'utf8'));
    }
    db.prepare('INSERT INTO sessions (id, synced_at, label, created_at, session_json_gz, owner) VALUES (?,?,?,?,?,?)')
        .run(SID, 1, 'Session #7', 1, Buffer.from('{}'), 'owner-of-7');
    const ask = deskEntry(SID, { kind: 'ask', to: 'driver', text: 'Didn\'t you shift 2→3 there?' });
    db.exec(insertSql(ask));
    db.exec(insertSql(ask));
    const rows = db.prepare('SELECT * FROM notebook_entries').all();
    check('the desk\'s entry is added once, however often it is sent', rows.length === 1, rows.length);
    check('...under the session\'s own owner', rows[0]?.owner === 'owner-of-7', rows[0]?.owner);
    check('...with its text intact through the quoting', entriesOf(rows)[0]?.body.text === 'Didn\'t you shift 2→3 there?');
    db.exec(insertSql(deskEntry('session-0000-none', { kind: 'ask', to: 'driver', text: 'x' })));
    check('nothing is added to a session the store does not hold', db.prepare('SELECT count(*) AS n FROM notebook_entries').get().n === 1);

    const note = { id: 'note-0000-0001', sessionId: SID, at: at(6), by: 'driver', body: { kind: 'note', run: 1, t: 4.2, text: 'kept my foot in', via: 'voice' } };
    const step = { id: 'step-0000-0001', sessionId: SID, at: at(7), by: 'chat', body: { kind: 'step', run: 1, t: 3.0, n: 1 } };
    const p2 = { id: 'plan-0000-0002', sessionId: SID, at: at(8), by: 'desk', body: { kind: 'plan', v: 2, re: p1.id, purpose: 'b', steps: [{ n: 1, do: 'Idle 30 s' }] } };
    const deskAnswer = { id: 'answ-0000-0001', sessionId: SID, at: at(9), by: 'desk', body: { kind: 'answer', re: toDesk.id, text: 'rf_init' } };
    const out = renderNotebook({
        session: { id: SID, seq: 7, label: 'Session #7', createdAt: at(0) },
        runs: [{ n: 1, points: 10 }],
        entries: [p1, toDesk, toDriver, note, step, p2, deskAnswer],
    });
    check('notebook.md puts the questions waiting first', out.indexOf('## Questions waiting') < out.indexOf('## Plan') && out.includes('ASK → DRIVER: Clutch in?'));
    check('...quotes what the driver said', out.includes('DRIVER 「kept my foot in」'));
    check('...and not what the desk wrote', out.includes('DESK ANSWER to ask-0000-desk: rf_init'));
    check('...credits a step to the plan it was driven to, not one written after',
        out.includes('STEP 1 done — Slow tip-in (plan v1)') && !/### v2[\s\S]*RUN 1 steps done/.test(out));

    const cli = readFileSync(new URL('./notebook.mjs', import.meta.url), 'utf8');
    check('the CLI writes only through deskEntry and its one insert', cli.includes('const entry = deskEntry(id, body);') && cli.includes('query(insertSql(entry));'));
    check('...says a stored notebook is written to only when its owner asked for the analysis', /only when the owner asked/.test(cli));
    check('...and that PowerShell reads # as a comment', cli.includes('PowerShell reads everything after # as a comment'));
}

console.log(fails === 0 ? '\nAll checks passed.\n' : `\n${fails} check(s) FAILED.\n`);
process.exit(fails === 0 ? 0 : 1);
