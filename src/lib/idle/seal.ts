/**
 * WHICH IDLE BYTES MAY BE WRITTEN.
 *
 * The full derivation — the formula, the parameter, the data, the distribution — is
 * docs/ecu-logic/70-idle-write.md. This file is the enforcement and the history.
 *
 * `KF_LLS_TV` is OPEN as of 2026-09-03. `KF_LLR_QVS_GRUND` is sealed permanently, and the argument
 * for that has not weakened; it is below, unchanged, because it is the reason the target moved.
 *
 * ## Why KF_LLR_QVS_GRUND stays sealed — it has no consumer in this calibration
 *
 * `lls_tv_calc` (master `0x025D0A`) has exactly two call sites, and they are mutually exclusive on
 * one config byte, `cfg_m.egas` (XDF `0x8012`, master, file `0x08012`):
 *
 *     llr_qsoll_calc  0x02592C:  tst.b $88012 / beq  -> byte == 0 SKIPS the call
 *     egas_...target  0x027280:  tst.b $88012 / bne  -> byte == 0 MAKES the call, arg ML_SOLL_LLS
 *
 * That byte reads 0x00 in this lineage (read directly out of
 * `public/mock/csl-0401-community-patch-v1.partial.bin`; the XDF's own TXTEQ gives
 * `0 = Momentenmanager, 1 = Bowdenzug`). So the live caller is the TORQUE path, and `KF_LLS_TV` is
 * indexed on `ML_SOLL_LLS` (`0xFFD900`) — not on `LLR_QSOLL`.
 *
 * Corroboration, independent of the guard: `LLR_QSOLL` (`0xFFEF1A`) has exactly ONE absolute
 * reference in the whole 1 MB image, and it is its own write site inside `llr_qsoll_calc`.
 *
 * Which makes the chain this feature was built on —
 *
 *     KF_LLR_QVS_GRUND -> LLR_QVS_ROH -> LLR_QVS -> LLR_QSOLL
 *
 * — live code that computes a value nothing reads. Writing the map changes nothing in the car, and
 * a tool that reported a converging correction while writing a dead map would be the most
 * expensive kind of wrong: confident, plausible, and unfalsifiable from the driver's seat.
 *
 * The model gate this feature documented as its defence would NOT have caught it. That gate
 * compares RAM `LLR_QVS` against the map interpolated from the binary — it proves `LLR_QVS` is
 * computed from the map, and says nothing about whether anything downstream reads the result.
 * (It was never implemented either; see the audit.)
 *
 * ## The second reason, which bit the OLD target and does not bite the new one
 *
 * `setEcuMapValues` writes every cell of a table and applies the caller's bounds to all of them,
 * not only to the ones the tuner moved. Against `KF_LLR_QVS_GRUND` that was fatal: the bound was
 * 40.0 kg/h and sixteen of the thirty stock cells are above it — the cold rows run to 80.0 kg/h at
 * -40 degC — so arming any proposal would quietly have rewritten the cold-start and high-rpm cells
 * down to 40.0.
 *
 * The same question, asked of `KF_LLS_TV` and MEASURED rather than argued (`npm run inspect:lls-tv`,
 * and `verify:idle` now asserts it so it cannot rot):
 *
 *     K_LLS_TV_MIN / MAX        14 / 97 %
 *     cells                     130
 *     min / max cell            14 / 97 %
 *     cells outside the rails   0
 *
 * Every stock cell is inside the rails the DME itself applies, so a whole-table write leaves the
 * untouched cells byte-identical. This objection does not transfer to the new target.
 *
 * ## What is NOT sealed
 *
 * Measurement, the census, the trace, the session store and the export. `MD_LLRI` is still a real
 * signal and a real reading of the governor; what is in question is what it MEANS and what, if
 * anything, can be written from it. Recording it costs nothing and the investigation needs the data.
 *
 * ## WHERE THE CORRECTION WENT INSTEAD (2026-08-29)
 *
 * The seal stands, and the feature is no longer stuck behind it. `lls_tv_calc`'s recovered body
 * names the live map directly:
 *
 *     _ML_SOLL_DPR ─┬─ min(., ML_SOLL_MAX_LLS) ─→ ML_SOLL_LLS ─┐
 *                   │                                          ├→ KF_LLS_TV(n, ml_ll) → LLS_TV → valve
 *                   └─ max(0, . - ML_SOLL_MAX_LLS) ─→ ML_SOLL_WDK ─→ throttle plate
 *
 * `KF_LLS_TV` (XDF `0x9DE2`, values `0x9E10`, master; x = rpm, y = `ml_ll` kg/h, z = duty %) is
 * `code-confirmed` — `lls_tv_calc` is its only consumer and it reads it in a recovered statement.
 * The air the valve is asked for is the torque path's own demand split at a ceiling, which is
 * precisely why a dedicated idle-air map has no reader: there is no dedicated idle air request.
 *
 * So the correction moves to `KF_LLS_TV`, and the estimator's measurement does not change — the
 * governor's standing effort is the same fact whichever map is wrong. What changes is the axes it
 * bins on (rpm x `ML_SOLL_LLS`, not rpm x TMOT) and the unit it writes (duty %, not kg/h). The
 * gain needs no new constant: the map's own slope along y is 2.25 %/(kg/h) at the idle cell, so
 * `slope * g_air` is about 0.90 %/Nm. See `valveModel.ts` and `verify:valve-model`.
 *
 * This seal keeps `KF_LLR_QVS_GRUND` sealed exactly as before. Nothing above weakens the argument
 * for it; it only stops that argument from being the end of the feature.
 *
 * ## What un-sealed the new target (2026-09-03)
 *
 * The bar this file set was: "a named parameter derived from the logic and shown to reach the
 * engine". Against `KF_LLS_TV`:
 *
 *   - DERIVED FROM THE LOGIC. `lls_tv_calc` is its only consumer and reads it in a recovered
 *     statement — `code-confirmed`, not an xref and not an inference.
 *   - REACHES THE ENGINE. Its output IS `LLS_TV`, the valve duty. And the claim is not left as an
 *     argument: every run compares RAM `LLS_TV` against this map interpolated at the operating
 *     point, and a dwell whose duty the map cannot explain is refused `model-disagrees`. That gate
 *     is the one the OLD design could not have — it compared `LLR_QVS` against a map whose output
 *     nothing read, and would have passed while proving nothing.
 *   - WHOLE-TABLE WRITE IS BYTE-NEUTRAL. Measured, above.
 *
 * What is still NOT established, and why that is survivable: the on-car delta test. The model gate
 * shows the map explains the duty the DME ran; it does not by itself show that changing the map
 * changes the car. So the first campaign is damped — `stepFraction` 0.5 and `maxStepPct` 3.0 %, so
 * one pass moves duty by at most 3 %, about 1.3 kg/h of idle air — which is large enough for the
 * next run's model gate to see the difference and small enough not to stall the engine. That test
 * is now something the tool performs rather than something that blocks it.
 */
export const IDLE_WRITE_SEALED = false;

/**
 * The calibration symbols that may never be written, whatever the flag above says.
 *
 * NOT derived from `IDLE_WRITE_SEALED` any more, and that is the whole change. It used to be, on
 * the assumption that the seal and the dead map would be released together — but they are two
 * different facts. `IDLE_WRITE_SEALED` was about whether this FEATURE had earned a write;
 * `KF_LLR_QVS_GRUND` is unwritable because nothing in the car reads it, which no amount of evidence
 * about `KF_LLS_TV` can change. Tying them together would have opened the dead map the moment the
 * live one was proven, and a tuner who then edited it by hand would learn, from a real flash and a
 * real drive, that idle air "does nothing".
 *
 * The CALIBRATION tab reads this to lock direct edits of the same bytes — a copy of the name over
 * there would outlive the seal it copies.
 */
export const SEALED_CAL_SYMBOLS: ReadonlySet<string> = new Set(['KF_LLR_QVS_GRUND']);
