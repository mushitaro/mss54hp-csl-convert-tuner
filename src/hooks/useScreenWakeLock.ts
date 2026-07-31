import { useEffect } from 'react';

/**
 * Holds the screen awake while a hardware operation is in flight.
 *
 * ## Why this exists, and only now
 *
 * On desktop it would be close to pointless — the tab keeps running with the monitor asleep. On
 * Android it is not: the screen switching off is the ordinary path to the tab being frozen and the
 * USB connection dropped, in the middle of an erase/write/verify that runs for four minutes. That
 * is the same window `useUnloadGuard` was built for, and this is the half of it that guard cannot
 * reach.
 *
 * ## What it is not
 *
 * Not a guarantee, for the same reason the unload guard is not a lock. The browser releases the
 * sentinel whenever the page is hidden, and the user can always press the power button. What it
 * removes is the *inactivity* timeout firing halfway through a write — which is the failure that
 * happens by itself, without anyone deciding anything.
 *
 * ## Shape
 *
 * Deliberately the same discipline as `useUnloadGuard`: the effect exists exactly while `active` is
 * true and React's cleanup releases it, so there is no flag to forget to clear and no "release"
 * step that a failure path can skip. The sentinel lives in a closure variable rather than state
 * because nothing renders from it, and a setState here would put a render in the middle of a
 * transfer.
 *
 * No watchdog, unlike the unload guard. A leaked wake lock costs battery; a leaked unload guard
 * traps the tab. And the browser drops it on hide regardless, so it cannot leak for long.
 *
 * Re-acquisition on `visibilitychange` is required, not optional: the sentinel is auto-released
 * every time the page hides, so without this a single glance at a notification would end it for the
 * rest of the write.
 */
export function useScreenWakeLock(active: boolean): void {
    useEffect(() => {
        if (!active) return;
        if (typeof navigator === 'undefined' || !navigator.wakeLock) return;

        let sentinel: WakeLockSentinel | null = null;
        let released = false;

        const acquire = async () => {
            if (released || sentinel) return;
            try {
                sentinel = await navigator.wakeLock!.request('screen');
                // The browser may drop it on its own; forget the stale handle so a later
                // visibilitychange can take a fresh one instead of seeing a non-null sentinel.
                sentinel.addEventListener('release', () => { sentinel = null; }, { once: true });
                if (released) { void sentinel.release().catch(() => { }); sentinel = null; }
            } catch {
                // Denied, unsupported, or not visible right now. Best-effort by design — the write
                // must not fail because the screen could not be pinned.
            }
        };

        const onVisibility = () => { if (document.visibilityState === 'visible') void acquire(); };

        void acquire();
        document.addEventListener('visibilitychange', onVisibility);

        return () => {
            released = true;
            document.removeEventListener('visibilitychange', onVisibility);
            const held = sentinel;
            sentinel = null;
            if (held) void held.release().catch(() => { });
        };
    }, [active]);
}
