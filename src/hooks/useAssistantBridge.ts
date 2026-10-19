'use client';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { BridgeClient, type BridgeStatus } from '@/lib/bridge/bridgeClient';
import { bridgeHandlers, TOOL_NAMES, type TabFacade } from '@/lib/bridge/tools';

/**
 * ASSISTANT — whether the owner's assistant can reach this tab, and how that is going.
 *
 * Off until the owner switches it on, on this device. Remembered per device (localStorage), because
 * the device this exists for is a head unit that cold-boots with every key cycle: an owner who turned
 * it on there should not have to find the switch again before each drive.
 *
 * `allowed` is the WORKS build with its first-run notice confirmed — the same two conditions every
 * send in this build waits on (`maySend` in session-sync). Not allowed means not even read: the
 * production build writes and reads no key its privacy policy does not name.
 *
 * The facade is the page's, rebuilt every render; the client reads the newest one when a call
 * arrives, so the socket is never reopened because the page re-rendered.
 */
export const ASSISTANT_KEY = 'assistant-bridge:v1';

/** This page's answer when storage refuses, so a switch still works for the session. */
let memoryOn: boolean | null = null;
const listeners = new Set<() => void>();
const subscribe = (cb: () => void) => {
    listeners.add(cb);
    return () => { listeners.delete(cb); };
};

const readOn = (): boolean => {
    if (memoryOn !== null) return memoryOn;
    try { return localStorage.getItem(ASSISTANT_KEY) === 'on'; } catch { return false; }
};

export function useAssistantBridge(input: {
    allowed: boolean;
    facade: TabFacade;
    hello: { build: string | null; variant: string | null };
}) {
    const { allowed, facade, hello } = input;
    // A store rather than state set from an effect: read only while allowed, never during the
    // prerender (the server snapshot is "off"), and every mount agrees.
    const getSnapshot = useCallback(() => allowed && readOn(), [allowed]);
    const on = useSyncExternalStore(subscribe, getSnapshot, () => false);
    const [status, setStatus] = useState<BridgeStatus>({ state: 'off', detail: null, calls: 0 });
    const facadeRef = useRef(facade);
    const helloRef = useRef(hello);
    useEffect(() => {
        facadeRef.current = facade;
        helloRef.current = hello;
    });

    const setOn = useCallback((next: boolean) => {
        if (!allowed) return;
        try {
            if (next) localStorage.setItem(ASSISTANT_KEY, 'on'); else localStorage.removeItem(ASSISTANT_KEY);
            memoryOn = null;
        } catch {
            memoryOn = next;
        }
        for (const cb of listeners) cb();
    }, [allowed]);

    useEffect(() => {
        if (!allowed || !on) return;
        const client = new BridgeClient({
            ticketUrl: '/api/bridge/ticket',
            handlers: () => bridgeHandlers(facadeRef.current),
            hello: () => ({ ...helloRef.current, tools: TOOL_NAMES }),
            onStatus: setStatus,
        });
        client.start();
        return () => client.stop();
    }, [allowed, on]);

    return { on, setOn, status: on ? status : { state: 'off' as const, detail: null, calls: 0 } };
}
