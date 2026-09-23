'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Replaces a horizontally scrolling strip's scrollbar with a fade on whichever edge still has
 * content behind it.
 *
 * The bar had to go: it renders 10px tall inside a 44px row, directly under the active tab's 2px
 * underline, so the row read as two competing rules. A fade costs no height at all.
 *
 * Only the overflowing side fades. A permanent fade on both edges would say "there is more this
 * way" while scrolled hard against a stop, which is exactly when there isn't — and an indicator
 * that is always on communicates nothing. Nothing is lost in exchange: Chromium maps a vertical
 * wheel onto a container that only scrolls horizontally, and the tabs are real buttons, so Tab-key
 * focus scrolls them into view on its own.
 */
export function useEdgeFade(fadePx = 24) {
    const ref = useRef<HTMLDivElement>(null);
    const [edges, setEdges] = useState({ left: false, right: false });

    useEffect(() => {
        const el = ref.current;
        if (!el) return;

        const update = () => {
            // 1px of slack: fractional layout widths leave scrollLeft a hair short of the true
            // maximum, which would otherwise strand a fade on the right edge at the end of the
            // scroll.
            const max = el.scrollWidth - el.clientWidth;
            setEdges(prev => {
                const next = { left: el.scrollLeft > 1, right: el.scrollLeft < max - 1 };
                return prev.left === next.left && prev.right === next.right ? prev : next;
            });
        };

        update();
        el.addEventListener('scroll', update, { passive: true });
        // Covers the container getting narrower. It does NOT cover the content getting wider: the
        // strip is flex-1, so its own box is unchanged when what is inside it grows.
        const ro = new ResizeObserver(update);
        ro.observe(el);
        // Which is exactly what a webfont swap does. Tab labels are laid out in the fallback face
        // first, and Inter's metrics can push a strip that fit into one that overflows — with no
        // scroll, no resize and no DOM change to notice it by, leaving the right edge unfaded until
        // the user happens to scroll. `fonts` is undefined in jsdom-style environments, hence the
        // guard.
        document.fonts?.ready.then(update);
        // Insurance for the tab set itself changing. Today every tab is always rendered and only
        // its `disabled` attribute varies, so this never fires — it is here so that making a tab
        // conditional later does not silently strand the fades.
        const mo = new MutationObserver(update);
        mo.observe(el, { childList: true, subtree: true, characterData: true });

        return () => {
            el.removeEventListener('scroll', update);
            ro.disconnect();
            mo.disconnect();
        };
    }, []);

    const mask = `linear-gradient(to right, ${[
        edges.left ? `transparent 0, black ${fadePx}px` : 'black 0',
        edges.right ? `black calc(100% - ${fadePx}px), transparent 100%` : 'black 100%',
    ].join(', ')})`;

    return { ref, style: { maskImage: mask, WebkitMaskImage: mask } as React.CSSProperties };
}
