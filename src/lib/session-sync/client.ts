import { LogDataPoint } from '@/lib/types';
import { TuningSession, SessionBinariesRecord } from '@/lib/db/schema';
import { getSessionLog, getSessionBinaries, putSessionRaw } from '@/lib/db/sessionRepository';

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

/** Where the settings live. Local to the device: the token is a secret and never leaves it. */
const STORAGE_KEY = 'mss54hp.sessionSync.v1';

export interface SyncSettings {
    /** Origin of the deployment, no trailing slash. Empty means "same origin as this page", which
     *  is what the deployed app wants; a value is only needed on a local bench rig where the app
     *  and the functions are on different ports. */
    baseUrl: string;
    token: string;
}

export const EMPTY_SETTINGS: SyncSettings = { baseUrl: '', token: '' };

export function loadSyncSettings(): SyncSettings {
    if (typeof localStorage === 'undefined') return EMPTY_SETTINGS;
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return EMPTY_SETTINGS;
        const parsed = JSON.parse(raw) as Partial<SyncSettings>;
        return { baseUrl: (parsed.baseUrl ?? '').replace(/\/+$/, ''), token: parsed.token ?? '' };
    } catch {
        return EMPTY_SETTINGS;
    }
}

export function saveSyncSettings(settings: SyncSettings): void {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
        baseUrl: settings.baseUrl.replace(/\/+$/, ''), token: settings.token,
    }));
}

/** Configured enough to try. The base URL may legitimately be empty (same origin); the token not. */
export const canSync = (s: SyncSettings) => s.token.trim().length > 0;

// --- Codec ------------------------------------------------------------------------------------
// gzip via the platform. CompressionStream is in every browser that can run the rest of this app —
// Chrome 80+, and the DME link needs Chrome anyway. A pako-sized dependency to compress something
// that crosses a cellular link once would be the wrong trade in both directions.

async function gzipJson(value: unknown): Promise<Uint8Array> {
    const stream = new Blob([JSON.stringify(value)]).stream()
        .pipeThrough(new CompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzipJson<T>(bytes: Uint8Array<ArrayBuffer>): Promise<T> {
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
function toBase64(bytes: Uint8Array): string {
    const CHUNK = 0x8000;
    let binary = '';
    for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    return btoa(binary);
}

function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
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
 * Which build sent this, as the service worker's cache name.
 *
 * There is no version constant in this app, and adding one would mean a number somebody has to
 * remember to bump — which is the same as not having one. gen-sw.mjs derives the cache name from a
 * hash of the built bytes, so it changes exactly when the build does and never otherwise.
 * Undefined on a dev server, where no worker is registered; saying nothing beats naming a build
 * that was never deployed.
 */
async function buildIdentity(): Promise<string | undefined> {
    try {
        if (typeof caches === 'undefined') return undefined;
        return (await caches.keys()).find(k => k.startsWith('tuner-'));
    } catch {
        return undefined;
    }
}

async function call(settings: SyncSettings, path: string, init: RequestInit = {}): Promise<Response> {
    const response = await fetch(`${settings.baseUrl}${path}`, {
        ...init,
        headers: { ...init.headers, authorization: `Bearer ${settings.token}` },
    });
    if (!response.ok) {
        // The API's own message where there is one — it is the useful half of a 413, which knows
        // both which part was too big and what to do about it.
        const detail = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(detail?.error ?? `Request failed (HTTP ${response.status}).`);
    }
    return response;
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
export async function syncSession(session: TuningSession, settings: SyncSettings): Promise<SyncResult> {
    if (!canSync(settings)) throw new Error('No sync token configured.');

    const [log, binaries] = await Promise.all([
        getSessionLog(session.id),
        getSessionBinaries(session.id),
    ]);

    const wireBinaries: WireBinaries | null = binaries ? {
        base: toBase64(new Uint8Array(binaries.baseBinaryBuffer)),
        tuned: binaries.tunedBinaryBuffer ? toBase64(new Uint8Array(binaries.tunedBinaryBuffer)) : null,
    } : null;

    const [sessionGz, logGz, binariesGz] = await Promise.all([
        gzipJson(session),
        log?.length ? gzipJson(log) : Promise.resolve(null),
        wireBinaries ? gzipJson(wireBinaries) : Promise.resolve(null),
    ]);

    const response = await call(settings, '/api/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            id: session.id,
            label: session.label,
            createdAt: session.createdAt,
            status: session.status,
            vin: session.baseOrigin?.kind === 'dme' ? session.baseOrigin.vin : undefined,
            pointCount: log?.length ?? 0,
            hasTune: !!session.sha256,
            hasRf: !!log?.some(p => p.rf !== undefined),
            hasEgt: !!log?.some(p => p.exhaustTemp !== undefined),
            appBuild: await buildIdentity(),
            sessionGz: toBase64(sessionGz),
            logGz: logGz ? toBase64(logGz) : null,
            binariesGz: binariesGz ? toBase64(binariesGz) : null,
        }),
    });

    return await response.json() as SyncResult;
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

export async function listStoredSessions(settings: SyncSettings): Promise<StoredSession[]> {
    if (!canSync(settings)) throw new Error('No sync token configured.');
    const response = await call(settings, '/api/sessions');
    const body = await response.json() as { sessions: StoredSession[] };
    return body.sessions;
}

/**
 * Pulls one session back into the local database, whole.
 *
 * This is the reason the server copy is worth having — a session recorded on a phone can be opened
 * at a desk with its BASE, its tune and the settings that produced it, not just a CSV of numbers.
 *
 * Overwrites the local session of the same id. The caller confirms first.
 */
export async function restoreSession(id: string, settings: SyncSettings): Promise<TuningSession> {
    if (!canSync(settings)) throw new Error('No sync token configured.');

    const response = await call(settings, `/api/sessions/${encodeURIComponent(id)}`);
    const body = await response.json() as {
        sessionGz: string; logGz: string | null; binariesGz: string | null;
    };

    const session = await gunzipJson<TuningSession>(fromBase64(body.sessionGz));
    const log = body.logGz ? await gunzipJson<LogDataPoint[]>(fromBase64(body.logGz)) : null;
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

export async function deleteStoredSession(id: string, settings: SyncSettings): Promise<void> {
    if (!canSync(settings)) throw new Error('No sync token configured.');
    await call(settings, `/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
