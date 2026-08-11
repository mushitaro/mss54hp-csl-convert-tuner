import { Env, MAX_GZ_BYTES, bad, ok, preflight, requireToken } from '../../_shared';

/** Every column except the payload. The list must never inflate a run to describe it. */
const LIST_COLUMNS = `
    id, created_at, client_time, label, notes, vin, base_file_name, software_version,
    rf_korr_mode, patch_on, point_count, average_hz, duration_s, has_rf, has_egt,
    csv_bytes, length(csv_gz) AS gz_bytes, app_version
`;

export const onRequestOptions = () => preflight();

/**
 * GET /api/runs — most recent first.
 *
 * No pagination. This is one person's own drives; the day it needs paging is the day it needs a
 * different design, and a limit that silently drops the oldest run would be worse than either.
 * `limit` caps the page for a phone on a slow connection.
 */
export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
    const denied = requireToken(request, env);
    if (denied) return denied;

    const limit = Math.min(200, Math.max(1, Number(new URL(request.url).searchParams.get('limit') ?? 100)));
    const { results } = await env.RUNS_DB
        .prepare(`SELECT ${LIST_COLUMNS} FROM runs ORDER BY created_at DESC LIMIT ?`)
        .bind(limit)
        .all();

    return ok({ runs: results });
};

interface UploadBody {
    id: string;
    label: string;
    /** base64 of the gzipped CSV. JSON cannot carry bytes, and multipart buys nothing here. */
    csvGzBase64: string;
    csvBytes: number;
    clientTime?: number;
    notes?: string;
    vin?: string;
    baseFileName?: string;
    softwareVersion?: string;
    rfKorrMode?: string;
    patchOn?: boolean;
    pointCount: number;
    averageHz?: number;
    durationS?: number;
    hasRf?: boolean;
    hasEgt?: boolean;
    appVersion?: string;
}

/**
 * POST /api/runs — store one run.
 *
 * Idempotent on `id`, which the client mints. A phone in a garage drops its connection mid-upload
 * often enough that "did that land?" is the normal case rather than the exceptional one, and the
 * only honest answer to it is a retry that cannot duplicate.
 */
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
    const denied = requireToken(request, env);
    if (denied) return denied;

    let body: UploadBody;
    try {
        body = await request.json<UploadBody>();
    } catch {
        return bad('Body is not JSON.');
    }

    if (!body.id || !body.label || !body.csvGzBase64) {
        return bad('id, label and csvGzBase64 are all required.');
    }
    if (!Number.isFinite(body.pointCount) || body.pointCount <= 0) {
        return bad('pointCount must be a positive number — an empty run is not worth storing.');
    }

    let gz: Uint8Array;
    try {
        const binary = atob(body.csvGzBase64);
        gz = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) gz[i] = binary.charCodeAt(i);
    } catch {
        return bad('csvGzBase64 is not valid base64.');
    }

    // Checked before the insert, not caught after it. D1's own error for an oversized value is
    // generic, and the useful answer — how far over, and what to do — is only available here.
    if (gz.byteLength > MAX_GZ_BYTES) {
        return bad(
            `Run is ${(gz.byteLength / 1024).toFixed(0)} KB compressed; the limit is `
            + `${(MAX_GZ_BYTES / 1024).toFixed(0)} KB. Split the drive into shorter runs.`, 413);
    }

    // Verify it really is gzip before storing it. A run that turns out to be undecodable months
    // later is indistinguishable from one that was never taken, and the check costs one branch.
    if (gz.byteLength < 3 || gz[0] !== 0x1f || gz[1] !== 0x8b) {
        return bad('Payload is not gzip data.');
    }

    const now = Date.now();
    await env.RUNS_DB.prepare(`
        INSERT INTO runs (
            id, created_at, client_time, label, notes, vin, base_file_name, software_version,
            rf_korr_mode, patch_on, point_count, average_hz, duration_s, has_rf, has_egt,
            csv_gz, csv_bytes, app_version
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET
            label = excluded.label,
            notes = excluded.notes,
            csv_gz = excluded.csv_gz,
            csv_bytes = excluded.csv_bytes
    `).bind(
        body.id, now, body.clientTime ?? null, body.label, body.notes ?? null,
        body.vin ?? null, body.baseFileName ?? null, body.softwareVersion ?? null,
        body.rfKorrMode ?? null, body.patchOn === undefined ? null : (body.patchOn ? 1 : 0),
        body.pointCount, body.averageHz ?? null, body.durationS ?? null,
        body.hasRf ? 1 : 0, body.hasEgt ? 1 : 0,
        gz, body.csvBytes, body.appVersion ?? null,
    ).run();

    return ok({ id: body.id, storedBytes: gz.byteLength });
};
