/**
 * How much a cell's per-sample corrections may scatter before the cell is refused.
 *
 * These are properties of `la_f_regler` ON THIS CAR, not of any region of the table: how wide the
 * controller's limit cycle is — so how much scatter one well-behaved condition produces — and how
 * finely `kf_rf_soll` can express an answer. One trim, read through one table, so one pair of
 * numbers.
 *
 * They lived in a second derivation that owned the low-opening rows under its own evidence bars,
 * with a comment saying they were exported "because the VE path needs the SAME ones". That second
 * derivation is gone and the whole table is derived one way; the constants keep the argument that
 * was already in that comment and lose the address that contradicted it.
 */

/**
 * Standard deviation of the per-sample corrections inside one cell.
 *
 * 0.08 because `la_f_regler` is a two-point controller: the P term steps at every sensor crossing,
 * so a cell sitting at one perfectly steady condition still produces a spread of that order. A
 * tighter bound refuses cells for being normal; a looser one stops separating "one condition" from
 * "two conditions averaged together".
 */
export const MAX_SAMPLE_SD = 0.08;

/**
 * Standard error of the cell's mean — the scatter divided by the root of the independent count.
 *
 * 0.005 is half a table step at the openings where `kf_rf_soll` is coarsest, so a cell that clears
 * it can express its own answer in the bytes. Below that the write is quantisation noise wearing a
 * measurement's clothes.
 */
export const MAX_STD_ERR = 0.005;
