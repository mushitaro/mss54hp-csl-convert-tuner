import type { BaseOrigin, SessionBinariesRecord, TuningSession } from './schema';
import { patchOnImage } from '@/lib/binary-engine/patcher';
import { analyzeDataChecksum, readStoredChecksums } from '@/lib/checksum/dmeDataChecksum';

type Checksums = { slave: number; master: number };
type ReferenceSource = { sessionId: string; kind: 'base' | 'tuned' | 'patch-flash'; at: number };
export interface RecordingCalibration {
    version: 1;
    checkedAt: number;
    vin: string | null;
    mock: boolean;
    ecuChecksums?: Checksums;
    status: 'matched' | 'unresolved';
    reason?: 'mock' | 'vehicle-unknown' | 'read-failed' | 'no-reference' | 'ambiguous-reference';
    /** A checksum-matched reference, NOT a byte-for-byte ECU readback. Kept with the
     * log so deleting a source session or changing BASE cannot change its meaning. */
    reference?: { source: ReferenceSource; sha256: string; bytes: number[] };
}

const digest = async (buffer: ArrayBuffer) => Array.from(new Uint8Array(
    await crypto.subtle.digest('SHA-256', buffer))).map(x => x.toString(16).padStart(2, '0')).join('');
const same = (a: Checksums, b: Checksums) => a.slave === b.slave && a.master === b.master;
const validCrc = (c: Checksums) => [c.slave, c.master].every(x => Number.isInteger(x) && x >= 0 && x <= 65535);

/** Follow BASE ancestry only to establish vehicle identity, never to guess patches. */
export function sessionVehicle(session: TuningSession, sessions: readonly TuningSession[]): string | null {
    const seen = new Set<string>();
    let current: TuningSession | undefined = session;
    while (current && !seen.has(current.id)) {
        seen.add(current.id);
        const origin: BaseOrigin | null = current.baseOrigin;
        if (origin?.kind === 'dme') return origin.vin && origin.vin !== 'UNKNOWN' ? origin.vin : null;
        current = origin?.kind === 'session' ? sessions.find(s => s.id === origin.sessionId) : undefined;
    }
    return null;
}

/** Read-only at START. Future write toggles and a stale BASE are never evidence of
 * installed patches. A patch-only flash can be reconstructed only when its exact
 * SHA-256 agrees with the real flash record. The car's two stored CRCs then select
 * a reference; different known images with the same pair are ambiguous. */
export async function captureRecordingCalibration(input: {
    sessions: readonly TuningSession[];
    loadBinaries: (id: string) => Promise<SessionBinariesRecord | null>;
    readChecksums: () => Promise<Checksums>;
    vin: string | null;
    mock: boolean;
    now?: () => number;
}): Promise<RecordingCalibration> {
    const now = input.now ?? Date.now;
    const result: RecordingCalibration = {
        version: 1, checkedAt: now(), vin: input.vin, mock: input.mock, status: 'unresolved',
    };
    if (input.mock) return { ...result, reason: 'mock' };
    if (!input.vin || input.vin === 'UNKNOWN') return { ...result, reason: 'vehicle-unknown' };
    try {
        result.ecuChecksums = await input.readChecksums();
        result.checkedAt = now();
        if (!validCrc(result.ecuChecksums)) throw new Error('Invalid CRC');
    } catch { return { ...result, reason: 'read-failed', ecuChecksums: undefined }; }
    const matches = new Map<string, NonNullable<RecordingCalibration['reference']>>();
    const consider = async (buffer: ArrayBuffer | null | undefined, expected: string | undefined, source: ReferenceSource) => {
        if (!buffer || !expected || source.at > result.checkedAt) return;
        const bytes = new Uint8Array(buffer);
        if (bytes.length !== 65536 || !analyzeDataChecksum(bytes).every(c => c.isValid)
            || !same(readStoredChecksums(bytes), result.ecuChecksums!)) return;
        const hash = await digest(buffer);
        if (hash !== expected) return;
        matches.set(hash, { source, sha256: hash, bytes: Array.from(bytes) });
    };
    for (const session of input.sessions) {
        if (session.createdAt > result.checkedAt || sessionVehicle(session, input.sessions) !== input.vin) continue;
        const bins = await input.loadBinaries(session.id);
        if (!bins) continue;
        await consider(bins.baseBinaryBuffer, session.baseSha256, { sessionId: session.id, kind: 'base',
            at: session.baseOrigin?.kind === 'dme' ? session.baseOrigin.readAt : session.createdAt });
        await consider(bins.tunedBinaryBuffer, session.sha256, { sessionId: session.id, kind: 'tuned', at: session.createdAt });
        for (const flash of session.flashHistory) {
            if (flash.practice || flash.tuned !== false || flash.at > result.checkedAt) continue;
            // BASE can have been replaced since the flash. The reconstructed SHA below must
            // still match; a settings bag alone never earns a reference.
            if (bins.baseBinaryBuffer.byteLength !== 65536) continue;
            await consider(patchOnImage(bins.baseBinaryBuffer, {
                ...flash.settings, applyTankVentDisable: !!flash.settings.applyTankVentDisable,
            }), flash.sha256,
                { sessionId: session.id, kind: 'patch-flash', at: flash.at });
        }
    }
    if (matches.size !== 1) return { ...result, reason: matches.size ? 'ambiguous-reference' : 'no-reference' };
    return { ...result, status: 'matched', reference: [...matches.values()][0] };
}

/** Verify again after SAVE/SYNC/recovery. JSON is data, not a trusted assertion. */
export async function recordingCalibrationBuffer(record: RecordingCalibration | null | undefined): Promise<ArrayBuffer | null> {
    try {
        if (record?.version !== 1 || record.status !== 'matched' || record.mock || !record.vin
            || record.vin === 'UNKNOWN' || !Number.isFinite(record.checkedAt) || !record.ecuChecksums
            || !validCrc(record.ecuChecksums) || !record.reference
            || !Number.isFinite(record.reference.source.at) || record.reference.source.at > record.checkedAt) return null;
        const { bytes, sha256 } = record.reference;
        if (!Array.isArray(bytes) || bytes.length !== 65536
            || bytes.some(x => !Number.isInteger(x) || x < 0 || x > 255)) return null;
        const image = new Uint8Array(bytes);
        if (!analyzeDataChecksum(image).every(c => c.isValid) || !same(readStoredChecksums(image), record.ecuChecksums)
            || await digest(image.buffer) !== sha256) return null;
        return image.buffer;
    } catch { return null; }
}
