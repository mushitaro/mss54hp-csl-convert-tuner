import { Env, MAX_GZ_BYTES, bad, ok, preflight, requireToken } from '../../_shared';

/** Every column except the three blobs. The list must never inflate a session to describe it. */
const LIST_COLUMNS = `
    id, synced_at, label, created_at, status, vin, point_count,
    has_tune, has_rf, has_egt, app_build,
    length(session_json_gz)  AS session_bytes,
    length(log_json_gz)      AS log_bytes,
    length(binaries_json_gz) AS binaries_bytes
`;

export const onRequestOptions = () => preflight();

/**
 * GET /api/sessions — most recent first.
 *
 * No pagination. This is one person's own sessions; the day it needs paging it needs a different
 * design, and a limit that silently dropped the oldest would be worse than either.
 */
export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
    const denied = requireToken(request, env);
    if (denied) return denied;

    const limit = Math.min(200, Math.max(1, Number(new URL(request.url).searchParams.get('limit') ?? 100)));
    const { results } = await env.RUNS_DB
        .prepare(`SELECT ${LIST_COLUMNS} FROM sessions ORDER BY created_at DESC LIMIT ?`)
        .bind(limit)
        .all();

    return ok({ sessions: results });
};

interface SyncBody {
    id: string;
    label: string;
    createdAt: number;
    status?: string;
    vin?: string;
    pointCount?: number;
    hasTune?: boolean;
    hasRf?: boolean;
    hasEgt?: boolean;
    appBuild?: string;
    /** base64 of gzipped JSON. JSON cannot carry bytes and multipart buys nothing here. */
    sessionGz: string;
    logGz?: string | null;
    binariesGz?: string | null;
}

function decode(b64: string): Uint8Array {
    const binary = atob(b64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
}

/** gzip starts 1f 8b. Checked because a payload that will not inflate months from now is
 *  indistinguishable from a session that was never synced. */
const isGzip = (b: Uint8Array) => b.byteLength >= 3 && b[0] === 0x1f && b[1] === 0x8b;

/**
 * POST /api/sessions — store one session, exactly as the local database holds it.
 *
 * Idempotent on the session's own id: re-syncing replaces. That is the behaviour a phone with an
 * unreliable connection needs, and it is also what makes "sync after every change" safe.
 */
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
    const denied = requireToken(request, env);
    if (denied) return denied;

    let body: SyncBody;
    try {
        body = await request.json<SyncBody>();
    } catch {
        return bad('Body is not JSON.');
    }

    if (!body.id || !body.label || !body.sessionGz) {
        return bad('id, label and sessionGz are all required.');
    }
    if (!Number.isFinite(body.createdAt)) return bad('createdAt must be a number.');

    const parts: Array<{ name: string; b64: string | null | undefined }> = [
        { name: 'sessionGz', b64: body.sessionGz },
        { name: 'logGz', b64: body.logGz },
        { name: 'binariesGz', b64: body.binariesGz },
    ];
    const blobs: Record<string, Uint8Array | null> = {};
    for (const part of parts) {
        if (!part.b64) { blobs[part.name] = null; continue; }
        let bytes: Uint8Array;
        try { bytes = decode(part.b64); } catch { return bad(`${part.name} is not valid base64.`); }
        if (!isGzip(bytes)) return bad(`${part.name} is not gzip data.`);
        // Checked before the insert rather than caught after it: D1's own error for an oversized
        // value is generic, and the useful answer — which part, how far over — is only available
        // here. Each part has its own budget, which is why they are three columns and not one.
        if (bytes.byteLength > MAX_GZ_BYTES) {
            return bad(
                `${part.name} is ${(bytes.byteLength / 1024).toFixed(0)} KB compressed; the limit `
                + `is ${(MAX_GZ_BYTES / 1024).toFixed(0)} KB per part. Split the drive into shorter runs.`,
                413);
        }
        blobs[part.name] = bytes;
    }

    await env.RUNS_DB.prepare(`
        INSERT INTO sessions (
            id, synced_at, label, created_at, status, vin, point_count,
            has_tune, has_rf, has_egt, session_json_gz, log_json_gz, binaries_json_gz, app_build
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET
            synced_at = excluded.synced_at,
            label = excluded.label,
            status = excluded.status,
            vin = excluded.vin,
            point_count = excluded.point_count,
            has_tune = excluded.has_tune,
            has_rf = excluded.has_rf,
            has_egt = excluded.has_egt,
            session_json_gz = excluded.session_json_gz,
            log_json_gz = excluded.log_json_gz,
            binaries_json_gz = excluded.binaries_json_gz,
            app_build = excluded.app_build
    `).bind(
        body.id, Date.now(), body.label, body.createdAt, body.status ?? null, body.vin ?? null,
        body.pointCount ?? 0, body.hasTune ? 1 : 0, body.hasRf ? 1 : 0, body.hasEgt ? 1 : 0,
        blobs.sessionGz, blobs.logGz, blobs.binariesGz, body.appBuild ?? null,
    ).run();

    const stored = parts.reduce((n, p) => n + (blobs[p.name]?.byteLength ?? 0), 0);
    return ok({ id: body.id, storedBytes: stored });
};
