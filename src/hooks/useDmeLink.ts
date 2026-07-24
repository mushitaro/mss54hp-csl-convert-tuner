import { useCallback, useRef, useState } from 'react';
import { DmeLink, DmeIdentity, LiveMeasurement, TransferPhase, AdaptationSnapshot } from '@/lib/dme-link/types';
import { MockDmeLink } from '@/lib/dme-link/mockDmeLink';
import { WebSerialDmeLink } from '@/lib/dme-link/webSerialDmeLink';
import { WebSerialTransport } from '@/lib/dme-link/webSerialTransport';
import { Ds2SupportedBaud } from '@/lib/dme-link/ds2';

/** What the *link* is doing — and nothing else.
 *
 *  There used to be 'ready' (START TUNE) and 'stopped' (WRITE) here too, but neither is a fact about
 *  the cable: they describe what the workspace holds. Storing them made the link and the workspace
 *  two sources of truth that had to be re-synced by hand at every load, reset, connect and
 *  disconnect — and every button bug we hit was one of those syncs being missed or wrong (a new
 *  session inheriting WRITE, a reconnect falling back to READ, READ re-arming READ). The idle
 *  action is now derived from the workspace at render time, so there is nothing left to keep in
 *  sync. Do not add states here that describe data rather than the link. */
export type DmeSessionState =
    | 'disconnected'  // CONNECTION
    | 'connecting'
    | 'connected'     // idle: READ / START TUNE / WRITE, decided by the caller from its data
    | 'reading'
    | 'tuning'        // STOP (live recording active)
    | 'writing'
    | 'resetting';    // adaptation read/clear in flight (RESET ADAPT)

export function useDmeLink() {
    const [state, setState] = useState<DmeSessionState>('disconnected');
    const [mockMode, setMockMode] = useState(false); // real hardware by default — mock is an explicit opt-in
    // Baud rate for the bulk read. 9600 is the proven path (no switch needed). 38400 / 125000 are the
    // only other rates the DME accepts; they need a 0x91 switch + local port reopen, so they're opt-in
    // until confirmed on real hardware.
    const [readBaud, setReadBaud] = useState<Ds2SupportedBaud>(9600);
    const [identity, setIdentity] = useState<DmeIdentity | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [transferProgress, setTransferProgress] = useState<number | null>(null);
    const [transferPhase, setTransferPhase] = useState<TransferPhase | null>(null);

    const linkRef = useRef<DmeLink | null>(null);
    const pollingRef = useRef<boolean>(false);

    const isWebSerialSupported = WebSerialTransport.isSupported();

    // Progress fires once per DS2 chunk (hundreds of times per read/write). Throttle the React state
    // update to ~10 Hz so the UI doesn't thrash and slow the transfer. 100% and phase changes always
    // go through, so the stage label flips the moment the transfer moves on.
    const makeThrottledProgress = () => {
        let last = 0;
        let lastPhase: TransferPhase | undefined;
        return (p: number, phase?: TransferPhase) => {
            const now = Date.now();
            const phaseChanged = phase !== undefined && phase !== lastPhase;
            if (p >= 100 || phaseChanged || now - last >= 100) {
                last = now;
                if (phase !== undefined && phaseChanged) {
                    lastPhase = phase;
                    setTransferPhase(phase);
                }
                setTransferProgress(p);
            }
        };
    };

    const connect = useCallback(async (mockSourceBuffer?: ArrayBuffer) => {
        setError(null);
        setState('connecting');
        try {
            const link: DmeLink = mockMode ? new MockDmeLink(mockSourceBuffer) : new WebSerialDmeLink({ readBaud });
            const id = await link.connect();
            linkRef.current = link;
            setIdentity(id);
            // Just 'connected'. What the button then offers follows from the workspace, so there is
            // no landing target to pass in and none to get wrong.
            setState('connected');
        } catch (e: any) {
            const message = e?.message ?? String(e);
            // Dismissing the browser's port picker isn't a failure, it's a cancel — the same reason
            // read() doesn't surface its own cancel in red. Reporting "No port selected by the user"
            // back to the user who just chose not to select a port is noise.
            const cancelled = e?.name === 'NotFoundError' || /No port selected/i.test(message);
            setError(cancelled ? null : message);
            setState('disconnected');
        }
    }, [mockMode, readBaud]);

    const disconnect = useCallback(async () => {
        pollingRef.current = false;
        try { await linkRef.current?.disconnect(); } catch { }
        linkRef.current = null;
        setIdentity(null);
        setState('disconnected');
    }, []);

    const read = useCallback(async (): Promise<ArrayBuffer | null> => {
        if (!linkRef.current) return null;
        setError(null);
        setState('reading');
        setTransferProgress(0);
        try {
            const buffer = await linkRef.current.readPartialBin(makeThrottledProgress());
            // Idle again. The caller loads these bytes as the BASE, which is what turns the button
            // into START TUNE — it isn't this function's business to say so.
            setState('connected');
            return buffer;
        } catch (e: any) {
            const message = e?.message ?? String(e);
            // A user-initiated cancel is not an error — don't surface it in red.
            setError(/cancel/i.test(message) ? null : message);
            setState('connected');
            return null;
        } finally {
            setTransferProgress(null);
            setTransferPhase(null);
        }
    }, []);

    // Aborts an in-progress partial-BIN read (the read() promise rejects with a cancel error,
    // which read()'s catch treats as a clean return to 'connected').
    const cancelRead = useCallback(() => {
        linkRef.current?.abort();
    }, []);

    /**
     * Begins the live-telemetry polling loop, invoking onSample for each reading until stopTuning is
     * called. Runs detached from React re-renders.
     *
     * onEnd fires exactly once when the loop exits, with the error message if the link failed or null
     * if it stopped cleanly. It exists because the loop can end on its own: a transport failure used
     * to tear it down internally and quietly return the link to 'connected', so the caller's
     * end-of-log teardown — dropping the connection and telling the user to key-cycle before writing —
     * simply never ran. That teardown is bound to a STOP button that had already stopped being
     * offered. onEnd stays a pure link fact ("the poll loop ended, and this is what ended it"); what
     * to DO about it belongs to the caller.
     */
    const startTuning = useCallback((
        onSample: (sample: LiveMeasurement) => void,
        onEnd?: (failure: string | null) => void,
    ) => {
        if (!linkRef.current) { onEnd?.('Not connected to DME'); return; }
        // Every other operation clears the previous error first; this one didn't, so a failed
        // adaptation reset — the step designed to happen immediately before a log — left the status
        // dot red for the whole run and made the abort invisible.
        setError(null);
        setState('tuning');
        pollingRef.current = true;

        (async () => {
            let failure: string | null = null;
            try {
                while (pollingRef.current && linkRef.current) {
                    try {
                        const sample = await linkRef.current.pollLiveMeasurement();
                        if (!pollingRef.current) break;
                        onSample(sample);
                    } catch (e) {
                        // A stop already in flight owns the teardown: disconnect() closes the port under
                        // the in-flight read, and reporting that as a link failure would resurrect
                        // 'connected' after disconnect() had already set 'disconnected'.
                        if (!pollingRef.current) break;
                        failure = e instanceof Error ? e.message : String(e);
                        setError(failure);
                        pollingRef.current = false;
                        setState('connected');
                        break;
                    }
                }
            } finally {
                // finally, not the catch: the loop's normal exit is the while condition / the break,
                // so this is the only true single exit point — and it makes a double-fire impossible.
                onEnd?.(failure);
            }
        })();
    }, []);

    const stopTuning = useCallback(() => {
        pollingRef.current = false;
        setState('connected');
    }, []);

    /**
     * Adaptation read and clear. Both take the link to 'resetting' for the duration.
     *
     * That state is doing real work, not decoration: exchange() has no mutex (the reference
     * serializes every DS2 op behind a CommandGate; this link has nothing equivalent), so if the
     * link stayed 'connected' during a clear the hub would still offer START TUNE, and pressing it
     * would interleave pollLiveMeasurement's frames with the in-flight 0x43 on one transport. The
     * dialog's backdrop hides the hub, but that's a UI-level guard; this is the link-level one. It
     * is also a fact about the link — like 'reading'/'writing' and unlike the 'ready'/'stopped' this
     * type used to carry — so there's no workspace data for it to fall out of sync with.
     *
     * No transferProgress: this is two round trips and a fixed settle, not a chunked transfer, so a
     * percentage would be invented.
     */
    const runAdaptationOp = useCallback(async (
        op: (link: DmeLink) => Promise<AdaptationSnapshot>,
    ): Promise<AdaptationSnapshot | null> => {
        const link = linkRef.current;
        if (!link) return null;
        setError(null);
        setState('resetting');
        try {
            return await op(link);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            return null;
        } finally {
            // Idle again either way — the tune is untouched, so the button goes back to whatever the
            // workspace says on its own.
            setState('connected');
        }
    }, []);

    const readAdaptations = useCallback(
        () => runAdaptationOp(link => link.readAdaptations()), [runAdaptationOp]);

    const resetAdaptations = useCallback(
        () => runAdaptationOp(link => link.clearTuneAdaptations()), [runAdaptationOp]);

    const write = useCallback(async (buffer: ArrayBuffer): Promise<boolean> => {
        if (!linkRef.current) return false;
        setError(null);
        setState('writing');
        setTransferProgress(0);
        try {
            await linkRef.current.writePartialBin(buffer, makeThrottledProgress());
            setState('connected');
            return true;
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            // Idle again, still connected — but do NOT read this as "nothing happened". writePartialBin
            // erases the data area before it writes, so once it has started the ECU is not untouched;
            // a failure here can leave it partially programmed. And if the transport latched a break,
            // an in-place retry is not merely inadvisable but mechanically impossible: the pre-flight
            // login throws immediately. The caller must say so — see handleDmeWrite's failure branch.
            //
            // Deliberately NOT auto-disconnecting: after the destructive phase has begun, closing the
            // port contradicts this file's own "keep power stable and re-write before disconnecting".
            setState('connected');
            return false;
        } finally {
            setTransferProgress(null);
            setTransferPhase(null);
        }
    }, []);

    return {
        state,
        mockMode,
        setMockMode,
        readBaud,
        setReadBaud,
        identity,
        error,
        transferProgress,
        transferPhase,
        isWebSerialSupported,
        connect,
        disconnect,
        read,
        cancelRead,
        startTuning,
        stopTuning,
        write,
        readAdaptations,
        resetAdaptations,
    };
}
