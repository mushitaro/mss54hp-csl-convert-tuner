import { useCallback, useEffect, useRef, useState } from 'react';
import {
    DmeLink, DmeIdentity, LiveMeasurement, TransferPhase, AdaptationSnapshot, FlashCounterInfo,
    DmeLinkError, DmeErrorKind, isServiceBlockErasedCause, ServiceBlockDump,
} from '@/lib/dme-link/types';
import { ServiceBlockReport, buildServiceBlockReport } from '@/lib/dme-link/serviceBlockReport';
import { MockDmeLink } from '@/lib/dme-link/mockDmeLink';
import { WebSerialDmeLink } from '@/lib/dme-link/webSerialDmeLink';
import { TransportKind, detectTransportKind } from '@/lib/dme-link/byteTransport';
import { analyzeDataChecksum, DATA_PAIR_LENGTH } from '@/lib/checksum/dmeDataChecksum';
import { dialogText } from '@/lib/dialog-text';
import { Ds2SupportedBaud, EchoMismatchAnalysis } from '@/lib/dme-link/ds2';
import { ReadTimingReport } from '@/lib/dme-link/transferTiming';

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
    | 'resetting';    // a reset-class op in flight: RESET ADAPT, or a flash-counter read/reset

/** Tester-present cadence. Comfortably inside any plausible DS2 session timeout, and cheap: one
 *  5-byte frame, skipped outright whenever the link is doing something real. */
const KEEP_ALIVE_INTERVAL_MS = 2000;

/** What a flash-counter reset attempt came back with. `needsRecovery` means the DME's service block
 *  was found already erased by an earlier interrupted attempt — the caller must offer the restore,
 *  and must NOT offer a retry. Carried in the return value because a prop would arrive too late;
 *  see resetFlashCounter. */
export type FlashCounterOutcome =
    | { ok: true; info: FlashCounterInfo }
    | { ok: false; needsRecovery: boolean };

/**
 * Checks a freshly read image against the checksums the DME stored inside it.
 *
 * Returns null when the image is good — including when it cannot be judged. Both "verified" and
 * "not a 65536-byte data pair" have to answer null, because the only thing the caller does with a
 * non-null result is tell the user their read is corrupt, and a wrong-length buffer is not evidence
 * of that. `analyzeDataChecksum` throws on any other length, and a read that came back short has
 * already failed in some more specific way; letting that throw escape here would replace the real
 * error with an unhandled one from a check that was only meant to add confidence.
 */
function analyzeReadChecksum(buffer: ArrayBuffer): { slave: boolean; master: boolean } | null {
    if (buffer.byteLength !== DATA_PAIR_LENGTH) return null;
    try {
        const [slave, master] = analyzeDataChecksum(new Uint8Array(buffer));
        if (slave.isValid && master.isValid) return null;
        return { slave: slave.isValid, master: master.isValid };
    } catch {
        return null;
    }
}

export function useDmeLink() {
    const [state, setState] = useState<DmeSessionState>('disconnected');
    const [mockMode, setMockMode] = useState(false); // real hardware by default — mock is an explicit opt-in
    // Baud rate for the bulk read. 9600 is the default and sends no switch at all; 38400 is confirmed
    // on a real vehicle. Everything faster needs a 0x91 switch + local port reopen and stays opt-in —
    // 125000 is known to fail here, and the rates between the two are untested candidates.
    const [readBaud, setReadBaud] = useState<Ds2SupportedBaud>(9600);
    const [lastReadTiming, setLastReadTiming] = useState<ReadTimingReport | null>(null);
    const [identity, setIdentity] = useState<DmeIdentity | null>(null);
    const [error, setError] = useState<string | null>(null);
    /**
     * What KIND of failure `error` describes, when the link could tell.
     *
     * The message alone is not enough for the UI to give useful advice: an echo mismatch caused by
     * something pulling the K-line low and one caused by a buffer desync read identically as "check
     * the connection and retry", and only the second is worth retrying. classifyEchoMismatch already
     * separates them; this carries that verdict out to the dialog instead of leaving it inside a
     * sentence nobody can branch on.
     */
    const [errorKind, setErrorKind] = useState<DmeErrorKind | null>(null);
    const [transferProgress, setTransferProgress] = useState<number | null>(null);
    const [transferPhase, setTransferPhase] = useState<TransferPhase | null>(null);
    /**
     * Something the user should know that is not a failure. Separate from `error` so it can be shown
     * without painting the status dot red: a baud switch the DME refused is a normal, harmless
     * outcome that the read recovers from by itself — but staying silent about it is what made a
     * refused switch look identical to a slow tool.
     */
    const [warning, setWarning] = useState<string | null>(null);
    /** 'info' is a plain result (a read's measured speed); 'warn' asks for attention. Kept as data so
     *  the notice line can colour it without matching on the sentence. */
    const [warningKind, setWarningKind] = useState<'info' | 'warn'>('info');

    const linkRef = useRef<DmeLink | null>(null);
    const pollingRef = useRef<boolean>(false);
    const lastServiceDumpRef = useRef<ServiceBlockDump | null>(null);

    /** Report a failure with whatever the link could say about its cause. Paired with clearError so
     *  the kind can never outlive the message it explains — a stale "electrical" next to a fresh
     *  timeout would be worse than no classification at all. */
    const failWith = useCallback((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
        const cause = e instanceof DmeLinkError ? e.cause : undefined;
        // 'serviceBlockErased' is the one kind that names a remedy rather than a diagnosis: it tells
        // the flash dialog to offer the restore instead of a retry, which for that state would be
        // the exact wrong button.
        if (isServiceBlockErasedCause(cause)) { setErrorKind('serviceBlockErased'); return; }
        const kind = (cause as EchoMismatchAnalysis | undefined)?.kind;
        setErrorKind(kind === 'electrical' || kind === 'desync' || kind === 'unclassified' ? kind : null);
    }, []);

    const clearError = useCallback(() => { setError(null); setErrorKind(null); setWarning(null); }, []);

    /**
     * Which backend can reach a DME here — `null` until the browser has actually been asked.
     *
     * This used to be `WebSerialTransport.isSupported()` evaluated during render, and that was
     * wrong twice over. On Android it answers *true* while the port picker offers only Bluetooth
     * SPP, so a K+DCAN cable is unreachable behind a capability check that says it is fine. And
     * during the static prerender there is no `navigator.serial`, so it answered *false* and baked
     * "Web Serial API not available in this browser" straight into the exported HTML — every
     * desktop visitor saw that for a frame before hydration replaced it.
     *
     * Resolving after mount fixes both: nothing is asserted about the browser until a browser is
     * actually present. It also keeps `dialogText()` out of the prerender, which would otherwise
     * emit Japanese into HTML that an English client then has to reconcile.
     */
    const [transportKind, setTransportKind] = useState<TransportKind | null>(null);
    useEffect(() => { setTransportKind(detectTransportKind()); }, []);

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
        clearError();
        setState('connecting');
        try {
            const link: DmeLink = mockMode ? new MockDmeLink(mockSourceBuffer) : new WebSerialDmeLink({ readBaud });
            // Always on. There used to be a DIAG checkbox here, which saved nothing measurable — the
            // instrument costs ~7 ms of performance.now() calls across a 123 s read, 0.006% — and cost
            // a whole vehicle run every time someone forgot to arm it before driving out. Before
            // connect, because identify() already runs exchanges.
            link.setTimingEnabled?.(true);
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
            if (cancelled) clearError(); else failWith(e);
            setState('disconnected');
        }
    }, [mockMode, readBaud, clearError, failWith]);

    const disconnect = useCallback(async () => {
        pollingRef.current = false;
        try { await linkRef.current?.disconnect(); } catch { }
        linkRef.current = null;
        setIdentity(null);
        setState('disconnected');
    }, []);

    /**
     * Tester-present while the link is up but nothing is being asked of it.
     *
     * The gap this closes is the adaptation dialog's viewing phase: a human reads twelve values and
     * decides, and for that whole time — seconds to minutes — the K-line is silent. If the DME drops
     * its diagnostic session in that window, the clear that follows fails, which is exactly where the
     * failure is experienced.
     *
     * Runs on every state, not only 'connected'. The link itself decides whether to send: keepAlive
     * skips when the CommandGate is held, so a read, a write or a poll loop simply absorbs the tick.
     * Gating here on state instead would be a second, weaker copy of that rule — and the reset dialog
     * sits in 'connected' anyway.
     *
     * `void` because nothing branches on the result: it is a heartbeat, and a failed one is reported
     * by the next real operation rather than as an error the user did not ask for.
     */
    useEffect(() => {
        const id = setInterval(() => { void linkRef.current?.keepAlive(); }, KEEP_ALIVE_INTERVAL_MS);
        return () => clearInterval(id);
    }, []);

    const read = useCallback(async (): Promise<ArrayBuffer | null> => {
        if (!linkRef.current) return null;
        clearError();
        setState('reading');
        setTransferProgress(0);
        const startedAt = performance.now();
        try {
            const buffer = await linkRef.current.readPartialBin(makeThrottledProgress());
            // Always report the measured result, not just failures. "It didn't feel faster" is not
            // something a baud rate can be judged on — that guess already cost three rates being
            // deleted on a wrong conclusion — so the read states its own elapsed time and throughput.
            const seconds = (performance.now() - startedAt) / 1000;
            const actual = linkRef.current.getLastReadBaud?.() ?? null;
            // Kept short on purpose: the notice line is one truncating row, so a sentence-shaped
            // message loses its tail — which is exactly where the numbers were. Baud comes first
            // because "which rate did this actually run at" is the question being answered.
            const rate = `${Math.round(buffer.byteLength / seconds).toLocaleString()} B/s`;
            const measured = `${(buffer.byteLength / 1024).toFixed(0)} KB / ${seconds.toFixed(1)} s · ${rate}`;
            const refused = actual !== null && actual !== readBaud;
            // The notice line stays the headline only. The per-chunk breakdown used to be appended as
            // a numeric tail, which mattered while the numbers were being read from the driver's seat
            // during a sweep; now that timing is always collected, TIMING saves the file and this row
            // goes back to being the one line a normal read produces.
            // Verify the bytes against the checksums the DME itself stored in them — silently.
            //
            // This is the acceptance test the Android transport was actually validated with, and it
            // is a stronger one than comparing two reads: the CRC-16/ARC values live in the image,
            // written by the ECU, so a systematic transport fault cannot agree with them the way it
            // would agree with a second read of its own making. The two slots together cover 65528
            // of the 65536 bytes; the remaining 8 *are* the slots, which a match verifies.
            //
            // Deliberately silent when it passes. The line below is, as the comment above says, the
            // one line a normal read produces, and it is carrying the measured baud and throughput —
            // the numbers a rate can actually be judged on. A "CHECKSUM OK" on every read would push
            // those out of a row that truncates, to say something that is true every time.
            //
            // A failure is not that. Reading corrupt bytes, tuning from them and writing them back is
            // the worst outcome this app has, so that one case takes the line.
            const checksum = analyzeReadChecksum(buffer);
            setWarningKind(refused || checksum !== null ? 'warn' : 'info');
            setWarning(checksum !== null
                ? dialogText().readChecksumBad(checksum)
                : refused
                    ? `${readBaud} REFUSED — ran at ${actual} · ${measured}`
                    : `${actual !== null ? `${actual} baud` : 'link'} · ${measured}`);
            // Idle again. The caller loads these bytes as the BASE, which is what turns the button
            // into START TUNE — it isn't this function's business to say so.
            setState('connected');
            return buffer;
        } catch (e: any) {
            const message = e?.message ?? String(e);
            // A user-initiated cancel is not an error — don't surface it in red.
            if (/cancel/i.test(message)) clearError(); else failWith(e);
            setState('connected');
            return null;
        } finally {
            // Publish the timing on BOTH paths, and publish null when there is none. It used to be
            // captured only on success, so a read that died part-way left the PREVIOUS run's report in
            // place — and TIMING then silently saved that instead. A 38400 sweep came back as three
            // byte-identical copies of the preceding 9600 run before this was noticed, costing a whole
            // vehicle session. A failed read is the case worth measuring, not the one to drop:
            // `chunks` says how far it got and `error` says what stopped it.
            //
            // Assigned unconditionally, including null: the link clears its own report at the start of
            // every read attempt, so this state always describes the read that just ran or nothing at
            // all. Keeping a stale report because the new one is missing is the exact failure being
            // fixed here — silently saving the wrong run is far worse than having nothing to save.
            setLastReadTiming(linkRef.current?.getLastReadTiming?.() ?? null);
            setTransferProgress(null);
            setTransferPhase(null);
        }
    }, [clearError, failWith]);

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
        clearError();
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
    }, [clearError]);

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
        clearError();
        setState('resetting');
        try {
            return await op(link);
        } catch (e) {
            failWith(e);
            return null;
        } finally {
            // Idle again either way — the tune is untouched, so the button goes back to whatever the
            // workspace says on its own.
            setState('connected');
        }
    }, [clearError, failWith]);

    const readAdaptations = useCallback(
        () => runAdaptationOp(link => link.readAdaptations()), [runAdaptationOp]);

    const resetAdaptations = useCallback(
        () => runAdaptationOp(link => link.clearTuneAdaptations()), [runAdaptationOp]);

    /** Folds a fresh counter reading into `identity`, so the header updates without a reconnect.
     *  Functional update: the reset takes minutes, and re-reading `identity` from this closure would
     *  write back whatever it held when the operation started. */
    const applyFlashCounter = useCallback((flashCounter: FlashCounterInfo) => {
        setIdentity(prev => (prev ? { ...prev, flashCounter } : prev));
    }, []);

    /**
     * Engine speed, to answer "may a programming operation run?".
     *
     * Returns null when the DME could not be asked, which the caller must NOT read as "stopped" —
     * an unanswered question is not a zero. Deliberately not folded into readFlashCounter: they are
     * two independent facts, and a failed RPM read should not cost the counter reading that
     * succeeded.
     */
    const readEngineRpm = useCallback(async (): Promise<number | null> => {
        const link = linkRef.current;
        if (!link) return null;
        setState('resetting');
        try {
            return await link.readEngineRpm();
        } catch {
            // Deliberately not failWith: this is a precondition probe the user did not ask for, and
            // painting the status dot red for it would misreport the link. The caller shows its own
            // "could not confirm" message instead.
            return null;
        } finally {
            setState('connected');
        }
    }, []);

    /**
     * Writes a saved service block back, recovering from a reset that was interrupted mid-rewrite.
     *
     * Same state and progress treatment as the reset, because it is the same programming sequence
     * with different bytes — and because from the user's side it is the second half of one incident,
     * not a new operation.
     */
    const restoreServiceBlock = useCallback(async (
        serviceBlockPair: ArrayBuffer,
    ): Promise<FlashCounterInfo | null> => {
        const link = linkRef.current;
        if (!link) return null;
        clearError();
        setState('resetting');
        setTransferProgress(0);
        try {
            const info = await link.restoreServiceBlock(serviceBlockPair, makeThrottledProgress());
            applyFlashCounter(info);
            return info;
        } catch (e) {
            failWith(e);
            return null;
        } finally {
            setState('connected');
            setTransferProgress(null);
            setTransferPhase(null);
        }
    }, [clearError, failWith, applyFlashCounter]);

    /**
     * Reads both service blocks for inspection. Read-only, but it moves 16 KB, so it publishes
     * progress like the other bulk operations.
     */
    const readServiceBlocks = useCallback(async (): Promise<ServiceBlockReport | null> => {
        const link = linkRef.current;
        if (!link) return null;
        clearError();
        setState('resetting');
        setTransferProgress(0);
        try {
            const dump = await link.readServiceBlocks(makeThrottledProgress());
            // The raw bytes are kept alongside the report so the UI can offer them as a file without
            // a second 16 KB read — this is a diagnostic whose whole purpose is being sent onward.
            const report = buildServiceBlockReport(dump.master, dump.slave, dump.pointers);
            lastServiceDumpRef.current = dump;
            return report;
        } catch (e) {
            failWith(e);
            return null;
        } finally {
            setState('connected');
            setTransferProgress(null);
            setTransferPhase(null);
        }
    }, [clearError, failWith]);

    /** The bytes behind the most recent report, as one 16384-byte master+slave image. */
    const getServiceBlockBytes = useCallback((): ArrayBuffer | null => {
        const dump = lastServiceDumpRef.current;
        if (!dump) return null;
        const pair = new Uint8Array(dump.master.length + dump.slave.length);
        pair.set(dump.master, 0);
        pair.set(dump.slave, dump.master.length);
        return pair.buffer;
    }, []);

    /** Re-reads the flash counter. Six chunk reads — 'resetting' rather than 'reading' because
     *  'reading' is the bulk partial-BIN transfer and paints the hub's progress ring. */
    const readFlashCounter = useCallback(async (): Promise<FlashCounterInfo | null> => {
        const link = linkRef.current;
        if (!link) return null;
        clearError();
        setState('resetting');
        try {
            const info = await link.readFlashCounter();
            applyFlashCounter(info);
            return info;
        } catch (e) {
            failWith(e);
            return null;
        } finally {
            setState('connected');
        }
    }, [clearError, failWith, applyFlashCounter]);

    /**
     * Clears the flash counter, and publishes progress while it does.
     *
     * Unlike runAdaptationOp this reports a percentage. That function's reason for not doing so —
     * "two round trips and a fixed settle, not a chunked transfer, so a percentage would be
     * invented" — simply doesn't hold here: this reads 16 KB, erases, writes it back and reads it
     * all again, so every number it publishes is measured.
     *
     * Stays in 'resetting' rather than 'writing': the dialog owns the screen and shows the progress
     * itself, and 'writing' additionally means "a tune is going to the ECU" to everything that
     * branches on it (the toggle disables, the hub's WRITING label).
     */
    const resetFlashCounter = useCallback(async (
        onBackup: (serviceBlockPair: ArrayBuffer) => Promise<void>,
    ): Promise<FlashCounterOutcome> => {
        const link = linkRef.current;
        if (!link) return { ok: false, needsRecovery: false };
        clearError();
        setState('resetting');
        setTransferProgress(0);
        try {
            const info = await link.resetFlashCounter(onBackup, makeThrottledProgress());
            applyFlashCounter(info);
            return { ok: true, info };
        } catch (e) {
            failWith(e);
            // Returned rather than left for the caller to read off `errorKind`: that is a prop, and
            // the caller resumes from its await BEFORE React has re-rendered with the new value, so
            // it would still see the previous one. The caller has to choose between offering Retry
            // and offering the restore, and getting that backwards is the difference between a
            // recoverable ECU and a permanently broken one.
            return { ok: false, needsRecovery: e instanceof DmeLinkError && isServiceBlockErasedCause(e.cause) };
        } finally {
            // Idle again, still connected. The caller drops the link straight afterwards for the
            // key cycle, but that is its decision to make — and on failure the connection is exactly
            // what is needed to retry or to restore the backup.
            setState('connected');
            setTransferProgress(null);
            setTransferPhase(null);
        }
    }, [clearError, failWith, applyFlashCounter]);

    const write = useCallback(async (buffer: ArrayBuffer): Promise<boolean> => {
        if (!linkRef.current) return false;
        clearError();
        setState('writing');
        setTransferProgress(0);
        try {
            await linkRef.current.writePartialBin(buffer, makeThrottledProgress());
            setState('connected');
            return true;
        } catch (e) {
            failWith(e);
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
    }, [clearError, failWith]);

    return {
        state,
        mockMode,
        setMockMode,
        readBaud,
        setReadBaud,
        lastReadTiming,
        identity,
        error,
        errorKind,
        warning,
        warningKind,
        transferProgress,
        transferPhase,
        transportKind,
        connect,
        disconnect,
        read,
        cancelRead,
        startTuning,
        stopTuning,
        write,
        readAdaptations,
        resetAdaptations,
        readFlashCounter,
        readServiceBlocks,
        getServiceBlockBytes,
        resetFlashCounter,
        restoreServiceBlock,
        readEngineRpm,
    };
}
