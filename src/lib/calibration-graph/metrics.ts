/**
 * Text measurement for the block diagram.
 *
 * The layout has to measure the same text the renderer draws, or boxes are
 * sized for one string and painted with another — the failure `clipExpression`
 * and `cellBudget` were each written to fix, twice, in the same file. Splitting
 * measurement out into its own module is what makes "measure what you draw" a
 * property of the code rather than a habit: the layout engine, the tokenizer
 * and the verify script all import these and there is nowhere else to get them.
 */

/** ui-monospace at 11.5px, the size the formulas are drawn at. */
export const CHAR_W = 6.9;

/**
 * Width in monospace cells, not in code points.
 *
 * The glosses and state-bit readings are Japanese, and kana and kanji occupy
 * two cells each. Measuring them as one made every box with a translated line
 * in it about half the width its text needed, so the text ran out through the
 * border.
 */
export function cells(text: string): number {
  let n = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    const wide =
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe6f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6);
    n += wide ? 2 : 1;
  }
  return n;
}

/** Cut `text` to at most `limit` cells, marking the cut. */
export function clipCells(text: string, limit: number): string {
  if (cells(text) <= limit) return text;
  let n = 0;
  let out = "";
  for (const ch of text) {
    const w = cells(ch);
    if (n + w > limit - 1) break;
    out += ch;
    n += w;
  }
  return out + "…";
}

export function textWidth(text: string, charW = CHAR_W): number {
  return cells(text) * charW;
}
