/**
 * Offline cache for the tuner.
 *
 * `scripts/gen-sw.mjs` fills in the two placeholders after `next build` and
 * writes the result to `out/sw.js`. This file is never served — it lives in
 * scripts/ rather than public/ so that Next does not publish the template
 * alongside the thing generated from it.
 *
 * ## Why this is hand-written
 *
 * Workbox and Serwist are routing frameworks, and this site has nothing to
 * route: one HTML entry point, a fixed set of hashed assets beside it, and no
 * runtime calls to anything. Fifteen kilobytes of matcher machinery would be an
 * answer to a question the bundle does not ask. What it does need is precise:
 * take everything, serve it from disk first, and never change under a page that
 * is already open.
 *
 * ## Cache-first, and why that is the right way round here
 *
 * Every asset below `/_next/static/` carries a content hash in its name, so a
 * cached copy can never be stale — a changed file is a different URL. The only
 * unhashed thing is the HTML, and serving that from cache is the entire point:
 * it is what makes the app start in a garage with no signal.
 *
 * The cost is that a deploy lands one launch late. See the activate handler.
 */
const CACHE = '__CACHE_NAME__';
const ASSETS = __ASSETS__;

self.addEventListener('install', (event) => {
    event.waitUntil((async () => {
        const cache = await caches.open(CACHE);

        // Added one at a time rather than with addAll, only so that a failure
        // can say which URL failed. The outcome is still all-or-nothing on
        // purpose: a half-filled cache produces an app that starts offline and
        // then dies on whichever chunk was missing, which is a worse failure
        // than not being offline-capable at all, because it looks like a bug in
        // the tool rather than a missing download.
        const results = await Promise.allSettled(ASSETS.map((url) => cache.add(url)));
        const failed = ASSETS.filter((_, i) => results[i].status === 'rejected');
        if (failed.length > 0) {
            await caches.delete(CACHE);
            throw new Error(
                `precache incomplete: ${failed.length}/${ASSETS.length} failed, ` +
                `first was ${failed[0]}`
            );
        }
    })());
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        // Drop every previous version. The cache name is a hash of the build's
        // own contents, so anything that is not the current name is a build
        // nobody can reach any more.
        const keys = await caches.keys();
        await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
        await self.clients.claim();
    })());
});

/**
 * There is deliberately no *unconditional* `skipWaiting()`.
 *
 * A new worker therefore sits in `waiting` until every page controlled by the
 * old one is gone. That is the behaviour an offline-first instrument wants: the
 * alternative is swapping the JavaScript underneath somebody who is part-way
 * through editing a map with an ECU on the other end of a cable.
 *
 * What that reasoning objects to is the swap being *automatic*, and asking is
 * exactly what the menu's "Update available — reload" row does. So the page can
 * request the swap, and only then:
 *
 *   waiting.postMessage({ type: 'SKIP_WAITING' })
 *
 * `activate` already claims every client, so the page hears `controllerchange`
 * and reloads into the new build — see `reloadForUpdate` in
 * `src/hooks/useAppUpdate.ts`, which is the only thing that sends this. Nothing
 * here fires on its own; without that message the worker still waits.
 *
 * Left alone, a deploy still appears one launch later than it was pushed.
 * Closing the tool and reopening it remains an update.
 */
self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.method !== 'GET') return;

    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return;

    // A navigation to any path resolves to the one HTML document. This app is a
    // single exported route; without this, a deep link or a reload while
    // offline would miss the cache and show the browser's error page.
    if (request.mode === 'navigate') {
        event.respondWith((async () => {
            const cached = await caches.match('/index.html');
            if (cached) return cached;
            return fetch(request);
        })());
        return;
    }

    event.respondWith((async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        // Not precached — a favicon variant the browser invented, say. Try the
        // network and let it fail honestly if there is none.
        return fetch(request);
    })());
});
