import React, { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { IdleSample } from '@/lib/dme-link/types';
import type { IdleTables } from '@/lib/idle/idleTables';
import type { IdleTuneResult } from '@/lib/idle/types';
import { idleCensus, tuneIdleFeedforward } from '@/lib/idle/tuner';
import { IdlePanel, IdleTrace } from './IdlePanel';

/** Same cadence the inertia run publishes at — live enough to steer by, cheap enough not to matter. */
const PUBLISH_INTERVAL_MS = 250;

/**
 * Owns the idle dwell run.
 *
 * A container rather than page state, and now for a second reason on top of the original one: this
 * publishes four times a second, and page.tsx is the whole application. Holding the samples here
 * keeps that re-render inside this subtree. It is also why the trace goes out through a PORTAL
 * rather than by handing the samples upward — the picture belongs in the visualization pane at the
 * top of the screen, but the state behind it does not belong in the component that owns that pane.
 *
 * The census runs LIVE and the tune runs at STOP, and the split matters more here than anywhere
 * else in the app. The driver is sitting still in a car park holding a procedure for three minutes;
 * finding out afterwards that the A/C cycled through all of it, or that the coolant never reached
 * 80 °C, costs the whole session. So the panel is fed a census on the same 250 ms tick as the
 * sample count, computed by the same function that produces the final verdict — never a second
 * implementation of the same rule, which is the mistake `inertia/liveCoverage.ts` records.
 *
 * Mounted for the whole session rather than with its tab, which is not a detail: the samples live in
 * a ref here, so unmounting on a tab change threw away a run in progress. It also means the hub can
 * start one — see `IdleControls`.
 */

/** What the hub drives. The run has to be startable from the state-machine button, because that
 *  button is where "what do I do next" is answered, and a run IS the next thing. */
export interface IdleControls {
    start: () => void;
    stop: () => void;
}

interface Props {
    startRun: (
        onSample: (s: IdleSample) => void,
        onEnd?: (failure: string | null) => void,
    ) => void;
    stopRun: () => void;
    /** Decoded from the image in the car. Read by the page too — it decides whether the hub may
     *  offer a run at all — so it is decoded once up there and passed down rather than twice. */
    tables: IdleTables | null;
    /** Hands the finished run to the session store, as the inertia run does. */
    onSaveRun?: (samples: IdleSample[]) => void;
    /** Arms the proposal for the next download or WRITE. The page owns the artifact; this owns the
     *  measurement, so the values are handed up rather than written here. */
    onArm?: (values: number[][] | null) => void;
    armed?: boolean;
    /** Where the trace is drawn: the visualization pane's own element, or null before it mounts. */
    graphSlot?: HTMLElement | null;
    /** Whether there is a trace worth switching to — the narrow layout's GRAPH destination is
     *  disabled without one, and a destination that lands on an empty box is worse than a disabled
     *  one. A boolean rather than the samples, so this crosses the boundary twice per run instead of
     *  four times a second. */
    onTrace?: (has: boolean) => void;
    controlsRef?: React.Ref<IdleControls>;
}

export const IdleWorkflow: React.FC<Props> = ({
    startRun, stopRun, tables, onSaveRun, onArm, armed, graphSlot, onTrace, controlsRef,
}) => {
    const samplesRef = useRef<IdleSample[]>([]);
    const lastPublishRef = useRef(0);
    const [samples, setSamples] = useState<IdleSample[]>([]);
    const [running, setRunning] = useState(false);
    const [result, setResult] = useState<IdleTuneResult | null>(null);

    /**
     * Live, and deliberately the same call the final answer makes.
     *
     * While the run is going this is the only thing standing between the driver and three wasted
     * minutes, so it reports the rejection census rather than a progress bar: "0 dwells, 812
     * throttle-open" is actionable and "collecting…" is not.
     */
    const liveResult: IdleTuneResult | null = useMemo(() => {
        if (!tables) return null;
        if (!running) return result;
        // A census carries no proposal — mid-run there is nothing to propose, and showing a moving
        // one would invite acting on a number that is still changing.
        const report = idleCensus(samples, tables);
        return { ...(result ?? EMPTY_RESULT(tables)), report } as IdleTuneResult;
    }, [running, samples, tables, result]);

    const onStart = useCallback(() => {
        samplesRef.current = [];
        lastPublishRef.current = 0;
        setSamples([]);
        setResult(null);
        setRunning(true);
        onArm?.(null);
        startRun(
            sample => {
                samplesRef.current.push(sample);
                const now = performance.now();
                if (now - lastPublishRef.current >= PUBLISH_INTERVAL_MS) {
                    lastPublishRef.current = now;
                    setSamples([...samplesRef.current]);
                }
            },
            () => {
                setRunning(false);
                const collected = samplesRef.current;
                setSamples([...collected]);
                // Derived even from a run that ended in a failure: a partial run is still evidence,
                // and this feature's own gates decide whether it is enough. Discarding it on the
                // caller's behalf would throw away the dwells that did complete.
                setResult(tuneIdleFeedforward(collected, tables));
                if (collected.length) onSaveRun?.(collected);
            },
        );
    }, [startRun, onSaveRun, onArm, tables]);

    const onStop = useCallback(() => {
        stopRun();
        setRunning(false);
    }, [stopRun]);

    useImperativeHandle(controlsRef, () => ({ start: onStart, stop: onStop }), [onStart, onStop]);

    // Two points make a line; one does not. The same test the trace itself applies, so the
    // destination is enabled exactly when there is something at the end of it.
    const hasTrace = useMemo(
        () => samples.reduce((n, s) => n + (s.mdLlri !== null ? 1 : 0), 0) >= 2,
        [samples]);
    useEffect(() => { onTrace?.(hasTrace); }, [hasTrace, onTrace]);

    return (
        <>
            {graphSlot && createPortal(
                <IdleTrace samples={samples} result={liveResult} target={tables?.idleTargetNm ?? 0} />,
                graphSlot,
            )}
            <IdlePanel
                samples={samples}
                tables={tables}
                result={liveResult}
                running={running}
                onArm={onArm}
                armed={!!armed}
            />
        </>
    );
};

/** A result shell carrying the stock map and nothing else, so the live census has somewhere to sit
 *  without pretending a proposal exists. */
function EMPTY_RESULT(tables: IdleTables): IdleTuneResult {
    return {
        stock: tables.qvs.values,
        tuned: tables.qvs.values,
        rpmAxis: tables.qvs.x,
        tmotAxis: tables.qvs.y,
        cells: [],
        dwells: [],
        report: idleCensus([], tables),
        targetNm: tables.idleTargetNm,
        converged: false,
        acceptable: false,
    };
}
