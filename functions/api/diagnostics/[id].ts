import { Env, bad, blobToBase64, corsHeaders, ok, preflight, requireToken } from '../../_shared';

export const onRequestOptions = () => preflight();

/**
 * GET /api/diagnostics/:id — the whole record back.
 *
 * Returned still gzipped and base64'd, exactly as it was sent, so there is one compression boundary
 * rather than two and what comes back is byte-identical to what went out. Same rule as the session
 * route, and here it matters for a second reason: this payload is evidence about a hardware
 * failure, and evidence that has been re-encoded on the way out is worth less than evidence that
 * has not.
 */
export const onRequestGet: PagesFunction<Env, 'id'> = async ({ request, env, params }) => {
    const denied = requireToken(request, env);
    if (denied) return denied;

    const row = await env.RUNS_DB
        .prepare('SELECT id, kind, created_at, synced_at, payload_gz FROM diagnostics WHERE id = ?')
        .bind(String(params.id))
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

/** DELETE /api/diagnostics/:id — for the run that was a false start. Same token as everything
 *  else: there is one user, and a second permission tier would be ceremony rather than security. */
export const onRequestDelete: PagesFunction<Env, 'id'> = async ({ request, env, params }) => {
    const denied = requireToken(request, env);
    if (denied) return denied;

    const result = await env.RUNS_DB.prepare('DELETE FROM diagnostics WHERE id = ?')
        .bind(String(params.id)).run();
    if (!result.meta.changes) return bad('No such diagnostic.', 404);
    return new Response(null, { status: 204, headers: corsHeaders() });
};
