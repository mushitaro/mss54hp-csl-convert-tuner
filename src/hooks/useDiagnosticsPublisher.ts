'use client';

import { useCallback, useEffect, useState } from 'react';
import type { RefObject } from 'react';
import type { DmeLinkSnapshot } from '@/hooks/useDmeLink';
import type { TransferTimingReport } from '@/lib/dme-link/transferTiming';
import type { LinkEventLogSnapshot } from '@/lib/dme-link/linkEventLog';
import type { SyncSettings } from '@/lib/session-sync/client';
import { buildIdentity } from '@/lib/session-sync/client';
import type { DiagnosticRecord } from '@/lib/session-sync/diagnostics';
import { uploadDiagnostic } from '@/lib/session-sync/diagnostics';

/**
 * Whether the last operation's diagnostic record reached the store.
 *
 * Shown next to TIMING. The upload has always been best-effort and silent, which is right for not
 * disturbing a flash — and wrong for ever finding out it is not working. Two vehicle sessions were
 * spent believing records were being sent; they were, but for the previous run each time, and the
 * only way to discover either fact was to query D1 from a laptop.
 */
export type DiagUploadState =
    | { state: 'idle' } | { state: 'none' } | { state: 'sending' }
    | { state: 'stored'; bytes: number }
    | { state: 'failed'; reason: string };

/**
 * Building and sending the record for the last instrumented operation.
 *
 * ## Everything here is read through a ref or a getter, and that is the point
 *
 * This runs from inside the operation's own async handler — after a two-minute read, after a flash,
 * from the `onEnd` of a poll loop that has been running since the car left the driveway. Handlers
 * are built during render and capture that render's values, so anything read as a plain variable
 * here describes the moment the handler was CREATED, not the moment the operation ended.
 *
 * That was not a theoretical risk. `startInertiaRunWithDiagnostics` is memoised on a dep that never
 * changes, so it is built once on the very first render — before connect, before any session exists
 * — and every inertia record it filed carried a null VIN, a null transport and no session id. The
 * write-failure dialog had the same shape of bug from the other end: it read the link's `error`
 * after the await and got the value from before the write, so every real failure was reported as
 * "unknown error".
 *
 * `readLinkState()` is the fix for the link half (its setters keep a snapshot synchronously, which
 * an effect could not do — a handler resumes from `await` long before React commits), and
 * `sessionIdRef` for the workspace half, where an effect IS early enough: the session changes by a
 * user action, minutes before a run ends.
 */
export function useDiagnosticsPublisher(input: {
    readLinkState: () => DmeLinkSnapshot;
    lastTransferTimingRef: RefObject<TransferTimingReport | null>;
    lastEventLogRef: RefObject<LinkEventLogSnapshot | null>;
    /** The session the operation ran under, at the moment it ended. */
    sessionIdRef: RefObject<string | null>;
    /** The device's sync settings, from `useSessionSync` — same reason it is a ref there. */
    settingsRef: RefObject<SyncSettings>;
}) {
    const { readLinkState, lastTransferTimingRef, lastEventLogRef, sessionIdRef, settingsRef } = input;

    /** Which build this is, for the menu and for every uploaded record. Resolved after mount: the
     *  meta tag exists in the export but `document` does not during the static prerender. */
    const [buildLabel, setBuildLabel] = useState<string | undefined>(undefined);
    useEffect(() => { void buildIdentity().then(setBuildLabel); }, []);

    const [diagUpload, setDiagUpload] = useState<DiagUploadState>({ state: 'idle' });

    /**
     * Builds the diagnostic record for the last instrumented operation: the numbers, the narrative,
     * and enough context to place both.
     *
     * One shape, used by the download button and by the upload — so a record read out of the store at
     * a desk and a file saved on a phone are the same thing, and neither can quietly carry less.
     */
    const buildRecord = useCallback((kind: DiagnosticRecord['kind']): DiagnosticRecord | null => {
        const link = readLinkState();
        const report = lastTransferTimingRef.current;
        const events = lastEventLogRef.current;
        // A record with no report is still worth having when something went wrong — the timing window
        // opens after the login and after the baud switch, so a refused login or a switch the DME
        // accepts and then goes silent on produces no report at all. Those are the failures most worth
        // reading, and returning early on a missing report is what made them the ones that left no
        // trace. Nothing at all is published only when there is genuinely nothing: no report, no
        // events, and no error.
        if (!report && !events && !link.error) return null;
        return {
            id: crypto.randomUUID(),
            // From the caller, not from the report: there may not be one, and a record that cannot say
            // which operation it describes is not a record.
            kind,
            createdAt: Date.now(),
            completed: report?.completed ?? false,
            // `??` chains past null, and `report.error` is null on a SUCCESSFUL run — so the fallback
            // below fired on every clean read and stamped it "failed before the instrument was armed"
            // beside completed=1. Caught in the store, where a 538-exchange 126.7 s success was carrying
            // that sentence. The fallback belongs to the no-report case only.
            error: report ? report.error : (link.error ?? 'failed before the instrument was armed'),
            // Which car, which bytes, which transport. A timing report without these is a column of
            // numbers that cannot be compared against any other run — and comparing runs is the only
            // thing any of this is for.
            vin: link.identity?.vin ?? null,
            softwareVersion: link.identity?.softwareVersion ?? null,
            transport: link.transportKind,
            mock: link.mockMode,
            sessionId: sessionIdRef.current,
            report,
            events,
        };
    }, [readLinkState, lastTransferTimingRef, lastEventLogRef, sessionIdRef]);

    /**
     * Uploads the last operation's diagnostics, best-effort and silent.
     *
     * Fire-and-forget by design: it is called from paths that have just finished a read, a write or a
     * datalog. An upload that could reject there would either surface as an unhandled rejection or
     * replace the operation's own error with a networking one — and the operation's own error is the
     * thing being diagnosed. `uploadDiagnostic` never throws; this `void` is belt and braces.
     */
    const publish = useCallback((kind: DiagnosticRecord['kind']) => {
        // Wrapped, because this runs on the line after a read or a flash and NOTHING it does may take
        // that handler down. It threw once in a way that could only present as "the marker never
        // appeared": buildRecord touches half a dozen fields off the link, and an exception here would
        // abort handleDmeRead before any state was set, leaving the UI in exactly the state it was in
        // before the operation. A reporting path that can fail silently is the bug this whole feature
        // exists to stop, so it is not allowed to have one itself.
        try {
            const record = buildRecord(kind);
            if (!record) { setDiagUpload({ state: 'none' }); return; }
            setDiagUpload({ state: 'sending' });
            void uploadDiagnostic(record, settingsRef.current).then(r => {
                setDiagUpload(r.ok ? { state: 'stored', bytes: r.bytes } : { state: 'failed', reason: r.reason });
            });
        } catch (e) {
            setDiagUpload({ state: 'failed', reason: `could not build the record: ${e instanceof Error ? e.message : String(e)}` });
        }
    }, [buildRecord, settingsRef]);

    return { buildLabel, diagUpload, buildRecord, publish };
}
