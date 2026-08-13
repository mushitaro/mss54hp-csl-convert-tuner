import { TransferTimingReport } from '@/lib/dme-link/transferTiming';
import { LinkEventLogSnapshot } from '@/lib/dme-link/linkEventLog';
import { TransportKind } from '@/lib/dme-link/byteTransport';
import { SyncSettings, canSync, gzipJson, gunzipJson, toBase64, fromBase64, call, buildIdentity } from './client';

/**
 * Uploading what the link actually did, so a failure in a car can be read at a desk.
 *
 * ## Why this is not just "save the JSON"
 *
 * There is a download button, and it works. It is also the wrong instrument for the situation this
 * exists for. The operations worth diagnosing happen on a phone, in a garage, with the engine off
 * and a laptop nowhere nearby; on Android the artifact lands in Downloads and getting it out means
 * a share sheet, a cable, or a cloud round trip performed by someone who has just had a flash fail.
 * Historically that means the report is not looked at, or is looked at three days later next to
 * four others with no way to tell which run is which.
 *
 * The store is already there for sessions. This puts the diagnostics beside them, on the same
 * origin, behind the same token, so `npm run db:diagnostics` at a desk shows every run in order.
 *
 * ## Why it uploads by itself, and the session sync does not
 *
 * Sessions are synced on an explicit press because a session is the user's work and a background
 * task that quietly gave up would be a lie about where their data is. A diagnostic record is the
 * opposite: it is worthless unless it is captured at the moment of failure, it is small, and nobody
 * will ever press a button for one. So it is best-effort and silent — it never throws into a
 * caller, never blocks a UI transition, and a failed upload leaves the downloadable copy exactly as
 * it was.
 */

export interface DiagnosticRecord {
    id: string;
    /** Stated by the caller rather than read off the report, because a record can exist without
     *  one — see `report` below. */
    kind: TransferTimingReport['kind'];
    /** Client clock at capture. The server stamps its own arrival time separately; they disagree,
     *  and picking one loses information. */
    createdAt: number;
    completed: boolean;
    error: string | null;
    vin: string | null;
    softwareVersion: string | null;
    transport: TransportKind | null;
    /** True for PRACTICE. Kept because a mock run's numbers are its own `delay()` calls, and a
     *  listing that mixed them in with real ones would be worse than not having a listing. */
    mock: boolean;
    /** The session this ran under, when there was one, so a record can be tied back to its tune. */
    sessionId: string | null;
    /**
     * Null when the operation died before the instrument was armed.
     *
     * That is not a hypothetical gap, it is the most interesting failure there is: the timing window
     * opens after the login and after the baud switch, so a refused login, a switch the DME accepts
     * and then goes silent on, or a transport that never opens all produce no report at all. The
     * first version of this returned early on a missing report and uploaded nothing — which meant
     * the errors most worth reading were the exact ones that left no trace. A record with a null
     * report and a populated `error` is a complete answer to "what happened"; silence is not.
     */
    report: TransferTimingReport | null;
    events: LinkEventLogSnapshot | null;
}

/** Row shape the list endpoint returns — everything except the compressed payload. */
export interface StoredDiagnostic {
    id: string;
    synced_at: number;
    created_at: number;
    kind: string;
    completed: number;
    error: string | null;
    vin: string | null;
    transport: string | null;
    mock: number;
    session_id: string | null;
    exchanges: number;
    elapsed_ms: number;
    baud: number | null;
    requested_baud: number | null;
    median_turnaround: number | null;
    median_total: number | null;
    median_host_gap: number | null;
    app_build: string | null;
    payload_bytes: number;
}

/**
 * What became of an upload. Silent success, nameable failure.
 *
 * It used to return `number | null` and the caller ignored it, which made "the store has no record
 * of that run" indistinguishable from "the run was never uploaded" and from "there is no token on
 * this device". Two rounds of vehicle testing were spent on that ambiguity. The result is a value
 * now, and the UI shows it — quietly when it worked, plainly when it did not.
 */
export type DiagnosticUpload =
    | { ok: true; bytes: number }
    | { ok: false; reason: string };

/**
 * Sends one record.
 *
 * **Never throws.** Every call site is on a path that has just finished a read, a write or a
 * datalog — several of them inside a `finally` — and an upload that rejected there would surface as
 * an unhandled rejection, or worse, replace the operation's own error with a networking one.
 */
export async function uploadDiagnostic(record: DiagnosticRecord, settings: SyncSettings): Promise<DiagnosticUpload> {
    if (!canSync(settings)) {
        // Not an error, and the most likely explanation for an empty store: this build carries no
        // token, or this device was pointed somewhere else. Named rather than swallowed.
        return { ok: false, reason: 'no sync token on this device' };
    }
    try {
        const payloadGz = await gzipJson(record);
        const response = await call(settings, '/api/diagnostics', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                id: record.id,
                kind: record.kind,
                createdAt: record.createdAt,
                completed: record.completed,
                error: record.error,
                vin: record.vin,
                transport: record.transport,
                mock: record.mock,
                sessionId: record.sessionId,
                // Denormalised so the list view can rank runs without inflating any of them. These
                // are the four numbers a sweep is actually read by, and a listing that required a
                // decompression per row to show them would not get used.
                exchanges: record.report?.chunks ?? 0,
                elapsedMs: Math.round(record.report?.elapsedMs ?? 0),
                baud: record.report?.baud ?? null,
                requestedBaud: record.report?.requestedBaud ?? null,
                medianTurnaround: record.report?.median.turnaround ?? null,
                medianTotal: record.report?.median.total ?? null,
                medianHostGap: record.report?.median.hostGap ?? null,
                appBuild: await buildIdentity(),
                payloadGz: toBase64(payloadGz),
            }),
        });
        const body = await response.json() as { storedBytes: number };
        return { ok: true, bytes: body.storedBytes };
    } catch (e) {
        // Still not retried, and still unable to reach the caller as an exception: the record is
        // downloadable either way, the operation it describes has already ended, and an upload must
        // never become the reason a flash reports a failure it did not have. What changed is that
        // the reason comes back instead of being discarded.
        return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
}

export async function listStoredDiagnostics(settings: SyncSettings, limit = 100): Promise<StoredDiagnostic[]> {
    if (!canSync(settings)) throw new Error('No sync token configured.');
    const response = await call(settings, `/api/diagnostics?limit=${limit}`);
    const body = await response.json() as { diagnostics: StoredDiagnostic[] };
    return body.diagnostics;
}

export async function fetchStoredDiagnostic(id: string, settings: SyncSettings): Promise<DiagnosticRecord> {
    if (!canSync(settings)) throw new Error('No sync token configured.');
    const response = await call(settings, `/api/diagnostics/${encodeURIComponent(id)}`);
    const body = await response.json() as { payloadGz: string };
    return gunzipJson<DiagnosticRecord>(fromBase64(body.payloadGz));
}
