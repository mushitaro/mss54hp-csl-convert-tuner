import type { ProcessId } from '@/lib/log-engine/logProfile';
import type { LogDataPoint, VEMap } from '@/lib/types';
import type { InertiaSample, IdleSample } from '@/lib/dme-link/types';
import { sampleRateHz } from '@/lib/log-engine/rate';
import {
    openDb,
    SESSIONS_STORE,
    SESSION_LOGS_STORE,
    SESSION_BINARIES_STORE,
} from './schema';
// Split from the value import above: Node's type stripping cannot tell a type-only named import
// from a value one, and the verify scripts load this module. Same reason as rfKorrTuner.ts:3.
import type {
    TuningSession,
    SessionLogRecord,
    SessionBinariesRecord,
    BaseOrigin,
    TuneSettings,
    FlashRecord,
    AdaptationResetRecord,
    FlashCounterResetRecord,
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
 *  Deliberately does NOT change `status`. Saving is not committing: nothing has left the machine, so
 *  the honest thing is to overwrite the stored TUNED next time rather than to freeze the workspace.
 *  This used to archive, on the reasoning that "the record now describes a specific set of bytes" —
 *  true, but the bytes are re-derivable and the record is the derivation, so a re-save simply
 *  re-describes them. What it cost was the case that actually happens: SAVE is the only way to
 *  persist a data log (a live run exists in memory until then), so saving a run to keep it locked
 *  RAW FILTER and every other setting the log would be re-derived through — the session was read-only
 *  before anyone had looked at the map it produced.
 *
 *  A flash is what ends a session, and only a flash: see handleDmeWrite, which calls this and then
 *  archive(). At that point the bytes are in an ECU, re-deriving would drift the record away from
 *  them, and "Use as base -> TUNED" is the way to continue. */
/**
 * What a save should STORE, given what it was handed and what is already there.
 *
 * Pulled out of the two call sites because both got it wrong in opposite directions and neither
 * mistake could be reached by a test: `saveResearchRun` accepted an `idle` array and never wrote
 * it, and `saveSessionTune` replaced the whole record and so destroyed whatever raw samples were
 * already in it. One is a field that is silently dropped, the other a field that is silently
 * deleted, and both look identical from outside — an empty array where a drive used to be.
 *
 * The rule, in one place: MERGE onto what exists, replace an array only when this save actually
 * carries one, and return null when the result would hold nothing at all. Adding a fourth sample
 * kind now means adding it here, where the test can see it.
 */
export function nextLogRecord(
    sessionId: string,
    prior: SessionLogRecord | undefined,
    incoming: { data?: LogDataPoint[]; inertia?: InertiaSample[]; idle?: IdleSample[] },
): SessionLogRecord | null {
    const merged: SessionLogRecord = {
        ...prior,
        sessionId,
        data: incoming.data ?? prior?.data ?? [],
    };
    if (incoming.inertia?.length) merged.inertia = incoming.inertia;
    if (incoming.idle?.length) merged.idle = incoming.idle;
    const holdsNothing = merged.data.length === 0
        && !merged.inertia?.length && !merged.idle?.length;
    return holdsNothing ? null : merged;
}

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
            binaryFileName: input.binaryFileName,
            tunedSize: input.tunedBinaryBuffer.byteLength,
            sha256,
            veMapSnapshot: input.veMapSnapshot,
            tuneSettings: input.tuneSettings,
            hasLog,
            logPointCount: input.log?.length ?? 0,
            // Derived here rather than passed in, alongside the two fields above that already work
            // this way. Both call sites get it for free, and a CSV import is measured by exactly the
            // same rule as a live DS2 run. Assigned unconditionally: `...existing` means a
            // conditional spread would let a previous log's rate survive a re-save with a new one.
            averageHz: sampleRateHz(input.log ?? []),
        };
        store.put(updated);

        const binStore = tx.objectStore(SESSION_BINARIES_STORE);
        const bins = await promisify<SessionBinariesRecord | undefined>(binStore.get(input.sessionId));
        if (!bins) throw new Error(`Session ${input.sessionId} has no BASE — set the base before saving a tune`);
        binStore.put({ ...bins, tunedBinaryBuffer: input.tunedBinaryBuffer });

        if (hasLog) {
            // MERGED onto whatever is already stored, not written over it. A plain `put` of
            // `{ sessionId, data }` replaces the record, so saving a tune after a run destroyed the
            // `inertia` and `idle` arrays that run had just written — the raw samples, which are the
            // only copy an estimator can read and cannot be reconstructed from `data`.
            const logStore = tx.objectStore(SESSION_LOGS_STORE);
            const prior = await promisify<SessionLogRecord | undefined>(logStore.get(input.sessionId));
            const record = nextLogRecord(input.sessionId, prior, { data: input.log! });
            if (record) logStore.put(record);
        }
        await txDone(tx);
        return updated;
    });
}

/**
 * Persists an inertia run: its samples, and the fact that it happened.
 *
 * A separate entry point from `saveTune`, not a flag on it, because the two record different kinds
 * of thing. `saveTune` exists to say "this session produced TUNED bytes" — it sets `sha256`, which
 * is what makes the download and the "Use as base" branch offer anything. An inertia run produces
 * no bytes at all: it proposes calibration changes for a person to read and decide on, and writes
 * nothing. Giving it a sha256 would put a downloadable TUNED on a session that never made one,
 * which is exactly the "BASE dressed as a TUNED" this repository already refuses elsewhere.
 *
 * So the record is BASE + log + the process label, and nothing more. The session list needs no
 * special case: `canFromTuned` is `!!session.sha256`, so an inertia session simply never offers
 * FINAL, Finalize or From TUNED. It stays a draft for the same reason — nothing was flashed.
 *
 * The log is stored in the same store as every other, keyed the same way. It is EgasMeasurement
 * rather than LogDataPoint, which is why the caller serialises it: the two sample types are
 * deliberately not interchangeable (see EgasMeasurement) and this function is not the place to
 * blur that.
 */
export async function saveResearchRun(input: {
    sessionId: string;
    process: ProcessId;
    log: LogDataPoint[];
    /** The unprojected samples, when this is an inertia run. Written alongside `log` rather than
     *  instead of it: `log` feeds the log table and the CSV export, this feeds the estimator, and
     *  neither can be reconstructed from the other. */
    inertia?: InertiaSample[];
    /** The unprojected samples, when this is an idle run. Same rule as `inertia`: the projection
     *  keeps time and engine speed and drops md_llri, which is the entire measurement. */
    idle?: IdleSample[];
}): Promise<TuningSession> {
    return withDb(async db => {
        const tx = db.transaction([SESSIONS_STORE, SESSION_LOGS_STORE], 'readwrite');
        const store = tx.objectStore(SESSIONS_STORE);
        const existing = await promisify<TuningSession | undefined>(store.get(input.sessionId));
        if (!existing) throw new Error(`Session ${input.sessionId} not found`);

        const updated: TuningSession = {
            ...existing,
            process: input.process,
            hasLog: input.log.length > 0,
            logPointCount: input.log.length,
            averageHz: sampleRateHz(input.log),
        };
        store.put(updated);
        // Written whenever there is EITHER kind of sample, and deliberately not nested inside a
        // `log.length` guard. The two arrays fail independently — a projection that produced
        // nothing must not be allowed to discard the raw samples, which are the only copy the
        // estimator can read.
        const logStore = tx.objectStore(SESSION_LOGS_STORE);
        const prior = await promisify<SessionLogRecord | undefined>(logStore.get(input.sessionId));
        const record = nextLogRecord(input.sessionId, prior, {
            data: input.log, inertia: input.inertia, idle: input.idle,
        });
        if (record) logStore.put(record);
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

/** Records what a run was for, at the moment it starts. Best-effort at the call site: it labels the
 *  session and feeds `deriveRoute`, and nothing is gated on it — an EGT log cannot make a VE map
 *  because it has no trim channel, not because of this field. */
export function setSessionProcess(id: string, process: ProcessId): Promise<TuningSession> {
    return patchSession(id, s => ({ ...s, process }));
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

/** Appends a flash-counter reset. Optional array, so spread through `?? []` like the one above. */
export function appendFlashCounterReset(id: string, record: FlashCounterResetRecord): Promise<TuningSession> {
    return patchSession(id, s => ({ ...s, flashCounterResets: [...(s.flashCounterResets ?? []), record] }));
}

/** Records that this device sent the session to the store, and what it sent.
 *
 *  The fingerprint is computed by the caller, from the session as it stood when the upload STARTED.
 *  That ordering is the whole point: a run that finishes recording while a slow upload is in flight
 *  must leave the session outstanding, and it does — the fingerprint written here describes the
 *  older shape, so `needsSync` still returns true for the newer one. Computing it in here, after the
 *  await, would silently mark the new data as already sent. */
export function markSessionSynced(id: string, fingerprint: string): Promise<TuningSession> {
    return patchSession(id, s => ({ ...s, syncedAt: Date.now(), syncedFingerprint: fingerprint }));
}

export async function listSessions(): Promise<TuningSession[]> {
    return withDb(async db => {
        const tx = db.transaction(SESSIONS_STORE, 'readonly');
        const sessions = await promisify(tx.objectStore(SESSIONS_STORE).index('createdAt').getAll());
        return sessions.sort((a, b) => b.createdAt - a.createdAt); // newest first
    });
}

/**
 * The projected log alone — what the log table, the chart and the CSV export read.
 *
 * Correct for those callers and wrong for anything that MOVES a session. `record.data` is a
 * projection: `SessionLogRecord.inertia` holds the samples the estimator needs and has no
 * representation in `LogDataPoint`, so a caller that reads through here and writes the result back
 * has silently dropped them. Use `getSessionLogRecord` for that.
 */
export async function getSessionLog(sessionId: string): Promise<LogDataPoint[] | null> {
    const record = await getSessionLogRecord(sessionId);
    return record?.data ?? null;
}

/**
 * The whole stored log record, unprojected.
 *
 * Exists because the sync path used `getSessionLog` and therefore uploaded a session without its
 * raw inertia samples — and then `putSessionRaw`, which writes the record whole, DELETED the local
 * copy on the way back in. Pulling your own session back destroyed the one thing the schema
 * comment says must never be collapsed (see SessionLogRecord.inertia, "cost one real drive to
 * discover"). Anything that round-trips a session goes through here.
 */
export async function getSessionLogRecord(sessionId: string): Promise<SessionLogRecord | null> {
    return withDb(async db => {
        const tx = db.transaction(SESSION_LOGS_STORE, 'readonly');
        const record = await promisify<SessionLogRecord | undefined>(tx.objectStore(SESSION_LOGS_STORE).get(sessionId));
        return record ?? null;
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

/**
 * Writes a whole session back — the record, its log and its binaries — as one transaction.
 *
 * The restore half of the server sync. Everything else in this file builds a session up a step at
 * a time, which is right for a session being made; this is for one that already exists somewhere
 * else and has to arrive intact. One transaction because the three stores are only meaningful
 * together: a session record whose log did not land is a row that claims a log it cannot produce.
 *
 * Overwrites by id. That is what makes re-restoring the same session idempotent, and it is the
 * caller's job to have asked first if it would clobber local work — see the confirm in the panel.
 *
 * Takes the whole `SessionLogRecord`, not a `LogDataPoint[]`. It used to take the projection and
 * write `{ sessionId, data }`, which meant a restore erased `inertia` from the local record even
 * when the incoming session had it — a whole-record `put` cannot preserve a field the caller was
 * never given. The record travels intact from `getSessionLogRecord` through the wire to here.
 */
export async function putSessionRaw(
    session: TuningSession,
    log: SessionLogRecord | null,
    binaries: SessionBinariesRecord | null,
): Promise<void> {
    await withDb(async db => {
        const tx = db.transaction([SESSIONS_STORE, SESSION_LOGS_STORE, SESSION_BINARIES_STORE], 'readwrite');
        tx.objectStore(SESSIONS_STORE).put(session);
        // `sessionId` forced from the session, never trusted from the record: a mismatched pair
        // would write the log under a key nothing reads.
        if (log) tx.objectStore(SESSION_LOGS_STORE).put({ ...log, sessionId: session.id });
        else tx.objectStore(SESSION_LOGS_STORE).delete(session.id);
        if (binaries) tx.objectStore(SESSION_BINARIES_STORE).put({ ...binaries, sessionId: session.id });
        else tx.objectStore(SESSION_BINARIES_STORE).delete(session.id);
        await txDone(tx);
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
