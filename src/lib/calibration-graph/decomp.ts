import type { Indexed } from "./graph";
import type { GraphNode } from "./types";
import { type Token, type TokenRole, roleOf } from "./expr-tokens";
import { cells } from "./metrics";
import { displayName } from "./names";

/**
 * The decompiler's own C, for the functions whose statements were never parsed.
 *
 * ## What this is for
 *
 * 1,171 of the 1,705 functions drew an empty box, and the tab told the reader
 * the same thing about all of them: "no formula recovered". That merged two
 * facts which were not alike — **110** had been decompiled and the text simply
 * never left the notes repository, while **1,061** had never been handed to
 * the decompiler at all, because the exporter dropped every function whose
 * name still began `FUN_`.
 *
 * Both halves are now closed. The corpus ships, and the exporter no longer
 * filters by spelling, so **every one of the 1,705 functions has its
 * decompiled body in the app**. What is left is a single, much smaller fact:
 *
 *   **321** functions have a body and no parsed statements. The decompiler
 *   ran, the text is here, and `parse_logic` could not turn it into
 *   assignments — a filter chain, a jump table, a loop it does not model.
 *   Quoting the body is the whole answer for those, and it is a real answer:
 *   the reader wanted the function and the function is what arrives.
 *
 *   **0** have nothing. That population is empty and this module would like it
 *   to stay that way; `verify:cal-decomp` fails if it is not.
 *
 * Every number here is asserted there, so the copy in the tab cannot drift
 * away from what the artifact holds.
 *
 * ## Why the text is re-tokenized rather than shown as a string
 *
 * A preformatted block would be legible and inert. Everything else in this tab
 * is connected — pick `KF_RF_SOLL` in the tree and every view lights where it
 * is touched — and a pane that opted out of that would be the one place a
 * reader has to find the symbol with their eyes.
 *
 * So the C is cut into the same `Token`s the formulas are, with the same roles
 * and therefore the same colours, and two measurements say what that buys:
 *
 *   **33,019 of 92,954** identifiers in the corpus are symbols the graph
 *   knows. They light with the selection and open on a click, exactly as they
 *   do in the reconstructed listing. The other 59,935 are `uVar1`, `param_1`,
 *   `local_10` — decompiler bookkeeping, which the `plumbing` role already
 *   draws as the background noise it is. (C's own grammar is not counted:
 *   `if`, `while` and the width types carry the `op` role, and counting them
 *   would make the ratio a statement about how much C is C.)
 *
 *   **2,735 of 2,737** `FUN_xxxxxxxx` call sites resolve to a real node, so a
 *   call into an unnamed function is a link and the reader can walk in. The
 *   two that do not are both `SUB_00f7d000`, an address no node in either
 *   bank occupies — outside the image, a label for an indirect target that is
 *   not in the program. They draw as machine detail with the address in the
 *   tooltip, which is what a reference to nowhere should look like.
 *
 * The one thing NOT rewritten is the spelling. `displayName` puts data symbols
 * in factory capitals, which is right for a formula this tool wrote and wrong
 * for a text it is quoting: what is drawn here is what Ghidra emitted,
 * character for character, and the display name rides along in `Token.name` so
 * the selection still matches across views.
 */

export interface DecompCorpus {
  /** Node id to the decompiler's C for that function. */
  texts: Record<string, string>;
}

/** A token of quoted C. `text` is the decompiler's spelling, `name` this tool's. */
export interface SourceToken extends Token {
  /** Node id, when pressing this token should open that function. */
  target?: string;
}

export interface SourceLine {
  /**
   * Leading whitespace, in monospace cells — Ghidra's own, not re-derived.
   *
   * The listing's other rows indent by reconstructed `if` nesting, four
   * characters a level. Applying that here would multiply the decompiler's
   * two-space steps by four and push a five-deep loop off the pane. The text
   * is quoted, so its layout is quoted too.
   */
  indent: number;
  tokens: SourceToken[];
  /** A WARNING note from the decompiler, drawn as an aside. */
  comment: boolean;
}

/**
 * C's own words, in two tiers — because they are not equally worth reading.
 *
 * `GRAMMAR` is control flow and declaration: `if`, `while`, `return`. It is
 * the shape of the function and it carries the `op` role, the same weight the
 * reconstructed listing gives its own `if` lines.
 *
 * `MACHINE` is width. `(ushort)`, `(uint)`, `undefined4` — the casts the
 * decompiler inserts to make an expression type-check, and `ushort` alone
 * appears 1,419 times in the corpus. They are the most common thing on screen
 * and among the least worth reading, so they take the `plumbing` role and sit
 * a step back from the grammar. Drawn at the same weight as `if` they were
 * the loudest noise in the pane.
 */
const GRAMMAR = new Set([
  "if", "else", "do", "while", "for", "switch", "case", "default", "break",
  "continue", "return", "goto", "sizeof", "struct", "union", "enum", "typedef",
  "static", "const", "volatile", "extern", "register", "signed", "unsigned",
  "void", "true", "false", "NULL",
]);

const MACHINE = new Set([
  "char", "short", "int", "long", "float", "double", "bool", "code", "byte",
  "word", "dword", "qword", "uint", "ushort", "ulong", "uchar", "undefined",
  "undefined1", "undefined2", "undefined4", "undefined8",
]);

/**
 * True for a word that is C itself rather than a name.
 *
 * Exported because `verify:cal-decomp` counts names, and a second copy of this
 * list inside the check would be a second answer to "is this a name" — the
 * same drift that put three different `dim` numbers in three views.
 */
export function isCWord(text: string): boolean {
  return GRAMMAR.has(text) || MACHINE.has(text);
}

/**
 * The decompiler's own scratch names, beyond the ones `roleOf` already knows.
 *
 * `roleOf` covers `uVar1`-shaped temporaries and the width types because those
 * survive into the rewritten formulas. These do not — they exist only in the
 * raw text — so they are matched here rather than widened into a rule the
 * formula tokenizer would also have to carry.
 */
const SCRATCH = /^(?:param_\d+|local_[0-9a-f]+|unaff_\w+|extraout_\w+|__\w+)$/;

/** `FUN_00012a4e` and friends: a name that is only an address. */
const ADDR_REF = /^(FUN|SUB|DAT|LAB|UNK|PTR|CODE)_([0-9a-fA-F]{6,8})$/;

/**
 * Names, per bank.
 *
 * `nameIndex` is one flat map for both processors, and **468 names exist on
 * more than one bank** — `N` is at 0xffedce on the master and 0xffe844 on the
 * slave. Resolving a master file's `N` through the flat map is a coin toss
 * that would put the slave's address in a master function's tooltip: the same
 * welding-the-two-CPUs-together mistake `blockChain` was carrying.
 */
const BY_BANK = new WeakMap<Indexed, Map<string, Map<string, GraphNode>>>();

function bankIndex(g: Indexed, bank: string): Map<string, GraphNode> {
  let banks = BY_BANK.get(g);
  if (!banks) {
    banks = new Map();
    for (const node of g.raw.nodes) {
      if (!node.bank) continue;
      let at = banks.get(node.bank);
      if (!at) banks.set(node.bank, (at = new Map()));
      // First writer wins, so the result does not depend on node order.
      if (!at.has(node.name)) at.set(node.name, node);
    }
    BY_BANK.set(g, banks);
  }
  return banks.get(bank) ?? new Map();
}

/** The node an identifier in this bank's text names, if the graph has one. */
function resolve(g: Indexed, bank: string, text: string): GraphNode | undefined {
  const local = bankIndex(g, bank);
  const hit = local.get(text) ?? local.get(text.toLowerCase()) ?? local.get(text.toUpperCase());
  if (hit) return hit;
  // Bank-less nodes — a calibration lives in the image, not in a processor's
  // RAM — are only in the flat index.
  const id = g.raw.nameIndex[text] ?? g.raw.nameIndex[text.toLowerCase()];
  return id ? g.byId.get(id) : undefined;
}

/** The node an `FUN_`/`DAT_` name points at, found by its address. */
function byAddress(g: Indexed, bank: string, kind: string, hex: string): GraphNode | undefined {
  const addr = parseInt(hex, 16);
  if (!Number.isFinite(addr)) return undefined;
  const prefix = kind === "FUN" || kind === "SUB" || kind === "CODE" ? "f" : "r";
  return g.byId.get(`${prefix}:${bank}:${addr.toString(16).padStart(6, "0")}`);
}

const IDENT = /^[A-Za-z_]\w*/;
const NUMBER = /^(?:0[xX][0-9a-fA-F]+|\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)/;
const LITERAL = /^(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/;
const OP_RUN = /^[^A-Za-z_0-9"']+/;

/**
 * Cut one line of C into drawable tokens.
 *
 * Same contract as `tokenize`: the pieces concatenate back to exactly the text
 * handed in. `verify:cal-decomp` asserts it over all 32,660 lines, because a
 * tokenizer that drops a character is a tokenizer that quietly rewrites the
 * source it claims to be quoting.
 */
function tokenizeC(g: Indexed, bank: string, text: string): SourceToken[] {
  const out: SourceToken[] = [];
  let i = 0;
  let cell = 0;

  const push = (piece: string, role: TokenRole, extra?: Partial<SourceToken>) => {
    const w = cells(piece);
    out.push({ text: piece, role, cell, cells: w, ...extra });
    cell += w;
    i += piece.length;
  };

  while (i < text.length) {
    const rest = text.slice(i);

    // A string or character literal is quoted material inside quoted material:
    // taken whole, so an apostrophe cannot start an identifier.
    const lit = LITERAL.exec(rest);
    if (lit) { push(lit[0], "number"); continue; }

    const ident = IDENT.exec(rest);
    if (ident) {
      const word = ident[0];
      if (GRAMMAR.has(word)) { push(word, "op"); continue; }
      if (MACHINE.has(word)) { push(word, "plumbing"); continue; }

      const addr = ADDR_REF.exec(word);
      if (addr) {
        const node = byAddress(g, bank, addr[1], addr[2]);
        const named = node ? !ADDR_REF.test(node.name) : false;
        // Still only an address, so it is drawn as machine detail — but the
        // function it points at can be opened. That was the only way into the
        // 1,061 the exporter used to drop; it is now simply how a call site
        // reads when Ghidra never found a name for its target.
        push(word, named && node ? roleOf(node.name) : "plumbing", {
          ...(node ? { name: node.t === "func" ? node.name : displayName(node.name) } : {}),
          ...(node && node.t === "func" ? { target: node.id } : {}),
          title: node
            ? `0x${addr[2].toUpperCase()} · ${node.name}`
            : `0x${addr[2].toUpperCase()} · no symbol`,
        });
        continue;
      }

      if (SCRATCH.test(word)) { push(word, "plumbing"); continue; }

      const node = resolve(g, bank, word);
      if (node) {
        const shown = node.t === "func" ? node.name : displayName(node.name);
        push(word, node.t === "param" ? "calib" : roleOf(shown), {
          name: shown,
          ...(node.t === "func" ? { target: node.id } : {}),
          ...(node.addr !== undefined
            ? { title: `0x${node.addr.toString(16).toUpperCase()}` }
            : {}),
        });
        continue;
      }

      push(word, roleOf(word));
      continue;
    }

    const num = NUMBER.exec(rest);
    if (num) { push(num[0], "number"); continue; }

    const opRun = OP_RUN.exec(rest);
    push(opRun ? opRun[0] : rest[0], "op");
  }

  return out;
}

/** Is this line only a decompiler aside? */
const COMMENT = /^\s*\/\*.*\*\/\s*$/;

/**
 * Read one function's decompiled C into rows the listing can draw.
 *
 * One source line is one row, so the listing's virtualisation keeps working
 * unchanged: it is arithmetic over a fixed row height, and a wrapped line
 * would have to be measured before it could be skipped.
 */
export function sourceLines(g: Indexed, bank: string, text: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let lastIndent = 0;
  for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
    const body = raw.replace(/\s+$/, "");
    const indent = body.length - body.replace(/^\s+/, "").length;
    const trimmed = body.slice(indent);
    if (!trimmed) {
      lines.push({ indent: 0, tokens: [], comment: false });
      continue;
    }
    const comment = COMMENT.test(body);
    // Ghidra parks its warnings in a fixed comment column, twenty spaces in,
    // however deep the code around them sits. Left alone they read as the most
    // deeply nested thing on screen; given the indent of the code they
    // annotate, they read as annotations.
    const at = comment ? lastIndent : indent;
    if (!comment) lastIndent = indent;
    lines.push({
      indent: at,
      tokens: comment
        ? [{ text: trimmed, role: "plumbing", cell: 0, cells: cells(trimmed) }]
        : tokenizeC(g, bank, trimmed),
      comment,
    });
  }
  // A trailing blank row is the file's final newline, not a line of the
  // function; drawing it leaves an unexplained gap under the closing brace.
  while (lines.length && !lines[lines.length - 1].tokens.length) lines.pop();
  // The same at the top: every file in the corpus opens with one.
  while (lines.length && !lines[0].tokens.length) lines.shift();
  return lines;
}
