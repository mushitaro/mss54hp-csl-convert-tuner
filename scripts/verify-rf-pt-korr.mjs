/**
 * `RF_PT_KORR` — the two curves that decide what a VE table's numbers mean.
 *
 * `rf_soll_calc` (decomp/master/01a9d2.txt) ends with
 * `rf_soll = (rf_soll_filtered * RF_PT_KORR) >> 12`, and `rf_pt_korr_calc` builds that factor as
 * `KL_RF_TAN_KORR(TAN) * KL_RF_P_UMG_KORR(P_UMG) >> 12`. The tuning patch clears `k_rf_cfg` bit 4,
 * which removes the MAP integral from `rf_calc` and touches neither of these. So the Alpha-N table
 * is scaled for the day's air on every segment, and this app believed for a long time that it was
 * not — a belief that was written into three comments as fact and became the premise of a feature.
 *
 * Two numbers out of these curves are load-bearing enough to pin:
 *
 *   1. **20 degC and 960.5 mbar.** That is where each curve is exactly 4096, and it is therefore
 *      the air `kf_rf_soll` is a value FOR. It is not a setting, it is not a choice, and the app
 *      reads it here rather than carrying a constant that could drift from the binary.
 *   2. **The pressure curve is proportional to pressure.** The decision to carry no pressure term
 *      at all rests on it: `actual air ∝ P` over `commanded ∝ P/960.5` cancels only if this holds.
 *      If a binary turned up where it did not, the app would be quietly writing altitude into the
 *      map, and `readRfPtKorrCurves` would have to refuse it.
 *
 * And one that is not load-bearing but is the whole reason the temperature half is hard: the
 * temperature curve is nowhere near 1/T. Its effective exponent is about 0.2, because `TAN` sits in
 * a manifold that heat-soaks and because one curve has to average a sensitivity that really varies
 * with load. That is what `tan_m` and chargeTemp.ts exist to recover.
 */
import { readFileSync } from 'node:fs';
import { readRfPtKorrCurves, referenceOf, rfPtKorr, PRESSURE_LINEARITY_TOLERANCE }
    from '../src/lib/ve-calculator/chargeTemp.ts';
import { interpAxis } from '../src/lib/log-engine/axisBracket.ts';
import { ECU_ITEMS } from '../src/lib/ecu-items/catalog/index.ts';
import { validateCatalog } from '../src/lib/ecu-items/codec.ts';

let fails = 0;
const check = (n, c, d) => { console.log('  ' + (c ? 'PASS' : 'FAIL') + '  ' + n + (c ? '' : ' — ' + d)); if (!c) fails++; };

const raw = readFileSync(new URL('../public/mock/csl-0401-community-patch-v1.partial.bin', import.meta.url));
const BUFFER = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
const curves = readRfPtKorrCurves(BUFFER);

console.log('\n[the curves decode out of the shipped binary]');
{
    check('both curves read through the catalog', !!curves);
    if (!curves) { console.log('\nnothing further can run.\n'); process.exit(1); }

    const problems = validateCatalog(ECU_ITEMS);
    check('the whole catalog still validates', problems.length === 0, problems.join('; '));

    // The axes, in physical units, exactly as the DME's own indices decode.
    check('the temperature axis is -40..100 degC in 20 degC steps',
        curves.tan.x.join(',') === '-40,-20,0,20,40,60,80,100', curves.tan.x.join(','));
    check('the pressure axis runs 597.5..1098.5 mbar',
        curves.pUmg.x[0] === 597.5 && curves.pUmg.x[curves.pUmg.x.length - 1] === 1098.5,
        curves.pUmg.x.join(','));
    check('eight points each, values against axis',
        curves.tan.values.length === 8 && curves.pUmg.values.length === 8);
}

console.log('\n[the reference is in the bytes, not in this app]');
{
    const ref = referenceOf(curves);
    // Both land on an exact grid node with Z = 4096. That is BMW saying what the table is defined
    // at; interpolating anyway is only so a calibration that puts it between nodes still works.
    check('KL_RF_TAN_KORR is exactly 1 at 20 degC',
        interpAxis(curves.tan.x, curves.tan.values, 20) === 1,
        String(interpAxis(curves.tan.x, curves.tan.values, 20)));
    check('KL_RF_P_UMG_KORR is exactly 1 at 960.5 mbar',
        interpAxis(curves.pUmg.x, curves.pUmg.values, 960.5) === 1,
        String(interpAxis(curves.pUmg.x, curves.pUmg.values, 960.5)));
    check('so the reference reads back as 20 degC / 960.5 mbar',
        ref.intakeTempC === 20 && ref.pressureMbar === 960.5, JSON.stringify(ref));
    check('and RF_PT_KORR there is exactly 1.000000', rfPtKorr(curves, 20, 960.5) === 1,
        String(rfPtKorr(curves, 20, 960.5)));

    // The order matters: the DME multiplies then shifts once, so the two curves are independent
    // factors. A reproduction that averaged or added them would agree at the reference and nowhere
    // else, which is the kind of wrong that survives a spot check.
    const t = interpAxis(curves.tan.x, curves.tan.values, 60);
    const p = interpAxis(curves.pUmg.x, curves.pUmg.values, 943);
    check('RF_PT_KORR is the PRODUCT of the two curves',
        Math.abs(rfPtKorr(curves, 60, 943) - t * p) < 1e-12,
        `${rfPtKorr(curves, 60, 943)} vs ${t * p}`);
}

console.log('\n[the pressure curve IS the ideal gas law — the no-pressure-term argument]');
{
    const ref = referenceOf(curves).pressureMbar;
    const err = p => interpAxis(curves.pUmg.x, curves.pUmg.values, p) / (p / ref) - 1;

    // The two altitudes this car is tuned and driven between. If these are not tight, the same
    // drive taken at home and on the tuning road would not produce the same table.
    check('at 888 mbar (1100 m) it is within 0.3 % of proportional', Math.abs(err(888)) < 0.003,
        (err(888) * 100).toFixed(3) + ' %');
    check('at 943 mbar (600 m) it is within 0.3 % of proportional', Math.abs(err(943)) < 0.003,
        (err(943) * 100).toFixed(3) + ' %');
    check('...so the two disagree by under 0.2 %', Math.abs(err(888) - err(943)) < 0.002,
        ((err(888) - err(943)) * 100).toFixed(3) + ' %');

    const worst = Math.max(...curves.pUmg.x.map(p => Math.abs(err(p))));
    check('and across the whole axis it stays inside the tolerance readRfPtKorrCurves enforces',
        worst <= PRESSURE_LINEARITY_TOLERANCE, (worst * 100).toFixed(2) + ' %');
}

console.log('\n[the temperature curve is NOT the ideal gas law — the reason tan_m is needed]');
{
    const T = c => c + 273.15;
    const exponent = c => Math.log(interpAxis(curves.tan.x, curves.tan.values, c))
        / Math.log(T(20) / T(c));

    for (const c of [40, 60, 80, 100]) {
        const n = exponent(c);
        check(`at ${c} degC the effective exponent is 0.15-0.30 (1.0 would be ideal gas)`,
            n > 0.15 && n < 0.30, n.toFixed(3));
    }
    // The size of the thing this leaves on the table. If the curve were 1/T there would be nothing
    // for chargeTemp.ts to do at all.
    const idealGas = T(20) / T(60);
    const curve = interpAxis(curves.tan.x, curves.tan.values, 60);
    check('at 60 degC ideal gas asks for 12 % and the curve gives 2 %',
        Math.abs(idealGas - 0.8799) < 0.001 && Math.abs(curve - 0.9795) < 0.001,
        `${idealGas.toFixed(4)} vs ${curve.toFixed(4)}`);
}

console.log('\n[a binary that is not this one is refused, not half-read]');
{
    // Blank the temperature curve's values. The axes still decode, the shape checks still pass,
    // and the unity point disappears — which has to be a refusal rather than a reference of 0.
    const broken = BUFFER.slice(0);
    new Uint8Array(broken).fill(0, 0xD2BC, 0xD2BC + 16);
    check('a curve with no unity point is refused', readRfPtKorrCurves(broken) === null);

    // A pressure curve that is not proportional to pressure. Everything else about it is fine —
    // ascending axis, plausible values, a unity point — and it would silently break the
    // cancellation the whole design rests on.
    const bent = BUFFER.slice(0);
    const view = new DataView(bent);
    for (let i = 0; i < 8; i++) {
        const at = 0xD2DE + i * 2;
        // Square the ratio: still monotonic, still 1.0 at the reference, no longer linear.
        const v = view.getUint16(at) / 4096;
        view.setUint16(at, Math.round(v * v * 4096));
    }
    check('a pressure curve that is not proportional is refused', readRfPtKorrCurves(bent) === null);

    check('an empty buffer is refused', readRfPtKorrCurves(new ArrayBuffer(0x10000)) === null);
}

console.log(fails === 0 ? '\nAll RF_PT_KORR checks passed.\n' : `\n${fails} check(s) FAILED.\n`);
process.exit(fails === 0 ? 0 : 1);
