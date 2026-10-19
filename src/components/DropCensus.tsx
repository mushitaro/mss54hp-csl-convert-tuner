'use client';

import React from 'react';
import { createPortal } from 'react-dom';
import type { DropCensus as Census } from '@/lib/log-engine/lambdaGates';
import { DROP_LABEL, DROP_WHY, droppedReasons } from '@/lib/log-engine/dropReasons';
import { useDialogLang } from '@/hooks/useDialogLang';

/**
 * Why the log is shorter than the drive was.
 *
 * The count on its own — "751 valid of 1600" — is the least actionable number in the app. Half the
 * drive is gone and nothing says whether the answer is to warm the engine first, hold a steadier
 * throttle, write the tank-vent patch, or stop pulling to redline. Every reason below is separately
 * fixable, and naming them is the difference between a filtered log and an instruction for the next
 * run.
 *
 * ## The nine explanations nobody had ever seen
 *
 * The LABELS were pulled out of a tooltip long ago with the right argument written beside them:
 * this is the number a driver reads standing next to the car on a phone, where hover does not
 * exist. The nine EXPLANATIONS stayed behind in a `title` regardless — so the half that says what
 * to DO about each reason was unreachable on the only device that reads this line, and English-only
 * besides, against the house rule that names stay put while explanations follow the reader. The
 * operator confirmed it on 2026-08-24: never seen one.
 *
 * The line is a button now, and it opens a sheet with every reason it is showing, each with its
 * sentence, in the reader's language. Same door as the DRIVE SPLIT chip and for the same reason: a
 * compact readout that has more to say has to say where the rest of it is.
 *
 * The names and the sentences live in lib/log-engine/dropReasons, because the assistant bridge
 * says the same sentences to the same driver and the two must not drift.
 */

const SHEET = {
    ja: { title: '除外されたサンプル', hint: 'それぞれ、次の走行で減らす方法が違います。' },
    en: { title: 'Samples left out', hint: 'Each one has a different cure on the next drive.' },
} as const;

export const DropCensusLine: React.FC<{
    census: Census;
    className?: string;
    /**
     * Clip to one line instead of wrapping.
     *
     * For the header, where the slot is a measured 243px on a phone and a line that grew would push
     * the readouts beside it off the screen. The sheet is what makes the clipping honest: the row
     * is sorted by count, so what falls off the end is the smallest reason, and everything is one
     * tap away. The wide layout keeps the wrapping it was measured with.
     */
    compact?: boolean;
    /**
     * One token — the total left out — instead of the reasons.
     *
     * For the phone band, which had this line to itself and could not fit it: the row is a measured
     * 343px, the readouts beside it take 327, and the census wants 189. It got its own line, and a
     * whole line of a phone screen for a list read once is the thing the operator asked to reclaim
     * (2026-08-25). As a chip it joins the readouts — VALID and DROP are the pair that matter, and
     * TOTAL was the sum of them — and every reason is still one tap away in the same sheet.
     */
    chip?: boolean;
    /**
     * The drive's TOTAL sample count, which turns the chip from "how many were left out" into
     * "how many there were" (operator, 2026-08-30).
     *
     * VALID sits beside it and the drop count is their difference, so TOTAL is the number that
     * cannot be worked out from the other one on the row — and it is the one that says whether a
     * drive was long enough to mean anything before any of the filtering is argued about.
     *
     * The door stays. Tapping still opens the census that says WHY the difference exists, which is
     * the only part of it anyone can act on. Given this, the chip also survives a drive with
     * nothing dropped: it renders as plain text rather than a button, because a control that opens
     * an empty sheet is worse than a number.
     */
    total?: number;
}> = ({ census, className, compact = false, chip = false, total }) => {
    const lang = useDialogLang();
    const [open, setOpen] = React.useState(false);
    /**
     * The sheet is portalled to `document.body`, and that is not tidiness.
     *
     * On a phone this line lives in the header, and the header carries `backdrop-blur-md` — a
     * backdrop-filter makes its element the containing block for every `position: fixed`
     * descendant. Rendered in place, `bottom-[60px]` measured 60px up from the HEADER's bottom
     * edge: the sheet opened at y = -422 on a 812px screen, entirely off the top, while every
     * class on it read as correct. Measured 2026-08-24.
     *
     * `mounted` because a portal needs a DOM and this component is in the static export.
     */
    const [mounted, setMounted] = React.useState(false);
    React.useEffect(() => setMounted(true), []);

    const rows = droppedReasons(census);

    const dropped = rows.reduce((sum, [, n]) => sum + n, 0);

    // Nothing dropped is worth saying out loud — it is the best possible outcome and an empty row
    // would read as a missing feature. Unless a TOTAL was given: that number is about the drive
    // rather than about the filter, so it belongs on the row either way, and only the door goes.
    if (!rows.length) {
        return total === undefined ? null : (
            <span className={`flex items-center gap-1.5 text-[9px] font-mono leading-none whitespace-nowrap ${className ?? ''}`}>
                <span className="text-slate-600">TOTAL</span>
                <span className="text-slate-500 font-bold">{total.toLocaleString()}</span>
            </span>
        );
    }

    return (
        <>
            <button
                type="button"
                onClick={() => setOpen(true)}
                title={SHEET[lang].title}
                className={`flex items-center gap-x-2 gap-y-0.5 text-[9px] font-mono leading-none text-left ${compact ? 'flex-nowrap overflow-hidden min-w-0' : 'flex-wrap'} ${className ?? ''}`}
            >
                {chip ? (
                    /* Same slot and same shape as VALID beside it, so the pair reads as one
                       statement: this many kept, this many left out. */
                    <span className="flex items-center gap-1.5 whitespace-nowrap">
                        <span className="text-slate-600">{total === undefined ? 'DROP' : 'TOTAL'}</span>
                        <span className="text-slate-500 font-bold">
                            {(total ?? dropped).toLocaleString()}
                        </span>
                    </span>
                ) : rows.map(([reason, n]) => (
                    <span key={reason} className="text-slate-600 whitespace-nowrap">
                        {DROP_LABEL[reason]} <span className="text-slate-500">{n.toLocaleString()}</span>
                    </span>
                ))}
            </button>

            {open && mounted && createPortal(
                <>
                    {/* Tinted, and closed on pointerdown — the rule the session sheet was fixed to.
                        An invisible scrim over a phone is indistinguishable from the screen having
                        stopped working. No backdrop-blur: measured elsewhere here at ~1 s of paint. */}
                    <div className="fixed inset-0 z-[95] bg-slate-950/70" onPointerDown={() => setOpen(false)} />
                    {/* Viewport-pinned rather than hung off the line. On a phone this line sits in a
                        48px header, and a popover anchored to it would open past the screen edge off
                        a control far narrower than itself. Same geometry as the other sheets. */}
                    <div className="fixed z-[96] inset-x-3 bottom-[60px] max-h-[min(calc(100svh-72px),420px)] overflow-y-auto bg-slate-900 border border-slate-700 rounded shadow-xl">
                        <div className="sticky top-0 bg-slate-900 px-3 pt-2.5 pb-1.5 border-b border-slate-800">
                            <div className="text-[10px] font-bold uppercase tracking-widest text-slate-300">
                                {SHEET[lang].title}
                            </div>
                            <div className="text-[9px] text-slate-600 mt-0.5">{SHEET[lang].hint}</div>
                        </div>
                        <div className="px-3 py-2 space-y-2.5">
                            {rows.map(([reason, n]) => (
                                <div key={reason}>
                                    <div className="flex items-baseline gap-2">
                                        <span className="text-[10px] font-mono font-bold text-slate-300">{DROP_LABEL[reason]}</span>
                                        <span className="text-[10px] font-mono text-blue-400">{n.toLocaleString()}</span>
                                    </div>
                                    <p className="text-[10px] leading-snug text-slate-500 mt-0.5">{DROP_WHY[lang][reason]}</p>
                                </div>
                            ))}
                        </div>
                    </div>
                </>,
                document.body,
            )}
        </>
    );
};
