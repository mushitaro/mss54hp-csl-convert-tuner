import { Env, bad, corsHeaders, ok, preflight, requireToken } from '../../_shared';

export const onRequestOptions = () => preflight();

/**
 * D1 hands a BLOB back as a plain `number[]`, not an ArrayBuffer, and both shapes are declared in
 * the wild depending on version. Assuming the wrong one fails silently — the stream errors after
 * the headers are on the wire and the client gets 200 with an empty body.
 */
function toBase64(value: ArrayBuffer | number[] | Uint8Array | null): string | null {
    if (value === null || value === undefined) return null;
    const bytes = value instanceof Uint8Array ? value
        : Array.isArray(value) ? Uint8Array.from(value)
            : new Uint8Array(value);
    const CHUNK = 0x8000;
    let binary = '';
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
}

/**
 * GET /api/sessions/:id — the whole session back, ready to be written into the local database.
 *
 * Returned still gzipped, base64'd in JSON, exactly as it was sent. The client inflates: that keeps
 * one compression boundary rather than two, and means what comes back is byte-identical to what
 * went out — which is the property a restore has to have.
 */
export const onRequestGet: PagesFunction<Env, 'id'> = async ({ request, env, params }) => {
    const denied = requireToken(request, env);
    if (denied) return denied;

    const row = await env.RUNS_DB
        .prepare(`SELECT id, label, created_at, status, vin, point_count, app_build,
                         session_json_gz, log_json_gz, binaries_json_gz
                  FROM sessions WHERE id = ?`)
        .bind(String(params.id))
        .first<{
            id: string; label: string; created_at: number; status: string | null; vin: string | null;
            point_count: number; app_build: string | null;
            session_json_gz: ArrayBuffer | number[];
            log_json_gz: ArrayBuffer | number[] | null;
            binaries_json_gz: ArrayBuffer | number[] | null;
        }>();

    if (!row) return bad('No such session.', 404);

    return ok({
        id: row.id,
        label: row.label,
        createdAt: row.created_at,
        status: row.status,
        vin: row.vin,
        pointCount: row.point_count,
        appBuild: row.app_build,
        sessionGz: toBase64(row.session_json_gz),
        logGz: toBase64(row.log_json_gz),
        binariesGz: toBase64(row.binaries_json_gz),
    });
};

/**
 * DELETE /api/sessions/:id — for the session that was a false start.
 *
 * Present because the alternative is a list that only grows, and a driver who stops trusting it.
 * Same token as everything else: there is one user, and a second permission tier would be ceremony
 * rather than security.
 */
export const onRequestDelete: PagesFunction<Env, 'id'> = async ({ request, env, params }) => {
    const denied = requireToken(request, env);
    if (denied) return denied;

    const result = await env.RUNS_DB.prepare('DELETE FROM sessions WHERE id = ?')
        .bind(String(params.id)).run();
    if (!result.meta.changes) return bad('No such session.', 404);
    return new Response(null, { status: 204, headers: corsHeaders() });
};
