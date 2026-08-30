'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { TuningSession } from '@/lib/db/schema';
import { markSessionSynced } from '@/lib/db/sessionRepository';
import type { SyncSettings } from '@/lib/session-sync/client';
import {
    EMPTY_SETTINGS, canSync, loadSyncSettings, needsSync, sessionFingerprint, syncSession,
} from '@/lib/session-sync/client';
import type { SyncStatus } from '@/lib/session-sync/status';
import type { UploadState } from '@/components/SessionList';

/**
 * The device's sync settings, read once.
 *
 * A module-level snapshot rather than component state, because the settings are a property of the
 * DEVICE — one `localStorage` key, over the token this build shipped with — and the app renders the
 * store panel twice, once on the SESSIONS tab and once inside the menu sheet. Each mount used to
 * re-read `localStorage` and publish upwards, so the value the uploader actually used was whichever
 * instance mounted last.
 *
 * Nothing writes it any more. The store panel's destination fields are gone (the store is a
 * development facility and the token is baked into the preview export), so the only way the value
 * changes is somebody editing `localStorage` by hand and reloading — which is exactly the case
 * `subscribeNever` describes, the same shape `useIsPreviewBuild` uses for the build variant.
 *
 * `useSyncExternalStore` also settles the prerender question the old effect was working around:
 * `getServerSnapshot` answers with the empty settings, so the static export and the hydrating
 * render agree, and the real value arrives on the first client read without a setState-in-effect
 * cascade.
 */
const subscribeNever = () => () => { };

/** Cached, not re-read: `getSnapshot` must return the same reference every call or React re-renders
 *  forever, and `loadSyncSettings` builds a fresh object. Lazily, because it touches localStorage,
 *  which does not exist during the static prerender. */
let cachedSettings: SyncSettings | null = null;
const readSettings = (): SyncSettings => (cachedSettings ??= loadSyncSettings());
const serverSettings = (): SyncSettings => EMPTY_SETTINGS;

/**
 * Sending sessions to the deployment's store, and what the controls that do it say.
 *
 * There are three of those controls — the desktop session bar, the mobile menu row, and the send
 * inside the store panel — and they must not be able to disagree. `session-sync/status.ts` already
 * guarantees that for the wording; this guarantees it for the state behind the wording, which used
 * to be six pieces of `useState` in the middle of a 4,000-line component.
 *
 * `uploadState` is per session id because "did that land?" is a question about one row, not about
 * the app. `busy`/`error` are the app-level half, for the one control that acts on all of them at
 * once.
 */
export function useSessionSync(input: {
    sessions: TuningSession[];
    /** Re-reads the local database after a sync, so a row's synced state reflects the record. */
    refresh: () => Promise<unknown> | unknown;
    /** Whether this build has an `/api` behind it at all. See `status` below. */
    isPreviewBuild: boolean;
    /** From `useOnline`. Reliable in the negative direction only, which is why it outranks the
     *  error but nothing outranks it. */
    online: boolean;
}) {
    const { sessions, refresh, isPreviewBuild, online } = input;

    /**
     * Read through the module snapshot, so every mount of the panel sees the same settings.
     *
     * Read here rather than only in the store panel: the panel lives on the SESSIONS tab, so
     * waiting for it to mount would leave the menu's sync row reading "not set up" until somebody
     * happened to open that tab — a control lying about the app's state because of where a
     * different component is.
     */
    const settings = useSyncExternalStore(subscribeNever, readSettings, serverSettings);

    const [uploadState, setUploadState] = useState<Record<string, UploadState>>({});
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    /**
     * Kept in a ref as well as in state, because the diagnostics uploader runs from inside async
     * handlers created several renders ago and would otherwise close over an empty token — which is
     * the failure that looks exactly like "the store is not configured".
     *
     * Written in an effect rather than during render. Assigning to a ref while rendering is what the
     * page did, and it is a real hazard rather than a lint preference: React may render a component
     * it then discards, so a value can land in the ref that never became the committed state. After
     * commit is also early enough — nothing can read this before the user has had a chance to touch
     * anything.
     */
    const settingsRef = useRef(settings);
    useEffect(() => { settingsRef.current = settings; }, [settings]);

    /**
     * Sends a whole session to the store, and says on the row whether it landed.
     *
     * The session goes as the local database holds it — the record, its log and its binaries — so it
     * can come back the same way. It syncs under its own id, which is what makes a retry after a
     * dropped connection replace rather than duplicate; a phone in a garage drops uploads often
     * enough that this is the normal path, not the exceptional one. Nothing local is touched.
     */
    const syncOne = useCallback(async (session: TuningSession): Promise<string | null> => {
        // Taken BEFORE the upload, not after. A run that finishes recording while a slow upload is
        // in flight must leave the session outstanding — see markSessionSynced.
        const fingerprint = sessionFingerprint(session);
        setUploadState(prev => ({ ...prev, [session.id]: 'busy' }));
        try {
            await syncSession(session, settingsRef.current);
            await markSessionSynced(session.id, fingerprint);
            setUploadState(prev => ({ ...prev, [session.id]: 'done' }));
            return null;
        } catch (e) {
            // Kept on the row rather than raised in an alert: an alert has to be dismissed before
            // the driver can retry, and the message is most useful next to the thing that failed.
            const message = (e as Error).message;
            setUploadState(prev => ({ ...prev, [session.id]: { error: message } }));
            return message;
        }
    }, []);

    /** One row's send, from the session list. */
    const syncSessionRow = useCallback(async (session: TuningSession) => {
        await syncOne(session);
        await refresh();   // the row's synced state is now on the record
    }, [syncOne, refresh]);

    /** Sessions worth sending that are not up there as they now stand. Also what the menu's sync row
     *  counts, so the number on the button and the rows it would act on are the same list. */
    const pending = useMemo(() => sessions.filter(needsSync), [sessions]);

    /**
     * Sends everything outstanding, one at a time.
     *
     * Sequential rather than `Promise.all`. Each session carries its BASE and TUNED images — around
     * 128 KB before gzip, and the API caps a part at 900 KB — so this is a handful of large uploads
     * over whatever signal a garage has, not a fan-out that finishes sooner for being parallel. It
     * also means a failure is attributable: the row that failed is the one that stopped, and the
     * rest still went.
     *
     * Nothing is skipped on failure. A phone that loses signal for one session usually has it back
     * for the next, and stopping the loop would strand later sessions behind an earlier one's bad
     * luck. The count of failures is what the button reports.
     */
    const syncAll = useCallback(async () => {
        const outstanding = pending;
        // Cleared before the early return, not after it, and that order is the whole point.
        //
        // The control reads "Sync failed — retry" and is pressable while an error is held. If
        // nothing is outstanding by then — the session that failed was deleted, or the upload
        // landed and only the response was lost, so its fingerprint now matches the stored copy —
        // this returned here without touching the error. The cell stayed red for ever, and the
        // retry it offered did nothing at all, silently. Pressing it is the user saying "again",
        // and the honest answer when there is nothing left to send is `clean`, not a failure with
        // no way out of it.
        setError(null);
        if (!outstanding.length) return;
        setBusy(true);
        const failures: string[] = [];
        for (const session of outstanding) {
            const failure = await syncOne(session);
            if (failure) failures.push(failure);
        }
        await refresh();
        setBusy(false);
        // The first message, with a count — not all of them concatenated. A dropped connection
        // produces N copies of one sentence, and the button has one line to say it in.
        setError(failures.length
            ? `${failures[0]}${failures.length > 1 ? ` (and ${failures.length - 1} more)` : ''}`
            : null);
    }, [pending, syncOne, refresh]);

    /**
     * What the sync controls say, or null when this build has no store behind them.
     *
     * Null on production, and that is not a styling choice. Production is served statically from
     * GitHub Pages: there are no Pages Functions, no D1 and no `/api` at any path. A permanently
     * greyed "Sync — not set up" row there would describe a feature that build does not contain,
     * and the honest rendering of a feature that does not exist is nothing at all.
     *
     * Keyed on the preview marker rather than on having a token, because those come from the same
     * build step and the marker is the one that means "this deployment has functions". A preview
     * whose token failed to embed still shows the row, saying `unavailable` — which is exactly the
     * case somebody needs to be told about rather than shielded from.
     */
    const status: SyncStatus | null = useMemo(() => !isPreviewBuild ? null : ({
        phase: !canSync(settings) ? 'unavailable'
            : busy ? 'busy'
                // Offline outranks the error: "no network" is the actionable half of a failure that
                // happened because there was no network, and it is the one that says what to do
                // about it.
                : !online ? 'offline'
                    : error ? 'error'
                        : pending.length > 0 ? 'ready'
                            : 'clean',
        pending: pending.length,
        error: error ?? undefined,
    }), [isPreviewBuild, settings, busy, online, error, pending.length]);

    return {
        settings, settingsRef,
        uploadState, pending, status,
        syncOne, syncSessionRow, syncAll,
    };
}
