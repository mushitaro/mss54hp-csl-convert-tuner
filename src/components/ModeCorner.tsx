import React from 'react';
import { Lock } from 'lucide-react';
import { LOG_PROFILES, type ProcessId } from '@/lib/log-engine/logProfile';
import { AnchoredSheet, useAnchoredMenu } from './anchoredMenu';

/**
 * MODE — what this session measures, in the hub panel's bottom-LEFT corner.
 *
 * The mirror of RESTORE, and deliberately the same shape: same `h-7` row, same 8px title beside a
 * 9px mono value, same anchored sheet. The two corners are the pair of things that qualify what the
 * dial between them is about to do — RESTORE says what the next WRITE puts back, MODE says what the
 * next run records — so they read as siblings or they read as clutter.
 *
 * ## Why it is a corner and not a wing
 *
 * The wings flank the dial because they are touched on every campaign. This is touched once per
 * session, at the start, and then never again for the life of that session — closer to RESTORE's
 * cadence than to WRITE's. Putting it beside the dial would give a once-per-session decision the
 * prominence of a per-flash one, and crowd the cluster that is read at arm's length in a car.
 *
 * ## Why it never disappears
 *
 * The window in which the mode can be CHANGED closes the moment the session holds a log — see
 * `lockReason`. The corner does not close with it. It becomes a readout in the same slot, at the
 * same height, because two things break otherwise: the row reflows at the exact moment a run
 * starts, and "which mode is this session" stops being answerable from any tab but STARTUP.
 *
 * ## Why a locked corner is still tappable
 *
 * `title` has no hover on a phone, and this app is used on one in a garage. A control that will not
 * move and will not say why is the one that gets reported as broken. So locked opens the same sheet
 * with the reason at the top of it and the options inert — the pattern the manifest's locked rows
 * already use, rather than a second one.
 */

/** Why the mode cannot be changed right now, in the reader's language. `null` = it can. */
export type ModeLock = 'no-session' | 'archived' | 'running' | 'has-log' | null;

const LOCK_TEXT: Record<Exclude<ModeLock, null>, string> = {
    'no-session': 'No session is open. MODE belongs to a session, so there is nothing for it to '
        + 'describe yet — create one on STARTUP and it opens on VE.',
    archived: 'This session is archived and read-only. What it recorded is a fact about a run that '
        + 'has already happened; changing the label would make the record disagree with the samples '
        + 'in it.',
    running: 'A run is in progress. The DS2 exchanges for this mode were settled when it started, '
        + 'and the samples arriving now are made of them.',
    'has-log': 'This session already holds a log. MODE decides which channels a run records, so '
        + 'changing it now would leave the session claiming a mode its samples were not captured '
        + 'in. Start a new session to measure something else.',
};

export const ModeCorner: React.FC<{
    mode: ProcessId;
    /**
     * What this BUILD may offer — `selectableModes(isPreview)`, passed in rather than read here.
     *
     * Production renders neither the IDLE nor the INERTIA tab, so offering those modes there would
     * hide the VE workflow in favour of tabs that do not exist. The page owns the variant bit, and
     * a component that reached for it independently would be a second answer to the question the
     * feature registry already answers.
     */
    modes: ProcessId[];
    onChange: (next: ProcessId) => void;
    lock: ModeLock;
}> = ({ mode, modes, onChange, lock }) => {
    const { triggerRef, open, anchor, toggle, close } = useAnchoredMenu();
    const locked = lock !== null;
    return (
        <div className="relative">
            <button ref={triggerRef} onClick={toggle} className="h-7 flex items-center gap-2 cursor-pointer group/row">
                {/* The same tiny-tag size and label grey RESTORE wears. Blue whenever the session is
                    on something other than VE: VE is what almost every session is, so saying so in
                    the accent would make the accent mean "a session exists". */}
                <span className={`text-[8px] font-bold tracking-widest uppercase transition-colors whitespace-nowrap ${mode === 'VE' ? 'text-slate-600 group-hover/row:text-slate-400' : 'text-blue-400'}`}>
                    Mode
                </span>
                <span className="flex items-center gap-1 text-[9px] font-mono uppercase tracking-wider text-slate-500">
                    {LOG_PROFILES[mode].label}
                    {/* Rendered, not a `title`. Touch has no hover, and this is the one glyph that
                        answers "why will this not move" before the sheet is opened. */}
                    {locked && <Lock className="w-2.5 h-2.5 text-slate-700" />}
                </span>
            </button>

            {/* AnchoredSheet portals itself to the body — the hub cluster is a transformed ancestor,
                and a `fixed` sheet rendered inside it is pinned to the dial instead of the viewport. */}
            {open && (
                <AnchoredSheet
                    title="Mode"
                    caption="What this session measures"
                    anchor={anchor}
                    onClose={close}
                >
                    {locked && (
                        <p className="mb-3 text-[9px] leading-[13px] text-slate-500 whitespace-pre-line">
                            {LOCK_TEXT[lock]}
                        </p>
                    )}
                    <div className="space-y-1">
                        {modes.map(id => {
                            const profile = LOG_PROFILES[id];
                            const active = id === mode;
                            return (
                                <button
                                    key={id}
                                    disabled={locked}
                                    onClick={() => { onChange(id); close(); }}
                                    className={`w-full text-left rounded px-2 py-2 transition-colors
                                        ${active ? 'bg-slate-800' : 'hover:bg-slate-800/60'}
                                        ${locked ? 'cursor-default opacity-40' : 'cursor-pointer'}`}
                                >
                                    <div className={`text-[10px] font-bold tracking-widest uppercase ${active ? 'text-blue-400' : 'text-slate-400'}`}>
                                        {profile.label}
                                    </div>
                                    {/* The profile's own one-liner, not a copy of it. It says what
                                        comes OUT of the run, which is the question someone choosing
                                        between three of them is actually asking. */}
                                    <div className="text-[9px] leading-[13px] text-slate-600">
                                        {profile.produces}
                                    </div>
                                </button>
                            );
                        })}
                    </div>
                    {/* The window, stated where the choice is made rather than discovered when it
                        closes. Not shown while locked — there the reason above already says it. */}
                    {!locked && (
                        <p className="mt-3 pt-2 border-t border-slate-800 text-[9px] leading-[13px] text-slate-600">
                            Settable until this session holds a log. After the first sample it becomes
                            a record of what was measured.
                        </p>
                    )}
                </AnchoredSheet>
            )}
        </div>
    );
};

/**
 * The same word, for the session list's rows.
 *
 * A badge rather than the corner: the list shows many sessions at once and none of them is the one
 * being changed. Absent `process` reads as VE for the reason the schema gives — every session
 * recorded before profiles existed polled blocks 3 and 19 and could produce nothing else.
 */
export const ModeBadge: React.FC<{ process?: ProcessId }> = ({ process }) => {
    const id = process ?? 'VE';
    return (
        <span
            title={`${LOG_PROFILES[id].label} — ${LOG_PROFILES[id].produces}`}
            className={`shrink-0 font-mono uppercase tracking-wider text-[8px] px-1 py-0.5 rounded
                ${id === 'VE' ? 'text-slate-600 bg-slate-800/60' : 'text-blue-400 bg-blue-500/15'}`}
        >
            {LOG_PROFILES[id].label}
        </span>
    );
};
