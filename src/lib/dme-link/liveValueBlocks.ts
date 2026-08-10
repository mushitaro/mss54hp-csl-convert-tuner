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
        // rf and tabg come out of the SAME 35-byte response the three fields above already fetch,
        // so reading them costs no extra round trip and does not slow the live sample rate.
        //
        // Offsets derived from the 0401 disassembly: master ds2_handler case 0x1c, annotated
        // /* 12050B03 */ (addr 12, len 05, cmd 0B, selection 03) in the CSL_0401 notes repo,
        // decomp/master/030b84.txt. It writes through puVar5 = rsp_ptr and puts N's high byte at
        // rsp_ptr+3, so payload offset = array index - 3. Two independent cross-checks on that
        // mapping: TMOT is written at index 0x0E -> offset 11, which is the offset already proven
        // on the car above; and RF at index 0x0B -> offset 8, which is where the reference
        // Mss54Ds2Tool catalog also puts `rf` (u16, 0.1).
        //
        // CAVEAT, unresolved: the same listing writes 0 at payload 13/16/20/21, yet offset 20 is
        // where aq_rel is read successfully on a real car. Those four positions are exactly the
        // ones the reference catalog assigns to slave-owned signals, so "the slave fills them in
        // afterwards" reconciles it — but confirm both fields against a real DME before trusting
        // them (see docs/ecu-logic/20-egt-correction.md).

        /** RF, the DME's final relative filling — rf_soll AFTER rf_korr. `puVar5[0xb..0xc] = RF`. */
        rf: { symbol: 'rf', offset: 8, format: 'uint16', scale: 0.1, add: 0 } as FieldDef,
        /** TABG. The DME emits `puVar5[0x11] = (char)(TABG >> 4)` — a SIGNED byte carrying degC/16,
         *  so the channel resolves 16 degC and spans the sensor's -55..1250 degC range. `int7` is
         *  this decoder's signed-byte format (see blockDecoder.ts). */
        exhaustTemp: { symbol: 'tabg', offset: 14, format: 'int7', scale: 16, add: 0 } as FieldDef,
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
        rf: decodeField(payload, f.rf),
        exhaustTemp: decodeField(payload, f.exhaustTemp),
    };
}

export function decodeOperatingMeasurementsBlock(payload: Uint8Array) {
    const f = OPERATING_MEASUREMENTS_BLOCK.fields;
    return {
        stft1: decodeField(payload, f.stft1),
        stft2: decodeField(payload, f.stft2),
    };
}
