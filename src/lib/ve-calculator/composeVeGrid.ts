/**
 * The one place kf_rf_soll is composed before it is written.
 *
 * Three workflows own cells in this table — VE (mid/high opening rows), LOW LOAD (the low-opening
 * rows), and eventually IDLE (the lowest rows, currently sealed). Before this module existed each
 * of them wrote the whole 24x20 grid itself, and the arbitration was call order alone: the LOW
 * LOAD write ran AFTER the VE write while its own comment claimed the opposite, so arming both
 * reverted every VE-corrected cell above the low rows to BASE — silently, with both panels still
 * reading armed and the file still named Tune_. docs/ecu-logic/65-workflows.md, defect 1.
 *
 * The rule, stated once: every cell has exactly one owner.
 *
 *   - LOW LOAD owns the cells it measured or repaired (`owned[r][c]`) — not because it applies a
 *     different correction (it applies the identical `trim x rf_korr`) but because the VE path
 *     refuses that band outright (`veOwnsRow = r > LOW_LOAD_TOP_ROW`) and LOW LOAD is the only
 *     one carrying evidence gates shaped for a dwell rather than a sweep.
 *   - VE owns every cell it accepted.
 *   - Everything else stays BASE.
 *
 * ## The two invariants this composition rests on
 *
 * The function never sees the BASE grid, and does not need to, because both inputs already carry
 * it in their untouched cells:
 *
 *   1. The VE calculator pushes `oldVal` for every cell that did not clear the evidence gate
 *      (calculator.ts, the `acceptedMap` branch) — so `veMap`'s non-accepted cells are
 *      byte-identical to BASE.
 *   2. The low-load tuner seeds its grid from `currentMap.data` and writes only the cells it
 *      marks `measured`/`repaired` (lowLoadTuner.ts, `tuned = stock.map(r => [...r])`) — so
 *      `lowLoad.grid`'s non-owned cells are byte-identical to BASE.
 *
 * Therefore "start from whichever grid exists, then overwrite the owned cells" implements the
 * ownership rule exactly. verify:compose asserts invariant 2 against the real tuner on every run,
 * because the composition silently stops being correct the day either invariant breaks.
 */

/** A low-load derivation armed for writing: the full grid plus which cells it actually owns. */
export interface LowLoadArm {
    /** 24x20, BASE-seeded, only owned cells changed. `LowLoadResult.tuned`. */
    grid: number[][];
    /** 24x20, true where the tuner measured or repaired the cell. `LowLoadResult.owned`. */
    owned: boolean[][];
}

export interface ComposedVe {
    /** The single grid to hand to `setVETableData` — the only writer of kf_rf_soll. */
    grid: number[][];
    /** How many cells LOW LOAD contributed. For the manifest and the write dialog. */
    lowLoadCells: number;
}

/**
 * Compose the kf_rf_soll grid from every armed contribution.
 *
 * Pass null for a contribution whose toggle is off — an OFF toggle and an underived table are the
 * same fact here ("this workflow contributes nothing"), which is what keeps the write gate in one
 * place. Returns null when nothing contributes, and the caller must then not touch the table at
 * all: BASE bytes stay BASE bytes, rather than being rewritten with a copy of themselves.
 */
export function composeVeGrid(
    veMap: number[][] | null,
    lowLoad: LowLoadArm | null,
): ComposedVe | null {
    if (!veMap && !lowLoad) return null;

    const seed = veMap ?? lowLoad!.grid;
    const grid = seed.map(row => [...row]);

    let lowLoadCells = 0;
    if (lowLoad) {
        for (let r = 0; r < grid.length; r++) {
            for (let c = 0; c < grid[r].length; c++) {
                if (lowLoad.owned[r]?.[c]) {
                    grid[r][c] = lowLoad.grid[r][c];
                    lowLoadCells++;
                }
            }
        }
    }
    return { grid, lowLoadCells };
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
    lowLoad: LowLoadArm | null,
    shape: ShapeArm | null,
): number[][] | null {
    const composed = composeVeGrid(veMap, lowLoad);
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
