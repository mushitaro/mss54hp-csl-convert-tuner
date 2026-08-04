'use client';

import { useEffect } from 'react';

/**
 * Registers the service worker that makes the tool work with no network.
 *
 * This exists because of where the tool is actually used: launched from the M
 * console of a head unit, in a garage, on WiFi that may or may not reach. With
 * no worker registered the app is a web page, and a web page with no network is
 * a blank screen — which is the one state a diagnostic instrument must not have.
 *
 * Renders nothing. It is mounted in the root layout purely so that the effect
 * runs once, on the client, after hydration.
 */
export function OfflineCache() {
    useEffect(() => {
        // `next dev` never produces out/sw.js — it is written by
        // scripts/gen-sw.mjs against the export — so registering in development
        // would only ever 404 and log a failure that means nothing.
        if (process.env.NODE_ENV !== 'production') return;
        if (!('serviceWorker' in navigator)) return;

        navigator.serviceWorker
            // `updateViaCache: 'none'` so the worker script itself is never
            // answered from the HTTP cache. Without it the browser may hand back
            // its own stored copy of sw.js when it checks for an update, and a
            // deploy can sit unnoticed behind a cached copy of the very file
            // whose job is to notice deploys.
            .register('/sw.js', { updateViaCache: 'none' })
            .catch((error) => {
                // Not silent. A registration that fails leaves the tool online-
                // only, and the symptom of that is a blank screen somewhere with
                // no signal — far away from anywhere this could be diagnosed.
                console.warn('[OfflineCache] service worker registration failed', error);
            });
    }, []);

    return null;
}
