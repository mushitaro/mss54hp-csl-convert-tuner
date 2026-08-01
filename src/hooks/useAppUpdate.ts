'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * Whether the server is serving a newer build than the one running.
 *
 * Installed to the home screen the app has no browser chrome, so it has no reload button; and
 * pull-to-refresh — which is what used to serve as one — is deliberately off, because a downward
 * swipe on a page that never scrolls went straight to Chrome's reload and mid-session that drops
 * the DME link, the log in progress and the unsaved tune. Removing the accident meant removing the
 * only way to take an update, so the app has to offer one of its own.
 *
 * There is no service worker to ask, and no version file to keep in step with the build. What is
 * already unique per build is the hashed chunk names Next emits, so this fetches the entry document
 * uncached and compares its script list against the one this page loaded. Different names mean a
 * different build; identical means there is nothing to take.
 *
 * Failure is silent and reads as "no update". The check is a convenience — the app is fully usable
 * without it, frequently with no network at all in a garage, and a red herring about updates is
 * worse than nothing while someone is trying to read an ECU.
 */
const CHUNK = /\/_next\/static\/chunks\/[^"'\s>]+\.js/g;

function loadedChunks(): Set<string> {
    return new Set(
        Array.from(document.querySelectorAll<HTMLScriptElement>('script[src*="/_next/static/chunks/"]'))
            .map(s => new URL(s.src, location.href).pathname),
    );
}

export function useAppUpdate(pollMs = 15 * 60 * 1000) {
    const [updateAvailable, setUpdateAvailable] = useState(false);

    const check = useCallback(async () => {
        if (typeof document === 'undefined' || !navigator.onLine) return;
        try {
            const res = await fetch(`${location.origin}/`, { cache: 'no-store' });
            if (!res.ok) return;
            const served = new Set((await res.text()).match(CHUNK) ?? []);
            if (!served.size) return;
            const running = loadedChunks();
            // Only ever set it true. A flaky response must not un-announce an update the user has
            // already been told about, and once it is true a reload is the only thing that clears it.
            if ([...served].some(c => !running.has(c))) setUpdateAvailable(true);
        } catch {
            /* offline, or the host blinked. Not an update. */
        }
    }, []);

    useEffect(() => {
        check();
        const t = setInterval(check, pollMs);
        // Coming back to the app is the moment a stale build matters and the moment a check is
        // cheapest — the tab was idle, and the user is about to act on what it shows.
        const onShow = () => { if (document.visibilityState === 'visible') check(); };
        document.addEventListener('visibilitychange', onShow);
        return () => { clearInterval(t); document.removeEventListener('visibilitychange', onShow); };
    }, [check, pollMs]);

    return updateAvailable;
}
