import { DmeLink, DmeIdentity, LiveMeasurement, TransferProgress, DmeLinkError } from './types';
import { WebSerialTransport } from './webSerialTransport';
import {
    Ds2Frame, Ds2Control, Ds2ProgrammingControl, Ds2BaudRate, Ds2BaudRateSpec, Ds2SupportedBaud, ds2BaudSpecFor,
    Mss54HpDataTuneLayout, DS2_DEFAULT_ADDRESS,
    buildDs2Frame, parseDs2Frame, frameToBytes, isPositiveResponse,
    buildSeedRequestPayload, buildKeyPayload, isAlreadyUnlockedResponse, isSeedResponse, calculateLoginKey,
    buildReadMemoryPayload, buildWriteMemoryPayload, parseWriteResult, describeVerifyByte,
    TUNE_ADAPTATION_CLEAR, buildClearAdaptationsPayload,
} from './ds2';
import {
    parseSystemAddressTable, findPointer, parseAifEntries, latestPopulatedAifEntry,
    parseZifProgramNumber, AIF_TOTAL_LENGTH,
} from './identity';
import { STANDARD_MEASUREMENT_BLOCK, OPERATING_MEASUREMENTS_BLOCK, decodeStandardMeasurementBlock, decodeOperatingMeasurementsBlock } from './liveValueBlocks';
import {
    AdaptationSnapshot, STANDARD_ADAPTATIONS_BLOCK, OBSERVATION_ADAPTATIONS_BLOCK, buildAdaptationSnapshot,
} from './adaptationBlocks';

// DS2 system-address-table pointer indices (Ds2KnownSystemAddressLengths / IdentifyService)
const SYSTEM_ADDRESS_INDEX = { DIF: 15, ZIF_BACKUP: 16, BRIF: 18, ZIF: 19, AIF: 20 } as const;
const ZIF_LENGTH = 78;

const RESPONSE_TIMEOUT_MS = 2000;
// Flash write responses can take much longer than reads (the DME programs cells before replying);
// the reference uses 15s at 9600 baud (ProgrammingWriteSupport.GetProgrammingWriteTimeout).
const WRITE_RESPONSE_TIMEOUT_MS = 15000;
const ERASE_TIMEOUT_MS = 65000;
const CHUNK_RETRY_ATTEMPTS = 5;
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
// Before the first adaptation exchange, wait for the K-line to fall silent so the echo read isn't
// racing a prior operation's still-arriving response. One quiet window this long with nothing new
// received counts as silent; give up after this many rounds rather than blocking forever.
const DRAIN_QUIET_MS = 150;
const DRAIN_MAX_ROUNDS = 8;

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
     * Baud rate to use for the bulk read. 9600 by default — that's the path proven against real
     * hardware and needs no switch at all. 38400/125000 are the only other rates the DME accepts
     * (per the reference Ds2BaudRate); they require a 0x91 switch plus a local port close/reopen,
     * which is unproven on this hardware, so they stay opt-in.
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
            // The sent/got bytes make the failure mode legible: `got` starting with 12 LL A0… means
            // we read a response where the echo should be (the line wasn't drained), whereas garbage
            // points at a real cable/echo fault.
            throw new DmeLinkError(`Unexpected K-line echo — check the cable connection (sent ${toHex(request)}, got ${toHex(echo)})`);
        }

        const header = await this.transport.readExact(2, timeoutMs);
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
     */
    private async identify(): Promise<DmeIdentity> {
        const result: DmeIdentity = { vin: 'UNKNOWN', aif: 'UNKNOWN', softwareVersion: 'UNKNOWN' };
        try {
            const tableFrame = await this.exchange(Ds2Control.READ_SYSTEM_ADDRESSES, new Uint8Array(0));
            if (!isPositiveResponse(tableFrame)) return result;
            const entries = parseSystemAddressTable(tableFrame.payload);

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
        return result;
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
                    this.transport.purge();
                    await delay(300);
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
    private async writeMemoryChunk(address: number, data: Uint8Array): Promise<void> {
        const frame = await this.exchange(
            Ds2Control.WRITE_MEMORY,
            buildWriteMemoryPayload(Ds2ProgrammingControl.WriteSegment, address, data),
            WRITE_RESPONSE_TIMEOUT_MS,
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
        this.assertConnected();
        this.aborted = false;
        // Refresh the seed/key unlock before reading program/data memory, mirroring the reference
        // EnsureUnlockedForProgramMemoryReadAsync. The diagnostic session can lapse between connect
        // and the user clicking READ; re-login is a no-op if still unlocked.
        this.transport.purge();
        await this.login();

        // Optional baud boost for the bulk transfer. Skipped entirely at 9600 (no switch, no port
        // reopen — the proven path), because a boost the hardware doesn't actually follow desyncs the
        // link for the rest of the session.
        const boosted = this.readBaud !== 9600
            ? await this.trySwitchBaud(ds2BaudSpecFor(this.readBaud))
            : false;
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
        this.assertConnected();
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
        this.transport.purge();
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

    private startTime = 0;

    /**
     * Polls the DS2 "Standard Measurements" block (selection 3: RPM, coolant temp, relative
     * opening) and the "Operating Measurements" block (selection 19: lambda controller trim,
     * i.e. our stft1/stft2) — both field layouts confirmed against the reference source
     * (DmeLiveValueCatalog.cs). Two DS2 round-trips per sample.
     */
    async pollLiveMeasurement(): Promise<LiveMeasurement> {
        this.assertConnected();
        if (this.startTime === 0) this.startTime = performance.now();

        // Standard Measurements (selection 3) is the critical block — it carries RPM and relative
        // opening, which the VE calculation depends on. A failure here is fatal to the sample.
        const stdFrame = await this.exchange(Ds2Control.READ_IO_STATUS, new Uint8Array([STANDARD_MEASUREMENT_BLOCK.selection]));
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
            // leave neutral; the transport buffer is resynced on the next exchange's write
            this.transport.purge();
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
        for (let round = 0; round < DRAIN_MAX_ROUNDS; round++) {
            await this.resyncTransport();
            await delay(DRAIN_QUIET_MS);
            // Quiet means both empty AND no error: a break latches the pump and stops new bytes, so
            // an empty buffer alone would read as "quiet" on a dead line.
            if (this.transport.bufferedLength() === 0 && !this.transport.hasReadError()) return;
        }
        await this.resyncTransport();
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
            await this.resyncTransport();
            try {
                const frame = await this.exchange(control, payload, timeoutMs);
                if (!isPositiveResponse(frame)) {
                    throw new DmeLinkError(`${describe} rejected by DME (status 0x${frame.controlOrStatus.toString(16)})`);
                }
                return frame;
            } catch (e) {
                lastError = e;
                await delay(ADAPT_RETRY_DELAY_MS);
            }
        }
        // Leave the transport usable for whatever runs next — most importantly a START TUNE poll.
        await this.resyncTransport();
        throw lastError instanceof Error ? lastError : new DmeLinkError(String(lastError));
    }

    /** Reads one adaptation block. Same request shape as a live-measurement poll — control 0x0B with
     *  a one-byte selection — just a different block. */
    private async readAdaptationBlock(selection: number): Promise<Uint8Array> {
        const frame = await this.adaptationExchangeWithRetry(
            Ds2Control.READ_IO_STATUS, new Uint8Array([selection]), RESPONSE_TIMEOUT_MS,
            `Adaptation block 0x${selection.toString(16)} read`,
        );
        return frame.payload;
    }

    /**
     * Reads the learned adaptation values. Unlike pollLiveMeasurement — which tolerates a missing
     * block 19 and falls back to neutral trim so a long log run isn't lost to one bad sample — both
     * blocks are required here. A half-read snapshot shown next to post-clear values would invite
     * exactly the wrong conclusion about what the clear did.
     */
    async readAdaptations(): Promise<AdaptationSnapshot> {
        this.assertAdaptationsAvailable();
        await this.drainUntilQuiet();
        const std = await this.readAdaptationBlock(STANDARD_ADAPTATIONS_BLOCK.selection);
        const obs = await this.readAdaptationBlock(OBSERVATION_ADAPTATIONS_BLOCK.selection);
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
        this.assertAdaptationsAvailable();
        await this.drainUntilQuiet();
        const { mask1, mask2 } = TUNE_ADAPTATION_CLEAR;
        await this.adaptationExchangeWithRetry(
            Ds2Control.CLEAR_ADAPTATIONS, buildClearAdaptationsPayload(mask1, mask2), ADAPT_CLEAR_TIMEOUT_MS,
            'Adaptation clear',
        );
        await delay(ADAPT_SETTLE_MS);
        return this.readAdaptations();
    }
}
