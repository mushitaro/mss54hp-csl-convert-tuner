'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Scales a fixed-size cluster down until it fits the box it is in, and reports the floor it needs.
 *
 * Measures real available space against the content's natural size rather than estimating from the
 * viewport, so it fits on any screen instead of on the ones somebody thought of.
 *
 * `minScale` is a promise about the smallest a control may become, not a rounding limit. The hub
 * cluster passes 0.8 because 0.4 — its previous floor — put an 80px dial at 32px, the arming
 * toggles at 14x8, and the one label distinguishing READ from WRITE at 3.2px. On a short landscape
 * phone that is the normal case, not a rare worst case.
 */
/**
 * The container's own padding, which `availH` spends and the floor below has to buy back.
 *
 * One constant because the two uses are the same number by necessity: the floor is "the height at
 * which the cluster still fits", and it only fits if what is left after the padding is at least the
 * scaled cluster. Two literals let them drift, and drift here is the defect this names.
 */
const PAD = 12;

export function useFitScale(minScale = 0.5) {
    const outerRef = useRef<HTMLDivElement>(null);
    const innerRef = useRef<HTMLDivElement>(null);
    const [scale, setScale] = useState(1);
    const [naturalH, setNaturalH] = useState(0);

    useEffect(() => {
        const outer = outerRef.current;
        const inner = innerRef.current;
        if (!outer || !inner) return;

        const compute = () => {
            const naturalW = inner.offsetWidth;
            const naturalH = inner.offsetHeight;
            if (naturalW <= 0 || naturalH <= 0) return;
            // Published even while the box is collapsed — it's what floors the container (minH
            // below), so bailing out first would leave a zero-height box with no way back.
            setNaturalH(naturalH);

            const availW = outer.clientWidth - PAD;
            const availH = outer.clientHeight - PAD;
            if (availW <= 0 || availH <= 0) return;
            setScale(Math.max(minScale, Math.min(1, availW / naturalW, availH / naturalH)));
        };

        const ro = new ResizeObserver(compute);
        ro.observe(outer);
        ro.observe(inner);
        compute();
        return () => ro.disconnect();
    }, [minScale]);

    // Floor for the container = the smallest height at which the cluster STILL FITS. `overflow-
    // hidden` zeroes a flex item's automatic minimum size, so without this `flex-1` collapses the
    // box and clips the main button away entirely on short viewports. Independent of scale, so it
    // can't feed back into it.
    //
    // `+ PAD`, and it is the whole of the fix here. The floor used to be `naturalH * minScale`
    // alone — the size of the cluster at its smallest — while `availH` above spends `PAD` on the
    // container's padding before comparing. So at the floor the box offered 64 px, kept 52 for
    // content, and the cluster at its 0.8 limit needed 64: it overflowed by 12 and `overflow-hidden`
    // took 6 px off the top and 6 off the bottom of the dial. The progress ring, which is
    // `-inset-1` and 88 px, lost 18 px each side — measured, at a container forced to the published
    // floor. A floor that does not fit the thing it is a floor for is not a floor.
    return { outerRef, innerRef, scale, minH: naturalH * minScale + PAD };
}
