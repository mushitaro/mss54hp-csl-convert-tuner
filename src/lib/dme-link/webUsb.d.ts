// Minimal ambient types for the WebUSB API (not part of TypeScript's default DOM lib).
// Covers only what this app uses — same approach as webSerial.d.ts, and for the same reason: a
// types package would be a dependency carrying far more surface than the handful of calls the FTDI
// transport makes.

interface USBEndpoint {
    readonly endpointNumber: number;
    readonly direction: 'in' | 'out';
    readonly type: 'bulk' | 'interrupt' | 'isochronous';
    readonly packetSize: number;
}

interface USBAlternateInterface {
    readonly alternateSetting: number;
    readonly interfaceClass: number;
    readonly endpoints: USBEndpoint[];
}

interface USBInterface {
    readonly interfaceNumber: number;
    readonly alternate: USBAlternateInterface;
    readonly alternates: USBAlternateInterface[];
    readonly claimed: boolean;
}

interface USBConfiguration {
    readonly configurationValue: number;
    readonly interfaces: USBInterface[];
}

interface USBControlTransferParameters {
    requestType: 'standard' | 'class' | 'vendor';
    recipient: 'device' | 'interface' | 'endpoint' | 'other';
    request: number;
    value: number;
    index: number;
}

type USBTransferStatus = 'ok' | 'stall' | 'babble';

interface USBInTransferResult {
    readonly data?: DataView;
    readonly status?: USBTransferStatus;
}

interface USBOutTransferResult {
    readonly bytesWritten: number;
    readonly status?: USBTransferStatus;
}

interface USBDevice {
    readonly vendorId: number;
    readonly productId: number;
    /** bcdDevice high byte — libftdi's own way of telling FT232R (6) from FT232BM (4), 232H (9), etc. */
    readonly deviceVersionMajor: number;
    readonly deviceVersionMinor: number;
    readonly manufacturerName?: string;
    readonly productName?: string;
    readonly serialNumber?: string;
    readonly opened: boolean;
    readonly configuration: USBConfiguration | null;
    readonly configurations: USBConfiguration[];
    open(): Promise<void>;
    close(): Promise<void>;
    selectConfiguration(configurationValue: number): Promise<void>;
    claimInterface(interfaceNumber: number): Promise<void>;
    releaseInterface(interfaceNumber: number): Promise<void>;
    controlTransferIn(setup: USBControlTransferParameters, length: number): Promise<USBInTransferResult>;
    // ArrayBufferView rather than BufferSource: TypeScript 5.7 made typed arrays generic over their
    // backing buffer, so a plain Uint8Array is Uint8Array<ArrayBufferLike> and no longer assignable
    // to BufferSource. The spec accepts any view; this says so without forcing casts at call sites.
    controlTransferOut(setup: USBControlTransferParameters, data?: ArrayBufferView | ArrayBuffer): Promise<USBOutTransferResult>;
    transferIn(endpointNumber: number, length: number): Promise<USBInTransferResult>;
    transferOut(endpointNumber: number, data: ArrayBufferView | ArrayBuffer): Promise<USBOutTransferResult>;
    clearHalt(direction: 'in' | 'out', endpointNumber: number): Promise<void>;
    reset(): Promise<void>;
}

interface USBConnectionEvent extends Event {
    readonly device: USBDevice;
}

interface USBDeviceFilter {
    vendorId?: number;
    productId?: number;
    classCode?: number;
}

interface USB extends EventTarget {
    getDevices(): Promise<USBDevice[]>;
    requestDevice(options: { filters: USBDeviceFilter[] }): Promise<USBDevice>;
    addEventListener(
        type: 'connect' | 'disconnect',
        listener: (event: USBConnectionEvent) => void,
        options?: boolean | AddEventListenerOptions,
    ): void;
    removeEventListener(
        type: 'connect' | 'disconnect',
        listener: (event: USBConnectionEvent) => void,
        options?: boolean | EventListenerOptions,
    ): void;
}

interface Navigator {
    usb?: USB;
}

interface WakeLockSentinel extends EventTarget {
    readonly released: boolean;
    readonly type: 'screen';
    release(): Promise<void>;
}

interface WakeLock {
    request(type: 'screen'): Promise<WakeLockSentinel>;
}

interface Navigator {
    wakeLock?: WakeLock;
}
