/**
 * The owner gate, in front of everything this project serves.
 *
 * WORKS is handed to people who hold `owner_preview` on m3.tsunagi.app — MILE buyers and
 * the owners whose cars were worked on — and to nobody else. It used to be open to anyone with the
 * URL, and its store was guarded by a token baked into the very HTML it guarded. The gate itself
 * lives in `_owner-gate/` as a byte-for-byte copy of tsunagi-m3/tools/owner-gate; `npm run
 * gate:verify` fails when the copy drifts. Change it there, not here.
 *
 * `publicPaths` is what a browser fetches WITHOUT cookies: the manifest, and the icons it and the
 * document head name. Installing and updating a PWA reads those anonymously, and a 401 there reads
 * to Chrome as "this app has no icon". They are WORKS's own (dev) set, because
 * brand-preview.mjs points every reference at it — production's icons are never requested here.
 * Anything added to the manifest or the head has to be added here too, or it is served only to
 * signed-in pages. The one entry that is neither is `/.well-known/assetlinks.json`, for the head
 * unit's launcher — see its comment below.
 */
import { createGate } from './_owner-gate/gate';

export const onRequest = createGate({
    clientId: 'tuner-preview',
    canonicalHost: 'mss54hp-csl-convert-tuner-preview.pages.dev',
    name: 'MSS54HP CSL CONVERT /// TUNER — WORKS',
    publicPaths: [
        '/manifest.webmanifest',
        '/icons/mapping-dev-192.png',
        '/icons/mapping-dev-512.png',
        '/icons/mapping-dev-maskable-192.png',
        '/icons/mapping-dev-maskable-512.png',
        '/icons/mapping-dev-256.png',
        '/icons/mapping-dev-32.png',
        // Asked for by name, without a cookie, by iOS, link previews and bookmark rebuilds; the build
        // puts the dev twins here (brand-preview.mjs, gen-root-icons.mjs).
        '/favicon.ico',
        '/apple-touch-icon.png',
        '/apple-touch-icon-precomposed.png',
        // Read by Chrome, with no cookie, to decide whether TSUNAGI///Manifold (the head unit's
        // launcher, app.tsunagi.e46m3.launcher) may open this build as a full-screen Trusted Web
        // Activity. A 401 here is not an error Chrome reports anywhere: it shows its toolbar and
        // carries on, so the only symptom is an address bar on the car's screen. The file names one
        // package and one signing-certificate fingerprint, both already public (the production
        // build serves the same file, and the launcher's README prints the fingerprint).
        // Measured 401 here on 2026-10-28, before this line existed.
        '/.well-known/assetlinks.json',
    ],
});
