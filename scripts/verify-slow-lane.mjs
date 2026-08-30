/**
 * The slow-lane carry: two independent exchanges, one set of channels, no silent losses.
 *
 * A VE profile reads block 3 and the lambda trim every sample, and two more on slower lanes —
 * block 19 for the purge and freeze channels, and a 16-byte RAM cluster for ambient pressure,
 * intake air temperature and the DME's modelled charge temperature. Their values belong on every
 * sample, so the link carries the last reading forward.
 *
 * The defect this pins: the carry was ASSIGNED from block 19's object, so the RAM byte written in a
 * different branch of the same loop was thrown away every time. Silent, because an absent channel
 * looks exactly like a channel the car does not have — it took a whole drive, 4,836 samples with a
 * column of nothing, to notice.
 */
import {
    decodeAmbientCharge, decodeAmbientTemp, mergeSlowLane, PRESSURE_DECODE_TOLERANCE_MBAR,
} from '../src/lib/dme-link/slowLane.ts';
import { AMBIENT_CHARGE_RAM_READ, AMBIENT_TEMP_RAM_READ } from '../src/lib/dme-link/ramMap.ts';

let fails = 0;
const check = (n, c, d) => { console.log('  ' + (c ? 'PASS' : 'FAIL') + '  ' + n + (c ? '' : ' — ' + d)); if (!c) fails++; };

console.log('\n[two exchanges on one lane, and neither erases the other]');
{
    const block19 = { tankVent: 12, tankVentCheckState: 0, tankVentDiag: 0, lambdaFreeze: 0 };
    const ram = { intakeTemp: 41 };
    // The exact shape of the bug: whichever ran first used to lose.
    const a = mergeSlowLane({}, block19, ram);
    check('block 19 then RAM keeps both', a.tankVent === 12 && a.intakeTemp === 41, JSON.stringify(a));
    const b = mergeSlowLane({}, ram, block19);
    check('RAM then block 19 keeps both', b.tankVent === 12 && b.intakeTemp === 41, JSON.stringify(b));
}

console.log('\n[a read that did not happen leaves the last value standing]');
{
    const carry = mergeSlowLane({}, { tankVent: 12, lambdaFreeze: 0 }, { intakeTemp: 41 });
    // The next seven samples make neither slow-lane exchange.
    const held = mergeSlowLane(carry, null, { intakeTemp: undefined });
    check('nothing this sample keeps everything', held.tankVent === 12 && held.intakeTemp === 41, JSON.stringify(held));
    // And a failed block-19 read must not blank the temperature, nor the reverse.
    const onlyRam = mergeSlowLane(carry, null, { intakeTemp: 44 });
    check('a RAM-only sample updates the temperature and keeps the purge state',
        onlyRam.intakeTemp === 44 && onlyRam.tankVent === 12, JSON.stringify(onlyRam));
    const onlyBlock = mergeSlowLane(carry, { tankVent: 30 }, { intakeTemp: undefined });
    check('a block-only sample updates the purge state and keeps the temperature',
        onlyBlock.tankVent === 30 && onlyBlock.intakeTemp === 41, JSON.stringify(onlyBlock));
}

console.log('\n[nothing is invented]');
{
    // The carry starts empty and undefined is never written, so a car that does not report a
    // channel produces a log with no column rather than a column of zeros.
    const none = mergeSlowLane({}, null, { intakeTemp: undefined });
    check('an empty carry stays empty', Object.keys(none).length === 0, JSON.stringify(none));
    check('undefined is not a value', !('intakeTemp' in none), JSON.stringify(none));
    // A real zero IS a value and must survive — tankVentDiag 0 means "no fault", not "no reading".
    const zero = mergeSlowLane({}, { tankVentDiag: 0 });
    check('a genuine 0 is kept', zero.tankVentDiag === 0, JSON.stringify(zero));
    // The carry is not mutated in place; the caller holds the old one while React renders it.
    const before = { tankVent: 5 };
    const after = mergeSlowLane(before, { tankVent: 9 });
    check('the previous carry is left alone', before.tankVent === 5 && after.tankVent === 9);
}

console.log('\n[the ambient/charge cluster decodes to physical units]');
{
    const BASE = AMBIENT_CHARGE_RAM_READ.address;
    // One telegram, laid out the way the DME's RAM is. Offsets are address - 0xFFED38.
    const frame = ({ ed = 0x00, diag = 0x00, pressure = 943, altitude = 600, tanC = 45, chargeC = 78 }) => {
        const b = new Uint8Array(AMBIENT_CHARGE_RAM_READ.count);
        const w = (off, v) => { b[off] = (v >> 8) & 0xFF; b[off + 1] = v & 0xFF; };
        b[1] = ed;                              // 0xFFED39 P_UMG_ED
        b[2] = diag;                            // 0xFFED3A P_UMG_DIAG_ST
        w(6, Math.round(pressure * 32));        // 0xFFED3E P_UMG_FILTER, 1/32 mbar
        w(10, altitude & 0xFFFF);               // 0xFFED42 P_UMG_HOEHE, metres
        w(12, Math.round((tanC + 48) * 4));     // 0xFFED44 tan_filter, (degC + 48) * 4
        w(14, Math.round((chargeC + 273.15) * 10)); // 0xFFED46 tan_m, 0.1 K absolute
        return b;
    };

    check('the read is 16 bytes and lands inside one telegram',
        AMBIENT_CHARGE_RAM_READ.count === 16 && AMBIENT_CHARGE_RAM_READ.count <= 0x80,
        String(AMBIENT_CHARGE_RAM_READ.count));

    const d = decodeAmbientCharge(frame({}), BASE);
    check('ambient pressure comes back in mbar', Math.abs(d.ambientPressure - 943) < 0.05, String(d.ambientPressure));
    check('intake temperature carries the -48 offset', Math.abs(d.intakeTemp - 45) < 0.13, String(d.intakeTemp));
    // 0.25 degC per LSB is the whole reason this is read as a word instead of the TAN byte.
    const quarter = decodeAmbientCharge(frame({ tanC: 45.25 }), BASE);
    check('and resolves a quarter of a degree', Math.abs(quarter.intakeTemp - 45.25) < 0.13, String(quarter.intakeTemp));
    check('charge temperature converts from absolute', Math.abs(d.chargeTemp - 78) < 0.06, String(d.chargeTemp));
    check('altitude comes back in metres', d.altitude === 600, String(d.altitude));

    // The charge temperature is the point of the cluster: it is NOT the sensor, and a decode that
    // quietly returned the sensor value would make the normalisation a no-op with no symptom.
    check('charge temperature is not the intake reading', d.chargeTemp !== d.intakeTemp);
}

console.log('\n[a substituted pressure is a fault, and cannot be seen in the value]');
{
    const BASE = AMBIENT_CHARGE_RAM_READ.address;
    const b = new Uint8Array(AMBIENT_CHARGE_RAM_READ.count);
    const w = (off, v) => { b[off] = (v >> 8) & 0xFF; b[off + 1] = v & 0xFF; };
    w(6, Math.round(943 * 32)); w(12, (45 + 48) * 4); w(14, Math.round((78 + 273.15) * 10));

    // Healthy: the flag is ABSENT, not false. mergeSlowLane drops undefined, so an absent flag
    // never overwrites a true one carried forward from an earlier sample in the same run.
    check('a healthy sample leaves the flag undefined',
        !('ambientPressureSubstituted' in decodeAmbientCharge(b, BASE))
        || decodeAmbientCharge(b, BASE).ambientPressureSubstituted === undefined);

    b[1] = 0x40;
    check('P_UMG_ED bit 0x40 raises it', decodeAmbientCharge(b, BASE).ambientPressureSubstituted === true);
    // And the pressure still reads plausibly, which is exactly why the flag has to exist: the DME
    // re-learns its substitute from the manifold sensor at key-on, so a faulted channel reports a
    // number in the middle of the normal range.
    check('...while the pressure it reports still looks fine',
        Math.abs(decodeAmbientCharge(b, BASE).ambientPressure - 943) < 0.05);

    b[1] = 0x00; b[2] = 0x07;
    check('a non-zero diag byte alone does NOT raise it (error_free is not established as 0)',
        decodeAmbientCharge(b, BASE).ambientPressureSubstituted === undefined);
}

console.log('\n[garbage is dropped, never clamped]');
{
    const BASE = AMBIENT_CHARGE_RAM_READ.address;
    const b = new Uint8Array(AMBIENT_CHARGE_RAM_READ.count);
    const w = (off, v) => { b[off] = (v >> 8) & 0xFF; b[off + 1] = v & 0xFF; };

    w(6, 0xFFFF); w(12, 0xFFFF); w(14, 0xFFFF); w(10, 0x7FFF);
    const d = decodeAmbientCharge(b, BASE);
    // A clamped value is a measurement that is not one. Absent makes the normalisation refuse;
    // clamped would make it produce a confident wrong answer.
    check('an impossible pressure is absent, not pinned to the limit', d.ambientPressure === undefined, String(d.ambientPressure));
    check('an impossible intake temperature is absent', d.intakeTemp === undefined, String(d.intakeTemp));
    check('an impossible charge temperature is absent', d.chargeTemp === undefined, String(d.chargeTemp));
    check('an impossible altitude is absent', d.altitude === undefined, String(d.altitude));

    // A short response must cost the sample, not the run.
    const short = decodeAmbientCharge(new Uint8Array(4), BASE);
    check('a short telegram yields nothing rather than garbage',
        short.ambientPressure === undefined && short.intakeTemp === undefined
        && short.chargeTemp === undefined && short.altitude === undefined);
}

console.log('\n[the cluster and block 19 still share the carry without erasing each other]');
{
    const BASE = AMBIENT_CHARGE_RAM_READ.address;
    const b = new Uint8Array(AMBIENT_CHARGE_RAM_READ.count);
    const w = (off, v) => { b[off] = (v >> 8) & 0xFF; b[off + 1] = v & 0xFF; };
    w(6, Math.round(943 * 32)); w(12, (45 + 48) * 4); w(14, Math.round((78 + 273.15) * 10));

    // The two lanes now run at DIFFERENT rates (8 and 16), so most block-19 samples arrive with no
    // cluster at all. That is the exact shape of the bug this file exists for.
    const carry = mergeSlowLane({}, { tankVent: 12 }, decodeAmbientCharge(b, BASE));
    const blockOnly = mergeSlowLane(carry, { tankVent: 0 }, null);
    check('a block-19-only sample keeps the density channels',
        blockOnly.tankVent === 0 && Math.abs(blockOnly.ambientPressure - 943) < 0.05
        && Math.abs(blockOnly.chargeTemp - 78) < 0.06, JSON.stringify(blockOnly));

    const clusterOnly = mergeSlowLane(blockOnly, null, decodeAmbientCharge(b, BASE));
    check('and a cluster-only sample keeps the purge channels',
        clusterOnly.tankVent === 0 && clusterOnly.ambientPressure !== undefined);
}

console.log('\n[the outside-air telegram, and the trap inside it]');
{
    const BASE = AMBIENT_TEMP_RAM_READ.address;
    // Offsets are address - 0xFF8082.
    const frame = ({ pressureByte = 148, tUmgC = 31, st = 0x00, speed = 0 }) => {
        const b = new Uint8Array(AMBIENT_TEMP_RAM_READ.count);
        b[0] = pressureByte;              // 0xFF8082 P_UMG, mbar = raw*3 + 498.5
        b[12] = tUmgC + 48;               // 0xFF808E T_UMG, degC + 48
        b[13] = st;                       // 0xFF808F T_UMG_ST
        b[14] = (speed >> 8) & 0xFF;      // 0xFF8090 V, km/h
        b[15] = speed & 0xFF;
        return b;
    };

    check('the read is 16 bytes', AMBIENT_TEMP_RAM_READ.count === 16, String(AMBIENT_TEMP_RAM_READ.count));
    check('and it is in the OTHER window from the density cluster',
        AMBIENT_TEMP_RAM_READ.segment !== AMBIENT_CHARGE_RAM_READ.segment,
        `${AMBIENT_TEMP_RAM_READ.segment} vs ${AMBIENT_CHARGE_RAM_READ.segment}`);

    const d = decodeAmbientTemp(frame({}), BASE);
    check('outside air temperature carries the -48 offset', d.ambientTemp === 31, String(d.ambientTemp));
    check('road speed comes back in km/h',
        decodeAmbientTemp(frame({ speed: 137 }), BASE).vehicleSpeed === 137);
    check('a negative outside temperature decodes',
        decodeAmbientTemp(frame({ tUmgC: -12 }), BASE).ambientTemp === -12);

    // THE trap. `can_rx_62f` substitutes T_UMG_ERSATZ - the running MINIMUM of TAN - when the bus
    // is quiet. A substituted reading is therefore derived from the very sensor it is meant to
    // check, and the cold-soak comparison would pass no matter what the sensor did.
    check('a good CAN frame is reported as from CAN', d.ambientTempFromCan === true);
    check('bit 7 of the status byte says it is NOT',
        decodeAmbientTemp(frame({ st: 0x80 }), BASE).ambientTempFromCan === false);
    check('...and the temperature is still reported, because it is still a number',
        decodeAmbientTemp(frame({ st: 0x80 }), BASE).ambientTemp === 31);
    // A short read is not evidence of anything, least of all of a negative.
    check('no status byte means the source is unknown, not "not CAN"',
        decodeAmbientTemp(new Uint8Array(4), BASE).ambientTempFromCan === undefined);
}

console.log('\n[two decodes of one pressure, so a wrong address shows up as a disagreement]');
{
    const BASE = AMBIENT_TEMP_RAM_READ.address;
    const withByte = (raw) => {
        const b = new Uint8Array(AMBIENT_TEMP_RAM_READ.count);
        b[0] = raw; b[12] = 31 + 48; b[13] = 0;
        return b;
    };
    // raw 148 -> 148*3 + 498.5 = 942.5 mbar. The word decode of the same pressure is 943.0.
    const agree = decodeAmbientTemp(withByte(148), BASE, 943);
    check('two correct decodes agree to within the byte step',
        agree.pressureDecodeDisagreesMbar <= PRESSURE_DECODE_TOLERANCE_MBAR,
        String(agree.pressureDecodeDisagreesMbar));

    const disagree = decodeAmbientTemp(withByte(148), BASE, 1013);
    check('a wrong address shows up as a gap well past it',
        disagree.pressureDecodeDisagreesMbar > PRESSURE_DECODE_TOLERANCE_MBAR,
        String(disagree.pressureDecodeDisagreesMbar));

    // Carried, not acted on: one telegram can fail while the other lands, and the app must not
    // then invent a comparison.
    check('no word decode means no comparison',
        decodeAmbientTemp(withByte(148), BASE, undefined).pressureDecodeDisagreesMbar === undefined);
    // 255 -> 1263.5 mbar, past the DME's own 1150 diagnostic ceiling. Note a byte of 0 is NOT
    // implausible: it decodes to 498.5 mbar, inside the band, and correctly produces a large gap.
    check('a byte outside the plausible band means no comparison at all',
        decodeAmbientTemp(withByte(255), BASE, 943).pressureDecodeDisagreesMbar === undefined,
        String(decodeAmbientTemp(withByte(255), BASE, 943).pressureDecodeDisagreesMbar));
    check('...while a low but possible byte does produce one',
        decodeAmbientTemp(withByte(0), BASE, 943).pressureDecodeDisagreesMbar > PRESSURE_DECODE_TOLERANCE_MBAR);
}

console.log('\n[three lanes now, at three different rates, and none erases another]');
{
    const cBase = AMBIENT_CHARGE_RAM_READ.address;
    const tBase = AMBIENT_TEMP_RAM_READ.address;
    const cluster = new Uint8Array(AMBIENT_CHARGE_RAM_READ.count);
    const w = (off, v) => { cluster[off] = (v >> 8) & 0xFF; cluster[off + 1] = v & 0xFF; };
    w(6, Math.round(943 * 32)); w(12, (45 + 48) * 4); w(14, Math.round((78 + 273.15) * 10));
    const ambient = new Uint8Array(AMBIENT_TEMP_RAM_READ.count);
    ambient[0] = 148; ambient[12] = 31 + 48; ambient[13] = 0; ambient[15] = 60;

    // block 19 every 8, density every 16, outside air every 32 — so on most samples two of the
    // three are absent. That is the exact shape of the bug this file was written for.
    let carry = mergeSlowLane({}, { tankVent: 12 },
        decodeAmbientCharge(cluster, cBase), decodeAmbientTemp(ambient, tBase, 943));
    check('everything lands', carry.tankVent === 12 && carry.ambientPressure !== undefined
        && carry.ambientTemp === 31 && carry.vehicleSpeed === 60, JSON.stringify(carry));

    carry = mergeSlowLane(carry, { tankVent: 0 }, null, null);
    check('a block-19-only sample keeps both RAM clusters',
        carry.tankVent === 0 && carry.chargeTemp !== undefined && carry.ambientTemp === 31);

    carry = mergeSlowLane(carry, null, decodeAmbientCharge(cluster, cBase), null);
    check('a density-only sample keeps the outside air',
        carry.ambientTemp === 31 && carry.vehicleSpeed === 60);

    carry = mergeSlowLane(carry, null, null, decodeAmbientTemp(ambient, tBase, 943));
    check('an outside-air-only sample keeps the density',
        carry.chargeTemp !== undefined && carry.ambientPressure !== undefined);
}

console.log(fails === 0 ? '\nAll slow-lane checks passed.\n' : `\n${fails} check(s) FAILED.\n`);
process.exit(fails === 0 ? 0 : 1);
