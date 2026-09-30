/**
 * The one place kf_rf_soll is composed before it is written.
 *
 * TWO workflows own cells in this table — the measured derivation (`VECalculator`) and SHAPE, the
 * log-free geometric repair. Before this module existed each wrote the whole 24x20 grid itself and
 * the arbitration was call order alone, which reverted corrected cells to BASE silently, with both
 * panels still reading armed and the file still named Tune_. docs/ecu-logic/65-workflows.md,
 * defect 1.
 *
 * The rule, stated once: every cell has exactly one owner.
 *
 *   - The measurement owns every cell it accepted.
 *   - SHAPE overlays the cells it repaired.
 *   - Everything else stays BASE.
 *
 * There used to be a THIRD owner, a second measured derivation of the same table; it is gone, and
 * one derivation on one set of bars now decides every cell. What is left to arbitrate is the
 * measurement against SHAPE.
 *
 * ## The invariant this composition rests on
 *
 * The function never sees the BASE grid, and does not need to, because its input already carries it
 * in the untouched cells: the calculator pushes `oldVal` for every cell that did not clear the
 * evidence gate (calculator.ts, the `acceptedMap` branch), so a non-accepted cell is byte-identical
 * to BASE. verify:compose asserts that against the real calculator on every run, because the
 * composition silently stops being correct the day it breaks.
 */

export interface ComposedVe {
    /** The single grid to hand to `setVETableData` — the only writer of kf_rf_soll. */
    grid: number[][];
}

/**
 * Compose the kf_rf_soll grid from the armed derivation.
 *
 * Pass null when the toggle is off — an OFF toggle and an underived table are the same fact here
 * ("this workflow contributes nothing"), which is what keeps the write gate in one place. Returns
 * null when nothing contributes, and the caller must then not touch the table at all: BASE bytes
 * stay BASE bytes, rather than being rewritten with a copy of themselves.
 *
 * A copy, not the input. The SHAPE overlay in `writtenVeGrid` writes into what this returns, and
 * handing back the caller's own grid would let a repair mutate the tuned map behind it.
 */
export function composeVeGrid(veMap: number[][] | null): ComposedVe | null {
    if (!veMap) return null;
    return { grid: veMap.map(row => [...row]) };
}

/** The SHAPE repair armed for writing: the repaired grid plus which cells it actually changed. */
export interface ShapeArm {
    /** 24x20, seeded from the tuned grid, only repaired cells changed. `ShapeRepairResult.values`. */
    grid: number[][];
    /** 24x20, true where the repair moved the cell. `ShapeRepairResult.shaped`. */
    shaped: boolean[][];
}

/**
 * THE grid that goes into `kf_rf_soll` — composition and SHAPE overlay in one call.
 *
 * This exists because the answer was needed in TWO places and was computed in one. The flash path
 * composed, overlaid the repair onto a local copy and wrote it; the WARMUP table — derived from the
 * main table by interpolation — took the tuned map instead, and the WARMUP TAB rendered a third
 * thing, generated once at calculation time and never revisited. Three answers to "what is in this
 * table", two of which were wrong whenever SHAPE was armed.
 *
 * So the rule from the module header extends by one line: every cell has exactly one owner, and
 * SHAPE is not an owner. It is a MODE — it chooses which shape of the composed grid is written, and
 * it can only move cells no derivation owns, because `repairShape` freezes every anchor. That is
 * why it is applied here, after the composition, rather than being a third argument to it.
 *
 * Null when nothing is armed for the table. A `shape` without a composition is deliberately still
 * null: the repaired cells interpolate BETWEEN measured ones, so dropping them onto a BASE table
 * would be two surfaces mixed. The manifest locks SHAPE to ALPHA-N for the same reason.
 */
export function writtenVeGrid(
    veMap: number[][] | null,
    shape: ShapeArm | null,
): number[][] | null {
    const composed = composeVeGrid(veMap);
    if (!composed) return null;
    const grid = composed.grid;
    if (shape) {
        for (let r = 0; r < grid.length; r++) {
            for (let c = 0; c < grid[r].length; c++) {
                if (shape.shaped[r]?.[c]) grid[r][c] = shape.grid[r][c];
            }
        }
    }
    return grid;
}
