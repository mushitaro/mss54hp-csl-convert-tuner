import { DmeLinkError } from './types';
import type { TransferTiming } from './transferTiming';
import { WebSerialTransport } from './webSerialTransport';
import { WebUsbFtdiTransport } from './webUsbFtdiTransport';

/**
 * The contract `webSerialTransport.ts` has always claimed to implement and never declared.
 *
 * Its header comment said it "mirrors the reference app's IByteTransport contract" while no such
 * TypeScript interface existed, so there was nothing stopping a second backend from drifting. There
 * is a second backend now — WebUSB, for Android — so the contract becomes real.
 *
 * Every member here is one the DS2 layer already calls. This is deliberately a description of the
 * existing surface, not a redesign of it: `WebSerialDmeLink` makes 21 transport calls and not one of
 * them changes.
 */
export interface ByteTransport {
    setTiming(timing: TransferTiming | null): void;
    open(): Promise<void>;
    close(): Promise<void>;
    reopen(baudRate: number): Promise<void>;
    write(bytes: Uint8Array): Promise<void>;
    /**
     * Synchronous by contract, and it must stay that way. `resyncTransport` calls it without
     * awaiting and `drainUntilQuiet` reads `bufferedLength()` straight afterwards expecting zero
     * (webSerialDmeLink.ts:1199-1230). Returning a promise here would silently change the shape of
     * code that was tuned against a real car.
     */
    purge(): void;
    bufferedLength(): number;
    hasReadError(): boolean;
    peekReadError(): Error | null;
    recoverRead(): Promise<void>;
    readExact(length: number, timeoutMs: number): Promise<Uint8Array>;
}

/**
 * Which backend can reach a DME here.
 *
 * 'none' is a real answer, not an error: the file-upload workflow stays fully usable without any
 * hardware transport, so this only gates the direct-DME features.
 */
export type TransportKind = 'web-serial' | 'web-usb-ftdi' | 'none';

/**
 * True on Android, which is the one platform where capability detection cannot decide for us.
 *
 * `userAgentData.platform` is Chromium's own structured answer and is not subject to the UA-string
 * freezing games; the regex is the fallback for engines that do not expose it.
 */
export function isAndroidPlatform(): boolean {
    if (typeof navigator === 'undefined') return false;
    const uaData = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
    if (uaData?.platform) return uaData.platform === 'Android';
    return /android/i.test(navigator.userAgent);
}

/**
 * Picks the backend for this browser.
 *
 * **This is the one place in the app that looks at the platform rather than at a capability, and it
 * has to.** Chrome for Android 138+ exposes `navigator.serial`, so `'serial' in navigator` is true
 * there — but it enumerates *only* Bluetooth RFCOMM serial-port emulation, and a USB K+DCAN cable
 * never appears in its picker. There is no feature test that separates "Web Serial that can see USB
 * adapters" from "Web Serial that can see only Bluetooth SPP": both objects are identical, and the
 * difference shows up as an empty chooser after the user has already tapped through a permission
 * prompt. So Android is asked by name and routed to WebUSB.
 *
 * `?transport=webusb` / `?transport=webserial` overrides the choice. It costs nothing on a static
 * export, and it is what lets the WebUSB path be driven from a desktop bench rig — which matters a
 * great deal when the alternative is testing a new byte transport for the first time in a car.
 */
export function detectTransportKind(): TransportKind {
    // Static prerender: neither API can exist, and answering 'none' here would bake an
    // "unsupported browser" notice into the exported HTML. Callers must resolve this after mount.
    if (typeof navigator === 'undefined' || typeof location === 'undefined') return 'none';

    const forced = new URLSearchParams(location.search).get('transport');
    if (forced === 'webusb') return WebUsbFtdiTransport.isSupported() ? 'web-usb-ftdi' : 'none';
    if (forced === 'webserial') return WebSerialTransport.isSupported() ? 'web-serial' : 'none';

    if (isAndroidPlatform()) return WebUsbFtdiTransport.isSupported() ? 'web-usb-ftdi' : 'none';
    return WebSerialTransport.isSupported() ? 'web-serial' : 'none';
}

/**
 * Builds the transport this browser can actually use.
 *
 * Detection happens here rather than being passed in, so the decision is made at connect time — a
 * phone that gains an OTG adapter between page load and the first tap does not need a reload.
 */
export function createDmeTransport(): ByteTransport {
    switch (detectTransportKind()) {
        case 'web-serial': return new WebSerialTransport();
        case 'web-usb-ftdi': return new WebUsbFtdiTransport();
        default: throw new DmeLinkError(
            'No serial transport is available in this browser. Chrome or Edge is required on desktop; ' +
            'on Android, Chrome with a USB OTG adapter.');
    }
}
