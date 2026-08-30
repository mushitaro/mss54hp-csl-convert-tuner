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
            en: 'Engine inertia as the SMG rev-matching feedforward assumes it. Used as a rate '
                + 'clamp — the commanded slew rate is limited to torque / this — so LOWERING it '
                + 'permits a faster blip. Its consumer is also called from the phase-3 clutch '
                + 're-engagement regulator, so it shapes every launch and every shift, not just '
                + 'blips. Treat it as a smoothness setting, not as a physical constant to be made '
                + 'accurate: stock 0.25 is deliberately conservative and the rest of the '
                + 'calibration is tuned around the smoothing it provides. Step 0.0078.',
            ja: 'SMG の回転合わせフィードフォワードが想定するエンジン慣性。'
                + '指令スルーレートを「トルク ÷ この値」で頭打ちにするレートクランプなので、'
                + '**下げると速いブリップが許可される**。消費関数はクラッチ再係合レギュレータ '
                + '(phase3) からも呼ばれるため、ブリップだけでなく発進と変速のたびに効く。'
                + '**「実物理値に合わせる」対象ではなく、再係合の穏やかさのつまみとして扱うこと** — '
                + '純正 0.25 は意図的に保守的で、較正の他の部分はその平滑化を前提にしている。刻み 0.0078。',
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
            en: 'The Momentenmanager\'s engine inertia. Stock 0.2687 — a different unit system from '
                + 'K_SMG_J_MOTOR, so compare ratios and not raw values. Its md_max_begr path is '
                + 'inert (KL_MD_BEGR_GANG is flat 1000 Nm, far above anything the engine makes), '
                + 'but it is NOT dead calibration: Torque_Limitation uses it with KL_MD_JFZ_GANG '
                + 'to form the soft rev limiter\'s integrator target, so it is live at redline.',
            ja: 'モーメントマネージャ側のエンジン慣性。純正 0.2687 — K_SMG_J_MOTOR とは'
                + '**単位系が別**なので、生値ではなく比で比べること。'
                + 'md_max_begr 経由は不活性（相方の KL_MD_BEGR_GANG が全段 1000 Nm 平坦）だが、'
                + '**死んだ較正ではない**: Torque_Limitation が KL_MD_JFZ_GANG と組でソフトレブリミッタの'
                + 'I 項目標を作るので、レブリミッタ手前では生きている。',
        },
    },
    {
        kind: 'curve', symbol: 'KL_SMG_MOT_J_MOTOR', address: 0x2ACC, bank: 'slave',
        category: 'inertia', label: 'SMG J CURVE',
        description: {
            en: 'DO NOT CHANGE. An inertia-labelled term inside the SMG vehicle-dynamics observer, '
                + 'looked up on TARGET engine speed. Stock 0.0078 / 0.398 / 0.5 — a shape no '
                + 'physical inertia has, since it would mean the engine weighs nothing at 1520 rpm. '
                + 'The lookup is code-confirmed; what the observer then does with the result was '
                + 'never recovered, so the direction of a change is unknown.',
            ja: '**変更しないこと。** SMG 車両ダイナミクスオブザーバ内の慣性名義の項で、'
                + '**目標**回転数で引かれる。純正 0.0078 / 0.398 / 0.5 — 1520 rpm でエンジンの慣性が'
                + 'ほぼゼロという形は物理的な慣性ではありえない。'
                + '引いていること自体は code-confirmed だが、'
                + 'オブザーバが結果をどう使うかは未回収なので、変更の向きすら分からない。',
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
                + '0 / 0.701 / 1.601 / 3.399 / 5.0 / 8.0 / 12.0 / 0.75 Nms², index 0 being neutral. '
                + 'READ ONLY here, and the most useful row in this catalog: it is what makes the '
                + 'in-gear correction computable instead of estimated. Because J_vehicle dwarfs '
                + 'J_engine in every gear, a 20 % lighter flywheel moves the effective inertia by '
                + 'only 5 % in first and 0.4 % in sixth.',
            ja: 'クランク軸換算の車両慣性をギアごとに与えるカーブ（**BMW 自身の値**）。'
                + '純正 0 / 0.701 / 1.601 / 3.399 / 5.0 / 8.0 / 12.0 / 0.75 Nms²、index 0 がニュートラル。'
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
            en: 'Idle controller integrator time constant. Stock 5.12 s, which is raw 1 — the '
                + 'slowest value that can be written. That is why the revs hang before falling '
                + 'after a lift. Reciprocal scaling, so intermediate values do not exist: the '
                + 'writable neighbours are 2.56 (raw 2), 1.707 (raw 3), 1.28 (raw 4).',
            ja: 'アイドル制御 I 項の時定数。純正 5.12 s ＝ raw 1 で、**書ける中で最も遅い端**。'
                + 'アクセルオフ後に回転が張り付いてから落ちる主因。'
                + '**逆数スケーリングなので中間値は存在しない**: 書ける隣は 2.56 (raw 2) / 1.707 (raw 3) / 1.28 (raw 4)。',
        },
    },
    {
        kind: 'constant', symbol: 'K_LFR_TAU_IA2_KKS', address: 0x9A9F, bank: 'master',
        category: 'inertia', label: 'LFR TAU IA2 KKS',
        bits: 8, signed: false, units: 's', scaling: reciprocal(5.12),
        description: {
            en: 'Idle integrator time constant with the clutch disengaged. Stock 0.0201 s, raw 255 '
                + '— the fastest writable value. On a 20 ms task a 20 ms time constant discards the '
                + 'integrator in one cycle, which is what produces the dip the instant the clutch '
                + 'goes in. Lower inertia makes that dip deeper for the same torque error.',
            ja: 'クラッチ断時のアイドル I 項時定数。純正 0.0201 s ＝ raw 255 で、**書ける中で最も速い端**。'
                + '20 ms タスクで時定数 20 ms は「1 周期で積分値を全部捨てる」に等しく、'
                + 'クラッチを切った瞬間の落ち込みを直接作っている。慣性が下がると同じトルク誤差でも落ち込みが深くなる。',
        },
    },
    {
        kind: 'constant', symbol: 'K_LFR_TAU_IA2_KS', address: 0x9A4E, bank: 'master',
        category: 'inertia', label: 'LFR TAU IA2 KS',
        bits: 8, signed: false, units: 's', scaling: reciprocal(5.12),
        description: {
            en: 'The clutch-engaged counterpart, stock 0.32 s. Not a change target — it is here as '
                + 'the reference that shows how far out of family K_LFR_TAU_IA2_KKS sits.',
            ja: 'クラッチ接時の対応値。純正 0.32 s。変更対象ではなく、'
                + 'K_LFR_TAU_IA2_KKS がどれだけ外れた値かを示す基準として置いてある。',
        },
    },
    {
        kind: 'curve', symbol: 'KL_LFR_TZ_NEG', address: 0x9CE6, bank: 'master',
        category: 'inertia', label: 'LFR TZ NEG',
        description: {
            en: 'Idle ignition retard authority in the rev-DOWN direction. Stock: all sixteen '
                + 'points 0.0 Nm — the fast path for pulling revs down does not exist in this '
                + 'calibration. Structural, not inertia-related, but lower inertia is what exposes '
                + 'it. Useless on its own: KL_MD_RES_LRW gates it and must be opened in the same '
                + 'flash. Evidence is xref-only, so treat a change as unproven until a log shows it.',
            ja: 'アイドル点火リタードの**回転を下げる側**の権限。純正は 16 点すべて 0.0 Nm ＝ '
                + '**この較正には回転を速く下げる経路が 1 Nm も存在しない**。'
                + '慣性とは無関係な構造上の穴だが、慣性が減ると露呈する。'
                + '**単独では無意味** — KL_MD_RES_LRW がゲートなので同じフラッシュで両方開けること。'
                + '根拠は xref-only なので、ログで確認するまで成功と見なさない。',
        },
        x: { address: 0x9CE6, n: 16, bits: 16, signed: false, units: 'rpm', label: 'N ERROR', scaling: { math: '-X', toPhysical: r => -r, toRaw: v => -v } },
        values: { address: 0x9D06, n: 16, bits: 16, signed: false, units: 'Nm', scaling: divideBy(80) },
    },
    {
        kind: 'curve', symbol: 'KL_MD_RES_LRW', address: 0x97D8, bank: 'master',
        category: 'inertia', label: 'MD RES LRW',
        description: {
            en: 'Torque reserve the idle controller is allowed to hold. y[0] is stock 0.0 Nm, which '
                + 'is the gate that makes KL_LFR_TZ_NEG inert. A permanent reserve is a permanent '
                + 'ignition retard, so more than about 3 Nm costs fuel, raises exhaust temperature '
                + 'and dulls the launch.',
            ja: 'アイドル制御が保持してよいトルクリザーブ。y[0] が純正 0.0 Nm で、'
                + 'これが KL_LFR_TZ_NEG を不活性にしているゲート。'
                + '常時リザーブ＝常時点火リタードなので、3 Nm を超えると燃費悪化・排気温上昇・発進の鈍さが出る。',
        },
        x: { address: 0x97D8, n: 4, bits: 16, signed: false, units: '°', label: 'STEER', scaling: { math: 'X*0.04375', toPhysical: r => r * 0.04375, toRaw: v => v / 0.04375 } },
        values: { address: 0x97E0, n: 4, bits: 16, signed: false, units: 'Nm', scaling: divideBy(10) },
    },
    {
        kind: 'curve', symbol: 'KL_LFR_DQP_POS', address: 0x9ABE, bank: 'master',
        category: 'inertia', label: 'LFR DQP POS',
        description: {
            en: 'Idle proportional term against speed error. Stock leaves 0-60 rpm of error at '
                + '0 Nm — a deadband. With less inertia the engine crosses that deadband faster, so '
                + 'the controller reaches it later in the excursion.',
            ja: 'アイドル制御の P 項（回転偏差に対するトルク）。純正は偏差 0–60 rpm が 0 Nm ＝ 不感帯。'
                + '慣性が減ると不感帯を通過する時間が短くなるので、制御が介入するのが相対的に遅くなる。',
        },
        x: { address: 0x9ABE, n: 16, bits: 16, signed: false, units: 'rpm', label: 'N ERROR', scaling: IDENTITY },
        values: { address: 0x9ADE, n: 16, bits: 16, signed: false, units: 'Nm', scaling: divideBy(80) },
    },
    {
        kind: 'curve', symbol: 'KL_SA_N40_GANG', address: 0x0E3C, bank: 'slave',
        category: 'inertia', label: 'SA N40 GANG',
        description: {
            en: 'Overrun fuel-cut lower speed limit, per gear. Index 0 is the clutch-out/neutral '
                + 'case and is the ONLY one worth moving: in gear the reflected vehicle inertia '
                + 'dominates so the rev-drop rate barely changes, while clutch-out the engine\'s '
                + 'own inertia is the whole plant. Stock 320 rpm at index 0. Quantised to 40 rpm, '
                + 'so 390 cannot be written.',
            ja: 'オーバーラン燃料カットの下限回転数（ギア別）。'
                + '**index 0（クラッチ切／N）だけが動かす価値のあるセル**: '
                + 'ギヤが入っていれば反射車両慣性が支配して回転落ち速度はほぼ変わらないが、'
                + 'クラッチを切った瞬間は機関自身の慣性がプラントの全部になる。純正 index 0 は 320 rpm。'
                + '**40 rpm 刻みなので 390 は書けない。**',
        },
        x: { address: 0x0E3C, n: 8, bits: 8, signed: false, units: '', label: 'GEAR', scaling: IDENTITY },
        values: { address: 0x0E44, n: 8, bits: 8, signed: false, units: 'rpm', scaling: multiplyBy(40) },
    },
    {
        kind: 'curve', symbol: 'KL_SA_N40_HYS_GANG', address: 0x0E2A, bank: 'slave',
        category: 'inertia', label: 'SA N40 HYS',
        description: {
            en: 'Hysteresis on the above, per gear. Stock 120 rpm at index 0. Moved with it and for '
                + 'the same reason; also 40 rpm quantised.',
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
                + 'Lower inertia raises loop gain while every lag stays put, so shortening this is '
                + 'how a little phase margin is bought back. Does NOT affect D_N40, which the '
                + 'fuel-cut logic uses. Reciprocal scaling.',
            ja: '回転勾配フィルタ D_N_GEFILTERT の PT1 時定数。純正 0.0985 s。'
                + '慣性が下がるとループ利得だけが上がり位相遅れは変わらないので、'
                + 'ここを短くするのが位相余裕を買い戻す手段。'
                + '**燃料カットが使う D_N40 には効かない。** 逆数スケーリング。',
        },
    },
    {
        kind: 'curve', symbol: 'KL_DYN_TZ_DBGR', address: 0xB388, bank: 'master',
        category: 'inertia', label: 'DYN TZ DBGR',
        description: {
            en: 'Transient ignition retard against engine speed. Stock -3 at 2000 rpm falling to '
                + '-12 from 5000 up. With less inertia the same retard costs more speed, so the '
                + 'high-rpm end is the part worth easing.',
            ja: '過渡点火リタード（回転数軸）。純正は 2000 rpm で −3、5000 rpm 以上で −12。'
                + '慣性が減ると同じリタード量でも回転の落ち込みが大きくなるので、緩めるなら高回転側。',
        },
        x: { address: 0xB388, n: 10, bits: 16, signed: false, units: 'rpm', label: 'RPM', scaling: IDENTITY },
        values: { address: 0xB39C, n: 10, bits: 16, signed: true, units: '°KW', scaling: divideBy(10) },
    },
    {
        kind: 'constant', symbol: 'K_SMG_N_ZIEL_ABWUERG', address: 0x2855, bank: 'slave',
        category: 'inertia', label: 'SMG N ABWUERG',
        bits: 8, signed: false, units: 'rpm', scaling: multiplyBy(40),
        description: {
            en: 'SMG anti-stall target speed. Stock 1200 rpm, 40 rpm quantised. Stored kinetic '
                + 'energy is 0.5*J*omega^2, so a lighter flywheel loses stall margin in proportion '
                + 'to the inertia ratio and the target has to come up to buy it back.',
            ja: 'SMG のエンスト回避目標回転数。純正 1200 rpm、40 rpm 刻み。'
                + '蓄積エネルギは 0.5·J·ω² なので、軽量フライホイールでは慣性比のぶんストール余裕が減る。'
                + '取り戻すには目標回転を上げるしかない。',
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
        kind: 'series', symbol: 'KF_MD_LS_GANG_FAKTOR', address: 0x927C, bank: 'master',
        category: 'inertia', label: 'LS GEAR FACTOR',
        indexLabel: 'gear',
        indexNames: ['idx0/OOR', '1st', '2nd', '3rd', '4th', '5th', '6th', 'idx7'],
        values: { address: 0x927C, n: 8, bits: 16, signed: false, units: '', scaling: divideBy(1024) },
        description: {
            en: 'Gear weighting on the tip-in torque slew allowance. Stock 1.00 / 0.75 / 0.80 / '
                + '0.90 / 1.00... — first gear held down hardest, which is independent evidence '
                + 'that larger means more direct. NOT DEFINED IN THE XDF; address and shape come '
                + 'from the disassembly, so a write here is a direct patch and the byte count must '
                + 'be checked twice. This is where the in-gear inertia correction belongs: '
                + 'KF_MD_LS_KOMF has no gear axis, and r_eff differs per gear by a factor of ten.',
            ja: 'ティップインのトルク変化率許容量に掛かるギア別係数。'
                + '純正 1.00 / 0.75 / 0.80 / 0.90 / 1.00…で、**1 速を最も強く抑えている** — '
                + 'これ自体が「大きい＝ダイレクト」の独立した裏付けになっている。'
                + '**XDF 未定義**（アドレスと形状は逆アセンブル由来）なので直接パッチであり、バイト数は二重確認すること。'
                + '**ギヤ込みの慣性補正はここに置くのが正しい**: '
                + 'KF_MD_LS_KOMF にはギア軸が無く、r_eff はギア間で 10 倍違う。',
        },
    },
    {
        kind: 'series', symbol: 'KF_MD_DASHPOT_GANG_FAKTOR', address: 0x929E, bank: 'master',
        category: 'inertia', label: 'DP GEAR FACTOR',
        indexLabel: 'gear',
        indexNames: ['idx0/OOR', '1st', '2nd', '3rd', '4th', '5th', '6th', 'idx7'],
        values: { address: 0x929E, n: 8, bits: 16, signed: false, units: '', scaling: divideBy(1024) },
        description: {
            en: 'The same weighting on the tip-out (dashpot) side. Stock 1.00 / 0.60 / 0.84 / 0.91 '
                + '/ 0.93 / 1.00 — first gear held down harder still than on the tip-in side. Also '
                + 'XDF-undefined.',
            ja: 'ティップアウト（ダッシュポット）側の同じギア別係数。'
                + '純正 1.00 / 0.60 / 0.84 / 0.91 / 0.93 / 1.00 で、1 速の抑えはティップイン側よりさらに強い。'
                + 'これも XDF 未定義。',
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
