import { DmeLink, DmeIdentity, LiveMeasurement, TransferProgress, DmeLinkError, ServiceBlockErasedCause, ServiceBlockDump } from './types';
import { ServiceBlockPointers } from './serviceBlockReport';
import { WebSerialTransport } from './webSerialTransport';
import {
    Ds2Frame, Ds2Control, Ds2ProgrammingControl, Ds2BaudRate, Ds2BaudRateSpec, Ds2SupportedBaud, ds2BaudSpecFor,
    Mss54HpDataTuneLayout, DS2_DEFAULT_ADDRESS,
    buildDs2Frame, parseDs2Frame, frameToBytes, isPositiveResponse,
    buildSeedRequestPayload, buildKeyPayload, isAlreadyUnlockedResponse, isSeedResponse, calculateLoginKey,
    buildReadMemoryPayload, buildWriteMemoryPayload, parseWriteResult, describeVerifyByte,
    TUNE_ADAPTATION_CLEAR, buildClearAdaptationsPayload, classifyEchoMismatch, Ds2Status,
} from './ds2';
import {
    parseSystemAddressTable, findPointer, parseAifEntries, latestPopulatedAifEntry,
    parseZifProgramNumber, AIF_TOTAL_LENGTH,
} from './identity';
import { STANDARD_MEASUREMENT_BLOCK, OPERATING_MEASUREMENTS_BLOCK, decodeStandardMeasurementBlock, decodeOperatingMeasurementsBlock } from './liveValueBlocks';
import { FieldDef } from './blockDecoder';
import {
    AdaptationSnapshot, STANDARD_ADAPTATIONS_BLOCK, OBSERVATION_ADAPTATIONS_BLOCK, buildAdaptationSnapshot,
    minPayloadLength,
} from './adaptationBlocks';
import {
    FlashCounterInfo, ServiceBlockLayout, SERVICE_BLOCK_PAIR_LENGTH, CLEAR_PREP_MARKER,
    analyzeFlashCounter, extractCounterFromServiceBlock, buildResetServiceBlockImage,
    shouldWriteClearPrepMarker, hasIntactAif, FLASH_COUNTER_RESET_ENABLED,
} from './flashCounter';

// DS2 system-address-table pointer indices (Ds2KnownSystemAddressLengths / IdentifyService)
const SYSTEM_ADDRESS_INDEX = { DIF: 15, ZIF_BACKUP: 16, BRIF: 18, ZIF: 19, AIF: 20 } as const;
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
 * Real DME connection over a K+DCAN-style cable via the Web Serial API, using the BMW DS2
 * protocol. Requires Chrome/Edge desktop and must be initiated from a genuine user gesture
 * (the browser's serial port picker cannot be triggered programmatically).
 *
 * Read/write addressing for the MSS54HP "DataTune" partial BIN, identity (VIN/AIF/software
 * version) parsing, and the live-measurement block layout are all confirmed against the
 * reference Mss54Ds2Tool source (see ds2.ts, identity.ts, liveValueBlocks.ts) — none of this
 * has been exercised against a real DME yet, since navigator.serial's port picker requires a
 * genuine user click that cannot be automated.
 */
export class WebSerialDmeLink implements DmeLink {
    private transport = new WebSerialTransport();
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
        try { return await fn(); } finally { this.gateHeld = false; }
    }
    /**
     * Baud rate to use for the bulk read. 9600 by default — proven, and it sends no switch at all.
     * 38400 is also proven on a real vehicle. Anything faster requires a 0x91 switch plus a local
     * port close/reopen: 125000 (the reference's programming rate) reproducibly fails here, and
     * 57600/76800/115200 are untested candidates between the two. See Ds2SupportedBaud.
     */
    private readonly readBaud: Ds2SupportedBaud;
    /**
     * Set once a baud boost has actually been accepted, and never cleared. Adaptation reads/clears
     * need a normal 9600 session; readPartialBin does try to hand the session back at 9600, but that
     * restore is best-effort by design (see its finally block), so "we restored it" is not something
     * this class can honestly claim. The reference refuses adaptation work for the rest of the
     * session on the same grounds (AdaptationService.EnsureReady checks HasEnteredFastReadOrWriteMode
     * — has it *ever* boosted, not what the baud is now). A fresh connect() builds a new link, which
     * is exactly the reference's "reconnect" remedy.
     */
    private hasBoostedThisSession = false;
    /** The rate the last bulk read ran at — see DmeLink.getLastReadBaud. */
    private lastReadBaud: number | null = null;

    getLastReadBaud(): number | null {
        return this.lastReadBaud;
    }

    constructor(options?: { readBaud?: Ds2SupportedBaud }) {
        this.readBaud = options?.readBaud ?? 9600;
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

    /** Sends a request frame, reads back the mandatory K-line echo, then reads the real response. */
    private async exchange(controlByte: number, payload: Uint8Array, timeoutMs = RESPONSE_TIMEOUT_MS): Promise<Ds2Frame> {
        const request = buildDs2Frame(DS2_DEFAULT_ADDRESS, controlByte, payload);
        await this.transport.write(request);

        const echo = await this.transport.readExact(request.length, timeoutMs);
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
        return parseDs2Frame(full);
    }

    /**
     * Requests a DS2 baud-rate switch (control 0x91) and, on a positive response, reconfigures the
     * local serial port to match. Best-effort: if the DME rejects the switch, returns false and the
     * caller stays at the current baud. Mirrors TrySwitchToProgrammingBaudAsync.
     */
    private async trySwitchBaud(target: Ds2BaudRateSpec): Promise<boolean> {
        let accepted = false;
        try {
            const frame = await this.exchange(Ds2Control.REQUEST_BAUD_SWITCH, target.payload, RESPONSE_TIMEOUT_MS);
            accepted = isPositiveResponse(frame);
        } catch {
            return false; // request itself failed — DME is still at the current baud
        }
        if (!accepted) return false; // DME rejected the switch — still at the current baud
        // The DME has committed to the new baud, so the local port MUST match it now.
        try {
            await this.transport.reopen(target.baudRate);
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
        const result: DmeIdentity = { vin: 'UNKNOWN', aif: 'UNKNOWN', softwareVersion: 'UNKNOWN', flashCounter: null };
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
                } catch { /* leave UNKNOWN */ }
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

        return result;
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
            this.aborted = false;
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
            // Cleared for the same reason readPartialBin clears it: a Cancel Read earlier in the
            // session leaves `aborted` latched, and readRange checks it on every chunk.
            this.aborted = false;
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
     * Writes one data chunk and fully validates the DME's programming response — segment, next
     * address, written count, and the verify byte (which must be 1 = "programming OK"). This is the
     * critical safety check: a positive DS2 status alone does NOT mean the cells were programmed;
     * the verify byte reports "verify failed" / "cells not erased" / etc. (Ds2WriteResponseValidator).
     */
    private async writeMemoryChunk(address: number, data: Uint8Array, timeoutMs = WRITE_RESPONSE_TIMEOUT_MS): Promise<void> {
        const frame = await this.exchange(
            Ds2Control.WRITE_MEMORY,
            buildWriteMemoryPayload(Ds2ProgrammingControl.WriteSegment, address, data),
            timeoutMs,
        );
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

    private async readRange(address: number, length: number, onProgress?: (readSoFar: number, total: number) => void): Promise<Uint8Array> {
        const out = new Uint8Array(length);
        let done = 0;
        while (done < length) {
            if (this.aborted) throw new DmeLinkError('Read cancelled');
            const count = Math.min(Mss54HpDataTuneLayout.chunkSize, length - done);
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
        this.aborted = false;
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
        const boosted = this.readBaud !== 9600
            ? await this.trySwitchBaud(ds2BaudSpecFor(this.readBaud))
            : false;
        // Recorded so the UI can state what happened. A refused switch is not an error and must not
        // become one, but it must not be invisible either.
        this.lastReadBaud = boosted ? this.readBaud : 9600;
        this.hasBoostedThisSession ||= boosted;
        try {
            const { slave, master } = Mss54HpDataTuneLayout;
            const total = slave.length + master.length;

            const slaveBytes = await this.readRange(slave.address, slave.length, (done) => onProgress?.(Math.round((done / total) * 100), 'reading'));
            const masterBytes = await this.readRange(master.address, master.length, (done) => onProgress?.(Math.round(((slave.length + done) / total) * 100), 'reading'));

            const combined = new Uint8Array(total);
            combined.set(slaveBytes, 0);
            combined.set(masterBytes, slave.length);
            onProgress?.(100, 'reading');
            return combined.buffer;
        } finally {
            if (boosted) {
                // Always try to hand the session back at 9600. If the DME never really switched, this
                // request fails too — force the local port back to 9600 anyway so a plain reconnect (or
                // an ignition off/on, which resets the DME) recovers instead of silently timing out.
                try {
                    await this.trySwitchBaud(Ds2BaudRate.Baud9600);
                } catch {
                    try { await this.transport.reopen(Ds2BaudRate.Baud9600.baudRate); } catch { }
                }
            }
        }
    }

    /**
     * Writes one data block (slave or master). Chunks are 122 bytes — even-length and starting at an
     * even address (the block base and 122 are both even), which satisfies the DME's even-aligned
     * flash-write requirement. Fully-erased (all-0xFF) chunks are skipped: after the erase step those
     * cells already read 0xFF, so re-writing them is an unnecessary program cycle (matches the
     * reference erase-aware sparse write). Progress reflects position through the block.
     */
    private async writeBlock(address: number, data: Uint8Array, doneBefore: number, grandTotal: number, onProgress?: (writtenSoFar: number, total: number) => void): Promise<void> {
        let offset = 0;
        while (offset < data.length) {
            const chunkSize = Math.min(Mss54HpDataTuneLayout.chunkSize, data.length - offset);
            const chunk = data.subarray(offset, offset + chunkSize);
            if (!isAllErased(chunk)) {
                await this.writeMemoryChunk(address + offset, chunk);
            }
            offset += chunkSize;
            onProgress?.(doneBefore + offset, grandTotal);
        }
    }

    async writePartialBin(buffer: ArrayBuffer, onProgress?: TransferProgress): Promise<void> {
        return this.withGate(() => this.writePartialBinInner(buffer, onProgress));
    }

    private async writePartialBinInner(buffer: ArrayBuffer, onProgress?: TransferProgress): Promise<void> {
        this.assertConnected();
        // Clear a stale cancel, exactly as readPartialBin does. Without this, a user who pressed
        // Cancel Read earlier in the session left `aborted` latched true: the flash would then erase,
        // write and finalize completely — and the read-back verify would throw "Read cancelled" on the
        // very first chunk. A fully successful flash reported as a failure, whose natural response is
        // to press WRITE again, burning another erase+program cycle on a 20-year-old ECU every time.
        // Note this only clears it up-front; no abort check is added inside the write loop, because
        // "between chunks" is mid-programming-session and honouring a cancel there would abandon a
        // half-programmed ECU.
        this.aborted = false;
        const { slave, master } = Mss54HpDataTuneLayout;
        const total = slave.length + master.length;
        if (buffer.byteLength !== total) {
            throw new DmeLinkError(`Refusing to write a ${buffer.byteLength}-byte buffer (expected ${total})`);
        }
        const bytes = new Uint8Array(buffer);
        const slaveData = bytes.subarray(0, slave.length);
        const masterData = bytes.subarray(slave.length, total);

        // Refresh the seed/key unlock before the protected write (matches ForceRefreshUnlock in the
        // reference). The DME rejects erase/write with 0xA2 if the session lapsed or RPM/speed != 0.
        // resync, not purge — same reason as READ. This is strictly BEFORE the erase below, so it
        // cannot affect flashing itself; it only stops a stale break from failing the pre-flight.
        await this.resyncTransport();
        await this.login();

        // Erase the data area. The normal flow erases directly (no "pre-clean" prepare — that would
        // consume an extra flash-counter slot). Only on erase failure do we send the prepare (0x0F)
        // and retry the erase once, mirroring EraseDataProgrammingWithFallbackAsync.
        onProgress?.(0, 'erasing');
        try {
            await this.sendProgrammingControl(Ds2ProgrammingControl.EraseSegment, Ds2ProgrammingControl.DataProgrammingSessionAddress, ERASE_TIMEOUT_MS, true);
        } catch (eraseError) {
            await this.sendProgrammingControl(Ds2ProgrammingControl.FinishSegment, Ds2ProgrammingControl.DataProgrammingSessionAddress, WRITE_RESPONSE_TIMEOUT_MS, false); // pre-clean
            await this.sendProgrammingControl(Ds2ProgrammingControl.EraseSegment, Ds2ProgrammingControl.DataProgrammingSessionAddress, ERASE_TIMEOUT_MS, true);
        }

        // Progress is split roughly by how long each stage actually takes at 9600 baud: writing 64 KB
        // (~2.5 min) then reading it all back to verify (~70 s). Hence 0–70% write, 70–100% verify —
        // both stages report continuously so neither looks frozen.
        const WRITE_SHARE = 70;
        const VERIFY_SHARE = 30;

        await this.writeBlock(slave.address, slaveData, 0, total, (w, t) => onProgress?.(Math.round((w / t) * WRITE_SHARE), 'writing'));
        await this.writeBlock(master.address, masterData, slave.length, total, (w, t) => onProgress?.(Math.round((w / t) * WRITE_SHARE), 'writing'));

        // Finalize the programming session (segment 0x0F, address 0).
        await this.sendProgrammingControl(Ds2ProgrammingControl.FinishSegment, 0, WRITE_RESPONSE_TIMEOUT_MS, true);

        // Read-back verification: read the written region and compare byte-for-byte.
        onProgress?.(WRITE_SHARE, 'verifying');
        const readBackSlave = await this.readRange(slave.address, slave.length,
            (done) => onProgress?.(WRITE_SHARE + Math.round((done / total) * VERIFY_SHARE), 'verifying'));
        const readBackMaster = await this.readRange(master.address, master.length,
            (done) => onProgress?.(WRITE_SHARE + Math.round(((slave.length + done) / total) * VERIFY_SHARE), 'verifying'));
        if (!arraysEqual(readBackSlave, slaveData) || !arraysEqual(readBackMaster, masterData)) {
            throw new DmeLinkError('Write verification failed: read-back does not match what was written. Treat the ECU state as unknown — keep power stable and re-write before disconnecting.');
        }
        onProgress?.(100, 'verifying');
    }

    async resetFlashCounter(
        onBackup: (serviceBlockPair: ArrayBuffer) => Promise<void>,
        onProgress?: TransferProgress,
    ): Promise<FlashCounterInfo> {
        return this.withGate(() => this.resetFlashCounterInner(onBackup, onProgress));
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
     * Deliberately does NOT boost baud. The reference switches to 125000 for this write; this app's
     * flash path has never done that on real hardware, and a boost the cable doesn't follow desyncs
     * the link for the rest of the session. 16 KB at 9600 is slow enough to accept and small enough
     * not to matter (~2 minutes end to end).
     */
    private async resetFlashCounterInner(
        onBackup: (serviceBlockPair: ArrayBuffer) => Promise<void>,
        onProgress?: TransferProgress,
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
        // Same reasoning as writePartialBinInner: a stale cancel latched by an earlier Cancel Read
        // would otherwise abort this mid-flight — here it would abort the read-back of an ECU whose
        // identity block has already been erased and rewritten.
        this.aborted = false;
        const { master, slave, counterOffset, prepMarkerOffset } = ServiceBlockLayout;

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
        onProgress?: TransferProgress,
    ): Promise<FlashCounterInfo> {
        const { master, slave, counterOffset, prepMarkerOffset } = ServiceBlockLayout;
        const pairTotal = master.length + slave.length;

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

        await this.writeBlock(master.address, masterPlan, 0, pairTotal,
            (w, t) => onProgress?.(doneBefore + Math.round((w / t) * writeShare), 'writing'));
        await this.writeBlock(slave.address, slavePlan, master.length, pairTotal,
            (w, t) => onProgress?.(doneBefore + Math.round((w / t) * writeShare), 'writing'));

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
        this.aborted = false;
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

    private async pollLiveMeasurementInner(): Promise<LiveMeasurement> {
        this.assertConnected();
        if (this.startTime === 0) this.startTime = performance.now();

        // Standard Measurements (selection 3) is the critical block — it carries RPM and relative
        // opening, which the VE calculation depends on. A failure here is fatal to the sample, and
        // (via useDmeLink's polling loop) to the entire datalog, so it gets the resync + bounded retry
        // it previously lacked: it used to be the only user-initiated first exchange with no purge, no
        // drain and no retry, so it inherited any desync an earlier failed operation left behind.
        //
        // Retrying is safe here specifically because READ_IO_STATUS with a selection byte is a pure
        // idempotent read — readAdaptationBlock already retries the identical control byte. This must
        // never be widened to WRITE_MEMORY or sendProgrammingControl.
        let stdFrame: Ds2Frame | null = null;
        let stdError: unknown;
        for (let attempt = 1; attempt <= POLL_RETRY_ATTEMPTS; attempt++) {
            try {
                await this.resyncTransport();
                stdFrame = await this.exchange(Ds2Control.READ_IO_STATUS, new Uint8Array([STANDARD_MEASUREMENT_BLOCK.selection]));
                stdError = undefined;
                break;
            } catch (e) {
                stdError = e;
            }
        }
        if (!stdFrame) throw stdError instanceof Error ? stdError : new DmeLinkError(String(stdError));
        if (!isPositiveResponse(stdFrame)) throw new DmeLinkError('Standard measurement block read rejected by DME');
        const std = decodeStandardMeasurementBlock(stdFrame.payload);

        if (std.rpm === null || std.rawLoad === null) {
            throw new DmeLinkError('Standard measurement block response was shorter than expected');
        }

        // Operating Measurements (selection 19) carries the lambda controller trim (our stft1/stft2).
        // This block's availability/layout is less certain than block 3, so it is best-effort: if it
        // is rejected or short, we fall back to neutral trim (1.0) and keep logging RPM/RO/temp rather
        // than killing the whole polling loop. (Neutral trim means the VE calc produces no lambda
        // correction, so the lambda channel must be validated before trusting tuning output.)
        let stft1 = 1.0;
        let stft2 = 1.0;
        try {
            const opFrame = await this.exchange(Ds2Control.READ_IO_STATUS, new Uint8Array([OPERATING_MEASUREMENTS_BLOCK.selection]));
            if (isPositiveResponse(opFrame)) {
                const op = decodeOperatingMeasurementsBlock(opFrame.payload);
                stft1 = op.stft1 ?? 1.0;
                stft2 = op.stft2 ?? 1.0;
            }
        } catch {
            // Leave trim neutral — but resync, because a break latched here would otherwise be
            // reported as a perfectly healthy sample while guaranteeing the NEXT poll dies.
            // The inner catch is load-bearing: resyncTransport can now throw (device gone), and a
            // deliberate swallow must not become fatal just because disconnect() raced this poll.
            try { await this.resyncTransport(); } catch { }
        }

        return {
            time: (performance.now() - this.startTime) / 1000,
            rpm: std.rpm,
            rawLoad: std.rawLoad,
            stft1,
            stft2,
            coolantTemp: std.coolantTemp ?? undefined,
        };
    }

    private assertAdaptationsAvailable() {
        this.assertConnected();
        if (this.hasBoostedThisSession) {
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
     * block 19 and falls back to neutral trim so a long log run isn't lost to one bad sample — both
     * blocks are required here. A half-read snapshot shown next to post-clear values would invite
     * exactly the wrong conclusion about what the clear did.
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

    private async clearTuneAdaptationsInner(): Promise<AdaptationSnapshot> {
        this.assertAdaptationsAvailable();
        await this.drainUntilQuiet();
        const { mask1, mask2 } = TUNE_ADAPTATION_CLEAR;
        await this.adaptationExchangeWithRetry(
            Ds2Control.CLEAR_ADAPTATIONS, buildClearAdaptationsPayload(mask1, mask2), ADAPT_CLEAR_TIMEOUT_MS,
            'Adaptation clear',
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
