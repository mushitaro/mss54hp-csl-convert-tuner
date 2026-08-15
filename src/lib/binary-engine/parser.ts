import { APP_CONFIG, EXPERIMENTAL_CONFIG, TANK_VENT_GAIN } from '@/config/constants';
import type { VEMap } from '@/lib/types';
import type { EcuItemDef, EcuItemValue, EcuNumericDef } from '@/lib/ecu-items/types';

export class BinaryParser {
    protected buffer: ArrayBuffer;
    protected view: DataView;
    protected uint8Array: Uint8Array;

    constructor(buffer: ArrayBuffer) {
        this.buffer = buffer;
        this.view = new DataView(buffer);
        this.uint8Array = new Uint8Array(buffer);
    }
    // ... (skip unchanged methods)
    public getWOTThresholdStatus(): boolean {
        const addr = EXPERIMENTAL_CONFIG.ADDRESS_WOT_THRESHOLD_MAP;
        // Read first two bytes (one value)
        const val = this.getUint16(addr);
        // If > 1000 (100%), it's disabled. Stock is usually much lower or specific map.
        return val > 1000;
    }

    /**
     * Whether this binary has the tank-vent valve held shut.
     *
     * Tests for exactly zero rather than "below stock". The byte is a gain and the DME's own
     * threshold is `<= K_TE_TV_MIN`, so intermediate values are legitimate calibration — a BIN
     * carrying 0x40 is running purge at half gain, not "sort of disabled", and reporting it as
     * disabled would put the wrong word on the hub and in the write dialog.
     */
    public getTankVentDisabled(): boolean {
        return this.getUint8(TANK_VENT_GAIN.ADDRESS) === TANK_VENT_GAIN.DISABLED_RAW;
    }

    public getBuffer(): ArrayBuffer {
        return this.buffer;
    }

    public getUint8(offset: number): number {
        this.validateOffset(offset, 1);
        return this.view.getUint8(offset);
    }

    public getUint16(offset: number): number {
        this.validateOffset(offset, 2);
        return this.view.getUint16(offset, false); // Big Endian (Correct for data)
    }

    /** Signed variants. The catalog needs them: TABG's diagnostic limits are int16 (-50 °C), and
     *  reading those unsigned would show 65486. */
    public getInt8(offset: number): number {
        this.validateOffset(offset, 1);
        return this.view.getInt8(offset);
    }

    public getInt16(offset: number): number {
        this.validateOffset(offset, 2);
        return this.view.getInt16(offset, false); // Big Endian
    }

    /** One contiguous run of same-width numbers — a constant, an axis, or a value grid. */
    private readRun(def: EcuNumericDef, count: number): number[] {
        const step = def.bits / 8;
        const out: number[] = new Array(count);
        for (let i = 0; i < count; i++) {
            const at = def.address + i * step;
            out[i] = def.bits === 8
                ? (def.signed ? this.getInt8(at) : this.getUint8(at))
                : (def.signed ? this.getInt16(at) : this.getUint16(at));
        }
        return out;
    }

    /**
     * Decodes one catalog item. Read-only by design — see lib/ecu-items/types.ts.
     *
     * Addresses are used as file offsets with no translation, exactly like every other read in this
     * class: the XDF address IS the partial-BIN offset. The 2-byte block size header that precedes
     * a KL/KF block sits at `x.address - 2` and is deliberately not part of any run here.
     */
    public readItem(def: EcuItemDef): EcuItemValue {
        switch (def.kind) {
            case 'constant': {
                const raw = this.readRun(def, 1)[0];
                return { kind: 'constant', symbol: def.symbol, raw, value: def.scaling.toPhysical(raw) };
            }
            case 'series': {
                const raw = this.readRun(def.values, def.values.n);
                return {
                    kind: 'series', symbol: def.symbol, indexNames: def.indexNames,
                    values: raw.map(def.values.scaling.toPhysical), raw,
                };
            }
            case 'curve': {
                const raw = this.readRun(def.values, def.values.n);
                return {
                    kind: 'curve', symbol: def.symbol,
                    x: this.readRun(def.x, def.x.n).map(def.x.scaling.toPhysical),
                    values: raw.map(def.values.scaling.toPhysical),
                    raw,
                };
            }
            case 'map': {
                const flat = this.readRun(def.values, def.values.rows * def.values.cols);
                const raw: number[][] = [];
                const values: number[][] = [];
                for (let r = 0; r < def.values.rows; r++) {
                    // Row-major, y-major — the same layout getVETable assumes.
                    const rowRaw = flat.slice(r * def.values.cols, (r + 1) * def.values.cols);
                    raw.push(rowRaw);
                    values.push(rowRaw.map(def.values.scaling.toPhysical));
                }
                return {
                    kind: 'map', symbol: def.symbol,
                    x: this.readRun(def.x, def.x.n).map(def.x.scaling.toPhysical),
                    y: this.readRun(def.y, def.y.n).map(def.y.scaling.toPhysical),
                    values, raw,
                };
            }
        }
    }

    /**
     * Reads the VE Table from the binary at defined offsets.
     * Using Fixed Axes from constants as requested by user to ensure correct labels.
     */
    public getVETable(): VEMap {
        const config = APP_CONFIG.MSS54HP.VE_TABLE;

        // Use Fixed Axes
        const xAxis = APP_CONFIG.MSS54HP.AXIS_RPM;
        const yAxis = APP_CONFIG.MSS54HP.AXIS_LOAD;

        // Read Data (24 rows x 20 cols)
        const data: number[][] = [];
        for (let row = 0; row < config.SIZE_Y; row++) {
            const rowData: number[] = [];
            for (let col = 0; col < config.SIZE_X; col++) {
                // Offset = Start + (Row * Width + Col) * 2
                const offset = config.ADDRESS_DATA + (row * config.SIZE_X + col) * 2;
                // User specified Z-axis is z/1000
                const rawValue = this.getUint16(offset);
                rowData.push(rawValue / 1000);
            }
            data.push(rowData);
        }

        return { xAxis, yAxis, data };
    }

    public getMapCorrectionStatus(): boolean {
        const val = this.getUint8(APP_CONFIG.MSS54HP.ADDRESS_MAP_CONFIG);
        // 0x02 means OFF (as per plan: 0xE5E4 = 0x02)
        // If it is NOT 0x02, it might be ON (usually 0x01 or 0x00).
        return val === 0x02;
    }

    public getTempThreshold(): number {
        const val = this.getUint8(APP_CONFIG.MSS54HP.ADDRESS_TEMP_LIMIT);
        // Value = Temp + 48. So Temp = Value - 48.
        return val - 48;
    }



    private validateOffset(offset: number, size: number) {
        if (offset + size > this.buffer.byteLength) {
            throw new Error(`Offset ${offset} out of bounds (Buffer size: ${this.buffer.byteLength})`);
        }
    }
}
