import type { BinaryPatcher } from '@/lib/binary-engine/patcher';
import { overlapsChecksumSlot, PARTIAL_BIN_LENGTH } from '@/lib/ecu-items/codec';
import { type CalEdit, type RunSpan, editSpan, managedSpans, SEALED_CAL_SYMBOLS } from './edits';

/**
 * The byte boundary of the calibration editor.
 *
 * Called from useBinaryFile.buildPatchedBuffer, after every table writer and
 * immediately before applyChecksumCorrection — so an edit can never be
 * clobbered by a writer on unrelated bytes, and can never clobber an armed
 * writer because overlaps are skipped HERE, not only greyed out in the UI.
 * The arbitration lives on the byte side deliberately (the same stance as the
 * restoreVe ordering note in useBinaryFile): `extras` lets a caller reach the
 * build with any combination, so the UI's locks cannot be the only rail.
 */

export interface CalibrationApplyReport {
    applied: Array<{ paramId: string; name: string; bytes: number }>;
    skipped: Array<{ paramId: string; name: string; reason: string }>;
}

/** Two's-complement encode a signed raw into its unsigned field value. */
function encodeRaw(raw: number, bits: 8 | 16, signed: boolean): number {
    if (!signed || raw >= 0) return raw;
    return raw + (bits === 8 ? 0x100 : 0x10000);
}

export function applyCalibrationEdits(
    patcher: BinaryPatcher,
    edits: CalEdit[],
    conflictSpans: RunSpan[],
): CalibrationApplyReport {
    const report: CalibrationApplyReport = { applied: [], skipped: [] };
    // The permanent locks are re-asserted here even though the catalog never
    // hands out an edit for them: apply must hold on its own.
    const spans = [...managedSpans(), ...conflictSpans];
    // The ACTUAL buffer, not only the 0x10000 constant: a loader that accepted a
    // short image must fail here as a skip, not as a DataView throw mid-build.
    const bufferLength = Math.min(PARTIAL_BIN_LENGTH, patcher.getBuffer().byteLength);

    for (const edit of edits) {
        const { start, length } = editSpan(edit);
        const end = start + length;
        const skip = (reason: string) =>
            report.skipped.push({ paramId: edit.paramId, name: edit.name, reason });

        if (edit.raw.length !== edit.count) { skip('run length mismatch'); continue; }
        if (start < 0 || end > bufferLength) { skip('outside the partial BIN'); continue; }
        if (overlapsChecksumSlot(start, end)) { skip('checksum slot'); continue; }
        if (SEALED_CAL_SYMBOLS.has(edit.name)) { skip('sealed'); continue; }
        const owner = spans.find(s => start < s.address + s.length && end > s.address);
        if (owner) { skip(`owned by ${owner.owner}`); continue; }

        const min = edit.signed ? (edit.bits === 8 ? -128 : -32768) : 0;
        const max = edit.signed ? (edit.bits === 8 ? 127 : 32767) : (edit.bits === 8 ? 255 : 65535);
        if (edit.raw.some(r => !Number.isInteger(r) || r < min || r > max)) {
            skip('raw out of field range');
            continue;
        }

        patcher.setRawRun(start, edit.bits, edit.raw.map(r => encodeRaw(r, edit.bits, edit.signed)));
        report.applied.push({ paramId: edit.paramId, name: edit.name, bytes: length });
    }
    return report;
}
