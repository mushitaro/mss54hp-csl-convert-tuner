import { LogDataPoint, VEMap } from '@/lib/types';
import {
    openDb,
    SESSIONS_STORE,
    SESSION_LOGS_STORE,
    SESSION_BINARIES_STORE,
    TuningSession,
    SessionLogRecord,
    SessionBinariesRecord,
    BaseOrigin,
    TuneSettings,
    FlashRecord,
    AdaptationResetRecord,
} from './schema';

function promisify<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

export async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function txDone(tx: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error ?? new Error('Transaction aborted'));
    });
}

/** Runs `fn` against an open DB and always closes it, including on the error paths. */
async function withDb<T>(fn: (db: IDBDatabase) => Promise<T>): Promise<T> {
    const db = await openDb();
    try {
        return await fn(db);
    } finally {
        db.close();
    }
}

export interface CreateDraftInput {
    /** Optional — defaults to "Session #<seq>", which is only knowable in here. */
    label?: string;
}

/** Creates the empty record that the whole flow hangs off. BASE is chosen afterwards. */
export async function createDraft(input: CreateDraftInput = {}): Promise<TuningSession> {
    return withDb(async db => {
        const tx = db.transaction(SESSIONS_STORE, 'readwrite');
        const store = tx.objectStore(SESSIONS_STORE);
        // Highest seq ever used + 1, computed inside the same transaction so two rapid creates
        // cannot land on the same number. Numbers are never reused: deleting #2 must not renumber
        // #3, or every lineage badge pointing at it would start lying.
        const existing = await promisify<TuningSession[]>(store.getAll());
        const seq = existing.reduce((max, s) => Math.max(max, s.seq ?? 0), 0) + 1;
        const session: TuningSession = {
            id: crypto.randomUUID(),
            createdAt: Date.now(),
            seq,
            label: input.label ?? `Session #${seq}`,
            status: 'draft',
            baseOrigin: null,
            hasLog: false,
            logPointCount: 0,
            flashHistory: [],
        };
        store.put(session);
        await txDone(tx);
        return session;
    });
}

export interface SetBaseInput {
    sessionId: string;
    baseOrigin: BaseOrigin;
    baseBinaryBuffer: ArrayBuffer;
    baseFileName: string;
}

/** Attaches the BASE bytes + their provenance to a draft. The bytes are copied in full even when
 *  they came from another session: a session must stay flashable and verifiable after its parent
 *  is deleted, so the parent link is decorative and the bytes are authoritative. */
export async function setSessionBase(input: SetBaseInput): Promise<TuningSession> {
    const baseSha256 = await sha256Hex(input.baseBinaryBuffer);   // hashing stays outside the tx
    return withDb(async db => {
        const tx = db.transaction([SESSIONS_STORE, SESSION_BINARIES_STORE], 'readwrite');
        const store = tx.objectStore(SESSIONS_STORE);
        const existing = await promisify<TuningSession | undefined>(store.get(input.sessionId));
        if (!existing) throw new Error(`Session ${input.sessionId} not found`);

        const updated: TuningSession = {
            ...existing,
            baseOrigin: input.baseOrigin,
            parentSessionId: input.baseOrigin.kind === 'session' ? input.baseOrigin.sessionId : undefined,
            baseSha256,
            baseFileName: input.baseFileName,
            baseSize: input.baseBinaryBuffer.byteLength,
        };
        store.put(updated);

        const bins: SessionBinariesRecord = {
            sessionId: input.sessionId,
            baseBinaryBuffer: input.baseBinaryBuffer,
            tunedBinaryBuffer: null,
        };
        tx.objectStore(SESSION_BINARIES_STORE).put(bins);
        await txDone(tx);
        return updated;
    });
}

export interface SaveTuneInput {
    sessionId: string;
    binaryFileName: string;
    tunedBinaryBuffer: ArrayBuffer;
    veMapSnapshot: VEMap;
    tuneSettings: TuneSettings;
    log: LogDataPoint[] | null;
}

/** Records the tuned output of a draft: the bytes, the map, and the settings that produced them.
 *
 *  This is also the one moment a session stops being a workspace. Producing a TUNED is what ends it:
 *  the record now describes a specific set of bytes, and tuning on top of them would silently make it
 *  describe something else. Continue with "Use as base -> TUNED", which starts a new branch.
 *  (Status used to be a side effect of creating the *next* session, which meant a saved-but-unflashed
 *  session stayed an editable draft forever.) */
export async function saveTune(input: SaveTuneInput): Promise<TuningSession> {
    const sha256 = await sha256Hex(input.tunedBinaryBuffer);
    return withDb(async db => {
        const tx = db.transaction([SESSIONS_STORE, SESSION_BINARIES_STORE, SESSION_LOGS_STORE], 'readwrite');
        const store = tx.objectStore(SESSIONS_STORE);
        const existing = await promisify<TuningSession | undefined>(store.get(input.sessionId));
        if (!existing) throw new Error(`Session ${input.sessionId} not found`);

        const hasLog = !!input.log && input.log.length > 0;
        const updated: TuningSession = {
            ...existing,
            status: 'archived',
            binaryFileName: input.binaryFileName,
            tunedSize: input.tunedBinaryBuffer.byteLength,
            sha256,
            veMapSnapshot: input.veMapSnapshot,
            tuneSettings: input.tuneSettings,
            hasLog,
            logPointCount: input.log?.length ?? 0,
        };
        store.put(updated);

        const binStore = tx.objectStore(SESSION_BINARIES_STORE);
        const bins = await promisify<SessionBinariesRecord | undefined>(binStore.get(input.sessionId));
        if (!bins) throw new Error(`Session ${input.sessionId} has no BASE — set the base before saving a tune`);
        binStore.put({ ...bins, tunedBinaryBuffer: input.tunedBinaryBuffer });

        if (hasLog) {
            const logRecord: SessionLogRecord = { sessionId: input.sessionId, data: input.log! };
            tx.objectStore(SESSION_LOGS_STORE).put(logRecord);
        }
        await txDone(tx);
        return updated;
    });
}

async function patchSession(id: string, patch: (s: TuningSession) => TuningSession): Promise<TuningSession> {
    return withDb(async db => {
        const tx = db.transaction(SESSIONS_STORE, 'readwrite');
        const store = tx.objectStore(SESSIONS_STORE);
        const existing = await promisify<TuningSession | undefined>(store.get(id));
        if (!existing) throw new Error(`Session ${id} not found`);
        const updated = patch(existing);
        store.put(updated);
        await txDone(tx);
        return updated;
    });
}

export function renameSession(id: string, label: string): Promise<TuningSession> {
    return patchSession(id, s => ({ ...s, label }));
}

export function archiveSession(id: string): Promise<TuningSession> {
    return patchSession(id, s => ({ ...s, status: 'archived' }));
}

/** Appends what was actually flashed. Options can differ from tuneSettings (PATCH on for logging,
 *  off for the final flash), so the record stores the bytes' real hash rather than assuming. */
export function appendFlashRecord(id: string, record: FlashRecord): Promise<TuningSession> {
    return patchSession(id, s => ({ ...s, flashHistory: [...s.flashHistory, record] }));
}

/** Appends an adaptation reset. Unlike flashHistory this array is optional (see the schema), so it
 *  is spread through `?? []` — a session created before the field existed has no array to spread. */
export function appendAdaptationReset(id: string, record: AdaptationResetRecord): Promise<TuningSession> {
    return patchSession(id, s => ({ ...s, adaptationResets: [...(s.adaptationResets ?? []), record] }));
}

export async function listSessions(): Promise<TuningSession[]> {
    return withDb(async db => {
        const tx = db.transaction(SESSIONS_STORE, 'readonly');
        const sessions = await promisify(tx.objectStore(SESSIONS_STORE).index('createdAt').getAll());
        return sessions.sort((a, b) => b.createdAt - a.createdAt); // newest first
    });
}

export async function getSessionLog(sessionId: string): Promise<LogDataPoint[] | null> {
    return withDb(async db => {
        const tx = db.transaction(SESSION_LOGS_STORE, 'readonly');
        const record = await promisify<SessionLogRecord | undefined>(tx.objectStore(SESSION_LOGS_STORE).get(sessionId));
        return record?.data ?? null;
    });
}

export async function getSessionBinaries(sessionId: string): Promise<SessionBinariesRecord | null> {
    return withDb(async db => {
        const tx = db.transaction(SESSION_BINARIES_STORE, 'readonly');
        const record = await promisify<SessionBinariesRecord | undefined>(
            tx.objectStore(SESSION_BINARIES_STORE).get(sessionId)
        );
        return record ?? null;
    });
}

export async function deleteSession(id: string): Promise<void> {
    await withDb(async db => {
        const tx = db.transaction([SESSIONS_STORE, SESSION_LOGS_STORE, SESSION_BINARIES_STORE], 'readwrite');
        tx.objectStore(SESSIONS_STORE).delete(id);
        tx.objectStore(SESSION_LOGS_STORE).delete(id);
        tx.objectStore(SESSION_BINARIES_STORE).delete(id);   // else every delete orphans ~128 KB
        await txDone(tx);
    });
}
