import { crc16Arc } from './crc16';

/**
 * MSS54HP "0401 partial BIN" data/tune-pair checksum (65536 bytes: slave half + master half).
 *
 * Ported from the reference Mss54Ds2Tool implementation (DmeDataChecksum.AnalyzeMss54Hp) and
 * confirmed byte-for-byte against a real stock partial BIN dump: both the slave (0x3FFC) and
 * master (0xBFFC) checksum slots matched their stored CRC-16/ARC values exactly.
 */
export const DATA_PAIR_LENGTH = 65536;
const HALF_LENGTH = 32768;
/** Where each half keeps its stored CRC: 2 bytes of checksum then 0xFF 0xFF of padding. */
export const CHECKSUM_OFFSET_WITHIN_HALF = 16380;
/** Bytes occupied by one slot — the CRC pair plus its padding. */
export const CHECKSUM_SLOT_LENGTH = 4;

export interface ChecksumSlotResult {
    name: string;
    offset: number;
    storedChecksum: number;
    calculatedChecksum: number;
    hasExpectedPadding: boolean;
    isValid: boolean;
}

function buildSlaveInput(image: Uint8Array): Uint8Array {
    // [image[16384:32768)] followed by [image[0:16380)]
    const input = new Uint8Array(32764);
    input.set(image.subarray(16384, 32768), 0);
    input.set(image.subarray(0, 16380), 16384);
    return input;
}

function buildMasterInput(image: Uint8Array): Uint8Array {
    // [image[49152:65536)] followed by [image[32768:49148)]
    const input = new Uint8Array(32764);
    input.set(image.subarray(49152, 65536), 0);
    input.set(image.subarray(32768, 49148), 16384);
    return input;
}

function createSlot(name: string, image: Uint8Array, offset: number, calculatedChecksum: number): ChecksumSlotResult {
    const storedChecksum = (image[offset] << 8) | image[offset + 1];
    const hasExpectedPadding = image[offset + 2] === 0xFF && image[offset + 3] === 0xFF;
    return {
        name,
        offset,
        storedChecksum,
        calculatedChecksum,
        hasExpectedPadding,
        isValid: storedChecksum === calculatedChecksum && hasExpectedPadding,
    };
}

/** Analyzes both checksum slots of a 65536-byte MSS54HP partial BIN without modifying it. */
export function analyzeDataChecksum(image: Uint8Array): ChecksumSlotResult[] {
    if (image.length !== DATA_PAIR_LENGTH) {
        throw new Error(`Expected a ${DATA_PAIR_LENGTH}-byte MSS54HP partial BIN, got ${image.length} bytes.`);
    }
    return [
        createSlot('Slave data', image, CHECKSUM_OFFSET_WITHIN_HALF, crc16Arc(buildSlaveInput(image))),
        createSlot('Master data', image, HALF_LENGTH + CHECKSUM_OFFSET_WITHIN_HALF, crc16Arc(buildMasterInput(image))),
    ];
}

/**
 * The two CRCs an image stores, without recomputing anything.
 *
 * Read rather than calculated on purpose. This is used to answer "is the calibration in the ECU the
 * one this tune was derived from?", and the honest comparison for that is stored-against-stored:
 * eight bytes off the car against eight bytes in the image. Recalculating would answer a different
 * question — whether the image is internally consistent — which `analyzeDataChecksum` already does.
 */
export function readStoredChecksums(image: Uint8Array): { slave: number; master: number } {
    if (image.length !== DATA_PAIR_LENGTH) {
        throw new Error(`Expected a ${DATA_PAIR_LENGTH}-byte MSS54HP partial BIN, got ${image.length} bytes.`);
    }
    const at = (offset: number) => (image[offset] << 8) | image[offset + 1];
    return {
        slave: at(CHECKSUM_OFFSET_WITHIN_HALF),
        master: at(HALF_LENGTH + CHECKSUM_OFFSET_WITHIN_HALF),
    };
}

/** Writes the recalculated checksum (+ 0xFF 0xFF padding) for both slots directly into `image`. */
export function correctDataChecksum(image: Uint8Array): void {
    for (const slot of analyzeDataChecksum(image)) {
        image[slot.offset] = (slot.calculatedChecksum >> 8) & 0xFF;
        image[slot.offset + 1] = slot.calculatedChecksum & 0xFF;
        image[slot.offset + 2] = 0xFF;
        image[slot.offset + 3] = 0xFF;
    }
}
