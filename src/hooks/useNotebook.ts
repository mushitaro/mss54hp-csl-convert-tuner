import { useCallback, useEffect, useMemo, useState } from 'react';
import type { NotebookAuthor, NotebookBody, NotebookEntry } from '@/lib/notebook/rules';
import { sessionEntries } from '@/lib/notebook/store';

/**
 * The open session's notebook, as the screen reads it, and the one way the screen writes to it.
 *
 * Reads from this device's copy (store.ts); what the store adds arrives by the pulls on open and on
 * SYNC, which bump `refreshKey`. Writes go through `write` — useSessionDb's `writeNotebook` — so a
 * screen entry marks the session outstanding exactly as an assistant's does.
 *
 * `enabled` is the feature gate: a production build never reads, so it never opens the database.
 */
export function useNotebook(
    sessionId: string | null,
    enabled: boolean,
    write: (sessionId: string, entries: NotebookEntry[]) => Promise<NotebookEntry[]>,
    refreshKey: string,
) {
    const [rev, setRev] = useState(0);
    const reload = useCallback(() => setRev(r => r + 1), []);

    // Keyed by the session it was read for, so switching sessions shows nothing of the old one while
    // the new one loads — derived, rather than cleared by a setState in the effect.
    const key = enabled && sessionId ? sessionId : '';
    const [loaded, setLoaded] = useState<{ key: string; entries: NotebookEntry[] }>({ key: '', entries: [] });
    useEffect(() => {
        if (!key) return;
        let live = true;
        sessionEntries(key)
            .then(e => { if (live) setLoaded({ key, entries: e }); })
            .catch(() => { if (live) setLoaded({ key, entries: [] }); });
        return () => { live = false; };
    }, [key, rev, refreshKey]);
    const entries = useMemo(() => (key && loaded.key === key ? loaded.entries : []), [key, loaded]);

    /**
     * Adds entries to the open session's notebook. Throws the rule's own sentence when one is
     * refused (rules.ts), for the caller to show where it was typed.
     */
    const add = useCallback(async (items: { by: NotebookAuthor; body: NotebookBody }[]) => {
        if (!enabled || !sessionId) throw new Error('No session is open.');
        const now = Date.now();
        const made: NotebookEntry[] = items.map((x, i) => ({
            id: crypto.randomUUID(), sessionId, at: now + i, by: x.by, body: x.body,
        }));
        const added = await write(sessionId, made);
        reload();
        return added;
    }, [enabled, sessionId, write, reload]);

    return { entries, reload, add };
}
