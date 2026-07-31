import { useEffect } from 'react';

/**
 * Interposes the browser's "leave site?" confirmation while a hardware operation is in flight.
 *
 * ## This is not a lock, and must not be described as one
 *
 * `beforeunload` is the only mechanism a page has, and all it can do is make leaving deliberate. The
 * user can always confirm and go. The dialog's wording is the browser's and cannot be set (every
 * engine dropped custom messages years ago), so the app has to explain itself elsewhere — the
 * pre-operation confirmations carry that copy. And it does not fire at all for a killed process, an
 * OS shutdown, a crash or a power cut. What it buys is turning an absent-minded Ctrl+R into a choice,
 * during the minutes when that keystroke can leave an ECU half-programmed.
 *
 * ## Weaker still on Android, and there is nothing to add
 *
 * Chrome for Android honours this for a reload and a same-tab navigation, but not dependably for a
 * tab close, the back gesture, or the OS reclaiming the tab. Do not go looking for a stronger API:
 * there isn't one. The gap is covered from two other directions instead — `useScreenWakeLock`
 * removes the commonest way a phone interrupts itself, `useHiddenWitness` records it when something
 * does, and `dialogText().writeConfirm` states the extra rules plainly on Android before the write
 * starts. This hook stays exactly as strong as the platform allows and no stronger.
 *
 * ## Why there is no unlock
 *
 * The obvious shape — a flag set before the operation and cleared after — has a failure mode worse
 * than the problem: any path that skips the clear leaves the tab nagging forever. So there is no
 * flag. The listener exists exactly while `active` is true, and React's cleanup removes it on every
 * change and on unmount, so there is no "release" step to forget or to fail.
 *
 * That makes the error case free rather than special: every operation in useDmeLink returns the link
 * to `connected` on both its success and its catch path (`write` does so explicitly, and
 * deliberately does not disconnect), so a failure drops `active` and the guard goes with it.
 *
 * ## The one residual risk, and the watchdog
 *
 * The above covers a thrown error but not a promise that never settles — a hung transport would
 * leave the state busy and the tab genuinely stuck. So the guard also expires on its own. The
 * listener is removed directly by the timer rather than through state, which keeps this hook free of
 * a setState-in-effect and means expiry cannot itself depend on a render happening.
 *
 * @param active   Whether an operation that must not be interrupted is running. Derive it from the
 *                 link state — never from a variable something has to remember to reset.
 * @param maxMs    How long the guard may hold before releasing itself. Must be sized to the
 *                 operation: a flash is ~4 minutes, but a data log is a drive and can run for hours,
 *                 so a single global figure would either cut a run's guard short or let a hang trap
 *                 the tab for the rest of the day.
 */
export function useUnloadGuard(active: boolean, maxMs: number): void {
    useEffect(() => {
        if (!active) return;

        const onBeforeUnload = (e: BeforeUnloadEvent) => {
            // preventDefault is the specified way; returnValue is what older engines still read.
            // Setting both is not belt-and-braces for its own sake — this is the one hook where a
            // silently ignored call means an ECU write loses its only warning.
            e.preventDefault();
            e.returnValue = '';
        };

        window.addEventListener('beforeunload', onBeforeUnload);
        const watchdog = setTimeout(() => {
            window.removeEventListener('beforeunload', onBeforeUnload);
        }, maxMs);

        return () => {
            clearTimeout(watchdog);
            window.removeEventListener('beforeunload', onBeforeUnload);
        };
    }, [active, maxMs]);
}
