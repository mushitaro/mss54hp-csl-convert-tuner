/**
 * CRC-16/ARC (polynomial 0x8005, reflected form 0xA001, init 0).
 * Confirmed against a real MSS54HP partial BIN dump — see dmeDataChecksum.ts.
 */
export function crc16Arc(bytes: Uint8Array, initial: number = 0): number {
    let crc = initial;
    for (let i = 0; i < bytes.length; i++) {
        crc ^= bytes[i];
        for (let j = 0; j < 8; j++) {
            crc = (crc & 1) !== 0 ? (crc >>> 1) ^ 0xA001 : crc >>> 1;
        }
    }
    return crc & 0xFFFF;
}
