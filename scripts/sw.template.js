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
/** `[{ url, bytes }]` — the on-disk size rides along so the install can be reported. See gen-sw.mjs. */
const ASSETS = __ASSETS__;

/** How often the install tells the page where it has got to. 10 Hz, the same rate the DME link
 *  throttles its own transfer progress to, and for the same reason: it is already smoother than a
 *  bar needs, and the page paints at 60 Hz regardless of how often it is told. */
const PROGRESS_MS = 100;

/**
 * A copy of a response holding the bytes we actually have.
 *
 * ## Flattening the redirect
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
 * ## Why the framing headers are dropped
 *
 * This used to copy `response.headers` through untouched, on the redirect path only. The body it
 * copies them onto has already been decoded by the fetch — `Content-Encoding: br` and the
 * compressed `Content-Length` describe the bytes on the wire, not the bytes in this Response, and
 * both hosts here serve compressed. `Transfer-Encoding: chunked` is the same kind of claim about a
 * connection this Response does not have; the local Pages emulator sets it on every asset. Keeping
 * any of them means storing a response whose headers contradict its body, which is a decode failure
 * waiting for whichever engine decides to believe them. Nothing needs them: what a cached asset has
 * to carry is its `Content-Type`.
 *
 * That was latent rather than observed — the old code only re-wrapped `/index.html`, and only on
 * the host that redirects. It stops being latent here, because now every asset is re-wrapped.
 * Verified from the stored entries afterwards: content-type and nosniff survive, the framing three
 * are gone, `redirected` is false, and a reload was served 9 chunks out of 9 by this worker with 0
 * bytes off the network.
 */
function rewrap(body, response) {
    const headers = new Headers(response.headers);
    for (const framing of ['content-encoding', 'content-length', 'transfer-encoding']) {
        headers.delete(framing);
    }
    return new Response(body, { status: 200, statusText: 'OK', headers });
}

/**
 * Stores one asset, counting the bytes as they land.
 *
 * Read through a reader rather than in one `blob()`, so `onBytes` is called during the download and
 * not once at the end of it. That distinction is the whole progress display: one Plotly chunk is
 * 4.4 MB of this build's 6.0, so a bar fed by completed files — or by completed bodies — would sit
 * near a quarter of the way across for almost the entire install and then jump to full.
 */
async function cacheOne(cache, url, onBytes) {
    const response = await fetch(url, { cache: 'reload' });
    if (!response.ok) throw new Error(`${response.status} for ${url}`);

    if (!response.body) {
        // No stream to read from. Not expected for any asset in the export, but a Response is
        // allowed to have a null body and losing the precache over a missing progress tick would
        // be the wrong trade.
        const blob = await response.blob();
        onBytes(blob.size);
        await cache.put(url, rewrap(blob, response));
        return;
    }

    const reader = response.body.getReader();
    const chunks = [];
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        onBytes(value.byteLength);
    }
    await cache.put(url, rewrap(new Blob(chunks), response));
}

self.addEventListener('install', (event) => {
    event.waitUntil((async () => {
        const cache = await caches.open(CACHE);
        const total = ASSETS.reduce((sum, asset) => sum + asset.bytes, 0);
        let loaded = 0;
        let postedAt = 0;

        /**
         * Tell every window in scope how far this has got.
         *
         * `includeUncontrolled: true` is the load-bearing option: this worker is still installing,
         * so it controls nothing. The page that wants to hear this is the one the OLD worker is
         * driving, and without the flag `matchAll` returns an empty list and the download is silent
         * — which is the state the app was in when the wait had no display at all.
         *
         * Nothing is awaited by the caller. A page that is not listening (any build before this
         * one) is not an error, and a postMessage must never be able to hold up a download.
         */
        const report = (force) => {
            const now = Date.now();
            if (!force && now - postedAt < PROGRESS_MS) return;
            postedAt = now;
            self.clients.matchAll({ includeUncontrolled: true, type: 'window' }).then((clients) => {
                for (const client of clients) {
                    client.postMessage({ type: 'PRECACHE_PROGRESS', loaded, total, cache: CACHE });
                }
            });
        };

        report(true);

        // Added one at a time rather than with addAll, only so that a failure
        // can say which URL failed. The outcome is still all-or-nothing on
        // purpose: a half-filled cache produces an app that starts offline and
        // then dies on whichever chunk was missing, which is a worse failure
        // than not being offline-capable at all, because it looks like a bug in
        // the tool rather than a missing download.
        const results = await Promise.allSettled(ASSETS.map((asset) => cacheOne(cache, asset.url, (n) => {
            loaded += n;
            report(false);
        })));
        const failed = ASSETS.filter((_, i) => results[i].status === 'rejected');
        if (failed.length > 0) {
            await caches.delete(CACHE);
            throw new Error(
                `precache incomplete: ${failed.length}/${ASSETS.length} failed, ` +
                `first was ${failed[0].url}`
            );
        }

        // Forced, so the bar lands on the real total rather than wherever the last throttled tick
        // left it. The page uses this to know the download is done, not just nearly done.
        report(true);
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
