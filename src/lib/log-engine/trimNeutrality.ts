/**
 * Is the short-term trim the WHOLE standing error, or only the part two long-term stores left over?
 *
 * Every correction this app derives is `New = Old x STFT x ...`, and that identity assumes STFT
 * carries the entire fuel-path error. The DME has two long-term stores that break the assumption by
 * absorbing exactly that error, and only one of them can be read on this ECU:
 *
 *   `laa_f`       MULTIPLICATIVE, 1/32768, learned in driven part load (ML > 40 kg/h, rf > 0.20).
 *                 Readable — it is `ltft1`/`ltft2` on the log, four bytes of the same telegram the
 *                 short-term pair arrives in. Folded into the low-opening correction directly.
 *   `LAA_OFFSET`  ADDITIVE, applied as `TI_OFFSET_ADAPT = LAA_OFFSET x 1200 / N` us of injection
 *                 time, learned at a STATIONARY idle (ML < 30 kg/h, N < 1200, V < 5 km/h) and
 *                 clamped to +/-0.5 ms — up to ~20 % of a 2.5 ms idle pulse. NOT readable: it lives
 *                 in slave RAM, which this image does not serve over DS2, and the master's
 *                 0xFFD922 region belongs to the rev limiter (session #923 read a bit-constant
 *                 -30720 there before the channel was withdrawn).
 *
 * So the unreadable store is the one an idle learns into, and an idle is where the map is hardest
 * to see. This module is how the app answers for it anyway.
 *
 * ## The inference
 *
 * Two facts out of the disassembly, both about `laa_st_calc` (slave 0x019B90), which is the ONE
 * function that enables either learner:
 *
 *   1. **The temperature window gates BOTH.** `K_LAA_TMOT_MIN < TMOT < K_LAA_TMOT_MAX` fails ->
 *      0x019DA0 clears LAA_ST bits 1 and 2, and the factor learner (0x019E26) and the offset
 *      learner (0x019F80) each test bit 1 (bank 1) or bit 2 (bank 2) before doing anything. This
 *      app's PATCH writes `K_LAA_TMOT_MIN = 100 degC` against a MAX of 100 degC, so the window is
 *      EMPTY and neither store can move at all.
 *   2. **They are reset and persisted together.** The sensor-fault reset at 0x019C3C clears
 *      LAA_OFFSET1/2 and writes 0x8000 to LAA_F1/2 in one branch, and the EEPROM routine at
 *      0x02EB00 saves LAA_OFFSET1, LAA_OFFSET2, LAA_F1, LAA_F2 through one call each into one
 *      block with one status accumulator. Nothing clears one without the other.
 *
 * Therefore: `laa_f` at a BIT-EXACT 1.000, with the learners frozen, says the stores are where a
 * clear left them — and the additive store is 0.
 *
 * **Bit-exact, not a tolerance.** The channel is `uint16 x 2^-15`, so 1.000 is the single code
 * 0x8000, and the factor learner integrates `(la_f_regler - 1) / 202` on EVERY cycle inside its
 * zone. Any driving at all with learning enabled moves it off that code. A tolerance would read a
 * store that has learned 0.3 % as untouched, which is the one reading this must never give.
 *
 * ## What it does not prove
 *
 * A car that has only ever idled could hold a learned offset beside an untouched factor — the two
 * zones are disjoint, so nothing in the arithmetic forbids it. The inference rests on the stores
 * being cleared together and the factor being the one that ordinary driving moves. On a car with
 * any part-load history, a factor at init means neither learner has run. That is the claim, and it
 * is why the verdict is reported rather than assumed.
 */

import type { LogDataPoint } from '@/lib/types';

/**
 * `K_LAA_TMOT_MIN` / `K_LAA_TMOT_MAX` out of the binary the log was recorded against, in degC.
 *
 * Read from the bytes rather than from the PATCH toggle, for the reason `readLambdaLimits` states
 * about the WOT table: the toggle says what the app would write, and the log was recorded against
 * whatever was actually in the ECU. A session reopened against a different binary would otherwise
 * report the wrong verdict with full confidence.
 */
export interface LtftLearnWindow {
    tmotMin: number;
    tmotMax: number;
}

/** Empty window = neither learner can ever run. `>=` because the DME's own test is exclusive on
 *  both ends (`bls` on MIN, `bcc` on MAX both jump to the clear). */
export function learnersFrozen(w: LtftLearnWindow): boolean {
    return w.tmotMin >= w.tmotMax;
}

export type TrimNeutralityVerdict =
    /** Factor at init AND the learners frozen: STFT is the whole standing error. */
    | 'neutral'
    /** The factor has moved. The unreadable additive store may hold anything up to its clamp. */
    | 'learned'
    /** No `ltft` on this log — the trim came from block 19, so there is nothing to check. */
    | 'unknown';

export interface TrimNeutrality {
    verdict: TrimNeutralityVerdict;
    /** Samples carrying at least one bank of `ltft`. */
    samples: number;
    /** Of those, how many were bit-exact 1.000 on every bank present. */
    atInit: number;
    /** The `laa_f` reading furthest from 1.000 anywhere in the run — what the copy names. */
    worst: number;
    /** Whether the binary's own temperature window is empty. Null when no binary was loaded, which
     *  is not the same as "the window is open" and must not be reported as it. */
    frozen: boolean | null;
}

/** 1.000 is one code, 0x8000, and `scale` is exactly 2^-15 — so this comparison is exact in binary
 *  floating point rather than approximately exact. */
const AT_INIT = 1;

/**
 * The run-level verdict. Reads the RAW log, not the filtered one: the stores are a property of the
 * ECU during the run, and a sample dropped for being transient still reports them truthfully.
 */
export function trimNeutrality(
    points: readonly LogDataPoint[],
    window: LtftLearnWindow | null,
): TrimNeutrality {
    const frozen = window ? learnersFrozen(window) : null;

    let samples = 0;
    let atInit = 0;
    let worst = AT_INIT;

    for (const p of points) {
        const banks = [p.ltft1, p.ltft2].filter((v): v is number => v !== undefined);
        if (!banks.length) continue;
        samples++;
        if (banks.every(v => v === AT_INIT)) atInit++;
        for (const v of banks) {
            if (Math.abs(v - AT_INIT) > Math.abs(worst - AT_INIT)) worst = v;
        }
    }

    // No channel, no claim. This is the block-19 fallback's log, not an old file: the RAM route can
    // be refused by the car on any run, and when it is, the app records the short-term pair alone.
    if (!samples) return { verdict: 'unknown', samples: 0, atInit: 0, worst: AT_INIT, frozen };

    // EVERY sample, not most. A store that moved mid-run moved because a learner was running, which
    // is the same finding as a store that was already off init — and it also falsifies `frozen`.
    const verdict: TrimNeutralityVerdict = atInit === samples && frozen === true
        ? 'neutral' : atInit === samples ? 'unknown' : 'learned';

    return { verdict, samples, atInit, worst, frozen };
}

/*
 * WHAT THE READER SHOULD DO ABOUT IT lives in `src/lib/manifest-text.ts`, not here.
 *
 * `trimNeutralityRemedy` used to be exported from this module, in English only. When the manifest's
 * copy became bilingual it needed the same four sentences, and two tables of the same sentences is
 * how a screen and its explanation come to disagree — the mistake `cellCoverage.COVERAGE_LABEL`
 * already exists to stop being repeated. One copy table, keyed on the verdict this module returns.
 *
 * The DECISION stays here: `verdict` is the finding, and it is what both the lock and the copy are
 * selected by. Only the wording moved.
 */
