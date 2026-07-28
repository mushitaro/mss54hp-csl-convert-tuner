/**
 * BMW DS2 protocol primitives, ported from the reference Mss54Ds2Tool implementation
 * (Ds2Frame.cs, Ds2Checksum.cs, Ds2Client.cs, Mss54SeedKeyCalculator.cs).
 *
 * Frame layout: [Address][Length][ControlOrStatus][Payload...][XOR checksum]
 * Length counts the whole frame (Address+Length+Control+Payload+Checksum), minimum 4 bytes.
 */

export const DS2_DEFAULT_ADDRESS = 0x12; // 18 decimal, default MSS54 slave address

export const Ds2Control = {
    READ_ERROR_MEMORY: 0x04,
    CLEAR_ERROR_MEMORY: 0x05,
    READ_MEMORY: 0x06,
    WRITE_MEMORY: 0x07,
    READ_IO_STATUS: 0x0B,
    SET_IO_STATUS: 0x0C,
    QUERY_ENCODING_CHECKSUM: 0x0A,
    READ_SYSTEM_ADDRESSES: 0x0D,
    REBOOT: 0x12,
    /**
     * Clear adaptations. Payload is [mask1] when mask2 is 0, else [mask1, mask2].
     *
     * OVERLOADED: payload `00 01` is not a clear at all — it starts VANOS diagnostic idle mode
     * (reference Ds2Client.StartVanosDiagnosticIdleModeAsync). Setting mask2 bit 0 on a running
     * engine would trip that mode instead of clearing anything, which is why ClearAll is 0xF7/0x32
     * and not 0xFF/0x33. buildClearAdaptationsPayload enforces this.
     */
    CLEAR_ADAPTATIONS: 0x43,
    READ_SHADOW_ERROR_MEMORY: 0x14,
    REQUEST_LOGIN_SEED: 0x90,
    SEND_LOGIN_KEY: 0x90,
    REQUEST_BAUD_SWITCH: 0x91,
    KEEP_ALIVE: 0x9E,
    END_DIAGNOSTIC_MODE: 0x9F,
} as const;

export const Ds2Status = {
    ACKNOWLEDGE: 0xA0,
    BUSY: 0xA1,
    REJECTED: 0xA2,
    PARAMETER_ERROR: 0xB0,
    FUNCTION_ERROR: 0xB1,
    NOT_ACKNOWLEDGE: 0xFF,
} as const;

export function ds2Checksum(bytes: Uint8Array): number {
    let sum = 0;
    for (let i = 0; i < bytes.length; i++) sum ^= bytes[i];
    return sum & 0xFF;
}

export interface Ds2Frame {
    address: number;
    length: number;
    controlOrStatus: number;
    payload: Uint8Array;
    checksum: number;
}

export function buildDs2Frame(address: number, controlByte: number, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
    const length = 4 + payload.length;
    if (length > 255) throw new Error(`DS2 frame too long: ${length} bytes`);
    const frame = new Uint8Array(length);
    frame[0] = address;
    frame[1] = length;
    frame[2] = controlByte;
    frame.set(payload, 3);
    frame[length - 1] = ds2Checksum(frame.subarray(0, length - 1));
    return frame;
}

export function parseDs2Frame(bytes: Uint8Array): Ds2Frame {
    if (bytes.length < 4) throw new Error(`Invalid DS2 frame: ${bytes.length} bytes (minimum 4)`);
    const checksum = bytes[bytes.length - 1];
    const calculated = ds2Checksum(bytes.subarray(0, bytes.length - 1));
    if (checksum !== calculated) {
        throw new Error(`Invalid DS2 checksum: expected 0x${calculated.toString(16)}, got 0x${checksum.toString(16)}`);
    }
    return {
        address: bytes[0],
        length: bytes[1],
        controlOrStatus: bytes[2],
        payload: bytes.subarray(3, bytes.length - 1),
        checksum,
    };
}

export function isPositiveResponse(frame: Ds2Frame): boolean {
    return frame.controlOrStatus === Ds2Status.ACKNOWLEDGE;
}

export interface EchoMismatchAnalysis {
    /** Byte offset at which `got` best lines up with `sent` (0 = same position, 1 = one byte lost). */
    lag: number;
    /** How many byte pairs the verdict rests on. */
    compared: number;
    /** Every compared byte of `got` is a bitwise subset of its `sent` byte (only 1→0, never 0→1). */
    allSubset: boolean;
    flips1to0: number;
    flips0to1: number;
    trailingZeroRun: number;
    /** `got` looks like a DS2 response frame — i.e. we read a reply where the echo belonged. */
    looksLikeResponse: boolean;
    /** The verdict as a value rather than prose, so the UI can branch on it instead of re-deriving
     *  the classification (or worse, matching on the sentence below). */
    kind: 'electrical' | 'desync' | 'unclassified';
    verdict: string;
}

/**
 * Explains WHY a K-line echo didn't match, so an unstable-cable report can be told apart from a
 * software desync without a second forensic pass.
 *
 * The discriminator is bit direction. The K-line is open-collector: a device can only pull it LOW,
 * never drive it high. So if every received bit that changed went 1→0 and none went 0→1, the request
 * was electrically corrupted on the wire — a cable, connector, ground, or DME-reset event. If instead
 * `got` parses as the head of a DS2 response, the buffer was simply out of frame and a stale reply was
 * read in the echo's place, which IS a software-recoverable desync.
 *
 * Pure and self-contained so it can be reasoned about (and unit-tested) without a serial port.
 */
export function classifyEchoMismatch(sent: Uint8Array, got: Uint8Array): EchoMismatchAnalysis {
    let trailingZeroRun = 0;
    for (let i = got.length - 1; i >= 0 && got[i] === 0; i--) trailingZeroRun++;

    const looksLikeResponse = got.length >= 3
        && got[0] === DS2_DEFAULT_ADDRESS
        && (got[2] === Ds2Status.ACKNOWLEDGE || got[2] === Ds2Status.BUSY || got[2] === Ds2Status.REJECTED);

    // Try small alignments; a dropped leading byte shifts everything by one. Score by how well the
    // "only pulled low" model fits, so the winner is the alignment that best explains the corruption.
    let best: EchoMismatchAnalysis | null = null;
    for (let lag = 0; lag < Math.min(4, sent.length); lag++) {
        let compared = 0, flips1to0 = 0, flips0to1 = 0, subset = true;
        for (let i = 0; i + lag < sent.length && i < got.length; i++) {
            const s = sent[i + lag], g = got[i];
            compared++;
            flips1to0 += popcount(s & ~g);
            flips0to1 += popcount(~s & g & 0xFF);
            if ((g & ~s & 0xFF) !== 0) subset = false;
        }
        if (compared === 0) continue;
        const candidate: EchoMismatchAnalysis = {
            lag, compared, allSubset: subset, flips1to0, flips0to1,
            // Both filled in once a winner is picked — scoring below only reads the bit counts.
            trailingZeroRun, looksLikeResponse, kind: 'unclassified', verdict: '',
        };
        // Prefer an alignment where nothing went 0→1 (physically impossible from an interfering
        // driver), then the one covering the most bytes, then the fewest corrupted bits.
        if (!best
            || (candidate.allSubset && !best.allSubset)
            || (candidate.allSubset === best.allSubset && candidate.compared > best.compared)
            || (candidate.allSubset === best.allSubset && candidate.compared === best.compared && candidate.flips1to0 < best.flips1to0)) {
            best = candidate;
        }
    }

    const a = best ?? {
        lag: 0, compared: 0, allSubset: false, flips1to0: 0, flips0to1: 0,
        trailingZeroRun, looksLikeResponse, kind: 'unclassified' as const, verdict: '',
    };

    a.kind = looksLikeResponse
        ? 'desync'
        // Needs enough bytes to be meaningful: one or two matching bytes prove nothing.
        : (a.compared >= 3 && a.allSubset && a.flips0to1 === 0) || a.trailingZeroRun >= 2
            ? 'electrical'
            : 'unclassified';

    a.verdict = looksLikeResponse
        ? 'a stale DS2 response was read where the echo belonged — buffer out of frame (software-recoverable)'
        : (a.compared >= 3 && a.allSubset && a.flips0to1 === 0)
            ? 'line-level electrical event — the K-line was pulled low during our own transmission (cable, connector, ground, or DME reset). Not a buffer desync.'
            : a.trailingZeroRun >= 2
                ? 'the line was held low (break / framing errors) — electrical, not a buffer desync'
                : 'unclassified — could be either a desync or line noise';
    return a;
}

function popcount(byte: number): number {
    let n = byte & 0xFF, c = 0;
    while (n) { c += n & 1; n >>>= 1; }
    return c;
}

/** Reconstructs the raw frame bytes [Address][Length][Control][Payload...][Checksum] from a parsed frame. */
export function frameToBytes(frame: Ds2Frame): Uint8Array {
    const bytes = new Uint8Array(frame.length);
    bytes[0] = frame.address;
    bytes[1] = frame.length;
    bytes[2] = frame.controlOrStatus;
    bytes.set(frame.payload, 3);
    bytes[frame.length - 1] = frame.checksum;
    return bytes;
}

/**
 * Seed/key login algorithm, ported exactly from Mss54SeedKeyCalculator.CalculateKey.
 * seedFrame must be a 46-byte positive response to a REQUEST_LOGIN_SEED request.
 */
export function calculateLoginKey(accessLevel: number, seedFrameBytes: Uint8Array): number {
    if (seedFrameBytes.length !== 46) {
        throw new Error(`Expected a 46-byte seed response, got ${seedFrameBytes.length} bytes`);
    }
    let key = 0;
    for (let i = 0; i < 4; i++) {
        const idx = (accessLevel + i) % seedFrameBytes[1];
        const term = seedFrameBytes[idx] + seedFrameBytes[18 + i] + seedFrameBytes[41 + i];
        key = ((key << 8) | (term & 0xFF)) >>> 0;
    }
    return key;
}

export function buildSeedRequestPayload(accessLevel: number = 5): Uint8Array {
    // ASCII "BMW" + access level byte
    return new Uint8Array([0x42, 0x4D, 0x57, accessLevel]);
}

export function buildKeyPayload(key: number): Uint8Array {
    return new Uint8Array([(key >>> 24) & 0xFF, (key >>> 16) & 0xFF, (key >>> 8) & 0xFF, key & 0xFF]);
}

/** A positive login response of length 5 means the session was already unlocked (no seed needed). */
export function isAlreadyUnlockedResponse(frame: Ds2Frame): boolean {
    return isPositiveResponse(frame) && frame.length === 5;
}

/** A positive login response of length 46 is a genuine seed to compute a key from. */
export function isSeedResponse(frame: Ds2Frame): boolean {
    return isPositiveResponse(frame) && frame.length === 46;
}

export function buildReadMemoryPayload(segment: number, address24: number, count: number): Uint8Array {
    return new Uint8Array([segment, (address24 >>> 16) & 0xFF, (address24 >>> 8) & 0xFF, address24 & 0xFF, count]);
}

export function buildWriteMemoryPayload(segment: number, address24: number, data: Uint8Array): Uint8Array {
    if (data.length > 123) throw new Error(`DS2 memory write count must be 123 bytes or less, got ${data.length}`);
    const payload = new Uint8Array(5 + data.length);
    payload[0] = segment;
    payload[1] = (address24 >>> 16) & 0xFF;
    payload[2] = (address24 >>> 8) & 0xFF;
    payload[3] = address24 & 0xFF;
    payload[4] = data.length;
    payload.set(data, 5);
    return payload;
}

/**
 * Adaptation clear mask bits (control 0x43), from the reference AdaptationClearOptions. The DME
 * clears every category whose bit is set; the reference's "Clear All" is the bitwise OR of all of
 * them (0xF7 / 0x32).
 */
export const Ds2AdaptationMask1 = {
    IDLE_FUEL: 0x01,
    KNOCK: 0x02,
    LAMBDA: 0x04,
    PEDAL: 0x10,
    THROTTLE_EGAS: 0x20,
    VANOS: 0x40,
    SMG: 0x80,
} as const;

export const Ds2AdaptationMask2 = {
    /** Bit 0 (0x01) is deliberately absent: `00 01` is the VANOS diagnostic overload, not a clear
     *  bit. See Ds2Control.CLEAR_ADAPTATIONS. */
    MISFIRE_OBSERVATION: 0x02,
    CRANK_IDLE_SYNC: 0x10,
    DETECTED_EQUIPMENT: 0x20,
} as const;

/**
 * The only clear this app performs: the adaptations a re-tune needs zeroed so the next log is
 * captured from a known base — lambda trim, knock, VANOS, and the idle/fuel demand values.
 *
 * Deliberately NOT the reference's "Clear All" (0xF7 / 0x32), which also wipes throttle/pedal/EGAS,
 * SMG, detected-equipment and crank-wheel adaptations. Those are irrelevant to a tune and expensive
 * to lose: the CSL is SMG-II only, so clearing SMG adaptation forces a clutch re-adaptation
 * procedure. This mask is exactly the twelve values the reset dialog shows, so nothing is cleared
 * that the user wasn't shown first.
 */
export const TUNE_ADAPTATION_CLEAR = {
    mask1: Ds2AdaptationMask1.IDLE_FUEL | Ds2AdaptationMask1.KNOCK
        | Ds2AdaptationMask1.LAMBDA | Ds2AdaptationMask1.VANOS,   // 0x47
    mask2: 0,
} as const;

/**
 * Builds a control-0x43 payload. Variable length, matching the reference: one byte when mask2 is 0,
 * two otherwise — the DME reads the payload length, so padding a zero mask2 is not the same request.
 */
export function buildClearAdaptationsPayload(mask1: number, mask2: number): Uint8Array {
    if (mask1 === 0 && mask2 === 0) {
        throw new Error('At least one adaptation clear mask bit must be set');
    }
    // The reference's own guard only rejects all-zero masks, so `00 01` slips through it and reaches
    // the DME as "start VANOS diagnostic idle mode". Reject it here instead: no clear needs this bit.
    if (mask2 & 0x01) {
        throw new Error('mask2 bit 0 is the VANOS diagnostic idle-mode overload (payload 00 01), not a clear bit');
    }
    return mask2 === 0 ? new Uint8Array([mask1]) : new Uint8Array([mask1, mask2]);
}

export const Ds2ProgrammingControl = {
    WriteSegment: 2,
    EraseSegment: 6,
    /** Recycling control segment — carries the recycle-only / recycle-off addresses below. */
    RecyclingSegment: 14,
    FinishSegment: 15,
    /**
     * Address sent with the data-area erase (segment 6) and the pre-clean (segment 15).
     *
     * NOTE a deliberate divergence from the reference: Ds2ProgrammingControl.cs uses 10502144,
     * which is 0xA04000 — not the 0xA02000 below. Both land inside the same slave DataBlock
     * subsegment (nibble 0xA) and differ only in the offset within it, and 0xA02000 is what this
     * app has actually flashed a real vehicle with, read-back verification included. Since a
     * skipped erase cannot survive that verification — NOR flash can only clear bits, so writing
     * into un-erased cells mismatches, and the DME would have answered verify byte 3 ("cells were
     * not erased") on the first chunk anyway — the proven value stays. Don't "fix" it to match the
     * reference without re-proving it on a car.
     */
    DataProgrammingSessionAddress: 0xA02000,
    /** ASCII "BAQ" — enter recycle-only mode before erasing the service block. */
    RecycleOnlyAddress: 0x424151,
    /** ASCII "BAR" — leave recycle mode once the service block has been rewritten. */
    RecycleOffAddress: 0x424152,
} as const;

/**
 * DS2 baud-rate switch payloads (control 0x91), from the reference Ds2BaudRate. The first 3 bytes
 * are the baud rate as a 24-bit big-endian value (0x002580=9600, 0x01E848=125000); the 4th byte
 * 0x19 is a constant. The DME switches after ACKing at the current baud; the host then reconfigures
 * its port.
 */
export interface Ds2BaudRateSpec {
    baudRate: number;
    payload: Uint8Array;
}
export const Ds2BaudRate: Record<'Baud9600' | 'Baud38400' | 'Baud125000', Ds2BaudRateSpec> = {
    Baud9600: { baudRate: 9600, payload: new Uint8Array([0, 37, 128, 25]) },      // 0x002580
    Baud38400: { baudRate: 38400, payload: new Uint8Array([0, 150, 0, 25]) },     // 0x009600
    Baud125000: { baudRate: 125000, payload: new Uint8Array([1, 232, 72, 25]) },  // 0x01E848
};

/** The only rates the MSS54 DME accepts via the 0x91 switch (per the reference Ds2BaudRate). */
export type Ds2SupportedBaud = 9600 | 38400 | 125000;

export function ds2BaudSpecFor(baud: Ds2SupportedBaud): Ds2BaudRateSpec {
    switch (baud) {
        case 38400: return Ds2BaudRate.Baud38400;
        case 125000: return Ds2BaudRate.Baud125000;
        default: return Ds2BaudRate.Baud9600;
    }
}

/** Parsed DS2 write/programming response: [segment, addrHi, addrMid, addrLo, writtenCount, verifyByte]. */
export interface Ds2WriteResult {
    segment: number;
    nextAddress24: number;
    writtenCount: number;
    verifyByte: number;
}

/**
 * Parses a positive write/programming response payload. Some control responses (prepare/erase/
 * finalize) legitimately return an empty payload — this returns null in that case. A non-empty
 * payload shorter than 6 bytes is a protocol error.
 * Ported from Ds2MemoryWriteResult.FromPositiveResponse.
 */
export function parseWriteResult(frame: Ds2Frame): Ds2WriteResult | null {
    if (frame.payload.length === 0) return null;
    if (frame.payload.length < 6) {
        throw new Error(`DS2 write response payload is ${frame.payload.length} byte(s), expected 0 or at least 6`);
    }
    const p = frame.payload;
    return {
        segment: p[0],
        nextAddress24: (p[1] << 16) | (p[2] << 8) | p[3],
        writtenCount: p[4],
        verifyByte: p[5],
    };
}

/** Human-readable meaning of a DME programming verify byte (Ds2MemoryWriteResult.DescribeVerifyByte). */
export function describeVerifyByte(verifyByte: number): string {
    switch (verifyByte) {
        case 1: return 'programming OK';
        case 2: return 'verify failed';
        case 3: return 'cells were not erased before programming attempt';
        case 4: return 'copying/backing up AIF not possible';
        case 5: return 'copying/backing up ZIF not possible';
        case 6: return 'boot-mode field management error; programming not possible';
        case 7: return 'program programming session active';
        case 8: return 'data programming session active';
        case 9: return 'hardware reference implausible';
        case 10: return 'program reference implausible';
        case 11: return 'program and hardware references do not match';
        case 12: return 'program incomplete';
        case 13: return 'data reference implausible';
        case 14: return 'program and data references do not match';
        case 15: return 'data incomplete';
        default: return `unknown verify byte 0x${verifyByte.toString(16)}`;
    }
}

/**
 * DS2 addressing for the MSS54HP "DataTune" region (our app's 65536-byte "0401 partial BIN" =
 * Slave data block followed by Master data block), confirmed against the reference
 * Mss54Ds2Tool source (DmeBinaryLayout.cs, Ds2ProgrammingSubsegment.cs, Ds2MemoryReader.cs,
 * Ds2MemoryProgrammer.cs, Ds2ProgrammingControl.cs).
 */
export const Mss54HpDataTuneLayout = {
    readSegment: 0, // Ds2MemoryReader.LinearProgrammingSegment — used for all Ds2MemoryBlock reads
    writeSegment: Ds2ProgrammingControl.WriteSegment,
    slave: { address: 0xA00000, length: 32768 },
    master: { address: 0x200000, length: 32768 },
    chunkSize: 122,
} as const;
