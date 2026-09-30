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

/**
 * Short enough that the menu sheet cannot stack its bands, and wide enough to stand them side by side.
 *
 * A third question rather than a reinterpretation of the two above: `SPLIT` asks whether the picture
 * and the control panel can share a pane; this asks whether the MENU SHEET can stack five bands. On a
 * 1024x600 head unit — about 683x400 CSS — the sheet is capped at 380px and its stacked content wants
 * ~450, so the whole sheet scrolled and VIEW was left sitting on its 88px floor: one and a half rows
 * of a list that needs 352 (8 tabs x 44). Side by side the same content fits with nothing scrolling.
 *
 * 560 is not a new number. It is the same short-viewport threshold the sheet already halves its
 * paddings on and the visualiser's floor already switches on. `orientation: landscape` rather than a
 * second width: the question is whether there is width to spend that the height has not got, and a
 * 360x380 split-screen window has neither. The sheet only exists below 900px (`min-[900px]:hidden`),
 * so no width bound belongs here.
 */
const SHORT_LANDSCAPE = '(max-height: 560px) and (orientation: landscape)';
const subscribeShortLandscape = subscriber(SHORT_LANDSCAPE);

/** Server snapshot `false`, for the same reason `useSplitGraph`'s is: the stacked sheet is what the
 *  markup has always described, and it is the arrangement a narrow-and-tall phone keeps. */
export function useShortLandscape(): boolean {
    return useSyncExternalStore(
        subscribeShortLandscape,
        () => window.matchMedia(SHORT_LANDSCAPE).matches,
        () => false,
    );
}
