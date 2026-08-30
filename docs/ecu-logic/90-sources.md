# 90 — 出典

このディレクトリの記述がどこから来ているかの対応表。
**コミュニティ由来の主張**と**逆アセンブルからの導出**を区別できるようにするための文書。

---

## 1. 一次資料

| 資料 | 内容 | 置き場所 |
|---|---|---|
| `CSL_0401_Karter16_v3_6_publish.xdf` | TunerPro 定義。`XDFCONSTANT` 1782 / `XDFTABLE` 394 / **`XDFFUNCTION` 353**。アドレス・型・スケール・軸の一次情報 | karter16 の CSL 0401 逆アセンブルリポジトリ |
| `Full 211323000401PD31_TERRA.bin` | 1 MB フル BIN。**このディレクトリの数値はすべてここから直接バイトを読んで算出** | 同上 |
| `MSS54 Funktionsrahmen/Original (German)/*.pdf` | BMW/Bosch の機能仕様書 39 冊。ドイツ語原文が正、英訳版は OCR 由来の劣化がある | 同上 |
| Ghidra 逆コンパイル出力 | `app/public/data/decomp/{master,slave}/<hex>.txt`。ファイル名 = 関数アドレス | 同上 |
| `graph.json` | XDF 全項目のデコード済み値 ＋ RAM シンボル ＋ 参照エッジ | 同上 |
| `95-faster-logging.md` | DS2 ログ速度の調査と go/no-go（交換の内訳、FTDI レイテンシ、専用ブロック案の判定） | 本リポジトリ。一次データはセッション #903/#904 の per-exchange トレース |

> **`XDFFUNCTION` は独立した要素型**。`XDFTABLE` と `XDFCONSTANT` だけを走査すると
> `KL_*` 曲線 353 本（`KL_TABG_PT200`、`KL_TI_KATS_*`、`KL_LFR_NSOLL_*` を含む）を全部取りこぼす。

---

## 2. Funktionsrahmen の該当節

| 節 | ファイル | 使った箇所 |
|---|---|---|
| **2.02** | `2.02 Füllungsregler.pdf` | 充填レギュレータ本体 → `40-fr-adaptation-bug.md` |
| **2.03** | `2.03 Adaption Füllungsregler.pdf` | FRA の目的（漏れ空気の補償）→ `40-fr-adaptation-bug.md` §4 |
| **4.01** | `4.01 EINSPRITZUNG.pdf` pp.7–9, 19–20 | Katschutz 増量の状態機械と「λ 制御を無効化する」の一文 → `20-egt-correction.md` §5 |
| **5.01** | `5.01 Lambdaregelung.pdf` | ICV 故障時のアイドル λ 遮断 → `30-idle-control.md` §7 |
| **7.0** | `7.0 Leerlaufregelung.pdf` | LLR/QVS 側。**制御器の名前は 0401 に存在しない**点に注意 |
| **7.2** | `7.2 Leerlaufregelung moment regelung.pdf` | **0401 が実装しているアイドル制御器** → `30-idle-control.md` |
| **7.03 / 7.04** | `7.03 DIAGNOSE LLS.pdf` / `7.04 Leerlaufsynchronisation.pdf` | LLS 診断、LLSync |
| **8.05** | `8.05 Modul Abgastemperatur.pdf` | TABG 取得と代替値 → `20-egt-correction.md` §4 |
| **8.06** | `8.06 Kattemperaturmodell.pdf` | `TKATM` |

---

## 3. 逆コンパイル関数

| 関数 | アドレス | ファイル | 内容 |
|---|---|---|---|
| `rf_calc` | master `0x0218D0` | `master/0218d0.txt` | RF / ML の算出。`k_rf_cfg` の全分岐 |
| `rf_korr` | master `0x021A70` | `master/021a70.txt` | EGT 密度補正 |
| `rf_init` | master `0x02181C` | `master/02181c.txt` | `m_norm` 系の初期化 |
| `tabg_calc` | master `0x01BFE2` | `master/01bfe2.txt` | Pt200 → TABG |
| `tabg_filter_calc` | master `0x01C4B0` | `master/01c4b0.txt` | 代替値と診断 |
| `kats_calc` | master `0x0209B2` | `master/0209b2.txt` | 触媒保護（**燃料枯渇由来**） |
| `tkatm_calc` | master `0x01CAF4` | `master/01caf4.txt` | 触媒温度モデル |
| `lfr_calc` | master `0x0266B8` | `master/0266b8.txt` | アイドルトルク制御器 |
| `llr_n_soll_calc` | master `0x026DB8` | `master/026db8.txt` | 目標回転数の形成 |
| `lls_tv_calc` | master `0x025D0A` | `master/025d0a.txt` | アイドル弁デューティ |
| `lfra_adapt` | master `0x025B52` | `master/025b52.txt` | アイドル適応（積分器切替） |
| A/C トルク補償 | master `0x017554` / `0x017748` | 同名 | `MD_LLRA` / `md_klima_filter` |
| `zustand_motor_calc` | master `0x02C1E2` | `master/02c1e2.txt` | LL/TL/VL 判定 |
| `lls_diag` | master `0x02603A` | `master/02603a.txt` | `LLS_ST` のラッチ |
| `ds2_handler` | master `0x030B84` | `master/030b84.txt` | **DS2 応答の組み立て**（selection 3 は `case 0x1c`） |
| FRA タイマ | master `0x025572` | `master/025572.txt` | `FRA_TIMER = CONCAT11(...)` |
| `ti_engine_running` | slave `0x01B0E2` | `slave/01b0e2.txt` | `TI_F_KATS` の適用 |
| `ti_moment_factor` | slave `0x01D190` | `slave/01d190.txt` | トルクモデルへの反映 |
| `smg_anti_stall_handler` | slave `0x0396A0` | `slave/0396a0.txt` | SMG アンチストール |

### 逆コンパイル出力が無い関数（BIN から直接読んだもの）

| 関数 | アドレス | 内容 | 使った箇所 |
|---|---|---|---|
| `FUN_0001C756` | slave | `TI_KATS` 制御器（100 ms） | `20-egt-correction.md` §5 |
| `FUN_0001EBEA` | slave（ファイル `0x9EBEA`） | λ 解除ロジック（`LA_ST_AUS` / `LA_ST_EIN`） | `30-idle-control.md` §7 |

---

## 4. フォーラム（NA M3 Forums）

| 話題 | スレッド / 投稿 |
|---|---|
| CSL 換装のストリートチューニング手順 | thread 242281（`k_rf_cfg = 0x02`、`K_LAA_TMOT_MIN = 100 °C`、AQ_REL 変換） |
| **`KF_RF_KORR_DRREL` の説明と「λ=1 を追うな」** | thread 242281 page10–11（karter16 #141 ほか、Bry5on #145） |
| **FRA バグの発見** | thread 287069 #242（karter16, 2025-09-06）、#244（Bry5on）、#245、#248 |
| Terra の旧修正とその議論 | thread 26354（terra #1 / #11、MpowerE36 #8、ppm008） |
| **Community Patch v1 の変更リスト** | thread 343444（karter16, 2026-02-14） |
| 純正 CSL の A/C アイドルハンチング（**未解決**） | thread 230915（全 9 ページ） |
| **タンク換気の無効化** `K_TE_TVTE_GA = 0`（純正 `0x80`） | thread 318164 #16 / #18（karter16, 2025-09-17）。「ログで確認済み」「代替手段なしに無効のまま放置するな」 |
| **チューニング走行中はタンク換気を切れ** | thread 242281 #161（karter16, 2026-08-14）。再現性に "MASSIVE difference"。**必ず戻すこと** |
| **VANOS 適応はリセット不要** | 同 #161。「この手順は VANOS に影響しない。変数を 1 つ減らせ」 |
| **カバレッジしきい値を上げる／可変にする** | 同 #161。氏は CAN 100 Hz が基準 |
| **CAN 経由 100 Hz ロギング**（`0x7D0` / `0x7D1`、10 ms タスク） | thread 287069 p9–p18（karter16 / Bry5on, 2025-06〜2026-08）、journal p20–p25。**未公開**、Community Patch V2 予定（thread 343444 #9） |
| **`0x700` / `0x701` はノック情報の CAN 送出**、`K_KA_CAN_AUS` で有効化 | thread 287069 p14 #206（karter16）、バイト 0 の解読は p15 #211（Bry5on） |

> **アトリビューション**: thread 242281 #161 で「コードとアプリに出典を明記する」と公開の場で
> 約束済み。README の CREDITS 節とアプリ内 CREDITS ダイアログ（バージョン表示から開く）が対応する。

---

## 5. 本解析による導出（コミュニティ未公表・要検証）

以下は**フォーラムに出典がなく、逆アセンブルと BIN の実測から導いたもの**。
採用する場合は実車での確認が前提。

| 項目 | 記載箇所 | 状態 |
|---|---|---|
| DS2 selection 3 の `RF` @offset 8 / `TABG` @offset 14 | `20-egt-correction.md` §7.1 | payload 13/16/20/21 の 0 書き込みという未解決の不一致あり。**実車確認が必要** |
| Terra プログラム向けのパーシャル値 `01 01` | `40-fr-adaptation-bug.md` §3 | 導出のみ。ベンチ／実車未検証 |
| 純正 CSL A/C ハンチングの 4 要因 | `40-fr-adaptation-bug.md` §5 | 機構は特定済み。**修正値は誰も検証していない** |
| ICV 故障によるアイドル λ 開ループ | `30-idle-control.md` §7 条件 1 | 逆アセンブルで確認。FR 5.01 の記述とも一致 |
| `KL_TI_KATS_RF_SCHW_N` により `TI_KATS` が実質 4500 rpm 以上専用 | `20-egt-correction.md` §5 | 較正値からの導出 |
| `KL_LFR_TZ_NEG` / `KL_LLS_UB_KORR` が全ゼロ | `30-idle-control.md` §4 / §5 | BIN 実測 |
