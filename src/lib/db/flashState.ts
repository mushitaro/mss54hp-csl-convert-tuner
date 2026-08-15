/**
 * What the ECU is holding right now, read off a session's flash history.
 *
 * Pure, and in its own file rather than inline in SessionList, for the reason the bug that produced
 * it demonstrates: the FINAL badge is a claim about a car, made from two booleans that were easy to
 * get wrong and impossible to test where they lived. Every consumer asks these two functions, and
 * `verify:flash-state` asks them the questions a wrong answer would fail.
 */

import type { FlashRecord, TuningSession } from './schema';

/**
 * Are these bytes fit for the road — i.e. is every tuning-only patch off?
 *
 * The list has to stay complete. TANK VENT was added to the app, to the write confirm and to the
 * flash record without being added here, so a flash that left the evaporative system disabled still
 * counted as road state — the one patch with a legal dimension, silently exempted. A patch missing
 * from this list is a patch the FINAL badge will lie about.
 *
 * `writeWarmup` / `writeWot` are deliberately NOT here. Those are tune CONTENT — tables derived from
 * the log and meant to stay in the car — not diagnostic switches to be taken back out.
 */
export function isRoadState(flash: FlashRecord): boolean {
    return !flash.settings.applyPatch
        && !flash.settings.applyWotDisable
        && !flash.settings.applyTankVentDisable;
}

/**
 * Is this session's tune in the ECU, in its road state?
 *
 * TWO conditions, and the second one is the one that was missing:
 *
 *  1. the last flash was road state, and
 *  2. it actually carried the tune.
 *
 * Without (2), arming a bare BASE with the toggles off — a patch write that carries no map at all —
 * badged the session FINAL and withdrew the Finalize action from it. `tuned` absent reads as true
 * because a flash without a derived map was unreachable before the field existed.
 *
 * The LAST flash, not any of them: re-flashing patch-on afterwards has to take the badge away again,
 * which is why this reads the tail rather than searching the history.
 */
export function isTuneOnTheRoad(session: Pick<TuningSession, 'flashHistory'>): boolean {
    const last = session.flashHistory.at(-1);
    return !!last && (last.tuned ?? true) && isRoadState(last);
}
