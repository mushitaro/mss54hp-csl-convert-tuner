// `import type` throughout for the types: Node's type stripping cannot tell a type-only named
// import from a value one, and `verify:session-wire` loads this module. Same reason as
// rfKorrTuner.ts:3.
import type { LogDataPoint } from '@/lib/types';
import type { TuningSession, SessionBinariesRecord, SessionLogRecord } from '@/lib/db/schema';
import { getSessionLogRecord, getSessionBinaries, putSessionRaw } from '@/lib/db/sessionRepository';
import { api, isPreviewBuild } from './owner-sync';
import { previewNoticeAcknowledged } from './preview-notice';

/**
 * Syncing a session to the deployment's store, and back.
 *
 * ## Why a server at all
 *
 * A log is recorded on a phone, in a car. Every way of getting it onto a desk afterwards runs
 * through a share sheet and a cable. IndexedDB keeps it safe on the phone; it does not get it
 * anywhere else. A browser cannot write to a server without an HTTP request, so there is an
 * endpoint — but that is the whole of the API's job, and it should be nothing more.
 *
 * ## Why the session, and not a "run"
 *
 * The first version of this invented a second data model: a session re-encoded into a CSV plus a
 * dozen hand-picked metadata columns, with a mapping between the two to keep in step forever. That
 * was work in exchange for a downgrade. A CSV is a log and nothing else — not the BASE it was
 * recorded against, not the tune, not the filter settings that produced it — so what came back was
 * strictly less than what went up.
 *
 * This sends the three IndexedDB stores as they are: the TuningSession record, its LogDataPoint[],
 * and its two binaries. Nothing is re-encoded and nothing is dropped, so a session can come BACK —
 * which is the thing that makes a server copy worth having. Record on the phone, finish at the desk.
 *
 * ## What it is not
 *
 * Not automatic, and not a replacement for the local copy. A session is synced when the driver says
 * so, which means the failure mode of a garage with no signal is a button that reports an error
 * rather than a background task that quietly gave up. Nothing here deletes anything locally.
 */

/**
 * Whether this build talks to a store at all — a fact about the build, not a setting.
 *
 * True on the preview and nowhere else. Production is local-complete (its privacy policy says so,
 * and `sessionSync` is `preview-only` in the registry for that reason); staging is main unmodified
 * and has no `/api`; the dev server has no backend. So every network function below returns early
 * on anything but the preview, and those builds make no sync request of any kind.
 *
 * There is no token and nothing to configure. The preview sits behind the owner gate, which put a
 * session cookie on this origin when the owner arrived from m3; every request here is same-origin
 * and carries it (owner-sync.ts). The shared token that used to be baked into the preview HTML, and
 * the `localStorage` override a bench rig wrote by hand, are gone — the first was readable by
 * anyone who could load the page, and the second pointed a device at a store by hand-typed secret.
 */
export const canSync = (): boolean => isPreviewBuild();

/**
 * Why a store request did not land, in the words the SYNC controls show.
 *
 * A kind as well as a message, because the kinds want different responses: `expired` is fixed by
 * signing in again, `tooLarge` by nothing short of a shorter drive, `offline`/`failed` by trying
 * again — which is what the controls offer — and `notice` by confirming the first-run dialog, which
 * is modal, so no control should ever show it.
 */
export class SyncError extends Error {
    // Declared and assigned rather than a `readonly kind` parameter property: `verify:session-wire`
    // loads this module through Node's type stripping, which cannot erase that syntax.
    readonly kind: 'expired' | 'tooLarge' | 'conflict' | 'offline' | 'failed' | 'notice';
    constructor(kind: SyncError['kind'], message: string) {
        super(message);
        this.kind = kind;
    }
}

/**
 * Why nothing may go to the store from this page yet, or null when it may.
 *
 * Two answers. A build with no store; and, on the preview, a notice not yet confirmed — the first-run
 * dialog says what is sent and why, and until it has been pressed nothing is (preview-notice.ts).
 * Asked before every request below, so no path in this file reaches the network first.
 */
function refusal(): SyncError | null {
    if (!canSync()) return new SyncError('failed', 'This build has no store.');
    if (!previewNoticeAcknowledged()) {
        return new SyncError('notice', 'Nothing is sent until the notice in the first-run dialog is confirmed. Nothing here was lost.');
    }
    return null;
}

/**
 * One same-origin call to this deployment's API. Resolves with the data or throws a SyncError.
 *
 * Built on owner-sync's `api()`, which never throws; this is the half that turns its result into
 * the sentence a control can show. The server's own message is kept where it has one — it is the
 * useful half of a per-part 413, which knows which part was too big.
 */
export async function call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const refused = refusal();
    if (refused) throw refused;
    const r = await api<T & { error?: string }>(path, init);
    if (r.ok) return r.data as T;
    // Told apart from a status, not from `data`: a 204 and a proxy's HTML both come back null.
    const detail = typeof r.data?.error === 'string' ? r.data.error : null;
    if (r.expired) {
        markGateExpired();
        throw new SyncError('expired', 'Signed out of the preview — sign in again to sync. Nothing here was lost.');
    }
    if (r.tooLarge) {
        throw new SyncError('tooLarge', detail && detail !== 'too_large' ? detail : 'Too large to send — the store takes rows up to 1.9 MB.');
    }
    if (r.status === 409) throw new SyncError('conflict', 'That id belongs to another account’s record and cannot be replaced.');
    if (r.status === 0) throw new SyncError('offline', 'No connection to the store.');
    throw new SyncError('failed', detail ?? `Request failed (HTTP ${r.status}).`);
}

/**
 * Listeners for "the gate said this browser is signed out", so the re-auth chip appears the moment
 * a request finds out rather than on the next status poll. See useGateStatus.
 */
const expiredListeners = new Set<() => void>();
export function onGateExpired(listener: () => void): () => void {
    expiredListeners.add(listener);
    return () => { expiredListeners.delete(listener); };
}
export function markGateExpired(): void {
    for (const listener of expiredListeners) listener();
}

// --- What is outstanding -------------------------------------------------------------------------

/**
 * What a stored copy would have to match to still be current.
 *
 * Not a hash of the whole session: `TuningSession` has no `updatedAt`, and half its fields change
 * for reasons a stored copy does not care about (a rename is not a reason to re-send 128 KB over
 * cellular). These are the ones that mean the stored copy is now describing something else — a BASE
 * was chosen or re-read, a log was recorded, a tune was produced, it reached the ECU, or it stopped
 * being a draft.
 *
 * `baseSha256` is in here for a reason that only shows up on a second read: it is hashed from the
 * bytes on every `setSessionBase`, so re-reading the ECU into the same session changes it. Without
 * it, a session synced once with BASE #1 would never be offered again after BASE #2 replaced it.
 */
export const sessionFingerprint = (s: TuningSession): string =>
    `${s.baseSha256 ?? '-'}|${s.sha256 ?? '-'}|${s.logPointCount}|${s.flashHistory.length}|${s.status}`;

/**
 * Whether this session is worth sending and has not been sent as it now stands.
 *
 * The gate exists to keep the control honest: without one, a fresh empty draft counts as outstanding
 * and the button reads "1 waiting" from the moment the app opens, which is a badge nobody reads.
 *
 * **It used to be `hasLog || sha256`, and that was wrong about the most valuable session there is.**
 * A session holding only a BASE just read off the car has no log and no tune, so it could never be
 * synced — reported from the car as "SAVE and SYNC do nothing when all I have is a VIN". Those 64 KB
 * are bytes that exist nowhere else in the world until they are sent, and they are the whole input
 * to a write test. An empty draft is one with no BASE either; that is what this now excludes, and
 * it is what the original guard meant.
 */
export const needsSync = (s: TuningSession): boolean =>
    (s.hasLog || !!s.sha256 || !!s.baseSha256) && s.syncedFingerprint !== sessionFingerprint(s);

// --- Codec ------------------------------------------------------------------------------------
// gzip via the platform. CompressionStream is in every browser that can run the rest of this app —
// Chrome 80+, and the DME link needs Chrome anyway. A pako-sized dependency to compress something
// that crosses a cellular link once would be the wrong trade in both directions.

// Exported, not copied, for the diagnostics uploader next door. There is exactly one right way to
// get bytes over this API — gzip, then base64 in 0x8000-byte slices — and two
// implementations of it would be two chances to get the base64 chunking wrong on the payload that
// is big enough to matter.
export async function gzipJson(value: unknown): Promise<Uint8Array> {
    const stream = new Blob([JSON.stringify(value)]).stream()
        .pipeThrough(new CompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function gunzipJson<T>(bytes: Uint8Array<ArrayBuffer>): Promise<T> {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return JSON.parse(await new Response(stream).text()) as T;
}

/**
 * base64 in fixed-size chunks.
 *
 * `String.fromCharCode(...bytes)` on a 200 KB array is a 200,000-argument call and V8 throws
 * RangeError somewhere above ~120k. The session that triggers that is a long drive — precisely the
 * one worth keeping.
 */
export function toBase64(bytes: Uint8Array): string {
    const CHUNK = 0x8000;
    let binary = '';
    for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    return btoa(binary);
}

export function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
    const binary = atob(b64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
}

/** ArrayBuffers cannot survive JSON, so the two images travel base64'd inside the binaries part. */
interface WireBinaries {
    base: string;
    tuned: string | null;
}

/**
 * The log part of the wire, in either shape it has ever had.
 *
 * It used to be a bare `LogDataPoint[]` — the projection — which is what made a restore destroy the
 * local `inertia` samples. It is now the whole `SessionLogRecord`. Sessions synced before this
 * change are still arrays in the store, and they must keep restoring, so the reader accepts both
 * and the writer only ever emits the record.
 */
export type WireLog = SessionLogRecord | LogDataPoint[];

/** Exported for `verify:session-wire`, which is the only thing standing between a stored session
 *  from last week and a restore that silently returns an empty log. */
export function asLogRecord(wire: WireLog, sessionId: string): SessionLogRecord {
    return Array.isArray(wire) ? { sessionId, data: wire } : { ...wire, sessionId };
}

/**
 * Which build sent this — `<commit-count>.<short-sha>`, e.g. `284.470f492`, with `+` when it was
 * built from a dirty tree. Written into every document by `scripts/build-id.mjs`.
 *
 * This used to report the service worker's cache name, and that was the wrong value for the
 * question. The cache name is a hash of the built bytes, which is exactly right for deciding when
 * to throw a cache away and useless for a human: `tuner-2e5ca880d950` cannot be compared against
 * `tuner-7bedb7d1bbef`, and neither points at a commit. When a phone and a desk disagree about
 * which build ran, an ordered number that maps back to a diff is the whole answer.
 *
 * The cache name is still recorded alongside it, because it is the one value that identifies what
 * the device actually has on disk — a phone serving a stale bundle from the service worker is a
 * real failure mode here, and the pair `build 284, cache tuner-2e5…` is what diagnoses it.
 */
export function buildId(): string | undefined {
    if (typeof document === 'undefined') return undefined;
    return document.querySelector('meta[name="build-id"]')?.getAttribute('content')?.trim() || undefined;
}

/** When that build was produced, ISO to the minute. */
export function buildAt(): string | undefined {
    if (typeof document === 'undefined') return undefined;
    return document.querySelector('meta[name="build-at"]')?.getAttribute('content')?.trim() || undefined;
}

/**
 * The build id, with the service-worker cache name appended when the two can be read together.
 *
 * Undefined only on a dev server with neither — saying nothing beats naming a build that was never
 * deployed.
 */
export async function buildIdentity(): Promise<string | undefined> {
    const id = buildId();
    let cache: string | undefined;
    try {
        if (typeof caches !== 'undefined') cache = (await caches.keys()).find(k => k.startsWith('tuner-'));
    } catch { /* a browser that refuses the cache API still has the meta tag */ }
    if (id && cache) return `${id} (${cache})`;
    return id ?? cache;
}

// --- Push -------------------------------------------------------------------------------------

export interface SyncResult {
    id: string;
    storedBytes: number;
}

/**
 * Sends one session, exactly as the local database holds it.
 *
 * Reads the log and binaries itself rather than taking them as arguments: they are keyed by the
 * session's id in the same database, and a caller that passed a mismatched pair would produce a
 * stored session that is internally inconsistent with nothing to detect it.
 */
export async function syncSession(session: TuningSession): Promise<SyncResult> {
    // Refused before anything is read to be sent, not only at the request: before the notice, no
    // part of a session is even gathered for the store. It stays outstanding in the local database,
    // which is where an unsent session has always waited.
    const refused = refusal();
    if (refused) throw refused;
    // The whole record, not `getSessionLog`'s projection: `inertia` has no representation in
    // `LogDataPoint`, so sending the projection would upload a run the estimator cannot re-read,
    // and restoring it would then overwrite the local copy that still had them.
    const [log, binaries] = await Promise.all([
        getSessionLogRecord(session.id),
        getSessionBinaries(session.id),
    ]);

    const wireBinaries: WireBinaries | null = binaries ? {
        base: toBase64(new Uint8Array(binaries.baseBinaryBuffer)),
        tuned: binaries.tunedBinaryBuffer ? toBase64(new Uint8Array(binaries.tunedBinaryBuffer)) : null,
    } : null;

    // Sent when there is EITHER kind of sample, matching `saveResearchRun`'s own rule: a run whose
    // projection came out empty must not take its raw samples down with it.
    // Every sample kind has to be named here. This mirrors the rule in `nextLogRecord`, which
    // decides what a record HOLDS, and it has already gone wrong once by copying an incomplete
    // enumeration: an idle run whose projection came out empty would upload a session with no log.
    const hasSamples = !!log && ((log.data?.length ?? 0) > 0
        || (log.inertia?.length ?? 0) > 0 || (log.idle?.length ?? 0) > 0);

    const [sessionGz, logGz, binariesGz] = await Promise.all([
        gzipJson(session),
        hasSamples ? gzipJson(log) : Promise.resolve(null),
        wireBinaries ? gzipJson(wireBinaries) : Promise.resolve(null),
    ]);

    return await call<SyncResult>('/api/sessions', {
        method: 'POST',
        body: {
            id: session.id,
            label: session.label,
            createdAt: session.createdAt,
            status: session.status,
            vin: session.baseOrigin?.kind === 'dme' ? session.baseOrigin.vin : undefined,
            pointCount: log?.data?.length ?? 0,
            hasTune: !!session.sha256,
            hasRf: !!log?.data?.some(p => p.rf !== undefined),
            hasEgt: !!log?.data?.some(p => p.exhaustTemp !== undefined),
            // still an idle run, and the list has to say so.
            hasIdle: (log?.idle?.length ?? 0) > 0,
            appBuild: await buildIdentity(),
            sessionGz: toBase64(sessionGz),
            logGz: logGz ? toBase64(logGz) : null,
            binariesGz: binariesGz ? toBase64(binariesGz) : null,
        },
    });
}

// --- Pull -------------------------------------------------------------------------------------

export interface StoredSession {
    id: string;
    synced_at: number;
    label: string;
    created_at: number;
    status: string | null;
    vin: string | null;
    point_count: number;
    has_tune: number;
    has_rf: number;
    has_egt: number;
    app_build: string | null;
    session_bytes: number;
    log_bytes: number | null;
    binaries_bytes: number | null;
}

export async function listStoredSessions(): Promise<StoredSession[]> {
    return (await call<{ sessions: StoredSession[] }>('/api/sessions')).sessions;
}

/**
 * Pulls one session back into the local database, whole.
 *
 * This is the reason the server copy is worth having — a session recorded on a phone can be opened
 * at a desk with its BASE, its tune and the settings that produced it, not just a CSV of numbers.
 *
 * Overwrites the local session of the same id. The caller confirms first.
 */
export async function restoreSession(id: string): Promise<TuningSession> {
    const body = await call<{
        sessionGz: string; logGz: string | null; binariesGz: string | null;
    }>(`/api/sessions/${encodeURIComponent(id)}`);

    const session = await gunzipJson<TuningSession>(fromBase64(body.sessionGz));
    // Either wire shape — see WireLog. Sessions stored before the record travelled whole are bare
    // arrays, and they have to keep coming back.
    const log = body.logGz
        ? asLogRecord(await gunzipJson<WireLog>(fromBase64(body.logGz)), session.id)
        : null;
    const wire = body.binariesGz ? await gunzipJson<WireBinaries>(fromBase64(body.binariesGz)) : null;

    const binaries: SessionBinariesRecord | null = wire ? {
        sessionId: session.id,
        baseBinaryBuffer: fromBase64(wire.base).buffer as ArrayBuffer,
        tunedBinaryBuffer: wire.tuned ? fromBase64(wire.tuned).buffer as ArrayBuffer : null,
    } : null;

    // Guard against a session record that claims a tune whose bytes did not come with it — the one
    // inconsistency a partial restore could produce, and the one that would let the app offer to
    // flash something it does not have.
    if (session.sha256 && !binaries?.tunedBinaryBuffer) {
        throw new Error('Stored session claims a tune but carries no tuned binary — refusing to restore it.');
    }

    await putSessionRaw(session, log, binaries);
    return session;
}

/** Removes the store's copy only. The session on this device is untouched. */
export async function deleteStoredSession(id: string): Promise<void> {
    await call(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
