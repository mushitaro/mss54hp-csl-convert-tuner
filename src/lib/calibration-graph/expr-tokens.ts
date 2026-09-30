import { cells } from "./metrics";

/**
 * Cutting a formula into the pieces the picture needs to talk about.
 *
 * The renderer used to split the drawn string with its own regex at paint time,
 * which meant the layout knew a formula's *width* and nothing about what was
 * inside it. That is why an input port's wire could only ever land on the
 * block's vertical centre: there was no way to ask where `RF` was written.
 *
 * Tokenizing here, in the model, gives one answer to three questions that must
 * never disagree — how wide is this line, where does the wire attach, and what
 * colour is this word. The invariant that keeps them honest is that the tokens
 * concatenate back to exactly the string that is drawn; `verify:cal-logic`
 * asserts it over all 14,524 recovered statements.
 *
 * Offsets are in monospace cells rather than pixels because that is the unit
 * the box was measured in (see ./metrics) — kana are two cells wide, and a
 * pixel offset computed any other way walks off the end of a Japanese gloss.
 */

export type TokenRole =
  /** A map, curve or constant — the editable calibration. */
  | "calib"
  /** An interpolation or filter helper: the operation, not the data. */
  | "helper"
  /** A factory ALL-CAPS signal. */
  | "signal"
  /** A lower-case symbol: a Ghidra function or a RAM name from disassembly. */
  | "symbol"
  /** A literal. */
  | "number"
  /** Machine plumbing: decompiler temporaries, width casts, truncation masks. */
  | "plumbing"
  /** A name this tool inferred rather than measured — always drawn as such. */
  | "inferred"
  /** Operators, brackets, whitespace. */
  | "op";

export interface Token {
  text: string;
  role: TokenRole;
  /** Offset from the start of the expression, in monospace cells. */
  cell: number;
  /** Width, in monospace cells. */
  cells: number;
  /** The symbol this token names, when it names one. Wires attach by this. */
  name?: string;
  /** Inside a `{A ｜ B}` alternative group, whichever role it has. */
  alt?: boolean;
  /** Why this token reads the way it does; shown on hover. */
  title?: string;
}

/**
 * What the rewriting stage learned about a token while it was producing it.
 *
 * Keyed by the text as drawn. The alternative was to smuggle a marker into the
 * string and have the tokenizer pick it back out, which would put a sentinel
 * character into text that is also measured and clipped — and a sentinel that
 * survives clipping into the middle of a name is a bug nobody would find.
 */
export interface TokenNote {
  inferred?: boolean;
  plumbing?: boolean;
  title?: string;
}
export type TokenNotes = Readonly<Record<string, TokenNote>>;

const IDENT = /^[A-Za-z_]\w*/;
const NUMBER = /^(?:0[xX][0-9a-fA-F]+|\d+)/;

/**
 * Machine detail rather than calibration: the decompiler's temporaries (after
 * logic-format has renamed them), the width casts it inserts, and the register
 * names it could not resolve. Drawn muted — present, checkable, not shouting.
 */
const TEMPORARY =
  /^(?:tmp\d*|arg\d+|reg_[A-Za-z]\w*|in_\w+|[a-z]{1,3}Var\d+|u?(?:int|char|short|long)\d*(?:_t)?|byte|word|dword|uint|ushort|uchar|bool|float|double|undefined\d*)$/;

/** The interpolation and filter helpers, spelled as they survive the rewrite. */
const HELPER = /^(?:(?:kf|kl)[su]_[wb]int|(?:PT1|IIR)_Filter_\w+|tableLookup|PT1|IIR|CONCAT\d+|SUB\d+|ZEXT\d+|SEXT\d+|SCARRY\d+)$/;

/** Role from the name alone, before any note is applied. */
export function roleOf(text: string): TokenRole {
  if (TEMPORARY.test(text)) return "plumbing";
  if (/^(?:KF|KL|K)_/i.test(text)) return "calib";
  if (HELPER.test(text)) return "helper";
  if (/^[A-Z][A-Z0-9_]*$/.test(text)) return "signal";
  return "symbol";
}

/** True for a role that names something a wire can attach to. */
export function isOperand(role: TokenRole): boolean {
  return role === "calib" || role === "signal" || role === "symbol" || role === "inferred";
}

/**
 * Split a rewritten expression into drawable, addressable tokens.
 *
 * `notes` carries what `logic-format` worked out while rewriting — chiefly
 * which names were inferred from an address rather than read off a symbol.
 */
export function tokenize(text: string, notes: TokenNotes = {}): Token[] {
  const out: Token[] = [];
  let i = 0;
  let cell = 0;
  let alt = 0;

  const push = (piece: string, role: TokenRole, name?: string) => {
    const note = notes[piece];
    const finalRole = note?.inferred ? "inferred" : note?.plumbing ? "plumbing" : role;
    const w = cells(piece);
    out.push({
      text: piece,
      role: finalRole,
      cell,
      cells: w,
      ...(name ? { name } : {}),
      ...(alt > 0 ? { alt: true } : {}),
      ...(note?.title ? { title: note.title } : {}),
    });
    cell += w;
    i += piece.length;
  };

  while (i < text.length) {
    const rest = text.slice(i);
    const ch = text[i];

    // Alternative groups are tokenized through rather than swallowed whole: the
    // names inside one are real operands — `{K_MD_NBEGR_RAMPE ｜ KL_MD_NBEGR_RAMPE}`
    // is two tables a wire can come from — and taking the group as one opaque
    // token is what would hide them from the wiring. The bracket run only
    // records that everything until the close is an alternative.
    if (ch === "{") { alt++; push(ch, "op"); continue; }
    if (ch === "}") { push(ch, "op"); alt = Math.max(0, alt - 1); continue; }

    const ident = IDENT.exec(rest);
    if (ident) { push(ident[0], roleOf(ident[0]), ident[0]); continue; }

    const num = NUMBER.exec(rest);
    if (num) { push(num[0], "number"); continue; }

    // Everything else — operators, spaces, brackets — in runs, so a formula of
    // 80 characters does not become 80 tokens.
    const opRun = /^[^A-Za-z_0-9{}]+/.exec(rest);
    push(opRun ? opRun[0] : ch, "op");
  }

  return out;
}

/**
 * The assigned-to name, as its own token; the write wire leaves from here.
 *
 * A target is ONE thing however many tokens it takes to spell. Taking the first
 * token of `tokenize` was right only while every target was a bare identifier,
 * and 4,330 of the 14,524 statements — 29.8% — have one that is not:
 *
 *     RAM 0xFFDB83                 drawn as "RAM"
 *     RAM 0xFFDBAC                 drawn as "RAM"
 *     KM_ST_ZYL[param_1 & 0xff]    drawn as "KM_ST_ZYL"
 *
 * Two writes to two different addresses came out looking like two writes to the
 * same one, which is worse than showing nothing: the reader has no way to tell
 * the row apart from the row above it. `cells(l.out)` — what the layout budgets
 * the column — was always measured on the WHOLE string, so only the drawn text
 * was short, and the gap sat there looking like padding.
 *
 * `name` is the whole spelling too, so picking one address lights that address
 * and not every other region-named byte in the picture.
 */
export function outToken(out: string, notes: TokenNotes = {}): Token {
  const parts = tokenize(out, notes);
  if (parts.length === 1) return parts[0];
  const head = parts[0];
  const note = notes[out];
  return {
    text: out,
    role: note?.inferred ? "inferred" : note?.plumbing ? "plumbing" : head?.role ?? roleOf(out),
    cell: 0,
    cells: cells(out),
    name: out,
    ...(note?.title ? { title: note.title } : head?.title ? { title: head.title } : {}),
  };
}
