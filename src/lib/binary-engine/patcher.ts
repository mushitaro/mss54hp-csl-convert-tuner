import { BinaryParser } from './parser';
import { APP_CONFIG, EXPERIMENTAL_CONFIG, CSL_STOCK_WOT_THRESHOLD_MAP, TANK_VENT_GAIN,
    COMMUNITY_WOT_FUEL_RAW, WOT_FUEL_ROWS, CSL_STOCK_MAP_DATA, CSL_STOCK_WARMUP_MAP } from '@/config/constants';
import type { VEMap } from '@/lib/types';
import type { EcuMapDef } from '@/lib/ecu-items/types';
import { analyzeDataChecksum, correctDataChecksum, DATA_PAIR_LENGTH } from '@/lib/checksum/dmeDataChecksum';
import type { ChecksumSlotResult } from '@/lib/checksum/dmeDataChecksum';

/** What `disableMapCorrection` writes, and therefore what a restore has to recognise as its own
 *  work. `k_rf_cfg = 0x02` turns MAP compensation off; `K_LAA_TMOT_MIN` at 148 raw (100 °C) puts
 *  long-term adaptation above any coolant temperature the engine reaches. */
const PATCHED_MAP_CONFIG = 0x02;
const PATCHED_TEMP_LIMIT = 148;

/** Where a restore lands when the loaded BASE was already patched and so cannot say what it held
 *  before. Community-patch values, not measurements — see restoreByte for why they are a last
 *  resort rather than the answer. */
const STOCK_MAP_CONFIG_FALLBACK = 0x12;
const STOCK_TEMP_LIMIT_FALLBACK = 117;   // 69 °C + 48

export class BinaryPatcher extends BinaryParser {
    /**
     * The bytes as loaded, before anything in this class touched them.
     *
     * Exists so "restore" can mean restore. The reverse of every toggle here used to write a
     * constant transcribed from one reference car — `enableMapCorrection` wrote `k_rf_cfg = 0x12`
     * and `K_LAA_TMOT_MIN = 69 °C`, `setWOTThreshold(false)` wrote a whole 4×4 table — and
     * `buildPatchedBuffer` calls both on every build, including the plain BASE download. So a user
     * whose binary held 0x01 and 80 °C had them silently replaced by someone else's numbers merely
     * by downloading their own BASE with PATCH off, and the checksum correction then made the
     * result a valid image with nothing to notice.
     *
     * A copy rather than the caller's buffer: `super(buffer.slice(0))` hands the parent a clone to
     * mutate, and this is a second, untouched one.
     */
    private readonly original: Uint8Array;

    constructor(buffer: ArrayBuffer) {
        super(buffer.slice(0)); // Clone buffer to avoid mutating original source if needed
        this.original = new Uint8Array(buffer.slice(0));
    }

    /**
     * One byte, checked.
     *
     * The comment here used to say "validate bounds omitted for brevity, view will throw", and that
     * is not what a DataView does. It throws on an out-of-range OFFSET only; an out-of-range VALUE
     * is truncated modulo the field width and `NaN` is written as 0, both silently. In a class
     * whose output is flashed to an ECU that is the wrong way round — the read path
     * (`BinaryParser.validateOffset`) is stricter than the write path was.
     */
    public setUint8(offset: number, value: number): void {
        this.assertWritable(offset, value, 0xFF);
        this.view.setUint8(offset, value);
    }

    public setUint16(offset: number, value: number): void {
        this.assertWritable(offset, value, 0xFFFF);
        this.view.setUint16(offset, value, false); // Big Endian
    }

    /**
     * One contiguous run of raw values, big-endian — the calibration editor's writer.
     *
     * Signed raws arrive already two's-complement encoded (lib/calibration/apply.ts does the
     * encoding), so every word here is an unsigned field value and assertWritable applies per
     * word. Bounds, checksum-slot exclusion and writer-conflict arbitration all happen in
     * apply.ts BEFORE this is called; this method is the byte boundary, not the policy.
     */
    public setRawRun(address: number, bits: 8 | 16, raws: number[]): void {
        const bytes = bits / 8;
        raws.forEach((raw, i) => {
            if (bits === 8) this.setUint8(address + i * bytes, raw);
            else this.setUint16(address + i * bytes, raw);
        });
    }

    /** Refuses what `DataView` would have quietly mangled. Per-writer clamps stay where they are —
     *  this is the floor under them, not a replacement for them. */
    private assertWritable(offset: number, value: number, max: number): void {
        if (!Number.isInteger(value) || value < 0 || value > max) {
            throw new Error(
                `Refusing to write ${value} at 0x${offset.toString(16)}: not an integer in 0..${max}. `
                + 'DataView would have truncated it modulo the field width, or written NaN as 0.');
        }
    }

    /**
     * Puts one byte back to what the loaded binary held — or to a stated stock value when the
     * loaded binary was itself already patched and therefore cannot answer.
     *
     * The two cases are genuinely different and both have to work:
     *
     *  - **BASE unpatched.** The byte is this car's own calibration and nothing here has any
     *    business replacing it. Restoring the snapshot is the whole fix.
     *  - **BASE already patch-on.** Its own byte IS the patch, so restoring it would make the
     *    toggle inert and there would be no way back off a patched binary. The documented stock
     *    value is the only thing left to go on, and it is used only here.
     */
    private restoreByte(address: number, patchedValue: number, stockFallback: number): void {
        const asLoaded = this.original[address];
        this.setUint8(address, asLoaded === patchedValue ? stockFallback : asLoaded);
    }

    public disableMapCorrection(): void {
        // Set k_rf_cfg (0xE5E4) to 0x02
        this.setUint8(APP_CONFIG.MSS54HP.ADDRESS_MAP_CONFIG, PATCHED_MAP_CONFIG);
        // Set Temp Limit to 100C (disabled adaptation behavior)
        // Formula: val = temp + 48 -> 100 + 48 = 148
        this.setUint8(APP_CONFIG.MSS54HP.ADDRESS_TEMP_LIMIT, PATCHED_TEMP_LIMIT);
    }

    /** Undoes `disableMapCorrection`. See restoreByte: this puts back what the loaded binary held,
     *  and only falls back to the community values when the loaded binary was already patched. */
    public enableMapCorrection(): void {
        this.restoreByte(APP_CONFIG.MSS54HP.ADDRESS_MAP_CONFIG, PATCHED_MAP_CONFIG, STOCK_MAP_CONFIG_FALLBACK);
        this.restoreByte(APP_CONFIG.MSS54HP.ADDRESS_TEMP_LIMIT, PATCHED_TEMP_LIMIT, STOCK_TEMP_LIMIT_FALLBACK);
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
        this.setVETableData(map.data);
    }

    /**
     * The same write, taking only the grid.
     *
     * Exists because `setVETable` never reads the axes — it writes data and nothing else — so a
     * caller holding a derived grid had to fabricate a VEMap with empty axes and cast it. That cast
     * is a statement that the axes do not matter, made in the one place where nobody would look to
     * find out whether it is still true.
     */
    public setVETableData(data: number[][]): void {
        const map = { data } as VEMap;
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
     *
     * Clamped exactly as `setVETable` is, and for the same reason: the storage is uint16 at 1/1000,
     * so a cell past 65.535 wraps modulo 65536 and lands back near zero — a catastrophically LEAN
     * cell produced by an overflow. That argument is written out in full on VE_MAX and applies here
     * unchanged; this writer simply never had the guard.
     *
     * The scaling is still assumed to match the main table (uint16 / 1000) and has not been checked
     * against the XDF. That is why the feature is EXPERIMENTAL and why the clamp matters more here
     * than there: if the assumption is wrong every cell is wrong by an unknown factor, and the
     * clamp is what keeps "wrong" from becoming "wrapped".
     */
    public setWarmupTable(map: VEMap): void {
        const addr = EXPERIMENTAL_CONFIG.ADDRESS_WARMUP_MAP;
        if (addr === 0x0000) return;

        // Iterate Rows (Load) -> Cols (RPM)
        for (let r = 0; r < map.data.length; r++) {
            for (let c = 0; c < map.data[0].length; c++) {
                const raw = map.data[r][c];
                // Number.isFinite first: Math.round(NaN) is NaN, which DataView writes as 0 — a
                // zero-filling cell, which is the same failure as the wrap and just as quiet.
                const value = Number.isFinite(raw)
                    ? Math.min(BinaryPatcher.VE_MAX, Math.max(0, raw))
                    : 0;
                this.setUint16(addr + (r * map.data[0].length + c) * 2, Math.round(value * 1000));
            }
        }
    }

    /**
     * [EXPERIMENTAL] Writes the autogenerated WOT Map to binary.
     * Dimensions: 3 Rows x 18 Cols.
     * Address: 0xB5A.
     * Scaling: x/128 (uint8).
     */
    /**
     * Puts `KF_TI_N_RF_VL` back to what the community patch ships.
     *
     * A restore, not a derivation. The function that used to live here computed a "new" table as
     * `stock x (newVE / stockVE)` and that is wrong in the dangerous direction — see
     * COMMUNITY_WOT_FUEL_RAW for the arithmetic and for the car it was found on. There is no
     * correct way to derive this table from a VE log, because the VE correction already IS the
     * fuel correction; this table only sets the ratio.
     *
     * Writes all three RF rows from one reference row, which is how the calibration ships and what
     * makes the table one-dimensional in rpm. Byte for byte, so a restored table is bit-identical
     * to the reference and `readWotFuel` reports no drift afterwards.
     */
    public restoreWotFuel(): void {
        const addr = EXPERIMENTAL_CONFIG.ADDRESS_WOT_MAP;
        if (addr === 0x0000) return;
        for (let r = 0; r < WOT_FUEL_ROWS; r++) {
            for (let c = 0; c < COMMUNITY_WOT_FUEL_RAW.length; c++) {
                this.setUint8(addr + r * COMMUNITY_WOT_FUEL_RAW.length + c, COMMUNITY_WOT_FUEL_RAW[c]);
            }
        }
    }

    /**
     * Puts `kf_rf_soll` back to the CSL 0401 reference — the whole 24 x 20 table.
     *
     * The reference is `CSL_STOCK_MAP_DATA`, and it is a reference rather than a transcription:
     * every one of its 480 cells is bit-identical to `0xD356` in the community partial this repo
     * ships (`public/mock/csl-0401-community-patch-v1.partial.bin`), checked cell for cell. The
     * comment beside it in constants.ts used to say the opposite — that it was "not any particular
     * car's stock map once a campaign has run" — on the strength of 363 cells differing. Those 363
     * are the difference between the REFERENCE and session #920's CAR, which is the measurement
     * this restore exists to undo, not a defect in the reference.
     *
     * Goes through `setVETableData`, so the same VE_MAX clamp and the same uint16 x/1000 encoding
     * apply. A restored table therefore reads back byte-identical to the reference.
     *
     * ONE-WAY, like `restoreWotFuel`: there is no derived value and no "off" direction. Arming it
     * writes the reference; leaving it alone writes nothing. It is mutually exclusive with the
     * derivations that own this table (ALPHA-N, SHAPE) — see the manifest rows in page.tsx, where
     * arming either side locks the other. Writing a tune and stock into the same bytes in one flash
     * is not a request with an answer.
     */
    public restoreVeTable(): void {
        this.setVETableData(CSL_STOCK_MAP_DATA.map(row => [...row]));
    }

    /**
     * Puts `kf_rf_soll_kath` — the catalyst-warmup table at `0xD770` — back to the CSL 0401
     * reference.
     *
     * A DIFFERENT table from `kf_rf_soll` with DIFFERENT axes: X `0xD718` runs 600-4600 rpm against
     * the main table's 600-7900, and Y `0xD740` has no 0.146 % row. Only the Z block is written
     * here, so none of that matters to the restore — but it is why the two must never be matched up
     * by row number (66-tuning-methodology.md §5).
     *
     * Unlike the main table, this one's scaling was in doubt when WARMUP shipped. It is not any
     * more: the stock `kf_rf_soll_kath` decoded from the XDF matches `CSL_STOCK_WARMUP_MAP` in all
     * 480 cells, and so does the community partial at `0xD770`. So the reference is bytes, the
     * address is confirmed, and uint16 x/1000 is confirmed with it.
     */
    public restoreWarmupTable(): void {
        this.setWarmupTable({ data: CSL_STOCK_WARMUP_MAP.map(row => [...row]) } as VEMap);
    }

    /**
     * Holds the tank-vent (evaporative purge) valve shut, or puts it back to stock.
     *
     * One byte. `K_TE_TVTE_GA` is the gain on the duty that `tetv_calc` computes, and its only
     * reader in the binary is that function; with the gain at zero the result falls to K_TE_TV_MIN
     * and the `<= K_TE_TV_MIN` branch forces exactly zero, so this is "shut", not "minimum duty".
     *
     * Why a tuning tool touches an emissions device: purged vapour is fuel the DME did not inject,
     * so the lambda controller trims for it — and `la_f_regler` is the single input this app derives
     * the whole VE correction from. Session #902 measured the valve open for 82.8 % of a drive. The
     * trims from a run like that are correct for a reason the VE map cannot reproduce.
     *
     * TUNING ONLY, and the toggle that reaches this says so. Restoring is the same call with
     * `disable = false`, and it goes through `restoreByte`: a binary whose gain was 0x40 — purge at
     * half gain, which is legitimate calibration and not "sort of disabled" — gets its 0x40 back
     * rather than this app's idea of stock. `TANK_VENT_GAIN.STOCK_RAW` remains the answer for a
     * binary that arrived already shut, which is the only case with nothing else to go on.
     */
    public setTankVentDisable(disable: boolean): void {
        if (disable) {
            this.setUint8(TANK_VENT_GAIN.ADDRESS, TANK_VENT_GAIN.DISABLED_RAW);
            return;
        }
        this.restoreByte(TANK_VENT_GAIN.ADDRESS, TANK_VENT_GAIN.DISABLED_RAW, TANK_VENT_GAIN.STOCK_RAW);
    }

    /**
     * Holds KF_BZ_WDK_VL above 100 % so full-load enrichment can never engage, or puts it back.
     *
     * 4×4 uint16 at x/10. Disabling writes 102.3 % into all sixteen; restoring writes back the
     * sixteen the binary was loaded with, and only falls back to `CSL_STOCK_WOT_THRESHOLD_MAP` when
     * the loaded table was itself already disabled — the same rule as `restoreByte`, for the same
     * reason, and it matters more here because this is 32 bytes rather than one.
     *
     * It matters twice over: `readLambdaLimits` reads this exact table back out to decide which log
     * samples were taken under full load, so overwriting it does not merely change the calibration,
     * it changes how the app classifies every drive recorded against it.
     */
    public setWOTThreshold(disable: boolean): void {
        const addr = EXPERIMENTAL_CONFIG.ADDRESS_WOT_THRESHOLD_MAP;
        if (addr === 0x0000) return;

        const DISABLED_RAW = 1023;   // 102.3 %, above anything the throttle can report

        // As loaded, so a restore has something true to go back to.
        const asLoaded: number[] = [];
        for (let i = 0; i < 16; i++) {
            asLoaded.push((this.original[addr + i * 2] << 8) | this.original[addr + i * 2 + 1]);
        }
        const wasDisabled = asLoaded.every(v => v > 1000);

        const raws = disable
            ? asLoaded.map(() => DISABLED_RAW)
            : wasDisabled
                ? CSL_STOCK_WOT_THRESHOLD_MAP.flat().map(v => Math.round(v * 10))
                : asLoaded;

        raws.forEach((raw, i) => this.setUint16(addr + i * 2, raw));
    }
}

/**
 * The bytes the DME was RUNNING: a BASE, plus the logic patches that were armed against it.
 *
 * ## Why this is not the BASE, and not the TUNED either
 *
 * A session stores its BASE unpatched and rebuilds the tune from it — that is the safeguard against
 * re-applying a correction to an already-corrected map (V0*C^2), and it must stay. But the log was
 * not recorded against those bytes. It was recorded against the car AFTER `WRITE PATCH-ON`, and one
 * of the things that write changes is `KF_BZ_WDK_VL`.
 *
 * `readLambdaLimits` reads `KF_BZ_WDK_VL` back out to decide which samples were taken at full load —
 * see `setWOTThreshold` above, whose own doc says overwriting that table "changes how the app
 * classifies every drive recorded against it". Patched, every cell reads 102.3 % and the gate is
 * inert, which is the entire point of the patch; stock, it reads 35-65 % and rejects the pulls. So a
 * log replayed against the raw BASE is filtered through thresholds the DME was not running, and the
 * same drive produces a different VE map depending on whether you were still in the session or had
 * reopened it. That is the divergence this exists to close.
 *
 * ## No checksum correction, deliberately
 *
 * These bytes are read and thrown away. Nothing writes them to an ECU, a file or the store — the
 * caller wants a calibration to interpret a log with, not an image to flash — and the DME's data
 * checksum is not consulted by any reader here. Leaving it alone also keeps this cheap enough to sit
 * behind a `useMemo` that re-runs whenever a toggle moves.
 *
 * Every OFF direction is a true restore rather than a write of reference-car constants, so with all
 * three false this returns the BASE unchanged in the regions it touches. See `restoreByte` and
 * `setWOTThreshold` for why that distinction exists and what it cost when it did not.
 */
export interface LogicPatches {
    applyPatch: boolean;
    applyWotDisable: boolean;
    applyTankVentDisable: boolean;
}

export function bytesAsRun(base: ArrayBuffer, patches: LogicPatches): ArrayBuffer {
    const patcher = new BinaryPatcher(base);
    if (patches.applyPatch) patcher.disableMapCorrection();
    else patcher.enableMapCorrection();
    patcher.setWOTThreshold(patches.applyWotDisable);
    patcher.setTankVentDisable(patches.applyTankVentDisable);
    return patcher.getBuffer();
}

/**
 * The same three patches, as an image meant to LEAVE the app — checksum corrected.
 *
 * `bytesAsRun` above is a reading of the calibration the DME was running, thrown away after the log
 * is interpreted, and its doc says outright that it does not correct the checksum. These bytes are
 * the opposite: a file to keep or to flash, so the correction is the difference between the two
 * functions and the reason this is not a flag on that one.
 *
 * It exists because PATCH-ON is a THIRD artifact. A session stores its BASE unpatched and its TUNED
 * fully built, and the image in between — the BASE with the logic patches on, which is what goes
 * into the car before a log run — was only ever available live, from the toggles of the open
 * session. A session that started from an unpatched BASE and wrote PATCH-ON had no way to hand back
 * the bytes it actually flashed (operator, 2026-08-25).
 *
 * Rebuilt rather than stored, on the same terms the tune is: `WRITE PATCH-ON` builds from the BASE
 * through this same patcher, so the same BASE and the same three booleans give the same bytes.
 */
export function patchOnImage(base: ArrayBuffer, patches: LogicPatches): ArrayBuffer {
    const patcher = new BinaryPatcher(base);
    if (patches.applyPatch) patcher.disableMapCorrection();
    else patcher.enableMapCorrection();
    patcher.setWOTThreshold(patches.applyWotDisable);
    patcher.setTankVentDisable(patches.applyTankVentDisable);
    // Last, after every other byte has moved — the same order buildPatchedBuffer uses.
    patcher.applyChecksumCorrection();
    return patcher.getBuffer();
}

/**
 * Which logic patches a stored image is carrying, read back out of the bytes.
 *
 * The same four questions `useBinaryFile` asks when a BASE arrives, in one place so the session
 * list can ask them of bytes it never loaded into the workspace. PATCH is two bytes agreeing —
 * the map correction off AND the temperature limit raised — because either alone is a half-applied
 * patch and not the state WRITE PATCH-ON leaves.
 */
export function readLogicPatches(image: ArrayBuffer): LogicPatches {
    const parser = new BinaryParser(image);
    return {
        applyPatch: parser.getMapCorrectionStatus() && parser.getTempThreshold() >= 99,
        applyWotDisable: parser.getWOTThresholdStatus(),
        applyTankVentDisable: parser.getTankVentDisabled(),
    };
}
