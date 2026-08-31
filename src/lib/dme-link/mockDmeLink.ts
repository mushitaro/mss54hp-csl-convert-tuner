import {
    DmeLink, DmeIdentity, LiveMeasurement, EgasMeasurement, InertiaSample, RamProbeResult, RamProbeWindow,
    TransferProgress, DmeLinkError, ServiceBlockErasedCause,
    ServiceBlockDump, WriteOptions, WriteVerification, IdleSample,
} from './types';
import {
    RAM_PROBE_READS, Mss54HpRamSignals, isRamReadInRange, SLEW_TORQUE_RAM_READ,
} from './ramMap';
import {
    AdaptationSnapshot, AdaptationReading, AdaptationFieldDef,
    STANDARD_ADAPTATIONS_BLOCK, OBSERVATION_ADAPTATIONS_BLOCK, isClearedByTuneReset,
} from './adaptationBlocks';
import { FlashCounterInfo, ServiceBlockLayout, SERVICE_BLOCK_PAIR_LENGTH, analyzeFlashCounter } from './flashCounter';
import { Mss54HpDataTuneLayout, Ds2EncodingChecksum, parseEncodingChecksum } from './ds2';
import { correctDataChecksum, readStoredChecksums } from '@/lib/checksum/dmeDataChecksum';
import { MockDrive } from './mockDrive';
import { BinaryPatcher } from '@/lib/binary-engine/patcher';
import { MockIdleBench } from '@/lib/idle/bench';
import { readIdleTables, qvsAt } from '@/lib/idle/idleTables';
import { MockInertiaBench } from '@/lib/inertia/bench';
import { type LogExchange, LOG_PROFILES, sampleMs , IDLE_SLOW_LANE_EVERY, IDLE_SURVEY_LANE_EVERY } from '@/lib/log-engine/logProfile';

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
 * retards. Picked so a mock reset visibly changes every row it is supposed to change — and, since
 * VANOS left the clear mask, visibly leaves the two VANOS rows where they were.
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
        return buffer.byteLength === PARTIAL_BIN_LENGTH ? asPreparedCar(buffer) : null;
    } catch {
        return null;
    }
}

/**
 * The default mock DME is a car that has already taken this app's own logging patches.
 *
 * It was not, and that made PRACTICE rehearse a run this app itself warns against. The community
 * image is stock in the two places the patches touch, so its `KF_BZ_WDK_VL` reads 35–65 % throttle
 * — and the lambda full-load gate, which reads that table out of whatever binary was loaded,
 * rejected **every driving sample** of the practice cycle: VALID sat at 0, no correction map was
 * ever derived, and the armed switch to LAMBDA FEEDBACK never fired because the tab it was waiting
 * for never became enabled. The whole point of the patch is to keep the lambda controller alive at
 * load (`isFullLoad`'s own doc: patched, every cell reads 102.3 % and the gate goes inert), so a
 * rehearsal of the tuning flow has to run against a patched car — exactly as every real logging
 * session does, because a real first session flashes the patch before it logs.
 *
 * Applied through `BinaryPatcher` rather than baked into the asset, so the bytes can never drift
 * from what the real WRITE path produces — this IS the write path, pointed at the mock's image.
 * The checksum correction keeps a later practice WRITE/verify consistent with what it read.
 *
 * Only the DEFAULT image is prepared. A caller-supplied buffer is deliberately served verbatim —
 * connecting PRACTICE with a BIN already open is asking to rehearse against THAT calibration,
 * including an unpatched one, and the preflight dialog exists to say so.
 */
function asPreparedCar(buffer: ArrayBuffer): ArrayBuffer {
    try {
        const patcher = new BinaryPatcher(buffer.slice(0));
        patcher.disableMapCorrection();
        patcher.setWOTThreshold(true);
        patcher.applyChecksumCorrection();
        return patcher.getBuffer();
    } catch {
        // A buffer the patcher cannot address is served as it came — the placeholder path already
        // tolerates a calibration the drive cannot load.
        return buffer;
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
    /**
     * The stationary-neutral inertia bench, answering `pollEgasMeasurement`.
     *
     * Separate from `drive` because it models something `drive` does not: rotational dynamics. The
     * drive cycle is a scripted rpm/load trace with no relationship between torque and speed
     * gradient, so an estimator run against it would find nothing. This has a known J, which makes
     * PRACTICE mode a genuine rehearsal of the inertia workflow — the answer at the end is
     * checkable, not merely plausible.
     */
    private readonly inertiaBench = new MockInertiaBench();
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
            encodingChecksum: await this.queryEncodingChecksum(),
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

    /**
     * Mirrors the real write's stages (erase → write → verify) so the mock is a faithful preview of
     * the UI, including the phase labels and the mode-dependent progress split.
     *
     * The two verify modes are rehearsed for real here rather than collapsed into one: QUICK skips
     * the read-back entirely and returns a clean checksum, FULL walks the read-back. Which matters,
     * because the difference between them in the UI is a progress bar that behaves differently and
     * a completion dialog that says something different — both of which are worth seeing before a
     * car is involved.
     */
    async writePartialBin(buffer: ArrayBuffer, options: WriteOptions, onProgress?: TransferProgress): Promise<WriteVerification> {
        this.assertConnected();
        if (buffer.byteLength !== PARTIAL_BIN_LENGTH) {
            throw new DmeLinkError(`Refusing to write a ${buffer.byteLength}-byte buffer (expected ${PARTIAL_BIN_LENGTH})`);
        }
        const total = buffer.byteLength;
        const writeShare = options.verifyMode === 'full' ? 55 : 98;

        onProgress?.(0, 'erasing');
        await delay(300);

        for (let written = 0; written < total; written += CHUNK_SIZE) {
            await delay(2);
            onProgress?.(Math.min(writeShare, Math.round(((written + CHUNK_SIZE) / total) * writeShare)), 'writing');
        }
        this.buffer = buffer.slice(0);

        onProgress?.(writeShare, 'verifying');
        let readBack = false;
        if (options.verifyMode === 'full') {
            const verifyShare = 100 - writeShare;
            for (let verified = 0; verified < total; verified += CHUNK_SIZE) {
                await delay(1);
                onProgress?.(writeShare + Math.min(verifyShare, Math.round(((verified + CHUNK_SIZE) / total) * verifyShare)), 'verifying');
            }
            readBack = true;
        }
        const encodingChecksum = await this.queryEncodingChecksum();
        onProgress?.(100, 'verifying');
        // The simulated DME always reports a clean checksum — see queryEncodingChecksum below for
        // why that is modelled rather than scripted.
        // The mock programs its own memory, so every changed window trivially matches — which is
        // the honest mock of a WORKING write path. A hollow-write simulation would go here.
        return { mode: options.verifyMode, encodingChecksum, encodingChecksumError: null, checksumClean: true, readBack,
            spotWindows: options.verifyMode === 'quick' ? (options.spotCheck?.length ?? 0) : 0 };
    }

    /**
     * A clean bill of health, always.
     *
     * Modelled rather than scripted, in the sense that matters here: the mock's flash cannot be
     * corrupted, so every area really is clean and saying so is not a lie. What the mock cannot
     * rehearse is a FAULTED answer or a DME that refuses 0x0A — those paths are exercised by the
     * scripted-transport tests against the real class, which is the right place for them.
     */
    async queryEncodingChecksum(): Promise<Ds2EncodingChecksum> {
        this.assertConnected();
        await delay(20);
        return parseEncodingChecksum({
            address: 0x12, length: 5, controlOrStatus: 0xA0,
            payload: new Uint8Array([0x00]), checksum: 0,
        });
    }

    async readDataChecksums(): Promise<{ slave: number; master: number }> {
        this.assertConnected();
        await delay(40); // two small reads
        // Off the mock's own image, so a PRACTICE write really does change the answer. Modelling
        // it as state rather than returning a fixed pair is what lets the lineage guard be
        // rehearsed offline: flash in PRACTICE, and a session built on the pre-flash BASE is
        // correctly refused afterwards, exactly as it would be on the car.
        return readStoredChecksums(new Uint8Array(this.buffer!));
    }

    /**
     * The latched EGAS freeze-frame — and on this simulated DME it is what a healthy car returns:
     * all zeros, because nothing has faulted.
     *
     * Modelled honestly rather than filled with telemetry. A mock that streamed live-looking values
     * out of selection 83 is precisely how the real block's behaviour stayed hidden through an
     * entire build; PRACTICE mode has to reproduce the DME's silence, not paper over it.
     */
    async readEgasFreezeFrame(): Promise<EgasMeasurement> {
        this.assertConnected();
        await delay(20);
        if (this.measurementStartTime === 0) this.measurementStartTime = performance.now();
        return {
            time: (performance.now() - this.measurementStartTime) / 1000,
            engineState: 0, wdk1: 0, n40: 0, dN40: 0, dPwg: 0, dWdk: 0, rf: 0,
            mdIndWunsch: 0, mdIndNe: 0, mdIndOptKorr: 0, vAntrieb: 0,
            mdDynSt: 0, gang: 0, sKrafts: 0, saWeSt: 0,
        };
    }

    async pollInertiaSample(): Promise<InertiaSample> {
        this.assertConnected();
        // Two round trips, because the real path is two: selection 3 then one RAM read. Modelling
        // the cost is the point — the run's usable sample rate is what decides whether the
        // procedure is possible at all, and a mock that answered in one would rehearse the wrong
        // manoeuvre. Priced from the profile rather than guessed: 40 ms was about six times faster
        // than the car, which made a PRACTICE inertia run rehearse a manoeuvre nobody can perform.
        await delay(sampleMs(LOG_PROFILES.INERTIA.exchanges));
        if (this.measurementStartTime === 0) this.measurementStartTime = performance.now();
        return this.inertiaBench.sample((performance.now() - this.measurementStartTime) / 1000);
    }

    async pollIdleSample(): Promise<IdleSample> {
        this.assertConnected();
        // Priced from the profile, for the reason pollInertiaSample is: a mock that answers faster
        // than the car rehearses a manoeuvre nobody can perform, and the whole point of the idle
        // procedure is that the driver has to hold still for a length of time the rate decides.
        await delay(sampleMs(LOG_PROFILES.IDLE.exchanges));
        if (this.measurementStartTime === 0) this.measurementStartTime = performance.now();
        const t = (performance.now() - this.measurementStartTime) / 1000;
        const r = this.idleBenchOrCreate().read(t);
        const slow = this.idleSampleIndex++ % IDLE_SLOW_LANE_EVERY === 0;
        // Carried forward between reads, like the real link. A mock that left them null in between
        // would rehearse a compressor cycle that the gate only catches one sample in four of.
        if (slow) {
            this.idleSlowLane = {
                llsTv: r.llsTv, llrQvs: r.llrQvs, llrQsoll: r.llrQvs,
                engineState: r.engineState, kkosSt: r.kkosSt, llsSt: r.llsSt,
                wdkWord: r.wdkWord, wdkSoll: r.wdkSoll, egasSoll: r.egasSoll, egasMaxWdk: r.egasMaxWdk,
                lfrZustand: r.lfrZustand, lfrMdi: r.lfrMdi, lfrIAfr: r.lfrIAfr,
                frRegler: r.frRegler, fraMlAdaption: r.fraMlAdaption,
                ...this.idleSurveyLane,
            };
        }
        if (this.idleSampleIndex % IDLE_SURVEY_LANE_EVERY === 1) {
            // The lambda learning stores. Held at unity because this rig models air and not fuel —
            // it can show the panel rendering them, and it cannot say what the car holds.
            this.idleSurveyLane = {
                laFRegler1: 1.0, laFRegler2: 1.0, laaF1: 1.0, laaF2: 1.0,
                laaRegler1: 1.0, laaRegler2: 1.0,
                // Straight ahead, both reserves down — what the listing says a real car holds at a
                // settled idle. MD_RES_LRW_ST is 0x01 and not 0x00 on purpose: bit0 means "below
                // K_MD_RES_LRW_V", which is UP on any stationary car, while bit1 is the one that
                // gates MD_LLR_TZ. A consumer that reads the byte as a boolean passes against 0x00
                // and fails here, which is the whole reason this rig holds a value at all.
                lwsLrw: 0, mdResKath: 0, mdResLrwRoh: 0, mdResLrwSt: 0x01, mdResLrw: 0,
                // A healthy VANOS: both cams where the calibration asks, the latch armed, no error.
                // EVAN1_ST is 0x88 rather than 0x08 on purpose — the slave also sets bit7 (a timer
                // flag, 0x024376) — so a consumer that compares the byte for equality with 8, or
                // treats it as a boolean, passes against 0x08 and fails here. Only a bit3 test works.
                evan1Ist: 60.0, avan1Ist: 2.0, evan1St: 0x88, avan1St: 0x88,
                vanEdSt: 0x00, vanAdapSt: 0x00, evan1IstFilt: 60.0, evan1Soll: 60.0,
            };
            this.idleSlowLane = { ...this.idleSlowLane, ...this.idleSurveyLane };
        }
        const carried = this.idleSlowLane;
        return {
            time: t,
            rpm: r.rpm,
            coolantTemp: r.tmot,
            wdk1: r.wdk1,
            rf: null,
            nSoll: r.nSoll,
            ub: r.ub,
            mdLlri: r.mdLlri,
            mdLlra: r.mdLlra,
            mdLlraKo: r.mdLlraKo,
            // Null off the slow lane, exactly as the real link leaves them. A mock that filled
            // these in every sample would hide a consumer that forgot they can be absent.
            llsTv: carried.llsTv,
            llrQvs: carried.llrQvs,
            llrQsoll: carried.llrQsoll,
            engineState: carried.engineState,
            kkosSt: carried.kkosSt,
            llsSt: carried.llsSt,
            // Same telegram as mdLlri on the real link, so the same here.
            mdRfSoll: Math.round(r.mlSoll * 40),
            mdRfKorr: Math.round(r.mlSoll * 40),
            mlSoll: r.mlSoll,
            mlSollLls: r.mlSollLls,
            mlSollMaxLls: r.mlSollMaxLls,
            wdkWord: carried.wdkWord,
            wdkSoll: carried.wdkSoll,
            egasSoll: carried.egasSoll,
            egasMaxWdk: carried.egasMaxWdk,
            lfrZustand: carried.lfrZustand,
            lfrMdi: carried.lfrMdi,
            lfrIAfr: carried.lfrIAfr,
            frRegler: carried.frRegler,
            fraMlAdaption: carried.fraMlAdaption,
            laFRegler1: carried.laFRegler1,
            laFRegler2: carried.laFRegler2,
            laaF1: carried.laaF1,
            laaF2: carried.laaF2,
            laaRegler1: carried.laaRegler1,
            laaRegler2: carried.laaRegler2,
            lwsLrw: carried.lwsLrw,
            mdResKath: carried.mdResKath,
            mdResLrwRoh: carried.mdResLrwRoh,
            mdResLrwSt: carried.mdResLrwSt,
            mdResLrw: carried.mdResLrw,
            evan1Ist: carried.evan1Ist,
            avan1Ist: carried.avan1Ist,
            evan1St: carried.evan1St,
            avan1St: carried.avan1St,
            vanEdSt: carried.vanEdSt,
            vanAdapSt: carried.vanAdapSt,
            evan1IstFilt: carried.evan1IstFilt,
            evan1Soll: carried.evan1Soll,
            // Held at a standard day rather than modelled. This rig simulates AIR, not weather:
            // 20 degC and 1013 mbar put RF_PT_KORR at 1.000, which is the condition the Alpha-N
            // table's own numbers are written for — so a practice run rehearses the arithmetic
            // without inventing a density correction the bench has no way to be right about.
            intakeTemp: 20,
            ambientPressure: 1013,
            chargeTemp: 20,
            altitude: 0,
            ambientPressureSubstituted: undefined,
            mdLlriSource: 'ram',
        };
    }

    /** The bench needs the binary, and the binary arrives on connect. */
    private idleBenchOrCreate(): MockIdleBench {
        if (!this.idleBench) {
            const tables = this.buffer ? readIdleTables(this.buffer) : null;
            this.idleBench = new MockIdleBench(
                tables ? { qvsAt: (rpm, tmot) => qvsAt(tables, rpm, tmot) } : {},
            );
        }
        return this.idleBench;
    }

    private idleBench: MockIdleBench | null = null;
    private idleSampleIndex = 0;
    private idleSurveyLane: {
        laFRegler1: number | null; laFRegler2: number | null;
        laaF1: number | null; laaF2: number | null;
        laaRegler1: number | null; laaRegler2: number | null;
        lwsLrw: number | null; mdResKath: number | null;
        mdResLrwRoh: number | null; mdResLrwSt: number | null; mdResLrw: number | null;
        evan1Ist: number | null; avan1Ist: number | null;
        evan1St: number | null; avan1St: number | null;
        vanEdSt: number | null; vanAdapSt: number | null;
        evan1IstFilt: number | null; evan1Soll: number | null;
    } = {
        laFRegler1: null, laFRegler2: null, laaF1: null, laaF2: null, laaRegler1: null, laaRegler2: null,
        lwsLrw: null, mdResKath: null, mdResLrwRoh: null, mdResLrwSt: null, mdResLrw: null,
        evan1Ist: null, avan1Ist: null, evan1St: null, avan1St: null,
        vanEdSt: null, vanAdapSt: null, evan1IstFilt: null, evan1Soll: null,
    };
    private idleSlowLane: {
        llsTv: number | null; llrQvs: number | null; llrQsoll: number | null;
        engineState: number | null; kkosSt: number | null; llsSt: number | null;
        wdkWord: number | null; wdkSoll: number | null; egasSoll: number | null; egasMaxWdk: number | null;
        lfrZustand: number | null; lfrMdi: number | null; lfrIAfr: number | null;
        frRegler: number | null; fraMlAdaption: number | null;
        laFRegler1: number | null; laFRegler2: number | null;
        laaF1: number | null; laaF2: number | null; laaRegler1: number | null; laaRegler2: number | null;
        lwsLrw: number | null; mdResKath: number | null;
        mdResLrwRoh: number | null; mdResLrwSt: number | null; mdResLrw: number | null;
        evan1Ist: number | null; avan1Ist: number | null;
        evan1St: number | null; avan1St: number | null;
        vanEdSt: number | null; vanAdapSt: number | null;
        evan1IstFilt: number | null; evan1Soll: number | null;
    } = {
        llsTv: null, llrQvs: null, llrQsoll: null, engineState: null, kkosSt: null, llsSt: null,
        wdkWord: null, wdkSoll: null, egasSoll: null, egasMaxWdk: null,
        lfrZustand: null, lfrMdi: null, lfrIAfr: null, frRegler: null, fraMlAdaption: null,
        laFRegler1: null, laFRegler2: null, laaF1: null, laaF2: null, laaRegler1: null, laaRegler2: null,
        lwsLrw: null, mdResKath: null, mdResLrwRoh: null, mdResLrwSt: null, mdResLrw: null,
        evan1Ist: null, avan1Ist: null, evan1St: null, avan1St: null,
        vanEdSt: null, vanAdapSt: null, evan1IstFilt: null, evan1Soll: null,
    };

    /**
     * The simulated DME serves RAM, so the probe passes offline.
     *
     * Returns the bench's own current torque bytes rather than a canned pair, so a probe result
     * shown in PRACTICE is a real reading of the simulated engine and not a green tick that would
     * look identical if the plumbing were broken.
     */
    async readRam(segment: number, address: number, count: number): Promise<Uint8Array> {
        this.assertConnected();
        if (!isRamReadInRange(segment, address, count)) {
            throw new DmeLinkError(`RAM read 0x${address.toString(16)} +${count} is outside every declared window`);
        }
        // The slew limiter's torque words are REFUSED rather than answered with zeroes.
        //
        // The bench models crank torque, not the driver's request either side of a filter it does
        // not simulate. Serving the window would return 0.0 Nm for `MD_FW` and `MD_FW_FILTER`,
        // which reads as "the limiter took nothing" — the exact conclusion a rehearsal is meant to
        // reach only from the car. An absent channel is already handled everywhere; a fabricated
        // zero is not distinguishable from a measurement.
        if (address === SLEW_TORQUE_RAM_READ.address) {
            throw new DmeLinkError('PRACTICE does not simulate the slew limiter; run this on the car');
        }
        await delay(20);
        const out = new Uint8Array(count);
        const sample = this.inertiaBench.sample((performance.now() - this.measurementStartTime) / 1000);
        const write = (sig: { address: number; size: 1 | 2; scale: number }, value: number | null) => {
            const at = sig.address - address;
            if (at < 0 || at + sig.size > count || value === null) return;
            const raw = Math.max(0, Math.round(value / sig.scale));
            if (sig.size === 1) out[at] = raw & 0xFF;
            else { out[at] = (raw >> 8) & 0xFF; out[at + 1] = raw & 0xFF; }
        };
        write(Mss54HpRamSignals.MD_IND_NE, sample.mdIndNe);
        write(Mss54HpRamSignals.MD_DYN_ST, sample.mdDynSt);
        write(Mss54HpRamSignals.MD_IND_OPT_KORR, sample.mdIndNe);
        return out;
    }

    /** The profile's list, so the simulated rate follows the same arithmetic the real link's does. */
    private liveExchanges: LogExchange[] = LOG_PROFILES.VE.fallback ?? LOG_PROFILES.VE.exchanges;

    setLiveExchanges(exchanges: readonly LogExchange[]): void {
        this.liveExchanges = [...exchanges];
    }

    getLiveExchanges(): LogExchange[] {
        return [...this.liveExchanges];
    }

    /**
     * PRACTICE always logs the way a car that refused the claim would.
     *
     * There is no simulated RAM lambda trim to check against, and inventing one that always agreed
     * would rehearse the gate passing — which is the one outcome nobody needs practice at. Answering
     * with the fallback teaches the honest lesson: this is what a log looks like when the fast path
     * is not available.
     */
    async verifyLambdaTrimSource(profile: { exchanges: LogExchange[]; fallback?: LogExchange[] }) {
        if (!profile.fallback) return null;
        return {
            exchanges: profile.fallback,
            proven: false,
            detail: 'PRACTICE has no RAM lambda trim to check — logging both blocks.',
        };
    }

    async probeRam(): Promise<RamProbeResult> {
        this.assertConnected();
        const windows: RamProbeWindow[] = [];
        for (const probe of RAM_PROBE_READS) {
            const bytes = await this.readRam(probe.segment, probe.address, probe.count);
            windows.push({
                name: probe.name, segment: probe.segment, address: probe.address,
                supported: true, bytes: [...bytes], failure: null, detail: null,
            });
        }
        return { ok: true, windows };
    }

    /** The J the offline bench is simulating, so PRACTICE mode can say whether the estimate is
     *  right rather than only whether it is plausible. Not part of DmeLink — no car knows this. */
    get mockTrueInertia(): number {
        return this.inertiaBench.trueJ;
    }

    async pollLiveMeasurement(): Promise<LiveMeasurement> {
        this.assertConnected();
        // The cost of the exchange list this run was actually given, not a flat 20 ms. Rehearsing a
        // datalog at ten times the car's rate teaches the wrong thing about every part of the
        // procedure that depends on rate — how long a pull has to be held, how many samples a gate
        // window collects, whether the flush keeps up.
        await delay(sampleMs(this.liveExchanges));

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
        // Tank ventilation, modelled as the thing it actually is: intermittent. The DME purges in
        // windows, so a mock that held a constant duty would teach the wrong shape — the reason this
        // channel is worth logging is that it comes and goes, and that a run can be spoiled by a
        // window you did not notice. ~30 s on, ~30 s off. At idle the stock duty map asks for only a
        // few percent, and K_TE_TV_MIN puts the floor near 6.9 ms, so the open value stays small.
        const purging = Math.sin(t * 0.1) > 0;
        const tankVent = purging ? 7.4 + Math.sin(t * 0.6) * 0.5 : 0;

        return {
            time: t,
            rpm: Math.max(0, rpm),
            rawLoad: Math.max(0, rawLoad),
            stft1,
            stft2,
            // A standing 4 % the long-term store has learned, which the short-term pair above no
            // longer shows — the exact shape of the real thing. A rehearsal that put 1.000 here
            // would rehearse the case where the new arithmetic changes nothing.
            ltft1: 0.96,
            ltft2: 0.96,
            coolantTemp,
            rf,
            exhaustTemp,
            // Idle throttle. The plate is nearly shut, which is what makes the full-load gate a
            // no-op here — correct for this pattern, and the reason PRACTICE cannot be used to
            // check that the gate actually rejects anything.
            wdk1: 4.5 + Math.sin(t * 0.7) * 0.4,
            tankVent,
            // Both idle at 0 on a healthy DME: the functional check is not running and the valve has
            // not faulted. PRACTICE has no failure to simulate here, and inventing one would put a
            // fault code on screen that no car reported.
            tankVentCheckState: 0,
            tankVentDiag: 0,
            // Zero, and NOT because a car said so — nothing here knows what this byte does. It is
            // present so the column exists in PRACTICE; its value carries no claim.
            lambdaFreeze: 0,
            // A warm engine bay, drifting up a little as the drive goes on. Not a claim about any
            // car: PRACTICE exists so the column is present and the density arithmetic downstream
            // has something to run on. A real log carries the NTC's own reading.
            intakeTemp: 38 + Math.min(12, t * 0.05),
            // The modelled charge temperature, built the way the DME builds it — coolant, pulled
            // toward the intake reading in proportion to flow. `f` here is a stand-in for
            // `|gain| * ML / 10000` using load as the flow proxy, so the mock exercises the whole
            // range of the normalisation (near-coolant at idle, near-sensor at high load) instead
            // of a constant that would make the factor look like 1.000 everywhere.
            chargeTemp: (() => {
                const tan = 38 + Math.min(12, t * 0.05);
                // ML the way rf_calc builds it: 3.201 L, four-stroke, at K_RF_LUFTDICHTE.
                // 6000 rpm at 100 % filling gives 654 kg/h, which is the check.
                const mlKgH = Math.max(0, rpm) * Math.max(0, rf) * 0.0010909;
                // Idle gain (-70), because this pattern is an idle: f = 1 at 143 kg/h.
                const f = Math.min(1, 70 * mlKgH / 10000);
                return coolantTemp - f * (coolantTemp - tan);
            })(),
            // 943 mbar is about 600 m, which is where this car lives. Static: the mock does not
            // drive up a mountain, and a fabricated gradient would be a claim.
            ambientPressure: 943,
            altitude: 600,
            // A summer morning at 600 m. Below the intake reading by the heat soak the S54's
            // manifold-mounted sensor is known for, which is what makes the cold-soak check in the
            // docs mean something: at rest these two converge, and here they do not.
            ambientTemp: 31,
            ambientTempFromCan: true,
            // Idle pattern, so the car is not moving — which also makes PRACTICE the wrong place to
            // check anything that gates on road speed.
            vehicleSpeed: 0,
            // A healthy valve: bit 0 is what lls_tv_init leaves, bit 7 clear. That is the case the
            // ti_load_factor branch question actually turns on, so a rehearsal has to get it right.
            llsSt: 0x01,
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
            // Carried through, not defaulted. This mapping duplicates decodeBlock in
            // adaptationBlocks.ts, and the first version of it silently dropped this flag — PRACTICE
            // then showed "expected 0" against the two VANOS rows while the real link showed nothing,
            // which is the exact disagreement the flag was added to remove.
            clearedByTuneReset: field.clearedByTuneReset,
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
        //
        // And only the rows the real mask actually clears: VANOS is read but not cleared, so PRACTICE
        // has to leave its two rows sitting at their seeded values. A mock that clears more than the
        // car does is a mock that teaches the wrong expectation.
        for (const field of ADAPTATION_FIELDS) {
            if (isClearedByTuneReset(field)) this.adaptations.set(field.symbol, field.cleared);
        }
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
        // DmeLink's third parameter, `boost`, is not declared here and that is the whole statement:
        // PRACTICE has no wire, so there is no rate to change and no time for changing it to save. A
        // mock that ran faster with the box ticked would be teaching a number it made up.
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
