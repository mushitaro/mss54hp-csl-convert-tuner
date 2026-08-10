/**
 * Definitions for calibration items read out of the 65536-byte MSS54HP partial BIN.
 *
 * The XDF address IS the file offset (slave 0x0000-0x7FFF, master 0x8000-0xFFFF), so nothing here
 * carries a base — see docs/ecu-logic/00-glossary.md §4 and docs/implementation-notes.md §4.
 *
 * Shaped after dme-link/blockDecoder.ts + adaptationBlocks.ts: a dumb decoder plus literal field
 * tables. That split is already proven against DS2 payloads; this is the same split against flash.
 *
 * READ ONLY for now. Every item here is surfaced so its address and scaling can be checked against
 * a real binary before anything is ever written back — constants.ts carries the warning that these
 * addresses need verifying against the user's own BIN version, and this is how that gets done.
 */

/** Which processor half the address falls in. Derivable from the address, but stated on every item
 *  so that a typo'd address becomes a failing assertion instead of a silent bank change. */
export type EcuBank = 'slave' | 'master';

/** 32-bit items exist in the XDF but none are wanted here yet. Widen this and readRun at the same
 *  time, never separately. */
export type EcuWidth = 8 | 16;

/**
 * Forward and inverse, as two functions rather than a scale/offset pair.
 *
 * The XDF's MATH column contains equations that are not affine — `25.6/x` (K_TABG_TAU),
 * `x*100/32768` (the Alpha-N load axis), `(16384-X)/16384`. A single `scale`/`add` like FieldDef's
 * cannot round-trip those. Keeping the inverse next to the forward is also how the app avoids
 * repeating getVETable's `/1000` and setVETable's `*1000` living forty lines apart with nothing
 * tying them together.
 */
export interface EcuScaling {
    /** The XDF <MATH equation> verbatim. Provenance only — never evaluated. */
    math: string;
    toPhysical: (raw: number) => number;
    /** Exact inverse of toPhysical over [min,max]. Unrounded; the writer rounds and clamps. */
    toRaw: (physical: number) => number;
}

/** Prose, in both display languages. Control shorthand is NOT in here — see `label`. */
export interface EcuProse { en: string; ja: string; }

export type EcuCategory = 'egt' | 'idle' | 'fuel' | 'load';

/** One contiguous run of same-width numbers: a constant (n = 1), an axis, or a value grid. */
export interface EcuNumericDef {
    /** Byte offset in the partial BIN. For a table's first axis this is the address the XDF gives;
     *  the block's 2-byte size header sits at `address - 2` and is never part of any item. */
    address: number;
    bits: EcuWidth;
    signed: boolean;
    units: string;
    scaling: EcuScaling;
}

export interface EcuAxisDef extends EcuNumericDef {
    /** Number of breakpoints. */
    n: number;
    /** Column/row heading. Instrument shorthand ('RPM', 'TABG'), one form, never translated. */
    label: string;
}

interface EcuItemBase {
    /** DME symbol, spelled as the XDF and the Funktionsrahmen spell it. The stable key. */
    symbol: string;
    address: number;
    bank: EcuBank;
    category: EcuCategory;
    /** Uppercase shorthand, one form in both languages — see the rule in lib/dialog-text.ts. */
    label: string;
    description: EcuProse;
}

export interface EcuConstantDef extends EcuItemBase, EcuNumericDef {
    kind: 'constant';
}

/** KL_* — one axis and one value series of the same length. */
export interface EcuCurveDef extends EcuItemBase {
    kind: 'curve';
    x: EcuAxisDef;
    values: EcuNumericDef & { n: number };
}

/** KF_* — x axis, y axis, and a row-major (y-major) grid, matching the layout getVETable already
 *  assumes: `address + (row * cols + col) * bytes`. */
export interface EcuMapDef extends EcuItemBase {
    kind: 'map';
    x: EcuAxisDef;
    y: EcuAxisDef;
    values: EcuNumericDef & { rows: number; cols: number };
}

export type EcuItemDef = EcuConstantDef | EcuCurveDef | EcuMapDef;

/** A decoded item. Raw is kept alongside the physical values because raw is what is actually in the
 *  bytes: a later correction to `scaling` should re-label an old reading, not falsify it. */
export type EcuItemValue =
    | { kind: 'constant'; symbol: string; value: number; raw: number }
    | { kind: 'curve'; symbol: string; x: number[]; values: number[]; raw: number[] }
    | { kind: 'map'; symbol: string; x: number[]; y: number[]; values: number[][]; raw: number[][] };
