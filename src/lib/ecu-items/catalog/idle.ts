import type { EcuItemDef } from '../types';
import { IDENTITY, divideBy, minus } from '../codec';

/**
 * Idle-side items.
 *
 * Two groups, read for different reasons. The first is diagnostic: the A/C entries are the
 * mechanism behind a symptom the community has never solved on the stock CSL bootloader, and no
 * verified fix values exist for them. The second — everything from KF_LLR_QVS_GRUND down — is what
 * the idle feedforward autotune measures against, and it is read out of the loaded binary rather
 * than assumed, because every threshold that decides whether a logged MD_LLRI means anything lives
 * in these bytes.
 *
 * Full narrative: docs/ecu-logic/30-idle-control.md and 40-fr-adaptation-bug.md.
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
        // X/10 signed, per the XDF. This read `divideBy(160)` unsigned until the idle autotune
        // needed the number to be right: 160 is what the two K_LFR_MDREG_* constants a few
        // addresses away use, and it had been carried across. The consequence was quiet rather
        // than loud — the panel showed 0.0625 Nm for a step the calibration sets to 1.0, i.e. the
        // adaptation looked sixteen times weaker than it is, which is exactly the wrong direction
        // to be wrong in about the one confound the idle measurement has to be protected from.
        bits: 16, signed: true, units: 'Nm', scaling: divideBy(10),
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

    // --- the idle air feedforward, and the actuator map that realises it ----------------------
    //
    // These two are the whole of the idle air path in this binary. `llr_qsoll_calc` reduces to
    //
    //     LLR_QSOLL = clamp(K_LLR_Q_MCS + LLR_QVS, >= K_LLR_QSOLL_MIN)
    //
    // and both constants are 0 here, so LLR_QSOLL == LLR_QVS == KF_LLR_QVS_GRUND(N, TMOT): the
    // idle valve is pure feedforward with no integrator of its own. Everything the closed loop
    // does at idle comes out of LFR as a TORQUE instead (MD_LLRI), which is what makes a standing
    // MD_LLRI a statement about THIS map rather than about a controller gain.
    //
    // Both constants are surfaced so that reduction is checkable on the user's own binary rather
    // than inherited from the reference image.
    {
        kind: 'map', symbol: 'KF_LLR_QVS_GRUND', address: 0xA04E, bank: 'master',
        category: 'idle', label: 'IDLE AIR FF',
        description: {
            en: 'Idle air request against rpm and coolant, kg/h — the feedforward the idle valve '
                + 'follows. Stock warm row (80 °C) is 30.0 at 500 rpm and a flat 14.0 from 600 rpm '
                + 'up; the 500 rpm column is high on every row because it is the stall catch. '
                + 'Stored 8-bit as x/2, so one step is 0.5 kg/h — 3.6 % of a warm idle cell, and '
                + 'the floor on how finely anything can correct it.',
            ja: '回転数と水温に対するアイドル空気要求 [kg/h]。アイドル調整弁が追従する'
                + 'フィードフォワードそのもの。純正の暖機行（80 °C）は 500 rpm で 30.0、'
                + '600 rpm 以上は平坦に 14.0。500 rpm 列が全行で高いのは失速キャッチのため。'
                + '8bit x/2 で保存されるので 1 段 = 0.5 kg/h（暖機セルの 3.6 %）であり、'
                + 'これが補正の分解能の下限になる。',
        },
        x: { address: 0xA04E, n: 6, bits: 16, signed: false, units: 'rpm', label: 'RPM', scaling: IDENTITY },
        y: { address: 0xA05A, n: 5, bits: 16, signed: false, units: '°C', label: 'TMOT', scaling: minus(48) },
        values: { address: 0xA064, rows: 5, cols: 6, bits: 8, signed: false, units: 'kg/h', scaling: divideBy(2) },
    },
    {
        kind: 'map', symbol: 'KF_LLS_TV', address: 0x9DE2, bank: 'master',
        category: 'idle', label: 'IDLE VALVE DUTY',
        description: {
            en: 'Idle valve duty against rpm and requested air mass — the actuator model, not the '
                + 'request. Read it for one number above all: the whole y = 11.0 kg/h row is 14.0 % '
                + 'at every rpm, which is K_LLS_TV_MIN. Below 11 kg/h the request has no authority '
                + 'at all, so that is the hard floor for any downward air correction, and it has to '
                + 'be re-derived from each binary rather than assumed.',
            ja: '回転数と要求空気量に対するアイドル弁デューティ。要求ではなくアクチュエータ特性。'
                + '最重要なのは 1 点: y = 11.0 kg/h の行が全 rpm で 14.0 % ＝ K_LLS_TV_MIN であること。'
                + '11 kg/h より下では空気要求に権限が無く、これが空気を減らす向きの補正のハード床になる。'
                + 'BIN ごとに導出し直すこと。',
        },
        x: { address: 0x9DE2, n: 10, bits: 16, signed: false, units: 'rpm', label: 'RPM', scaling: IDENTITY },
        y: { address: 0x9DF6, n: 13, bits: 16, signed: false, units: 'kg/h', label: 'ML LL', scaling: divideBy(40) },
        values: { address: 0x9E10, rows: 13, cols: 10, bits: 16, signed: false, units: '%', scaling: divideBy(50) },
    },
    {
        kind: 'constant', symbol: 'K_LLR_Q_MCS', address: 0xA048, bank: 'master',
        category: 'idle', label: 'IDLE AIR OFFSET',
        bits: 8, signed: false, units: 'kg/h', scaling: divideBy(2),
        description: {
            en: 'Flat offset added to the idle air request before the minimum clamp. Stock 0 — half '
                + 'of why LLR_QSOLL equals KF_LLR_QVS_GRUND exactly. A non-zero value here would '
                + 'shift cold idle and the warm-up ramp together with warm idle.',
            ja: '最小クランプ前にアイドル空気要求へ加算される一律オフセット。純正 0 ——'
                + 'LLR_QSOLL が KF_LLR_QVS_GRUND と厳密に一致する理由の半分。'
                + 'ここが非ゼロだと、暖機後アイドルと一緒に冷間アイドルと暖機ランプも動く。',
        },
    },
    {
        kind: 'constant', symbol: 'K_LLR_QSOLL_MIN', address: 0xA0AE, bank: 'master',
        category: 'idle', label: 'IDLE AIR MIN',
        bits: 16, signed: false, units: 'kg/h', scaling: divideBy(256),
        description: {
            en: 'Lower clamp on the idle air request. Stock 0 — the other half of why the request '
                + 'passes through unchanged. Note this clamp is NOT the floor that matters: the '
                + 'real floor is where KF_LLS_TV stops responding, at its first breakpoint.',
            ja: 'アイドル空気要求の下限クランプ。純正 0 ——要求がそのまま通る理由のもう半分。'
                + 'ただし実効的な床はこれではなく、KF_LLS_TV が応答しなくなる第 1 ブレークポイント。',
        },
    },

    // --- the two preconditions section 7.1 of csl_idle_control_from_code.md turns on -----------
    //
    // Neither is a tuning parameter. Both are thresholds the DME applies to the SAME quantity — how
    // far the throttle plate sits from where it was told to be — and each stops a different control
    // loop when it is exceeded. They are read from the binary rather than quoted because the whole
    // point of that section is to replace quoted numbers with measured ones, and a threshold quoted
    // from a reference image is the same class of mistake as a value quoted from one.
    {
        kind: 'constant', symbol: 'K_LFR_EGAS_ABW', address: 0x9AB8, bank: 'master',
        category: 'idle', label: 'IDLE THROTTLE TOLERANCE',
        bits: 16, signed: false, units: '%', scaling: divideBy(10),
        description: {
            en: 'How far actual throttle may sit from commanded before the idle governor leaves its '
                + 'settled state. Past it, KF_LFR_DQI stops integrating and lfra_adapt stops '
                + 'adapting — so a dwell recorded past it measures a controller that is not running. '
                + 'This is throttle-body adaptation state, not calibration: no binary contains the '
                + 'answer, which is why it has to be measured on the car before anything else.',
            ja: '実スロットルが指令からどれだけ離れてよいか。これを超えるとアイドル調速器は整定状態を'
                + '外れ、KF_LFR_DQI の積分も lfra_adapt の適応も止まる —— つまりその先で取った dwell は'
                + '「動いていない制御器」を測っている。これは較正ではなくスロットルボディの学習状態で'
                + 'あり、どちらの BIN にも答えは無い。だから何よりも先に実車で測る。',
        },
    },
    {
        kind: 'constant', symbol: 'K_FR_EDK_DIFF', address: 0xDFB2, bank: 'master',
        category: 'idle', label: 'FR FREEZE TOLERANCE',
        bits: 16, signed: false, units: '%', scaling: divideBy(10),
        description: {
            en: 'The same difference, at a wider threshold: past this the filling regulator freezes '
                + 'FR_REG_I, which is a pure integrator with up to +/-20 % multiplicative authority '
                + 'on the same actuator the idle governor uses. Frozen and tracking are both stable; '
                + 'the transition between them is not.',
            ja: '同じ差に対する、より広いしきい値。これを超えると充填レギュレータが FR_REG_I を凍結する。'
                + 'FR_REG_I はアイドル調速器と同じアクチュエータ上で最大 ±20 % の乗算権限を持つ純積分器で'
                + 'ある。凍結側も追従側も安定で、その遷移だけが不安定。',
        },
    },

    // --- the LFR integrator: its resting point, and every clamp it can stop against -----------
    //
    // MD_LLRI is the measurement the idle autotune is built on, so what it is ALLOWED to do has to
    // come from the binary. Three clamp pairs reference it and their order of application is not
    // recovered, so all three are surfaced and all three are treated as rails when reading a log:
    // a value that stops at 50 means something different from one that stops at 60 or 80, and
    // guessing which pair won would turn a diagnosis into a fabrication.
    {
        kind: 'constant', symbol: 'K_LFR_MDADAPT_OFFSET', address: 0x9D3E, bank: 'master',
        category: 'idle', label: 'IDLE I TARGET',
        bits: 16, signed: true, units: 'Nm', scaling: divideBy(10),
        description: {
            en: 'The offset idle adaptation integrates against, and therefore the value the governor '
                + 'is DESIGNED to leave its I term resting at: minus this, i.e. -7.0 Nm stock, '
                + 'keeping that much upward headroom in the feedforward. Read this before concluding '
                + 'anything from MD_LLRI — treating 0 as the target would call a correctly '
                + 'calibrated engine 7 Nm short, which at idle is more air than the whole request. '
                + 'Grade: funktionsrahmen-only, FUN_000259de has no recovered statements.',
            ja: 'アイドル適応が積分の基準に使うオフセット。したがって調速器が I 項を'
                + '「置いておく設計になっている」値は 0 ではなく**これの符号反転**、純正 −7.0 Nm。'
                + 'フィードフォワードに上向きの余裕をこれだけ残す意図。'
                + 'MD_LLRI から何かを結論する前に必ず読むこと ——0 を目標と誤ると、'
                + '正しく較正されたエンジンを 7 Nm 不足と判定する。アイドルではそれは要求全体より多い空気量。'
                + '根拠: funktionsrahmen-only（FUN_000259de は復元文 0 件）。',
        },
    },
    {
        kind: 'constant', symbol: 'K_LFR_MD_REG_MIN', address: 0x9D76, bank: 'master',
        category: 'idle', label: 'IDLE I MIN',
        bits: 16, signed: true, units: 'Nm', scaling: divideBy(10),
        description: {
            en: 'Outer lower clamp on MD_LLRI. Stock -80 Nm. A log that sits here is not a '
                + 'measurement of anything: the integrator ran out of authority.',
            ja: 'MD_LLRI の外側下限クランプ。純正 −80 Nm。ここに張り付いたログは測定値ではない'
                + '（積分器が権限を使い切っている）。',
        },
    },
    {
        kind: 'constant', symbol: 'K_LFR_MD_REG_MAX', address: 0x9D78, bank: 'master',
        category: 'idle', label: 'IDLE I MAX',
        bits: 16, signed: true, units: 'Nm', scaling: divideBy(10),
        description: {
            en: 'Outer upper clamp on MD_LLRI. Stock +120 Nm.',
            ja: 'MD_LLRI の外側上限クランプ。純正 +120 Nm。',
        },
    },
    {
        kind: 'constant', symbol: 'K_LFR_MDREG_MIN', address: 0x9A9A, bank: 'master',
        category: 'idle', label: 'IDLE REG MIN',
        bits: 16, signed: true, units: 'Nm', scaling: divideBy(160),
        description: {
            en: 'Inner lower clamp on the governor output. Stock -60 Nm — inside the -80 above, so '
                + 'if MD_LLRI appears to top out near 60 it is this one, not that one. Which pair '
                + 'applies first is not recovered from the binary.',
            ja: '調速器出力の内側下限クランプ。純正 −60 Nm。上の −80 より内側なので、'
                + 'MD_LLRI が 60 付近で頭打ちに見えたらこちらが効いている。'
                + 'どちらの組が先に適用されるかはバイナリから復元できていない。',
        },
    },
    {
        kind: 'constant', symbol: 'K_LFR_MDREG_MAX', address: 0x9A9C, bank: 'master',
        category: 'idle', label: 'IDLE REG MAX',
        bits: 16, signed: true, units: 'Nm', scaling: divideBy(160),
        description: {
            en: 'Inner upper clamp on the governor output. Stock +60 Nm.',
            ja: '調速器出力の内側上限クランプ。純正 +60 Nm。',
        },
    },
    {
        kind: 'constant', symbol: 'K_LFR_ED_MDREG_MIN', address: 0x9D50, bank: 'master',
        category: 'idle', label: 'IDLE ED MIN',
        bits: 16, signed: true, units: 'Nm', scaling: divideBy(160),
        description: {
            en: 'A THIRD lower clamp, on the idle diagnostic path. Stock -50 Nm. Surfaced only so a '
                + 'log that stops at 50 rather than 60 or 80 is legible instead of baffling; which '
                + 'function applies it has not been identified.',
            ja: 'アイドル診断側の**3 組目**の下限クランプ。純正 −50 Nm。'
                + 'ログが 60 でも 80 でもなく 50 で止まったときに読み解けるようにするためだけに出している。'
                + 'どの関数が適用するかは未特定。',
        },
    },
    {
        kind: 'constant', symbol: 'K_LFR_ED_MDREG_MAX', address: 0x9D52, bank: 'master',
        category: 'idle', label: 'IDLE ED MAX',
        bits: 16, signed: true, units: 'Nm', scaling: divideBy(160),
        description: {
            en: 'The third upper clamp. Stock +50 Nm.',
            ja: '3 組目の上限クランプ。純正 +50 Nm。',
        },
    },

    // --- idle valve rails, and the voltage correction that is switched off in this calibration -
    {
        kind: 'constant', symbol: 'K_LLS_TV_MIN', address: 0x9DAE, bank: 'master',
        category: 'idle', label: 'DUTY MIN',
        bits: 16, signed: false, units: '%', scaling: divideBy(50),
        description: {
            en: 'Lower duty rail in normal running. Stock 14.0 % — the same value the whole first '
                + 'row of KF_LLS_TV holds, which is what makes 11 kg/h the point below which the '
                + 'air request stops doing anything.',
            ja: '通常運転時のデューティ下限レール。純正 14.0 % ——KF_LLS_TV の第 1 行全体と同じ値で、'
                + 'これが「11 kg/h より下では空気要求が効かなくなる」根拠。',
        },
    },
    {
        kind: 'constant', symbol: 'K_LLS_TV_MAX', address: 0x9DAC, bank: 'master',
        category: 'idle', label: 'DUTY MAX',
        bits: 16, signed: false, units: '%', scaling: divideBy(50),
        description: {
            en: 'Upper duty rail in normal running. Stock 97.0 %.',
            ja: '通常運転時のデューティ上限レール。純正 97.0 %。',
        },
    },
    {
        kind: 'constant', symbol: 'K_LLS_TV_NOTLAUF_MIN', address: 0x9DB2, bank: 'master',
        category: 'idle', label: 'DUTY LIMP MIN',
        bits: 16, signed: false, units: '%', scaling: divideBy(50),
        description: {
            en: 'Lower duty rail on the limp-home branch (LLS_ST & 0x40). Stock 3.0 %. Read this the '
                + 'right way round: a logged duty of 3.0 % does NOT mean "not at a rail", it means '
                + 'the idle valve has gone into limp and the maps are not being consulted.',
            ja: '非常運転枝（LLS_ST & 0x40）のデューティ下限レール。純正 3.0 %。'
                + '読み違えないこと ——ログの 3.0 % は「レールではない」ではなく'
                + '「アイドル弁が非常運転に入っていてマップが参照されていない」を意味する。',
        },
    },
    {
        kind: 'constant', symbol: 'K_LLS_TV_NOTLAUF_MAX', address: 0x9DB0, bank: 'master',
        category: 'idle', label: 'DUTY LIMP MAX',
        bits: 16, signed: false, units: '%', scaling: divideBy(50),
        description: {
            en: 'Upper duty rail on the limp-home branch. Stock 75.0 %, same caveat as the min.',
            ja: '非常運転枝のデューティ上限レール。純正 75.0 %。下限と同じ注意。',
        },
    },
    {
        kind: 'constant', symbol: 'K_LLS_TV_DREHPUNKT', address: 0x9DB6, bank: 'master',
        category: 'idle', label: 'DUTY PIVOT',
        bits: 16, signed: false, units: '%', scaling: divideBy(50),
        description: {
            en: 'Pivot the battery-voltage correction see-saws about. Stock 30.08 % — and inert, '
                + 'because the curve it multiplies is all zeros (see KL_LLS_UB_KORR).',
            ja: '電池電圧補正がシーソーする支点。純正 30.08 % ——ただし相方のカーブが全ゼロなので'
                + '実質的に効いていない（KL_LLS_UB_KORR を参照）。',
        },
    },
    {
        kind: 'constant', symbol: 'K_LLS_TAU2', address: 0x9DBB, bank: 'master',
        category: 'idle', label: 'DUTY FILTER',
        bits: 8, signed: false, units: '', scaling: IDENTITY,
        description: {
            en: 'PT1 coefficient the blended duty is filtered with before the rails. Stock 32.',
            ja: 'レール適用前にブレンド後デューティへ掛かる PT1 係数。純正 32。',
        },
    },
    {
        kind: 'curve', symbol: 'KL_LLS_UB_KORR', address: 0x9DC0, bank: 'master',
        category: 'idle', label: 'DUTY VOLT CORR',
        description: {
            en: 'Battery-voltage correction on the idle valve duty. ALL FIVE POINTS ARE ZERO in this '
                + 'calibration, so the correction term is identically zero and the duty does not '
                + 'compensate for voltage at all. That is worth knowing in the other direction: a '
                + 'voltage change really does change the air the valve passes, so an electrical load '
                + 'is a disturbance the feedforward cannot see.',
            ja: 'アイドル弁デューティの電池電圧補正。この較正では**5 点すべてゼロ**なので'
                + '補正項は恒等的に 0 で、デューティは電圧を補償していない。'
                + '逆向きに重要: 電圧が動けば同じデューティで通る空気量が実際に変わるので、'
                + '電気負荷はフィードフォワードから見えない外乱になる。',
        },
        x: { address: 0x9DC0, n: 5, bits: 8, signed: false, units: 'V', label: 'UB', scaling: divideBy(10) },
        values: { address: 0x9DC5, n: 5, bits: 8, signed: false, units: '', scaling: divideBy(256) },
    },

    // --- The VANOS hydraulic-confirmation latch ------------------------------------------------
    //
    // Not tuning parameters. These three constants define a latch that, on a car where it never
    // arms, permanently blocks cylinder-individual idle balance — and sets no fault code doing it.
    // They are here so the preflight can state the threshold it judges against instead of quoting
    // 55.0 from a document.
    //
    // The mechanism, read out of the SLAVE at runtime 0x0244A8-0x0244C6 (file 0x0A44A8):
    //
    //     move.w K_EVAN1_DRUCK,d0 / move.w K_EVAN1_DRUCK_HYS,d1 / add.l d1,d0   -> 550
    //     move.w EVAN1_IST_FILT,d1 / cmp.l d1,d0 / blt 0x244DE
    //     ori.b  #$8,(a2)                        a2 = 0xFF81F0 = EVAN1_ST  (set at 0x024340)
    //
    // So bit 3 sets only while the intake cam is at or below 55.0 degKW. Warm idle commands
    // K_EVAN1_SOLL_MAX = 60.0 degKW — the mechanical stop — so the only window in which the latch
    // can ever arm is the 52.5 degKW command just after start.
    {
        kind: 'constant', symbol: 'K_EVAN1_SOLL_MAX', address: 0x180A, bank: 'slave',
        category: 'idle', label: 'VANOS INTAKE TARGET MAX',
        bits: 16, signed: false, units: '°KW', scaling: divideBy(10),
        description: {
            en: 'The upper clamp on the intake cam target, and the angle warm idle actually commands: '
                + 'the mechanical stop. A healthy car reads EVAN1_IST here. Reading 52.5 instead means '
                + 'the hydraulic-confirmation latch never armed and the target is pinned at '
                + 'K_EVAN1_DRUCK, 7.5 degKW away, for as long as the engine runs.',
            ja: '吸気カム目標の上限クランプであり、暖機アイドルが実際に指令している角度 —— 機械ストッパである。'
                + '健全な車は EVAN1_IST がここを示す。52.5 を示していれば油圧確認ラッチが一度も成立しておらず、'
                + '目標は K_EVAN1_DRUCK に 7.5 degKW 離れたまま固定されている。',
        },
    },
    {
        kind: 'constant', symbol: 'K_EVAN1_DRUCK', address: 0x181E, bank: 'slave',
        category: 'idle', label: 'VANOS PRESSURE-CHECK TARGET',
        bits: 16, signed: false, units: '°KW', scaling: divideBy(10),
        description: {
            en: 'Where the intake cam is commanded until the oil-pressure latch arms — and where it '
                + 'stays forever if the latch never does. Do NOT raise it towards 60.0 to "fix" a car '
                + 'that will not latch: the latch tests EVAN1_IST_FILT against this plus its '
                + 'hysteresis, so raising it stops a HEALTHY car arming too.',
            ja: '油圧ラッチが成立するまで吸気カムに指令される角度であり、ラッチが成立しない個体では'
                + 'そのまま永久に留まる角度でもある。ラッチが立たない車を「直す」ために 60.0 へ近づけては'
                + 'いけない —— ラッチは EVAN1_IST_FILT をこの値＋ヒステリシスと比較するので、'
                + '上げると健全な車まで成立しなくなる。',
        },
    },
    {
        kind: 'constant', symbol: 'K_EVAN1_DRUCK_HYS', address: 0x1820, bank: 'slave',
        category: 'idle', label: 'VANOS PRESSURE-CHECK HYSTERESIS',
        bits: 16, signed: false, units: '°KW', scaling: divideBy(10),
        description: {
            en: 'Added to K_EVAN1_DRUCK to form the latch threshold, so the threshold is derived here '
                + 'rather than written down. Raising it lets a sluggish VANOS arm the latch, which is '
                + 'not a fix — it tells the DME oil pressure is established when it is not.',
            ja: '`K_EVAN1_DRUCK` に加算されてラッチ閾値を作る。だから閾値は書き下さず、ここから導出する。'
                + '上げれば渋い VANOS でもラッチが成立するようになるが、それは修理ではない —— '
                + '油圧が確立していないのに確立したと DME に告げる行為である。',
        },
    },
];
