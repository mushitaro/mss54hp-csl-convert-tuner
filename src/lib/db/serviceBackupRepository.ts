/**
 * Storage for DME service-block backups — the 16 KB (master + slave) Free Identifiers image taken
 * immediately before a flash-counter reset erases and rewrites it.
 *
 * That block holds the AIF, the ZIF and the VIN records, so if the rewrite is interrupted this
 * image is the only way back. It is written to a downloaded file AND to this store, and the reset
 * refuses to erase anything until both have succeeded.
 *
 * ## Why a separate database
 *
 * Two constraints rule out the session DB:
 *
 *  - A new object store requires bumping DB_VERSION, and this app's `onupgradeneeded` drops and
 *    recreates every store with no oldVersion check — a bump destroys all saved sessions. See the
 *    warning at the top of schema.ts.
 *  - A backup can be taken with no session open at all (the reset is offered whenever the link is
 *    connected, including straight after CONNECTION), and SESSION_BINARIES_STORE is keyed by
 *    sessionId, so there would be nothing to attach it to.
 *
 * A separate database sidesteps both: its own version line, and no key that depends on a session
 * existing. Nothing here can touch saved sessions.
 */

export const BACKUP_DB_NAME = 'mss54hp-tuner-backups';
export const BACKUP_DB_VERSION = 1;
export const SERVICE_BLOCKS_STORE = 'serviceBlocks';

export interface ServiceBackupRecord {
    /** Epoch ms — also the primary key. One reset, one record. */
    at: number;
    /** Whatever the DME reported at connect, for telling two cars' backups apart in the list. */
    vin?: string;
    /** Master service block followed by slave: 16384 bytes, the reference's artifact order. */
    buffer: ArrayBuffer;
}

/** Metadata without the 16 KB payload, so a list doesn't hydrate every backup. */
export type ServiceBackupSummary = Omit<ServiceBackupRecord, 'buffer'> & { size: number };

function openBackupDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(BACKUP_DB_NAME, BACKUP_DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(SERVICE_BLOCKS_STORE)) {
                db.createObjectStore(SERVICE_BLOCKS_STORE, { keyPath: 'at' });
            }
        };
        request.onsuccess = () => {
            const db = request.result;
            db.onversionchange = () => db.close();
            resolve(db);
        };
        request.onerror = () => reject(request.error);
        // Neither success nor error, so without this the promise never settles — and the caller
        // waiting on it is the step that decides whether the ECU may be erased.
        request.onblocked = () => reject(new Error(
            'Backup database upgrade is blocked by another open tab. Close the app\'s other tabs and retry.',
        ));
    });
}

function runTransaction<T>(
    db: IDBDatabase,
    mode: IDBTransactionMode,
    body: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(SERVICE_BLOCKS_STORE, mode);
        const request = body(tx.objectStore(SERVICE_BLOCKS_STORE));
        // Resolve on the TRANSACTION completing, not the request succeeding: for a write, a request
        // that succeeded inside a transaction that later aborts has persisted nothing, and this
        // promise is what the reset treats as "the backup is safe".
        let result: T;
        request.onsuccess = () => { result = request.result; };
        request.onerror = () => reject(request.error);
        tx.oncomplete = () => resolve(result);
        tx.onabort = () => reject(tx.error ?? new Error('Service backup transaction aborted'));
        tx.onerror = () => reject(tx.error);
    });
}

/**
 * Persists one backup. Rejects rather than resolving on any failure — quota exceeded, private-mode
 * storage, a blocked upgrade — because the caller uses this promise to decide whether the erase may
 * proceed. Resolving optimistically here would trade the ECU's only recovery path for a tidier
 * happy path.
 */
export async function saveServiceBackup(record: ServiceBackupRecord): Promise<void> {
    const db = await openBackupDb();
    try {
        await runTransaction(db, 'readwrite', store => store.put(record));
    } finally {
        db.close();
    }
}

/** Newest first. */
export async function listServiceBackups(): Promise<ServiceBackupSummary[]> {
    const db = await openBackupDb();
    try {
        const all = await runTransaction<ServiceBackupRecord[]>(db, 'readonly', store => store.getAll());
        return all
            .map(({ at, vin, buffer }) => ({ at, vin, size: buffer.byteLength }))
            .sort((a, b) => b.at - a.at);
    } finally {
        db.close();
    }
}

export async function loadServiceBackup(at: number): Promise<ServiceBackupRecord | null> {
    const db = await openBackupDb();
    try {
        const record = await runTransaction<ServiceBackupRecord | undefined>(db, 'readonly', store => store.get(at));
        return record ?? null;
    } finally {
        db.close();
    }
}
