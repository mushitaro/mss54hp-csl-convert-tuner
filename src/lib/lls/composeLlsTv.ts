import { lookupNodes } from '@/lib/idle/valveModel';
import type { IdleMap2d } from '@/lib/idle/idleTables';
import type { LlsTvEdit } from './ringGain';

/**
 * The one place `KF_LLS_TV` is composed before it is written.
 *
 * ## Why this exists
 *
 * TWO workflows own cells in this table. IDLE derives it from warm idle dwells; the micro-throttle
 * mode derives it from ring consistency. Both reach `setEcuMapValues`, and before this module the
 * arbitration would have been call order alone — the same defect `composeVeGrid` was written to
 * fix on `kf_rf_soll`, where corrected cells reverted to BASE silently with both panels still
 * reading armed.
 *
 * The rule, stated once: **every cell has exactly one owner.**
 *
 *   - LLS owns the rows its solve writes, while an LLS proposal is armed.
 *   - IDLE owns every cell it moved that LLS did not claim.
 *   - Everything else stays BASE.
 *
 * ## Under the shipped anchor there is nothing to arbitrate
 *
 * `RING_GAIN_DEFAULTS.anchorMlKgH` is 20, so LLS HOLDS the row IDLE needs and writes 25/30/40/50.
 * The two modes do not contend at all, and `cededCells` is 0. That was the reason for moving the
 * anchor: the collision was made by an arbitrary constant, not by two modes wanting the same cell.
 *
 * This module stays because the anchor is a choice, and the other choice collides. Everything
 * below describes what happens on the notes' anchor of 30, which remains selectable.
 *
 * ## Why LLS wins the overlap when there is one, and what it costs
 *
 * On anchor 30 they collide on row 20. On this car that is not a tie:
 *
 *   - Warm idle sits at 18.15 kg/h / ~880 rpm, which puts **63 % of the DME's own lookup weight on
 *     row 20** — measured, and the reason `rowsWithWarmEvidence` exists at all (`idle/tuner.ts`).
 *   - The LLS solve moves the commanded duty at that point by **-1.00 pp**, against IDLE's
 *     per-pass cap of 3 %. IDLE can absorb the whole reshape in a third of one correction.
 *
 * So LLS takes the row, because its claim is a SHAPE across four rows anchored on a fifth — break
 * one and the ring is no longer flat — while IDLE's claim is a LEVEL that its own integrator
 * re-converges on. A shape cannot be recovered by feedback; a level can.
 *
 * ## The cost is reported, not hidden
 *
 * Ceding row 20 leaves IDLE reaching only 37 % of its operating point, and that exact shortfall is
 * on record as having broken convergence on this car once before: the correction was scaled up to
 * compensate and saturated the per-pass cap for ever. So `idleReach` computes what is left rather
 * than assuming it is enough, and the surface says so while both are armed.
 *
 * This is also why ownership is **dynamic**. With no LLS proposal armed, `lls` is null and IDLE
 * keeps its full writable set — the mode that is not running does not hold cells hostage.
 */

export type CellOwner = 'base' | 'idle' | 'lls';

/**
 * Where this car idles warm, and so where IDLE's authority is spent.
 *
 * 18.15 kg/h at about 880 rpm — measured, and the figure `idle/tuner.ts` records as the reason
 * `rowsWithWarmEvidence` exists at all. Every claim about IDLE losing reach is evaluated here,
 * because "IDLE can still write cells" and "IDLE can still move the point it has to control" are
 * different statements and only the second one matters.
 */
export const WARM_IDLE_POINT = { rpm: 880, mlKgH: 18.15 } as const;

/**
 * What share of the warm idle point IDLE can still move, given the rows LLS is taking.
 *
 * Exists so a surface can state the cost of an anchor BEFORE it is armed rather than after it is
 * flashed. Taking row 20 leaves 37 %; taking row 15 leaves 63 %; taking both leaves ZERO, and a
 * mode that cannot reach its own operating point at all cannot converge on anything.
 */
export function idleReachIfLlsTakes(
    map: IdleMap2d,
    rowsTakenMlKgH: readonly number[],
): number | null {
    const nodes = lookupNodes(map, WARM_IDLE_POINT.rpm, WARM_IDLE_POINT.mlKgH);
    if (nodes.length === 0) return null;
    let total = 0;
    let mine = 0;
    for (const n of nodes) {
        total += n.weight;
        if (!rowsTakenMlKgH.includes(map.y[n.row])) mine += n.weight;
    }
    return total > 0 ? mine / total : null;
}

export interface LlsTvContributions {
    /**
     * IDLE's proposed table, 13x10 physical per cent, exactly as `tuneIdleFeedforward` returns it.
     * Null when the IDLE row is not armed — an unarmed toggle and an underived table are the same
     * fact here, which is what keeps the write gate in one place.
     */
    idle: readonly (readonly number[])[] | null;
    /** The LLS solve. Null when its row is not armed. */
    lls: readonly LlsTvEdit[] | null;
}

export interface ComposedLlsTv {
    /** The single table to hand to `setEcuMapValues` — the only writer of `KF_LLS_TV`. */
    values: number[][];
    owner: CellOwner[][];
    /** Cells IDLE moved that LLS took. The reach it gave up, countable rather than argued. */
    cededCells: number;
}

const EPSILON = 1e-9;

/**
 * Compose `KF_LLS_TV` from whatever is armed.
 *
 * Returns null when nothing contributes, and the caller must then not touch the table at all —
 * BASE bytes stay BASE bytes rather than being rewritten with a copy of themselves. That matters
 * more here than on `kf_rf_soll`: `setEcuMapValues` clamps every cell it writes, so a write of
 * "no change" is still a write, and a stock cell outside the rails would move.
 */
export function composeLlsTv(
    stock: readonly (readonly number[])[],
    contributions: LlsTvContributions,
    axes?: { rpm: readonly number[]; mlKgH: readonly number[] },
): ComposedLlsTv | null {
    const { idle, lls } = contributions;
    if (!idle && (!lls || lls.length === 0)) return null;

    const values = stock.map(row => [...row]);
    const owner: CellOwner[][] = stock.map(row => row.map(() => 'base' as CellOwner));

    // IDLE first: it owns every cell it actually moved. A cell it left alone is not a claim.
    if (idle) {
        for (let r = 0; r < values.length; r++) {
            for (let c = 0; c < values[r].length; c++) {
                const proposed = idle[r]?.[c];
                if (typeof proposed !== 'number' || !Number.isFinite(proposed)) continue;
                if (Math.abs(proposed - stock[r][c]) < EPSILON) continue;
                values[r][c] = proposed;
                owner[r][c] = 'idle';
            }
        }
    }

    // LLS overlays. Its edits carry axis values rather than indices, so they are resolved against
    // the axes of the table being written — an edit list from a different image does not silently
    // land on whatever cell happens to share an index.
    let cededCells = 0;
    if (lls && axes) {
        for (const e of lls) {
            const r = axes.mlKgH.indexOf(e.mlKgH);
            const c = axes.rpm.indexOf(e.rpm);
            if (r < 0 || c < 0) continue;
            if (owner[r][c] === 'idle') cededCells++;
            values[r][c] = e.afterPct;
            owner[r][c] = 'lls';
        }
    }

    return { values, owner, cededCells };
}

/**
 * The share of the DME's own lookup weight at an operating point that sits on cells a given mode
 * may still write, 0..1.
 *
 * This is the number the 37 % story turns on, so it is computed from `lookupNodes` — the same
 * bilinear corners the DME reads — rather than counted in rows. A mode whose reach falls far below
 * 1 has to scale its corrections up to compensate, and a mode that has to scale up far enough will
 * saturate its per-pass cap and stop converging.
 *
 * Cells still owned by BASE count as reachable: nothing has claimed them, so this mode may.
 */
export function reachAt(
    map: IdleMap2d,
    owner: readonly (readonly CellOwner[])[],
    mode: 'idle' | 'lls',
    rpm: number,
    mlKgH: number,
): number | null {
    const nodes = lookupNodes(map, rpm, mlKgH);
    if (nodes.length === 0) return null;
    let mine = 0;
    let total = 0;
    for (const n of nodes) {
        const held = owner[n.row]?.[n.col] ?? 'base';
        total += n.weight;
        if (held === mode || held === 'base') mine += n.weight;
    }
    return total > 0 ? mine / total : null;
}

/** Cells each mode ended up owning — for the surface to state the split rather than imply it. */
export function ownerCounts(owner: readonly (readonly CellOwner[])[]): Record<CellOwner, number> {
    const counts: Record<CellOwner, number> = { base: 0, idle: 0, lls: 0 };
    for (const row of owner) for (const cell of row) counts[cell]++;
    return counts;
}
