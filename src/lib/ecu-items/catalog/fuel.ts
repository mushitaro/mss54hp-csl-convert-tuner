import type { EcuItemDef } from '../types';
import { IDENTITY, divideBy, multiplyBy } from '../codec';

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

    // --- the injection factor that makes a low-load lambda trim mean something else --------------
    //
    // This table is the reason the VE filter throws idle samples away, and reading it is what lets
    // them be kept instead.
    //
    // It was once believed to be a term of the correction, on the reading that the rf = 0.10 row
    // is deliberate enrichment which a lambda-1 loop takes straight back out. Session #920 refuted
    // that: across the y = 0.15 breakpoint of this table the trim is CONTINUOUS (0.9685 -> 0.9699,
    // +0.1 %) while `trim x TI_F_STAT` steps -9.6 %, and the regression slope is -0.025 against
    // the -1 the enrichment reading requires. The factor is small-pulse injector compensation, so
    // the correction is `trim x rf_korr` and this table is READ but not multiplied in. See
    // alphaNTable.ts for the full retraction and verify:ti-factor for the measurement.
    {
        kind: 'map', symbol: 'KF_TI_N_RF', address: 0x08BE, bank: 'slave',
        category: 'fuel', label: 'TI LOAD FACTOR',
        description: {
            en: 'Multiplicative injection factor against rpm and relative filling. Every row at '
                + 'rf >= 0.15 is exactly 1.000; only the rf = 0.10 row is enriched, 1.148-1.297. '
                + 'That row is why a lambda trim measured at the lowest filling is NOT an air-model '
                + 'error -- the loop is cancelling a deliberate enrichment. Anything deriving a '
                + 'correction from low-load trim has to read this to tell the two apart, and must '
                + 'refuse rather than assume 1.0 when it cannot.',
            ja: '回転数と相対充填に対する噴射時間の乗算係数。rf >= 0.15 の行はすべて厳密に 1.000 で、'
                + 'rf = 0.10 行だけが 1.1484〜1.2969（意図的な増量）。'
                + '最低充填でのラムダ補正は空気モデル誤差ではなく、この意図的増量の打ち消しである。'
                + '低負荷トリムから補正を導くものは必ずこの表を読んで両者を切り分けること。'
                + '読めない場合は 1.0 で代替せず拒否する。',
        },
        x: { address: 0x08BE, n: 18, bits: 16, signed: false, units: 'rpm', label: 'RPM', scaling: IDENTITY },
        y: { address: 0x08E2, n: 12, bits: 16, signed: false, units: '', label: 'RF', scaling: divideBy(1000) },
        values: { address: 0x08FA, rows: 12, cols: 18, bits: 8, signed: false, units: '', scaling: divideBy(128) },
    },
    {
        kind: 'map', symbol: 'KF_TI_N_RF_VL', address: 0x0B30, bank: 'slave',
        category: 'fuel', label: 'TI LOAD FACTOR VL',
        description: {
            en: 'The full-load branch of the same factor. Worth surfacing for a reason beyond its own '
                + 'content: its z data starts at 0x0B5A, which is exactly EXPERIMENTAL_CONFIG.'
                + 'ADDRESS_WOT_MAP. The app has been writing this table under the name "WOT MAP" all '
                + 'along, with a comment saying its scaling had never been checked against the XDF. '
                + 'It now is -- u8, x/128, 3 x 18 -- and it matches what setWOTMap assumes.',
            ja: '同じ係数の全負荷側。内容以上に重要な点がある: z データの先頭 0x0B5A は '
                + 'EXPERIMENTAL_CONFIG.ADDRESS_WOT_MAP と同一で、'
                + 'このアプリは「WOT MAP」という名前でこの表を書き続けてきた。'
                + '「スケーリングを XDF と未照合」というコメントが付いていたが、'
                + 'u8 / x/128 / 3x18 で setWOTMap の想定と一致することをここで確認した。',
        },
        x: { address: 0x0B30, n: 18, bits: 16, signed: false, units: 'rpm', label: 'RPM', scaling: IDENTITY },
        y: { address: 0x0B54, n: 3, bits: 16, signed: false, units: '', label: 'RF', scaling: divideBy(1000) },
        values: { address: 0x0B5A, rows: 3, cols: 18, bits: 8, signed: false, units: '', scaling: divideBy(128) },
    },
    {
        kind: 'curve', symbol: 'KL_TI_N_ZWD_LL', address: 0x00B2, bank: 'slave',
        category: 'fuel', label: 'TI IDLE FACTOR',
        description: {
            en: 'THE UNRESOLVED BRANCH. ti_load_factor selects between KF_TI_N_RF, KF_TI_N_RF_VL and '
                + 'this, and the inner branch conditions are not in the recovered code. It reads '
                + '0.859 above 800 rpm -- BELOW 1.0 -- so if this is what runs at idle then the '
                + 'correction inverts and a measured trim of 1.16 would mean "the model is right" '
                + 'rather than "16 % lean". Surfaced so the value can be seen; nothing may derive '
                + 'from the low-load rows until which branch runs is settled on the car.',
            ja: '**未解決の分岐。** ti_load_factor は KF_TI_N_RF / KF_TI_N_RF_VL / 本表 の 3 択で、'
                + '内側の分岐条件は復元コードに無い。800 rpm 以上で 0.859 ——**1.0 未満**——なので、'
                + 'アイドルでこちらが引かれているなら補正の向きが反転し、'
                + '実測トリム 1.16 は「16 % 薄い」ではなく「モデルは正しい」を意味することになる。'
                + '値を見えるようにするために出している。どちらの枝が走るかが実車で決まるまで、'
                + '低開度行から何も導出してはいけない。',
        },
        x: { address: 0x00B2, n: 6, bits: 8, signed: false, units: 'rpm', label: 'N40', scaling: multiplyBy(40) },
        values: { address: 0x00B8, n: 6, bits: 8, signed: false, units: '', scaling: divideBy(128) },
    },
    {
        kind: 'constant', symbol: 'K_LA_TI_MIN', address: 0x4844, bank: 'slave',
        category: 'fuel', label: 'LAMBDA TI MIN',
        bits: 16, signed: false, units: 'ms', scaling: divideBy(1000),
        description: {
            en: 'Injection time below which the DME opens the lambda loop (FR 5.01, and 30-idle-'
                + 'control.md §7 condition 5). Stock 1.05 ms. It bites precisely in the low-load '
                + 'region a low-opening correction is derived from, and it is free to check: ti1..ti6 '
                + 'are already inside the 90-byte block 19 response.',
            ja: 'いずれかの気筒の噴射時間がこれを下回ると DME は λ ループを開く'
                + '（FR 5.01 / 30-idle-control.md §7 条件 5）。純正 1.05 ms。'
                + '低開度補正を導出する領域でまさに効き、しかも ti1..ti6 は既に取得している'
                + 'block 19 の 90 バイトの中にあるので測定コストはゼロ。',
        },
    },
];
