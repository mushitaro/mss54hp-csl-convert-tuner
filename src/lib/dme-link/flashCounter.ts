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

/**
 * `50 60 70 33` — the OTHER marker at the same `prepMarkerOffset`, used by FAST READ entry and by
 * the Service Info restore.
 *
 * The comment above has described this byte string since the flash-counter work landed, as the
 * thing not to confuse `K16.` with. It finally has a caller. Same address, different payload,
 * different operation: `K16.` prepares a counter CLEAR, this prepares an erase whose contents are
 * going straight back.
 *
 * Written only when the four bytes there are still erased — a DME that has had fast entry run
 * before already carries it, and rewriting a programmed cell is what the verify byte rejects.
 */
export const FAST_ENTRY_PREP_MARKER = new Uint8Array([0x50, 0x60, 0x70, 0x33]);

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

/**
 * The reset is enabled. It was disabled for one day and the disabling was itself a mistake.
 *
 * What happened: on a real vehicle the slave service block looked "erased" to the old guard, so the
 * reset refused. That was read as evidence the slave address was wrong and the feature was switched
 * off. A read-only dump of both blocks then settled it (2026-07-28, VIN WBSBL92000PP86271):
 *
 *  - `AIF 0x001D50 -> lies in: master`, and real VIN/software numbers parsed out of the master image,
 *    so the master read lands correctly.
 *  - Slave block: 99.3% 0xFF, exactly **two** distinct byte values, and a flash counter reading
 *    15/30 — the same count as the master. The slave read lands correctly too; that block simply
 *    holds nothing but the counter.
 *  - Every identity pointer (DIF, ZIF backup, BRIF, ZIF, AIF) resolves into master space.
 *
 * So a near-empty slave block is the normal state, not damage, and the address was never in doubt.
 * The guard was wrong; see hasIntactAif for what replaced it.
 */
export const FLASH_COUNTER_RESET_ENABLED = true;

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
 * True when the AIF records the reset is about to preserve are actually present.
 *
 * This replaces an earlier check that asked "is everything outside the counter erased?" and treated
 * yes as the fingerprint of an interrupted reset. Real-vehicle data (2026-07-28) showed that test to
 * be worthless: the **slave** service block normally contains nothing but the flash counter — the
 * AIF, ZIF, DIF and BRIF pointers all resolve into master space — so the old check reported "erased"
 * on every healthy DME and blocked the reset outright.
 *
 * What is actually worth verifying is narrower and concrete: the block still holds the identity
 * records, so that erasing and writing it back preserves rather than cements. Everything else about
 * the block being sparse is normal and says nothing.
 *
 * `aifOffset` is the DME's own AIF pointer converted to an offset within this image; pass null when
 * the AIF does not live in this block, in which case there is nothing here to protect and the answer
 * is true.
 */
export function hasIntactAif(image: Uint8Array, aifOffset: number | null): boolean {
    assertServiceBlockLength(image);
    if (aifOffset === null) return true;
    // One populated 46-byte record is enough — a DME with any programming history has at least one,
    // and requiring more would refuse a legitimately once-programmed ECU.
    const end = Math.min(aifOffset + AIF_RECORD_LENGTH * AIF_RECORD_COUNT, image.length);
    for (let i = aifOffset; i < end; i++) {
        if (image[i] !== 0xFF && image[i] !== 0x00) return true;
    }
    return false;
}

const AIF_RECORD_LENGTH = 46;
const AIF_RECORD_COUNT = 14;

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

/**
 * How bad the flash-counter situation is, in the two levels that mean different things.
 *
 * It was a single boolean called `hasFlashCounterWarning`, and nothing used it — because neither
 * caller can act on one bit. `blocked` and `low` are not degrees of the same problem: `blocked`
 * means a boot field is not closed, which is a programming session still open and stops a reset
 * outright; `low` is headroom, which only asks the operator to think. The header paints them red and
 * amber for exactly that reason, and had to work it out itself.
 *
 * Worst-of, over both processors, because a limit reached on either half is reached.
 */
export type FlashCounterLevel = 'blocked' | 'low' | 'ok';

export function classifyFlashCounter(regions: FlashCounterInfo | readonly FlashCounterRegion[]): FlashCounterLevel {
    const list = Array.isArray(regions) ? regions : [(regions as FlashCounterInfo).master, (regions as FlashCounterInfo).slave];
    if (list.some(r => r.state !== 'available')) return 'blocked';
    if (list.some(r => r.remaining < LOW_SLOT_WARNING_THRESHOLD)) return 'low';
    return 'ok';
}
