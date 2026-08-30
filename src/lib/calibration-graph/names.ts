import type { GraphNode } from "./types";

/**
 * Display casing for symbol names.
 *
 * The XDF is a community document with two authors' conventions in it: 2,371
 * of its 2,529 entries are the factory ALL-CAPS spelling, and 158 arrived in
 * lower case from a separate disassembly. Sorted together they read as two
 * unrelated lists — `k_rg_p_abgasdruck_tau` next to `K_RG_R` — and the eye has
 * to re-learn the naming scheme at every row.
 *
 * Calibration and RAM symbols are therefore shown in the factory casing. Ghidra
 * function symbols are left alone on purpose: lower case is what the decompiled
 * C the viewer can display actually contains, and the contrast doubles as a
 * legend — capitals are data, lower case is code.
 *
 * This is presentation only. Lookups, ids and the decompiler output keep the
 * original spelling, and `originalName` surfaces it wherever it differs so a
 * name can still be pasted into TunerPro or the XDF and found.
 */

/** True when the name is a symbol that follows the factory ALL-CAPS scheme. */
function isDataSymbol(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?$/.test(name);
}

export function displayName(name: string, t?: GraphNode["t"]): string {
  if (t === "func") return name;
  if (!isDataSymbol(name)) return name;
  return name.toUpperCase();
}

export function displayNodeName(node: GraphNode): string {
  return displayName(node.name, node.t);
}

/** The spelling as it appears in the source document, when casing changed it. */
export function originalName(node: GraphNode): string | undefined {
  const shown = displayNodeName(node);
  return shown === node.name ? undefined : node.name;
}
