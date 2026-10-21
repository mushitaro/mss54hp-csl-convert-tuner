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
/** The name the owner gives this device ("ナビ"), so the assistant — and another device's tab —
 *  can say which device answers. Per device, like the switch. */
export const DEVICE_KEY = 'assistant-bridge:device';
const MAX_DEVICE_NAME = 24;

export function readDeviceName(): string | null {
    try { return localStorage.getItem(DEVICE_KEY)?.trim().slice(0, MAX_DEVICE_NAME) || null; } catch { return null; }
}

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
    const [device, setDeviceState] = useState<string | null>(null);
    useEffect(() => { if (allowed) setDeviceState(readDeviceName()); }, [allowed]);
    const clientRef = useRef<BridgeClient | null>(null);
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
            hello: () => ({ ...helloRef.current, tools: TOOL_NAMES, device: readDeviceName() }),
            onStatus: setStatus,
        });
        clientRef.current = client;
        client.start();
        return () => { client.stop(); clientRef.current = null; };
    }, [allowed, on]);

    const takeover = useCallback(() => { clientRef.current?.takeover(); }, []);
    // Saved as typed; the next hello carries it (a held or live tab says hello again on its next
    // socket, which a switch-here or the next reconnect opens).
    const setDevice = useCallback((name: string) => {
        if (!allowed) return;
        const clean = name.trim().slice(0, MAX_DEVICE_NAME);
        try { if (clean) localStorage.setItem(DEVICE_KEY, clean); else localStorage.removeItem(DEVICE_KEY); } catch { /* storage refused: the session still uses it */ }
        setDeviceState(clean || null);
    }, [allowed]);
    return { on, setOn, takeover, device, setDevice, status: on ? status : { state: 'off' as const, detail: null, calls: 0 } };
}
