/**
 * The full-load fuel multiplier, and the restore that puts it back.
 *
 * `KF_TI_N_RF_VL` is selected by `ti_load_factor` (slave 0x01c6ca) whenever ZUSTAND_MOTOR's VL bit
 * is set, and it multiplies the injection time. Its part-load sibling `KF_TI_N_RF` is 1.000 across
 * its whole range, which is the proof these are MULTIPLIERS: a table of ones cannot be an amount.
 * So the mixture at full load is `lambda = 1 / (rf_korr x this)`.
 *
 * The app used to DERIVE this table as `stock x (newVE / stockVE)`. That is the VE correction
 * applied a second time — fuel is already proportional to `rf_soll x rf_korr`, so correcting the VE
 * table corrects the fuel, and scaling this one by the same ratio squares it. Found on a real car:
 * every point matched its VE ratio and the full-load lambda had reached 1.23 at 2100 rpm. Nothing
 * had gone wrong yet only because the WOT-threshold patch was in, so VL never set and the table was
 * never reached.
 *
 * These checks exist so the reference cannot rot and the restore cannot become a rewrite:
 *
 *   1. the shipped constant equals the bytes in the community partial, byte for byte,
 *   2. restoring writes exactly those bytes and touches nothing else,
 *   3. restoring a drifted table is idempotent and detectable before and after,
 *   4. the lambda the reference implies is inside a band that could plausibly be a calibration.
 */
import { readFileSync } from 'node:fs';
import { BinaryParser } from '../src/lib/binary-engine/parser.ts';
import { BinaryPatcher } from '../src/lib/binary-engine/patcher.ts';
import { COMMUNITY_WOT_FUEL_RAW, WOT_FUEL_ROWS, EXPERIMENTAL_CONFIG } from '../src/config/constants.ts';

let fails = 0;
const check = (n, c, d) => { console.log('  ' + (c ? 'PASS' : 'FAIL') + '  ' + n + (c ? '' : ' — ' + d)); if (!c) fails++; };

const raw = readFileSync(new URL('../public/mock/csl-0401-community-patch-v1.partial.bin', import.meta.url));
const COMMUNITY = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
const Z = EXPERIMENTAL_CONFIG.ADDRESS_WOT_MAP;
const N = COMMUNITY_WOT_FUEL_RAW.length;

console.log('\n[the shipped reference IS the community binary]');
{
    const bytes = new Uint8Array(COMMUNITY);
    const onDisk = Array.from({ length: N }, (_, i) => bytes[Z + i]);
    check('the constant matches the partial byte for byte',
        COMMUNITY_WOT_FUEL_RAW.every((v, i) => v === onDisk[i]),
        `constant ${COMMUNITY_WOT_FUEL_RAW.join(',')} vs disk ${onDisk.join(',')}`);
    // All three RF rows ship identical, which is what makes the table one-dimensional in rpm and
    // what `restoreWotFuel` relies on when it writes one row three times.
    let allRowsSame = true;
    for (let r = 1; r < WOT_FUEL_ROWS; r++)
        for (let c = 0; c < N; c++) if (bytes[Z + r * N + c] !== onDisk[c]) allRowsSame = false;
    check('all three RF rows are identical in the shipped binary', allRowsSame);
    check('the parser agrees the community partial is stock',
        new BinaryParser(COMMUNITY).wotFuelIsStock());
}

console.log('\n[what the reference means as a mixture]');
{
    // lambda = 1 / value. A calibration that enriches at full load lives below 1.0; the 700 rpm
    // point sits just above it, which is why the band is not simply "< 1".
    const lambdas = COMMUNITY_WOT_FUEL_RAW.map(v => 128 / v);
    check('every point implies lambda between 0.75 and 1.06',
        lambdas.every(l => l >= 0.75 && l <= 1.06),
        lambdas.map(l => l.toFixed(3)).join(' '));
    // The one that matters: nothing in the reference is lean of stoichiometric where it would hurt.
    check('above 900 rpm nothing is lean of stoichiometric',
        lambdas.slice(1).every(l => l <= 1.0), lambdas.map(l => l.toFixed(2)).join(' '));
}

console.log('\n[restore puts it back, and only it]');
{
    // A drifted table, built the way the bug built one: every point scaled by a VE ratio.
    const drifted = COMMUNITY.slice(0);
    const view = new Uint8Array(drifted);
    const before = Array.from({ length: N }, (_, i) => view[Z + i]);
    for (let r = 0; r < WOT_FUEL_ROWS; r++)
        for (let c = 0; c < N; c++) view[Z + r * N + c] = Math.round(before[c] * 0.74);

    check('the drifted copy is detected', !new BinaryParser(drifted).wotFuelIsStock());
    check('...and its lambda has gone lean of stoichiometric, which is the danger',
        Math.max(...Array.from({ length: N }, (_, i) => 128 / view[Z + i])) > 1.2);

    const p = new BinaryPatcher(drifted);
    p.restoreWotFuel();
    const fixed = p.getBuffer();
    check('restoring makes it stock again', new BinaryParser(fixed).wotFuelIsStock());

    const a = new Uint8Array(COMMUNITY), b = new Uint8Array(fixed);
    let differ = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) differ++;
    check('and the restored image is byte-identical to the community partial', differ === 0, `${differ} bytes differ`);

    // Idempotent: restoring an already-stock table writes the same bytes rather than drifting.
    const q = new BinaryPatcher(fixed);
    q.restoreWotFuel();
    const twice = new Uint8Array(q.getBuffer());
    let d2 = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== twice[i]) d2++;
    check('restoring twice changes nothing further', d2 === 0, `${d2} bytes differ`);
}

console.log('\n[the restore does not reach past its own table]');
{
    const p = new BinaryPatcher(COMMUNITY);
    p.restoreWotFuel();
    const out = new Uint8Array(p.getBuffer()), src = new Uint8Array(COMMUNITY);
    let outside = 0;
    for (let i = 0; i < src.length; i++) {
        const inside = i >= Z && i < Z + WOT_FUEL_ROWS * N;
        if (!inside && src[i] !== out[i]) outside++;
    }
    check('no byte outside the Z block moved', outside === 0, `${outside} bytes`);
}

console.log(fails === 0 ? '\nAll WOT-fuel checks passed.\n' : `\n${fails} check(s) FAILED.\n`);
process.exit(fails === 0 ? 0 : 1);
