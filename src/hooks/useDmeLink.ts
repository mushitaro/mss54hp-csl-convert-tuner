import { useCallback, useEffect, useRef, useState } from 'react';
import {
    DmeLink, DmeIdentity, LiveMeasurement, InertiaSample, RamProbeResult, TransferPhase, AdaptationSnapshot, FlashCounterInfo,
    DmeLinkError, DmeErrorKind, isServiceBlockErasedCause, ServiceBlockDump,
    WriteVerifyMode, WriteVerification, IdleSample,} from '@/lib/dme-link/types';
import { ServiceBlockReport, buildServiceBlockReport } from '@/lib/dme-link/serviceBlockReport';
import type { SpotWindow } from '@/lib/dme-link/spotCheck';
import { MockDmeLink } from '@/lib/dme-link/mockDmeLink';
import { WebSerialDmeLink } from '@/lib/dme-link/webSerialDmeLink';
import { loadFastEntrySeed } from '@/lib/db/serviceBackupRepository';
import { TransportKind, detectTransportKind } from '@/lib/dme-link/byteTransport';
import { analyzeDataChecksum, DATA_PAIR_LENGTH } from '@/lib/checksum/dmeDataChecksum';
import { dialogText } from '@/lib/dialog-text';
import { Ds2SupportedBaud, EchoMismatchAnalysis } from '@/lib/dme-link/ds2';
import { TransferTimingReport } from '@/lib/dme-link/transferTiming';
import { LinkEventLogSnapshot } from '@/lib/dme-link/linkEventLog';
import type { LogExchange, LogProfile } from '@/lib/log-engine/logProfile';
import { LOG_PROFILES } from '@/lib/log-engine/logProfile';

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
 * What a bulk read came back with, and why it did not when it did not.
 *
 * A discriminated result rather than `ArrayBuffer | null`, for the same reason `FlashCounterOutcome`
 * above is one: the caller resumes from its `await` BEFORE React has re-rendered with the new
 * `error`, so reading the failure off the returned object is the only way to read it at all. A
 * `null` cannot say whether the user cancelled the port picker or the DME refused the login, and
 * both callers need to know — the diagnostic record wants the reason, and a cancel is not a failure
 * to report.
 */
export type ReadOutcome =
    | { ok: true; buffer: ArrayBuffer }
    | { ok: false; cancelled: boolean; error: string };

/** The same, for the flash. `verification` rather than a boolean because the completion dialog has
 *  to state which checks actually ran; `error` because the failure dialog has to say what stopped
 *  it, and it used to read a `dmeLink.error` frozen at the render that built the handler — so every
 *  failed write reported "unknown error" no matter what happened. */
export type WriteOutcome =
    | { ok: true; verification: WriteVerification }
    | { ok: false; error: string };

/**
 * Everything about the link that an async handler needs, readable from the middle of one.
 *
 * The problem this solves is not hypothetical and not small. Handlers here are defined during
 * render, so they capture that render's `dmeLink` object; they then await an operation for anything
 * up to two minutes, during which the operation's own failure, identity change or reconnect has
 * already been published to a NEWER object. Reading `dmeLink.error` after the await reads the value
 * from before the operation — so the write-failure dialog said "unknown error" for every real
 * failure, and `startInertiaRunWithDiagnostics` (memoised on a stable dep, therefore built once on
 * the first render) filed every inertia diagnostic with a null VIN, a null transport and no session.
 *
 * Written synchronously by the setters below rather than from an effect, and that is the whole
 * design. An effect runs after commit; a handler resuming from `await link.write()` runs as a
 * microtask, well before React has even scheduled that render. A snapshot updated in an effect would
 * be exactly as stale as the object it replaces.
 */
export interface DmeLinkSnapshot {
    state: DmeSessionState;
    error: string | null;
    errorKind: DmeErrorKind | null;
    identity: DmeIdentity | null;
    transportKind: TransportKind | null;
    mockMode: boolean;
}

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
    /**
     * The snapshot every setter below keeps up to date, and the only thing async handlers may read.
     *
     * Mutated in place from callbacks — never during render, which is a real hazard rather than a
     * lint preference: React may render a component it then discards, and a value written from that
     * render would describe a link state that was never committed. Every write here happens inside
     * an event handler, an effect or an async operation, all of which run after commit.
     */
    const snapshotRef = useRef<DmeLinkSnapshot>({
        state: 'disconnected', error: null, errorKind: null,
        identity: null, transportKind: null, mockMode: false,
    });
    /** A copy, so a caller that holds onto it cannot be surprised by it changing underneath. */
    const readLinkState = useCallback((): DmeLinkSnapshot => ({ ...snapshotRef.current }), []);

    const [state, setStateValue] = useState<DmeSessionState>('disconnected');
    const setState = useCallback((next: DmeSessionState) => {
        snapshotRef.current.state = next;
        setStateValue(next);
    }, []);
    const [mockMode, setMockModeValue] = useState(false); // real hardware by default — mock is an explicit opt-in
    const setMockMode = useCallback((next: boolean) => {
        snapshotRef.current.mockMode = next;
        setMockModeValue(next);
    }, []);
    /**
     * Rate to boost the FLASH WRITE to after the erase. 9600 = no switch attempted.
     *
     * The only rate anything selects. There was a READ selector beside it; it is gone, because two
     * of its three settings were proven to lose the read and the third was the default (see
     * Ds2SupportedBaud). This one is different in kind: it can only be sent from inside a
     * programming session, which only exists after the erase, so it starts off on every connect and
     * has to be armed on purpose each time. Not persisted, for that reason.
     */
    const [writeBaud, setWriteBaudState] = useState<Ds2SupportedBaud>(9600);
    /**
     * Arms the boost on the live link as well as in React state, so the selector is describing the
     * link that WRITE will actually use rather than the one that existed at connect.
     *
     * The link is the authority on whether the arming took: a transport that cannot change rate on
     * the open handle refuses it, and reading the value back means the selector cannot sit on
     * 125000 while the link quietly stays at 9600.
     */
    const setWriteBaud = useCallback((baud: Ds2SupportedBaud) => {
        linkRef.current?.setWriteBaud?.(baud);
        setWriteBaudState(linkRef.current?.getWriteBaud?.() ?? baud);
    }, []);
    /**
     * The last instrumented operation's numbers and its narrative, captured together.
     *
     * One slot for both, and one slot for every operation kind — the report itself says whether it
     * describes a read or a write. Two separate pieces of state would let a write's timing sit
     * beside a read's event log, which is the shape of a diagnostic that reads perfectly and
     * describes nothing that happened.
     */
    const [lastTransferTiming, setLastTransferTiming] = useState<TransferTimingReport | null>(null);
    const [lastEventLog, setLastEventLog] = useState<LinkEventLogSnapshot | null>(null);
    /**
     * The same two values, in refs, for readers that run INSIDE the operation's own async handler.
     *
     * This is not belt-and-braces, it is a correctness fix for a real off-by-one. `handleDmeRead`
     * closes over the `dmeLink` object from the render that created it, awaits a read for up to two
     * minutes, and then builds the diagnostic record. The state setters below have fired by then and
     * re-rendered — but the suspended handler still holds the OLD object, so it published the
     * PREVIOUS operation's report every time and the last operation of a session was never uploaded
     * at all. Proven from the store: three records whose own event logs ended 16 s, 39 s and 2 min 43 s
     * before the record claimed to have been created.
     *
     * State stays for rendering; refs are what the handlers must read.
     */
    const lastTransferTimingRef = useRef<TransferTimingReport | null>(null);
    const lastEventLogRef = useRef<LinkEventLogSnapshot | null>(null);
    const publishLast = useCallback((link: DmeLink | null) => {
        const report = link?.getLastTransferTiming?.() ?? null;
        const events = link?.getEventLog?.() ?? null;
        lastTransferTimingRef.current = report;
        lastEventLogRef.current = events;
        setLastTransferTiming(report);
        setLastEventLog(events);
    }, []);
    /**
     * Closes a log run's timing window and publishes it, on the link object the run started with.
     *
     * Both run kinds need exactly this and neither could do it correctly through `linkRef`: STOP
     * tears the connection down without waiting for the poll loop, so the ref is usually null by the
     * time the loop's `finally` runs. Nothing ever noticed, because every call was optional-chained
     * and a no-op reads the same as a success — which is why `kind: 'log'` has never once reached
     * the diagnostics store despite the inertia run having armed the instrument since it was built.
     *
     * Guarded end to end: a run's report is a nice-to-have and must never be able to take down the
     * teardown that follows it.
     */
    const closeLogTiming = useCallback((link: DmeLink | null, failure: string | null) => {
        if (!link) return;
        try {
            link.endLogTiming?.(failure ?? undefined);
            publishLast(link);
        } catch { /* the run's own outcome is what matters; this is instrumentation */ }
    }, [publishLast]);
    const [identity, setIdentityValue] = useState<DmeIdentity | null>(null);
    /** Takes an updater as well as a value, because applyFlashCounter folds a fresh counter into
     *  whatever identity is current — see there for why it must not read it from a closure. The
     *  snapshot is the authority the updater is applied to, and it is current by construction. */
    const setIdentity = useCallback((next: DmeIdentity | null | ((prev: DmeIdentity | null) => DmeIdentity | null)) => {
        const value = typeof next === 'function' ? next(snapshotRef.current.identity) : next;
        snapshotRef.current.identity = value;
        setIdentityValue(value);
    }, []);
    const [error, setErrorValue] = useState<string | null>(null);
    const setError = useCallback((next: string | null) => {
        snapshotRef.current.error = next;
        setErrorValue(next);
    }, []);
    /**
     * What KIND of failure `error` describes, when the link could tell.
     *
     * The message alone is not enough for the UI to give useful advice: an echo mismatch caused by
     * something pulling the K-line low and one caused by a buffer desync read identically as "check
     * the connection and retry", and only the second is worth retrying. classifyEchoMismatch already
     * separates them; this carries that verdict out to the dialog instead of leaving it inside a
     * sentence nobody can branch on.
     */
    const [errorKind, setErrorKindValue] = useState<DmeErrorKind | null>(null);
    const setErrorKind = useCallback((next: DmeErrorKind | null) => {
        snapshotRef.current.errorKind = next;
        setErrorKindValue(next);
    }, []);
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
    }, [setError, setErrorKind]);

    const clearError = useCallback(() => { setError(null); setErrorKind(null); setWarning(null); }, [setError, setErrorKind]);

    /**
     * Back to idle — but only if there is still a link to be idle ON.
     *
     * Every operation used to end with `finally { setState('connected') }`, and that is a claim
     * about the cable rather than about the operation. The FAST READ path makes it false: it reboots
     * the DME, disconnects, and reconnects, and if the reconnect does not take it leaves `linkRef`
     * null — after which the hub sat on 'connected' offering READ and START TUNE over nothing, and
     * every one of them failed with "Not connected to DME" from inside a handler.
     *
     * The same shape guards the ordinary teardown race: `disconnect()` nulls the ref and sets
     * 'disconnected', and an in-flight operation settling afterwards would otherwise resurrect
     * 'connected' on a closed port.
     */
    const settleIdle = useCallback(() => {
        setState(linkRef.current ? 'connected' : 'disconnected');
    }, [setState]);

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
    const [transportKind, setTransportKindValue] = useState<TransportKind | null>(null);
    /** Whether FAST READ is armed on the live link. Set by connect() from what the seed lookup
     *  found, so the UI reports the link's own answer rather than an intention. */
    const [fastReadArmed, setFastReadArmed] = useState(false);
    useEffect(() => {
        const kind = detectTransportKind();
        snapshotRef.current.transportKind = kind;
        setTransportKindValue(kind);
    }, []);

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
            const link: DmeLink = mockMode ? new MockDmeLink(mockSourceBuffer) : new WebSerialDmeLink();
            // Always on. There used to be a DIAG checkbox here, which saved nothing measurable — the
            // instrument costs ~7 ms of performance.now() calls across a 123 s read, 0.006% — and cost
            // a whole vehicle run every time someone forgot to arm it before driving out. Before
            // connect, because identify() already runs exchanges.
            link.setTimingEnabled?.(true);
            // Every connect starts disarmed. The one thing that must not happen is a boost surviving
            // from a session the operator has stopped thinking about — the selector says it resets,
            // and the reset belongs where the link is built, not only where the state is declared.
            link.setWriteBaud?.(9600);
            setWriteBaudState(9600);
            const id = await link.connect();
            linkRef.current = link;
            setIdentity(id);
            // FAST READ, armed here rather than at read time, because the seed is keyed by VIN and
            // the VIN only exists once identify() has run. A DME with no stored service-block backup
            // simply stays disarmed and reads at 9600 — the first backup is created by the flash
            // counter dialog's own inspect/backup path, which is where reading those 16 KB already
            // belongs. Never in PRACTICE: `mock` is part of the backup's identity for the same
            // reason it gates a restore, and a mock seed must never describe a real ECU.
            try {
                const seed = mockMode ? null : await loadFastEntrySeed(id.vin, false);
                link.setFastRead?.(seed);
                setFastReadArmed(link.getFastReadArmed?.() ?? false);
            } catch {
                // A seed that cannot be loaded is a slow read, not a failed connect.
                setFastReadArmed(false);
            }
            // Just 'connected'. What the button then offers follows from the workspace, so there is
            // no landing target to pass in and none to get wrong.
            settleIdle();
        } catch (e) {
            // `unknown`, narrowed here rather than typed `any` at the catch. The browser's own
            // DOMException is the case being classified and it is not an Error subclass everywhere,
            // so both fields are read defensively rather than asserted.
            const err = e as { message?: unknown; name?: unknown } | null;
            const message = typeof err?.message === 'string' ? err.message : String(e);
            // Dismissing the browser's port picker isn't a failure, it's a cancel — the same reason
            // read() doesn't surface its own cancel in red. Reporting "No port selected by the user"
            // back to the user who just chose not to select a port is noise.
            const cancelled = err?.name === 'NotFoundError' || /No port selected/i.test(message);
            if (cancelled) clearError(); else failWith(e);
            setState('disconnected');
        }
    }, [mockMode, clearError, failWith, setState, setIdentity, settleIdle]);

    const disconnect = useCallback(async () => {
        pollingRef.current = false;
        try { await linkRef.current?.disconnect(); } catch { }
        linkRef.current = null;
        setIdentity(null);
        setState('disconnected');
    }, [setState, setIdentity]);

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
        const id = setInterval(() => {
            // Not while a datalog is running. The gate makes this safe rather than correct: keepAlive
            // skips when an operation holds it, so a tick that lands mid-exchange is absorbed — but a
            // tick that lands in the gap BETWEEN two samples wins the gate and spends a full ~150 ms
            // round trip proving a link that is being exercised twice a second anyway. The whole
            // point of a tester-present frame is to fill silence, and a log leaves none.
            if (pollingRef.current) return;
            void linkRef.current?.keepAlive();
        }, KEEP_ALIVE_INTERVAL_MS);
        return () => clearInterval(id);
    }, []);

    const read = useCallback(async (): Promise<ReadOutcome> => {
        if (!linkRef.current) return { ok: false, cancelled: false, error: 'Not connected to DME' };
        // Pinned, because the FAST READ path REPLACES linkRef.current before this function returns:
        // it reboots the DME and reconnects, which builds a new link with an empty event log and no
        // timing report. Publishing from `linkRef.current` in the finally would hand over that empty
        // one — silently losing the diagnostic for the read that just ran, which is the exact failure
        // the comment down there says was already paid for with a vehicle session. The old object
        // still holds its report after disconnect; nothing here needs it to be live.
        const readLink = linkRef.current;
        clearError();
        setState('reading');
        setTransferProgress(0);
        const startedAt = performance.now();
        try {
            const buffer = await readLink.readPartialBin(makeThrottledProgress());
            // Always report the measured result, not just failures. "It didn't feel faster" is not
            // something a baud rate can be judged on — that guess already cost three rates being
            // deleted on a wrong conclusion — so the read states its own elapsed time and throughput.
            const seconds = (performance.now() - startedAt) / 1000;
            const actual = readLink.getLastReadBaud?.() ?? null;
            // Kept short on purpose: the notice line is one truncating row, so a sentence-shaped
            // message loses its tail — which is exactly where the numbers were. Baud comes first
            // because "which rate did this actually run at" is the question being answered.
            const rate = `${Math.round(buffer.byteLength / seconds).toLocaleString()} B/s`;
            const measured = `${(buffer.byteLength / 1024).toFixed(0)} KB / ${seconds.toFixed(1)} s · ${rate}`;
            // FAST READ armed and the read still came back at 9600: the programming session or the
            // switch did not hold. Worth a warning — it is the difference between 20 seconds and two
            // minutes, and nothing else on screen says why.
            //
            // Against the LINK's own arming, not a React value, and against 125000 rather than a
            // selected rate. The old form compared `actual` with the READ selector, which sat at
            // 9600 while a SUCCESSFUL fast read ran at 125000 — so the one path that reaches the
            // fast rate reported itself as "9600 REFUSED — ran at 125000". A plain read has nothing
            // left to refuse: there is no rate to select any more, and it sends no switch.
            const fastArmed = readLink.getFastReadArmed?.() ?? false;
            const refused = fastArmed && actual !== null && actual !== 125000;
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
                    ? `FAST READ REFUSED — ran at ${actual} · ${measured}`
                    : `${actual !== null ? `${actual} baud` : 'link'} · ${measured}`);
            // Come back down from 125000 before handing control back.
            //
            // A read at that rate only happened because the DME is in a programming session, and in
            // that state it will not serve live values, adaptations or error memory — the reference
            // simply forbids all three until the user reconnects. This app's whole workflow is READ
            // then LOG then WRITE in one sitting, so "reconnect now" would land in the middle of it,
            // standing next to a car. A reboot and a fresh connect cost a few seconds and put the
            // link back where every other feature expects to find it.
            //
            // Deliberately after the warning above is set and after the buffer is in hand: the read
            // has already succeeded, and nothing here is allowed to turn that into a failure. If the
            // reboot or the reconnect does not take, the bytes are still returned and the notice
            // tells the user to reconnect by hand.
            if (actual === 125000) {
                const rebooted = await readLink.rebootDme?.() ?? false;
                let recovered = false;
                if (rebooted) {
                    try {
                        await readLink.disconnect();
                        linkRef.current = null;
                        await connect();
                        recovered = linkRef.current !== null;
                    } catch { recovered = false; }
                }
                if (!recovered) {
                    setWarningKind('warn');
                    setWarning('Read OK at 125000, but the DME is still in programming mode — '
                        + 'live logging and adaptations need a reconnect. Disconnect and connect again.');
                }
            }
            // Idle again. The caller loads these bytes as the BASE, which is what turns the button
            // into START TUNE — it isn't this function's business to say so.
            settleIdle();
            return { ok: true, buffer };
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            // A user-initiated cancel is not an error — don't surface it in red. Carried out in the
            // result as well, so the caller can tell "the user pressed Cancel Read" from "the DME
            // stopped answering" without matching on the sentence a second time.
            const cancelled = /cancel/i.test(message);
            if (cancelled) clearError(); else failWith(e);
            settleIdle();
            return { ok: false, cancelled, error: message };
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
            publishLast(readLink);
            setTransferProgress(null);
            setTransferPhase(null);
        }
        // `connect` is a real input and was missing: the 125000 path reconnects through it, and a
        // stale copy would rebuild the link with an out-of-date mockMode. The READ rate used to be
        // listed here too, for a "REFUSED" comparison that no longer reads React state — see above.
    }, [clearError, failWith, publishLast, connect, setState, settleIdle]);

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
        /**
         * What a sample is made of — the run profile's exchange list.
         *
         * Applied here rather than left to the caller to set beforehand, because the two have to
         * move together: a profile chosen and a poll still fetching the old exchanges would produce
         * a log with channels the process does not claim, or missing ones it does. Omitted means the
         * link keeps whatever it had, which is both blocks.
         */
        exchanges?: readonly LogExchange[],
    ) => {
        const link = linkRef.current;
        if (!link) { onEnd?.('Not connected to DME'); return; }
        if (exchanges) link.setLiveExchanges?.(exchanges);
        // Every other operation clears the previous error first; this one didn't, so a failed
        // adaptation reset — the step designed to happen immediately before a log — left the status
        // dot red for the whole run and made the abort invisible.
        clearError();
        setState('tuning');
        pollingRef.current = true;
        // Armed for the datalog too, not just the inertia run. Until now `kind: 'log'` was only ever
        // emitted by startInertiaRun, so the path whose rate the whole profile exercise is about —
        // the VE/EGT poll — had never been measured on the wire once. Session #903's 6.60 Hz had to
        // be recovered by dividing samples by duration after the fact, which cannot separate the
        // DME's turnaround from the host's; this can. Sized from the exchanges actually being made —
        // the link's answer, not the request, because it puts block 3 back if the caller left it out.
        link.beginLogTiming?.(link.getLiveExchanges?.() ?? exchanges);

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
                        settleIdle();
                        break;
                    }
                }
            } finally {
                // finally, not the catch: the loop's normal exit is the while condition / the break,
                // so this is the only true single exit point — and it makes a double-fire impossible.
                //
                // Closed on the same terms as a read or a write: a drive that died part-way is the
                // most informative timing report there is, so the failure is passed in rather than
                // used as a reason to discard the window.
                //
                // `link`, not `linkRef.current`. STOP does not wait for this loop — handleStopTune
                // runs the teardown itself so a dying cable cannot make the button look dead — and
                // that teardown calls disconnect(), which NULLS linkRef. So by the time an in-flight
                // poll settles and this finally runs, the ref is routinely already empty and an
                // optional call through it is a silent no-op. The captured object is still there.
                closeLogTiming(link, failure);
                onEnd?.(failure);
            }
        })();
    }, [clearError, closeLogTiming, setState, setError, settleIdle]);

    const stopTuning = useCallback(() => {
        pollingRef.current = false;
        settleIdle();
    }, [settleIdle]);

    /**
     * Settles which exchange list this car's next run will use, before the run starts.
     *
     * Only the VE profile has anything to settle: it reads the lambda trim out of four bytes of
     * master RAM rather than the 90-byte block that used to carry it, and that address comes from a
     * disassembly rather than from this ECU. About a second of checking at the kerb, against a whole
     * drive recorded from an address that might not be the one.
     *
     * Never throws and always answers with a usable list — a car that will not serve the RAM read is
     * a car that logs the slower way. The notice is surfaced rather than swallowed: "this ran the
     * old way" is exactly the fact somebody comparing two drives' rates needs.
     */
    const verifyLogProfile = useCallback(async (profile: LogProfile): Promise<{
        exchanges: LogExchange[]; proven: boolean; detail: string | null;
    }> => {
        const link = linkRef.current;
        if (!link?.verifyLambdaTrimSource) return { exchanges: profile.exchanges, proven: true, detail: null };
        try {
            const result = await link.verifyLambdaTrimSource(profile);
            if (!result) return { exchanges: profile.exchanges, proven: true, detail: null };
            if (!result.proven) {
                setWarningKind('warn');
                setWarning(result.detail);
            }
            return result;
        } catch {
            // The check itself failing is the same answer as the check failing: log the safe way.
            return { exchanges: profile.fallback ?? profile.exchanges, proven: false, detail: null };
        }
    }, []);

    /**
     * The inertia run: selection 3 plus one RAM read, per sample, until stopped.
     *
     * A sibling of startTuning rather than a mode of it, because the two produce different sample
     * types and answer different questions — a VE log has no torque, an inertia log has no exhaust
     * temperature or lambda trim, and neither can be used for the other's analysis. Keeping them
     * apart at the type level means a mismatched log is a compile error rather than a confident
     * wrong answer downstream.
     *
     * Shares `pollingRef` deliberately: both drive the same transport, so they must be mutually
     * exclusive, and one flag is the simplest thing that guarantees it. STOP stops whichever is
     * running.
     *
     * The timing instrument is armed here and closed on exit, which is the first time anything has
     * measured the datalog path on the wire — see `beginLogTiming`.
     */
    const startInertiaRun = useCallback((
        onSample: (sample: InertiaSample) => void,
        onEnd?: (failure: string | null) => void,
    ) => {
        const link = linkRef.current;
        if (!link) { onEnd?.('Not connected to DME'); return; }
        clearError();
        setState('tuning');
        pollingRef.current = true;
        // Named, not defaulted. Passing nothing used to mean "the EGAS block", which this run has not
        // read since block 83 turned out to be a latched fault frame — so every inertia timing report
        // sized its exchanges at 52 bytes for a sample that is block 3 plus a 40-byte RAM read.
        link.beginLogTiming?.(LOG_PROFILES.INERTIA.exchanges);

        (async () => {
            let failure: string | null = null;
            try {
                while (pollingRef.current && linkRef.current) {
                    try {
                        const sample = await linkRef.current.pollInertiaSample();
                        if (!pollingRef.current) break;
                        onSample(sample);
                    } catch (e) {
                        if (!pollingRef.current) break;
                        failure = e instanceof Error ? e.message : String(e);
                        setError(failure);
                        pollingRef.current = false;
                        settleIdle();
                        break;
                    }
                }
            } finally {
                // Closed on every exit including the failed one: a run that died part-way is the
                // most informative timing report there is, and discarding it would lose exactly the
                // case worth having. On the captured link rather than the ref — see closeLogTiming.
                closeLogTiming(link, failure);
                onEnd?.(failure);
            }
        })();
    }, [clearError, closeLogTiming, setState, setError, settleIdle]);

    /**
     * The idle dwell run.
     *
     * The extra reason is the decisive one: the VE filter DELETES the samples this run collects.
     * `processLogData` used to drop anything with `rawLoad <= 1.0 && rpm < idleRpm`, so a VE
     * log structurally cannot hold an idle dwell however it was recorded. Sharing the poll would
     * have produced a run whose output the rest of the pipeline throws away.
     *
     * Everything else mirrors the inertia run deliberately — the same `pollingRef`, the same
     * `beginLogTiming`/`closeLogTiming` pairing, the same rule that a run which died part-way still
     * files its timing report, because that is the report worth having.
     */
    const startIdleRun = useCallback((
        onSample: (sample: IdleSample) => void,
        onEnd?: (failure: string | null) => void,
        exchanges?: readonly LogExchange[],
    ) => {
        const link = linkRef.current;
        if (!link) { onEnd?.('Not connected to DME'); return; }
        clearError();
        setState('tuning');
        pollingRef.current = true;
        // The caller passes the list the truth gate settled on, so the timing report describes the
        // exchanges actually made rather than the ones the profile hoped for.
        link.beginLogTiming?.(exchanges ?? LOG_PROFILES.IDLE.exchanges);

        (async () => {
            let failure: string | null = null;
            try {
                while (pollingRef.current && linkRef.current) {
                    try {
                        const sample = await linkRef.current.pollIdleSample();
                        if (!pollingRef.current) break;
                        onSample(sample);
                    } catch (e) {
                        if (!pollingRef.current) break;
                        failure = e instanceof Error ? e.message : String(e);
                        setError(failure);
                        pollingRef.current = false;
                        settleIdle();
                        break;
                    }
                }
            } finally {
                closeLogTiming(link, failure);
                onEnd?.(failure);
            }
        })();
    }, [clearError, closeLogTiming, setState, setError, settleIdle]);

    /**
     * Asks the DME whether it will serve live RAM reads. **Read-only, two telegrams, ~100 ms.**
     *
     * Does NOT change `state`. Every other DS2 operation here takes the link somewhere — 'reading',
     * 'writing', 'resetting' — because they are long, or exclusive, or destructive; this is none of
     * those. Moving state for it would flicker the hub's buttons for a tenth of a second and, worse,
     * would make a probe look like a mode the user had entered rather than a question that was
     * asked. It shares the link's own gate, so it still cannot interleave with anything.
     *
     * Returns null when there is no link, rather than throwing: the caller is a UI that wants to
     * show "not connected", not to handle an exception.
     */
    const probeRam = useCallback(async (): Promise<RamProbeResult | null> => {
        const link = linkRef.current;
        if (!link) return null;
        try {
            return await link.probeRam();
        } catch (e) {
            // Only a bug in the request itself reaches here — probeRam reports a refusal as data.
            setError(e instanceof Error ? e.message : String(e));
            return null;
        }
    }, [setError]);

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
            settleIdle();
        }
    }, [clearError, failWith, setState, settleIdle]);

    const readAdaptations = useCallback(
        () => runAdaptationOp(link => link.readAdaptations()), [runAdaptationOp]);

    const resetAdaptations = useCallback(
        () => runAdaptationOp(link => link.clearTuneAdaptations()), [runAdaptationOp]);

    /** Folds a fresh counter reading into `identity`, so the header updates without a reconnect.
     *  Functional update: the reset takes minutes, and re-reading `identity` from this closure would
     *  write back whatever it held when the operation started. */
    const applyFlashCounter = useCallback((flashCounter: FlashCounterInfo) => {
        setIdentity(prev => (prev ? { ...prev, flashCounter } : prev));
    }, [setIdentity]);

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
            settleIdle();
        }
    }, [setState, settleIdle]);

    /**
     * The two CRCs the calibration currently in the ECU stores.
     *
     * Throws rather than returning null, unlike readEngineRpm above, and the difference matters:
     * that one is a precondition probe whose failure has a safe interpretation, while this one
     * exists to decide whether a flash would destroy someone else's work. "Could not tell" must
     * reach the caller as a failure it has to handle, not as a value it can compare — see
     * `checkLineage`, which turns the throw into a blocking `unknown` verdict.
     *
     * Two four-byte reads, so no 'reading' state and no progress: it is over before a spinner
     * would render.
     */
    const readDataChecksums = useCallback(async (): Promise<{ slave: number; master: number }> => {
        const link = linkRef.current;
        if (!link) throw new Error('Not connected to DME');
        return link.readDataChecksums();
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
            settleIdle();
            setTransferProgress(null);
            setTransferPhase(null);
        }
    }, [clearError, failWith, applyFlashCounter, setState, settleIdle]);

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
            settleIdle();
            setTransferProgress(null);
            setTransferPhase(null);
        }
    }, [clearError, failWith, setState, settleIdle]);

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
            settleIdle();
        }
    }, [clearError, failWith, applyFlashCounter, setState, settleIdle]);

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
            settleIdle();
            setTransferProgress(null);
            setTransferPhase(null);
        }
    }, [clearError, failWith, applyFlashCounter, setState, settleIdle]);

    /**
     * Flashes the tune. `verifyMode` is required by the link and is therefore required here — there
     * is deliberately no default at any layer, because a default would be this file quietly deciding
     * how strongly somebody's ECU was proven.
     *
     * Resolves to a `WriteOutcome` — the verification on success, the reason on failure. Not a
     * `WriteVerification | null`: the failure dialog is built after the await, and reading the reason
     * off the hook's `error` there reads the value from before the write, which is why every failed
     * write used to be reported as "unknown error".
     */
    const write = useCallback(async (buffer: ArrayBuffer, verifyMode: WriteVerifyMode, spotCheck?: SpotWindow[]): Promise<WriteOutcome> => {
        if (!linkRef.current) return { ok: false, error: 'Not connected to DME' };
        clearError();
        setState('writing');
        setTransferProgress(0);
        try {
            const verification = await linkRef.current.writePartialBin(buffer, { verifyMode, spotCheck }, makeThrottledProgress());
            settleIdle();
            return { ok: true, verification };
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
            settleIdle();
            return { ok: false, error: e instanceof Error ? e.message : String(e) };
        } finally {
            // Same rule as READ, and for a stronger reason: the write path's diagnostics exist mostly
            // for the runs that fail, on an ECU that has already been erased. Published on both paths,
            // published as null when there is nothing — never left showing the previous operation's.
            publishLast(linkRef.current);
            setTransferProgress(null);
            setTransferPhase(null);
        }
    }, [clearError, failWith, publishLast, setState, settleIdle]);

    return {
        state,
        mockMode,
        setMockMode,
        /** Read the link's CURRENT state from inside an async handler through this, never off the
         *  fields above — those are frozen at the render that built the handler. See DmeLinkSnapshot. */
        readLinkState,
        writeBaud,
        setWriteBaud,
        lastTransferTiming,
        lastEventLog,
        /** Read these, not the state above, from inside an async handler — see the refs' comment. */
        lastTransferTimingRef,
        lastEventLogRef,
        identity,
        error,
        errorKind,
        warning,
        warningKind,
        transferProgress,
        transferPhase,
        transportKind,
        fastReadArmed,
        connect,
        disconnect,
        read,
        cancelRead,
        startTuning,
        stopTuning,
        verifyLogProfile,
        startInertiaRun,
        startIdleRun,
        probeRam,
        write,
        readAdaptations,
        resetAdaptations,
        readFlashCounter,
        readServiceBlocks,
        getServiceBlockBytes,
        resetFlashCounter,
        restoreServiceBlock,
        readEngineRpm,
        readDataChecksums,
    };
}
