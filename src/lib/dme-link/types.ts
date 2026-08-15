import { AdaptationSnapshot } from './adaptationBlocks';
import { FlashCounterInfo } from './flashCounter';
import { ServiceBlockPointers } from './serviceBlockReport';
import type { Ds2EncodingChecksum, Ds2SupportedBaud } from './ds2';
import type { SeedMap } from './fastEntry';
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
    /** `la_f_regler1/2` — the lambda controller's output factor, DS2 selection 19.
     *
     *  OPTIONAL, and undefined means "block 19 was not read", which is what the EGT profile does.
     *  It must never be defaulted to 1.0: that is a real measurement meaning "no correction wanted",
     *  and handing it back for a block nobody fetched is the same lie as calling this channel
     *  "Lambda". A log without it cannot produce a VE map, which is correct. */
    stft1?: number;
    stft2?: number;
    coolantTemp?: number;
    /** RF — the DME's relative filling AFTER the EGT correction. Same block as rpm/rawLoad. */
    rf?: number;
    /** TABG — exhaust gas temperature, 16 °C resolution. Same block as rpm/rawLoad. */
    exhaustTemp?: number;
    /** WDK1 — throttle plate position, %. Same block as rpm/rawLoad, so free. Exists to answer
     *  "was the lambda controller even running here", by comparing against the WOT threshold. */
    wdk1?: number;
    /**
     * TETV — tank-vent valve pulse time, ms. Same block as stft1/stft2, so it is free.
     *
     * Zero means the valve is shut and this sample's trim is the engine's own mixture error. Any
     * non-zero value means some of `stft1`/`stft2` is the DME compensating for fuel it did not
     * inject, and the sample is worth less than it looks. Undefined means this DME did not report
     * the field at all — which is not the same as zero and must not be filtered as if it were.
     */
    tankVent?: number;
    /** TEFC_LL_ST — tank-vent idle functional-check state. Non-zero while the check runs. */
    tankVentCheckState?: number;
    /** TEFC_ED — tank-vent diagnostic handle. Non-zero once the DME has faulted the valve. */
    tankVentDiag?: number;
    /** LA_FREEZE_FLAG — recorded, not interpreted. Its meaning is not in the Funktionsrahmen; see
     *  the registry entry for the experiment that would establish it. */
    lambdaFreeze?: number;
}

/**
 * One read of DS2 selection 83 (EGAS) — **a latched fault freeze-frame, not telemetry.**
 *
 * This block does not stream. Master `0x024A66` fills the 52-byte buffer at `0xFFDA48` on the first
 * EGAS event and latches immediately (`tst.b (a1) / bne.w $24b82`); every later event only bumps the
 * counter in byte 0 (`0x024B82: cmpi.b #$ff,(a1) / addq.b #$1,(a1)`). On a healthy car it reads 52
 * zero bytes for as long as you care to poll it, at whatever rate you like.
 *
 * The inertia measurement was built on this block and could not have worked. What it is good for is
 * the question it was designed to answer — *what was the throttle system doing when it faulted* —
 * and, incidentally, proving where its own contents live: the copy at `0x024A66` names the RAM
 * address of every field, which is what `ramMap.ts` is built from. Live values come from there now.
 *
 * **Deliberately not a `LiveMeasurement`, and deliberately not convertible to one.** The channels
 * are disjoint, and a run recorded for one purpose cannot answer the other's question; the cheapest
 * place to discover that is the compiler rather than a VE map quietly rebuilt from samples that
 * never carried a trim.
 *
 * Every channel is `number | null` because `decodeField` returns null on a short block and null is
 * a different fact from zero — see `decodeEgasMeasurementBlock`.
 */
export interface EgasMeasurement {
    /** Seconds since this run started. Host clock, taken after the single exchange returns. Because
     *  only one block is polled there is no inter-block skew for this stamp to hide. */
    time: number;
    engineState: number | null;
    wdk1: number | null;
    /** Engine speed, 40 rpm resolution. */
    n40: number | null;
    /** Speed gradient as the DME reports it, 40 rpm/s resolution, **uncorrected**. The truncation
     *  bias is left in deliberately: this is the wire value, and correcting on the way in would put
     *  a derived number into something named like a measurement. Correct it at use — `correctDN40`. */
    dN40: number | null;
    dPwg: number | null;
    dWdk: number | null;
    rf: number | null;
    mdIndWunsch: number | null;
    mdIndNe: number | null;
    mdIndOptKorr: number | null;
    vAntrieb: number | null;
    mdDynSt: number | null;
    gang: number | null;
    sKrafts: number | null;
    saWeSt: number | null;
}

/**
 * One sample of the inertia run: DS2 selection 3 plus one control-0x06 read of live RAM.
 *
 * ## Why two exchanges rather than one block
 *
 * Because no single block carries both halves. Selection 3 has engine speed at **1 rpm** — the best
 * speed channel the DME offers, better than the 40 rpm `n40` the EGAS block would have given — plus
 * coolant temperature and throttle. It has no torque. The torque lives in RAM, and after the
 * freeze-frame discovery RAM is the only place a *live* torque can be read from at all.
 *
 * The cost is one extra round trip and the benefit is that the measurement exists. Both stamps come
 * from the same `time`, taken after the second exchange returns; the skew between them is one
 * telegram (~20 ms at 9600) and is the same every sample, so it shifts the pairing rather than
 * scattering it.
 *
 * ## Why this is not `EgasMeasurement` with different sources
 *
 * Same reason `EgasMeasurement` is not `LiveMeasurement`: the channel sets differ, and a stale run
 * of the old shape must not silently satisfy the new estimator. There is no gear, no vehicle speed
 * and no engine-state channel here — see `estimateInertia` for what stands in for each.
 */
export interface InertiaSample {
    /** Seconds since this run started. Host clock, taken after the RAM read returns. */
    time: number;
    /** Engine speed, **1 rpm** resolution (selection 3 `n`). The measurement rests on this channel. */
    rpm: number | null;
    /** Coolant temperature, °C. The gate the EGAS block could never support — it carries no `tmot`. */
    coolantTemp: number | null;
    /** Throttle plate 1, %. Used to find the closed-throttle deceleration, not as a gate. */
    wdk1: number | null;
    /** Relative filling, %. Recorded for diagnosis; the fit does not read it. */
    rf: number | null;
    /** `MD_IND_NE` — indicated torque after intervention, Nm. Read from RAM `0xFF81A6`. */
    mdIndNe: number | null;
    /** `MD_DYN_ST` — slew-limiter state. Read from RAM `0xFF8180` in the same telegram. */
    mdDynSt: number | null;
}

/** What one window of the RAM probe reported. */
export interface RamProbeWindow {
    /** The signal the probe read, for naming the window in a message. */
    name: string;
    segment: number;
    address: number;
    /** True when the DME answered with the requested bytes. */
    supported: boolean;
    /** The bytes it returned, when it did. Shown so a probe can be read as evidence, not a verdict. */
    bytes: number[] | null;
    /** Why not, when not. `parameter-error` is the DME's own `0xB0` — the region lookup refused the
     *  address, which is a different fact from the link being broken. */
    failure: 'parameter-error' | 'rejected' | 'transport' | null;
    detail: string | null;
}

/**
 * The result of asking the DME, without writing anything, whether it will serve live RAM reads.
 *
 * Exists as its own step because the whole inertia path now depends on an answer recovered from a
 * disassembly rather than observed on this car. The evidence is strong — see `ramMap.ts` — but
 * "strong" is not "checked", and the cheap way to check costs two telegrams and changes nothing.
 */
export interface RamProbeResult {
    /** Every declared window answered. */
    ok: boolean;
    windows: RamProbeWindow[];
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
    /**
     * Reads DS2 selection 83 (EGAS) — the latched fault freeze-frame. **Not a telemetry poll.**
     *
     * Kept, and kept named for what it is, because the block still answers the question it was
     * designed for. It is no longer on the inertia path; `pollInertiaSample` is. See
     * `EgasMeasurement` for why polling this in a loop returns the same bytes forever.
     */
    readEgasFreezeFrame(): Promise<EgasMeasurement>;
    /**
     * One sample of the inertia run: selection 3 plus one control-0x06 read of live RAM.
     *
     * Both exchanges are required — there is no useful degraded sample, because a speed without a
     * torque and a torque without a speed are each half of one point. So a failure in either is
     * fatal to the sample rather than something to paper over with a neutral default, which is the
     * opposite of what the VE datalog does with its second block and deliberately so.
     */
    pollInertiaSample(): Promise<InertiaSample>;
    /**
     * Reads `count` bytes of the DME's live RAM (DS2 control 0x06).
     *
     * **Read-only.** Sends one telegram, asks for bytes, changes nothing. The address must lie
     * inside a declared window in `ramMap.ts`; the DME would answer `0xB0` otherwise, but a caller
     * should not need a car to find out it asked for the wrong thing.
     */
    readRam(segment: number, address: number, count: number): Promise<Uint8Array>;
    /**
     * Asks whether this DME serves live RAM reads, by trying the smallest legal read in each window.
     *
     * Sends nothing but control-0x06 reads and never throws on a refusal — a refusal is the answer,
     * reported per window with the DME's own status distinguished from a transport failure.
     */
    probeRam(): Promise<RamProbeResult>;
    /**
     * The two CRCs the calibration currently in the ECU stores, one per processor half.
     *
     * Exists so a flash can prove what it is about to overwrite. **Every write erases and rewrites
     * all 65536 bytes** — `writePartialBinInner` refuses any other length — so a TUNED built from a
     * stale BASE does not merge with what is in the car, it replaces it wholesale. Two tunes
     * branched from one BASE therefore silently revert each other, with no overlapping addresses
     * required and nothing in either one's own diff to hint at it.
     *
     * Eight bytes rather than a re-read of all 65536: a full read is ~123 s at 9600 and would
     * double the time every flash takes, which is the kind of cost that gets a safety check turned
     * off. Two four-byte reads are effectively free.
     *
     * The trade is honest and worth stating: a CRC-16 per half means two different calibrations
     * could collide, at roughly one in 2^32 for the pair. That is ample for the real question —
     * "did something else get flashed in between?" — and it is not a defence against a deliberate
     * forgery. Nothing here needs it to be.
     */
    readDataChecksums(): Promise<{ slave: number; master: number }>;
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
     * Arms the per-exchange instrument for a datalog run, and closes it again.
     *
     * Optional because only the real link has a wire to measure — the mock's timings are `delay()`
     * calls and reporting them as if they described a cable would be worse than reporting nothing.
     *
     * The log is the one path where `hostGap` is not ~0, because `flushLiveSamples` runs a full VE
     * recalculation synchronously inside the sample callback, and it is also the path whose rate
     * has only ever been asserted. `TransferKind` has carried `'log'` since the write instrument
     * was built and nothing armed it until now, so both questions were open.
     *
     * `selections` are the DS2 blocks one sample is made of, which is what the exchange sizes have
     * to be taken from — a VE sample is 35 + 90 bytes and an inertia sample is 52, and reporting
     * either as the other makes the wire share of the time wrong. Omitted means the EGAS block.
     */
    beginLogTiming?(selections?: number[]): void;
    endLogTiming?(error?: unknown): TransferTimingReport | null;
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
    /**
     * Arms (or disarms) the post-erase baud boost on the WRITE path. 9600 disarms it.
     *
     * Settable on a live link rather than fixed at construction, because the control that arms it
     * has to be on screen at the moment WRITE is pressed. A dangerous mode you cannot see is worse
     * than one you cannot change: the read rate can sit in a constructor option because a refused
     * read costs a read, but this one is only reachable after the erase, and the operator has to be
     * able to look at the panel and see whether it is armed. The link still owns the value — the
     * hook resets it to 9600 on every connect, so it can never be inherited from a past session.
     */
    setWriteBaud?(baud: Ds2SupportedBaud): void;
    /**
     * What the boost is actually armed at, which is not always what was asked for — see setWriteBaud.
     * The caller reads this back so the control can never show a rate the link declined to take.
     */
    getWriteBaud?(): Ds2SupportedBaud;

    /**
     * Arms FAST READ with the seed map it needs, or disarms with `null`.
     *
     * FAST READ erases and restores the DME's Free Identifiers sector to reach a programming
     * session, where 125000 baud is a rate this ECU actually implements — turning a 123-second read
     * into 15-30. The seed is a map of ADDRESSES, never bytes; every byte written back is read live
     * immediately before the erase. See fastEntry.ts.
     *
     * Optional on the interface so the mock does not have to implement it: PRACTICE has no sector to
     * erase and nothing to gain, and a mock that pretended otherwise would be teaching a procedure
     * that does not exist.
     */
    setFastRead?(seed: SeedMap | null): void;
    /** Which DS2 selections a live sample is made of — see lib/log-engine/logProfile.ts. Optional
     *  so a mock link that only ever produces one shape of sample need not implement it. */
    setLiveBlocks?(selections: number[]): void;
    /** What `setLiveBlocks` left in place, which is not always what the last caller asked for — a
     *  run started without a profile keeps the previous set. The timing instrument sizes its
     *  exchanges from this, so it has to read the link's answer rather than the request. */
    getLiveBlocks?(): number[];
    /** Whether the link actually armed it. Not the same as what was asked for — a transport that
     *  cannot change rate on the open handle refuses, and the UI must report the link's answer. */
    getFastReadArmed?(): boolean;
    /**
     * DS2 reboot (service 0x12), returning whether the DME acknowledged.
     *
     * The way back out of the state FAST READ leaves behind: at 125000 the DME will not serve live
     * values, adaptations or error memory until it is restarted or the session is reconnected.
     */
    rebootDme?(): Promise<boolean>;
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
