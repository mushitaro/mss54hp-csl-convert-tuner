/**
 * K HOLD at the byte level — `kl_rf_korr_rf_min` held at 2.000 — and, above all, that it comes out.
 *
 * What the DME does with the floor (rf_korr, master 0x021A70, every background pass):
 *
 *     rf_soll >  floor(N)         && V >  vMin  ->  rf_korr = KF_RF_KORR_DRREL(N, Δ)
 *     rf_soll >= floor(N) - 0.100 && V >= vMin  ->  rf_korr held
 *     otherwise                                 ->  rf_korr = 1.000
 *
 * With all six points at 2000 neither branch is reachable, so K ≡ 1.000 — the Δ=30 row — and a VE
 * log carries no rf_korr step for the lambda loop's fixed-slope ramp to turn into a fake VE error.
 *
 * The expensive failure is not the hold going in, it is the hold STAYING in. A held image comes
 * back into the app as the post-write reload, as the stored image FINALIZE builds from, and as the
 * BASE of a new session parented on a TUNED built held. In each, "the six as loaded" are 2000, and
 * a restore that wrote those back would ship the hold — no cold-exhaust enrichment, more part-load
 * advance — in the BIN meant for the road. So restore-from-held is pinned here three ways.
 *
 * Run against the community partial in public/mock, whose floor is BMW's 700/550/650/650/650/800:
 * the plausibility check and the latch read real calibration, not a fabricated one.
 */
import { readFileSync } from 'node:fs';
import { BinaryPatcher, bytesAsRecorded, bytesAsRun, patchOnImage, readLogicPatches, rfKorrFloorMode } from '../src/lib/binary-engine/patcher.ts';
import { BinaryParser } from '../src/lib/binary-engine/parser.ts';
import { APP_CONFIG, TANK_VENT_GAIN, TANK_VENT_TMOT, RF_KORR_GATE_FLOOR } from '../src/config/constants.ts';
import { readEgtTables, RfKorrLatch, gateOpen, rfKorrActive, rfKorrAt } from '../src/lib/ve-calculator/egtTables.ts';
import { analyzeDataChecksum } from '../src/lib/checksum/dmeDataChecksum.ts';
import { isRoadState, isTuneOnTheRoad } from '../src/lib/db/flashState.ts';
import { derivedBaseName } from '../src/hooks/useBinaryFile.ts';

let fails = 0;
const check = (n, c, d) => { console.log('  ' + (c ? 'PASS' : 'FAIL') + '  ' + n + (c ? '' : ' — ' + d)); if (!c) fails++; };

const raw = readFileSync(new URL('../public/mock/csl-0401-community-patch-v1.partial.bin', import.meta.url));
const BASE = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);

const Y = RF_KORR_GATE_FLOOR.VALUES_ADDRESS;          // 0xE90C
const X = Y - RF_KORR_GATE_FLOOR.POINTS * 2;          // 0xE900, the rpm breakpoints
const N = RF_KORR_GATE_FLOOR.POINTS;
const HELD = RF_KORR_GATE_FLOOR.HELD_RAW;
const STOCK = [...RF_KORR_GATE_FLOOR.STOCK_RAW];

const u8 = (b) => new Uint8Array(b);
const floorOf = (b) => { const v = u8(b); return Array.from({ length: N }, (_, i) => (v[Y + i * 2] << 8) | v[Y + i * 2 + 1]); };
const axisOf = (b) => { const v = u8(b); return Array.from({ length: N }, (_, i) => (v[X + i * 2] << 8) | v[X + i * 2 + 1]); };
const diff = (a, b) => { const x = u8(a), y = u8(b); const out = []; for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) out.push(i); return out; };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** BASE with its six floor words replaced. */
const withFloor = (words) => {
    const v = u8(BASE.slice(0));
    words.forEach((w, i) => { v[Y + i * 2] = w >> 8; v[Y + i * 2 + 1] = w & 0xFF; });
    return v.buffer;
};
const floorAfter = (image, mode) => { const p = new BinaryPatcher(image); p.setRfKorrGateFloor(mode); return p.getBuffer(); };

const NONE = { applyPatch: false, applyWotDisable: false, applyTankVentDisable: false };

console.log('\n[hold: the twelve bytes at 0xE90C, and nothing else]');
{
    check('the BASE floor is BMW\'s (else this file tests nothing)', eq(floorOf(BASE), STOCK), JSON.stringify(floorOf(BASE)));
    const held = floorAfter(BASE, 'hold');
    check('all six read 2000', floorOf(held).every(v => v === HELD), JSON.stringify(floorOf(held)));
    const moved = diff(BASE, held);
    check('every moved byte is inside 0xE90C..0xE917',
        moved.every(i => i >= Y && i < Y + N * 2), moved.map(i => i.toString(16)).join(','));
    check('exactly twelve moved', moved.length === 12, String(moved.length));
    check('the rpm breakpoints at 0xE900 are untouched', eq(axisOf(held), axisOf(BASE)),
        `${JSON.stringify(axisOf(BASE))} -> ${JSON.stringify(axisOf(held))}`);
    const parser = new BinaryParser(held);
    check('the parser calls it held', parser.getRfKorrGateFloorHeld() === true);
    check('...and not dropped', parser.getRfKorrGateFloorDropped() === false);
    check('the stock BASE is neither', !new BinaryParser(BASE).getRfKorrGateFloorHeld()
        && !new BinaryParser(BASE).getRfKorrGateFloorDropped());
}

console.log('\n[restore takes it back out — the release BIN must not carry the hold]');
{
    const held = withFloor(Array(N).fill(HELD));
    check('restore from a held image lands on STOCK_RAW', eq(floorOf(floorAfter(held, 'stock')), STOCK),
        JSON.stringify(floorOf(floorAfter(held, 'stock'))));
    check('restore from a stock image changes nothing', diff(floorAfter(BASE, 'stock'), BASE).length === 0,
        String(diff(floorAfter(BASE, 'stock'), BASE).length));
    // The retired drop is recognised as this app's work the same way.
    const dropped = withFloor(Array(N).fill(RF_KORR_GATE_FLOOR.DROPPED_RAW));
    check('restore from the retired drop lands on STOCK_RAW', eq(floorOf(floorAfter(dropped, 'stock')), STOCK));
    // Not this app's work: a restore keeps it, which is the rule every other writer follows.
    const ownCar = [720, 560, 640, 660, 640, 780];
    check("another car's own floor survives a restore", eq(floorOf(floorAfter(withFloor(ownCar), 'stock')), ownCar));
    const handRaised = Array(N).fill(1500);
    check('a hand-raised floor at 1.500 is not HOLD, and survives too',
        eq(floorOf(floorAfter(withFloor(handRaised), 'stock')), handRaised));
    // On and off in one build is a round trip, because the restore reads `original`, not the
    // bytes the hold just wrote.
    const p = new BinaryPatcher(BASE);
    p.setRfKorrGateFloor('hold');
    p.setRfKorrGateFloor('stock');
    check('hold then stock in one build is byte-identical', diff(p.getBuffer(), BASE).length === 0);
    // The three ordinary ways a held image comes back in, all of which build from it with the
    // hold off: the reload after a write, FINALIZE, and a session parented on a held TUNED.
    check('bytesAsRun(held image, nothing armed) reads the stock floor',
        eq(floorOf(bytesAsRun(held, NONE)), STOCK), JSON.stringify(floorOf(bytesAsRun(held, NONE))));
}

console.log('\n[a replay the record is silent on reads the BASE as stored, not the stock floor]');
{
    // A Re-tune child from a held TUNED: its BASE is held, it has no settings and no flash, and the
    // car already runs those bytes. A crash before its first SAVE replays through `armed` undefined.
    const heldTuned = patchOnImage(BASE, { applyPatch: true, applyWotDisable: false, applyTankVentDisable: true, applyRfKorrHold: true });
    check('the held TUNED reads back held (else this tests nothing)', readLogicPatches(heldTuned).applyRfKorrHold === true);
    const silent = bytesAsRecorded(heldTuned, undefined);
    check('no record: the replay keeps the hold the BASE carries', floorOf(silent).every(v => v === HELD),
        JSON.stringify(floorOf(silent)));
    const t = readEgtTables(silent);
    check('...so the EGT tables read the held floor the toggles also show',
        !!t && t.rfKorrMin.values.every(v => Math.abs(v - 2) < 1e-9), JSON.stringify(t?.rfKorrMin.values));
    check('...and PATCH and TANK VENT too, from the same bytes', (() => {
        const back = readLogicPatches(silent);
        return back.applyPatch && back.applyTankVentDisable && !back.applyWotDisable;
    })());
    // An older record that predates K HOLD: the field it lacks falls back alone.
    const oldRecord = bytesAsRecorded(heldTuned, { applyPatch: true, applyWotDisable: false, applyTankVentDisable: true });
    check('a record without the K HOLD field falls back for that field only', floorOf(oldRecord).every(v => v === HELD));
    // A field on record is what the drive ran, and wins over the bytes.
    check('a record that says K HOLD off replays the stock floor',
        eq(floorOf(bytesAsRecorded(heldTuned, { applyRfKorrHold: false })), STOCK));
    check('a stock BASE with no record replays stock', eq(floorOf(bytesAsRecorded(BASE, undefined)), STOCK));
    // The coercion this replaced: every missing field false reads the held BASE through the stock gate.
    check('control: bytesAsRun with the fields coerced to false loses the hold',
        eq(floorOf(bytesAsRun(heldTuned, NONE)), STOCK));
}

console.log('\n[held is exact equality of all six, never a threshold]');
{
    const isHeld = (words) => new BinaryParser(withFloor(words)).getRfKorrGateFloorHeld();
    check('2000 x6 is held', isHeld(Array(N).fill(2000)));
    check('five at 2000 and one at 1999 is not', !isHeld([2000, 2000, 2000, 1999, 2000, 2000]));
    check('2001 x6 is not', !isHeld(Array(N).fill(2001)));
    check('1900 x6 is not', !isHeld(Array(N).fill(1900)));
    check('0xFFFF x6 is not', !isHeld(Array(N).fill(0xFFFF)));
    check('one point at 2000 is not', !isHeld([2000, 550, 650, 650, 650, 800]));
}

console.log('\n[hold wins over the retired drop; the drop never leaves the app]');
{
    check('both flags resolve to hold', rfKorrFloorMode({ applyRfKorrHold: true, applyRfKorrGateDrop: true }) === 'hold');
    check('the drop alone resolves to drop', rfKorrFloorMode({ applyRfKorrGateDrop: true }) === 'drop');
    check('neither resolves to stock', rfKorrFloorMode({}) === 'stock');
    const both = bytesAsRun(BASE, { ...NONE, applyRfKorrHold: true, applyRfKorrGateDrop: true });
    check('bytesAsRun with both armed reads held', new BinaryParser(both).getRfKorrGateFloorHeld());
    // A log recorded on the drop has to replay through the floor the DME was running.
    check('bytesAsRun with a legacy drop record reads dropped',
        new BinaryParser(bytesAsRun(BASE, { ...NONE, applyRfKorrGateDrop: true })).getRfKorrGateFloorDropped());
    // ...but an image leaving the app never carries it again.
    check('patchOnImage ignores a legacy drop: the floor stays stock',
        eq(floorOf(patchOnImage(BASE, { ...NONE, applyRfKorrGateDrop: true })), STOCK));
    const dropped = withFloor(Array(N).fill(RF_KORR_GATE_FLOOR.DROPPED_RAW));
    check('a dropped BIN armed with K HOLD is written held',
        floorOf(patchOnImage(dropped, { ...NONE, applyRfKorrHold: true })).every(v => v === HELD));
    check('a dropped BIN with K HOLD off is written stock',
        eq(floorOf(patchOnImage(dropped, NONE)), STOCK));
}

console.log('\n[a held image still reads as calibration, and its gate never opens]');
{
    const stockT = readEgtTables(BASE);
    const heldT = readEgtTables(floorAfter(BASE, 'hold'));
    check('the stock BASE reads its EGT tables', stockT !== null);
    check('readEgtTables(held) is NOT null — 2000 stays inside the plausibility bound', heldT !== null);
    check('...with the floor at 2.000 in all six', !!heldT && heldT.rfKorrMin.values.every(v => Math.abs(v - 2) < 1e-9),
        JSON.stringify(heldT?.rfKorrMin.values));
    check('...and the rpm axis unchanged', !!heldT && eq(heldT.rfKorrMin.rpm, stockT.rfKorrMin.rpm));
    // 0xFFFF is the obvious "never", and the reason it is not used: the whole set would read null.
    check('0xFFFF would have lost the EGT tables altogether', readEgtTables(withFloor(Array(N).fill(0xFFFF))) === null);

    // rf_soll 1.5 at 200 km/h: above every stock point and above anything kf_rf_soll reaches
    // (≈1.2), below the 1.900 hold threshold. The stock latch opens there — the control — and the
    // held one must not open anywhere on the rpm range, entering or holding.
    const RF = 1.5, V = 200;
    const sweep = [];
    for (let rpm = 800; rpm <= 7200; rpm += 100) sweep.push(rpm);
    const stockLatch = new RfKorrLatch();
    check('control: the stock latch opens at rf_soll 1.5 / 200 km/h', sweep.some(rpm => stockLatch.step(stockT, rpm, RF, V)));
    if (heldT) {
        const latch = new RfKorrLatch();
        const opened = sweep.filter(rpm => latch.step(heldT, rpm, RF, V));
        check('held: the latch never opens across 800-7200 rpm', opened.length === 0, opened.join(','));
        check('held: gateOpen is false everywhere', sweep.every(rpm => !gateOpen(heldT, rpm, RF)));
        check('held: rfKorrActive is false everywhere', sweep.every(rpm => !rfKorrActive(heldT, rpm, RF, V)));
        // A walk that climbs to just under the entry and sits in what would be the hold band: there
        // is nothing to hold, because entry needs rf_soll > 2.000.
        const walk = new RfKorrLatch();
        const climb = [0.3, 0.8, 1.2, 1.6, 1.95, 1.99, 2.0, 1.95, 1.92, 1.9];
        check('held: a climb to 2.000 and a sit in 1.900-2.000 never opens',
            climb.every(rf => !walk.step(heldT, 3000, rf, V)));
        // What the DME applies with the latch shut is 1.000 — the K the VE write then divides by.
        const kAt = (t, l, rpm) => (l.step(t, rpm, RF, V) ? rfKorrAt(t, rpm, 200) : 1.0);
        const kl = new RfKorrLatch();
        check('held: K = 1.000 at every rpm, Δ = 200', sweep.every(rpm => kAt(heldT, kl, rpm) === 1.0));
    }
}

console.log('\n[the PATCH-ON image with K HOLD is flashable, and says what it is]');
{
    const on = patchOnImage(BASE, { applyPatch: true, applyWotDisable: false, applyTankVentDisable: true, applyRfKorrHold: true });
    check('the checksum validates', analyzeDataChecksum(u8(on)).every(s => s.isValid), JSON.stringify(analyzeDataChecksum(u8(on))));
    const back = readLogicPatches(on);
    check('it reads back as PATCH + TEV + K HOLD, and not as the drop',
        back.applyPatch && back.applyTankVentDisable && back.applyRfKorrHold && !back.applyRfKorrGateDrop && !back.applyWotDisable,
        JSON.stringify(back));
    const inSlot = (i) => (i >= 0x3FFC && i <= 0x3FFE) || (i >= 0xBFFC && i <= 0xBFFE);
    // TEV is two bytes: the valve gain and K_TE_TMOT (TANK_VENT_TMOT).
    const known = new Set([APP_CONFIG.MSS54HP.ADDRESS_MAP_CONFIG, APP_CONFIG.MSS54HP.ADDRESS_TEMP_LIMIT,
        TANK_VENT_GAIN.ADDRESS, TANK_VENT_TMOT.ADDRESS]);
    const stray = diff(BASE, on).filter(i => !inSlot(i) && !known.has(i) && !(i >= Y && i < Y + N * 2));
    check('nothing moved outside PATCH, TEV, the floor and the checksum slots', stray.length === 0,
        stray.map(i => i.toString(16)).join(','));

    // FINALIZE: the stored held image, every patch off. Stock floor, flashable, reads as stock.
    const fin = patchOnImage(on, NONE);
    check('FINALIZE from a held image writes the stock floor', eq(floorOf(fin), STOCK), JSON.stringify(floorOf(fin)));
    check('...validates', analyzeDataChecksum(u8(fin)).every(s => s.isValid));
    check('...and reads back without K HOLD', readLogicPatches(fin).applyRfKorrHold === false);
}

console.log('\n[a held BIN is never FINAL]');
{
    const flash = (over = {}) => ({
        at: 1, sha256: 'x', tuned: true, ...over,
        settings: { ...NONE, writeWarmup: false, writeWot: false, ...(over.settings ?? {}) },
    });
    check('K HOLD alone is not road state', !isRoadState(flash({ settings: { applyRfKorrHold: true } })));
    check('a tune flashed held is not on the road',
        !isTuneOnTheRoad({ flashHistory: [flash({ settings: { applyPatch: true, applyRfKorrHold: true } })] }));
    check('...until a FINALIZE takes it out',
        isTuneOnTheRoad({ flashHistory: [flash({ at: 1, settings: { applyPatch: true, applyRfKorrHold: true } }), flash({ at: 2 })] }));
}

console.log('\n[the filename says K HOLD once, however many times it is re-derived]');
{
    check('a _KHOLD name strips back to its source', derivedBaseName('Tune_202610131200_car_PatchON_TEVOFF_KHOLD') === 'car',
        derivedBaseName('Tune_202610131200_car_PatchON_TEVOFF_KHOLD'));
    // The nesting the old strip produced, because it did not know _RFGATE40.
    check('an old nested _RFGATE40 name strips clean in one pass',
        derivedBaseName('Base_202610011200_car_PatchON_RFGATE40_PatchON_RFGATE40') === 'car',
        derivedBaseName('Base_202610011200_car_PatchON_RFGATE40_PatchON_RFGATE40'));
    check('a plain name is left alone', derivedBaseName('csl-0401') === 'csl-0401');
}

console.log(fails === 0 ? '\nAll K HOLD checks passed.\n' : `\n${fails} check(s) FAILED.\n`);
process.exit(fails === 0 ? 0 : 1);
