import type { EcuBank, EcuNumericDef } from '@/lib/ecu-items/types';
import type { GraphNode } from '@/lib/calibration-graph/types';

/**
 * The calibration workbench's view of one parameter.
 *
 * The vendored graph (public/data/calibration-graph.json) describes all 2,529
 * parameters; this is the adaptation of one of them into something the binary
 * engine can read and write. The shape deliberately reuses `EcuNumericDef` for
 * every byte run so `quantise`/`quantiseToward` (lib/ecu-items/quantise.ts)
 * work on it unchanged — structural typing is the whole point.
 *
 * One rule from the hand-written catalog carries over verbatim: the EDITABLE
 * thing is a single contiguous run of same-width numbers — the constant
 * itself, a curve's value row, a map's grid. Axes are never editable (moving a
 * breakpoint silently re-labels every value beside it), and the 2-byte block
 * size header at (first axis address − 2) is never part of any run.
 */

/** Why a parameter cannot be edited. Shown to the user, so every reason has copy. */
export type EditLockReason =
    | 'no-address'        // K_VERS_UP_S — the XDF records no address for it
    | 'width-32'          // K_BELU_DIAG_ANLAUF_SPERRE — the only 32-bit item; readRun is 8/16
    | 'math-unsupported'  // the value run's scaling failed to compile
    | 'k-linked'          // scaling references another item's value (VAR type="link")
    | 'checksum-slot'     // run overlaps a checksum slot (none today; guarded)
    | 'app-managed'       // owned by the PATCH group, written both directions every build
    | 'idle-sealed';      // KF_LLR_QVS_GRUND — see lib/idle/seal.ts

export type EditLock = { locked: false } | { locked: true; reason: EditLockReason };

/** An axis: either stored bytes in the binary, or XDF label text with no address. */
export type CalAxisDef =
    | {
        source: 'stored';
        def: EcuNumericDef & { n: number };
        /** False when the axis scaling failed to compile — decode shows raw counts. */
        mathOk: boolean;
        label: string;
    }
    | { source: 'labels'; labels: string[]; n: number; label: string };

export interface CalParamDef {
    /** Graph node id ("p:xxxxx") — the stable key everywhere. */
    id: string;
    /** DME symbol as the XDF spells it (casing preserved; display upper-cases). */
    name: string;
    kind: 'constant' | 'curve' | 'map';
    conf: 'documented' | 'derived';
    bank: EcuBank;
    cats: number[];
    desc: { en: string; ja: string };
    /**
     * The one editable run: the constant (count 1), the curve's value row
     * (graph axes.y), or the map grid (graph axes.z, row-major, y-major).
     * Null when the parameter cannot be decoded at all (no address / 32-bit).
     */
    run: (EcuNumericDef & { count: number }) | null;
    /** False when the run decodes raw-only (scaling did not compile). */
    runMathOk: boolean;
    /** Maps only: rows * cols === run.count. */
    rows?: number;
    cols?: number;
    /** Maps have both; curves x only; constants neither. */
    xAxis: CalAxisDef | null;
    yAxis: CalAxisDef | null;
    lock: EditLock;
}

/** The vendored artifact's own node type, re-exported for the adapters. */
export type CalParamNode = GraphNode;

/**
 * Which set of bytes a view is showing.
 *
 * `tuned` is the loaded image with this session's edits overlaid — what a WRITE
 * would produce; `base` is that image as it was loaded; `stock` is the CSL 0401
 * reference image the app ships; `db:<id>` is a stored session's own binary.
 *
 * They are the app's OWN records rather than a file picked off the disk: a
 * binary worth comparing against is a binary worth having a session for, and
 * the session is what carries where it came from.
 */
export type CalVariant = 'tuned' | 'base' | 'stock' | `db:${string}`;
