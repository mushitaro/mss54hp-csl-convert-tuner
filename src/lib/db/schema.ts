import { LogDataPoint, VEMap, LogFilterConfig, InterpolationPoint } from '@/lib/types';
import { AdaptationSnapshot } from '@/lib/dme-link/adaptationBlocks';

export const DB_NAME = 'mss54hp-tuner-db';
// 3: adds `seq`. Existing rows have no number, and the lineage badges are built on it, so the
// upgrade rebuilds the stores rather than leaving "#?" rows behind.
//
// Think hard before raising this. onupgradeneeded below drops and recreates all three stores with
// no oldVersion check, so any bump destroys every saved session. That was a deliberate trade for
// v1 -> v3 (v1 rows could not be reviewed or reproduced, so they were worth losing); it is not a
// trade worth making to add a field. Optional properties need no bump at all — IndexedDB stores
// structured clones, so an old row simply lacks them, which `?` already describes. Only a new store
// or index actually requires a version.
export const DB_VERSION = 3;

export const SESSIONS_STORE = 'sessions';
export const SESSION_LOGS_STORE = 'sessionLogs';
export const SESSION_BINARIES_STORE = 'sessionBinaries';

/** Where a session's BASE bytes came from. Without this a session can't be judged: a tune only
 *  means something relative to what it started from. */
export type BaseOrigin =
    | { kind: 'upload'; fileName: string }
    | { kind: 'dme'; vin?: string; aif?: string; softwareVersion?: string; readAt: number }
    | { kind: 'session'; sessionId: string; which: 'tuned' | 'base' };

/** Everything that turns a BASE + log into the TUNED bytes. Stored so the derivation can be
 *  replayed exactly — `processLogData` is pure, but the hook feeds it whatever is in state, and
 *  writeWarmup/writeWot cannot be detected from the bytes at all. */
export interface TuneSettings {
    filterConfig: LogFilterConfig;
    interpolationTable: InterpolationPoint[];
    applyPatch: boolean;
    applyWotDisable: boolean;
    writeWarmup: boolean;
    writeWot: boolean;
}

export interface FlashRecord {
    at: number;
    sha256: string;
    settings: Pick<TuneSettings, 'applyPatch' | 'applyWotDisable' | 'writeWarmup' | 'writeWot'>;
}

/** What the DME had learned when a tune's data capture began, and what it held after being cleared.
 *  Kept because a log only means something relative to the adaptation state that produced it: the
 *  same log read very differently from a learned base than from a cleared one. The `before` lambda
 *  factors are also the DME's own account of how far the previous map's fuelling was off. */
export interface AdaptationResetRecord {
    at: number;
    /** Recorded rather than assumed — the clear's scope is a constant today but may widen. */
    mask1: number;
    mask2: number;
    /** Read immediately before the clear. */
    before: AdaptationSnapshot;
    /** Re-read after the DME settled. Non-null: a record is only written once the clear and its
     *  verifying re-read have both succeeded, so this never has to stand for "we think it worked".
     *  A failure mid-way writes nothing and the user retries — clearing is idempotent, so a retry
     *  costs nothing, and a record that stays silent is better than one that guesses. */
    after: AdaptationSnapshot;
}

/** Metadata only — the ArrayBuffers live in SESSION_BINARIES_STORE so the list can render without
 *  hydrating every session's 128 KB. */
export interface TuningSession {
    id: string;
    createdAt: number;
    /** Stable, human-sized identifier ("#3"). Dates can't tell two sessions minutes apart apart,
     *  and this is what the lineage badges point at. Never reused, so deleting #2 doesn't renumber. */
    seq: number;
    label: string;
    /** draft = the one working session, tunable. archived = reference + flash only. */
    status: 'draft' | 'archived';

    baseOrigin: BaseOrigin | null;   // null = BASE not chosen yet
    /** Denormalised from baseOrigin for tree building. Decorative: the bytes are self-contained,
     *  so a dangling parent only degrades the label, never the session. */
    parentSessionId?: string;
    /** Proves the BASE really is the parent's TUNED output (=== parent.sha256). */
    baseSha256?: string;
    baseFileName?: string;
    baseSize?: number;

    binaryFileName?: string;
    tunedSize?: number;
    sha256?: string;                 // TUNED bytes — the reproduction check compares against this
    veMapSnapshot?: VEMap;           // TUNED map. Read by useComparison for the `db:` diff variants
    tuneSettings?: TuneSettings;
    hasLog: boolean;
    logPointCount: number;

    /** Replaces writtenToDme. The same tune legitimately gets flashed more than once with
     *  different options (log runs with PATCH on, the final street flash with it off), and the
     *  record must not claim bytes that were never written. */
    flashHistory: FlashRecord[];

    /** Adaptation resets performed before logging this session. Optional, and appended with `?? []`
     *  rather than a bare spread like flashHistory: this field post-dates v3, so rows written before
     *  it genuinely do not have the array. */
    adaptationResets?: AdaptationResetRecord[];
}

export interface SessionLogRecord {
    sessionId: string;
    data: LogDataPoint[];
}

export interface SessionBinariesRecord {
    sessionId: string;
    baseBinaryBuffer: ArrayBuffer;
    tunedBinaryBuffer: ArrayBuffer | null;   // null until the session has been tuned
}

export function openDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = () => {
            const db = request.result;
            // v1 stored the tuned output only, with no BASE and no settings — such records cannot be
            // reviewed or reproduced, so they are dropped rather than migrated. contains() matters:
            // a fresh install arrives here at oldVersion 0 with no stores to delete.
            for (const name of [SESSIONS_STORE, SESSION_LOGS_STORE, SESSION_BINARIES_STORE]) {
                if (db.objectStoreNames.contains(name)) db.deleteObjectStore(name);
            }
            const sessions = db.createObjectStore(SESSIONS_STORE, { keyPath: 'id' });
            sessions.createIndex('createdAt', 'createdAt');
            db.createObjectStore(SESSION_LOGS_STORE, { keyPath: 'sessionId' });
            db.createObjectStore(SESSION_BINARIES_STORE, { keyPath: 'sessionId' });
        };

        request.onsuccess = () => {
            const db = request.result;
            // Don't wedge another tab's upgrade: close as soon as it asks for a newer version.
            db.onversionchange = () => db.close();
            resolve(db);
        };
        request.onerror = () => reject(request.error);
        // 'blocked' is neither success nor error, so without this the promise never settles and
        // every caller hangs — including the auto-save right after flashing the ECU.
        request.onblocked = () => reject(new Error(
            'Database upgrade is blocked by another open tab. Close the app\'s other tabs and retry.'
        ));
    });
}
