'use client';

import { useEffect, useSyncExternalStore } from 'react';

/**
 * Whether this is a preview build rather than production.
 *
 * Read from a `<meta name="app-variant">` that `scripts/brand-preview.mjs` injects into the export.
 * Deliberately NOT a compiled constant or an env var: both deployments come out of the same
 * `next build`, so anything baked at compile time would have to be baked differently per target and
 * the variant would end up with two definitions to keep in step. The branding script already owns
 * the name; it owns this too.
 *
 * ## Why a hook and not a module constant
 *
 * The obvious `export const isPreviewBuild = document.querySelector(...)` is wrong, and quietly:
 * it evaluates to false during the static prerender and true on the client, so the hydrating render
 * disagrees with the markup it is hydrating. `getServerSnapshot` is the API for exactly this — the
 * prerender answers "production", the client answers truthfully, and React reconciles the two
 * without a mismatch. (The same reasoning as useInstallPrompt.)
 *
 * Nothing to subscribe to: the tag cannot change while the document is alive.
 */
const subscribeNever = () => () => { };

const readVariant = () =>
    document.querySelector('meta[name="app-variant"]')?.getAttribute('content') === 'preview';

export function useIsPreviewBuild(): boolean {
    return useSyncExternalStore(subscribeNever, readVariant, () => false);
}

/**
 * Keeps the document title on the preview name.
 *
 * The branding script rewrites `<title>` in the exported HTML, and that is not enough: Next applies
 * its own compiled metadata on the client during hydration and puts the production name straight
 * back. Measured — the tab read `MSS54HP CSL CONVERT /// TUNER` on a build whose HTML said
 * PREVIEW. So the name has to be reasserted after that has happened.
 *
 * An observer rather than a one-shot assignment, because "after that has happened" is not a moment
 * this can know. Next may re-apply metadata again later, and a title that reverts some time after
 * load is worse than one that never changed — it looks like the wrong build got deployed.
 *
 * Cheap: the observer only ever sees writes to one element, and it stops as soon as the title
 * already agrees.
 */
export function usePreviewTitle(): void {
    const preview = useIsPreviewBuild();
    useEffect(() => {
        if (!preview) return;
        const el = document.querySelector('title');
        if (!el) return;
        const wanted = el.dataset.previewTitle ?? el.textContent ?? '';
        if (!wanted) return;
        // Remembered on the node itself: by the time Next has overwritten the text, the value the
        // branding script wrote is gone, and there would be nothing left to restore.
        el.dataset.previewTitle = wanted;

        const enforce = () => { if (document.title !== wanted) document.title = wanted; };
        enforce();
        const observer = new MutationObserver(enforce);
        observer.observe(el, { childList: true, characterData: true, subtree: true });
        return () => observer.disconnect();
    }, [preview]);
}
