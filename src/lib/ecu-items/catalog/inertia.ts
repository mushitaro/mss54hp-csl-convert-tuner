import type { EcuItemDef } from '../types';
import { IDENTITY, divideBy, multiplyBy, reciprocal } from '../codec';

/**
 * Items whose calibration depends on engine rotational inertia — the flywheel set.
 *
 * Values in the comments are what stock 0401 holds in `Full 211323000401PD31_TERRA.bin`. Yours will
 * differ; that is the entire reason the correction generator reads them out of the loaded BASE
 * image instead of trusting the numbers written here. Full narrative:
 * `docs/ecu-logic/85-flywheel-inertia-autotune.md`.
 *
 * ## The one idea this catalog is organised around
 *
 * Not everything here sees the same inertia, and applying one ratio to all of it is the mistake
 * that motivated the document:
 *
 * - **Engine alone.** Clutch-out, neutral and idle work: the crank is the whole plant, so the
 *   correction is the inertia ratio `r` itself.
 * - **Engine plus the car.** The tip-in and dashpot slew limiters are bypassed below 3 km/h
 *   (`K_MD_DF_VMIN`), so they only ever act with a gear engaged — where the plant is
 *   `J_engine + J_vehicle(gear)` and `J_vehicle` is 3 to 45 times larger. The effective ratio is
 *   0.95 in first and 0.996 in sixth, not 0.82. `KL_MD_JFZ_GANG` below is BMW's own table of that
 *   vehicle inertia, which is what lets the ratio be computed rather than guessed.
 * - **Neither.** The dual-mass flywheel's damper is a spring, not an inertia. Removing it moves the
 *   driveline mode and deletes its damping, and no inertia ratio expresses that.
 *
 * Read-only, like the rest of the catalog. Nothing here writes; `lib/inertia/corrections.ts`
 * proposes and the operator decides.
 */
export const INERTIA_ITEMS: EcuItemDef[] = [
    // --- The inertia constants themselves -------------------------------------------------------
    {
        kind: 'constant', symbol: 'K_SMG_J_MOTOR', address: 0x280A, bank: 'slave',
        category: 'inertia', label: 'SMG J MOTOR',
        bits: 8, signed: false, units: 'Nms²', scaling: divideBy(128),
        description: {
            en: 'The CEILING on the SMG speed regulator\'s commanded slew rate: min(demand, T / this) '
                + 'at slave 0x0383A4/0x0383AE. It is NOT the rev-matching feedforward\'s inertia — that '
                + 'is KL_SMG_MOT_J_MOTOR, which prices the gradient into torque. Raising this lowers the '
                + 'ceiling, so the MAGNITUDE of the re-matching intervention falls in both directions; '
                + 'the sign flips at 0x0383FE against 0xFFDB30 = (target - actual), so an upshift and a '
                + 'downshift move opposite ways and only the magnitude statement holds unconditionally. '
                + 'Acts in the clutch re-engagement phase ONLY (guarded to shift phases 3-4 at '
                + '0x037832): never on a launch (jump table 0x03A23A routes case 1 elsewhere), never '
                + 'during the blip itself, and not on a Zug downshift (0x039208 discards the result). '
                + 'Treat it as a smoothness setting, not a physical constant to be made accurate: stock '
                + '0.25 is deliberately conservative and the rest of the calibration is tuned around the '
                + 'smoothing it provides. Step 0.0078 — and 0.20 is not representable; raw 26 is 0.2031.',
            ja: 'SMG 回転レギュレータの**指令スルーレートの上限**。slave 0x0383A4/0x0383AE で '
                + 'min(指令, T ÷ この値)。**回転合わせフィードフォワードの慣性ではない** — '
                + 'それは KL_SMG_MOT_J_MOTOR で、勾配をトルクに換算する側。'
                + '上げると上限が下がり、**向きを問わず再係合介入の絶対値が小さくなる**。'
                + '0x0383FE が 0xFFDB30 =（目標 − 実回転）の符号で項を反転するので、'
                + 'アップとダウンで向きは逆になり、無条件に成立するのは大きさの主張だけ。'
                + '作用するのは**クラッチ再係合フェーズのみ**（0x037832 で相 3–4 に限定）: '
                + '発進では効かず（ジャンプテーブル 0x03A23A の case 1 は別ハンドラ）、'
                + 'ブリップ本体でも効かず、Zug ダウンシフトでも効かない（0x039208 が結果を廃棄）。'
                + '**「実物理値に合わせる」対象ではなく、再係合の穏やかさのつまみとして扱うこと** — '
                + '純正 0.25 は意図的に保守的で、較正の他の部分はその平滑化を前提にしている。'
                + '刻み 0.0078 — なお 0.20 は表現不能で、raw 26 は 0.2031。',
        },
    },
    {
        kind: 'constant', symbol: 'K_MD_J_MOTOR', address: 0x9554, bank: 'master',
        category: 'inertia', label: 'MD J MOTOR',
        // 16-bit, confirmed against the bytes: 0x9554 holds `00 48`, i.e. raw 72 big-endian across
        // two bytes. Reading it as 8-bit lands on the high byte and returns a clean, plausible 0 —
        // which then makes every effective-inertia ratio come out at exactly 1.0 and the whole
        // in-gear correction quietly disappear. It shares its X/268 scaling with KL_MD_JFZ_GANG
        // below, which is also 16-bit; that pairing is the corroboration.
        bits: 16, signed: false, units: 'Nms²', scaling: divideBy(268),
        description: {
            en: 'The Momentenmanager engine inertia. Stock 0.2687 — a different unit system from '
                + 'K_SMG_J_MOTOR, so compare ratios and not raw values. TWO consumers, and they behave '
                + 'differently: md_max_begr (file 0x1619A) ADDS the term (0x1611B4) and is inert behind '
                + 'KL_MD_BEGR_GANG\'s flat 1000 Nm rail; Torque_Limitation (file 0x16D82) SUBTRACTS it '
                + '(0x16D9A) from MD_NBEGR_I_ZIEL, the soft rev limiter integrator target, and does '
                + 'execute. The signal both multiply is D_N_GEFILTERT (0xFFEC9E), not d_n40. Live but '
                + 'nearly always inconsequential: the limiter arms only within 100 rpm of the cut with a '
                + 'predicted arrival under ~51 ms, and the seed is then clamped up by K_MD_NBEGR_MIN = '
                + '90 Nm, which the load torque rarely clears in neutral or a low gear.',
            ja: 'モーメントマネージャ側のエンジン慣性。純正 0.2687 — K_SMG_J_MOTOR とは'
                + '**単位系が別**なので、生値ではなく比で比べること。**消費者は 2 つ**あり挙動が違う: '
                + 'md_max_begr（file 0x1619A）は項を**加算**し（0x1611B4）、'
                + 'KL_MD_BEGR_GANG の全段 1000 Nm レールの後ろで不活性。'
                + 'Torque_Limitation（file 0x16D82）は**減算**し（0x16D9A）、'
                + 'ソフトレブリミッタの I 項目標 MD_NBEGR_I_ZIEL を作る — **こちらは実行される**。'
                + '両者が掛ける信号は **D_N_GEFILTERT**（0xFFEC9E）であって d_n40 ではない。'
                + 'ただし生きていてもほぼ無影響: 武装はカットまで 100 rpm 以内かつ到達予測 51 ms 未満の '
                + '1 パスのみで、種は K_MD_NBEGR_MIN = 90 Nm で上方クランプされ、'
                + 'N や低いギアでは負荷トルクがそこに届かない。',
        },
    },
    {
        kind: 'curve', symbol: 'KL_SMG_MOT_J_MOTOR', address: 0x2ACC, bank: 'slave',
        category: 'inertia', label: 'SMG J CURVE',
        description: {
            en: 'The inertia the SMG rev-matching feedforward actually uses — the partner of '
                + 'K_SMG_J_MOTOR, and the half the owner did not change. Looked up on TARGET engine '
                + 'speed by smg_vehicle_dynamics_observer_update (slave 0x03B960) into smg_mot_j_motor '
                + '(0xFFDBDA); smg_dn_regulator_update then does muls.w 0xFFDBAA / asr.l #7 at slave '
                + '0x039082, converting the commanded speed gradient into a FEEDFORWARD TORQUE and '
                + 'adding it to the request at 0x039202. So K_SMG_J_MOTOR sets the gradient ceiling and '
                + 'this prices that gradient into torque: they are a pair. Lowering only the ceiling — '
                + 'which is what was done — lets a 23 % larger gradient be converted at an unchanged '
                + 'inertia, so it arrives undiluted. That is the likeliest reason the change was felt. '
                + 'Stock 0.0078 / 0.398 / 0.5 is a shape no physical inertia has (it would mean the '
                + 'engine weighs nothing at 1520 rpm), so it is a tuning curve, not a measurement. '
                + 'DO NOT CHANGE remains the default — but because it is a second, interacting knob, '
                + 'not because the mechanism is unknown.',
            ja: 'SMG の回転合わせフィードフォワードが**実際に使う**慣性。K_SMG_J_MOTOR の相方であり、'
                + '**オーナーが変更しなかった方の半分**。smg_vehicle_dynamics_observer_update '
                + '（slave 0x03B960）が**目標**回転で引いて smg_mot_j_motor（0xFFDBDA）に書き、'
                + 'smg_dn_regulator_update が slave 0x039082 で muls.w 0xFFDBAA / asr.l #7 を行って'
                + '**指令勾配をフィードフォワードトルクに換算**し、0x039202 で要求に加算する。'
                + '∴ K_SMG_J_MOTOR が勾配の上限を決め、こちらがその勾配をトルクに値付けする — **対**である。'
                + '**上限だけを下げると**（今回やったこと）、23 % 大きい勾配が'
                + '変わらない慣性で換算されて**薄まらずに届く**。症状が出た最有力の理由。'
                + '純正 0.0078 / 0.398 / 0.5 は物理慣性ではありえない形（1520 rpm で慣性ゼロ）なので、'
                + '測定値ではなくチューニング曲線。**変更しない**は既定のままだが、'
                + '理由は「機構が未回収だから」ではなく「相互作用する 2 つ目のつまみだから」。',
        },
        x: { address: 0x2ACC, n: 3, bits: 8, signed: false, units: 'rpm', label: 'N ZIEL', scaling: multiplyBy(40) },
        values: { address: 0x2ACF, n: 3, bits: 8, signed: false, units: 'Nms²', scaling: divideBy(128) },
    },

    // --- Driveline reference: what turns r into r_eff(gear) --------------------------------------
    {
        kind: 'curve', symbol: 'KL_MD_JFZ_GANG', address: 0x955E, bank: 'master',
        category: 'inertia', label: 'JFZ GANG',
        description: {
            en: 'Vehicle inertia referred to the crankshaft, per gear — BMW\'s own numbers. Stock '
                + '0 / 0.701 / 1.601 / 3.399 / 5.0 / 8.0 / 12.0 / 0.75 Nms², index 0 being neutral '
                + 'and INDEX 7 BEING REVERSE — not padding. smg_10ms (slave 0x03B81A) writes '
                + 'smg_can_istgang to GANG without masking, and the observer compares against Reverse '
                + 'explicitly; J_fz 0.75 sitting just above first gear\'s 0.70 is what a short reverse '
                + 'ratio should look like. READ ONLY here, and the most useful row in this catalog: it '
                + 'is what makes the in-gear correction computable instead of estimated. Because '
                + 'J_vehicle dwarfs J_engine in every gear, a 20 % lighter flywheel moves the effective '
                + 'inertia by only 5 % in first and 0.4 % in sixth.',
            ja: 'クランク軸換算の車両慣性をギアごとに与えるカーブ（**BMW 自身の値**）。'
                + '純正 0 / 0.701 / 1.601 / 3.399 / 5.0 / 8.0 / 12.0 / 0.75 Nms²、index 0 がニュートラル、'
                + '**index 7 はリバース**（パディングではない）。smg_10ms（slave 0x03B81A）が '
                + 'smg_can_istgang をマスクせずに GANG へ書き、オブザーバは Reverse と明示比較している。'
                + 'J_fz 0.75 が 1 速の 0.70 のすぐ上にあるのは、短いリバース比としてそのとおりの形。'
                + 'ここでは**読み取り専用**で、この表の中で最も価値がある: '
                + '**ギヤが入っているときの補正を推定ではなく計算にできる**。'
                + '全ギアで J_vehicle が J_engine より桁で大きいため、フライホイールを 20 % 軽くしても'
                + '実効慣性は 1 速で 5 %、6 速では 0.4 % しか動かない。',
        },
        x: { address: 0x955E, n: 8, bits: 16, signed: false, units: '', label: 'GEAR', scaling: IDENTITY },
        values: { address: 0x956E, n: 8, bits: 16, signed: false, units: 'Nms²', scaling: divideBy(268) },
    },
    {
        kind: 'constant', symbol: 'K_SMG_I_HA', address: 0x28CC, bank: 'slave',
        category: 'inertia', label: 'I HA',
        bits: 8, signed: false, units: '', scaling: divideBy(60),
        description: {
            en: 'Final drive ratio. Stock 3.6333. Read only — with the gear ratios and the dynamic '
                + 'wheel radius it lets KL_MD_JFZ_GANG be sanity-checked against physics.',
            ja: 'ファイナルギア比。純正 3.6333。読み取り専用 — ギア比と動的タイヤ半径と合わせると、'
                + 'KL_MD_JFZ_GANG を物理計算で検算できる。',
        },
    },
    {
        kind: 'series', symbol: 'K_SMG_I_GANG', address: 0x28CD, bank: 'slave',
        category: 'inertia', label: 'I GANG',
        indexLabel: 'gear',
        indexNames: ['1st', '2nd', '3rd', '4th', '5th', '6th'],
        values: { address: 0x28CD, n: 6, bits: 8, signed: false, units: '', scaling: divideBy(60) },
        description: {
            en: 'Gearbox ratios, one byte each, stock 4.2333 / 2.5333 / 1.6667 / 1.2333 / 1.0 / '
                + '0.8333. Six consecutive constants in the XDF rather than a table; grouped here '
                + 'because they are only ever read together. Read only.',
            ja: 'ギア比（各 1 バイト）。純正 4.2333 / 2.5333 / 1.6667 / 1.2333 / 1.0 / 0.8333。'
                + 'XDF では 6 個の独立した定数だが、常にまとめて読むのでここでは 1 項目にしてある。読み取り専用。',
        },
    },
    {
        kind: 'constant', symbol: 'K_SMG_R_RAD_DYN', address: 0x280C, bank: 'slave',
        category: 'inertia', label: 'R RAD DYN',
        bits: 16, signed: false, units: 'mm', scaling: divideBy(10),
        description: {
            en: 'Dynamic rolling radius, stock 307 mm. Read only here. Note it sits two bytes above '
                + 'K_SMG_J_MOTOR (0x280A) — the easiest address in this catalog to hit by mistake.',
            ja: '動的タイヤ半径。純正 307 mm。ここでは読み取り専用。'
                + '**K_SMG_J_MOTOR (0x280A) のすぐ隣（+2）** — この表で最も誤爆しやすいアドレス。',
        },
    },

    // --- Class A: the engine alone is the plant --------------------------------------------------
    {
        kind: 'constant', symbol: 'K_LFR_TAU_IA1', address: 0x9A9E, bank: 'master',
        category: 'inertia', label: 'LFR TAU IA1',
        bits: 8, signed: false, units: 's', scaling: reciprocal(5.12),
        description: {
            en: 'NOT the idle controller integrator constant — that rate lives in KF_LFR_DQI '
                + '(master 0x9B84). This is the decay constant applied to the idle I term in '
                + 'LFR_ZUSTAND 8 only, and every path into that state first zeroes LFR_MDI (state 4 '
                + 'does clr.w at lfr_calc 0x026C90, state 1 at 0x026D0C/0x026D10). So the filter drives '
                + 'zero toward zero and reading it changes nothing measurable. Nor can it be corrected '
                + 'by an inertia ratio: at raw 1 the reciprocal 5.12/x scaling has a 2.56 s step — '
                + '50 % — so an 18 % change is not representable at all. Stock 5.12 s IS the slowest '
                + 'writable value, and the revs hanging after a lift is an EGAS/dashpot behaviour, not '
                + 'this. Left in the catalog to be read, not written.',
            ja: '**アイドル制御 I 項の時定数ではない** — その速度は KF_LFR_DQI（master 0x9B84）にある。'
                + 'これは LFR_ZUSTAND 8 でだけ I 項に掛かる減衰定数で、'
                + 'その状態に入る経路はすべて先に LFR_MDI を 0 にする'
                + '（状態 4 が lfr_calc 0x026C90 で clr.w、状態 1 が 0x026D0C/0x026D10）。'
                + '∴ **フィルタは 0 を 0 に向けて濾しており**、書いても測れる変化は出ない。'
                + 'そもそも慣性比で補正できない: raw 1 では逆数 5.12/x の刻みが 2.56 s（50 %）で、'
                + '18 % の変更は表現不能。純正 5.12 s は確かに書ける中で最も遅い端だが、'
                + 'アクセルオフ後の回転の張り付きは EGAS／ダッシュポット系の挙動でこれではない。'
                + '**読むために置いてあり、書くためではない。**',
        },
    },
    {
        kind: 'constant', symbol: 'K_LFR_TAU_IA2_KKS', address: 0x9A9F, bank: 'master',
        category: 'inertia', label: 'LFR TAU IA2 KKS',
        bits: 8, signed: false, units: 's', scaling: reciprocal(5.12),
        description: {
            en: 'The idle I-term handover constant used BELOW 2 km/h — not a clutch signal. The '
                + 'selector is S_KRAFTSCHLUSS (0xFF80BB, tested at lfr_calc 0x026CE8), and on an SMG car '
                + 's_kraftschluss_calc (master 0x01D558) sets it from vehicle speed against '
                + 'K_LLR_V_MAX = 2 km/h; the gear/clutch-switch branch at 0x01D5CA is the manual-gearbox '
                + 'path and is never taken. Nor does it discard the integrator: the PT1 target in state '
                + '0x10 is the value held at handover (0xFFEA44, clamped to K_LFR_UEW_MAX = 5.0 Nm), so '
                + 'it is a one-shot transfer, not a per-cycle throw-away. And the transition fires when '
                + 'the engine LEAVES idle (N > 970 rpm), where a warm LFR_MDI sits at about -7.0 Nm, so '
                + 'driving it toward the held value RAISES torque demand. Stock 0.0201 s is raw 255, '
                + 'already the fastest writable value, so there is nothing to gain by writing it.',
            ja: '**2 km/h 以下**で使われるアイドル I 項の引き継ぎ定数 — クラッチ信号ではない。'
                + '選択子は S_KRAFTSCHLUSS（0xFF80BB、lfr_calc 0x026CE8 で判定）で、'
                + 'SMG 車では s_kraftschluss_calc（master 0x01D558）が'
                + '**車速を K_LLR_V_MAX = 2 km/h と比べて**立てる。'
                + '0x01D5CA のギア／クラッチスイッチ分岐は MT 用で、この車では通らない。'
                + 'また積分値を捨てもしない: 状態 0x10 の PT1 目標は引き継ぎ時に保持した値'
                + '（0xFFEA44、K_LFR_UEW_MAX = 5.0 Nm でクランプ）なので、'
                + '**毎周期の全捨てではなく一度きりの受け渡し**である。'
                + 'しかも遷移は**アイドルを離れる**とき（N > 970 rpm）に起きる。'
                + '暖機時の LFR_MDI は約 −7.0 Nm なので、保持値へ動かすとトルク要求は**上がる**。'
                + '純正 0.0201 s は raw 255 で既に最速端。書いても得るものが無い。',
        },
    },
    {
        kind: 'constant', symbol: 'K_LFR_TAU_IA2_KS', address: 0x9A4E, bank: 'master',
        category: 'inertia', label: 'LFR TAU IA2 KS',
        bits: 8, signed: false, units: 's', scaling: reciprocal(5.12),
        description: {
            en: 'The ABOVE-2 km/h counterpart, stock 0.32 s. Not a change target, and — correcting an '
                + 'earlier note here — not evidence that K_LFR_TAU_IA2_KKS is an outlier. The pair is '
                + 'coherent: the fast constant belongs to the case with no torque path to the wheels, '
                + 'where a step in idle torque cannot shunt anything, and the slow one to the connected '
                + 'case where the same step has to be ramped. That is the assignment a driveline '
                + 'engineer would choose, and the reverse would be absurd — which is a shape test '
                + 'confirming the code rather than contradicting it.',
            ja: '**2 km/h 超**側の対応値。純正 0.32 s。変更対象ではない — そしてここの旧記述を訂正すると、'
                + '**K_LFR_TAU_IA2_KKS が外れ値である証拠ではない**。2 つは整合している: '
                + '速い方は駆動系が繋がっていない場合（トルクの段差がどこにも伝わらない）、'
                + '遅い方は繋がっている場合（同じ段差をランプさせる必要がある）に割り当てられている。'
                + 'ドライブライン屋ならそう振るし、逆なら不合理 — '
                + '**コードを否定するのではなく裏付ける形状テスト**である。',
        },
    },
    {
        kind: 'curve', symbol: 'KL_LFR_TZ_NEG', address: 0x9CE6, bank: 'master',
        category: 'inertia', label: 'LFR TZ NEG',
        description: {
            en: 'Idle ignition retard authority in the rev-DOWN direction. Stock: all sixteen points '
                + '0.0 Nm — the fast path for pulling revs down does not exist in this calibration. '
                + 'Structural, not inertia-related, but lower inertia is what exposes it. Two gates '
                + 'beyond the reserve: lfr_calc takes the NEG branch only when LFR_DN < 1 AND '
                + '(ZUSTAND_MOTOR & LL) != 0, so it does nothing with the pedal down; and MD_LLR_TZ is '
                + 'zeroed whole whenever (MD_RES_LRW_ST & 2) is clear. Note the branch boundary is '
                + 'LFR_DN < 1, so exactly-zero error takes this path and reads y[0] — a non-zero y[0] '
                + 'would apply a permanent retard at zero error, which is why the ramp starts at 0. '
                + 'Inert on its own (sixteen zeros behind a shut gate), but the converse is NOT true: '
                + 'see KL_MD_RES_LRW, which does something by itself. Mechanism is code-confirmed '
                + 'end to end (lfr_calc 0x026A4C/0x026A6A); an earlier xref-only grade here was the '
                + 'stmts=0 trap, not a real gap.',
            ja: 'アイドル点火リタードの**回転を下げる側**の権限。純正は 16 点すべて 0.0 Nm ＝ '
                + '**この較正には回転を速く下げる経路が 1 Nm も存在しない**。'
                + '慣性とは無関係な構造上の穴だが、慣性が減ると露呈する。'
                + 'リザーブ以外に**ゲートが 2 つ**: lfr_calc が NEG 分岐に入るのは '
                + 'LFR_DN < 1 **かつ** (ZUSTAND_MOTOR & LL) != 0 のときだけなので、'
                + '**アクセルを踏んでいる間は何もしない**。'
                + 'そして (MD_RES_LRW_ST & 2) が落ちていれば MD_LLR_TZ ごと 0 にされる。'
                + '分岐境界が LFR_DN < 1 なので**偏差ちょうど 0 もこの経路に入り y[0] を引く** — '
                + 'y[0] を非ゼロにすると偏差 0 で常時リタードになる。だからランプは 0 から始める。'
                + '**単独では不活性**（閉じたゲートの後ろの 16 個のゼロ）だが、'
                + '**逆は成り立たない** — KL_MD_RES_LRW は単独でも効く。'
                + '機構は端から端まで code-confirmed（lfr_calc 0x026A4C/0x026A6A）。'
                + '以前の xref-only 評価は stmts=0 の罠であって本当の欠落ではなかった。',
        },
        x: { address: 0x9CE6, n: 16, bits: 16, signed: false, units: 'rpm', label: 'N ERROR', scaling: { math: '-X', toPhysical: r => -r, toRaw: v => -v } },
        values: { address: 0x9D06, n: 16, bits: 16, signed: false, units: 'Nm', scaling: divideBy(80) },
    },
    {
        kind: 'curve', symbol: 'KL_MD_RES_LRW', address: 0x97D8, bank: 'master',
        category: 'inertia', label: 'MD RES LRW',
        description: {
            en: 'Torque reserve held against POWER-STEERING PUMP LOAD AT THE STEERING END STOPS, and '
                + 'the switch that lets the idle governor move torque with ignition. Indexed on '
                + '|LWS_LRW|, absolute steering angle: x = 520.0 / 550.0 / 560.0 / 580.0 deg, '
                + 'y = 0/5/10/15 Nm. Stock full lock is 542.8 deg, so x[1..3] are physically '
                + 'UNREACHABLE and the usable span is 520-543 deg yielding 3.8 Nm interpolated — which '
                + 'is why 3.0 is a well-chosen size rather than an arbitrary one. y[0] is not "the '
                + 'straight-ahead entry": klu_wint clamps below the first breakpoint, so y[0] is the '
                + 'floor for the whole 0-520 deg range and raising it opens the reserve at every angle. '
                + 'NOT a standing cost — K_MD_RES_LRW_V = 25 km/h arms it and 30 km/h (VHYS 5) '
                + 'disarms it, so above 30 km/h it costs and does nothing. Below that the cost is about '
                + '3.6 % of an ~81 Nm warm idle request, 0.9 % at WOT. And the authority it buys needs '
                + 'V < K_LFR_V_MAX = 2 km/h as well (lfr_calc 0x0269D0), so between 2 and 30 km/h you '
                + 'pay the reserve and get nothing back. The reserve SIZE is also the upward authority: '
                + 'MD_RES is added to the air request but not to MD_TZ_RED, so ignition can only claw '
                + 'back what the reserve gave — 3.0 Nm up, while the down direction is uncapped.',
            ja: '**据切り時のパワステポンプ負荷**に備えるトルクリザーブであり、'
                + 'アイドル調速器が**点火でトルクを動かす**ためのスイッチ。'
                + '軸は **|LWS_LRW| ＝ 絶対舵角**で、x = 520.0 / 550.0 / 560.0 / 580.0 度、y = 0/5/10/15 Nm。'
                + '純正フルロックは 542.8 度なので **x[1..3] は物理的に到達不能**、'
                + '使えるのは 520–543 度の幅で内挿 3.8 Nm — 3.0 Nm という提案値が恣意的でない理由がこれ。'
                + 'y[0] は「直進の値」ではない: klu_wint は最初のブレークポイント以下でクランプするので、'
                + '**y[0] は 0–520 度全域の下限**であり、上げれば全舵角でリザーブが開く。'
                + '**常時コストではない** — K_MD_RES_LRW_V = 25 km/h で武装、30 km/h（VHYS 5）で解除。'
                + '30 km/h 超では払いも効きもしない。以下でのコストは暖機アイドルの要求 約81 Nm に対し **3.6 %**、'
                + 'WOT で 0.9 %。**ただし買った権限が使えるのは V < K_LFR_V_MAX = 2 km/h だけ**'
                + '（lfr_calc 0x0269D0）なので、**2〜30 km/h はリザーブを払って何も返ってこない帯**。'
                + 'そしてリザーブの**大きさがそのまま上向き権限**である: MD_RES は空気要求に足されるが '
                + 'MD_TZ_RED には入らないので、点火はリザーブが渡した分しか取り返せない — '
                + '上は 3.0 Nm 止まり、下は上限なし。',
        },
        x: { address: 0x97D8, n: 4, bits: 16, signed: false, units: '°', label: 'STEER', scaling: { math: 'X*0.04375', toPhysical: r => r * 0.04375, toRaw: v => v / 0.04375 } },
        values: { address: 0x97E0, n: 4, bits: 16, signed: false, units: 'Nm', scaling: divideBy(10) },
    },
    {
        kind: 'curve', symbol: 'KL_LFR_DQP_POS', address: 0x9ABE, bank: 'master',
        category: 'inertia', label: 'LFR DQP POS',
        description: {
            en: 'Idle proportional term against speed error. The axis is LFR_DN = LLR_N_SOLL - N, so '
                + 'positive means the engine is BELOW target and the curve is evaluated only for '
                + 'LFR_DN > 0 (0x0269D2) — it can never act on an overshoot; that side is '
                + 'KL_LFR_TZ_NEG, which is all zeros. Stock leaves 0-60 rpm of error at 0 Nm, a '
                + 'deadband. Correcting an earlier note here: a lighter flywheel does NOT make the '
                + 'controller intervene later. The trip point is defined in rpm and does not move; the '
                + 'engine reaches it SOONER (60 rpm under a 5 Nm deficit takes 0.258 s at J = 0.205 '
                + 'against 0.314 s at 0.25) and then falls 22 % faster. The reason to look at this '
                + 'curve is the lost phase margin in the small-signal region, not a change in timing. '
                + 'Two gates worth knowing: the term is cleared when ZUSTAND_MOTOR & 0x1C is zero, and '
                + 'when S_KRAFTSCHLUSS is set with V above K_LFR_V_MAX = 2 km/h — so it does nothing '
                + 'while rolling in gear. Do NOT fill in only two cells: leaving index 3 at 0.0 creates '
                + 'a negative-gain band between 40 and 60 rpm. Write index 1-11 or leave it alone.',
            ja: 'アイドル制御の P 項。軸は **LFR_DN = LLR_N_SOLL − N** なので'
                + '正は「エンジンが目標より下」を意味し、**LFR_DN > 0 でしか評価されない**（0x0269D2）— '
                + 'オーバーシュート側には一切効かない（そちらは KL_LFR_TZ_NEG で、全ゼロ）。'
                + '純正は偏差 0–60 rpm が 0 Nm ＝ 不感帯。'
                + '**ここの旧記述を訂正する**: 慣性が減っても制御の介入は遅くならない。'
                + 'トリップ点は rpm で定義されていて動かず、エンジンは**より早く**そこへ達する'
                + '（5 Nm の不足で 60 rpm 落ちるのに J=0.205 なら 0.258 s、0.25 なら 0.314 s）。'
                + 'そこから先が 22 % 速く落ちる。この曲線を見る理由は**小信号域の位相余裕の喪失**であって、'
                + '介入タイミングの変化ではない。ゲートが 2 つ: ZUSTAND_MOTOR & 0x1C が 0 のとき、'
                + 'および S_KRAFTSCHLUSS が立っていて V > K_LFR_V_MAX = 2 km/h のときはクリアされる — '
                + '**走行中は効かない**。**2 セルだけ埋めないこと**: index 3 を 0.0 のまま残すと '
                + '40–60 rpm に**負ゲイン帯**ができる。index 1–11 をまとめて書くか、触らないか。',
        },
        x: { address: 0x9ABE, n: 16, bits: 16, signed: false, units: 'rpm', label: 'N ERROR', scaling: IDENTITY },
        values: { address: 0x9ADE, n: 16, bits: 16, signed: false, units: 'Nm', scaling: divideBy(80) },
    },
    {
        kind: 'curve', symbol: 'KL_SA_N40_GANG', address: 0x0E3C, bank: 'slave',
        category: 'inertia', label: 'SA N40 GANG',
        description: {
            en: 'ONE TERM of the overrun fuel-cut speed threshold, per gear — not the threshold. '
                + 'sa_rpm_thresholds_calc (slave 0x0262EE, adds at 0x263B4-0x263CE) builds '
                + 'SA_N40_WIEDEREINSETZEN = SA_N40_GANG + SA_N40_KKOS + SA_N40_DN40 + SA_N40_TMOT, then '
                + 'SA_N40 = that + K_SA_N40_HYS + SA_N40_HYST_GANG. Index 0 at 320 rpm supplies only '
                + 'about 15 % of a warm coasting threshold of ~2080 rpm; KL_SA_N40_TMOT (slave 0x0E4E, '
                + '1200 rpm above 70 degC) supplies 58 % and K_SA_N40_HYS another 400. Reading 320 as '
                + '"the fuel cut ends at 320 rpm" is the mistake this entry exists to prevent. Index 0 '
                + 'is the clutch-out/neutral case and the only one worth moving: in gear the reflected '
                + 'vehicle inertia dominates so the rev-drop rate barely changes. Index 7 is REVERSE. '
                + 'Note this term sits inside SA_N40_WIEDEREINSETZEN, which is itself a term of SA_N40 '
                + '— so moving it shifts BOTH thresholds equally and does not widen the band. Only '
                + 'KL_SA_N40_HYS_GANG changes the band. Quantised to 40 rpm, so 390 cannot be written.',
            ja: 'オーバーラン燃料カットしきい値の**項の 1 つ**（ギア別）— しきい値そのものではない。'
                + 'sa_rpm_thresholds_calc（slave 0x0262EE、0x263B4–0x263CE は全部 add.b）が'
                + 'SA_N40_WIEDEREINSETZEN = SA_N40_GANG + SA_N40_KKOS + SA_N40_DN40 + SA_N40_TMOT を作り、'
                + 'さらに SA_N40 = それ + K_SA_N40_HYS + SA_N40_HYST_GANG。'
                + 'index 0 の 320 rpm は暖機惰行の実しきい値 約2080 rpm のうち **15 % 程度**でしかない。'
                + '**KL_SA_N40_TMOT**（slave 0x0E4E、70 degC 以上で 1200 rpm）が 58 % を供給し、'
                + 'K_SA_N40_HYS がさらに 400 rpm。'
                + '**「320 rpm で燃料カットが終わる」と読むのがこの項目が防ぎたい誤解**である。'
                + 'index 0 はクラッチ切／N の場合で、動かす価値があるのはここだけ '
                + '（ギヤが入っていれば反射車両慣性が支配して回転落ち速度はほぼ変わらない）。'
                + '**index 7 はリバース。** なおこの項は SA_N40_WIEDEREINSETZEN の中にあり、'
                + 'それ自体が SA_N40 の項でもあるので、**動かすと 2 つのしきい値が同じだけ平行移動し、'
                + '帯域は変わらない**。帯域を動かすのは KL_SA_N40_HYS_GANG だけ。'
                + '**40 rpm 刻みなので 390 は書けない。**',
        },
        x: { address: 0x0E3C, n: 8, bits: 8, signed: false, units: '', label: 'GEAR', scaling: IDENTITY },
        values: { address: 0x0E44, n: 8, bits: 8, signed: false, units: 'rpm', scaling: multiplyBy(40) },
    },
    {
        kind: 'curve', symbol: 'KL_SA_N40_HYS_GANG', address: 0x0E2A, bank: 'slave',
        category: 'inertia', label: 'SA N40 HYS',
        description: {
            en: 'Hysteresis on the above, per gear, and the ONLY term that changes the band width. '
                + 'The band is K_SA_N40_HYS (400 rpm, fixed) + this, so index 0 at 120 gives 520 rpm. '
                + 'Moving it to 160 widens the band to 560 — a factor of 1.077, NOT 1/r = 1.22; '
                + 'reaching 1/r would need 240 rpm (raw 6). Also 40 rpm quantised, and the rounding '
                + 'boundary is close: at J above about 0.2143 the target rounds back to the current '
                + 'value and the proposal is silently dropped.',
            ja: '上のヒステリシス（ギア別）。純正 index 0 は 120 rpm。同じ理由で同時に動かす。同じく 40 rpm 刻み。',
        },
        x: { address: 0x0E2A, n: 8, bits: 8, signed: false, units: '', label: 'GEAR', scaling: IDENTITY },
        values: { address: 0x0E32, n: 8, bits: 8, signed: false, units: 'rpm', scaling: multiplyBy(40) },
    },
    {
        kind: 'constant', symbol: 'K_WE_DN40_HARD', address: 0x0E1E, bank: 'slave',
        category: 'inertia', label: 'WE DN40 HARD',
        bits: 8, signed: true, units: 'rpm/s', scaling: multiplyBy(40),
        description: {
            en: 'Speed-gradient threshold splitting the hard and soft fuel-cut reinstatement paths. '
                + 'Stock -5000 rpm/s. DO NOT plan around moving it: the field is a signed byte at '
                + '40 rpm/s per count, so -5120 is the floor and it is already one step away. '
                + 'Advice to set it to -8000 cannot be flashed.',
            ja: '燃料カット復帰の hard/soft を分ける回転勾配しきい値。純正 −5000 rpm/s。'
                + '**動かす前提で計画を立てないこと**: 8 bit 符号付き × 40 なので下限は −5120 で、'
                + '純正は既にその 1 段手前にある。「−8000 にする」という助言は**物理的に書き込めない**。',
        },
    },
    {
        kind: 'constant', symbol: 'K_N_TAU_DN', address: 0xC419, bank: 'master',
        category: 'inertia', label: 'N TAU DN',
        bits: 8, signed: false, units: 's', scaling: reciprocal(2.56),
        description: {
            en: 'PT1 time constant on the filtered speed gradient D_N_GEFILTERT. Stock 0.0985 s. '
                + 'NOT an inertia term — nothing in the filter contains J, and none of the lags around '
                + 'it (the 10 ms task, the 20 ms task, K_LLS_TAU2, the induction-to-torque delay) '
                + 'scales with a flywheel change. It is filed as class D for that reason. Shortening it '
                + 'buys back a little phase margin in the IDLE loop specifically, which is the one '
                + 'consumer whose plant is the engine alone; on the other live consumer, the soft rev '
                + 'limiter, the gain change is 0.4-5 % because that path only runs in gear. Measured '
                + 'worth: about 8-13 rpm of idle dip against a 870 rpm target, roughly 0.7 % of the '
                + 'governor authority of +/-60 Nm. Consumers of the filtered value: KF_LFR_DQI\'s y '
                + 'axis and KL_LFR_I_AUF\'s x axis in lfr_calc, plus MD_NBEGR in Torque_Limitation. '
                + 'Does NOT affect D_N40, which n_calc reads unfiltered from D_N_SEGMENT (0xFF805A at '
                + '0x01893E). Reciprocal scaling.',
            ja: '回転勾配フィルタ D_N_GEFILTERT の PT1 時定数。純正 0.0985 s。'
                + '**慣性の項ではない** — フィルタに J は入っておらず、周囲のラグ'
                + '（10 ms タスク、20 ms タスク、K_LLS_TAU2、吸気→トルク遅れ）も'
                + 'フライホイール交換でスケールしない。だから**クラス D** に分類してある。'
                + '短くすると位相余裕がいくらか戻るのは**アイドルループに限った話**で、'
                + 'そこだけがプラントがエンジン単体になる消費者。'
                + 'もう一方の生きた消費者であるソフトレブリミッタは in-gear でしか走らないので利得変化は 0.4–5 %。'
                + '実効: 870 rpm 目標に対しアイドル落ち込み **8〜13 rpm** ＝ 調速器権限 ±60 Nm の約 0.7 %。'
                + 'フィルタ後の値の消費者: lfr_calc の KF_LFR_DQI の y 軸と KL_LFR_I_AUF の x 軸、'
                + 'および Torque_Limitation の MD_NBEGR。'
                + '**燃料カットが使う D_N40 には効かない** — n_calc は 0x01893E で '
                + 'D_N_SEGMENT（0xFF805A）を生で読む。逆数スケーリング。',
        },
    },
    {
        kind: 'curve', symbol: 'KL_DYN_TZ_DBGR', address: 0xB388, bank: 'master',
        category: 'inertia', label: 'DYN TZ DBGR',
        description: {
            en: 'Transient ignition retard against engine speed. Stock -3 at 2000 rpm falling to -12 '
                + 'from 5000 up. NOT an inertia correction and NOT a change target here — corrected '
                + 'from an earlier note that had it backwards twice over. It cannot cause a rev drop: '
                + 'the trigger at 0x02BE1C is signed and fires on THROTTLE-OPENING transients only, so '
                + 'the engine does not fall, it merely rises less sharply. And it is angle-clocked — '
                + 'K_TZ_DYN_DBGR_SEGM counts 18 crank segments — so the wall-clock duration already '
                + 'shortens by itself as revs rise, leaving nowhere for r to enter. The source this '
                + 'recommendation came from says the opposite of what was copied: leave everything '
                + 'above 4000 rpm alone, because easing it there gives up peak-cylinder-pressure '
                + 'protection that CSL cams and airbox make a real risk. If transient response is the '
                + 'goal, K_TZ_ZWB_DYN_DBGR (master 0xAC8C) shortens the release tail without touching '
                + 'the depth or the hold.',
            ja: '過渡点火リタード（回転数軸）。純正は 2000 rpm で −3、5000 rpm 以上で −12。'
                + '**慣性補正ではなく、ここでの変更対象でもない** — 旧記述は二重に逆だった。'
                + 'まず**回転の落ち込みは起こせない**: 0x02BE1C のトリガは符号付きで'
                + '**スロットルを開ける方向の過渡でしか発火しない**ので、回転は落ちず上がり方が鈍るだけ。'
                + 'そして**角度クロック**（K_TZ_DYN_DBGR_SEGM が 18 クランクセグメントを数える）なので、'
                + '回転が上がれば壁時計時間は自動的に縮み、r の入る余地がない。'
                + 'この推奨の出典自体が写された内容と逆のことを言っている: '
                + '**4000 rpm 以上は触るな**、緩めると筒内圧ピーク保護を手放すことになり、'
                + 'CSL カム＋CSL エアボックスでは実在のリスク、と。'
                + '過渡応答が目的なら K_TZ_ZWB_DYN_DBGR（master 0xAC8C）が'
                + '深さにも保持にも触らずに解放テールだけを短くする。',
        },
        x: { address: 0xB388, n: 10, bits: 16, signed: false, units: 'rpm', label: 'RPM', scaling: IDENTITY },
        values: { address: 0xB39C, n: 10, bits: 16, signed: true, units: '°KW', scaling: divideBy(10) },
    },
    {
        kind: 'constant', symbol: 'K_SMG_N_ZIEL_ABWUERG', address: 0x2855, bank: 'slave',
        category: 'inertia', label: 'SMG N ABWUERG',
        bits: 8, signed: false, units: 'rpm', scaling: multiplyBy(40),
        description: {
            en: 'SMG anti-stall target speed. Stock 1200 rpm, 40 rpm quantised. Consumed by '
                + 'smg_anti_stall_handler -> smg_engine_speed_controller_step, a closed-loop regulator '
                + 'holding engine speed after the SMG has pulled the gear (entry requires '
                + 'smg_can_istgang == Neutral). Evidence is code-confirmed, not funktionsrahmen-only. '
                + 'Correcting the reasoning that put it here: the 0.5*J*omega^2 argument does not '
                + 'apply, because with the gear out and a PID holding speed with 30+ Nm of authority '
                + 'there is no event drawing energy out of the flywheel to be short of. The 1/sqrt(r) '
                + 'target lands inside the reachable band anyway (1280/1320/1360), so the NUMBER '
                + 'survives while the derivation does not. Real risk of raising it is not a higher '
                + 'launch — launch is a different handler — but re-engagement starting 120 rpm higher, '
                + 'so more clutch slip energy.',
            ja: 'SMG のエンスト回避目標回転数。純正 1200 rpm、40 rpm 刻み。'
                + '消費者は smg_anti_stall_handler → smg_engine_speed_controller_step で、'
                + '**SMG がギアを抜いた後に回転を保持する閉ループ**（入場条件に smg_can_istgang == Neutral）。'
                + '根拠は **code-confirmed** であって funktionsrahmen-only ではない。'
                + 'ここに入れた理屈を訂正する: **0.5·J·ω² の議論は当たらない**。'
                + 'ギアが抜けていて 30 Nm 超の権限を持つ PID が回転を保持しているので、'
                + 'フライホイールのエネルギーを取り崩すイベントが無い。'
                + 'ただし 1/√r の目標は到達可能帯（1280/1320/1360）の中に入るので、'
                + '**数字は生き残り導出だけが死ぬ**。上げたときの実リスクは「発進の回転が上がる」ではなく'
                + '（発進は別ハンドラ）、**再係合が 120 rpm 高い回転から始まりクラッチ滑りエネルギーが増える**こと。',
        },
    },
    {
        kind: 'curve', symbol: 'KL_SA_N40_DN40', address: 0x0E58, bank: 'slave',
        category: 'inertia', label: 'SA N40 DN40',
        description: {
            en: 'Fuel-cut speed limit raised by how fast the engine is decelerating — the look-ahead '
                + 'that stops a cut being reinstated into a rev-drop. Its X AXIS IS A GRADIENT, in '
                + 'rpm/s, so it is the one item here whose axis genuinely does scale with inertia. '
                + 'Move it LAST and ALONE: shifting an axis changes what every neighbouring cell '
                + 'means, and mixing that into a flash with other changes makes the result '
                + 'untraceable.',
            ja: '減速の速さに応じて燃料カット下限を持ち上げる先読み。'
                + '**この表の X 軸は勾配 (rpm/s)** なので、この項目だけは軸が本当に慣性でスケールする。'
                + '**最後に、単独で動かすこと** — 軸を動かすと隣接セルの意味が全部変わるため、'
                + '他の変更と同じフラッシュに混ぜると原因が追えなくなる。',
        },
        x: { address: 0x0E58, n: 4, bits: 8, signed: false, units: 'rpm/s', label: 'DN40', scaling: multiplyBy(-40) },
        values: { address: 0x0E5C, n: 4, bits: 8, signed: false, units: 'rpm', scaling: multiplyBy(40) },
    },

    // --- Class B: engine plus vehicle. Correction goes on the GEAR axis. -------------------------
    {
        kind: 'series', symbol: 'KL_MD_LS_W_GANG', address: 0x927C, bank: 'master',
        category: 'inertia', label: 'LS GEAR FACTOR',
        indexLabel: 'gear',
        indexNames: ['idx0/OOR', '1st', '2nd', '3rd', '4th', '5th', '6th', 'Reverse'],
        values: { address: 0x927C, n: 8, bits: 16, signed: false, units: '', scaling: divideBy(1024) },
        description: {
            en: 'Gear weighting on the tip-in torque slew allowance. Stock 1.00 / 0.75 / 0.80 / 0.90 / '
                + '1.00... — first gear held down hardest, which is independent evidence that larger '
                + 'means more direct. IT IS DEFINED IN THE XDF, as the y data of curve KL_MD_LS_W_GANG '
                + 'at 0x926C — an earlier note here called it XDF-undefined and demanded a blind patch, '
                + 'which was wrong and is why this table sat behind an opt-in flag.\n\n'
                + 'READ THIS BEFORE WRITING IT. The table has a SECOND consumer that no inertia model '
                + 'accounts for. Torque_Limitation latches the selected factor into RAM 0xFFD8FA every '
                + '10 ms (0x0160F6), and FUN_00017400 multiplies it into the overrun fuel-cut ENTRY and '
                + 'RESUMPTION ramps at 0x1746C and 0x174C6, each with a truncating >>10. Against '
                + 'K_MD_DELTA_SA_SOFT = raw 5 that shift sits on an integer cliff: factor 1024 gives 5 '
                + 'counts, 1015 gives 4. So the r_eff correction — which is -0.4 % in the top gears — '
                + 'lands as a 20 % change to how fast torque is withdrawn on a lift-off in 4th, 5th and '
                + '6th, while doing nothing at all in 1st through 3rd where the same truncation '
                + 'swallows it. K_DYN_CONTROL = 0 makes DYN_ST permanently zero, so the HARD ramp is '
                + 'dead and every ordinary lift-off takes this SOFT path. The generator flags the '
                + 'affected entries; do not write them without reading that flag.\n\n'
                + 'The in-gear inertia correction still belongs here rather than on KF_MD_LS_KOMF, '
                + 'which has no gear axis — but note that applying an inertia ratio to a torque RATE '
                + 'limiter is a modelling choice, not something the binary dictates.',
            ja: 'ティップインのトルク変化率許容量に掛かるギア別係数。'
                + '純正 1.00 / 0.75 / 0.80 / 0.90 / 1.00…で、**1 速を最も強く抑えている** — '
                + 'これ自体が「大きい＝ダイレクト」の独立した裏付けになっている。'
                + '**XDF に定義されている** — curve KL_MD_LS_W_GANG（0x926C）の y データ。'
                + '「XDF 未定義だから直接パッチ」という旧記述は誤りで、'
                + 'この表がオプトインの裏に置かれていた理由もそれだった。\n\n'
                + '**書く前に読むこと。この表には慣性モデルが勘定していない 2 つ目の消費者がある。** '
                + 'Torque_Limitation が選択された係数を 10 ms ごとに RAM 0xFFD8FA へラッチし（0x0160F6）、'
                + 'FUN_00017400 が 0x1746C / 0x174C6 で**燃料カットの進入ランプと復帰ランプ**に掛ける'
                + '（いずれも切り捨ての >>10）。'
                + 'K_MD_DELTA_SA_SOFT = raw 5 に対してこのシフトは**整数の崖**の上にある: '
                + '係数 1024 で 5 カウント、1015 で 4 カウント。'
                + '∴ 上位ギアで −0.4 % の r_eff 補正が、**4/5/6 速のリフトオフ時のトルク引き抜き速度を 20 % 変える**。'
                + '一方 1〜3 速では同じ切り捨てに飲まれて**何も起きない**。'
                + 'K_DYN_CONTROL = 0 で DYN_ST は恒久ゼロ、HARD ランプは死んでいるので'
                + '**通常のリフトオフは必ずこの SOFT 経路**を通る。'
                + '該当セルはジェネレータが警告を出す。その警告を読まずに書かないこと。\n\n'
                + 'ギヤ込みの慣性補正の置き場所としてはやはりここが正しい'
                + '（KF_MD_LS_KOMF にはギア軸が無い）— ただし**慣性比をトルクのレートリミッタに掛けるのは'
                + 'モデリング上の判断**であって、バイナリがそう指示しているわけではない。',
        },
    },
    {
        kind: 'series', symbol: 'KL_MD_W_GANG_DASHPOT', address: 0x929E, bank: 'master',
        category: 'inertia', label: 'DP GEAR FACTOR',
        indexLabel: 'gear',
        indexNames: ['idx0/OOR', '1st', '2nd', '3rd', '4th', '5th', '6th', 'Reverse'],
        values: { address: 0x929E, n: 8, bits: 16, signed: false, units: '', scaling: divideBy(1024) },
        description: {
            en: 'The same weighting on the tip-out (dashpot) side. Stock 1.00 / 0.60 / 0.84 / 0.91 / '
                + '0.93 / 1.00 — first gear held down harder still than on the tip-in side. Also '
                + 'XDF-DEFINED, as the y data of curve KL_MD_W_GANG_DASHPOT at 0x928E; the previous '
                + '"XDF-undefined" note was wrong here too. Read the second-consumer and truncation '
                + 'warning on KL_MD_LS_W_GANG before writing this one — it goes through the same '
                + 'latch at 0xFFD8FA.',
            ja: 'ティップアウト（ダッシュポット）側の同じギア別係数。'
                + '純正 1.00 / 0.60 / 0.84 / 0.91 / 0.93 / 1.00 で、1 速の抑えはティップイン側よりさらに強い。'
                + 'これも **XDF に定義されている** — curve KL_MD_W_GANG_DASHPOT（0x928E）の y データ。'
                + '「XDF 未定義」は同じく誤りだった。'
                + '書く前に KL_MD_LS_W_GANG の 2 つ目の消費者と切り捨ての警告を読むこと — '
                + '**同じ 0xFFD8FA のラッチを通る**。',
        },
    },
    {
        kind: 'map', symbol: 'KF_MD_LS_KOMF', address: 0x9396, bank: 'master',
        category: 'inertia', label: 'MD LS KOMF',
        description: {
            en: 'Permitted driver-torque change per 10 ms during tip-in, Comfort map. LARGER MEANS '
                + 'MORE DIRECT AND MORE SHUNT; smaller is smoother. The minimum is 1.7 at 1500 rpm '
                + '/ 100 Nm — exactly the low-speed part-throttle case where shunt is worst. Do not '
                + 'scale the whole map by an inertia ratio: it has no gear axis, so a blanket '
                + 'factor over-corrects the gears that needed nothing. Change the individual cell a '
                + 'log points at.',
            ja: 'ティップイン時に 10 ms あたり許容するドライバ要求トルク変化量（Komfort マップ）。'
                + '**大きい＝ダイレクト＝シャクリやすい／小さい＝滑らか。** '
                + '最小は 1500 rpm × 100 Nm の 1.7 で、まさにシャクリが最も出る低回転・部分負荷を狙って抑えてある。'
                + '**マップ全体を慣性比でスケールしないこと**: ギア軸が無いので、'
                + '一律に掛けると補正の要らないギアまで過補正になる。ログが指した個別セルだけを動かす。',
        },
        x: { address: 0x9396, n: 6, bits: 16, signed: false, units: 'Nm', label: 'MD LS KF', scaling: divideBy(10) },
        y: { address: 0x93A2, n: 6, bits: 16, signed: false, units: 'rpm', label: 'RPM', scaling: IDENTITY },
        values: { address: 0x93AE, rows: 6, cols: 6, bits: 16, signed: false, units: 'Nm/10ms', scaling: divideBy(10) },
    },
    {
        kind: 'map', symbol: 'KF_MD_DASHPOT_FAKTOR', address: 0x946A, bank: 'master',
        category: 'inertia', label: 'DASHPOT FAKTOR',
        description: {
            en: 'Multiplier on the tip-out allowance, stock 0.20 to 1.00. LATCHED: sampled once '
                + 'when the dashpot first clips during an event and frozen for the rest of it, and '
                + 'looked up on the RAW request rather than the filtered one — unlike '
                + 'KF_MD_DASHPOT beside it. Both facts change what a change here does.',
            ja: 'ティップアウト許容量に掛かる係数。純正 0.20〜1.00。'
                + '**ラッチ値**: ダッシュポットがそのイベントで最初に頭打ちした瞬間に 1 回だけ採取され、'
                + 'イベント中は凍結される。さらに参照軸が**生の要求値**（隣の KF_MD_DASHPOT はフィルタ後を使う）。'
                + 'この 2 点が変更の効き方を変える。',
        },
        x: { address: 0x946A, n: 3, bits: 16, signed: false, units: 'rpm', label: 'RPM', scaling: IDENTITY },
        y: { address: 0x9470, n: 4, bits: 16, signed: false, units: 'Nm', label: 'MD FW', scaling: divideBy(10) },
        values: { address: 0x9478, rows: 4, cols: 3, bits: 16, signed: false, units: '', scaling: divideBy(1024) },
    },
];
