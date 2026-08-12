import { AdaptationSnapshot } from './adaptationBlocks';
import { FlashCounterInfo } from './flashCounter';
import { ServiceBlockPointers } from './serviceBlockReport';
import type { Ds2EncodingChecksum } from './ds2';
import type { LinkEventLogSnapshot } from './linkEventLog';
import type { TransferTimingReport } from './transferTiming';

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
    /**
     * The DME's own encoding-checksum verdict, read once at connect. `null` when the query failed or
     * this DME does not answer control 0x0A.
     *
     * Read here — before anything is written — precisely so that a post-write reading has something
     * to be compared against. On its own, "bits 2 and 6 are clear after the flash" is only evidence
     * if the DME recomputes on demand; if it were answering from a cached value it would say the
     * same thing either way. A before-and-after pair settles that empirically, and costs one
     * 4-byte telegram on a path that already sends a dozen.
     */
    encodingChecksum: Ds2EncodingChecksum | null;
}

/** A single live-telemetry sample, using the same field names as LogDataPoint so it can feed
 * straight into the existing log-processing/VE-calculation pipeline. */
export interface LiveMeasurement {
    /** Seconds since the run started. Note the Testo CSV path uses milliseconds for the same
     *  field name on LogDataPoint — log-engine/filter.ts detects which it is holding. */
    time: number;
    rpm: number;
    rawLoad: number;
    stft1: number;
    stft2: number;
    coolantTemp?: number;
    /** RF — the DME's relative filling AFTER the EGT correction. Same block as rpm/rawLoad. */
    rf?: number;
    /** TABG — exhaust gas temperature, 16 °C resolution. Same block as rpm/rawLoad. */
    exhaustTemp?: number;
}

/** Which stage a long transfer is in. Surfaced in the UI so a slow-but-working stage (notably a FULL
 *  post-write read-back, measured at 122.9 s at 9600 baud) doesn't look like a freeze. */
export type TransferPhase = 'erasing' | 'reading' | 'writing' | 'verifying';

export type TransferProgress = (donePercent: number, phase?: TransferPhase) => void;

/**
 * How a flash write proves it landed.
 *
 * Both modes keep the per-telegram verify byte, which is not optional and is not a mode: every
 * chunk's response is parsed and a verify byte other than 1 ("programming OK") throws. What the
 * mode chooses is what happens *after* the last chunk.
 *
 * - `quick` — ask the DME for its own encoding checksum (control 0x0A) and require the two data
 *   areas to be clean. One exchange, ~50 ms. This is the reference tool's default, and its
 *   authority is the CRC-16/ARC values the ECU stores in its own flash, covering 65528 of the
 *   pair's 65536 bytes. It cannot say *where* a mismatch is, and it cannot catch a corruption that
 *   preserves CRC-16.
 * - `full` — everything `quick` does, **and** read all 65536 bytes back and compare byte for byte.
 *   ~123 s at 9600. The only check that can name an offset.
 *
 * `full` is not "instead of" the checksum: the checksum runs in both modes, because one exchange is
 * not worth choosing between two independent authorities over.
 */
export type WriteVerifyMode = 'quick' | 'full';

export interface WriteOptions {
    /**
     * Deliberately required, with no default anywhere in the stack.
     *
     * A default here would be a silent decision about how strongly a flash was proven, made in a
     * layer that has no business making it — and the wrong half of that choice looks identical to
     * the right one until an ECU is wrong.
     */
    verifyMode: WriteVerifyMode;
}

/** What a completed write actually proved, so the UI can say it rather than imply it. */
export interface WriteVerification {
    mode: WriteVerifyMode;
    /** The DME's post-write verdict, or null when control 0x0A could not be asked. */
    encodingChecksum: Ds2EncodingChecksum | null;
    /** Why `encodingChecksum` is null, when it is. Never silently empty. */
    encodingChecksumError: string | null;
    /** True when a byte-for-byte read-back ran — and therefore passed, since a mismatch throws. */
    readBack: boolean;
}

/** Abstraction the connection state machine (useDmeLink) depends on. Implemented by both
 * WebSerialDmeLink (real navigator.serial + DS2 protocol) and MockDmeLink (offline simulator). */
export interface DmeLink {
    connect(): Promise<DmeIdentity>;
    disconnect(): Promise<void>;
    readPartialBin(onProgress?: TransferProgress): Promise<ArrayBuffer>;
    /**
     * Erases and rewrites the DataTune pair, then verifies per `options.verifyMode`.
     *
     * Returns what it proved rather than resolving void, so the completion dialog, the session
     * record and the saved artifact can all state the same thing about the same write. A write
     * verified two different ways must not be describable by one word.
     */
    writePartialBin(buffer: ArrayBuffer, options: WriteOptions, onProgress?: TransferProgress): Promise<WriteVerification>;
    /**
     * Asks the DME for its own encoding-checksum status (DS2 control 0x0A).
     *
     * **Read-only and non-destructive** — it sends four bytes and asks a question. That is what
     * makes it usable at connect as well as after a write, and the before/after pair is what turns
     * a single post-write reading into evidence.
     */
    queryEncodingChecksum(): Promise<Ds2EncodingChecksum>;
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
    /**
     * The DME's own published maximum DS2 telegram length (system address table index 21), or null
     * if the pointer was absent or unreadable.
     *
     * Diagnostic only — nothing branches on it yet. It exists because the 122-byte read chunk every
     * tool uses is an undocumented default, not a limit: DS2 framing allows 251, BMW's own SGBD uses
     * 120, and the ECU publishes its real ceiling here. The reference tool ships a decoder for this
     * value and never calls it, so this number has never been looked at on a car.
     */
    getMaxTelegramLength?(): number | null;
    /**
     * Per-exchange timing for the last instrumented operation, or null if timing was off or none has
     * run. One slot, and `kind` says which operation it describes.
     *
     * One slot rather than one per operation on purpose: the alternative is three getters, three
     * pieces of UI state, and the standing question of which one a save button is looking at. A
     * report is cleared at the *start* of the next operation, so "no report" always means this
     * operation produced none — it can never mean "here is the previous one's".
     */
    getLastTransferTiming?(): TransferTimingReport | null;
    /**
     * Phase-level narrative of the last instrumented operation: what was sent, in what order, and
     * what the DME answered. Paired with the timing report when a diagnostic record is uploaded.
     *
     * Separate from the timing report because they answer different questions and fail
     * independently — an operation that dies before the instrument is armed still has a story, and
     * that is exactly the operation worth having one for.
     */
    getEventLog?(): LinkEventLogSnapshot;
    /**
     * Turns per-exchange timing collection on or off.
     *
     * There is no user-facing switch behind this. It exists because a link that never collects is
     * the honest default for implementations with no transport to measure (the mock), and because
     * collection is armed per operation rather than globally — see TransferTiming's `collecting`.
     * The caller arms it once at connect.
     */
    setTimingEnabled?(enabled: boolean): void;
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
