'use client';

import { useCallback, useSyncExternalStore } from 'react';

/**
 * How large the VE grid draws itself, remembered between launches.
 *
 * The grid's cells are a fixed 50px because `table-fixed` needs a stated width — that is what keeps
 * a 480-cell table off the automatic-layout path that cost 6.9s the first time it painted. Fixed is
 * right; fixed at one number for every screen is not. On the head unit the grid is read at arm's
 * length, sometimes moving, and 12px numerals are not always the right 12px numerals.
 *
 * Persisted, because the alternative is setting it again at the start of every drive. `localStorage`
 * rather than the session database for the same reason `useDisclaimer` uses it: this is one number
 * about this browser, not part of a tune, and it must be readable synchronously.
 *
 * Read through `useSyncExternalStore` for the same reason `useWideLayout` is — storage is an
 * external store, and subscribing to it properly is both the honest description and the one that
 * does not set state from inside an effect.
 */
const STORAGE_KEY = 'e46m3csl:map-zoom';

/** 1 is the size the grid has always been; the range is what stays legible at either end. */
export const ZOOM_MIN = 0.6;
export const ZOOM_MAX = 1.6;
const ZOOM_STEP = 0.2;

const clamp = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 10) / 10));

/** Same-tab writes need their own channel: `storage` only fires in the *other* tabs. */
const listeners = new Set<() => void>();
function subscribe(onChange: () => void) {
    listeners.add(onChange);
    window.addEventListener('storage', onChange);
    return () => { listeners.delete(onChange); window.removeEventListener('storage', onChange); };
}

/** Returns a number, so repeated calls compare equal and cannot loop the store. */
function read(): number {
    try {
        const stored = parseFloat(localStorage.getItem(STORAGE_KEY) ?? '');
        return Number.isFinite(stored) ? clamp(stored) : 1;
    } catch {
        return 1;   // private mode, or no storage at all
    }
}

export function useMapZoom() {
    // Server snapshot 1: the prerendered HTML has no storage to read, and 1 is the size the grid
    // has always been, so the first paint is never wrong in a way anyone can see.
    const zoom = useSyncExternalStore(subscribe, read, () => 1);

    const nudge = useCallback((direction: 1 | -1) => {
        const next = clamp(read() + direction * ZOOM_STEP);
        try { localStorage.setItem(STORAGE_KEY, String(next)); } catch { /* nothing to do */ }
        listeners.forEach(l => l());
    }, []);

    return { zoom, nudge, atMin: zoom <= ZOOM_MIN, atMax: zoom >= ZOOM_MAX };
}
