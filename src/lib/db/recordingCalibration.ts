import type { BaseOrigin, SessionBinariesRecord, TuningSession } from './schema';
import { patchOnImage } from '@/lib/binary-engine/patcher';
import { analyzeDataChecksum, readStoredChecksums } from '@/lib/checksum/dmeDataChecksum';
import { BinaryParser } from '@/lib/binary-engine/parser';

type Checksums = { slave: number; master: number };
type ReferenceSource = { sessionId: string; kind: 'base' | 'tuned' | 'patch-flash'; at: number };
export interface RecordingCalibration {
    version: 1;
    checkedAt: number;
    vin: string | null;
    mock: boolean;
    ecuChecksums?: Checksums;
    status: 'matched' | 'recorded-flash-reference' | 'unresolved';
    reason?: 'mock' | 'vehicle-unknown' | 'read-failed' | 'no-reference' | 'ambiguous-reference';
    /** A checksum-matched reference, NOT a byte-for-byte ECU readback. Kept with the
     * log so deleting a source session or changing BASE cannot change its meaning. */
    reference?: { source: ReferenceSource; sha256: string; bytes: number[] };
    /** Historical write evidence for a log predating START checksum capture. This
     * does not assert that an unrecorded later write or a vehicle readback was checked. */
    historical?: { recordingSessionId: string; boundaryAt: number; evidence: 'last-explicit-real-flash' };
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

/** Recover old-log provenance from the last recorded real flash for the same car.
 * The most recent record is authoritative even when its artifact is unavailable:
 * never skip an unverifiable newer write to reuse a convenient older calibration.
 * No live ECU checksum is fabricated and no source session/log/BIN is modified. */
export async function recoverHistoricalRecordingCalibration(input: {
    recordingSession: TuningSession;
    sessions: readonly TuningSession[];
    loadBinaries: (id: string) => Promise<SessionBinariesRecord | null>;
    logDurationSec?: number;
}): Promise<RecordingCalibration | null> {
    const target = input.recordingSession, boundary = target.createdAt;
    const vin = sessionVehicle(target, input.sessions);
    if (!vin || !Number.isFinite(boundary)) return null;
    const sameVehicle = input.sessions.filter(s => sessionVehicle(s, input.sessions) === vin);
    const events = sameVehicle.flatMap(s => s.flashHistory.filter(f => !f.practice).map(f => ({ session: s, flash: f })));
    const duration = input.logDurationSec ?? 0;
    if (!Number.isFinite(duration) || duration < 0 || events.some(e => e.flash.at > boundary && e.flash.at <= boundary + duration*1000)) return null;
    const prior = events.filter(e => Number.isFinite(e.flash.at) && e.flash.at <= boundary).sort((a,b) => b.flash.at-a.flash.at);
    if (!prior.length || prior[0].flash.practice !== false) return null;
    const newest = prior.filter(e => e.flash.at === prior[0].flash.at);
    if (newest.some(e => e.flash.practice !== false || e.flash.sha256 !== newest[0].flash.sha256)) return null;
    const chosen = newest[0];
    const source = await input.loadBinaries(chosen.session.id), targetBins = await input.loadBinaries(target.id);
    if (!source || !targetBins || !target.baseSha256 || await digest(targetBins.baseBinaryBuffer) !== target.baseSha256) return null;
    try {
        const flash = chosen.flash;
        let image: ArrayBuffer;
        if (flash.tuned === false) {
            if (!chosen.session.baseSha256 || await digest(source.baseBinaryBuffer) !== chosen.session.baseSha256) return null;
            image = patchOnImage(source.baseBinaryBuffer, { ...flash.settings, applyTankVentDisable: !!flash.settings.applyTankVentDisable });
        } else if (flash.tuned === true && source.tunedBinaryBuffer) {
            image = source.tunedBinaryBuffer;
        } else return null;
        if (image.byteLength !== 65536 || await digest(image) !== flash.sha256
            || !analyzeDataChecksum(new Uint8Array(image)).every(c => c.isValid)) return null;
        if (JSON.stringify(new BinaryParser(image).getVETable()) !== JSON.stringify(new BinaryParser(targetBins.baseBinaryBuffer).getVETable())) return null;
        return { version: 1, checkedAt: boundary, vin, mock: false, status: 'recorded-flash-reference',
            historical: { recordingSessionId: target.id, boundaryAt: boundary, evidence: 'last-explicit-real-flash' },
            reference: { source: { sessionId: chosen.session.id, kind: flash.tuned ? 'tuned' : 'patch-flash', at: flash.at },
                sha256: flash.sha256, bytes: Array.from(new Uint8Array(image)) } };
    } catch { return null; }
}

/** Verify again after SAVE/SYNC/recovery. JSON is data, not a trusted assertion. */
export async function recordingCalibrationBuffer(record: RecordingCalibration | null | undefined): Promise<ArrayBuffer | null> {
    try {
        if (record?.version !== 1 || !['matched','recorded-flash-reference'].includes(record.status) || record.mock || !record.vin
            || record.vin === 'UNKNOWN' || !Number.isFinite(record.checkedAt) || !record.reference
            || !Number.isFinite(record.reference.source.at) || record.reference.source.at > record.checkedAt) return null;
        if (record.status === 'matched' && (!record.ecuChecksums || !validCrc(record.ecuChecksums))) return null;
        if (record.status === 'recorded-flash-reference' && (record.ecuChecksums !== undefined
            || !record.historical?.recordingSessionId || record.historical.boundaryAt !== record.checkedAt
            || record.historical.evidence !== 'last-explicit-real-flash'
            || !['patch-flash','tuned'].includes(record.reference.source.kind))) return null;
        const { bytes, sha256 } = record.reference;
        if (!Array.isArray(bytes) || bytes.length !== 65536
            || bytes.some(x => !Number.isInteger(x) || x < 0 || x > 255)) return null;
        const image = new Uint8Array(bytes);
        if (!analyzeDataChecksum(image).every(c => c.isValid)
            || (record.status === 'matched' && !same(readStoredChecksums(image), record.ecuChecksums!))
            || await digest(image.buffer) !== sha256) return null;
        return image.buffer;
    } catch { return null; }
}
