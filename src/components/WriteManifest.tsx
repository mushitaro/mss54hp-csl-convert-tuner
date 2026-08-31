import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { Info, X } from 'lucide-react';
import { armedLabels, type ManifestGroup, type ManifestRow } from '@/lib/writeManifest';

export { armedLabels, anythingArmed } from '@/lib/writeManifest';
export type { ManifestGroup, ManifestRow } from '@/lib/writeManifest';

/**
 * The hub's WRITE / RESTORE / PATCH groups — collapsed by default, each opening its own menu.
 *
 * What the next artifact contains used to be spread across two wing rows, one ARM button inside a
 * panel, and a VE map written unconditionally whenever it existed. Then it became one always-open
 * list, which is worse in the place it lives: the hub is read at arm's length in a car, and a
 * fifteen-row list under it is not read at all.
 *
 * So each group is one wing row — its name, and beneath it the names of whatever is armed. Tap to
 * open its menu of toggles; the summary answers "what will the next write contain" without opening
 * anything. Nothing armed, nothing listed, and the central ring's WRITE stays unpressable.
 *
 * ## Where the values come from
 *
 * Every number here is a ///M token rather than a chosen one, and the ones that look arbitrary are
 * the ones that are not:
 *
 *   - Row height `h-7`, wing gap `gap-[18px]` — the sizing system's toggle-row pair, so these read
 *     as one grid with the switches they replaced.
 *   - Panel `w-[280px]` with `max-h-[453px]` — 280 x 1.618. φ is the shape of a window too, and a
 *     `max-h-[…vh]` that fires on every screen means the height was never chosen; the viewport
 *     clamp sits underneath it, for a short screen only.
 *   - Panel `p-4`, and **no border**: `slate-900` on a `slate-950` page plus `shadow-xl` already
 *     say "different thing" twice, and a third device reads as a box drawn around the content
 *     rather than as depth. One device per edge.
 *   - Close `X` at `w-4 h-4`, the icon scale's size for a popover close.
 *   - Group titles and row labels are chrome — bold, uppercase, tracked. The summary is the
 *     micro-label token. Only the cell counts are mono, because only they are read off the data.
 *
 * Presentation only. Every fact on a row — armed, derivable, cell counts, lock reasons — is
 * computed by the page, which owns that state anyway; a second computation here would be a second
 * chance to disagree with what buildPatchedBuffer actually does.
 */

const STATUS_TONE: Record<NonNullable<ManifestRow['statusTone']>, string> = {
    ok: 'text-emerald-400/90',
    warn: 'text-amber-500',
    danger: 'text-red-400/80',
    muted: 'text-slate-600',
};

/**
 * One row: its name, the table it names (RESTORE only), a switch, a status, and an ⓘ.
 *
 * ## Why the explanation moved behind an ⓘ
 *
 * It used to render inline whenever a toggle was disabled, on the argument that touch has no hover
 * and a control that will not move without saying why is the one that gets reported as broken. That
 * argument was right about the PROBLEM and wrong about the fix. Written out, the reasons are
 * paragraphs — the WOT FUEL one is eighteen lambda figures long — and three locked rows turned the
 * menu into a wall of prose with the switches lost inside it, on a panel read at arm's length in a
 * car (operator, 2026-08-26).
 *
 * The original concern is kept by the ICON rather than by the text: on a locked row the ⓘ is BLUE,
 * which is this app's "there is something here" colour, so the row still advertises that it has a
 * reason without spending the panel on it. And every row with anything to say now has one, not just
 * the locked ones — TRIM STORE's good news is the licence the two derivations above it are written
 * on, and a licence that only speaks when it refuses is not one anybody can check.
 *
 * The `title` stays as well. It costs nothing and it is the desktop reading of the same sentence.
 */
const MenuRow: React.FC<{ row: ManifestRow; busy: boolean }> = ({ row, busy }) => {
    const [open, setOpen] = useState(false);
    const locked = row.kind === 'toggle' && !!row.disabled;
    return (
    <div title={row.lockReason}>
        {/* Three columns, and the middle one is why: `1fr auto 1fr` puts the switch on the panel's
            centre line whatever the label and the status weigh — the same reason the hub cluster
            is a grid rather than a flex row, and `minmax(0,1fr)` for the same reason it uses that:
            a plain `1fr` column cannot shrink below its own content, so the widest row quietly
            drags the switch off centre (measured 3px, consistently, before this). A switch on the left edge is a switch for a left
            thumb; on the centre line either thumb reaches it without regripping, which is the
            point when this is opened one-handed beside a running car.

            The label stays LEFT-aligned in its column so the heads line up down the list rather
            than the tails — a centred label block gives the eye nothing to read down. */}
        <div className={`h-7 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 ${row.kind === 'toggle' && row.disabled ? 'opacity-40' : ''}`}>
            <span className="min-w-0 flex items-center gap-1">
                <span className={`truncate text-[10px] font-bold tracking-widest uppercase ${row.kind === 'toggle' && row.checked && !row.disabled ? 'text-blue-400' : 'text-slate-500'}`}>
                    {row.label}
                </span>
                {row.lockReason && (
                    /* `p-2 -m-2` grows the hit box to 28x28 without moving the glyph — the same
                       trick the switch uses, for the same reason: this is tapped in a car, and the
                       bare 12px glyph measured 20x20 with `p-1`. 28 is the row height, so it is as
                       large as it can be without two rows stealing each other's taps. */
                    <button
                        type="button"
                        onClick={() => setOpen(o => !o)}
                        aria-expanded={open}
                        aria-label={row.infoLabel ?? 'Info'}
                        className={`shrink-0 p-2 -m-2 rounded transition-colors ${open ? 'text-blue-400'
                            : locked ? 'text-blue-400/70 hover:text-blue-400'
                                : 'text-slate-700 hover:text-slate-400'}`}
                    >
                        <Info className="w-3 h-3" />
                    </button>
                )}
            </span>

            {row.kind === 'toggle' ? (
                /* `px-3 -mx-3 py-2 -my-2`: the hit box grows to ~60x36 while the pill does not
                   move — padding cancelled by an equal negative margin, symmetric so a centred
                   element stays centred. The bare 36x20 pill is below what a finger can hit in a
                   car, and rows this close together would otherwise steal each other's taps.
                   `relative` sits on the PILL, not on this label: the knob is positioned against
                   its nearest positioned ancestor, and padding here would let it slide out. */
                <label className={`justify-self-center inline-flex items-center px-3 -mx-3 py-2 -my-2 ${row.disabled ? 'cursor-not-allowed' : 'cursor-pointer'}`}>
                    <input type="checkbox" className="sr-only peer" checked={!!row.checked && !row.disabled}
                        disabled={!!row.disabled || busy} onChange={(e) => row.onToggle?.(e.target.checked)} />
                    <div className="relative w-9 h-5 rounded-full bg-slate-800 peer-checked:bg-blue-900
                        after:content-[''] after:absolute after:top-[2px] after:left-[2px]
                        after:h-4 after:w-4 after:rounded-full after:bg-slate-400 after:border after:border-gray-500
                        after:transition peer-checked:after:translate-x-full peer-checked:after:bg-blue-400"></div>
                </label>
            ) : (
                /* Sealed / informational / readout rows hold the switch's column so the three
                   columns stay one grid, and render a tiny tag instead of a control — a
                   toggle-shaped thing that never toggles reads as broken. */
                <span className="justify-self-center w-9 text-center text-[8px] font-bold tracking-widest uppercase text-slate-600 select-none">
                    {row.kind === 'sealed' ? 'seal' : '—'}
                </span>
            )}

            {/* Mono: a cell count and a drift mark are read off the data, not app furniture. */}
            <span className={`justify-self-end truncate text-[10px] font-mono ${STATUS_TONE[row.statusTone ?? 'muted']}`}>
                {row.status ?? ''}
            </span>
        </div>
        {/* The table this row puts back, in the ECU's own vocabulary. Always on, and above the
            explanation: the identity of a row is not something the ⓘ should have to be opened for. */}
        {row.symbol && (
            <p className="pb-1 text-[9px] leading-[12px] font-mono text-slate-600">{row.symbol}</p>
        )}
        {/* Prose, so sans, and `whitespace-pre-line` because the WOT FUEL reason is two paragraphs
            and reads as one wall without its own break. Aligned to the label column. */}
        {open && row.lockReason && (
            <p className="pb-2 text-[9px] leading-[13px] text-slate-500 whitespace-pre-line">{row.lockReason}</p>
        )}
    </div>
    );
};

/**
 * Where a menu goes on the desk, and why it is measured instead of declared.
 *
 * The panel is portalled to the body (see MenuPortal), so no CSS can position it against the word
 * that opened it — there is no shared containing block left to position in. On a phone that costs
 * nothing, because the sheet belongs at the bottom of the viewport whatever opened it. On the desk
 * the same rule put the panel at the centre of the SCREEN, which is the middle of the MAP column,
 * half a screen from the word that was tapped (operator, 2026-08-31).
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
function useAnchoredMenu() {
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
 * The convex arc of a wing: ends near the ring, middles pushed out, mirrored on the other side.
 * It read 1-8-8-1 when each side carried four rows. It is the cluster's shape, not decoration —
 * the dial is supposed to sit inside a curve of its own modifiers.
 */
const INSETS: Record<'left' | 'right', string[]> = {
    left: ['mr-1', 'mr-8 pr-1'],
    right: ['ml-1', 'ml-8 pl-1'],
};

const Group: React.FC<{ group: ManifestGroup; busy: boolean; align: 'left' | 'right'; inset: string }> =
    ({ group, busy, align, inset }) => {
        const { triggerRef, open, anchor, toggle, close } = useAnchoredMenu();
        const armed = armedLabels(group);

        return (
            <div className={`relative ${inset}`}>
                <button
                    ref={triggerRef}
                    onClick={toggle}
                    className={`flex flex-col gap-1 group/row cursor-pointer ${align === 'left' ? 'items-end' : 'items-start'}`}
                >
                    {/* A reserved slot ABOVE the title as well as below it, and it is not padding.
                        The wing is centred on the dial as a block, so a title with a summary only
                        underneath rides half the summary's height above the ring's centre line —
                        measured at 6.5px, which is exactly enough to read as misaligned. Matching
                        slots put the TITLE on the centre line, which is what the eye lines up. */}
                    <span aria-hidden className="h-[12px]" />
                    {/* h-7 — the toggle-row height. These sit where switches used to, and the wing
                        has to keep reading as one grid with the rest of the app. */}
                    <span className={`h-7 flex items-center text-[10px] font-bold tracking-widest uppercase transition-colors whitespace-nowrap ${armed.length ? 'text-blue-400' : 'text-slate-500 group-hover/row:text-slate-300'}`}>
                        {group.title}
                    </span>
                    {/* The summary, as the micro-label token. A reserved slot whether or not it says
                        anything, so arming a table cannot reflow the cluster the dial is centred in. */}
                    <span className="h-[12px] max-w-[180px] truncate text-[9px] leading-[12px] font-mono uppercase tracking-wider text-slate-600">
                        {armed.join(' · ')}
                    </span>
                </button>

                {open && createPortal(<MenuPortal group={group} busy={busy} anchor={anchor} onClose={close} />, document.body)}
            </div>
        );
    };

const MenuPortal: React.FC<{ group: ManifestGroup; busy: boolean; onClose: () => void; anchor: DOMRect | null }> =
    ({ group, busy, onClose, anchor }) => {
        // Subscribed rather than read once, so crossing the breakpoint with a menu open re-lays it
        // out instead of stranding a desk panel on a phone's bottom edge.
        const desk = useSyncExternalStore(subscribeDesk, isDeskNow, isDeskOnServer);
        const at = desk ? anchor : null;
        return (
                    <>
                        <div className="fixed inset-0 z-40" onClick={onClose} />
                        {/* PORTALLED TO THE BODY, and that is not a detail.
                            The hub cluster carries `transform: scale(clusterScale)` for the auto-fit,
                            and a transformed ancestor becomes the containing block for `fixed`
                            descendants — so a "viewport-pinned" sheet rendered in place is pinned to
                            the CLUSTER instead, scaled down with the dial and clipped by the panel's
                            own overflow. Measured: it came out at the dial's scale with its top and
                            bottom cut off. Only leaving the transformed subtree fixes it; `max-h`
                            cannot, because the box was never the problem — the containing block is.

                            A viewport sheet on the phone, where the sheet IS the shape. The desk
                            used to take the same sheet and centre it, which put the panel over the
                            MAP column — the trigger sits beside the dial in the RIGHT column, and
                            the centre of the screen is not near it. So the desk measures the word
                            and hangs the panel off it: see anchoredStyle. */}
                        <div
                            style={at ? anchoredStyle(at) : undefined}
                            className={`fixed overflow-y-auto overscroll-contain
                            bg-slate-900 rounded-lg shadow-xl z-50 p-4
                            animate-in fade-in zoom-in-95 duration-200 text-left
                            ${at ? '' : 'inset-x-3 bottom-[60px] max-h-[calc(100svh-72px)]'}`}>
                            <div className="flex items-start justify-between border-b border-slate-800 pb-2 mb-2">
                                <div className="min-w-0">
                                    <div className="text-[10px] font-bold tracking-widest uppercase text-slate-300">{group.title}</div>
                                    <div className="text-[9px] text-slate-600">{group.caption}</div>
                                </div>
                                <button onClick={onClose} className="p-1 -m-1 text-slate-600 hover:text-slate-300 shrink-0">
                                    <X className="w-4 h-4" />
                                </button>
                            </div>
                            <div className="space-y-1">
                                {group.rows.map(row => <MenuRow key={row.id} row={row} busy={busy} />)}
                            </div>
                        </div>
                    </>
        );
    };

/**
 * A group that does NOT flank the dial: one line, in a corner, for something used a few times a
 * year rather than every flash. No reserved summary slot beneath it — that slot exists to stop a
 * wing reflowing the cluster, and nothing here is beside the cluster. The armed names run inline
 * after the title instead.
 */
export const ManifestCorner: React.FC<{ group: ManifestGroup; busy: boolean }> = ({ group, busy }) => {
    const { triggerRef, open, anchor, toggle, close } = useAnchoredMenu();
    const armed = armedLabels(group);
    return (
        <div className="relative">
            <button ref={triggerRef} onClick={toggle} className="h-7 flex items-center gap-2 cursor-pointer group/row">
                {/* Deliberately a step quieter than a wing title: the tiny-tag size rather than the
                    control-label size, and the dimmer label grey. It is reachable, not prominent —
                    a handful of uses a year against the wings' every campaign. */}
                <span className={`text-[8px] font-bold tracking-widest uppercase transition-colors whitespace-nowrap ${armed.length ? 'text-blue-400' : 'text-slate-600 group-hover/row:text-slate-400'}`}>
                    {group.title}
                </span>
                {armed.length > 0 && (
                    <span className="max-w-[180px] truncate text-[9px] font-mono uppercase tracking-wider text-slate-600">
                        {armed.join(' · ')}
                    </span>
                )}
            </button>
            {open && createPortal(<MenuPortal group={group} busy={busy} anchor={anchor} onClose={close} />, document.body)}
        </div>
    );
};

export const WriteManifest: React.FC<{
    groups: ManifestGroup[]; busy: boolean; align: 'left' | 'right';
    /**
     * Empty rows appended to this wing, so the two wings come out the same height.
     *
     * The grid centres each wing, so a one-row wing beside a two-row wing puts its single row half
     * a row above the other's first — and the pair that flanks the dial stops being level. A
     * reserved row fixes that, and it has to be a REAL one in the flow: the cluster is inside an
     * `overflow-hidden` box whose scale is measured from this subtree's natural size, so anything
     * positioned out of flow is both unmeasured and clipped. That is the same trap the hub's
     * sub-action row records.
     */
    trailingSpacers?: number;
}> = ({ groups, busy, align, trailingSpacers = 0 }) => (
    <div className={`flex flex-col gap-[18px] ${align === 'left' ? 'items-end' : 'items-start'}`}>
        {groups.map((g, i) => (
            <Group key={g.id} group={g} busy={busy} align={align}
                // Ends near, middles far. With one or two rows every row is an end, which is what
                // keeps the flanking pair level rather than fanned.
                inset={INSETS[align][i === 0 || i === groups.length - 1 ? 0 : 1]} />
        ))}
        {Array.from({ length: trailingSpacers }).map((_, i) => (
            // The row's own shape, made invisible — so the reserved height tracks the real row
            // instead of a number copied from it that goes stale the first time the row changes.
            <div key={`spacer-${i}`} aria-hidden className={`invisible flex flex-col gap-1 ${INSETS[align][0]}`}>
                <span className="h-[12px]">&nbsp;</span>
                <span className="h-7 flex items-center text-[10px] font-bold tracking-widest uppercase">&nbsp;</span>
                <span className="h-[12px] text-[9px] leading-[12px] font-mono">&nbsp;</span>
            </div>
        ))}
    </div>
);
