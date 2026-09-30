import React from 'react';

/**
 * The three shared atoms of the idle surface.
 *
 * `emph` exists because every string on this surface was written with `**...**` around the sentence
 * that carries it and nothing ever rendered them — they reached the screen as literal asterisks, in
 * both languages, on the one line of each message meant to stand out.
 *
 * `Stat` and `SectionLabel` are here rather than at the call sites so a figure is shaped the same
 * way in the panel, on the gauge rack and in the trace's readout bar.
 */

/** `**bold**` -> slate-200. Odd segments of a split on the marker are the emphasised ones. */
export function emph(text: string): React.ReactNode[] {
    return text.split('**').map((part, i) =>
        i % 2 === 1
            ? <strong key={i} className="font-semibold text-slate-200">{part}</strong>
            : <React.Fragment key={i}>{part}</React.Fragment>);
}

/**
 * The label-over-value readout, at the panel's scale.
 *
 * The same atom the trace's readout bar uses, so a figure means the same thing and is shaped the
 * same way whichever pane it is read in. `tone` carries the role; the label never does.
 */
export const Stat: React.FC<{ label: string; value: React.ReactNode; tone?: string }> = ({
    label, value, tone = 'text-slate-200',
}) => (
    <div className="flex min-w-0 flex-col leading-none">
        <span className="truncate text-[8px] uppercase tracking-wider text-slate-600">{label}</span>
        <span className={`truncate font-mono text-[11px] font-bold ${tone}`}>{value}</span>
    </div>
);

/** A section heading inside the panel. One device per edge: a rule under it, and nothing else. */
export const SectionLabel: React.FC<{ children: React.ReactNode; trailing?: React.ReactNode }> = ({
    children, trailing,
}) => (
    <div className="flex items-baseline gap-2 border-b border-slate-800 pb-1">
        <span className="text-[10px] font-bold uppercase tracking-widest text-slate-500">{children}</span>
        {trailing && <span className="ml-auto font-mono text-[9px] text-slate-600">{trailing}</span>}
    </div>
);
