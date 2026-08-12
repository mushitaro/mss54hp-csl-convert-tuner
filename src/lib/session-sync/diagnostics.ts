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
    report: TransferTimingReport;
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
 * Sends one record. Resolves to the stored size, or null when it could not be sent.
 *
 * **Never throws.** Every call site is on a path that has just finished a read, a write or a
 * datalog — several of them inside a `finally` — and an upload that rejected there would surface as
 * an unhandled rejection, or worse, replace the operation's own error with a networking one.
 */
export async function uploadDiagnostic(record: DiagnosticRecord, settings: SyncSettings): Promise<number | null> {
    if (!canSync(settings)) return null;
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
                exchanges: record.report.chunks,
                elapsedMs: Math.round(record.report.elapsedMs),
                baud: record.report.baud,
                requestedBaud: record.report.requestedBaud,
                medianTurnaround: record.report.median.turnaround,
                medianTotal: record.report.median.total,
                medianHostGap: record.report.median.hostGap,
                appBuild: await buildIdentity(),
                payloadGz: toBase64(payloadGz),
            }),
        });
        const body = await response.json() as { storedBytes: number };
        return body.storedBytes;
    } catch {
        // Deliberately swallowed, and deliberately not retried. The record is still downloadable,
        // the operation it describes has already ended, and the one thing an upload must never do
        // is become the reason a flash reports a failure it did not have.
        return null;
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
