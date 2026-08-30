'use client';

import React from 'react';

/**
 * SUBJECT vs REFERENCE — the one control for "what am I looking at, and what am
 * I looking at it against".
 *
 * Extracted from the DIFFERENCE tab so the CALIBRATION tab asks the question the
 * same way, in the same words, in the same place. Two spellings of one control
 * would be two things to learn for one idea.
 *
 * The width rules below are measured, not decorative. A `<select>` claims its
 * max-content width unless every box in the chain carries `min-w-0` and the
 * select itself `w-full`: without them the bar came to 625px inside a 343px
 * pane, the map scrolled sideways with it, and the selector you were reaching
 * for slid off the screen as you reached. `max-w-[220px]` is the other end —
 * without it `flex-1` gives each box half a desk pane to hold the word CURRENT.
 *
 * COMPARE stands down below 900px: it is a heading for a row whose own tab
 * already names it, and it was taking 63px from two controls with 145 each.
 */

export interface CompareOption {
    value: string;
    label: string;
    disabled?: boolean;
}

export function CompareBar({
    options,
    subject,
    onSubject,
    reference,
    onReference,
    trailing,
}: {
    options: CompareOption[];
    subject: string;
    onSubject: (value: string) => void;
    reference: string;
    onReference: (value: string) => void;
    /** Controls that belong to this bar's own question — the differences
     *  popover, the reference loader. Kept out of the shared shape. */
    trailing?: React.ReactNode;
}) {
    const select = (
        value: string,
        onChange: (v: string) => void,
        label: string,
        tone: string,
    ) => (
        <div className="flex items-center gap-1 bg-slate-800 rounded px-2 py-0.5 flex-1 min-w-0 max-w-[220px]">
            <span className="shrink-0 text-[9px] text-slate-500 uppercase">{label}</span>
            <select
                value={value}
                onChange={e => onChange(e.target.value)}
                className={`w-full min-w-0 truncate bg-transparent text-[10px] font-bold outline-none cursor-pointer ${tone}`}
            >
                {options.map(o => (
                    <option
                        key={o.value}
                        value={o.value}
                        disabled={o.disabled}
                        className="bg-slate-900 text-slate-300"
                    >
                        {o.label}
                    </option>
                ))}
            </select>
        </div>
    );

    return (
        <div className="flex items-center gap-2 min-w-0 px-3 py-2 bg-slate-900/50 border-b border-slate-800">
            <span className="shrink-0 hidden min-[900px]:inline text-xs font-bold text-slate-400">COMPARE</span>

            <div className="flex items-center gap-2 flex-1 min-w-0">
                {select(subject, onSubject, 'Subject', 'text-white')}
                <span className="shrink-0 text-xs text-slate-600 font-bold">vs</span>
                {/* Indigo: the reference role, the same hue the lineage badges use. */}
                {select(reference, onReference, 'Reference', 'text-indigo-400')}
            </div>

            {trailing}
        </div>
    );
}
