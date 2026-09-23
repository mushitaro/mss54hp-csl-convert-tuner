import React, { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { IdleSample } from '@/lib/dme-link/types';
import type { IdleTables } from '@/lib/idle/idleTables';
import type { IdleTuneResult } from '@/lib/idle/types';
import { idleCensus, tuneIdleFeedforward, withPool } from '@/lib/idle/tuner';
import { IdlePanel } from './IdlePanel';
import { IdleTrace } from './IdleTrace';
import { IdleGauges } from './IdleGauges';
import { IdleLogTable } from './IdleLogTable';

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
    /**
     * WHAT THIS RUN PROPOSES, published whenever it changes — not armed.
     *
     * The panel used to carry an ARM button beside the proposal. The hub's WRITE menu is the one
     * place this app answers "what will the flash change", so arming moved there, and the page needs
     * the VALUES to arm with. Null whenever the run has not earned a write, so the row can never be
     * switched on over something the patcher would refuse.
     */
    onProposal?: (values: number[][] | null) => void;
    /**
     * Earlier idle runs recorded on the SAME BASE, already laid out on their own stretch of the
     * timeline. Extra evidence for the write and for the census, never for the trace: the picture
     * is this run's.
     */
    pooled?: IdleSample[];
    /** How many of them, so the panel can say the write stands on more than this sitting. */
    pooledRuns?: number;
    /**
     * Where the TRACE is drawn — the visualization pane, on the IDLE LOG tab only.
     *
     * The trace answers "what happened", which is the log's question, so it lives with the log. The
     * IDLE tab's own pane gets `gaugeSlot` instead: standing in a car park the question is not the
     * shape of the last three minutes, it is where each reading sits against its threshold, and
     * that is a position on a bar rather than a curve.
     */
    graphSlot?: HTMLElement | null;
    /** Where the gauge rack is drawn: the visualization pane on the IDLE tab. */
    gaugeSlot?: HTMLElement | null;
    /** Whether there is a trace worth switching to — the narrow layout's GRAPH destination is
     *  disabled without one, and a destination that lands on an empty box is worse than a disabled
     *  one. A boolean rather than the samples, so this crosses the boundary twice per run instead of
     *  four times a second. */
    onTrace?: (has: boolean) => void;
    /**
     * Where the per-sample rows are drawn: the CORRECTED LOG pane's own element, or null.
     *
     * A second portal for the reason the first one exists. The rows belong in the tab that shows a
     * log, and the samples behind them do not belong in the component that owns that tab — this
     * publishes four times a second, and page.tsx is the whole application.
     */
    tableSlot?: HTMLElement | null;
    /**
     * Whether there are rows worth switching to, so the CORRECTED LOG tab is enabled exactly when
     * it has something in it. A boolean rather than the samples, for the reason `onTrace` is one:
     * it crosses the boundary twice per run instead of four times a second.
     */
    onRows?: (has: boolean) => void;
    /**
     * A stored run, handed back when a session is opened.
     *
     * Applied only when nothing is running, and identity-keyed rather than value-keyed: the page
     * passes the array it loaded from the session store, so a new array means a different session
     * and the same array means nothing happened. Without this, reopening a session that recorded
     * three minutes of idle showed an empty tab — the samples were in the database the whole time.
     */
    restored?: IdleSample[] | null;
    /**
     * What that stored run proposes, derived by the page.
     *
     * Handed down rather than computed here, so `tuneIdleFeedforward` has ONE caller per run: the
     * page needs the same result to put a recorded arming back, and two call sites of one pure
     * function is the shape that drifts as soon as either grows a condition.
     */
    restoredResult?: IdleTuneResult | null;
    /**
     * The campaign's learned torque-to-duty gain, %/Nm, or undefined to use the prior.
     *
     * Handed in rather than learned here: it comes from the session's ancestry, which is the page's
     * to walk. Used at STOP, where the proposal is derived — and it must be the same value the page
     * used for the stored-run derivation, or a reopened session rebuilds different bytes.
     */
    gain?: { gain: number; learned: boolean };
    /** The link's verdict on MD_LLRI's address — passed straight through to IdlePanel. */
    sourceProven?: boolean | null;
    controlsRef?: React.Ref<IdleControls>;
}

export const IdleWorkflow: React.FC<Props> = ({
    startRun, stopRun, tables, onSaveRun, onArm, onProposal, pooled, pooledRuns, graphSlot,
    gaugeSlot, onTrace, tableSlot, onRows, restored, restoredResult, gain, sourceProven, controlsRef,
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
        // A reopened run shows what IT proposed, not an empty panel. `result` is this sitting's,
        // and stays null until a run STOPS here; `restoredResult` is the stored run's, derived by
        // the page from the samples the session kept.
        if (!running) return result ?? restoredResult ?? null;
        // A census carries no proposal — mid-run there is nothing to propose, and showing a moving
        // one would invite acting on a number that is still changing.
        // The campaign's gain goes to the LIVE census too, not only to the tune at STOP. The two
        // are the same function's report; a driver watching one number change into a different one
        // when they press STOP would be right to distrust both.
        // The census hands back the WINDOWS with the counts, and the shell adopts them. Without
        // that the live trace had `dwells: []` for the whole run and drew no bands until STOP —
        // three minutes of watching a screen that showed the judgement of nothing.
        // The census counts the POOL as well, because the write does. A driver watching
        // "1 dwell" while the proposal stands on three would be reading a different run's number.
        const { dwells, ...report } = idleCensus(withPool(pooled ?? [], samples), tables, undefined, gain);
        return { ...(result ?? EMPTY_RESULT(tables)), report, dwells } as IdleTuneResult;
    }, [running, samples, tables, result, restoredResult, gain, pooled]);

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
                setResult(tuneIdleFeedforward(
                    withPool(pooled ?? [], collected), tables, undefined, gain));
                if (collected.length) onSaveRun?.(collected);
            },
        );
    }, [startRun, onSaveRun, onArm, tables, gain, pooled]);

    const onStop = useCallback(() => {
        stopRun();
        setRunning(false);
    }, [stopRun]);

    useImperativeHandle(controlsRef, () => ({ start: onStart, stop: onStop }), [onStart, onStop]);

    /**
     * What is on screen: this sitting's run, or the one loaded from the session store.
     *
     * A derivation and not a copy, which is the point. Adopting `restored` INTO `samples` would
     * need an effect (or a ref written during render) and would put a stored run into the buffer
     * `onSaveRun` hands back at STOP — so a restore followed by a save would rewrite a real run
     * with a copy of itself. Deriving instead leaves `samples` and `samplesRef` meaning exactly
     * what they meant before: the samples this sitting collected.
     *
     * The live side wins whenever there is one, so opening a session mid-run cannot replace what is
     * arriving from the car.
     *
     * No result is derived from `restored`. The estimate is computed from the samples at STOP, and
     * re-deriving it on open would put a fresh proposal on screen for a run whose proposal may
     * already have been armed and written. A reopened session shows the EVIDENCE; deriving from it
     * again is a decision, and it belongs to the button that makes it.
     */
    // Memoised because the empty-restore case allocates: `restored ?? []` is a fresh array on
    // every render, and hasTrace below is a memo over it.
    const shown = useMemo(
        () => (running || samples.length > 0 ? samples : (restored ?? [])),
        [running, samples, restored]);

    // Two points make a line; one does not. The same test the trace itself applies, so the
    // destination is enabled exactly when there is something at the end of it.
    const hasTrace = useMemo(
        () => shown.reduce((n, s) => n + (s.mdLlri !== null ? 1 : 0), 0) >= 2,
        [shown]);
    useEffect(() => { onTrace?.(hasTrace); }, [hasTrace, onTrace]);

    /**
     * The proposal, handed up the moment it exists.
     *
     * `acceptable` is the tuner's own gate, so this is exactly the array `tuneIdleFeedforward` says
     * is worth writing — the WRITE row cannot be armed with anything else, and a run that stops
     * short of the gate leaves the row locked rather than offering bytes nothing earned.
     */
    const proposal = liveResult?.acceptable ? liveResult.tuned : null;
    useEffect(() => { onProposal?.(proposal); }, [proposal, onProposal]);

    // The table's own test, and a weaker one on purpose: one row IS a table, where one point is not
    // a line. A run that produced two samples and stopped is still worth reading, and the census
    // beside it is what says whether it counted for anything.
    const hasRows = shown.length > 0;
    useEffect(() => { onRows?.(hasRows); }, [hasRows, onRows]);

    return (
        <>
            {graphSlot && createPortal(
                <IdleTrace samples={shown} result={liveResult} target={tables?.idleTargetNm ?? 0}
                    running={running} tables={tables} />,
                graphSlot,
            )}
            {gaugeSlot && createPortal(
                <IdleGauges samples={shown} tables={tables} result={liveResult} running={running}
                    sourceProven={sourceProven} />,
                gaugeSlot,
            )}
            {tableSlot && createPortal(<IdleLogTable samples={shown} />, tableSlot)}
            {/* No `onArm` / `armed`: the panel has no ARM button. The hub's WRITE row carries that
                decision, and `onArm` is still used HERE — `onStart` calls it with null, so a new run
                cannot leave the previous run's bytes armed. */}
            <IdlePanel
                sourceProven={sourceProven}
                samples={shown}
                tables={tables}
                result={liveResult}
                running={running}
                pooledRuns={pooledRuns ?? 0}
            />
        </>
    );
};

/**
 * A result shell carrying the stock map and nothing else, so the live census has somewhere to sit
 * without pretending a proposal exists.
 *
 * `KF_LLS_TV`, not `KF_LLR_QVS_GRUND` — this was the retarget's last stale reference. It put a
 * 5x6 kg/h map and a coolant axis into the shell the live trace reads, so anything that reached for
 * `rpmAxis` or `tmotAxis` mid-run got the axes of the map that has no consumer. `tmotAxis` keeps
 * its name and carries the AIR breakpoints, exactly as `tuneIdleFeedforward` returns them.
 */
function EMPTY_RESULT(tables: IdleTables): IdleTuneResult {
    const { dwells, ...report } = idleCensus([], tables);
    return {
        stock: tables.llsTv.values,
        tuned: tables.llsTv.values,
        rpmAxis: tables.llsTv.x,
        tmotAxis: tables.llsTv.y,
        cells: [],
        dwells,
        report,
        targetNm: tables.idleTargetNm,
        converged: false,
        acceptable: false,
    };
}
