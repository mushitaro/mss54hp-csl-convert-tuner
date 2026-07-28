/**
 * DME flash counter (boot-mode field) layout and decoding, ported from the reference
 * Mss54Ds2Tool source (DmeFlashCounter.cs, Ds2ProgrammingSubsegment.cs, DmeBinaryLayout.cs,
 * ClearFlashCounterExecutor.cs).
 *
 * The counter is NOT part of the identity response. It lives inside the 8 KB "Free Identifiers"
 * (Service Info) block — the same block that carries AIF, ZIF and the VIN records — at offset
 * 0x800, as a 256-byte run of 2-byte big-endian markers. Every programming session consumes one
 * 4-byte slot (two markers), and the DME stops accepting programming once the field is full.
 *
 * Everything here is pure: no serial, no DS2 framing. That's deliberate — the reset rewrites the
 * block that holds the ECU's identity, so the byte-level rules deserve to be checkable without a
 * cable in the loop.
 */

/**
 * DS2 addressing for the service block on both processors.
 *
 * Addresses come from Ds2ProgrammingSubsegment.CreateAddress: `(nibble << 20) | offset`, where the
 * FreeIdentifiers block is nibble 0 and the slave processor adds 8. So master = 0x000000 and
 * slave = 0x800000, each 8192 bytes (DmeBinaryLayout.Region, ServiceFreeIdentifiersLength).
 */
export const ServiceBlockLayout = {
    master: { name: 'Master', address: 0x000000, length: 8192 },
    slave: { name: 'Slave', address: 0x800000, length: 8192 },
    /** Offset of the counter within a service block (DmeFlashCounter.FlashCounterOffsetWithinFreeIdentifiers). */
    counterOffset: 0x800,   // 2048
    counterLength: 256,
    /** Offset of the clear-preparation marker (DmeFlashCounter.ClearPrepMarkerOffsetWithinFreeIdentifiers). */
    prepMarkerOffset: 0x900, // 2304
    /** DmeFlashCounter.KnownFlashLimitPerProcessor. */
    limitPerProcessor: 30,
    markerSize: 2,
    slotSize: 4,
} as const;

/** Combined master+slave service block image, in the reference's artifact order (master first). */
export const SERVICE_BLOCK_PAIR_LENGTH = ServiceBlockLayout.master.length + ServiceBlockLayout.slave.length;

/**
 * ASCII "K16." — written to `prepMarkerOffset` before the clear so the DME permits the service
 * block to be erased and rewritten (DmeFlashCounter.CreateClearPrepMarkerBytes).
 *
 * Not to be confused with the reference's OTHER marker at the same offset, `50 60 70 33`, which
 * belongs to the Service Info restore and fast-entry read flows. Same address, different payload,
 * different operation.
 */
export const CLEAR_PREP_MARKER = new Uint8Array([0x4B, 0x31, 0x36, 0x2E]);

/** What the first non-consumed marker says the boot field is doing (DmeFlashCounter.DecodeState). */
export type FlashCounterState =
    | 'available'                 // 0xFFFF — closed and ready to accept another programming session
    | 'dataProgrammingActive'     // 0x00FF — a data programming session is open
    | 'programProgrammingActive'  // 0xFF00 — a program programming session is open
    | 'fullOrUnknown';            // anything else

export interface FlashCounterRegion {
    name: string;
    /** DS2 address of the counter itself, for diagnostics. */
    address: number;
    /** Slots consumed so far (DmeFlashCounterRegion.ProgrammedEntryPairs). */
    used: number;
    /** Slots left before this processor refuses further programming. */
    remaining: number;
    /** The first marker that wasn't 0x0000 — what `state` was decoded from. */
    firstOpenMarker: number;
    state: FlashCounterState;
}

export interface FlashCounterInfo {
    master: FlashCounterRegion;
    slave: FlashCounterRegion;
    readAt: number;
}

/** Below this many free slots the header switches to a warning color (the reference warns at 5). */
export const LOW_SLOT_WARNING_THRESHOLD = 5;

function decodeState(marker: number): FlashCounterState {
    switch (marker) {
        case 0xFFFF: return 'available';
        case 0x00FF: return 'dataProgrammingActive';
        case 0xFF00: return 'programProgrammingActive';
        default: return 'fullOrUnknown';
    }
}

/**
 * Decodes one 256-byte counter region. Verbatim port of DmeFlashCounter.Analyze.
 *
 * The scan walks 2-byte big-endian markers until it meets one that isn't 0x0000 — that value is
 * the field's current state, and everything before it is a consumed slot. Note the two details
 * that are easy to get wrong porting this:
 *
 *  - The loop is do/while, so a region whose very first marker is non-zero still advances `i` by 2
 *    and then backs it out, landing on 0 used. Rewriting it as a `while` changes that.
 *  - `i` steps by 2 but a slot is 4 bytes, so `i / 4` is not always an integer. C# integer division
 *    truncates; JS does not, which is why Math.trunc is explicit here. Without it a field caught
 *    mid-programming reports a fractional "used" count.
 */
export function analyzeFlashCounter(name: string, address: number, data: Uint8Array): FlashCounterRegion {
    if (data.length !== ServiceBlockLayout.counterLength) {
        throw new Error(`Expected ${ServiceBlockLayout.counterLength} flash counter byte(s), got ${data.length}`);
    }
    let i = 0;
    let marker: number;
    do {
        marker = (data[i] << 8) | data[i + 1];
        i += 2;
    } while (marker === 0 && i < data.length - 2);
    i -= 2;

    const used = Math.trunc(i / ServiceBlockLayout.slotSize);
    return {
        name,
        address,
        used,
        remaining: Math.max(0, ServiceBlockLayout.limitPerProcessor - used),
        firstOpenMarker: marker,
        state: decodeState(marker),
    };
}

function assertServiceBlockLength(image: Uint8Array): void {
    if (image.length !== ServiceBlockLayout.master.length) {
        throw new Error(`Expected ${ServiceBlockLayout.master.length} service block byte(s), got ${image.length}`);
    }
}

/** The counter bytes out of a full 8 KB service block image (ServiceBlockOperationSupport.ExtractFlashCounterRead). */
export function extractCounterFromServiceBlock(image: Uint8Array): Uint8Array {
    assertServiceBlockLength(image);
    const start = ServiceBlockLayout.counterOffset;
    return image.subarray(start, start + ServiceBlockLayout.counterLength);
}

/**
 * Builds the service block image to write back, with the counter reset
 * (DmeFlashCounter.CreateResetFreeIdentifiersImage). Everything outside the 256-byte counter —
 * AIF, ZIF, the VIN records — is copied through untouched.
 *
 * A cleared counter is NOT all-0xFF, and the result is NOT 0/30: the first slot is zeroed, which
 * analyzeFlashCounter reads as one consumed slot. 0x0000 is the "consumed, keep looking" sentinel
 * the scan walks over, so a field of pure 0xFF would leave no sentinel at all. After a reset the
 * DME reports 1/30 used, 29 remaining — that is the correct, expected outcome, not an off-by-one.
 */
export function buildResetServiceBlockImage(image: Uint8Array): Uint8Array {
    assertServiceBlockLength(image);
    const out = new Uint8Array(image); // copy — the caller keeps the original as its backup
    const start = ServiceBlockLayout.counterOffset;
    out.fill(0xFF, start, start + ServiceBlockLayout.counterLength);
    out.fill(0x00, start, start + ServiceBlockLayout.slotSize);
    return out;
}

/**
 * True when this service block holds nothing but erased cells outside the counter.
 *
 * That is the fingerprint of a reset that was interrupted between its erase and its rewrite: the
 * block's real contents — the AIF, the ZIF, the VIN records — are gone and have not been put back.
 *
 * It has to be tested separately because the counter alone cannot reveal it. An erased counter reads
 * as marker `0xFFFF`, which `analyzeFlashCounter` reports as `available` with 0 slots used — a
 * perfectly healthy-looking field. A second reset run would therefore sail past the boot-field guard,
 * take the erased block as its "current contents", and write that back as the plan, making the loss
 * permanent and verified.
 */
export function isServiceBlockErased(image: Uint8Array): boolean {
    assertServiceBlockLength(image);
    const counterStart = ServiceBlockLayout.counterOffset;
    const counterEnd = counterStart + ServiceBlockLayout.counterLength;
    for (let i = 0; i < image.length; i++) {
        if (i >= counterStart && i < counterEnd) continue; // the counter is 0xFF by design after a reset
        if (image[i] !== 0xFF) return false;
    }
    return true;
}

/**
 * Whether the clear-preparation marker still needs writing on this processor
 * (DmeFlashCounter.ShouldWriteClearPrepMarker): only when those 4 bytes are still erased. Writing
 * it a second time would be a program cycle on cells that already hold data, which the DME rejects.
 */
export function shouldWriteClearPrepMarker(image: Uint8Array): boolean {
    assertServiceBlockLength(image);
    const start = ServiceBlockLayout.prepMarkerOffset;
    for (let i = 0; i < CLEAR_PREP_MARKER.length; i++) {
        if (image[start + i] !== 0xFF) return false;
    }
    return true;
}

/** True when either processor is out of headroom or not in a closed/available state. */
export function hasFlashCounterWarning(info: FlashCounterInfo): boolean {
    for (const region of [info.master, info.slave]) {
        if (region.state !== 'available') return true;
        if (region.remaining < LOW_SLOT_WARNING_THRESHOLD) return true;
    }
    return false;
}
