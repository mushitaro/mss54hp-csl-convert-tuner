/**
 * Shared field decoding for DS2 data blocks, ported from the reference Mss54Ds2Tool source
 * (DmeLiveValueDecoder.cs, DmeAdaptationDecoder.cs).
 *
 * The reference has two field-format enums — DmeLiveValueFieldFormat (live values) and
 * DmeAdaptationFieldFormat (adaptations) — but they decode identically, and the adaptation set is a
 * strict subset of the live one. In particular the reference's adaptation `Int8` and its live-value
 * `Int7` are both `(sbyte)data[0]`; `int7` below covers both. So one decoder serves both block
 * families: liveValueBlocks.ts and adaptationBlocks.ts each own their field tables, and share this.
 */

/**
 * `uint10` is gone, and its removal is the point.
 *
 * The reference enum has one, and it was carried across as an alias for `uint16` — same two bytes,
 * same read, no mask. Nothing in either field table ever used it, so it was a name that would have
 * produced a wrong number the first time somebody reached for it: a ten-bit field read as sixteen
 * bits is off by whatever the top six hold. A format that does not decode what it is named after is
 * worse than no format, and adding the mask would be inventing an encoding no block here uses.
 */
export type FieldFormat = 'int7' | 'uint8' | 'int15' | 'uint16' | 'int31' | 'uint32';

export interface FieldDef {
    symbol: string;
    offset: number;
    format: FieldFormat;
    scale: number;
    add: number;
}

export function byteLength(format: FieldFormat): number {
    switch (format) {
        case 'int7': case 'uint8': return 1;
        case 'int15': case 'uint16': return 2;
        case 'int31': case 'uint32': return 4;
    }
}

export function readRaw(bytes: Uint8Array, format: FieldFormat): number {
    switch (format) {
        case 'int7': return (bytes[0] << 24) >> 24; // sign-extend int8
        case 'uint8': return bytes[0];
        case 'uint16': return (bytes[0] << 8) | bytes[1];
        case 'int15': return ((bytes[0] << 8) | bytes[1]) << 16 >> 16; // sign-extend int16
        case 'uint32': return ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
        case 'int31': return (bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3];
    }
}

/** Returns null when the payload is too short to hold this field — a real case, since a block's
 *  length varies by DME software version. Callers must distinguish that from a decoded 0. */
export function decodeField(payload: Uint8Array, field: FieldDef): number | null {
    const len = byteLength(field.format);
    if (field.offset < 0 || field.offset + len > payload.length) return null;
    const raw = readRaw(payload.subarray(field.offset, field.offset + len), field.format);
    return field.add + raw * field.scale;
}
