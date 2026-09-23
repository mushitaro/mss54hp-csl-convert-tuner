import type { GraphNode } from "./types";
import type { Lang } from "./calib-i18n";
import { displayName } from "./names";
import { Mss54HpRamWindows } from "../dme-link/ramMap";

/**
 * Saying what an address is, in three tiers, and never blurring which one it is.
 *
 * The decompiler names a location it could not resolve `DAT_00ffd00a`. There
 * are 3,851 of those in the recovered formulas and exactly 961 — a quarter —
 * sit on an address a RAM symbol claims outright. The rest used to render as
 * `RAM[0x00FFD00A]`, which is unreadable, and for about a hundred of them it
 * was also wrong: `DAT_0003d944` is in flash, not RAM, and the old fallback
 * said RAM for every address it failed to name.
 *
 * A further 1,551 land inside the span a known symbol appears to own. Naming
 * those is worth a lot — it is the difference between 25% and 65% of every
 * address in the picture reading as something — but it is an INFERENCE, because
 * the graph records where each symbol starts and never how long it is. So the
 * rule is deliberately conservative and the result is always marked:
 *
 *   an address belongs to the preceding symbol only if it stops short of where
 *   the NEXT known symbol begins, and only within 16 bytes.
 *
 * Both halves matter. The gap test is what makes it a claim about this binary's
 * own symbol table rather than a guess about type sizes; the 16-byte cap is
 * what stops a lone symbol in a sparse region from adopting a whole page. The
 * measured offsets cluster at 1, 2 and 8 — byte members of 2-, 4- and 8-byte
 * fields — which is what an inference this shape should look like when it is
 * right.
 */

export interface AddressIndex {
  byAddr: Map<number, string>;
  /** Every known address, ascending; searched by bisection. */
  sorted: number[];
}

export interface ResolvedAddress {
  /** What to draw. */
  text: string;
  /** True when the name was inferred rather than read off a symbol. */
  inferred?: boolean;
  /** Why it reads this way. Always set for an inferred name. */
  title?: string;
}

/** As far past a symbol as this will still call an address part of it. */
const MAX_OFFSET = 16;

/** Below this, the address is in flash rather than RAM on this control unit. */
const RAM_BASE = 0x00_ff_00_00;

export function buildAddressIndex(nodes: readonly GraphNode[]): AddressIndex {
  const byAddr = new Map<number, string>();
  for (const n of nodes) {
    if (n.t === "ram" && n.addr !== undefined && !byAddr.has(n.addr)) {
      byAddr.set(n.addr, n.name);
    }
  }
  return { byAddr, sorted: [...byAddr.keys()].sort((a, b) => a - b) };
}

/** Index of the largest known address strictly below `addr`, or -1. */
function below(sorted: readonly number[], addr: number): number {
  let lo = 0;
  let hi = sorted.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < addr) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

const hex = (addr: number, digits = 6) =>
  `0x${addr.toString(16).toUpperCase().padStart(digits, "0")}`;

/**
 * True when the DME will serve this address over a DS2 control-0x06 read.
 *
 * Worth saying out loud rather than keeping to the link layer: an address in
 * one of these windows is one the reader can actually watch on a running
 * engine, and that is usually the next question after "what is it".
 */
function liveWindow(addr: number): boolean {
  return Object.values(Mss54HpRamWindows).some((w) => addr >= w.lo && addr < w.hi);
}

export function resolveAddress(addr: number, ix: AddressIndex, lang: Lang): ResolvedAddress {
  const exact = ix.byAddr.get(addr);
  if (exact) return { text: displayName(exact) };

  const i = below(ix.sorted, addr);
  if (i >= 0) {
    const base = ix.sorted[i];
    const offset = addr - base;
    const next = i + 1 < ix.sorted.length ? ix.sorted[i + 1] : Infinity;
    if (offset <= MAX_OFFSET && base + offset < next) {
      const name = displayName(ix.byAddr.get(base)!);
      return {
        text: `${name}+${offset}`,
        inferred: true,
        title:
          lang === "ja"
            ? `推定です。${hex(addr)} は ${name} の ${offset} バイト先にあり、次の既知シンボルより手前です。シンボルの長さは記録されていないため、同じ変数の一部だと確定してはいません。`
            : `Inferred. ${hex(addr)} is ${offset} bytes past ${name} and short of the next known symbol. Symbol lengths are not recorded, so this is not confirmed to be part of the same variable.`,
      };
    }
  }

  if (addr >= RAM_BASE) {
    const live = liveWindow(addr);
    return {
      text: `RAM ${hex(addr)}`,
      title: live
        ? lang === "ja"
          ? `名前の付いたシンボルがありません。DS2 のライブ読み出し窓の中にあるので、エンジン運転中に読める番地です。`
          : `No symbol carries this address. It is inside a DS2 live-read window, so it can be watched on a running engine.`
        : lang === "ja"
          ? `名前の付いたシンボルがありません。DS2 のライブ読み出し窓の外なので、走行中に読むことはできません。`
          : `No symbol carries this address, and it is outside the DS2 live-read windows.`,
    };
  }

  return {
    text: `FLASH ${hex(addr)}`,
    title:
      lang === "ja"
        ? `フラッシュ上の番地です（RAM ではありません）。名前の付いたシンボルはありません。`
        : `An address in flash, not RAM. No symbol carries it.`,
  };
}
