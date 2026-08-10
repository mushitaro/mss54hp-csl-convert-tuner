# 30 — アイドル制御と λ 開ループ条件

用語は `00-glossary.md`。アドレスは **64 KB パーシャル BIN のオフセット**。

---

## 1. 二層構造

MSS54HP 0401（EGAS 構成 `cfg_m_egas != 0`）のアイドル制御は**2 つのループ**でできており、
**この 2 つは同じループではない**。

| | **LFR** | **LLR / LLS** |
|---|---|---|
| 正式名 | Leerlaufregelung in **Momenten**struktur | Leerlaufregelung ohne Momentenstruktur |
| Funktionsrahmen | 7.2 | 7.0 |
| 周期 | 20 ms（Master） | — |
| 出力 | **トルク [Nm]** → モーメントマネージャ → `WDK_SOLL`（スロットル）と点火 | アイドル調整弁（ICV）のデューティ |
| 0401 での実態 | **本命の閉ループ制御器。生きている** | **PI・ダッシュポット・A/C 外乱 FF・需要適応はすべて削除済み** |

LLR 側は `llr_qsoll_calc`（`decomp/master/0258da.txt`）が実質

```
LLR_QSOLL = clamp(K_LLR_Q_MCS + LLR_QVS, >= K_LLR_QSOLL_MIN)
```

だけで、`K_LLR_Q_MCS`（`0xA048`）= 0、`K_LLR_QSOLL_MIN`（`0xA0AE`）= 0。
つまり **アイドル調整弁は `KF_LLR_QVS_GRUND(N, TMOT)` からの純フィードフォワード**。

> 注意：Funktionsrahmen 7.0 に出てくる `KL_LLR_NSOLL_GRUND` / `K_LLR_CONTROL` /
> `KF_LLR_DQI` / `K_LLR_TAU_IA1` などは **0401 のバイナリに存在しない**（文書のみの名前）。
> 0401 が実装しているのは 7.2 の `K_LFR_*` 系。探すなら `LFR` を見ること。

---

## 2. 「いまアイドルか」の判定

`ZUSTAND_MOTOR`（RAM `0xFFE8EC`）のビットフィールド:

| 値 | 状態 |
|---|---|
| 1 | Motor_steht（停止） |
| 2 | Start（始動） |
| **4** | **LL（Leerlauf / アイドル）** |
| 8 | TL（Teillast / 部分負荷） |
| 0x10 | VL（Vollast / 全負荷） |
| 0x20 | Kl.15 aus |
| 0x40 | Nachlauf（後行） |

EGAS 車での遷移（`decomp/master/02c1e2.txt` `zustand_motor_calc`）:

- **LL → TL**: `WDK_WORD >= KL_BZ_WDK_LL(N)`（全 rpm で 1.2 %）
  または `(MD_IND_WUNSCH_RED − MD_IND_WUNSCH_KORR) > K_BZ_MD_LL_EINGR`（25.0 Nm）
- **TL → LL**: `WDK_WORD < KL_BZ_WDK_LL(N) − K_BZ_WDK_LL_HYST`（1.2 − 0.2 = 1.0 %）

→ CSL では**実質「相対スロットル開度が 1.0 % 未満」がアイドル判定**。

もう一つのゲートが `S_KRAFTSCHLUSS`（`decomp/master/01d558.txt`）：
SMG（`cfg_m_getriebetyp == 0x40`）では `V <= K_LLR_V_MAX`（2 km/h）かつ SMG がクラッチ開放を
報告しているとき 0、それ以外 1（駆動系接続）。

---

## 3. 目標回転数 `n_soll` の形成

`decomp/master/026db8.txt`（`llr_n_soll_calc`、`lfr_calc` の先頭で呼ばれる）

```
if 非(LL|TL|VL) または LFR_FLAGS bit0:
    LFR_N_N_STAT = KL_LFR_NSOLL_START(TMOT)        [-30°C:1300, 30°C:1100, 85°C:950 rpm]
else:
    base = KL_LFR_NSOLL_GRUND(TMOT)                [-30°C:1050, 20°C:920, 50°C:870, 80°C:870 rpm]
         + 始動後オフセット KL_LFR_NSOLL_OFFSET(TMOT_START)
                                                    [-10°C:350, -8°C:250, 34°C:200, 50°C:0 rpm]
      （K_LFR_T_SEIT_START = 60 s を過ぎたら K_LFR_DELTA_N_ZYKLUS で 0 へランプ）
    ── 以下、MAX セレクトの連鎖 ──
    if SCHALTER_CAN & 4   (A/C 要求)     → K_LFR_NSOLL_AC          = 870 rpm
    if SK_TI_CONTR&1 等   (安全コンセプト) → K_LFR_NSOLL_SK          = 1250 rpm
    if edk_ds2_st & 1     (DS2 スロットル試験) → k_lfr_nsoll_ds2_min = 1500 rpm
    if TOG_FLAG&4 かつ !(TOG_ED&0x40) (油温上昇) → KL_LFR_N_TOG(TOEL)
                                     [115°C:0, 120°C:900, 125°C:980, 130°C:1050, 140°C:1150 rpm]
    ── Leerlaufmoment 下限 ──
    if NMAX_SEIT_START < K_LFR_LM_SCHWELLE(1200) かつ 目標 < 1300:
        LFR_N_N_STAT = K_LFR_NSOLL_LM_OFFSET + K_LFR_LM_SCHWELLE = 1300 rpm

LFR_N_N_SOLL = PT1(LFR_N_N_STAT, 前回値, KL_LFR_TAU_NSOLL(TMOT))   [0.233 / 0.284 / 0.394 s]
LLR_N_SOLL   = LFR_N_N_SOLL          ← ECU の他の場所はこれを見る（DS2 selection 3 offset 2）
戻り値 LFR_DN = LFR_N_N_SOLL − N     （正 = 回転が低い）
```

### 主要アドレス

| シンボル | アドレス | 値 |
|---|---|---|
| `K_LFR_NSOLL_SK` | `0x9A14` | 1250 rpm |
| **`K_LFR_NSOLL_AC`** | **`0x9A4A`** | **870 rpm** |
| `k_lfr_nsoll_ds2_min` | `0x9A4C` | 1500 rpm |
| `K_LFR_DN_EINGEREGELT` | `0x9A4F` | 200 rpm |
| `K_LFR_DELTA_N_ZYKLUS` | `0x9A50` | 0.977 **rpm/秒**（`X*50/256`、単位 U/s） |
| `K_LFR_T_SEIT_START` | `0x9A52` | 60 s |
| `KL_LFR_NSOLL_START` | X `0x9A56` / Y `0x9A5C` | 3 点 |
| **`KL_LFR_NSOLL_GRUND`** | X `0x9A64` / Y `0x9A6C` | 4 点 |
| `KL_LFR_NSOLL_OFFSET` | X `0x9A76` / Y `0x9A7E` | 4 点 |
| `KL_LFR_TAU_NSOLL` | X `0x9A88` / Y `0x9A90` | 4 点 |
| `K_LFR_LM_SCHWELLE` | `0x9D7C` | 1200 rpm |
| `K_LFR_NSOLL_LM_OFFSET` | `0x9D7E` | 100 rpm |
| `KL_LFR_N_TOG` | `0x9D82` | 油温による上げ |

---

## 4. 制御器（`lfr_calc`, `decomp/master/0266b8.txt`）

状態機械 `LFR_ZUSTAND`（FR 7.2 Bild 4 と一致）:
1 = `B_LFR_STOP` / 2 = `B_LFR`（アイドル制御）/ 4 = `B_AFR`（Anfahrregelung）/
8 = `B_IA1` / 0x10 = `B_IA2`

| 枝 | パラメータ | アドレス | 値 |
|---|---|---|---|
| **P 項** | `KL_LFR_DQP_POS` | X `0x9ABE` / Y `0x9ADE` | 0…9 Nm。**`dn > 0`（回転が低い側）でのみ評価** |
| **I 項** | `KF_LFR_DQI` | X `0x9B84` / Y `0x9BA2` / Z `0x9BB2` | 15 × 8、Z は `(X*50)/(10*16)` で **Nm/秒**（20 ms ステップ量は 1/50） |
| **点火（速い枝）** | `KL_LFR_TZ_POS` | X `0x9CA4` / Y `0x9CC4` | 0…15 Nm |
| | **`KL_LFR_TZ_NEG`** | `0x9CE6` 系 | **全ゼロ** |
| 積分時定数 | `K_LFR_TAU_IA1` / `_IA2_KKS` / `_IA2_KS` | `0x9A9E` / `0x9A9F` / `0x9A4E` | |
| トルク制限 | `K_LFR_MDREG_MIN` / `_MAX` | `0x9A9A` / `0x9A9C` | −60 / +60 Nm |
| | `K_LFR_MD_REG_MIN` / `_MAX` | `0x9D76` / `0x9D78` | −80 / +120 Nm |
| 制御ビット | `K_LFR_CONTROL` | `0x9ABA` | `0x1F` |
| ヒステリシス | `K_LFR_DN_HYS` | `0x9D38` | 100 rpm |

> **重要**：オーバーシュート側（回転が上がりすぎた側）には
> **比例項も点火項も存在しない**（P は正側のみ、`TZ_NEG` は全ゼロ）。
> 戻しは遅い I 積分だけ。→ `40-fr-adaptation-bug.md` §3 の A/C ハンチング要因 3。

### 適応（Bedarfsadaption, `decomp/master/025b52.txt` `lfra_adapt`）

許可条件: `LFRA_SPERREN == 0` かつ `LFR_ZUSTAND` bit1（`B_LFR`）かつ `TMOT > K_LFR_TMOT_ADAPT`（70 °C）。
積分器は 2 本あり、`KKOS_ST` bit0 で切り替わる:

- `LFRA_MD_INTEGRATOR`（コンプレッサ OFF）→ `MD_LLRA`
- `LFRA_KO_MD_INTEGRATOR`（コンプレッサ ON）→ `MD_LLRA_KO`

| シンボル | アドレス | 値 |
|---|---|---|
| `K_LFR_MDADAPT_OFFSET` | `0x9D3E` | 7 Nm |
| `K_LFR_TAU_ADAPT` | `0x9D40` | 15.06 s |
| `K_LFR_DMDADAPT_MAX` | `0x9D42` | **1.0 Nm**（1 フェーズの移動量上限） |
| `K_LFR_T_ADAPT` | `0x9D44` | 3.0 s（Sperrzeit） |
| `K_LFR_MDADAPT_MAX` / `_MIN` | `0x9D46` / `0x9D48` | +40 / −30 Nm |
| `K_LFR_MDADAPT_KO_MAX` / `_MIN` | `0x9D4A` / `0x9D4C` | +30 / −30 Nm |
| `K_LFR_TMOT_ADAPT` | `0x9D4E` | 70 °C |

適応した分は I 項から直接差し引かれる（`LFR_MDI += sVar2 * -0x10`）。

---

## 5. アイドル調整弁（LLS）

`llr_qvs_roh_calc`（`0257d2`）→ `llr_qsoll_calc`（`0258da`）→ `lls_tv_calc`（`025d0a`）

- `LLR_QVS_ROH` = 始動系なら `KL_LLR_QVS_START_TMOT(TMOT) + KL_LLR_QVS_START_N(N40)`、
  通常は **`KF_LLR_QVS_GRUND(N, TMOT)`**（暖機アイドル 600–900 rpm / 80 °C セルで 14.0 kg/h）
- `TV = KF_LLS_TV(N, qsoll)`（触媒暖機中は `KF_LLS_TV_KATH` と `AVAN1_SOLL_FAKTOR` で加重ブレンド）
- クランプ: `K_LLS_TV_MIN` 14 % / `K_LLS_TV_MAX` 97 %
- 故障時（`LLS_ST` bit6）: `K_LLS_TV_NOTLAUF_MIN` 3 % / `_MAX` 75 % / `K_LLS_TV_AQ_NOTLAUF` 35 %
- **`KL_LLS_UB_KORR` は全ゼロ** → このバイナリでは**アイドル弁の電圧補正が効いていない**

| シンボル | アドレス |
|---|---|
| `K_LLS_TV_MAX` / `_MIN` | `0x9DAC` / `0x9DAE` |
| `K_LLS_TV_DREHPUNKT` | `0x9DB6` |
| `K_LLS_NFILTER` | `0x9DB8` |
| `K_LLS_TAU1` / `TAU2` / `TAU_START` | `0x9DBA` / `0x9DBB` / `0x9DBC` |
| `KL_LLS_UB_KORR` | `0x9DC0` |
| `KF_LLS_TV` | X `0x9DE2` / Y `0x9DF6` / Z `0x9E10` |
| `KF_LLS_TV_KATH` | X `0x9F16` / Y `0x9F2A` / Z `0x9F44` |
| `KF_LLR_QVS_GRUND` | X `0xA04E` / Y `0xA05A` / Z `0xA064`（**8bit**） |

---

## 6. アイドル同期（LLSync, Slave）

`slave/02888c.txt` ほか。許可条件:

`ZUSTAND_MOTOR & LL`、`K_LL_TMOT_MIN`(70 °C) ≤ TMOT ≤ `K_LL_TMOT_MAX`(95 °C)、
`K_LL_TAN_MIN`(20 °C) ≤ TAN ≤ `K_LL_TAN_MAX`(60 °C)、`|N − LLR_N_SOLL| ≤ K_LL_DN_MAX`(50 rpm)、
`N ≤ K_LL_N_MAX`(1000 rpm)、`V ≤ K_LL_V_MAX`(5 km/h)。

ブロックマスク **`K_LL_AKTIV_CONTROL`（`0x1013`）= `0xBF`**
→ bit6「**A/C コンプレッサ作動中はブロック**」が**クリアされている**。
つまり **A/C 作動中も気筒別 `ti` 学習が走る**。

気筒別トリムは `KL_LL_TI_T(偏差)`（`0x1026`）から、`K_TI_LL_MIN/MAX`（`0x006A`/`0x006C`、±0.1 ms）で
クリップ、`K_LL_SYNC_SPERRZEIT`（`0x1022`）= 2 s ごとに再トリガ。

---

## 7. λ が閉ループにならない条件（本解析で特定）

λ 解除ロジックは Slave の `FUN_0001EBEA`（未デコンパイル関数。BIN から直接逆アセンブル）。
`LA_ST_AUS`（`0xFFD908`）、`LA_ST_EIN1/2`（`0xFF80C6/C7`）を作る。

**このツールの VE 補正は `la_f_regler`（λ 積分器）を読むので、
これらの条件下のサンプルは「凍結した値」であり意味を持たない。**

| # | 条件 | 詳細 |
|---|---|---|
| 1 | **アイドル固有：ICV 故障** | `0x1EC54`: `LLS_ST` bit7（アイドル調整弁故障ラッチ）かつ `ZUSTAND_MOTOR` bit2（LL）→ バンク 1 の λ 制御 OFF。`0x1ECD8` にバンク 2 の同型。FR 5.01「アイドル調整弁が故障している場合、アイドル運転状態では λ 制御器も遮断される」。→ **ICV 不良車は「アイドルでだけ開ループ、スロットルを開けた瞬間に閉ループ復帰」** |
| 2 | **水温** | `TSTART > K_LA_TMOT_SCHWELLE`(−2 °C) なら `TMOT > K_LA_TMOT_OBER_SCH` = **60 °C** が必要。実質すべての始動でこちら |
| 3 | **全負荷** | `LA_ST_AUS` bit5: VL かつ `N > K_LA_N_VL`(120 rpm) |
| 4 | **触媒保護増量中** | `TI_F_KATS1 > 0x400` → EIN 条件が成立しない（→ `20-egt-correction.md` §5） |
| 5 | 噴射時間が短すぎる | いずれかの気筒の `ti < K_LA_TI_MIN` = 1.05 ms。**大容量インジェクタでは暖機アイドルで踏みやすい** |
| 6 | RF が高い状態が続く | `KL_LA_N` = 全 rpm で 1.5 → **到達不能。較正で殺されている** |

**開ループ中の燃調**は `KF_TI_N_RF`（Slave `0x08BE`）。
その `rf = 0.10` 行（＝ S54 の暖機アイドル負荷点）だけが **1.1484 … 1.2969**（+15〜30 % 濃い）で、
`rf ≥ 0.15` の行はすべて厳密に 1.000。つまり**最低負荷行は意図的に濃い**。

閉ループ時は `KF_LA_TV`（意図的な λ シフト）が**全ゼロ**なので、
`K_LA_GRENZ_INI` / `K_LAS_R_FETT` / `K_LAS_R_MAGER`（455 / 510 / 400 mV）を中心に **λ 1.0 を狙う**。

> この「閉ループなら λ 1.0 を狙う」「RF による遮断は無効」の 2 点が、
> `20-egt-correction.md` §7.2 と `60-tuning-logic.md` §6 で、
> 測った `rf_korr` をどう使うかを決める根拠になっている。

---

## 8. SMG アンチストール

`slave/0396a0.txt` `smg_anti_stall_handler`：ストールフラグが立つと SMG のエンジン回転制御へ
`K_SMG_N_ZIEL_ABWUERG` = 1200 rpm を指令し、効率を `K_SMG_ETA_RES_SCHA` = 85.16 % にクランプ。
`K_SMG_MOT_N_REG_P_KH` = 0.08 Nm/rpm、`K_SMG_MOT_N_REG_I` = 0.003 Nm/rpm の**独立した第 2 の回転制御器**で、
クラッチ接続中は LFR と競合しうる。
