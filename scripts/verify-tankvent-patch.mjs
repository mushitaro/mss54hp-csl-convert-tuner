/**
 * The tank-vent patch, at the byte level.
 *
 * Two properties matter more than the rest and neither is visible from the UI. First, that the
 * patch touches exactly one byte — a stray write into a neighbouring calibration would be silent,
 * since the checksum is corrected afterwards and the DME would accept the result. Second, that
 * turning it OFF really restores stock: the whole safety story is that the valve goes back, and a
 * patch that only ever wrote one way could not deliver it.
 */
import { BinaryPatcher } from '../src/lib/binary-engine/patcher.ts';
import { BinaryParser } from '../src/lib/binary-engine/parser.ts';
import { TANK_VENT_GAIN } from '../src/config/constants.ts';

let fails = 0;
const check = (n, c, d) => { console.log('  ' + (c ? 'PASS' : 'FAIL') + '  ' + n + (c ? '' : ' — ' + d)); if (!c) fails++; };

/** A 64 KB image with recognisable filler, so any unintended write shows up as a changed byte. */
const fresh = () => {
    const b = new Uint8Array(0x10000);
    for (let i = 0; i < b.length; i++) b[i] = i & 0xFF;
    b[TANK_VENT_GAIN.ADDRESS] = TANK_VENT_GAIN.STOCK_RAW;
    return b;
};
const diff = (a, b) => { const out = []; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) out.push(i); return out; };

console.log('\n[the address is where the XDF says]');
check('K_TE_TVTE_GA at slave 0xBF1', TANK_VENT_GAIN.ADDRESS === 0xBF1, '0x' + TANK_VENT_GAIN.ADDRESS.toString(16));
check('inside the slave half (0x0000-0x7FFF)', TANK_VENT_GAIN.ADDRESS < 0x8000);
check('stock 0x80 = 1.0 with the XDF x/128', TANK_VENT_GAIN.STOCK_RAW === 0x80 && TANK_VENT_GAIN.STOCK_RAW / 128 === 1.0);
// The checksum slots are rewritten after every patch, so an item living in one could never read
// back as what was written. 0xBF1 is nowhere near them, but the test is cheap and the failure silent.
check('clear of both checksum slots', !(TANK_VENT_GAIN.ADDRESS >= 0x3FFC && TANK_VENT_GAIN.ADDRESS < 0x4000)
    && !(TANK_VENT_GAIN.ADDRESS >= 0xBFFC && TANK_VENT_GAIN.ADDRESS < 0xC000));

console.log('\n[disable]');
{
    const before = fresh();
    const p = new BinaryPatcher(before.buffer.slice(0));
    p.setTankVentDisable(true);
    const after = new Uint8Array(p.getBuffer());
    const changed = diff(before, after);
    check('exactly one byte moved', changed.length === 1, JSON.stringify(changed.slice(0, 8)));
    check('and it is 0xBF1', changed[0] === TANK_VENT_GAIN.ADDRESS, '0x' + (changed[0] ?? -1).toString(16));
    check('it now reads 0x00', after[TANK_VENT_GAIN.ADDRESS] === 0);
    check('parser calls it disabled', new BinaryParser(after.buffer).getTankVentDisabled() === true);
}

console.log('\n[restore — the half that makes the toggle honest]');
{
    const stock = fresh();
    const p = new BinaryPatcher(stock.buffer.slice(0));
    p.setTankVentDisable(true);
    p.setTankVentDisable(false);
    const after = new Uint8Array(p.getBuffer());
    check('round trip is byte-identical to stock', diff(stock, after).length === 0, JSON.stringify(diff(stock, after)));
    check('parser calls it enabled', new BinaryParser(after.buffer).getTankVentDisabled() === false);
}
{
    // A BASE read off a car that already had the patch: OFF must still restore, not no-op.
    const patched = fresh();
    patched[TANK_VENT_GAIN.ADDRESS] = 0;
    const p = new BinaryPatcher(patched.buffer.slice(0));
    p.setTankVentDisable(false);
    check('a BIN that arrives disabled is restored by OFF',
        new Uint8Array(p.getBuffer())[TANK_VENT_GAIN.ADDRESS] === TANK_VENT_GAIN.STOCK_RAW);
}

console.log('\n[status reads the byte, not an approximation]');
{
    // The DME's own test is `<= K_TE_TV_MIN`, so a reduced gain is real calibration, not "off".
    const half = fresh();
    half[TANK_VENT_GAIN.ADDRESS] = 0x40;
    check('half gain is NOT reported as disabled', new BinaryParser(half.buffer).getTankVentDisabled() === false);
}

console.log(fails === 0 ? '\nALL PASS' : '\n' + fails + ' FAILURE(S)');
process.exit(fails ? 1 : 0);
