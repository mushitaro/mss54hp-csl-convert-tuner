/**
 * How the three views show what is lit — in one place, because they had three.
 *
 * NETWORK, FUNCTION and CODE each carried their own copy of this rule and the
 * copies had drifted to 0.85, 0.25 and 0.3: the same picture, the same
 * selection, three different answers to "how far does the rest recede". Two of
 * them were unreadable, and only the one that had been complained about got
 * fixed. This is the `guard-tree` lesson again — a rule that lives in three
 * files is a rule that will disagree with itself — so it lives here and the
 * views import it.
 *
 * ## Why the numbers are what they are
 *
 * Emphasis is by ADDITION, not subtraction. Turning the rest of the page down
 * far enough to make one thing stand out also turns off the thing the view is
 * for: these pictures exist to show how a selection RELATES to what is around
 * it, and a relation needs both ends legible.
 *
 * So the unlit state is set by contrast, measured over the true-black ground
 * this instrument uses. The text that matters is not the brightest — most of a
 * formula is `slate-400` symbols:
 *
 *              slate-300      slate-400      slate-600
 *     0.25      1.6:1          1.3:1          1.1:1    (gone)
 *     0.30      1.9:1          1.5:1          1.2:1    (gone)
 *     0.60      4.7:1          3.1:1          1.5:1    (symbols still under)
 *     0.85      8.8:1          5.5:1          2.1:1
 *
 * 4.5:1 is what text read as prose needs, so 0.85 — everything a reader reads
 * clears it, and only `plumbing`, which is meant to recede and is folded away
 * by default, stays faint.
 */
export const UNLIT = 0.85;

/** Opacity for something that may or may not be on the lit path. */
export function dim(picked: string | null, name?: string): number {
  if (!picked) return 1;
  return name === picked ? 1 : UNLIT;
}

/** Is this the thing the reader has lit? */
export function isLit(picked: string | null, name?: string): boolean {
  return Boolean(picked) && name === picked;
}

/**
 * The accent, for the one path that is lit.
 *
 * With the unlit state this close to full, the lit state has to carry the
 * difference by itself — hue, weight and a rule, none of which the surrounding
 * text is using. `#26AEE4` is the instrument's one accent; `globals.css` keeps
 * it for "this is the thing".
 */
export const LIT_STROKE = 'stroke-[#26AEE4]';
export const LIT_TEXT = 'fill-[#26AEE4]';
/** Bold and underlined, for a symbol drawn inside a run of other symbols. */
export const LIT_MARK = ' font-bold underline';
/** A lit wire is drawn heavier than the ones around it. */
export const LIT_WIDTH = 1.6;
