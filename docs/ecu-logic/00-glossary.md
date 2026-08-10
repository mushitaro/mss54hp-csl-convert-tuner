# 00 — 用語集とアドレス体系

MSS54HP CSL `0401` の**ECU 側ロジック**を読むための最低限。
（`docs/implementation-notes.md` が「このツールの実装」の記録なのに対し、
`docs/ecu-logic/` は「DME が何をしているか」の記録）

このディレクトリの構成:

| ファイル | 内容 |
|---|---|
| `00-glossary.md` | ここ。命名規約・信号・制御モジュール・アドレス体系 |
| `10-load-path.md` | 負荷と燃料の主鎖 `aq_rel → rf_soll → rf_korr → RF → ML → TI` |
| `20-egt-correction.md` | 排気温度による燃料補正（`rf_korr`）と触媒保護 |
| `30-idle-control.md` | アイドル制御（LFR / LLR / LLS / LLSync）と λ 開ループ条件 |
| `40-fr-adaptation-bug.md` | `K_FR_T_ADAPT` / `FRA_TIMER` バグと A/C アイドルハンチング |
| `50-binary-lineage.md` | 素の CSL / Terra / Community Patch v1 の実測バイト差分 |
| **`60-tuning-logic.md`** | **このアプリのチューニングロジックとデータログ。「DME がこうだから、こう組んだ」** |
| `90-sources.md` | 出典対応表 |

00〜50 は **DME が何をしているか**、60 は **それを受けてアプリが何をするか**。
チューニング手順そのものを追いたいなら `60` から読み、必要に応じて 10/20/30 を参照するのが早い。

---

## 1. 命名規約

| 接頭辞 | 意味 | 例 |
|---|---|---|
| `K_…` | **定数**（スカラー 1 個） | `K_TABG_TAU` |
| `KL_…` | **Kennlinie = 特性曲線**（1 入力 → 1 出力。X 軸列 + Y 値列） | `KL_TABG_PT200` |
| `KF_…` | **Kennfeld = 特性マップ**（2 入力 → 1 出力。X 軸 + Y 軸 + Z 格子） | `KF_RF_KORR_DRREL` |
| 小文字 `k_…` `kf_…` | 逆アセンブルで**新たに命名された CSL 固有項目**（純正 A2L に無い） | `kf_rf_tabg_modell` |
| `…_ST` / `B_…` | ステータスバイト / 状態ビット（RAM） | `ZUSTAND_MOTOR` |

ドイツ語の頻出語:

| 語 | 意味 |
|---|---|
| Vorsteuerung | 先行制御（フィードフォワード） |
| Regler | 制御器 |
| Kennfeld / Kennlinie | マップ / 曲線 |
| Leerlauf | アイドル |
| Füllung | 充填 |
| Abgas | 排気 |
| Katschutz | 触媒保護 |
| Bauteilschutz | 部品保護 |
| Störgrößenaufschaltung | 外乱フィードフォワード |
| Einschaltverzögerung | 作動開始遅延 |
| Leckluft | 漏れ空気 |

---

## 2. 信号（燃料計算の主鎖）

| 記号 | 意味 | 単位・分解能 | 備考 |
|---|---|---|---|
| `N` | エンジン回転数 | rpm | |
| `aq_rel` | **相対開口面積**（Relativer Öffnungsquerschnitt） | % | このツールのログ列 `Raw RO %` |
| `aq_rel_rf` | `aq_rel` を `kl_aq_rel_rf_fakt(N)` で補正した値 | % | **Alpha-N テーブルの Y 軸** |
| `rf_soll` | **目標相対充填**。`kf_rf_soll`（Alpha-N）の出力 | 無次元（1.0 = 100%） | このツールが調整している「VE テーブル」の値そのもの |
| `rf_p_saug` | MAP センサから求めた相対充填 | 無次元 | RAM `0xFFEECA` |
| `rf_p_saug_i` | `rf_p_saug` と `RF` の差の積分（MAP 補正） | | `k_rf_cfg` bit4 で有効 |
| **`rf_korr`** | **排気温度による充填補正倍率** | 1024 = 1.000 | RAM `0xFFEEA6`。→ `20-egt-correction.md` |
| `RF` | **最終的な相対充填** | 無次元 | `RF = (rf_soll × rf_korr) >> 10` （+ MAP 積分項） |
| `ML` | 空気質量流量 | kg/h | |
| `TL` | 負荷信号 | | |
| `TI` | **噴射時間** | ms | 最終出力 |
| `λ` | 空気過剰率。1.0 = 理論空燃比 | 無次元 | |
| `LA_F_REGLER1/2` | λ 制御器の**短期補正**（STFT 相当） | 1.0 が中立 | このツールのログ列 `Lambda 1/2`、内部名 `stft1/2` |
| `LAA` | λ **適応**（長期学習, LTFT 相当） | | `K_LAA_TMOT_MIN` で更新を止められる |
| **`TABG`** | **排気ガス温度** | °C（RAM は 1 °C/LSB, 符号付） | Pt200 センサ、100 ms 更新 |
| `rg_tabg_modell` | `kf_rf_tabg_modell(N, RF)` が返す**公称**排気温度 | °C | RAM `0xFFEBB2` |
| `tabg_delta` | `rg_tabg_modell − TABG`（負は 0 にクリップ） | °C | `KF_RF_KORR_DRREL` の Y 軸 |
| `TKATM` | 触媒温度モデル | °C | |
| `TRG` | 残留ガス温度 | °C | |
| `TI_F_KATS1/2` | 触媒保護増量係数（バンク別） | 1024 = 1.000 | **1.0 超で λ 閉ループが切れる** |

---

## 3. 制御モジュール

| 略号 | 正式名 | 役割 | 0401 での実態 |
|---|---|---|---|
| **LFR** | Leerlaufregelung in **Momenten**struktur（FR 7.2） | 本命のアイドル閉ループ制御器。20 ms、出力は**トルク [Nm]** | 生きている |
| **LLR** | Leerlaufregelung ohne Momentenstruktur（FR 7.0） | 旧来の空気量ベース制御 | PI・ダッシュポット・A/C 外乱 FF・需要適応は**すべて削除済み**。純フィードフォワードのみ |
| **LLS** | Leerlaufsteller | アイドル調整弁（ICV）のデューティ | `KF_LLS_TV(N, qsoll)` から |
| **FR / FRA** | Füllungsregler / -Adaption（FR 2.02 / 2.03） | 目標充填と実充填の**定常偏差**（漏れ空気等）を学習 | → `40-fr-adaptation-bug.md` |
| **LLSync** | Leerlaufsynchronisation（FR 7.04） | 気筒別に `ti` を微調整して回転むらを均す | 有効 |
| `ZUSTAND_MOTOR` | 運転状態ビット（RAM `0xFFE8EC`） | 1=停止, 2=始動, **4=LL**, 8=TL, 0x10=VL, 0x20=KL15 OFF, 0x40=後行 | |
| `KKOS` | Klimakompressor（A/C コンプレッサ） | | `KKOS_ST` bit0 |
| `SK` | Sicherheitskonzept（安全コンセプト） | | 作動時アイドル目標 1250 rpm |

---

## 4. アドレス体系

| 区分 | 内容 |
|---|---|
| XDF アドレス `A` | `A < 0x8000` → **Slave**、`A ≥ 0x8000` → **Master** |
| **64 KB パーシャル BIN のオフセット** | **`A` そのもの（恒等写像）** |
| 1 MB フル BIN のオフセット | `A < 0x8000` なら `A + 0x88000`、それ以外は `A` |

→ このディレクトリに出てくる XDF アドレスは、**そのままこのツールが扱う 64 KB パーシャル BIN の
バイトオフセット**。`src/config/constants.ts` の既存定数（`0xD2FE`, `0xE5E4`, `0x4824` …）と同じ流儀。

- データはすべて **ビッグエンディアン**（`parser.ts` / `patcher.ts` は `getUint16(o, false)`）。
- KF/KL ブロックは**第 1 軸アドレスの 2 バイト手前**にサイズヘッダを持つ。
  軸アドレス自体はヘッダの後ろを指す。
- **チェックサム**: CRC-16/ARC（reflected poly `0xA001`, init 0）。
  Slave スロット `0x3FFC`、Master スロット `0xBFFC`。1 バイト書き換えても再計算が必須。
  → 詳細は `docs/implementation-notes.md` §5。

### タスク周期

| タスク | 主な担当 |
|---|---|
| `task_10ms` | `FRA_TIMER` のティック |
| `task_20ms` | LFR（アイドルトルク制御器） |
| `task_100ms` | `TABG` 取得、`KATS`、`TI_KATS` |
| `task_bgnd`（背景ループ） | **`rf_korr`** |
| セグメントタスク（120°CA ごと） | `rf_calc`（`RF` / `ML` の算出） |

`rf_korr` は**遅くラッチされるスカラーを、速い消費側がサンプルする**構造になっている。

---

## 5. 本ディレクトリの記述方針

- 値はすべて `Full 211323000401PD31_TERRA.bin` から直接バイトを読み、XDF の `<MATH>` を適用した実測値。
- **コミュニティ由来の主張**と**逆アセンブルからの導出**を明確に区別する。
  後者で未検証のものには「導出・未検証」と明記する。
- Community Patch v1 と値が異なる項目には印を付ける（→ `50-binary-lineage.md`）。
- 日本語を主とし、シンボル名・単位は原語のまま。訳さない。
