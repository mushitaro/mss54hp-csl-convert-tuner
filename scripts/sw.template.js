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
/**
 * Where /data/ lands when something actually asks for it.
 *
 * Keyed to the build like the precache, and dropped with it on activate: the corpus is served from
 * a fixed URL, so a re-vendored graph would otherwise be answered from a stale copy forever, and a
 * calibration table that quietly describes the previous artifact is worse than a download.
 */
const DATA_CACHE = CACHE + '-data';
/**
 * `[{ url, fetch, bytes }]`. `url` is the cache key, `fetch` is where it is fetched from — the two
 * differ only for documents (see gen-sw.mjs), and the on-disk size rides along so the install can be
 * reported.
 */
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
 * What each extension's Content-Type must contain. Matched as substrings, so charset suffixes and
 * the two spellings of JavaScript both pass.
 *
 * This is the check that keeps the owner gate's answers out of the cache. Behind the gate an
 * expired session gets a 401 JSON for an asset and a 302 towards m3 for a document; either one
 * stored under an asset's name is an app that starts offline and then fails on that file — or, for
 * the shell, an app that opens as someone else's sign-in page. `ok` alone does not catch every
 * shape of that (a sign-in page is a 200 somewhere), so the body has to be the KIND of thing the key
 * names. An extension missing from here must at least not be HTML.
 */
const TYPES = {
    html: ['text/html'],
    js: ['javascript'],
    css: ['text/css'],
    txt: ['text/plain', 'text/x-component'],
    json: ['json'],
    webmanifest: ['json'],
    png: ['image/png'],
    svg: ['image/svg'],
    ico: ['image/'],
    woff2: ['font/', 'woff2', 'application/octet-stream'],
    bin: ['application/octet-stream'],
};

/** Why a fetched response may not become this build's copy of `key`, or null when it may. */
function unfit(response, key) {
    if (!response.ok) return `${response.status}`;
    // `basic` is same-origin and readable. An opaque or CORS response is not this site's file.
    if (response.type !== 'basic') return `type ${response.type}`;
    if (response.redirected) {
        // Pages answers `.html` with a 308 to the extensionless path, which is fine; anything that
        // ends on another origin or inside the gate is the gate talking, not the asset.
        const to = new URL(response.url);
        if (to.origin !== self.location.origin || to.pathname.startsWith('/_gate/')) return `redirected to ${to.pathname}`;
    }
    const ext = key.slice(key.lastIndexOf('.') + 1).toLowerCase();
    const type = (response.headers.get('content-type') ?? '').toLowerCase();
    const want = TYPES[ext];
    if (want ? !want.some((w) => type.includes(w)) : type.includes('text/html')) return `content-type ${type || '(none)'}`;
    return null;
}

/**
 * Stores one asset, counting the bytes as they land.
 *
 * Fetched from `asset.fetch` and stored under `asset.url`. For a document those differ: Pages
 * answers `/index.html` with a 308 to `/`, and fetching the extensionless path directly is one
 * request instead of two and never meets a redirect that `unfit` would have to judge. The key stays
 * `/index.html` — `/` must NOT become a key, because useAppUpdate asks the network for `/` to learn
 * whether there is a new build, and a cached `/` would freeze that answer for ever.
 *
 * Read through a reader rather than in one `blob()`, so `onBytes` is called during the download and
 * not once at the end of it. That distinction is the whole progress display: one Plotly chunk is
 * 4.4 MB of this build's 6.0, so a bar fed by completed files — or by completed bodies — would sit
 * near a quarter of the way across for almost the entire install and then jump to full.
 */
async function cacheOne(cache, asset, onBytes) {
    const response = await fetch(asset.fetch, { cache: 'reload' });
    const why = unfit(response, asset.url);
    if (why) throw new Error(`${why} for ${asset.url}`);

    if (!response.body) {
        // No stream to read from. Not expected for any asset in the export, but a Response is
        // allowed to have a null body and losing the precache over a missing progress tick would
        // be the wrong trade.
        const blob = await response.blob();
        onBytes(blob.size);
        await cache.put(asset.url, rewrap(blob, response));
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
    await cache.put(asset.url, rewrap(new Blob(chunks), response));
}

self.addEventListener('install', (event) => {
    event.waitUntil((async () => {
        // Whether this name is already somebody's working cache. It should not be — the name hashes
        // this build's bytes. If it is, a failed install does NOT leave it exactly as it was: the
        // assets that did arrive are written straight into it (cacheOne puts into CACHE, there is no
        // staging cache), and only a cache this install created is deleted on failure. That is
        // accepted because the same name means the same content hash, so what lands is the same
        // bytes the existing entries already hold, and each one passed `unfit` first.
        const existed = await caches.has(CACHE);
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
        // A few at a time, not all 67 at once. Each body is held in memory as chunks and then as
        // a Blob before it reaches the cache, so "all at once" is the whole build resident at once —
        // on a 1-2 GB head unit, over a tethered phone, with the app running in front of it. The
        // install is all-or-nothing either way; this only bounds what it costs while it runs.
        const LANES = 6;
        const results = new Array(ASSETS.length);
        let next = 0;
        await Promise.all(Array.from({ length: Math.min(LANES, ASSETS.length) }, async () => {
            for (;;) {
                const i = next++;
                if (i >= ASSETS.length) return;
                try {
                    await cacheOne(cache, ASSETS[i], (n) => { loaded += n; report(false); });
                    results[i] = { status: 'fulfilled' };
                } catch (error) {
                    results[i] = { status: 'rejected', reason: error };
                }
            }
        }));
        const failed = ASSETS.filter((_, i) => results[i].status === 'rejected');
        if (failed.length > 0) {
            // Throwing fails the install, so the worker already running keeps running, from the
            // cache it already has. That is the whole of "an update that cannot be fetched properly
            // changes nothing" — an expired session, a gate outage, a captive portal. The next
            // check tries again. A cache this install created is removed; one that already existed
            // under this name keeps the entries that were rewritten into it (see `existed` above).
            if (!existed) await caches.delete(CACHE);
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
        await Promise.all(keys
            .filter((k) => k !== CACHE && k !== DATA_CACHE)
            .map((k) => caches.delete(k)));
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
    //
    // The owner gate's own routes go the same way, and for the second reason above with higher
    // stakes: /_gate/start and /_gate/callback ARE navigations. Answered with the cached shell, the
    // round trip to m3 would never start, or would never finish — the code in the callback's query
    // would reach nobody, and "sign in again" would reload the app still signed out. So both
    // prefixes are let through here, before the navigation fallback can see them.
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return;
    if (url.pathname.startsWith('/_gate/')) return;

    // The calibration corpus, on first use. It is not precached (see gen-sw.mjs), so this is
    // what makes the CALIBRATION tab work offline for the build that has it: fetch once, keep it,
    // serve it from disk every time after. A failed fetch is left to fail — the tab's own loader
    // already says so, and an empty 200 cached here would be a corpus that is silently wrong.
    if (url.pathname.startsWith('/data/')) {
        event.respondWith((async () => {
            const cache = await caches.open(DATA_CACHE);
            const hit = await cache.match(request);
            if (hit) return hit;
            const response = await fetch(request);
            // The same test the precache applies: a gate's 401 or a redirect towards m3 is not
            // the corpus, and a copy of it kept here would be served as the corpus from then on.
            if (!unfit(response, url.pathname)) event.waitUntil(cache.put(request, response.clone()));
            return response;
        })());
        return;
    }

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
            // Offline, or the network answered with something that is not the app — behind the
            // owner gate an expired session is a redirect towards m3 (opaqueredirect here), and a
            // gate that cannot reach m3 is a 503. Holding only a poisoned shell, the poisoned
            // shell is still the app: re-wrapping it is the difference between the tool opening
            // and a sign-in page or the browser's error page. With no shell at all, the network's
            // answer is the only one there is — that is how a first visit reaches m3.
            const shell = async () => new Response(await cached.blob(), {
                status: 200, statusText: 'OK', headers: cached.headers,
            });
            let response;
            try {
                response = await fetch(request);
            } catch {
                if (cached) return shell();
                throw new Error('offline and no cached shell');
            }
            if (cached && (response.type === 'opaqueredirect' || response.status < 200 || response.status > 299)) {
                return shell();
            }
            return response;
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
