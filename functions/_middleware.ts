/**
 * The owner gate, in front of everything this project serves.
 *
 * The preview is handed to people who hold `owner_preview` on m3.tsunagi.app — MILE buyers and
 * the owners whose cars were worked on — and to nobody else. It used to be open to anyone with the
 * URL, and its store was guarded by a token baked into the very HTML it guarded. The gate itself
 * lives in `_owner-gate/` as a byte-for-byte copy of tsunagi-m3/tools/owner-gate; `npm run
 * gate:verify` fails when the copy drifts. Change it there, not here.
 *
 * `publicPaths` is what a browser fetches WITHOUT cookies: the manifest, and the icons it and the
 * document head name. Installing and updating a PWA reads those anonymously, and a 401 there reads
 * to Chrome as "this app has no icon". They are the preview's own (dev) set, because
 * brand-preview.mjs points every reference at it — production's icons are never requested here.
 * Anything added to the manifest or the head has to be added here too, or it is served only to
 * signed-in pages.
 */
import { createGate } from './_owner-gate/gate';

export const onRequest = createGate({
    clientId: 'tuner-preview',
    canonicalHost: 'mss54hp-csl-convert-tuner-preview.pages.dev',
    name: 'MSS54HP CSL CONVERT /// TUNER — PREVIEW',
    publicPaths: [
        '/manifest.webmanifest',
        '/icons/mapping-dev-192.png',
        '/icons/mapping-dev-512.png',
        '/icons/mapping-dev-maskable-192.png',
        '/icons/mapping-dev-maskable-512.png',
        '/icons/mapping-dev-256.png',
        '/icons/mapping-dev-32.png',
    ],
});
