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
 * There is no version file to keep in step with the build. What is already unique per build is the
 * hashed chunk names Next emits, so this fetches the entry document uncached and compares its script
 * list against the one this page loaded. Different names mean a different build; identical means
 * there is nothing to take.
 *
 * The offline cache does not answer this fetch and must not start to. Its precache lists the file as
 * `/index.html` and this asks for `/`, which is a different key, so the request misses and goes to
 * the network — which is the whole point of the check. A precache entry for `/` would freeze the
 * answer at the installed build and the app would never report an update again.
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

/**
 * Reload into the newest build there is, rather than into the one already cached.
 *
 * `location.reload()` on its own does not do that any more, and this is the whole reason this
 * function exists. The offline cache answers a navigation from disk — that is what makes the tool
 * start in a garage with no signal — and it holds no `skipWaiting()`, so a newly downloaded worker
 * sits in `waiting` until the app is closed. Between them, pressing a row that says
 * "Update available — reload" repainted the same build and left the row still saying it.
 *
 * So: re-fetch the worker script, wait for the new one to reach `waiting`, tell it to take over,
 * and reload once it has. `activate` claims every client, so `controllerchange` is the signal that
 * the next navigation will be served by the new worker out of the new cache.
 *
 * Every step is allowed to fail into a plain reload, on one shared deadline. No network, no worker,
 * an update that turned out not to exist, a `controllerchange` that never comes — all of them end
 * with the page reloading, because the user asked for a reload and must get one. The deadline is
 * what makes this safe to put behind a button: worst case it is a normal reload, four seconds late.
 */
export async function reloadForUpdate(deadlineMs = 4000) {
    const deadline = new Promise<void>(resolve => setTimeout(resolve, deadlineMs));
    /** Resolves on whichever comes first, and never rejects. */
    const race = (p: Promise<unknown>) => Promise.race([p.then(() => undefined, () => undefined), deadline]);

    try {
        if ('serviceWorker' in navigator) {
            const reg = await navigator.serviceWorker.getRegistration();
            if (reg) {
                // The browser only checks sw.js on its own schedule, so a deploy the poll above has
                // already noticed may not have been downloaded yet. Ask now.
                await race(reg.update());

                // `update()` returning does not mean the new worker is ready to be told anything —
                // it may still be precaching. `waiting` is the state that can accept the message.
                const waiting = reg.waiting ?? (reg.installing
                    ? await Promise.race([
                        new Promise<ServiceWorker | null>(resolve => {
                            const sw = reg.installing!;
                            sw.addEventListener('statechange', () => {
                                if (sw.state === 'installed') resolve(sw);
                                // 'redundant' means the install failed — nothing to swap to.
                                else if (sw.state === 'redundant') resolve(null);
                            });
                        }),
                        deadline.then(() => null),
                    ])
                    : null);

                if (waiting) {
                    await Promise.race([
                        new Promise<void>(resolve => {
                            navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true });
                            waiting.postMessage({ type: 'SKIP_WAITING' });
                        }),
                        deadline,
                    ]);
                }
            }
        }
    } catch {
        /* Nothing here is worth blocking a reload over. */
    }

    location.reload();
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
