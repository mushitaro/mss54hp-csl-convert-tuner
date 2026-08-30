import { LogDataPoint } from '@/lib/types';

/**
 * Crash recovery for a data log in progress.
 *
 * Until this existed, a run lived only in `liveSamplesRef` — a plain ref in page.tsx — from START
 * TUNE until the user pressed SAVE. Anything that reloaded the page in between took the whole run
 * with it: an HMR update, a stray refresh, a browser crash, the machine sleeping. That is not an
 * ordinary unsaved-work bug, because the input is a drive. A lost run costs fuel, time, and a set
 * of conditions that may not come back. It has already cost 30 minutes once.
 *
 * So samples are appended here as they arrive, and the record outlives the run: it is cleared when
 * the samples are safely in the session store (SAVE) or the user throws them away on purpose, NOT
 * when the run stops. A stopped-but-unsaved run is exactly as fragile as a running one.
 *
 * ## Why a separate database
 *
 * The same two reasons as `serviceBackupRepository`, and the first is the hard one: a new object
 * store means bumping DB_VERSION, and the session DB's `onupgradeneeded` drops and recreates every
 * store with no oldVersion check — a bump would destroy every saved session to add a safety net.
 * See the warning at the top of schema.ts. Its own database has its own version line and cannot
 * touch saved sessions.
 *
 * ## Why chunks
 *
 * Appended, never rewritten. Re-putting the whole array on every flush is O(n) per flush and O(n²)
 * across a run; at the ~10 Hz this link achieves, a 30-minute run is ~18,000 points and the last
 * flush alone would rewrite all of them. Each flush writes only what arrived since the previous one,
 * so the cost per flush is flat no matter how long the drive has been going.
 */

export const LIVE_DB_NAME = 'mss54hp-tuner-live';
export const LIVE_DB_VERSION = 1;
export const RUNS_STORE = 'runs';
export const CHUNKS_STORE = 'chunks';

export interface LiveRunRecord {
    runId: string;
    /** The session this run belongs to. START TUNE is only offered with a session open (the hub's
     *  'tune' action requires one), so this is always set — and it is what makes recovery useful:
     *  the samples alone cannot rebuild a tune without the BASE they were captured against. */
    sessionId: string;
    startedAt: number;
    updatedAt: number;
    pointCount: number;
    /** PRACTICE runs are recorded too, so the recovery path itself can be rehearsed without a car.
     *  Surfaced on the offer so a simulated run is never mistaken for a drive. */
    mock: boolean;
    /** Set when the run stopped through the app. Unset means the page went away mid-run — the case
     *  this store exists for. Both are offered for recovery; only the wording differs. */
    endedAt?: number;
}

interface ChunkRecord {
    runId: string;
    seq: number;
    points: LogDataPoint[];
}

function openLiveDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(LIVE_DB_NAME, LIVE_DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(RUNS_STORE)) {
                db.createObjectStore(RUNS_STORE, { keyPath: 'runId' });
            }
            if (!db.objectStoreNames.contains(CHUNKS_STORE)) {
                // Compound key so a run's chunks are contiguous and already in arrival order — the
                // read below is one range scan, with no sort and no per-chunk lookup.
                db.createObjectStore(CHUNKS_STORE, { keyPath: ['runId', 'seq'] });
            }
        };
        // `blocked` is not terminal: the same request still fires `onsuccess` once the other tab
        // lets go, and resolving an already-rejected promise silently leaks that open connection —
        // which then blocks the next upgrade for good. See the fuller note in schema.ts.
        let settled = false;
        request.onsuccess = () => {
            const db = request.result;
            db.onversionchange = () => db.close();
            if (settled) { db.close(); return; }
            settled = true;
            resolve(db);
        };
        request.onerror = () => {
            if (settled) return;
            settled = true;
            reject(request.error);
        };
        request.onblocked = () => {
            if (settled) return;
            settled = true;
            reject(new Error('Live-run database upgrade is blocked by another open tab.'));
        };
    });
}

/** Runs `work` inside one transaction over `stores` and resolves when the transaction commits —
 *  not when the last request succeeds, which would let the caller proceed before the data is durable. */
function runTransaction<T>(
    db: IDBDatabase,
    stores: string[],
    mode: IDBTransactionMode,
    work: (tx: IDBTransaction) => T | Promise<T>,
): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const tx = db.transaction(stores, mode);
        let result: T;
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error ?? new Error('Live-run transaction aborted'));
        Promise.resolve(work(tx)).then(r => { result = r; }, e => { tx.abort(); reject(e); });
    });
}

function request<T>(req: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

/** Every chunk key for one run. `-Infinity`/`Infinity` cannot appear in an IndexedDB key, so the
 *  bounds are the actual integer range `seq` is drawn from. */
function chunkRange(runId: string): IDBKeyRange {
    return IDBKeyRange.bound([runId, 0], [runId, Number.MAX_SAFE_INTEGER]);
}

/**
 * Opens a recovery record for a new run and clears any earlier one.
 *
 * Purging here rather than at load is deliberate: the offer to recover is made when the app starts,
 * so by the time a new run begins the user has already answered it. Keeping both would mean a second
 * reload offered the older, less interesting run.
 */
export async function beginLiveRun(meta: { sessionId: string; mock: boolean }): Promise<string> {
    const runId = crypto.randomUUID();
    const now = Date.now();
    const db = await openLiveDb();
    try {
        await runTransaction(db, [RUNS_STORE, CHUNKS_STORE], 'readwrite', tx => {
            tx.objectStore(RUNS_STORE).clear();
            tx.objectStore(CHUNKS_STORE).clear();
            tx.objectStore(RUNS_STORE).put({
                runId, sessionId: meta.sessionId, startedAt: now, updatedAt: now,
                pointCount: 0, mock: meta.mock,
            } satisfies LiveRunRecord);
        });
        return runId;
    } finally {
        db.close();
    }
}

/** Appends one batch of samples. `seq` must increase within a run; it is the read order. */
export async function appendLiveChunk(runId: string, seq: number, points: LogDataPoint[]): Promise<void> {
    if (points.length === 0) return;
    const db = await openLiveDb();
    try {
        await runTransaction(db, [RUNS_STORE, CHUNKS_STORE], 'readwrite', async tx => {
            tx.objectStore(CHUNKS_STORE).put({ runId, seq, points } satisfies ChunkRecord);
            const runs = tx.objectStore(RUNS_STORE);
            const run = await request(runs.get(runId) as IDBRequest<LiveRunRecord | undefined>);
            // A missing run means it was discarded while this flush was in flight. Write the counter
            // back only if there is something to write it back to, rather than resurrecting it.
            if (run) {
                runs.put({ ...run, pointCount: run.pointCount + points.length, updatedAt: Date.now() });
            }
        });
    } finally {
        db.close();
    }
}

/** Marks a run as having stopped through the app. The record stays — the samples are still only in
 *  memory until they are saved, which is the whole point. */
export async function endLiveRun(runId: string): Promise<void> {
    const db = await openLiveDb();
    try {
        await runTransaction(db, [RUNS_STORE], 'readwrite', async tx => {
            const runs = tx.objectStore(RUNS_STORE);
            const run = await request(runs.get(runId) as IDBRequest<LiveRunRecord | undefined>);
            if (run) runs.put({ ...run, endedAt: Date.now() });
        });
    } finally {
        db.close();
    }
}

/** Drops the recovery record and its samples. Call once the run is safely stored, or when the user
 *  throws it away — never merely because it stopped. */
export async function discardLiveRun(runId?: string): Promise<void> {
    const db = await openLiveDb();
    try {
        await runTransaction(db, [RUNS_STORE, CHUNKS_STORE], 'readwrite', tx => {
            if (runId === undefined) {
                tx.objectStore(RUNS_STORE).clear();
                tx.objectStore(CHUNKS_STORE).clear();
            } else {
                tx.objectStore(RUNS_STORE).delete(runId);
                tx.objectStore(CHUNKS_STORE).delete(chunkRange(runId));
            }
        });
    } finally {
        db.close();
    }
}

/** The run left behind by a previous page, if it captured anything. A zero-point run is not worth
 *  offering — there is nothing to restore, and the prompt would just be noise after a false start. */
export async function findRecoverableRun(): Promise<LiveRunRecord | null> {
    const db = await openLiveDb();
    try {
        const runs = await runTransaction(db, [RUNS_STORE], 'readonly', tx =>
            request(tx.objectStore(RUNS_STORE).getAll() as IDBRequest<LiveRunRecord[]>));
        const usable = runs.filter(r => r.pointCount > 0).sort((a, b) => b.startedAt - a.startedAt);
        return usable[0] ?? null;
    } finally {
        db.close();
    }
}

/** Every sample of a run, in capture order. */
export async function loadLiveRunPoints(runId: string): Promise<LogDataPoint[]> {
    const db = await openLiveDb();
    try {
        const chunks = await runTransaction(db, [CHUNKS_STORE], 'readonly', tx =>
            request(tx.objectStore(CHUNKS_STORE).getAll(chunkRange(runId)) as IDBRequest<ChunkRecord[]>));
        // getAll over a compound-key range returns key order, so `seq` is already ascending; sorting
        // anyway costs nothing on a few hundred chunks and makes the guarantee local to this file.
        return chunks.sort((a, b) => a.seq - b.seq).flatMap(c => c.points);
    } finally {
        db.close();
    }
}
