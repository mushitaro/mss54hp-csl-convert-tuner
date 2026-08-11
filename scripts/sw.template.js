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

/**
 * Stores one asset, with any redirect flattened out of it.
 *
 * `cache.add(url)` is the obvious call and it is the one that broke this app on
 * Cloudflare Pages. Pages answers `/index.html` with a **308 to `/`**; `add`
 * follows it and stores a response whose `redirected` flag is true. Per spec a
 * redirected response **may not satisfy a navigation request**, so every
 * navigation under this worker failed with `net::ERR_FAILED` — a blank screen,
 * with the worker looking like the culprit and the redirect nowhere in sight.
 *
 * GitHub Pages serves `/index.html` at 200, which is why production never showed
 * it and why this was found on a phone rather than at a desk. The host is not
 * something this file gets to assume, so the fix is here rather than in a
 * redirect rule: re-wrapping through `new Response` produces a copy with
 * `redirected === false`, which navigation accepts from any host.
 *
 * (The repo's own scripts/serve-like-pages.mjs documents this exact trap for the
 * local harness. It cost an hour there too.)
 */
async function cacheOne(cache, url) {
    const response = await fetch(url, { cache: 'reload' });
    if (!response.ok) throw new Error(`${response.status} for ${url}`);
    if (!response.redirected) {
        await cache.put(url, response);
        return;
    }
    await cache.put(url, new Response(await response.blob(), {
        status: 200,
        statusText: 'OK',
        headers: response.headers,
    }));
}

self.addEventListener('install', (event) => {
    event.waitUntil((async () => {
        const cache = await caches.open(CACHE);

        // Added one at a time rather than with addAll, only so that a failure
        // can say which URL failed. The outcome is still all-or-nothing on
        // purpose: a half-filled cache produces an app that starts offline and
        // then dies on whichever chunk was missing, which is a worse failure
        // than not being offline-capable at all, because it looks like a bug in
        // the tool rather than a missing download.
        const results = await Promise.allSettled(ASSETS.map((url) => cacheOne(cache, url)));
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

    // The upload API, where one exists (the Cloudflare Pages preview — production is static and has
    // no /api at all). Left entirely to the network, for two reasons that both bite:
    //
    //   A GET to /api/runs has `mode: 'cors'`, so it would fall past the navigate branch into the
    //   cache lookup, miss, and go to the network anyway — correct today, and only by accident. A
    //   list of runs served from a cache would be a list of runs that no longer exist.
    //
    //   And a *navigation* to /api/... — following the download link for a run — matches the
    //   navigate branch above and would be answered with index.html. The user would get the app
    //   where they asked for a CSV, with no error anywhere to explain it.
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return;

    // A navigation to any path resolves to the one HTML document. This app is a
    // single exported route; without this, a deep link or a reload while
    // offline would miss the cache and show the browser's error page.
    if (request.mode === 'navigate') {
        event.respondWith((async () => {
            const cached = await caches.match('/index.html');
            // `redirected` is checked as well as presence, and that check is what
            // lets a cache poisoned by an older build heal itself. A worker that
            // stored the shell before `cacheOne` existed has a copy navigation
            // will refuse, and returning it strands the client on a blank screen
            // with no page running to ask for an update — the one failure this
            // app cannot recover from on its own. Falling through to the network
            // costs a request and ends the deadlock.
            if (cached && !cached.redirected) return cached;
            try {
                return await fetch(request);
            } catch {
                // Offline AND holding only a poisoned shell. Nothing here can
                // fix that, but a redirected response is still a document —
                // re-wrapping it is the difference between the app opening and
                // the browser's error page.
                if (cached) {
                    return new Response(await cached.blob(), {
                        status: 200, statusText: 'OK', headers: cached.headers,
                    });
                }
                throw new Error('offline and no cached shell');
            }
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
