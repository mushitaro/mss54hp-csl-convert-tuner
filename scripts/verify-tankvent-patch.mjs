/**
 * The tank-vent patch, at the byte level.
 *
 * TANK VENT is two bytes since 2026-10-18, written and restored by one toggle:
 *
 *     K_TE_TVTE_GA  slave 0xBF1   0x80 -> 0x00   the valve duty is zero      (TANK_VENT_GAIN)
 *     K_TE_TMOT     slave 0xBED   0x75 -> 0xFF   the state machine never     (TANK_VENT_TMOT)
 *                                                enters purge, so the purge adaptation TEA never
 *                                                learns and TEA1_F_KORR stays 1.000
 *
 * The second byte exists because the first alone left the tank-vent state machine running: above
 * 69 °C coolant it entered purge with the valve shut, and TEA folded up to −21 % / +3.3 % of the
 * lambda error at RF 0.17-0.46 into a correction no log carries. See TANK_VENT_TMOT for the
 * arithmetic and the eight compares.
 *
 * What these checks pin, none of it visible from the UI:
 *   - the patch moves exactly those two bytes — a stray write would be silent, since the checksum is
 *     corrected afterwards and the DME would accept the result;
 *   - turning it OFF really restores, both bytes, to what the BIN was loaded with — or to stock when
 *     the BIN arrived patched — because the whole safety story is that the valve and the functional
 *     check come back;
 *   - a BIN carrying the pre-2026-10-18 patch (valve shut, K_TE_TMOT stock) seeds the toggle ON, and
 *     the write from that toggle leaves it whole with a valid checksum. Whether the hub OFFERS that
 *     write is the write gate's question — the build against the car image, byte for byte — and is
 *     pinned in verify:car-image beside the gate, where it moved from the retired `tankVentDrift`;
 *   - every builder that takes the toggle (bytesAsRun, bytesAsRecorded, patchOnImage) moves both.
 *
 * Synthetic images plus public/mock only.
 */
import { readFileSync } from 'node:fs';
import { BinaryPatcher, bytesAsRun, bytesAsRecorded, patchOnImage, readLogicPatches }
    from '../src/lib/binary-engine/patcher.ts';
import { BinaryParser } from '../src/lib/binary-engine/parser.ts';
import { TANK_VENT_GAIN, TANK_VENT_TMOT } from '../src/config/constants.ts';
import { analyzeDataChecksum, correctDataChecksum } from '../src/lib/checksum/dmeDataChecksum.ts';
import { managedSpans } from '../src/lib/calibration/edits.ts';

let fails = 0;
const check = (n, c, d) => { console.log('  ' + (c ? 'PASS' : 'FAIL') + '  ' + n + (c ? '' : ' — ' + d)); if (!c) fails++; };

const GA = TANK_VENT_GAIN.ADDRESS;
const TMOT = TANK_VENT_TMOT.ADDRESS;

/** A 64 KB image with recognisable filler, so any unintended write shows up as a changed byte. */
const fresh = (overrides = {}) => {
    const b = new Uint8Array(0x10000);
    for (let i = 0; i < b.length; i++) b[i] = i & 0xFF;
    b[GA] = TANK_VENT_GAIN.STOCK_RAW;
    b[TMOT] = TANK_VENT_TMOT.STOCK_RAW;
    for (const [addr, val] of Object.entries(overrides)) b[Number(addr)] = val;
    return b;
};
const buf = (u8) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
const diff = (a, b) => { const out = []; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) out.push(i); return out; };
const hex = (xs) => xs.map(i => '0x' + i.toString(16)).join(',');
const inSlot = (i) => (i >= 0x3FFC && i <= 0x3FFF) || (i >= 0xBFFC && i <= 0xBFFF);
const patchedWith = (u8, disable) => {
    const p = new BinaryPatcher(buf(u8));
    p.setTankVentDisable(disable);
    return new Uint8Array(p.getBuffer());
};
const status = (u8) => {
    const parser = new BinaryParser(buf(u8));
    return { valveShut: parser.getTankVentDisabled(), learnStopped: parser.getTankVentLearnStopped() };
};

console.log('\n[the addresses are where the XDF says, and the stock bytes are what the BIN holds]');
check('K_TE_TVTE_GA at slave 0xBF1', GA === 0xBF1, '0x' + GA.toString(16));
check('K_TE_TMOT at slave 0xBED', TMOT === 0xBED, '0x' + TMOT.toString(16));
check('both inside the slave half (0x0000-0x7FFF)', GA < 0x8000 && TMOT < 0x8000);
check('stock gain 0x80 = 1.0 with the XDF x/128', TANK_VENT_GAIN.STOCK_RAW === 0x80 && TANK_VENT_GAIN.STOCK_RAW / 128 === 1.0);
// °C = raw − 48, the XDF's conversion: stock is the 69 °C the docs quote, the patch a temperature
// no coolant reaches.
check('stock K_TE_TMOT 0x75 = 69 °C', TANK_VENT_TMOT.STOCK_RAW === 0x75 && TANK_VENT_TMOT.STOCK_RAW - 48 === 69);
check('patched K_TE_TMOT 0xFF = 207 °C', TANK_VENT_TMOT.DISABLED_RAW === 0xFF && TANK_VENT_TMOT.DISABLED_RAW - 48 === 207);
// The checksum slots are rewritten after every patch, so an item living in one could never read
// back as what was written.
check('clear of both checksum slots', ![GA, TMOT].some(inSlot));
// The slave CRC covers [0x0000, 0x3FFC) and [0x4000, 0x8000) — so the existing correction already
// covers the new byte, and nothing else has to learn about it.
check('K_TE_TMOT is under the slave CRC', TMOT < 0x3FFC);

const raw = readFileSync(new URL('../public/mock/csl-0401-community-patch-v1.partial.bin', import.meta.url));
const MOCK = new Uint8Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
check('the community partial holds stock 0x75 at 0x0BED', MOCK[TMOT] === 0x75, '0x' + MOCK[TMOT].toString(16));
check('...and stock 0x80 at 0x0BF1', MOCK[GA] === 0x80, '0x' + MOCK[GA].toString(16));
check('...and its checksum validates (else the tests below test nothing)', analyzeDataChecksum(MOCK).every(s => s.isValid));

console.log('\n[disable: two bytes, those two]');
{
    const before = fresh();
    const after = patchedWith(before, true);
    const changed = diff(before, after);
    check('exactly two bytes moved', changed.length === 2, hex(changed.slice(0, 8)));
    check('and they are 0xBED and 0xBF1', changed[0] === TMOT && changed[1] === GA, hex(changed));
    check('the gain reads 0x00', after[GA] === 0x00);
    check('K_TE_TMOT reads 0xFF', after[TMOT] === 0xFF);
    check('parser: valve shut, learning stopped',
        JSON.stringify(status(after)) === JSON.stringify({ valveShut: true, learnStopped: true }), JSON.stringify(status(after)));
}

console.log('\n[restore — the half that makes the toggle honest]');
{
    const stock = fresh();
    const p = new BinaryPatcher(buf(stock));
    p.setTankVentDisable(true);
    p.setTankVentDisable(false);
    const after = new Uint8Array(p.getBuffer());
    check('round trip is byte-identical to stock', diff(stock, after).length === 0, hex(diff(stock, after)));
    check('parser: valve open, learning live',
        JSON.stringify(status(after)) === JSON.stringify({ valveShut: false, learnStopped: false }), JSON.stringify(status(after)));
}
{
    // A BASE read off a car that already had the whole patch: OFF must restore both, not no-op.
    const after = patchedWith(fresh({ [GA]: 0x00, [TMOT]: 0xFF }), false);
    check('a BIN that arrives fully patched gets the stock gain back', after[GA] === TANK_VENT_GAIN.STOCK_RAW);
    check('...and the stock 69 °C', after[TMOT] === TANK_VENT_TMOT.STOCK_RAW, '0x' + after[TMOT].toString(16));
}
{
    // Its own calibration is not this app's patch, and a restore must not trade it for 69 °C.
    const own = fresh({ [TMOT]: 0x70 });   // 64 °C
    const after = patchedWith(own, false);
    check('a K_TE_TMOT of its own (64 °C) survives OFF', after[TMOT] === 0x70, '0x' + after[TMOT].toString(16));
    const p = new BinaryPatcher(buf(own));
    p.setTankVentDisable(true);
    p.setTankVentDisable(false);
    check('...and survives ON then OFF', new Uint8Array(p.getBuffer())[TMOT] === 0x70);
    check('a half gain (0x40) survives OFF', patchedWith(fresh({ [GA]: 0x40 }), false)[GA] === 0x40);
}

console.log('\n[status reads the bytes, not an approximation]');
{
    // The DME's own test is `<= K_TE_TV_MIN`, so a reduced gain is real calibration, not "off".
    check('half gain is NOT reported as disabled', status(fresh({ [GA]: 0x40 })).valveShut === false);
    // Anything under 0xFF is a temperature the coolant can reach: calibration, not the patch.
    check('K_TE_TMOT 0xFE is NOT reported as learning stopped', status(fresh({ [TMOT]: 0xFE })).learnStopped === false);
}

console.log('\n[the old patch: valve shut, K_TE_TMOT stock — every car patched before 2026-10-18]');
{
    // Built from the community partial the way the old write built it: the gain alone, then the
    // checksum. This is the BIN a READ off such a car hands back.
    const old = MOCK.slice();
    old[GA] = 0x00;
    correctDataChecksum(old);
    check('it is a valid image', analyzeDataChecksum(old).every(s => s.isValid));

    const s = status(old);
    check('the valve byte says shut', s.valveShut === true);
    check('the temperature byte says learning is NOT stopped', s.learnStopped === false);
    // The seed: useBinaryFile arms the toggle from the valve byte, the same question this asks.
    const seeded = readLogicPatches(buf(old)).applyTankVentDisable;
    check('the toggle seeds ON — loading it does not lose the patch', seeded === true);

    // The write the gate offers for it (verify:car-image): WRITE PATCH-ON, built through the same patcher.
    const written = new Uint8Array(patchOnImage(buf(old), {
        applyPatch: false, applyWotDisable: false, applyTankVentDisable: true,
    }));
    const moved = diff(old, written).filter(i => !inSlot(i));
    check('the write moves K_TE_TMOT and nothing else outside the checksum', moved.length === 1 && moved[0] === TMOT, hex(moved));
    check('K_TE_TMOT is now 0xFF and the valve still shut', written[TMOT] === 0xFF && written[GA] === 0x00);
    check('the checksum validates', analyzeDataChecksum(written).every(x => x.isValid),
        JSON.stringify(analyzeDataChecksum(written)));
    check('written, the bytes hold the whole patch', JSON.stringify(status(written)) === JSON.stringify({ valveShut: true, learnStopped: true }));

    // FINALIZE from the old patch: OFF restores the valve and leaves its own 0x75 alone.
    const fin = new Uint8Array(patchOnImage(buf(old), { applyPatch: false, applyWotDisable: false, applyTankVentDisable: false }));
    check('FINALIZE on the old patch: gain back to 0x80, K_TE_TMOT still 0x75', fin[GA] === 0x80 && fin[TMOT] === 0x75);
    check('...and it validates', analyzeDataChecksum(fin).every(x => x.isValid));
}

console.log('\n[every builder that takes the toggle moves both bytes]');
{
    const base = buf(MOCK);
    const NONE = { applyPatch: false, applyWotDisable: false, applyTankVentDisable: false };
    const TV = { ...NONE, applyTankVentDisable: true };

    const run = new Uint8Array(bytesAsRun(base, TV));
    check('bytesAsRun armed: both patched', run[GA] === 0x00 && run[TMOT] === 0xFF);
    check('bytesAsRun with nothing armed: both as loaded', diff(MOCK, new Uint8Array(bytesAsRun(base, NONE))).length === 0);

    const rec = new Uint8Array(bytesAsRecorded(base, { applyTankVentDisable: true }));
    check('bytesAsRecorded with TANK VENT on record: both patched', rec[GA] === 0x00 && rec[TMOT] === 0xFF);

    const on = new Uint8Array(patchOnImage(base, TV));
    const movedOn = diff(MOCK, on).filter(i => !inSlot(i));
    check('patchOnImage armed: exactly 0xBED and 0xBF1 outside the checksum', hex(movedOn) === hex([TMOT, GA]), hex(movedOn));
    check('...with a valid checksum', analyzeDataChecksum(on).every(x => x.isValid));

    // The delivered image: every toggle off over the patched one — FINALIZE's write, built from the
    // car image that holds the patch.
    const road = new Uint8Array(patchOnImage(buf(on), NONE));
    check('the road BIN restores both to stock', road[GA] === 0x80 && road[TMOT] === 0x75, `0x${road[GA].toString(16)} / 0x${road[TMOT].toString(16)}`);
    check('...byte-identical to the BASE', diff(MOCK, road).length === 0, hex(diff(MOCK, road)));
}

console.log('\n[the calibration editor cannot reach either byte]');
{
    // buildPatchedBuffer writes both on every build; an edit there would be overwritten silently.
    const owned = (addr) => managedSpans().some(s => s.owner === 'TANK VENT' && addr >= s.address && addr < s.address + s.length);
    check('0xBF1 is locked under TANK VENT', owned(GA));
    check('0xBED is locked under TANK VENT', owned(TMOT));
}

console.log(fails === 0 ? '\nALL PASS' : '\n' + fails + ' FAILURE(S)');
process.exit(fails ? 1 : 0);
