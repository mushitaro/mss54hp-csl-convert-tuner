'use client';

import React from 'react';
import { useLiveReadout } from '@/hooks/useLiveRun';
import type { useLiveRun } from '@/hooks/useLiveRun';
import { interpolateFactor } from '@/lib/log-engine/filter';
import type { InterpolationPoint } from '@/lib/types';

/**
 * What the driver cannot get anywhere else, over the map they are aiming at — three readouts.
 *
 *   AQ %   the map's row axis, `aq_rel_rf = rawLoad / interpolateFactor(rpm)`. A computed quantity
 *          with no gauge in the car, and the one the cell is chosen by.
 *   WDK %  throttle plate 1 (`wdk1`), the pedal the driver is holding — the row is steered with it.
 *   PULL   how long that pedal has been held still: ±2 points from where the hold began, at 15 % or
 *          more. Live while it runs; the last hold of 2 s or more stays up, dimmed, until a new one
 *          reaches 2 s. The rule and its numbers are in pullClock.ts; it is stepped per sample in
 *          useLiveRun so a skipped render cannot hide the sample that ended a hold.
 *
 * rpm is on the tachometer and which cells are short is on the map's colour, so neither is here
 * (rpm was, and was noise — operator, 2026-08-28). The cell targets (TO COVERED / TO SETTLED), the
 * HELD IN CELL / ABOVE FLOOR clocks, the VE / RF KORR selector and the RF KORR view's audio cues
 * were removed on 2026-10-18 (operator: only how many seconds the pull was held is needed).
 */
export function LiveDriveStrip({ feed, interpolationTable }: {
    feed: ReturnType<typeof useLiveRun>['readout'];
    /** The session's Alpha-N table — the same one `processLogData` corrects the load with. */
    interpolationTable?: InterpolationPoint[];
}) {
    const { sample, pull } = useLiveReadout(feed);

    // The map's own Y axis. `interpolateFactor` is the filter's function, not a copy of it.
    const factor = sample && interpolationTable
        ? interpolateFactor(sample.rpm, interpolationTable) : 1;
    const aq = sample ? sample.rawLoad / (factor === 0 ? 1 : factor) : null;
    const wdk = sample?.wdk1 ?? null;

    // A ROW, not an overlay, and that is the whole of what this element's box has to get right.
    //
    // It used to be `absolute top-2 left-2 right-2`, which contributes no height — so the grid
    // below it started at the top of the same box and the strip landed on the one part of the map
    // that is pinned there: `MapEditor`'s sticky `thead`, the RPM axis. Every column heading was
    // covered for the whole of a run, which is exactly when you need to read which rpm column the
    // car is in. The comment at the call site already described the layout this class now produces
    // — the strip at the top and the grid taking the rest — and the flex column it sits in was
    // already built for it.
    //
    // Three cells of equal width (`flex-1`, `truncate`), so the row never wraps and a value going
    // from '—' to '12.3 s' moves nothing beside it.
    return (
        <div className="relative z-20 m-2 mb-0 px-3 py-2 rounded
                        bg-slate-950/90 border border-slate-800 min-[900px]:backdrop-blur-sm
                        flex items-stretch gap-3 font-mono tabular-nums">
            <Cell label="AQ %" value={aq === null ? '—' : aq.toFixed(1)} tone="text-blue-400" />
            <Cell label="WDK %" value={wdk === null ? '—' : wdk.toFixed(1)} tone="text-blue-400" />
            <Cell
                label="PULL"
                value={pull === null ? '—' : `${pull.sec.toFixed(1)} s`}
                tone={pull === null ? 'text-slate-600' : pull.live ? 'text-slate-100' : 'text-slate-500'}
            />
        </div>
    );
}

/** Module scope: a component defined inside a component is a new type on every render. */
const Cell: React.FC<{ label: string; value: string; tone: string }> = ({ label, value, tone }) => (
    <div className="flex flex-col leading-none min-w-0 flex-1">
        <span className="text-[8px] text-slate-600 uppercase tracking-wider truncate">{label}</span>
        <span className={`text-[15px] font-bold truncate ${tone}`}>{value}</span>
    </div>
);
