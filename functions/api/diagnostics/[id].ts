import { Env, bad, blobToBase64, noContent, ok, ownerOf, unauthorized } from '../../_shared';

/**
 * GET /api/diagnostics/:id — the whole record back.
 *
 * Returned still gzipped and base64'd, exactly as it was sent, so there is one compression boundary
 * rather than two and what comes back is byte-identical to what went out. Same rule as the session
 * route, and here it matters for a second reason: this payload is evidence about a hardware
 * failure, and evidence that has been re-encoded on the way out is worth less than evidence that
 * has not.
 *
 * Someone else's id answers 404, like one that does not exist.
 */
export const onRequestGet: PagesFunction<Env, 'id'> = async ({ env, params, data }) => {
    const owner = ownerOf(data);
    if (!owner) return unauthorized();

    const row = await env.RUNS_DB
        .prepare('SELECT id, kind, created_at, synced_at, payload_gz FROM diagnostics WHERE id = ? AND owner = ?')
        .bind(String(params.id), owner.id)
        .first<{
            id: string; kind: string; created_at: number; synced_at: number;
            payload_gz: ArrayBuffer | number[];
        }>();

    if (!row) return bad('No such diagnostic.', 404);

    return ok({
        id: row.id,
        kind: row.kind,
        createdAt: row.created_at,
        syncedAt: row.synced_at,
        payloadGz: blobToBase64(row.payload_gz),
    });
};

/** DELETE /api/diagnostics/:id — the owner's own record, from the list in the SYNC panel. A foreign
 *  id deletes nothing and answers 404. */
export const onRequestDelete: PagesFunction<Env, 'id'> = async ({ env, params, data }) => {
    const owner = ownerOf(data);
    if (!owner) return unauthorized();

    const result = await env.RUNS_DB.prepare('DELETE FROM diagnostics WHERE id = ? AND owner = ?')
        .bind(String(params.id), owner.id).run();
    if (!result.meta.changes) return bad('No such diagnostic.', 404);
    return noContent();
};
