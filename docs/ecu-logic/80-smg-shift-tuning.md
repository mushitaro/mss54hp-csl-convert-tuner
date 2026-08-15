# 80 — SMG II 変速チューニング（ブリップ / シフト速度 / 滑らかさ）

用語は `00-glossary.md`。アドレスは **XDF アドレス**が主表記（ツールが編集する 64 KB パーシャル BIN では
これがそのままオフセット）。1 MB フルコンテナでは **slave: `0x88000 + XDF`**、master: XDF そのもの。

**値の出典**: `Full 211323000401PD31_TERRA.bin`。**あなたの BIN の数値は違いうる。必ず自分の BIN を読むこと。**

---

## 0. 範囲 — DME にどこまで入っているか

**DME は SMG の CAN 窓口ではない。** slave バンクに **52 個の SMG 関数と 208 個の較正値**があり、
クラッチのフェーズプロファイル（phase1/2/3）、変速フェーズ FSM、エンジン回転レギュレータ、
レーススタート、車両ダイナミクスオブザーバまで入っている。

```
cfg_s.getriebetyp = 0x40   → SMG コードは `cfg_s_getriebetyp == 0x40` でゲート（task_10ms, slave 0x012A44）
cfg_m.getriebetyp = 0x40   → EGS(AT) 経路は (&0x30)==0x30 が条件なので不成立
```

したがって本車で SMG 経路は**生きている**（`70-max-power-methodology.md` §13.4 と同じ確認）。

> **未確認**: 油圧バルブの最終駆動が DME 側か SMG ユニット側かは追っていない。
> 本文書が扱うのは **DME が計算しているセットポイントと時間**であり、そこは確実に DME 側にある。

---

## 1. 共通の軸 — 12 段の「Kennung」

シフト速度を決める 2 枚のマップは、どちらも **(Kennung 1–12, 現在ギア 1–5)** で引かれる。
`smg_update_ki_regulation_params`（slave `0x03AEEC`、code-confirmed）:

```
DAT_00ffdc62 = kfu_bint(KF_SMG_T_ABREGEL,  ki_ab,  smg_can_istgang)   ← トルク抜き時間 [ms]
DAT_00ffdc62 = 1   [if == 0]
DAT_00ffdc66 = kfu_bint(KF_SMG_T_AUFREGEL, ki_auf, smg_can_istgang)   ← トルク戻し時間 [ms]
DAT_00ffdc66 = 1   [if == 0]
```

**読みどころ 2 点**:

1. **ダウンとアップで別インデックス**（`ki_ab` / `ki_auf`）。片方だけ速くできる。
2. **0 を 1 に矯正している = 除数として使われる。** 実際
   `smg_shift_abregel_ramp_correction_update` に
   `DAT_00ffdb3c = (K_SMG_T_KORR_AB_MIN << 7) / DAT_00ffdc62` がある。
   → **時間が小さい ＝ ランプが速い。** 向きはこれで確定。

Kennung が表示上の Drivelogic 段（S1–S6 / D）にどう対応するかは**未確定**。
`K_SMG_PROG_MIN_ZR = 6` があるので 1–6 / 7–12 の 2 群と推測されるが `inference`。
→ 実車で `0xFFDB78`（プログラムレベル。`smg_update_program_level` が書く）をログし、
段を切り替えて値を見れば確定する（§7）。

---

## 2. シフト速度 — `KF_SMG_T_ABREGEL` / `KF_SMG_T_AUFREGEL`

`z = raw × 10` [ms]、5 行（ギア）× 12 列（Kennung）、8 bit。

### `KF_SMG_T_ABREGEL`（slave `0x2D7C`、z `0x2D8D`）— トルク抜き時間

| ギア \ Kennung | 1 | 4 | 7 | 9 | 11 | 12 |
|---|---|---|---|---|---|---|
| 1 | 1210 | 540 | 330 | 240 | 240 | **100** |
| 2 | 1090 | 470 | 280 | 240 | 240 | **100** |
| 3 | 1010 | 410 | 240 | 220 | 200 | 150 |
| 4 | 940 | 360 | 210 | 180 | 160 | 160 |
| 5 | 870 | 320 | 200 | 180 | 180 | 180 |

### `KF_SMG_T_AUFREGEL`（slave `0x2DCC`、z `0x2DDD`）— トルク戻し時間

| ギア \ Kennung | 1 | 4 | 7 | 9 | 11 | 12 |
|---|---|---|---|---|---|---|
| 1 | 1100 | 650 | 350 | 200 | 110 | **50** |
| 2 | 1050 | 600 | 350 | 160 | 90 | 80 |
| 3 | 1050 | 550 | 330 | 200 | 110 | 100 |
| 4 | 1000 | 550 | 330 | 180 | 130 | 120 |
| 5 | 1000 | 550 | 330 | 180 | 150 | 140 |

### 方向性

- **最速側（Kennung 11–12）は既に 100–180 ms。** ここを削る余地は小さい。
  体感差が大きいのは**中間段（4–9）の階段を詰める**方。
- **速度は `_ABREGEL`、滑らかさは `_AUFREGEL`** と役割を分けて考える。
  `_AUFREGEL` を下げると再係合が速くなり、そのままシフトショックになる。
- 1 段あたり 10–20 % を目安に、**ギア 1 行だけ / Kennung 1 列だけ**動かして切り分ける。
  5 行 12 列を一度に動かすと何が効いたか分からなくなる。
- 補正: `KL_SMG_T_KORR_AB`（`0x28F2`）が抜きランプを相対負荷で 0 → 75 % スケール。
  `K_SMG_T_KORR_AB_MIN`（`0x2825` = 240 ms）は**発進時（`smg_fahrzustand == Anfahren`）の床**。

> **摩耗と直結する。** `_ABREGEL` を詰める＝クラッチのスリップ時間短縮＝トルク段差増。
> `smg_clutch_protection_monitor`（slave `0x03843E`）が存在するので、
> 行き過ぎると保護が介入して**かえって遅くなる**可能性がある。

---

## 3. ブリッピングの鋭さ

`smg_shift_deltaN_request_update`（slave `0x038314`）を逆アセンブルして回収した機構:

```
d3 = smg_can_gewuenschter_gang − 1            ; 0xFFDB15 = CAN の要求ギア
d0 = |n_zie − N|                              ; 0xFFDB0A = 目標回転、N = 実回転
d0 = klu_wint(KL_SMG_MOT_DN_SOLL, d0)         ; → 指令スルーレート [Upm/s]
if ((*0xFFDB6C & 1) == 0) and (d3 < 3):
    d0 = (table_0x2862[d3] × d0) >> 7         ; ★ ギア別倍率
...
d0 = (トルク << 7) / K_SMG_J_MOTOR            ; 実現可能な dω/dt との比較
```

### 3.1 スルーレート指令 `KL_SMG_MOT_DN_SOLL`（slave `0x2AA8`、y `0x2AB4`、16 bit）

| 回転差 [rpm] | 0 | 120 | 300 | 600 | 1200 | 3000 |
|---|---|---|---|---|---|---|
| 指令 [rpm/s] | 200 | 400 | 1020 | 2920 | 8000 | 12000 |

### 3.2 ★ ギア別倍率（低速ギアのブリップが鈍い原因）

slave `0x2862` の **3 バイト表**、`要求ギア − 1` で引き、`/128`:

| 要求ギア | raw | 倍率 |
|---|---|---|
| 1 速 | 13 | **0.102** |
| 2 速 | 64 | **0.500** |
| 3 速 | 128 | 1.000 |
| 4 速以上 | — | スケーリングなし（`d3 < 3` で分岐外） |

**1 速へのダウンシフトは指令スルーレートが 1/10 に落とされている。** 2 速で半分。
→ **低速ギアのブリップが眠いのは `KL_SMG_MOT_DN_SOLL` ではなくこの表。**
ここを上げないと 3.1 をいくら上げても 1–2 速では効かない。

> **XDF が 3 バイトのうち先頭 1 バイトしか定義していない**
> （`0x2862` のみ定義、`0x2863` / `0x2864` は未定義）。
> 触るなら XDF 追加か、パッチとして 3 バイト直書きが必要。
> → `CSL_0401_Binary_Disassembly_Notes/docs/finding_xdf_undefined_calibration.md`

### 3.3 3 つの天井 — ここを見ないと 3.1 を上げても無駄

| 天井 | XDF (slave) | 現在値 | 意味 |
|---|---|---|---|
| **トルク権限** | `K_SMG_MOT_RAB_M_MAX` `0x286C` | **100.0 Nm** | 回転レギュレータが要求できるトルク上限 |
| **想定慣性** | `K_SMG_J_MOTOR` `0x280A` | **0.25 Nms²** | 100 Nm ÷ 0.25 ≈ 400 rad/s² ≈ **3800 rpm/s** |
| 空気側の過渡 | `KL_EDK_VORST` master `0x8132` | 8–34 %tv | スロットルの整定速度（`70-...md` §17.1） |

**表が 8000–12000 rpm/s を要求しても、トルク側が約 3800 rpm/s しか出せない。**
∴ **順序は `K_SMG_MOT_RAB_M_MAX` → ギア別倍率 → `KL_SMG_MOT_DN_SOLL`。** 逆にやると効かない。

### 3.4 レギュレータのゲイン

| パラメータ | XDF (slave) | 現在値 | 備考 |
|---|---|---|---|
| `KL_SMG_MOT_DN_REG_P` | `0x2AC2` | 0.010 / 0.006 / 0.005 / **0.0** Nms/Upm | x = 回転差 120/240/320/**520** rpm。**520 rpm 差で P がゼロ** |
| `K_SMG_MOT_N_REG_P_AH` | `0x2870` | 0.04 Nm/Upm | |
| `K_SMG_MOT_N_REG_P_KH` | `0x2871` | 0.08 Nm/Upm | |
| `K_SMG_MOT_N_REG_I` | `0x2872` | 0.003 Nm/Upm | |
| `KL_SMG_MOT_N_REG_D_D` | `0x2A9A` | 0.8 / 0.9 / 1.2 / 1.1 / 0.6 / **0.0** Nm/Upm | **4000 rpm 以上で D がゼロ** |
| `KL_SMG_MOT_N_REG_D_U` | `0x2A8C` | 0.2 / 0.2 / 0 / 0 / 0 / 0 Nm/Upm | ほぼ不活性 |
| `K_SMG_MOT_N_REG_D_MIN/MAX` | `0x287C` / `0x287E` | 90 / 350 rpm | レギュレータの作動窓 |
| `K_SMG_MOT_N_REG_T_MAX` | `0x2882` | 400 ms | 回転合わせの打ち切り |

**大きな回転差のダウンシフトが鈍い**なら `KL_SMG_MOT_DN_REG_P` の 520 rpm 点がゼロなのが原因候補。
**高回転でのブリップが甘い**なら `KL_SMG_MOT_N_REG_D_D` が 4000 rpm 以上でゼロなのが原因候補。

### 3.5 `K_SMG_J_MOTOR` は指令スルーレートの上限クランプ

逆アセンブルで用途が確定した（slave `0x038314`）:

```
0383a4:  d3 = (*0xFFDB5E << 7) / K_SMG_J_MOTOR      ; α_available = T / J
0383ae:  cmp.l  d0, d3                              ; d0 = 指令スルーレート（§3.1×§3.2）
0383b0:  bge.b  $383b4                              ;   available >= commanded なら指令を維持
0383b2:  move.w d3, d2                              ;   さもなくば指令を α_available まで切り下げる
```

**∴ `d2 = min(指令スルーレート, T / K_SMG_J_MOTOR)`。フィードフォワードの上限クランプである。**
（直後に第 2 の同型計算があり、そちらは `0x285E` = 100 で下限が掛かる）

> **★ この関数は変速中だけのものではない。** `smg_shift_deltaN_request_update` の呼び出し元は 2 つあり、
> 片方が **`smg_shift_phase3_clutch_reengage_regulator`（slave `0x037C6A`、32 stmts）** ＝ クラッチ再係合である
> （もう片方は `smg_shift_reg_prestep_flatten_profile`、slave `0x0377AE`）。
> **∴ `K_SMG_J_MOTOR` はブリップだけでなく、発進と変速のたびに効く。**
> 下げる ＝ 再係合レギュレータの許容スルーレートを上げる、でもある。
>
> **「発進直後・低速からの踏み込み」「変速直後の踏み足し」でガクつくなら、
> ここを下げたことが第一容疑者。** 純正へ戻す 1 バイトの A/B が最短の切り分けになる。
> 詳細と手順は `85-flywheel-inertia-autotune.md` §3.2。

したがって向きは:

| `K_SMG_J_MOTOR` | 計算される α_available | 結果 |
|---|---|---|
| **実 J より大きい**（＝軽量 FW を入れて放置） | **過小** | 指令が不要に切り下げられ、**ブリップが鈍る**。回転合わせが `K_SMG_MOT_N_REG_T_MAX`(400 ms) 内に終わらず、係合時に段差が出ることもある |
| **実 J より小さい** | 過大 | クランプが効かなくなり指令がそのまま通る。行き過ぎると回転が合わない |

> **軽量フライホイールを入れたら `K_SMG_J_MOTOR` は「下げる」方向。**
> レート上限なので、下げることで**より速いブリップが許可される**。
> クランプはフィードフォワード側だけで、実回転は §3.4 の P/I が別途閉ループで追うので、
> ここを下げても暴走はしない（過大に下げれば回転が合わなくなる、という形で出る）。

値の決め方は §3.6。→ `CSL_0401_Binary_Disassembly_Notes/docs/lightweight_flywheel_tuning.md`

### 3.6 `K_SMG_J_MOTOR` の値をどう決めるか

**これは質量ではなく慣性モーメント。** 単位 `Nms2` は次元的に **kg·m²** と同一
（`N·m = J·rad/s²` より `J = N·m·s²`、`kg·m² = N·s²·m²/m = N·m·s²`）。

**質量比でスケールしてはいけない。** 理由が 2 つある。

1. **`J ∝ m·r²` であって `m` ではない。** 軽量フライホイールは外周（`r²` が最大の部分）から
   優先的に肉を取るので、**J の減り方は質量の減り方より大きい**。質量比で掛けると過小評価になる。
2. **これはフライホイール単体ではなく、クランク軸換算の回転系全体の慣性。**
   クランク、コンロッド／ピストンの等価慣性、フライホイール、クラッチ、ダンパ／プーリの合計。
   **変わるのはフライホイール＋クラッチの分だけ。**

正しい計算は差分:

```
J_new = 0.25 − (J_FW_純正 + J_CL_純正) + (J_FW_新 + J_CL_新)
```

純正値の内訳の目安（**推定**。BMW の内訳数値は持っていない）:
S54 の 2 マスフライホイールは約 10.5 kg、回転半径 `k ≈ 0.115 m` とすると
`J ≈ 10.5 × 0.115² ≈ 0.139`。残り（クランク＋等価往復質量＋ダンパ）が約 0.11。
合計 ≈ 0.25 で**較正値と一致する**ので、0.25 は回転系全体の物理慣性として妥当。
→ **フライホイール＋クラッチが全体の 5〜6 割**を占める。

J の入手方法（確度順）:

| 手段 | 備考 |
|---|---|
| メーカー公表の `J` | 軽量 FW メーカーが kg·m² / lb·ft² で公表していることがある。**質量しか無い場合は使えない** |
| 形状から計算 | `J = Σ m_i r_i²`。リング近似なら `J ≈ m·k²`、`k ≈ 0.7–0.8 × 外半径` |
| 振り子法で実測 | 二線式（bifilar）吊りの振動周期から `J` を出す。最も確実 |

**量子化**: 8 bit `x/128` なので刻みは **0.0078125**（現在値の約 3 %）。書ける範囲は 0–1.99219。
`0.20 → raw 26 = 0.203125`、`0.18 → raw 23 = 0.179688`、`0.15 → raw 19 = 0.148438`
（いずれも厳密には表現不能。`enc` で確認してから書くこと）

**実車で詰める方法（物理値が分からなくても可）**: この定数はレート上限なので、症状で追える。
純正 0.25 のまま軽量 FW を入れてブリップが鈍いなら、raw を 2–3 ずつ（0.016–0.023 ずつ）下げ、
`K_SMG_MOT_N_REG_T_MAX`(400 ms) 内に回転が合うようになる点を探す。
下げ過ぎると回転が合わずに係合するので、そこが下限。

> **★ 物理値に合わせるのが目的ではない。** 上の §3.5 の追記のとおりこの定数は再係合にも効くので、
> 実 J に「正確に」合わせると**較正の他の部分が前提にしていた平滑化が消える**。
> 純正 0.25 はレートクランプとして意図的に保守的な値である。
> **「正確にすべき物理定数」ではなく「再係合の穏やかさと、ブリップの鋭さの折り合いを取るつまみ」
> として扱うこと。** 実測 J は出発点であって答えではない。

> **`K_MD_J_MOTOR`（master `0x9554`、0.2687 Nms²、`x/268`）と混同しないこと。**
> 名前も単位も似ているが**別物**で、スケーリングも異なる。
> そちらは `Torque_Limitation` 系からの参照しか無く、
> 相方の `KL_MD_BEGR_GANG` が全点 1000 Nm に張り付いているため**経路が死んでいる**
> （`70-max-power-methodology.md` §15 と同じ「不活性」の類）。**触っても何も起きない。**

> **`KL_SMG_MOT_J_MOTOR`（slave `0x2ACC`）も別物。** 3 点カーブで軸は `n_zie`（目標回転）、
> 値は 0.0078 / 0.398 / 0.5（1520 / 3000 / 6000 rpm）。
> 単位ラベルは `Nms2` だが、**低回転でほぼ 0 になる形は物理的な慣性ではない**。
> 消費先は `smg_vehicle_dynamics_observer_update`（code-confirmed）で、
> オブザーバ内の重み付けと思われるが**用途は未確定**。§3.5 の議論をここへ流用しないこと。

---

## 4. シフトの滑らかさ

| パラメータ | XDF (slave) | 現在値 | 上げると |
|---|---|---|---|
| `KF_SMG_T_AUFREGEL` | `0x2DCC` | 50–1100 ms | **主役。** 滑らか・遅い |
| `KL_SMG_T_KORR_AB` | `0x28F2` | 0 → 75 % | 高負荷での抜きランプが緩む |
| `K_SMG_TAU_MD_FAHRER` | `0x2800` | 0.0753 s | ドライバトルク要求が鈍る＝滑らか |
| `K_SMG_TAU_DMD_FAHRER` | `0x2807` | 0.512 s | その微分側 |
| `K_SMG_MD_FW_SA_D_M` | `0x282E` | 50 Nm/s | ドライバトルクのレート制限（下げると穏やか） |
| `K_SMG_TAU_DN_FILTER` | `0x2801` | 0.0150 s | 回転差フィルタ。レギュレータが穏やかに |
| `K_SMG_MOT_N_REG_I_T` | `0x2878` | 600 ms | I 項の作動時間 |

**注意**: `K_SMG_TAU_*` はスケーリングが `2.56/x` または `5.12/x` の**逆数**。
raw を上げると時定数は**下がる**。`enc` で必ず確認してから書くこと。

再係合の作り込み本体は `smg_shift_phase3_clutch_reengage_regulator`（slave `0x037C6A`、32 stmts）。
「つながり方」を本気で追うならここの消費パラメータを洗うのが次の一手。

---

## 5. パラメータ表

| パラメータ定義名 | 種別 | XDFアドレス | ファイルオフセット | bank | 現在値 | 単位 | 役割 | 変更方向・量 | リスク | 根拠 |
|---|---|---|---|---|---|---|---|---|---|---|
| KF_SMG_T_ABREGEL | map | 0x2D7C | 0x8AD7C | slave | 100–1210 | ms | トルク抜き時間 (Kennung × ギア)。z=0x2D8D | 小さく＝速い。中間段を 10–20 % ずつ | クラッチ摩耗・保護介入 | code-confirmed |
| KF_SMG_T_AUFREGEL | map | 0x2DCC | 0x8ADCC | slave | 50–1100 | ms | トルク戻し時間。z=0x2DDD | 小さく＝速いが荒い | シフトショック増 | code-confirmed |
| KL_SMG_MOT_DN_SOLL | curve | 0x2AA8 | 0x8AAA8 | slave | 200–12000 | Upm/s | 回転差→指令スルーレート。y=0x2AB4 | 上げて鋭く。先に §3.3 の天井を上げる | 単独では効果なし | code-confirmed |
| KL_SMG_MOT_DN_REG_P | curve | 0x2AC2 | 0x8AAC2 | slave | 0.010–0.0 | Nms/Upm | 回転差レギュレータ P。y=0x2AC6 | 520 rpm 点の 0 を埋める | 発振 | code-confirmed |
| KL_SMG_MOT_N_REG_D_D | curve | 0x2A9A | 0x8AA9A | slave | 0.8–0.0 | Nm/Upm | 回転レギュレータ D（下側）。y=0x2AA0 | 4000 rpm 以上の 0 を埋める | 高回転で振動 | funktionsrahmen-only |
| KL_SMG_MOT_N_REG_D_U | curve | 0x2A8C | 0x8AA8C | slave | 0.2–0.0 | Nm/Upm | 同（上側）。y=0x2A92 | ほぼ不活性 | — | funktionsrahmen-only |
| KL_SMG_T_KORR_AB | curve | 0x28F2 | 0x8A8F2 | slave | 0–75 | % | 抜きランプの負荷補正。y=0x28F8 | 上げると高負荷で緩い | — | code-confirmed |
| K_SMG_MOT_RAB_M_MAX | constant | 0x286C | 0x8A86C | slave | 100.0 | Nm | 回転レギュレータのトルク上限 | **ブリップ強化はここから** | 駆動系負荷・ノック | code-confirmed |
| K_SMG_MOT_RAB_M_MIN | constant | 0x286A | 0x8A86A | slave | -20.0 | Nm | 同下限（引き側） | 通常変更不要 | — | code-confirmed |
| K_SMG_MOT_RAB_T_MAX | constant | 0x286E | 0x8A86E | slave | 4.0 | sec | 同打ち切り時間 | 変更不要 | — | code-confirmed |
| K_SMG_J_MOTOR | constant | 0x280A | 0x8A80A | slave | 0.25 | Nms2 | 回転系全体の慣性。指令スルーレートの上限クランプ `min(指令, T/J)` | **軽量FW時は下げる**。刻み 0.0078。§3.6 | 過大でブリップが鈍る／過小で回転が合わない | code-confirmed |
| KL_SMG_MOT_J_MOTOR | curve | 0x2ACC | 0x8AACC | slave | 0.0078–0.5 | Nms2 | オブザーバ内の慣性項（用途未確定）。y=0x2ACF | **触らない**（§3.6 の注記） | 用途不明 | xref-only |
| K_MD_J_MOTOR | constant | 0x9554 | 0x09554 | master | 0.268657 | Nms2 | 別系統の慣性定数。**経路が死んでいる** | 変更しても無効 | 混同注意 | inference |
| K_SMG_MOT_N_REG_P_AH | constant | 0x2870 | 0x8A870 | slave | 0.04 | Nm/Upm | 回転レギュレータ P (AH) | 上げて追従改善 | 発振 | funktionsrahmen-only |
| K_SMG_MOT_N_REG_P_KH | constant | 0x2871 | 0x8A871 | slave | 0.08 | Nm/Upm | 回転レギュレータ P (KH) | 同上 | 発振 | funktionsrahmen-only |
| K_SMG_MOT_N_REG_I | constant | 0x2872 | 0x8A872 | slave | 0.003 | Nm/Upm | 同 I 項 | 微増 | ワインドアップ | funktionsrahmen-only |
| K_SMG_MOT_N_REG_T_MAX | constant | 0x2882 | 0x8A882 | slave | 400.0 | ms | 回転合わせ打ち切り | 上げると粘る | 変速遅延 | funktionsrahmen-only |
| K_SMG_MOT_N_REG_D_MIN | constant | 0x287C | 0x8A87C | slave | 90.0 | Upm | レギュレータ作動窓 下限 | 下げると小さい差でも介入 | ハンチング | funktionsrahmen-only |
| K_SMG_MOT_N_REG_D_MAX | constant | 0x287E | 0x8A87E | slave | 350.0 | Upm | 同 上限 | 上げると大差でも介入 | — | funktionsrahmen-only |
| K_SMG_T_KORR_AB_MIN | constant | 0x2825 | 0x8A825 | slave | 240.0 | ms | 発進時の抜き時間の床 | 発進のみ影響 | 発進ショック | code-confirmed |
| K_SMG_TAU_MD_FAHRER | constant | 0x2800 | 0x8A800 | slave | 0.075294 | s | ドライバトルク PT1（scale 2.56/x） | 上げると滑らか。**raw と逆** | 応答鈍化 | code-confirmed |
| K_SMG_TAU_DMD_FAHRER | constant | 0x2807 | 0x8A807 | slave | 0.512 | s | 同微分側（5.12/x） | 同上 | — | funktionsrahmen-only |
| K_SMG_TAU_DN_FILTER | constant | 0x2801 | 0x8A801 | slave | 0.014971 | s | 回転差フィルタ（2.56/x） | 上げると穏やか | 追従遅れ | funktionsrahmen-only |
| K_SMG_MD_FW_SA_D_M | constant | 0x282E | 0x8A82E | slave | 50.0 | Nm/s | ドライバトルクのレート制限 | 下げると穏やか | 応答鈍化 | code-confirmed |
| K_SMG_MOT_NL_T_MAX | constant | 0x2858 | 0x8A858 | slave | 2000.0 | ms | 発進ウィンドウ長 | 発進のみ | — | code-confirmed |

---

## 6. 触ってはいけないもの

| 対象 | 理由 |
|---|---|
| `K_SMG_SK_*`（`0x28AE`–`0x28B4` 系、いずれも 1.0 s） | 安全概念側のタイムアウト。緩めると保護が遅れる |
| `smg_clutch_protection_monitor` 関連 | クラッチ保護。速度を追うなら**むしろ余裕を見る側** |
| `K_SMG_R_RAD_DYN`（`0x280C` = 307 mm） | 動的タイヤ半径。車速推定の基準。タイヤ変更時のみ、実測で |
| すべてのテーブルの軸 | 軸を動かすと隣接セルの意味が変わる（`60-tuning-logic.md` §8 と同じ理由） |

---

## 7. ログで確認すること

DS2 に SMG 専用ブロックは無いので、**間接的に見る**しかない。

| 見たいもの | 手段 |
|---|---|
| プログラムレベル（Kennung の確定） | `0xFFDB78`。DS2 で直接読めないので、S1–S6 を切り替えて挙動差から推定するか RAM 読み出しが必要 |
| ブリップの実効スルーレート | block 3 の `n`（rpm）を最速で。**block 3 単独なら 11.1 Hz** — ブリップは 200–400 ms なので 2–4 サンプルしか乗らない |
| 変速中のトルク介入 | block 19 の `tz1..tz6`（点火角、off 22–32）。**取得済みブロック内＝コスト増ゼロ** |
| 変速中の噴射 | block 19 の `ti1..ti6`（off 6–16） |
| ギア | block 3 には無い。block 83（EGAS）の `gang` |

> **レート的にブリップの過渡は DS2 では十分に測れない。**
> 200 ms のイベントに対し 11.1 Hz（90 ms/サンプル）では 2–3 点。
> 「鋭くなったか」は**体感と `n` の到達時間の粗い比較**までが限界で、
> スルーレートの数値検証はできない。ここは正直に諦める部分。

---

## 8. 確立できなかったこと

| 項目 | 状態 |
|---|---|
| **Kennung 1–12 と Drivelogic 段の対応** | 未確定。`K_SMG_PROG_MIN_ZR = 6` から 1–6 / 7–12 の 2 群と推測（`inference`） |
| **`0xFFDB6C` bit0 の意味** | ギア別倍率を適用するかのゲート。未同定 |
| **`0xFFDB5E`（トルク）の作られ方** | `/K_SMG_J_MOTOR` される分子。未回収 |
| **`ki_ab` / `ki_auf` の作られ方** | Kennung インデックスの生成元が未回収。`smg_update_ki_regulation_params` は消費側のみ |
| 油圧バルブの最終駆動位置 | DME 側か SMG ユニット側か未確認（§0） |
| `KL_SMG_MOT_N_REG_D_D` / `_D_U` の `_D`/`_U` の別 | 「下側/上側」と読んだが未確証。`funktionsrahmen-only` |

`stmts=0` の SMG 関数（`smg_shift_phase_dispatch_basic` / `_default`、
`smg_shift_speed_reg_dispatcher`、`smg_expected_N_from_V_and_gear`）は
`disasm.py` で回収可能。特に `smg_shift_speed_reg_dispatcher`（slave `0x03A79E`）は
変速速度レギュレータの選択そのものなので、次に読む価値が高い。

---

## 参照

- `70-max-power-methodology.md` §13.4（SMG トルク余裕）、§17.1（`KL_EDK_VORST` の確定）
- `CSL_0401_Binary_Disassembly_Notes/docs/lightweight_flywheel_tuning.md`
- `CSL_0401_Binary_Disassembly_Notes/docs/finding_xdf_undefined_calibration.md`（`0x2863`/`0x2864` 未定義の件）
