import type { EcuNumericDef } from '@/lib/ecu-items/types';
import { quantise } from '@/lib/ecu-items/quantise';
import { SEALED_CAL_SYMBOLS } from '@/lib/idle/seal';
import { findEcuItem } from '@/lib/ecu-items/catalog';
import { APP_CONFIG, EXPERIMENTAL_CONFIG, TANK_VENT_GAIN, WOT_FUEL_ROWS, COMMUNITY_WOT_FUEL_RAW, MAP_DIMENSIONS } from '@/config/constants';
import type { CalParamDef } from './types';
import type { DecodedRun } from './decode';

/**
 * The calibration edit set — pure functions, no React.
 *
 * An edit is the FULL run as it should be written, in raw, alongside the run
 * it was derived from. Raw, because raw is what is actually in the bytes: the
 * write path never re-derives it through a scaling round trip, so a value the
 * editor quantised is the value the flash receives, to the bit.
 *
 * The set is exactly "what will change": any operation whose result equals the
 * base drops the entry, so counting the set counts the manifest rows and an
 * empty set means the WRITE carries nothing calibration-shaped.
 */

export interface CalEdit {
    paramId: string;
    name: string;
    /** Self-contained byte-run snapshot, so applying never needs the async catalog. */
    address: number;
    bits: 8 | 16;
    signed: boolean;
    count: number;
    dims?: { rows: number; cols: number };
    /** The run as it should be written. Integers, in-field. */
    raw: number[];
    /** The run as decoded from the loaded buffer when the edit was created. */
    baseRaw: number[];
}

export type CalEditSet = ReadonlyMap<string, CalEdit>;

export const EMPTY_EDITS: CalEditSet = new Map();

// ---------------------------------------------------------------------------
// operations — each returns a NEW set; identical-to-base entries drop out.
// Quantisation is lib/ecu-items/quantise — ONE encoding boundary, per its
// own header's rule about shared boundaries with two implementations.
// ---------------------------------------------------------------------------

function sameAsBase(raw: number[], baseRaw: number[]): boolean {
    return raw.length === baseRaw.length && raw.every((v, i) => v === baseRaw[i]);
}

function makeEdit(def: CalParamDef, base: DecodedRun, raw: number[]): CalEdit {
    const run = def.run!;
    return {
        paramId: def.id,
        name: def.name,
        address: run.address,
        bits: run.bits,
        signed: run.signed,
        count: run.count,
        dims: def.rows !== undefined && def.cols !== undefined
            ? { rows: def.rows, cols: def.cols }
            : undefined,
        raw,
        baseRaw: [...base.raw],
    };
}

function withEntry(set: CalEditSet, edit: CalEdit): CalEditSet {
    const next = new Map(set);
    if (sameAsBase(edit.raw, edit.baseRaw)) next.delete(edit.paramId);
    else next.set(edit.paramId, edit);
    return next;
}

function currentRaw(set: CalEditSet, def: CalParamDef, base: DecodedRun): number[] {
    return [...(set.get(def.id)?.raw ?? base.raw)];
}

/** One cell set to (the nearest writable value to) `physical`. */
export function withCellEdit(
    set: CalEditSet,
    def: CalParamDef,
    base: DecodedRun,
    index: number,
    physical: number,
): { set: CalEditSet; quantised: { raw: number; value: number; exact: boolean } } {
    const run = def.run;
    if (!run || index < 0 || index >= run.count) return { set, quantised: { raw: NaN, value: NaN, exact: false } };
    const q = quantise(run, physical);
    const raw = currentRaw(set, def, base);
    raw[index] = q.raw;
    return { set: withEntry(set, makeEdit(def, base, raw)), quantised: q };
}

/** One cell put back to what the loaded buffer holds. */
export function withCellRevert(
    set: CalEditSet,
    def: CalParamDef,
    base: DecodedRun,
    index: number,
): CalEditSet {
    const run = def.run;
    if (!run || index < 0 || index >= run.count) return set;
    const raw = currentRaw(set, def, base);
    raw[index] = base.raw[index];
    return withEntry(set, makeEdit(def, base, raw));
}

export interface BulkOp {
    kind: 'scale' | 'add';
    amount: number;
}

/**
 * `physical × k` or `physical + d` over a set of cells, applied in physical
 * space and quantised per cell. `amount` is signed — a negative `add`
 * subtracts, and a `scale` below 1 shrinks.
 *
 * `indices` is the scope: the cells the caller can currently SEE. Omitted
 * means the whole run. A bulk edit that reached cells off the screen would be
 * the most expensive kind of surprise, so the scope is the caller's to state
 * rather than this function's to assume.
 *
 * Cells whose CURRENT physical is non-finite (the reciprocal scalings at raw 0)
 * are skipped and counted, not silently zeroed.
 */
export function withBulkOp(
    set: CalEditSet,
    def: CalParamDef,
    base: DecodedRun,
    op: BulkOp,
    indices?: readonly number[],
): { set: CalEditSet; clampedCells: number; skippedErrorCells: number } {
    const run = def.run;
    if (!run) return { set, clampedCells: 0, skippedErrorCells: 0 };
    const raw = currentRaw(set, def, base);
    const targets = indices ?? raw.map((_, i) => i);
    let clampedCells = 0;
    let skippedErrorCells = 0;
    for (const i of targets) {
        if (i < 0 || i >= raw.length) continue;
        const phys = run.scaling.toPhysical(raw[i]);
        if (!Number.isFinite(phys)) {
            skippedErrorCells += 1;
            continue;
        }
        const target = op.kind === 'scale' ? phys * op.amount : phys + op.amount;
        const q = quantise(run, target);
        if (q.clamped) clampedCells += 1;
        raw[i] = q.raw;
    }
    return { set: withEntry(set, makeEdit(def, base, raw)), clampedCells, skippedErrorCells };
}

/**
 * The reference image's raw run, copied exactly. Raw copy on purpose: both
 * buffers decode through the same def, so the runs always agree in shape, and
 * a physical round trip could shift a cell by one LSB for nothing.
 */
export function withReferenceCopy(
    set: CalEditSet,
    def: CalParamDef,
    base: DecodedRun,
    ref: DecodedRun | null,
): { ok: true; set: CalEditSet } | { ok: false; reason: 'undecodable' } {
    if (!def.run || !ref || ref.raw.length !== def.run.count) return { ok: false, reason: 'undecodable' };
    return { ok: true, set: withEntry(set, makeEdit(def, base, [...ref.raw])) };
}

/** The whole parameter back to the loaded buffer's bytes. */
export function withoutParam(set: CalEditSet, paramId: string): CalEditSet {
    if (!set.has(paramId)) return set;
    const next = new Map(set);
    next.delete(paramId);
    return next;
}

// ---------------------------------------------------------------------------
// spans — who else writes bytes, so edits and writers cannot silently collide
// ---------------------------------------------------------------------------

export interface RunSpan {
    address: number;
    /** Bytes. */
    length: number;
    /** Manifest-facing owner label, e.g. 'PATCH', 'ALPHA-N'. */
    owner: string;
}

/**
 * Bytes the PATCH group writes BOTH DIRECTIONS on every build
 * (enable/disableMapCorrection, setWOTThreshold, setTankVentDisable in
 * useBinaryFile.buildPatchedBuffer). An edit here would either be overwritten
 * silently or silently contradict patchStatus — so these are permanent locks,
 * not conflicts.
 */
export function managedSpans(): RunSpan[] {
    return [
        { address: APP_CONFIG.MSS54HP.ADDRESS_MAP_CONFIG, length: 1, owner: 'PATCH' },     // k_rf_cfg
        { address: APP_CONFIG.MSS54HP.ADDRESS_TEMP_LIMIT, length: 1, owner: 'PATCH' },     // K_LAA_TMOT_MIN
        { address: TANK_VENT_GAIN.ADDRESS, length: 1, owner: 'TANK VENT' },                // K_TE_TVTE_GA
        { address: EXPERIMENTAL_CONFIG.ADDRESS_WOT_THRESHOLD_MAP, length: 16 * 2, owner: 'WOT LIMIT' }, // KF_BZ_WDK_VL z
    ];
}

/** Symbols whose write path is sealed. Re-exported from the seal itself so an un-seal releases
 *  every consumer in one flip — see lib/idle/seal.ts. */
export { SEALED_CAL_SYMBOLS };

/**
 * Bytes an ARMED table writer owns for this build. Which writers are armed is
 * the caller's knowledge (the manifest toggles); the same list feeds both the
 * row locks and the byte arbitration in apply, so UI and bytes cannot disagree.
 */
export function armedWriterSpans(armed: {
    veWrite: boolean;
    warmup: boolean;
    restoreVe: boolean;
    restoreWarmup: boolean;
    restoreWotFuel: boolean;
    rfKorr: boolean;
}): RunSpan[] {
    const spans: RunSpan[] = [];
    const ve = APP_CONFIG.MSS54HP.VE_TABLE;
    const veBytes = MAP_DIMENSIONS.rows * MAP_DIMENSIONS.cols * 2;
    if (armed.veWrite || armed.restoreVe) {
        spans.push({ address: ve.ADDRESS_DATA, length: veBytes, owner: 'ALPHA-N' });
    }
    if (armed.warmup || armed.restoreWarmup) {
        spans.push({ address: EXPERIMENTAL_CONFIG.ADDRESS_WARMUP_MAP, length: veBytes, owner: 'WARMUP' });
    }
    if (armed.restoreWotFuel) {
        spans.push({
            address: EXPERIMENTAL_CONFIG.ADDRESS_WOT_MAP,
            length: WOT_FUEL_ROWS * COMMUNITY_WOT_FUEL_RAW.length,
            owner: 'WOT FUEL',
        });
    }
    if (armed.rfKorr) {
        const def = findEcuItem('KF_RF_KORR_DRREL');
        if (def?.kind === 'map') {
            spans.push({
                address: def.values.address,
                length: def.values.rows * def.values.cols * (def.values.bits / 8),
                owner: 'RF KORR',
            });
        }
    }
    return spans;
}

function overlaps(aStart: number, aLength: number, bStart: number, bLength: number): boolean {
    return aStart < bStart + bLength && aStart + aLength > bStart;
}

export function editSpan(edit: CalEdit): { start: number; length: number } {
    return { start: edit.address, length: edit.count * (edit.bits / 8) };
}

/**
 * paramId → owner label for every edit that collides with a span, plus
 * edit-vs-edit aliasing (the catalog holds exactly one aliased run pair, so
 * two edits CAN claim the same bytes; last write would win silently).
 */
export function editConflicts(edits: CalEditSet, spans: RunSpan[]): Map<string, string> {
    const out = new Map<string, string>();
    const list = [...edits.values()];
    for (const edit of list) {
        const { start, length } = editSpan(edit);
        for (const span of spans) {
            if (overlaps(start, length, span.address, span.length)) {
                out.set(edit.paramId, span.owner);
                break;
            }
        }
    }
    for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
            const a = editSpan(list[i]);
            const b = editSpan(list[j]);
            if (overlaps(a.start, a.length, b.start, b.length)) {
                if (!out.has(list[i].paramId)) out.set(list[i].paramId, list[j].name);
                if (!out.has(list[j].paramId)) out.set(list[j].paramId, list[i].name);
            }
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// diffs
// ---------------------------------------------------------------------------

/** {differing cells, largest |physical delta|} between two raw runs under one scaling — the
 *  one accumulation both COMPARE bases share, so their Δ can never disagree. */
export function runDeltaStats(
    rawA: number[],
    rawB: number[],
    scaling: EcuNumericDef['scaling'],
): { cells: number; maxDelta: number | null } {
    let cells = 0;
    let maxDelta: number | null = null;
    const n = Math.min(rawA.length, rawB.length);
    for (let i = 0; i < n; i++) {
        if (rawA[i] === rawB[i]) continue;
        cells += 1;
        const a = scaling.toPhysical(rawA[i]);
        const b = scaling.toPhysical(rawB[i]);
        if (Number.isFinite(a) && Number.isFinite(b)) {
            const d = Math.abs(a - b);
            maxDelta = maxDelta === null ? d : Math.max(maxDelta, d);
        }
    }
    return { cells, maxDelta };
}

/** Cells this edit changes against its own base — the manifest row's count. */
export function changedCellCount(edit: CalEdit): number {
    let n = 0;
    for (let i = 0; i < edit.raw.length; i++) {
        if (edit.raw[i] !== edit.baseRaw[i]) n += 1;
    }
    return n;
}
