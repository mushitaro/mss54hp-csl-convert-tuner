'use client';

import React, { useEffect, useState } from 'react';
import { X, Cable, Gauge, Database, Download, Upload, FileSpreadsheet } from 'lucide-react';
import { DmeIdentity } from '@/lib/dme-link/types';

/**
 * Everything the header used to carry, for windows too narrow to carry it.
 *
 * Below 900px the header had four things competing for about 312px: the wordmark, the identity
 * strip (VIN/AIF/SW/FLASH), the tab row underneath it, and the session bar under that. The strip
 * resolved to zero and the session bar overflowed its own 26px — its BASE badge wrapped to two
 * lines and painted over the tab row above and the grid below.
 *
 * None of that is a sizing problem. There are four groups of things and one row to put them in, so
 * they go behind one control and the header keeps only what has to be glanceable while driving:
 * link state, which car, and which half of the app you are looking at.
 *
 * **Everything is ordered outward from the thumb.** The sheet opens from a button at the bottom
 * centre, so the lists run bottom-up — first entry nearest the button, last entry furthest — and
 * the close control sits at that same bottom centre, on the spot the finger is already touching.
 * Press, slide up, release: one gesture, no second aim. The interactive groups (VIEW, DOWNLOAD) are
 * nearest; the readouts that are only there to be read sit above them, out of the sweep.
 *
 * Deliberately NOT in here: anything that writes. WRITE, the arming toggles and START/STOP stay on
 * the dashboard where they are one tap apart and visible together — a menu that has to be opened
 * is the wrong place for a control whose state changes what goes into the ECU.
 */
interface Props {
    onClose: () => void;
    tabs: { id: string; label: string; enabled: boolean }[];
    activeTab: string;
    onSelectTab: (id: string) => void;
    identity: DmeIdentity | null;
    linkState: string;
    flashText: string;
    flashColor: string;
    flashEnabled: boolean;
    onOpenFlash: () => void;
    session: { label: string; archived: boolean } | null;
    /** Rendered by the caller so the badge logic stays in one place. */
    baseOrigin?: React.ReactNode;
    logName?: string;
    logPoints?: number;
    actions: {
        label: string;
        onClick: () => void;
        kind: 'bin' | 'save' | 'base' | 'log';
        hint: string;
    }[];
    /**
     * Where the press that opened this landed, while it is still down — so this mount can be the
     * middle of a drag rather than the end of a tap. The coordinates matter, not just the fact:
     * the close control sits on the same spot as the button that opens the sheet, so a press that
     * never moves would otherwise release onto Close and shut what it just opened. Only a press
     * that has travelled counts as a sweep.
     */
    dragFrom?: { x: number; y: number } | null;
}

const ICONS = { bin: Download, save: Database, base: Upload, log: FileSpreadsheet } as const;

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
    <div className="px-4 py-3 border-b border-slate-900">
        <h4 className="text-[9px] font-bold uppercase tracking-widest text-slate-600 mb-2">{title}</h4>
        {children}
    </div>
);

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
    <div className="flex items-baseline gap-3 py-1">
        <span className="w-16 shrink-0 text-[9px] uppercase tracking-widest text-slate-600">{label}</span>
        <span className="min-w-0 flex-1 font-mono text-[11px] text-slate-300 break-all">{children}</span>
    </div>
);

export const MobileMenu: React.FC<Props> = ({
    onClose, tabs, activeTab, onSelectTab, identity, linkState,
    flashText, flashColor, flashEnabled, onOpenFlash,
    session, baseOrigin, logName, logPoints, actions, dragFrom,
}) => {
    /** Which row the finger is currently over, keyed by the `data-menu-key` below. */
    const [hot, setHot] = useState<string | null>(null);
    useEffect(() => {
        if (!dragFrom) return;
        // 12px, about a millimetre of skin. Below it the press is a tap that happens to wobble.
        let moved = false;
        const travelled = (e: PointerEvent) =>
            moved || (moved = Math.hypot(e.clientX - dragFrom.x, e.clientY - dragFrom.y) > 12);
        // Hit-tested rather than tracked by listeners on each row: the press started on a different
        // element (the footer button), so it holds the implicit pointer capture and the rows never
        // see the move events at all.
        const at = (e: PointerEvent) => {
            const el = document.elementFromPoint(e.clientX, e.clientY);
            const row = el?.closest('[data-menu-key]') as HTMLElement | null;
            return row && row.dataset.menuDisabled !== 'true' ? row : null;
        };
        const move = (e: PointerEvent) => setHot(travelled(e) ? at(e)?.dataset.menuKey ?? null : null);
        const up = (e: PointerEvent) => {
            const row = travelled(e) ? at(e) : null;
            setHot(null);
            // Clicking the row rather than looking its handler up: the row already owns the handler
            // for the ordinary tap path, and one way in means the two cannot drift apart.
            // Released without travelling, or without reaching a row, leaves the sheet up — which is
            // what makes a plain tap open it to be read and tapped in the ordinary way.
            row?.click();
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up, { once: true });
        window.addEventListener('pointercancel', () => setHot(null), { once: true });
        return () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
        };
    }, [dragFrom]);

    /** Marks a row as drag-selectable. The key is only for the highlight; the handler stays on
     *  the element, where the tap path already reads it. */
    const row = (key: string, run: () => void, disabled = false) => ({
        'data-menu-key': key,
        'data-menu-disabled': disabled ? 'true' : undefined,
        onClick: run,
        disabled,
    } as const);

    const lit = (key: string) => (hot === key ? 'bg-slate-800' : '');

    return (
        <>
            <div className="fixed inset-0 z-[90] bg-slate-950/70 backdrop-blur-sm min-[900px]:hidden" onClick={onClose} />
            {/* Up from the bottom, not in from the side: it opens from a control on the footer, so it
                comes from where the finger already is. Capped at 85svh so the scrim above stays
                visible — the way out has to be on screen. */}
            <div className="fixed inset-x-0 bottom-0 z-[95] max-h-[85svh] flex flex-col bg-slate-900 border-t border-slate-800 rounded-t-xl min-[900px]:hidden touch-none">
                <div className="flex-1 overflow-y-auto overscroll-contain">
                    {/* Readouts first, i.e. furthest from the thumb. Nothing here is a sweep target. */}
                    {session && (
                        <Section title="Session">
                            <div className="flex items-center gap-2 mb-2 min-w-0">
                                <Cable className="w-3 h-3 shrink-0 text-slate-600" />
                                <span className="min-w-0 truncate text-[11px] font-bold tracking-widest uppercase text-slate-300">{session.label}</span>
                                {session.archived && <span className="shrink-0 text-[8px] uppercase tracking-widest text-slate-500">read-only</span>}
                            </div>
                            {baseOrigin && <div className="mb-1 flex items-center gap-2"><span className="text-[9px] uppercase tracking-widest text-slate-600">Base</span>{baseOrigin}</div>}
                            {logName && (
                                <div className="flex items-center gap-2 min-w-0">
                                    <span className="text-[9px] uppercase tracking-widest text-slate-600 shrink-0">Log</span>
                                    <span className="min-w-0 truncate font-mono text-[10px] text-slate-400">{logName}</span>
                                    {logPoints !== undefined && <span className="shrink-0 font-mono text-[10px] text-slate-600">{logPoints}pts</span>}
                                </div>
                            )}
                        </Section>
                    )}

                    <Section title="Vehicle">
                        <Field label="VIN">{identity?.vin ?? <span className="text-slate-600">{linkState === 'disconnected' ? 'not connected' : 'reading'}</span>}</Field>
                        <Field label="AIF">{identity?.aif ?? <span className="text-slate-600">—</span>}</Field>
                        <Field label="SW">{identity?.softwareVersion ?? <span className="text-slate-600">—</span>}</Field>
                        {/* Still a control, and still one step deeper than the number it changes. */}
                        <button
                            type="button"
                            {...row('flash', () => { onOpenFlash(); onClose(); }, !flashEnabled)}
                            className={`mt-1 w-full flex items-center gap-3 py-3 px-2 -mx-2 rounded text-left enabled:cursor-pointer disabled:cursor-default ${lit('flash')}`}
                        >
                            <Gauge className="w-3.5 h-3.5 shrink-0 text-slate-600" />
                            <span className="text-[9px] uppercase tracking-widest text-slate-600">Flash</span>
                            <span className={`font-mono text-[11px] ${flashColor}`}>{flashText}</span>
                        </button>
                    </Section>

                    {actions.length > 0 && (
                        <Section title="Download">
                            {/* Reversed, like VIEW below it: first in the list is nearest the thumb. */}
                            {[...actions].reverse().map(a => {
                                const Icon = ICONS[a.kind];
                                return (
                                    <button
                                        key={a.label}
                                        type="button"
                                        title={a.hint}
                                        {...row(`action:${a.label}`, () => { a.onClick(); onClose(); })}
                                        className={`w-full flex items-center gap-3 py-3 px-2 -mx-2 rounded text-left cursor-pointer group ${lit(`action:${a.label}`)}`}
                                    >
                                        <Icon className="w-3.5 h-3.5 shrink-0 text-slate-600 group-hover:text-blue-400 transition-colors" />
                                        <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400 group-hover:text-blue-400 transition-colors">{a.label}</span>
                                    </button>
                                );
                            })}
                        </Section>
                    )}

                    <Section title="View">
                        {/* The tab row, unrolled and turned upside down. Horizontally it was 916px of
                            labels in a 360px window; here STARTUP — the first tab — sits closest to
                            the button that opened this, and the list climbs away from the thumb.
                            Disabled entries stay listed rather than hidden: which map does not exist
                            yet is the same information as which one does. */}
                        <div className="flex flex-col">
                            {[...tabs].reverse().map(t => (
                                <button
                                    key={t.id}
                                    type="button"
                                    {...row(`tab:${t.id}`, () => { onSelectTab(t.id); onClose(); }, !t.enabled)}
                                    className={`text-left py-3 px-2 -mx-2 rounded text-[11px] font-bold tracking-widest transition-colors ${lit(`tab:${t.id}`)} ${activeTab === t.id ? 'text-blue-400'
                                        : t.enabled ? 'text-slate-400' : 'text-slate-700 cursor-default'}`}
                                >
                                    {t.label}
                                </button>
                            ))}
                        </div>
                    </Section>
                </div>

                {/* Close, on the spot the opening press landed on. Same height and same centre as the
                    footer's menu button, so releasing without moving lands here and a second tap
                    closes what the first opened without the thumb going anywhere. */}
                <div className="h-[52px] shrink-0 flex items-center justify-center border-t border-slate-800">
                    <button
                        type="button"
                        {...row('close', onClose)}
                        aria-label="Close menu"
                        className={`h-[52px] w-[52px] flex items-center justify-center rounded text-slate-400 hover:text-slate-200 cursor-pointer ${lit('close')}`}
                    >
                        <X className="w-6 h-6" />
                    </button>
                </div>
            </div>
        </>
    );
};
