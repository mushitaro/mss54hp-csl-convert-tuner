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
const WIDE = '(min-width: 900px)';

/**
 * Narrow enough for one pane at a time AND too short to stack the picture above the controls.
 *
 * This, not the width alone, is what makes GRAPH a destination of its own. The split exists to
 * settle a fight over vertical pixels: at 851x393 the 3D view was down to 48px because the control
 * panel needed 244 of the 301 the pane had. Where the height is there, nothing is fighting —
 * measured at 360x800 the stacked layout gives the surface 431px *and* the panel its full 268, with
 * no scrolling. Splitting that costs a tap and buys nothing.
 *
 * 560px is not a new number: it is the threshold the visualiser's own floor already switches on.
 *
 * The same query is written out as a Tailwind variant at the three places that need it in CSS
 * (`SPLIT_ONLY_*` in page.tsx). Keep them identical — a viewport that matches one and not the other
 * can reach a destination that is not there.
 */
const SPLIT = '(max-width: 899px) and (max-height: 560px)';

const subscriber = (query: string) => (onChange: () => void) => {
    const mq = window.matchMedia(query);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
};
const subscribeWide = subscriber(WIDE);
const subscribeSplit = subscriber(SPLIT);

export function useWideLayout(): boolean {
    return useSyncExternalStore(
        subscribeWide,
        () => window.matchMedia(WIDE).matches,
        () => true,
    );
}

/** Server snapshot `false` for the same reason `useWideLayout` is `true`: both describe the stacked
 *  layout, which is what the markup renders before anything has been measured. */
export function useSplitGraph(): boolean {
    return useSyncExternalStore(
        subscribeSplit,
        () => window.matchMedia(SPLIT).matches,
        () => false,
    );
}
