import { bad, ok, ownerOf, unauthorized } from '../../../_shared';
// Type-only, on its own line: verify:notebook loads this file through Node's type stripping, which
// cannot tell a type in a named import from a value.
import type { Env } from '../../../_shared';
import { entryProblem, type NotebookEntry } from '../../../../src/lib/notebook/rules';

/**
 * The session's experiment notebook in the store — see src/lib/notebook/rules.ts for what it is.
 *
 * GET  /api/sessions/:id/notebook[?since=<stored_at>]   the entries, oldest first
 * POST /api/sessions/:id/notebook  { entries: [...] }    adds the ones the store has not got
 *
 * The rules are the tab's own file, imported rather than restated: a note the assistant wrote in
 * the driver's name, or a fact with no evidence, is refused here with the same sentence the tab
 * gives, so a writer that skipped the tab — or an older tab — cannot put one in.
 *
 * Only for a session row the same owner has: the notebook belongs to a session that is in the store.
 * Another owner's id answers 404, as for the session itself.
 */

const MAX_ENTRIES_PER_POST = 200;

async function ownsSession(env: Env, sessionId: string, owner: string): Promise<boolean> {
    const row = await env.RUNS_DB.prepare('SELECT 1 AS one FROM sessions WHERE id = ? AND owner = ?')
        .bind(sessionId, owner).first<{ one: number }>();
    return !!row;
}

export const onRequestGet: PagesFunction<Env, 'id'> = async ({ env, params, data, request }) => {
    const owner = ownerOf(data);
    if (!owner) return unauthorized();
    const sessionId = String(params.id);
    if (!await ownsSession(env, sessionId, owner.id)) return bad('No such session.', 404);

    const since = Number(new URL(request.url).searchParams.get('since') ?? 0);
    const rows = await env.RUNS_DB.prepare(`
        SELECT id, session_id, at, author, body_json, stored_at FROM notebook_entries
        WHERE owner = ? AND session_id = ? AND stored_at > ?
        ORDER BY at, id`)
        .bind(owner.id, sessionId, Number.isFinite(since) ? since : 0)
        .all<{ id: string; session_id: string; at: number; author: string; body_json: string; stored_at: number }>();

    const entries: NotebookEntry[] = [];
    let latest = 0;
    for (const r of rows.results ?? []) {
        latest = Math.max(latest, r.stored_at);
        entries.push({ id: r.id, sessionId: r.session_id, at: r.at, by: r.author as NotebookEntry['by'], body: JSON.parse(r.body_json) });
    }
    return ok({ entries, storedAt: latest });
};

export const onRequestPost: PagesFunction<Env, 'id'> = async ({ env, params, data, request }) => {
    const owner = ownerOf(data);
    if (!owner) return unauthorized();
    const sessionId = String(params.id);

    let body: { entries?: unknown };
    try { body = await request.json(); } catch { return bad('Body is not JSON.'); }
    const entries = body.entries;
    if (!Array.isArray(entries) || entries.length === 0) return bad('entries must be a non-empty list.');
    if (entries.length > MAX_ENTRIES_PER_POST) return bad(`At most ${MAX_ENTRIES_PER_POST} entries per request.`);
    for (const [i, e] of entries.entries()) {
        const problem = entryProblem(e);
        if (problem) return bad(`Entry ${i + 1}: ${problem}`, 422);
        if ((e as NotebookEntry).sessionId !== sessionId) return bad(`Entry ${i + 1} belongs to another session.`, 422);
    }
    if (!await ownsSession(env, sessionId, owner.id)) return bad('No such session.', 404);

    const storedAt = Date.now();
    const insert = env.RUNS_DB.prepare(`
        INSERT OR IGNORE INTO notebook_entries (id, session_id, owner, at, author, kind, body_json, stored_at)
        VALUES (?,?,?,?,?,?,?,?)`);
    const results = await env.RUNS_DB.batch((entries as NotebookEntry[]).map(e =>
        insert.bind(e.id, sessionId, owner.id, e.at, e.by, e.body.kind, JSON.stringify(e.body), storedAt)));
    const added = results.reduce((n, r) => n + (r.meta?.changes ?? 0), 0);
    // Every id is answered for — added now or already there — so the sender marks all of them sent.
    return ok({ added, ids: (entries as NotebookEntry[]).map(e => e.id), storedAt });
};
