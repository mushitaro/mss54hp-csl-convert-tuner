/**
 * The high-load settle clock, as ONE implementation used by the filter and by the live readout.
 *
 * The filter drops a high-load sample until the pull has been held for `highLoadSettleSec`, because
 * entering the region makes the DME's `rf_korr` step off a lagging TABG while the lambda trim walks
 * after it — until it lands, `trim x rf_korr` reads high. Two same-day drives disagreed by 5.2 % at
 * high load because one was short stabs and the other held a 29.8 s pull; requiring the wait closed
 * it to 1.1 %.
 *
 * That rule used to live only inside `processLogData`, where the driver cannot see it. The cost was
 * measured on session #924: a 40-minute drive that put ZERO samples into the 45-100 % / 1400-2200
 * band it was driven to fill, because there is no way from behind the wheel to tell a pull that
 * counts from one that is thrown away. A gate the operator cannot see is a gate they cannot satisfy.
 *
 * So it is extracted rather than copied. A second implementation for the dashboard would agree with
 * the filter until the day it did not, and the day it did not is the day someone drives for an hour
 * on a readout that was lying. `verify:settle` pins the filter's behaviour across the extraction and
 * `verify:high-load-clock` pins the state machine itself.
 */

/**
 * The filling floor the DME's own correction is gated on.
 *
 * 55 is the lowest node of `kl_rf_korr_rf_min` — below it the EGT correction cannot be active at
 * all, so there is no step to wait out.
 */
export const HIGH_LOAD_SETTLE_RF_MIN = 55;

/**
 * A filling rise this large restarts the clock: it is a NEW excursion, not a continuing one.
 *
 * Cruise at 60-70 % and then floor it, and `rf_korr` steps exactly as hard as it does at entry
 * while a clock timed from the 55 % crossing has long since expired. A pull's own climb (about
 * 1.7 %RF/s) never trips this.
 */
export const HIGH_LOAD_RESTEP_RF = 15;

/** How often the restep reference is rotated, seconds. */
export const HIGH_LOAD_REF_PERIOD_S = 1.5;

/**
 * Everything the clock needs to survive a gap in the samples.
 *
 * Carried in `FilterResume` for the same reason it is carried here: a live flush landing mid-pull
 * must not restart the clock, or early-pull samples a batch pass would have dropped survive, and
 * `verify:settle` holds the two paths to byte-identical output across exactly that boundary.
 */
export interface HighLoadClock {
    /** When the filling last rose above the floor, in the log's own time units. Null while below. */
    enteredAt: number | null;
    /** Where the filling stood up to ~2x HIGH_LOAD_REF_PERIOD_S ago, so a flush landing mid-stab
     *  cannot forget the level the stab rose from. Null below the floor. */
    refTime: number | null;
    refRf: number | null;
}

export const EMPTY_HIGH_LOAD_CLOCK: HighLoadClock = { enteredAt: null, refTime: null, refRf: null };

/**
 * Advance the clock by one sample. Pure — the caller holds the state.
 *
 * `rf` undefined is treated as below the floor: a sample with no filling reading cannot prove the
 * region is still entered, and the safe direction is to make re-entry a fresh excursion.
 */
export function stepHighLoadClock(
    clock: HighLoadClock,
    rf: number | undefined,
    time: number,
    secondsPerTimeUnit: number,
): HighLoadClock {
    if (rf === undefined || rf < HIGH_LOAD_SETTLE_RF_MIN) {
        // Any dip below the floor resets it. Strict on purpose: a dip means the gate shut and
        // rf_korr snapped back to 1.000, so re-entry is a fresh step and a fresh excursion. The
        // cost is samples; the alternative is keeping evidence mid-transient.
        return EMPTY_HIGH_LOAD_CLOCK;
    }
    if (clock.enteredAt === null) {
        return { enteredAt: time, refTime: time, refRf: rf };
    }
    if (clock.refTime !== null && clock.refRf !== null) {
        if (rf - clock.refRf >= HIGH_LOAD_RESTEP_RF) {
            // A fresh excursion inside the region — the clock restarts with it.
            return { enteredAt: time, refTime: time, refRf: rf };
        }
        if ((time - clock.refTime) * secondsPerTimeUnit >= HIGH_LOAD_REF_PERIOD_S) {
            return { ...clock, refTime: time, refRf: rf };
        }
    }
    return clock;
}

/**
 * How long the pull has been held, in seconds, or null while below the floor.
 *
 * This is the number the driver needs, and it is read off the same state the filter drops samples
 * from — so "counting" on the dashboard and "kept" in the derivation cannot disagree.
 */
export function heldSeconds(
    clock: HighLoadClock,
    time: number,
    secondsPerTimeUnit: number,
): number | null {
    if (clock.enteredAt === null) return null;
    return (time - clock.enteredAt) * secondsPerTimeUnit;
}
