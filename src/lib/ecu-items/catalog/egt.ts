import { EcuItemDef } from '../types';
import { IDENTITY, divideBy, reciprocal } from '../codec';

/**
 * Exhaust-gas-temperature items: the rf_korr density correction, the TABG acquisition chain, and
 * the TI_KATS cat-protection enrichment.
 *
 * Values quoted in the comments are what the stock 0401 calibration holds, read out of
 * `Full 211323000401PD31_TERRA.bin`. They are here so a decoded item that disagrees is obvious.
 * Full narrative: docs/ecu-logic/20-egt-correction.md.
 */
export const EGT_ITEMS: EcuItemDef[] = [
    // --- rf_korr: the correction that scales the Alpha-N output -------------------------------
    {
        kind: 'map', symbol: 'KF_RF_KORR_DRREL', address: 0xE84A, bank: 'master',
        category: 'egt', label: 'RF KORR',
        description: {
            en: 'Dimensionless RF correction. Once load and road speed allow it, rf_korr is taken '
                + 'from here and scales RF for temperature-driven density effects. Peaks at 1.371 '
                + 'around 2350 rpm with a 400 °C model-minus-measured delta.',
            ja: '無次元の RF 補正係数。負荷と車速の条件が成立すると rf_korr をここから取り、'
                + '温度起因の密度変化に合わせて RF をスケーリングする。'
                + '2350 rpm / Δ400 °C で最大 1.371。',
        },
        x: { address: 0xE84A, n: 12, bits: 16, signed: false, units: 'rpm', label: 'RPM', scaling: IDENTITY },
        y: { address: 0xE862, n: 6, bits: 16, signed: false, units: '°C', label: 'TABG Δ', scaling: IDENTITY },
        values: { address: 0xE86E, rows: 6, cols: 12, bits: 16, signed: false, units: '', scaling: divideBy(1024) },
    },
    {
        kind: 'map', symbol: 'kf_rf_tabg_modell', address: 0xE7B0, bank: 'master',
        category: 'egt', label: 'TABG MODEL',
        description: {
            en: 'Nominal exhaust temperature for a given rpm and filling — what BMW measured on the '
                + 'bench. rf_korr keys off this minus the measured TABG.',
            ja: '回転数と充填率に対する公称排気温度（BMW がベンチで実測した値）。'
                + 'これと実測 TABG の差が rf_korr の入力になる。',
        },
        x: { address: 0xE7B0, n: 10, bits: 16, signed: false, units: 'rpm', label: 'RPM', scaling: IDENTITY },
        y: { address: 0xE7C4, n: 6, bits: 16, signed: false, units: '', label: 'RF', scaling: divideBy(1000) },
        values: { address: 0xE7D0, rows: 6, cols: 10, bits: 16, signed: false, units: '°C', scaling: divideBy(16) },
    },
    {
        kind: 'curve', symbol: 'kl_rf_korr_rf_min', address: 0xE900, bank: 'master',
        category: 'egt', label: 'RF KORR MIN',
        description: {
            en: 'Filling floor, per rpm, above which rf_korr is allowed to engage. Stock: 0.70 at '
                + '1400 rpm, 0.55 at 1600, 0.65 through the midrange, 0.80 at 4000.',
            ja: 'rf_korr の作動を許可する RF（充填率）下限を回転数ごとに与えるカーブ。'
                + '純正は 1400 rpm:0.70 / 1600:0.55 / 中速域 0.65 / 4000:0.80。',
        },
        x: { address: 0xE900, n: 6, bits: 16, signed: false, units: 'rpm', label: 'RPM', scaling: IDENTITY },
        values: { address: 0xE90C, n: 6, bits: 16, signed: false, units: '', scaling: divideBy(1000) },
    },
    {
        kind: 'constant', symbol: 'k_rf_korr_hys', address: 0xE918, bank: 'master',
        category: 'egt', label: 'RF KORR HYS',
        bits: 16, signed: false, units: 'RF', scaling: divideBy(1000),
        description: {
            en: 'Release hysteresis. Once engaged, rf_korr holds its previous value until rf_soll '
                + 'drops this far below the kl_rf_korr_rf_min floor. Stock 0.1.',
            ja: '解除側のヒステリシス。一度作動したら、rf_soll が下限からこの分だけ下回るまで前回値を保持する。純正 0.1。',
        },
    },
    {
        kind: 'constant', symbol: 'k_rf_korr_v_min', address: 0xE91A, bank: 'master',
        category: 'egt', label: 'RF KORR V MIN',
        bits: 8, signed: false, units: 'km/h', scaling: IDENTITY,
        description: {
            en: 'Road speed below which rf_korr is forced to 1.0. Stock 20 km/h — which is why the '
                + 'correction can never act at idle or on a stationary car.',
            ja: 'これ未満の車速では rf_korr が必ず 1.0 になる。純正 20 km/h。'
                + 'アイドルや停車中にこの補正が効かないのはこのため。',
        },
    },
    {
        kind: 'constant', symbol: 'k_rf_cfg', address: 0xE5E4, bank: 'master',
        category: 'load', label: 'RF CFG',
        bits: 8, signed: false, units: '', scaling: IDENTITY,
        description: {
            en: 'RF source configuration. 0x00 rf_soll (with the TABG correction); 0x01 rf_p_saug; '
                + '0x04 rf_hfm1; 0x10 rf_soll plus the MAP integrator. Stock 0x12; this app\'s '
                + 'PATCH writes 0x02 to drop the MAP integrator and run pure Alpha-N.',
            ja: 'RF の算出方式。0x00 = rf_soll（TABG 補正込み）／0x01 = rf_p_saug／'
                + '0x04 = rf_hfm1／0x10 = rf_soll + MAP 積分。純正 0x12、本アプリの PATCH は 0x02。',
        },
    },

    // --- TABG acquisition ----------------------------------------------------------------------
    {
        kind: 'constant', symbol: 'K_TABG_CFG', address: 0xC556, bank: 'master',
        category: 'egt', label: 'TABG CFG',
        bits: 8, signed: false, units: '', scaling: IDENTITY,
        description: {
            en: '0 = a real Pt200 sensor is fitted; 1-5 = run on the substitute model. Stock 0. On a '
                + 'converted car with no EGT sensor this staying at 0 is worth checking: TABG then '
                + 'reads wrong and tabg_delta biases the mixture rich.',
            ja: '0 = Pt200 センサ実装／1–5 = 代替値運転。純正 0。'
                + '排気温センサ未装着の換装車では要確認 — TABG が正しく読めず tabg_delta が増量側に張り付く。',
        },
    },
    {
        kind: 'constant', symbol: 'K_TABG_TAU', address: 0xC56A, bank: 'master',
        category: 'egt', label: 'TABG TAU',
        bits: 8, signed: false, units: 's', scaling: reciprocal(25.6),
        description: {
            en: 'PT1 time constant on the measured exhaust temperature. Stock 0.2 s.',
            ja: '実測排気温の PT1 フィルタ時定数。純正 0.2 s。',
        },
    },
    {
        kind: 'constant', symbol: 'K_TABG_DIAG_MIN', address: 0xC55E, bank: 'master',
        category: 'egt', label: 'TABG DIAG MIN',
        bits: 16, signed: true, units: '°C', scaling: IDENTITY,
        description: {
            en: 'Below this, the sensor is called shorted to ground. Stock -50 °C.',
            ja: 'これを下回るとセンサの対 GND ショートと判定。純正 −50 °C。',
        },
    },
    {
        kind: 'constant', symbol: 'K_TABG_DIAG_MAX', address: 0xC560, bank: 'master',
        category: 'egt', label: 'TABG DIAG MAX',
        bits: 16, signed: true, units: '°C', scaling: IDENTITY,
        description: {
            en: 'Above this, the sensor is called shorted to battery. Stock 1200 °C.',
            ja: 'これを上回るとセンサの対 Ub ショートと判定。純正 1200 °C。',
        },
    },

    // --- TI_KATS: cat-protection enrichment (slave) ---------------------------------------------
    {
        kind: 'constant', symbol: 'K_TI_KATS', address: 0x0072, bank: 'slave',
        category: 'egt', label: 'TI KATS GAIN',
        bits: 16, signed: false, units: '1/KW', scaling: divideBy(26214),
        description: {
            en: 'Gain on the knock-retard feed-forward branch of cat protection. Stock 0.0, which '
                + 'makes that whole branch inert — only the TABG-driven integrator is alive.',
            ja: '触媒保護の先行制御（ノック遅角起因の増量）のゲイン。純正 0.0 ＝ その枝は完全に不活性で、'
                + 'TABG 駆動の I 制御器だけが生きている。',
        },
    },
    {
        kind: 'constant', symbol: 'K_TI_F_KATS_MAX', address: 0x0076, bank: 'slave',
        category: 'egt', label: 'TI KATS MAX',
        bits: 16, signed: false, units: '', scaling: divideBy(1024),
        description: {
            en: 'Ceiling on the total cat-protection enrichment factor. Stock 1.3496, i.e. +35 % '
                + 'injection time — and lambda control is off for all of it.',
            ja: '触媒保護の合計増量係数の上限。純正 1.3496（噴射時間 +35 %）。'
                + 'その間ずっと λ 制御は切れている。',
        },
    },
    {
        kind: 'constant', symbol: 'K_TI_KATS_TABG_EIN', address: 0x0078, bank: 'slave',
        category: 'egt', label: 'KATS ON',
        bits: 16, signed: true, units: '°C', scaling: IDENTITY,
        description: {
            en: 'Exhaust temperature at which cat-protection enrichment arms. Stock 850 °C. This is '
                + 'the threshold the log filter\'s Cat Protect EGT control mirrors.',
            ja: '触媒保護増量が入り始める排気温。純正 850 °C。'
                + 'ログフィルタの Cat Protect EGT はこのしきい値に対応している。',
        },
    },
    {
        kind: 'constant', symbol: 'K_TI_KATS_TABG_SCHNELL', address: 0x007A, bank: 'slave',
        category: 'egt', label: 'KATS FAST',
        bits: 16, signed: true, units: '°C', scaling: IDENTITY,
        description: {
            en: 'Above this the integrator ramps at K_TI_KATS_FAK_SCHNELL times the normal step. '
                + 'Stock 860 °C.',
            ja: 'これを超えると積分が K_TI_KATS_FAK_SCHNELL 倍の速度になる。純正 860 °C。',
        },
    },
    {
        kind: 'constant', symbol: 'K_TI_KATS_TABG_AUS', address: 0x007C, bank: 'slave',
        category: 'egt', label: 'KATS OFF',
        bits: 16, signed: true, units: '°C', scaling: IDENTITY,
        description: {
            en: 'Below this the enrichment unwinds. Stock 840 °C. Unwinding takes ~18 s from the '
                + 'ceiling, and lambda stays open the whole time — which is why the log filter '
                + 'keeps excluding for 20 s after this is crossed.',
            ja: 'これを下回ると増量が戻り始める。純正 840 °C。'
                + '上限からの復帰に約 18 秒かかり、その間 λ は開ループのまま。'
                + 'ログフィルタが復帰後 20 秒まで除外を続けるのはこのため。',
        },
    },
    {
        kind: 'constant', symbol: 'K_TI_KATS_FAK_SCHNELL', address: 0x0074, bank: 'slave',
        category: 'egt', label: 'KATS FAST FAC',
        bits: 8, signed: false, units: '', scaling: divideBy(16),
        description: {
            en: 'Multiplier on the integrator step above the fast threshold. Stock 3.0.',
            ja: '高速増量しきい値を超えたときの積分ステップ倍率。純正 3.0。',
        },
    },
];
