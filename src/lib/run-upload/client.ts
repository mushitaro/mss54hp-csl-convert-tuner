import { LogDataPoint } from '@/lib/types';
import { serializeLogFile } from '@/lib/log-engine/serializer';

/**
 * Uploading a finished run to the preview deployment's D1 store.
 *
 * This exists because of where the app is used. A log is recorded on a phone, in a car, and every
 * way of getting it onto a desk afterwards runs through a share sheet and a cable. IndexedDB keeps
 * it safe on the phone; it does not get it anywhere else.
 *
 * Deliberately not automatic. A run is uploaded when the driver says so, which means the failure
 * mode of a garage with no signal is a button that reports an error rather than a background task
 * that silently gave up. The local copy is authoritative either way — nothing here deletes it.
 */

/** Where the settings live. Local to the device: the token is a secret and never leaves it. */
const STORAGE_KEY = 'mss54hp.runUpload.v1';

export interface UploadSettings {
    /** Origin of the deployment, no trailing slash. Empty means "same origin as this page", which
     *  is what the deployed app itself wants; a value is only needed on a local bench rig where the
     *  Next dev server and the functions are on different ports. */
    baseUrl: string;
    token: string;
}

export const EMPTY_SETTINGS: UploadSettings = { baseUrl: '', token: '' };

export function loadUploadSettings(): UploadSettings {
    if (typeof localStorage === 'undefined') return EMPTY_SETTINGS;
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return EMPTY_SETTINGS;
        const parsed = JSON.parse(raw) as Partial<UploadSettings>;
        return {
            baseUrl: (parsed.baseUrl ?? '').replace(/\/+$/, ''),
            token: parsed.token ?? '',
        };
    } catch {
        return EMPTY_SETTINGS;
    }
}

export function saveUploadSettings(settings: UploadSettings): void {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
        baseUrl: settings.baseUrl.replace(/\/+$/, ''),
        token: settings.token,
    }));
}

/** Configured enough to try. The base URL may legitimately be empty (same origin); the token not. */
export const canUpload = (s: UploadSettings) => s.token.trim().length > 0;

/**
 * gzip, via the platform.
 *
 * `CompressionStream` is in every browser that can run the rest of this app — Chrome 80+, and the
 * DME link needs Chrome anyway. Bringing in a pako-sized dependency to compress a file that is
 * about to cross a cellular link once would be the wrong trade in both directions.
 */
async function gzip(text: string): Promise<Uint8Array> {
    const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * base64 in fixed-size chunks.
 *
 * `String.fromCharCode(...bytes)` on a 100 KB array is a 100,000-argument call, and V8 throws
 * RangeError somewhere above ~120k. The run that triggers that is a long drive — precisely the one
 * worth keeping.
 */
function toBase64(bytes: Uint8Array): string {
    const CHUNK = 0x8000;
    let binary = '';
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
}

/**
 * Which build recorded this run, as the service worker's cache name.
 *
 * There is no version constant in this app, and adding one would mean a number somebody has to
 * remember to bump — which is the same as not having one. `gen-sw.mjs` already derives the cache
 * name from a hash of the built bytes, so it changes exactly when the build does and never
 * otherwise. That is a better answer to "which build took this log" than a semver would be.
 *
 * Undefined on a dev server, where no worker is registered. That is fine: a run uploaded from
 * `next dev` is a bench test, and saying nothing beats naming a build that was never deployed.
 */
async function buildIdentity(): Promise<string | undefined> {
    try {
        if (typeof caches === 'undefined') return undefined;
        return (await caches.keys()).find(k => k.startsWith('tuner-'));
    } catch {
        return undefined;
    }
}

export interface RunMetadata {
    /** Stable per session, so a retry after a dropped connection updates rather than duplicates. */
    id: string;
    label: string;
    notes?: string;
    vin?: string;
    baseFileName?: string;
    softwareVersion?: string;
    rfKorrMode?: string;
    patchOn?: boolean;
    averageHz?: number;
}

export interface UploadResult {
    id: string;
    storedBytes: number;
    /** Uncompressed CSV size, for the "before/after" the UI shows. */
    csvBytes: number;
}

/**
 * Serialises, compresses and posts one run.
 *
 * The payload is the same CSV `serializeLogFile` already produces, which is what makes a stored run
 * re-importable by this app without a second format to keep in step — and readable by anything else
 * if it outlives the app.
 */
export async function uploadRun(
    points: LogDataPoint[],
    meta: RunMetadata,
    settings: UploadSettings,
): Promise<UploadResult> {
    if (!canUpload(settings)) throw new Error('No upload token configured.');
    if (points.length === 0) throw new Error('This run has no samples.');

    const csv = serializeLogFile(points);
    const gz = await gzip(csv);

    // Both duration and rate come from the timestamps rather than from the sample count, because
    // the two log sources use different time units and a run can contain a stall.
    const first = points[0].time;
    const last = points[points.length - 1].time;
    const span = last - first;
    // Same discriminator as log-engine/filter.ts: live logs are in seconds, CSV exports in ms.
    const durationS = span > 0 ? (span / points.length >= 5 ? span / 1000 : span) : undefined;

    const body = {
        id: meta.id,
        label: meta.label,
        notes: meta.notes,
        vin: meta.vin,
        baseFileName: meta.baseFileName,
        softwareVersion: meta.softwareVersion,
        rfKorrMode: meta.rfKorrMode,
        patchOn: meta.patchOn,
        pointCount: points.length,
        averageHz: meta.averageHz,
        durationS,
        hasRf: points.some(p => p.rf !== undefined),
        hasEgt: points.some(p => p.exhaustTemp !== undefined),
        appVersion: await buildIdentity(),
        clientTime: Date.now(),
        csvBytes: new TextEncoder().encode(csv).byteLength,
        csvGzBase64: toBase64(gz),
    };

    const response = await fetch(`${settings.baseUrl}/api/runs`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${settings.token}`,
        },
        body: JSON.stringify(body),
    });

    if (!response.ok) {
        // The API's own message where there is one — it is the useful half of a 413, which knows
        // both the size and what to do about it.
        const detail = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(detail?.error ?? `Upload failed (HTTP ${response.status}).`);
    }

    const result = await response.json() as { id: string; storedBytes: number };
    return { ...result, csvBytes: body.csvBytes };
}

export interface StoredRun {
    id: string;
    created_at: number;
    label: string;
    point_count: number;
    has_rf: number;
    has_egt: number;
    gz_bytes: number;
    csv_bytes: number;
    vin: string | null;
    rf_korr_mode: string | null;
    duration_s: number | null;
}

export async function listRuns(settings: UploadSettings): Promise<StoredRun[]> {
    if (!canUpload(settings)) throw new Error('No upload token configured.');
    const response = await fetch(`${settings.baseUrl}/api/runs`, {
        headers: { authorization: `Bearer ${settings.token}` },
    });
    if (!response.ok) {
        const detail = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(detail?.error ?? `Could not list runs (HTTP ${response.status}).`);
    }
    const body = await response.json() as { runs: StoredRun[] };
    return body.runs;
}
