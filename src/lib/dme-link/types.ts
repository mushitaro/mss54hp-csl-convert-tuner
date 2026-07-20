import { AdaptationSnapshot } from './adaptationBlocks';

export type { AdaptationSnapshot };

export interface DmeIdentity {
    vin: string;
    aif: string;
    softwareVersion: string;
}

/** A single live-telemetry sample, using the same field names as LogDataPoint so it can feed
 * straight into the existing log-processing/VE-calculation pipeline. */
export interface LiveMeasurement {
    time: number;
    rpm: number;
    rawLoad: number;
    stft1: number;
    stft2: number;
    coolantTemp?: number;
}

/** Which stage a long transfer is in. Surfaced in the UI so a slow-but-working stage (notably the
 *  post-write read-back verification, which takes ~70s at 9600 baud) doesn't look like a freeze. */
export type TransferPhase = 'erasing' | 'reading' | 'writing' | 'verifying';

export type TransferProgress = (donePercent: number, phase?: TransferPhase) => void;

/** Abstraction the connection state machine (useDmeLink) depends on. Implemented by both
 * WebSerialDmeLink (real navigator.serial + DS2 protocol) and MockDmeLink (offline simulator). */
export interface DmeLink {
    connect(): Promise<DmeIdentity>;
    disconnect(): Promise<void>;
    readPartialBin(onProgress?: TransferProgress): Promise<ArrayBuffer>;
    writePartialBin(buffer: ArrayBuffer, onProgress?: TransferProgress): Promise<void>;
    pollLiveMeasurement(): Promise<LiveMeasurement>;
    /** Reads the DME's learned adaptation values (DS2 blocks 0x06 and 0x16). */
    readAdaptations(): Promise<AdaptationSnapshot>;
    /**
     * Clears the tune-relevant adaptations, waits for the DME to commit, and re-reads. Returns the
     * post-clear values.
     *
     * Takes no mask: which adaptations a tuning tool may clear is a product decision, not a caller's
     * (see TUNE_ADAPTATION_CLEAR in ds2.ts), so "clear all" is unreachable by construction. The
     * settle-then-re-read lives here because the wait is a property of the DME, not of the UI.
     */
    clearTuneAdaptations(): Promise<AdaptationSnapshot>;
    /** Requests cancellation of an in-progress readPartialBin. Safe to call any time; no-op if idle. */
    abort(): void;
}

export class DmeLinkError extends Error {
    constructor(message: string, public readonly cause?: unknown) {
        super(message);
        this.name = 'DmeLinkError';
    }
}
