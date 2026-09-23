'use client';

import { useSyncExternalStore } from 'react';

/**
 * Whether this device currently has a network route.
 *
 * ## What it is worth, and what it is not
 *
 * `navigator.onLine` is a one-way signal. **False is reliable**: the interface is down, nothing is
 * going anywhere, and a control that tries is a control that wastes a tap. **True is a guess** — it
 * means a route exists, not that the deployment is reachable. A phone on a garage's captive wifi,
 * or holding one bar at the far end of a workshop, reports true and then times out.
 *
 * So it is used in exactly one direction: false disables the sync control and says why; true only
 * lets the attempt happen. Whether it actually worked is the request's answer, reported on the
 * control, never predicted here. Treating `true` as a promise would produce the worst version of
 * this — a button that claims the upload is possible and then fails with no explanation.
 *
 * ## Why useSyncExternalStore
 *
 * `navigator` does not exist during the static prerender, and `useState(navigator.onLine)` would
 * throw there. Seeding `false` instead trades the crash for a lie that renders: the exported HTML
 * would ship with the sync control disabled, and it would flip to enabled a frame after hydration —
 * visible, and exactly the "an element that appears must not move anything" problem the header
 * rules already call out.
 *
 * `getServerSnapshot` returns **true**, which is the assumption that fails safe. Prerendering
 * "online" and discovering otherwise disables a control; prerendering "offline" and discovering
 * otherwise enables one — and only the first of those matches what the markup was built for.
 * (Same shape as useInstallPrompt and lib/build-variant.)
 */
function subscribe(onChange: () => void): () => void {
    window.addEventListener('online', onChange);
    window.addEventListener('offline', onChange);
    return () => {
        window.removeEventListener('online', onChange);
        window.removeEventListener('offline', onChange);
    };
}

export function useOnline(): boolean {
    return useSyncExternalStore(subscribe, () => navigator.onLine, () => true);
}
