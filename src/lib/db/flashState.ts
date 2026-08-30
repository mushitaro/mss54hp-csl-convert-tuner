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
 * The flashes that actually reached a car, oldest first.
 *
 * Everything below answers a question about a physical ECU, so a PRACTICE write — the mock link, no
 * cable — is not an answer to any of them. It is still kept in the history (see FlashRecord), and
 * this is the one place that decides it does not count, so a new consumer cannot forget to ask.
 *
 * Filtered rather than "ignore the tail if it is practice", because the two interleave: practise a
 * finalize on Tuesday and the car is still holding Monday's real patch-on write, and the tail alone
 * would say the session had never been flashed at all.
 */
const realFlashes = (session: Pick<TuningSession, 'flashHistory'>): FlashRecord[] =>
    session.flashHistory.filter(f => !f.practice);

/**
 * Is this session's tune in the ECU, in its road state?
 *
 * THREE conditions now:
 *
 *  1. the last REAL flash was road state,
 *  2. it actually carried the tune, and
 *  3. it happened at all — a session flashed only in PRACTICE has never been on a road.
 *
 * Without (2), arming a bare BASE with the toggles off — a patch write that carries no map at all —
 * badged the session FINAL and withdrew the Finalize action from it. `tuned` absent reads as true
 * because a flash without a derived map was unreachable before the field existed.
 *
 * The LAST flash, not any of them: re-flashing patch-on afterwards has to take the badge away again,
 * which is why this reads the tail rather than searching the history.
 */
export function isTuneOnTheRoad(session: Pick<TuningSession, 'flashHistory'>): boolean {
    const last = realFlashes(session).at(-1);
    return !!last && (last.tuned ?? true) && isRoadState(last);
}

/**
 * What has actually reached the ECU from this session, split three ways.
 *
 * `real` and `practice` were the whole answer once, and a ✔ over `real` was wrong in a way nobody
 * could see from the list: **arming a bare BASE with WRITE PATCH-ON is a real write that carries no
 * tune.** So a session where the driver patched the ECU, drove, logged, and never wrote a tune
 * showed the same ✔ as one whose tune is in the car — and the only place the difference existed was
 * the tooltip, which says TUNED or PATCH ONLY per entry and which a phone cannot show at all.
 * Reported by the operator, 2026-08-24.
 *
 * `tuned ?? true` for records written before the field existed, the same convention
 * `describeFlashHistory` and `isTuneOnTheRoad` already use: back then a write was a tune.
 */
export function flashCounts(session: Pick<TuningSession, 'flashHistory'>): {
    /** Real writes of any kind — kept because "did anything reach the ECU" is still a question. */
    real: number;
    practice: number;
    /** Real writes that carried a tune. This is what a ✔ may stand for. */
    tuned: number;
    /** Real writes that carried only logic patches. A patched ECU, not a tuned one. */
    patchOnly: number;
} {
    const practice = session.flashHistory.filter(f => f.practice).length;
    const real = session.flashHistory.filter(f => !f.practice);
    const tuned = real.filter(f => f.tuned ?? true).length;
    return { real: real.length, practice, tuned, patchOnly: real.length - tuned };
}

/**
 * Did a real write from this session put a TUNE into the ECU?
 *
 * Not "does a tune exist": a map is derived the moment a log meets a BASE, and SAVE stores its
 * bytes, so `sha256` is set on essentially every session that was driven — 15 of the 20 in the
 * store, which is a mark that says nothing. What the operator means by having tuned a session is
 * that a tune went to the car, and that is one deliberate act with a consequence.
 *
 * Distinct from `isTuneOnTheRoad`, which asks whether the tune is in there NOW: writing patch-on
 * again afterwards makes that false, and does not un-write the tune this session sent.
 */
export function wroteTune(session: Pick<TuningSession, 'flashHistory'>): boolean {
    return realFlashes(session).some(f => f.tuned ?? true);
}

/** The three logic patches, as a load's toggle overrides. Not a `ToggleOverrides` import — this
 *  module is under lib/db and must not depend on a hook's types. */
export interface ArmedPatches {
    applyPatch?: boolean;
    applyWotDisable?: boolean;
    applyTankVentDisable?: boolean;
}

/**
 * The last PATCH-ON image this session actually wrote, as its three patches — or null.
 *
 * Not `tuneSettings`, and the difference is the whole point. `tuneSettings` says what the TUNE was
 * built with; this says what went into the CAR. A session commonly writes PATCH-ON first, drives,
 * derives a tune, and later writes it patch-off — so the tune's settings can be all-false while
 * the session did put patches in the ECU, which is exactly the case the PATCH-ON download exists
 * for (operator, 2026-08-25).
 *
 * The LAST such flash rather than the first: if the patches changed between runs, the file this
 * offers should be the most recent thing the car was given. PRACTICE writes are excluded here as
 * everywhere else in this file — they moved no bytes, so they wrote no image.
 */
export function patchOnFlash(session: Pick<TuningSession, 'flashHistory'>): ArmedPatches | null {
    for (let i = session.flashHistory.length - 1; i >= 0; i--) {
        const f = session.flashHistory[i];
        if (f.practice) continue;
        const { applyPatch, applyWotDisable, applyTankVentDisable } = f.settings;
        if (applyPatch || applyWotDisable || applyTankVentDisable) {
            return { applyPatch, applyWotDisable, applyTankVentDisable };
        }
    }
    return null;
}

/**
 * Which logic patches the ECU is holding, for a session whose `tuneSettings` cannot say.
 *
 * `tuneSettings` is written in exactly one place — `saveTune` — so it exists only once a session has
 * derived a VE map. Two ordinary states never reach it: a BASE armed with WRITE PATCH-ON before the
 * first log run, and a research run saved through `saveResearchRun`, which records `hasLog` and no
 * settings at all. Reopening either used to fall through to detection-from-bytes, and the bytes on
 * offer are the session's BASE — by design the PRE-patch image, because `setBase` is never called
 * again after a flash. So the app decided the car was stock, having itself patched it minutes
 * earlier, and nothing raised drift: the toggle and the detection agreed, both about the wrong bytes.
 *
 * The flash history is the record that does know. It is what `isTuneOnTheRoad` above already reads
 * for the FINAL badge; this reads the same tail for the same reason — the LAST flash is the state of
 * the car, and re-flashing patch-on after a finalize has to move it back.
 *
 * Only the three logic patches. `writeWarmup` / `writeWot` are tune CONTENT rather than switches
 * (the same distinction `isRoadState` makes), and re-arming them from a flash record would inject
 * derived tables into a workspace that has not derived them.
 *
 * A field absent from an older record stays `undefined` rather than becoming `false`, so the load
 * falls back to detection for that one toggle instead of asserting an answer the record never had.
 */
export function armedPatchesFromHistory(
    session: Pick<TuningSession, 'flashHistory'>,
): ArmedPatches | null {
    // The last REAL flash. A practice write moved no bytes, so it cannot be what the ECU is
    // holding — and this is the function that decides which calibration a recorded drive gets
    // replayed against, so believing one would filter the log through a car that never existed.
    const last = realFlashes(session).at(-1);
    if (!last) return null;
    return {
        applyPatch: last.settings.applyPatch,
        applyWotDisable: last.settings.applyWotDisable,
        applyTankVentDisable: last.settings.applyTankVentDisable,
    };
}
