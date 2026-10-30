/**
 * What WORKS does when the owner gate stops letting this browser through — WORKS only; production
 * and staging have no gate, and nothing here is reached there.
 *
 * ## Why the app has to do it itself
 *
 * The service worker answers a navigation from its cache, so a lapsed sign-in never shows the
 * gate's page: the cached build simply goes on running. On 2026-10-29 the head unit's sign-in
 * cookies vanished when its clock was put right (Chrome dates a cookie's expiry by the device's
 * clock, and that clock boots at 2006-12-18), and WORKS kept running an old build in silence — the
 * update check got 401, said nothing, and RELOAD reloaded the old build from the cache.
 *
 * So a 401 is news, and there are three things to do with it:
 *
 *     repass          go through the gate again, now. m3 sends a signed-in owner straight back.
 *     notice-signin   say the sign-in has lapsed, with SIGN IN when pressing it is safe.
 *     notice-clock    say the device's clock is out. Through the gate now, the gate would only show
 *                     its page that waits for the clock, and the app would be gone from the screen
 *                     until the device put it right — so it waits here, in the working tool, and the
 *                     next check that finds the clock right goes through by itself.
 *
 * The trip replaces this document as a reload does, so it is taken by itself only when that costs
 * nothing: no link (the cable, or PRACTICE's stand-in, would go with the page), nothing that lives
 * only on this page, a network to make the round trip on, a clock the gate will accept — and not
 * twice in ten minutes in one tab, so a trip that comes back still signed out cannot become a loop.
 */

export type LapseAction = 'repass' | 'notice-signin' | 'notice-clock' | 'none';

export interface LapseFacts {
    /** The gate has turned this browser away: a 401 to the update check, or its own status. */
    lapsed: boolean;
    /** `clockAgrees()` of the 401 that said so. Null when no response has said — the gate's status
     *  alone does not carry one — and null never licenses the trip. */
    clockAgrees: boolean | null;
    /** A DME link is up. */
    linked: boolean;
    /** A run being recorded, or a tune or a log not yet saved. */
    unsaved: boolean;
    online: boolean;
    /** This tab has not been through the gate by itself in the last ten minutes (`repassGuardOpen`). */
    guardOpen: boolean;
}

export function lapseAction(f: LapseFacts): LapseAction {
    if (!f.lapsed) return 'none';
    // First, whatever else holds: with the clock out there is nothing to press either, and saying
    // "sign in" would send the owner to the gate's waiting page.
    if (f.clockAgrees === false) return 'notice-clock';
    if (f.clockAgrees === true && !f.linked && !f.unsaved && f.online && f.guardOpen) return 'repass';
    return 'notice-signin';
}

/**
 * When this tab last went through the gate by itself. sessionStorage, because the trip leaves the
 * document and comes back into the same tab, and the guard has to still be there when it does.
 */
export const REPASS_KEY = 'owner-gate:repassed-at';
export const REPASS_EVERY_MS = 10 * 60_000;

/**
 * Whether this tab may go through the gate by itself now. False when storage cannot be read: a trip
 * that cannot be counted cannot be bounded, and the notice is the safe answer.
 *
 * Either side of `now`, because the clock this is measured on is the device's, and on the head unit
 * that clock moves.
 */
export function repassGuardOpen(now = Date.now()): boolean {
    try {
        const raw = sessionStorage.getItem(REPASS_KEY);
        if (raw === null) return true;
        const last = Number(raw);
        return !Number.isFinite(last) || Math.abs(now - last) >= REPASS_EVERY_MS;
    } catch {
        return false;
    }
}

/** Counts the trip about to be taken. False if it could not be kept — and then it is not taken. */
export function spendRepass(now = Date.now()): boolean {
    try {
        sessionStorage.setItem(REPASS_KEY, String(now));
        return sessionStorage.getItem(REPASS_KEY) === String(now);
    } catch {
        return false;
    }
}
