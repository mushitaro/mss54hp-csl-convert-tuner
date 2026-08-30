import type { Lang } from "./calib-i18n";

/**
 * Reading a guard as a sentence instead of as a mask test.
 *
 * A guard is the condition a formula runs under, and it is the half of a block
 * a tuner most needs and least often gets. There are 6,066 of them, and the
 * regex this replaces could phrase exactly one shape — a bit test naming German
 * engine states — which covers about 330. The other 5,700 were drawn as C.
 *
 * They did not need to be. Measured over the whole artifact, the vocabulary is
 * tiny: comparisons, bit masks, and && / || / not. The masks are overwhelmingly
 * NUMERIC (`& 2`, `& 0x80`, `& 0xf` — over a thousand occurrences), and turning
 * a numeric mask into the bits it selects is arithmetic, not interpretation.
 * `(TOG_FLAG & 2) == 0` says "bit 1 of TOG_FLAG is clear" and cannot say
 * anything else. That is the bulk of the win here and none of it is a guess.
 *
 * ## Where the honesty line is
 *
 * Either the whole guard parses or none of it is rephrased. The caller keeps
 * the formatted-C form when this returns undefined, and never gets a sentence
 * with a hole in it.
 *
 * Once it HAS parsed, every leaf is rendered: the ones with a phrase get the
 * phrase, and the rest are printed back as tidied source. That is a different
 * thing from the half-translated name `mnemonic.ts` refuses to compose, and the
 * difference is whether the reader can see the gap. A guard reading
 * "bit 3 of KM_ST is set かつ (cursor < AIF_FLASH_COUNTER + 63)" shows plainly
 * which half is still code. A name reading "target ??? pressure" does not — the
 * missing piece looks like an answer. So: structure is all-or-nothing, leaves
 * degrade visibly.
 */

// --------------------------------------------------------------------------
// the German the firmware tests against
// --------------------------------------------------------------------------

interface Term {
  ja: string;
  en: string;
}

/**
 * The engine-state bits, in the factory's German with a reading.
 *
 * Only the bits whose meaning is settled are listed. A mask naming a bit that
 * is not here keeps its mask form rather than being half-translated into a
 * guess, and the German is carried in every reading so it can be checked.
 */
const STATE_BITS: Record<string, Term> = {
  LL: { ja: "アイドル(Leerlauf)", en: "idle (Leerlauf)" },
  VL: { ja: "全負荷(Vollast)", en: "full load (Vollast)" },
  TL: { ja: "部分負荷(Teillast)", en: "part load (Teillast)" },
  S: { ja: "減速燃料カット(Schub)", en: "overrun (Schub)" },
  Start: { ja: "始動中(Start)", en: "cranking (Start)" },
  Nachlauf: { ja: "停止後の後処理(Nachlauf)", en: "after-run (Nachlauf)" },
  "KI.15 aus": { ja: "イグニッションOFF(Klemme 15 aus)", en: "ignition off (Klemme 15 aus)" },
  "Kl15 aus": { ja: "イグニッションOFF(Klemme 15 aus)", en: "ignition off (Klemme 15 aus)" },
};

/**
 * Named values a state word is compared against, rather than masked with.
 *
 * Plain German rendered as plain German — the original is kept in parentheses
 * for the same reason it is on the bits above. Translating `nicht sync` is not
 * the kind of inference this project guards against; claiming to know what the
 * firmware DOES about it would be.
 */
const STATE_VALUES: Record<string, Term> = {
  "in Ordnung": { ja: "正常(in Ordnung)", en: "OK (in Ordnung)" },
  "nicht sync": { ja: "同期していない(nicht sync)", en: "not synchronised (nicht sync)" },
  "nicht sync2": { ja: "同期していない2(nicht sync2)", en: "not synchronised 2 (nicht sync2)" },
  "Segm gesperrt": { ja: "セグメント遮断(Segm gesperrt)", en: "segment blocked (Segm gesperrt)" },
  "keine NW": { ja: "カム信号なし(keine NW)", en: "no camshaft signal (keine NW)" },
};

/** Names carrying an internal space; the lexer must not split these. */
const ATOMS = [...Object.keys(STATE_BITS), ...Object.keys(STATE_VALUES)]
  .filter((k) => k.includes(" "))
  .sort((a, b) => b.length - a.length);

// --------------------------------------------------------------------------
// lexer
// --------------------------------------------------------------------------

type Tok =
  | { t: "name"; v: string }
  | { t: "num"; v: number; raw: string }
  | { t: "op"; v: string }
  | { t: "eof" };

const RELOPS = ["==", "!=", "<=", ">=", "<", ">"];
/** Longest first, so `<<` is never read as two `<`. */
const OPS = ["&&", "||", "==", "!=", "<=", ">=", ">>", "<<", "&", "|", "^", "+", "-", "*", "/", "%", "<", ">", "(", ")", "[", "]", "~", "!"];

function lex(src: string): Tok[] | null {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === " " || ch === "\t" || ch === "\n") { i++; continue; }

    const atom = ATOMS.find((a) => src.startsWith(a, i));
    if (atom) { out.push({ t: "name", v: atom }); i += atom.length; continue; }

    // Ghidra writes the logical operators as words as often as as symbols.
    const word = /^(?:and|or|not)\b/.exec(src.slice(i));
    if (word) {
      out.push({ t: "op", v: word[0] === "and" ? "&&" : word[0] === "or" ? "||" : "not" });
      i += word[0].length;
      continue;
    }

    // A C character literal is a number wearing a quote: `'5'` is 53, and a
    // calibration constant compared against it cannot be checked against the
    // table until it says so.
    const chr = /^'(\\[0abtnvfre\\'"]|\\x[0-9a-fA-F]{1,2}|[^\\'])'/.exec(src.slice(i));
    if (chr) {
      const v = charValue(chr[1]);
      if (v === null) return null;
      // Printed as the number it is. A calibration constant compared against
      // 0x35 cannot be checked against the value in its table while the guard
      // says '5'. The quoted form stays in the raw C on the tooltip.
      out.push({ t: "num", v, raw: String(v) });
      i += chr[0].length;
      continue;
    }

    const num = /^(?:0[xX][0-9a-fA-F]+|\d+)/.exec(src.slice(i));
    if (num) { out.push({ t: "num", v: Number(num[0]), raw: num[0] }); i += num[0].length; continue; }

    const name = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(src.slice(i));
    if (name) { out.push({ t: "name", v: name[0] }); i += name[0].length; continue; }

    const op = OPS.find((o) => src.startsWith(o, i));
    if (op) { out.push({ t: "op", v: op }); i += op.length; continue; }

    return null; // something this grammar has never seen
  }
  out.push({ t: "eof" });
  return out;
}

function charValue(body: string): number | null {
  if (body.length === 1) return body.charCodeAt(0);
  if (body.startsWith("\\x")) return parseInt(body.slice(2), 16);
  const escapes: Record<string, number> = {
    "\\0": 0, "\\a": 7, "\\b": 8, "\\t": 9, "\\n": 10, "\\v": 11, "\\f": 12,
    "\\r": 13, "\\e": 27, "\\\\": 92, "\\'": 39, '\\"': 34,
  };
  return escapes[body] ?? null;
}

// --------------------------------------------------------------------------
// parser
// --------------------------------------------------------------------------

type Node =
  | { t: "or"; parts: Node[] }
  | { t: "and"; parts: Node[] }
  | { t: "not"; inner: Node }
  | { t: "cmp"; op: string; left: Node; right: Node }
  | { t: "bin"; op: string; left: Node; right: Node }
  | { t: "unary"; op: string; inner: Node }
  | { t: "index"; base: Node; index: Node }
  | { t: "name"; v: string }
  | { t: "num"; v: number; raw: string };

function parse(toks: Tok[]): Node | null {
  let p = 0;
  const peek = () => toks[p];
  const isOp = (v: string) => { const k = toks[p]; return k.t === "op" && k.v === v; };
  const eat = (v: string) => { if (!isOp(v)) return false; p++; return true; };

  const chain = (next: () => Node | null, ops: string[], t: "or" | "and"): Node | null => {
    const first = next();
    if (!first) return null;
    const parts = [first];
    while (ops.some((o) => isOp(o))) {
      p++;
      const rhs = next();
      if (!rhs) return null;
      parts.push(rhs);
    }
    return parts.length === 1 ? first : { t, parts };
  };

  const binary = (next: () => Node | null, ops: string[]): Node | null => {
    let left = next();
    if (!left) return null;
    for (;;) {
      const k = peek();
      if (k.t !== "op" || !ops.includes(k.v)) return left;
      p++;
      const right = next();
      if (!right) return null;
      left = { t: "bin", op: k.v, left, right };
    }
  };

  const primary = (): Node | null => {
    const k = peek();
    if (k.t === "op" && k.v === "(") {
      p++;
      const inner = or();
      if (!inner || !eat(")")) return null;
      return inner;
    }
    if (k.t === "num") { p++; return { t: "num", v: k.v, raw: k.raw }; }
    if (k.t === "name") {
      p++;
      let node: Node = { t: "name", v: k.v };
      while (isOp("[")) {
        p++;
        const idx = or();
        if (!idx || !eat("]")) return null;
        node = { t: "index", base: node, index: idx };
      }
      return node;
    }
    return null;
  };

  const unary = (): Node | null => {
    for (const op of ["not", "!", "-", "~"]) {
      if (isOp(op)) {
        p++;
        const inner = unary();
        if (!inner) return null;
        return op === "not" || op === "!" ? { t: "not", inner } : { t: "unary", op, inner };
      }
    }
    return primary();
  };

  const mul = () => binary(unary, ["*", "/", "%", ">>", "<<"]);
  const add = () => binary(mul, ["+", "-"]);
  const bitand = () => binary(add, ["&"]);
  const bitor = () => binary(bitand, ["|", "^"]);
  const cmp = (): Node | null => {
    const left = bitor();
    if (!left) return null;
    const k = peek();
    if (k.t !== "op" || !RELOPS.includes(k.v)) return left;
    p++;
    const right = bitor();
    if (!right) return null;
    return { t: "cmp", op: k.v, left, right };
  };
  const and = () => chain(cmp, ["&&"], "and");
  const or = (): Node | null => chain(and, ["||"], "or");

  const tree = or();
  if (!tree || peek().t !== "eof") return null;
  return tree;
}

// --------------------------------------------------------------------------
// bits
// --------------------------------------------------------------------------

/** Which bits a numeric mask selects, low to high. */
function bitsOf(mask: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < 32; i++) if (mask & (1 << i)) out.push(i);
  return out;
}

/** `bit 7`, `bits 0-3`, `bits 0, 8, 12` — runs collapse, gaps do not. */
function bitPhrase(bits: number[]): string {
  const runs: string[] = [];
  let i = 0;
  while (i < bits.length) {
    let j = i;
    while (j + 1 < bits.length && bits[j + 1] === bits[j] + 1) j++;
    runs.push(j - i >= 2 ? `${bits[i]}-${bits[j]}` : bits.slice(i, j + 1).join(", "));
    i = j + 1;
  }
  return `${bits.length === 1 ? "bit" : "bits"} ${runs.join(", ")}`;
}

/** Every plain name in an OR-of-names mask, or null if it is not one. */
function maskNames(node: Node): string[] | null {
  if (node.t === "name") return [node.v];
  if (node.t === "bin" && (node.op === "|" || node.op === "^")) {
    const l = maskNames(node.left);
    const r = maskNames(node.right);
    return l && r ? [...l, ...r] : null;
  }
  return null;
}

// --------------------------------------------------------------------------
// rendering
// --------------------------------------------------------------------------

const SYMBOL: Record<string, string> = {
  "==": "=", "!=": "≠", "<=": "≤", ">=": "≥", "*": "×", "/": "÷", "&&": "&&", "||": "||",
};

/** True for the operators whose operands read better in hex than in decimal. */
const BITWISE = new Set(["&", "|", "^", "~"]);

/**
 * A literal, in the base that says what it is.
 *
 * Same rule as the formulas: a mask keeps its hex because the shape is the
 * point, and everything else is a quantity. `V_ANTRIEB >= 0x51` is a road speed
 * of 81 and nothing about the hex helps read it.
 */
function numText(node: Node, keepHex: boolean): string {
  if (node.t !== "num") return "";
  if (keepHex) return node.raw;
  return /^0[xX]/.test(node.raw) ? String(node.v) : node.raw;
}

/**
 * One binary operation.
 *
 * `>> 8` is how the firmware divides by 256, and the shift is an implementation
 * detail of a fixed-point scale factor rather than something a tuner is doing.
 * The formulas have spelled it as a division since `shiftToScale`; a guard
 * spelling it the other way would make one quantity look like two on adjacent
 * lines of the same block.
 */
function binText(left: string, op: string, rightNode: Node, right: string): string {
  if ((op === ">>" || op === "<<") && rightNode.t === "num") {
    return `${left} ${op === ">>" ? "÷" : "×"} ${2 ** rightNode.v}`;
  }
  const rhs = rightNode.t === "num" ? numText(rightNode, BITWISE.has(op)) : right;
  return `${left} ${SYMBOL[op] ?? op} ${rhs}`;
}

/** A leaf or arithmetic subtree, printed back as tidied source. */
function source(node: Node): string {
  switch (node.t) {
    case "name": return node.v;
    case "num": return node.raw;
    case "index": return `${source(node.base)}[${source(node.index)}]`;
    case "unary": return `${node.op}${source(node.inner)}`;
    case "not": return `!(${source(node.inner)})`;
    case "bin": return binText(source(node.left), node.op, node.right, source(node.right));
    case "cmp": return `${source(node.left)} ${SYMBOL[node.op] ?? node.op} ${source(node.right)}`;
    case "and": return node.parts.map(source).join(" && ");
    case "or": return node.parts.map(source).join(" || ");
  }
}

interface Ctx {
  lang: Lang;
  /** Presentation for a symbol name, so the prose matches the formula above it. */
  name: (raw: string) => string;
}

/**
 * `(W & MASK) ==/!= 0` and `(W & MASK) ==/!= MASK`.
 *
 * Between them these are three quarters of every mask guard in the artifact.
 * The two right-hand sides say opposite things and both are exact: against 0,
 * none of the masked bits is set; against the mask itself, all of them are.
 * Any OTHER right-hand side — `(cfg_m_motortyp & 0xf7) == 4` — is a value test
 * rather than a bit test, and gets the plain comparison instead of a sentence
 * that would have to invent which reading was meant.
 */
function maskTest(node: Node, ctx: Ctx): string | null {
  if (node.t !== "cmp" || (node.op !== "==" && node.op !== "!=")) return null;
  if (node.right.t !== "num") return null;
  const target = node.right.v;
  const inner = node.left;
  if (inner.t !== "bin" || inner.op !== "&") return null;
  if (inner.left.t !== "name") return null;
  const word = inner.left.v;
  const negated = node.op === "!=";

  // Named bits: the factory's German, when every bit in the mask is known.
  //
  // Not gated on the left operand being a state word. The decompiler routinely
  // copies ZUSTAND_MOTOR into a temporary first, and `uVar1 & (VL|TL|LL)` is
  // the same test as `ZUSTAND_MOTOR & (VL|TL|LL)` — requiring the word by name
  // left those drawn as a raw mask whose operator precedence was invisible.
  // The bit names carry the meaning here and they exist in one word only.
  const names = maskNames(inner.right);
  if (target === 0 && names && names.length) {
    const read = names.map((n) => STATE_BITS[n]?.[ctx.lang]);
    if (read.every(Boolean)) {
      const list = (read as string[]).join(ctx.lang === "ja" ? "・" : " / ");
      if (negated) return list;
      if (ctx.lang === "ja") return names.length === 1 ? `${list} でない` : `${list} のいずれでもない`;
      return `not ${list}`;
    }
  }

  // Numeric bits: arithmetic, and always right.
  if (inner.right.t !== "num") return null;
  const mask = inner.right.v;
  const bits = bitsOf(mask);
  if (!bits.length) return null;
  const where = bitPhrase(bits);
  const w = ctx.name(word);
  const one = bits.length === 1;

  if (target === 0) {
    // != 0 means at least one of them is set; == 0 means none is.
    if (ctx.lang === "ja") {
      if (one) return `${w} の ${where} が ${negated ? "1" : "0"}`;
      return negated ? `${w} の ${where} のどれかが 1` : `${w} の ${where} が全て 0`;
    }
    if (one) return `${where} of ${w} is ${negated ? "set" : "clear"}`;
    return negated ? `any of ${where} of ${w} is set` : `${where} of ${w} are all clear`;
  }

  if (target === mask) {
    // == mask means every one of them is set; != mask means at least one is not.
    if (ctx.lang === "ja") {
      if (one) return `${w} の ${where} が ${negated ? "0" : "1"}`;
      return negated ? `${w} の ${where} のどれかが 0` : `${w} の ${where} が全て 1`;
    }
    if (one) return `${where} of ${w} is ${negated ? "clear" : "set"}`;
    return negated ? `any of ${where} of ${w} is clear` : `${where} of ${w} are all set`;
  }

  return null;
}

/** `W ==/!= <named value>`. */
function valueTest(node: Node, ctx: Ctx): string | null {
  if (node.t !== "cmp" || (node.op !== "==" && node.op !== "!=")) return null;
  if (node.right.t !== "name") return null;
  const term = STATE_VALUES[node.right.v];
  if (!term) return null;
  const left = node.left.t === "name" ? ctx.name(node.left.v) : source(node.left);
  const value = term[ctx.lang];
  if (ctx.lang === "ja") return node.op === "==" ? `${left} が ${value}` : `${left} が ${value} でない`;
  return node.op === "==" ? `${left} is ${value}` : `${left} is not ${value}`;
}

/** `V ==/!= 0` on a bare name — "is set" reads better than "≠ 0". */
function zeroTest(node: Node, ctx: Ctx): string | null {
  if (node.t !== "cmp" || (node.op !== "==" && node.op !== "!=")) return null;
  if (node.left.t !== "name" || node.right.t !== "num" || node.right.v !== 0) return null;
  const v = ctx.name(node.left.v);
  if (ctx.lang === "ja") return node.op === "==" ? `${v} が 0` : `${v} が 0 でない`;
  return node.op === "==" ? `${v} is zero` : `${v} is non-zero`;
}

const FLIP: Record<string, string> = {
  "==": "!=", "!=": "==", "<": ">=", ">=": "<", ">": "<=", "<=": ">",
};

/**
 * Push a negation inwards, so the reader is not handed a double negative.
 *
 * The decompiler emits `not (A == 0 && B == 0)` where a person would say
 * "A or B is set", and rendered literally that became "(neither of these is
 * the case) is not the case" — which is correct, and unreadable. De Morgan is
 * arithmetic, not interpretation, so this is safe in a way a rewording would
 * not be; it returns null the moment it meets something it cannot invert, and
 * the plain negation is used instead.
 */
function negate(node: Node): Node | null {
  switch (node.t) {
    case "not":
      return node.inner;
    case "and":
    case "or": {
      const parts = node.parts.map(negate);
      if (parts.some((p) => p === null)) return null;
      return { t: node.t === "and" ? "or" : "and", parts: parts as Node[] };
    }
    case "cmp": {
      const flipped = FLIP[node.op];
      return flipped ? { ...node, op: flipped } : null;
    }
    default:
      return null;
  }
}

function phrase(node: Node, ctx: Ctx, depth = 0): string {
  const join = (parts: string[], word: string) => {
    const body = parts.join(word);
    return depth > 0 ? `(${body})` : body;
  };
  switch (node.t) {
    case "and":
      return join(node.parts.map((n) => phrase(n, ctx, depth + 1)), ctx.lang === "ja" ? " かつ " : " and ");
    case "or":
      return join(node.parts.map((n) => phrase(n, ctx, depth + 1)), ctx.lang === "ja" ? " または " : " or ");
    case "not": {
      const pushed = negate(node.inner);
      if (pushed) return phrase(pushed, ctx, depth);
      const inner = phrase(node.inner, ctx, depth + 1);
      return ctx.lang === "ja" ? `${inner} でない` : `not ${inner}`;
    }
    case "cmp": {
      const said = maskTest(node, ctx) ?? valueTest(node, ctx) ?? zeroTest(node, ctx);
      if (said) return said;
      // A compound operand keeps its brackets: `CFG & 0xEF が 32` hides which
      // of the two operators binds first, and the answer changes the condition.
      const bracket = (n: Node, text: string) => (n.t === "bin" ? `(${text})` : text);
      const l = bracket(node.left, renderOperand(node.left, ctx));
      const r = bracket(node.right, renderOperand(node.right, ctx));
      // Equality gets words, not "=". A condition drawn as `CFG & 0xEF = 0x20`
      // in a picture whose formulas are all `out = expr` reads as an
      // assignment, which is the opposite of what a guard is.
      if (node.op === "==") return ctx.lang === "ja" ? `${l} が ${r}` : `${l} is ${r}`;
      if (node.op === "!=") return ctx.lang === "ja" ? `${l} が ${r} でない` : `${l} is not ${r}`;
      return `${l} ${SYMBOL[node.op] ?? node.op} ${r}`;
    }
    default:
      return renderOperand(node, ctx);
  }
}

/** Arithmetic and leaves: tidied source with the display spelling of names. */
function renderOperand(node: Node, ctx: Ctx): string {
  switch (node.t) {
    case "name": return ctx.name(node.v);
    case "num": return numText(node, false);
    case "index": return `${renderOperand(node.base, ctx)}[${renderOperand(node.index, ctx)}]`;
    case "unary": return `${node.op}${renderOperand(node.inner, ctx)}`;
    case "bin": return binText(renderOperand(node.left, ctx), node.op, node.right, renderOperand(node.right, ctx));
    default: return source(node);
  }
}

/**
 * Read a guard as a condition phrase, or return nothing and let the caller
 * keep the C.
 *
 * A PHRASE, not a sentence: a statement can carry several guards and the
 * caller joins them before wrapping the result once. Wrapping here produced
 * "... のとき かつ ... のとき", which reads as two separate conditions when it
 * is one.
 *
 * `name` is how the caller spells a symbol on screen, so the phrase and the
 * formula above it agree — including the addresses the caller has resolved.
 */
export function conditionPhrase(
  guard: string,
  lang: Lang,
  name: (raw: string) => string = (s) => s,
): string | undefined {
  const toks = lex(guard);
  if (!toks) return undefined;
  const tree = parse(toks);
  if (!tree) return undefined;
  return phrase(tree, { lang, name }) || undefined;
}
