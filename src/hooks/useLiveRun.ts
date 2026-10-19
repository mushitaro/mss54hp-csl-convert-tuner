'use client';

import { useCallback, useRef, useSyncExternalStore } from 'react';
import {
    stepPullClock, pullReading, EMPTY_PULL_CLOCK, type PullClock, type PullReading,
} from '@/lib/log-engine/pullClock';
import type { LogDataPoint } from '@/lib/types';
import type { LogExchange } from '@/lib/log-engine/logProfile';
import { sampleRateHzFromTimes } from '@/lib/log-engine/rate';
import { appendLiveChunk, beginLiveRun, endLiveRun } from '@/lib/db/liveRunRepository';

/** Live Hz readout tuning. 24 samples is ~3 s of history on the cable and ~0.5 s under PRACTICE —
 *  long enough to ride out one retried exchange either way. Publishing at 4 Hz keeps the digits
 *  readable; the value itself is recomputed no faster than that. */
const HZ_WINDOW_SAMPLES = 24;
const HZ_PUBLISH_INTERVAL_S = 0.25;
/** How often a run's samples are appended to the crash-recovery store. Wall clock, not sample time:
 *  this bounds how much of a DRIVE is at risk, and that is measured in seconds of the user's life,
 *  not in samples. At the ~10 Hz this link achieves under PRACTICE, 5 s is ~50 points — the most a
 *  crash can cost. */
const PERSIST_INTERVAL_MS = 5000;
/** Milliseconds between UI flushes. */
const FLUSH_INTERVAL_MS = 500;

/** What the live readout shows. A snapshot rather than the mutable sample, so a subscriber can
 *  compare identities and React can bail out of a render that would change nothing. */
export interface LiveReadout {
    sample: LogDataPoint | null;
    /** Samples captured so far in this run. */
    count: number;
    /** Measured sample rate, or null before the first window closes. */
    hz: number | null;
    /**
     * How long the pedal has been held — the PULL readout — or null before the first hold.
     *
     * Stepped HERE rather than in the component that draws it, because the clock must not miss a
     * sample: the one where the pedal leaves the band ends the hold, and a subscriber that renders
     * on a coalesced snapshot can skip it entirely — which would leave the strip counting a hold
     * that is already over. Every sample passes through this hook; renders do not. See pullClock.ts.
     *
     * This slot held the high-load settle clock until 2026-10-18, when the strip stopped showing it
     * (operator: only how long the pull was held is needed). The filter still runs that clock on its
     * own — highLoadClock.ts.
     */
    pull: PullReading | null;
}

const EMPTY_READOUT: LiveReadout = { sample: null, count: 0, hz: null, pull: null };

/**
 * A datalog in progress: the samples, their durability, and the pace of everything downstream.
 *
 * ## Why the readout is a store rather than state
 *
 * The live cells used to be `useState` on the page component. That component renders the whole app —
 * the map, the visualiser, the panels, the session bar — and a sample arrives four or five times a
 * second, so every sample re-rendered all of it just to change seven small numbers. It is also the
 * one moment when the main thread is most needed elsewhere: the poll loop is between two DS2
 * exchanges, and everything spent here is a sample not taken.
 *
 * `useSyncExternalStore` moves the subscription to the component that actually displays the numbers.
 * Nothing else re-renders, the store is written from the poll callback with no React work at all,
 * and the readout is exactly as live as it was.
 *
 * ## Why almost everything else is a ref
 *
 * The poll loop's `onSample` is captured ONCE, when START TUNE is pressed. Anything it reads as a
 * variable is frozen at that instant — which is how the incremental filter's resume came to be
 * looked for in a `processedLog` that was null, making every flush of every run re-filter the whole
 * drive. The rule here is: state for what is rendered, refs for what the loop touches, and the work
 * itself reached through `workRef` so it is always the current render's version.
 */
export function useLiveRun(input: {
    /**
     * Rebuilds the view from the samples so far. Called on the flush schedule and again at STOP.
     *
     * Passed in on every render and stored in a ref, NOT captured: it closes over the map, the
     * filters and the calculator, all of which the operator can change mid-run.
     */
    flush: (force: boolean, authoritative?: boolean) => unknown;
}) {
    const flushRef = useRef(input.flush);
    flushRef.current = input.flush;

    /** Every sample of the run, in order. Memory only until SAVE — see the recovery store below. */
    const samplesRef = useRef<LogDataPoint[]>([]);
    /** The PULL clock, advanced once per sample — see LiveReadout.pull. */
    const pullRef = useRef<PullClock>(EMPTY_PULL_CLOCK);
    /** What this run's samples are made of, so the RATE row compares against what this run can
     *  reach rather than what the profile hopes for. Null outside a run. */
    const exchangesRef = useRef<LogExchange[] | null>(null);

    // --- The live readout store -------------------------------------------------------------------
    const readoutRef = useRef<LiveReadout>(EMPTY_READOUT);
    const listenersRef = useRef(new Set<() => void>());
    const subscribe = useCallback((fn: () => void) => {
        const set = listenersRef.current;
        set.add(fn);
        return () => { set.delete(fn); };
    }, []);
    const getReadout = useCallback(() => readoutRef.current, []);
    /** The prerender has no run and no samples, and must agree with the first client render. */
    const getServerReadout = useCallback(() => EMPTY_READOUT, []);
    const publishReadout = (next: LiveReadout) => {
        readoutRef.current = next;
        listenersRef.current.forEach(fn => fn());
    };

    // --- Sample rate ------------------------------------------------------------------------------
    // Clocked off `sample.time` rather than Date.now(), so both smoothings stay honest if the tab is
    // backgrounded and the poll loop keeps running.
    const hzWindowRef = useRef<number[]>([]);
    const hzValueRef = useRef<number | null>(null);
    const hzPublishedAtRef = useRef<number>(0);

    // --- Crash recovery ---------------------------------------------------------------------------
    // `samplesRef` is memory only, so until this existed any reload during a run took the whole drive
    // with it. Samples accumulate in the queue and are appended to IndexedDB as a new chunk every
    // PERSIST_INTERVAL_MS, so the write cost per flush does not grow with the run.
    const runIdRef = useRef<string | null>(null);
    const queueRef = useRef<LogDataPoint[]>([]);
    const seqRef = useRef<number>(0);
    const persistAtRef = useRef<number>(0);
    /** True while an append is in flight, so a slow write cannot have a second stacked on top of it —
     *  the queue simply keeps filling and the next tick takes everything at once. */
    const persistBusyRef = useRef(false);

    /**
     * Writes whatever has queued up since the last append to the crash-recovery store.
     *
     * Best effort in the strongest sense: this must never throw into the poll loop, never block a
     * sample, and never fail a run. A drive that is being recorded is worth more than the safety net,
     * so if the net cannot be written the run carries on without it. On failure the batch is put back
     * at the front of the queue and retried on the next tick, so a transient error costs nothing.
     */
    const persist = useCallback(async (force: boolean) => {
        const runId = runIdRef.current;
        if (!runId || persistBusyRef.current) return;
        const now = Date.now();
        if (!force && now - persistAtRef.current < PERSIST_INTERVAL_MS) return;
        if (queueRef.current.length === 0) return;

        const batch = queueRef.current;
        queueRef.current = [];
        persistAtRef.current = now;
        persistBusyRef.current = true;
        try {
            await appendLiveChunk(runId, seqRef.current++, batch);
        } catch {
            // Re-queue ahead of anything that arrived meanwhile, so capture order survives the retry.
            queueRef.current = [...batch, ...queueRef.current];
            seqRef.current--;
        } finally {
            persistBusyRef.current = false;
        }
    }, []);

    // --- Flush pacing -----------------------------------------------------------------------------
    const lastFlushRef = useRef<number>(0);
    /**
     * True while a deferred flush is queued or running.
     *
     * The work is O(n) in the log and the log only grows, so on a long run a second flush can be
     * scheduled before the first has finished. Dropping the extra one is right — the next sample
     * schedules another 500 ms later, and a flush already in flight is about to show the same answer.
     */
    const flushBusyRef = useRef(false);

    /**
     * Runs the UI flush WITHOUT blocking the DS2 poll loop.
     *
     * Called straight from `onSample` the flush sits between two DS2 exchanges, so the DME is idle
     * for the whole of it — measured on session #902, a sample took 411 ms against 244 ms of
     * unavoidable wire and turnaround, and the missing 167 ms was this.
     *
     * Deferring it to a macrotask does not make the work cheaper; it makes it happen at a better
     * time. The poll loop can issue the next request immediately, and the flush then runs during the
     * DME's own turnaround, which is dead CPU time either way.
     *
     * requestIdleCallback where it exists, because that is exactly "run when the main thread is
     * otherwise waiting". Safari and older Android have no such thing, hence the timeout fallback —
     * and a timeout on the idle callback too, since idle never arrives on a busy main thread and a
     * readout that stops updating during a hard pull is worse than one that costs a few ms there.
     */
    const scheduleFlush = useCallback(() => {
        if (flushBusyRef.current) return;
        if (Date.now() - lastFlushRef.current < FLUSH_INTERVAL_MS) return;
        flushBusyRef.current = true;
        const run = () => {
            try { runFlush(true); } finally { flushBusyRef.current = false; }
        };
        const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void })
            .requestIdleCallback;
        if (ric) ric(run, { timeout: 400 }); else setTimeout(run, 0);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    /** The flush itself, through the ref so it is the CURRENT render's — see flushRef. */
    const runFlush = useCallback((force: boolean, authoritative = false) => {
        const now = Date.now();
        if (!force && now - lastFlushRef.current < FLUSH_INTERVAL_MS) return null;
        lastFlushRef.current = now;
        return flushRef.current(force, authoritative);
    }, []);

    /**
     * Takes one sample: records it, prices the rate, and paces everything downstream.
     *
     * The whole of the poll loop's per-sample cost lives here, and all of it is either an array push
     * or a scheduling decision. Nothing in this function renders anything.
     */
    const addSample = useCallback((point: LogDataPoint) => {
        samplesRef.current.push(point);
        queueRef.current.push(point);

        // The first sample after a link gap. The rate window would price the gap as one very slow
        // exchange for the next 24 samples, and the pull clock would count the gap as pedal held —
        // neither is what the readout says it is, so both start again from here.
        if (point.linkGapS !== undefined) {
            hzWindowRef.current = [];
            pullRef.current = EMPTY_PULL_CLOCK;
        }

        // Trailing window of sample times. There is no poll interval to read — the loop awaits
        // pollLiveMeasurement back to back, so the rate IS the DS2 round trip and the only way to
        // know it is to measure it.
        const w = hzWindowRef.current;
        w.push(point.time);
        if (w.length > HZ_WINDOW_SAMPLES) w.splice(0, w.length - HZ_WINDOW_SAMPLES);
        if (point.time - hzPublishedAtRef.current >= HZ_PUBLISH_INTERVAL_S) {
            const hz = sampleRateHzFromTimes(w);
            // Leave the last good value standing on a degenerate window rather than blanking the cell
            // mid-run: the rate did not become unknown, we just could not measure it this tick.
            if (hz !== undefined) hzValueRef.current = hz;
            hzPublishedAtRef.current = point.time;
        }

        // Seconds as they come: both live links stamp `performance.now() / 1000` from run start.
        pullRef.current = stepPullClock(pullRef.current, { time: point.time, wdk: point.wdk1 });
        publishReadout({
            sample: point,
            count: samplesRef.current.length,
            hz: hzValueRef.current,
            pull: pullReading(pullRef.current),
        });
        scheduleFlush();
        void persist(false);   // own throttle, an order of magnitude slower than the UI flush
    }, [persist, scheduleFlush]);

    /**
     * Clears everything and opens a recovery record. Called by START TUNE, before the first sample.
     *
     * `beginLiveRun` is deliberately not awaited: the poll loop starts immediately afterwards and the
     * first samples must not wait on IndexedDB. They queue up regardless — `persist` no-ops until the
     * id lands, and the queue is what it reads from, so nothing is dropped.
     */
    const start = useCallback((run: { sessionId: string | null; mock: boolean; exchanges: LogExchange[] }) => {
        samplesRef.current = [];
        exchangesRef.current = run.exchanges;
        lastFlushRef.current = 0;
        flushBusyRef.current = false;
        runIdRef.current = null;
        queueRef.current = [];
        seqRef.current = 0;
        persistAtRef.current = Date.now();
        persistBusyRef.current = false;
        hzWindowRef.current = [];
        hzValueRef.current = null;
        hzPublishedAtRef.current = 0;
        pullRef.current = EMPTY_PULL_CLOCK;
        publishReadout(EMPTY_READOUT);
        if (run.sessionId) {
            void beginLiveRun({ sessionId: run.sessionId, mock: run.mock })
                .then(id => { runIdRef.current = id; })
                .catch(() => { /* no recovery record; the run itself is unaffected */ });
        }
    }, []);

    /**
     * Closes the run: the authoritative flush, then the durable tail.
     *
     * The recovery record is marked stopped but NOT discarded. The samples are still only in memory
     * until SAVE, so a stopped-and-unsaved run is exactly as fragile as a running one, and this is
     * the window in which the result is read and a decision made.
     */
    const finish = useCallback(async () => {
        // Authoritative: the run is over, and everything downstream — the stored TUNED, the bytes a
        // WRITE sends — comes from this pass rather than from the live approximation.
        const flushed = runFlush(true, true);
        await persist(true);
        if (runIdRef.current) {
            try { await endLiveRun(runIdRef.current); } catch { /* the samples are already stored */ }
        }
        return flushed;
    }, [runFlush, persist]);

    /** Drops the buffered run without touching the recovery store — for the paths that replace the
     *  workspace rather than end a drive (a new session, a CSV import, a discard). */
    const reset = useCallback(() => {
        samplesRef.current = [];
        exchangesRef.current = null;
        queueRef.current = [];
        runIdRef.current = null;
        pullRef.current = EMPTY_PULL_CLOCK;
        publishReadout(EMPTY_READOUT);
    }, []);

    /** Adopts a recovered run's samples as the buffer, so a further flush appends rather than
     *  restarting. */
    const adopt = useCallback((points: LogDataPoint[]) => {
        samplesRef.current = points;
        pullRef.current = EMPTY_PULL_CLOCK;
        publishReadout({
            sample: points[points.length - 1] ?? null, count: points.length, hz: null, pull: null,
        });
    }, []);

    return {
        samplesRef, exchangesRef, runIdRef, hzValueRef,
        addSample, start, finish, reset, adopt,
        flush: runFlush,
        persist,
        /** For the readout component. Everything else on the page ignores the sample stream. */
        readout: { subscribe, getSnapshot: getReadout, getServerSnapshot: getServerReadout },
    };
}

/** Subscribes to the live readout. One component uses this — see useLiveRun for why it is a store. */
export function useLiveReadout(feed: ReturnType<typeof useLiveRun>['readout']): LiveReadout {
    return useSyncExternalStore(feed.subscribe, feed.getSnapshot, feed.getServerSnapshot);
}
