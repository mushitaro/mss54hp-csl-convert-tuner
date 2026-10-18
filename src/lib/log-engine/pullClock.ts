/**
 * The PULL clock — how long the driver has held the pedal still, as one pure state machine.
 *
 * The live drive strip shows it (operator, 2026-10-18: "only how many seconds the pull was held is
 * needed"). It is stepped once per sample in `useLiveRun`, not in the component that draws it, for
 * the reason the old settle clock was: a subscriber renders on coalesced snapshots and can skip the
 * one sample where the pedal left the band, and a clock that never saw it would keep counting a
 * hold that had already ended.
 *
 * ## The rule
 *
 *     start     wdk1 >= PULL_MIN_WDK, with no hold running             (t0, w0) = (time, wdk1)
 *     continue  |wdk1 − w0| <= PULL_WDK_BAND  and  wdk1 >= PULL_MIN_WDK
 *     end       anything else — the pedal moved out of the band, or lifted under the minimum;
 *               a new hold starts on the same sample if wdk1 is still >= PULL_MIN_WDK
 *     held      = time of the last sample inside the band − t0
 *
 * `wdk1` is throttle plate 1, %, DS2 selection 3 (`LogDataPoint.wdk1`). Time is SECONDS: both live
 * links stamp samples `performance.now() / 1000` from the start of the run.
 *
 * ## Why these numbers
 *
 * `PULL_WDK_BAND` = ±2 points is the band the log analysis uses to find pedal-hold pulls in a
 * recorded drive (wdk1 within ±2 for >= 4 s), so the clock on the screen and the census of the
 * drive call the same stretch a hold. `PULL_MIN_WDK` = 15 % is where a pull starts being one: the
 * VE band at RO 7.5-10 % is reached at WDK ~22-27 % and RO 13-17 % at WDK ~32-37 %, and below ~15 %
 * the car is cruising or coasting, where nothing is being pulled for.
 *
 * ## What the display shows
 *
 * The hold running now, live, once it has lasted `PULL_SHOWN_MIN_SEC`; until then the last hold
 * that lasted at least that long, dimmed, stays up. 2 s is the floor because a shorter hold is the
 * pedal passing through a position on its way somewhere else — every part-throttle wobble starts
 * one — and letting those replace the number would wipe the pull the driver just made off the
 * screen before they could look at it. With no earlier hold to keep, the running one shows from
 * zero.
 */

/** Pedal below this is cruise or coast, %. */
export const PULL_MIN_WDK = 15;

/** How far the pedal may move from where the hold started and still be the same hold, points of %. */
export const PULL_WDK_BAND = 2;

/** A hold shorter than this never replaces the one on screen, seconds. */
export const PULL_SHOWN_MIN_SEC = 2;

export interface PullClock {
    /** The hold in progress — where and when it started, and the last sample inside its band. */
    active: { startTime: number; startWdk: number; lastTime: number } | null;
    /** Seconds of the last hold that ended after lasting PULL_SHOWN_MIN_SEC or more. */
    lastSec: number | null;
}

export const EMPTY_PULL_CLOCK: PullClock = { active: null, lastSec: null };

/** What the strip draws: seconds, and whether that is the hold running now or the last one. */
export interface PullReading {
    sec: number;
    live: boolean;
}

/**
 * Advance the clock by one sample. Pure — the caller holds the state.
 *
 * A sample with no WDK reading ends the hold: a pedal the link did not report is not one the clock
 * may call held. Run boundaries are the caller's: `useLiveRun` puts `EMPTY_PULL_CLOCK` back on
 * START, reset and recovery, so one run's last pull never shows on the next.
 */
export function stepPullClock(state: PullClock, s: { time: number; wdk: number | null | undefined }): PullClock {
    const { active } = state;
    const wdk = typeof s.wdk === 'number' && Number.isFinite(s.wdk) ? s.wdk : null;
    const pressed = wdk !== null && wdk >= PULL_MIN_WDK;

    if (active && pressed && Math.abs(wdk - active.startWdk) <= PULL_WDK_BAND) {
        return { active: { ...active, lastTime: s.time }, lastSec: state.lastSec };
    }

    // The running hold, if any, is over. It replaces the shown one only if it lasted long enough.
    const endedSec = active ? active.lastTime - active.startTime : null;
    const lastSec = endedSec !== null && endedSec >= PULL_SHOWN_MIN_SEC ? endedSec : state.lastSec;
    return {
        active: pressed ? { startTime: s.time, startWdk: wdk, lastTime: s.time } : null,
        lastSec,
    };
}

/** What the strip shows for this state, or null for '—' (no hold yet). */
export function pullReading(state: PullClock): PullReading | null {
    const running = state.active ? state.active.lastTime - state.active.startTime : null;
    if (running !== null && running >= PULL_SHOWN_MIN_SEC) return { sec: running, live: true };
    if (state.lastSec !== null) return { sec: state.lastSec, live: false };
    if (running !== null) return { sec: running, live: true };
    return null;
}
