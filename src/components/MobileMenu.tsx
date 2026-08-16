'use client';

import React, { useEffect, useRef, useState } from 'react';
import {
    X, Gauge, Database, Download, Upload, FileSpreadsheet, RefreshCw, Shield,
    Plus, Medal, Github, BookOpen,
} from 'lucide-react';
import { DmeIdentity } from '@/lib/dme-link/types';
import { PRIVACY_POLICY_URL, PROJECT_REPO_URL, CREDIT_LINKS } from '@/config/links';
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
 * **Three bands, and only one of them scrolls.** VEHICLE is the car, SESSION is the work, VIEW is
 * the screen. The first two are laid out to fit and stay put; VIEW is the only list long enough to
 * need a scroller, and it gets the space the other two do not use. They were briefly all in one
 * scroller with sticky headings, and that is the arrangement this replaces: with one scroller,
 * whichever band you are not looking at is gone, and SAVE — which the whole sheet exists to make
 * reachable — was off screen at open by five pixels.
 *
 * **Everything is ordered outward from the thumb.** The sheet opens from a button at the bottom
 * centre, so VIEW is nearest it, VEHICLE furthest, and the close control sits at that same bottom
 * centre on the spot the finger is already touching. Press, slide up, release: one gesture, no
 * second aim. VIEW's own list is unrolled upside down and opens scrolled to its end, so STARTUP —
 * the first tab and the one most often wanted — is the row closest to the button.
 *
 * **The icon strip at the top is the desktop header.** Same destinations, same order, drawn as
 * icons because a phone has no room for "Tuning Source" spelled out. It is the furthest thing from
 * the thumb, which is where a legal link and an app reload belong.
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
    /** Opens the attribution dialog — the same thing the version string does on a desk. */
    onOpenCredits: () => void;
    /** Whether this device can take the app, and how. See useInstallPrompt. */
    installState: InstallState;
    onInstall: () => void;
    /** The server is serving a newer build than the one running. */
    updateAvailable?: boolean;
    /** What the sync cell says and whether it can be pressed. Computed by the caller so this and
     *  the desktop header's twin cannot disagree — see lib/session-sync/status.ts.
     *
     *  Null on a build with no store to sync to, which is production: it is served statically from
     *  GitHub Pages and has no `/api` of any kind. A greyed-out cell there would not be a control
     *  that is temporarily unavailable, it would be a control for a feature that build does not
     *  contain — which is why this is null rather than a permanent `unavailable` phase. */
    sync: SyncStatus | null;
    /** What the SAVE cell says and whether it can be pressed — the step before sync. Same
     *  computed-by-the-caller rule as `sync`, and null for the same kind of reason: a layout with no
     *  session concept at all should render no cell rather than a permanently dead one. */
    save: SaveStatus | null;
    /** Records the tune into this device's database. Does not close the sheet, so the caption can
     *  report the outcome. */
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
     * It renders its own trigger, which is why this is a node and not a callback — the caller
     * dresses it as a cell with MENU_CELL. Its panel is a fixed sheet that has to come out ABOVE
     * this one; see the z-index note at its openUp branch.
     */
    storePanel?: React.ReactNode;
    /** `<build>.<sha>` plus the service-worker cache name, or undefined on a dev server. */
    buildLabel?: string;
}

const ICONS = { bin: Download, save: Database, base: Upload, log: FileSpreadsheet } as const;

/**
 * One cell of the SESSION grid: icon over a short word, 56px tall.
 *
 * Exported because one of the cells is `storePanel`, which the caller builds — the shape has to
 * come from here or that cell would be the one that does not match its neighbours.
 *
 * 56 rather than 44 because these are square-ish targets in a three-across row on a 360px screen,
 * where the horizontal budget is already about 110px each. The label is `text-[9px]` and truncates:
 * a cell that grows to fit its word would break the grid it shares.
 *
 * `w-full h-full` is not belt-and-braces. Two of these three cells are the grid's own children and
 * stretch on their own; SYNC is a button inside the store panel's wrapper, and without this it sized
 * to its content — 38px of button sitting at the left edge of a 109px slot, which is exactly the
 * misalignment that got reported.
 */
export const MENU_CELL = 'w-full h-full flex flex-col items-center justify-center gap-1 min-h-[56px] px-1 rounded transition-colors text-[9px] font-bold uppercase tracking-widest';

/** The icon strip's controls — the desktop header, drawn small. 40px is the target; the icons
 *  themselves are 14px, which is what the header renders them at. */
const STRIP_ITEM = 'w-10 h-10 [@media(max-height:560px)]:w-9 [@media(max-height:560px)]:h-9 flex items-center justify-center rounded transition-colors';

/** One page of the SESSION carousel. Three columns on both, so the pages line up rather than
 *  sliding sideways under the thumb. */
const PAGE = 'w-full shrink-0 snap-start grid grid-cols-3 gap-2';

/** The breathing room inside a band. Halved on a short viewport, which is the only place the sheet
 *  is short of height — nothing here is a tap target, so nothing loses one. */
const BAND_BODY = 'px-4 pb-3 [@media(max-height:560px)]:pb-1.5';

/**
 * The three download slots, always all three.
 *
 * `actions` only carries what exists, and a grid that grew and shrank with it changed this band's
 * height and moved VIEW under the thumb. The slots are fixed and the lookup is by `kind`, so an
 * unavailable one is a greyed cell that says why rather than a gap that says nothing.
 *
 * `bin` reads "Tuned" when empty even though it can arrive labelled "Patch-On": the empty state is
 * the absence of a derived tune, and Patch-On only exists in place of one.
 *
 * BASE, TUNED, LOG — the tune in the middle, on the same centre line SAVE holds on page one, so
 * flicking between the pages keeps the eye on one column. It also reads in order: what the session
 * started from, what it became, what proved it.
 */
const DOWNLOAD_SLOTS = [
    { kind: 'base', fallback: 'Base', absent: 'This session has no BASE yet. Read one from the DME, or upload a BIN.' },
    { kind: 'bin', fallback: 'Tuned', absent: 'No tune to download yet — derive one from a log, or arm a patch.' },
    { kind: 'log', fallback: 'Log CSV', absent: 'This session has no log yet.' },
] as const;

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
 * One labelled readout, and an em-dash when there is nothing to read.
 *
 * The placeholder is the point, not a nicety: both readout bands hold a fixed height, and they can
 * only do that if a field with no value still occupies a line. It also answers a different question
 * than a blank does — "this session has no BASE" rather than "this row is missing".
 *
 * `truncate` rather than `break-all`: a long VIN used to wrap to a second line and take the band's
 * height with it, which is exactly what the fixed height is there to prevent.
 */
const Field: React.FC<{ label: string; children?: React.ReactNode }> = ({ label, children }) => (
    <div className="flex items-baseline gap-3 py-1 [@media(max-height:560px)]:py-0.5">
        <span className="w-10 shrink-0 text-[9px] uppercase tracking-widest text-slate-600">{label}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-slate-300">
            {children ?? <span className="text-slate-700">—</span>}
        </span>
    </div>
);

/**
 * A band and its heading.
 *
 * The heading is a plain child rather than `sticky`, because nothing scrolls past it any more: each
 * band holds its own height. VIEW puts its scroller in `children`, so its heading stays put for the
 * same reason without needing to be told to.
 */
const Band: React.FC<{ title: string; className?: string; children: React.ReactNode }> = ({ title, className = 'shrink-0', children }) => (
    <div className={`flex flex-col border-b border-slate-800 ${className}`}>
        <h4 className="shrink-0 px-4 pt-3 pb-2 [@media(max-height:560px)]:pt-1.5 [@media(max-height:560px)]:pb-1 text-[9px] font-bold uppercase tracking-widest text-slate-600 text-center">
            {title}
        </h4>
        {children}
    </div>
);

export const MobileMenu: React.FC<Props> = ({
    onClose, tabs, activeTab, onSelectTab, identity, linkState,
    flashText, flashColor, flashEnabled, onOpenFlash,
    session, baseOrigin, logName, logPoints, actions, dragFrom, onDragEnd, onReload, onOpenCredits,
    updateAvailable, installState, onInstall, sync, save, onSave, onNewSession, storePanel,
    buildLabel,
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
     * VIEW opens at the end of its own scroll.
     *
     * Its list is unrolled upside down, so the end is STARTUP — the row nearest the button that
     * opened the sheet. Only this band scrolls, so this is the only scroll position there is to
     * set; the other two bands cannot move out from under it.
     */
    const tabScroller = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const el = tabScroller.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, []);

    /**
     * The SESSION carousel.
     *
     * Two pages, because five controls across one row would be 72px each on a 360px screen and the
     * three that matter every run — SAVE, SYNC, NEW SESSION — would be the same size as the three
     * that matter once. Page one is those; page two is the files and the store's settings.
     *
     * Scroll-snap, so a swipe works where the platform allows one, with dots that always do. The
     * dots are not decoration here: the sheet carries `touch-none` to stop the browser claiming the
     * opening drag as a scroll, and a horizontal swipe inside it is not guaranteed to survive that.
     * `touch-pan-x` asks for the exception; the dots do not need it granted.
     */
    const pager = useRef<HTMLDivElement>(null);
    const [page, setPage] = useState(0);
    const goTo = (i: number) => {
        const el = pager.current;
        if (el) el.scrollTo({ left: i * el.clientWidth, behavior: 'smooth' });
        setPage(i);
    };

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

    /** Every cross-origin destination in here opens in a new tab, and that is a safety rule rather
     *  than a courtesy: a same-tab navigation drops the serial link and takes an unsaved run with
     *  it. See config/links.ts, which is where they are all declared for this reason. */
    const away = { target: '_blank', rel: 'noopener noreferrer' } as const;

    return (
        <>
            <div className="fixed inset-0 z-[90] bg-slate-950/70 backdrop-blur-sm min-[900px]:hidden" onClick={dismiss} />
            {/* Up from the bottom, not in from the side: it opens from a control on the footer, so it
                comes from where the finger already is. Capped short of the full height so the scrim
                above stays visible — the way out has to be on screen. 95 rather than 90 because on a
                400px viewport the missing 5% is 20px of list, and Close is the real way out anyway. */}
            <div className="fixed inset-x-0 bottom-0 z-[95] max-h-[95svh] flex flex-col bg-slate-900 border-t border-slate-800 rounded-t-xl min-[900px]:hidden touch-none">

                {/* The backstop, and only that.
                    ────────────────────────────────────────────────────────────────────────────────
                    VEHICLE and SESSION hold their height and VIEW absorbs the squeeze — which works
                    until VIEW has none left to give. Measured at 812x375, a landscape phone: VIEW
                    reached 1px, the two bands above still wanted 350px of a 304px space, and Close
                    was pushed 48px below the bottom of the screen. The way out of a sheet cannot be
                    a function of how tall the phone is.

                    So the four things above Close can scroll as a group, and Close never can. On any
                    portrait phone this never engages: the bands fit, VIEW takes the remainder, and
                    the only scroller in the sheet is VIEW's own. It is here for the case where the
                    arithmetic does not work at all, and in that case a band you have to scroll to is
                    still better than a control that is not on the screen. */}
                <div className="no-scrollbar flex-1 min-h-0 flex flex-col overflow-y-auto overscroll-contain">

                {/* The desktop header, as icons. Same five destinations in the same order it uses,
                    plus INSTALL, which has no desktop twin because a desk does not install this.

                    Furthest from the thumb of anything in the sheet, and deliberately outside the
                    sweep: none of these carries a `data-menu-key`, so the hit test returns null over
                    the whole strip and a finger travelling up can cross it and let go without
                    opening a legal page, reloading the app, or leaving for GitHub. Do not add one. */}
                <div className="shrink-0 border-b border-slate-800 px-4 pt-1.5">
                    {/* Three columns, not one centred row. CREDITS holds the middle of the strip on
                        its own, and `1fr auto 1fr` keeps it on the sheet's centre line whatever the
                        groups either side happen to weigh — INSTALL comes and goes, and a flex row
                        would slide the medal sideways with it. Same reason MENU is absolutely
                        centred in the footer this sheet opens from. */}
                    <div className="grid grid-cols-[1fr_auto_1fr] items-center">
                        <div className="flex items-center justify-end gap-1">
                            <a href={PRIVACY_POLICY_URL} {...away} title="Privacy policy"
                                className={`${STRIP_ITEM} text-slate-600 hover:text-slate-300`}>
                                <Shield className="w-3.5 h-3.5" />
                            </a>
                            <a href={PROJECT_REPO_URL} {...away} title="View on GitHub"
                                className={`${STRIP_ITEM} text-slate-600 hover:text-slate-300`}>
                                <Github className="w-3.5 h-3.5" />
                            </a>
                        </div>
                        {/* A medal, and centred: this is the one control in the strip that is not a
                            tool but an acknowledgement — whose disassembly, whose XDF, whose DS2
                            tool this is built on. It was an ⓘ among five other icons, which read as
                            "about this app" rather than "about whose work this is". */}
                        <button type="button" onClick={onOpenCredits} title="Credits — whose work this is built on"
                            className={`${STRIP_ITEM} text-slate-500 hover:text-amber-400`}>
                            <Medal className="w-4 h-4" />
                        </button>
                        <div className="flex items-center justify-start gap-1">
                            <a href={CREDIT_LINKS.tuningThread} {...away} title="Methodology source: NA M3 Forum"
                                className={`${STRIP_ITEM} text-slate-600 hover:text-amber-400`}>
                                <BookOpen className="w-3.5 h-3.5" />
                            </a>
                            {/* Tinted and pulsing on an update, exactly as the header's twin is — the
                                one state of this control that has to be seen without being looked for. */}
                            <button type="button" onClick={onReload}
                                title={updateAvailable ? 'A newer build is on the server — reload to take it' : 'Reload the app'}
                                className={`${STRIP_ITEM} ${updateAvailable ? 'text-blue-400 animate-pulse' : 'text-slate-600 hover:text-slate-300'}`}>
                                <RefreshCw className="w-3.5 h-3.5" />
                            </button>
                            {/* The unavailable case is shown, not hidden. "I looked for install and
                                found nothing" is the report this exists to answer, and a control that
                                disappears cannot answer it — so it stays, greyed, with the reason on
                                the title. Gone only once there is genuinely nothing to install to. */}
                            {installState !== 'installed' && (
                                <button type="button"
                                    onClick={installState === 'ready' ? onInstall : undefined}
                                    disabled={installState !== 'ready'}
                                    title={installState === 'ready' ? 'Install to device'
                                        : installState === 'ios' ? 'Share → Add to Home Screen'
                                            : installState === 'dismissed' ? 'Install declined — reload to be asked again'
                                                : 'Install — not offered by this browser'}
                                    className={`${STRIP_ITEM} ${installState === 'ready'
                                        ? 'text-emerald-400 hover:text-emerald-300' : 'text-slate-700 cursor-default'}`}>
                                    <Download className="w-3.5 h-3.5" />
                                </button>
                            )}
                        </div>
                    </div>
                    {/* Which build this phone is actually running. Never acted on, but it is the
                        first thing asked when a device behaves differently from the desk — and a
                        service worker serving a stale bundle is a real failure mode here, which is
                        why the cache name rides along. */}
                    {buildLabel && (
                        <p className="pb-1 text-center font-mono text-[9px] leading-none text-slate-700 break-all">{buildLabel}</p>
                    )}
                </div>

                {/* Laid out to fit, and never scrolled: the flash count is the one control in here
                    and a band that scrolls can hide it. `shrink-0`, so a short viewport takes its
                    height out of VIEW instead — VIEW is the only band that absorbs a squeeze. */}
                <Band title="Vehicle">
                    <div className={BAND_BODY}>
                        <div className={READOUT_COLUMN}>
                            <Field label="VIN">{identity?.vin ?? <span className="text-slate-600">{linkState === 'disconnected' ? 'not connected' : 'reading'}</span>}</Field>
                            <Field label="AIF">{identity?.aif}</Field>
                            <Field label="SW">{identity?.softwareVersion}</Field>
                        </div>
                        {/* Still a control, and still one step deeper than the number it changes —
                            so it is centred rather than aligned to the readouts. It is the one thing
                            in this band you press, and it should not read as a fourth field. */}
                        <button
                            type="button"
                            {...row('flash', () => { onOpenFlash(); onClose(); }, !flashEnabled)}
                            className={`mt-2 [@media(max-height:560px)]:mt-1 w-full flex items-center justify-center gap-2 min-h-[44px] [@media(max-height:560px)]:min-h-[36px] rounded enabled:cursor-pointer disabled:cursor-default ${lit('flash')}`}
                        >
                            <Gauge className="w-3.5 h-3.5 shrink-0 text-slate-600" />
                            <span className="text-[9px] uppercase tracking-widest text-slate-600">Flash</span>
                            <span className={`font-mono text-[11px] ${flashColor}`}>{flashText}</span>
                        </button>
                    </div>
                </Band>

                {/* Fixed height too, and that is why every field and every cell is always drawn.
                    Nothing here appears or disappears with what is loaded: an empty session shows
                    the three labels against em-dashes and the downloads greyed out. A band that
                    changed height would move VIEW under the thumb between one glance and the next,
                    and a control that vanishes cannot say why it is not available. */}
                <Band title="Session">
                    <div className={BAND_BODY}>
                        <div className={`${READOUT_COLUMN} mb-2 [@media(max-height:560px)]:mb-1`}>
                            <Field label="Name">
                                {session && (
                                    <span className="inline-flex items-baseline gap-2 min-w-0">
                                        <span className="min-w-0 truncate">{session.label}</span>
                                        {session.archived && <span className="shrink-0 text-[8px] uppercase tracking-widest text-slate-500">read-only</span>}
                                    </span>
                                )}
                            </Field>
                            <Field label="Base">{baseOrigin}</Field>
                            <Field label="Log">
                                {logName && (
                                    <span className="inline-flex items-baseline gap-2 min-w-0">
                                        <span className="min-w-0 truncate text-[10px]">{logName}</span>
                                        {logPoints !== undefined && <span className="shrink-0 text-[10px] text-slate-600">{logPoints}pts</span>}
                                    </span>
                                )}
                            </Field>
                        </div>

                        {/* The failure, in text, on the device that cannot hover.
                            ────────────────────────────────────────────────────────────────────────
                            Everything else here keeps its long form in `title`, which is correct for
                            a label whose short form is already the answer. It is wrong for an error:
                            the short form is "Sync failed" and the long form is the only thing that
                            says WHY. A phone has no hover, so on the one platform this band exists
                            to serve, the app could report that an upload failed and had no way to
                            report the reason. Rendered only in the error tone — and it is allowed to
                            change this band's height, unlike everything else in it, because an
                            upload that failed is worth a reflow. */}
                        {syncLook?.tone === 'error' && sync?.error && (
                            <p className="pb-2 text-[10px] leading-relaxed text-red-400 break-words">{sync.error}</p>
                        )}

                        <div
                            ref={pager}
                            onScroll={e => {
                                const el = e.currentTarget;
                                if (el.clientWidth) setPage(Math.round(el.scrollLeft / el.clientWidth));
                            }}
                            className="no-scrollbar flex overflow-x-auto overscroll-x-contain snap-x snap-mandatory touch-pan-x"
                        >
                            {/* Page one: the three pressed every run. None of them is wired through
                                `row()` — the sweep's hit test must return null over all three so a
                                finger travelling up the sheet cannot release onto SAVE and write to
                                the database, onto SYNC and open an upload, or onto NEW SESSION and
                                discard an empty draft. Do not add `data-menu-key` to any of them. */}
                            {/* NEW, SAVE, SYNC — a session's life left to right, and SAVE on the
                                centre line because it is the one pressed after every run. Page two
                                puts TUNED on that same line, so a flick between the pages does not
                                move the eye off the column it was reading. */}
                            <div className={PAGE}>
                                <button
                                    type="button"
                                    onClick={() => { onNewSession(); onClose(); }}
                                    title="Start a fresh draft and go to STARTUP"
                                    className={`${MENU_CELL} text-blue-400 hover:bg-slate-800 cursor-pointer`}
                                >
                                    <Plus className="w-4 h-4 shrink-0" />
                                    <span className="max-w-full truncate">New</span>
                                </button>
                                {saveLook && (
                                    <button
                                        type="button"
                                        onClick={saveLook.disabled ? undefined : onSave}
                                        disabled={saveLook.disabled}
                                        title={saveLook.title}
                                        className={`${MENU_CELL} ${saveLook.tone === 'ready' ? 'text-amber-400 hover:bg-slate-800 cursor-pointer'
                                            : saveLook.tone === 'busy' ? 'text-slate-500 animate-pulse cursor-wait'
                                                : 'text-slate-700 cursor-default'}`}
                                    >
                                        <Database className="w-4 h-4 shrink-0" />
                                        <span className="max-w-full truncate">Save</span>
                                    </button>
                                )}
                                {/* SYNC is the store panel's door, not a second control beside it.
                                    Sending and configuring where it sends were two cells that had to
                                    be told apart, and the panel behind this one is already titled
                                    SESSION SYNC and already carries the send — see `topAction`
                                    there. The tone is still describeSync's, so the cell reports the
                                    same state it always did. */}
                                {storePanel}
                            </div>

                            {/* Page two: the files. Three slots, always all three, greyed when the
                                bytes do not exist — an absent cell would change the grid under the
                                thumb and could not say why it had gone. Same three columns as page
                                one, so the two pages line up rather than sliding sideways. */}
                            <div className={PAGE}>
                                {DOWNLOAD_SLOTS.map(slot => {
                                    const a = actions.find(x => x.kind === slot.kind);
                                    const Icon = ICONS[slot.kind];
                                    return a ? (
                                        <button
                                            key={slot.kind}
                                            type="button"
                                            title={a.hint}
                                            {...row(`action:${slot.kind}`, () => { a.onClick(); onClose(); })}
                                            className={`${MENU_CELL} text-slate-400 hover:text-blue-400 hover:bg-slate-800 cursor-pointer ${lit(`action:${slot.kind}`)}`}
                                        >
                                            <Icon className="w-4 h-4 shrink-0" />
                                            {/* "Download BASE" does not fit 90px. The verb is the
                                                icon's job here; the cell says which bytes. */}
                                            <span className="max-w-full truncate">{a.label.replace(/^Download /, '')}</span>
                                        </button>
                                    ) : (
                                        <button
                                            key={slot.kind}
                                            type="button"
                                            disabled
                                            title={slot.absent}
                                            className={`${MENU_CELL} text-slate-700 cursor-default`}
                                        >
                                            <Icon className="w-4 h-4 shrink-0" />
                                            <span className="max-w-full truncate">{slot.fallback}</span>
                                        </button>
                                    );
                                })}
                            </div>
                        </div>

                        <div className="mt-2 [@media(max-height:560px)]:mt-1 flex items-center justify-center gap-3">
                            {[0, 1].map(i => (
                                <button
                                    key={i}
                                    type="button"
                                    onClick={() => goTo(i)}
                                    aria-label={i === 0 ? 'Session actions' : 'Downloads'}
                                    aria-current={page === i}
                                    className="p-2 -m-2 cursor-pointer"
                                >
                                    <span className={`block w-1.5 h-1.5 rounded-full transition-colors ${page === i ? 'bg-slate-400' : 'bg-slate-700'}`} />
                                </button>
                            ))}
                        </div>
                    </div>
                </Band>

                {/* The only band that scrolls, and the only one that gives ground. Ten destinations
                    do not fit under two bands of readouts and controls, and on a landscape phone
                    neither does much else — so this is where the squeeze goes, by being the only
                    `flex-1` in the column. It reaches one row on a 375px-tall viewport and scrolls
                    from there; the two bands above keep every control they have. */}
                <Band title="View" className="flex-1 min-h-[88px]">
                    <div ref={tabScroller} className="no-scrollbar flex-1 min-h-0 overflow-y-auto overscroll-contain px-4 pb-2">
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
                                    className={`flex items-center justify-center text-center min-h-[44px] py-3 px-2 -mx-2 rounded text-[11px] font-bold tracking-widest transition-colors ${lit(`tab:${t.id}`)} ${activeTab === t.id ? 'text-blue-400'
                                        : t.enabled ? 'text-slate-400' : 'text-slate-700 cursor-default'}`}
                                >
                                    {t.label}
                                </button>
                            ))}
                        </div>
                    </div>
                </Band>

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
