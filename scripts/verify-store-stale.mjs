/**
 * The store refuses an upload over a newer copy another device sent, unless the owner said to.
 *
 *   the rule   POST /api/sessions with ifStoreSyncedAt: the stored row's synced_at must still be
 *              that, or the answer is 409 newer_in_store with when the newer copy was sent; force
 *              replaces it; no ifStoreSyncedAt (a session first sent before this) checks nothing,
 *              as before; every stored copy answers with its own syncedAt for the next upload
 *   the client syncSession sends what it last saw and the owner's force; a restore keeps the
 *              store's time; the 409 becomes a SyncError of kind 'stale' with that time
 *
 * What a wrong answer costs: the copy a laptop fixed overwritten by the head unit's older one, with
 * nothing saying so — the session list is per device, and the store is the only place they meet.
 * A stand-in D1; nothing leaves this machine.
 */
import { gzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { onRequestPost } from '../functions/api/sessions/index.ts';

let fails = 0;
const check = (n, c, d) => { console.log('  ' + (c ? 'PASS' : 'FAIL') + '  ' + n + (c ? '' : ' — ' + (d ?? ''))); if (!c) fails++; };

/** One table, the two statements the handler runs. */
function fakeDb() {
    const rows = new Map();
    return {
        rows,
        prepare(sql) {
            return {
                bind(...v) {
                    return {
                        async first() {
                            if (/^SELECT synced_at FROM sessions/.test(sql)) {
                                const r = rows.get(v[0]);
                                return r && r.owner === v[1] ? { synced_at: r.synced_at } : null;
                            }
                            throw new Error(`unexpected first(): ${sql}`);
                        },
                        async run() {
                            if (!/INSERT INTO sessions/.test(sql)) throw new Error(`unexpected run(): ${sql}`);
                            const [id, synced_at] = v;
                            const owner = v[15];
                            const had = rows.get(id);
                            if (had && had.owner !== owner) return { meta: { changes: 0 } };
                            rows.set(id, { synced_at, owner });
                            return { meta: { changes: 1 } };
                        },
                    };
                },
            };
        },
    };
}

const gz = s => gzipSync(Buffer.from(s)).toString('base64');
const body = extra => ({ id: 'sess-1', label: 'Session #978', createdAt: 1, sessionGz: gz('{}'), ...extra });
const post = async (db, b) => {
    const res = await onRequestPost({
        request: new Request('https://x/api/sessions', { method: 'POST', body: JSON.stringify(b), headers: { 'content-type': 'application/json' } }),
        env: { RUNS_DB: db }, data: { owner: { id: 'owner-1234-abcd' } },
    });
    return { status: res.status, json: await res.json() };
};

console.log('\n[the store: a newer copy from another device is not replaced unasked]');
{
    const db = fakeDb();
    const a = await post(db, body({}));
    check('first upload, nothing seen before: stored, with the store\'s time', a.status === 200 && typeof a.json.syncedAt === 'number', JSON.stringify(a));
    const seenByA = a.json.syncedAt;
    await new Promise(r => setTimeout(r, 5));
    const b = await post(db, body({ ifStoreSyncedAt: seenByA }));
    check('the same device again, having seen the latest: stored', b.status === 200 && b.json.syncedAt > seenByA, JSON.stringify(b));
    const stale = await post(db, body({ ifStoreSyncedAt: seenByA }));
    check('a device that last saw an older copy: 409 newer_in_store, with when', stale.status === 409 && stale.json.error === 'newer_in_store' && stale.json.syncedAt === b.json.syncedAt, JSON.stringify(stale));
    check('...and the stored copy is untouched', db.rows.get('sess-1').synced_at === b.json.syncedAt);
    const forced = await post(db, body({ ifStoreSyncedAt: seenByA, force: true }));
    check('force: the owner chose to replace it — stored', forced.status === 200 && db.rows.get('sess-1').synced_at === forced.json.syncedAt, JSON.stringify(forced));
    const legacy = await post(db, body({}));
    check('no ifStoreSyncedAt (sent before this existed): checked as before, stored', legacy.status === 200, JSON.stringify(legacy));
    const fresh = await post(db, body({ id: 'sess-new', ifStoreSyncedAt: 12345 }));
    check('a session the store does not have: stored whatever was seen', fresh.status === 200, JSON.stringify(fresh));
    db.rows.set('sess-foreign', { synced_at: 1, owner: 'someone-else-0000' });
    const foreign = await post(db, body({ id: 'sess-foreign', ifStoreSyncedAt: 999 }));
    check('another account\'s id: still the 409 id_taken it was, not a stale copy', foreign.status === 409 && foreign.json.error === 'id_taken', JSON.stringify(foreign));
}

console.log('\n[the client: what it sends, and what a restore keeps]');
{
    const client = readFileSync('src/lib/session-sync/client.ts', 'utf8');
    check('syncSession sends what this device last saw, and force only when asked', /ifStoreSyncedAt: session\.storeSyncedAt/.test(client) && /force: opts\.force === true \? true : undefined/.test(client));
    check('a 409 newer_in_store is a SyncError of kind stale, with the store\'s time', /detail === 'newer_in_store'/.test(client) && /new SyncError\('stale'/.test(client));
    check('a restore keeps the store\'s time on the session it writes', /storeSyncedAt: body\.syncedAt/.test(client));
    const hook = readFileSync('src/hooks/useSessionSync.ts', 'utf8');
    check('SYNC keeps the newer-copy refusals apart from failures, and never forces unasked', /if \(failure\?\.stale\) stale\.push/.test(hook) && /force\?\.includes\(session\.id\)/.test(hook));
    check('a row\'s send asks before replacing a newer copy', /failure\?\.stale && confirm\(dialogText\(\)\.syncOverwriteNewer/.test(hook));
    const repo = readFileSync('src/lib/db/sessionRepository.ts', 'utf8');
    check('a send that landed records the store\'s time', /storeSyncedAt !== undefined \? \{ storeSyncedAt \} : \{\}/.test(repo));
}

console.log(fails === 0 ? '\nALL PASS' : '\n' + fails + ' FAILURE(S)');
process.exit(fails ? 1 : 0);
