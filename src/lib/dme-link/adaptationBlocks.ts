/**
 * DS2 adaptation block field layouts — the values the DME has learned and that a re-tune wants
 * cleared, so the next log is captured from a known base.
 *
 * The item set matches the reference2 ECUWorx DME Utility (its STATUS_ADAPTIONSBLOCK_06 and
 * STATUS_ADAPTIONSBLOCK_16 jobs), but that tool is an EDIABAS wrapper: it dispatches job names into
 * MSS54DS0.prg and holds no addresses, scaling or command bytes of its own. Those come from the
 * reference Mss54Ds2Tool source (DmeAdaptationProfiles.cs), whose DS2 selections 0x06/0x16 are the
 * same two blocks. Names here are that source's, not ECUWorx's: it labels laa_offset1 "Bank 1 STFT",
 * which would collide with what this app already calls stft1 (la_f_regler1, the live lambda
 * regulator in liveValueBlocks.ts) — a different value entirely.
 */

import { FieldDef, decodeField, byteLength } from './blockDecoder';

/**
 * Smallest payload that can still carry every field this app decodes from a block.
 *
 * Deliberately NOT `expectedLength`. That number comes from the reference and is self-contradictory
 * — 83 for block 0x06 whose own field table runs to offset 92 — so asserting equality against it
 * could reject a response the DME is entitled to send. Derived from the fields instead: it fails only
 * in the case that currently produces a table of silent dashes, and it demotes `expectedLength` to
 * the documentation it can honestly be.
 */
export function minPayloadLength(fields: readonly FieldDef[]): number {
    return fields.reduce((max, f) => Math.max(max, f.offset + byteLength(f.format)), 0);
}

/** One displayable adaptation row. */
export interface AdaptationFieldDef extends FieldDef {
    /** The reference's name for the value. */
    label: string;
    unit: string;
    /** Section heading in the reset dialog. */
    group: string;
    /**
     * What this value is expected to read once cleared. NOT all zero: laa_f1/laa_f2 are
     * multiplicative trim factors on a 1/32768 scale, so their neutral is 1.0 — a factor of 0 would
     * mean zero fuel. (The same reasoning is already in webSerialDmeLink.pollLiveMeasurement, which
     * falls back to 1.0 as neutral trim for la_f_regler on that identical scale.) The other ten are
     * additive and clear to 0.
     *
     * Advisory only — shown as an expected value, never used to decide whether a clear worked.
     * Asserting "cleared == 0" would report a false failure on the two factor rows.
     */
    cleared: number;
}

/**
 * Selection 0x06 "Standard Adaptions" — lambda trim and VANOS.
 *
 * The reference declares this block 83 bytes but its own field table runs to offset 92 (the trailing
 * CSL-specific fields), so one of the two is stale. It doesn't matter here: every field below is at
 * offset <= 81, inside the payload either way. decodeField still bounds-checks.
 */
export const STANDARD_ADAPTATIONS_BLOCK = {
    selection: 0x06,
    expectedLength: 83,
    fields: [
        { symbol: 'laa_f1', label: 'Lambda adaptation factor 1', offset: 4, format: 'uint16', scale: 3.0517578125e-05, add: 0, unit: '', group: 'Lambda / Fuel Trim', cleared: 1.0 },
        { symbol: 'laa_f2', label: 'Lambda adaptation factor 2', offset: 6, format: 'uint16', scale: 3.0517578125e-05, add: 0, unit: '', group: 'Lambda / Fuel Trim', cleared: 1.0 },
        { symbol: 'laa_offset1', label: 'Lambda adaptation offset 1', offset: 8, format: 'int15', scale: 0.002, add: 0, unit: 'ms', group: 'Lambda / Fuel Trim', cleared: 0 },
        { symbol: 'laa_offset2', label: 'Lambda adaptation offset 2', offset: 10, format: 'int15', scale: 0.002, add: 0, unit: 'ms', group: 'Lambda / Fuel Trim', cleared: 0 },
        // 'int7' is this codebase's name for a sign-extended single byte — the same thing the
        // reference's adaptation table calls Int8. Not a mismatch; see blockDecoder.ts.
        { symbol: 'evan1_adap', label: 'Intake VANOS bank 1 adaptation', offset: 80, format: 'int7', scale: 0.1, add: 0, unit: 'deg KW', group: 'VANOS', cleared: 0 },
        { symbol: 'avan1_adap', label: 'Exhaust VANOS bank 1 adaptation', offset: 81, format: 'int7', scale: 0.1, add: 0, unit: 'deg KW', group: 'VANOS', cleared: 0 },
    ] satisfies AdaptationFieldDef[],
};

/**
 * Selection 0x16 "Observation Adaptions" — knock adaptation, one field per cylinder.
 *
 * Six cylinders, not the eight ECUWorx shows: that tool is shared with the E39 M5 (S62 V8), so it
 * reads TZ0–TZ7. The S54 is an inline-6 and the reference's DS2 table defines only ka_adap_tz[0..5].
 */
export const OBSERVATION_ADAPTATIONS_BLOCK = {
    selection: 0x16,
    expectedLength: 85,
    fields: Array.from({ length: 6 }, (_, i): AdaptationFieldDef => ({
        symbol: `ka_adap_tz[${i}]`,
        label: `Knock adaptation cylinder ${i + 1}`,
        offset: 48 + i * 4,
        format: 'int31',
        scale: 6.103515625e-06,
        add: 0,
        unit: 'deg KW',
        group: 'Knock Adaptation',
        cleared: 0,
    })),
};

export interface AdaptationReading {
    symbol: string;
    label: string;
    unit: string;
    group: string;
    /** null = the DME's response was too short to contain this field. Distinct from a decoded 0. */
    value: number | null;
    cleared: number;
}

/** A decoded read of all twelve values. Plain data — it is persisted into IndexedDB as-is. */
export interface AdaptationSnapshot {
    at: number;
    readings: AdaptationReading[];
}

function decodeBlock(fields: readonly AdaptationFieldDef[], payload: Uint8Array): AdaptationReading[] {
    return fields.map(field => ({
        symbol: field.symbol,
        label: field.label,
        unit: field.unit,
        group: field.group,
        value: decodeField(payload, field),
        cleared: field.cleared,
    }));
}

/** Block 0x06's six rows then block 0x16's six, in display order. */
export function buildAdaptationSnapshot(stdPayload: Uint8Array, obsPayload: Uint8Array): AdaptationSnapshot {
    return {
        at: Date.now(),
        readings: [
            ...decodeBlock(STANDARD_ADAPTATIONS_BLOCK.fields, stdPayload),
            ...decodeBlock(OBSERVATION_ADAPTATIONS_BLOCK.fields, obsPayload),
        ],
    };
}
