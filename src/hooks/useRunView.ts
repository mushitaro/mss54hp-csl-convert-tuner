import { useCallback, useMemo, useState } from 'react';
import { processLogData } from '@/lib/log-engine/filter';
import type { LambdaLimits } from '@/lib/log-engine/lambdaGates';
import type { InterpolationPoint, LogDataPoint, LogFilterConfig, ProcessedLog } from '@/lib/types';

/**
 * An earlier run of the open session, on the LOG table and the GRAPH chart — to read, never to work
 * on.
 *
 * The workspace holds ONE run: the one its maps, its analysis and SAVE are about. Showing another run
 * by loading it into the workspace would make those answer for a run nobody asked them about, so an
 * earlier run gets a view of its own instead: its samples filtered by the session's own settings, and
 * its own window and selection — the same one-window-two-views pairing `useLogFile` keeps, so a point
 * clicked on the chart is still the row the table jumps to.
 *
 * The view belongs to where it was opened from (`owner`: the session, the run the workspace holds,
 * and that nothing records). When any of them moves on, it is simply not the view any more — derived,
 * not reset by an effect, so there is no render in which a stale run is drawn over a new session.
 */
export interface RunViewOwner {
    sessionId: string | null;
    workspaceRun: number | null;
    recording: boolean;
}

interface Shown {
    run: number;
    samples: LogDataPoint[];
    owner: string;
    /** Filtered when it was opened, with the settings it was opened under — see `processed`. */
    processed: ProcessedLog;
    config: LogFilterConfig;
    table: InterpolationPoint[];
    limits: LambdaLimits | null;
}

const ownerKey = (o: RunViewOwner) => (o.recording ? null : `${o.sessionId}|${o.workspaceRun}`);

export function useRunView(
    windowSize: number,
    owner: RunViewOwner,
    config: LogFilterConfig,
    table: InterpolationPoint[],
    limits: LambdaLimits | null,
) {
    const [shown, setShown] = useState<Shown | null>(null);
    const [windowStart, setWindowStart] = useState(0);
    const [selectedIndex, setSelectedIndex] = useState<number | null>(null);

    const key = ownerKey(owner);
    const live = shown !== null && key !== null && shown.owner === key ? shown : null;

    /** The run filtered as the session filters now: a filter moved while it is on screen applies to
     *  it as it does to the run the workspace holds. */
    const processed = useMemo(() => {
        if (!live) return null;
        if (live.config === config && live.table === table && live.limits === limits) return live.processed;
        return processLogData(live.samples, `run-${live.run}`, config, table, limits);
    }, [live, config, table, limits]);

    const rows = useMemo(
        () => (processed ? processed.data.slice(windowStart, windowStart + windowSize) : []),
        [processed, windowStart, windowSize],
    );
    const maxWindowStart = Math.max(0, (processed?.data.length ?? 0) - windowSize);
    const panWindow = useCallback((delta: number) => {
        setWindowStart(prev => Math.max(0, Math.min(maxWindowStart, Math.round(prev + delta))));
    }, [maxWindowStart]);

    /**
     * Puts run `run` on the log views, centred on `atTime` (log seconds) when one is given. Filters
     * once here rather than after the state lands, because the moment to centre on is a row of the
     * filtered run and the window and selection have to be set with the run, not a render later.
     * Refused (false) while a log records: the chart is the live run's then.
     */
    const show = (run: number, samples: LogDataPoint[], atTime?: number): boolean => {
        if (key === null || !samples.length) return false;
        const p = processLogData(samples, `run-${run}`, config, table, limits);
        setShown({ run, samples, owner: key, processed: p, config, table, limits });
        let at: number | null = null;
        if (atTime !== undefined && p.data.length) {
            at = 0;
            for (let i = 1; i < p.data.length; i++) if (Math.abs(p.data[i].time - atTime) < Math.abs(p.data[at].time - atTime)) at = i;
        }
        setSelectedIndex(at);
        setWindowStart(at === null ? 0 : Math.max(0, Math.min(Math.max(0, p.data.length - windowSize), at - Math.floor(windowSize / 2))));
        return true;
    };

    const close = () => {
        setShown(null);
        setSelectedIndex(null);
        setWindowStart(0);
    };

    return {
        /** The earlier run on the log views, or null when they show the workspace's own. */
        run: live && processed ? live.run : null,
        samples: live?.samples ?? null,
        processed,
        rows,
        windowStart,
        setWindowStart,
        maxWindowStart,
        panWindow,
        selectedIndex,
        setSelectedIndex,
        show,
        close,
    };
}
