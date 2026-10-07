import { BinaryParser } from '@/lib/binary-engine/parser';
import { learnersFrozen } from '@/lib/log-engine/trimNeutrality';

export type OperatingHold = 'binary-missing' | 'air-model-active' | 'learning-active';

/** Read from the recording's BASE, never from toggles describing a future write. */
export function operatingCalibrationHold(buffer: ArrayBuffer | null | undefined): OperatingHold | null {
    if (!buffer) return 'binary-missing';
    try {
        const parser = new BinaryParser(buffer);
        // Direct MAP, HFM, and the additive MAP integrator are outside the multiplicative model.
        if ((parser.getUint8(0xE5E4) & 0x15) !== 0) return 'air-model-active';
        if (!learnersFrozen(parser.readLtftLearnWindow())) return 'learning-active';
        return null;
    } catch {
        return 'binary-missing';
    }
}
