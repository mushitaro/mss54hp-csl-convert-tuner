# 過渡走行での噴射指令の追加計測

2026-10-11。VE/rf_korr の調査用。運転点の保持は要求しない。

## 今回変えたもの

従来は O₂ 電圧・STFT・λ制御状態・P回数・BA・直接読取りの rf_korr / rf_soll を記録していた。
噴射側の補正が重なった結果を確認するため、取得した診断応答から次を保存する。

| 保存列 | 意味・出所 | 取得タイミング |
|---|---|---|
| `baseInjectionMs` | `TL`、block 3 offset 6、uint16 × 0.001 ms | `standardReadTime/Ms` |
| `injection1Ms`〜`injection6Ms` | `TI1`〜`TI6`、block 19 offset 6/8/10/12/14/16、uint16 × 0.001 ms | `injectionReadTime/Ms` |
| `injectionBlankActual/Target` | `TI_AUSBLEND_IST/SOLL`、block 19 offset 4/5 | 同上 |
| `injectionStft1/2` | block 19 offset 40/42 の `LA_F_REGLER1/2` | 同上。先に読んだ RAM の STFT と別列 |
| `injectionReadSource` | `block19-0401-unverified` | 実車での新列の検証は別途必要 |

`TL` は `TI_VORST` ではない。`TI1`〜`TI6` は、slave の各補正と加算適応・気筒補正・
上下限を通過した指令時間であり、`KL_TI_UB` の無効噴射時間を加える前の値。
実噴射量や実測 AFR ではなく、噴射カット中に実際に通電したことの証明でもない。

WORKS の VE 計測は block 19 を **8サンプルに1回から毎サンプル**へ変更。
デコードと保存そのものには追加通信がないが、頻度を上げる分は約171.9 ms/sample増える。
既存通信モデルでは全体約2.74 Hz→約1.865 Hz。実車レートを保証する数字ではない。
production の block 19 は従来の1/8、通信モデル約4.563 Hzを維持する。
blockだけのfallbackも噴射時間を記録するが、O₂/BA/RAM状態が無いことはそのまま残る。

## DMEを読んで確定したこと

- master `030b84` case `0x1c` は、block 3 payload 6/7に `TL` を書く。
- master の block 19はslave担当の欄をゼロにする。これだけ読んで「TIは取れない」と判断しない。
  0401 full BINのslave `030936`〜`0309D8` は、4バイトの空欄とblanking 2バイトに続いて
  `FFE75A`〜`FFE769`の8気筒ぶんのTIを順に上位/下位バイトとして書く。
  CSLで記録するのは先頭6気筒。参照DS2カタログのoffsetと一致する。
- slave `01b0e2` は `TI_VORST` → bank別 `TI_F_ADAPT × TI_F_KATS + TI_OFFSET_ADAPT`
  → 気筒補正・同期加算・上下限 → `TI1`〜`TI6` → `KL_TI_UB` 加算 → TPU値の順。
  このためTIの記録は、STFTだけでは見えない補正の合成結果を調べる手段になる。
- `TI_F_ADAPT` と `TI_VORST` はslave専用RAMで、この0401の通常メモリ読取りでは直接取得できない。
  masterの同じ数値アドレスを代用してはならない。
- slave `027114` の `TEA1/2_F_KORR` は、学習状態と忘却状態から計算される。
  `TETV=0`だけから、その瞬間の燃料側パージ補正が1と断定できない。
  過去の履歴と全内部状態がないログから、これらを一意に再構成することもできない。

一次資料は `public/data/calibration-decomp.json` の関数、`calibration-graph.json` のRAMシンボル、
逆アセンブルノートの0401 full BIN、参照 `DmeLiveValueCatalog.cs`。
slaveの `030936` の診断応答部分は現在の関数別decomp出力に含まれないため、BIN命令列を確認した。

## 保存とTuneへの影響

追加列はリンク→`LiveMeasurement`→`LogDataPoint`→SAVE/SYNC/CSVへ渡す。
今回の変更にはD1スキーマ変更は不要で、既存の圧縮ログJSONに含まれる。
読取り失敗・短い応答・その回に読まなかった値は欠測とし、前回値や0で埋めない。
実際に読んだ0は保持する。旧ログに追加値を合成しない。

追加列は診断用で、VE採用条件・VE補正量・rf_korrテーブル・αの入力にはしていない。
現行の比較専用候補をTuneへ書き込まない制約も維持する。

## このデータで行う検証

1. 読取り成功数・実間隔・応答時間、TIの0/固定値/範囲を確認し、新列を実車で検証する。
2. block 19内のTIとSTFTを組にする。block 3のTLやRAMのBAとの比較には別々の時刻を使い、
   同じ行だから同時刻とは扱わない。応答はECU内部の原子的なスナップショットでもない。
3. 普通の走行の各通過について、rf_korr発動・BA・λ再開・STFT減少・TI変化の順序を比較する。
   TL変化やカットを区別し、STFTの減少と噴射指令の減少が対応しているかを調べる。
4. 残差があれば未記録の噴射補正を調査する。TIを追加しても、濃い側だけのO₂電圧から
   濃さの量が直接判明するわけではない。検証前にVEの修正量へ変換しない。

回転数や開度を固定して保持する走行、全開走行、追加リセットを計測成立の条件にはしない。
この追加計測は噴射経路の仮説を分けるものであり、VE定量推定が完成したという意味ではない。
