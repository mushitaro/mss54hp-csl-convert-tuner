import type { Indexed } from "./graph";

/**
 * The whole controller, as regions with names — and the size of the part that
 * has none.
 *
 * The question this answers is "where in the engine am I", which the picture
 * cannot answer because the picture only ever holds a dozen blocks. It needs a
 * grouping of all 1,705, and the grouping has to come from somewhere real.
 *
 * ## Why the Funktionsrahmen and not the XDF categories
 *
 * The plan said to group by the XDF's own categories. Measuring them settled
 * it against that: the categories are attached to PARAMETERS (2,528 of 2,529
 * carry one) and to no function at all, and the two largest groups they
 * produce are called "no function" (75) and "measured value" (61). A map whose
 * biggest named region means nothing is worse than no map.
 *
 * The artifact carries a second grouping that does mean something: BMW's own
 * Funktionsrahmen, 39 documented sections — torque management, filling
 * regulator, injection, EGAS, ignition, lambda control — cross-referenced onto
 * 2,093 nodes. Those names are the engineering decomposition of this ECU, by
 * the people who built it.
 *
 * ## What is inferred, and what that costs
 *
 * Only 12 functions are documented directly — 25 is the EDGE count, and the
 * two are not the same number: `md_verbraucher`, `kls_wint`, `edk_write`,
 * `EGAS_SOLL_BERECH`, `EGAS_SOLL_BESTIMM`, `wdk_a100_adapt`, `edk_tr_diag_stat`,
 * `pdr_m`, `task_pdr_m`, `ti_set_startbereich`, `ti_write_undo`, `ed_report`.
 * A block's region is therefore
 * voted for by the parameters and signals it touches, which is an inference,
 * and it is drawn as one — dashed, and never as a claim about a single block.
 *
 * It reaches **473 of 1,705** blocks. The remaining 1,232 are the largest
 * region on the map and are drawn that way, at their true size, because the
 * one thing a reader must not take from this picture is that it is complete.
 */

export interface Region {
  /** Funktionsrahmen section number, e.g. `4.01`. Empty for the unnamed one. */
  section: string;
  /** The section's title in the reader's language. */
  title: string;
  /** Blocks voted into it. */
  blocks: string[];
}

export interface SystemMap {
  regions: Region[];
  /** Blocks no section could be inferred for — always the largest region. */
  unplaced: string[];
  /** Which region each block landed in, by block id. */
  sectionOf: Map<string, string>;
  /** Every block the map considered. */
  total: number;
}

const CACHE = new WeakMap<Indexed, Map<string, SystemMap>>();

/**
 * A block's own documentation counts for more than a parameter it happens to
 * read.
 *
 * Without the weighting, one directly documented function loses its section to
 * whichever unrelated map it reads most of. Five is enough that a direct
 * cross-reference always wins and never enough to invent a region on its own.
 */
const DIRECT = 5;

export function systemMap(g: Indexed, lang: "ja" | "en"): SystemMap {
  let byLang = CACHE.get(g);
  if (!byLang) {
    byLang = new Map();
    CACHE.set(g, byLang);
  }
  const had = byLang.get(lang);
  if (had) return had;

  /** Node id → the sections its cross-references land on. */
  const sections = new Map<string, Set<string>>();
  for (const e of g.raw.edges) {
    if (e.o !== "fr" || e.k !== "documented") continue;
    const page = g.byId.get(e.d);
    const section = (page as { section?: string } | undefined)?.section;
    if (!section) continue;
    const at = sections.get(e.s);
    if (at) at.add(section);
    else sections.set(e.s, new Set([section]));
  }

  const title = new Map<string, string>();
  for (const doc of g.raw.frDocs ?? []) {
    title.set(doc.section, (lang === "ja" ? doc.ja : doc.en) || doc.en || doc.section);
  }

  const members = new Map<string, string[]>();
  const sectionOf = new Map<string, string>();
  const unplaced: string[] = [];
  let total = 0;

  for (const node of g.raw.nodes) {
    if (node.t !== "func") continue;
    total += 1;
    const votes = new Map<string, number>();
    const cast = (section: string, weight: number) =>
      votes.set(section, (votes.get(section) ?? 0) + weight);
    for (const e of g.out.get(node.id) ?? []) {
      for (const s of sections.get(e.d) ?? []) cast(s, 1);
    }
    for (const s of sections.get(node.id) ?? []) cast(s, DIRECT);

    if (!votes.size) {
      unplaced.push(node.id);
      continue;
    }
    // Ties broken by section number, so the map is the same map every time.
    const best = [...votes.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
    sectionOf.set(node.id, best);
    const at = members.get(best);
    if (at) at.push(node.id);
    else members.set(best, [node.id]);
  }

  const regions: Region[] = [...members.entries()]
    .map(([section, blocks]) => ({ section, title: title.get(section) ?? section, blocks }))
    .sort((a, b) => b.blocks.length - a.blocks.length || a.section.localeCompare(b.section));

  const built: SystemMap = { regions, unplaced, sectionOf, total };
  byLang.set(lang, built);
  return built;
}
