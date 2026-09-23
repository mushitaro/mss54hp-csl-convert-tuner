import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

/**
 * The app's one popover: a viewport sheet on the phone, a panel hung off the word on the desk.
 *
 * Extracted from WriteManifest, which built it for the hub's WRITE / RESTORE / PATCH groups and is
 * still its largest user. It moved here the moment a SECOND corner of the hub needed the same
 * shape (MODE, opposite RESTORE): the placement rules below are the ones that took two rounds of
 * measurement to get right — a transformed ancestor stealing the containing block, and a centred
 * desk panel landing half a screen from the word that opened it — and a second copy of them is a
 * second chance to get either wrong.
 *
 * ## Where the values come from
 *
 * Every number is a ///M token rather than a chosen one:
 *
 *   - Panel `w-[280px]` with `max-h-[453px]` — 280 x 1.618. φ is the shape of a window too, and a
 *     `max-h-[…vh]` that fires on every screen means the height was never chosen; the viewport
 *     clamp sits underneath it, for a short screen only.
 *   - Panel `p-4`, and **no border**: `slate-900` on a `slate-950` page plus `shadow-xl` already
 *     say "different thing" twice, and a third device reads as a box drawn around the content
 *     rather than as depth. One device per edge.
 *   - Close `X` at `w-4 h-4`, the icon scale's size for a popover close.
 */

/**
 * Where a menu goes on the desk, and why it is measured instead of declared.
 *
 * The panel is portalled to the body (see AnchoredSheet), so no CSS can position it against the
 * word that opened it — there is no shared containing block left to position in. On a phone that
 * costs nothing, because the sheet belongs at the bottom of the viewport whatever opened it. On the
 * desk the same rule put the panel at the centre of the SCREEN, which is the middle of the MAP
 * column, half a screen from the word that was tapped (operator, 2026-08-31).
 *
 * So the desk measures. The trigger's rect is taken in the click handler and turned into
 * left / width / top-or-bottom here: centred on the word, above it when that side has more room
 * than below, and clamped EDGE from every side. The panel takes whatever height that side has and
 * scrolls the rest — a menu that is anchored to a word and then covers it is not anchored to
 * anything the reader can still see.
 */
const PANEL_W = 280;
/** 280 x 1.618 — the shape the panel was designed at, and the ceiling the room below is capped to. */
const PANEL_MAX_H = 453;
/** Below this the panel is a scroll slit rather than a menu, so it overlaps the word instead. */
const PANEL_MIN_H = 160;
const GAP = 8;
const EDGE = 12;

function anchoredStyle(rect: DOMRect): React.CSSProperties {
    const left = Math.min(
        Math.max(rect.left + rect.width / 2 - PANEL_W / 2, EDGE),
        Math.max(EDGE, window.innerWidth - PANEL_W - EDGE));
    const above = rect.top - GAP - EDGE;
    const below = window.innerHeight - rect.bottom - GAP - EDGE;
    const up = above >= below;
    const maxHeight = Math.min(PANEL_MAX_H, Math.max(PANEL_MIN_H, up ? above : below));
    // `bottom` for the upward case rather than a computed `top`: the panel then grows away from the
    // word as its content does, instead of sliding over it.
    return up
        ? { left, width: PANEL_W, maxHeight, bottom: window.innerHeight - rect.top + GAP }
        : { left, width: PANEL_W, maxHeight, top: rect.bottom + GAP };
}

/** The breakpoint the whole app splits on, subscribed rather than read once. */
const DESK = '(min-width: 900px)';
const subscribeDesk = (onChange: () => void) => {
    const m = window.matchMedia(DESK);
    m.addEventListener('change', onChange);
    return () => m.removeEventListener('change', onChange);
};
const isDeskNow = () => window.matchMedia(DESK).matches;
const isDeskOnServer = () => false;

/**
 * One menu's open state and the rect it hangs off.
 *
 * The rect is taken in the CLICK and not in an effect. An effect would have to measure and then set
 * state synchronously, which `react-hooks/set-state-in-effect` forbids; the listeners below set
 * state from their own callbacks, which is a different thing and is allowed.
 */
export function useAnchoredMenu() {
    const triggerRef = useRef<HTMLButtonElement>(null);
    const [open, setOpen] = useState(false);
    const [anchor, setAnchor] = useState<DOMRect | null>(null);

    useEffect(() => {
        if (!open) return;
        const remeasure = () => setAnchor(triggerRef.current?.getBoundingClientRect() ?? null);
        window.addEventListener('resize', remeasure);
        // Capture phase: the cluster sits inside scroll containers that do not bubble `scroll` to
        // the window, and an anchor that goes stale on a scroll is worse than no anchor.
        window.addEventListener('scroll', remeasure, true);
        return () => {
            window.removeEventListener('resize', remeasure);
            window.removeEventListener('scroll', remeasure, true);
        };
    }, [open]);

    const close = () => { setOpen(false); setAnchor(null); };
    const toggle = () => {
        if (open) { close(); return; }
        setAnchor(triggerRef.current?.getBoundingClientRect() ?? null);
        setOpen(true);
    };
    return { triggerRef, open, anchor, toggle, close };
}

/**
 * The sheet itself: scrim, panel, and the title/caption/close header every menu here wears.
 *
 * PORTALLED TO THE BODY, and that is not a detail. The hub cluster carries
 * `transform: scale(clusterScale)` for the auto-fit, and a transformed ancestor becomes the
 * containing block for `fixed` descendants — so a "viewport-pinned" sheet rendered in place is
 * pinned to the CLUSTER instead, scaled down with the dial and clipped by the panel's own overflow.
 * Measured: it came out at the dial's scale with its top and bottom cut off. Only leaving the
 * transformed subtree fixes it; `max-h` cannot, because the box was never the problem — the
 * containing block is.
 */
export const AnchoredSheet: React.FC<{
    title: string;
    caption?: string;
    anchor: DOMRect | null;
    onClose: () => void;
    children: React.ReactNode;
}> = ({ title, caption, anchor, onClose, children }) => {
    // Subscribed rather than read once, so crossing the breakpoint with a menu open re-lays it
    // out instead of stranding a desk panel on a phone's bottom edge.
    const desk = useSyncExternalStore(subscribeDesk, isDeskNow, isDeskOnServer);
    const at = desk ? anchor : null;
    return createPortal(
        <>
            <div className="fixed inset-0 z-40" onClick={onClose} />
            <div
                style={at ? anchoredStyle(at) : undefined}
                className={`fixed overflow-y-auto overscroll-contain
                bg-slate-900 rounded-lg shadow-xl z-50 p-4
                animate-in fade-in zoom-in-95 duration-200 text-left
                ${at ? '' : 'inset-x-3 bottom-[60px] max-h-[calc(100svh-72px)]'}`}>
                <div className="flex items-start justify-between border-b border-slate-800 pb-2 mb-2">
                    <div className="min-w-0">
                        <div className="text-[10px] font-bold tracking-widest uppercase text-slate-300">{title}</div>
                        {caption && <div className="text-[9px] text-slate-600">{caption}</div>}
                    </div>
                    <button onClick={onClose} className="p-1 -m-1 text-slate-600 hover:text-slate-300 shrink-0">
                        <X className="w-4 h-4" />
                    </button>
                </div>
                {children}
            </div>
        </>,
        document.body,
    );
};
