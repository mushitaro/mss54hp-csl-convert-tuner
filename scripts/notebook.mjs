/**
 * The desk's side of the experiment notebook (src/lib/notebook/rules.ts): read a session's
 * notebook, its runs and its BINs out of the store, and add a plan, a question, an answer, a
 * finding or a status to it — for when no WORKS tab is open to do it through the assistant.
 *
 *   npm run notebook -- pull <982 | UUID> [--out DIR] [--parents 3]
 *   npm run notebook -- plan <session> <plan.md | plan.json> [--dry]
 *   npm run notebook -- ask <session> <driver | owner | chat> "<question>" [--about RUN:FROM-TO:CH,CH]
 *   npm run notebook -- answer <session> <ask id> "<answer>"
 *   npm run notebook -- finding <session> fact "<text>" --evidence RUN:FROM-TO:CH,CH[:DECODE]
 *   npm run notebook -- finding <session> read "<text>" --sure low|mid|high [--evidence …] [--re ID]
 *   npm run notebook -- status <session> <entry id> withdrawn | agreed | disputed
 *
 * Add --local to work on the local D1 (`npm run db:migrate:local` first) instead of the store.
 * Write `982`, not `#982`: PowerShell reads everything after # as a comment.
 *
 * Reads and writes go through THIS tool's Cloudflare login (scripts/wrangler.mjs), as the store's
 * other desk reads do. Writing is adding: an entry is inserted once under its own id and the
 * session's own owner, and the owner's device takes it in when it next opens or syncs the session.
 * The privacy policy lets the operator add to a stored notebook only when the owner asked for the
 * session to be analysed — this tool cannot know that, so the person running it has to.
 *
 * `pull` writes, under archive/d1/<date>/<session id>/ (gitignored): notebook.md and notebook.json,
 * session.json, log.json (the current run) with binaries.json beside it — the directory the
 * analyze:* scripts read — run-<n>.json for every run, and base.bin / tuned.bin. notebook.md follows
 * the session's parents and lists their plans, questions and answers too.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
    answerBody, deskEntry, entriesOf, insertSql, mustExist, parseEvidence, parsePlanFile, planBody, renderNotebook,
} from './notebook-desk.mjs';

const root = path.resolve(import.meta.dirname, '..');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DB = 'mss54hp-tuner-runs';

const argv = process.argv.slice(2);
const flags = {};
const words = [];
for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--local' || a === '--dry') flags[a.slice(2)] = true;
    else if (a.startsWith('--')) {
        if (argv[i + 1] === undefined) fail(`${a} needs a value`);
        flags[a.slice(2)] = argv[++i];
    } else words.push(a);
}
const where = flags.local ? '--local' : '--remote';

function fail(message) {
    console.error(`notebook: ${message}`);
    process.exit(1);
}

function queryOnce(statement) {
    const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'wrangler.mjs'),
        'd1', 'execute', DB, where, '--json', '--command', statement],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true });
    if (r.error) throw r.error;
    let parsed;
    try { parsed = JSON.parse(r.stdout.trim()); } catch { throw new Error(`wrangler did not answer in JSON (exit ${r.status}): ${(r.stderr || r.stdout).slice(0, 600)}`); }
    if (r.status !== 0 || !Array.isArray(parsed) || parsed.some(x => !x.success)) {
        throw new Error(`D1: ${JSON.stringify(parsed.error ?? parsed).slice(0, 1200)}`);
    }
    return parsed.flatMap(x => x.results);
}

/** 7403 has come and gone on the same read (see archive/fetch-latest-complete.mjs); retried twice. */
function query(statement) {
    for (let attempt = 0; ; attempt++) {
        try { return queryOnce(statement); } catch (error) {
            if (/no such table: notebook_entries/.test(String(error))) {
                fail(`the ${flags.local ? 'local D1' : 'store'} has no notebook yet: migrations/0007_notebook.sql is not applied there (npm run db:migrate:${flags.local ? 'local' : 'remote'} — on the store, the operator's decision).`);
            }
            if (attempt >= 2 || !/\b7403\b/.test(String(error))) throw error;
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, (attempt + 1) * 1000);
        }
    }
}

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** One of the session row's gzipped JSON columns, read in hex chunks below D1's value limit. */
function readBlob(id, column) {
    const row = query(`SELECT length(${column}) AS size FROM sessions WHERE id = ${q(id)}`)[0];
    if (!row) fail(`session ${id} is not in the ${flags.local ? 'local D1' : 'store'}`);
    if (!row.size) return null;
    const chunks = [];
    const step = 128 * 1024;
    for (let start = 1; start <= row.size; start += step) {
        const part = query(`SELECT hex(substr(${column},${start},${step})) AS part FROM sessions WHERE id = ${q(id)}`)[0]?.part;
        if (typeof part !== 'string' || !/^(?:[0-9a-f]{2})*$/i.test(part)) throw new Error('a blob chunk came back unreadable');
        chunks.push(Buffer.from(part, 'hex'));
    }
    return JSON.parse(gunzipSync(Buffer.concat(chunks)).toString('utf8'));
}

/**
 * A session by its number (as the screen shows it, #982) or its id. The number lives only inside
 * the gzipped session record, so the label is tried first ("Session #982" unless renamed), then the
 * newest sessions are opened one by one; what is found is remembered in archive/d1/.seq-index.json.
 */
function resolveSession(ref) {
    if (!ref) fail('say which session: its number (982) or its id');
    if (UUID.test(ref)) return ref;
    const seq = Number(/^#?(\d+)$/.exec(ref)?.[1]);
    if (!Number.isInteger(seq)) fail(`"${ref}" is neither a session number nor an id`);
    const indexFile = path.join(root, 'archive', 'd1', '.seq-index.json');
    const index = existsSync(indexFile) ? JSON.parse(readFileSync(indexFile, 'utf8')) : {};
    const key = `${where}:${seq}`;
    if (index[key]) return index[key];
    const rows = query('SELECT id, label FROM sessions ORDER BY created_at DESC LIMIT 400');
    const byLabel = rows.filter(r => new RegExp(`#${seq}(?!\\d)`).test(r.label ?? ''));
    const scan = Number(flags.scan ?? 30);
    for (const r of [...byLabel, ...rows.filter(x => !byLabel.includes(x)).slice(0, scan)]) {
        const s = readBlob(r.id, 'session_json_gz');
        if (s?.seq === seq) {
            mkdirSync(path.dirname(indexFile), { recursive: true });
            writeFileSync(indexFile, JSON.stringify({ ...index, [key]: r.id }, null, 1));
            return r.id;
        }
    }
    fail(`no session #${seq} among the newest ${scan} (or labelled with it); pass its id, or --scan N`);
}

function entriesFor(id) {
    return entriesOf(query(`SELECT id, session_id, at, author, body_json FROM notebook_entries WHERE session_id = ${q(id)} ORDER BY at, id`));
}

function add(id, body) {
    const entry = deskEntry(id, body);
    if (flags.dry) {
        console.log(JSON.stringify(entry, null, 2));
        console.log('(dry: nothing written)');
        return;
    }
    query(insertSql(entry));
    if (!query(`SELECT 1 AS one FROM notebook_entries WHERE id = ${q(entry.id)}`).length) {
        fail(`not added: session ${id} is not in the ${flags.local ? 'local D1' : 'store'}`);
    }
    console.log(`added ${body.kind} ${entry.id} to ${id} as DESK. The owner's device takes it in when it next opens or syncs the session.`);
}

function pull(id) {
    const session = readBlob(id, 'session_json_gz');
    if (!session || session.id !== id) fail('the session record does not match its id');
    const record = readBlob(id, 'log_json_gz');
    const bins = readBlob(id, 'binaries_json_gz');
    const entries = entriesFor(id);

    const runData = [...(record?.runs ?? []).map(r => r.data ?? []), ...(record?.data?.length ? [record.data] : [])];
    const runs = runData.map((data, i) => ({ n: i + 1, points: data.length }));

    const parents = [];
    for (let p = session.parentSessionId, depth = 0; p && depth < Number(flags.parents ?? 3); depth++) {
        let parent;
        try { parent = readBlob(p, 'session_json_gz'); } catch { break; }
        if (!parent) break;
        parents.push({ session: parent, entries: entriesFor(p) });
        p = parent.parentSessionId;
    }

    const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo', dateStyle: 'short' }).format(new Date());
    const dir = path.resolve(flags.out ?? path.join(root, 'archive', 'd1', day, id));
    mkdirSync(dir, { recursive: true });
    const json = (name, value) => writeFileSync(path.join(dir, name), JSON.stringify(value));
    json('session.json', session);
    if (record) json('log-record.json', record);
    if (record?.data?.length) json('log.json', record.data);
    runData.forEach((data, i) => json(`run-${i + 1}.json`, data));
    if (bins) json('binaries.json', bins);
    for (const kind of ['base', 'tuned']) {
        if (!bins?.[kind]) continue;
        const bytes = Buffer.from(bins[kind], 'base64');
        const expected = kind === 'base' ? session.baseSha256 : session.sha256;
        const sha = createHash('sha256').update(bytes).digest('hex');
        if (expected && expected.toLowerCase() !== sha) console.warn(`${kind}.bin: SHA-256 differs from the session record`);
        writeFileSync(path.join(dir, `${kind}.bin`), bytes);
    }
    json('notebook.json', { session: { id, seq: session.seq, label: session.label }, entries, parents: parents.map(p => ({ id: p.session.id, seq: p.session.seq, label: p.session.label, entries: p.entries })) });
    writeFileSync(path.join(dir, 'notebook.md'), renderNotebook({ session, runs, entries, parents }));
    console.log(`#${session.seq} ${session.label}: ${runs.length} run(s), ${entries.length} notebook entries${parents.length ? `, ${parents.length} earlier session(s)` : ''}.`);
    console.log(`Read first: ${path.join(dir, 'notebook.md')}`);
}

const [command, ref, ...rest] = words;
try {
    switch (command) {
        case 'pull':
            pull(resolveSession(ref));
            break;
        case 'plan': {
            const file = rest[0];
            if (!file || !existsSync(file)) fail('plan needs a plan file (plan.md or plan.json)');
            const fields = parsePlanFile(readFileSync(file, 'utf8'), file);
            const id = resolveSession(ref);
            add(id, planBody(entriesFor(id), fields));
            break;
        }
        case 'ask': {
            const [to, text] = rest;
            if (!['driver', 'owner', 'chat'].includes(to)) fail('ask is for the driver, the owner or the chat: ask <session> driver "…"');
            const id = resolveSession(ref);
            add(id, { kind: 'ask', to, text, ...(flags.about ? { about: parseEvidence(flags.about) } : {}) });
            break;
        }
        case 'answer': {
            const [askId, text] = rest;
            const id = resolveSession(ref);
            add(id, answerBody(entriesFor(id), askId, text));
            break;
        }
        case 'finding': {
            const [kind, text] = rest;
            const id = resolveSession(ref);
            if (kind === 'fact') {
                if (!flags.evidence) fail('a fact needs --evidence RUN:FROM-TO:CHANNELS; without it, it is a read (with --sure)');
                add(id, { kind: 'fact', text, evidence: parseEvidence(flags.evidence) });
            } else if (kind === 'read') {
                const entries = flags.re ? entriesFor(id) : [];
                add(id, {
                    kind: 'read', text, sure: flags.sure,
                    ...(flags.evidence ? { evidence: parseEvidence(flags.evidence) } : {}),
                    ...(flags.re ? { re: mustExist(entries, flags.re) } : {}),
                });
            } else fail('finding is fact or read');
            break;
        }
        case 'status': {
            const [entryId, to] = rest;
            const id = resolveSession(ref);
            add(id, { kind: 'status', re: mustExist(entriesFor(id), entryId), to });
            break;
        }
        default:
            console.log(readFileSync(import.meta.filename, 'utf8').split('*/')[0].replace(/^\/\*\*\n?/, '').replace(/^ \* ?/gm, ''));
            process.exit(command ? 1 : 0);
    }
} catch (error) {
    fail(error instanceof Error ? error.message : String(error));
}
