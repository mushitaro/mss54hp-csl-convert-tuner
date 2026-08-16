'use client';

import React, { useEffect, useRef, useState } from 'react';
import { X, Cable, Gauge, Database, Download, Upload, FileSpreadsheet, RefreshCw, Shield, UploadCloud, Plus } from 'lucide-react';
import { DmeIdentity } from '@/lib/dme-link/types';
import { PRIVACY_POLICY_URL } from '@/config/links';
import type { InstallState } from '@/hooks/useInstallPrompt';
import { describeSave, describeSync, SaveStatus, SyncStatus } from '@/lib/session-sync/status';

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
 * **Three sections, by subject: VEHICLE, APPLICATION, VIEW.** The car, the app, the screen — every
 * row belongs to exactly one of those, and nothing needs a fourth heading. What used to be five
 * groups (an unlabelled RELOAD/INSTALL block, SESSION, VEHICLE, DOWNLOAD, VIEW) plus a pinned
 * SAVE/SYNC footer was five places to look for one thing; APPLICATION is now the only place any of
 * it can be.
 *
 * **Everything is ordered outward from the thumb.** The sheet opens from a button at the bottom
 * centre, so the sections run bottom-up — VIEW nearest the button, VEHICLE furthest — and the close
 * control sits at that same bottom centre, on the spot the finger is already touching. Press, slide
 * up, release: one gesture, no second aim.
 *
 * The section headings are sticky, which is what makes one long scroller legible: whatever you have
 * scrolled to, the band it belongs to is named at the top of the view.
 *
 * SAVE and SYNC used to be pinned above Close, because before that they lived at the top of a
 * scroller that opens at its BOTTOM and were reported three times as "SAVE does not appear on
 * mobile" — it did not appear; it was never visible. They scroll again now, but the other way up:
 * APPLICATION sits directly above VIEW, so the sheet opens with it partly on screen rather than a
 * whole list away. Measured before shipping, and worth re-measuring if the tab list ever grows.
 *
 * Deliberately NOT in here: anything that writes to the ECU. WRITE, the arming toggles and
 * START/STOP stay on the dashboard where they are one tap apart and visible together — a menu that
 * has to be opened is the wrong place for a control whose state changes what goes into the car.
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
    /**
     * Clears `dragFrom`. It has to be called from in here, not from the button that set it: the
     * scrim goes up on pointerdown and covers that button immediately, so the button's own
     * pointerup never fires and the drag state would stay armed after the finger had left. The next
     * release anywhere would then be read as a selection.
     */
    onDragEnd?: () => void;
    /** Reloads the document. The caller confirms first if there is a live link or unsaved work. */
    onReload: () => void;
    /** Whether this device can take the app, and how. See useInstallPrompt. */
    installState: InstallState;
    onInstall: () => void;
    /** The server is serving a newer build than the one running. */
    updateAvailable?: boolean;
    /** What the sync row says and whether it can be pressed. Computed by the caller so this row and
     *  the desktop header's twin cannot disagree — see lib/session-sync/status.ts.
     *
     *  Null on a build with no store to sync to, which is production: it is served statically from
     *  GitHub Pages and has no `/api` of any kind. A greyed-out row there would not be a control
     *  that is temporarily unavailable, it would be a control for a feature that build does not
     *  contain — which is why this is null rather than a permanent `unavailable` phase. */
    sync: SyncStatus | null;
    /** Sends every outstanding session. Does not close the sheet: the row is the progress readout. */
    onSync: () => void;
    /** What the SAVE row says and whether it can be pressed — the step before sync. Same
     *  computed-by-the-caller rule as `sync`, and null for the same kind of reason: a layout with no
     *  session concept at all should render no row rather than a permanently dead one. */
    save: SaveStatus | null;
    /** Records the tune into this device's database. Does not close the sheet, so the row can
     *  report the outcome the same way the sync row does. */
    onSave: () => void;
    /** Starts a fresh draft and lands on STARTUP. Closes the sheet — unlike SAVE and SYNC it has
     *  somewhere to take you, so leaving the sheet up would just cover what it did. */
    onNewSession: () => void;
    /**
     * The sync store's own panel — token, the list on the server, and the link diagnostics.
     *
     * Passed in rather than imported so the build gate stays in one place: production is served
     * statically with no `/api` at all, and the caller is already deciding that for `sync`.
     *
     * It renders its own trigger, which is why this is a node and not a callback. Its panel is a
     * fixed sheet that has to come out ABOVE this one — see the z-index note at its openUp branch.
     */
    storePanel?: React.ReactNode;
    /** `<build>.<sha>` plus the service-worker cache name, or undefined on a dev server. */
    buildLabel?: string;
}

const ICONS = { bin: Download, save: Database, base: Upload, log: FileSpreadsheet } as const;

/**
 * Every pressable row in APPLICATION, so eight controls read as one control repeated rather than as
 * eight designs. 44px is the tap target; only the tone varies between them.
 *
 * Exported because one of those rows is `storePanel`, which the caller builds — the shape has to
 * come from here or that row would be the one that does not match.
 */
export const MENU_ROW = 'w-full flex items-center justify-center gap-3 min-h-[44px] py-3 px-2 -mx-2 rounded transition-colors';

/**
 * One column for every readout in the sheet.
 *
 * The width is stated, not fitted. `w-fit` sizes each block to its own longest line, so the session
 * block resolved to 98px wide and the vehicle block to 164 — both centred, and therefore starting
 * at two different x. Centred as a group is only half of it: the groups have to agree with each
 * other, or the eye still has nothing to read down. A single width means one left edge for
 * everything, with the slack falling either side of it.
 */
const READOUT_COLUMN = 'w-[min(15rem,100%)] mx-auto';

/**
 * One of the three bands, with its heading pinned to the top of the scroll.
 *
 * Sticky is what lets all three live in one scroller. Nothing is pinned outside it any more, so the
 * heading is the only thing that says which band the rows under your thumb belong to — and it has
 * to be opaque, not translucent, because rows scroll underneath it.
 *
 * Vertical padding is halved on a short viewport. Only the readouts are squeezed; the headings and
 * the rows keep their height, so nothing loses a tap target.
 */
const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
    <div className="border-b border-slate-900">
        <h4 className="sticky top-0 z-10 bg-slate-900 px-4 pt-3 pb-2 [@media(max-height:560px)]:pt-1.5 [@media(max-height:560px)]:pb-1 text-[9px] font-bold uppercase tracking-widest text-slate-600 text-center">
            {title}
        </h4>
        <div className="px-4 pb-3 [@media(max-height:560px)]:pb-1.5">{children}</div>
    </div>
);

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
    <div className="flex items-baseline gap-3 py-1 [@media(max-height:560px)]:py-0.5">
        <span className="w-10 shrink-0 text-[9px] uppercase tracking-widest text-slate-600">{label}</span>
        <span className="min-w-0 font-mono text-[11px] text-slate-300 break-all">{children}</span>
    </div>
);

export const MobileMenu: React.FC<Props> = ({
    onClose, tabs, activeTab, onSelectTab, identity, linkState,
    flashText, flashColor, flashEnabled, onOpenFlash,
    session, baseOrigin, logName, logPoints, actions, dragFrom, onDragEnd, onReload, updateAvailable,
    installState, onInstall, sync, onSync, save, onSave, onNewSession, storePanel, buildLabel,
}) => {
    const syncLook = sync && describeSync(sync);
    const saveLook = save && describeSave(save);
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
            onDragEnd?.();
            // Clicking the row rather than looking its handler up: the row already owns the handler
            // for the ordinary tap path, and one way in means the two cannot drift apart.
            // Released without travelling, or without reaching a row, leaves the sheet up — which is
            // what makes a plain tap open it to be read and tapped in the ordinary way.
            row?.click();
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up, { once: true });
        window.addEventListener('pointercancel', () => { setHot(null); onDragEnd?.(); }, { once: true });
        return () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
        };
    }, [dragFrom, onDragEnd]);

    /** Marks a row as drag-selectable. The key is only for the highlight; the handler stays on
     *  the element, where the tap path already reads it. */
    const row = (key: string, run: () => void, disabled = false) => ({
        'data-menu-key': key,
        'data-menu-disabled': disabled ? 'true' : undefined,
        onClick: run,
        disabled,
    } as const);

    const lit = (key: string) => (hot === key ? 'bg-slate-800' : '');


    /**
     * Opens on APPLICATION, with VEHICLE scrolled off above it.
     *
     * It used to open at the very bottom of the scroll, on the argument that the rows nearest the
     * thumb are the last in the document and `scrollTop 0` would show the readouts instead. Both
     * halves of that still hold — VEHICLE is readouts and it is still what you land past — but the
     * bottom is now one row too far: measured at 375x812 with no session, SAVE rendered at y=39
     * against a scroller starting at y=42, five pixels behind its own sticky heading. Off screen by
     * five pixels is off screen, and "SAVE does not appear on mobile" is a report this file has
     * already collected three times.
     *
     * So the target is APPLICATION's top edge, clamped to the end of the scroll. Clamping is what
     * makes it degrade the right way: when APPLICATION and VIEW both fit, it lands at the bottom
     * exactly as before and every tab is on screen; when they do not, APPLICATION wins the fold and
     * the tabs are one flick away under a heading that says so.
     */
    const scroller = useRef<HTMLDivElement>(null);
    const appBand = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const el = scroller.current;
        const band = appBand.current;
        if (!el) return;
        if (!band) { el.scrollTop = el.scrollHeight; return; }
        // Measured from a known scroll position, because getBoundingClientRect is viewport-relative
        // and offsetTop would be relative to the fixed sheet rather than to the scrolling content.
        el.scrollTop = 0;
        const offset = band.getBoundingClientRect().top - el.getBoundingClientRect().top;
        el.scrollTop = Math.min(offset, el.scrollHeight - el.clientHeight);
    }, []);

    /**
     * Ignore the dismissals for a moment after opening.
     *
     * On touch, letting go of the button that opened this fires a compatibility `click` at the same
     * coordinates a beat after `pointerup` — and Close sits at exactly those coordinates, by design.
     * So press-and-release shut the sheet the instant it appeared. `preventDefault` on the opening
     * pointerdown does not reliably suppress that click, and the drag path does not need it: it runs
     * off pointerup and dispatches its own click on the row.
     *
     * Only Close and the scrim are gated. A row reached by sweeping is still selectable throughout,
     * because that path never waits for a browser-generated click.
     */
    const [dismissable, setDismissable] = useState(false);
    useEffect(() => {
        const t = setTimeout(() => setDismissable(true), 400);
        return () => clearTimeout(t);
    }, []);
    const dismiss = () => { if (dismissable) onClose(); };

    return (
        <>
            <div className="fixed inset-0 z-[90] bg-slate-950/70 backdrop-blur-sm min-[900px]:hidden" onClick={dismiss} />
            {/* Up from the bottom, not in from the side: it opens from a control on the footer, so it
                comes from where the finger already is. Capped short of the full height so the scrim
                above stays visible — the way out has to be on screen. 95 rather than 90 because on a
                400px viewport the missing 5% is 20px of list, and Close is the real way out anyway. */}
            <div className="fixed inset-x-0 bottom-0 z-[95] max-h-[95svh] flex flex-col bg-slate-900 border-t border-slate-800 rounded-t-xl min-[900px]:hidden touch-none">
                {/* One scroller for all three bands, and nothing pinned above it.
                    ────────────────────────────────────────────────────────────────────────────────
                    Two scrollers used to share this space with no rule for how they divided it, and
                    on a 683x400 head unit the readouts simply took what they wanted: that band
                    measured 314px of a 360px sheet, the tab list got 0px, and Close hung 8px below
                    the bottom of the screen. The fix then was `min-h-0` so the pinned band would
                    yield. One scroller cannot have the argument at all.

                    What pinning bought — knowing which band you are in — the sticky headings buy
                    instead, and they buy it for all three rather than for the two that happened to
                    be at the top.

                    `no-scrollbar`: a 4px bar down the edge of a 360px sheet is noise on an
                    instrument, and the list already shows it runs past the fold. */}
                <div ref={scroller} className="no-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain">
                    {/* The furthest thing from the thumb in the sheet, and the only one that belongs
                        to none of the three bands. The scroller opens at its own bottom, so this
                        sits off screen until someone deliberately scrolls up for it — which is the
                        whole placement argument: a legal link has to be reachable, not visible.

                        Deliberately NOT wired through `row()`. With no `data-menu-key` the sweep's
                        hit test returns null over this row, so a finger travelling up the sheet can
                        pass across it and let go without opening anything. Do not add one.

                        `_blank` is not decoration: a same-tab navigation would drop the serial link
                        and take an unsaved run with it. */}
                    <a
                        href={PRIVACY_POLICY_URL}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center justify-center gap-2 py-4 border-b border-slate-900 text-slate-600 hover:text-slate-400 transition-colors"
                    >
                        <Shield className="w-2.5 h-2.5 shrink-0" />
                        <span className="text-[9px] font-bold uppercase tracking-widest">Privacy Policy</span>
                    </a>

                    <Section title="Vehicle">
                        <div className={READOUT_COLUMN}>
                            <Field label="VIN">{identity?.vin ?? <span className="text-slate-600">{linkState === 'disconnected' ? 'not connected' : 'reading'}</span>}</Field>
                            <Field label="AIF">{identity?.aif ?? <span className="text-slate-600">—</span>}</Field>
                            <Field label="SW">{identity?.softwareVersion ?? <span className="text-slate-600">—</span>}</Field>
                        </div>
                        {/* Still a control, and still one step deeper than the number it changes —
                            so it is centred like the APPLICATION rows rather than aligned like the
                            readouts above it. It is the one thing in this band you press, and it
                            should not read as a fourth row of the column. */}
                        <button
                            type="button"
                            {...row('flash', () => { onOpenFlash(); onClose(); }, !flashEnabled)}
                            className={`mt-2 ${MENU_ROW} enabled:cursor-pointer disabled:cursor-default ${lit('flash')}`}
                        >
                            <Gauge className="w-3.5 h-3.5 shrink-0 text-slate-600" />
                            <span className="text-[9px] uppercase tracking-widest text-slate-600">Flash</span>
                            <span className={`font-mono text-[11px] ${flashColor}`}>{flashText}</span>
                        </button>
                    </Section>

                    {/* Everything that is about the app rather than about the car or about which
                        screen you are on. SAVE, SYNC, RELOAD and NEW SESSION are the four this band
                        was asked for; the store panel sits with SYNC because it is the other half of
                        it, and the downloads, INSTALL and the build string are app-level too and had
                        no other home once SESSION and DOWNLOAD stopped being headings of their own. */}
                    <div ref={appBand}>
                    <Section title="Application">
                        {/* Which session the rows below would act on. A readout, not a control, so it
                            keeps the readout column and sits above them rather than among them. */}
                        {session && (
                            <div className={`${READOUT_COLUMN} mb-3`}>
                                <div className="flex items-center gap-2 mb-1 min-w-0">
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
                            </div>
                        )}

                        {/* SAVE, SYNC, RELOAD, NEW SESSION — in that order, and none of them wired
                            through `row()`. The sweep's hit test must return null over all four so a
                            finger travelling up the sheet cannot release onto SAVE and write to the
                            database, onto SYNC and start an upload, or onto RELOAD and drop the link
                            and the run with it. Do not add `data-menu-key` to any of them.

                            A full-width row each, which is what lets them carry describeSave's and
                            describeSync's whole sentence — "Save — nothing to record", "Offline — 3
                            waiting". Side by side above Close, which is where they used to be, there
                            was room for one word and the reason lived in a tooltip no phone can
                            open. */}
                        {saveLook && (
                            <button
                                type="button"
                                onClick={saveLook.disabled ? undefined : onSave}
                                disabled={saveLook.disabled}
                                title={saveLook.title}
                                className={`${MENU_ROW} ${saveLook.tone === 'ready' ? 'text-amber-400 hover:text-amber-300 cursor-pointer'
                                    : saveLook.tone === 'busy' ? 'text-slate-500 animate-pulse cursor-wait'
                                        : 'text-slate-700 cursor-default'}`}
                            >
                                <Database className="w-3.5 h-3.5 shrink-0" />
                                <span className="text-[10px] font-bold uppercase tracking-widest">{saveLook.label}</span>
                            </button>
                        )}

                        {/* The failure, in text, on the device that cannot hover.
                            ────────────────────────────────────────────────────────────────────────
                            Everything else on this sheet keeps its long form in `title`, which is
                            correct for a label whose short form is already the answer. It is wrong
                            for an error: the short form is "Sync failed" and the long form is the
                            only thing that says WHY. A phone has no hover, so on the one platform
                            this row exists to serve, the app could report that an upload failed and
                            had no way to report the reason.

                            Wraps rather than truncates, and sits above the button rather than beside
                            it, because it is read once and then acted on. Rendered only in the error
                            tone, so nothing moves in the normal case. */}
                        {syncLook?.tone === 'error' && sync?.error && (
                            <p className="pt-1 text-[10px] leading-relaxed text-red-400 break-words">
                                {sync.error}
                            </p>
                        )}
                        {syncLook && (
                            <button
                                type="button"
                                onClick={syncLook.disabled ? undefined : onSync}
                                disabled={syncLook.disabled}
                                title={syncLook.title}
                                className={`${MENU_ROW} ${syncLook.tone === 'ready' ? 'text-blue-400 hover:text-blue-300 cursor-pointer'
                                    : syncLook.tone === 'error' ? 'text-red-400 hover:text-red-300 cursor-pointer'
                                        : syncLook.tone === 'busy' ? 'text-slate-500 animate-pulse cursor-wait'
                                            : 'text-slate-700 cursor-default'}`}
                            >
                                <UploadCloud className="w-3.5 h-3.5 shrink-0" />
                                <span className="text-[10px] font-bold uppercase tracking-widest">{syncLook.label}</span>
                            </button>
                        )}

                        {/* Where the token, the list on the server and the link diagnostics live —
                            directly under the button that uses them. It used to sit in the STARTUP
                            list's header, which is the one screen SAVE never appears on. */}
                        {storePanel}

                        <button
                            type="button"
                            onClick={onReload}
                            className={`${MENU_ROW} cursor-pointer ${updateAvailable ? 'text-blue-400' : 'text-slate-500 hover:text-slate-300'}`}
                        >
                            <RefreshCw className="w-3.5 h-3.5 shrink-0" />
                            <span className="text-[10px] font-bold uppercase tracking-widest">
                                {updateAvailable ? 'Update available — reload' : 'Reload'}
                            </span>
                        </button>

                        {/* The only row here that navigates, so the only one that closes the sheet:
                            it lands on STARTUP, and leaving the sheet up would cover what it did. */}
                        <button
                            type="button"
                            onClick={() => { onNewSession(); onClose(); }}
                            className={`${MENU_ROW} text-blue-400 hover:text-blue-300 cursor-pointer`}
                        >
                            <Plus className="w-3.5 h-3.5 shrink-0" />
                            <span className="text-[10px] font-bold uppercase tracking-widest">New Session</span>
                        </button>

                        {actions.length > 0 && (
                            <>
                                <div className="my-2 border-t border-slate-900" />
                                {actions.map(a => {
                                    const Icon = ICONS[a.kind];
                                    return (
                                        <button
                                            key={a.label}
                                            type="button"
                                            title={a.hint}
                                            {...row(`action:${a.label}`, () => { a.onClick(); onClose(); })}
                                            className={`${MENU_ROW} cursor-pointer group ${lit(`action:${a.label}`)}`}
                                        >
                                            <Icon className="w-3.5 h-3.5 shrink-0 text-slate-600 group-hover:text-blue-400 transition-colors" />
                                            <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400 group-hover:text-blue-400 transition-colors">{a.label}</span>
                                        </button>
                                    );
                                })}
                            </>
                        )}

                        {/* Install is here because installed is the state this tool is meant to be
                            used in: no browser chrome eating the viewport, the screen kept awake,
                            and the whole build on disk for a garage with no signal.

                            The unavailable case is shown, not hidden. "I looked for install and
                            found nothing" is the report this exists to answer, and a control that
                            disappears cannot answer it. */}
                        {installState !== 'installed' && (
                            <button
                                type="button"
                                onClick={installState === 'ready' ? onInstall : undefined}
                                disabled={installState !== 'ready'}
                                className={`${MENU_ROW} ${installState === 'ready'
                                    ? 'text-emerald-400 hover:text-emerald-300 cursor-pointer'
                                    : 'text-slate-700 cursor-default'}`}
                            >
                                <Download className="w-3.5 h-3.5 shrink-0" />
                                <span className="text-[10px] font-bold uppercase tracking-widest">
                                    {installState === 'ready' ? 'Install to device'
                                        : installState === 'ios' ? 'Share → Add to Home Screen'
                                            : installState === 'dismissed' ? 'Install declined — reload to be asked again'
                                                : 'Install — not offered by this browser'}
                                </span>
                            </button>
                        )}

                        {/* Which build this phone is actually running. Monospace and muted: it is
                            never acted on, but it is the first thing asked when a device behaves
                            differently from the desk — and a service worker serving a stale bundle
                            is a real failure mode here, which is why the cache name rides along. */}
                        {buildLabel && (
                            <p className="pt-2 text-center font-mono text-[9px] text-slate-700 break-all">{buildLabel}</p>
                        )}
                    </Section>
                    </div>

                    <Section title="View">
                        {/* The tab row, unrolled. Horizontally it was 916px of labels in a 360px
                            window.

                            It used to be unrolled UPSIDE DOWN, so that STARTUP — the first tab and
                            the most often wanted — ended up last in the document and therefore
                            nearest the thumb. That followed from the sheet opening at the very
                            bottom of its scroll, and the sheet no longer does: it opens on
                            APPLICATION, so the top of this list is what is on screen and the bottom
                            is what you scroll for. Reversed, that put STARTUP 85px under the fold
                            and left INERTIA (EXP.) in the first slot. In document order the two
                            experimental maps are the ones below the fold, which is the right way
                            round for what they are.

                            Disabled entries stay listed rather than hidden: which map does not exist
                            yet is the same information as which one does. */}
                        <div className="flex flex-col">
                            {tabs.map(t => (
                                <button
                                    key={t.id}
                                    type="button"
                                    {...row(`tab:${t.id}`, () => { onSelectTab(t.id); onClose(); }, !t.enabled)}
                                    /* 44px, not the 49 these used to be. Ten tabs at five spare
                                       pixels each is 50px, and 50px is the difference between the
                                       last tab — STARTUP, the one nearest the thumb and the one
                                       most often wanted — sitting on screen when the sheet opens or
                                       23px under the fold. 44 is the tap-target floor, not a
                                       squeeze: `min-h` holds it whatever the padding computes to. */
                                    className={`text-center min-h-[44px] py-3 px-2 -mx-2 rounded text-[11px] font-bold tracking-widest transition-colors flex items-center justify-center ${lit(`tab:${t.id}`)} ${activeTab === t.id ? 'text-blue-400'
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
                        {...row('close', dismiss)}
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
