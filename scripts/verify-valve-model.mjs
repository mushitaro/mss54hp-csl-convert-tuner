/**
 * `KF_LLS_TV` read the way the DME reads it, and the gate that proves it on the car.
 *
 * This is the map the idle correction moves to. The one the feature was built around,
 * `KF_LLR_QVS_GRUND`, is sealed: its output `LLR_QSOLL` has exactly one absolute reference in the
 * whole image and it is its own write site, because `cfg_m.egas` reads 0x00 on this lineage and
 * that routes `lls_tv_calc` from the TORQUE path instead. Recovered from `lls_tv_calc`
 * (master 0x025D0A):
 *
 *     LLS_TV = PT1( KF_LLS_TV(n, ml_ll) + KATH blend | LLS_TV_MIN_START )
 *              then the UB correction, then clamped to K_LLS_TV_MIN/MAX
 *
 * The numbers below are this car's own table, decoded from the reference image by the disassembly
 * repo. They are asserted rather than described so that a re-vendor which changes them fails here
 * instead of silently changing what the tuner writes.
 *
 *     node scripts/verify-valve-model.mjs
 */
import {
    llsTvAt, llsTvSlopePctPerKgH, modelAgreement,
} from '../src/lib/idle/valveModel.ts';

let fails = 0;
const check = (name, ok, got) => {
    if (!ok) fails++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok || got === undefined ? '' : ' — ' + got}`);
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;

/** This car's KF_LLS_TV, XDF 0x9DE2 / values 0x9E10, x = rpm, y = ml_ll kg/h, z = duty %. */
const MAP = {
    x: [500, 600, 800, 950, 1400, 1700, 2350, 3000, 5000, 7000],
    y: [11, 15, 20, 25, 30, 40, 50, 60, 65, 70, 75, 80, 85],
    values: [
        [14.0, 14.0, 14.0, 14.0, 14.0, 14.0, 14.0, 14.0, 14.0, 14.0],
        [23.9, 23.9, 23.0, 23.0, 24.0, 25.0, 25.0, 25.0, 25.0, 25.0],
        [33.8, 33.8, 33.6, 33.2, 31.0, 30.0, 30.0, 30.0, 30.0, 30.0],
        [40.5, 40.5, 38.0, 37.2, 36.9, 36.6, 36.6, 36.6, 36.6, 36.6],
        [46.7, 46.7, 44.7, 42.8, 41.8, 42.0, 41.2, 40.3, 39.3, 39.3],
        [62.0, 62.0, 60.9, 53.52, 50.6, 49.8, 48.8, 47.7, 46.5, 46.1],
        [97.0, 97.0, 97.0, 83.0, 62.5, 60.2, 58.3, 56.4, 52.7, 52.0],
        [97.0, 97.0, 97.0, 97.0, 88.5, 83.2, 69.6, 67.3, 60.0, 59.1],
        [97.0, 97.0, 97.0, 97.0, 97.0, 97.0, 77.5, 73.5, 63.6, 61.5],
        [97.0, 97.0, 97.0, 97.0, 97.0, 97.0, 97.0, 83.1, 68.7, 65.0],
        [97.0, 97.0, 97.0, 97.0, 97.0, 97.0, 97.0, 97.0, 74.9, 67.0],
        [97.0, 97.0, 97.0, 97.0, 97.0, 97.0, 97.0, 97.0, 86.2, 72.0],
        [97.0, 97.0, 97.0, 97.0, 97.0, 97.0, 97.0, 97.0, 97.0, 97.0],
    ],
};

console.log('\n[the table is the shape its axes describe]');
{
    check('13 rows', MAP.values.length === MAP.y.length, `${MAP.values.length}/${MAP.y.length}`);
    check('10 columns', MAP.values.every(r => r.length === MAP.x.length));
    check('both axes ascend',
        MAP.x.every((v, i) => i === 0 || v > MAP.x[i - 1])
        && MAP.y.every((v, i) => i === 0 || v > MAP.y[i - 1]));
    check('the bottom row is the K_LLS_TV_MIN rail (14 %)', MAP.values[0].every(v => v === 14.0));
    check('the top row is the K_LLS_TV_MAX rail (97 %)', MAP.values[12].every(v => v === 97.0));
}

console.log('\n[breakpoints read back exactly]');
{
    check('800 rpm, 11 kg/h', llsTvAt(MAP, 800, 11) === 14.0, llsTvAt(MAP, 800, 11));
    check('800 rpm, 15 kg/h', llsTvAt(MAP, 800, 15) === 23.0, llsTvAt(MAP, 800, 15));
    check('1400 rpm, 30 kg/h', llsTvAt(MAP, 1400, 30) === 41.8, llsTvAt(MAP, 1400, 30));
    check('7000 rpm, 85 kg/h', llsTvAt(MAP, 7000, 85) === 97.0, llsTvAt(MAP, 7000, 85));
}

console.log('\n[between breakpoints it is linear, the way kfu_wint is]');
{
    // Halfway along y between 11 and 15 kg/h at 800 rpm: (14.0 + 23.0) / 2.
    check('mid-row', near(llsTvAt(MAP, 800, 13), 18.5, 1e-9), llsTvAt(MAP, 800, 13));
    // Halfway along x between 600 and 800 rpm at 15 kg/h: (23.9 + 23.0) / 2.
    check('mid-column', near(llsTvAt(MAP, 700, 15), 23.45, 1e-9), llsTvAt(MAP, 700, 15));
    // Both at once.
    check('mid-cell', near(llsTvAt(MAP, 700, 13), (14.0 + 14.0 + 23.9 + 23.0) / 4, 1e-9),
        llsTvAt(MAP, 700, 13));
}

console.log('\n[outside the axes it CLAMPS — it does not extrapolate]');
{
    check('below the first rpm', llsTvAt(MAP, 100, 15) === llsTvAt(MAP, 500, 15));
    check('above the last rpm', llsTvAt(MAP, 9000, 15) === llsTvAt(MAP, 7000, 15));
    check('below the first ml', llsTvAt(MAP, 800, 2) === llsTvAt(MAP, 800, 11));
    check('above the last ml', llsTvAt(MAP, 800, 200) === llsTvAt(MAP, 800, 85));
    check('a request under the floor cannot ask for less duty',
        llsTvAt(MAP, 800, 0) === 14.0, llsTvAt(MAP, 800, 0));
}

/**
 * THE GAIN. This is what replaces the invented %/Nm constant, so it is pinned to the two numbers
 * the decision was argued from.
 */
console.log('\n[the gain is the map\'s own slope]');
{
    const s1 = llsTvSlopePctPerKgH(MAP, 800, 12);   // inside 11-15
    const s2 = llsTvSlopePctPerKgH(MAP, 800, 17);   // inside 15-20
    check('11-15 kg/h at 800 rpm is 2.25 %/(kg/h)', near(s1, 2.25, 1e-9), s1);
    check('15-20 kg/h at 800 rpm is 2.12 %/(kg/h)', near(s2, 2.12, 1e-9), s2);
    check('the two adjacent rows agree within 10 %', Math.abs(s1 - s2) / s1 < 0.10,
        `${((s1 - s2) / s1 * 100).toFixed(1)} %`);
    // g_air = 0.40 kg/h per Nm, the physics-bounded default the old target used.
    check('combined gain at the idle cell is about 0.90 %/Nm', near(s1 * 0.40, 0.90, 0.01),
        (s1 * 0.40).toFixed(3));
    check('the slope is positive everywhere it is defined',
        MAP.x.every(rpm => MAP.y.slice(0, -1).every(ml => (llsTvSlopePctPerKgH(MAP, rpm, ml + 0.5) ?? 1) >= 0)));
    check('a railed row reports zero slope, not a negative one',
        llsTvSlopePctPerKgH(MAP, 500, 82) === 0, llsTvSlopePctPerKgH(MAP, 500, 82));
}

/**
 * THE GATE, and the reason run 1 is worth taking even though nothing is written from it.
 *
 * Every way this can disagree is a way the whole retarget could be wrong, and the disagreement is
 * visible from the driver's seat instead of being discovered afterwards.
 */
console.log('\n[the model gate]');
{
    const ok = modelAgreement(MAP, 800, 15, 23.2, 2.0);
    check('a duty on the map agrees', ok.agrees, JSON.stringify(ok));
    check('...and reports the delta signed', near(ok.delta, 0.2, 1e-9), ok.delta);

    // A live KATH blend adds duty on top: KF_LLS_TV_KATH is the richer map, so the measured duty
    // sits ABOVE what KF_LLS_TV alone asks for. That is the case this gate exists to catch.
    const kath = modelAgreement(MAP, 800, 15, 31.0, 2.0);
    check('cat-heating blend is refused', !kath.agrees, JSON.stringify(kath));
    check('...and the sign says which way', kath.delta > 0);

    // A wrong address or scaling shows as a large disagreement in either direction.
    check('a wrong map is refused', !modelAgreement(MAP, 800, 15, 60.0, 2.0).agrees);

    check('a missing channel is not an agreement', modelAgreement(MAP, 800, null, 23.0, 2.0) === null);
    check('...nor a missing duty', modelAgreement(MAP, 800, 15, null, 2.0) === null);
    check('...nor a missing rpm', modelAgreement(MAP, null, 15, 23.0, 2.0) === null);
}

console.log('\n[the warm idle cell, as the car actually sits]');
{
    // 780 rpm, and the air the valve is asked for at a settled warm idle.
    const duty = llsTvAt(MAP, 780, 14);
    check('is between the two rails', duty > 14.0 && duty < 97.0, duty.toFixed(2));
    check('and under the preflight duty ceiling of 25 %', duty < 25, duty.toFixed(2));
    // A 3 Nm standing error, at the combined gain, in duty.
    const slope = llsTvSlopePctPerKgH(MAP, 780, 14);
    check('a 3 Nm error asks for about 2.7 % more duty',
        near(slope * 0.40 * 3, 2.7, 0.2), (slope * 0.40 * 3).toFixed(2));
    check('...which is a real move against a 20 % duty, not noise',
        (slope * 0.40 * 3) / duty > 0.10, `${(100 * (slope * 0.40 * 3) / duty).toFixed(0)} %`);
}

console.log(fails === 0 ? '\nALL PASS' : '\n' + fails + ' FAILURE(S)');
process.exit(fails ? 1 : 0);
