'use client';

import { useSyncExternalStore } from 'react';

/**
 * Whether both panes are on screen at once — the same 900px the layout splits at.
 *
 * Needed in JS, not just CSS, because below it the two panes share one grid cell and the inactive
 * one is only `invisible`: it stays laid out, and anything mounted inside it keeps doing its work
 * where nobody can see it. For the 3D visualizer that was 366,561 vertices of WebGL surface rebuilt
 * on every tab change, behind a `visibility: hidden`.
 *
 * `useSyncExternalStore` rather than an effect + state so the first client render already has the
 * right answer instead of painting the wrong branch and correcting it. The server snapshot is
 * `true` — the wide layout is the one the markup has always described, and it renders nothing that
 * a narrow viewport then has to tear down.
 */
const QUERY = '(min-width: 900px)';

function subscribe(onChange: () => void) {
    const mq = window.matchMedia(QUERY);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
}

export function useWideLayout(): boolean {
    return useSyncExternalStore(
        subscribe,
        () => window.matchMedia(QUERY).matches,
        () => true,
    );
}
