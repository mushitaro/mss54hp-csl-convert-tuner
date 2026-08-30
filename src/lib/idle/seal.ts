/**
 * The idle write is SEALED. Nothing derived here reaches a byte.
 *
 * ## Why — the write target has no consumer in this calibration
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
 * ## The second reason, which bites even if the first is overturned
 *
 * `IDLE_QVS_WRITE_BOUNDS.max` is 40.0 kg/h and `setEcuMapValues` applies it to ALL 30 cells, not
 * only the ones the tuner moved. Sixteen of the thirty stock cells are above 40.0 — the cold rows
 * run to 80.0 kg/h at -40 degC — so arming any proposal would quietly rewrite the cold-start and
 * high-rpm cells down to 40.0. Neither verify script catches it: they check the tuner's proposal
 * rather than the resulting bytes.
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
 * ## What un-seals it
 *
 * The investigation in the plan, and specifically: the disassembly of the slave DPR readers
 * (`MD_LLRI` leaves the master only into `0xFF8172`, which has no resolved reader in either bank),
 * plus one on-car test — write a large delta into one warm cell and log LLS duty and rpm. Set this
 * to false only when a named parameter has been derived from the logic and shown to reach the
 * engine, and change the comment above to say which.
 */
export const IDLE_WRITE_SEALED = true;

/**
 * The calibration symbols this seal covers, derived FROM the flag so a future un-seal releases
 * every consumer in one flip. The CALIBRATION tab reads this to lock direct edits of the same
 * bytes — a copy of the name over there would outlive the seal it copies.
 */
export const SEALED_CAL_SYMBOLS: ReadonlySet<string> =
    IDLE_WRITE_SEALED ? new Set(['KF_LLR_QVS_GRUND']) : new Set();
