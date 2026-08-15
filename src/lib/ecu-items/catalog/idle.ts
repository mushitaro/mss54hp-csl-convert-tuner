import type { EcuItemDef } from '../types';
import { IDENTITY, divideBy, minus } from '../codec';

/**
 * Idle-side items. Surfaced for reading only — nothing here is a recommended edit.
 *
 * The A/C entries in particular are the mechanism behind a symptom the community has never solved
 * on the stock CSL bootloader; no verified fix values exist for them. Full narrative:
 * docs/ecu-logic/30-idle-control.md and 40-fr-adaptation-bug.md.
 */
export const IDLE_ITEMS: EcuItemDef[] = [
    {
        kind: 'constant', symbol: 'K_LFR_NSOLL_AC', address: 0x9A4A, bank: 'master',
        category: 'idle', label: 'IDLE A/C',
        bits: 16, signed: false, units: 'rpm', scaling: IDENTITY,
        description: {
            en: 'Idle target while the A/C compressor is engaged. Stock 870 rpm — which is also '
                + 'what KL_LFR_NSOLL_GRUND already asks for at 50 °C and 80 °C, so once warm the '
                + 'A/C raises the target by nothing and the governor absorbs the whole step load.',
            ja: 'A/C コンプレッサ作動時のアイドル目標。純正 870 rpm。'
                + 'KL_LFR_NSOLL_GRUND の 50 °C / 80 °C も同じ 870 rpm なので、'
                + '暖機後は引き上げ幅がゼロになり、ステップ負荷を制御器が丸ごと吸収させられる。',
        },
    },
    {
        kind: 'curve', symbol: 'KL_LFR_NSOLL_GRUND', address: 0x9A64, bank: 'master',
        category: 'idle', label: 'IDLE TARGET',
        description: {
            en: 'Base idle target against coolant temperature. Stock 1050 / 920 / 870 / 870 rpm at '
                + '-30 / 20 / 50 / 80 °C.',
            ja: '水温に対する基本アイドル目標。純正 −30/20/50/80 °C で 1050/920/870/870 rpm。',
        },
        x: { address: 0x9A64, n: 4, bits: 16, signed: false, units: '°C', label: 'TMOT', scaling: minus(48) },
        values: { address: 0x9A6C, n: 4, bits: 16, signed: false, units: 'rpm', scaling: IDENTITY },
    },
    {
        kind: 'curve', symbol: 'KL_LFR_NSOLL_START', address: 0x9A56, bank: 'master',
        category: 'idle', label: 'IDLE START',
        description: {
            en: 'Idle target during and just after start. Stock 1300 / 1100 / 950 rpm at -30 / 30 / 85 °C.',
            ja: '始動中・始動直後のアイドル目標。純正 −30/30/85 °C で 1300/1100/950 rpm。',
        },
        x: { address: 0x9A56, n: 3, bits: 16, signed: false, units: '°C', label: 'TMOT', scaling: minus(48) },
        values: { address: 0x9A5C, n: 3, bits: 16, signed: false, units: 'rpm', scaling: IDENTITY },
    },
    {
        kind: 'constant', symbol: 'K_LFR_TMOT_ADAPT', address: 0x9D4E, bank: 'master',
        category: 'idle', label: 'IDLE ADAPT TEMP',
        bits: 8, signed: false, units: '°C', scaling: minus(48),
        description: {
            en: 'Coolant temperature above which idle adaptation is allowed to run. Stock 70 °C.',
            ja: 'アイドル適応の実行を許可する水温。純正 70 °C。',
        },
    },
    {
        kind: 'constant', symbol: 'K_LFR_DMDADAPT_MAX', address: 0x9D42, bank: 'master',
        category: 'idle', label: 'IDLE ADAPT STEP',
        bits: 16, signed: false, units: 'Nm', scaling: divideBy(160),
        description: {
            en: 'How far idle adaptation may travel in one phase. Stock 1.0 Nm — small enough that '
                + 'the A/C-on and A/C-off integrators are always catching up after a compressor cycle.',
            ja: 'アイドル適応の 1 フェーズあたり移動量上限。純正 1.0 Nm。'
                + 'A/C ON 用と OFF 用の積分器はコンプレッサ入切のたびに追随が遅れる。',
        },
    },
    {
        kind: 'constant', symbol: 'K_LL_AKTIV_CONTROL', address: 0x1013, bank: 'slave',
        category: 'idle', label: 'LLSYNC MASK',
        bits: 8, signed: false, units: '', scaling: IDENTITY,
        description: {
            en: 'Blocking mask for idle synchronisation. Stock 0xBF — bit 6, "block while the A/C '
                + 'compressor is engaged", is CLEAR, so per-cylinder trim keeps being learned '
                + 'through the compressor disturbance.',
            ja: 'アイドル同期のブロックマスク。純正 0xBF ＝ bit6「A/C コンプレッサ作動中はブロック」が'
                + 'クリアされており、コンプレッサ外乱の最中も気筒別 ti 学習が走る。',
        },
    },
    {
        kind: 'constant', symbol: 'K_FR_T_ADAPT', address: 0xE002, bank: 'master',
        category: 'idle', label: 'FR ADAPT LOCKOUT',
        bits: 16, signed: false, units: 's', scaling: divideBy(100),
        description: {
            en: 'Filling-regulator adaptation lockout. READ THIS ONE CAREFULLY: what these two '
                + 'bytes mean depends on the PROGRAM image, which is not in the partial BIN. '
                + '00 96 = stock (1.50 s). 01 00 = Community Patch v1 (2.56 s). 01 96 = Terra, '
                + 'whose program reads only 0xE003 as a byte and lands 0x9600 = 384 s in the timer, '
                + 'so adaptation effectively never runs. Do not copy a value between lineages.',
            ja: '充填レギュレータ適応のロックアウト時間。**要注意**: この 2 バイトの意味は'
                + 'プログラム側の命令に依存し、その命令はパーシャル BIN に含まれない。'
                + '00 96 = 素の CSL（1.50 s）／01 00 = Community Patch v1（2.56 s）／'
                + '01 96 = Terra（プログラムが 0xE003 を 1 バイトで読むため実効 0x9600 = 384 s ＝適応がほぼ停止）。'
                + '系統をまたいで値をコピーしてはいけない。',
        },
    },
];
