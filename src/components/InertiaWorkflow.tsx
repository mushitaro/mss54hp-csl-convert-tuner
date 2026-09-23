import React, { useCallback, useMemo, useRef, useState } from 'react';
import type { InertiaSample, RamProbeResult } from '@/lib/dme-link/types';
import type { InertiaEstimate } from '@/lib/inertia/types';
import type { CorrectionPlan } from '@/lib/inertia/corrections';
import { estimateInertia } from '@/lib/inertia/estimator';
import { proposeCorrections } from '@/lib/inertia/corrections';
import { InertiaPanel } from './InertiaPanel';

/** How often the run publishes its samples for rendering. Same cadence the VE run uses for its
 *  rate readout — live enough to steer by, cheap enough not to matter. */
const PUBLISH_INTERVAL_MS = 250;

/**
 * Owns the inertia run: collects samples, estimates J when the run stops, and asks for a
 * correction plan.
 *
 * A container rather than state threaded through the page, for the same reason the samples are
 * their own type: this run has nothing in common with the VE datalog. It shares no channels, no
 * filter settings, no map, and no output. Folding it into the page's existing log state would put
 * two incompatible things behind one set of variables and make the type separation pointless.
 *
 * The estimate is computed on STOP rather than per sample. Every sample changes the regression, so
 * a live figure would flicker through values that are not measurements of anything — and the bin
 * agreement that decides whether to trust it only means something once the sweeps are complete.
 */
interface Props {
    /** Starts the polling loop. Returns via the callbacks; the caller owns the transport. */
    startRun: (onSample: (s: InertiaSample) => void, onEnd?: (failure: string | null) => void) => void;
    stopRun: () => void;
    /** The image currently in the car, for reading every current value from. */
    baseImage: ArrayBuffer | null;
    /** True J when the link is the offline bench, so PRACTICE can grade the estimate. */
    benchTrueJ?: number;
    /**
     * Hands the finished run to the session store.
     *
     * Optional, and absent means the run stays in memory as it always did. Passed in rather than
     * done here because this component owns a measurement run, not a session — the page owns those,
     * and knows which one is open.
     */
    onSaveRun?: (samples: InertiaSample[]) => void;
    /** Passed straight through to the panel, which owns the gate. See `InertiaPanel`. */
    probeRam?: () => Promise<RamProbeResult | null>;
}

export const InertiaWorkflow: React.FC<Props> = ({ startRun, stopRun, baseImage, benchTrueJ, onSaveRun, probeRam }) => {
    // The authoritative copy, for the same reason the VE datalog keeps one: React state updates are
    // batched and a poll loop running faster than a render would drop samples through a setState
    // closure. The array in state exists to drive the sample counter.
    const samplesRef = useRef<InertiaSample[]>([]);
    /** Last time the sample array was published to React, for the throttle in onStart. */
    const lastPublishRef = useRef(0);
    const [samples, setSamples] = useState<InertiaSample[]>([]);
    const [running, setRunning] = useState(false);
    const [estimate, setEstimate] = useState<InertiaEstimate | null>(null);

    const plan: CorrectionPlan | null = useMemo(() => {
        if (!estimate || !baseImage) return null;
        return proposeCorrections(estimate, baseImage);
    }, [estimate, baseImage]);

    const onStart = useCallback(() => {
        samplesRef.current = [];
        lastPublishRef.current = 0;
        setSamples([]);
        setEstimate(null);
        setRunning(true);
        startRun(
            sample => {
                samplesRef.current.push(sample);
                // Throttled by TIME, not by sample count.
                //
                // It was every fifth sample, which was fine when the panel showed only a counter.
                // The panel now shows live per-bin coverage — the thing that tells the driver
                // whether to keep sweeping — and a count-based throttle ties its refresh rate to
                // the link's, so a slow link would also make the display sluggish exactly when the
                // driver most needs to know the run is going badly.
                //
                // 250 ms is the same cadence the VE run publishes its Hz readout at: fast enough to
                // feel live from the driver's seat, slow enough that the O(n) coverage pass behind
                // it is nothing. The render is also what makes the copy — the ref stays the
                // authoritative array, because the poll loop can outrun React's batching.
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
                // Estimated even when the run ended in a failure. A partial run is still evidence,
                // and the estimator's own gates decide whether it is enough — which is a better
                // answer than discarding it on the caller's behalf.
                setEstimate(estimateInertia(collected));
                // Persist on the same terms as the estimate above: a partial run is still evidence,
                // and an inertia run is research whose whole value is being able to come back to it.
                // Until now the samples lived in this ref and nothing else — navigating away lost
                // the drive.
                if (collected.length) onSaveRun?.(collected);
            },
        );
    }, [startRun, onSaveRun]);

    const onStop = useCallback(() => {
        stopRun();
        setRunning(false);
    }, [stopRun]);

    return (
        <InertiaPanel
            samples={samples}
            estimate={estimate}
            plan={plan}
            running={running}
            onStart={onStart}
            onStop={onStop}
            benchTrueJ={benchTrueJ}
            probeRam={probeRam}
        />
    );
};
