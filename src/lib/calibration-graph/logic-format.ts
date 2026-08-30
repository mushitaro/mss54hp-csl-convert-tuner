import type { GraphNode, Statement } from "./types";
import type { Lang } from "./calib-i18n";
import type { TokenNote, TokenNotes } from "./expr-tokens";
import { type AddressIndex, buildAddressIndex, resolveAddress } from "./address";
import { conditionPhrase } from "./guard-prose";
import { displayName } from "./names";

/**
 * Turn a recovered formula into something a tuner can read.
 *
 * `parse_logic` recovers what the block computes, but it recovers it in the
 * decompiler's own dialect: `kfs_wint(KF_TZ_GRUND,N,RF)` is a C call whose
 * name encodes the table's storage format, `x >> 8` is a scaling step written
 * as a bit shift, `uVar3` is a variable the decompiler invented, and
 * `DAT_00ffeb3e` is an address it failed to name. None of that is wrong; it is
 * just written for the wrong reader.
 *
 * Everything here is presentation. The original C is kept alongside and shown
 * on demand, because a rewrite that quietly disagreed with the decompiler
 * would be worse than no rewrite at all — and `ctx.plain` turns the whole
 * readable layer off in one place, so the two can be compared on screen.
 */

export interface FormatContext {
  /** RAM symbols by address, with the tiers for naming what falls between. */
  addr: AddressIndex;
  /** Node lookup by symbol name, for descriptions. */
  nodeByName: (name: string) => GraphNode | undefined;
  glossary: Record<string, string>;
  lang: Lang;
  /**
   * Readable rewriting on.
   *
   * False is AS DECOMPILED: no inferred names, no prose conditions, no tidied
   * syntax — the wording this viewer has always drawn. The lookup and shift
   * rewrites are older than this flag and stay on either way; they are how the
   * factory writes the same operations, not a reading of them.
   */
  plain: boolean;
}

export interface FormattedLine {
  out: string;
  expr: string;
  /** `expr` clipped to the width the box was measured at; what is drawn. */
  shown?: string;
  guard?: string;
  /** Plain-language reading of the guard, when the structure parsed. */
  guardGloss?: string;
  /** Plain-language reading of the assignment, when the operands are known. */
  gloss?: string;
  /** `gloss` before it was clipped to the box, for the tooltip. */
  glossFull?: string;
  /** The untouched `out = expr` as the decompiler produced it. */
  raw: string;
  /** The untouched guards, for the same reason. */
  rawGuards?: string;
  /** Machine plumbing rather than calibration: folded away by default. */
  noise: boolean;
  /**
   * What the rewriting learned about individual tokens — chiefly which names
   * were inferred from an address. Keyed by the text as drawn; consumed by
   * `tokenize` so the picture can colour an inference as an inference.
   */
  notes: TokenNotes;
}

/** Working state for one statement worth of rewriting. */
export interface Scratch {
  notes: Record<string, TokenNote>;
  /** Decompiler temporaries this statement can safely rename. */
  rename: Map<string, string>;
}

// --------------------------------------------------------------------------
// expression rewriting
// --------------------------------------------------------------------------

/**
 * The interpolation helpers, whose names encode the table's storage format.
 *
 * `[su]{1,2}` rather than one letter: `kfus_bint` names its two axes'
 * signedness separately and appears nine times, and with a single letter it
 * fell through the rewrite entirely — so those nine lines drew the raw C call
 * beside identical lines that had been rewritten to `KF_X[a, b]`.
 */
const LOOKUP_RE = /^(kf|kl)([su]{1,2})([wb])int$/;

/** Split `a, b, c` at depth 0. Brace groups are alternatives, not nesting. */
function splitArgs(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === "," && depth === 0) {
      out.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(text.slice(start).trim());
  return out;
}

/** Find `name(...)` calls and hand the argument text to `rewrite`. */
function rewriteCalls(
  text: string,
  rewrite: (name: string, args: string[]) => string | null,
): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const m = /([A-Za-z_]\w*)\(/.exec(text.slice(i));
    if (!m) {
      out += text.slice(i);
      break;
    }
    const nameStart = i + m.index;
    const open = nameStart + m[1].length;
    let depth = 0;
    let close = -1;
    for (let j = open; j < text.length; j++) {
      if (text[j] === "(") depth++;
      else if (text[j] === ")") {
        depth--;
        if (depth === 0) {
          close = j;
          break;
        }
      }
    }
    if (close < 0) {
      out += text.slice(i);
      break;
    }
    const inner = rewriteCalls(text.slice(open + 1, close), rewrite);
    const replaced = rewrite(m[1], splitArgs(inner));
    out += text.slice(i, nameStart);
    out += replaced ?? `${m[1]}(${inner})`;
    i = close + 1;
  }
  return out;
}

/** `{A | B | C}` renders with a full-width bar so it reads as one token. */
function formatAlternatives(token: string): string {
  // [\s\S] rather than the /s flag: this repo targets ES2017.
  const m = token.match(/^\{([\s\S]+)\}$/);
  if (!m) return token;
  return `{${m[1].split("|").map((s) => s.trim()).join(" ｜ ")}}`;
}

function shiftToScale(text: string): string {
  // `>> 8` is how the firmware divides by 256; the shift is an implementation
  // detail of a fixed-point scale factor, and reads as noise in a formula.
  //
  // The decompiler writes the count in hex as often as in decimal, and
  // matching only `\d+` turned `AQ_REL << 0xf` into `AQ_REL × 1xf`: the `0`
  // matched, `2 ** 0` gave 1, and `xf` was left sitting on the end. A scale
  // factor that reads 1 where the firmware means 32768 is the worst kind of
  // wrong for a tool someone tunes from. (`Number` reads the `0x` form.)
  const both = String.raw`(0[xX][0-9a-fA-F]+|\d+)`;
  return text
    .replace(new RegExp(String.raw`\s*>>\s*${both}`, "g"), (_m, n) => ` ÷ ${2 ** Number(n)}`)
    .replace(new RegExp(String.raw`\s*<<\s*${both}`, "g"), (_m, n) => ` × ${2 ** Number(n)}`);
}

/**
 * Name an address, and record how confident the name is.
 *
 * The three tiers live in ./address. What matters here is that tier 2 — the
 * inferred `SYM+6` — is gated on `plain`, so AS DECOMPILED never shows a name
 * this tool worked out, and that every inferred name leaves a note behind so
 * the renderer can draw it in the muted channel the picture already uses for
 * everything it inferred rather than measured.
 */
function nameAddress(addr: number, ctx: FormatContext, sc: Scratch): string {
  const r = resolveAddress(addr, ctx.addr, ctx.lang);
  if (r.inferred && !ctx.plain) {
    // Fall through to the region form rather than showing an inference.
    const plainForm = resolveAddress(addr, { byAddr: new Map(), sorted: [] }, ctx.lang);
    if (plainForm.title) sc.notes[plainForm.text] = { title: plainForm.title };
    return plainForm.text;
  }
  if (r.inferred || r.title) {
    sc.notes[r.text] = { ...(r.inferred ? { inferred: true } : {}), ...(r.title ? { title: r.title } : {}) };
  }
  return r.text;
}

function resolveData(text: string, ctx: FormatContext, sc: Scratch): string {
  return text.replace(/\b(?:DAT|UNK|PTR)_([0-9a-fA-F]{6,8})\b/g, (_m, hex) =>
    nameAddress(parseInt(hex, 16), ctx, sc),
  );
}

/**
 * Which decompiler temporaries this statement can rename without merging two.
 *
 * Ghidra names a temporary by type prefix and index, so `uVar2` and `iVar2` are
 * DIFFERENT variables that a naive rename to `tmp2` would silently join —
 * which is exactly the class of quiet disagreement with the decompiler this
 * file exists not to commit. An index used by more than one prefix in the same
 * statement therefore keeps its original spelling.
 */
function buildRenames(text: string): Map<string, string> {
  const prefixes = new Map<string, Set<string>>();
  for (const m of text.matchAll(/\b([a-z]{1,3})Var(\d+)\b/g)) {
    const set = prefixes.get(m[2]) ?? new Set<string>();
    set.add(m[1]);
    prefixes.set(m[2], set);
  }
  const out = new Map<string, string>();
  for (const [index, seen] of prefixes) {
    if (seen.size !== 1) continue;
    out.set(`${[...seen][0]}Var${index}`, `tmp${index}`);
  }
  for (const m of text.matchAll(/\bparam_(\d+)\b/g)) out.set(m[0], `arg${m[1]}`);
  return out;
}

function applyRenames(text: string, rename: Map<string, string>): string {
  if (!rename.size) return text;
  return text.replace(/\b[A-Za-z_]\w*\b/g, (name) => rename.get(name) ?? name);
}

/**
 * The rest of the C that is punctuation rather than meaning.
 *
 * Each rule is mechanical and reversible against the raw line on the tooltip.
 * The one that needs care is `*`: it is multiplication only when something
 * precedes it, because `*(base + 4)` is a pointer dereference and rendering
 * that as a multiplication sign would state something false. The test is the
 * character before it, which is why this is a capture rather than a lookbehind
 * (ES2017, per `formatAlternatives`).
 */
function tidySyntax(text: string, sc: Scratch): string {
  let out = text.replace(/\s*->\s*/g, ".");

  // Ghidra's sub-field selector: `X._2_2_` is two bytes at offset two of X.
  out = out.replace(/\._(\d+)_(\d+)_/g, (_m, offset, size) => {
    const shown = `[${offset}:${size}]`;
    sc.notes[shown] = {
      plumbing: true,
      title: `Ghidra sub-field: ${size} byte(s) at offset ${offset}`,
    };
    return shown;
  });

  out = out
    .replace(/([A-Za-z0-9_)\]}])(\s*)\*(\s*)/g, "$1$2×$3")
    .replace(/([A-Za-z0-9_)\]}])(\s*)\/(\s*)/g, "$1$2÷$3")
    .replace(/!=/g, "≠")
    .replace(/<=/g, "≤")
    .replace(/>=/g, "≥");
  // `x + -768` is how the decompiler writes a subtraction of a negative
  // constant; nobody reads it that way.
  return out.replace(/\+\s*-\s*(?=\d)/g, "- ");
}

/**
 * Hex where hex is the point, decimal where the number is a quantity.
 *
 * A mask reads better in hex — `& 0xF0` shows its shape and `& 240` does not —
 * but a scale factor does not: `× 0x10` is sixteen and should say so, and a
 * calibration constant compared against `0x35` cannot be checked against the
 * value in its own table until it reads 53. The test is the operator the
 * literal sits next to, which is the same distinction the guard renderer makes
 * when it turns a mask into bit numbers.
 */
function decimalise(text: string): string {
  return text.replace(/0[xX][0-9a-fA-F]+/g, (m, offset: number, whole: string) => {
    const before = whole.slice(0, offset).replace(/\s+$/, "").slice(-1);
    const after = whole.slice(offset + m.length).replace(/^\s+/, "").slice(0, 1);
    // The emptiness tests are not redundant: `"&|^~".includes("")` is true, so
    // a literal at either end of the string looked like a mask operand and kept
    // its hex. That is why `... + -0x300` stayed hex while the identical
    // `... + -0x300)` a few characters earlier turned into 768.
    const bitwise = (c: string) => c !== "" && "&|^~".includes(c);
    if (bitwise(before) || bitwise(after)) return m;
    return String(Number(m));
  });
}

/**
 * The factory's spelling for data, the decompiler's for code.
 *
 * `names.ts` settles this for every name the app shows except the operands
 * inside a formula, which were left as the XDF happened to spell them — so a
 * line could read `RF_SOLL_ASK_TEMP = kf_rf_soll_ask[N, aq_rel_rf]`, three
 * casings in one statement, two of them for symbols the tree lists in capitals.
 * Functions keep lower case on purpose: the contrast is the legend.
 */
function canonicalNames(text: string, ctx: FormatContext): string {
  return text.replace(/\b[A-Za-z_]\w*\b(\s*\()?/g, (whole, call: string | undefined) => {
    const name = call ? whole.slice(0, whole.length - call.length) : whole;
    const tail = call ?? "";
    if (C_TYPE.test(name)) return whole;
    const node = ctx.nodeByName(name);
    // The node decides WHETHER to capitalise, never WHAT to write. 544 of the
    // XDF's titles carry a parenthetical — `kf_rf_soll (CSL Alpha-N)` — and
    // `nameIndex` maps both that and the bare symbol to the same node, so
    // substituting `node.name` dropped the whole title into the middle of a
    // formula and made the line un-pasteable into TunerPro.
    if (node) return (node.t === "func" ? name : displayName(name)) + tail;
    // Not in the graph, but the factory naming scheme still says what it is —
    // the same fallback `classify()` uses to decide a port's kind. Without it a
    // curve the graph happens not to carry drew in lower case beside the gloss
    // that named it in capitals.
    if (/^(?:KF|KL|K)_/i.test(name)) return name.toUpperCase() + tail;
    // An unknown name followed by "(" is a call, and lower case is how this
    // viewer says "code" (see names.ts). Anything else is data, and gets the
    // factory casing — which is what `out` has always had, so leaving operands
    // alone spelled one symbol two ways inside a single statement.
    if (call || isDecompilerLocal(name)) return whole;
    return displayName(name) + tail;
  });
}

/**
 * C type names, which are the decompiler's vocabulary rather than the car's.
 *
 * Capitalising them turned `(uint16_t)(x >> 0xc)` into `(UINT16_T)(x ÷ 4096)`,
 * which reads like a factory signal doing something to a number.
 */
const C_TYPE = /^(?:u?(?:int|char|short|long)\d*(?:_t)?|byte|word|dword|uint|ushort|uchar|bool|float|double|undefined\d*)$/;

export function formatExpression(expr: string, ctx: FormatContext, sc: Scratch): string {
  let text = rewriteCalls(expr, (name, args) => {
    const lookup = LOOKUP_RE.exec(name.replace(/_/g, ""));
    if (lookup && args.length >= 2) {
      const table = formatAlternatives(args[0]);
      const axes = args.slice(1).join(", ");
      // A Kennfeld is indexed on two axes, a Kennlinie evaluated on one; the
      // bracket/paren distinction is the one the factory diagrams use.
      return lookup[1] === "kf" ? `${table}[${axes}]` : `${table}(${axes})`;
    }
    if (name === "tableLookup" && args.length === 2) {
      return `${formatAlternatives(args[0])}[${args[1]}]`;
    }
    const filter = /^(PT1|IIR)_Filter_\w+$/.exec(name);
    if (filter) {
      // (input, previous value, time constant). Every one of the 55 filter
      // calls in the artifact has all three, and this used to label the SECOND
      // as tau and drop the third — so `PT1_Filter_US(0, MD_MIN_START,
      // K_MD_MIN_START_KATH)` drew as `PT1(0, τ=MD_MIN_START)`: the state
      // presented as the time constant, and the actual time constant, which is
      // an editable calibration value, missing from the picture entirely.
      if (args.length >= 3) return `${filter[1]}(${args[0]}, ${args[1]}, τ=${args[2]})`;
      if (args.length === 2) return `${filter[1]}(${args[0]}, τ=${args[1]})`;
    }
    return null;
  });
  text = shiftToScale(text);
  // Before `resolveData`, not after. An unresolved address becomes a label that
  // CONTAINS hex — `RAM 0xFFECCC` — and decimalising afterwards turned that into
  // `RAM 16772300`, which is an address written as a population count.
  if (ctx.plain) text = decimalise(text);
  text = resolveData(text, ctx, sc);
  if (ctx.plain) text = applyRenames(text, sc.rename);
  text = canonicalNames(text, ctx);
  if (ctx.plain) text = tidySyntax(text, sc);
  text = text.replace(/\{[^{}]+\}/g, (m) => formatAlternatives(m));
  return text.replace(/\s+/g, " ").trim();
}

// --------------------------------------------------------------------------
// guards
// --------------------------------------------------------------------------

/**
 * How a bare symbol out of a guard should be spelled on screen.
 *
 * The prose and the formula above it have to agree — a condition naming
 * `DAT_00ffeb2f` above a formula naming `EE_ERROR_MASK+1` reads as two
 * different quantities — so the guard renderer is handed the same resolution
 * the expression rewriting uses, notes and all.
 */
function displaySymbol(raw: string, ctx: FormatContext, sc: Scratch): string {
  const m = /^(?:DAT|UNK|PTR)_([0-9a-fA-F]{6,8})$/.exec(raw);
  if (m) return nameAddress(parseInt(m[1], 16), ctx, sc);
  return sc.rename.get(raw) ?? displayName(raw);
}

export function formatGuard(
  guard: string,
  ctx: FormatContext,
  sc: Scratch,
): { text: string; phrase?: string } {
  const text = formatExpression(guard, ctx, sc);
  if (!ctx.plain) return { text };
  const phrase = conditionPhrase(guard, ctx.lang, (raw) => displaySymbol(raw, ctx, sc));
  return phrase ? { text, phrase } : { text };
}

// --------------------------------------------------------------------------
// what the line means
// --------------------------------------------------------------------------

/**
 * True for the stamp the XDF editor writes into a description it did not have.
 *
 * 1,986 of the 2,272 descriptions in the XDF are this block rather than prose —
 * a tool version, a file layout and a match ratio. Read as a description it is
 * worse than an empty field, because it looks like an answer.
 */
export function isToolMetadata(desc: string): boolean {
  return /\bHW:\d|MatchRatio|BlockFound|Created by find routine|File Orientation/.test(desc);
}

/** A description worth showing a reader, or nothing. */
export function meaningfulDescription(
  node: GraphNode | undefined,
  lang: Lang,
): string | undefined {
  const desc = lang === "ja" ? (node?.desc?.ja ?? node?.desc?.en) : node?.desc?.en;
  if (!desc || isToolMetadata(desc)) return undefined;
  return desc;
}

/**
 * The spelling a name gets when there is no description to show instead.
 *
 * `displayName` capitalises anything shaped like a symbol, which is right for
 * one and wrong for the decompiler's placeholders: the axis of an unnamed
 * lookup is `xValue`, and shouting it as `XVALUE` dressed a Ghidra local up as
 * a factory signal.
 */
function spell(name: string, ctx: FormatContext): string {
  // Same rule as `canonicalNames`: the node says whether this is data, the
  // spelling stays the one the statement used.
  const node = ctx.nodeByName(name);
  if (node) return node.t === "func" ? name : displayName(name);
  if (/^(?:KF|KL|K)_/i.test(name)) return name.toUpperCase();
  return isDecompilerLocal(name) ? name : displayName(name);
}

/**
 * True for a name the decompiler invented rather than one the factory chose.
 *
 * camelCase is the tell, and it is a reliable one here: every factory symbol in
 * this binary is ALL_CAPS or all_lower with underscores, and Ghidra's own
 * placeholders — `xValue`, `uVar3`, `pcVar4` — are the only camelCase in the
 * corpus. Without the test, capitalising unknown names shouted `xValue` as
 * `XVALUE`, dressing a decompiler local up as a factory signal.
 */
function isDecompilerLocal(name: string): boolean {
  return /[a-z][A-Z]/.test(name);
}

function describe(name: string, ctx: FormatContext): string | undefined {
  const desc = meaningfulDescription(ctx.nodeByName(name), ctx.lang);
  if (!desc) return undefined;
  // Descriptions run to a paragraph; the gloss is one line, so take the head.
  //
  // A long head used to be dropped outright, which threw away the sentence
  // that mattered most: `kf_rf_soll` opens with "commonly known as the CSL
  // Alpha-N Map" and was 62 characters, so the diagram said nothing about the
  // most-edited map in the binary. Length is a layout problem, and it is
  // solved in the layout — clipped to the box, whole in the tooltip.
  const head = desc.split(/[.。\n]/)[0].trim();
  return head || undefined;
}

/**
 * One line of plain language under the formula.
 *
 * Built only from descriptions that exist: a block whose operands are all
 * undocumented gets no gloss rather than an invented one. Guessing here would
 * be the worst kind of wrong, because a gloss is exactly what a reader who
 * cannot read the formula will trust.
 */
export function glossFor(st: Statement, ctx: FormatContext): string | undefined {
  const outDesc = describe(st.out, ctx);
  const parts: string[] = [];
  for (const it of st.interp) {
    const table = it.tables[0];
    if (!table) continue;
    const tableDesc = describe(table, ctx) ?? spell(table, ctx);
    const axes = it.axes.map((a) => describe(a, ctx) ?? spell(a, ctx));
    if (ctx.lang === "ja") {
      const by = axes.length ? `${axes.join("×")} で` : "";
      parts.push(`${tableDesc} を ${by}補間`);
    } else {
      const by = axes.length ? ` over ${axes.join(" × ")}` : "";
      parts.push(`interpolate ${tableDesc}${by}`);
    }
  }
  if (!parts.length && !outDesc) return undefined;
  const target = outDesc ?? displayName(st.out);
  if (!parts.length) return ctx.lang === "ja" ? `${target} を求める` : `compute ${target}`;
  return ctx.lang === "ja"
    ? `${target} ← ${parts.join("、")}`
    : `${target} ← ${parts.join(", ")}`;
}

// --------------------------------------------------------------------------
// noise
// --------------------------------------------------------------------------

/**
 * Statements that are the machine's business rather than the calibration's.
 *
 * A third of the recovered statements are pointer walks, peripheral register
 * pokes and decompiler temporaries. They are honest output and worth keeping,
 * but showing them by default buries the two lines in a block that actually
 * interpolate a map. They are folded, and the count is always shown.
 */
export function isNoise(st: Statement, ctx: FormatContext): boolean {
  if (st.interp.length) return false;
  const text = `${st.out} = ${st.expr}`;
  if (/\b(?:KF|KL|K)_[A-Z0-9_]+/.test(text)) return false;
  if (
    /\b(?:DAT|UNK|PTR)_[0-9a-fA-F]{6,8}\b/.test(text) ||
    /\bparam_\d+\b/.test(text) ||
    /\b[a-z]{1,3}Var\d+\b/.test(text) ||
    /\b\w+_\d+_\d+_\b/.test(text) ||
    /\*\s*\(/.test(text) ||
    /\b(?:SIM_|TPU_|QSM_|SIM\b)/.test(text)
  ) {
    return true;
  }
  // A bare constant is plumbing when it lands somewhere the graph has never
  // heard of (a decompiler local, a peripheral register), and real logic when
  // it lands on a known signal: `CFG_RAM_SG_TYP = 2` selects the control unit
  // variant, which is exactly the sort of line a tuner is looking for.
  if (/^\s*[\w.[\]]+\s*=\s*(?:0x[0-9a-fA-F]+|-?\d+)\s*$/.test(text)) {
    const target = st.out.replace(/[[\].>-].*$/, "");
    return !ctx.nodeByName(target);
  }
  return false;
}

export function formatStatement(st: Statement, ctx: FormatContext): FormattedLine {
  // Renames are decided across the WHOLE statement, guards included: the
  // temporaries are shared between a condition and the assignment it governs,
  // and deciding per fragment would spell one variable two ways on two lines.
  const whole = [st.out, st.expr, ...st.guards].join(" ");
  const sc: Scratch = { notes: {}, rename: ctx.plain ? buildRenames(whole) : new Map() };

  const guards = st.guards.map((g) => formatGuard(g, ctx, sc));
  const gloss = glossFor(st, ctx);
  const and = ctx.lang === "ja" ? " かつ " : " and ";
  const or = ctx.lang === "ja" ? "または" : " or ";
  // A statement can carry several guards and they are ANDed. One of them
  // reading "A or B" has to keep its brackets across that join, or
  // `(A or B) and C` flattens into `A or B and C`, which is a different
  // condition. guard-prose brackets what it nests; this is the seam above it.
  const phrases = (guards.map((g) => g.phrase).filter(Boolean) as string[]).map((p) =>
    guards.length > 1 && p.includes(or) ? `(${p})` : p,
  );

  return {
    // The assigned-to name needs the same address resolution as the operands;
    // it is the same kind of symbol, just on the other side of the "=".
    out: resolveData(applyRenames(displayName(st.out), sc.rename), ctx, sc),
    expr: formatExpression(st.expr, ctx, sc),
    guard: guards.length ? guards.map((g) => g.text).join(and) : undefined,
    // Every guard has to have a phrase or none of them does: a condition that
    // is half sentence and half C reads as one condition, not as two.
    guardGloss:
      phrases.length === guards.length && phrases.length
        ? ctx.lang === "ja"
          ? `${phrases.join(and)} のとき`
          : `while ${phrases.join(and)}`
        : undefined,
    gloss,
    glossFull: gloss,
    raw: `${st.out} = ${st.expr}`,
    rawGuards: st.guards.length ? st.guards.join(" AND ") : undefined,
    noise: isNoise(st, ctx),
    notes: sc.notes,
  };
}

/** Build the lookup context once per graph load. */
export function makeContext(
  nodes: GraphNode[],
  nameIndex: Record<string, string>,
  byId: Map<string, GraphNode>,
  glossary: Record<string, string>,
  lang: Lang,
  plain = true,
): FormatContext {
  return {
    addr: buildAddressIndex(nodes),
    nodeByName: (name) => {
      const id = nameIndex[name] ?? nameIndex[name.toLowerCase()];
      return id ? byId.get(id) : undefined;
    },
    glossary,
    lang,
    plain,
  };
}
