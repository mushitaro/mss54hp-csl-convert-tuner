import React from 'react';
import type { DropCensus as Census, DropReason } from '@/lib/log-engine/lambdaGates';

/**
 * Why the log is shorter than the drive was.
 *
 * The count on its own — "751 valid of 1600" — is the least actionable number in the app. Half the
 * drive is gone and nothing says whether the answer is to warm the engine first, hold a steadier
 * throttle, write the tank-vent patch, or stop pulling to redline. Every reason below is separately
 * fixable, and naming them is the difference between a filtered log and an instruction for the next
 * run.
 *
 * Rendered as TEXT, not as a tooltip. This is the number a driver reads standing next to the car on
 * a phone, where hover does not exist — the same reason the sync error was moved out of a `title`.
 * Only non-zero reasons appear, largest first, so the thing most worth fixing is leftmost.
 */

/** Short enough for a phone, and the same vocabulary the docs and the filter panel use. */
const LABEL: Record<DropReason, string> = {
    coldEngine: 'cold',
    idle: 'idle',
    transient: 'transient',
    catProtect: 'cat protect',
    tankVent: 'tetv',
    fullLoad: 'full load',
    controllerStop: 'la stop',
};

/** The one sentence that says what to DO about each. Hover on desktop; the label alone has to carry
 *  it on a phone, which is why the labels are the words used everywhere else. */
/**
 * Same rules as the filter panel's explanations: what was excluded, why that sample cannot be used,
 * and what to do about it next time. One vocabulary across both — a reader who has read the panel
 * should recognise every word here.
 */
const WHY: Record<DropReason, string> = {
    coldEngine: 'The DME does not close the lambda loop below 60 °C, so the lambda trim was not being updated. Let the coolant reach temperature before starting the log.',
    idle: 'At the lowest filling the DME adds 12-30 % more fuel from a table this tool does not write, and the lambda trim falls to cancel it. Not a fault, and not information about air flow.',
    transient: 'Engine speed or throttle was still changing, so the lambda trim had not finished moving to its new value. Hold a steady pedal for longer.',
    catProtect: 'The DME was enriching to protect the catalyst, which suspends lambda control — the trim held its last value. Includes the 20 s the enrichment takes to clear.',
    tankVent: 'The purge valve was letting tank vapour into the engine, so the lambda trim was cancelling fuel the DME did not inject. Write TANK VENT: SHUT and run again — this is the one a patch removes entirely.',
    fullLoad: 'Past the DME\'s full-load threshold, where lambda control is switched off. The WOT TH patch keeps it running.',
    controllerStop: 'The lambda trim was pinned at its own limit, so it reports "at least this much" rather than a measurement.',
};

export const DropCensusLine: React.FC<{ census: Census; className?: string }> = ({ census, className }) => {
    const rows = (Object.keys(LABEL) as DropReason[])
        .map(r => [r, census[r]] as const)
        .filter(([, n]) => n > 0)
        .sort((a, b) => b[1] - a[1]);

    // Nothing dropped is worth saying out loud — it is the best possible outcome and an empty row
    // would read as a missing feature.
    if (!rows.length) return null;

    return (
        <div className={`flex items-center gap-x-2 gap-y-0.5 flex-wrap text-[9px] font-mono leading-none ${className ?? ''}`}>
            {rows.map(([reason, n]) => (
                <span key={reason} className="text-slate-600 whitespace-nowrap" title={WHY[reason]}>
                    {LABEL[reason]} <span className="text-slate-500">{n.toLocaleString()}</span>
                </span>
            ))}
        </div>
    );
};
