import { DmeLink, DmeIdentity, LiveMeasurement, TransferProgress, DmeLinkError } from './types';
import {
    AdaptationSnapshot, AdaptationReading, AdaptationFieldDef,
    STANDARD_ADAPTATIONS_BLOCK, OBSERVATION_ADAPTATIONS_BLOCK,
} from './adaptationBlocks';

const PARTIAL_BIN_LENGTH = 65536;
const CHUNK_SIZE = 122; // matches the reference implementation's DS2 chunk size
const ADAPT_SETTLE_MS = 2000; // the real link's post-clear wait — kept so the UI's spinner is real offline

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

const ADAPTATION_FIELDS: AdaptationFieldDef[] = [
    ...STANDARD_ADAPTATIONS_BLOCK.fields,
    ...OBSERVATION_ADAPTATIONS_BLOCK.fields,
];

/**
 * A DME that has plausibly learned something, in decoded engineering units. Values are made up but
 * shaped like real ones: the two lambda factors straddle their 1.0 neutral, the offsets are small
 * and opposite-signed, and knock adaptation is negative on every cylinder because it only ever
 * retards. Picked so a mock reset visibly changes all twelve rows.
 */
const MOCK_LEARNED_VALUES: Record<string, number> = {
    laa_f1: 1.031,
    laa_f2: 0.968,
    laa_offset1: 0.084,
    laa_offset2: -0.062,
    evan1_adap: -1.2,
    avan1_adap: 0.8,
    'ka_adap_tz[0]': -0.8,
    'ka_adap_tz[1]': -1.5,
    'ka_adap_tz[2]': -2.4,
    'ka_adap_tz[3]': -1.1,
    'ka_adap_tz[4]': -0.9,
    'ka_adap_tz[5]': -1.8,
};

function buildPlaceholderBin(): ArrayBuffer {
    // A plausible-looking (but not real) 65536-byte partial BIN, so the app has something
    // sensible to parse when no real/stock BIN has been supplied to the mock.
    const buf = new Uint8Array(PARTIAL_BIN_LENGTH);
    const view = new DataView(buf.buffer);
    for (let row = 0; row < 24; row++) {
        for (let col = 0; col < 20; col++) {
            const offset = 0xD356 + (row * 20 + col) * 2;
            view.setUint16(offset, 500 + row * 10 + col, false);
        }
    }
    return buf.buffer;
}

/**
 * In-memory DME simulator for offline testing of the connection state machine and live-tuning
 * UI without any real cable or vehicle. Mirrors DmeLink's behavior/timing at a high level rather
 * than round-tripping through byte-level DS2 frames (those are validated separately in ds2.ts).
 */
export class MockDmeLink implements DmeLink {
    private buffer: ArrayBuffer;
    private connected = false;
    private measurementStartTime = 0;
    private aborted = false;
    /** The simulated DME's learned state, in decoded units, keyed by field symbol. Modelling the
     *  state (rather than scripting a before/after pair) means a mock reset is a real state change:
     *  read it twice and it stays cleared, exactly like the car. */
    private adaptations = new Map<string, number>();

    abort(): void {
        this.aborted = true;
    }

    constructor(initialBuffer?: ArrayBuffer) {
        if (initialBuffer && initialBuffer.byteLength !== PARTIAL_BIN_LENGTH) {
            throw new DmeLinkError(`Mock DME expects a ${PARTIAL_BIN_LENGTH}-byte partial BIN, got ${initialBuffer.byteLength} bytes`);
        }
        this.buffer = initialBuffer ? initialBuffer.slice(0) : buildPlaceholderBin();
    }

    async connect(): Promise<DmeIdentity> {
        await delay(400); // simulate handshake latency
        this.connected = true;
        this.measurementStartTime = performance.now();
        // A reconnect is an ignition cycle, not a factory reset — but the mock has no engine to
        // re-learn from, so seed the learned state fresh each time. That keeps RESET ADAPT worth
        // pressing on every mock session.
        this.adaptations = new Map(Object.entries(MOCK_LEARNED_VALUES));
        return {
            vin: 'MOCKVIN0000000001',
            aif: 'MOCK-0401-PD31',
            softwareVersion: 'MOCK-SIM-1.0',
        };
    }

    async disconnect(): Promise<void> {
        this.connected = false;
    }

    private assertConnected() {
        if (!this.connected) throw new DmeLinkError('Mock DME is not connected');
    }

    async readPartialBin(onProgress?: TransferProgress): Promise<ArrayBuffer> {
        this.assertConnected();
        this.aborted = false;
        const total = this.buffer.byteLength;
        for (let read = 0; read < total; read += CHUNK_SIZE) {
            if (this.aborted) throw new DmeLinkError('Read cancelled');
            await delay(2);
            onProgress?.(Math.min(100, Math.round(((read + CHUNK_SIZE) / total) * 100)), 'reading');
        }
        onProgress?.(100, 'reading');
        return this.buffer.slice(0);
    }

    /** Mirrors the real write's stages (erase → write → read-back verify) so the mock is a faithful
     *  preview of the UI, including the phase labels and the 70/30 progress split. */
    async writePartialBin(buffer: ArrayBuffer, onProgress?: TransferProgress): Promise<void> {
        this.assertConnected();
        if (buffer.byteLength !== PARTIAL_BIN_LENGTH) {
            throw new DmeLinkError(`Refusing to write a ${buffer.byteLength}-byte buffer (expected ${PARTIAL_BIN_LENGTH})`);
        }
        const total = buffer.byteLength;

        onProgress?.(0, 'erasing');
        await delay(300);

        for (let written = 0; written < total; written += CHUNK_SIZE) {
            await delay(2);
            onProgress?.(Math.min(70, Math.round(((written + CHUNK_SIZE) / total) * 70)), 'writing');
        }
        this.buffer = buffer.slice(0);

        // Simulated read-back verification (always matches in mock mode).
        onProgress?.(70, 'verifying');
        for (let verified = 0; verified < total; verified += CHUNK_SIZE) {
            await delay(1);
            onProgress?.(70 + Math.min(30, Math.round(((verified + CHUNK_SIZE) / total) * 30)), 'verifying');
        }
        onProgress?.(100, 'verifying');
    }

    async pollLiveMeasurement(): Promise<LiveMeasurement> {
        this.assertConnected();
        await delay(20); // simulate a single DS2 request/response round trip

        const t = (performance.now() - this.measurementStartTime) / 1000;
        // Idle-like pattern: RPM hunts gently around ~800, RO stays low, STFT/lambda hover near 1.0
        const rpm = 800 + Math.sin(t * 1.3) * 15 + (Math.random() - 0.5) * 8;
        const rawLoad = 2.5 + Math.sin(t * 0.7) * 0.8 + (Math.random() - 0.5) * 0.3;
        const stftWobble = Math.sin(t * 0.9) * 0.015;
        const stft1 = 1.0 + stftWobble + (Math.random() - 0.5) * 0.01;
        const stft2 = 1.0 - stftWobble + (Math.random() - 0.5) * 0.01;
        const coolantTemp = 85 + Math.sin(t * 0.05) * 1.5;

        return {
            time: t,
            rpm: Math.max(0, rpm),
            rawLoad: Math.max(0, rawLoad),
            stft1,
            stft2,
            coolantTemp,
        };
    }

    private snapshot(): AdaptationSnapshot {
        const readings: AdaptationReading[] = ADAPTATION_FIELDS.map(field => ({
            symbol: field.symbol,
            label: field.label,
            unit: field.unit,
            group: field.group,
            value: this.adaptations.get(field.symbol) ?? field.cleared,
            cleared: field.cleared,
        }));
        return { at: Date.now(), readings };
    }

    async readAdaptations(): Promise<AdaptationSnapshot> {
        this.assertConnected();
        await delay(40); // two DS2 round trips
        return this.snapshot();
    }

    async clearTuneAdaptations(): Promise<AdaptationSnapshot> {
        this.assertConnected();
        await delay(60);
        // Each value drops to its own neutral — 1.0 for the multiplicative lambda factors, 0 for the
        // additive rest — rather than a blanket zero. See AdaptationFieldDef.cleared.
        for (const field of ADAPTATION_FIELDS) this.adaptations.set(field.symbol, field.cleared);
        await delay(ADAPT_SETTLE_MS);
        return this.snapshot();
    }
}
