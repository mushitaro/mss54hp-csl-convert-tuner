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
const WHY: Record<DropReason, string> = {
    coldEngine: 'Below the minimum coolant temperature — drive the first minutes before starting the log.',
    idle: 'Closed throttle below the idle threshold. Not a fault; idle carries no VE information.',
    transient: 'RPM or throttle still moving, so the lambda loop had not settled. Hold steadier, longer pulls.',
    catProtect: 'Cat protection enrichment opened the lambda loop, plus the unwind after it.',
    tankVent: 'The purge valve was passing vapour. Write TANK VENT: SHUT and run again — this is the one that a patch removes entirely.',
    fullLoad: 'Past the DME\'s full-load threshold, where FR 5.01 switches the lambda controller off. The WOT TH patch keeps it alive.',
    controllerStop: 'The lambda factor was pinned at K_LA_FMAX/K_LA_FMIN, so it reports "at least this much" rather than a measurement.',
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
