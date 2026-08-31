import {
    DmeLink, DmeIdentity, LiveMeasurement, EgasMeasurement, InertiaSample, IdleSample, RamProbeResult, RamProbeWindow,
    TransferProgress, DmeLinkError, ServiceBlockErasedCause,
    ServiceBlockDump, WriteOptions, WriteVerification,
} from './types';
import {
    AMBIENT_CHARGE_ADDRESS, AMBIENT_TEMP_ADDRESS, IDLE_VALVE_STATE_ADDRESS,
    SLEW_STATE_ADDRESS, SLEW_TORQUE_ADDRESS,
    decodeAmbientCharge, decodeAmbientTemp, decodeIdleValveState, decodeSlewState, decodeSlewTorque,
    mergeSlowLane, type SlowLaneChannels, type SlewChannels,
} from './slowLane';
import type { SpotWindow } from './spotCheck';
import {
    INERTIA_RAM_READ, LAMBDA_TRIM_RAM_READ, RAM_PROBE_READS,
    IDLE_TORQUE_RAM_READ, IDLE_ACTUATOR_RAM_READ, ENGINE_STATE_RAM_READ, COMPRESSOR_RAM_READ,
    IDLE_GOVERNOR_RAM_READ, IDLE_THROTTLE_RAM_READ, IDLE_WDK_RAM_READ, IDLE_LAMBDA_LEARN_RAM_READ,
    IDLE_RESERVE_RAM_READ, IDLE_STEERING_RAM_READ, IDLE_VALVE_STATE_RAM_READ,
    IDLE_VANOS_RAM_READ, IDLE_VANOS_TARGET_RAM_READ, AMBIENT_CHARGE_RAM_READ,
    Mss54HpRamSignals, decodeRamSignal, isRamReadInRange,
} from './ramMap';
import {
    type LogExchange, LAMBDA_TRUTH_GATE, lambdaTrimAgrees, IDLE_SLOW_LANE_EVERY, IDLE_SURVEY_LANE_EVERY,
    IDLE_TORQUE_TRUTH_GATE, idleTorqueAgrees,
} from '@/lib/log-engine/logProfile';
import { ServiceBlockPointers } from './serviceBlockReport';
import { ByteTransport, createDmeTransport } from './byteTransport';
import {
    Ds2Frame, Ds2Control, Ds2ProgrammingControl, Ds2BaudRate, Ds2BaudRateSpec, Ds2SupportedBaud, ds2BaudSpecFor,
    Mss54HpDataTuneLayout, DS2_DEFAULT_ADDRESS,
    buildDs2Frame, parseDs2Frame, frameToBytes, isPositiveResponse,
    buildSeedRequestPayload, buildKeyPayload, isAlreadyUnlockedResponse, isSeedResponse, calculateLoginKey,
    buildReadMemoryPayload, buildWriteMemoryPayload, parseWriteResult, describeVerifyByte,
    TUNE_ADAPTATION_CLEAR, VANOS_ADAPTATION_CLEAR, buildClearAdaptationsPayload, classifyEchoMismatch, Ds2Status,
    programmingWriteTimeoutFor,
    Ds2EncodingChecksum, parseEncodingChecksum, faultedAreas, DATA_TUNE_CHECKSUM_BITS,
    Ds2ReadBlockSize,
} from './ds2';
import {
    parseSystemAddressTable, findPointer, parseAifEntries, latestPopulatedAifEntry,
    parseZifProgramNumber, detectVariantFromZif, AIF_TOTAL_LENGTH,
} from './identity';
import {
    STANDARD_MEASUREMENT_BLOCK, OPERATING_MEASUREMENTS_BLOCK, EGAS_MEASUREMENT_BLOCK,
    decodeStandardMeasurementBlock, decodeOperatingMeasurementsBlock, decodeEgasMeasurementBlock,
    UB_PLAUSIBLE,
} from './liveValueBlocks';
import { FieldDef } from './blockDecoder';
import {
    AdaptationSnapshot, STANDARD_ADAPTATIONS_BLOCK, OBSERVATION_ADAPTATIONS_BLOCK, buildAdaptationSnapshot,
    minPayloadLength,
} from './adaptationBlocks';
import {
    FlashCounterInfo, ServiceBlockLayout, SERVICE_BLOCK_PAIR_LENGTH, CLEAR_PREP_MARKER,
    analyzeFlashCounter, extractCounterFromServiceBlock, buildResetServiceBlockImage,
    shouldWriteClearPrepMarker, hasIntactAif, FLASH_COUNTER_RESET_ENABLED, FAST_ENTRY_PREP_MARKER,
} from './flashCounter';
import {
    type Span, type SeedMap, buildPreservationPlan, toDs2Address, planBytes,
} from './fastEntry';
import { TransferTiming, TransferTimingReport } from './transferTiming';
import { CHECKSUM_OFFSET_WITHIN_HALF, CHECKSUM_SLOT_LENGTH } from '@/lib/checksum/dmeDataChecksum';
import { LinkEventLog, LinkEventLogSnapshot, describeEncodingChecksum } from './linkEventLog';

/** The four channels only block 19 carries, which the VE profile now reads at 1/8 the sample rate
 *  and carries forward in between. Two of them (`tefc_ed`, `la_freeze_flag`) live in slave RAM this
 *  calibration refuses to serve, so there is no faster way to them at all. */

/** What an exchange is, for the timing report's per-kind breakdown. Short, stable strings: they end
 *  up as JSON keys in the diagnostics store and get compared across runs. */
function describeExchangeBytes(controlByte: number, payload: Uint8Array): string {
    if (controlByte === Ds2Control.READ_IO_STATUS && payload.length >= 1) return `block${payload[0]}`;
    // buildReadMemoryPayload puts the count last, and the count is what decides the response size.
    if (controlByte === Ds2Control.READ_MEMORY && payload.length === 5) return `ram${payload[4]}`;
    return `ctrl0x${controlByte.toString(16).padStart(2, '0')}`;
}

// DS2 system-address-table pointer indices (Ds2KnownSystemAddressLengths / IdentifyService)
//
// MAX_TELEGRAM (21) is the DME's own statement of the largest DS2 telegram it will accept. The
// reference tool has a decoder for it ("{value[0]} byte max DS2 telegram length") and BMW's SGBD has
// a job named BLOCKLAENGE_MAX, but the reference NEVER CALLS ITS OWN DECODER — it logs the pointer
// address and stops. So the 122-byte chunk everyone uses has never been checked against the number
// the ECU publishes. Treat what we read as an upper bound to probe toward, not as permission: nobody
// has confirmed this interpretation on a car, which is exactly why we are reading it.
const SYSTEM_ADDRESS_INDEX = { DIF: 15, ZIF_BACKUP: 16, BRIF: 18, ZIF: 19, AIF: 20, MAX_TELEGRAM: 21 } as const;
const ZIF_LENGTH = 78;

const RESPONSE_TIMEOUT_MS = 2000;
// Flash write responses can take much longer than reads (the DME programs cells before replying);
// the reference uses 15s at 9600 baud (ProgrammingWriteSupport.GetProgrammingWriteTimeout).
const WRITE_RESPONSE_TIMEOUT_MS = 15000;
const ERASE_TIMEOUT_MS = 65000;
// The first write into the service block wakes something slow in the DME: the reference allows the
// master prepare marker 30 s where every other data write gets 15 (ClearFlashCounterExecutor).
// Applied to both processors here — a timeout that is too generous only delays a failure.
const PREP_MARKER_TIMEOUT_MS = 30000;
const CHUNK_RETRY_ATTEMPTS = 5;
// Base pause between bulk-read chunk attempts, multiplied by the attempt number (see
// readMemoryChunkWithRetry). The reference Ds2MemoryReader uses a flat 1 s x 4 = 4 s of settling per
// failing chunk; escalating from 300ms reaches 3 s without making the common single-glitch case wait
// a full second before its first retry.
const CHUNK_RETRY_DELAY_MS = 300;
// Attempts for one flash WRITE telegram, matching the reference Ds2MemoryProgrammer's 5. Only the
// telegram is retried — a DME that answered and reported "verify failed" is not re-asked, because
// re-sending that would hide failing flash rather than survive a lost message. See
// writeChunkTelegramWithRetry.
const WRITE_CHUNK_RETRY_ATTEMPTS = 5;
// Keep-alive probes sent straight after a baud switch to prove both ends really landed on the new
// rate. Two, because one miss right after a port close/open is not enough evidence to abandon a
// boost that might be fine.
//
// The cost when the link really has gone silent is TWO response timeouts plus a settle — 2 x 2000 +
// 30 ms, about four seconds, not the "~300 ms" this said before. Four seconds is still the right
// trade against discovering it 2 % into a 538-chunk read, but it is the number, and a probe that
// claims to be an order of magnitude cheaper than it is invites being called from somewhere it
// should not be.
const SWITCH_PROBE_ATTEMPTS = 2;
// Clearing adaptations writes EEPROM before the DME replies, so the plain read timeout is thin.
const ADAPT_CLEAR_TIMEOUT_MS = 5000;
// The DME needs a moment to commit the cleared values before they read back true. The reference2
// ECUWorx tool waits 2s between ADAPT_LOESCHEN and its re-read; match it.
const ADAPT_SETTLE_MS = 2000;
// Adaptation exchanges resync-and-retry like the bulk read's chunks do. 3 is enough for a transient
// K-line glitch; the 300ms pause matches readMemoryChunkWithRetry and, more importantly, lets a late
// or partial response finish arriving so the purge that follows actually clears it.
const ADAPT_RETRY_ATTEMPTS = 3;
const ADAPT_RETRY_DELAY_MS = 300;
// Attempts for the one exchange the whole datalog rides on (block 3). Deliberately small: a sample
// must never block long enough to starve the poll cadence, and this is a mitigation for transient
// glitches, not a cure for a bad line.
const POLL_RETRY_ATTEMPTS = 2;

/**
 * How many datalog exchanges the timing instrument sizes its lanes for.
 *
 * A run has no chunk count to derive this from, so it is a fixed window rather than the read's
 * `ceil(total / chunkSize)`. 256 exchanges is ~30 s at the rate the EGAS profile is expected to
 * reach — long enough for the median turnaround and the `hostGap` distribution to settle, and
 * bounded so a twenty-minute drive does not allocate for twenty minutes. `TransferTiming.end()`
 * already drops anything past capacity, so overflowing this is a non-event.
 */
const LOG_TIMING_WINDOW_EXCHANGES = 256;
/** DS2 selection -> payload bytes, for the blocks a log run can be made of. Sizing the timing
 *  window is the only thing that needs this, and it needs all three in one place. */
const LIVE_BLOCK_LENGTHS: Record<number, number> = {
    [STANDARD_MEASUREMENT_BLOCK.selection]: STANDARD_MEASUREMENT_BLOCK.expectedLength,
    [OPERATING_MEASUREMENTS_BLOCK.selection]: OPERATING_MEASUREMENTS_BLOCK.expectedLength,
    [EGAS_MEASUREMENT_BLOCK.selection]: EGAS_MEASUREMENT_BLOCK.expectedLength,
};
// Before the first adaptation exchange, wait for the K-line to fall silent so the echo read isn't
// racing a prior operation's still-arriving response. One quiet window this long with nothing new
// received counts as silent; give up after this many rounds rather than blocking forever.
const DRAIN_QUIET_MS = 150;
const DRAIN_MAX_ROUNDS = 8;
// A latched break is a different problem from a stale tail and needs a different remedy. Re-acquiring
// the reader does not repair a disturbed line: the fresh reader simply re-latches the same break, so
// cycling it every 150ms is churn, not recovery — the line never gets a quiet stretch long enough to
// come back. These give it real, escalating silence instead (400 / 800 / 1200 ms).
const BREAK_SETTLE_MS = 400;
const BREAK_RECOVERY_ROUNDS = 3;
// resyncTransport purges (or re-acquires) the reader and the very next thing that happens is a write.
// Every other DS2 tool leaves an inter-message gap; this one had none. Hygiene rather than a cure —
// a pre-write pause cannot prevent corruption that happens DURING our own transmission.
const RESYNC_SETTLE_MS = 30;
// A DME that answers 0xA1 BUSY is working, not failing, so re-asking must not spend a transport
// retry. Its own small budget: the clear commits to EEPROM in well under a second, and anything
// still busy after two seconds is a different problem.
const BUSY_POLL_INTERVAL_MS = 150;
const BUSY_POLL_ATTEMPTS = 13;
// (The keep-alive cadence lives in useDmeLink, which owns the timer. The link only decides whether a
// given tick is safe to send — see keepAlive.)

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function arraysEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

function isAllErased(bytes: Uint8Array): boolean {
    for (let i = 0; i < bytes.length; i++) if (bytes[i] !== 0xFF) return false;
    return true;
}

function toHex(bytes: Uint8Array): string {
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(' ');
}

/**
 * Proves, BEFORE an erase, that every chunk writeBlock is about to emit for these blocks is legal.
 *
 * The failure this exists to prevent: every flash path here erases first and writes second, and the
 * only check on an over-long write lives inside buildWriteMemoryPayload — a throw that would land on
 * the first chunk, i.e. on an ECU that has already been erased. ds2.ts asserts the constant itself at
 * module load; this asserts the plan, including the short tail chunk, which the constant alone does
 * not cover. Both are cheap. Neither may run after an erase has been sent.
 */
function assertWriteChunkingLegal(blocks: readonly { address: number; length: number }[]): void {
    const chunk = Mss54HpDataTuneLayout.writeChunkSize;
    if (chunk > 123) throw new DmeLinkError(`Refusing to flash: write chunk ${chunk} exceeds the DS2 write cap of 123`);
    if (chunk <= 0 || chunk % 2 !== 0) throw new DmeLinkError(`Refusing to flash: write chunk ${chunk} is not positive and even`);
    for (const block of blocks) {
        if (block.address % 2 !== 0) {
            throw new DmeLinkError(`Refusing to flash: block base 0x${block.address.toString(16)} is not even`);
        }
        // The final chunk is the remainder, and it must be even too or the last write is misaligned.
        const tail = block.length % chunk;
        if (tail % 2 !== 0) {
            throw new DmeLinkError(`Refusing to flash: block of ${block.length} bytes leaves an odd ${tail}-byte tail at chunk ${chunk}`);
        }
    }
}

/**
 * Real DME connection over a K+DCAN-style cable, using the BMW DS2 protocol.
 *
 * The name is now slightly narrower than the truth: the byte transport underneath is Web Serial on
 * desktop and the FTDI vendor protocol over WebUSB on Android (see byteTransport.ts). Nothing in
 * this file knows which — it holds a `ByteTransport` and every one of its calls is the same on both.
 * The class keeps its name deliberately; renaming a 1400-line file with dense blame buys nothing.
 *
 * Must be initiated from a genuine user gesture on either backend: neither the serial port picker
 * nor the USB device chooser can be triggered programmatically.
 *
 * Read/write addressing for the MSS54HP "DataTune" partial BIN, identity (VIN/AIF/software
 * version) parsing, and the live-measurement block layout are all confirmed against the
 * reference Mss54Ds2Tool source (see ds2.ts, identity.ts, liveValueBlocks.ts) — none of this
 * has been exercised against a real DME yet, since navigator.serial's port picker requires a
 * genuine user click that cannot be automated.
 */
export class WebSerialDmeLink implements DmeLink {
    private readonly transport: ByteTransport;
    private connected = false;
    private aborted = false;
    /**
     * The CommandGate this class was missing.
     *
     * One transport, one frame in flight. Until now nothing enforced that: useDmeLink's 'resetting'
     * state existed purely so the UI could not offer START TUNE during a clear, and its own comment
     * says so — a UI-level guard standing in for a link-level one. That held while every DS2 request
     * came from a user action, and stops holding the moment a timer sends one (keepAlive), so the
     * real primitive goes here.
     *
     * Public operations take it exclusively; keepAlive skips rather than queues, because a tester-
     * present frame is only worth sending when the line is otherwise idle.
     */
    private gateHeld = false;

    private async withGate<T>(fn: () => Promise<T>): Promise<T> {
        if (this.gateHeld) throw new DmeLinkError('Another DME operation is already in progress');
        this.gateHeld = true;
        // Every operation starts un-cancelled, and this is the only place that says so.
        //
        // `aborted` is latched by Cancel Read and checked by `readRange` and the chunk retry on
        // every attempt. It used to be cleared by eight hand-written assignments at the top of eight
        // operations — and the three that did not have one were the bug: after a Cancel Read, every
        // inertia sample failed for the rest of the session, and the pre-write checksum comparison
        // failed too, which is the check that decides whether a flash would overwrite somebody
        // else's work. A list of places that must remember to do a thing is a list that will be
        // added to and not remembered.
        //
        // Here rather than inside each operation because the gate IS the boundary of an operation.
        // An abort that arrives while no operation holds the gate means nothing and is discarded;
        // one that arrives during an operation still latches and is still honoured, because this
        // runs before `fn` rather than during it.
        this.aborted = false;
        try { return await fn(); } finally { this.gateHeld = false; }
    }
    /**
     * Baud rate to use for the bulk read. 9600 by default — proven, and it sends no switch at all.
     *
     * **Nothing sets this any more.** The UI selector is gone (see Ds2SupportedBaud), so every read
     * from the app runs at 9600 and FAST READ's 125000 arrives by a different route entirely. The
     * constructor option stays for the same reason `readChunkSize` does: it is real, it is free, and
     * it is the escape hatch if a different cable or a different car ever makes the question live
     * again. What went is the control that invited another sweep — a knob proven to lose the read is
     * not neutral, it costs a trip to the vehicle every time someone wonders.
     */
    private readonly readBaud: Ds2SupportedBaud;
    /**
     * Bytes per read telegram. Defaults to the layout's 122.
     *
     * An instance field, NOT a mutation of Mss54HpDataTuneLayout: the write chunk lives in that same
     * object behind a module-load invariant, and the two were one constant until a latent brick was
     * found in it. Nothing here may reach the write path, and an instance field cannot.
     */
    private readonly readChunkSize: number;
    /**
     * Rate to boost the FLASH WRITE to, after the erase. 9600 means no switch is attempted at all.
     *
     * Separate from `readBaud` because they are different experiments with wildly different costs.
     * A refused or failed read costs a read. This switch can only be sent from inside a programming
     * session, which only exists after the erase — so the one moment it can be tried is the moment
     * the ECU has least to fall back on. See writePartialBinInner for the ordering that bounds it.
     */
    private writeBaud: Ds2SupportedBaud;
    /**
     * Set once a baud boost has actually been accepted, and never cleared. Adaptation reads/clears
     * need a normal 9600 session; readPartialBin does try to hand the session back at 9600, but that
     * restore is best-effort by design (see its finally block), so "we restored it" is not something
     * this class can honestly claim. The reference refuses adaptation work for the rest of the
     * session on the same grounds (AdaptationService.EnsureReady checks HasEnteredFastReadOrWriteMode
     * — has it *ever* boosted, not what the baud is now). A fresh connect() builds a new link, which
     * is exactly the reference's "reconnect" remedy.
     */
    /**
     * The cached non-0xFF map of this DME's Free Identifiers sector, if one has been loaded.
     *
     * ADDRESSES ONLY — see fastEntry.ts. Supplied by the caller from the session store rather than
     * read here, because deciding which stored backup belongs to which DME is a question about VIN
     * and PRACTICE-vs-real that the link layer has no business answering.
     */
    private fastEntrySeed: SeedMap | null = null;
    /** Whether to attempt the erase-and-restore entry on the next bulk read. Only ever true when a
     *  seed exists AND the transport can change rate on the open handle — see setFastRead. */
    private fastReadArmed = false;

    /** Whether this session has EVER left 9600, which is what makes adaptations unavailable — the
     *  DME does not serve them after a programming session even once the rate has come back down.
     *  Named for the fact rather than for the moment: `hasBoostedThisSession` read like a question
     *  about right now, and it is not one. */
    private everBoosted = false;
    /** The rate the last bulk read ran at — see DmeLink.getLastReadBaud. A historical fact about
     *  that read, and NOT the rate the link is at now: a read that boosted to 125000 comes back down
     *  to 9600 before it returns, and this deliberately keeps saying 125000 afterwards. */
    private lastReadBaud: number | null = null;
    /**
     * The rate the local port is open at, right now.
     *
     * Separate from `lastReadBaud` because two different questions were being answered with one
     * field. "What did that read run at?" is what the notice line and the read's own diagnostic want,
     * and it must survive the restore to 9600. "What is this link running at?" is what a datalog's
     * timing report and a write's event log want — and both were reading `lastReadBaud`, so a
     * datalog started after a 125000 read filed its exchanges as 125000 baud when every one of them
     * went out at 9600. The wire-time figures derived from that are wrong by a factor of thirteen.
     *
     * Maintained wherever the port is actually reopened, which is the only place it can change.
     */
    private currentBaud = 9600;
    /** The DME's published maximum DS2 telegram length, read during identify. Null when the pointer
     *  is absent or the read failed — "not read" is a different fact from "no limit". */
    private maxTelegramLength: number | null = null;
    /** What happened to the last 0x91 baud switch: 'accepted', 'rejected (DS2 status 0x..)', or
     *  'failed (...)'. Null when no switch was attempted, i.e. a plain 9600 read. */
    private lastSwitchOutcome: string | null = null;
    /** Per-exchange instrument. Always constructed, collects only between an operation's begin/finish. */
    private readonly timing = new TransferTiming();
    /**
     * Phase-level narrative of the operation in flight, replaced at the start of each one.
     *
     * Replaced rather than appended to, for the same reason the timing report is cleared up front:
     * a log that spans two attempts reads as one, and the whole value of uploading it is being able
     * to trust that what it describes is the run that just failed.
     */
    private events = new LinkEventLog();

    getEventLog(): LinkEventLogSnapshot {
        return this.events.snapshot();
    }

    getLastReadBaud(): number | null {
        return this.lastReadBaud;
    }

    getMaxTelegramLength(): number | null {
        return this.maxTelegramLength;
    }

    getLastTransferTiming(): TransferTimingReport | null {
        return this.timing.getReport();
    }

    setTimingEnabled(enabled: boolean): void {
        this.timing.setEnabled(enabled);
        this.transport.setTiming(enabled ? this.timing : null);
    }

    /**
     * Arms the post-erase boost. Refused outright on a transport that cannot change rate on the open
     * handle, so an armed selector can never mean something the transport will not do — the guard
     * lives here rather than only in the UI, because the UI is not the thing that sends 0x91.
     */
    setWriteBaud(baud: Ds2SupportedBaud): void {
        this.writeBaud = baud !== 9600 && !this.transport.reopenIsInPlace() ? 9600 : baud;
    }

    getWriteBaud(): Ds2SupportedBaud {
        return this.writeBaud;
    }

    /**
     * Arms FAST READ, and supplies the seed map it needs.
     *
     * Both together, because they are not independent: arming without a seed is a no-op that would
     * look like a broken switch, and a seed with nothing armed is dead weight. Passing `null`
     * disarms. The caller owns the decision about WHICH stored backup belongs to this DME — that is
     * a question about VIN and PRACTICE-vs-real, and the link layer must not be the thing that
     * answers it.
     */
    setFastRead(seed: SeedMap | null): void {
        this.fastEntrySeed = seed;
        this.fastReadArmed = seed !== null && this.transport.reopenIsInPlace();
    }

    getFastReadArmed(): boolean {
        return this.fastReadArmed;
    }

    /**
     * `transport` exists for the bench harness and for a future byte-level fake; production passes
     * nothing and gets whatever this browser can reach — Web Serial on desktop, the FTDI vendor
     * protocol over WebUSB on Android. Deciding it in the factory rather than at the call site keeps
     * the React layer free of platform knowledge.
     */
    constructor(options?: {
        readBaud?: Ds2SupportedBaud;
        readChunkSize?: Ds2ReadBlockSize;
        writeBaud?: Ds2SupportedBaud;
        transport?: ByteTransport;
    }) {
        this.readBaud = options?.readBaud ?? 9600;
        this.writeBaud = options?.writeBaud ?? 9600;
        this.readChunkSize = options?.readChunkSize ?? Mss54HpDataTuneLayout.readChunkSize;
        this.transport = options?.transport ?? createDmeTransport();
    }

    abort(): void {
        this.aborted = true;
    }

    async connect(): Promise<DmeIdentity> {
        await this.transport.open();
        try {
            await this.login();
        } catch (e) {
            await this.transport.close();
            throw e;
        }
        this.connected = true;
        return this.identify();
    }

    async disconnect(): Promise<void> {
        this.connected = false;
        await this.transport.close();
    }

    private assertConnected() {
        if (!this.connected) throw new DmeLinkError('Not connected to DME');
    }

    /**
     * Sends a request frame, reads back the mandatory K-line echo, then reads the real response.
     *
     * The timing calls here are the only ones on a path shared with the FLASH WRITE. Every one is
     * void, cannot throw, and is inert outside a bulk read (the instrument only collects between
     * begin() and finish()) — an instrument must never be able to change what a write does.
     */
    private async exchange(controlByte: number, payload: Uint8Array, timeoutMs = RESPONSE_TIMEOUT_MS): Promise<Ds2Frame> {
        this.timing.exchangeStart(performance.now());
        // Named from the bytes about to go out, so the label can never disagree with the wire. A
        // datalog's sample is three different shapes of exchange now and one median over all of
        // them answers nothing — see TransferTiming.label.
        this.timing.label(describeExchangeBytes(controlByte, payload));
        const request = buildDs2Frame(DS2_DEFAULT_ADDRESS, controlByte, payload);
        await this.transport.write(request);

        const echo = await this.transport.readExact(request.length, timeoutMs);
        // Marked before the mismatch check: the echo bytes are on the wire either way, and the
        // turnaround measurement wants the arrival time of the last of them.
        this.timing.echoComplete(performance.now());
        if (!arraysEqual(echo, request)) {
            // Report WHICH failure this is rather than leaving it to be guessed. classifyEchoMismatch
            // separates "a stale response was read in the echo's place" (software desync) from "the
            // line was pulled low mid-transmission" (electrical) by bit direction — see ds2.ts.
            //
            // Deliberately NO resync here. Recovery belongs to the layers that own retry
            // (adaptationExchangeWithRetry, the poll retry, readMemoryChunkWithRetry); putting it in
            // this primitive would also silently clear a latch mid-flash and let the erase-failure
            // fallback re-issue ERASE after what may have been a DME reset.
            const a = classifyEchoMismatch(request, echo);
            const latched = this.transport.peekReadError();
            // The analysis rides along in `cause`, not just flattened into the message. The dialog
            // needs the verdict as data so it can offer the physical checklist for an electrical
            // fault instead of "check the connection and retry" — advice that cannot work when
            // something is pulling the line down.
            throw new DmeLinkError(
                `Unexpected K-line echo (sent ${toHex(request)}, got ${toHex(echo)}) — ${a.verdict} ` +
                `[lag +${a.lag}, ${a.flips1to0} bit(s) 1→0, ${a.flips0to1} bit(s) 0→1, ` +
                `${a.trailingZeroRun}-byte zero tail, ${this.transport.bufferedLength()} byte(s) still buffered` +
                `${latched ? `, latched ${latched.name}` : ''}]`,
                a,
            );
        }

        const header = await this.transport.readExact(2, timeoutMs);
        // Check the address before trusting the length byte. Out of frame, a bogus length would
        // otherwise consume up to 253 further bytes (swallowing the NEXT response) or stall a whole
        // timeout before the checksum finally rejected it.
        if (header[0] !== DS2_DEFAULT_ADDRESS) {
            throw new DmeLinkError(
                `DS2 response out of frame: expected address 0x${DS2_DEFAULT_ADDRESS.toString(16)}, got ${toHex(header)}`,
            );
        }
        const declaredLength = header[1];
        if (declaredLength < 4) throw new DmeLinkError(`Invalid DS2 response length byte ${declaredLength}`);
        const rest = await this.transport.readExact(declaredLength - 2, timeoutMs);

        const full = new Uint8Array(declaredLength);
        full.set(header, 0);
        full.set(rest, 2);
        // Only a completed exchange is recorded. A chunk that threw above is counted by retry()
        // instead — mixing a failed exchange into the medians would blend a timeout into the
        // turnaround figure, which is the one number this whole instrument exists to isolate.
        this.timing.exchangeEnd(performance.now());
        return parseDs2Frame(full);
    }

    /**
     * Requests a DS2 baud-rate switch (control 0x91) and, on a positive response, reconfigures the
     * local serial port to match. Best-effort: if the DME rejects the switch, returns false and the
     * caller stays at the current baud. Mirrors TrySwitchToProgrammingBaudAsync.
     */
    /**
     * Asks whether the DME is still talking now that both ends have supposedly moved to a new rate.
     *
     * Uses the keep-alive (0x9E) because it is the cheapest telegram in the protocol and the session
     * already sends it every two seconds, so it cannot disturb anything. Two attempts with a resync
     * between: one miss straight after a port close/open is not enough evidence to give up a boost
     * that might be fine.
     */
    private async linkRespondsAfterSwitch(): Promise<boolean> {
        for (let attempt = 1; attempt <= SWITCH_PROBE_ATTEMPTS; attempt++) {
            try {
                if (isPositiveResponse(await this.exchange(Ds2Control.KEEP_ALIVE, new Uint8Array(0)))) return true;
                // Inside the try, with the exchange it belongs to. `resyncTransport` can throw when
                // the device is gone, and this function's whole contract is to answer a QUESTION —
                // "did the switch hold?" — so a throw escaping from here replaces the caller's
                // orderly fall back to 9600 with a transport error. On the WRITE path that means an
                // erased ECU gets a message about a cable instead of "erased, not yet rewritten".
                await delay(RESYNC_SETTLE_MS);
                await this.resyncTransport();
            } catch { /* fall through to the retry; a silent link is the answer, not an error */ }
        }
        return false;
    }

    private async trySwitchBaud(target: Ds2BaudRateSpec): Promise<boolean> {
        let accepted = false;
        try {
            const frame = await this.exchange(Ds2Control.REQUEST_BAUD_SWITCH, target.payload, RESPONSE_TIMEOUT_MS);
            accepted = isPositiveResponse(frame);
            // Record WHY, not just that it failed. A rate the DME does not implement answers 0xA2
            // REJECTED, which is a different fact from the request timing out — and until now a
            // refused switch left no trace in the saved report at all, only a colour on the notice
            // line. Four candidate rates were tested on a car and the files could not say whether the
            // ECU had turned them down or the app had never asked.
            this.lastSwitchOutcome = accepted
                ? 'accepted'
                : `rejected (DS2 status 0x${frame.controlOrStatus.toString(16)})`;
        } catch (e) {
            this.lastSwitchOutcome = `failed (${e instanceof Error ? e.message : String(e)})`;
            return false; // request itself failed — DME is still at the current baud
        }
        if (!accepted) return false; // DME rejected the switch — still at the current baud
        // The DME has committed to the new baud, so the local port MUST match it now.
        try {
            await this.transport.reopen(target.baudRate);
            this.currentBaud = target.baudRate;
        } catch (e) {
            throw new DmeLinkError(
                `Baud switch to ${target.baudRate} could not reopen the serial port (${e instanceof Error ? e.message : String(e)}). ` +
                `Disconnect and reconnect to recover.`,
            );
        }
        await delay(200); // settle after the local port re-opens at the new baud
        return true;
    }

    private async login(accessLevel = 5): Promise<void> {
        const seedFrame = await this.exchange(Ds2Control.REQUEST_LOGIN_SEED, buildSeedRequestPayload(accessLevel));
        if (isAlreadyUnlockedResponse(seedFrame)) return;
        if (!isSeedResponse(seedFrame)) throw new DmeLinkError('Unexpected login seed response from DME');

        const key = calculateLoginKey(accessLevel, frameToBytes(seedFrame));
        const keyFrame = await this.exchange(Ds2Control.SEND_LOGIN_KEY, buildKeyPayload(key));
        if (!isPositiveResponse(keyFrame)) throw new DmeLinkError('DME rejected the login key');
    }

    /**
     * Reads VIN (from the AIF user-info block), software/program number (from ZIF), via the
     * DME's system address table (control 0x0D) — confirmed byte-for-byte against the reference
     * Mss54Ds2Tool source (see identity.ts). Falls back to 'UNKNOWN' per-field if a pointer is
     * unavailable or a read fails, rather than aborting the whole connection.
     *
     * The flash counter is read here too, but it needs no pointer: it sits at fixed addresses in
     * the service block (see flashCounter.ts), so it is outside the system-address-table try below.
     */
    private async identify(): Promise<DmeIdentity> {
        const result: DmeIdentity = {
            vin: 'UNKNOWN', aif: 'UNKNOWN', softwareVersion: 'UNKNOWN',
            flashCounter: null, encodingChecksum: null,
        };
        try {
            const tableFrame = await this.exchange(Ds2Control.READ_SYSTEM_ADDRESSES, new Uint8Array(0));
            if (!isPositiveResponse(tableFrame)) return result;
            const entries = parseSystemAddressTable(tableFrame.payload);
            // Kept for the service-block report. These pointers are the DME's own statement of where
            // it puts each record, which is the only authority on whether the AIF lives in master or
            // slave space — a question this code had been answering by assumption.
            this.pointers = {
                dif: findPointer(entries, SYSTEM_ADDRESS_INDEX.DIF),
                zifBackup: findPointer(entries, SYSTEM_ADDRESS_INDEX.ZIF_BACKUP),
                brif: findPointer(entries, SYSTEM_ADDRESS_INDEX.BRIF),
                zif: findPointer(entries, SYSTEM_ADDRESS_INDEX.ZIF),
                aif: findPointer(entries, SYSTEM_ADDRESS_INDEX.AIF),
            };

            const zifAddress = findPointer(entries, SYSTEM_ADDRESS_INDEX.ZIF);
            if (zifAddress !== null) {
                try {
                    const zifBytes = await this.readMemoryChunk(Mss54HpDataTuneLayout.readSegment, zifAddress, ZIF_LENGTH);
                    const programNumber = parseZifProgramNumber(zifBytes);
                    if (programNumber) result.softwareVersion = programNumber;
                    // Which DME family this is, from bytes already in hand.
                    //
                    // `detectVariantFromZif` was written and then never called, which for a tool
                    // that writes MSS54**HP** calibration data is the wrong function to leave
                    // unwired. It costs nothing here — the ZIF has just been read for the software
                    // number — and it goes into the event log, so a run whose bytes turn out not to
                    // fit can be explained from the diagnostic record rather than guessed at.
                    // Deliberately NOT a refusal: this is one 8-byte code against a table of three,
                    // and blocking a connect on it would strand any DME the table does not name.
                    const variant = detectVariantFromZif(zifBytes);
                    this.events.push(`IDENT ZIF variant: ${variant}`);
                } catch { /* leave UNKNOWN */ }
            }

            // Index 21 is a POINTER to the value, not the value — same shape as every other entry in
            // this table. So: resolve the pointer, then read one byte from it. Own try: this is a
            // diagnostic, and it must never be the reason identify degrades VIN/AIF to UNKNOWN.
            const maxTelegramAddress = findPointer(entries, SYSTEM_ADDRESS_INDEX.MAX_TELEGRAM);
            if (maxTelegramAddress !== null) {
                try {
                    const raw = await this.readMemoryChunk(Mss54HpDataTuneLayout.readSegment, maxTelegramAddress, 1);
                    // 0 and 0xFF are "not populated", not "a zero-byte telegram limit".
                    if (raw.length === 1 && raw[0] !== 0 && raw[0] !== 0xFF) this.maxTelegramLength = raw[0];
                } catch { /* leave null — "not read" is a different fact from "no limit published" */ }
            }

            const aifAddress = findPointer(entries, SYSTEM_ADDRESS_INDEX.AIF);
            if (aifAddress !== null) {
                try {
                    const aifBytes = await this.readRange(aifAddress, AIF_TOTAL_LENGTH);
                    const entry = latestPopulatedAifEntry(parseAifEntries(aifBytes));
                    if (entry) {
                        result.vin = entry.vin || 'UNKNOWN';
                        result.aif = entry.softwareNumber || 'UNKNOWN';
                    }
                } catch { /* leave UNKNOWN */ }
            }
        } catch { /* connection succeeded but identify failed entirely — return UNKNOWN fields */ }

        // Separate try, and separate from the pointer table above: this is a fixed-address read, so
        // it can succeed on a DME whose system address table came back unusable — and it must never
        // be the reason a connection reports failure. Left null when it can't be read.
        try {
            result.flashCounter = await this.readFlashCounterInner();
        } catch { /* leave null — "not read" is a different fact from "0 used" */ }

        // The BEFORE half of the before/after pair a QuickVerify rests on. Four bytes out, five back.
        // Own try for the same reason as everything else here: a DME that does not answer 0x0A is a
        // DME that cannot offer QuickVerify, not a DME that failed to connect.
        try {
            result.encodingChecksum = await this.queryEncodingChecksumInner();
        } catch { /* leave null — the write path reads this to decide whether QUICK is offerable */ }

        return result;
    }

    /**
     * Asks the DME whether its own stored CRCs still match its own flash (control 0x0A).
     *
     * Read-only: a four-byte request with no payload. Safe at connect, safe between operations, and
     * safe to repeat — which is the whole point, because a single reading proves much less than a
     * pair taken either side of a write.
     */
    async queryEncodingChecksum(): Promise<Ds2EncodingChecksum> {
        return this.withGate(async () => {
            this.assertConnected();
            return this.queryEncodingChecksumInner();
        });
    }

    /** The gate-free body. `identify()` and the write path both run inside the gate already, and a
     *  public method calling another public method here would deadlock on it. */
    private async queryEncodingChecksumInner(): Promise<Ds2EncodingChecksum> {
        const frame = await this.exchange(Ds2Control.QUERY_ENCODING_CHECKSUM, new Uint8Array(0));
        return parseEncodingChecksum(frame);
    }

    /** Reads both 256-byte counter regions and decodes them. Six chunk reads, ~1.5 s at 9600. */
    private async readFlashCounterInner(): Promise<FlashCounterInfo> {
        const { master, slave, counterOffset, counterLength } = ServiceBlockLayout;
        const masterBytes = await this.readRange(master.address + counterOffset, counterLength);
        const slaveBytes = await this.readRange(slave.address + counterOffset, counterLength);
        return {
            master: analyzeFlashCounter(master.name, master.address + counterOffset, masterBytes),
            slave: analyzeFlashCounter(slave.name, slave.address + counterOffset, slaveBytes),
            readAt: Date.now(),
        };
    }

    /** Pointers captured during identify; all null until a connect has run. */
    private pointers: ServiceBlockPointers = { dif: null, zifBackup: null, brif: null, zif: null, aif: null };

    /**
     * Reads both service blocks. Read-only: two readRange calls and nothing else, so it is safe to
     * run on a DME whose state is unknown — which is exactly when it is worth running.
     */
    async readServiceBlocks(onProgress?: TransferProgress): Promise<ServiceBlockDump> {
        return this.withGate(async () => {
            this.assertConnected();
            await this.resyncTransport();
            const { master, slave } = ServiceBlockLayout;
            const total = master.length + slave.length;
            const masterImage = await this.readRange(master.address, master.length,
                (done) => onProgress?.(Math.round((done / total) * 100), 'reading'));
            const slaveImage = await this.readRange(slave.address, slave.length,
                (done) => onProgress?.(Math.round(((master.length + done) / total) * 100), 'reading'));
            onProgress?.(100, 'reading');
            return { master: masterImage, slave: slaveImage, pointers: this.pointers };
        });
    }

    async readFlashCounter(): Promise<FlashCounterInfo> {
        return this.withGate(async () => {
            this.assertConnected();
            await this.resyncTransport();
            return this.readFlashCounterInner();
        });
    }

    private async readMemoryChunk(segment: number, address: number, count: number): Promise<Uint8Array> {
        const frame = await this.exchange(Ds2Control.READ_MEMORY, buildReadMemoryPayload(segment, address, count));
        if (!isPositiveResponse(frame)) throw new DmeLinkError(`Memory read at 0x${address.toString(16)} rejected by DME`);
        if (frame.payload.length !== count) {
            throw new DmeLinkError(`Memory read at 0x${address.toString(16)} returned ${frame.payload.length} bytes, expected ${count}`);
        }
        return frame.payload;
    }

    /** Retries a chunk read up to CHUNK_RETRY_ATTEMPTS times, purging the transport between attempts
     *  to resynchronize, mirroring the reference Ds2MemoryReader.ReadChunkWithRetryAsync. */
    private async readMemoryChunkWithRetry(segment: number, address: number, count: number): Promise<Uint8Array> {
        let lastError: unknown;
        for (let attempt = 1; attempt <= CHUNK_RETRY_ATTEMPTS; attempt++) {
            if (this.aborted) throw new DmeLinkError('Read cancelled');
            try {
                return await this.readMemoryChunk(segment, address, count);
            } catch (e) {
                lastError = e;
                this.timing.retry();
                if (attempt < CHUNK_RETRY_ATTEMPTS) {
                    // Delay first, THEN resync. Resyncing first lets the DME's late response arrive
                    // into the freshly-cleared buffer and desync the next attempt. purge() alone also
                    // cannot clear a latched break, which is why all five attempts used to burn in
                    // zero time once the line had glitched.
                    //
                    // Escalating, and longer after a break — the same rule adaptationExchangeWithRetry
                    // already follows, and for the same reason: re-acquiring the reader does not repair
                    // a disturbed line, only silence does. This path was the one that never learned it.
                    // A flat 300ms gave a failing chunk 1.2 s of total settling where the reference
                    // Ds2MemoryReader gives 4 s (1 s x 4); after a break this now matches that exactly
                    // (400/800/1200/1600), and 3 s otherwise.
                    const base = this.transport.hasReadError() ? BREAK_SETTLE_MS : CHUNK_RETRY_DELAY_MS;
                    await delay(base * attempt);
                    await this.resyncTransport();
                }
            }
        }
        throw lastError instanceof Error ? lastError : new DmeLinkError(String(lastError));
    }

    /**
     * Sends one write telegram, retrying the TELEGRAM — and only the telegram — on a transport-level
     * failure. Mirrors the reference `Ds2MemoryProgrammer.WriteChunkWithRetryAsync`.
     *
     * This path had no retry at all until now, while the read path next to it has had five attempts
     * since it was written. That asymmetry is exactly backwards: `writePartialBinInner` erases before
     * it writes, so a single lost telegram — one break, one timeout — failed the entire flash **on an
     * already-erased ECU**, with nothing to catch it. `readMemoryChunkWithRetry` was ported from
     * `Ds2MemoryReader` and its neighbour in `Ds2MemoryProgrammer` was not.
     *
     * **Validation deliberately lives in the caller, outside this loop** — the same split the reference
     * uses (`ValidateWriteResponse` runs on what `WriteChunkWithRetryAsync` returns). A timeout means
     * the telegram never landed and re-sending it is right. A verify byte of "verify failed" or "cells
     * not erased" means the DME received it, tried, and could not do it; re-sending that would paper
     * over failing flash on a twenty-year-old ECU and report success. The reference catches only
     * `TimeoutException` for the same reason.
     *
     * Re-sending is safe: a DS2 write is one telegram, so the DME either processed it or did not, and
     * re-writing the same bytes to the same address is idempotent. The `nextAddress` check in the
     * caller catches any desync afterwards.
     *
     * No `aborted` check, matching the write loop's own deliberate choice: honouring a cancel between
     * chunks would abandon a half-programmed ECU.
     */
    private async writeChunkTelegramWithRetry(address: number, data: Uint8Array, timeoutMs: number): Promise<Ds2Frame> {
        let lastError: unknown;
        for (let attempt = 1; attempt <= WRITE_CHUNK_RETRY_ATTEMPTS; attempt++) {
            try {
                return await this.exchange(
                    Ds2Control.WRITE_MEMORY,
                    buildWriteMemoryPayload(Ds2ProgrammingControl.WriteSegment, address, data),
                    timeoutMs,
                );
            } catch (e) {
                lastError = e;
                if (attempt < WRITE_CHUNK_RETRY_ATTEMPTS) {
                    // Same escalation as the read path, and longer after a break, for the same reason:
                    // re-acquiring the reader does not repair a disturbed line, only silence does.
                    // resyncTransport only touches the READ side — it clears a latched pump error or
                    // drops a stale tail — so it sends nothing to the DME and cannot disturb the
                    // programming session it is running inside.
                    const base = this.transport.hasReadError() ? BREAK_SETTLE_MS : CHUNK_RETRY_DELAY_MS;
                    await delay(base * attempt);
                    await this.resyncTransport();
                }
            }
        }
        throw lastError instanceof Error ? lastError : new DmeLinkError(String(lastError));
    }

    /**
     * Writes one data chunk and fully validates the DME's programming response — segment, next
     * address, written count, and the verify byte (which must be 1 = "programming OK"). This is the
     * critical safety check: a positive DS2 status alone does NOT mean the cells were programmed;
     * the verify byte reports "verify failed" / "cells not erased" / etc. (Ds2WriteResponseValidator).
     *
     * Everything below this line runs on a telegram that round-tripped, and is NEVER retried.
     */
    private async writeMemoryChunk(address: number, data: Uint8Array, timeoutMs = WRITE_RESPONSE_TIMEOUT_MS): Promise<void> {
        const frame = await this.writeChunkTelegramWithRetry(address, data, timeoutMs);
        if (!isPositiveResponse(frame)) throw new DmeLinkError(`Memory write at 0x${address.toString(16)} rejected by DME`);
        const result = parseWriteResult(frame);
        if (!result) throw new DmeLinkError(`Memory write at 0x${address.toString(16)} returned no verify data`);
        if (result.segment !== Ds2ProgrammingControl.WriteSegment) {
            throw new DmeLinkError(`Memory write at 0x${address.toString(16)} returned segment 0x${result.segment.toString(16)}, expected 0x02`);
        }
        if (result.nextAddress24 !== address + data.length) {
            throw new DmeLinkError(`Memory write at 0x${address.toString(16)} returned next address 0x${result.nextAddress24.toString(16)}, expected 0x${(address + data.length).toString(16)}`);
        }
        if (result.writtenCount !== data.length) {
            throw new DmeLinkError(`Memory write at 0x${address.toString(16)} wrote ${result.writtenCount} bytes, expected ${data.length} — ${describeVerifyByte(result.verifyByte)}`);
        }
        if (result.verifyByte !== 1) {
            throw new DmeLinkError(`Memory write at 0x${address.toString(16)} failed: ${describeVerifyByte(result.verifyByte)}`);
        }
    }

    /**
     * Sends a programming control command (prepare/erase/finalize) — a WriteMemory with an empty
     * body at a control segment/address. Validates the verify byte when required (1 = OK,
     * 8 = "data programming session active" is also accepted for control commands). An empty
     * response payload is a legitimate positive acknowledgement.
     */
    private async sendProgrammingControl(segment: number, address: number, timeoutMs: number, requireProgrammingOk: boolean): Promise<void> {
        const frame = await this.exchange(
            Ds2Control.WRITE_MEMORY,
            buildWriteMemoryPayload(segment, address, new Uint8Array(0)),
            timeoutMs,
        );
        if (!isPositiveResponse(frame)) throw new DmeLinkError(`Programming control (segment 0x${segment.toString(16)}) rejected by DME`);
        const result = parseWriteResult(frame);
        if (result) {
            if (result.segment !== segment) {
                throw new DmeLinkError(`Programming control returned segment 0x${result.segment.toString(16)}, expected 0x${segment.toString(16)}`);
            }
            if (requireProgrammingOk && result.verifyByte !== 1 && result.verifyByte !== 8) {
                throw new DmeLinkError(`Programming control (segment 0x${segment.toString(16)}) failed: ${describeVerifyByte(result.verifyByte)}`);
            }
        }
    }


    /**
     * Puts the DME into a programming session by erasing and restoring the Free Identifiers sector,
     * then raises the link to 125000 for the bulk read.
     *
     * This is the most consequential thing in the app after a flash write, and the ordering is the
     * safety argument. Read it as three phases:
     *
     *   1. **Reversible.** Build the plan, live-read every span, check the prep marker. Anything
     *      that fails here is recorded and the read continues at 9600 — no telegram sent so far has
     *      changed a byte.
     *   2. **Destructive.** recycle-only, erase master, erase slave, restore every span, verify
     *      every span byte for byte. `eraseStarted` marks the door; past it a failure goes to the
     *      recovery path rather than to a shrug.
     *   3. **Free.** recycle-off, finalize, then 0x91. By the time the baud switch is attempted the
     *      sector is back and PROVEN back, so a refused or silent switch costs the read and nothing
     *      else. That is the opposite of the write path, where the switch happens with the data area
     *      erased — and it is why this is the safer of the two boosts despite erasing more.
     *
     * Returns whether the link is now at 125000. Before the erase it never throws: the caller's job
     * is to read, and reading slowly is a better answer than not reading.
     */
    private async enterFastReadMode(): Promise<boolean> {
        const { prepMarkerOffset } = ServiceBlockLayout;
        const plan = buildPreservationPlan(this.fastEntrySeed, this.pointers);
        if (!plan.safe) {
            this.events.push(`FAST READ skipped: ${plan.reason}`);
            return false;
        }
        this.events.push(`FAST READ plan: ${plan.spans.length} span(s), ${planBytes(plan.spans)} byte(s)`);

        // --- Phase 1: reversible ---------------------------------------------------------------
        // Live, every time. The seed supplies addresses and never bytes, so a stale map can only
        // make us preserve too much — never write yesterday's identity over today's.
        const live: Array<{ span: Span; data: Uint8Array }> = [];
        try {
            for (const span of plan.spans) {
                live.push({ span, data: await this.readRange(toDs2Address(span.processor, span.start), span.length) });
            }
        } catch (e) {
            this.events.push(`FAST READ skipped: could not read the spans to preserve (${(e as Error).message})`);
            return false;
        }

        let eraseStarted = false;
        let recycleOffSent = false;
        let finalizeSent = false;
        const restored = new Set<number>();
        try {
            // The marker the DME wants before it will let this sector be erased. Read first: on a
            // DME that has had fast entry run before it is already there, and programming an
            // already-programmed cell is exactly what the verify byte rejects.
            for (const processor of ['master', 'slave'] as const) {
                const address = ServiceBlockLayout[processor].address + prepMarkerOffset;
                const present = await this.readMemoryChunkWithRetry(
                    Mss54HpDataTuneLayout.readSegment, address, FAST_ENTRY_PREP_MARKER.length);
                if (isAllErased(present)) {
                    await this.writeMemoryChunk(address, FAST_ENTRY_PREP_MARKER, PREP_MARKER_TIMEOUT_MS);
                    this.events.push(`FAST READ ${processor} prep marker written`);
                } else {
                    this.events.push(`FAST READ ${processor} prep marker already present`);
                }
            }

            // --- Phase 2: destructive ----------------------------------------------------------
            await this.sendProgrammingControl(
                Ds2ProgrammingControl.RecyclingSegment, Ds2ProgrammingControl.RecycleOnlyAddress,
                WRITE_RESPONSE_TIMEOUT_MS, false);

            eraseStarted = true;
            // BOTH processors, unlike programServiceBlocks which sends one erase at the master
            // address. That path verifies byte-for-byte afterwards and passes on a real car, but
            // that is not evidence the slave was erased: NOR flash accepts a write of the same
            // value it already holds, and the slave sector is 99.3 % 0xFF with the rest unchanged,
            // so both the write and the verify would pass either way. The reference sends two, so
            // this does too — and whether one is enough for the counter reset is left as its own
            // question rather than inferred from a test that could not have failed.
            for (const processor of ['master', 'slave'] as const) {
                await this.sendProgrammingControl(
                    Ds2ProgrammingControl.EraseSegment, ServiceBlockLayout[processor].address,
                    ERASE_TIMEOUT_MS, true);
            }
            this.events.push('FAST READ erased both Free Identifiers sectors');

            for (let i = 0; i < live.length; i++) {
                const { span, data } = live[i];
                await this.writeBlock(toDs2Address(span.processor, span.start), data, 0, 1);
                restored.add(i);
            }

            // Byte for byte, span by span, and BEFORE the session is closed. A mismatch here is the
            // one failure worth stopping everything for: identity records cannot be rebuilt.
            for (const { span, data } of live) {
                const back = await this.readRange(toDs2Address(span.processor, span.start), span.length);
                if (!arraysEqual(back, data)) {
                    throw new DmeLinkError(
                        `Fast-entry restore verify failed for ${span.processor} `
                        + `0x${span.start.toString(16)}+${span.length}`);
                }
            }
            this.events.push('FAST READ restore verified');

            // --- Phase 3: free -----------------------------------------------------------------
            await this.sendProgrammingControl(
                Ds2ProgrammingControl.RecyclingSegment, Ds2ProgrammingControl.RecycleOffAddress,
                WRITE_RESPONSE_TIMEOUT_MS, false);
            recycleOffSent = true;
            await this.sendProgrammingControl(
                Ds2ProgrammingControl.FinishSegment, 0,
                WRITE_RESPONSE_TIMEOUT_MS, true);
            finalizeSent = true;
        } catch (e) {
            if (!eraseStarted) {
                this.events.push(`FAST READ skipped before erase: ${(e as Error).message}`);
                return false;
            }
            await this.recoverFastEntry(live, restored, recycleOffSent, finalizeSent, e);
            // Rethrown. Past the erase this is no longer "read slowly instead" — the sector has
            // been touched, and the operator has to know that before anything else happens.
            throw new DmeLinkError(
                `Fast-entry preparation failed after the erase started: ${(e as Error).message}. `
                + `The Free Identifiers sector was erased and an attempt was made to put it back. `
                + `Do not write to this DME until the service info has been inspected.`,
                e);
        }

        // The switch, last. Everything above is committed and verified, so a refusal costs the
        // speed and nothing else.
        //
        // Wrapped, and it was not. `trySwitchBaud` throws when the DME has ACCEPTED the switch and
        // the local port then fails to reopen — the one state in this function with no way back:
        // the DME is at 125000, the host at 9600, and the throw escaped past every recovery path
        // here to a caller whose only option is to tell the user to disconnect. The DME is already
        // in a programming session at that point, so "disconnect and reconnect" is not a cheap
        // instruction. Falling back is what the silent-link branch below already does; a failed
        // reopen deserves the same treatment and for a stronger reason.
        let boosted = false;
        let switchFailure: unknown;
        try {
            boosted = await this.trySwitchBaud(ds2BaudSpecFor(125000));
        } catch (e) {
            switchFailure = e;
        }
        if (switchFailure || (boosted && !(await this.linkRespondsAfterSwitch()))) {
            const wasAccepted = this.lastSwitchOutcome ?? 'accepted';
            try { await this.trySwitchBaud(Ds2BaudRate.Baud9600); } catch { }
            try { await this.transport.reopen(Ds2BaudRate.Baud9600.baudRate); this.currentBaud = 9600; } catch { }
            // Guarded like the two above it: this whole block is the recovery, and a throw from
            // inside a recovery leaves the caller with the transport's complaint instead of the
            // fact that matters — that the read is going to happen at 9600.
            try { await this.resyncTransport(); } catch { }
            this.lastSwitchOutcome = switchFailure
                ? `${wasAccepted}, then the local port would not reopen — fell back to 9600`
                : `${wasAccepted}, then the link went silent — fell back to 9600`;
            this.events.push(`FAST READ switch ${switchFailure ? 'could not reopen the port' : 'accepted then silent'}; back at 9600`);
            return false;
        }
        this.everBoosted ||= boosted;
        this.events.push(`FAST READ ${boosted ? 'complete: session now at 125000' : 'switch refused; reading at 9600'}`);
        return boosted;
    }

    /**
     * Best effort to put the sector back after a failure past the erase.
     *
     * Every step has its own try/catch, because this runs when something has already gone wrong and
     * the worst outcome would be an exception here masking the original one. The caller rethrows
     * that original whatever happens here.
     */
    private async recoverFastEntry(
        live: Array<{ span: Span; data: Uint8Array }>,
        restored: Set<number>,
        recycleOffSent: boolean,
        finalizeSent: boolean,
        cause: unknown,
    ): Promise<void> {
        this.events.push(`FAST READ recovery started after: ${(cause as Error).message}`);
        for (let i = 0; i < live.length; i++) {
            const { span, data } = live[i];
            try {
                if (restored.has(i)) {
                    const back = await this.readRange(toDs2Address(span.processor, span.start), span.length);
                    if (arraysEqual(back, data)) continue;
                }
                await this.writeBlock(toDs2Address(span.processor, span.start), data, 0, 1);
            } catch (e) {
                this.events.push(
                    `FAST READ recovery could not restore ${span.processor} `
                    + `0x${span.start.toString(16)}: ${(e as Error).message}`);
            }
        }
        if (!recycleOffSent) {
            try {
                await this.sendProgrammingControl(
                    Ds2ProgrammingControl.RecyclingSegment, Ds2ProgrammingControl.RecycleOffAddress,
                    WRITE_RESPONSE_TIMEOUT_MS, false);
            } catch { /* the caller is about to throw with the original cause */ }
        }
        if (!finalizeSent) {
            try {
                await this.sendProgrammingControl(
                    Ds2ProgrammingControl.FinishSegment, 0,
                    WRITE_RESPONSE_TIMEOUT_MS, true);
            } catch { /* same */ }
        }
        this.events.push('FAST READ recovery finished');
    }

    /**
     * DS2 reboot — service 0x12.
     *
     * Entering 125000 leaves the DME in a state where live values, adaptations and error memory are
     * all unavailable; the reference simply forbids them until the user reconnects. This app reboots
     * instead, because its whole workflow is READ then LOG then WRITE in one session, and
     * "reconnect now" in the middle of that is a step performed standing next to a car.
     *
     * Best effort by construction. The read has already succeeded by the time this runs, so a
     * failure here must not turn a good read into a failed operation — it returns false and the
     * caller tells the user to reconnect.
     */
    async rebootDme(): Promise<boolean> {
        try {
            await this.exchange(Ds2Control.REBOOT, new Uint8Array(0), WRITE_RESPONSE_TIMEOUT_MS);
            this.events.push('DS2 reboot sent');
            return true;
        } catch (e) {
            this.events.push(`DS2 reboot failed: ${(e as Error).message}`);
            return false;
        }
    }

    private async readRange(address: number, length: number, onProgress?: (readSoFar: number, total: number) => void): Promise<Uint8Array> {
        const out = new Uint8Array(length);
        let done = 0;
        while (done < length) {
            if (this.aborted) throw new DmeLinkError('Read cancelled');
            const count = Math.min(this.readChunkSize, length - done);
            const chunk = await this.readMemoryChunkWithRetry(Mss54HpDataTuneLayout.readSegment, address + done, count);
            out.set(chunk, done);
            done += count;
            onProgress?.(done, length);
        }
        return out;
    }

    async readPartialBin(onProgress?: TransferProgress): Promise<ArrayBuffer> {
        return this.withGate(() => this.readPartialBinInner(onProgress));
    }

    private async readPartialBinInner(onProgress?: TransferProgress): Promise<ArrayBuffer> {
        this.assertConnected();
        // Before anything can fail. From here on, "no report" means this read produced none — it can
        // never mean "here is the previous read's".
        this.timing.clearReport();
        this.events = new LinkEventLog();
        this.events.push(`READ start: requested baud ${this.readBaud}, chunk ${this.readChunkSize}`);
        // Refresh the seed/key unlock before reading program/data memory, mirroring the reference
        // EnsureUnlockedForProgramMemoryReadAsync. The diagnostic session can lapse between connect
        // and the user clicking READ; re-login is a no-op if still unlocked.
        // resync, not purge: a break latched by an earlier operation would otherwise kill the login
        // that follows, and READ would die before transferring a single chunk.
        await this.resyncTransport();
        await this.login();

        // Optional baud boost for the bulk transfer. Skipped entirely at 9600 (no switch, no port
        // reopen — the proven path), because a boost the hardware doesn't actually follow desyncs the
        // link for the rest of the session.
        this.lastSwitchOutcome = null;
        // FAST READ first, because it is a different mechanism from the plain 0x91 below rather
        // than a faster version of it. The plain switch asks a DME in normal mode to change rate,
        // which is exactly what 38400 proved this ECU will accept and then not honour. This one
        // erases and restores the Free Identifiers sector to put the DME into a programming session,
        // where 125000 is a rate it actually implements. Armed by the caller; skipped silently when
        // there is no seed backup for this DME or the plan cannot be built.
        let boosted = false;
        let fastReadBaud = 0;
        if (this.fastReadArmed) {
            boosted = await this.enterFastReadMode();
            // Recorded separately because the line further down derives lastReadBaud from
            // `this.readBaud`, which is the rate the SELECTOR asked for and is 9600 on this path —
            // fast entry reaches 125000 without anyone having selected it. Reporting 9600 for a read
            // that ran at 125000 would put the wrong number in the diagnostic that exists to prove
            // this feature works.
            if (boosted) fastReadBaud = 125000;
        }
        boosted = boosted || (this.readBaud !== 9600
            ? await this.trySwitchBaud(ds2BaudSpecFor(this.readBaud))
            : false);
        // A positive ACK to 0x91 is the DME agreeing to switch. It is NOT evidence that both ends
        // ended up at the same rate, and until now nothing checked: a switch that did not really hold
        // was discovered 2% into a 538-chunk read, as a failure, having thrown away the whole read.
        //
        // One keep-alive costs ~150 ms and settles it. If the link is silent here, the most likely
        // reason is that we are at the new rate and the DME is not — in which case dropping the local
        // port back to 9600 recovers completely, and the user gets a finished read instead of nothing.
        if (boosted && !(await this.linkRespondsAfterSwitch())) {
            const wasAccepted = this.lastSwitchOutcome ?? 'accepted';
            // Ask the DME to come back too, then force the local side regardless. Same order and same
            // best-effort reasoning as the restore in the finally below.
            try { await this.trySwitchBaud(Ds2BaudRate.Baud9600); } catch { }
            try { await this.transport.reopen(Ds2BaudRate.Baud9600.baudRate); this.currentBaud = 9600; } catch { }
            await this.resyncTransport();
            boosted = false;
            // AFTER the restore: trySwitchBaud writes lastSwitchOutcome itself, so setting this first
            // would have it overwritten by the outcome of the fallback rather than the real one.
            this.lastSwitchOutcome = `${wasAccepted}, then the link went silent — fell back to 9600`;
        }
        // Recorded so the UI can state what happened. A refused switch is not an error and must not
        // become one, but it must not be invisible either.
        this.lastReadBaud = fastReadBaud || (boosted ? this.readBaud : 9600);
        this.everBoosted ||= boosted;
        this.events.push(`BAUD ran at ${this.lastReadBaud}${this.lastSwitchOutcome ? ` (switch: ${this.lastSwitchOutcome})` : ' (no switch attempted)'}`);
        // Held so the finally can tell finish() whether the read completed. A read that dies part-way
        // is the case the instrument matters most for — that is the whole 38400 question.
        let readError: unknown;
        try {
            const { slave, master } = Mss54HpDataTuneLayout;
            const readChunkSize = this.readChunkSize;
            const total = slave.length + master.length;

            // Arm the instrument for exactly this read. Sized up-front so nothing allocates per chunk.
            this.timing.begin(Math.ceil(total / readChunkSize), {
                kind: 'read',
                chunkSize: readChunkSize,
                // [addr][len][status][N data][cksum].
                responseBytes: readChunkSize + 4,
                // [addr][len][0x06][seg][addr x3][count][cksum] — the read asks with 9 bytes, which
                // is why `write` and `echoLatency` behave on this path and not on the write path.
                requestBytes: 9,
                requestedBaud: this.readBaud,
                switchOutcome: this.lastSwitchOutcome,
                baud: this.lastReadBaud,
                maxTelegramLength: this.maxTelegramLength,
            });

            const slaveBytes = await this.readRange(slave.address, slave.length, (done) => onProgress?.(Math.round((done / total) * 100), 'reading'));
            const masterBytes = await this.readRange(master.address, master.length, (done) => onProgress?.(Math.round(((slave.length + done) / total) * 100), 'reading'));

            const combined = new Uint8Array(total);
            combined.set(slaveBytes, 0);
            combined.set(masterBytes, slave.length);
            onProgress?.(100, 'reading');
            return combined.buffer;
        } catch (e) {
            readError = e;
            throw e;
        } finally {
            // In the finally so a cancelled or failed read still yields whatever was measured — a read
            // that died at 8% is precisely when the numbers are worth having.
            const report = this.timing.finish(readError);
            this.events.push(readError
                ? `READ failed after ${report?.chunks ?? 0} chunk(s): ${readError instanceof Error ? readError.message : String(readError)}`
                : `READ complete: ${report?.chunks ?? 0} chunks in ${Math.round(report?.elapsedMs ?? 0)} ms`);
            if (boosted) {
                // Always try to hand the session back at 9600. If the DME never really switched, this
                // request fails too — force the local port back to 9600 anyway so a plain reconnect (or
                // an ignition off/on, which resets the DME) recovers instead of silently timing out.
                try {
                    await this.trySwitchBaud(Ds2BaudRate.Baud9600);
                } catch {
                    try { await this.transport.reopen(Ds2BaudRate.Baud9600.baudRate); this.currentBaud = 9600; } catch { }
                }
            }
        }
    }

    /**
     * Writes one data block (slave or master). Chunks are `writeChunkSize` (122) — even-length and
     * starting at an even address, which satisfies the DME's even-aligned flash-write requirement and
     * is enforced at module load in ds2.ts. Note this is deliberately NOT the read chunk size: the
     * read side may grow toward the 251-byte DS2 framing limit, the write side is capped at 123 and
     * so is already at its maximum. Fully-erased (all-0xFF) chunks are skipped: after the erase step
     * those cells already read 0xFF, so re-writing them is an unnecessary program cycle (matches the
     * reference erase-aware sparse write). Progress reflects position through the block.
     */
    private async writeBlock(address: number, data: Uint8Array, doneBefore: number, grandTotal: number, onProgress?: (writtenSoFar: number, total: number) => void, timeoutMs = WRITE_RESPONSE_TIMEOUT_MS): Promise<void> {
        let offset = 0;
        while (offset < data.length) {
            const chunkSize = Math.min(Mss54HpDataTuneLayout.writeChunkSize, data.length - offset);
            const chunk = data.subarray(offset, offset + chunkSize);
            if (!isAllErased(chunk)) {
                await this.writeMemoryChunk(address + offset, chunk, timeoutMs);
            }
            offset += chunkSize;
            onProgress?.(doneBefore + offset, grandTotal);
        }
    }

    async writePartialBin(buffer: ArrayBuffer, options: WriteOptions, onProgress?: TransferProgress): Promise<WriteVerification> {
        return this.withGate(() => this.writePartialBinInner(buffer, options, onProgress));
    }

    private async writePartialBinInner(buffer: ArrayBuffer, options: WriteOptions, onProgress?: TransferProgress): Promise<WriteVerification> {
        this.assertConnected();
        // Clear a stale cancel, exactly as readPartialBin does. Without this, a user who pressed
        // Cancel Read earlier in the session left `aborted` latched true: the flash would then erase,
        // write and finalize completely — and the read-back verify would throw "Read cancelled" on the
        // very first chunk. A fully successful flash reported as a failure, whose natural response is
        // to press WRITE again, burning another erase+program cycle on a 20-year-old ECU every time.
        // Note that no abort check is added inside the write loop, because "between chunks" is
        // mid-programming-session and honouring a cancel there would abandon a half-programmed ECU.
        // Clearing the latch is `withGate`'s job — see there.
        //
        // Before anything that can fail, so "no report" can only ever mean "this write produced
        // none". Same rule as READ, and the reason for it was paid for once already: a report kept
        // from the previous attempt is a file that describes a run that did not happen.
        this.timing.clearReport();
        this.events = new LinkEventLog();
        const log = this.events;
        const { slave, master } = Mss54HpDataTuneLayout;
        const total = slave.length + master.length;
        if (buffer.byteLength !== total) {
            throw new DmeLinkError(`Refusing to write a ${buffer.byteLength}-byte buffer (expected ${total})`);
        }
        const bytes = new Uint8Array(buffer);
        const slaveData = bytes.subarray(0, slave.length);
        const masterData = bytes.subarray(slave.length, total);

        // Every precondition is checked before the DME is touched at all — next to the buffer-length
        // check, not further down. Refusing after a login is harmless but pointless, and "validate,
        // then act" is the only ordering that stays obviously correct as this function grows.
        assertWriteChunkingLegal([slave, master]);

        log.push(`WRITE start: ${total} bytes, verify=${options.verifyMode}, baud=${this.currentBaud}, chunk=${Mss54HpDataTuneLayout.writeChunkSize}`);

        // Refresh the seed/key unlock before the protected write (matches ForceRefreshUnlock in the
        // reference). The DME rejects erase/write with 0xA2 if the session lapsed or RPM/speed != 0.
        // resync, not purge — same reason as READ. This is strictly BEFORE the erase below, so it
        // cannot affect flashing itself; it only stops a stale break from failing the pre-flight.
        await this.resyncTransport();
        await this.login();
        log.push('LOGIN refreshed');

        // Erase the data area. The normal flow erases directly (no "pre-clean" prepare — that would
        // consume an extra flash-counter slot). Only on erase failure do we send the prepare (0x0F)
        // and retry the erase once, mirroring EraseDataProgrammingWithFallbackAsync.
        onProgress?.(0, 'erasing');
        const tErase = performance.now();
        try {
            await this.sendProgrammingControl(Ds2ProgrammingControl.EraseSegment, Ds2ProgrammingControl.DataProgrammingSessionAddress, ERASE_TIMEOUT_MS, true);
        } catch (eraseError) {
            log.push(`ERASE failed, sending pre-clean and retrying once: ${eraseError instanceof Error ? eraseError.message : String(eraseError)}`);
            await this.sendProgrammingControl(Ds2ProgrammingControl.FinishSegment, Ds2ProgrammingControl.DataProgrammingSessionAddress, WRITE_RESPONSE_TIMEOUT_MS, false); // pre-clean
            try {
                await this.sendProgrammingControl(Ds2ProgrammingControl.EraseSegment, Ds2ProgrammingControl.DataProgrammingSessionAddress, ERASE_TIMEOUT_MS, true);
            } catch (retryError) {
                // Chain the original. Without this the first erase's reason — which is usually the
                // informative one, since the retry tends to fail the same way for a reason already
                // stated — was discarded, and `eraseError` sat bound and unused as the evidence.
                throw new DmeLinkError(
                    `Erase failed twice. First: ${eraseError instanceof Error ? eraseError.message : String(eraseError)}. `
                    + `After pre-clean: ${retryError instanceof Error ? retryError.message : String(retryError)}`,
                    eraseError,
                );
            }
        }
        log.pushTimed('ERASE data area', tErase);

        // ---- The baud boost. Everything about its placement is forced, so read the order. --------
        //
        // The DME accepts 125000 only while in a programming session, and karter16's journal is
        // explicit that its bootloader offers no way into one "except through valid flash wipe
        // commands". The erase above IS that command, so this is the first instant the switch can
        // be sent — and the ECU's data area is already gone, which makes it also the most expensive
        // instant for the link to break. The reference does exactly this (TuneWriteExecutor.cs:67),
        // best-effort, continuing at 9600 if the switch is refused.
        //
        // Three things bound the risk, and the third is the one that matters:
        //   1. Only on a transport that changes rate on the open handle. Web Serial must close and
        //      reopen the port, which is a disturbance no other DS2 tool produces at all, let alone
        //      mid-programming-session.
        //   2. A refused switch is a normal outcome. 0x91 is answered before anything moves.
        //   3. A switch that is ACKed and then does NOT hold is caught by a keep-alive probe, and
        //      the fallback runs BEFORE the first write telegram. Not one byte of flash data is
        //      sent at a rate that has not just answered.
        //
        // The probe uses 0x9E inside a programming session, which neither tool has exercised there.
        // If the DME refuses tester-present in this state the probe fails, we fall back, and the
        // cost is the boost — not the flash. That is the right way for an unknown to fail.
        let boostedWrite = false;
        let writeTimeout = WRITE_RESPONSE_TIMEOUT_MS;
        this.lastSwitchOutcome = null;
        if (this.writeBaud !== 9600) {
            if (!this.transport.reopenIsInPlace()) {
                this.lastSwitchOutcome = 'not attempted — this transport cannot change baud without reopening the port';
                log.push(`BAUD boost skipped: ${this.lastSwitchOutcome}`);
            } else if (await this.trySwitchBaud(ds2BaudSpecFor(this.writeBaud))) {
                if (await this.linkRespondsAfterSwitch()) {
                    boostedWrite = true;
                    writeTimeout = programmingWriteTimeoutFor(this.writeBaud);
                    log.push(`BAUD boosted to ${this.writeBaud} and answered — write timeout now ${writeTimeout} ms`);
                } else {
                    const accepted = this.lastSwitchOutcome ?? 'accepted';
                    // Ask it back down, then force the local side regardless — same order and same
                    // best-effort reasoning as the read path's fallback.
                    try { await this.trySwitchBaud(Ds2BaudRate.Baud9600); } catch { }
                    try { await this.transport.reopen(Ds2BaudRate.Baud9600.baudRate); this.currentBaud = 9600; } catch { }
                    await this.resyncTransport();
                    // AFTER the restore: trySwitchBaud writes lastSwitchOutcome itself, so setting
                    // this first would have the fallback's own outcome overwrite the real one.
                    this.lastSwitchOutcome = `${accepted}, then the link went silent — fell back to 9600 before any write telegram`;
                    log.push(`BAUD boost to ${this.writeBaud} did not hold; writing at 9600`);
                    if (!(await this.linkRespondsAfterSwitch())) {
                        // The ECU is erased and will not answer at either rate. Stopping here is the
                        // honest outcome: every write telegram from now would fail anyway, and the
                        // recovery is a power cycle plus a re-run, which restarts from the erase.
                        throw new DmeLinkError(
                            `The DME stopped answering after a baud switch to ${this.writeBaud}, and did not come back at 9600. `
                            + `The data area has been erased and NOT rewritten. Turn the ignition off, wait 10 seconds, turn it back on, `
                            + `reconnect, and run WRITE again — it always starts from the erase, so re-running it is safe.`,
                        );
                    }
                }
            } else {
                log.push(`BAUD boost to ${this.writeBaud} refused: ${this.lastSwitchOutcome}`);
            }
        }
        const writeBaudActual = boostedWrite ? this.writeBaud : 9600;
        this.everBoosted ||= boostedWrite;

        // How the progress bar is split, derived from what this write will actually do rather than
        // stored as a pair of constants.
        //
        // It used to be a flat 70/30 justified by "writing ~2.5 min then verifying ~70 s". The 70 s
        // was wrong — §9 measures the identical 65536-byte read at 122.9 s — so the bar under-ran
        // the verify by a factor of nearly two on every flash. And under QUICK there is no read-back
        // at all: a fixed 30% reserved for a 50 ms exchange would leave the bar sitting at 70% for
        // the entire time anything was happening, then jumping.
        const WRITE_SHARE = options.verifyMode === 'full' ? 55 : 98;
        const VERIFY_SHARE = 100 - WRITE_SHARE;

        // Arm the instrument for the WRITE TELEGRAMS ONLY.
        //
        // Not the erase (one exchange whose turnaround is a flash sector erase, seconds long) and
        // not the read-back (whose turnaround is the DME *thinking*, ~40 ms). Both would land in the
        // same `turnaround` lane as the write telegrams and blend three different physical
        // quantities into one median — and that median is the entire reason to measure a write: it
        // is the DME's per-chunk flash programming time, which is the part a baud boost cannot
        // recover. The erase is timed separately above, by a plain stopwatch.
        this.timing.begin(Math.ceil(total / Mss54HpDataTuneLayout.writeChunkSize), {
            kind: 'write',
            chunkSize: Mss54HpDataTuneLayout.writeChunkSize,
            // A write acknowledgement is [addr][len][status][seg][addr×3][count][verify][cksum] —
            // fixed at 10 bytes however much was written.
            responseBytes: 10,
            // [addr][len][0x07][seg][addr x3][count][122 data][cksum] = 131 bytes. On this path the
            // request is 78% of the exchange, which is what `requestWire` exists to show.
            requestBytes: 9 + Mss54HpDataTuneLayout.writeChunkSize,
            // Asked-for beside ran-at. A refused boost falls back silently, and without both a
            // 9600 write is indistinguishable from a 125000 one that was never attempted.
            requestedBaud: this.writeBaud,
            switchOutcome: this.lastSwitchOutcome,
            baud: writeBaudActual,
            maxTelegramLength: this.maxTelegramLength,
        });
        let writeError: unknown;
        try {
            await this.writeBlock(slave.address, slaveData, 0, total, (w, t) => onProgress?.(Math.round((w / t) * WRITE_SHARE), 'writing'), writeTimeout);
            await this.writeBlock(master.address, masterData, slave.length, total, (w, t) => onProgress?.(Math.round((w / t) * WRITE_SHARE), 'writing'), writeTimeout);
        } catch (e) {
            writeError = e;
            throw e;
        } finally {
            // In the finally so a write that died at chunk 300 still yields its numbers. On this path
            // that matters more than on the read: the ECU is erased, the user is about to re-run, and
            // what the telegrams were doing beforehand is the only evidence there will ever be.
            const report = this.timing.finish(writeError);
            if (report) {
                log.push(`WRITE telegrams: ${report.chunks} in ${Math.round(report.elapsedMs)} ms at ${writeBaudActual} baud, `
                    + `median turnaround ${report.median.turnaround.toFixed(1)} ms, requestWire ${report.median.requestWire.toFixed(1)} ms `
                    + `(theory ${report.theoreticalRequestWire?.toFixed(1)}), ${report.retries} retr(ies)`);
            }
        }

        try {
            // Finalize the programming session (segment 0x0F, address 0).
            await this.sendProgrammingControl(Ds2ProgrammingControl.FinishSegment, 0, WRITE_RESPONSE_TIMEOUT_MS, true);
            log.push('FINALIZE data programming');

            // Finalize and the verification stay at the boosted rate, matching the reference, which
            // logs that it is "staying at boosted baud for the remainder of the session". Under FULL
            // that also carries the 65536-byte read-back, which is 103 s of the operation at 9600.
            return await this.verifyWrite(options.verifyMode, slaveData, masterData, total, WRITE_SHARE, VERIFY_SHARE, onProgress, options.spotCheck);
        } finally {
            // Hand the session back at 9600 however this ended.
            //
            // Not optional and not conditional on success: the adaptation paths, the flash counter
            // and the next connect all assume 9600, and a link left at 125000 after a write that
            // threw would make the NEXT operation fail for a reason that has nothing to do with it.
            // Best-effort in the same way the read path's restore is — if the DME never really
            // moved, the 0x91 fails and forcing the local port back is what recovers.
            if (boostedWrite) {
                try {
                    await this.trySwitchBaud(Ds2BaudRate.Baud9600);
                } catch {
                    try { await this.transport.reopen(Ds2BaudRate.Baud9600.baudRate); this.currentBaud = 9600; } catch { }
                }
                log.push('BAUD restored to 9600');
            }
        }
    }

    /**
     * Proves the write landed, and reports which proof it used.
     *
     * Both modes ask the DME for its own encoding checksum, because it is one exchange and there is
     * nothing to gain from choosing between two independent authorities. `full` adds the read-back.
     *
     * Deliberately NOT retried as a unit, and deliberately not wrapped in a try that softens a
     * failure into a warning: a verification that cannot be performed is not a verification that
     * passed. The one thing that IS tolerated is the DME declining to answer 0x0A at all under
     * `full` — there the read-back is the stronger check and has already run, so a missing checksum
     * is recorded and the write stands on the byte comparison.
     */
    private async verifyWrite(
        mode: WriteOptions['verifyMode'],
        slaveData: Uint8Array,
        masterData: Uint8Array,
        total: number,
        writeShare: number,
        verifyShare: number,
        onProgress?: TransferProgress,
        spotCheck?: SpotWindow[],
    ): Promise<WriteVerification> {
        const { slave, master } = Mss54HpDataTuneLayout;
        const log = this.events;
        onProgress?.(writeShare, 'verifying');

        let readBack = false;
        let spotWindows = 0;
        if (mode === 'full') {
            const tRead = performance.now();
            const readBackSlave = await this.readRange(slave.address, slave.length,
                (done) => onProgress?.(writeShare + Math.round((done / total) * verifyShare), 'verifying'));
            const readBackMaster = await this.readRange(master.address, master.length,
                (done) => onProgress?.(writeShare + Math.round(((slave.length + done) / total) * verifyShare), 'verifying'));
            if (!arraysEqual(readBackSlave, slaveData) || !arraysEqual(readBackMaster, masterData)) {
                log.push('VERIFY read-back MISMATCH');
                throw new DmeLinkError('Write verification failed: read-back does not match what was written. Treat the ECU state as unknown — keep power stable and re-write before disconnecting.');
            }
            readBack = true;
            log.pushTimed(`VERIFY read-back matched (${total} bytes)`, tRead);
        }

        let encodingChecksum: Ds2EncodingChecksum | null = null;
        let encodingChecksumError: string | null = null;
        try {
            encodingChecksum = await this.queryEncodingChecksumInner();
            log.push(`VERIFY encoding checksum — ${describeEncodingChecksum(encodingChecksum)}`);
        } catch (e) {
            encodingChecksumError = e instanceof Error ? e.message : String(e);
            log.push(`VERIFY encoding checksum unavailable: ${encodingChecksumError}`);
        }

        // Judged in BOTH modes. Under QUICK it is the only post-write check there is and a fault
        // has to fail the write; under FULL the read-back already proved the bytes, so a fault is
        // not fatal — but it is exactly the fact that decides whether QUICK may be offered on this
        // ECU later, and it was not being recorded. See WriteVerification.checksumClean.
        const faults = encodingChecksum ? faultedAreas(encodingChecksum, DATA_TUNE_CHECKSUM_BITS) : null;
        const checksumClean = faults !== null && faults.length === 0;
        if (mode === 'quick') {
            // Under QUICK this is the only post-write check there is, so it must be present and it
            // must be clean. A DME that will not answer 0x0A cannot be quick-verified, and saying so
            // is the only honest outcome — the alternative is a write reported as verified by a
            // check that never ran.
            if (!encodingChecksum) {
                throw new DmeLinkError(
                    `Quick verification could not be performed: the DME did not answer the encoding-checksum query (${encodingChecksumError}). `
                    + `The data was written and every telegram reported "programming OK", but nothing has confirmed the result. `
                    + `Re-run the write with FULL READBACK before relying on it.`,
                );
            }
            const bad = faults ?? [];
            if (bad.length > 0) {
                throw new DmeLinkError(
                    `Write verification failed: the DME reports a checksum fault in ${bad.map(a => a.name).join(' and ')}. `
                    + `Treat the ECU state as unknown — keep power stable and re-write before disconnecting.`,
                );
            }
            // The checksum byte alone cannot tell "programmed" from "politely ignored" — the old
            // image has valid checksums too, and a real write has been watched passing every gate
            // above while the flash kept its old bytes (spotCheck.ts has the post-mortem). So read
            // back the windows the caller says MUST have changed, and compare. A handful of tiny
            // reads: the cost is two or three telegrams against a 66-second write.
            for (const w of spotCheck ?? []) {
                const inSlave = w.offset < slave.length;
                const regionEnd = inSlave ? slave.length : total;
                const len = Math.min(w.length, regionEnd - w.offset);
                if (len <= 0) continue;
                const addr = inSlave ? slave.address + w.offset : master.address + (w.offset - slave.length);
                const sent = inSlave
                    ? slaveData.subarray(w.offset, w.offset + len)
                    : masterData.subarray(w.offset - slave.length, w.offset - slave.length + len);
                const got = await this.readRange(addr, len);
                if (!arraysEqual(got, sent)) {
                    log.push(`VERIFY spot read-back MISMATCH at 0x${addr.toString(16).toUpperCase().padStart(6, '0')}`);
                    throw new DmeLinkError(
                        `Write verification failed: the flash still holds the OLD bytes at 0x${addr.toString(16).toUpperCase().padStart(6, '0')} — `
                        + `the DME acknowledged every programming telegram and reports clean checksums, but it did not program. `
                        + `Nothing was changed on the ECU. Re-try the write; if it repeats, use FULL READBACK and a different baud.`,
                    );
                }
                spotWindows++;
            }
            if (spotWindows > 0) log.push(`VERIFY spot read-back matched (${spotWindows} window(s) of changed bytes)`);
        } else if (faults && faults.length > 0) {
            // FULL: the bytes are proven, so this is not a failure — but it is a disagreement
            // between two checks and it goes in the record rather than being dropped.
            log.push(`VERIFY read-back matched but the DME reports a checksum fault in ${faults.map(a => a.name).join(' and ')}`);
        }

        onProgress?.(100, 'verifying');
        return { mode, encodingChecksum, encodingChecksumError, checksumClean, readBack, spotWindows };
    }

    async resetFlashCounter(
        onBackup: (serviceBlockPair: ArrayBuffer) => Promise<void>,
        onProgress?: TransferProgress,
        boost = false,
    ): Promise<FlashCounterInfo> {
        return this.withGate(() => this.resetFlashCounterInner(onBackup, onProgress, boost));
    }

    /**
     * Clears the flash counter on both processors, mirroring the reference ClearFlashCounterExecutor.
     *
     * The counter cannot be written in place: it lives in flash, and flash only goes 1 -> 0 without an
     * erase. So the whole 8 KB service block on each processor is read, rebuilt with the counter
     * reset, erased and written back. That block also carries AIF, ZIF and the VIN records, which is
     * why the read comes first and its bytes go to `onBackup` before a single erase is sent — those
     * 16 KB are the only way back if the write is interrupted.
     *
     * Honours the BOOST selector, and only where a boost is possible at all (operator, 2026-08-30).
     *
     * This used to say it deliberately did not boost, on the grounds that the flash path had never
     * done it on real hardware. That stopped being true when `writePartialBin` gained `writeBaud` —
     * the same switch, the same three bounds, exercised on this car. Leaving the counter reset out
     * was no longer a decision, it was the older half of the file.
     *
     * WHAT CAN AND CANNOT SPEED UP. The DME accepts the switch only from inside a programming
     * session, and the erase is what opens one. So the two 16 KB READS here — phase 1, and the
     * verifying read-back — happen before that door exists and stay at 9600. What boosts is the
     * 16 KB write between them, which is where the erase has already put the session.
     */
    private async resetFlashCounterInner(
        onBackup: (serviceBlockPair: ArrayBuffer) => Promise<void>,
        onProgress?: TransferProgress,
        boost = false,
    ): Promise<FlashCounterInfo> {
        this.assertConnected();
        // Hard stop before anything is read, let alone erased. See FLASH_COUNTER_RESET_ENABLED: the
        // slave block read all-0xFF on a real car, so the addressing this whole sequence rests on is
        // not trustworthy, and the erase clears both processors at once.
        if (!FLASH_COUNTER_RESET_ENABLED) {
            throw new DmeLinkError(
                'Flash counter reset is disabled. On a real vehicle the slave service block read back as all-0xFF ' +
                'while the master read real data, which means the slave address this operation depends on is not ' +
                'confirmed. Since the erase clears both processors in one command, running it could destroy the ' +
                'slave\'s VIN/AIF/ZIF records. Reading the counter is unaffected.',
            );
        }
        const { master, slave, counterOffset } = ServiceBlockLayout;

        // Refresh the seed/key unlock before the protected write, exactly as READ and WRITE do, and
        // strictly before anything destructive. resync rather than purge so a break latched earlier
        // can't kill the login.
        await this.resyncTransport();
        await this.login();

        // --- Phase 1: read both service blocks (0-25%) -------------------------------------------
        const READ_SHARE = 25;
        const WRITE_SHARE = 45;   // 25 -> 70
        const VERIFY_SHARE = 30;  // 70 -> 100
        const pairTotal = master.length + slave.length;

        const masterImage = await this.readRange(master.address, master.length,
            (done) => onProgress?.(Math.round((done / pairTotal) * READ_SHARE), 'reading'));
        const slaveImage = await this.readRange(slave.address, slave.length,
            (done) => onProgress?.(Math.round(((master.length + done) / pairTotal) * READ_SHARE), 'reading'));

        // --- Phase 2: guards ---------------------------------------------------------------------
        // Refuse if the identity records this operation is supposed to preserve are not there. The
        // reset erases and writes back, so it can only carry forward what it actually read: if the
        // AIF is missing from the image, the rewrite would make that state the verified truth.
        //
        // Checked only where the AIF actually lives, which the DME tells us. An earlier version asked
        // "is everything outside the counter erased?" of BOTH blocks and refused on yes — that fires
        // on every healthy DME, because the slave block normally holds nothing but the counter.
        const aifOffset = this.pointers.aif !== null
            && this.pointers.aif >= master.address && this.pointers.aif < master.address + master.length
            ? this.pointers.aif - master.address
            : null;
        if (!hasIntactAif(masterImage, aifOffset)) {
            // Carried as data, not prose: this is the one failure with a remedy the app can perform,
            // so the UI branches to the restore rather than printing advice it hasn't enabled.
            throw new DmeLinkError(
                `Flash counter reset refused: the AIF records are missing from the ${master.name} service block. ` +
                `Writing it back in this state would make that permanent. Read the service info to see what is ` +
                `there, and restore a saved backup if one matches this DME.`,
                { kind: 'serviceBlockErased', processor: master.name } satisfies ServiceBlockErasedCause,
            );
        }

        // Then: both boot fields must be closed. A field showing 0x00FF/0xFF00 has a programming
        // session still open, and erasing the block underneath one is how a DME stops being
        // programmable at all. Same condition the reference refuses on (ClearFlashCounterExecutor).
        const before: FlashCounterInfo = {
            master: analyzeFlashCounter(master.name, master.address + counterOffset, extractCounterFromServiceBlock(masterImage)),
            slave: analyzeFlashCounter(slave.name, slave.address + counterOffset, extractCounterFromServiceBlock(slaveImage)),
            readAt: Date.now(),
        };
        for (const region of [before.master, before.slave]) {
            if (region.state !== 'available') {
                throw new DmeLinkError(
                    `Flash counter reset refused: the ${region.name} boot field is not in the available/closed state ` +
                    `(marker 0x${region.firstOpenMarker.toString(16).padStart(4, '0')}). ` +
                    `A programming session is still open — cycle the ignition and reconnect before retrying.`,
                );
            }
        }

        // --- Phase 3: hand the backup out — the last point of no return --------------------------
        // Awaited, and its rejection is deliberately NOT caught: if the caller cannot persist these
        // bytes, nothing below should run. Everything after this line is destructive.
        const pair = new Uint8Array(SERVICE_BLOCK_PAIR_LENGTH);
        pair.set(masterImage, 0);
        pair.set(slaveImage, master.length);
        await onBackup(pair.buffer);

        // --- Phase 4/5: erase, rewrite, verify ---------------------------------------------------
        return this.programServiceBlocks(
            buildResetServiceBlockImage(masterImage),
            buildResetServiceBlockImage(slaveImage),
            // Asked of the ORIGINAL images, because the question is what the DME holds now — the
            // reset copies those 4 bytes through unchanged, so the plan would answer identically.
            shouldWriteClearPrepMarker(masterImage),
            shouldWriteClearPrepMarker(slaveImage),
            'Flash counter reset',
            READ_SHARE, WRITE_SHARE, VERIFY_SHARE,
            // The tick on THIS reset's confirmation, not the data write's BOOST selector — see the
            // `boost` parameter on DmeLink.resetFlashCounter for why they are not one decision, and
            // programServiceBlocks for why the RESTORE that shares this sequence passes 9600.
            // `programServiceBlocks` still refuses a transport that cannot change rate in place, so
            // a tick that cannot be honoured costs the speed and nothing else.
            boost ? 125000 : 9600,
            onProgress,
        );
    }

    /**
     * Erases both service blocks and writes the given images back, then verifies byte-for-byte.
     *
     * Shared by the reset and the restore because it is the same programming sequence — only the
     * bytes differ, and only in how they were arrived at. Keeping one copy means the recovery path
     * cannot drift away from the path that created the damage, which is the last place a
     * near-duplicate would be safe.
     */
    private async programServiceBlocks(
        masterPlan: Uint8Array,
        slavePlan: Uint8Array,
        masterNeedsPrep: boolean,
        slaveNeedsPrep: boolean,
        describe: string,
        doneBefore: number,
        writeShare: number,
        verifyShare: number,
        /**
         * Rate to boost the WRITE to once the erase has opened a programming session. 9600 means
         * no switch is attempted.
         *
         * A parameter rather than a read of `this.writeBaud`, because the two callers want
         * different answers and the difference is the point. The RESET passes the operator's
         * selector. The RESTORE passes 9600 — it is the recovery for a service block that is
         * already damaged, and the one path that has to work is not the place to also be running
         * the experiment. Stating it here keeps ONE programming sequence with one declared
         * difference, rather than two sequences free to drift apart.
         */
        boostTo: Ds2SupportedBaud,
        onProgress?: TransferProgress,
    ): Promise<FlashCounterInfo> {
        const { master, slave, counterOffset, prepMarkerOffset } = ServiceBlockLayout;
        const pairTotal = master.length + slave.length;

        // Same guard as the data-area write, and for the same reason: the recycle/erase below is the
        // point of no return, and this block holds AIF/ZIF/VIN.
        assertWriteChunkingLegal([master, slave]);

        onProgress?.(doneBefore, 'erasing');
        if (masterNeedsPrep) {
            await this.writeMemoryChunk(master.address + prepMarkerOffset, CLEAR_PREP_MARKER, PREP_MARKER_TIMEOUT_MS);
        }
        if (slaveNeedsPrep) {
            await this.writeMemoryChunk(slave.address + prepMarkerOffset, CLEAR_PREP_MARKER, PREP_MARKER_TIMEOUT_MS);
        }

        // Recycle-only permits the service block to be erased. Its verify byte is not required to be
        // 1 — the reference passes requireProgrammingOk: false here.
        await this.sendProgrammingControl(
            Ds2ProgrammingControl.RecyclingSegment, Ds2ProgrammingControl.RecycleOnlyAddress,
            WRITE_RESPONSE_TIMEOUT_MS, false);
        // One erase covers BOTH processors' service blocks, addressed at the master base — the same
        // shape as the data-area erase, which erases slave and master with a single command.
        await this.sendProgrammingControl(
            Ds2ProgrammingControl.EraseSegment, master.address, ERASE_TIMEOUT_MS, true);

        // THE ONE MOMENT A BOOST IS POSSIBLE, and the same three bounds the data write is held to:
        // the switch is answered before anything moves; a refused switch just writes at 9600; and
        // an accepted switch that then goes silent drops back BEFORE a single write telegram.
        //
        // Unlike the data write, a link that answers at neither rate is NOT thrown on here. That
        // one stops because its data area is erased and every telegram after would fail anyway.
        // Here the erased block is the service block, its 16 KB have already been handed to
        // `onBackup`, and the caller's recovery is `restoreServiceBlock` from exactly those bytes —
        // so the useful thing is to keep going at 9600 and let the write and its verification say
        // what really happened.
        let boosted = false;
        let writeTimeout = WRITE_RESPONSE_TIMEOUT_MS;
        if (boostTo !== 9600) {
            if (!this.transport.reopenIsInPlace()) {
                this.lastSwitchOutcome = 'not attempted — this transport cannot change baud without reopening the port';
            } else if (await this.trySwitchBaud(ds2BaudSpecFor(boostTo)).catch(() => false)) {
                if (await this.linkRespondsAfterSwitch()) {
                    boosted = true;
                    writeTimeout = programmingWriteTimeoutFor(boostTo);
                } else {
                    const accepted = this.lastSwitchOutcome ?? 'accepted';
                    try { await this.trySwitchBaud(Ds2BaudRate.Baud9600); } catch { }
                    try { await this.transport.reopen(Ds2BaudRate.Baud9600.baudRate); this.currentBaud = 9600; } catch { }
                    try { await this.resyncTransport(); } catch { }
                    // AFTER the restore, for the reason the data write states: trySwitchBaud writes
                    // this field itself, so setting it first loses the outcome that matters.
                    this.lastSwitchOutcome = `${accepted}, then the link went silent — fell back to 9600 before any write telegram`;
                }
            }
        }
        this.everBoosted ||= boosted;
        this.events.push(`${describe}: write at ${boosted ? boostTo : 9600}`
            + (this.lastSwitchOutcome ? ` (${this.lastSwitchOutcome})` : ''));

        try {
            await this.writeBlock(master.address, masterPlan, 0, pairTotal,
                (w, t) => onProgress?.(doneBefore + Math.round((w / t) * writeShare), 'writing'), writeTimeout);
            await this.writeBlock(slave.address, slavePlan, master.length, pairTotal,
                (w, t) => onProgress?.(doneBefore + Math.round((w / t) * writeShare), 'writing'), writeTimeout);

        await this.sendProgrammingControl(
            Ds2ProgrammingControl.RecyclingSegment, Ds2ProgrammingControl.RecycleOffAddress,
            WRITE_RESPONSE_TIMEOUT_MS, false);
        await this.sendProgrammingControl(
            Ds2ProgrammingControl.FinishSegment, 0, WRITE_RESPONSE_TIMEOUT_MS, true);

        const verifyBase = doneBefore + writeShare;
        onProgress?.(verifyBase, 'verifying');
        const masterReadBack = await this.readRange(master.address, master.length,
            (done) => onProgress?.(verifyBase + Math.round((done / pairTotal) * verifyShare), 'verifying'));
        const slaveReadBack = await this.readRange(slave.address, slave.length,
            (done) => onProgress?.(verifyBase + Math.round(((master.length + done) / pairTotal) * verifyShare), 'verifying'));
        if (!arraysEqual(masterReadBack, masterPlan) || !arraysEqual(slaveReadBack, slavePlan)) {
            throw new DmeLinkError(
                `${describe} verification failed: the read-back does not match what was written. Treat the ECU ` +
                `state as unknown — keep power on, stay connected, and do not switch the ignition off.`,
            );
        }
        onProgress?.(100, 'verifying');

        // Decoded from what the DME actually returned, not from the image we planned to write. The
        // reference reports the plan's numbers; these are measured, and they cost nothing extra
        // because the verifying read already fetched the bytes.
        return {
            master: analyzeFlashCounter(master.name, master.address + counterOffset, extractCounterFromServiceBlock(masterReadBack)),
            slave: analyzeFlashCounter(slave.name, slave.address + counterOffset, extractCounterFromServiceBlock(slaveReadBack)),
            readAt: Date.now(),
        };
        } finally {
            // Hand the session back at 9600 however this ended — not optional and not conditional
            // on success, for the reason the data write gives: the adaptation paths, the counter
            // read and the next connect all assume 9600, and a link left boosted after a throw
            // makes the NEXT operation fail for a reason that has nothing to do with it.
            if (boosted) {
                try {
                    await this.trySwitchBaud(Ds2BaudRate.Baud9600);
                } catch {
                    try { await this.transport.reopen(Ds2BaudRate.Baud9600.baudRate); this.currentBaud = 9600; } catch { }
                }
                this.events.push(`${describe}: baud restored to 9600`);
            }
        }
    }

    async restoreServiceBlock(serviceBlockPair: ArrayBuffer, onProgress?: TransferProgress): Promise<FlashCounterInfo> {
        return this.withGate(() => this.restoreServiceBlockInner(serviceBlockPair, onProgress));
    }

    /**
     * Writes a saved service block back over whatever the DME currently holds.
     *
     * Deliberately guard-free where the reset is careful. It does not read the block first (the
     * current contents are the damage), does not take a backup (there is nothing left worth saving),
     * and does not refuse an erased block (that is the case it exists for). The one thing it keeps
     * is the verifying read-back — recovery that cannot prove it landed is not recovery.
     *
     * Whether the prep markers still need writing is read from the DME, not inferred from the saved
     * image. Those two questions have different answers here by definition: the backup records what
     * the block held BEFORE the reset, while the erase that followed set the markers back to 0xFF.
     * Asking the image would skip a marker the DME now needs, and the erase would be refused.
     */
    private async restoreServiceBlockInner(serviceBlockPair: ArrayBuffer, onProgress?: TransferProgress): Promise<FlashCounterInfo> {
        this.assertConnected();
        const { master, slave, prepMarkerOffset } = ServiceBlockLayout;
        if (serviceBlockPair.byteLength !== SERVICE_BLOCK_PAIR_LENGTH) {
            throw new DmeLinkError(
                `Refusing to restore a ${serviceBlockPair.byteLength}-byte service block (expected ${SERVICE_BLOCK_PAIR_LENGTH})`,
            );
        }
        const bytes = new Uint8Array(serviceBlockPair);
        const masterPlan = bytes.slice(0, master.length);
        const slavePlan = bytes.slice(master.length, SERVICE_BLOCK_PAIR_LENGTH);

        await this.resyncTransport();
        await this.login();

        // Two 4-byte reads, so the answer describes the ECU in front of us.
        const masterNeedsPrep = isAllErased(
            await this.readRange(master.address + prepMarkerOffset, CLEAR_PREP_MARKER.length));
        const slaveNeedsPrep = isAllErased(
            await this.readRange(slave.address + prepMarkerOffset, CLEAR_PREP_MARKER.length));

        // No bulk read phase, so the whole progress bar belongs to the write and the verify.
        return this.programServiceBlocks(
            masterPlan, slavePlan, masterNeedsPrep, slaveNeedsPrep,
            'Service block restore',
            0, 60, 40,
            // 9600, and not the operator's selector. This is the recovery for a service block that
            // is already damaged; the one path that has to work is not the place to also run the
            // experiment. It is stated here rather than defaulted so that the difference from the
            // reset is a line someone can read and argue with.
            9600,
            onProgress,
        );
    }

    private startTime = 0;

    /**
     * Polls the DS2 "Standard Measurements" block (selection 3: RPM, coolant temp, relative
     * opening) and the "Operating Measurements" block (selection 19: lambda controller trim,
     * i.e. our stft1/stft2) — both field layouts confirmed against the reference source
     * (DmeLiveValueCatalog.cs). Two DS2 round-trips per sample.
     */
    async pollLiveMeasurement(): Promise<LiveMeasurement> {
        return this.withGate(() => this.pollLiveMeasurementInner());
    }

    /** Engine speed from the same block a datalog sample comes from — block 3 carries RPM, and the
     *  poll already resyncs and retries it. Throws rather than guessing if the DME can't be asked:
     *  the caller must not read a failed question as "stopped". */
    async readEngineRpm(): Promise<number> {
        return this.withGate(async () => {
            this.assertConnected();
            const sample = await this.pollLiveMeasurementInner();
            return sample.rpm;
        });
    }

    /**
     * Arms the per-exchange instrument for a datalog run.
     *
     * The log is the one path where `hostGap` is not ~0 — `flushLiveSamples` runs a full
     * `processLogData` and VE recalculation synchronously inside the sample callback — and it is
     * also the path whose sample rate has only ever been asserted, never measured. `TransferKind`
     * has carried `'log'` since the write instrument was built and nothing ever armed it, so both
     * questions stayed open.
     *
     * Bounded rather than open-ended: a run has no chunk count to size the lanes from, so it takes a
     * fixed window and lets `end()`'s existing bounds check drop the overflow. The first few hundred
     * exchanges are what answers "what rate does this profile really achieve" — a rolling window
     * would cost memory forever to tell us the same thing.
     */
    beginLogTiming(exchanges?: readonly LogExchange[]): void {
        // Every run starts at sample 0, so the slow lane always fires on the first sample and no run
        // begins with eight samples of undefined purge channels. This is the one call every run makes
        // before its first poll, which is what makes it the right place for the counters.
        this.liveSampleIndex = 0;
        this.lambdaDriftRun = 0;
        this.lastSlowLane = {};

        // Low latency timer for the duration of the run. Not awaited: it is a throughput adjustment
        // on a chip that may not have the knob, and a run must not wait on it or fail with it. Paired
        // with the restore in endLogTiming, which every run reaches — the poll loop's `finally` calls
        // it on the clean exit and on the failed one alike.
        void this.transport.setLatencyTimer?.('log');

        // Sized from the exchanges the run will actually make. It used to be hard-wired to the EGAS
        // block because the inertia run was the only caller; a VE sample is two exchanges of 35 and
        // 90 bytes and would have been reported as two 52-byte ones.
        //
        // The MEAN payload, for a profile that makes more than one exchange. `turnaround` and
        // `hostGap` — the two numbers this instrument exists for — are per-exchange and do not
        // depend on size at all; only `theoreticalResponseWire` does, and the mean is what makes
        // that figure times the exchange count come out as the run's true wire time. A single
        // exchange's own figure is then an average rather than its exact size, which is worth
        // saying out loud but is not a number anything reads.
        //
        // A RAM read contributes its own byte count, and the slow lane contributes its block at 1/8
        // weight — otherwise a four-byte read and a ninety-byte block would average as if they were
        // equally frequent, which is the same class of error as the EGAS default this replaced.
        const list = exchanges ?? this.liveExchanges;
        let weight = 0;
        let weighted = 0;
        for (const x of list) {
            const w = 1 / Math.max(1, x.every ?? 1);
            const bytes = x.kind === 'ram' ? x.count : LIVE_BLOCK_LENGTHS[x.selection];
            if (bytes === undefined) continue;
            weight += w;
            weighted += w * bytes;
        }
        const payload = weight > 0 ? weighted / weight : EGAS_MEASUREMENT_BLOCK.expectedLength;

        this.timing.clearReport();
        this.timing.begin(LOG_TIMING_WINDOW_EXCHANGES, {
            kind: 'log',
            chunkSize: payload,
            // [addr][len][status][payload][cksum].
            responseBytes: payload + 4,
            // [addr][len][0x0B][selection][cksum] — five bytes, so `write` and `echoLatency` are
            // meaningful here in the way they are on a read and are not on a write. A RAM read's
            // request is nine; the difference is 4.6 ms of wire against a per-exchange turnaround of
            // tens, and reporting one mean here would make BOTH figures wrong rather than one.
            requestBytes: 5,
            requestedBaud: null,
            switchOutcome: null,
            // The rate the link is at NOW, not the rate the last read ran at — see currentBaud.
            baud: this.currentBaud,
            maxTelegramLength: this.maxTelegramLength,
        });
    }

    /** Closes the datalog timing window and returns what it collected, or null if DIAG was off.
     *  Also puts the transport's latency timer back — see beginLogTiming. */
    endLogTiming(error?: unknown): TransferTimingReport | null {
        void this.transport.setLatencyTimer?.('idle');
        return this.timing.finish(error);
    }

    /**
     * What one live sample is made of.
     *
     * Defaults to both blocks, so anything that has not been taught about profiles keeps the
     * behaviour it had. See lib/log-engine/logProfile.ts for what the lists mean and what they cost.
     */
    private liveExchanges: LogExchange[] = [
        { kind: 'block', selection: STANDARD_MEASUREMENT_BLOCK.selection },
        { kind: 'block', selection: OPERATING_MEASUREMENTS_BLOCK.selection },
    ];
    /** Which sample of the run this is, for the `every` divisors. Reset by `beginLogTiming`, which
     *  is the one call every run makes before its first sample. */
    private liveSampleIndex = 0;
    /** Consecutive slow-lane disagreements between the RAM trim and block 19's own. Reported, never
     *  acted on — see LAMBDA_TRUTH_GATE.driftWarnAfter. */
    private lambdaDriftRun = 0;
    /** The block-19 channels that exist in no other block, carried between slow-lane reads. Empty
     *  until the first one lands, so nothing is ever invented. */
    private lastSlowLane: SlowLaneChannels = {};

    /** Block 3 is not optional: it carries rpm and load, without which there is no sample at all.
     *  A list that omits it is a caller error, so it is put back rather than obeyed. */
    setLiveExchanges(exchanges: readonly LogExchange[]): void {
        const hasStandard = exchanges.some(x =>
            x.kind === 'block' && x.selection === STANDARD_MEASUREMENT_BLOCK.selection && (x.every ?? 1) === 1);
        this.liveExchanges = hasStandard
            ? [...exchanges]
            : [{ kind: 'block', selection: STANDARD_MEASUREMENT_BLOCK.selection }, ...exchanges];
    }

    getLiveExchanges(): LogExchange[] { return [...this.liveExchanges]; }

    /**
     * Proves — on this ECU, before the drive — that the four RAM bytes really are the lambda trim.
     *
     * See `LAMBDA_TRUTH_GATE` for why 5 % and why a sandwich. This is the operational half: it never
     * throws and never leaves the caller without a list, because the answer to "this car will not
     * serve that read" is a slower log, not a failed one.
     */
    async verifyLambdaTrimSource(profile: { exchanges: LogExchange[]; fallback?: LogExchange[] }) {
        const claim = profile.exchanges.find(x => x.kind === 'ram' && x.count === LAMBDA_TRIM_RAM_READ.count
            && x.address === LAMBDA_TRIM_RAM_READ.address && x.segment === LAMBDA_TRIM_RAM_READ.segment);
        if (!claim) return null;   // nothing claimed, nothing to check
        const fallback = profile.fallback ?? profile.exchanges;
        return this.withGate(async () => {
            this.assertConnected();
            this.events.push('Lambda trim source check');
            let passed = 0;
            const seen: string[] = [];
            try {
                for (let i = 0; i < LAMBDA_TRUTH_GATE.pairsTaken; i++) {
                    const before = await this.readLambdaTrimFromRam();
                    const block19 = await this.readLambdaTrimFromBlock19();
                    const after = await this.readLambdaTrimFromRam();
                    // The mean of the readings either side, against the block read between them. The
                    // trim moves continuously, so bracketing is what stops "200 ms passed" from
                    // looking like "the address is wrong".
                    const ram = before !== undefined && after !== undefined ? (before + after) / 2 : undefined;
                    const ok = lambdaTrimAgrees(ram, block19);
                    if (ok) passed++;
                    seen.push(`${ram?.toFixed(4) ?? '—'}/${block19?.toFixed(4) ?? '—'}${ok ? '' : ' ✗'}`);
                }
            } catch (e) {
                // A refusal, a timeout, a window the DME will not serve. All of them mean the same
                // thing here, and it is not a failed drive.
                const detail = `RAM lambda trim could not be checked (${e instanceof Error ? e.message : String(e)}) — logging both blocks.`;
                this.events.push(detail);
                return { exchanges: fallback, proven: false, detail };
            }
            const proven = passed >= LAMBDA_TRUTH_GATE.pairsRequired;
            const detail = `RAM lambda trim ${proven ? 'confirmed' : 'REJECTED'} `
                + `(${passed}/${LAMBDA_TRUTH_GATE.pairsTaken} within ${(LAMBDA_TRUTH_GATE.tolerance * 100).toFixed(0)} %: ${seen.join(', ')})`;
            this.events.push(detail);
            return { exchanges: proven ? profile.exchanges : fallback, proven, detail };
        });
    }
    /**
     * The same sandwich for MD_LLRI, and `verifyLambdaTrimSource` delegated into one entry point.
     *
     * `'lambda-trim'` just forwards, so every existing caller and every stored event log keeps its
     * name. `'idle-torque'` is the new case, and its arithmetic is genuinely different rather than
     * parameterised for the sake of it: the lambda gate is relative with a fixed 0.7-1.3 band,
     * which is meaningless for a signed torque that rests at -7 Nm and crosses zero in normal
     * running. So the tolerance is absolute and the plausibility band is `rails`, read from the
     * binary by the caller. This layer must not invent a range for a channel whose range is
     * calibration data — which is also why `rails` missing is a refusal, not a default.
     */
    async verifyRamChannelSource(
        profile: { exchanges: LogExchange[]; fallback?: LogExchange[] },
        channel: 'lambda-trim' | 'idle-torque',
        rails?: { min: number; max: number },
    ) {
        if (channel === 'lambda-trim') return this.verifyLambdaTrimSource(profile);

        const claim = profile.exchanges.find(x => x.kind === 'ram' && x.count === IDLE_TORQUE_RAM_READ.count
            && x.address === IDLE_TORQUE_RAM_READ.address && x.segment === IDLE_TORQUE_RAM_READ.segment);
        if (!claim) return null;
        const fallback = profile.fallback ?? profile.exchanges;
        if (!rails) {
            const detail = "Idle torque source not checked: the binary's MD_LLRI clamps were not supplied — logging block 19.";
            this.events.push(detail);
            return { exchanges: fallback, proven: false, detail };
        }
        return this.withGate(async () => {
            this.assertConnected();
            this.events.push('Idle torque source check');
            let passed = 0;
            const seen: string[] = [];
            try {
                for (let i = 0; i < IDLE_TORQUE_TRUTH_GATE.pairsTaken; i++) {
                    const before = await this.readIdleTorqueFromRam();
                    const block19 = await this.readIdleTorqueFromBlock19();
                    const after = await this.readIdleTorqueFromRam();
                    const ram = before !== undefined && after !== undefined ? (before + after) / 2 : undefined;
                    const ok = idleTorqueAgrees(ram, block19, rails);
                    if (ok) passed++;
                    seen.push(`${ram?.toFixed(1) ?? '—'}/${block19?.toFixed(1) ?? '—'}${ok ? '' : ' ✗'}`);
                }
            } catch (e) {
                const detail = `RAM idle torque could not be checked (${e instanceof Error ? e.message : String(e)}) — logging block 19.`;
                this.events.push(detail);
                return { exchanges: fallback, proven: false, detail };
            }
            const proven = passed >= IDLE_TORQUE_TRUTH_GATE.pairsRequired;
            const detail = `RAM idle torque ${proven ? 'confirmed' : 'REJECTED'} `
                + `(${passed}/${IDLE_TORQUE_TRUTH_GATE.pairsTaken} within ${IDLE_TORQUE_TRUTH_GATE.toleranceNm} Nm: ${seen.join(', ')})`;
            this.events.push(detail);
            return { exchanges: proven ? profile.exchanges : fallback, proven, detail };
        });
    }

    private async readIdleTorqueFromRam(): Promise<number | undefined> {
        const { segment, address, count } = IDLE_TORQUE_RAM_READ;
        const bytes = await this.readMemoryChunk(segment, address, count);
        return decodeRamSignal(Mss54HpRamSignals.MD_LLRI, bytes, address) ?? undefined;
    }

    private async readIdleTorqueFromBlock19(): Promise<number | undefined> {
        const frame = await this.exchange(Ds2Control.READ_IO_STATUS, new Uint8Array([OPERATING_MEASUREMENTS_BLOCK.selection]));
        if (!isPositiveResponse(frame)) return undefined;
        return decodeOperatingMeasurementsBlock(frame.payload).mdLlri ?? undefined;
    }

    /** Sample counter for the idle run, so the slow and survey lanes know when they are due. */
    private idleSampleIndex = 0;

    /** One four-byte RAM read, decoded to bank 1's trim. Poll-shaped: no retry budget, because the
     *  caller is either a gate that takes three samples or a poll that gets another one in 200 ms. */
    private async readLambdaTrimFromRam(): Promise<number | undefined> {
        const { segment, address, count } = LAMBDA_TRIM_RAM_READ;
        const bytes = await this.readMemoryChunk(segment, address, count);
        return decodeRamSignal(Mss54HpRamSignals.LA_F_REGLER1, bytes, address) ?? undefined;
    }

    private async readLambdaTrimFromBlock19(): Promise<number | undefined> {
        const frame = await this.exchange(Ds2Control.READ_IO_STATUS, new Uint8Array([OPERATING_MEASUREMENTS_BLOCK.selection]));
        if (!isPositiveResponse(frame)) return undefined;
        return decodeOperatingMeasurementsBlock(frame.payload).stft1 ?? undefined;
    }

    async readEgasFreezeFrame(): Promise<EgasMeasurement> {
        return this.withGate(() => this.readEgasFreezeFrameInner());
    }

    async pollInertiaSample(): Promise<InertiaSample> {
        return this.withGate(() => this.pollInertiaSampleInner());
    }
    async pollIdleSample(): Promise<IdleSample> {
        return this.withGate(() => this.pollIdleSampleInner());
    }

    async readRam(segment: number, address: number, count: number): Promise<Uint8Array> {
        if (!isRamReadInRange(segment, address, count)) {
            throw new DmeLinkError(
                `RAM read 0x${address.toString(16)} +${count} is not inside a declared window for segment `
                + `0x${segment.toString(16)}. See Mss54HpRamWindows.`);
        }
        return this.withGate(async () => {
            this.assertConnected();
            await this.resyncTransport();
            return this.readMemoryChunkWithRetry(segment, address, count);
        });
    }

    /**
     * Tries the smallest legal read in each RAM window and reports what came back.
     *
     * **Never throws on a refusal.** A DME that will not serve RAM is an answer this app has to be
     * able to display, not an exception to surface as a broken cable — and the two are genuinely
     * different: `0xB0` is `flash_req_parse` declining the address (`0x002938: move.b #$b0,$2(a0)`),
     * which means the region table on this calibration is not what the disassembly said, while a
     * timeout means the link. Only a bug in the request itself propagates, because that is the one
     * case where continuing would hide a mistake rather than report a fact.
     */
    async probeRam(): Promise<RamProbeResult> {
        this.assertConnected();
        const windows: RamProbeWindow[] = [];
        for (const probe of RAM_PROBE_READS) {
            const base = { name: probe.name, segment: probe.segment, address: probe.address };
            try {
                const bytes = await this.readRam(probe.segment, probe.address, probe.count);
                windows.push({ ...base, supported: true, bytes: [...bytes], failure: null, detail: null });
            } catch (e) {
                const message = e instanceof Error ? e.message : String(e);
                // `readMemoryChunk` phrases a non-ACK as "rejected by DME"; the underlying status is
                // not carried up. That is enough to separate "the DME answered no" from "nothing
                // answered", which is the distinction that changes what the operator should do.
                const failure: RamProbeWindow['failure'] = /rejected by DME/i.test(message)
                    ? 'parameter-error'
                    : /timed out|timeout|not connected|port/i.test(message) ? 'transport' : 'rejected';
                windows.push({ ...base, supported: false, bytes: null, failure, detail: message });
            }
        }
        return { ok: windows.every(w => w.supported), windows };
    }

    async readDataChecksums(): Promise<{ slave: number; master: number }> {
        return this.withGate(async () => {
            this.assertConnected();
            const { slave, master } = Mss54HpDataTuneLayout;
            // Each half keeps its CRC at the same offset within itself, so one expression serves
            // both banks. Four bytes each: the CRC pair and its 0xFF 0xFF padding.
            const read = async (base: number) => {
                const bytes = await this.readRange(base + CHECKSUM_OFFSET_WITHIN_HALF, CHECKSUM_SLOT_LENGTH);
                return (bytes[0] << 8) | bytes[1];
            };
            return {
                slave: await read(slave.address),
                master: await read(master.address),
            };
        });
    }

    /**
     * One exchange, one block, no fallback. Reads the latched EGAS freeze-frame.
     *
     * Nothing here polls: the buffer at `0xFFDA48` is written once per fault and then latched, so
     * calling this twice returns the same bytes. It is kept as a diagnostic read.
     *
     * The retry is the same bounded, resync-first retry block 3 gets, and is safe for the same
     * reason: READ_IO_STATUS with a selection byte is an idempotent read.
     */
    private async readEgasFreezeFrameInner(): Promise<EgasMeasurement> {
        this.assertConnected();
        if (this.startTime === 0) this.startTime = performance.now();

        let frame: Ds2Frame | null = null;
        let lastError: unknown;
        for (let attempt = 1; attempt <= POLL_RETRY_ATTEMPTS; attempt++) {
            try {
                await this.resyncTransport();
                frame = await this.exchange(Ds2Control.READ_IO_STATUS, new Uint8Array([EGAS_MEASUREMENT_BLOCK.selection]));
                lastError = undefined;
                break;
            } catch (e) {
                lastError = e;
            }
        }
        if (!frame) throw lastError instanceof Error ? lastError : new DmeLinkError(String(lastError));
        if (!isPositiveResponse(frame)) throw new DmeLinkError('EGAS block (selection 83) read rejected by DME');
        // No length assertion beyond the decoder's own. An all-zero 52 bytes is the NORMAL answer on
        // a car that has never faulted, and throwing on it would turn a healthy result into an error.
        return { time: (performance.now() - this.startTime) / 1000, ...decodeEgasMeasurementBlock(frame.payload) };
    }

    /**
     * Selection 3, then one control-0x06 read of `INERTIA_RAM_READ`. Both required.
     *
     * Where `pollLiveMeasurementInner` lets its optional exchanges fail and leaves their channels
     * UNDEFINED, this substitutes nothing at all — not even an absence. A speed without a torque and
     * a torque without a speed are each half of one regression point, and the estimator's whole
     * defence against a wrong answer is that every sample it sees really came off the DME. A failed
     * exchange is a failed sample.
     *
     * The two exchanges are ~20 ms apart at 9600 and the stamp is taken after the second, so the
     * skew is a constant offset between the speed and the torque rather than jitter. That matters:
     * a constant lag shifts the fitted intercept, which the plausibility rail on `M_loss` can see,
     * whereas jitter would scatter the slope, which nothing can.
     */
    private async pollInertiaSampleInner(): Promise<InertiaSample> {
        this.assertConnected();
        if (this.startTime === 0) this.startTime = performance.now();

        // The same two helpers the VE poll uses, and for the same reasons. This used to resync
        // unconditionally before every attempt — a USB control transfer on Android for a buffer the
        // previous sample had already emptied — and then read its RAM chunk on the BULK budget:
        // five attempts with escalating settles, up to about four seconds, inside a loop that is
        // supposed to produce a sample every quarter of a second. It also inherited that path's
        // `aborted` latch, so a Cancel Read earlier in the session failed every inertia sample.
        const std = decodeStandardMeasurementBlock(await this.pollStandardBlock());
        if (std.rpm === null) throw new DmeLinkError('Selection 3 response was shorter than expected (no engine speed)');

        const { address } = INERTIA_RAM_READ;
        const ram = await this.pollRamChunk(INERTIA_RAM_READ);

        return {
            time: (performance.now() - this.startTime) / 1000,
            rpm: std.rpm,
            coolantTemp: std.coolantTemp,
            wdk1: std.wdk1 ?? null,
            rf: std.rf ?? null,
            mdIndNe: decodeRamSignal(Mss54HpRamSignals.MD_IND_NE, ram, address),
            mdDynSt: decodeRamSignal(Mss54HpRamSignals.MD_DYN_ST, ram, address),
        };
    }
    /** Last known values of the idle run's slow-lane channels, carried between reads. */
    private idleSlowLane: {
        llsTv: number | null; llrQvs: number | null; llrQsoll: number | null;
        engineState: number | null; kkosSt: number | null; llsSt: number | null;
        wdkWord: number | null; wdkSoll: number | null; egasSoll: number | null; egasMaxWdk: number | null;
        lfrZustand: number | null; lfrMdi: number | null; lfrIAfr: number | null;
        frRegler: number | null; fraMlAdaption: number | null;
        laFRegler1: number | null; laFRegler2: number | null;
        laaF1: number | null; laaF2: number | null; laaRegler1: number | null; laaRegler2: number | null;
        lwsLrw: number | null; mdResKath: number | null;
        mdResLrwRoh: number | null; mdResLrwSt: number | null; mdResLrw: number | null;
        evan1Ist: number | null; avan1Ist: number | null;
        evan1St: number | null; avan1St: number | null;
        vanEdSt: number | null; vanAdapSt: number | null;
        evan1IstFilt: number | null; evan1Soll: number | null;
        intakeTemp: number | null; ambientPressure: number | null;
        chargeTemp: number | null; altitude: number | null;
        ambientPressureSubstituted: boolean | undefined;
    } = {
        llsTv: null, llrQvs: null, llrQsoll: null, engineState: null, kkosSt: null, llsSt: null,
        wdkWord: null, wdkSoll: null, egasSoll: null, egasMaxWdk: null,
        lfrZustand: null, lfrMdi: null, lfrIAfr: null, frRegler: null, fraMlAdaption: null,
        laFRegler1: null, laFRegler2: null, laaF1: null, laaF2: null, laaRegler1: null, laaRegler2: null,
        lwsLrw: null, mdResKath: null, mdResLrwRoh: null, mdResLrwSt: null, mdResLrw: null,
        evan1Ist: null, avan1Ist: null, evan1St: null, avan1St: null,
        vanEdSt: null, vanAdapSt: null, evan1IstFilt: null, evan1Soll: null,
        intakeTemp: null, ambientPressure: null, chargeTemp: null, altitude: null,
        ambientPressureSubstituted: undefined as boolean | undefined,
    };

    private async pollIdleSampleInner(): Promise<IdleSample> {
        this.assertConnected();
        if (this.startTime === 0) this.startTime = performance.now();

        const index = this.idleSampleIndex++;
        const slowLaneDue = index % IDLE_SLOW_LANE_EVERY === 0;
        const surveyDue = index % IDLE_SURVEY_LANE_EVERY === 0;

        const std = decodeStandardMeasurementBlock(await this.pollStandardBlock());
        if (std.rpm === null) throw new DmeLinkError('Selection 3 response was shorter than expected (no engine speed)');

        const torque = await this.pollRamChunk(IDLE_TORQUE_RAM_READ);
        const t = IDLE_TORQUE_RAM_READ.address;

        // Carried forward between slow-lane reads, exactly as the VE poll carries block 19's four
        // channels. Doing it HERE rather than downstream is what stops the estimator ever learning
        // that a channel has two rates — and it is not cosmetic: a null kkosSt does not reject a
        // sample, so leaving three samples in four blank during a compressor cycle would admit 75 %
        // of the disturbance the gate exists to exclude.
        let llsTv = this.idleSlowLane.llsTv;
        let llrQvs = this.idleSlowLane.llrQvs;
        let llrQsoll = this.idleSlowLane.llrQsoll;
        let engineState = this.idleSlowLane.engineState;
        let kkosSt = this.idleSlowLane.kkosSt;
        let llsSt = this.idleSlowLane.llsSt;
        const carried = this.idleSlowLane;
        let { wdkWord, wdkSoll, egasSoll, egasMaxWdk } = carried;
        let { lfrZustand, lfrMdi, lfrIAfr, frRegler, fraMlAdaption } = carried;
        let { laFRegler1, laFRegler2, laaF1, laaF2, laaRegler1, laaRegler2 } = carried;
        let { lwsLrw, mdResKath, mdResLrwRoh, mdResLrwSt, mdResLrw } = carried;
        let { intakeTemp, ambientPressure, chargeTemp, altitude, ambientPressureSubstituted } = carried;
        let { evan1Ist, avan1Ist, evan1St, avan1St, vanEdSt, vanAdapSt } = carried;
        let { evan1IstFilt, evan1Soll } = carried;
        if (slowLaneDue) {
            // Best-effort, one at a time: a DME that refuses the actuator window should still give
            // up the engine state, and losing a diagnostic must not cost the sample its torque.
            try {
                const act = await this.pollRamChunk(IDLE_ACTUATOR_RAM_READ);
                const a = IDLE_ACTUATOR_RAM_READ.address;
                llsTv = decodeRamSignal(Mss54HpRamSignals.LLS_TV, act, a);
                llrQvs = decodeRamSignal(Mss54HpRamSignals.LLR_QVS, act, a);
                llrQsoll = decodeRamSignal(Mss54HpRamSignals.LLR_QSOLL, act, a);
            } catch { /* stays null — see the doc comment */ }
            try {
                const st = await this.pollRamChunk(ENGINE_STATE_RAM_READ);
                engineState = decodeRamSignal(Mss54HpRamSignals.ZUSTAND_MOTOR, st, ENGINE_STATE_RAM_READ.address);
            } catch { /* stays null */ }
            try {
                const kk = await this.pollRamChunk(COMPRESSOR_RAM_READ);
                kkosSt = decodeRamSignal(Mss54HpRamSignals.KKOS_ST, kk, COMPRESSOR_RAM_READ.address);
            } catch { /* stays null */ }
            // The section 7.1 preconditions. Same best-effort discipline, and it matters more here:
            // these decide whether the run means anything, so losing one must cost that verdict and
            // not the sample it rode in on.
            try {
                const g = await this.pollRamChunk(IDLE_GOVERNOR_RAM_READ);
                const a = IDLE_GOVERNOR_RAM_READ.address;
                frRegler = decodeRamSignal(Mss54HpRamSignals.FR_REGLER, g, a);
                fraMlAdaption = decodeRamSignal(Mss54HpRamSignals.FRA_ML_ADAPTION, g, a);
                lfrMdi = decodeRamSignal(Mss54HpRamSignals.LFR_MDI, g, a);
                lfrZustand = decodeRamSignal(Mss54HpRamSignals.LFR_ZUSTAND, g, a);
                lfrIAfr = decodeRamSignal(Mss54HpRamSignals.LFR_I_AFR, g, a);
            } catch { /* stays null */ }
            try {
                const th = await this.pollRamChunk(IDLE_THROTTLE_RAM_READ);
                const a = IDLE_THROTTLE_RAM_READ.address;
                egasSoll = decodeRamSignal(Mss54HpRamSignals.EGAS_SOLL, th, a);
                egasMaxWdk = decodeRamSignal(Mss54HpRamSignals.EGAS_MAX_WDK, th, a);
                wdkSoll = decodeRamSignal(Mss54HpRamSignals.WDK_SOLL, th, a);
            } catch { /* stays null */ }
            try {
                const w = await this.pollRamChunk(IDLE_WDK_RAM_READ);
                wdkWord = decodeRamSignal(Mss54HpRamSignals.WDK_WORD, w, IDLE_WDK_RAM_READ.address);
            } catch { /* stays null */ }
        }
        if (surveyDue) {
            // Bit 7 is what decides which table TI_F_STAT comes from, and it is latched by a
            // diagnosis rather than moved by a dwell — so the slowest lane is the right one.
            try {
                const ls = await this.pollRamChunk(IDLE_VALVE_STATE_RAM_READ);
                llsSt = decodeRamSignal(Mss54HpRamSignals.LLS_ST, ls, IDLE_VALVE_STATE_RAM_READ.address);
            } catch { /* stays null */ }
            try {
                const l = await this.pollRamChunk(IDLE_LAMBDA_LEARN_RAM_READ);
                const a = IDLE_LAMBDA_LEARN_RAM_READ.address;
                laFRegler1 = decodeRamSignal(Mss54HpRamSignals.LA_F_REGLER1, l, a);
                laFRegler2 = decodeRamSignal(Mss54HpRamSignals.LA_F_REGLER2, l, a);
                laaF1 = decodeRamSignal(Mss54HpRamSignals.LAA_F1, l, a);
                laaF2 = decodeRamSignal(Mss54HpRamSignals.LAA_F2, l, a);
                laaRegler1 = decodeRamSignal(Mss54HpRamSignals.LAA_REGLER1, l, a);
                laaRegler2 = decodeRamSignal(Mss54HpRamSignals.LAA_REGLER2, l, a);
            } catch { /* stays null */ }
            // The additive store the cluster above does not include — and at a stationary idle,
            // the only long-term store whose learning zone is open. Other RAM window, so it is its
            // own exchange.
            // Both reserves in one telegram, because what the verdict wants is their MAXIMUM and a
            // maximum taken across two moments is not a maximum. The steering angle is a second
            // exchange only because it lives in the other window.
            try {
                const rv = await this.pollRamChunk(IDLE_RESERVE_RAM_READ);
                const a = IDLE_RESERVE_RAM_READ.address;
                mdResKath = decodeRamSignal(Mss54HpRamSignals.MD_RES_KATH, rv, a);
                mdResLrwRoh = decodeRamSignal(Mss54HpRamSignals.MD_RES_LRW_ROH, rv, a);
                mdResLrwSt = decodeRamSignal(Mss54HpRamSignals.MD_RES_LRW_ST, rv, a);
                mdResLrw = decodeRamSignal(Mss54HpRamSignals.MD_RES_LRW, rv, a);
            } catch { /* stays null */ }
            try {
                const lw = await this.pollRamChunk(IDLE_STEERING_RAM_READ);
                lwsLrw = decodeRamSignal(Mss54HpRamSignals.LWS_LRW, lw, IDLE_STEERING_RAM_READ.address);
            } catch { /* stays null */ }
            // The air of the day. Survey lane, because it is weather: RF_PT_KORR moves with intake
            // temperature over minutes and with ambient pressure over a drive, and asking four times
            // a second would buy nothing and cost a quarter of the run's rate. Same read the VE poll
            // uses, so the two runs cannot disagree about what the density correction was.
            try {
                const amb = await this.pollRamChunk(AMBIENT_CHARGE_RAM_READ);
                const d = decodeAmbientCharge(amb, AMBIENT_CHARGE_RAM_READ.address);
                intakeTemp = d.intakeTemp ?? null;
                ambientPressure = d.ambientPressure ?? null;
                chargeTemp = d.chargeTemp ?? null;
                altitude = d.altitude ?? null;
                ambientPressureSubstituted = d.ambientPressureSubstituted;
            } catch { /* stays null */ }
            // The cams, the latch and the blocked-balance flag in ONE telegram — see the read's own
            // note. Split apart they would be three facts about three moments.
            try {
                const v = await this.pollRamChunk(IDLE_VANOS_RAM_READ);
                const a = IDLE_VANOS_RAM_READ.address;
                evan1Ist = decodeRamSignal(Mss54HpRamSignals.EVAN1_IST, v, a);
                avan1Ist = decodeRamSignal(Mss54HpRamSignals.AVAN1_IST, v, a);
                evan1St = decodeRamSignal(Mss54HpRamSignals.EVAN1_ST, v, a);
                avan1St = decodeRamSignal(Mss54HpRamSignals.AVAN1_ST, v, a);
                vanEdSt = decodeRamSignal(Mss54HpRamSignals.VAN_ED_ST, v, a);
                vanAdapSt = decodeRamSignal(Mss54HpRamSignals.VAN_ADAP_ST, v, a);
            } catch { /* stays null */ }
            try {
                const vt = await this.pollRamChunk(IDLE_VANOS_TARGET_RAM_READ);
                const a = IDLE_VANOS_TARGET_RAM_READ.address;
                evan1IstFilt = decodeRamSignal(Mss54HpRamSignals.EVAN1_IST_FILT, vt, a);
                evan1Soll = decodeRamSignal(Mss54HpRamSignals.EVAN1_SOLL, vt, a);
            } catch { /* stays null */ }
        }
        if (slowLaneDue || surveyDue) {
            this.idleSlowLane = {
                llsTv, llrQvs, llrQsoll, engineState, kkosSt, llsSt,
                wdkWord, wdkSoll, egasSoll, egasMaxWdk,
                lfrZustand, lfrMdi, lfrIAfr, frRegler, fraMlAdaption,
                laFRegler1, laFRegler2, laaF1, laaF2, laaRegler1, laaRegler2,
                lwsLrw, mdResKath, mdResLrwRoh, mdResLrwSt, mdResLrw,
                intakeTemp, ambientPressure, chargeTemp, altitude, ambientPressureSubstituted,
                evan1Ist, avan1Ist, evan1St, avan1St, vanEdSt, vanAdapSt,
                evan1IstFilt, evan1Soll,
            };
        }

        const ub = std.ub ?? null;
        const ubPlausible = ub !== null && ub >= UB_PLAUSIBLE.min && ub <= UB_PLAUSIBLE.max;

        return {
            time: (performance.now() - this.startTime) / 1000,
            rpm: std.rpm,
            coolantTemp: std.coolantTemp,
            wdk1: std.wdk1 ?? null,
            rf: std.rf ?? null,
            nSoll: std.llrNSoll ?? null,
            ub: ubPlausible ? ub : null,
            mdLlri: decodeRamSignal(Mss54HpRamSignals.MD_LLRI, torque, t),
            mdLlra: decodeRamSignal(Mss54HpRamSignals.MD_LLRA, torque, t),
            mdLlraKo: decodeRamSignal(Mss54HpRamSignals.MD_LLRA_KO, torque, t),
            // Same telegram as the three above — that is the point of the twenty-byte read.
            mdRfSoll: decodeRamSignal(Mss54HpRamSignals.MD_RF_SOLL, torque, t),
            mlSoll: decodeRamSignal(Mss54HpRamSignals.ML_SOLL, torque, t),
            mdRfKorr: decodeRamSignal(Mss54HpRamSignals.MD_RF_KORR, torque, t),
            mlSollLls: decodeRamSignal(Mss54HpRamSignals.ML_SOLL_LLS, torque, t),
            mlSollMaxLls: decodeRamSignal(Mss54HpRamSignals.ML_SOLL_MAX_LLS, torque, t),
            llsTv, llrQvs, llrQsoll, engineState, kkosSt, llsSt,
            wdkWord, wdkSoll, egasSoll, egasMaxWdk,
            lfrZustand, lfrMdi, lfrIAfr, frRegler, fraMlAdaption,
            laFRegler1, laFRegler2, laaF1, laaF2, laaRegler1, laaRegler2,
            lwsLrw, mdResKath, mdResLrwRoh, mdResLrwSt, mdResLrw,
            intakeTemp, ambientPressure, chargeTemp, altitude, ambientPressureSubstituted,
            evan1Ist, avan1Ist, evan1St, avan1St, vanEdSt, vanAdapSt,
            evan1IstFilt, evan1Soll,
            mdLlriSource: 'ram',
        };
    }

    /**
     * One sample: the profile's exchange list, run in order.
     *
     * ## What each exchange is allowed to cost the sample
     *
     * Block 3 is the sample. It carries rpm and relative opening, and without them there is nothing
     * to record — so it, and only it, is fatal, and it gets the resync + bounded retry it needs to
     * survive whatever an earlier failed operation left in the buffer. Retrying is safe here
     * specifically because READ_IO_STATUS with a selection byte is a pure idempotent read;
     * readAdaptationBlock already retries the identical control byte. **This must never be widened
     * to WRITE_MEMORY or sendProgrammingControl.**
     *
     * Everything else is best-effort. A missing lambda trim leaves `stft1`/`stft2` UNDEFINED rather
     * than 1.0, and that distinction is the whole point: 1.0 means "the controller wanted no
     * correction", which is a measurement, and handing it back for an exchange that did not happen
     * is the same class of lie as labelling `la_f_regler` "Lambda 1". The VE map cannot be built from
     * a log full of undefined — which is correct.
     *
     * ## The slow lane
     *
     * `every: 8` on block 19 means it is fetched on samples 0, 8, 16… and its channels are carried
     * forward in between. Four channels live nowhere else (`tetv`, `tefc_ll_st`, `tefc_ed`,
     * `la_freeze_flag`), two of them in slave RAM this calibration will not serve at all; all four
     * are slow latching state, so 1.6 s of resolution loses nothing. The carry-forward happens here
     * rather than downstream so `LogDataPoint`, the CSV, the filters and verify:incremental never
     * learn that a channel has two rates.
     */
    private async pollLiveMeasurementInner(): Promise<LiveMeasurement> {
        this.assertConnected();
        if (this.startTime === 0) this.startTime = performance.now();

        const index = this.liveSampleIndex++;
        const due = (x: LogExchange) => index % Math.max(1, x.every ?? 1) === 0;

        let std: ReturnType<typeof decodeStandardMeasurementBlock> | null = null;
        let stft1: number | undefined;
        let stft2: number | undefined;
        let ltft1: number | undefined;
        let ltft2: number | undefined;
        let stftSource: 'ram' | 'block19' | undefined;
        let slowLane: SlowLaneChannels | null = null;
        let density: Partial<SlowLaneChannels> | null = null;
        let ambient: Partial<SlowLaneChannels> | null = null;
        let idleValve: Partial<SlowLaneChannels> | null = null;
        // Two exchanges, two locals, for the same reason the density cluster has its own: they sit
        // on the same lane and a single variable would let whichever decoded last erase the other.
        // NOT carried between samples — see SlewChannels for why an event must not be held.
        let slewState: Partial<SlewChannels> | null = null;
        let slewTorque: Partial<SlewChannels> | null = null;

        for (const exchange of this.liveExchanges) {
            if (!due(exchange)) continue;

            if (exchange.kind === 'ram') {
                try {
                    const bytes = await this.pollRamChunk(exchange);
                    // Dispatched on the address, not on "it is a RAM read". There are two of them in
                    // a VE list now and they mean entirely different things; decoding the intake
                    // temperature as a lambda trim would produce a plausible number (one byte at
                    // 2^-15) and poison the map with it.
                    if (exchange.address === AMBIENT_CHARGE_ADDRESS) {
                        // Into a local, not straight into the carry. Both slow-lane exchanges sit on
                        // the same `every: 8`, so writing here and letting the post-loop assignment
                        // replace the whole object wiped whichever ran first — that is exactly what
                        // happened to the intake temperature on the drive it was introduced for,
                        // 4,836 samples of 4,836. Merged after the loop instead.
                        density = decodeAmbientCharge(bytes, exchange.address);
                        continue;
                    }
                    if (exchange.address === IDLE_VALVE_STATE_ADDRESS) {
                        idleValve = decodeIdleValveState(bytes, exchange.address);
                        continue;
                    }
                    if (exchange.address === SLEW_STATE_ADDRESS) {
                        slewState = decodeSlewState(bytes, exchange.address);
                        continue;
                    }
                    if (exchange.address === SLEW_TORQUE_ADDRESS) {
                        slewTorque = decodeSlewTorque(bytes, exchange.address);
                        continue;
                    }
                    if (exchange.address === AMBIENT_TEMP_ADDRESS) {
                        // The word decode to compare the byte against comes from THIS sample when
                        // both lanes happen to land together, and from the carry otherwise — the
                        // two clusters run at different rates, so most of the time they do not.
                        ambient = decodeAmbientTemp(bytes, exchange.address,
                            density?.ambientPressure ?? this.lastSlowLane.ambientPressure);
                        continue;
                    }
                    const b1 = decodeRamSignal(Mss54HpRamSignals.LA_F_REGLER1, bytes, exchange.address);
                    const b2 = decodeRamSignal(Mss54HpRamSignals.LA_F_REGLER2, bytes, exchange.address);
                    if (b1 !== null) { stft1 = b1; stftSource = 'ram'; }
                    if (b2 !== null) stft2 = b2;
                    // The long-term store, out of the same eight bytes. `la_f_regler` above is the
                    // two-point controller's output; this is where its mean has been learned to,
                    // and at a settled warm idle almost the whole standing error lives here.
                    const l1 = decodeRamSignal(Mss54HpRamSignals.LAA_F1, bytes, exchange.address);
                    const l2 = decodeRamSignal(Mss54HpRamSignals.LAA_F2, bytes, exchange.address);
                    if (l1 !== null) ltft1 = l1;
                    if (l2 !== null) ltft2 = l2;
                } catch {
                    // Same treatment as a missing block: leave the channel undefined, and resync so a
                    // latched break is not reported as a healthy sample that guarantees the next one
                    // dies. Guarded because resyncTransport can throw when the device is gone.
                    try { await this.resyncTransport(); } catch { }
                }
                continue;
            }

            if (exchange.selection === STANDARD_MEASUREMENT_BLOCK.selection) {
                std = decodeStandardMeasurementBlock(await this.pollStandardBlock());
                continue;
            }

            try {
                const frame = await this.exchange(Ds2Control.READ_IO_STATUS, new Uint8Array([exchange.selection]));
                if (!isPositiveResponse(frame)) continue;
                if (exchange.selection !== OPERATING_MEASUREMENTS_BLOCK.selection) continue;
                const op = decodeOperatingMeasurementsBlock(frame.payload);
                const block19Trim = op.stft1 ?? undefined;
                slowLane = {
                    tankVent: op.tankVent ?? undefined,
                    tankVentCheckState: op.tankVentCheckState ?? undefined,
                    tankVentDiag: op.tankVentDiag ?? undefined,
                    lambdaFreeze: op.lambdaFreeze ?? undefined,
                };
                // The RAM claim, re-checked against the block that is the authority for it — for
                // free, on every slow-lane sample, for the whole drive. Reported, never acted on:
                // switching the source mid-run would leave one log holding two measurements.
                if (stftSource === 'ram') {
                    if (lambdaTrimAgrees(stft1, block19Trim)) {
                        this.lambdaDriftRun = 0;
                    } else if (++this.lambdaDriftRun === LAMBDA_TRUTH_GATE.driftWarnAfter) {
                        this.events.push(`RAM lambda trim has disagreed with block 19 ${this.lambdaDriftRun} times running `
                            + `(${stft1?.toFixed(4) ?? '-'} vs ${block19Trim?.toFixed(4) ?? '-'}). Recorded, not switched.`);
                    }
                } else {
                    // No RAM read in this list, so block 19 IS the source.
                    stft1 = block19Trim;
                    stft2 = op.stft2 ?? undefined;
                    if (stft1 !== undefined) stftSource = 'block19';
                }
            } catch {
                try { await this.resyncTransport(); } catch { }
            }
        }

        if (!std) throw new DmeLinkError('Live sample has no standard measurement block (selection 3)');
        if (std.rpm === null || std.rawLoad === null) {
            throw new DmeLinkError('Standard measurement block response was shorter than expected');
        }

        // Carried forward, so the block-19-only channels and the intake temperature are present on
        // every sample rather than on one in eight. A fresh read overwrites its own channels;
        // nothing here can invent a channel this run has never seen, because the carry starts empty.
        //
        // MERGED, not replaced. The two slow-lane exchanges are independent — block 19 and a RAM
        // byte — and replacing the whole object meant whichever ran first lost. That is exactly what
        // happened to the intake temperature on the drive it was introduced for.
        this.lastSlowLane = mergeSlowLane(this.lastSlowLane, slowLane, density, ambient, idleValve);

        return {
            time: (performance.now() - this.startTime) / 1000,
            rpm: std.rpm,
            rawLoad: std.rawLoad,
            stft1,
            ltft1,
            ltft2,
            stft2,
            stftSource,
            coolantTemp: std.coolantTemp ?? undefined,
            // Same 35-byte response, no extra round trip. Both are `?? undefined` for the same
            // reason coolantTemp is: decodeField returns null on a short block, and a null there
            // must stay distinguishable from a genuine 0 °C / 0 % reading.
            rf: std.rf ?? undefined,
            exhaustTemp: std.exhaustTemp ?? undefined,
            wdk1: std.wdk1 ?? undefined,
            ...this.lastSlowLane,
            // AFTER the carry and never inside it: present on the sample that read them, absent on
            // every other, so a count of them is a count of reads. See SlewChannels.
            ...slewState,
            ...slewTorque,
        };
    }

    /**
     * Block 3, with the retry the sample depends on.
     *
     * The resync is conditional on the FIRST attempt and unconditional on a retry. It exists because
     * this used to be the one user-initiated first exchange with no purge, so it inherited any desync
     * an earlier failed operation left behind — reasoning about recovering from a mess, which holds
     * on a retry. On the happy path there is nothing to purge (the previous sample consumed its whole
     * response), and on WebUSB `purge()` is a USB control transfer paid several times a second for a
     * buffer that is already empty. `bufferedLength() > 0 || hasReadError()` is the same test the
     * read path uses, so a latched error or a stale tail still triggers it.
     */
    private async pollStandardBlock(): Promise<Uint8Array> {
        let frame: Ds2Frame | null = null;
        let error: unknown;
        for (let attempt = 1; attempt <= POLL_RETRY_ATTEMPTS; attempt++) {
            try {
                if (attempt > 1 || this.transport.bufferedLength() > 0 || this.transport.hasReadError()) {
                    await this.resyncTransport();
                }
                frame = await this.exchange(Ds2Control.READ_IO_STATUS, new Uint8Array([STANDARD_MEASUREMENT_BLOCK.selection]));
                error = undefined;
                break;
            } catch (e) {
                error = e;
            }
        }
        if (!frame) throw error instanceof Error ? error : new DmeLinkError(String(error));
        if (!isPositiveResponse(frame)) throw new DmeLinkError('Standard measurement block read rejected by DME');
        return frame.payload;
    }

    /**
     * A RAM read on the POLL budget: two attempts, no delay, resync only if the transport says so.
     *
     * Deliberately not `readMemoryChunkWithRetry`. That one is the bulk-read budget — five attempts
     * with escalating 300-1600 ms settles, up to about four seconds — which is right for a chunk of
     * a 65 KB image that must not be re-read from the start, and catastrophic inside a poll loop
     * running four times a second. It also checks and honours the `aborted` latch, which belongs to
     * Cancel Read and has nothing to do with a datalog.
     */
    private async pollRamChunk(read: { segment: number; address: number; count: number }): Promise<Uint8Array> {
        let error: unknown;
        for (let attempt = 1; attempt <= POLL_RETRY_ATTEMPTS; attempt++) {
            try {
                if (attempt > 1 || this.transport.bufferedLength() > 0 || this.transport.hasReadError()) {
                    await this.resyncTransport();
                }
                return await this.readMemoryChunk(read.segment, read.address, read.count);
            } catch (e) {
                error = e;
            }
        }
        throw error instanceof Error ? error : new DmeLinkError(String(error));
    }

    private assertAdaptationsAvailable() {
        this.assertConnected();
        if (this.everBoosted) {
            throw new DmeLinkError(
                'Adaptations need a normal 9600 DS2 session, and this session has switched baud for a ' +
                'read. Disconnect and reconnect before resetting adaptations.',
            );
        }
    }

    /**
     * Waits for the K-line to go quiet, then clears the buffer, so the following exchange's echo read
     * sees only its own request's echo.
     *
     * This is the fix for a real-vehicle "Unexpected K-line echo" that recurred on all three retries.
     * Something before the reset (a prior identify/read whose response was still trickling in) left
     * the DME streaming a tail. A plain purge races that tail — bytes land between the purge and the
     * echo read, so the read consumes the tail instead of the echo and every attempt mismatches.
     * Purging only after a full quiet window has passed with nothing new arriving cannot race it.
     * READ and START TUNE happen not to run on top of such a tail, which is why only the reset hit it.
     */
    private async drainUntilQuiet(): Promise<void> {
        let breakRounds = 0;
        for (let round = 0; round < DRAIN_MAX_ROUNDS; round++) {
            const wasBroken = this.transport.hasReadError();
            // Stop cycling the reader once a few real settle windows haven't helped. Continuing would
            // only churn: nine cancel/re-acquire cycles in two seconds is what made a break on this
            // path survive every automatic attempt while a manual retry seconds later succeeded.
            if (wasBroken && ++breakRounds > BREAK_RECOVERY_ROUNDS) break;
            // Guarded: resyncTransport can now throw when the device is gone. Draining is preparation,
            // not the operation, so a failure here must not pre-empt the real DS2 error the caller is
            // about to produce — it just means this round couldn't clean up.
            try { await this.resyncTransport(); } catch { }
            // A stale tail clears in a moment; a disturbed line needs genuine silence, escalating.
            await delay(wasBroken ? BREAK_SETTLE_MS * breakRounds : DRAIN_QUIET_MS);
            // Quiet means both empty AND no error: a break latches the pump and stops new bytes, so
            // an empty buffer alone would read as "quiet" on a dead line.
            if (this.transport.bufferedLength() === 0 && !this.transport.hasReadError()) return;
        }
        try { await this.resyncTransport(); } catch { }
    }

    /** Readies the read side for a fresh attempt: a latched break needs the pump restarted; a plain
     *  stale tail just needs the buffer dropped. Used before every adaptation exchange and between
     *  retries, so neither a leftover response nor a break carries into the next request — or into a
     *  later START TUNE, which was the real-vehicle symptom. */
    private async resyncTransport(): Promise<void> {
        if (this.transport.hasReadError()) await this.transport.recoverRead();
        else this.transport.purge();
    }

    /**
     * Runs one adaptation exchange, resynchronizing the transport around failures.
     *
     * This is the fix for a real-vehicle bug: a failed reset left the next START TUNE unable to log
     * until a reconnect. A timed-out or mismatched DS2 exchange can leave unread bytes buffered (the
     * background pump keeps draining the port), and the next request then reads that stale tail and
     * fails too. pollLiveMeasurement's first block is critical and doesn't purge, so it inherited the
     * desync. Purging before every attempt — and once more before giving up — stops a failed
     * adaptation op from desyncing everything after it. The pause before each retry matters as much
     * as the purge: it lets a late or partial response finish arriving so the next purge clears it,
     * rather than purging into a buffer that is still filling.
     */
    private async adaptationExchangeWithRetry(
        control: number, payload: Uint8Array, timeoutMs: number, describe: string,
    ): Promise<Ds2Frame> {
        let lastError: unknown;
        for (let attempt = 1; attempt <= ADAPT_RETRY_ATTEMPTS; attempt++) {
            try {
                // Inside the try on purpose: resyncTransport can throw (device gone), and outside it
                // that throw would escape the loop entirely, discarding the remaining attempts and
                // replacing the actual DS2 diagnosis with a recovery error.
                await this.resyncTransport();
                // Let the line settle after the purge before transmitting into it.
                await delay(RESYNC_SETTLE_MS);

                // BUSY is the DME saying "still working", not "no". Re-ask on its own budget so a
                // slow EEPROM commit cannot burn the transport retries that exist for line faults.
                let frame = await this.exchange(control, payload, timeoutMs);
                for (let busy = 0; frame.controlOrStatus === Ds2Status.BUSY && busy < BUSY_POLL_ATTEMPTS; busy++) {
                    await delay(BUSY_POLL_INTERVAL_MS);
                    frame = await this.exchange(control, payload, timeoutMs);
                }

                if (!isPositiveResponse(frame)) {
                    const status = frame.controlOrStatus;
                    throw new DmeLinkError(
                        `${describe} rejected by DME (status 0x${status.toString(16)}` +
                        `${status === Ds2Status.BUSY ? ' — still BUSY after retrying' : ''})`,
                    );
                }
                return frame;
            } catch (e) {
                lastError = e;
                // Escalating, and longer after a break: a flat 300ms gave the line barely a second of
                // total settling across all three attempts, which is why the automatic retries kept
                // failing where a manual retry a few seconds later worked.
                //
                // Skipped after the final attempt — there is nothing left to settle for, and paying it
                // anyway delayed the user's error by up to 1.2 s. readMemoryChunkWithRetry already
                // guards this the same way.
                if (attempt < ADAPT_RETRY_ATTEMPTS) {
                    const base = this.transport.hasReadError() ? BREAK_SETTLE_MS : ADAPT_RETRY_DELAY_MS;
                    await delay(base * attempt);
                }
            }
        }
        // Leave the transport usable for whatever runs next — most importantly a START TUNE poll.
        // Guarded so a failed cleanup can't overwrite lastError one line before we report it.
        try { await this.resyncTransport(); } catch { }
        throw lastError instanceof Error ? lastError : new DmeLinkError(String(lastError));
    }

    /** Reads one adaptation block. Same request shape as a live-measurement poll — control 0x0B with
     *  a one-byte selection — just a different block. */
    private async readAdaptationBlock(block: { selection: number; fields: readonly FieldDef[] }): Promise<Uint8Array> {
        const describe = `Adaptation block 0x${block.selection.toString(16)} read`;
        const frame = await this.adaptationExchangeWithRetry(
            Ds2Control.READ_IO_STATUS, new Uint8Array([block.selection]), RESPONSE_TIMEOUT_MS, describe,
        );
        // A short payload that still checksums used to pass silently: decodeField bounds-checks and
        // returns null per field, so the dialog rendered a full table of dashes and called it a
        // reading. Name it instead — the bulk read already asserts its own length this way.
        const need = minPayloadLength(block.fields);
        if (frame.payload.length < need) {
            throw new DmeLinkError(
                `${describe} returned ${frame.payload.length} bytes, need at least ${need} to decode its fields`,
            );
        }
        return frame.payload;
    }

    /**
     * Reads the learned adaptation values. Unlike pollLiveMeasurement — which tolerates a missing
     * optional exchange and records the channel as absent, so a long log run is not lost to one bad
     * sample — both blocks are required here. A half-read snapshot shown next to post-clear values
     * would invite exactly the wrong conclusion about what the clear did.
     */
    async readAdaptations(): Promise<AdaptationSnapshot> {
        return this.withGate(async () => {
            this.assertAdaptationsAvailable();
            await this.drainUntilQuiet();
            return this.readBothAdaptationBlocks();
        });
    }

    /** The two reads without the drain in front, so clearTuneAdaptations can re-read after its settle
     *  without paying for a second quiet window. It had been calling the public readAdaptations, which
     *  drained again — a guaranteed-passing 150 ms round on a line that had just been silent for two
     *  seconds by construction. */
    private async readBothAdaptationBlocks(): Promise<AdaptationSnapshot> {
        const std = await this.readAdaptationBlock(STANDARD_ADAPTATIONS_BLOCK);
        const obs = await this.readAdaptationBlock(OBSERVATION_ADAPTATIONS_BLOCK);
        return buildAdaptationSnapshot(std, obs);
    }

    /**
     * Clears the tune-relevant adaptations and re-reads them once the DME has committed.
     *
     * No login() first, unlike readPartialBin/writePartialBin: control 0x43 needs no seed/key (none
     * of the reference's clear options set RequiresUnlock). Retried like the reads, and safe to
     * retry: clearing is idempotent, so re-sending the same mask after a mangled reply just clears
     * the same values again.
     */
    async clearTuneAdaptations(): Promise<AdaptationSnapshot> {
        return this.withGate(() => this.clearTuneAdaptationsInner());
    }

    /**
     * Clears VANOS adaptation only — the prerequisite for the max-power cam sweep, which drives cam
     * targets over DS2 and cannot tolerate a learned offset between commanded and actual position.
     *
     * Separate from clearTuneAdaptations because it is a separate decision with a separate reason,
     * not a parameterisation of the same one. A re-tune must NOT clear this (see
     * TUNE_ADAPTATION_CLEAR); the cam sweep must.
     */
    async clearVanosAdaptations(): Promise<AdaptationSnapshot> {
        return this.withGate(() => this.clearAdaptationsInner(VANOS_ADAPTATION_CLEAR, 'VANOS adaptation clear'));
    }

    private clearTuneAdaptationsInner(): Promise<AdaptationSnapshot> {
        return this.clearAdaptationsInner(TUNE_ADAPTATION_CLEAR, 'Adaptation clear');
    }

    private async clearAdaptationsInner(
        set: { readonly mask1: number; readonly mask2: number },
        describe: string,
    ): Promise<AdaptationSnapshot> {
        this.assertAdaptationsAvailable();
        await this.drainUntilQuiet();
        const { mask1, mask2 } = set;
        await this.adaptationExchangeWithRetry(
            Ds2Control.CLEAR_ADAPTATIONS, buildClearAdaptationsPayload(mask1, mask2), ADAPT_CLEAR_TIMEOUT_MS,
            describe,
        );
        // A flat wait, kept deliberately. The tempting replacement — poll the block and stop as soon
        // as the read succeeds — does not work: a premature read does not fail, it succeeds and hands
        // back the OLD values. Success is not evidence of commitment, and the one thing that could
        // test for it (comparing against AdaptationFieldDef.cleared) is explicitly ruled out there,
        // because two of the twelve rows clear to 1.0 rather than 0. So the floor stays; only the
        // re-read after it is retried, which is what adaptationExchangeWithRetry already provides.
        await delay(ADAPT_SETTLE_MS);
        return this.readBothAdaptationBlocks();
    }

    /**
     * Tester-present. Best effort by design: returns false rather than throwing, and skips entirely
     * when any real operation holds the gate — a keep-alive that interrupted a flash to prove the
     * link was alive would be worse than the silence it is preventing.
     */
    async keepAlive(): Promise<boolean> {
        if (!this.connected || this.gateHeld) return false;
        // The try wraps withGate, not just the exchange: this is called from a timer with nothing to
        // catch it, so a rejection here would surface as an unhandled promise rejection rather than
        // as anything a user could act on. Everything about a heartbeat is best-effort, including
        // losing the race for the gate.
        try {
            return await this.withGate(async () => {
                const frame = await this.exchange(Ds2Control.KEEP_ALIVE, new Uint8Array(0));
                return isPositiveResponse(frame);
            });
        } catch {
            // Deliberately silent. The next real operation reports the link's actual state; raising
            // an error banner for a request the user never made would only be noise.
            return false;
        }
    }
}
