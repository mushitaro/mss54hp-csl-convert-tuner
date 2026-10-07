/**
 * Read the run store through this project's Wrangler profile, then export the newest
 * recorded VE session and newest session's BIN. No remote writes or credential changes.
 *
 * Usage: node scripts/fetch-d1-sessions.mjs [--limit 12] [--out archive/d1/<name>]
 *        [--list-only]
 *        [--id <session UUID>] (repeat --id to export specific sessions instead)
 *
 * ID discovery and per-ID reads are deliberately separate: on 2026-10-06 the wide
 * latest-10 query returned API 7403 while these reads on the same database succeeded.
 * The upstream reason is unknown; do not diagnose that response as a missing login.
 * Blob chunks also stay below D1's single-value limit after hex expansion.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('..', import.meta.url));
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const args = process.argv.slice(2);
let limit = 12;
let listOnly = false;
let output = path.join(root, 'archive', 'd1', 'latest');
const requested = [];
for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help') {
        console.log('node scripts/fetch-d1-sessions.mjs [--limit 12] [--out archive/d1/<name>] [--id <UUID>] [--list-only]');
        process.exit(0);
    }
    if (arg === '--list-only') { listOnly = true; continue; }
    if (!['--limit', '--out', '--id'].includes(arg) || !args[i + 1]) throw new Error(`Invalid argument: ${arg}`);
    const value = args[++i];
    if (arg === '--limit') limit = Number(value);
    if (arg === '--out') output = path.resolve(value);
    if (arg === '--id') {
        if (!uuid.test(value)) throw new Error('Session ID must be a UUID');
        requested.push(value);
    }
}
if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('--limit must be 1..100');

function queryOnce(sql) {
    const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'wrangler.mjs'),
        'd1', 'execute', 'mss54hp-tuner-runs', '--remote', '--json', '--command', sql],
        { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true });
    if (result.error) throw result.error;
    let parsed;
    try { parsed = JSON.parse(result.stdout.trim()); }
    catch { throw new Error(`Wrangler returned non-JSON output (exit ${result.status})`); }
    if (result.status !== 0 || !Array.isArray(parsed) || parsed.some(r => !r.success)) {
        throw new Error(`D1 read failed: ${JSON.stringify(parsed.error ?? parsed).slice(0, 1200)}`);
    }
    return parsed.flatMap(r => r.results);
}
function query(sql) {
    // The same read failed with API 7403 and later succeeded unchanged on 2026-10-07.
    // Retry this observed intermittent response only; persistent errors still surface.
    for (let attempt = 0; ; attempt++) {
        try { return queryOnce(sql); }
        catch (error) {
            if (attempt >= 2 || !/\b7403\b/.test(String(error))) throw error;
            console.warn(`D1 returned API 7403; retrying the same read (${attempt + 1}/2).`);
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, (attempt + 1) * 1000);
        }
    }
}
const columns = new Set(['session_json_gz', 'log_json_gz', 'binaries_json_gz']);
function readBlob(id, column) {
    if (!uuid.test(id) || !columns.has(column)) throw new Error('Invalid blob selector');
    const row = query(`SELECT length(${column}) AS size FROM sessions WHERE id='${id}'`)[0];
    if (!row) throw new Error(`Session not found: ${id}`);
    if (row.size === null || row.size === 0) return null;
    const chunks = [];
    const chunkBytes = 128 * 1024;
    for (let start = 1; start <= row.size; start += chunkBytes) {
        const part = query(`SELECT hex(substr(${column},${start},${chunkBytes})) AS part FROM sessions WHERE id='${id}'`)[0]?.part;
        if (typeof part !== 'string' || !/^(?:[0-9a-f]{2})*$/i.test(part)) throw new Error('Invalid blob chunk');
        chunks.push(Buffer.from(part, 'hex'));
    }
    const bytes = Buffer.concat(chunks);
    if (bytes.length !== row.size) throw new Error('Blob length changed during export; rerun after sync completes');
    return JSON.parse(gunzipSync(bytes).toString('utf8'));
}
const discovered = requested.length ? [...new Set(requested)]
    : query(`SELECT id FROM sessions ORDER BY created_at DESC LIMIT ${limit}`).map(r => r.id);
const sessions = [];
for (const id of discovered) {
    const session = readBlob(id, 'session_json_gz');
    if (!session || session.id !== id) throw new Error('Session identity mismatch');
    sessions.push(session);
}
const summary = sessions.map(s => ({ id: s.id, seq: s.seq, label: s.label, process: s.process ?? null,
    createdJst: new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo', dateStyle: 'short', timeStyle: 'medium' }).format(new Date(s.createdAt)),
    pointCount: s.logPointCount ?? 0, status: s.status }));
if (listOnly) {
    console.log(JSON.stringify(summary, null, 2));
    process.exit(0);
}
mkdirSync(output, { recursive: true });
writeFileSync(path.join(output, 'sessions.json'), JSON.stringify(summary, null, 2));
const newestVe = sessions.find(s => s.process === 'VE' && s.logPointCount > 0);
if (!requested.length && !newestVe) console.warn(`No recorded VE session found in the newest ${limit} sessions; increase --limit or use --id.`);
const selected = requested.length ? sessions : [...new Set([sessions[0], newestVe].filter(Boolean))];
const exported = [];
for (const session of selected) {
    const id = session.id;
    const log = readBlob(id, 'log_json_gz');
    const bins = readBlob(id, 'binaries_json_gz');
    // A sync while blobs are being read could mix two revisions under the same UUID.
    if (JSON.stringify(readBlob(id, 'session_json_gz')) !== JSON.stringify(session)) {
        throw new Error('Session changed during export; rerun after sync completes');
    }
    if (log?.sessionId && log.sessionId !== id) throw new Error('Log identity mismatch');
    const points = Array.isArray(log) ? log : log?.data;
    if (log && !Array.isArray(points)) throw new Error('Unrecognised log format');
    if (points && points.length !== (session.logPointCount ?? 0)) throw new Error('Log count differs from session metadata');
    const directory = path.join(output, id);
    mkdirSync(directory, { recursive: true });
    const saveJson = (name, value) => writeFileSync(path.join(directory, name), JSON.stringify(value));
    saveJson('session.json', session);
    saveJson('binaries.json', bins);
    if (points) saveJson('log.json', points);
    if (log?.idle) saveJson('idle.json', log.idle);
    const binaries = {};
    for (const kind of ['base', 'tuned']) {
        if (!bins?.[kind]) continue;
        const bytes = Buffer.from(bins[kind], 'base64');
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        const expected = kind === 'base' ? session.baseSha256 : session.sha256;
        if (expected && expected.toLowerCase() !== sha256) throw new Error(`${kind} SHA-256 mismatch`);
        writeFileSync(path.join(directory, `${kind}.bin`), bytes);
        binaries[kind] = { bytes: bytes.length, sha256, storedHashMatches: expected ? true : null };
    }
    const keys = ['rpm', 'rawLoad', 'rf', 'exhaustTemp', 'stft1', 'stft2', 'ltft1', 'ltft2', 'vehicleSpeed', 'intakeTemp', 'ambientPressure', 'chargeTemp'];
    const item = { id, label: session.label, process: session.process, directory, pointCount: points?.length ?? 0,
        binaries, channelCounts: Object.fromEntries(keys.map(k => [k, points?.filter(p => Number.isFinite(p[k])).length ?? 0])) };
    exported.push(item);
    console.log(JSON.stringify(item));
}
writeFileSync(path.join(output, 'export-summary.json'), JSON.stringify({ sessions: summary, exported }, null, 2));
console.log(`Saved ${summary.length} session summaries and ${exported.length} exports to ${output}`);
