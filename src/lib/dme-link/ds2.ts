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

/** Builds a 0x91 payload for any rate. The encoding is generic — the reference hardcodes three
 *  rates, but all three are just this: the rate big-endian in 24 bits, then the constant. */
function ds2BaudPayload(baudRate: number): Uint8Array {
    return new Uint8Array([(baudRate >>> 16) & 0xFF, (baudRate >>> 8) & 0xFF, baudRate & 0xFF, 0x19]);
}

/**
 * The three rates the MSS54 actually implements — the same three the reference hardcodes, which is
 * not a coincidence and not an arbitrary limitation of that tool.
 *
 * Ten rates were offered here for a while, on the reasoning that the 0x91 payload encodes the rate as
 * a plain 24-bit value and therefore "admits any rate". It does. The DME does not: asked for 19200 on
 * a real car it answered **DS2 status 0xB0, PARAMETER_ERROR** — the ECU validating the value against
 * a fixed list and saying no. Expressible and implemented are different things, and only one of them
 * was ever checked.
 *
 * That result also closed a much older loose end. 57600 was reported from the car long ago as "no
 * faster than 9600, and no message appeared", which was true and for this exact reason: the switch was
 * silently refused and the read fell back to 9600. Those rates were once deleted on that impression,
 * then restored on the grounds that an impression cannot separate a refused switch from an unhelpful
 * one. It cannot — but the impression was right, and it took recording `switchOutcome` to prove why.
 */
export const Ds2BaudRate = {
    Baud9600: { baudRate: 9600, payload: ds2BaudPayload(9600) },        // 0x002580
    Baud38400: { baudRate: 38400, payload: ds2BaudPayload(38400) },     // 0x009600
    Baud125000: { baudRate: 125000, payload: ds2BaudPayload(125000) },  // 0x01E848
} as const satisfies Record<string, Ds2BaudRateSpec>;

/**
 * Rates the 0x91 switch may be asked for. **9600 is the only one that works on this car**, and the
 * measurements behind that are worth keeping, because two of them corrected earlier conclusions here.
 *
 * - **9600** — the default, and no switch is sent at all. Measured 122.9 s for the 64 KiB read,
 *   reproducibly. That is the floor.
 * - **38400** — the switch IS accepted and the wire genuinely runs at 38400 (measured response time
 *   36.0-36.8 ms against a theoretical 36.1). But every attempt died inside the first 17 of 538
 *   chunks, with the ECU silent — zero bytes, not a corrupted frame — and an inter-telegram gap of up
 *   to 40 ms changed neither the survival nor anything else.
 * - **125000** — the reference's programming rate. The DME ACKs and then every exchange times out. In
 *   the reference it is only ever reached after a "fast entry" procedure that erases flash on both
 *   processors, which is not a thing to do for a read.
 *
 * **Correction to an earlier claim in this file: 38400 does NOT double the DME's turnaround.** That
 * was an artifact of comparing 38400's first-17-chunk median against 9600's whole-read median. The
 * ECU has a warm-up — at 9600 the head of a read shows ~110 ms of turnaround and the settled middle
 * shows ~40 ms, which is what blends to the 53 ms median. Sampled at the same point in the read, 9600
 * and 38400 are indistinguishable (102-121 ms vs 111-116 ms). 38400 simply never survived long enough
 * to reach the settled region. The gap experiment was therefore testing a phenomenon that did not
 * exist, which is why it found nothing.
 *
 * Asking for an unsupported rate is safe: the DME answers 0xB0 and trySwitchBaud leaves the port
 * alone — but the read then runs at 9600, so check `switchOutcome` before believing a rate ran.
 */
export type Ds2SupportedBaud = 9600 | 38400 | 125000;

/**
 * Every selectable rate, slowest first — the single source the UI's selector renders from, so a
 * rate can never exist in the switch table but be unreachable (or vice versa).
 *
 * Deliberately exactly the reference's three. Seven others were offered here at various points —
 * 10400/14400/19200/28800 below 38400, and 57600/76800/115200 above it — on the reasoning that the
 * payload encodes an arbitrary 24-bit rate. Removed once the ECU was actually asked: see Ds2BaudRate.
 */
export const DS2_SELECTABLE_BAUDS: readonly Ds2SupportedBaud[] = [9600, 38400, 125000];

/**
 * Selectable bytes-per-read-telegram, largest first. Exactly the reference's
 * `AllowedDs2MemoryBlockSizes = { 122, 96, 64, 32 }`.
 *
 * **This is a reliability control, not a speed one, and the direction that helps is DOWNWARD.**
 * 122 is already very nearly the maximum: the DME publishes a 132-byte telegram cap, so a read
 * payload can reach 128, and 122 → 128 is worth 538 → 512 exchanges ≈ 1.3%. There is nothing above.
 *
 * What it is for is the one variable that has never been moved at 38400. From karter16's own
 * journal, on running the MSS54 outside programming mode: *"I found even in normal OS mode 38,400
 * kinda worked **provided the block size wasn't too big**"* — followed by the judgement that it
 * "wasn't stable enough to make an actual feature". Every 38400 attempt here, on both transports,
 * has been at 122. Six deaths on desktop Web Serial (chunks 0/1/4/7/9/17) and three on Android
 * WebUSB (chunks 23/1/3), all with the same signature: the echo returns, then the ECU sends zero
 * bytes. That is not a corrupted frame, and the Android result rules out the port close/reopen that
 * was the last remaining host-side suspect.
 *
 * The arithmetic, so the trade is visible before a drive rather than after it. At 38400 the
 * per-exchange cost is roughly `tx + ~55 ms turnaround + rx`, and the turnaround is paid per
 * exchange no matter how small the block — so shrinking the block buys stability by spending the
 * saving:
 *
 * | block | exchanges | ~total at 38400 |
 * |---|---|---|
 * | 122 | 538 | ~51 s |
 * | 96 | 683 | ~59 s |
 * | 64 | 1024 | ~79 s |
 * | 32 | 2048 | ~139 s — **slower than 9600's measured 126 s** |
 *
 * So 96 and 64 are the two worth trying; 32 is there to complete the reference's set and to be a
 * last resort for a link that will not hold at any useful rate, not because it could ever be fast.
 */
export const DS2_READ_BLOCK_SIZES = [122, 96, 64, 32] as const;
export type Ds2ReadBlockSize = typeof DS2_READ_BLOCK_SIZES[number];

export function ds2BaudSpecFor(baud: Ds2SupportedBaud): Ds2BaudRateSpec {
    switch (baud) {
        case 38400: return Ds2BaudRate.Baud38400;
        case 125000: return Ds2BaudRate.Baud125000;
        default: return Ds2BaudRate.Baud9600;
    }
}

/*
 * There is deliberately NO inter-telegram delay setting here, and that is a measured decision rather
 * than an omission.
 *
 * BMW's own stacks all use one — EDIABAS spins until `ParRegenTime` has elapsed since the last
 * response (`EdInterfaceObd.TransDs2`), BMW Scanner 1.4.0 ships `Delay=20` / `Delay2=40` in
 * `bmwscan.ini` — while the reference C# tool declares a `CommandDelay` hook and never assigns it. So
 * running at zero, as this link does, looked like the outlier worth fixing, on the theory that we were
 * overrunning a twenty-year-old ECU at 38400.
 *
 * A selectable 0/5/10/20/40 ms gap was built and swept on the car. It changed **nothing**: the DME's
 * turnaround stayed at 104-121 ms at every setting and the read still died at chunk 0/1/9/1/17. The
 * hypothesis it was built to test was itself an artifact — see §9 — and at 9600 a 40 ms gap is simply
 * 21 s of pure loss across 538 chunks. Removed rather than left as a knob that can only hurt.
 */

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

// --- Encoding checksum (control 0x0A) -----------------------------------------------------------
//
// The DME's own verdict on its own flash. Ported from the reference Ds2EncodingChecksumResult.cs,
// where it is the substance of `ProgrammingVerificationMode.QuickVerify` — that tool's DEFAULT
// post-write check, and the reason it does not read 64 KB back after every flash.
//
// One exchange: request `12 04 0A 1C` (4 bytes), response `12 05 A0 xx ck` (5 bytes). ~50 ms at
// 9600 against ~123 s for a full read-back of the same region.
//
// What it actually proves is worth being precise about, because it is NOT the same guarantee as a
// read-back. The MSS54HP stores CRC-16/ARC values for each area inside the flash itself (see
// checksum/dmeDataChecksum.ts — two slots covering 65528 of the data pair's 65536 bytes). This asks
// the DME whether its own stored CRCs match its own contents. So it is an external authority on the
// bytes rather than a second copy of our read path — a systematic transport fault corrupts a
// read-back and a re-read identically, and cannot forge a CRC the ECU computed for itself. What it
// cannot do is say WHERE a mismatch is, or catch a corruption that happens to preserve CRC-16.

export interface Ds2EncodingChecksumArea {
    bit: number;
    name: string;
    /** **A SET BIT MEANS FAULTED.** The polarity is the easy thing to get backwards, and getting it
     *  backwards turns this check into one that passes on a broken flash and fails on a good one. */
    faulted: boolean;
}

export interface Ds2EncodingChecksum {
    /** The raw status byte, kept so a report can carry what the DME actually said. */
    lowByte: number;
    /** Some DMEs answer with a second byte. The reference accepts 1 or 2 and decodes only the first;
     *  it is retained rather than dropped so an unexpected value is visible in a saved report. */
    extraByte: number | null;
    areas: Ds2EncodingChecksumArea[];
}

/** Bit → area, exactly the reference's table. Bits 3 and 7 are not assigned by it. */
const ENCODING_CHECKSUM_AREAS: readonly { bit: number; name: string }[] = [
    { bit: 0, name: 'Boot sector master' },
    { bit: 1, name: 'Program master' },
    { bit: 2, name: 'Data master' },
    { bit: 4, name: 'Boot sector slave' },
    { bit: 5, name: 'Program slave' },
    { bit: 6, name: 'Data slave' },
];

/**
 * The two areas a DataTune write touches, and therefore the only two a tune's QuickVerify may judge.
 *
 * Matches the reference's `DataChecksumBits = { 2, 6 }`. Deliberately not "all areas must be clean":
 * a program-area fault is a real fact about the ECU but it is not something this write caused or
 * could fix, and failing a good tune write on it would be wrong. It is reported, not thrown on.
 */
export const DATA_TUNE_CHECKSUM_BITS: readonly number[] = [2, 6];

export function parseEncodingChecksum(frame: Ds2Frame): Ds2EncodingChecksum {
    if (!isPositiveResponse(frame)) {
        throw new Error(`Encoding checksum query answered DS2 status 0x${frame.controlOrStatus.toString(16)}`);
    }
    if (frame.payload.length < 1 || frame.payload.length > 2) {
        throw new Error(`Encoding checksum payload must be 1 or 2 bytes, got ${frame.payload.length}`);
    }
    const lowByte = frame.payload[0];
    return {
        lowByte,
        extraByte: frame.payload.length === 2 ? frame.payload[1] : null,
        areas: ENCODING_CHECKSUM_AREAS.map(a => ({ ...a, faulted: (lowByte & (1 << a.bit)) !== 0 })),
    };
}

/** The faulted areas among `bits`. Empty means those areas are clean by the DME's own reckoning. */
export function faultedAreas(result: Ds2EncodingChecksum, bits: readonly number[]): Ds2EncodingChecksumArea[] {
    return result.areas.filter(a => bits.includes(a.bit) && a.faulted);
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
    /**
     * Bytes per read telegram. Deliberately SEPARATE from writeChunkSize even though both are 122
     * today, because they are bounded by different things and only one of them can ever grow.
     *
     * A read is bounded by DS2 framing alone: buildDs2Frame caps a frame at 255 bytes and a read
     * response is [addr][len][status][N][cksum], so N <= 251. 122 is not a protocol limit — it is the
     * reference tool's undocumented default, and BMW's own SGBD job FLASH_LESEN uses 120. The DME
     * publishes its real maximum in the system address table (see SYSTEM_ADDRESS_INDEX.MAX_TELEGRAM).
     *
     * They shared one constant until 2026-07-29. That is a latent brick: writePartialBinInner erases
     * before it writes, and the only thing stopping an over-long write is a runtime throw inside
     * buildWriteMemoryPayload — which would fire on the first chunk, i.e. on an already-erased ECU.
     */
    readChunkSize: 122,
    /**
     * Bytes per write telegram. **122 is already the maximum legal value and cannot be raised.**
     * The DS2 write count caps at 123 (buildWriteMemoryPayload), and flash programming needs an even
     * length at an even address — so 122 is the largest even value that fits. Splitting the constants
     * therefore costs the write path nothing; it only removes the coupling.
     */
    writeChunkSize: 122,
} as const;

/**
 * Load-time invariant on the write chunk. This exists to turn a mid-flash throw — the failure mode
 * that lands on a half-erased ECU — into an import-time failure that cannot reach a car.
 *
 * Runs at module scope on purpose: `npm run build` prerenders, so a bad constant fails the build.
 */
(function assertWriteChunkIsFlashSafe() {
    const { writeChunkSize, slave, master } = Mss54HpDataTuneLayout;
    if (writeChunkSize > 123) {
        throw new Error(`Mss54HpDataTuneLayout.writeChunkSize ${writeChunkSize} exceeds the DS2 write cap of 123`);
    }
    if (writeChunkSize <= 0 || writeChunkSize % 2 !== 0) {
        throw new Error(`Mss54HpDataTuneLayout.writeChunkSize ${writeChunkSize} must be positive and even (flash writes are even-aligned)`);
    }
    // An even chunk size only keeps every write even-aligned if the block base is even too.
    for (const [name, block] of [['slave', slave], ['master', master]] as const) {
        if (block.address % 2 !== 0) {
            throw new Error(`Mss54HpDataTuneLayout.${name}.address 0x${block.address.toString(16)} must be even`);
        }
    }
})();
