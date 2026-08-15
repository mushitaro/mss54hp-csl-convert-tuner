import React, { useCallback, useMemo, useRef, useState } from 'react';
import type { EgasMeasurement } from '@/lib/dme-link/types';
import type { InertiaEstimate } from '@/lib/inertia/types';
import type { CorrectionPlan } from '@/lib/inertia/corrections';
import { estimateInertia } from '@/lib/inertia/estimator';
import { proposeCorrections } from '@/lib/inertia/corrections';
import { InertiaPanel } from './InertiaPanel';

/**
 * Owns the inertia run: collects EGAS samples, estimates J when the run stops, and asks for a
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
    startRun: (onSample: (s: EgasMeasurement) => void, onEnd?: (failure: string | null) => void) => void;
    stopRun: () => void;
    /** The image currently in the car, for reading every current value from. */
    baseImage: ArrayBuffer | null;
    /** True J when the link is the offline bench, so PRACTICE can grade the estimate. */
    benchTrueJ?: number;
}

export const InertiaWorkflow: React.FC<Props> = ({ startRun, stopRun, baseImage, benchTrueJ }) => {
    // The authoritative copy, for the same reason the VE datalog keeps one: React state updates are
    // batched and a poll loop running faster than a render would drop samples through a setState
    // closure. The array in state exists to drive the sample counter.
    const samplesRef = useRef<EgasMeasurement[]>([]);
    const [samples, setSamples] = useState<EgasMeasurement[]>([]);
    const [running, setRunning] = useState(false);
    const [estimate, setEstimate] = useState<InertiaEstimate | null>(null);

    const plan: CorrectionPlan | null = useMemo(() => {
        if (!estimate || !baseImage) return null;
        return proposeCorrections(estimate, baseImage);
    }, [estimate, baseImage]);

    const onStart = useCallback(() => {
        samplesRef.current = [];
        setSamples([]);
        setEstimate(null);
        setRunning(true);
        startRun(
            sample => {
                samplesRef.current.push(sample);
                // Counter only, and throttled by count rather than by time: the panel shows a
                // number, and re-rendering a number nine times a second is work for nothing.
                if (samplesRef.current.length % 5 === 0) setSamples([...samplesRef.current]);
            },
            () => {
                setRunning(false);
                const collected = samplesRef.current;
                setSamples([...collected]);
                // Estimated even when the run ended in a failure. A partial run is still evidence,
                // and the estimator's own gates decide whether it is enough — which is a better
                // answer than discarding it on the caller's behalf.
                setEstimate(estimateInertia(collected));
            },
        );
    }, [startRun]);

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
        />
    );
};
