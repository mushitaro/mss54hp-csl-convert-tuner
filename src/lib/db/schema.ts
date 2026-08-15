import type { ProcessId } from '@/lib/log-engine/logProfile';
import { LogDataPoint, VEMap, LogFilterConfig, InterpolationPoint } from '@/lib/types';
import { AdaptationSnapshot } from '@/lib/dme-link/adaptationBlocks';
import type { EgasMeasurement, InertiaSample } from '@/lib/dme-link/types';

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
    /**
     * Tank ventilation held shut (K_TE_TVTE_GA = 0).
     *
     * Optional, and absent reads as false — which is correct here rather than merely convenient:
     * no session saved before this field existed could have had the patch, because the code to
     * write it did not exist. Unlike writeRfKorr, there is no legacy encoding to reconstruct from.
     *
     * Recorded because it changes what the log MEANS, not just what the bytes are. A run taken with
     * purge disabled and one taken without are not comparable, and a year later the only way to
     * know which a session was is that this was written down.
     */
    applyTankVentDisable?: boolean;
    writeWarmup: boolean;
    writeWot: boolean;
    /** Write the back-calculated KF_RF_KORR_DRREL into the binary. Beside writeWarmup and writeWot
     *  because it is the same kind of thing: a table derived from this tune, injected at flash time.
     *
     *  Optional, and a missing value reads as false — but NOT because false is a safe default. A
     *  session saved before this field existed encoded the write inside `filterConfig.rfKorrMode`
     *  ('tuned'), so `resolveRfKorr().legacyWrite` is what such a row must be reconstructed from.
     *  Reading the absence as plain false would silently drop the table write from every archived
     *  'tuned' session and break its sha256 reproduction. See loadSession. */
    writeRfKorr?: boolean;
}

export interface FlashRecord {
    at: number;
    sha256: string;
    settings: Pick<TuneSettings, 'applyPatch' | 'applyWotDisable' | 'applyTankVentDisable' | 'writeWarmup' | 'writeWot'>;
    /** Did these bytes carry a derived map, or only the patches? `settings` cannot answer that — a
     *  patch-armed BASE and a patch-armed tune record identically — and the flash count is now a mix
     *  of both, so the history has to say which each one was.
     *
     *  Optional because records written before the field existed have no value for it. Those are all
     *  tunes: flashing without a derived map was unreachable until the hub gained WRITE PATCH-ON, so
     *  a missing value reads as `true` rather than as unknown. Additive like `adaptationResets` — no
     *  index changes, so no DB version bump. */
    tuned?: boolean;
    /** How this flash was verified — 'quick' (the DME's own encoding checksum, DS2 0x0A) or 'full'
     *  (that, plus a byte-for-byte read-back of all 65536 bytes).
     *
     *  Recorded because the two are not the same claim, and the history is the only place the
     *  distinction survives once the dialog is dismissed. Optional: records written before the
     *  choice existed were all full read-backs, but they are left undefined rather than backfilled
     *  as 'full' — "we know it was a read-back" and "we have no record" are different facts, and
     *  only the UI rendering them should decide how to say so. */
    verifyMode?: 'quick' | 'full';
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

/** A flash-counter reset performed during this session.
 *
 *  Worth keeping because the counter is the DME's own record of how much programming life it has
 *  left, and a reset is the one act that makes that record stop matching reality — without this,
 *  a later "1/30 used" gives no hint that the ECU has actually been programmed 40 times. `backupAt`
 *  is the key into the separate service-block backup database (serviceBackupRepository.ts), which
 *  is where the recovery image for this reset lives. */
export interface FlashCounterResetRecord {
    at: number;
    /** Slots used per processor before and after, as the DME reported them. */
    beforeMasterUsed: number;
    beforeSlaveUsed: number;
    afterMasterUsed: number;
    afterSlaveUsed: number;
    /** Primary key of the pre-erase service-block backup in the separate backup database. */
    backupAt: number;
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

    /**
     * What this session's log was captured FOR — and therefore which DS2 blocks it holds.
     *
     * One session, one log, one process: `SessionLogRecord` is keyed by session id and holds a
     * single log, so the process is a property of the session rather than of a run within it.
     *
     * Optional, and absent reads as 'VE'. That is not a lenient default but a historically correct
     * one — every session recorded before profiles existed polled blocks 3 and 19 and produced a VE
     * map, because there was nothing else it could do.
     *
     * Nothing is gated on this. An EGT log has no `la_f_regler` and so cannot produce a VE map
     * whatever this field says; the field is here so the session list can show the chain (an EGT run
     * and the VE run branched from it) and so `deriveRoute` can name the campaign shape.
     */
    process?: ProcessId;

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

    /** Mean sample rate of the stored log, in Hz. Derived in saveTune from the log's own `time`
     *  column, so a DS2 run and a CSV import are measured the same way and neither has to report it.
     *
     *  Optional, and unlike FlashRecord.tuned there is no defensible default for a missing value:
     *  a rate is either measured or unknown, so old rows render nothing rather than "0.0 Hz".
     *  Additive — no index change, so no DB_VERSION bump (see the note at the top of this file). */
    averageHz?: number;

    /** Replaces writtenToDme. The same tune legitimately gets flashed more than once with
     *  different options (log runs with PATCH on, the final street flash with it off), and the
     *  record must not claim bytes that were never written. */
    flashHistory: FlashRecord[];

    /** Adaptation resets performed before logging this session. Optional, and appended with `?? []`
     *  rather than a bare spread like flashHistory: this field post-dates v3, so rows written before
     *  it genuinely do not have the array. */
    adaptationResets?: AdaptationResetRecord[];

    /** Flash-counter resets performed while this session was open. Optional and spread through
     *  `?? []` for the same reason as adaptationResets — and no DB_VERSION bump, because an added
     *  optional property needs none (see the note at the top of this file). */
    flashCounterResets?: FlashCounterResetRecord[];

    /** When this device last sent the session to the store. Display only — `syncedFingerprint` is
     *  what decides whether it is still current. */
    syncedAt?: number;

    /** What was sent, as `sessionFingerprint` describes it (session-sync/client.ts).
     *
     *  A timestamp alone cannot answer the question the sync button asks. "Sent at 14:02" says
     *  nothing about a log recorded at 14:30, so a button keyed on it would go quiet the moment
     *  anything was sent once and stay quiet through every subsequent run. Storing what was sent is
     *  what lets "already up there" and "up there, but stale" be different states.
     *
     *  Kept on the session rather than in localStorage so that deleting a session takes its sync
     *  state with it and nothing has to prune orphans. Both fields are optional and additive — no
     *  DB_VERSION bump, per the note at the top of this file. A row written before they existed
     *  simply reads as never sent, which is the truthful answer for it. */
    syncedFingerprint?: string;
}

export interface SessionLogRecord {
    sessionId: string;
    data: LogDataPoint[];

    /**
     * The raw samples of an inertia run, stored unprojected.
     *
     * `data` above cannot hold them and must not try. An `InertiaSample` carries indicated torque
     * and the slew-limiter state; a `LogDataPoint` has fields for neither. Mapping one onto the
     * other keeps `time` and engine speed and silently discards `mdIndNe` — one of the two
     * quantities the estimate is a regression between — which makes a stored run un-re-analysable,
     * and cost one real drive to discover.
     *
     * So both are kept: `data` in the projected shape the log table and the CSV export read, and
     * this in the shape `estimateInertia` reads. Optional and additive, so no `DB_VERSION` bump
     * (see the note at the top of this file) and a session written before it existed simply has no
     * raw copy — which is the truthful answer for it.
     *
     * Nulls are preserved as nulls on the way in. `mdIndNe: null` means the RAM read came back
     * short; `mdIndNe: 0` means overrun, no combustion torque. Collapsing the first into the second
     * would feed the regression a fabricated anchor point at exactly the place it is most sensitive.
     */
    inertia?: InertiaSample[];

    /**
     * Runs recorded against the abandoned DS2 selection-83 design, kept readable.
     *
     * Never written any more. Selection 83 is a latched fault freeze-frame, so every array under
     * this key is either empty or 52 zero bytes repeated — but deleting the field would turn those
     * sessions into ones that silently lost data rather than ones that never had any, and the
     * difference is worth a line of type.
     */
    egas?: EgasMeasurement[];
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
