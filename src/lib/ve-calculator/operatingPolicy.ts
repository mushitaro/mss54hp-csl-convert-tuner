import { BinaryParser } from '@/lib/binary-engine/parser';
import { learnersFrozen } from '@/lib/log-engine/trimNeutrality';

export type OperatingHold = 'binary-missing' | 'air-model-active' | 'learning-active' | 'recording-map-mismatch';

/** All independent conditions, not just the first refusal. Purge capability is a
 * preparation warning; the sample gate still checks actual tank-vent activity. */
export function operatingCalibrationContext(buffer: ArrayBuffer | null | undefined) {
    try {
        if (!buffer) throw new Error('No recording calibration reference');
        const parser = new BinaryParser(buffer);
        const airModelActive = (parser.getUint8(0xE5E4) & 0x15) !== 0;
        const learningWindow = parser.readLtftLearnWindow();
        const learningActive = !learnersFrozen(learningWindow);
        const purgeEnabled = !parser.getTankVentDisabled();
        return { known: true as const, airModelActive, learningActive, learningWindow, purgeEnabled };
    } catch {
        return { known: false as const };
    }
}

/** Read the recording reference, never future write toggles. A different VE basis
 * cannot borrow this drive's evidence even when its logic patches match. */
export function operatingCalibrationHold(buffer: ArrayBuffer | null | undefined, tuningBase?: ArrayBuffer | null): OperatingHold | null {
    const context = operatingCalibrationContext(buffer);
    if (!context.known) return 'binary-missing';
    if (context.airModelActive) return 'air-model-active';
    if (context.learningActive) return 'learning-active';
    if (tuningBase) {
        try {
            const before = new BinaryParser(tuningBase).getVETable();
            const recorded = new BinaryParser(buffer!).getVETable();
            if (JSON.stringify(before) !== JSON.stringify(recorded)) return 'recording-map-mismatch';
        } catch { return 'binary-missing'; }
    }
    return null;
}
