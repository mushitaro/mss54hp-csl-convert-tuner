import { Env, MAX_GZ_BYTES, bad, decodeBase64, isGzip, ok, preflight, requireToken } from '../../_shared';

/**
 * Link diagnostics — one row per read, write or datalog.
 *
 * Deliberately a sibling of /api/sessions rather than part of it. A session is uploaded because the
 * driver pressed a button and wants their work somewhere else; a diagnostic uploads itself, is
 * worth most for the operations that FAILED, and those are exactly the ones that never produce a
 * session worth syncing. See migrations/0003_diagnostics.sql.
 */

/** Every column except the payload. The list must never inflate a record to describe it. */
const LIST_COLUMNS = `
    id, synced_at, created_at, kind, completed, error, vin, transport, mock, session_id,
    exchanges, elapsed_ms, baud, requested_baud, retries,
    median_turnaround, median_total, median_host_gap, app_build,
    length(payload_gz) AS payload_bytes
`;

export const onRequestOptions = () => preflight();

/**
 * GET /api/diagnostics — most recent first.
 *
 * `?kind=write` narrows it, because the one question asked of this table more than any other is
 * "how did the last few flashes go" and scrolling past a hundred datalogs to answer it is how a
 * listing stops being used.
 */
export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
    const denied = requireToken(request, env);
    if (denied) return denied;

    const url = new URL(request.url);
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? 100)));
    const kind = url.searchParams.get('kind');
    // Validated against the known set rather than interpolated. It is a bound parameter either way,
    // but an unknown kind silently returning zero rows reads as "nothing has run" — which is the
    // wrong answer to give about a diagnostics table.
    if (kind !== null && !['read', 'write', 'log'].includes(kind)) {
        return bad(`Unknown kind "${kind}". Expected read, write or log.`);
    }

    const { results } = kind === null
        ? await env.RUNS_DB.prepare(`SELECT ${LIST_COLUMNS} FROM diagnostics ORDER BY created_at DESC LIMIT ?`)
            .bind(limit).all()
        : await env.RUNS_DB.prepare(`SELECT ${LIST_COLUMNS} FROM diagnostics WHERE kind = ? ORDER BY created_at DESC LIMIT ?`)
            .bind(kind, limit).all();

    return ok({ diagnostics: results });
};

interface DiagnosticBody {
    id: string;
    kind: string;
    createdAt: number;
    completed: boolean;
    error?: string | null;
    vin?: string | null;
    transport?: string | null;
    mock?: boolean;
    sessionId?: string | null;
    exchanges?: number;
    elapsedMs?: number;
    retries?: number | null;
    baud?: number | null;
    requestedBaud?: number | null;
    medianTurnaround?: number | null;
    medianTotal?: number | null;
    medianHostGap?: number | null;
    appBuild?: string | null;
    /** base64 of the gzipped DiagnosticRecord. */
    payloadGz: string;
}

/**
 * POST /api/diagnostics — store one record.
 *
 * Idempotent on the client's id, like the session route: a phone in a garage drops uploads often
 * enough that a retry replacing rather than duplicating is the normal path, not the exceptional one.
 */
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
    const denied = requireToken(request, env);
    if (denied) return denied;

    let body: DiagnosticBody;
    try {
        body = await request.json<DiagnosticBody>();
    } catch {
        return bad('Body is not JSON.');
    }

    if (!body.id || !body.kind || !body.payloadGz) return bad('id, kind and payloadGz are all required.');
    if (!['read', 'write', 'log'].includes(body.kind)) return bad(`Unknown kind "${body.kind}".`);
    if (!Number.isFinite(body.createdAt)) return bad('createdAt must be a number.');

    let payload: Uint8Array;
    try { payload = decodeBase64(body.payloadGz); } catch { return bad('payloadGz is not valid base64.'); }
    if (!isGzip(payload)) return bad('payloadGz is not gzip data.');
    if (payload.byteLength > MAX_GZ_BYTES) {
        // A diagnostic this large is not a diagnostic. The sampled-trace cap in TransferTiming is
        // what normally keeps it to single-digit KB, so hitting this means that cap has been raised
        // or the event log has started carrying per-exchange lines — both of which are worth
        // hearing about as an error rather than as a silent D1 rejection.
        return bad(
            `payloadGz is ${(payload.byteLength / 1024).toFixed(0)} KB compressed; the limit is `
            + `${(MAX_GZ_BYTES / 1024).toFixed(0)} KB. A diagnostic that big has stopped being a summary.`,
            413);
    }

    await env.RUNS_DB.prepare(`
        INSERT INTO diagnostics (
            id, synced_at, created_at, kind, completed, error, vin, transport, mock, session_id,
            exchanges, elapsed_ms, baud, requested_baud, retries,
            median_turnaround, median_total, median_host_gap, payload_gz, app_build
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET
            synced_at = excluded.synced_at,
            completed = excluded.completed,
            error = excluded.error,
            exchanges = excluded.exchanges,
            elapsed_ms = excluded.elapsed_ms,
            baud = excluded.baud,
            requested_baud = excluded.requested_baud,
            retries = excluded.retries,
            median_turnaround = excluded.median_turnaround,
            median_total = excluded.median_total,
            median_host_gap = excluded.median_host_gap,
            payload_gz = excluded.payload_gz,
            app_build = excluded.app_build
    `).bind(
        body.id, Date.now(), body.createdAt, body.kind, body.completed ? 1 : 0, body.error ?? null,
        body.vin ?? null, body.transport ?? null, body.mock ? 1 : 0, body.sessionId ?? null,
        body.exchanges ?? 0, body.elapsedMs ?? 0, body.baud ?? null, body.requestedBaud ?? null,
        body.retries ?? null,
        body.medianTurnaround ?? null, body.medianTotal ?? null, body.medianHostGap ?? null,
        payload, body.appBuild ?? null,
    ).run();

    return ok({ id: body.id, storedBytes: payload.byteLength });
};
