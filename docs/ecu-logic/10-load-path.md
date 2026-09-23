# 10 — 負荷と燃料の主鎖

用語は `00-glossary.md` を参照。アドレスはすべて **64 KB パーシャル BIN のオフセット**。

---

## 1. 全体像

```
  スロットル ──→ aq_rel  ──kl_aq_rel_rf_fakt(N)──→ aq_rel_rf
                                                      │
                        kf_rf_soll(N, aq_rel_rf) ──→ （暖機ブレンド・ASK・一次遅れ）
                                                      │             ↑ ★このツールが調整する VE テーブル
                                        × RF_PT_KORR（吸気温・大気圧）← §4.5。パッチでは切れない
                                                      ▼
                                                   rf_soll
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
`decomp/master/01a9d2.txt`（`rf_soll_calc`、セグメントタスク）、
`decomp/master/01a5d6.txt`（`rf_pt_korr_calc`）、
`decomp/master/021a70.txt`（`rf_korr`、背景タスク）。

> **この図の `× RF_PT_KORR` は 2026-08-21 に追加された。** それまでこのドキュメントは
> `kf_rf_soll` の出力がそのまま `rf_soll` になると書いており、そこから
> 「Alpha-N 経路には温度項も気圧項も無い」という結論が導かれ、アプリのコメント数箇所と
> 機能ひとつの前提になっていた。**誤りである。** §4.5 を参照。

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
- **このツールの PATCH ON は `0x02`** — bit4 を落として MAP 積分項だけを切る（`RF_PT_KORR` は残る。§4.5）
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

## 4.5 `RF_PT_KORR` — Alpha-N に掛かる吸気温・大気圧補正

`kf_rf_soll` の出力は、そのまま `rf_soll` になるのではない。`rf_soll_calc`
（`decomp/master/01a9d2.txt`）の最終行:

```c
/* Final pressure/temperature correction. After shaping the request, scale it so
   the target corresponds to current air density. This keeps the commanded fill
   consistent across ambient and thermal conditions. */
rf_soll_kath_temp = (rf_soll__t_1_ & 0xffff) * (uint)RF_PT_KORR;
rf_soll = (uint16_t)(rf_soll_kath_temp >> 0xc);
```

`RF_PT_KORR` は `rf_pt_korr_calc`（`decomp/master/01a5d6.txt`）が 2 本のカーブの積で作る。
どちらも**生バイト**（`TAN` = °C + 48、`P_UMG` = (mbar − 498.5) / 3）で引く。

```c
RF_PT_KORR = (KL_RF_TAN_KORR(TAN) * KL_RF_P_UMG_KORR(P_UMG)) >> 12;
```

| シンボル | X 軸 | Z 値 | 備考 |
|---|---|---|---|
| `KL_RF_TAN_KORR` | `0xD2AC`、8 点、16bit、`x-48`、°C | `0xD2BC`、`x/4096` | **20 °C でちょうど 4096** |
| `KL_RF_P_UMG_KORR` | `0xD2CE`、8 点、16bit、`x*3+498.5`、mbar | `0xD2DE`、`x/4096` | **960.5 mbar でちょうど 4096** |

**`k_rf_cfg` bit4（このツールの PATCH）はこれを切らない。** bit4 が消すのは `rf_calc` の
`RF += rf_p_saug_i >> 6` の 1 行だけで、`rf_soll_calc` は `k_rf_cfg` を一度も読まない。
測定中も走行中も常に効いている。

### 読みどころ

**基準は選ぶものではない。** 両カーブが 1.0000 を取る点 —— **20 °C / 960.5 mbar** ——
が「`kf_rf_soll` の数値が意味する空気」である。「テーブルは何気圧の値か」への答えはここにある。
`K_RF_LUFTDICHTE`（1.136 kg/m³）と `K_P_UMG_ERSATZ`（955.0 mbar）も同じ点を指す。

**気圧カーブは理想気体そのもの。** `P/960.5` との差は 888 mbar で 0.24 %、943 mbar で 0.08 %。
だから λ トリムから気圧が約分で消える:

```
トリム ∝ (P × VE / T) ÷ (kf_rf_soll × P/960.5) = 960.5 × VE / (T × kf_rf_soll)
```

標高 600 m で測っても 1100 m で測っても同じ表が出る。**アプリ側で気圧補正を足すと、
この打ち消しを壊す。**

**温度カーブは理想気体ではない。** 実効指数は約 0.2（1/T なら 1.0）。60 °C で理想気体は
0.880、このカーブは 0.9795。理由は 2 つ:

1. `TAN` は熱を持つインマニ内にあり、実際の空気より高く読む
   （DME 自身が外気温を得るのに `TAN` の走行中最小値を追う。`K_TAN_ERSATZ` = 60 °C）。
2. **温度に対する充填量の感度は負荷で変わる**のに、1 次元カーブは平均しか表現できない。
   負荷依存版は `tan_m` にある —— §5 を参照。

| 吸気温 | 理想気体 `293.15/T` | `KL_RF_TAN_KORR` |
|---|---|---|
| 20 °C | 1.000 | 1.0000 |
| 40 °C | 0.936 | 0.9873 |
| 60 °C | 0.880 | 0.9795 |
| 80 °C | 0.830 | 0.9651 |
| 100 °C | 0.786 | 0.9507 |

### 吸気温センサーの健全性チェック（1 分、走行不要）

上の議論はすべて `TAN` が正しいことに依っている。**確かめる方法は 1 つで、冷間でしか成立しない。**

一晩置いて冷え切った車で、イグニッション ON（エンジンは掛けない）。この状態で **4 つの値が
一致するはず**である。

| 値 | 出どころ | 冷間で一致する理由 |
|---|---|---|
| `TAN` | 吸気温センサー（NTC、純正 13621739510） | 熱源が無いので外気温そのもの |
| `TMOT` | 水温センサー | 同上 |
| `T_UMG` | CAN 0x62F（外気温センサー） | 同上 |
| `tan_m` | 充填温度モデル | **エンジン停止中は素通し** — `tan_m_adj_calc` の先頭で `tan_m_adj = tan_local` |

**`T_UMG` には落とし穴がある。** `can_rx_62f` は CAN が来ないと `T_UMG_ERSATZ` に落ち、
`tan_calc` はそれを **`TAN` の走行中最小値**として維持している。つまり CAN が無い車では
`T_UMG` は `TAN` から作られた値であり、**照合しても必ず一致する（＝何も証明しない）**。
アプリは `T_UMG_ST` bit 7 を一緒に読み、`Outside Air Temp Substituted` 列が出た走行では
この照合を信じないようにしている。

ずれていた場合に疑う順:
1. **センサー品番**。DME が想定する NTC 特性は `KL_TAN_NTC`（X `0xC4D4` / Z `0xC4E4`）で、
   `R(20 °C)/R(80 °C) ≈ 10.0` に相当する。プルアップ 400 Ω を仮定すると 20 °C で約 2,502 Ω。
   これは純正品の公称（約 2.5 kΩ @20 °C）と一致する。
2. **配線・接触抵抗**。直列抵抗が増えると低温側に張り付く。
3. **`KL_TAN_NTC` 自体が書き換えられている**（このアプリは書かない）。

`RF_PT_KORR` は `rf_soll` 以外にも掛かる: `rf_sk_wdk_calc`（`RF_SK_WDK1/2`）、
`MD_Maximum_Moment`（トルクモデル）、`ti_ptkorr_factor`（スレーブ、`KL_TI_PT_KORR`）。
`aq_rel_calc` の `_aq_rel_rf_pt_fakt` は **DS2 報告専用**で、テーブル参照には使われない
（＝軸は二重補正されない）。

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

### `tan_m` — モデル化された実充填温度

`m_calc` が理想気体式で割る温度は、吸気温センサーの値**ではない**。
`k_tanm_cfg`（`0xA9A3`）= 1 なので `tan_m = tan_m_adj + 2732`（0.1 K 絶対）で、
`tan_m_adj_calc`（`decomp/master/0212be.txt`、100 ms タスク）がこう作る:

```
tan_m_adj = TMOT_filt − f × (TMOT_filt − TAN)        時定数 τ ≈ 11 s
f = |gain| × ML[kg/h] / 10000  （≤ 1 にクランプ）
    gain = −35（走行・オーバーラン）→ f = 1 は 285.7 kg/h
    gain = −70（アイドル）        → f = 1 は 142.9 kg/h
```

| 定数 | アドレス | 値 |
|---|---|---|
| `k_tanm_cfg` | `0xA9A3` | 1（= モデル経路） |
| `k_tanm_delta_weight` / `_ll` | `0xA97A` / `0xA97C` | 11000 → τ ≈ 11 s |
| `k_tanm_load_gain` | `0xA97E` | −35 |
| `k_tanm_load_gain_ll` | `0xA9A4` | −70 |
| `k_tanm_load_gain_sa` | `0xA9A6` | −35 |
| `k_tanm_rg_gain` | `0xA9A8` | **0（残留ガス項は無効）** |
| `KL_TANM_PT1_INIT` | `0xA982` | 全点 10000 → 素通し |

**物理の言い換え**: 熱いポートを通る空気は壁から熱をもらう。流量が少ないほど滞在時間が長く、
たくさんもらう。だから低流量では充填温度は水温に近く、高流量ではセンサー値に近い。

**エンジン停止中はモデルが働かない。** `tan_m_adj_calc` の先頭:

```c
if (((ZUSTAND_MOTOR & (VL|TL|LL)) == 0) && ((ZUSTAND_MOTOR & Start) == 0)) {
    tan_m_adj = tan_local;   /* = TAN。素通し */
    return;
}
```

だから **イグニッション ON・エンジン停止では `tan_m` = `TAN` になる**。§4.5 の冷間チェックの
4 番目の照合点はこれである。

これが §4.5 の温度カーブが平坦な理由であり、`RAM 0xFFED46` から読める。
アプリの `chargeTempFactor`（`src/lib/ve-calculator/chargeTemp.ts`）はこれを使って
測定を基準の空気に言い換える —— 調整定数はひとつも要らない。

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
| `k_rf_cfg` | PATCH トグルの `MAP ON/OFF`（bit4 のみ。`RF_PT_KORR` は切れない） |
| `K_LAA_TMOT_MIN` | PATCH トグルの `LTFT MIN` |
| `TAN`（`tan_filter` `0xFFED44`） | ログ列 `Intake Air Temp`（RAM 16 バイト読み、0.25 °C） |
| `tan_m` `0xFFED46` | ログ列 `Charge Temp Modelled`（0.1 K 絶対 → °C） |
| `P_UMG_FILTER` `0xFFED3E` | ログ列 `Ambient Pressure`（1/32 mbar） |
| `P_UMG_HOEHE` `0xFFED42` | ログ列 `Altitude`（既定では非表示） |
| `P_UMG_ED` bit 0x40 | ログ列 `Ambient Pressure Substituted`（立った走行だけ列が出る） |
| `KL_RF_TAN_KORR` / `KL_RF_P_UMG_KORR` | `chargeTemp.ts` の `readRfPtKorrCurves()`、FILTER の「表の基準の空気に揃える」 |
| `T_UMG` `0xFF808E` | ログ列 `Outside Air Temp`（CAN 0x62F、`°C + 48`） |
| `T_UMG_ST` bit 7 | ログ列 `Outside Air Temp Substituted`（立った走行だけ列が出る） |
| `V` `0xFF8090` | ログ列 `Road Speed`（km/h）。**まだゲートには使っていない** |
| `k_rf_korr_v_min` | `EgtTables.vMin` — 復号済み・未使用。`V` が読めるようになったので塞げる |
