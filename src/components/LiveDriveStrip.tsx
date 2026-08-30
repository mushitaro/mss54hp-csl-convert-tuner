'use client';

import React from 'react';
import { useLiveReadout } from '@/hooks/useLiveRun';
import { useDriveCues } from '@/hooks/useDriveCues';
import type { useLiveRun } from '@/hooks/useLiveRun';
import { interpolateFactor } from '@/lib/log-engine/filter';
import type { InterpolationPoint } from '@/lib/types';
import type { DriveView } from '@/lib/features';

/**
 * What the driver cannot get anywhere else, over the map they are aiming at.
 *
 * The car has a tachometer and the map has colour: rpm and which cells are short are both already
 * in front of the driver. What is NOT is the row axis — `aq_rel_rf` is a computed quantity with no
 * gauge — and how long the current state has been held. So the strip shows those and stops. An
 * earlier version put rpm here as well and it was noise (operator, 2026-08-28).
 *
 * ## Two viewpoints, and never both at once
 *
 * VE and RF KORR are filled by different driving and counted on different grids, so showing both
 * targets would be two instructions at once at two thirds throttle:
 *
 *   VE      wants SAMPLES IN THIS CELL of (rpm x aq_rel_rf). Its clock is dwell in the cell and it
 *           restarts when you leave, because holding `aq_rel_rf` still is the whole skill.
 *   RF KORR wants SUSTAINED FILLING. Its table is indexed on (rpm x Delta) and not on opening at
 *           all, and its bar is time above the filling floor — the settle clock.
 *
 * Mixing them is how a drive ends up satisfying neither. The selector is one tap and only one view
 * is ever on screen.
 *
 * ## Which views exist is not this component's decision
 *
 * `views` comes from `enabledDriveViews()`, and RF KORR is in it only where that feature renders.
 * The selector disappears entirely when there is one view, because a control that offers a target
 * this build cannot show or write is worse than no control: `useDriveCues` runs the audio and
 * haptic cues in the RF KORR view alone, so pressing it on a production build started cueing a
 * feature that is not there, at speed.
 *
 * The strip does not read the build variant itself. The page owns the selected view — it has to
 * survive the pane switch that unmounts the map on a phone — so the page owns the clamp too, and
 * splitting the two is how they come to disagree.
 */

/** What each view calls itself. Keyed by `DriveView`, so a new target must be named here to
 *  compile — the label is instrument vocabulary and stays with the instrument, not the registry. */
const VIEW_LABEL: Record<DriveView, string> = {
    ve: 'VE',
    rfkorr: 'RF KORR',
};

/** Nearest axis index, so the strip names the cell the binner would put this sample in. */
const nearest = (axis: readonly number[], v: number): number => {
    let best = 0;
    for (let i = 1; i < axis.length; i++) {
        if (Math.abs(axis[i] - v) < Math.abs(axis[best] - v)) best = i;
    }
    return best;
};

export function LiveDriveStrip({
    feed, interpolationTable, settleSec, view, views, onViewChange,
    hitMap, rpmAxis, loadAxis, coverageOk, cues = true,
}: {
    feed: ReturnType<typeof useLiveRun>['readout'];
    /** The session's Alpha-N table — the same one `processLogData` corrects the load with. */
    interpolationTable?: InterpolationPoint[];
    /** The session's own settle requirement, seconds. Drives the RF KORR view. */
    settleSec?: number;
    view: DriveView;
    /** What this variant may offer — `enabledDriveViews()`. One entry means no selector. */
    views: readonly DriveView[];
    onViewChange: (v: DriveView) => void;
    /** Live per-cell sample counts, rebuilt on every flush. Drives the VE view's target. */
    hitMap?: number[][] | null;
    rpmAxis?: readonly number[];
    loadAxis?: readonly number[];
    /** "This area needs no more driving" — the VE target, from RAW FILTER. */
    coverageOk?: number;
    cues?: boolean;
}) {
    const { sample, heldSec, hz } = useLiveReadout(feed);

    // The map's own Y axis. `interpolateFactor` is the filter's function, not a copy of it.
    const factor = sample && interpolationTable
        ? interpolateFactor(sample.rpm, interpolationTable) : 1;
    const aq = sample ? sample.rawLoad / (factor === 0 ? 1 : factor) : null;

    /**
     * DWELL IN THE CELL — the VE clock, which is not the settle clock.
     *
     * Held in a ref rather than derived: "how long have you been here" is a fact about the samples
     * that went past, and this component only ever sees the latest one. It restarts the moment the
     * binned cell changes, because leaving the row is leaving the cell.
     */
    const here = sample && aq !== null && rpmAxis?.length && loadAxis?.length
        ? { r: nearest(loadAxis, aq), c: nearest(rpmAxis, sample.rpm), t: sample.time }
        : null;
    const cellKey = here ? here.r + ':' + here.c : null;
    const cellSamples = here ? (hitMap?.[here.r]?.[here.c] ?? 0) : null;

    // The entry TIME of the current cell, as state rather than a ref written during render — the
    // dwell has to survive re-renders that carry no new sample, and mutating a ref on the way past
    // is the thing `react-hooks/refs` is right to refuse.
    const [entry, setEntry] = React.useState<{ key: string; at: number } | null>(null);
    const hereTime = here?.t ?? null;
    React.useEffect(() => {
        // `hereTime` rather than `here`: the object is rebuilt every sample, and depending on it
        // would run this on every render to compare a value that has not changed. Only the key and
        // the timestamp matter, and the timestamp is only read when the key is new.
        if (cellKey === null || hereTime === null) { setEntry(null); return; }
        setEntry(e => (e && e.key === cellKey ? e : { key: cellKey, at: hereTime }));
    }, [cellKey, hereTime]);
    const rawDwell = here && entry && entry.key === cellKey ? here.t - entry.at : null;
    // Milliseconds or seconds, by the same discrimination the filter makes.
    const dwellSec = rawDwell === null ? null : (rawDwell > 1000 ? rawDwell / 1000 : rawDwell);

    const need = settleSec ?? 0;
    const holding = heldSec !== null;
    const counting = holding && (need <= 0 || heldSec >= need);
    // The tones belong to the RF KORR clock, which is the one with a hard threshold to cross.
    useDriveCues({ holding, counting, heldSec, enabled: cues && view === 'rfkorr' });

    /** Seconds of driving still owed, for whichever view is up. Null when it cannot be computed. */
    let target: number | null = null;
    if (view === 've' && cellSamples !== null && coverageOk && hz) {
        target = Math.max(0, (coverageOk - cellSamples) / hz);
    } else if (view === 'rfkorr' && holding) {
        target = Math.max(0, need - (heldSec ?? 0));
    }

    const clock = view === 've' ? dwellSec : heldSec;
    const done = view === 've' ? (target !== null && target <= 0) : counting;

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
    // Nothing here is click-through any more, for the same reason: it no longer covers anything to
    // click through TO. The button below keeps its own handler and needs no `pointer-events-auto`.
    return (
        <div className="relative z-20 m-2 mb-0 px-3 py-2 rounded
                        bg-slate-950/90 border border-slate-800 backdrop-blur-sm
                        flex items-stretch gap-3 font-mono tabular-nums">
            <Cell label="AQ %" value={aq === null ? '—' : aq.toFixed(1)} tone="text-blue-400" />
            <Cell
                label={view === 've' ? 'HELD IN CELL' : 'ABOVE FLOOR'}
                value={clock === null ? '—' : `${clock.toFixed(1)} s`}
                tone={done ? 'text-emerald-400' : clock === null ? 'text-slate-600' : 'text-slate-100'}
            />
            <Cell
                label={view === 've'
                    ? (cellSamples === null ? 'TO COVERED' : `TO COVERED · ${cellSamples}`)
                    : 'TO SETTLED'}
                value={target === null ? '—' : target <= 0 ? 'done'
                    : `+${target.toFixed(target < 10 ? 1 : 0)} s`}
                tone={target !== null && target <= 0 ? 'text-emerald-400' : 'text-violet-300'}
            />
            {/* The one interactive thing here — and only where there is a choice to make.
                A single-view build shows the name as a label instead of a button, because the
                strip still has to say WHICH target it is counting: with the selector gone, the
                three readouts above would otherwise be three unlabelled numbers. */}
            {views.length > 1 ? (
                <button
                    type="button"
                    onClick={() => onViewChange(views[(views.indexOf(view) + 1) % views.length])}
                    className="shrink-0 self-center px-2 py-1 rounded text-[9px]
                               font-bold tracking-wider bg-slate-800 text-slate-300 hover:text-white"
                >
                    {VIEW_LABEL[view]}
                </button>
            ) : (
                <span className="shrink-0 self-center px-2 py-1 text-[9px]
                                 font-bold tracking-wider text-slate-500">
                    {VIEW_LABEL[view]}
                </span>
            )}
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
