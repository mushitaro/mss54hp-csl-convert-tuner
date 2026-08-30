import type { ProcessId } from '@/lib/log-engine/logProfile';
import type { LogDataPoint, VEMap, LogFilterConfig, InterpolationPoint } from '@/lib/types';
// `import type`, deliberately: Node's type stripping cannot tell a type-only named import from a
// value one, and the verify scripts load this module through the import graph. Same reason as
// rfKorrTuner.ts:3 and adaptationBlocks.ts:14.
import type { AdaptationSnapshot } from '@/lib/dme-link/adaptationBlocks';
import type { EgasMeasurement, InertiaSample, IdleSample } from '@/lib/dme-link/types';
import type { CalEdit } from '@/lib/calibration/edits';

export const DB_NAME = 'mss54hp-tuner-db';
// 3: adds `seq`. Existing rows have no number, and the lineage badges are built on it, so the
// v1/v2 upgrade rebuilds the stores rather than leaving "#?" rows behind.
//
// Raising this no longer destroys anything: `onupgradeneeded` rebuilds only from `oldVersion < 3`
// and takes additive changes above it. Adding a store or an index is now a normal edit — bump this,
// add an `if (oldVersion < N)` branch that only creates.
//
// Optional properties still need no bump at all: IndexedDB stores structured clones, so an old row
// simply lacks them, which `?` already describes.
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
    /** @deprecated Retired 2026-08-21 with `generateWOTMap`, which derived this table as
     *  `stock x (newVE / stockVE)` — the VE correction applied a second time, lean by c^2. A stored
     *  `true` describes bytes that can no longer be reproduced, and should not be: see
     *  COMMUNITY_WOT_FUEL_RAW. Kept in the record so an old session still parses. */
    writeWot?: boolean;
    /** Put `KF_TI_N_RF_VL` back to the community reference on the next write. A restore, so it has
     *  no "off" direction: false writes nothing rather than writing something else. */
    restoreWotFuel?: boolean;
    /**
     * Put `kf_rf_soll` (0xD356) / `kf_rf_soll_kath` (0xD770) back to the CSL 0401 reference on the
     * next write. Restores, so no "off" direction: false writes nothing rather than something else.
     *
     * Two fields for two tables, because a campaign moves them independently. Absent reads as
     * false, and here that is the honest default rather than a convenient one — the code to write
     * either did not exist when older sessions were saved, so no such session can have carried one.
     */
    restoreVe?: boolean;
    restoreWarmup?: boolean;
    /** Write the back-calculated KF_RF_KORR_DRREL into the binary. Beside writeWarmup and writeWot
     *  because it is the same kind of thing: a table derived from this tune, injected at flash time.
     *
     *  Optional, and a missing value reads as false — but NOT because false is a safe default. A
     *  session saved before this field existed encoded the write inside `filterConfig.rfKorrMode`
     *  ('tuned'), so `resolveRfKorr().legacyWrite` is what such a row must be reconstructed from.
     *  Reading the absence as plain false would silently drop the table write from every archived
     *  'tuned' session and break its sha256 reproduction. See loadSession. */
    writeRfKorr?: boolean;
    /**
     * Write the VE map into the binary. The map used to be written unconditionally whenever it
     * existed, so **absence reads as TRUE**: every session saved before this field existed had the
     * map in its bytes, and reading the absence as false would break sha256 reproduction of every
     * archived tune. The default flipped to opt-in only for NEW artifacts (WRITE VE on the hub
     * manifest), not for interpreting the past.
     */
    writeVe?: boolean;
    /** Write the low-opening rows of kf_rf_soll (composed with the VE map by composeVeGrid — one
     *  table, one writer). Absence reads as false: no session saved before this field existed
     *  could have had the block, the arming state was never persisted. */
    writeLowLoad?: boolean;
    /**
     * The CALIBRATION tab edits ARMED at save time — self-contained raw runs
     * (address/bits/signed/raw), the same records buildPatchedBuffer applied, so a
     * reopened session can re-arm them and rebuild the same bytes. Absence reads
     * as none: no session saved before this field existed could have carried one.
     * Optional properties need no DB_VERSION bump — see the note on it above.
     */
    calibrationEdits?: CalEdit[];
}

export interface FlashRecord {
    at: number;
    sha256: string;
    settings: Pick<TuneSettings, 'applyPatch' | 'applyWotDisable' | 'applyTankVentDisable' | 'writeWarmup' | 'writeWot' | 'restoreWotFuel'>;
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
    /**
     * Was this a PRACTICE write — the mock link, no cable, no ECU?
     *
     * The record exists either way, because a practice run is worth reviewing and because leaving
     * it out would make the history disagree with the diagnostics table, which has recorded `mock`
     * since the feature shipped. What it must never do is *count* as a flash: every other consumer
     * of this array is answering a question about a physical car — is the tune on the road, which
     * patches is the ECU holding, how many times has it been written.
     *
     * Written after a practice run put a full tune record in #907's history. Three days later a
     * fresh read came back byte-identical to the one before it, and the only two readings available
     * were "the write silently failed" and "someone reflashed the original" — both alarming, both
     * wrong. One boolean would have said "no bytes ever left the laptop".
     *
     * Optional, and absent means REAL: records written before this field existed came from a build
     * whose practice writes were indistinguishable, and there is nothing in them to reclassify from.
     * A history that predates the field cannot be trusted on this point — say so rather than
     * guessing, which is why `describeFlashHistory` renders the three states separately.
     */
    practice?: boolean;
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
     * The idle run's raw samples. Same rule the inertia array exists to enforce: the projection
     * into `data` keeps time and engine speed and DROPS md_llri, which is the entire measurement.
     * A run stored only as the projection cannot be re-analysed, and that has already cost a real
     * drive once.
     */
    idle?: IdleSample[];
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

        /**
         * Rebuild only from the versions that genuinely cannot be migrated; add, never drop, above.
         *
         * This handler used to delete all three stores unconditionally, which made every future
         * DB_VERSION bump destroy every saved session on every device — a landmine armed to go off
         * on whichever commit next needed a new index. The comment on DB_VERSION said "think hard
         * before raising this"; a warning is not a guard, and the sessions at risk are drives that
         * cost fuel and a road to record.
         *
         * `oldVersion` is 0 on a fresh install and the pre-upgrade version otherwise, so the two
         * cases the rebuild is FOR — no stores at all, and v1/v2 rows that carry no BASE and no
         * settings and therefore cannot be reviewed or reproduced — are exactly `oldVersion < 3`.
         * Anything at 3 or above keeps its rows and takes additive changes only.
         */
        request.onupgradeneeded = (event) => {
            const db = request.result;
            const oldVersion = event.oldVersion;

            if (oldVersion < 3) {
                // contains() still matters: a fresh install arrives at oldVersion 0 with nothing
                // to delete, and a v1 install has only some of these.
                for (const name of [SESSIONS_STORE, SESSION_LOGS_STORE, SESSION_BINARIES_STORE]) {
                    if (db.objectStoreNames.contains(name)) db.deleteObjectStore(name);
                }
                const sessions = db.createObjectStore(SESSIONS_STORE, { keyPath: 'id' });
                sessions.createIndex('createdAt', 'createdAt');
                db.createObjectStore(SESSION_LOGS_STORE, { keyPath: 'sessionId' });
                db.createObjectStore(SESSION_BINARIES_STORE, { keyPath: 'sessionId' });
                return;
            }

            // v3 -> v4 and beyond go here, additively:
            //   if (oldVersion < 4) { ...createObjectStore / createIndex only... }
            // Never delete a store in this branch. A migration that has to reshape existing rows
            // reads them through `request.transaction` (the versionchange transaction) and writes
            // them back — it does not start over.
        };

        /**
         * Which of the three handlers already answered the caller.
         *
         * `blocked` is not terminal, and that is the whole reason this flag exists. Rejecting from
         * `onblocked` settles the promise, but the SAME request stays live: when the tab that was
         * holding the old version finally closes, `onsuccess` fires and hands over an open
         * `IDBDatabase`. The `resolve` is a no-op on an already-rejected promise, so that handle
         * has no owner — `withDb`'s `finally { db.close() }` never runs for it — and an unclosed
         * connection is exactly what blocks the next upgrade. One transient block would otherwise
         * become a permanent one, curable only by killing the app.
         */
        let settled = false;

        request.onsuccess = () => {
            const db = request.result;
            // Don't wedge another tab's upgrade: close as soon as it asks for a newer version.
            db.onversionchange = () => db.close();
            if (settled) { db.close(); return; }   // see `settled` — nobody is waiting for this one
            settled = true;
            resolve(db);
        };
        request.onerror = () => {
            if (settled) return;
            settled = true;
            reject(request.error);
        };
        // 'blocked' is neither success nor error, so without this the promise never settles and
        // every caller hangs — including the auto-save right after flashing the ECU.
        request.onblocked = () => {
            if (settled) return;
            settled = true;
            reject(new Error(
                'Database upgrade is blocked by another open tab. Close the app\'s other tabs and retry.'
            ));
        };
    });
}
