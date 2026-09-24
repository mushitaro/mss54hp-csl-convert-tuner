// `import type`: Node's type stripping cannot tell a type-only named import from a value one, and
// `verify:preview-notice` loads this module. Same reason as client.ts:1.
import type { TransferTimingReport } from '@/lib/dme-link/transferTiming';
import type { LinkEventLogSnapshot } from '@/lib/dme-link/linkEventLog';
import type { TransportKind } from '@/lib/dme-link/byteTransport';
import { canSync, gzipJson, gunzipJson, toBase64, fromBase64, call, buildIdentity } from './client';
import { api, outbox } from './owner-sync';
import { previewNoticeAcknowledged } from './preview-notice';

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
 * origin, behind the same owner gate, so the SYNC panel — and `npm run db:diagnostics` at a desk —
 * shows every run in order.
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
    retries: number | null;
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
 * Records that could not be sent yet: offline in a garage, or signed out of the preview. Kept in
 * IndexedDB (newest twenty) and sent, oldest first, after the next send that works — see owner-sync.
 * A separate database from the sessions', so clearing one can never take the other with it.
 */
const pending = outbox('tuner-outbox');

/** The body POST /api/diagnostics takes — built once, so a record queued in the outbox is sent later
 *  exactly as it would have been sent now, build identity included. */
async function wireBody(record: DiagnosticRecord) {
    return {
        id: record.id,
        kind: record.kind,
        createdAt: record.createdAt,
        completed: record.completed,
        error: record.error,
        vin: record.vin,
        transport: record.transport,
        mock: record.mock,
        sessionId: record.sessionId,
        // Denormalised so the list view can rank runs without inflating any of them. These are the
        // four numbers a sweep is actually read by, and a listing that required a decompression per
        // row to show them would not get used.
        exchanges: record.report?.chunks ?? 0,
        elapsedMs: Math.round(record.report?.elapsedMs ?? 0),
        baud: record.report?.baud ?? null,
        requestedBaud: record.report?.requestedBaud ?? null,
        // The number that separates "ran fast" from "ran fast and spent it all on settle".
        retries: record.report?.retries ?? null,
        medianTurnaround: record.report?.median.turnaround ?? null,
        medianTotal: record.report?.median.total ?? null,
        medianHostGap: record.report?.median.hostGap ?? null,
        appBuild: await buildIdentity(),
        payloadGz: toBase64(await gzipJson(record)),
    };
}

/**
 * Whether a response settles a queued record for good. A success does; so does a refusal that
 * sending again cannot change (400 malformed, 409 an id that is someone else's, 413 too large) —
 * kept, those would block every record behind them for ever. Signed out (401), rate-limited, the
 * gate unavailable (5xx) or no connection (0) are worth waiting out.
 */
const settled = (status: number) =>
    (status >= 200 && status < 300) || (status >= 400 && status < 500 && ![401, 408, 429].includes(status));

/**
 * Sends what the outbox holds, oldest first, stopping at the first that has to wait. Never throws.
 * Called after any send that worked — a diagnostic or a session — because that is the moment the
 * route is known to be open.
 *
 * Nothing at all before the preview's notice is confirmed — not even the gate check `flush` opens
 * with. What waits keeps waiting, and goes on the first flush after the press (useGateStatus asks
 * again at that moment for exactly this).
 */
export async function flushDiagnostics(): Promise<number> {
    if (!canSync() || !previewNoticeAcknowledged()) return 0;
    return pending.flush(async (body) => settled((await api('/api/diagnostics', { method: 'POST', body })).status));
}

/**
 * Sends one record.
 *
 * **Never throws.** Every call site is on a path that has just finished a read, a write or a
 * datalog — several of them inside a `finally` — and an upload that rejected there would surface as
 * an unhandled rejection, or worse, replace the operation's own error with a networking one.
 *
 * A record that cannot go now goes into the outbox instead of being dropped: the flash that failed
 * in a garage with no signal is the record most worth having, and it is exactly the one a
 * send-or-lose uploader would lose. On production and staging nothing is sent and nothing is kept —
 * they have no store, and the production privacy policy says the data stays on the device.
 *
 * Before the preview's notice is confirmed the record is kept the same way, and not sent: the
 * notice says what goes before any of it does (preview-notice.ts). The dialog is modal, so a record
 * that arrives here first would be one filed by no hand — which is why this does not rely on it.
 */
export async function uploadDiagnostic(record: DiagnosticRecord): Promise<DiagnosticUpload> {
    if (!canSync()) return { ok: false, reason: 'this build has no store' };
    let body: Awaited<ReturnType<typeof wireBody>>;
    try {
        body = await wireBody(record);
    } catch (e) {
        return { ok: false, reason: `could not encode the record: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (!previewNoticeAcknowledged()) {
        await pending.add(body);
        return { ok: false, reason: 'kept on this device until the notice in the first-run dialog is confirmed' };
    }
    const r = await api<{ storedBytes: number }>('/api/diagnostics', { method: 'POST', body });
    if (r.ok) {
        void flushDiagnostics();
        return { ok: true, bytes: r.data?.storedBytes ?? 0 };
    }
    if (!settled(r.status)) {
        // Signed out, offline, or the gate could not reach m3. Kept, and sent after the next send
        // that works. Still not retried here: the operation it describes has already ended, and an
        // upload must never become the reason a flash reports a failure it did not have.
        await pending.add(body);
        return { ok: false, reason: r.expired ? 'signed out — kept on this device until the next send' : 'kept on this device until the next send' };
    }
    return { ok: false, reason: `refused (HTTP ${r.status})` };
}

export async function listStoredDiagnostics(limit = 100): Promise<StoredDiagnostic[]> {
    return (await call<{ diagnostics: StoredDiagnostic[] }>(`/api/diagnostics?limit=${limit}`)).diagnostics;
}

export async function fetchStoredDiagnostic(id: string): Promise<DiagnosticRecord> {
    const body = await call<{ payloadGz: string }>(`/api/diagnostics/${encodeURIComponent(id)}`);
    return gunzipJson<DiagnosticRecord>(fromBase64(body.payloadGz));
}

/** Removes one record from the store. Records are the owner's to delete, like sessions. */
export async function deleteStoredDiagnostic(id: string): Promise<void> {
    await call(`/api/diagnostics/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

