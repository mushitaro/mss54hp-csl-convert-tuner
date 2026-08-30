import type { Lang } from "./calib-i18n";

/**
 * Reading a symbol name out of the factory's German vocabulary.
 *
 * The diagram's ports are RAM signals, and not one of the 2,560 RAM symbols in
 * the graph carries a description — the XDF documents calibration, not the
 * signals that run between blocks. So a port label is, on the data alone,
 * unreadable: `RF_SOLL` tells a reader nothing they did not already know.
 *
 * The glossary does know what `RF` is. It was only ever consulted for engine
 * state bit masks, so that knowledge never reached a label. This reads a name
 * as the composition it actually is — one base term plus German qualifiers —
 * and hands the result back as its own tier, marked as derived from the
 * glossary rather than measured from the binary or quoted from the factory.
 *
 * It is inference and it is labelled as inference. The rule that keeps it
 * honest is the one `stateBitGloss` already uses: unless every token in the
 * name is accounted for, no reading is composed at all. Half a reading is
 * worse than none, because the half that is missing does not show up as
 * missing — it reads as the whole answer.
 */

export type TermRole = "kind" | "base" | "qualifier" | "operation";

export interface MnemonicTerm {
  /** The token as it appears in the name, upper-cased. */
  token: string;
  /** The factory's own word, kept so the reading can always be checked. */
  de: string;
  /** What it is being read as, in the reader's language. */
  reading: string;
  role: TermRole;
}

export interface MnemonicReading {
  terms: MnemonicTerm[];
  /** Tokens with no entry anywhere. Their presence blocks `reading`. */
  unknown: string[];
  /** The composed one-line reading, only when nothing was left unexplained. */
  reading?: string;
}

/** Prefixes that say how a symbol is stored rather than what it means. */
const KIND_PREFIX = new Set(["KF", "KL", "K", "B"]);

interface Term {
  de: string;
  ja: string;
  en: string;
}

/**
 * German qualifiers that modify a base term.
 *
 * Hand-checked against the symbols they actually appear on in this binary, and
 * deliberately short. A qualifier guessed from the German dictionary rather
 * than read off the firmware would compose just as fluently and be just as
 * wrong, and the reader has no way to tell those two apart.
 */
const QUALIFIERS: Record<string, Term> = {
  SOLL: { de: "Sollwert", ja: "目標", en: "target" },
  IST: { de: "Istwert", ja: "実測", en: "actual" },
  KORR: { de: "Korrektur", ja: "補正", en: "corrected" },
  ROH: { de: "Rohwert", ja: "生", en: "raw" },
  GRUND: { de: "Grundwert", ja: "基本", en: "base" },
  ERSATZ: { de: "Ersatzwert", ja: "代替", en: "substitute" },
  MIN: { de: "Minimum", ja: "最小", en: "minimum" },
  MAX: { de: "Maximum", ja: "最大", en: "maximum" },
  FILTER: { de: "gefiltert", ja: "フィルタ後", en: "filtered" },
  DYN: { de: "dynamisch", ja: "過渡", en: "dynamic" },
  DELTA: { de: "Differenz", ja: "差分", en: "delta" },
  NORM: { de: "normiert", ja: "正規化", en: "normalised" },
  FAKT: { de: "Faktor", ja: "係数", en: "factor" },
  FAKTOR: { de: "Faktor", ja: "係数", en: "factor" },
  TAU: { de: "Zeitkonstante", ja: "時定数", en: "time constant" },
  ST: { de: "Status", ja: "状態", en: "status" },
};

/**
 * Suffixes this project's own namers put on Ghidra functions.
 *
 * Not factory vocabulary — these come from the humans who named the 644
 * functions in the archive — so they read as what the code does rather than
 * as a German term, and they are the only tokens allowed to land last.
 */
const OPERATIONS: Record<string, Term> = {
  CALC: { de: "", ja: "の計算", en: "computation of" },
  INIT: { de: "", ja: "の初期化", en: "initialisation of" },
  DIAG: { de: "Diagnose", ja: "の診断", en: "diagnosis of" },
  LOOKUP: { de: "", ja: "の引き当て", en: "lookup of" },
};

/** `relative Füllung — 相対充填量（負荷）` splits at the em dash. */
function splitEntry(entry: string): { de: string; reading: string } {
  const i = entry.indexOf("—");
  if (i < 0) {
    const t = entry.trim();
    return { de: t, reading: t };
  }
  return { de: entry.slice(0, i).trim(), reading: entry.slice(i + 1).trim() };
}

/**
 * The combining form of a reading.
 *
 * A glossary entry is written to stand alone, so it carries a parenthetical
 * that turns into noise mid-phrase: `相対充填量（負荷）` is right on its own and
 * wrong inside `目標相対充填量（負荷）`.
 */
function combining(reading: string): string {
  return reading.replace(/[（(][^）)]*[）)]/g, "").trim() || reading;
}

function compose(
  base: MnemonicTerm,
  quals: MnemonicTerm[],
  operation: MnemonicTerm | undefined,
  lang: Lang,
): string {
  // The qualifier written last is the outermost one: `rf_soll_korr` is a
  // correction applied to a target, not a target applied to a correction.
  const outward = [...quals].reverse();
  const stem = combining(base.reading);
  if (lang === "ja") {
    const phrase = outward.map((q) => q.reading).join("") + stem;
    return operation ? `${phrase}${operation.reading}` : phrase;
  }
  const phrase = [...outward.map((q) => q.reading), stem].join(" ");
  return operation ? `${operation.reading} ${phrase}` : phrase;
}

/**
 * Read a symbol name against the glossary.
 *
 * Returns nothing when not a single token is recognised — an empty tier is
 * worse than no tier, because it implies the name was looked at and found
 * meaningless rather than simply absent from a 52-entry vocabulary.
 */
export function readMnemonic(
  name: string,
  glossary: Record<string, string>,
  lang: Lang,
): MnemonicReading | undefined {
  // Array indices and struct members belong to the expression, not the name.
  const bare = name.replace(/[[.\->\s].*$/, "");
  const tokens = bare.split("_").filter(Boolean).map((s) => s.toUpperCase());
  if (!tokens.length) return undefined;

  const terms: MnemonicTerm[] = [];
  const unknown: string[] = [];
  const bases: MnemonicTerm[] = [];
  const quals: MnemonicTerm[] = [];
  let operation: MnemonicTerm | undefined;

  tokens.forEach((token, i) => {
    // The shipped glossary wins over the tables here: it is the curated data
    // the pipeline emits, and a token in both should read the documented way.
    const entry = glossary[token] ?? glossary[`${token}_`];
    if (entry) {
      const { de, reading } = splitEntry(entry);
      const role: TermRole = i === 0 && KIND_PREFIX.has(token) ? "kind" : "base";
      const term = { token, de, reading, role };
      terms.push(term);
      if (role === "base") bases.push(term);
      return;
    }
    const q = QUALIFIERS[token];
    if (q) {
      const term: MnemonicTerm = { token, de: q.de, reading: q[lang], role: "qualifier" };
      terms.push(term);
      quals.push(term);
      return;
    }
    const op = OPERATIONS[token];
    if (op && i === tokens.length - 1) {
      const term: MnemonicTerm = { token, de: op.de, reading: op[lang], role: "operation" };
      terms.push(term);
      operation = term;
      return;
    }
    unknown.push(token);
  });

  if (!terms.length) return undefined;
  // Two base terms is a name this reading cannot parse — `RF_TI_CONST` joins
  // two quantities, and picking one to head the phrase would invent a
  // relationship between them that the name does not state.
  const reading =
    !unknown.length && bases.length === 1
      ? compose(bases[0], quals, operation, lang)
      : undefined;
  return { terms, unknown, reading };
}
