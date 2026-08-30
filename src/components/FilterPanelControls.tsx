'use client';

import React from 'react';
import { Info } from 'lucide-react';

/**
 * The filter panel's shared vocabulary: one row shape, one sub-field shape, one slider.
 *
 * These lived inside `FilterConfigPanel` and could not be imported by anything, because the panel
 * imports its own children. `RfKorrSourceControl` is one of those children, and being unable to
 * reach `Row` is exactly why it grew a heading, an information layout and a set of always-open
 * paragraphs of its own — a control that could not share the vocabulary invented a second one.
 *
 * So the vocabulary moves here, where both can have it. The rule this enforces is the one the panel
 * was already trying to state: every setting in it is a Row, and a Row is a label, a live value, an
 * explanation behind the ⓘ, and the control itself. Anything that needs to be different from that
 * has to say why in a comment rather than by drifting.
 */

/**
 * One control, one shape.
 *
 * Everything in this panel is the same object: a name, a value, an optional on/off, sliders, and an
 * explanation that is out of the way until asked for. Before this there were three shapes — sliders
 * with a permanent paragraph under them, a bare checkbox, and a pair of number inputs — and the
 * paragraphs alone ran the panel to twice the height of a phone.
 *
 * The explanation lives behind the ⓘ and never in a `title`. Chrome for Android surfaces `title` on
 * neither tap nor long-press, so an explanation put there does not exist on the device this panel is
 * read on. The disabled reason is the exception and is always visible: a control that cannot be
 * pressed has to say why without being asked.
 */
export const Row: React.FC<{
    id: string;
    label: string;
    value?: React.ReactNode;
    /** Omitted for a row with no on/off of its own. */
    toggle?: { checked: boolean; onChange: (v: boolean) => void; accent?: string };
    /** Non-empty means the control is inert on this log, and says so. */
    lockedReason?: string;
    hint: string;
    infoLabel: string;
    open: boolean;
    onToggleInfo: () => void;
    children?: React.ReactNode;
}> = ({ id, label, value, toggle, lockedReason, hint, infoLabel, open, onToggleInfo, children }) => {
    const on = toggle ? toggle.checked : true;
    const live = on && !lockedReason;
    return (
        <div className="space-y-1" data-filter-row={id}>
            <div className="flex justify-between items-center gap-2 text-[10px] text-slate-500 uppercase tracking-wider">
                {toggle ? (
                    <label className={`py-3 -my-3 flex items-center gap-2 min-w-0 ${lockedReason ? 'cursor-not-allowed' : 'cursor-pointer'}`}>
                        <input
                            type="checkbox"
                            checked={toggle.checked}
                            disabled={!!lockedReason}
                            onChange={(e) => toggle.onChange(e.target.checked)}
                            className={`w-3 h-3 rounded bg-slate-700 border-none shrink-0 ${toggle.accent ?? 'accent-blue-500'} disabled:opacity-40`}
                        />
                        <span className={`truncate ${lockedReason ? 'text-slate-700' : ''}`}>{label}</span>
                    </label>
                ) : (
                    <span className="truncate">{label}</span>
                )}
                <span className="flex items-center gap-1 shrink-0">
                    {value !== undefined && (
                        <span className={live ? 'text-slate-300' : 'text-slate-600'}>{value}</span>
                    )}
                    <button
                        type="button"
                        onClick={onToggleInfo}
                        aria-expanded={open}
                        aria-label={infoLabel}
                        className={`p-1.5 -mr-1.5 rounded transition-colors ${open ? 'text-blue-400' : 'text-slate-600 hover:text-slate-400'}`}
                    >
                        <Info className="w-3 h-3" />
                    </button>
                </span>
            </div>
            {children}
            {/* Above the explanation, not inside it: the reason a control cannot be used is not
                background reading. */}
            {lockedReason && (
                <p className="text-[9px] text-amber-500/80 leading-snug">{lockedReason}</p>
            )}
            {open && (
                <p className="text-[9px] text-slate-500 leading-relaxed whitespace-pre-line pt-0.5">{hint}</p>
            )}
        </div>
    );
};

/**
 * The width of the thumb Chrome draws.
 *
 * Not read from anywhere, because it cannot be: the thumb is in the UA shadow tree, and
 * `getComputedStyle(el, '::-webkit-slider-thumb')` answers with the ORIGINATING element's box — the
 * track. It is measured by eye and pinned here.
 *
 * It matters beyond locating the thumb: `move` derives the drag's gain from `width - THUMB_PX`, so
 * a value too large models a longer travel than exists and the control lags the pointer across the
 * whole track. If an author thumb is ever added in globals.css, this has to follow its size.
 */
const THUMB_PX = 16;
/** How far from the thumb a press still counts as grabbing it. Generous on purpose — see below. */
const GRAB_PX = 24;
/** Movement below this is a press, not a drag. */
const SLOP_PX = 3;

/**
 * A slider that changes only while its thumb is being dragged.
 *
 * A native range input jumps to wherever the track is pressed. That is right for a volume control
 * and wrong for these: every one of them sets an evidence threshold, and moving one re-derives the
 * map with no undo and nothing announced.
 *
 * The first attempt cancelled the stray press with `preventDefault` on pointerdown. It did not work
 * on the phone, and the measurement that said it did was worthless — the events were dispatched
 * from JavaScript, and an untrusted event never triggers a default action in the first place, so
 * there was never anything there to prevent.
 *
 * So the native control is taken out of the pointer path instead of being argued with:
 * `pointer-events: none` on the input, and a transparent band over it that handles the pointer
 * itself. Nothing is cancelled, so nothing depends on what a browser does with a cancelled event.
 *
 *   • A press further than GRAB_PX from the thumb is ignored — not prevented, never acted on.
 *   • A press on the thumb starts a drag, and the value follows the pointer's movement FROM WHERE
 *     IT WAS GRABBED. A press that does not move therefore cannot change the value at all, which
 *     is what makes a generous grab radius free: the worst a sloppy hit can do is nothing.
 *   • The keyboard is untouched. The input still takes focus by Tab and still fires `change` on the
 *     arrow keys — the one path that never involved a pointer.
 *
 * The band is 16px tall against the track's 4px, positioned rather than padded so it adds nothing to
 * the layout, and `touch-action: pan-y` leaves a vertical swipe scrolling the panel: seven of these
 * claiming a 16px band each would otherwise make the panel hard to scroll.
 *
 * ## The drag never re-renders the panel
 *
 * This control is owned by a panel of ~20 rows, and it used to hand every pointer-move to
 * `onChange` — so the thumb could only move as fast as the WHOLE panel re-rendered, once per
 * move. On the phone that is the stutter the transient-filter section was reported for: three
 * sliders in a row, each drag fighting a full panel render per frame.
 *
 * While a pointer holds the thumb, the value lives HERE (`dragValue`): the thumb tracks the
 * finger with a Slider-sized render. The owner hears about it on a 90 ms throttle — enough for
 * the row's readout to follow at a readable cadence — and the release flushes the final value
 * synchronously, in the same event as `setDragValue(null)`, so both commit together and the
 * thumb cannot snap back to a stale prop. The keyboard path still calls `onChange` directly:
 * arrow keys are discrete.
 */
export const Slider: React.FC<{
    min: number; max: number; step?: number; value: number; disabled?: boolean;
    accent?: string; onChange: (v: number) => void;
}> = ({ min, max, step = 1, value, disabled, accent = 'accent-blue-500', onChange }) => {
    const drag = React.useRef<{ id: number; from: number; x: number; moved: boolean; travel: number } | null>(null);
    /** The thumb's value while a pointer holds it; null hands the thumb back to the prop. */
    const [dragValue, setDragValue] = React.useState<number | null>(null);
    /** The same number as a ref, because the pointer handlers of the LAST committed render must
     *  compare against what the thumb already shows, not against a one-frame-old state closure. */
    const liveRef = React.useRef<number | null>(null);
    const emitRef = React.useRef<{ timer: ReturnType<typeof setTimeout> | null; v: number; ms: number }>({ timer: null, v: value, ms: 90 });
    const onChangeRef = React.useRef(onChange);
    React.useEffect(() => { onChangeRef.current = onChange; });
    const shown = dragValue ?? value;

    /** Trailing 90 ms: the owner's readout follows the drag at ~11 Hz instead of per move. */
    const emitThrottled = (v: number) => {
        emitRef.current.v = v;
        if (emitRef.current.timer !== null) return;
        emitRef.current.timer = setTimeout(() => {
            emitRef.current.timer = null;
            onChangeRef.current(emitRef.current.v);
        }, emitRef.current.ms);
    };

    /** How far this press landed from the thumb's centre, in px. */
    const offThumb = (band: HTMLElement, clientX: number) => {
        const r = band.getBoundingClientRect();
        // The thumb's centre travels between half a thumb in from each end, never to the edges.
        //
        // Clamped, because `value` is not guaranteed to be inside [min, max]: a stored session
        // carries whatever the control's range was when it was saved, and a range that has since
        // narrowed leaves the value outside it. The native input pins its thumb at the end in that
        // case; this arithmetic put the "thumb" off the track entirely, so no press was ever within
        // 24px of it and the slider could not be grabbed at all — with nothing on screen to say why.
        const frac = max > min ? Math.min(1, Math.max(0, (value - min) / (max - min))) : 0;
        return Math.abs(clientX - (r.left + THUMB_PX / 2 + frac * (r.width - THUMB_PX)));
    };

    const grab = (e: React.PointerEvent<HTMLDivElement>) => {
        if (disabled || offThumb(e.currentTarget, e.clientX) > GRAB_PX) return;
        liveRef.current = value;
        // The band's rect is read ONCE, here. `move` used to read it per event — and a phone
        // delivers pointermove at 60-120 Hz, each read forcing a synchronous layout whenever the
        // last readout commit had dirtied it, which is most of the time. That stall, repeated at
        // input rate, is what "sticky on the phone" was. A drag cannot outlive a resize, so the
        // travel measured at grab time IS the travel.
        drag.current = {
            id: e.pointerId, from: value, x: e.clientX, moved: false,
            travel: Math.max(1, e.currentTarget.getBoundingClientRect().width - THUMB_PX),
        };
        // A finger hides the readout anyway, and the phone pays several times a desktop's price
        // for each readout commit — so touch reports at 160 ms, a mouse at 90.
        emitRef.current.ms = e.pointerType === 'mouse' ? 90 : 160;
        e.currentTarget.style.cursor = 'grabbing';
        // Throws for a pointer the browser has no record of, which is every synthetic one.
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* not a live pointer */ }
    };

    const move = (e: React.PointerEvent<HTMLDivElement>) => {
        const d = drag.current;
        if (!d || d.id !== e.pointerId) return;
        const dx = e.clientX - d.x;
        // Landing on the thumb and letting go is a no-op rather than a one-step nudge.
        if (!d.moved && Math.abs(dx) < SLOP_PX) return;
        d.moved = true;
        const raw = d.from + (dx / d.travel) * (max - min);
        // Snapped from `min`, which is where a range input's own step grid starts.
        const next = Math.min(max, Math.max(min,
            Number((min + Math.round((raw - min) / step) * step).toFixed(4))));
        if (next !== (liveRef.current ?? value)) {
            liveRef.current = next;
            setDragValue(next);
            emitThrottled(next);
        }
    };

    const drop = (e: React.PointerEvent<HTMLDivElement>) => {
        if (drag.current?.id !== e.pointerId) return;
        const moved = drag.current.moved;
        drag.current = null;
        e.currentTarget.style.cursor = '';
        try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* never captured */ }
        if (emitRef.current.timer !== null) { clearTimeout(emitRef.current.timer); emitRef.current.timer = null; }
        // Synchronous, so this batches with setDragValue(null): the owner's echo of the final
        // value and the hand-back of the thumb land in ONE commit, and there is no frame in
        // which the thumb shows a value the owner has not yet heard.
        if (moved && liveRef.current !== null) onChangeRef.current(liveRef.current);
        liveRef.current = null;
        setDragValue(null);
    };

    /** Desktop only: say which part of this band is the control. Written straight to the node — a
     *  cursor is not state, and putting it in React state would re-render on every mouse move. */
    const hint = (e: React.PointerEvent<HTMLDivElement>) => {
        if (drag.current || e.pointerType !== 'mouse') return;
        e.currentTarget.style.cursor = !disabled && offThumb(e.currentTarget, e.clientX) <= GRAB_PX
            ? 'grab' : '';
    };

    return (
        /*
         * `py-1.5` reserves the thumb, and that is a layout fact rather than a margin preference.
         *
         * The input is `h-1` — a 4px track — but the thumb Chrome draws over it is 16px, so it
         * overhangs 6px above and below and paints on whatever is next to it. The wrapper used to be
         * the height of the TRACK, so every `space-y-*` around a slider was spacing something two
         * pixels tall against something sixteen pixels tall, and the neighbours it collided with
         * varied by which group the slider was in: the COVERAGE sub-fields sat flush against their
         * own "Samples"/"Weight" labels, and the Covered At legend was overlapped outright.
         *
         * Reserving the overhang here fixes all of them at once and keeps fixing them: a control
         * whose box is the size it draws can be spaced with the ordinary scale, and the next slider
         * added inherits that rather than needing its own neighbour-specific padding.
         *
         * 6px is exactly the overhang (`(THUMB_PX - 4) / 2`). It moves with THUMB_PX — if an author
         * thumb is ever added in globals.css, both change together.
         */
        <div className="relative py-1.5">
            <input
                type="range"
                min={min} max={max} step={step}
                disabled={disabled}
                value={shown}
                onChange={(e) => onChange(Number(e.target.value))}
                /* `accent-*` colours the thumb, and `appearance-none` does not stop it — see the
                   note in globals.css, which is where that was got wrong twice. */
                className={`block w-full h-1 rounded-lg appearance-none pointer-events-none ${disabled ? 'bg-slate-800 accent-slate-600' : `bg-slate-700 ${accent}`}`}
            />
            {/* The pointer target, now the full height of the reserved box rather than the track
                plus a hand-tuned overhang — `inset-0` and `-inset-y-1.5` describe the same 16px band
                as long as the padding above is the thumb's overhang, and this one cannot drift out
                of step with it. */}
            <div
                className="absolute inset-0 touch-pan-y"
                onPointerDown={grab}
                onPointerMove={(e) => { move(e); hint(e); }}
                onPointerUp={drop}
                onPointerCancel={drop}
            />
        </div>
    );
};

/**
 * One number inside a group that shares a switch.
 *
 * The VE and RF KORR gates are two numbers each, and stacking their sliders with one shared label
 * put two 18px thumbs four pixels apart with nothing saying which was which. Each gets its own name,
 * its own readout and its own line.
 */
/** `space-y-2` rather than `1.5`, to match the gap a labelled Row leaves. A sub-field's label sits
 *  closer to its slider than a row's does, and with the thumb's 6px overhang now reserved that came
 *  out at 6px of daylight against the rest of the panel's 8.5. */
export const SubField: React.FC<{ label: string; value: string; dim?: boolean; children: React.ReactNode }> = (
    { label, value, dim, children },
) => (
    <div className="space-y-2">
        <div className="flex justify-between items-baseline text-[9px] uppercase tracking-wider">
            <span className={dim ? 'text-slate-700' : 'text-slate-500'}>{label}</span>
            <span className={dim ? 'text-slate-700' : 'text-slate-400 font-mono'}>{value}</span>
        </div>
        {children}
    </div>
);
