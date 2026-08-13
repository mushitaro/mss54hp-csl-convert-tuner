'use client';

import React, { useEffect, useRef, useState } from 'react';
import { X, Cable, Gauge, Database, Download, Upload, FileSpreadsheet, RefreshCw, Shield, UploadCloud } from 'lucide-react';
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
    /** `<build>.<sha>` plus the service-worker cache name, or undefined on a dev server. */
    buildLabel?: string;
}

const ICONS = { bin: Download, save: Database, base: Upload, log: FileSpreadsheet } as const;

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

/** Vertical padding is halved on a short viewport — see the pinned block below for what it buys.
 *  Only the readouts are squeezed; nothing here is a tap target, so nothing loses one. */
const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
    <div className="px-4 py-3 [@media(max-height:560px)]:py-1.5 border-b border-slate-900">
        <h4 className="text-[9px] font-bold uppercase tracking-widest text-slate-600 mb-2 [@media(max-height:560px)]:mb-1 text-center">{title}</h4>
        {children}
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
    installState, onInstall, sync, onSync, save, onSave, buildLabel,
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

    /** Opens at the bottom of its own scroll. The lists run bottom-up so the rows nearest the thumb
     *  are the last ones in the document, and scrollTop 0 showed the readouts instead of them. */
    const scroller = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const el = scroller.current;
        if (el) el.scrollTop = el.scrollHeight;
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
                {/* Pinned. These are what the sheet is consulted for as much as navigated with —
                    which car, which session, how many flashes left — and scrolling them away to
                    reach a tab meant they were never on screen at the moment you wanted them. Above
                    the scroll, not in it.

                    Pinned, but no longer `shrink-0`. Three bands shared one `max-h` and nothing said
                    how they divided it, so on the head unit — 683x400, and every band sized in
                    absolute px — the readouts simply took what they needed and the other two got the
                    remainder. Connected, that block measured 314px of a 360px sheet: the tab list
                    was 0px tall and Close hung 8px below the bottom of the screen. The way out of a
                    sheet cannot be a function of how long a VIN is.

                    So it yields: `min-h-0` is what lets it, and the shrink it already had does the
                    rest — the readouts and the list end up sharing the squeeze in proportion to what
                    each of them wanted, and Close, which is `shrink-0`, is never in the negotiation.
                    Measured at 683x400 connected: 314px -> 109px, the list 0px -> 218px, five of
                    eight destinations reachable, Close back inside the screen.

                    A `max-h` was tried here first and is deliberately absent: 45% and 42svh produced
                    byte-identical measurements, because the cap never binds — the flex pass has
                    already brought this band below it. Leaving a rule in that never fires is worse
                    than not having one.

                    The readouts stay above the list, which is what pinning them was for; what they
                    lose is the right to push anything off the screen. Below the fold here they are
                    one scroll away, and the identity dialog on the status dot is the other route. */}
                <div className="min-h-0 overflow-y-auto overscroll-contain no-scrollbar border-b border-slate-800">
                    {/* Installed to the home screen there is no reload button, and pull-to-refresh —
                        which is what used to be one — is off on purpose. So the app carries its own.

                        Top of the sheet, above everything: this drops the link and any unsaved tune,
                        so it belongs at the point furthest from the thumb — off the sweep entirely,
                        and past the readouts as well, so reaching it is a decision rather than a
                        slip. It was one row under the vehicle block, which was too close. */}
                    <div className="px-4 pt-3 pb-1 border-b border-slate-900">
                        <button
                            type="button"
                            onClick={onReload}
                            className={`w-full flex items-center justify-center gap-3 py-3 rounded cursor-pointer transition-colors ${updateAvailable ? 'text-blue-400' : 'text-slate-500 hover:text-slate-300'}`}
                        >
                            <RefreshCw className="w-3.5 h-3.5 shrink-0" />
                            <span className="text-[10px] font-bold uppercase tracking-widest">
                                {updateAvailable ? 'Update available — reload' : 'Reload'}
                            </span>
                        </button>

                        {/* Install sits with Reload because they are the same subject — which build
                            is on this device, and where it lives. It is here rather than only in
                            Chrome's overflow menu because that is where a phone user looks, and
                            because installed is the state this tool is meant to be used in: no
                            browser chrome eating the viewport, the screen kept awake, and the whole
                            build on disk for a garage with no signal.

                            The unavailable case is shown, not hidden. "I looked for install and
                            found nothing" is the report this exists to answer, and a control that
                            disappears cannot answer it. */}
                        {installState !== 'installed' && (
                            <button
                                type="button"
                                onClick={installState === 'ready' ? onInstall : undefined}
                                disabled={installState !== 'ready'}
                                className={`w-full flex items-center justify-center gap-3 py-3 rounded transition-colors ${installState === 'ready'
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

                        {/* Sync, in the pinned block with Reload and Install because this band does
                            not scroll: the sheet opens at the bottom of its own scroller, so
                            anything in the list below is out of sight until you go looking. The one
                            control a driver wants the moment a run ends should not need to be
                            found.

                            Wired to `onSync` directly and NOT through `row()`, exactly like the two
                            above it. Without a `data-menu-key` the sweep's hit test returns null
                            here, so a finger travelling up the sheet can pass over this row and let
                            go without starting an upload. Do not add one.

                            The sheet stays open on purpose. This row IS the progress readout —
                            "Syncing…", then a count or a failure — and closing it would replace the
                            only report with nothing.

                            Once the row is here, every STATE of it is shown, including the ones that
                            cannot be pressed — "I looked for sync and there was nothing there" is
                            the report a control that hides itself produces, and offline and
                            already-synced are precisely the two worth stating out loud. Whether the
                            row exists at all is a different question, and the caller answers it. */}
                        {/* SAVE, immediately above SYNC, and in the pinned band for the same reason
                            SYNC is: this band does not scroll, and the two of them are one flow read
                            top to bottom — record it on this device, then send what has changed.

                            It used to live only in the scrolling action list, gated so that it
                            vanished during a run, and in the desktop session bar, which is
                            `hidden min-[900px]:flex`. On a phone that left no reachable SAVE at all
                            on most tabs, and none anywhere during a log.

                            Shown in every state including the ones that cannot be pressed — same
                            rule as the sync row below. "I looked for save and there was nothing
                            there" is the report a control that hides itself produces, and
                            "not until the run stops" is worth saying rather than implying.

                            No `data-menu-key`, deliberately, exactly like the rows around it: the
                            sweep's hit test must return null here so a finger travelling up the
                            sheet cannot let go on it and write to the database. */}
                        {saveLook && (
                            <button
                                type="button"
                                onClick={saveLook.disabled ? undefined : onSave}
                                disabled={saveLook.disabled}
                                title={saveLook.title}
                                className={`w-full flex items-center justify-center gap-3 py-3 rounded transition-colors ${saveLook.tone === 'ready' ? 'text-amber-400 hover:text-amber-300 cursor-pointer'
                                    : saveLook.tone === 'busy' ? 'text-slate-500 animate-pulse cursor-wait'
                                        : 'text-slate-700 cursor-default'}`}
                            >
                                <Database className="w-3.5 h-3.5 shrink-0" />
                                <span className="text-[10px] font-bold uppercase tracking-widest">{saveLook.label}</span>
                            </button>
                        )}

                        {syncLook && (
                            <button
                                type="button"
                                onClick={syncLook.disabled ? undefined : onSync}
                                disabled={syncLook.disabled}
                                title={syncLook.title}
                                className={`w-full flex items-center justify-center gap-3 py-3 rounded transition-colors ${syncLook.tone === 'ready' ? 'text-blue-400 hover:text-blue-300 cursor-pointer'
                                    : syncLook.tone === 'error' ? 'text-red-400 hover:text-red-300 cursor-pointer'
                                        : syncLook.tone === 'busy' ? 'text-slate-500 animate-pulse cursor-wait'
                                            : 'text-slate-700 cursor-default'}`}
                            >
                                <UploadCloud className="w-3.5 h-3.5 shrink-0" />
                                <span className="text-[10px] font-bold uppercase tracking-widest">{syncLook.label}</span>
                            </button>
                        )}

                        {/* Which build this phone is actually running. Monospace and muted: it is
                            never acted on, but it is the first thing asked when a device behaves
                            differently from the desk — and a service worker serving a stale bundle
                            is a real failure mode here, which is why the cache name rides along. */}
                        {buildLabel && (
                            <p className="pt-1 text-center font-mono text-[9px] text-slate-700 break-all">{buildLabel}</p>
                        )}
                    </div>

                    {session && (
                        <Section title="Session">
                            <div className={READOUT_COLUMN}>
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
                            </div>
                        </Section>
                    )}

                    <Section title="Vehicle">
                        <div className={READOUT_COLUMN}>
                            <Field label="VIN">{identity?.vin ?? <span className="text-slate-600">{linkState === 'disconnected' ? 'not connected' : 'reading'}</span>}</Field>
                            <Field label="AIF">{identity?.aif ?? <span className="text-slate-600">—</span>}</Field>
                            <Field label="SW">{identity?.softwareVersion ?? <span className="text-slate-600">—</span>}</Field>
                        </div>
                        {/* Still a control, and still one step deeper than the number it changes —
                            so it is centred like Reload rather than aligned like the readouts. It is
                            the one thing in this block you press, and it should not read as a fourth
                            row of the column above it. */}
                        <button
                            type="button"
                            {...row('flash', () => { onOpenFlash(); onClose(); }, !flashEnabled)}
                            className={`mt-2 w-full flex items-center justify-center gap-2 py-3 rounded enabled:cursor-pointer disabled:cursor-default ${lit('flash')}`}
                        >
                            <Gauge className="w-3.5 h-3.5 shrink-0 text-slate-600" />
                            <span className="text-[9px] uppercase tracking-widest text-slate-600">Flash</span>
                            <span className={`font-mono text-[11px] ${flashColor}`}>{flashText}</span>
                        </button>
                    </Section>

                </div>

                {/* Scrolls, without saying so. A 4px bar down the edge of a 360px sheet is noise on
                    an instrument, and the list already shows it runs past the fold. */}
                <div ref={scroller} className="no-scrollbar flex-1 overflow-y-auto overscroll-contain">
                    {/* The furthest thing from the thumb in the sheet, and the only one not about
                        the car. The scroller opens at its own bottom, so this sits off screen until
                        someone deliberately scrolls up for it — which is the whole placement
                        argument: a legal link has to be reachable, not visible.

                        Deliberately NOT wired through `row()`, exactly like Reload above. With no
                        `data-menu-key` the sweep's hit test returns null over this row, so a finger
                        travelling up the sheet can pass across it and let go without opening
                        anything. Do not add one.

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
                                        className={`w-full flex items-center justify-center gap-3 py-4 px-2 -mx-2 rounded cursor-pointer group ${lit(`action:${a.label}`)}`}
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
                                    className={`text-center py-4 px-2 -mx-2 rounded text-[11px] font-bold tracking-widest transition-colors ${lit(`tab:${t.id}`)} ${activeTab === t.id ? 'text-blue-400'
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
