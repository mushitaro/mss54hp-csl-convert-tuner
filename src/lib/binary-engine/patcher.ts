import { BinaryParser } from './parser';
import { APP_CONFIG, EXPERIMENTAL_CONFIG, CSL_STOCK_WOT_THRESHOLD_MAP } from '@/config/constants';
import { VEMap } from '@/lib/types';
import type { EcuMapDef } from '@/lib/ecu-items/types';
import { analyzeDataChecksum, correctDataChecksum, DATA_PAIR_LENGTH } from '@/lib/checksum/dmeDataChecksum';
import type { ChecksumSlotResult } from '@/lib/checksum/dmeDataChecksum';

export class BinaryPatcher extends BinaryParser {
    constructor(buffer: ArrayBuffer) {
        super(buffer.slice(0)); // Clone buffer to avoid mutating original source if needed
    }

    public setUint8(offset: number, value: number): void {
        // Validate bounds omitted for brevity, view will throw
        this.view.setUint8(offset, value);
    }

    public setUint16(offset: number, value: number): void {
        this.view.setUint16(offset, value, false); // Big Endian
    }

    public disableMapCorrection(): void {
        // Set k_rf_cfg (0xE5E4) to 0x02
        this.setUint8(APP_CONFIG.MSS54HP.ADDRESS_MAP_CONFIG, 0x02);
        // Set Temp Limit to 100C (disabled adaptation behavior)
        // Formula: val = temp + 48 -> 100 + 48 = 148
        this.setUint8(APP_CONFIG.MSS54HP.ADDRESS_TEMP_LIMIT, 148);
    }

    public enableMapCorrection(): void {
        // Restore to Stock/Initial
        // User Request: MAF = 0x12
        this.setUint8(APP_CONFIG.MSS54HP.ADDRESS_MAP_CONFIG, 0x12);

        // User Request: LTFT = 69 (deg C)
        // Formula: val = temp + 48. 69 + 48 = 117 (0x75)
        this.setUint8(APP_CONFIG.MSS54HP.ADDRESS_TEMP_LIMIT, 117);
    }

    public setTempThreshold(tempCelsius: number): void {
        // Value = Temp + 48
        const val = tempCelsius + 48;
        this.setUint8(APP_CONFIG.MSS54HP.ADDRESS_TEMP_LIMIT, val);
    }

    /**
     * Largest filling this app will write into the VE table, dimensionless (1.0 = 100 %).
     *
     * The storage is uint16 at 1/1000, so anything past 65.535 wraps modulo 65536 and a runaway
     * cell lands back near zero — a catastrophically LEAN cell produced by an overflow, which is
     * the worst failure this file could have. 4.0 is far above anything an S54 can reach and far
     * below the wrap, so it turns a runaway into an obviously-wrong number instead of a quiet one.
     */
    private static readonly VE_MAX = 4.0;

    public setVETable(map: VEMap): void {
        const config = APP_CONFIG.MSS54HP.VE_TABLE;

        // We only write DATA, not axes (usually axes are fixed/read-only or we don't need to change them)
        // Writing 24 rows x 20 cols
        for (let row = 0; row < config.SIZE_Y; row++) {
            for (let col = 0; col < config.SIZE_X; col++) {
                const offset = config.ADDRESS_DATA + (row * config.SIZE_X + col) * 2;
                // User specified Z-axis is z/1000, so we write back value * 1000
                const value = Math.min(BinaryPatcher.VE_MAX, Math.max(0, map.data[row][col]));
                this.setUint16(offset, Math.round(value * 1000)); // Ensure integer
            }
        }
    }

    /**
     * Writes the VALUES of a catalog map. Axes are never touched.
     *
     * That restriction is the point rather than an omission: a table's values only mean anything
     * against the breakpoints they were computed on, and the back-calculated KF_RF_KORR_DRREL is
     * binned on the Δ axis read out of these very bytes. Moving a breakpoint would silently
     * re-label every value beside it.
     *
     * `bounds` is in physical units and is the caller's statement of what this table may hold —
     * enforced here, at the last point before bytes, so no path can reach the flash around it.
     * The raw value is clamped to the storage width as well, because a scaling function is an
     * arbitrary expression and its inverse need not land inside the field.
     *
     * The caller is responsible for running applyChecksumCorrection() afterwards.
     */
    public setEcuMapValues(def: EcuMapDef, values: number[][], bounds: { min: number; max: number }): void {
        const { rows, cols, bits, address, scaling } = def.values;
        if (values.length !== rows || values.some(r => r.length !== cols)) {
            throw new Error(
                `${def.symbol}: expected ${rows}x${cols}, got ${values.length}x${values[0]?.length ?? 0}`);
        }

        const step = bits / 8;
        const fieldMax = bits === 8 ? 0xFF : 0xFFFF;

        // Clamp in RAW, not in physical. Clamping the physical value and then rounding leaves the
        // stored number up to half an LSB outside the bound the caller asked for — 1.40 goes in and
        // 1.4004 comes back out. Half an LSB does not matter here, but "the bound is respected" is
        // the kind of claim that should be true rather than nearly true, since it is the last thing
        // standing between a derived table and the flash.
        //
        // Both ends are mapped and then ordered, because a scaling equation is arbitrary: `25.6/x`
        // is decreasing, so its toRaw sends the physical minimum to the raw MAXIMUM.
        // Rounded INWARD — ceil the low end, floor the high one — so a bound that falls between
        // two representable values resolves to the side that stays inside it.
        const a = scaling.toRaw(bounds.min);
        const b = scaling.toRaw(bounds.max);
        const rawLo = Math.max(0, Math.ceil(Math.min(a, b)));
        const rawHi = Math.max(rawLo, Math.min(fieldMax, Math.floor(Math.max(a, b))));

        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const physical = Math.min(bounds.max, Math.max(bounds.min, values[r][c]));
                const raw = Math.min(rawHi, Math.max(rawLo, Math.round(scaling.toRaw(physical))));
                const at = address + (r * cols + c) * step;
                if (bits === 8) this.setUint8(at, raw); else this.setUint16(at, raw);
            }
        }
    }

    public getPatchedBuffer(): ArrayBuffer {
        return this.buffer;
    }

    /**
     * Recalculates and writes the MSS54HP data-pair checksum (slave @ 0x3FFC, master @ 0xBFFC).
     * No-ops for buffer sizes other than the confirmed 65536-byte "0401 partial BIN" format.
     */
    public applyChecksumCorrection(): ChecksumSlotResult[] | null {
        if (this.uint8Array.length !== DATA_PAIR_LENGTH) return null;
        const before = analyzeDataChecksum(this.uint8Array);
        correctDataChecksum(this.uint8Array);
        return before;
    }

    /**
     * [EXPERIMENTAL] Writes the autogenerated Warmup Map to binary.
     * Assumes 20x24 Dimension (Standard VE).
     */
    public setWarmupTable(map: VEMap): void {
        const addr = EXPERIMENTAL_CONFIG.ADDRESS_WARMUP_MAP;
        if (addr === 0x0000) return;

        // Iterate Rows (Load) -> Cols (RPM)
        for (let r = 0; r < map.data.length; r++) {
            for (let c = 0; c < map.data[0].length; c++) {
                const val = map.data[r][c];
                // Scaling: Likely uint16 * 1000 like main table?
                // Screenshot suggests 0.xx range. Main table is 0.xx range.
                // Assuming Main Table scaling holds for now (uint16 / 1000).
                // TODO: Verify scaling if different.
                this.setUint16(addr + (r * map.data[0].length + c) * 2, Math.round(val * 1000));
            }
        }
    }

    /**
     * [EXPERIMENTAL] Writes the autogenerated WOT Map to binary.
     * Dimensions: 3 Rows x 18 Cols.
     * Address: 0xB5A.
     * Scaling: x/128 (uint8).
     */
    public setWOTMap(map: number[][]): void {
        const addr = EXPERIMENTAL_CONFIG.ADDRESS_WOT_MAP;
        if (addr === 0x0000) return;

        let offset = 0;
        for (let r = 0; r < map.length; r++) {
            for (let c = 0; c < map[0].length; c++) {
                const val = map[r][c];
                // Scaling: val = raw / 128  => raw = val * 128
                const raw = Math.round(val * 128);
                // Clamp to uint8 limit
                const clamped = Math.min(255, Math.max(0, raw));

                this.setUint8(addr + offset, clamped);
                offset++;
            }
        }
    }

    public setWOTThreshold(disable: boolean): void {
        const addr = EXPERIMENTAL_CONFIG.ADDRESS_WOT_THRESHOLD_MAP;
        if (addr === 0x0000) return;

        // 4x4 Map = 16 values. Uint16.
        // Scaling x/10.
        // Disable -> Set to >100% (e.g. 102.3% = 1023) to prevent WOT activation.
        // Enable -> Restore Stock

        const mapData = disable
            ? Array(4).fill(Array(4).fill(102.3)) // > 100%
            : CSL_STOCK_WOT_THRESHOLD_MAP;

        let offset = 0;
        for (let r = 0; r < 4; r++) {
            for (let c = 0; c < 4; c++) {
                const val = mapData[r][c];
                const raw = Math.round(val * 10);
                this.setUint16(addr + offset, raw);
                offset += 2; // 2 bytes per value
            }
        }
    }
}
