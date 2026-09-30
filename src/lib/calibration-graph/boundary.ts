import type { GraphNode } from "./types";
import type { Indexed } from "./graph";
import { blockChain, signalOf } from "./diagram-model";

/**
 * Where the engine ends and the computer begins.
 *
 * Every picture in this tool draws blocks passing values to blocks, and a
 * reader who has not seen the code before has no way to tell where that chain
 * STARTS or STOPS. The complaint was exactly this: no driver input at one end,
 * no actuator at the other, so the feedback loop the whole ECU is could not be
 * seen as a loop.
 *
 * The two ends are not a guess. They are a list, and it comes from the
 * processor's memory map:
 *
 *   `0xFFF2B0–0xFFF2DF`  QADC result registers — the fifteen analogue inputs.
 *                        Pedal, both throttle sensors, both lambda sensors,
 *                        the temperatures, the pressures, knock.
 *   `0xFFF410–0xFFF45F`  CTM4 channels — the VANOS solenoids and the PWM
 *                        outputs, plus two capture channels that read.
 *   `0xFFFF00–0xFFFFFF`  TPU parameter RAM — the injection pulses, the fuel
 *                        pump, and the crank wheel timing.
 *
 * Everything else above `0xFFF000` is the chip configuring itself — SIM chip
 * selects, QSM serial, SRAM and TPU control, the QADC's own control registers.
 * Those are peripheral registers too, and a rule based on "peripheral, and
 * nothing reads it back" would have called 81 of them outputs. They are not
 * outputs; the engine cannot tell whether a chip-select was written.
 *
 * ## Which way a register points
 *
 * From whether the ECU can write it. Nothing in the binary writes an input, so
 * the value can only have arrived from the hardware; an output is one the code
 * drives, whether or not it reads it back afterwards.
 *
 * That rule is checkable and it catches its own failure. `PSP1_HIGH_TIME` and
 * `PSP1_END_ANGLE` come out as inputs on the master and outputs on the slave —
 * the same register, on two banks, pointing two ways. One of those has to be
 * wrong, and it is the master's: an injector pulse is not something the engine
 * tells the ECU. The write is there and was not recovered. So a register whose
 * OTHER bank is written is reported as `suspect` rather than asserted as an
 * input, which is why the rail says 21 and not 23.
 */

/** A peripheral register at the edge of the ECU. */
export interface BoundaryPort {
  /** The graph node — carries the name, bank and address. */
  node: GraphNode;
  /** The location key, the way `blockChain` is keyed. */
  key: string;
  /** Which side of the ECU it is on. */
  side: "in" | "out";
  /** Which peripheral it belongs to, for grouping the rail. */
  family: "analogue" | "ctm4" | "tpu";
  /** Blocks that read it (an input) or write it (an output). */
  blocks: string[];
}

/**
 * The three address bands that carry signal, and what they are.
 *
 * Bands rather than name prefixes, because the names do not separate: the TPU's
 * control registers and its parameter RAM are both `TPU_*`, and one is chip
 * setup while the other is the injectors.
 */
const BANDS: { lo: number; hi: number; family: BoundaryPort["family"] }[] = [
  { lo: 0xfff2b0, hi: 0xfff2df, family: "analogue" },
  { lo: 0xfff410, hi: 0xfff45f, family: "ctm4" },
  { lo: 0xffff00, hi: 0xffffff, family: "tpu" },
];

/**
 * Control registers inside the CTM4 band.
 *
 * The band is the timer module's channels, but its first rows are the module's
 * own setup — the bus interface, the counter prescaler, and each submodule's
 * interrupt/control word. Those configure the timer; they do not move a valve.
 */
const CTM4_CONTROL = /SIC$|^CTM4_MCSM|BIUMCR|CPCR/;

export interface Boundary {
  inputs: BoundaryPort[];
  outputs: BoundaryPort[];
  /**
   * Registers the write-degree rule calls inputs, contradicted by the same
   * address on the other bank. Reported, never counted as either end.
   */
  suspect: BoundaryPort[];
  /** Every boundary register by its location key. */
  byKey: Map<string, BoundaryPort>;
}

const CACHE = new WeakMap<Indexed, Boundary>();

export function boundary(g: Indexed): Boundary {
  const had = CACHE.get(g);
  if (had) return had;

  const chain = blockChain(g);
  const candidates: { node: GraphNode; key: string; family: BoundaryPort["family"]; w: string[]; r: string[] }[] = [];
  /** Addresses something in the binary writes, on either bank. */
  const written = new Set<number>();

  for (const node of g.raw.nodes) {
    if (node.t !== "ram" || node.addr == null) continue;
    const band = BANDS.find((b) => node.addr! >= b.lo && node.addr! <= b.hi);
    if (!band) continue;
    if (band.family === "ctm4" && CTM4_CONTROL.test(node.name)) continue;
    const key = signalOf(g, node.name, node.bank).key;
    const w = chain.writers.get(key) ?? [];
    const r = chain.readers.get(key) ?? [];
    if (w.length) written.add(node.addr);
    candidates.push({ node, key, family: band.family, w: [...w], r: [...r] });
  }

  const inputs: BoundaryPort[] = [];
  const outputs: BoundaryPort[] = [];
  const suspect: BoundaryPort[] = [];
  for (const c of candidates) {
    const port = (side: "in" | "out", blocks: string[]): BoundaryPort => ({
      node: c.node,
      key: c.key,
      side,
      family: c.family,
      blocks,
    });
    if (c.w.length) outputs.push(port("out", c.w));
    // Neither read nor written is not a boundary on THIS car: the master's
    // second VANOS channels are wired in the silicon and untouched by the code.
    else if (!c.r.length) continue;
    else if (written.has(c.node.addr!)) suspect.push(port("in", c.r));
    else inputs.push(port("in", c.r));
  }

  const order = (a: BoundaryPort, b: BoundaryPort) =>
    (a.node.addr ?? 0) - (b.node.addr ?? 0) || (a.node.bank ?? "").localeCompare(b.node.bank ?? "");
  inputs.sort(order);
  outputs.sort(order);
  suspect.sort(order);

  const byKey = new Map<string, BoundaryPort>();
  for (const p of [...inputs, ...outputs]) byKey.set(p.key, p);

  const built: Boundary = { inputs, outputs, suspect, byKey };
  CACHE.set(g, built);
  return built;
}

/**
 * How far each block is from each end, and how big a circle it sits in.
 *
 * Hops along the same writer→reader chain the pictures are built from, so a
 * distance here means the same thing a DEPTH step does: one more block.
 */
export interface Reach {
  /** Blocks by hops from the nearest block that reads a sensor. */
  fromInput: Map<string, number>;
  /** Blocks by hops to the nearest block that drives an actuator. */
  toOutput: Map<string, number>;
  /**
   * How many blocks are mutually reachable with this one — the size of its
   * strongly connected component, which is the honest form of "am I in a loop".
   *
   * 1 means it is in no loop at all. Anything larger is a circle, and the
   * measurement is blunt about how large: 589 of the 1,384 blocks with formulas
   * are in a loop at all, and the largest single component holds 432. The
   * engine controller is one mass of
   * mutual dependency, so the number is reported as a badge rather than as a
   * distance anybody could act on.
   */
  loopSize: Map<string, number>;
  /**
   * The same walk, kept per register rather than collapsed to the nearest.
   *
   * A rail has to say WHICH sensor is four blocks away, not that something is,
   * so each of the 54 boundary registers gets its own distance map. Fifty-four
   * breadth-first walks of a graph with 13,545 hand-offs, once per artifact.
   */
  perPort: Map<string, Map<string, number>>;
}

const REACH = new WeakMap<Indexed, Reach>();

export function reach(g: Indexed): Reach {
  const had = REACH.get(g);
  if (had) return had;

  const chain = blockChain(g);
  const next = new Map<string, Set<string>>();
  const prev = new Map<string, Set<string>>();
  const link = (m: Map<string, Set<string>>, a: string, b: string) => {
    const s = m.get(a);
    if (s) s.add(b);
    else m.set(a, new Set([b]));
  };
  for (const [key, writers] of chain.writers) {
    for (const w of writers) {
      for (const r of chain.readers.get(key) ?? []) {
        if (w === r) continue;
        link(next, w, r);
        link(prev, r, w);
      }
    }
  }

  const spread = (seeds: Iterable<string>, edges: Map<string, Set<string>>) => {
    const hops = new Map<string, number>();
    let front: string[] = [];
    for (const id of seeds) {
      if (!hops.has(id)) {
        hops.set(id, 0);
        front.push(id);
      }
    }
    let h = 0;
    while (front.length) {
      h += 1;
      const onwards: string[] = [];
      for (const id of front) {
        for (const o of edges.get(id) ?? []) {
          if (!hops.has(o)) {
            hops.set(o, h);
            onwards.push(o);
          }
        }
      }
      front = onwards;
    }
    return hops;
  };

  const b = boundary(g);
  const fromInput = spread(b.inputs.flatMap((p) => p.blocks), next);
  const toOutput = spread(b.outputs.flatMap((p) => p.blocks), prev);

  const perPort = new Map<string, Map<string, number>>();
  for (const port of b.inputs) perPort.set(port.key, spread(port.blocks, next));
  for (const port of b.outputs) perPort.set(port.key, spread(port.blocks, prev));

  const built: Reach = { fromInput, toOutput, loopSize: components(next), perPort };
  REACH.set(g, built);
  return built;
}

/**
 * Strongly connected components, iteratively.
 *
 * Tarjan, with its recursion turned into an explicit stack: the block graph has
 * a component of 502 and a recursive walk of it overflows.
 */
function components(next: Map<string, Set<string>>): Map<string, number> {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const size = new Map<string, number>();
  let counter = 0;

  for (const start of next.keys()) {
    if (index.has(start)) continue;
    const work: { v: string; edges: string[]; at: number }[] = [];
    const open = (v: string) => {
      index.set(v, counter);
      low.set(v, counter);
      counter += 1;
      stack.push(v);
      onStack.add(v);
      work.push({ v, edges: [...(next.get(v) ?? [])], at: 0 });
    };
    open(start);
    while (work.length) {
      const top = work[work.length - 1];
      if (top.at < top.edges.length) {
        const w = top.edges[top.at];
        top.at += 1;
        if (!index.has(w)) open(w);
        else if (onStack.has(w)) low.set(top.v, Math.min(low.get(top.v)!, index.get(w)!));
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) low.set(parent.v, Math.min(low.get(parent.v)!, low.get(top.v)!));
      if (low.get(top.v) === index.get(top.v)) {
        const members: string[] = [];
        let w: string;
        do {
          w = stack.pop()!;
          onStack.delete(w);
          members.push(w);
        } while (w !== top.v);
        for (const m of members) size.set(m, members.length);
      }
    }
  }
  return size;
}
