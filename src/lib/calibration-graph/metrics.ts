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

/**
 * Clip to `limit`, but never cut away `keep`.
 *
 * A formula is clipped from the right, which is fine until the thing the
 * reader selected is what falls off the end. Selecting `KL_V_MAX_GANG` and
 * opening `md_limiter_calc` drew the row that uses it as
 *
 *     MD_IND_VMAX = MD_IND_VMAX + (((K_MD_I_VMAX × ({…
 *
 * — the one row on the picture that was about the selection, ending one
 * character before the name. The row was there and said nothing.
 *
 * When the plain clip would lose it, the window slides instead: an ellipsis,
 * the stretch containing `keep` with a little context after it, and another
 * ellipsis if there is more. The row keeps its place in source order — only
 * which part of it is shown changes.
 */
export function clipAround(text: string, limit: number, keep?: string): string {
  if (cells(text) <= limit) return text;
  const plain = clipCells(text, limit);
  if (!keep) return plain;
  const at = text.toLowerCase().indexOf(keep.toLowerCase());
  if (at < 0 || plain.toLowerCase().includes(keep.toLowerCase())) return plain;

  const chars = [...text];
  // Character index, not code-unit index: `cells` and the renderer both count
  // characters, and a surrogate pair would put the window half a glyph out.
  let start = 0;
  for (let i = 0, n = 0; i < chars.length; i += 1) {
    if (n >= at) { start = i; break; }
    n += chars[i].length;
  }
  const keepLen = [...keep].length;
  /** A little of what follows, so the name is not left hanging at the edge. */
  const TRAIL = 12;
  let end = Math.min(chars.length, start + keepLen + TRAIL);

  // Two ellipses to pay for, one at each end; the trailing one only if the
  // window really stops short of the end.
  const budget = limit - (end < chars.length ? 2 : 1);
  let width = 0;
  let from = end;
  while (from > 0) {
    const w = cells(chars[from - 1]);
    if (width + w > budget) break;
    width += w;
    from -= 1;
  }
  // The name itself must survive even when it alone exceeds the budget: cut
  // the trailing context back rather than the name.
  if (from > start) {
    from = start;
    width = 0;
    end = start;
    while (end < chars.length) {
      const w = cells(chars[end]);
      if (width + w > budget) break;
      width += w;
      end += 1;
    }
  }
  return (from > 0 ? "…" : "") + chars.slice(from, end).join("") + (end < chars.length ? "…" : "");
}

export function textWidth(text: string, charW = CHAR_W): number {
  return cells(text) * charW;
}
