import { Env, bad, blobToBase64, corsHeaders, ok, preflight, requireToken } from '../../_shared';

export const onRequestOptions = () => preflight();

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
        sessionGz: blobToBase64(row.session_json_gz),
        logGz: blobToBase64(row.log_json_gz),
        binariesGz: blobToBase64(row.binaries_json_gz),
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
