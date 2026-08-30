import type { EcuItemDef } from '../types';
import { affine, divideBy, minus } from '../codec';

/**
 * `RF_PT_KORR` — the two curves that scale the Alpha-N table for the air of the day.
 *
 * ## Why these matter more than their size suggests
 *
 * This app spent a long time built on the belief that the Alpha-N fuel path is density blind, and
 * that belief was written into several comments as fact. It is wrong. `rf_soll_calc`
 * (decomp/master/01a9d2.txt) ends with
 *
 *     rf_soll = (rf_soll_filtered * RF_PT_KORR) >> 12;
 *
 * carrying the source comment *"scale it so the target corresponds to current air density. This
 * keeps the commanded fill consistent across ambient and thermal conditions."* — and
 * `rf_pt_korr_calc` (decomp/master/01a5d6.txt) builds that factor from exactly the two curves
 * below, indexed by the RAW `TAN` and `P_UMG` bytes:
 *
 *     RF_PT_KORR = (KL_RF_TAN_KORR(TAN) * KL_RF_P_UMG_KORR(P_UMG)) >> 12;
 *
 * `k_rf_cfg` bit 4 — the tuning patch — removes the `rf_p_saug_i` integral from `rf_calc` and
 * nothing else. This scaling runs on every segment, patch in or out. So a lambda trim recorded on
 * this car was measured THROUGH these curves, and reproducing them is the only way to know what it
 * was measuring.
 *
 * ## What they establish
 *
 * **The reference the VE table is written at is not a choice.** It is the point where each curve is
 * exactly 4096, and both land on a grid node: `TAN` = 20 degC and `P_UMG` = 960.5 mbar. Ask "what
 * ambient pressure is `kf_rf_soll` a value for" and the answer is in these bytes.
 *
 * **The pressure curve is the ideal gas law.** Against `P/960.5` it is within 0.24 % at 888 mbar
 * and 0.08 % at 943 — the two altitudes this car is tuned and driven at. That exactness is what
 * makes ambient pressure cancel out of the measurement (`actual air ∝ P` over
 * `commanded ∝ P/960.5`) rather than something the app has to correct for.
 *
 * **The temperature curve is not.** It is far flatter than 1/T — an effective exponent near 0.2 —
 * because `TAN` is measured in a manifold that heat-soaks, and because a single curve has to cover
 * a temperature sensitivity that is in truth load-dependent. `tan_m` is where the DME keeps the
 * load-dependent version; see the charge-temperature normaliser.
 */
export const DENSITY_ITEMS: EcuItemDef[] = [
    {
        kind: 'curve', symbol: 'KL_RF_TAN_KORR', address: 0xD2AC, bank: 'master',
        category: 'load', label: 'RF TAN KORR',
        description: {
            en: 'Intake-air-temperature scaling on the Alpha-N target, applied on every segment and '
                + 'NOT removed by the tuning patch. Exactly 1.0000 at 20 degC, which is the '
                + 'temperature kf_rf_soll is written for. Much flatter than 1/T (effective exponent '
                + '~0.2) because TAN sits in a manifold that heat-soaks, and because one curve has '
                + 'to average a sensitivity that really varies with load.',
            ja: 'Alpha-N の目標値に掛かる吸気温補正。全セグメントで適用され、チューニングパッチでも'
                + '消えない。20 °C でちょうど 1.0000 — つまり kf_rf_soll はその温度での値。'
                + '理想気体の 1/T よりはるかに平坦（実効指数 約 0.2）。TAN が熱を持つマニホールド内に'
                + 'あることと、本来は負荷で変わる感度を 1 本のカーブで平均しているため。',
        },
        x: { address: 0xD2AC, n: 8, bits: 16, signed: false, units: '°C', label: 'TAN', scaling: minus(48) },
        values: { address: 0xD2BC, n: 8, bits: 16, signed: false, units: '', scaling: divideBy(4096) },
    },
    {
        kind: 'curve', symbol: 'KL_RF_P_UMG_KORR', address: 0xD2CE, bank: 'master',
        category: 'load', label: 'RF P_UMG KORR',
        description: {
            en: 'Ambient-pressure scaling on the Alpha-N target. Exactly 1.0000 at 960.5 mbar, and '
                + 'linear in pressure to within 0.24 % across 888-1098 mbar — it IS the ideal gas '
                + 'law. That is why altitude cancels out of a VE measurement instead of biasing it, '
                + 'and why this app adds no pressure term of its own.',
            ja: 'Alpha-N の目標値に掛かる大気圧補正。960.5 mbar でちょうど 1.0000、'
                + '888〜1098 mbar の範囲で気圧に 0.24 % 以内で比例する — つまり理想気体そのもの。'
                + 'VE 測定から標高が約分で消えるのはこのためで、アプリ側で気圧項を足さない理由でもある。',
        },
        x: {
            address: 0xD2CE, n: 8, bits: 16, signed: false, units: 'mbar', label: 'P_UMG',
            // The raw index is the P_UMG byte, and `p_umg_calc` defines that byte as
            // `(P_UMG_FILTER - 0x3E50) / 0x60`. At 1/32 mbar per filter count that is
            // `mbar = raw * 3 + 498.5`, which puts the 1.0000 node at 154 -> 960.5 mbar.
            scaling: affine(3, 498.5),
        },
        values: { address: 0xD2DE, n: 8, bits: 16, signed: false, units: '', scaling: divideBy(4096) },
    },
];
