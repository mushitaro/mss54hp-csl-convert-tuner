/**
 * The patcher's writers, at the byte level — and above all, what "restore" restores.
 *
 * Every toggle in `buildPatchedBuffer` is written in BOTH directions on every build, including a
 * plain BASE download with nothing armed. So the OFF direction is not a rarely-taken branch; it
 * runs constantly, over the user's own calibration, and the checksum correction afterwards makes
 * whatever it wrote a valid image that the DME will accept without complaint.
 *
 * It used to write constants transcribed from one reference car: `enableMapCorrection` put
 * `k_rf_cfg = 0x12` and `K_LAA_TMOT_MIN = 69 °C` into every binary, and `setWOTThreshold(false)`
 * put 32 bytes of somebody else's KF_BZ_WDK_VL there. A binary holding 0x01 and 80 °C lost them by
 * being downloaded. That table is also what `readLambdaLimits` reads back to decide which log
 * samples were taken at full load, so overwriting it silently changes how a drive is classified.
 *
 * The rule these checks pin: restore what the binary was loaded with; fall back to a stated stock
 * value only when the loaded binary was itself already patched and so cannot say.
 */
import { BinaryPatcher, patchOnImage, readLogicPatches } from '../src/lib/binary-engine/patcher.ts';
import { BinaryParser } from '../src/lib/binary-engine/parser.ts';
import { APP_CONFIG, EXPERIMENTAL_CONFIG, TANK_VENT_GAIN, CSL_STOCK_WOT_THRESHOLD_MAP } from '../src/config/constants.ts';
import { analyzeDataChecksum } from '../src/lib/checksum/dmeDataChecksum.ts';

let fails = 0;
const check = (n, c, d) => { console.log('  ' + (c ? 'PASS' : 'FAIL') + '  ' + n + (c ? '' : ' — ' + d)); if (!c) fails++; };

const MAP_CFG = APP_CONFIG.MSS54HP.ADDRESS_MAP_CONFIG;
const TEMP_LIMIT = APP_CONFIG.MSS54HP.ADDRESS_TEMP_LIMIT;
const WOT_THR = EXPERIMENTAL_CONFIG.ADDRESS_WOT_THRESHOLD_MAP;

/** A 64 KB image with recognisable filler, so any unintended write shows up as a changed byte. */
const fresh = (overrides = {}) => {
    const b = new Uint8Array(0x10000);
    for (let i = 0; i < b.length; i++) b[i] = i & 0xFF;
    // A car that is NOT the reference car: its own values, none of them the patched ones.
    b[MAP_CFG] = 0x01;
    b[TEMP_LIMIT] = 128;          // 80 °C
    b[TANK_VENT_GAIN.ADDRESS] = 0x40;   // purge at half gain — legitimate calibration
    for (let i = 0; i < 16; i++) { b[WOT_THR + i * 2] = 0x01; b[WOT_THR + i * 2 + 1] = 0x90; }  // 40.0 %
    for (const [addr, val] of Object.entries(overrides)) b[Number(addr)] = val;
    return b;
};
const patcherOn = (bytes) => new BinaryPatcher(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
const diff = (a, b) => { const out = []; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) out.push(i); return out; };
const u16 = (b, at) => (b[at] << 8) | b[at + 1];

console.log('\n[PATCH on: the documented bytes, and only those]');
{
    const before = fresh();
    const p = patcherOn(before);
    p.disableMapCorrection();
    const after = new Uint8Array(p.getBuffer());
    check('k_rf_cfg = 0x02', after[MAP_CFG] === 0x02);
    check('K_LAA_TMOT_MIN = 148 raw (100 °C)', after[TEMP_LIMIT] === 148);
    check('exactly two bytes moved', diff(before, after).length === 2, JSON.stringify(diff(before, after)));
}

console.log('\n[PATCH off, on a binary that was never patched — the bug]');
{
    // This is the case that ran on every BASE download. It must change nothing at all.
    const before = fresh();
    const p = patcherOn(before);
    p.enableMapCorrection();
    const after = new Uint8Array(p.getBuffer());
    check("k_rf_cfg keeps this car's 0x01", after[MAP_CFG] === 0x01,
        `got 0x${after[MAP_CFG].toString(16)} — a reference car's value overwrote it`);
    check('K_LAA_TMOT_MIN keeps 80 °C', after[TEMP_LIMIT] === 128,
        `got ${after[TEMP_LIMIT]} raw = ${after[TEMP_LIMIT] - 48} °C`);
    check('not one byte moved', diff(before, after).length === 0, JSON.stringify(diff(before, after)));
}

console.log('\n[PATCH off, on a binary that arrived patched — the toggle must still work]');
{
    const before = fresh({ [MAP_CFG]: 0x02, [TEMP_LIMIT]: 148 });
    const p = patcherOn(before);
    p.enableMapCorrection();
    const after = new Uint8Array(p.getBuffer());
    check('k_rf_cfg falls back to 0x12', after[MAP_CFG] === 0x12);
    check('K_LAA_TMOT_MIN falls back to 117 raw (69 °C)', after[TEMP_LIMIT] === 117);
}

console.log('\n[PATCH on then off is a round trip]');
{
    const before = fresh();
    const p = patcherOn(before);
    p.disableMapCorrection();
    p.enableMapCorrection();
    const after = new Uint8Array(p.getBuffer());
    check('byte-identical to what was loaded', diff(before, after).length === 0, JSON.stringify(diff(before, after)));
}

console.log('\n[WOT threshold: 32 bytes, same rule]');
{
    const before = fresh();
    const p = patcherOn(before);
    p.setWOTThreshold(true);
    const on = new Uint8Array(p.getBuffer());
    check('all sixteen read 102.3 %', Array.from({ length: 16 }, (_, i) => u16(on, WOT_THR + i * 2)).every(v => v === 1023));
    check('exactly 32 bytes moved', diff(before, on).length === 32, String(diff(before, on).length));
    check('parser calls it disabled', new BinaryParser(on.buffer).getWOTThresholdStatus() === true);
}
{
    const before = fresh();
    const p = patcherOn(before);
    p.setWOTThreshold(false);
    const after = new Uint8Array(p.getBuffer());
    check("an unpatched table keeps this car's 40.0 %", diff(before, after).length === 0,
        `${diff(before, after).length} byte(s) overwritten with the reference table`);
}
{
    const before = fresh();
    const p = patcherOn(before);
    p.setWOTThreshold(true);
    p.setWOTThreshold(false);
    const after = new Uint8Array(p.getBuffer());
    check('on then off is a round trip', diff(before, after).length === 0, JSON.stringify(diff(before, after).slice(0, 8)));
}
{
    // A BASE read off a car that already had the WOT patch: OFF has nothing to go back to but the
    // community table, and must use it rather than leaving the car unable to make full load.
    const disabled = fresh();
    for (let i = 0; i < 16; i++) { disabled[WOT_THR + i * 2] = 0x03; disabled[WOT_THR + i * 2 + 1] = 0xFF; }
    const p = patcherOn(disabled);
    p.setWOTThreshold(false);
    const after = new Uint8Array(p.getBuffer());
    const expected = CSL_STOCK_WOT_THRESHOLD_MAP.flat().map(v => Math.round(v * 10));
    check('falls back to the stock table', expected.every((v, i) => u16(after, WOT_THR + i * 2) === v));
    check('and it is no longer disabled', new BinaryParser(after.buffer).getWOTThresholdStatus() === false);
}

console.log('\n[tank vent: a half-gain calibration is not "sort of disabled"]');
{
    const before = fresh();   // gain 0x40
    const p = patcherOn(before);
    p.setTankVentDisable(false);
    const after = new Uint8Array(p.getBuffer());
    check('0x40 survives a restore', after[TANK_VENT_GAIN.ADDRESS] === 0x40,
        `got 0x${after[TANK_VENT_GAIN.ADDRESS].toString(16)}`);
}
{
    const shut = fresh({ [TANK_VENT_GAIN.ADDRESS]: TANK_VENT_GAIN.DISABLED_RAW });
    const p = patcherOn(shut);
    p.setTankVentDisable(false);
    const after = new Uint8Array(p.getBuffer());
    check('a shut valve falls back to stock gain', after[TANK_VENT_GAIN.ADDRESS] === TANK_VENT_GAIN.STOCK_RAW);
}

console.log('\n[the writers refuse what DataView would have mangled]');
{
    const p = patcherOn(fresh());
    const threw = (fn) => { try { fn(); return false; } catch { return true; } };
    check('setUint8 refuses 256', threw(() => p.setUint8(0x100, 256)));
    check('setUint8 refuses NaN', threw(() => p.setUint8(0x100, NaN)));
    check('setUint16 refuses 65536', threw(() => p.setUint16(0x100, 65536)));
    check('setUint16 refuses a fraction', threw(() => p.setUint16(0x100, 1.5)));
    check('and still takes a legal value', !threw(() => p.setUint16(0x100, 1023)));
}

console.log('\n[VE and warmup tables clamp rather than wrap]');
{
    const grid = (v) => ({ xAxis: [], yAxis: [], data: Array.from({ length: 24 }, () => Array(20).fill(v)) });
    const cfg = APP_CONFIG.MSS54HP.VE_TABLE;
    const p = patcherOn(fresh());
    // 70.0 would be 70000 raw: past 65535, so it wraps to 4464 — a cell reading 4.464 instead of
    // 70, which is the quiet catastrophic-lean failure VE_MAX exists to prevent.
    p.setVETable(grid(70));
    const after = new Uint8Array(p.getBuffer());
    check('VE clamps to 4.0, not 70', u16(after, cfg.ADDRESS_DATA) === 4000, String(u16(after, cfg.ADDRESS_DATA)));
}
{
    const grid = (v) => ({ xAxis: [], yAxis: [], data: Array.from({ length: 24 }, () => Array(20).fill(v)) });
    const addr = EXPERIMENTAL_CONFIG.ADDRESS_WARMUP_MAP;
    {
        const p = patcherOn(fresh());
        p.setWarmupTable(grid(70));
        check('warmup clamps to 4.0 too', u16(new Uint8Array(p.getBuffer()), addr) === 4000,
            String(u16(new Uint8Array(p.getBuffer()), addr)));
    }
    {
        const p = patcherOn(fresh());
        p.setWarmupTable(grid(NaN));
        check('warmup writes 0 for NaN rather than throwing', u16(new Uint8Array(p.getBuffer()), addr) === 0);
    }
}

console.log('\n[checksum last, and idempotent]');
{
    const p = patcherOn(fresh());
    p.disableMapCorrection();
    p.setTankVentDisable(true);
    p.applyChecksumCorrection();
    const once = new Uint8Array(p.getBuffer());
    check('the image validates afterwards', analyzeDataChecksum(once).every(s => s.stored === s.calculated),
        JSON.stringify(analyzeDataChecksum(once)));

    // Running it twice must not move anything: the correction is what makes "checksum last" a rule
    // that can be stated rather than an ordering to remember.
    const q = patcherOn(once);
    q.applyChecksumCorrection();
    check('a second correction changes nothing', diff(once, new Uint8Array(q.getBuffer())).length === 0);
}

console.log('\n[the PATCH-ON image, which is a file rather than a reading]');
{
    // The third artifact: BASE + the logic patches + a corrected checksum. It is rebuilt from the
    // stored BASE whenever a session offers it, so the properties that matter are that it is
    // FLASHABLE (the checksum validates), that it says what it is (the patches read back), and
    // that with nothing armed it is not a second copy of the BASE under another name.
    const base = fresh();
    const buf = (u8) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);

    const on = new Uint8Array(patchOnImage(buf(base), {
        applyPatch: true, applyWotDisable: true, applyTankVentDisable: true,
    }));
    check('the image validates', analyzeDataChecksum(on).every(x => x.stored === x.calculated),
        JSON.stringify(analyzeDataChecksum(on)));
    check('it is not the BASE', diff(base, on).length > 0);

    const back = readLogicPatches(buf(on));
    check('it reads back as patched',
        back.applyPatch && back.applyWotDisable && back.applyTankVentDisable, JSON.stringify(back));

    // Same BASE, same three booleans, same bytes — the reason it can be rebuilt instead of stored.
    const again = new Uint8Array(patchOnImage(buf(base), {
        applyPatch: true, applyWotDisable: true, applyTankVentDisable: true,
    }));
    check('rebuilding it twice gives the same bytes', diff(on, again).length === 0);

    // With nothing armed every OFF direction is a true restore, so the only bytes that may move
    // are the checksum's own — which is exactly what makes the offer conditional in the UI: an
    // unpatched session must not be handed the same file under a second name.
    const off = new Uint8Array(patchOnImage(buf(base), {
        applyPatch: false, applyWotDisable: false, applyTankVentDisable: false,
    }));
    // Every moved byte inside a checksum slot, rather than a count: the two slots are three bytes
    // each (0x3FFC-0x3FFE, 0xBFFC-0xBFFE), and counting them was how this check first went wrong.
    const inSlot = (i) => (i >= 0x3FFC && i <= 0x3FFE) || (i >= 0xBFFC && i <= 0xBFFE);
    const moved = diff(base, off);
    check('with nothing armed only the checksum moves', moved.every(inSlot),
        `outside the slots: ${moved.filter(i => !inSlot(i)).map(i => i.toString(16)).join(', ')}`);
    const offBack = readLogicPatches(buf(off));
    check('and it reads back as stock',
        !offBack.applyPatch && !offBack.applyWotDisable && !offBack.applyTankVentDisable,
        JSON.stringify(offBack));

    // The half-applied case PATCH is deliberately two bytes for: the map correction off on its own
    // is not the state WRITE PATCH-ON leaves, and a row that called it PATCH ON would be offering
    // a file that is not what it says.
    // `disableMapCorrection` writes BOTH bytes, so half-applying has to be done a byte at a time —
    // which is exactly the state a hand-edited BIN can be in.
    const half = fresh();
    const hp = patcherOn(half);
    hp.setUint8(MAP_CFG, 0x02);
    const halfBack = readLogicPatches(hp.getBuffer());
    check('the map correction alone does not read as PATCH', !halfBack.applyPatch, JSON.stringify(halfBack));
}

console.log(fails === 0 ? '\nAll checks passed.\n' : `\n${fails} check(s) FAILED.\n`);
process.exit(fails === 0 ? 0 : 1);
