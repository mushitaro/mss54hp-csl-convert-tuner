import { AdaptationSnapshot } from './adaptationBlocks';
import { FlashCounterInfo } from './flashCounter';
import { ServiceBlockPointers } from './serviceBlockReport';

export type { AdaptationSnapshot, FlashCounterInfo };

/** Raw service-block bytes plus the DME's own pointers, for buildServiceBlockReport to analyse. */
export interface ServiceBlockDump {
    master: Uint8Array;
    slave: Uint8Array;
    pointers: ServiceBlockPointers;
}

export interface DmeIdentity {
    vin: string;
    aif: string;
    softwareVersion: string;
    /**
     * Remaining programming headroom on both processors, read at connect alongside VIN/AIF/SW.
     *
     * `null` when it could not be read, which is a different fact from 0/30 and must not be shown
     * as one — the other three fields make the same distinction with 'UNKNOWN'. A failure here
     * never fails the connection.
     */
    flashCounter: FlashCounterInfo | null;
}

/** A single live-telemetry sample, using the same field names as LogDataPoint so it can feed
 * straight into the existing log-processing/VE-calculation pipeline. */
export interface LiveMeasurement {
    time: number;
    rpm: number;
    rawLoad: number;
    stft1: number;
    stft2: number;
    coolantTemp?: number;
}

/** Which stage a long transfer is in. Surfaced in the UI so a slow-but-working stage (notably the
 *  post-write read-back verification, which takes ~70s at 9600 baud) doesn't look like a freeze. */
export type TransferPhase = 'erasing' | 'reading' | 'writing' | 'verifying';

export type TransferProgress = (donePercent: number, phase?: TransferPhase) => void;

/** Abstraction the connection state machine (useDmeLink) depends on. Implemented by both
 * WebSerialDmeLink (real navigator.serial + DS2 protocol) and MockDmeLink (offline simulator). */
export interface DmeLink {
    connect(): Promise<DmeIdentity>;
    disconnect(): Promise<void>;
    readPartialBin(onProgress?: TransferProgress): Promise<ArrayBuffer>;
    writePartialBin(buffer: ArrayBuffer, onProgress?: TransferProgress): Promise<void>;
    pollLiveMeasurement(): Promise<LiveMeasurement>;
    /** Reads the DME's learned adaptation values (DS2 blocks 0x06 and 0x16). */
    readAdaptations(): Promise<AdaptationSnapshot>;
    /**
     * Clears the tune-relevant adaptations, waits for the DME to commit, and re-reads. Returns the
     * post-clear values.
     *
     * Takes no mask: which adaptations a tuning tool may clear is a product decision, not a caller's
     * (see TUNE_ADAPTATION_CLEAR in ds2.ts), so "clear all" is unreachable by construction. The
     * settle-then-re-read lives here because the wait is a property of the DME, not of the UI.
     */
    clearTuneAdaptations(): Promise<AdaptationSnapshot>;
    /** Re-reads the flash counter (2 x 256 bytes), so the header can refresh without a reconnect. */
    readFlashCounter(): Promise<FlashCounterInfo>;
    /**
     * Reads both 8 KB service blocks and the DME's system-address pointers. **Read-only** — it sends
     * no erase, no write, and no programming control of any kind.
     *
     * Diagnostic, and deliberately separate from the reset that also reads these bytes: the reset
     * reads them in order to overwrite them, this reads them in order to find out what is actually
     * there. Conflating the two is how a blank block came to be treated as damage to be repaired
     * rather than a fact to be explained.
     */
    readServiceBlocks(onProgress?: TransferProgress): Promise<ServiceBlockDump>;
    /**
     * Engine speed, for deciding whether a programming operation may run.
     *
     * Deliberately separate from pollLiveMeasurement even though the real link answers it with the
     * same DS2 block. The two ask different questions — "give me a telemetry sample to plot" versus
     * "is this engine turning?" — and only the second has a defensible answer offline: the mock has
     * no engine, so it reports 0, while its telemetry stays an idle pattern because a datalog with
     * a flat 0 rpm trace would rehearse nothing. One method could not honestly serve both.
     */
    readEngineRpm(): Promise<number>;
    /**
     * Resets the flash counter on both processors, and returns what the DME reads back afterwards.
     *
     * This is the most destructive operation this interface exposes. Clearing the counter means
     * erasing and rewriting the whole 8 KB service block on each processor — the block that also
     * holds AIF, ZIF and the VIN records — so a failure part-way through can leave the ECU without
     * its identity data. `onBackup` receives those 16384 bytes (master then slave) BEFORE anything
     * is erased, and is awaited: if it rejects, no erase is sent at all. That ordering is enforced
     * here rather than by the caller because this is the layer that issues the erase, and a rule
     * about "not until the backup is safe" is only worth anything where it can actually be obeyed.
     *
     * Not cancellable once the erase has gone out, for the same reason writePartialBin isn't.
     */
    resetFlashCounter(
        onBackup: (serviceBlockPair: ArrayBuffer) => Promise<void>,
        onProgress?: TransferProgress,
    ): Promise<FlashCounterInfo>;
    /**
     * Writes a previously saved service block back, for recovering from a reset that was interrupted
     * between its erase and its rewrite.
     *
     * The mirror image of resetFlashCounter: no read, no backup — the DME's current contents are the
     * damage being undone, so there is nothing there worth preserving — and none of the guards that
     * protect the reset. In particular it does NOT refuse an erased block: an erased block is
     * precisely what this exists to fill.
     */
    restoreServiceBlock(
        serviceBlockPair: ArrayBuffer,
        onProgress?: TransferProgress,
    ): Promise<FlashCounterInfo>;
    /**
     * Tester-present, to stop the DME dropping its diagnostic session while nothing is being asked of
     * it — the adaptation dialog can sit for minutes between reading the values and clearing them.
     *
     * Best effort: resolves false instead of throwing, and skips itself whenever a real operation is
     * in flight. Nothing should branch on the result beyond diagnostics; it is a heartbeat, not a
     * health check a caller can act on.
     */
    keepAlive(): Promise<boolean>;
    /** Requests cancellation of an in-progress readPartialBin. Safe to call any time; no-op if idle. */
    abort(): void;
    /**
     * The rate the last bulk read actually ran at, or null if none has run.
     *
     * Exists because a refused baud switch is deliberately not an error — the read just proceeds at
     * 9600 — and that silence is indistinguishable from a switch that worked but didn't help. Judging
     * it by how fast the read felt is guesswork, and guesswork already cost three rates being deleted
     * on a wrong conclusion. Optional: only the real link switches baud at all.
     */
    getLastReadBaud?(): number | null;
}

export class DmeLinkError extends Error {
    constructor(message: string, public readonly cause?: unknown) {
        super(message);
        this.name = 'DmeLinkError';
    }
}

/**
 * Attached as a DmeLinkError's `cause` when a flash-counter reset is refused because the DME's
 * service block is already erased — i.e. an earlier attempt died between its erase and its rewrite.
 *
 * Carried as data rather than left inside the message so the UI can route to the recovery flow
 * instead of showing a dead end. It is the one failure here that has a specific, available remedy,
 * and telling the user to recover without giving them the control to do it is worse than not
 * mentioning it.
 */
export interface ServiceBlockErasedCause {
    kind: 'serviceBlockErased';
    processor: string;
}

export function isServiceBlockErasedCause(cause: unknown): cause is ServiceBlockErasedCause {
    return typeof cause === 'object' && cause !== null && (cause as ServiceBlockErasedCause).kind === 'serviceBlockErased';
}

/** What kind of failure the link could name, when it could name one. The echo-mismatch verdicts
 *  describe a cause; 'serviceBlockErased' names a remedy. */
export type DmeErrorKind = 'electrical' | 'desync' | 'unclassified' | 'serviceBlockErased';
