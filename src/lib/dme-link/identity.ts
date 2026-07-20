/**
 * DME identity (VIN / AIF / software version) parsing, ported from the reference Mss54Ds2Tool
 * source (Ds2SystemAddressTable.cs, DmeAifUserInfo.cs, DmeLogisticsInfoParser.cs,
 * DmeVariantDetector.cs). All byte offsets below are confirmed against that source, not guessed.
 */

const VIN_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export interface SystemAddressEntry {
    index: number;
    address24: number; // (high<<16)|(mid<<8)|low
}

/** DS2 control 0x0D response payload is a flat array of 3-byte (high, mid, low) pointer entries. */
export function parseSystemAddressTable(payload: Uint8Array): SystemAddressEntry[] {
    const count = Math.floor(payload.length / 3);
    const entries: SystemAddressEntry[] = [];
    for (let i = 0; i < count; i++) {
        const o = i * 3;
        entries.push({ index: i, address24: (payload[o] << 16) | (payload[o + 1] << 8) | payload[o + 2] });
    }
    return entries;
}

export function findPointer(entries: SystemAddressEntry[], index: number): number | null {
    const entry = entries.find(e => e.index === index);
    if (!entry) return null;
    if (entry.address24 === 0 || entry.address24 === 0xFFFFFF) return null; // unavailable
    return entry.address24;
}

function readBitsBigEndian(bytes: Uint8Array, bitOffset: number, bitLength: number): number {
    let result = 0;
    for (let i = 0; i < bitLength; i++) {
        const n = bitOffset + i;
        const bit = (bytes[Math.floor(n / 8)] >> (7 - (n % 8))) & 1;
        result = (result << 1) | bit;
    }
    return result;
}

function decodeAsciiDropNonPrintable(bytes: Uint8Array): string {
    let out = '';
    for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i];
        if (b >= 32 && b <= 126) out += String.fromCharCode(b);
    }
    return out.trim();
}

function decodeAsciiDotSubstitute(bytes: Uint8Array): string {
    let out = '';
    for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i];
        out += (b >= 32 && b <= 126) ? String.fromCharCode(b) : '.';
    }
    return out.trim();
}

/** AIF entry VIN field (bytes 0..12 of a 46-byte entry): ASCII if all printable, else packed 6-bit. */
function decodeVin(bytes13: Uint8Array): string {
    const allPrintable = Array.from(bytes13).every(b => b >= 32 && b <= 126);
    if (allPrintable) return decodeAsciiDropNonPrintable(bytes13);

    let vin = '';
    for (let bitOffset = 2; bitOffset < 104; bitOffset += 6) {
        const idx = readBitsBigEndian(bytes13, bitOffset, 6);
        vin += idx < VIN_ALPHABET.length ? VIN_ALPHABET[idx] : '?';
    }
    return vin;
}

function isBlankEntry(entry: Uint8Array): boolean {
    let allFF = true, allZero = true;
    for (let i = 0; i < entry.length; i++) {
        if (entry[i] !== 0xFF) allFF = false;
        if (entry[i] !== 0x00) allZero = false;
    }
    return allFF || allZero;
}

function decodeUInt24Decimal(bytes3: Uint8Array): string {
    const v = (bytes3[0] << 16) | (bytes3[1] << 8) | bytes3[2];
    return String(v).padStart(6, '0');
}

function decodeSixBitLetter(value: number): string {
    if (value < 1 || value > 26) return '?';
    return String.fromCharCode(65 + value - 1);
}

/** AIF "data stand"/software-number field (5 bytes: 24-bit number + 2 packed 6-bit letters). */
function decodeDataStand(bytes5: Uint8Array): string {
    const value = (bytes5[0] << 16) | (bytes5[1] << 8) | bytes5[2];
    const packed = ((bytes5[3] & 0xF) << 8) | bytes5[4];
    const letter1 = decodeSixBitLetter((packed >> 6) & 0x3F);
    const letter2 = decodeSixBitLetter(packed & 0x3F);
    return `${String(value).padStart(6, '0')}${letter1}${letter2}`;
}

export interface AifEntry {
    isBlank: boolean;
    vin: string;
    softwareNumber: string;
}

const AIF_ENTRY_LENGTH = 46;
export const AIF_TOTAL_LENGTH = 660; // 14 entries * 46 bytes + 16-byte tail

/** Parses the 660-byte AIF user-info block into its (up to) 14 fixed 46-byte entries. */
export function parseAifEntries(aifBytes: Uint8Array): AifEntry[] {
    const count = Math.floor(aifBytes.length / AIF_ENTRY_LENGTH);
    const entries: AifEntry[] = [];
    for (let i = 0; i < count; i++) {
        const entry = aifBytes.subarray(i * AIF_ENTRY_LENGTH, (i + 1) * AIF_ENTRY_LENGTH);
        entries.push({
            isBlank: isBlankEntry(entry),
            vin: decodeVin(entry.subarray(0, 13)),
            softwareNumber: decodeDataStand(entry.subarray(17, 22)),
        });
    }
    return entries;
}

/** The last non-blank entry is the most recently programmed record. */
export function latestPopulatedAifEntry(entries: AifEntry[]): AifEntry | null {
    const populated = entries.filter(e => !e.isBlank);
    return populated.length > 0 ? populated[populated.length - 1] : null;
}

/** ZIF (78 bytes): BMW program number lives at bytes 57-63 (7-byte ASCII), repeated 3x for redundancy. */
export function parseZifProgramNumber(zifBytes: Uint8Array): string | null {
    if (zifBytes.length < 64) return null;
    return decodeAsciiDotSubstitute(zifBytes.subarray(57, 64));
}

/** BRIF/ZIF-derived variant detection: first 8 raw bytes of the ZIF block, exact match. */
export function detectVariantFromZif(zifBytes: Uint8Array): 'mss54' | 'mss54hp' | 'unknown' {
    if (zifBytes.length < 8) return 'unknown';
    const code = decodeAsciiDotSubstitute(zifBytes.subarray(0, 8));
    switch (code) {
        case '21132200': return 'mss54';
        case '21132300':
        case '21132500': return 'mss54hp';
        default: return 'unknown';
    }
}
