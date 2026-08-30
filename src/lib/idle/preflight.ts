/**
 * The preconditions from section 7.1 of `docs/csl_idle_control_from_code.md`, as a decision.
 *
 * That document recovers what actually controls warm idle from the disassembly and then says, of
 * its own numbers, that almost all of them are model outputs rather than measurements — and that
 * two of them are not numbers at all but questions neither binary image can answer:
 *
 *   is the governor in its settled state, and is the throttle plate where the split says it is?
 *
 * Both are throttle-body adaptation state. If either fails, the rest of that document does not
 * describe this car, and a dwell recorded anyway is measuring a controller that is not running.
 *
 * ## Why this is a library and not part of the panel
 *
 * It is a verdict with named consequences, and a verdict that lives inside a component cannot be
 * tested against anything. The same split the tuner already has: `tuner.ts` decides, `IdlePanel`
 * renders. Here it means `verify:idle` can drive these tests from the simulated engine and check
 * that they fire when they should — including the case that matters, a run taken outside state 2.
 *
 * ## Where the thresholds come from
 *
 * `K_LFR_EGAS_ABW`, `K_FR_EDK_DIFF` and the authority floor are all read from the loaded binary via
 * `readIdleTables`. Quoting a threshold from a reference image is the same class of mistake as
 * quoting a value from one, and this feature has already made that mistake once. The one exception
 * is the 25 % duty test, which is an inference from the investigation rather than a calibration
 * constant — and it says so, in the test itself.
 */

import type { IdleSample } from '@/lib/dme-link/types';
import type { IdleTables } from './idleTables';

export type PreflightStatus = 'ok' | 'fail' | 'unknown';

export interface PreflightTest {
    /** The channel or comparison, as the DME names it. Instrument shorthand, so it does not translate. */
    id: string;
    status: PreflightStatus;
    /** The measured value, or null when the channel has not arrived. */
    value: number | null;
    /** A second value where the test is a comparison — `WDK_SOLL` against `WDK_WORD`, the ceiling
     *  against the demand. Null when the test reads one channel. */
    against: number | null;
    /** The rule, formatted with the binary's own threshold. */
    rule: string;
    unit: string;
    /** What being on the wrong side MEANS. The reason this exists at all. */
    consequence: { en: string; ja: string };
    /** True for the one test that invalidates every other reading. */
    fatal?: boolean;
    /** True where the threshold is NOT read from the binary. One test only. */
    thresholdIsInference?: boolean;
}

export interface PreflightVerdict {
    tests: PreflightTest[];
    /** A fatal test failed: nothing below it is a measurement. */
    blocked: boolean;
    /** Any test failed. */
    anyFail: boolean;
    /** Any channel has not arrived yet — the slow lane has not come round, or the fallback profile
     *  is running and never will. */
    anyUnknown: boolean;
    /** How many samples the medians were taken over. */
    samplesUsed: number;
}

/** The duty above which the load model is no longer on its bottom-row rail. INFERENCE, from the
 *  investigation, not a constant in the binary — which is why the test carries a flag saying so. */
export const PREFLIGHT_DUTY_CEILING_PCT = 25;

/**
 * The first breakpoint of `KL_MD_RES_LRW` (master 0x97D8), in degrees of steering wheel angle.
 *
 * Not an inference: raw 11886 with the curve's own `x * 0.04375` scaling, re-read from the car's
 * image and byte-identical to the reference one. Below it `klu_wint` returns y[0] = 0 and the
 * steering torque reserve is zero, which is what keeps MD_LLR_TZ cleared at idle.
 */
export const LWS_RESERVE_BREAKPOINT_DEG = 11886 * 0.04375;

/**
 * How far the intake cam may sit from its commanded stop before the reading is called a failure,
 * degKW. INFERENCE — the binary contains no such tolerance.
 *
 * It only has to separate the two states this test exists to tell apart, and those are 7.5 degKW
 * apart (K_EVAN1_SOLL_MAX 60.0 against K_EVAN1_DRUCK 52.5). 2.0 sits comfortably inside that gap
 * while leaving room for the control deviation a cam parked against a mechanical stop really shows.
 */
export const EVAN_POSITION_TOLERANCE_DEG_KW = 2.0;

/** Median of the non-null values, so one split RAM read cannot decide a verdict. */
function median(values: readonly (number | null)[]): number | null {
    const v = values.filter((x): x is number => x !== null && Number.isFinite(x)).sort((a, b) => a - b);
    return v.length ? v[Math.floor(v.length / 2)] : null;
}

/**
 * @param window How many trailing samples to judge over. A window rather than the latest sample
 *   because these are steady-state facts; a window rather than the whole run because a run
 *   deliberately contains rev segments where they are SUPPOSED to fail.
 */
export function evaluateIdlePreflight(
    samples: readonly IdleSample[],
    tables: IdleTables | null,
    window = 40,
): PreflightVerdict | null {
    if (!tables || samples.length === 0) return null;
    const tail = samples.slice(-window);
    const m = (pick: (s: IdleSample) => number | null) => median(tail.map(pick));

    const zustand = m(s => s.lfrZustand);
    const wdkWord = m(s => s.wdkWord);
    const wdkSoll = m(s => s.wdkSoll);
    const mlSoll = m(s => s.mlSoll);
    const mlMax = m(s => s.mlSollMaxLls);
    const llsTv = m(s => s.llsTv);
    const egasMax = m(s => s.egasMaxWdk);
    const resKath = m(s => s.mdResKath);
    const resLrw = m(s => s.mdResLrw);
    const lrwSt = m(s => s.mdResLrwSt);
    const lws = m(s => s.lwsLrw);
    const evanIst = m(s => s.evan1Ist);
    const evanSoll = m(s => s.evan1Soll);
    const evanSt = m(s => s.evan1St);
    // Derived rather than read: MD_RES lives at 0xFFD8CA, 74 bytes below the pair, and
    // `md_res_calc` 0x017D44-0x017D5E computes exactly this maximum. Taking it from the two operands
    // costs nothing and says WHICH reserve is up, which the maximum alone cannot.
    const mdRes = resKath !== null && resLrw !== null ? Math.max(resKath, resLrw) : null;
    const gap = wdkWord !== null && wdkSoll !== null ? Math.abs(wdkWord - wdkSoll) : null;

    const judge = (present: number | null, ok: boolean): PreflightStatus =>
        present === null ? 'unknown' : ok ? 'ok' : 'fail';

    const tests: PreflightTest[] = [
        {
            id: 'LFR_ZUSTAND',
            status: judge(zustand, zustand === 2),
            value: zustand, against: null, rule: '= 2', unit: '',
            fatal: true,
            consequence: {
                ja: '2 が整定アイドル調速器。外れていれば KF_LFR_DQI は積分せず lfra_adapt は適応しない。'
                    + 'その状態で取った dwell は「動いていない制御器」を測っている。',
                en: '2 is the settled idle regulator. Outside it KF_LFR_DQI does not integrate and '
                    + 'lfra_adapt does not adapt, so a dwell taken there measures a controller that is '
                    + 'not running.',
            },
        },
        {
            id: 'WDK_WORD − WDK_SOLL',
            status: judge(gap, gap !== null && gap <= tables.egasAbwPct),
            value: wdkWord, against: wdkSoll,
            rule: `|Δ| <= K_LFR_EGAS_ABW ${tables.egasAbwPct.toFixed(1)}`, unit: '%',
            consequence: {
                ja: '超えると調速器が整定状態を外れ、積分と適応が止まる。'
                    + 'これは較正ではなくスロットルボディの学習状態で、どちらの BIN にも答えは無い。',
                en: 'Past it the governor leaves its settled state and both integration and adaptation '
                    + 'stop. This is throttle-body adaptation state, not calibration: no binary contains '
                    + 'the answer.',
            },
        },
        {
            id: 'WDK gap vs FR',
            status: judge(gap, gap !== null && gap <= tables.frEdkDiffPct),
            value: gap, against: null,
            rule: `<= K_FR_EDK_DIFF ${tables.frEdkDiffPct.toFixed(1)}`, unit: '%',
            consequence: {
                ja: '超えると FR_REG_I が凍結する ——最大 ±20 % の乗算補正を持ったまま。'
                    + '凍結側も追従側も安定で、その遷移だけが不安定。',
                en: 'Past it FR_REG_I freezes, holding up to +/-20 % of multiplicative correction. '
                    + 'Frozen and tracking are both stable; the transition between them is not.',
            },
        },
        {
            id: 'ML_SOLL < ML_SOLL_MAX_LLS',
            status: judge(mlSoll !== null && mlMax !== null ? 1 : null,
                mlSoll !== null && mlMax !== null && mlSoll < mlMax),
            value: mlSoll, against: mlMax,
            rule: 'demand < ceiling',
            unit: 'kg/h',
            consequence: {
                ja: '成り立っていれば WDK_SOLL は 0.0 %、空気は全部アイドル弁が運んでいる。'
                    + '成り立たなければスロットルが分担しており、権限の順位そのものが変わる。'
                    + '同一テレグラムで読んでいるので、これは 2 時点の比較ではない。',
                en: 'If it holds, WDK_SOLL is 0.0 % and the valve carries all the air. If it does not, '
                    + 'the throttle is taking a share and the authority ranking itself moves. Read in one '
                    + 'telegram, so this is a comparison rather than two moments.',
            },
        },
        {
            id: 'ML_SOLL vs authority floor',
            status: judge(mlSoll, mlSoll !== null && mlSoll >= tables.qvsAuthorityFloorKgH),
            value: mlSoll, against: null,
            rule: `>= ${tables.qvsAuthorityFloorKgH.toFixed(1)}`, unit: 'kg/h',
            // Flagged when KF_LLS_TV's first row is NOT railed: the breakpoint is then an upper
            // bound on the floor rather than the floor, so the threshold stops being a measured
            // fact about this calibration.
            thresholdIsInference: !tables.authorityFloorIsRailed,
            consequence: {
                ja: '下回ると LLS_TV_BEGR bit0 が立ち、FRA が完全にブロックされる。'
                    + '床は KF_LLS_TV の第 1 ブレークポイントから毎回導出している。'
                    + (tables.authorityFloorIsRailed ? ''
                        : ' **この BIN では第 1 行が K_LLS_TV_MIN に張り付いていない**ので、'
                        + 'この値は床そのものではなく床の上限である。実際の床はこれより下にある。'),
                en: 'Below it LLS_TV_BEGR bit 0 sets and FRA is blocked entirely. The floor is derived '
                    + 'from KF_LLS_TV every time rather than stated.'
                    + (tables.authorityFloorIsRailed ? ''
                        : ' **In THIS binary the first row is not railed at K_LLS_TV_MIN**, so this is an '
                        + 'upper bound on the floor rather than the floor. The real one is lower.'),
            },
        },
        {
            id: 'LLS_TV',
            status: judge(llsTv, llsTv !== null && llsTv <= PREFLIGHT_DUTY_CEILING_PCT),
            value: llsTv, against: null,
            rule: `<= ${PREFLIGHT_DUTY_CEILING_PCT}`, unit: '%',
            thresholdIsInference: true,
            consequence: {
                ja: '約 25 % を超えていれば、負荷モデルは最下行のレール上に無い。'
                    + '「Alpha-N はアイドルで固まっている」系の結論は性質が変わる。'
                    + 'この 25 % だけは BIN からではなく調査ドキュメントからの inference。',
                en: 'Above about 25 % the load model is not on its bottom-row rail, and the "Alpha-N is '
                    + 'frozen at idle" conclusions change character. This threshold alone is an inference '
                    + 'from the investigation rather than a value read from the binary.',
            },
        },
        {
            id: 'MD_RES + MD_RES_LRW_ST bit1',
            status: judge(mdRes !== null && lrwSt !== null ? 1 : null,
                mdRes !== null && mdRes < 0.05 && lrwSt !== null && (Math.round(lrwSt) & 0x02) === 0),
            value: mdRes, against: null,
            rule: '= 0.0 & bit1 clear', unit: 'Nm',
            consequence: {
                ja: '予備トルクが立っていれば lfr_calc 0x026A4C の btst が通り、MD_LLR_TZ は clr されない '
                    + '—— 調速器に速い点火権限がある状態であり、§1.3 の「74.9 ms の空気アクチュエータ 1 個'
                    + 'だけ」という構造がこの瞬間には当てはまらない。原因は 2 つしかない: ステアリングが '
                    + '520 deg 以上（KL_MD_RES_LRW の第 1 ブレークポイント）まで切られているか、触媒暖機中か。'
                    + '**bit0 は見ないこと** —— bit0 は「25 km/h 未満」なので停車中は必ず立っている。'
                    + '判定に使うのは bit1 だけである。',
                en: 'With the reserve up, the btst at lfr_calc 0x026A4C passes and MD_LLR_TZ is not '
                    + 'cleared — the governor has fast ignition authority, so section 1.3\'s "one 74.9 ms '
                    + 'air actuator and nothing else" does not describe this moment. There are only two '
                    + 'causes: the wheel is past 520 deg (KL_MD_RES_LRW\'s first breakpoint), or the '
                    + 'catalyst is heating. **Do not read bit0** — it only means "below 25 km/h" and is '
                    + 'up on every stationary car. bit1 is the gate.',
            },
        },
        {
            id: 'LWS_LRW',
            status: judge(lws, lws !== null && Math.abs(lws) < LWS_RESERVE_BREAKPOINT_DEG),
            value: lws, against: null,
            rule: `|x| < ${LWS_RESERVE_BREAKPOINT_DEG.toFixed(1)}`, unit: 'deg',
            consequence: {
                ja: 'ステアリング角。符号付きで直進が 0 —— can_rx_1f5 0x03C82E の符号絶対値変換から '
                    + 'code-confirmed であり、故障時にも 0 が書かれる（0x03C884）。'
                    + 'したがって **0 は「直進」と「信号が死んでいる」の両方を意味しうる**。'
                    + '区別する唯一の方法は動かすこと: アイドルのままハンドルを左右いっぱいまで回し、'
                    + 'この値が動き、520 deg を越えたところで上の bit1 が立つことを確かめる。'
                    + 'それが本書 §8.1 の第 1 項をコード読解から実車確認へ格上げする唯一の手順である。',
                en: 'Steering angle, signed, straight ahead at 0 — code-confirmed from the sign-magnitude '
                    + 'conversion at can_rx_1f5 0x03C82E, and 0 is also written on sensor fault at '
                    + '0x03C884. So **0 means either "straight" or "the signal is dead"**, and the only '
                    + 'way to tell is to move it: at idle, turn the wheel lock to lock and watch this '
                    + 'value travel and bit1 above set as it passes 520 deg. That is the one procedure '
                    + 'that takes section 8.1 item 1 from a reading of the listing to a fact about this car.',
            },
        },
        {
            id: 'EVAN1_ST bit3',
            status: judge(evanSt, evanSt !== null && (Math.round(evanSt) & 0x08) !== 0),
            value: evanSt === null ? null : Math.round(evanSt), against: null,
            rule: 'bit3 set', unit: '',
            consequence: {
                ja: '**VANOS 油圧確認ラッチ。落ちていれば、このアイドルでは気筒別バランスが動いていない。**'
                    + 'slave 0x0244C6 の `ori.b #$8,(a2)`（a2 = EVAN1_ST）は `EVAN1_IST_FILT` が '
                    + `${tables.evanLatchThresholdDegKw.toFixed(1)} degKW 以下のときだけ実行される。`
                    + `暖機アイドルは K_EVAN1_SOLL_MAX = ${tables.evanSollMaxDegKw.toFixed(1)} degKW（機械ストッパ）を`
                    + '指令しているので、**成立の機会は始動直後の '
                    + `${tables.evanDruckDegKw.toFixed(1)} degKW 指令中しか無い。**成立しなかった個体では `
                    + 'VAN_ED_ST bit4 が無条件にセットされ、LLSYNC_AKTIV 経由で TI_SYNCn が恒久的に阻止される。'
                    + '**故障コードは出ない** —— 位置追従診断は 1300 rpm 未満で無効だから、'
                    + '故障メモリが空であることは証拠にならない。較正では直せない。'
                    + 'なお EVAN1_ST には bit7 など他のビットも立つので、バイトの一致比較で判定してはいけない。',
                en: '**The VANOS oil-pressure latch. Down means cylinder-individual idle balance is not '
                    + 'running during this idle.** The slave executes `ori.b #$8,(a2)` at 0x0244C6 '
                    + '(a2 = EVAN1_ST) only while `EVAN1_IST_FILT` is at or below '
                    + `${tables.evanLatchThresholdDegKw.toFixed(1)} degKW. Warm idle commands `
                    + `K_EVAN1_SOLL_MAX = ${tables.evanSollMaxDegKw.toFixed(1)} degKW — the mechanical stop — so `
                    + `its only chance to arm is the ${tables.evanDruckDegKw.toFixed(1)} degKW command just after `
                    + 'start. On a car where it never armed, VAN_ED_ST bit4 sets unconditionally and '
                    + 'TI_SYNCn is blocked through LLSYNC_AKTIV for as long as the engine runs. **No fault '
                    + 'code is set** — the position diagnostic is gated off below 1300 rpm, so an empty '
                    + 'fault memory is not evidence. This is not fixable in calibration. Note other bits '
                    + '(bit7 among them) also set in EVAN1_ST, so never test this byte for equality.',
            },
        },
        {
            id: 'EVAN1_IST',
            status: judge(evanIst, evanIst !== null
                && Math.abs(evanIst - tables.evanSollMaxDegKw) <= EVAN_POSITION_TOLERANCE_DEG_KW),
            value: evanIst, against: evanSoll,
            rule: `= ${tables.evanSollMaxDegKw.toFixed(1)} +/- ${EVAN_POSITION_TOLERANCE_DEG_KW.toFixed(1)}`,
            unit: '°KW',
            consequence: {
                ja: `暖機アイドルの吸気カム実位置。健全なら K_EVAN1_SOLL_MAX = ${tables.evanSollMaxDegKw.toFixed(1)} degKW、`
                    + `K_EVAN1_DRUCK = ${tables.evanDruckDegKw.toFixed(1)} degKW 付近なら上のラッチが一度も成立していない。`
                    + '**併記した目標（EVAN1_SOLL）が 2 つの故障を切り分ける**: 目標も '
                    + `${tables.evanDruckDegKw.toFixed(1)} なら目標が固定されている（ラッチ未成立）、`
                    + `目標が ${tables.evanSollMaxDegKw.toFixed(1)} なのに実位置が届いていないならカムが機械的に渋い。`
                    + 'しきい値は較正から読んでいる。',
                en: `The intake cam's actual position at warm idle. Healthy is K_EVAN1_SOLL_MAX = ${tables.evanSollMaxDegKw.toFixed(1)} degKW; `
                    + `near K_EVAN1_DRUCK = ${tables.evanDruckDegKw.toFixed(1)} degKW means the latch above never armed. `
                    + '**The target shown beside it separates the two failures**: a target also at '
                    + `${tables.evanDruckDegKw.toFixed(1)} means the target is pinned (latch never armed), while a target `
                    + `of ${tables.evanSollMaxDegKw.toFixed(1)} that the position does not reach means the cam is `
                    + 'mechanically sticky. Both thresholds are read from the calibration.',
            },
        },
        {
            id: 'EGAS_MAX_WDK',
            status: judge(egasMax, egasMax !== null && Math.abs(egasMax - 100) < 0.5),
            value: egasMax, against: null, rule: '= 100.0', unit: '%',
            consequence: {
                ja: 'KF_EGAS_MAX_WDK は全セル 100.0 % で、コードは 2 命令後に 1000 へクランプする。'
                    + 'これが 100.0 でなければ疑うべきはスロットルではなくデコードのほう。',
                en: 'KF_EGAS_MAX_WDK is 100.0 % in every cell and the code clamps to 1000 two instructions '
                    + 'later. If this is not 100.0, the thing to doubt is the decode rather than the '
                    + 'throttle.',
            },
        },
    ];

    return {
        tests,
        blocked: tests.some(x => x.fatal && x.status === 'fail'),
        anyFail: tests.some(x => x.status === 'fail'),
        anyUnknown: tests.some(x => x.status === 'unknown'),
        samplesUsed: tail.length,
    };
}
