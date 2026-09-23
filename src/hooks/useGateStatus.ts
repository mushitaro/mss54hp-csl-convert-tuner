'use client';

import { useEffect, useState } from 'react';
import { gateStatus, type GateState } from '@/lib/session-sync/owner-sync';
import { onGateExpired } from '@/lib/session-sync/client';
import { flushDiagnostics } from '@/lib/session-sync/diagnostics';

export interface GateInfo {
    state: GateState;
    /** The account the preview is signed in as, e.g. `#A1B2` — what the SYNC panel names as the
     *  destination. Null until the gate has said. */
    label: string | null;
}

const UNKNOWN: GateInfo = { state: 'unknown', label: null };

/**
 * Where this browser stands with the owner gate: signed in (and as whom), signed out, or unknown.
 *
 * Asked on mount, when the tab comes back, and when the device comes back online — and told at once
 * when any store request is answered 401, so the SIGN IN chip appears the moment a sync finds out
 * rather than on the next check. `unknown` (offline, m3 unreachable) is deliberately not `expired`:
 * the app keeps working and offers nothing, rather than sending somebody into a sign-in round trip
 * that cannot complete from a garage.
 *
 * `enabled` is the preview marker. Production and staging have no gate and make no request here.
 *
 * A signed-in answer is also the moment the route is known to be open, so diagnostics kept while
 * signed out or offline are sent then — after a re-sign-in the page reloads, and this is the first
 * thing that runs.
 */
export function useGateStatus(enabled: boolean): GateInfo {
    const [info, setInfo] = useState<GateInfo>(UNKNOWN);

    useEffect(() => {
        if (!enabled) return;
        let alive = true;
        const check = () => {
            void gateStatus().then(s => {
                if (!alive) return;
                setInfo(s);
                if (s.state === 'active') void flushDiagnostics();
            });
        };
        check();
        const onShow = () => { if (document.visibilityState === 'visible') check(); };
        document.addEventListener('visibilitychange', onShow);
        window.addEventListener('online', check);
        const off = onGateExpired(() => setInfo(prev => ({ state: 'expired', label: prev.label })));
        return () => {
            alive = false;
            document.removeEventListener('visibilitychange', onShow);
            window.removeEventListener('online', check);
            off();
        };
    }, [enabled]);

    return enabled ? info : UNKNOWN;
}
