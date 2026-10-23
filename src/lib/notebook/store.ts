import { entryProblem, mergeEntries, type NotebookEntry } from './rules';

/**
 * The notebook on this device: its own IndexedDB database, beside the session database.
 *
 * Its own database rather than a fourth store in `mss54hp-tuner-db`, for two reasons. A new store
 * there means raising that database's version, which every device then upgrades on first open — and
 * an upgrade another open tab blocks leaves the app without its sessions until that tab closes. And
 * only WORKS writes a notebook: a database opened only by notebook code is one a production build
 * never creates, so nothing about it has to be said for the build that does not have it.
 *
 * Append-only, as the notebook is: an entry already here is never written over, so a copy pulled
 * from the store cannot replace one written on this device, and pulling twice adds nothing.
 */

const DB_NAME = 'mss54hp-tuner-notebook';
const DB_VERSION = 1;
const ENTRIES = 'entries';

/** An entry as kept here: the entry, and whether the store has it yet. `sent` never leaves. */
interface StoredEntry extends NotebookEntry {
    sent: boolean;
}

function openNotebookDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(ENTRIES)) {
                db.createObjectStore(ENTRIES, { keyPath: 'id' }).createIndex('sessionId', 'sessionId');
            }
        };
        // `blocked` is not terminal: the same request still fires `onsuccess` once the other tab lets
        // go — see the note in schema.ts. Settled once, and a late success closes what it opened.
        let settled = false;
        request.onsuccess = () => {
            const db = request.result;
            db.onversionchange = () => db.close();
            if (settled) { db.close(); return; }
            settled = true;
            resolve(db);
        };
        request.onerror = () => { if (!settled) { settled = true; reject(request.error); } };
        request.onblocked = () => {
            if (!settled) { settled = true; reject(new Error('Notebook database upgrade is blocked by another open tab.')); }
        };
    });
}

async function withStore<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => Promise<T> | T): Promise<T> {
    const db = await openNotebookDb();
    try {
        const tx = db.transaction(ENTRIES, mode);
        const done = new Promise<void>((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error ?? new Error('Transaction aborted'));
        });
        const result = await work(tx.objectStore(ENTRIES));
        await done;
        return result;
    } finally {
        db.close();
    }
}

const req = <T>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
});

const strip = ({ id, sessionId, at, by, body }: StoredEntry): NotebookEntry => ({ id, sessionId, at, by, body });

/**
 * Whether this device has a notebook database at all. Asked before every read and delete, so a
 * build that never wrote a notebook — production — never creates the database just by looking.
 * Where the browser cannot list databases, it is assumed to exist: a read then creates an empty one,
 * which is harmless, and the app runs in Chrome, which can.
 */
async function notebookDbExists(): Promise<boolean> {
    const list = (indexedDB as IDBFactory & { databases?: () => Promise<{ name?: string }[]> }).databases;
    if (!list) return true;
    return (await list.call(indexedDB)).some(d => d.name === DB_NAME);
}

/**
 * Adds entries this device has not got, and returns the ones it added.
 *
 * Written here (`sent: false`) when the entry was made on this device; pulled from the store
 * (`sent: true`) when the store already has it. An entry that breaks the rules is refused here too,
 * and the refusal says why — the same sentence the store would give.
 */
export async function addEntries(entries: readonly NotebookEntry[], opts: { sent: boolean }): Promise<NotebookEntry[]> {
    for (const e of entries) {
        const problem = entryProblem(e);
        if (problem) throw new Error(`Notebook entry refused: ${problem}`);
    }
    return withStore('readwrite', async store => {
        const added: NotebookEntry[] = [];
        for (const e of entries) {
            if (await req(store.getKey(e.id)) !== undefined) continue;
            store.add({ ...e, sent: opts.sent } satisfies StoredEntry);
            added.push(e);
        }
        return added;
    });
}

/** The session's notebook, in the order written. */
export async function sessionEntries(sessionId: string): Promise<NotebookEntry[]> {
    if (!await notebookDbExists()) return [];
    const rows = await withStore('readonly', store => req(store.index('sessionId').getAll(sessionId) as IDBRequest<StoredEntry[]>));
    return mergeEntries(rows.map(strip));
}

/** What this device wrote and the store has not got yet. */
export async function unsentEntries(sessionId: string): Promise<NotebookEntry[]> {
    if (!await notebookDbExists()) return [];
    const rows = await withStore('readonly', store => req(store.index('sessionId').getAll(sessionId) as IDBRequest<StoredEntry[]>));
    return mergeEntries(rows.filter(r => !r.sent).map(strip));
}

/** Marks entries as in the store, once it has said so. */
export async function markSent(ids: readonly string[]): Promise<void> {
    await withStore('readwrite', async store => {
        for (const id of ids) {
            const row = await req(store.get(id) as IDBRequest<StoredEntry | undefined>);
            if (row && !row.sent) store.put({ ...row, sent: true });
        }
    });
}

/** Removes a session's notebook from this device — with the session, and only then. */
export async function deleteSessionEntries(sessionId: string): Promise<void> {
    if (!await notebookDbExists()) return;
    await withStore('readwrite', async store => {
        const keys = await req(store.index('sessionId').getAllKeys(sessionId));
        for (const k of keys) store.delete(k);
    });
}
