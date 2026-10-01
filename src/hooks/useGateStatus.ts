'use client';

import { useCallback, useEffect, useState } from 'react';
import { gateStatus, type GateState } from '@/lib/session-sync/owner-sync';
import { onGateState } from '@/lib/session-sync/client';
import { flushDiagnostics } from '@/lib/session-sync/diagnostics';
import { subscribePreviewNotice } from '@/lib/session-sync/preview-notice';

export interface GateInfo {
    /** `checking` until the gate has answered once on this page. Not a verdict, so nothing reads it
     *  as one: `unknown` is the gate's answer that it could not confirm anybody, and the SYNC control
     *  says so — the first half-second of every load must not. */
    state: GateState | 'checking';
    /** The account the preview is signed in as, e.g. `#A1B2` — what the SYNC panel names as the
     *  destination. Null until the gate has said. */
    label: string | null;
}

const UNKNOWN: GateInfo = { state: 'unknown', label: null };
const CHECKING: GateInfo = { state: 'checking', label: null };

/**
 * Where this browser stands with the owner gate: signed in (and as whom), signed out, or unknown.
 *
 * Asked on mount, when the tab comes back, when the device comes back online, and by every SYNC
 * press (`recheck`) — and told at once when a store request is answered 401 or 503, so the control
 * changes the moment a sync finds out rather than on the next check. `unknown` (m3 unreachable, or
 * the gate unable to ask it) is deliberately not `expired`: the app keeps working and offers no
 * sign-in round trip that cannot complete from a garage — but SYNC says the store is unreachable
 * rather than offering a send that cannot land.
 *
 * `enabled` is the preview marker. Production and staging have no gate and make no request here.
 *
 * A signed-in answer is also the moment the route is known to be open, so diagnostics kept while
 * signed out or offline are sent then — after a re-sign-in the page reloads, and this is the first
 * thing that runs.
 *
 * Except before the preview's notice is confirmed: that flush sends nothing until then
 * (flushDiagnostics). So confirming it is one more moment to ask — whatever waited goes right away,
 * rather than the next time the tab comes back.
 */
export function useGateStatus(enabled: boolean): GateInfo & { recheck: () => Promise<GateInfo> } {
    const [info, setInfo] = useState<GateInfo>(CHECKING);

    /** Asks the gate now, and keeps the answer. */
    const recheck = useCallback(async (): Promise<GateInfo> => {
        const s = await gateStatus();
        setInfo(s);
        if (s.state === 'active') void flushDiagnostics();
        return s;
    }, []);

    useEffect(() => {
        if (!enabled) return;
        const check = () => { void recheck(); };
        check();
        const onShow = () => { if (document.visibilityState === 'visible') check(); };
        document.addEventListener('visibilitychange', onShow);
        window.addEventListener('online', check);
        const off = onGateState(state => setInfo(prev => ({ state, label: prev.label })));
        const offNotice = subscribePreviewNotice(check);
        return () => {
            document.removeEventListener('visibilitychange', onShow);
            window.removeEventListener('online', check);
            off();
            offNotice();
        };
    }, [enabled, recheck]);

    return { ...(enabled ? info : UNKNOWN), recheck };
}
