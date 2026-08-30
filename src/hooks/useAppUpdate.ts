'use client';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

/**
 * Where a running update has got to, for the overlay that shows the wait.
 *
 *     checking      one conditional GET of sw.js. No quantity to report.
 *     downloading   the new worker is precaching. `loaded`/`total` are real bytes.
 *     activating    it is installed; the swap and the old caches' deletion are underway.
 *
 * There is no `failed`. Every path in `reloadForUpdate` ends in `location.reload()`, so a failure
 * has the same visible ending as a success — the document is replaced — and a state for it would
 * only ever be painted for the instant before the page goes away.
 */
export type UpdatePhase = 'idle' | 'checking' | 'downloading' | 'activating';

export interface UpdateProgress {
    phase: UpdatePhase;
    /** Bytes of the new build stored, and the size of the whole build. Both 0 until the worker
     *  reports — a build before this one never reports at all, and the overlay says so by showing
     *  no quantity rather than by showing a zero. */
    loaded: number;
    total: number;
    /** The build id the server is offering, read from the document it served. */
    incoming?: string;
    /** When the press happened. The overlay holds off briefly on this, so an update that is already
     *  downloaded — the normal case, see `primeWorker` — swaps without a panel flashing past. */
    startedAt: number;
}

const IDLE: UpdateProgress = { phase: 'idle', loaded: 0, total: 0, startedAt: 0 };

/**
 * A store rather than component state, for the same reason `useLiveRun` publishes samples this way:
 * the thing that changes it is not a React event. Progress arrives from the service worker at 10 Hz
 * while a 6 MB download runs, and the only component that should re-render at 10 Hz is the bar.
 * `useUpdateRunning` exists beside `useUpdateProgress` so the page — 3800 lines of it — can subscribe
 * to a boolean and re-render twice per update instead of six hundred times.
 */
let progress: UpdateProgress = IDLE;
const listeners = new Set<() => void>();

function setProgress(patch: Partial<UpdateProgress>) {
    progress = { ...progress, ...patch };
    for (const listener of listeners) listener();
}

const subscribeProgress = (listener: () => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
};

const readProgress = () => progress;
const readProgressOnServer = () => IDLE;
const readRunning = () => progress.phase !== 'idle';
const readRunningOnServer = () => false;

/** The whole record, at the rate the worker reports it. For the overlay and nothing else. */
export function useUpdateProgress(): UpdateProgress {
    return useSyncExternalStore(subscribeProgress, readProgress, readProgressOnServer);
}

/** Just whether an update is running. Changes twice per update, so subscribing costs the caller
 *  two renders however long the download takes. */
export function useUpdateRunning(): boolean {
    return useSyncExternalStore(subscribeProgress, readRunning, readRunningOnServer);
}

/**
 * Listen for the installing worker's progress, once, for the tab's lifetime.
 *
 * Registered on first mount rather than inside `reloadForUpdate`, because the download normally
 * starts long before anyone presses anything (see `primeWorker`). Listening only during the press
 * would mean the overlay opened at zero on a download that was already three quarters done.
 *
 * Never removed. It is one listener per tab holding a reference to a module-level setter, and the
 * only thing that ends an update is the document being replaced.
 */
let listening = false;
function listenForPrecache() {
    if (listening || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    listening = true;
    navigator.serviceWorker.addEventListener('message', event => {
        const data: unknown = event.data;
        if (!data || typeof data !== 'object') return;
        const message = data as { type?: unknown; loaded?: unknown; total?: unknown };
        if (message.type !== 'PRECACHE_PROGRESS') return;
        if (typeof message.loaded !== 'number' || typeof message.total !== 'number') return;
        setProgress({ loaded: message.loaded, total: message.total });
    });
}

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
/** The stamp build-id.mjs puts in every document's head. Attribute order is fixed by that script,
 *  so matching it rather than parsing the served HTML is enough — and parsing it would mean handing
 *  a foreign document to DOMParser to read one string out of it. */
const BUILD_ID = /<meta name="build-id" content="([^"]*)"/;

function loadedChunks(): Set<string> {
    return new Set(
        Array.from(document.querySelectorAll<HTMLScriptElement>('script[src*="/_next/static/chunks/"]'))
            .map(s => new URL(s.src, location.href).pathname),
    );
}

/**
 * Starts downloading the new build the moment there is one, rather than when somebody asks for it.
 *
 * ## This is the fix for "the update only lands if you press UPDATE twice"
 *
 * The press used to be what STARTED the download. The worker's install handler precaches the whole
 * export — measured at this commit, **65 files, 6.0 MB**, of which one Plotly chunk is 4.4 MB — and
 * `cacheOne` fetches every one of them with `cache: 'reload'`, so not a byte of it may come from the
 * HTTP cache. `reloadForUpdate` then gave that four seconds. Four seconds is 12 Mbit/s sustained
 * plus 65 round trips; on a phone on a garage's WiFi it is not close. The deadline expired, the
 * function fell through to its plain-reload fallback, and the same build came back up still offering
 * the same update.
 *
 * Timed here against `wrangler pages dev` over loopback — no latency, no bandwidth limit, warm
 * disk, which is the floor rather than the phone: `update()` resolved at **322 ms** and the worker
 * reached `installed` at **1051 ms**. That is a quarter of the old budget spent where the transfer
 * itself is free. What the phone adds is the 6 MB and 65 round trips of it.
 *
 * What made that reliably TWO presses rather than an occasional miss is what the fallback does. A
 * navigation is one of the moments the browser checks sw.js by itself, so the press that appeared to
 * do nothing kicked off the very download it had just stopped waiting for. Seconds later — at a row
 * still saying "Update", because nothing about the page had changed — the second press found the new
 * worker already in `waiting` and swapped instantly. The button was never broken. The first press
 * paid for the download and the second one collected it.
 *
 * So the download starts here, when the poll below first notices the new build, and it runs while
 * the control pulses for somebody to notice it. By the time it is pressed the worker is normally
 * already waiting, which is the state the whole handover needs and the state the old code could only
 * reach by accident.
 *
 * Nothing is swapped by this. The worker precaches and then sits in `waiting` exactly as before —
 * see the note in `scripts/sw.template.js` about why the swap must stay something the user asks for.
 * Failure is silent for the same reason the check is: without this the app behaves as it did, one
 * press slower.
 */
async function primeWorker() {
    if (!('serviceWorker' in navigator)) return;
    try {
        const reg = await navigator.serviceWorker.getRegistration();
        await reg?.update();
    } catch {
        /* No network, or no worker registered. The press carries its own `update()` regardless. */
    }
}

/** Whichever settles first; `null` if `work` rejects or runs out of time. Never rejects. */
function within<T>(ms: number, work: Promise<T>): Promise<T | null> {
    return Promise.race([
        work.then(value => value, () => null),
        new Promise<null>(resolve => { setTimeout(() => resolve(null), ms); }),
    ]);
}

/**
 * Resolves with the worker once it has finished installing, or with null if it never will.
 *
 * The state is read once up front as well as listened for. A worker that reached `installed` between
 * the caller's read of `reg.installing` and this line will never fire another `statechange`, and the
 * wait would then run to its deadline over a download that had already finished.
 */
function installed(sw: ServiceWorker): Promise<ServiceWorker | null> {
    return new Promise(resolve => {
        const settle = () => {
            if (sw.state === 'installed') resolve(sw);
            // 'redundant' is a failed install — the install handler deletes its own half-filled
            // cache and rethrows, on purpose. 'activating'/'activated' means it took over without
            // ever waiting. Either way there is nothing left to ask this worker for.
            else if (sw.state !== 'installing') resolve(null);
        };
        sw.addEventListener('statechange', settle);
        settle();
    });
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
 * ## Three deadlines, not one
 *
 * There was a single four-second budget across all of it, and it was being spent on the wrong step —
 * see `primeWorker` for what that cost. The three steps have nothing in common:
 *
 *     probe    4 s   one conditional GET of sw.js. Overrunning that means a dead link rather than a
 *                    slow one, and the answer to a dead link is the plain reload that was asked for.
 *     install 60 s   6 MB over whatever the garage has. Reached only when a download really is in
 *                    flight (`reg.installing` is set), so a press with nothing to take still costs
 *                    at most the probe. 60 s is that payload at about 1 Mbit/s.
 *     swap     5 s   a postMessage, and an `activate` that deletes the old caches and claims. There
 *                    is no network in it at all.
 *
 * Every one of them still falls through to `location.reload()`: the user asked for a reload and must
 * get one, whatever else failed. What licenses the middle deadline being fifteen times the old whole
 * is that the caller now shows the wait — the refresh icon spins while this runs — so a download is
 * something the user can watch happening rather than a button that appears to have missed the press.
 */
export async function reloadForUpdate({ probeMs = 4000, installMs = 60_000, swapMs = 5000 } = {}) {
    // Synchronously, before the first await: this is what the press acknowledges. Every later phase
    // is set from inside the try, and none of them can fail to end at the reload below.
    setProgress({ phase: 'checking', startedAt: Date.now() });

    try {
        if ('serviceWorker' in navigator) {
            const reg = await navigator.serviceWorker.getRegistration();
            if (reg) {
                // Already downloaded, by `primeWorker` or by one of the browser's own checks.
                // Asking again would find the same script and cost a round trip to be told so.
                if (!reg.waiting) await within(probeMs, reg.update());

                // `update()` resolving does not mean the new worker is ready to be told anything.
                // The spec resolves that promise as the worker ENTERS `installing`, before the
                // install event's waitUntil settles — i.e. before a byte of the precache is stored.
                // Measured over loopback: resolved at 322 ms, `installed` at 1051 ms. `waiting` is
                // the state that can accept the message.
                if (reg.installing) setProgress({ phase: 'downloading' });
                const waiting = reg.waiting ?? (reg.installing
                    ? await within(installMs, installed(reg.installing))
                    : null);

                if (waiting) {
                    setProgress({ phase: 'activating' });
                    await within(swapMs, new Promise<void>(resolve => {
                        navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true });
                        waiting.postMessage({ type: 'SKIP_WAITING' });
                    }));
                }
            }
        }
    } catch {
        /* Nothing here is worth blocking a reload over. */
    }

    location.reload();
}

/**
 * Two minutes, down from fifteen.
 *
 * Fifteen was sized for a tool that gets deployed occasionally, and the visibilitychange check was
 * meant to cover the rest — but it only fires when the tab was hidden and comes back. Somebody
 * holding the phone, watching the screen while a build goes out, triggers neither: the tab never
 * hides, so the only thing left is the interval, and they wait up to a quarter of an hour looking at
 * a build they were told had shipped. That happened three times in a row.
 *
 * The check is one no-store GET of the entry document. Against a datalog's measured 0.3 ms of host
 * gap per sample it is not a cost worth trading a quarter hour of confusion for.
 */
export function useAppUpdate(pollMs = 2 * 60 * 1000) {
    const [updateAvailable, setUpdateAvailable] = useState(false);
    /**
     * The build whose download has already been started, as its chunk set.
     *
     * Keyed on the build rather than on a bare "done" flag, so that a second deploy landing while
     * the app is open is fetched too — which is the normal case here, where the person watching the
     * screen is the person deploying. Keyed on something, rather than not at all, because the poll
     * re-notices the same build every two minutes and on every return to the tab, and an `update()`
     * per notice would be a round trip each time for an answer that cannot have changed.
     */
    const primed = useRef('');

    const check = useCallback(async () => {
        if (typeof document === 'undefined' || !navigator.onLine) return;
        try {
            const res = await fetch(`${location.origin}/`, { cache: 'no-store' });
            if (!res.ok) return;
            const html = await res.text();
            const served = new Set(html.match(CHUNK) ?? []);
            if (!served.size) return;
            const running = loadedChunks();
            // Only ever set it true. A flaky response must not un-announce an update the user has
            // already been told about, and once it is true a reload is the only thing that clears it.
            if ([...served].some(c => !running.has(c))) {
                setUpdateAvailable(true);
                // The same stamp `scripts/build-id.mjs` writes into every document and the
                // diagnostics store records, taken from the document the server just served. The
                // overlay names the build that is arriving with it, so "did it take the one I
                // pushed" is answerable from the phone rather than only from the desk.
                setProgress({ incoming: html.match(BUILD_ID)?.[1] });
                const build = [...served].sort().join('|');
                if (primed.current !== build) {
                    primed.current = build;
                    void primeWorker();
                }
            }
        } catch {
            /* offline, or the host blinked. Not an update. */
        }
    }, []);

    useEffect(() => {
        listenForPrecache();
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
