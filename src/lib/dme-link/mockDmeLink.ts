import { DmeLink, DmeIdentity, LiveMeasurement, TransferProgress, DmeLinkError, ServiceBlockErasedCause, ServiceBlockDump } from './types';
import {
    AdaptationSnapshot, AdaptationReading, AdaptationFieldDef,
    STANDARD_ADAPTATIONS_BLOCK, OBSERVATION_ADAPTATIONS_BLOCK,
} from './adaptationBlocks';
import { FlashCounterInfo, ServiceBlockLayout, SERVICE_BLOCK_PAIR_LENGTH, analyzeFlashCounter } from './flashCounter';
import { Mss54HpDataTuneLayout } from './ds2';
import { correctDataChecksum } from '@/lib/checksum/dmeDataChecksum';
import { MockDrive } from './mockDrive';

const PARTIAL_BIN_LENGTH = 65536;
// Imported, not redeclared: this used to be an independent `const CHUNK_SIZE = 122`, so the mock's
// chunk count silently stopped matching the real link's the moment either number moved. The mock's
// only job is to make offline progress behave like the car's, and that needs the same chunk count.
const CHUNK_SIZE = Mss54HpDataTuneLayout.readChunkSize;
const ADAPT_SETTLE_MS = 2000; // the real link's post-clear wait — kept so the UI's spinner is real offline
/** Slots the simulated DME has already burned, per processor. Chosen so a mock reset visibly moves
 *  the header (12/30 -> 1/30) without sitting in the low-slot warning band to begin with. */
const MOCK_FLASH_SLOTS_USED = 12;

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

/**
 * The image PRACTICE serves when nothing else was supplied: the CSL 0401 Community Patch v1
 * partial, shipped as a static asset.
 *
 * The generated placeholder below cannot rehearse this app any more. It is zero everywhere except
 * a VE ramp, which means `KF_RF_KORR_DRREL`, `kf_rf_tabg_modell` and `kl_rf_korr_rf_min` are all
 * zero, `readEgtTables` refuses it, and every EGT-correction feature is simply absent offline —
 * including the RF KORR tab, which is the thing most in need of rehearsing.
 *
 * A real calibration also means PRACTICE shows real numbers: the correction peaks at 1.371 where it
 * really does, the filling floors are the real 0.55-0.80, and a tune done offline lands in the same
 * range as one done in the car.
 *
 * Community Patch v1 rather than stock: it is the lineage with the FRA timer bug fixed
 * (`K_FR_T_ADAPT` = 0x0100), so PRACTICE is not rehearsing against a binary with a known defect.
 * See docs/ecu-logic/50-binary-lineage.md. It carries no vehicle identity — the only string in it
 * is the calibration ID `211323000401PD31`.
 */
const MOCK_BIN_URL = '/mock/csl-0401-community-patch-v1.partial.bin';

async function fetchMockBin(): Promise<ArrayBuffer | null> {
    try {
        const response = await fetch(MOCK_BIN_URL, { cache: 'force-cache' });
        if (!response.ok) return null;
        const buffer = await response.arrayBuffer();
        // Wrong length means the asset is not what this expects — a half-written deploy, or a host
        // answering a 404 with an HTML page. Refusing beats serving a truncated calibration.
        return buffer.byteLength === PARTIAL_BIN_LENGTH ? buffer : null;
    } catch {
        return null;
    }
}

function buildPlaceholderBin(): ArrayBuffer {
    // The last resort, when the asset above cannot be fetched (a dev server without it, a stale
    // offline cache). Enough to parse; not enough to rehearse the EGT work, which is why it is
    // no longer the default.
    const buf = new Uint8Array(PARTIAL_BIN_LENGTH);
    const view = new DataView(buf.buffer);
    for (let row = 0; row < 24; row++) {
        for (let col = 0; col < 20; col++) {
            const offset = 0xD356 + (row * 20 + col) * 2;
            view.setUint16(offset, 500 + row * 10 + col, false);
        }
    }
    // Give it checksums that verify, for the same reason the adaptations and flash slots are modelled
    // as state rather than scripted: PRACTICE must not show a result the car wouldn't. A read now
    // checks the image against the checksums the DME stores inside it, and a placeholder left with
    // 0x0000 in both slots would fail that on every offline read — a warning about corrupt bytes,
    // raised against bytes that were never transferred.
    correctDataChecksum(buf);
    return buf.buffer;
}

/**
 * In-memory DME simulator for offline testing of the connection state machine and live-tuning
 * UI without any real cable or vehicle. Mirrors DmeLink's behavior/timing at a high level rather
 * than round-tripping through byte-level DS2 frames (those are validated separately in ds2.ts).
 */
export class MockDmeLink implements DmeLink {
    /** Null until connect() resolves it — the default image is fetched, and the constructor cannot
     *  await. Every method that touches it runs after assertConnected(). */
    private buffer: ArrayBuffer | null;
    /** The simulated drive, computed from `buffer`. See mockDrive.ts for what it models and why. */
    private drive = new MockDrive();
    private driveReady = false;
    private connected = false;
    private measurementStartTime = 0;
    private aborted = false;
    /** The simulated DME's learned state, in decoded units, keyed by field symbol. Modelling the
     *  state (rather than scripting a before/after pair) means a mock reset is a real state change:
     *  read it twice and it stays cleared, exactly like the car. */
    private adaptations = new Map<string, number>();
    /** Slots consumed per processor, modelled for the same reason as `adaptations`: a mock reset has
     *  to survive a re-read, or PRACTICE mode would show a result the car wouldn't. */
    private flashSlotsUsed = { master: MOCK_FLASH_SLOTS_USED, slave: MOCK_FLASH_SLOTS_USED };
    /**
     * Whether the simulated service block is sitting erased, as it would after a reset that died
     * between its erase and its rewrite.
     *
     * Modelled because the recovery flow is otherwise unreachable offline: the mock never fails, so
     * without a way to enter this state PRACTICE could rehearse everything about the reset except
     * the one situation the recovery instructions exist for. Set by `simulateInterruptedReset()`
     * and cleared by a restore.
     */
    private serviceBlockErased = false;
    /** Arms a one-shot failure right after the simulated erase, so the recovery flow can be walked
     *  through offline. Nothing in the UI sets this — it is driven from the console during testing. */
    private interruptNextReset = false;

    simulateInterruptedReset(): void {
        this.interruptNextReset = true;
    }

    abort(): void {
        this.aborted = true;
    }

    /** The simulated DME never drops its session, so this only has to be truthful about whether the
     *  link is up — PRACTICE mode exists to rehearse the workflow, not the K-line's failure modes. */
    async keepAlive(): Promise<boolean> {
        return this.connected;
    }

    constructor(initialBuffer?: ArrayBuffer) {
        if (initialBuffer && initialBuffer.byteLength !== PARTIAL_BIN_LENGTH) {
            throw new DmeLinkError(`Mock DME expects a ${PARTIAL_BIN_LENGTH}-byte partial BIN, got ${initialBuffer.byteLength} bytes`);
        }
        // A supplied buffer wins — connecting PRACTICE with a BIN already open is asking to
        // rehearse against THAT calibration. Otherwise the default is fetched in connect(), which
        // is the first point that is allowed to be async.
        this.buffer = initialBuffer ? initialBuffer.slice(0) : null;
    }

    async connect(): Promise<DmeIdentity> {
        await delay(400); // simulate handshake latency
        if (!this.buffer) this.buffer = (await fetchMockBin()) ?? buildPlaceholderBin();
        // Telemetry is computed from whatever bytes this DME is serving, so it has to be told about
        // them here rather than at construction. A binary without the EGT tables leaves the drive
        // unloaded and the idle pattern in charge — see pollLiveMeasurement.
        this.driveReady = this.drive.load(this.buffer);
        this.connected = true;
        this.measurementStartTime = performance.now();
        // A reconnect is an ignition cycle, not a factory reset — but the mock has no engine to
        // re-learn from, so seed the learned state fresh each time. That keeps RESET ADAPT worth
        // pressing on every mock session.
        this.adaptations = new Map(Object.entries(MOCK_LEARNED_VALUES));
        // The flash counter is NOT reseeded here, unlike the adaptations above. An ignition cycle
        // does not give a real DME its programming slots back, and a PRACTICE session that quietly
        // undid the reset on every reconnect would rehearse the wrong thing.
        return {
            vin: 'MOCKVIN0000000001',
            aif: 'MOCK-0401-PD31',
            softwareVersion: 'MOCK-SIM-1.0',
            flashCounter: this.flashCounterSnapshot(),
        };
    }

    async disconnect(): Promise<void> {
        this.connected = false;
    }

    private assertConnected() {
        if (!this.connected) throw new DmeLinkError('Mock DME is not connected');
    }

    /** The image this DME is serving. Resolved by connect(); reaching it before that is a bug in
     *  the caller's ordering, not a state to handle, so it says so rather than returning empty
     *  bytes that would read as a DME full of zeros. */
    private get image(): ArrayBuffer {
        if (!this.buffer) throw new DmeLinkError('Mock DME has no image yet — connect() first');
        return this.buffer;
    }

    async readPartialBin(onProgress?: TransferProgress): Promise<ArrayBuffer> {
        this.assertConnected();
        this.aborted = false;
        const total = this.image.byteLength;
        for (let read = 0; read < total; read += CHUNK_SIZE) {
            if (this.aborted) throw new DmeLinkError('Read cancelled');
            await delay(2);
            onProgress?.(Math.min(100, Math.round(((read + CHUNK_SIZE) / total) * 100)), 'reading');
        }
        onProgress?.(100, 'reading');
        return this.image.slice(0);
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

        // The simulated drive, computed from this DME's own calibration — see mockDrive.ts. It is
        // the only mode in which the EGT correction can be rehearsed: the idle pattern below never
        // reaches the correction's 55-80 %RF gate, so rf_korr in it is 1.000 forever.
        if (this.driveReady) return this.drive.sample(t);

        // Fallback: the old idle pattern, for a binary with no usable EGT tables (the generated
        // placeholder, or an image whose bytes do not match the catalog). Telemetry-shaped, and
        // honest about being nothing more than that.
        // Idle-like pattern: RPM hunts gently around ~800, RO stays low, STFT/lambda hover near 1.0
        const rpm = 800 + Math.sin(t * 1.3) * 15 + (Math.random() - 0.5) * 8;
        const rawLoad = 2.5 + Math.sin(t * 0.7) * 0.8 + (Math.random() - 0.5) * 0.3;
        const stftWobble = Math.sin(t * 0.9) * 0.015;
        const stft1 = 1.0 + stftWobble + (Math.random() - 0.5) * 0.01;
        const stft2 = 1.0 - stftWobble + (Math.random() - 0.5) * 0.01;
        const coolantTemp = 85 + Math.sin(t * 0.05) * 1.5;
        // Idle-consistent: ~10% relative filling, and an EGT that respects the DME's 16 °C
        // quantisation so the mock exercises the same coarse channel the car sends. Kept well
        // under K_TI_KATS_TABG_EIN (850 °C) so the mock does not trip the cat-protection filter.
        const rf = 10 + Math.sin(t * 0.7) * 0.6;
        const exhaustTemp = Math.round((360 + Math.sin(t * 0.11) * 40) / 16) * 16;

        return {
            time: t,
            rpm: Math.max(0, rpm),
            rawLoad: Math.max(0, rawLoad),
            stft1,
            stft2,
            coolantTemp,
            rf,
            exhaustTemp,
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

    /** Builds the 256 counter bytes a DME with this many consumed slots would hold: one 0x00 marker
     *  pair per used slot, erased 0xFF after. Run through the real decoder rather than reporting the
     *  numbers directly, so PRACTICE exercises analyzeFlashCounter instead of bypassing it. */
    private counterBytes(used: number): Uint8Array {
        const bytes = new Uint8Array(ServiceBlockLayout.counterLength).fill(0xFF);
        bytes.fill(0x00, 0, Math.min(used * ServiceBlockLayout.slotSize, bytes.length));
        return bytes;
    }

    private flashCounterSnapshot(): FlashCounterInfo {
        const { master, slave, counterOffset } = ServiceBlockLayout;
        return {
            master: analyzeFlashCounter(master.name, master.address + counterOffset, this.counterBytes(this.flashSlotsUsed.master)),
            slave: analyzeFlashCounter(slave.name, slave.address + counterOffset, this.counterBytes(this.flashSlotsUsed.slave)),
            readAt: Date.now(),
        };
    }

    /**
     * Zero, always: there is no engine here.
     *
     * Not a contradiction of pollLiveMeasurement's ~800 rpm idle above. That pattern exists so a
     * rehearsed datalog has a plausible trace to plot; it is telemetry-shaped test data, not a claim
     * that something is turning. This method answers the programming interlock's question instead,
     * and for a simulator the honest answer is "nothing is running". Returning the idle pattern here
     * would make the flash-counter reset — the very workflow PRACTICE exists to rehearse before
     * doing it on a car — permanently unreachable offline.
     */
    async readEngineRpm(): Promise<number> {
        this.assertConnected();
        await delay(20);
        return 0;
    }

    /**
     * A pair of service blocks shaped like the real thing.
     *
     * Modelled on an actual dump (2026-07-28): the AIF sits on the **master**, two slots populated
     * with the same VIN, and the **slave holds nothing but the flash counter** — 99.3% 0xFF, two
     * distinct byte values, same slot count as the master. That last part is the detail worth
     * preserving here, because assuming it meant damage is what disabled the reset for a day.
     */
    async readServiceBlocks(onProgress?: TransferProgress): Promise<ServiceBlockDump> {
        this.assertConnected();
        const { master, slave, counterOffset } = ServiceBlockLayout;
        const aifOffset = 0x1D50; // where a real MSS54's pointer put it

        const masterImage = new Uint8Array(master.length).fill(0xFF);
        masterImage.set(this.counterBytes(this.flashSlotsUsed.master), counterOffset);
        // Two populated AIF slots followed by blanks, which is what a twice-programmed DME looks like.
        const enc = new TextEncoder();
        for (const [slot, vin, stand] of [[0, 'MOCKVIN000001', [0, 7, 214, 1, 20]], [1, 'MOCKVIN000001', [0, 7, 214, 1, 21]]] as const) {
            const entry = new Uint8Array(46).fill(0x20);
            entry.set(enc.encode(vin), 0);
            entry.set(stand as unknown as number[], 17);
            masterImage.set(entry, aifOffset + slot * 46);
        }

        const slaveImage = new Uint8Array(slave.length).fill(0xFF);
        slaveImage.set(this.counterBytes(this.flashSlotsUsed.slave), counterOffset);

        for (let i = 1; i <= 20; i++) {
            await delay(15);
            onProgress?.(Math.round((i / 20) * 100), 'reading');
        }
        return {
            master: masterImage,
            slave: slaveImage,
            // Real pointer values, so the report's "which block does the AIF lie in" logic is
            // exercised against addresses that actually occur rather than convenient ones.
            pointers: {
                dif: 0x203FB8, zifBackup: 0x401E00, brif: 0x103FD2, zif: 0x531B90,
                aif: master.address + aifOffset,
            },
        };
    }

    async readFlashCounter(): Promise<FlashCounterInfo> {
        this.assertConnected();
        await delay(60); // six DS2 chunk reads
        return this.flashCounterSnapshot();
    }

    /** Mirrors the real reset's stages (read → erase → write → read-back verify) including the
     *  progress split, so PRACTICE is a faithful preview of a two-minute operation — and calls
     *  onBackup with a real 16384-byte buffer so the download and IndexedDB path get rehearsed too. */
    async resetFlashCounter(
        onBackup: (serviceBlockPair: ArrayBuffer) => Promise<void>,
        onProgress?: TransferProgress,
    ): Promise<FlashCounterInfo> {
        this.assertConnected();
        const READ_SHARE = 25, WRITE_SHARE = 45, VERIFY_SHARE = 30;
        const steps = 40;

        for (let i = 1; i <= steps; i++) {
            await delay(12);
            onProgress?.(Math.round((i / steps) * READ_SHARE), 'reading');
        }

        // The same refusal the real link raises, with the same typed cause, so the UI's recovery
        // branch is exercised rather than merely assumed to work.
        if (this.serviceBlockErased) {
            throw new DmeLinkError(
                'Flash counter reset refused: the Master service block is erased, which means an earlier reset was ' +
                'interrupted before it could write the block back. Re-running now would make that loss permanent — ' +
                'restore the saved backup instead.',
                { kind: 'serviceBlockErased', processor: 'Master' } satisfies ServiceBlockErasedCause,
            );
        }

        // A stand-in service block pair: erased everywhere except the counter regions, which carry
        // the simulated slot markers. Enough for the caller to save a real file of the real size.
        const pair = new Uint8Array(SERVICE_BLOCK_PAIR_LENGTH).fill(0xFF);
        pair.set(this.counterBytes(this.flashSlotsUsed.master), ServiceBlockLayout.counterOffset);
        pair.set(this.counterBytes(this.flashSlotsUsed.slave), ServiceBlockLayout.master.length + ServiceBlockLayout.counterOffset);
        // Awaited and unguarded, exactly like the real link: a caller that cannot persist the backup
        // must stop the operation here, and PRACTICE has to be able to rehearse that failure.
        await onBackup(pair.buffer);

        onProgress?.(READ_SHARE, 'erasing');
        await delay(600);
        // From here the simulated block is erased. If the run is cut short after this point — which
        // simulateInterruptedReset() arranges — it stays that way, exactly as a real one would.
        this.serviceBlockErased = true;
        if (this.interruptNextReset) {
            this.interruptNextReset = false;
            throw new DmeLinkError(
                'Simulated interruption: power was lost after the erase and before the write completed.',
            );
        }

        for (let i = 1; i <= steps; i++) {
            await delay(10);
            onProgress?.(READ_SHARE + Math.round((i / steps) * WRITE_SHARE), 'writing');
        }
        // A cleared counter is 1/30, not 0/30 — the first slot stays consumed. See flashCounter.ts.
        this.flashSlotsUsed = { master: 1, slave: 1 };
        this.serviceBlockErased = false;

        for (let i = 1; i <= steps; i++) {
            await delay(8);
            onProgress?.(READ_SHARE + WRITE_SHARE + Math.round((i / steps) * VERIFY_SHARE), 'verifying');
        }
        onProgress?.(100, 'verifying');
        return this.flashCounterSnapshot();
    }

    /**
     * Restores a saved service block. In the simulator the only thing the 16 KB actually carries is
     * the counter state, so that is what gets read back out of it — but the timing, the phases and
     * the length check are the real ones, so the recovery flow can be rehearsed exactly once it has
     * been reached.
     */
    async restoreServiceBlock(serviceBlockPair: ArrayBuffer, onProgress?: TransferProgress): Promise<FlashCounterInfo> {
        this.assertConnected();
        if (serviceBlockPair.byteLength !== SERVICE_BLOCK_PAIR_LENGTH) {
            throw new DmeLinkError(
                `Refusing to restore a ${serviceBlockPair.byteLength}-byte service block (expected ${SERVICE_BLOCK_PAIR_LENGTH})`,
            );
        }
        const bytes = new Uint8Array(serviceBlockPair);
        const steps = 40;

        onProgress?.(0, 'erasing');
        await delay(600);
        for (let i = 1; i <= steps; i++) {
            await delay(10);
            onProgress?.(Math.round((i / steps) * 60), 'writing');
        }
        for (let i = 1; i <= steps; i++) {
            await delay(8);
            onProgress?.(60 + Math.round((i / steps) * 40), 'verifying');
        }
        onProgress?.(100, 'verifying');

        // Recover the simulated slot counts from the image, so a restore genuinely puts back what
        // was saved rather than resetting to a hardcoded number.
        const readUsed = (base: number) => {
            const counter = bytes.subarray(base + ServiceBlockLayout.counterOffset,
                base + ServiceBlockLayout.counterOffset + ServiceBlockLayout.counterLength);
            return analyzeFlashCounter('probe', 0, counter).used;
        };
        this.flashSlotsUsed = { master: readUsed(0), slave: readUsed(ServiceBlockLayout.master.length) };
        this.serviceBlockErased = false;
        return this.flashCounterSnapshot();
    }
}
