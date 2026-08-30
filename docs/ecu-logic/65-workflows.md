# 65 — ワークフロー一覧：何を測り、何を導き、どのバイトを書くか

**このアプリには 7 本のワークフローがある。** タブは 12 あるので 1 対 1 ではなく、それが
「今どれを走らせているのか」が読みにくい第一の原因になっている。

この文書は各ワークフローについて **測定 → 証拠 → 導出 → 書き込み先** を 1 行で確定させる。
`docs/ecu-logic/60-tuning-logic.md` が「DME がこう動くからこう組んだ」を書くのに対し、
ここは「**組んだ結果、いま何本あって、どれがどのバイトを握っているか**」を書く。

すべて実コードから起こしている。出典はファイル名と行番号で示す。

---

## 早見表

| # | ワークフロー | profile | 交換数 | 前提パッチ | 書き込み先テーブル | 書き込み器 | タブ数 |
|---|---|---|---|---|---|---|---|
| 1 | **VE** | `VE` | 7 | `PATCH` | `kf_rf_soll` 24×20 | `setVETable` | **5** |
| 2 | **RF KORR** | `EGT` | 1 | `PATCH` `TANK_VENT` | `KF_RF_KORR_DRREL` 6×12 | `setEcuMapValues` | 1 |
| 3 | **LOW LOAD** | （VE のログを読む） | — | — | **`kf_rf_soll` 24×20** | `setVETableData` | 1 |
| 4 | **WARMUP** | （VE の結果から導出） | — | — | 暖機表 | `setWarmupTable` | 1 |
| 5 | **INERTIA** | `INERTIA` | 2 | なし | **書かない**（提案のみ） | — | 1 |
| 6 | **IDLE** | `IDLE` | 15 | なし | **封印** | — | 1 |
| 7 | **CALIBRATION** | — | — | — | 読むだけ | — | 1 |

**1・3・4 は同じ表か、その派生を触る。** かつてはここが二重 writer の事故現場だった
（「既知の欠陥」1 番 — 修正済み。現在は `composeVeGrid` が唯一の合流点）。

---

## 1. VE — 充填テーブル本体

| | |
|---|---|
| **測定** | `LOG_PROFILES.VE`（7 交換）。block 3・block 19 の遅レーン・λ トリムの RAM 読み・外気の遅レーン |
| **証拠** | `la_f_regler`（DME 自身の λ 積分器）。**トリムの無いサンプルは証拠にならない**（`calculator.ts:292` — `if (!banks.length) return;`） |
| **導出** | `newMap`（`kf_rf_soll` 24×20）と、その途中経過 `correctionMap` / `hitMap` / `weightMap` / `acceptedMap` |
| **書き込み** | `composeVeGrid` 経由で `kf_rf_soll` へ（トグル `writeVe`、既定 OFF） |
| **タブ** | CURRENT MAP / LAMBDA FEEDBACK / TUNED MAP / DIFFERENCE % / CORRECTED LOG |

**5 タブは 5 つのワークフローではなく、1 つの結果に対する 5 つの見方。**
CURRENT MAP は入力、LAMBDA FEEDBACK は中間、TUNED MAP は出力、DIFFERENCE % はその差、
CORRECTED LOG は使われたサンプル。

## 2. RF KORR — 排気密度補正

| | |
|---|---|
| **測定** | `LOG_PROFILES.EGT`（1 交換）。**profile 名が `EGT`、タブ名が `RF KORR`** で一致していない |
| **証拠** | 同一セル内の冷排気／温排気の `rf` 比 |
| **導出** | `tunedRfKorr` 6×12 |
| **書き込み** | `setEcuMapValues(KF_RF_KORR_DRREL, …, {min: 1.0, max: 1.40})`。下限 1.0 は**薄くする方向を禁じる**ため |
| **前提** | `PATCH` と `TANK_VENT` の両方。7 本のうちここだけ 2 つ要る |

**注意（コードから）**: `rf_korr` は `k_rf_korr_v_min`（純正 20 km/h）を超えていないと
DME 側で 1.000 に固定される。停車中に測っても補正は動いていない。

## 3. LOW LOAD — 低開度行

| | |
|---|---|
| **測定** | **自前の profile を持たない。** VE のログを読み直す |
| **証拠** | 低開度セルの λ トリム（`stft × ltft`）× `rf_korr`。**VE 本体と同じ式**で、`KF_TI_N_RF` は掛けも割りもしない —— #920 で y = 0.15 の段差を跨いでもトリムは +0.1 % しか動かず、掛けると逆に −9.6 % ずれる（`verify:ti-factor`） |
| **導出** | `lowLoadResult.tuned` — **BASE のグリッドを丸ごとコピーし、低開度行だけ書き換えた 24×20**（`lowLoadTuner.ts:193,233,278`） |
| **書き込み** | `composeVeGrid` 経由で **VE と同じ `kf_rf_soll`** へ（トグル `writeLowLoad`、owned セルのみ） |
| **ゲート** | `maxOpeningRow: 12`（= 3.198 %）、`minCellSamples: 30` / `minVisits: 2` / `maxSampleSd: 0.08` / `maxStdErr: 0.005` / `noChangeBand: 0.01`。`requireTiBranchProven` は**既定 OFF**（`lowLoadTuner.ts:185`）—— `TI_F_STAT` が補正式に入らない以上、分岐が決まってもバイトは変わらない |

**VE と同じ表に寄与する 2 本目の証拠源** — writer は `composeVeGrid` の 1 つで、
所有権はセル単位（`LowLoadResult.owned`）。欠陥 1 の修正記録を参照。

## 4. WARMUP — 暖機表

| | |
|---|---|
| **測定** | **しない。** `generateWarmupMap(newMap)` で **VE の結果から導出**（`useVeCalculation.ts:164`） |
| **書き込み** | `setWarmupTable`。トグル `writeWarmup` |

**VE の派生物であって独立したワークフローではない。** VE を録り直せば必ず変わる。

## 5. INERTIA — フライホイール

| | |
|---|---|
| **測定** | `LOG_PROFILES.INERTIA`（2 交換）。block 3 と RAM 1 回。**両方必須** — 速度のないトルクも、トルクのない速度も点の半分にしかならない |
| **証拠** | `md_ind_ne` と `dω/dt` の回帰 |
| **導出** | `K_MD_J_MOTOR` ほかへの提案 |
| **書き込み** | **しない。** 提案を表示するだけで、適用は手動 |

## 6. IDLE — アイドル

| | |
|---|---|
| **測定** | `LOG_PROFILES.IDLE`（15 交換、2.68 Hz）。1 サンプル 54 チャンネル |
| **証拠** | `md_llri` / `md_llra`（調速器の I 項と学習値）、および 7.1 節の前提条件一式 |
| **導出** | `tunedIdleQvs`（`KF_LLR_QVS_GRUND` 向け） |
| **書き込み** | **封印**（`IDLE_WRITE_SEALED = true`）。書き込み先に読み手がいないため |

**封印の理由**（`src/lib/idle/seal.ts`）: `cfg_m.egas` = 0 のため `lls_tv_calc` はトルク経路から
呼ばれ、`LLR_QSOLL` は 1 MB 中に絶対参照が 1 箇所（自分への書き込み）しかない。

**そして本当のレバーは別にある。** 逆アセンブルの追跡結果:

```
ML_SOLL_LLS → KF_LLS_TV(N,·) → LLS_TV_AQ → KL_AQ_ABS_LLS → AQ_ABS_LLS
AQ_ABS       = AQ_ABS_LLS + KL_AQ_ABS_WDK(WDK_SEGM)
aq_rel_rf    = (AQ_REL << 15) / kl_aq_rel_rf_fakt(N)
RF_SOLL      = kf_rf_soll(N, aq_rel_rf) × RF_PT_KORR
```

アイドル弁の開口断面積はスロットルのそれと**足し算されて同じ軸に乗る**。実車ログでは
`ml_soll == ml_soll_lls` が 271/271 サンプル、`wdk_soll` = 0 が 280/280 なので、
**アイドル中の `aq_rel_rf` はアイドル弁の断面積そのもの**。

つまり **IDLE の実効的な書き込み先も `kf_rf_soll` の最低開度行**であり、
VE・LOW LOAD と合わせて **同じ表に向かう 3 本目**になる。

## 7. CALIBRATION — 読むだけ

`EcuItemList` を BIN に対して開く。導出も書き込みもしない。
他の 6 本が使う閾値を、そのバイトと突き合わせて確認するための窓。

---

## 表の所有権 —— いま誰が `kf_rf_soll` を握っているか

```
VE        accepted セル             composeVeGrid の種          （writeVe トグル）
LOW LOAD  owned セル（低開度行）    composeVeGrid が上書き      （writeLowLoad トグル）
IDLE      最低開度行（封印中）      将来ここに合流する          —
```

**writer は `setVETableData(composed.grid)` の 1 呼び出しだけ。** 調停は呼ぶ順番ではなく
`composeVeGrid` のセル単位の所有権になった（2026-08-23、欠陥 1 の修正）。

---

## 既知の欠陥

### 1. LOW LOAD を武装すると VE の補正が消える — 修正済み ✅

**修正 (2026-08-23)**: `kf_rf_soll` の writer は 1 つになった。すべての寄与は
`src/lib/ve-calculator/composeVeGrid.ts` を通り、所有権はセル単位で決まる:

- **LOW LOAD は自分が測定/修復したセル（`LowLoadResult.owned`）で勝つ** —
  勝つ理由は式ではなく担当行である。式は VE と同一（トリム × `rf_korr`）で、VE 側は
  `veOwnsRow = r > LOW_LOAD_TOP_ROW`（`calculator.ts:616`）により行 12 以下を `out-of-band` で落とす
- VE は accepted セルで勝つ
- どちらも触っていないセルは BASE のまま。**両方 OFF ならテーブルに 1 バイトも触れない**

合成は BASE も acceptedMap も見ない。両入力が未接触セルに BASE をそのまま運ぶ、という
2 つの不変量に乗っている（composeVeGrid の doc 参照）。`verify:compose` がその不変量を
**実物の tuner に対して**毎回検査する。

元の欠陥の記録: `setVETable`（VE、480 セル）の後に `setVETableData`（LOW LOAD、BASE 種の
480 セル）が走り、低開度行より上の VE 補正が全部 BASE に戻っていた。コメントは逆順を主張していた。

### 2. profile 名とタブ名が一致していない

`LOG_PROFILES.EGT` ↔ 「RF KORR」タブ。`ProcessId` はセッションに保存され D1 にも入るので、
**id の改名は移行を伴う**。表示ラベルだけ合わせるのが安全。

### 3. タブがワークフロー単位になっていない

12 タブ / 7 ワークフロー。VE が 5 タブを占める。

### 4. 前提パッチの要求が不揃い

`VE` = `PATCH` / `EGT` = `PATCH` + `TANK_VENT` / `INERTIA` = なし / `IDLE` = なし。
同じ ECU に対して run ごとに前提が違う理由が画面から読めない。

### 5. セッションが run 1 本を前提にしている

`SessionLogRecord.data[]` が 1 本、`TuningSession.process` が 1 つ。
同じセッションで 2 種類の run を録ると `data[]` は後勝ちになる
（生の `inertia[]` / `idle[]` は残る）。

### 6. WARMUP と LOW LOAD は独立したワークフローではない

WARMUP は VE の結果の派生、LOW LOAD は VE のログの読み直し。
タブ列では INERTIA や IDLE と同格に並んでいる。

---

## WRITE / RESTORE マニフェスト — 書き込み調停の単一点（2026-08-23）

「次の書き込みに何が入るか」への答えは 1 箇所になった: ハブ下の **WRITE / RESTORE マニフェスト**
（`src/components/WriteManifest.tsx`）。

```
WRITE      次の書き込み・ダウンロードに載るもの
  VE / WARMUP / RF KORR / LOW LOAD   … トグル + セル数 or ロック理由
  IDLE                                … 封印表示（seal.ts の理由をツールチップに）
  INERTIA                             … 提案のみ（書き込み対象ではない）
RESTORE    参照値へ戻すもの
  WOT FUEL                            … drift 検出付き
```

- **VE の書き込みもトグル**（既定 OFF、毎ロード解除）。「導出されたら無条件に書く」は廃止
- LOW LOAD の ARM ボタンは撤去。書き込みの入口はマニフェストだけ
- `Tune_` / `Base_` はマニフェストに従う: トグル OFF の VE マップはファイル名を作らず、
  LOW LOAD / RF KORR 単独は `Tune_` を名乗る
- **RESTORE セクションは行の追加だけで育つ**。将来: VE / IDLE / INERTIA のリストア、
  最終的に全パラメータリストアのメニュー（予定）

## 機能ステージ — 本番で実験を閉じる（2026-08-23）

`src/lib/features.ts`。同一ビルド・同一コードのまま、本番変種（GitHub Pages / meta 無し）では
未昇格タブとそのマニフェスト行が出ない。preview と dev では全部見える。タブの並びはどの変種でも不変。

| feature | stage | 昇格予定 |
|---|---|---|
| ve（WARMUP 含む） | stable | — |
| rfKorr | experimental | **1 番手** |
| lowLoad / idle | experimental | 2 番手（同じ kf_rf_soll 行の 2 証拠源なので同時） |
| inertia | experimental | 3 番手 |
| calibration | experimental | 適宜 |
| sessionSync | **preview-only** | **昇格しない**（本番はローカル完結。verify:features が固定） |

昇格 = features.ts の 1 語変更。`verify:features` が本番タブ集合をリテラルで持つので、
昇格は必ずテストの diff に現れる。main への統合は別途の意図的な手順
（features.ts ヘッダに記載: c3db356 cherry-pick → merge → 本番ビルドをローカル検証 → push）。

## 用語

| 語 | 意味 |
|---|---|
| **profile** | 1 サンプルで DME と交わす交換の並び。`LOG_PROFILES` に定義 |
| **交換 (exchange)** | 1 往復。DS2 ブロック読み、または control-0x06 の RAM 読み |
| **レーン** | 交換の頻度。毎サンプル / 遅レーン (`every: 4`) / survey レーン (`every: 8`) |
| **武装 (arm)** | 導出した表を「次の書き込みに載せる」と宣言すること。載せた時点ではまだバイトは動かない |
| **封印 (seal)** | 導出はするが、バイト境界で書き込みを止めてあること |
