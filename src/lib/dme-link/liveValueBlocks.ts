/**
 * DS2 live-measurement block field layouts, ported from the reference Mss54Ds2Tool source
 * (Ds2StandardMeasurementBlock.cs, DmeLiveValueCatalog.cs, DmeLiveValueDecoder.cs). Byte offsets
 * and scaling formulas are confirmed against that source. The decoding itself lives in
 * blockDecoder.ts, shared with adaptationBlocks.ts.
 */

import { FieldDef, decodeField } from './blockDecoder';

/** Selection 3 "Standard Measurements" (35 bytes) — RPM, coolant temp, and relative opening (RO). */
export const STANDARD_MEASUREMENT_BLOCK = {
    selection: 3,
    expectedLength: 35,
    fields: {
        rpm: { symbol: 'n', offset: 0, format: 'uint16', scale: 1.0, add: 0 } as FieldDef,
        coolantTemp: { symbol: 'tmot', offset: 11, format: 'uint8', scale: 1.0, add: -48 } as FieldDef,
        // aq_rel = "relativer Oeffnungsquerschnitt" — the same quantity the Testo CSV pipeline calls
        // rawLoad, and the tuning table's load axis is in these units.
        //
        // SCALE is 200/65536, NOT the Mss54Ds2Tool catalog's 0.46511627906976744. The offset is
        // right — RPM (0) and tmot (11) decode correctly and this raw matches — but that tool scales
        // aq_rel to its own % convention, ~150x larger than Testo's, which put idle at 38% and cruise
        // over 200%. Confirmed against a real Testo log: every relativer Oeffnungsquerschnitt value
        // there is exactly raw*200/65536 (0.241089 = 79*, 0.67749 = 222*, 63.3575 = 20763*), so idle
        // reads ~0.25 and cruise ~1, matching the axis instead of overflowing it.
        rawLoad: { symbol: 'aq_rel', offset: 20, format: 'uint16', scale: 0.0030517578125, add: 0 } as FieldDef,
    },
};

/** Selection 19 "Operating Measurements" (90 bytes) — lambda controller trim (STFT-equivalent). */
export const OPERATING_MEASUREMENTS_BLOCK = {
    selection: 19,
    expectedLength: 90,
    fields: {
        stft1: { symbol: 'la_f_regler1', offset: 40, format: 'uint16', scale: 3.0517578125e-05, add: 0 } as FieldDef,
        stft2: { symbol: 'la_f_regler2', offset: 42, format: 'uint16', scale: 3.0517578125e-05, add: 0 } as FieldDef,
    },
};

export function decodeStandardMeasurementBlock(payload: Uint8Array) {
    const f = STANDARD_MEASUREMENT_BLOCK.fields;
    return {
        rpm: decodeField(payload, f.rpm),
        coolantTemp: decodeField(payload, f.coolantTemp),
        rawLoad: decodeField(payload, f.rawLoad),
    };
}

export function decodeOperatingMeasurementsBlock(payload: Uint8Array) {
    const f = OPERATING_MEASUREMENTS_BLOCK.fields;
    return {
        stft1: decodeField(payload, f.stft1),
        stft2: decodeField(payload, f.stft2),
    };
}
