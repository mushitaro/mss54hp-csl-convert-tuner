/**
 * Stating a VE measurement at the air the table is defined for.
 *
 * The derivation, in one line, with `VE_ref` the true filling at the reference air:
 *
 *     trim = actual / commanded
 *          = [VE_ref * KL_P(P) * (tan_m_ref / tan_m)] / [table * KL_P(P) * KL_T(TAN)]
 *          = VE_ref * (tan_m_ref / tan_m) / (table * KL_T(TAN))
 *
 * `KL_P(P)` divides out — that is the whole reason this app carries no pressure term — and what is
 * left is undone by
 *
 *     factor = (tan_m / tan_m_ref) * KL_T(TAN)
 *
 * so `table * trim * factor = VE_ref` at any pressure, any intake temperature and any flow. Most of
 * this file is that one sentence, run.
 *
 * The load dependence is the part worth staring at. `tan_m = TMOT - f*(TMOT - TAN)` with `f` rising
 * with air mass flow, so at high flow the factor is the ideal gas law and at idle it is the
 * RECIPROCAL of what the DME applied — the app undoing a correction, because at low flow ambient
 * temperature does not reach the charge and the DME corrected for it anyway. A one-dimensional
 * `KL_RF_TAN_KORR` cannot say that, which is why it sits between the two at an exponent near 0.2.
 */
import { readFileSync } from 'node:fs';
import {
    readRfPtKorrCurves, referenceOf, chargeTempFactor, summariseChargeTemp,
    MIN_COOLANT_INTAKE_GAP_K, CHARGE_TEMP_SLACK_K,
} from '../src/lib/ve-calculator/chargeTemp.ts';
import { interpAxis } from '../src/lib/log-engine/axisBracket.ts';

let fails = 0;
const check = (n, c, d) => { console.log('  ' + (c ? 'PASS' : 'FAIL') + '  ' + n + (c ? '' : ' — ' + d)); if (!c) fails++; };

const raw = readFileSync(new URL('../public/mock/csl-0401-community-patch-v1.partial.bin', import.meta.url));
const curves = readRfPtKorrCurves(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
if (!curves) { console.log('  FAIL  curves did not decode'); process.exit(1); }

const K = c => c + 273.15;
const REF = referenceOf(curves);
const KLT = c => interpAxis(curves.tan.x, curves.tan.values, c);
const KLP = p => interpAxis(curves.pUmg.x, curves.pUmg.values, p);
const point = (o) => ({ time: 0, rpm: 3000, rawLoad: 40, ...o });

/** A sample as the DME would have produced it, for a given air and a given flow fraction `f`. */
function sample({ tanC, tmotC, f }) {
    const tanM = K(tmotC) - f * (K(tmotC) - K(tanC));
    return point({ intakeTemp: tanC, chargeTemp: tanM - 273.15, coolantTemp: tmotC });
}

console.log('\n[the two flow limits, which are the whole shape of the thing]');
{
    const tanC = 60, tmotC = 95;
    // f = 1: the charge IS the sensor reading, and the correction is ideal gas less what the DME
    // already applied.
    const hi = chargeTempFactor(sample({ tanC, tmotC, f: 1 }), curves);
    check('at high flow the factor is (T/T_ref) * KL_T(TAN)',
        Math.abs(hi - (K(tanC) / K(REF.intakeTempC)) * KLT(tanC)) < 1e-9, String(hi));
    check('...which on this binary is 1.113', Math.abs(hi - 1.1131) < 0.0005, hi.toFixed(4));

    // f = 0: the charge is at coolant temperature whatever the weather is, so there is nothing to
    // correct — and the DME corrected anyway, so the app takes it back off.
    const lo = chargeTempFactor(sample({ tanC, tmotC, f: 0 }), curves);
    check('at low flow the factor is exactly KL_T(TAN) — the DME correction, undone',
        Math.abs(lo - KLT(tanC)) < 1e-9, String(lo));
    check('...which is BELOW 1, i.e. the opposite direction to high flow',
        lo < 1 && hi > 1, `${lo.toFixed(4)} / ${hi.toFixed(4)}`);

    // Monotonic in between: a single exponent could not produce this, which is the argument for
    // taking the temperature from the DME's model instead of fitting one.
    const mid = [0.25, 0.5, 0.75].map(f => chargeTempFactor(sample({ tanC, tmotC, f }), curves));
    check('and it rises monotonically with flow between them',
        lo < mid[0] && mid[0] < mid[1] && mid[1] < mid[2] && mid[2] < hi,
        mid.map(v => v.toFixed(4)).join(' '));
}

console.log('\n[at the reference air there is nothing to state, whatever the load]');
{
    // Not obvious, and load-bearing: a drive taken at exactly 20 degC must come out unchanged no
    // matter how it was driven. If this failed, the normalisation would be moving maps that were
    // already right.
    for (const f of [0, 0.3, 0.7, 1]) {
        const v = chargeTempFactor(sample({ tanC: REF.intakeTempC, tmotC: 95, f }), curves);
        check(`f = ${f} gives exactly 1.000`, Math.abs(v - 1) < 1e-12, String(v));
    }
}

console.log('\n[pressure cancels: the same table comes out at 888 mbar and at 943]');
{
    // The claim the design rests on, run end to end. VE_ref is the truth; the table currently holds
    // something else; the DME commands through its own curves; the trim is what the sensor sees.
    const VE_REF = 0.700;
    const TABLE = 0.650;

    const drive = ({ pressure, tanC, tmotC, f }) => {
        const tanM = K(tmotC) - f * (K(tmotC) - K(tanC));
        const tanMRef = K(tmotC) - f * (K(tmotC) - K(REF.intakeTempC));
        // Filling is proportional to pressure and inversely to CHARGE temperature.
        const actual = VE_REF * KLP(pressure) * (tanMRef / tanM);
        const commanded = TABLE * KLP(pressure) * KLT(tanC);
        const trim = actual / commanded;
        const factor = chargeTempFactor(sample({ tanC, tmotC, f }), curves);
        return { raw: TABLE * trim, stated: TABLE * trim * factor };
    };

    const home = drive({ pressure: 943, tanC: 45, tmotC: 95, f: 0.8 });
    const road = drive({ pressure: 888, tanC: 45, tmotC: 95, f: 0.8 });
    check('the same drive at 600 m and at 1100 m produces the same table value',
        Math.abs(home.stated - road.stated) < 1e-9,
        `${home.stated.toFixed(6)} vs ${road.stated.toFixed(6)}`);
    check('...and that value is the truth', Math.abs(home.stated - VE_REF) < 1e-9, home.stated.toFixed(6));
    // The cancellation is in the DME, not in the factor: the UNSTATED numbers already agree on
    // pressure. That is why adding a pressure term here would break it rather than help.
    check('pressure had already cancelled before the factor was applied',
        Math.abs(home.raw - road.raw) < 1e-9, `${home.raw.toFixed(6)} vs ${road.raw.toFixed(6)}`);

    // Same engine, two seasons, high flow. Unstated they disagree; stated they do not.
    const summer = drive({ pressure: 943, tanC: 55, tmotC: 95, f: 1 });
    const winter = drive({ pressure: 1013, tanC: 15, tmotC: 95, f: 1 });
    check('midsummer and midwinter agree once stated',
        Math.abs(summer.stated - winter.stated) < 1e-9,
        `${summer.stated.toFixed(6)} vs ${winter.stated.toFixed(6)}`);
    check('...and disagreed by 12 % before it, so the test is not vacuous',
        Math.abs(winter.raw / summer.raw - 1) > 0.10,
        ((winter.raw / summer.raw - 1) * 100).toFixed(1) + ' %');

    // A REAL change in the engine has to survive. This is what separates a unit conversion from a
    // correction: it must not flatten the thing being measured.
    const realVE = 0.700 * 1.05;
    const withChange = (() => {
        const tanC = 55, tmotC = 95, f = 1;
        const tanM = K(tmotC) - f * (K(tmotC) - K(tanC));
        const tanMRef = K(tmotC) - f * (K(tmotC) - K(REF.intakeTempC));
        const actual = realVE * KLP(943) * (tanMRef / tanM);
        const trim = actual / (TABLE * KLP(943) * KLT(tanC));
        return TABLE * trim * chargeTempFactor(sample({ tanC, tmotC, f }), curves);
    })();
    check('a genuine 5 % VE difference survives being stated',
        Math.abs(withChange / VE_REF - 1.05) < 1e-9, (withChange / VE_REF).toFixed(6));
}

console.log('\n[a sample that cannot answer is refused, never passed through at 1.0]');
{
    const base = { intakeTemp: 60, chargeTemp: 78, coolantTemp: 95 };
    check('the base sample does answer', chargeTempFactor(point(base), curves) !== undefined);

    check('no curves', chargeTempFactor(point(base), null) === undefined);
    check('no intake temperature',
        chargeTempFactor(point({ ...base, intakeTemp: undefined }), curves) === undefined);
    check('no charge temperature',
        chargeTempFactor(point({ ...base, chargeTemp: undefined }), curves) === undefined);
    check('no coolant temperature',
        chargeTempFactor(point({ ...base, coolantTemp: undefined }), curves) === undefined);
    // The one that cannot be seen in any value: a substituted ambient pressure breaks the
    // cancellation, and the DME's substitute is a plausible number.
    check('a substituted ambient pressure',
        chargeTempFactor(point({ ...base, ambientPressureSubstituted: true }), curves) === undefined);

    // f is indeterminate when the anchors meet.
    const gap = MIN_COOLANT_INTAKE_GAP_K;
    check(`coolant within ${gap} K of intake`,
        chargeTempFactor(point({ intakeTemp: 93, chargeTemp: 94, coolantTemp: 95 }), curves) === undefined);
    check(`and just outside it does answer`,
        chargeTempFactor(point({ intakeTemp: 95 - gap - 1, chargeTemp: 92, coolantTemp: 95 }), curves) !== undefined);

    // The model keeps the charge between the anchors. Outside by more than filter lag explains,
    // this is not the quantity the app thinks it is.
    check('charge temperature above coolant by more than the slack',
        chargeTempFactor(point({ intakeTemp: 60, chargeTemp: 95 + CHARGE_TEMP_SLACK_K + 1, coolantTemp: 95 }), curves) === undefined);
    check('charge temperature below intake by more than the slack',
        chargeTempFactor(point({ intakeTemp: 60, chargeTemp: 60 - CHARGE_TEMP_SLACK_K - 1, coolantTemp: 95 }), curves) === undefined);
    check('and just inside the slack still answers',
        chargeTempFactor(point({ intakeTemp: 60, chargeTemp: 96, coolantTemp: 95 }), curves) !== undefined);

    check('NaN is not a temperature',
        chargeTempFactor(point({ ...base, chargeTemp: NaN }), curves) === undefined);
}

console.log('\n[the summary counts what could answer, and says when it could not]');
{
    const good = Array.from({ length: 10 }, () => sample({ tanC: 50, tmotC: 95, f: 0.8 }));
    const blind = Array.from({ length: 6 }, () => point({ intakeTemp: 50, coolantTemp: 95 }));

    const s = summariseChargeTemp([...good, ...blind], curves, true);
    check('usable counts only the samples that produced a factor', s.usable === 10, String(s.usable));
    check('total counts everything it was asked about', s.total === 16, String(s.total));
    check('the reference travels with the summary',
        s.reference.intakeTempC === 20 && s.reference.pressureMbar === 960.5);
    check('the median factor is the factor those samples got',
        Math.abs(s.medianFactor - chargeTempFactor(good[0], curves)) < 1e-12, String(s.medianFactor));
    check('applied is what the caller said it was', s.applied === true);
    check('nothing substituted on a healthy set', s.pressureSubstituted === false);

    const spoiled = summariseChargeTemp(
        [...good, point({ ...good[0], ambientPressureSubstituted: true })], curves, true);
    check('one substituted sample marks the whole run', spoiled.pressureSubstituted === true);

    const off = summariseChargeTemp(good, null, false);
    check('with no curves nothing is usable and nothing is claimed',
        off.usable === 0 && off.medianFactor === undefined && off.reference === null);

    // The spread is what says whether a run moved its LEVEL or its SHAPE. A drive at one condition
    // and one load has almost none; a drive that heat-soaks across the load range has a lot.
    const varied = [0.1, 0.4, 0.7, 1].flatMap(f =>
        [40, 50, 60, 70].map(tanC => sample({ tanC, tmotC: 95, f })));
    const v = summariseChargeTemp(varied, curves, true);
    check('a drive across load and temperature reports a real spread',
        v.p95 - v.p05 > 0.05, `${v.p05?.toFixed(4)}..${v.p95?.toFixed(4)}`);
}

console.log(fails === 0 ? '\nAll charge-temperature checks passed.\n' : `\n${fails} check(s) FAILED.\n`);
process.exit(fails === 0 ? 0 : 1);
