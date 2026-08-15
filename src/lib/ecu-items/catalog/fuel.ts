import type { EcuItemDef } from '../types';
import { IDENTITY, divideBy } from '../codec';

/**
 * Tank ventilation (Tankentlüftung) — the evaporative purge path.
 *
 * Here because purge is the largest known threat to a VE log's reproducibility, and because the one
 * byte that switches it off is worth being able to LOOK at before anything writes to it. Session
 * #902 (2026-08-15, 1600 samples) measured the valve open for 82.8 % of a 657-second drive, with a
 * duty distribution that reproduces `KF_TE_N_RF_TVTE` below: p95 94.7 % against the map's 94.14 %,
 * peak 99.87 % against 99.61 %. That is not a background effect.
 *
 * Why it reaches the tune at all: purged vapour is fuel the DME did not inject, so the lambda
 * controller trims for it and `la_f_regler` moves — the one input this app derives the VE
 * correction from. Separately the DME subtracts its own purge estimate from the air mass in
 * `m_calc` (decomp/master/0216e2.txt), so `rf` moves too. See docs/ecu-logic/60-tuning-logic.md.
 */
export const FUEL_ITEMS: EcuItemDef[] = [
    {
        kind: 'constant', symbol: 'K_TE_TVTE_GA', address: 0xBF1, bank: 'slave',
        category: 'fuel', label: 'TANK VENT GAIN',
        bits: 8, signed: false, units: '', scaling: divideBy(128),
        description: {
            en: 'Gain on the tank-vent valve duty. Stock 0x80 = 1.0. Setting it to 0 holds the valve '
                + 'shut — verified at instruction level, not inferred: tetv_calc (slave 0x26ED6) is the '
                + 'only reader in the binary and the only writer of a non-zero TETV, and with the gain '
                + 'at 0 its result falls to K_TE_TV_MIN, which trips the `<= K_TE_TV_MIN` branch and '
                + 'forces exactly zero rather than a minimum duty. karter16 confirmed the same '
                + 'behaviour by logging. One path is not gated by it: during the TEFC idle functional '
                + 'check (TEFC_LL_ST 0x10-0x15) the duty comes from the TEFC ramp instead — but '
                + 'K_TEFC_N_MIN, K_TEFC_N_MAX and K_TEFC_LL_ML_MAX are all raw 0 here, so that check '
                + 'appears to abort before it can run, and Session #902 saw TEFC_LL_ST flat at 0 for '
                + '657 seconds. TUNING ONLY — the canister stops being purged and DTC 24 is the code '
                + 'for a valve that will not open.',
            ja: 'タンク換気バルブのデューティに掛かるゲイン。純正 0x80 = 1.0。0 にするとバルブが開かなくなる。'
                + '推測ではなく命令レベルで確認済み: このバイトの読み手はバイナリ全体で tetv_calc'
                + '（slave 0x26ED6）だけ、非ゼロの TETV を書くのもそこだけで、ゲイン 0 なら結果が '
                + 'K_TE_TV_MIN に落ち、`<= K_TE_TV_MIN` 分岐に入って「最小デューティ」ではなく厳密に 0 になる。'
                + 'karter16 も実車ログで同じ挙動を確認している。ゲートされない経路が 1 つだけあり、'
                + 'TEFC アイドル機能検査中（TEFC_LL_ST 0x10-0x15）はデューティが TEFC のランプ由来になる — '
                + 'ただし K_TEFC_N_MIN / K_TEFC_N_MAX / K_TEFC_LL_ML_MAX が全部 raw 0 なので到達しないと見られ、'
                + 'Session #902 では 657 秒間 TEFC_LL_ST は 0 のままだった。'
                + '**チューニング専用** — キャニスタがパージされなくなり、DTC 24 は「開かないバルブ」の符号。',
        },
    },
    {
        kind: 'map', symbol: 'KF_TE_N_RF_TVTE', address: 0xC6A, bank: 'slave',
        category: 'fuel', label: 'TANK VENT DUTY',
        description: {
            en: 'Purge duty against rpm and relative filling — the ceiling, not the value. The DME '
                + 'computes TETV as this map times K_TE_TVTE_GA times TE_F_VENTIL, where TE_F_VENTIL is '
                + "the purge scheduler's enable factor, so the measured duty tracks this map's shape "
                + 'and sits under it. Stock asks 94-99.6 % above 2500 rpm at mid load, which is exactly '
                + 'the region worth tuning.',
            ja: 'rpm × 相対充填に対するパージデューティ。値そのものではなく**天井**。DME は '
                + 'TETV = このマップ × K_TE_TVTE_GA × TE_F_VENTIL で算出し、TE_F_VENTIL は'
                + 'パージ窓のスケジューラ係数なので、実測デューティはこの形をなぞって下側に出る。'
                + '純正は 2500 rpm 以上・中負荷で 94〜99.6 % — チューニングで見たい領域そのもの。',
        },
        x: { address: 0xC44, n: 10, bits: 16, signed: false, units: 'rpm', label: 'N', scaling: IDENTITY },
        y: { address: 0xC58, n: 9, bits: 16, signed: false, units: '', label: 'RF', scaling: divideBy(1000) },
        // (x*100)/256 in the XDF, i.e. a byte spanning 0-99.6 %.
        values: { address: 0xC6A, rows: 9, cols: 10, bits: 8, signed: false, units: '%', scaling: divideBy(2.56) },
    },
    {
        kind: 'constant', symbol: 'k_te_tetv_reference_flow', address: 0xE69C, bank: 'master',
        category: 'fuel', label: 'TANK VENT FLOW',
        bits: 16, signed: false, units: 'mg/min', scaling: IDENTITY,
        description: {
            en: 'Reference flow through the tank-vent valve when fully open. Stock 800 mg/min. This is '
                + 'the number m_calc scales by TETV to estimate how much air the purge path is '
                + 'contributing, and then subtracts from the cylinder charge — which is how purge '
                + 'reaches rf_p_saug and therefore RF.',
            ja: '全開時の TETV バルブ基準流量。純正 800 mg/min。m_calc はこの値を TETV でスケールして'
                + 'パージ経路の空気量を見積もり、シリンダ充填から差し引く — パージが rf_p_saug、'
                + 'ひいては RF に届く経路がこれ。',
        },
    },
];
