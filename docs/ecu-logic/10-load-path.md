# 10 — 負荷と燃料の主鎖

用語は `00-glossary.md` を参照。アドレスはすべて **64 KB パーシャル BIN のオフセット**。

---

## 1. 全体像

```
  スロットル ──→ aq_rel  ──kl_aq_rel_rf_fakt(N)──→ aq_rel_rf
                                                      │
                        kf_rf_soll(N, aq_rel_rf) ──→ rf_soll        ← ★このツールが調整する VE テーブル
                                                      │
                                          × rf_korr（排気温度補正）  ← 20-egt-correction.md
                                                      │
                        （k_rf_cfg bit4）+ rf_p_saug_i（MAP 積分）
                                                      ▼
                                                     RF
                                                      │
                              ML = N × (RF × m_norm / 1000) / 25000
                                                      │
                                    TL = RF_TI_CONST × RF / 2000
                                                      ▼
                                              噴射時間 TI
```

出典：`decomp/master/0218d0.txt`（`rf_calc`、セグメントタスク）、
`decomp/master/021a70.txt`（`rf_korr`、背景タスク）。

---

## 2. `rf_calc` の分岐（実コード）

```c
rf_p_saug = (ushort)(((uint)m_norm_fakt * (int)m) / 65535);
if ((ZUSTAND_MOTOR & Start) == 0) {
    RF = rf_p_saug;
    if (rf_diag_ed_st == 0) {
        if ((k_rf_cfg & 1) == 0) {
            if ((k_rf_cfg & 4) == 0) {
                /* Alpha-N の出力に TABG 補正を掛ける */
                rf_soll_korr = (uint)rf_soll * (uint)rf_korr;
                RF = (ushort)((int)rf_soll_korr >> 10);
                if ((k_rf_cfg & 0x10) != 0) {
                    /* MAP 積分項を加算 */
                    RF = (short)(rf_p_saug_i_temp >> 6) + RF;
                    if ((short)RF < 0) RF = 0;
                }
            } else {
                RF = rf_hfm1;      /* HFM 構成。ハード改造前提、使用しないこと */
            }
        }
    } else if (rf_diag_ed_st == 1) {
        /* MAP 診断エラー時のフォールバック。Alpha-N + TABG 補正のみ */
        RF = (ushort)(((uint)rf_soll * (uint)rf_korr) >> 10);
    }
    ML = (word)(((uint)N * ((int)((uint)RF * (uint)m_norm) / 1000)) / 25000);
} else {
    RF = k_rf_start;   /* 始動中は固定値 */
    ML = k_ml_start;
}
```

**読みどころ**

- **`rf_korr` は 3 つの経路すべてに掛かる。** MAP 補正を切っても、MAP 診断がエラーでも掛かる。
  → このツールの「PATCH ON」状態でも EGT 補正は生きている。
- `>> 10` なので `rf_korr` は 1024 = 1.000 の 10 bit 固定小数。
- 始動中（`ZUSTAND_MOTOR & Start`）は Alpha-N を一切見ない。

---

## 3. `k_rf_cfg`（RF 算出方式コンフィグ）

**アドレス `0xE5E4`（Master, 8bit）。純正 `0x12`。**

| ビット | 意味 |
|---|---|
| `0x00` | `rf_soll`（TABG 補正込み）のみ |
| `0x01` | `rf_p_saug`（MAP 直接） |
| `0x04` | `rf_hfm1`（HFM。ハード改造が必要で 0401 では非推奨） |
| `0x10` | `rf_soll`（TABG 補正込み）+ `rf_p_saug_i`（MAP 積分） |

- 純正 `0x12` = `0x10 | 0x02`
- **このツールの PATCH ON は `0x02`** — bit4 を落として MAP 積分項を切り、純 Alpha-N にする
  （`patcher.disableMapCorrection()`）。VE チューニング時に MAP が VE の誤差を隠すのを防ぐため。

---

## 4. Alpha-N テーブル（`kf_rf_soll`）

| 項目 | 値 |
|---|---|
| X 軸 | `0xD2FE`、20 点、16bit、`x`、rpm |
| Y 軸 | `0xD326`、24 点、16bit、`x*100/32768`、% （= `aq_rel_rf`） |
| **Z データ** | **`0xD356`**、24 行 × 20 列、16bit、**`x/1000`**、無次元 |

`src/config/constants.ts` の `VE_TABLE.ADDRESS_DATA = 0xD356 / SIZE_X 20 / SIZE_Y 24` と、
`parser.getVETable()` の `raw / 1000` はこれと一致する。

関連する CSL 固有テーブル:

| シンボル | アドレス | 内容 |
|---|---|---|
| `kf_rf_soll_kath` | `0xD718` | 冷間時 Alpha-N（CSL Alpha-N Cold） |
| `kf_rf_soll_ask` | `0xDB32` | CSL スノーケルフラップ開時の加算分 |
| `kl_aq_rel_rf_fakt` | X `0xE058` | `AQ_REL` → `aq_rel_rf` の補正係数（**除数**として使われるので 1.0 未満で `aq_rel_rf` が大きくなる） |
| `kf_rf_soll_tau_up` | `0xDF4C` | `rf_soll` 上昇時の一次遅れ |
| `k_rf_soll_tau_down` | `0xDFAC` | `rf_soll` 下降時の一次遅れ |
| `k_rf_start` / `k_ml_start` | `0xE5E8` / `0xE5EA` | 始動中の固定値（0.3 / 30.0 kg/h） |

---

## 5. MAP 経路（`rf_p_saug` 系、CSL 固有）

| シンボル | アドレス | 意味 |
|---|---|---|
| `k_p_saug_steigung` | `0xD2EE` | MAP 変換の傾き（CSL MAP Scaler） |
| `k_p_saug_offset` | `0xD2F0` | MAP 変換のオフセット（CSL MAP Offset） |
| `k_p_saug_diag_min` / `_max` | `0xD2F2` / `0xD2F4` | MAP 妥当性の下限 / 上限 |
| `kf_rf_p_saug_i_gain` | `0xE63A` | `rf_p_saug_i` 積分ゲイン（N × p_saug） |
| `k_rf_p_saug_i_min` / `_max` | `0xE5EE` / `0xE5F0` | 積分のワインドアップ制限（**符号付**） |
| `k_rf_p_saug_i_tmot_min` | `0xE5EC` | 積分を許可する最低水温 |
| `k_rf_p_saug_i_ll_wait` | `0xE5ED` | `N_START_EXIT` 到達後、積分開始までの待ち時間 |
| `k_rf_p_saug_i_begr` | `0xE5F2` | WDK エラー時に積分をゼロへ落とす速度（10 ms あたり） |

**`rf_p_saug` は RAM `0xFFEECA`。** Community Patch v1 はここを DS2 フレームに正しく載せる修正を
入れている（→ `50-binary-lineage.md`）。

### RF 診断

| シンボル | アドレス | 意味 |
|---|---|---|
| `kl_rf_diag_f_max` / `_min` | `0xE606` / `0xE620` | `rf_diag_f = rf_soll − rf_p_saug` の許容帯（X 軸 = `p_kvd` mbar、**Y 軸は RF**。`_min` は符号付） |
| `K_RF_DIAG_SCHWELLE` | `0xE5F8` | 診断カウンタのラッチしきい値 |
| `k_rf_diag_d_pwg_max` | `0xE5FC` | ペダル変化率によるゲート |
| `k_rf_diag_tau` | `0xE5FE` | 再開遅延 |

`rf_diag_ed_st == 1` になると `rf_calc` は Alpha-N + TABG 補正だけにフォールバックする（§2）。

---

## 6. 空気質量と負荷信号

```
  ML = N × (RF × m_norm / 1000) / 25000        [kg/h]
  TL = RF_TI_CONST × RF / 2000
  RF5 = RF / 5                                 （RF < 0x4FB のとき。それ以外 0xFF）
  DAM = N × (ML − 前回 ML) / max(ML, K_HFM_ML_SEG_MIN)     （気筒あたり空気量変化）
```

`m_norm` / `m_norm_fakt` は `rf_init`（`decomp/master/02181c.txt`）で
`K_RF_HUBVOLUMEN`（`0xD21C` = 3.201 dm³）と `K_RF_LUFTDICHTE`（`0xD21E` = 1.136 kg/m³）から作られる。

---

## 7. このツールとの対応

| DME 側 | このツール |
|---|---|
| `aq_rel` | ログ列 `Raw RO %`（DS2 selection 3 payload 20） |
| `aq_rel_rf` | ログ列 `Corr. RO %`（`kl_aq_rel_rf_fakt` 相当を `InterpolationTable` で再現） |
| `kf_rf_soll` Z | CURRENT MAP / TUNED MAP のセル値 |
| `RF` | ログ列 `RF`（DS2 selection 3 payload 8） |
| `rf_korr` | ログ列 `RF KORR`（`RF / rf_soll` として実測） |
| `la_f_regler1/2` | ログ列 `Lambda 1/2`（内部名 `stft1/2`。DS2 selection 19 payload 40/42） |
| `k_rf_cfg` | PATCH トグルの `MAP ON/OFF` |
| `K_LAA_TMOT_MIN` | PATCH トグルの `LTFT MIN` |
