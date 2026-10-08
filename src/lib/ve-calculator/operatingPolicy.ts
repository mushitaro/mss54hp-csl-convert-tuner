import { BinaryParser } from '@/lib/binary-engine/parser';
import { learnersFrozen } from '@/lib/log-engine/trimNeutrality';

export type OperatingHold = 'binary-missing' | 'air-model-active' | 'learning-active';

/** All independent conditions, not just the first refusal. Purge capability is a
 * preparation warning; the sample gate still checks actual tank-vent activity. */
export function operatingCalibrationContext(buffer: ArrayBuffer | null | undefined) {
    try {
        if (!buffer) throw new Error('No recording BASE');
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

/** Read from the recording's BASE, never from toggles describing a future write. */
export function operatingCalibrationHold(buffer: ArrayBuffer | null | undefined): OperatingHold | null {
    const context = operatingCalibrationContext(buffer);
    if (!context.known) return 'binary-missing';
    if (context.airModelActive) return 'air-model-active';
    if (context.learningActive) return 'learning-active';
    return null;
}
