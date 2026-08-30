import { APP_CONFIG, EXPERIMENTAL_CONFIG, TANK_VENT_GAIN, LAMBDA_SHUTDOWN, COMMUNITY_WOT_FUEL_RAW,
    CSL_STOCK_MAP_DATA, CSL_STOCK_WARMUP_MAP } from '@/config/constants';
import type { LambdaLimits } from '@/lib/log-engine/lambdaGates';
import type { LtftLearnWindow } from '@/lib/log-engine/trimNeutrality';
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

    /**
     * The thresholds that decide whether the lambda controller was running — read from THIS binary.
     *
     * Never hard-coded, for the reason the WOT table demonstrates: this app patches it. A log
     * captured with the patch in force was captured with the controller deliberately kept alive at
     * full load, and the only way for the filter to know that is to read the same bytes the DME did.
     * Constants in the source would say the opposite and be confidently wrong.
     *
     * Returns null if the axes do not look like axes. A 4-point rpm axis that is not ascending is
     * either the wrong address or a binary this app does not understand, and in both cases guessing
     * a threshold would reject real samples for an invented reason.
     */
    public readLambdaLimits(): LambdaLimits | null {
        const u16s = (addr: number, n: number) =>
            Array.from({ length: n }, (_, i) => this.getUint16(addr + i * 2));
        const ascending = (a: number[]) => a.every((v, i) => i === 0 || v > a[i - 1]);

        const wotX = u16s(LAMBDA_SHUTDOWN.WOT_THRESHOLD_X, 4);
        const wotY = u16s(LAMBDA_SHUTDOWN.WOT_THRESHOLD_Y, 4);
        const loadX = u16s(LAMBDA_SHUTDOWN.LOAD_THRESHOLD_X, 7);
        if (!ascending(wotX) || !ascending(wotY) || !ascending(loadX)) return null;

        return {
            wotThreshold: {
                x: wotX,
                y: wotY,
                z: Array.from({ length: 4 }, (_, r) =>
                    u16s(LAMBDA_SHUTDOWN.WOT_THRESHOLD_Z + r * 8, 4).map(v => v / 10)),
            },
            loadThreshold: {
                x: loadX,
                y: u16s(LAMBDA_SHUTDOWN.LOAD_THRESHOLD_Y, 7).map(v => v / 1000),
            },
            fMax: this.getUint16(LAMBDA_SHUTDOWN.F_MAX) / 32768,
            fMin: this.getUint16(LAMBDA_SHUTDOWN.F_MIN) / 32768,
        };
    }

    /**
     * `K_LAA_TMOT_MIN` / `K_LAA_TMOT_MAX` — the coolant window in which the DME's long-term fuel
     * stores are allowed to learn, out of THIS binary.
     *
     * Both learners hang off it: `laa_st_calc` (slave 0x019B90) clears LAA_ST bits 1 and 2 when
     * the window fails, and the multiplicative learner (0x019E26) and the additive one (0x019F80)
     * each test one of those bits first. So an empty window freezes both, which is exactly what
     * this app's PATCH does by writing MIN = 100 degC.
     *
     * Read rather than inferred from the PATCH toggle for the reason `readLambdaLimits` gives: the
     * toggle says what the app WOULD write, and the log was recorded against whatever the ECU
     * actually held.
     */
    public readLtftLearnWindow(): LtftLearnWindow {
        const off = APP_CONFIG.MSS54HP.TEMP_LIMIT_OFFSET_C;
        return {
            tmotMin: this.getUint8(APP_CONFIG.MSS54HP.ADDRESS_TEMP_LIMIT) - off,
            tmotMax: this.getUint8(APP_CONFIG.MSS54HP.ADDRESS_TEMP_LIMIT_MAX) - off,
        };
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
    /**
     * The full-load injection-time multiplier `KF_TI_N_RF_VL`, as raw bytes.
     *
     * Raw rather than scaled, so a comparison against COMMUNITY_WOT_FUEL_RAW is exact. The scaled
     * form is `x / 128`, and the mixture it implies at full load is `lambda = 1 / (rf_korr x value)`
     * — which is what makes a drifted copy of this table worth showing rather than merely storing.
     *
     * Row 0 only. All three RF rows ship identical and `restoreWotFuel` writes them that way; a
     * binary where they disagree is not something this app produced, and reading one row keeps the
     * comparison honest about what it checked.
     */
    public readWotFuel(): number[] {
        const addr = EXPERIMENTAL_CONFIG.ADDRESS_WOT_MAP;
        return Array.from({ length: COMMUNITY_WOT_FUEL_RAW.length }, (_, i) => this.view.getUint8(addr + i));
    }

    /** Does this binary's full-load table still match the community reference? Byte for byte —
     *  a single count is 1/128 of the multiplier, which is small, and drift here is never small. */
    public wotFuelIsStock(): boolean {
        const now = this.readWotFuel();
        return COMMUNITY_WOT_FUEL_RAW.every((v, i) => v === now[i]);
    }

    /**
     * How many cells of `kf_rf_soll` differ from the CSL 0401 reference.
     *
     * A COUNT rather than a boolean, unlike the full-load table above, and the difference is not
     * cosmetic. `KF_TI_N_RF_VL` is a table nothing derives, so any drift in it is a finding. This
     * one is the table the whole app writes: a count of 6 is a tune in progress and a count of 363
     * is a campaign that has been running for a while, and the RESTORE row has to be able to say
     * which — "drift!" would be true of both and useful for neither.
     *
     * Compared on the DECODED value, not the raw word, because that is what the reference holds.
     * The encoding is exact in both directions (uint16 / 1000 with a 3-decimal reference), so this
     * is not a tolerance dressed up as an equality.
     */
    public veCellsOffStock(): number {
        const now = this.getVETable().data;
        let n = 0;
        for (let r = 0; r < CSL_STOCK_MAP_DATA.length; r++) {
            for (let c = 0; c < CSL_STOCK_MAP_DATA[r].length; c++) {
                if (now[r]?.[c] !== CSL_STOCK_MAP_DATA[r][c]) n++;
            }
        }
        return n;
    }

    /**
     * The same count for `kf_rf_soll_kath` at `0xD770`, the catalyst-warmup table.
     *
     * Read here rather than through `getVETable`: it is a different table at a different address
     * with different axes, and only the Z block shares a shape with the main one. Its rows and
     * columns are taken from the REFERENCE so the two are compared over the same extent, which is
     * also what stops a shape drift from being reported as 480 changed cells.
     */
    public warmupCellsOffStock(): number {
        const addr = EXPERIMENTAL_CONFIG.ADDRESS_WARMUP_MAP;
        const cols = CSL_STOCK_WARMUP_MAP[0].length;
        let n = 0;
        for (let r = 0; r < CSL_STOCK_WARMUP_MAP.length; r++) {
            for (let c = 0; c < cols; c++) {
                const raw = this.view.getUint16(addr + (r * cols + c) * 2);
                if (raw / 1000 !== CSL_STOCK_WARMUP_MAP[r][c]) n++;
            }
        }
        return n;
    }

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
     *
     * ## The axes are the app's own, deliberately, and this is not a bug to fix
     *
     * The binary's load axis is not the round numbers this app shows. It stores the breakpoints as
     * integers over 327.68, so `0xD326` decodes to 0.0977, 0.1465, 0.1953, 0.3906, 0.6104, 0.8057,
     * 1.0010 ... where `AXIS_LOAD` says 0.10, 0.15, 0.20, 0.40, 0.60, 0.80, 1.00. The bottom four
     * are 2.4 % apart.
     *
     * **The operator has asked for the round numbers and the request stands** (2026-08-22): these
     * are the labels down the side of every heatmap and the numbers a cell is discussed by, and
     * 0.0977 is not a load anyone means.
     *
     * The cost was measured before agreeing to it, so nobody has to guess later. Substituting the
     * binary's own axis halves the scatter of a single sample's measured rf_korr (interquartile
     * range 0.013 -> 0.007 on one drive, 0.019 -> 0.009 on another) and does NOT change what the map
     * says: per-cell agreement between two drives was 83 % within 2 % either way, and the
     * load-dependent tilt in the corrections is 2.1 % with these axes and 2.9 % with the binary's.
     * A cell averages tens of samples and the scatter averages out with them.
     *
     * So: rounder labels, identical answer, noisier individual samples. If that trade is ever
     * revisited, the axis is at `config.ADDRESS_Y_AXIS` and the scale is raw/327.68 — the
     * arithmetic is not the hard part, the labels are.
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
