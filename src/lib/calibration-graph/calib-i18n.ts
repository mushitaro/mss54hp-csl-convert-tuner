export type Lang = "ja" | "en";

/**
 * Strings for the calibration workbench, adapted from the notes-repo viewer.
 *
 * The house rule (see lib/dialog-text.ts) applies: control labels — tab names,
 * buttons, table headings, instrument shorthand — are ONE English form in both
 * languages; only explanations, notes and empty-state copy switch language.
 * A key whose ja and en strings are identical below is a control label on
 * purpose, not an untranslated leftover.
 */
const STRINGS = {
  // controls (English both sides, by rule)
  search: { ja: "SEARCH", en: "SEARCH" },
  parameters: { ja: "PARAMETERS", en: "PARAMETERS" },
  functions: { ja: "FUNCTIONS", en: "FUNCTIONS" },
  results: { ja: "RESULTS", en: "RESULTS" },
  blockDiagram: { ja: "LOGIC DIAGRAM", en: "LOGIC DIAGRAM" },
  // The control row. Every one of these is ONE fixed word that never changes
  // when the control is toggled: the row's geometry has to be a constant, and a
  // label that rewrites itself between SHOW PLUMBING (+3) and HIDE PLUMBING
  // moves every control to its right by five characters. State is lighting.
  viewNetwork: { ja: "NETWORK", en: "NETWORK" },
  viewFunction: { ja: "FUNCTION", en: "FUNCTION" },
  viewCode: { ja: "CODE", en: "CODE" },
  insideFlow: { ja: "FLOW", en: "FLOW" },
  insideBranches: { ja: "IF", en: "IF" },
  diagramDepth: { ja: "DEPTH", en: "DEPTH" },
  showEverything: { ja: "ALL", en: "ALL" },
  showAllLines: { ja: "LINES", en: "LINES" },
  showNoise: { ja: "PLUMBING", en: "PLUMBING" },
  decompiledForm: { ja: "RAW", en: "RAW" },
  hiddenLabel: { ja: "HIDDEN", en: "HIDDEN" },
  master: { ja: "MASTER", en: "MASTER" },
  slave: { ja: "SLAVE", en: "SLAVE" },
  address: { ja: "ADDR", en: "ADDR" },
  units: { ja: "UNITS", en: "UNITS" },
  scaling: { ja: "SCALING", en: "SCALING" },
  width: { ja: "WIDTH", en: "WIDTH" },
  chartRow: { ja: "SECTION", en: "SECTION" },
  documents: { ja: "FUNKTIONSRAHMEN", en: "FUNKTIONSRAHMEN" },
  originalSpelling: { ja: "AS WRITTEN", en: "AS WRITTEN" },

  // tooltips on small controls (explanatory, bilingual)
  zoomIn: { ja: "図を拡大（Ctrl + ホイール、2本指ピンチでも同じ）", en: "Magnify (Ctrl + wheel, or pinch)" },
  zoomOut: { ja: "図を縮小（Ctrl + ホイール、2本指ピンチでも同じ）", en: "Shrink (Ctrl + wheel, or pinch)" },
  // Hints for the fixed row. One per control, describing what the control DOES
  // rather than what pressing it will switch to — the label no longer flips, so
  // the hint must not read as an instruction to flip it either.
  rawFormHint: {
    ja: "点灯中は逆コンパイラそのままの書き方です。推定で付けた名前は出ません。消すと読みやすい書き方に戻り、元の C 言語の行は式にカーソルを乗せると出ます。",
    en: "Lit shows the decompiler's own wording, with inferred names withheld. Unlit is the readable wording; the original C stays on hover.",
  },
  depthHint: {
    ja: "何段先まで図に出すかです。CODE の一覧に載るブロックもこの設定で決まります。",
    en: "How many steps out the picture reaches. It also decides which blocks the CODE listing holds.",
  },
  showEverythingHint: {
    ja: "列ごと・ブロックごとの上限を外して、関係するものを全部出します。消すと要点だけになります。",
    en: "Lifts the per-column and per-block caps and draws everything related. Unlit shows the key ones only.",
  },
  showAllLinesHint: {
    ja: "順位で選ばれなかった式も全部出します。ALL が点いている間は既に全部出ているので効きません。",
    en: "Draws the statements that were ranked out too. While ALL is lit they are already drawn, so this does nothing.",
  },
  showNoiseHint: {
    ja: "ポインタやレジスタの操作など、機械の都合の行も出します。既定では畳んであります。",
    en: "Also draws the pointer and register rows — machine detail, folded away by default.",
  },
  rawCondition: { ja: "元の条件式", en: "The condition as decompiled" },
  zoomFit: {
    ja: "全体が入るところまで縮小します。下限は 40% なので、大きな図は入りきらないことがあります。等倍より大きくはしません。",
    en: "Shrink toward fitting the whole picture. The floor is 40%, so a large one may still not fit. Never magnifies past 1:1.",
  },
  expandBlock: { ja: "式を開く", en: "Open" },
  collapseBlock: { ja: "式を畳む", en: "Close" },
  expandLines: { ja: "この行を開く", en: "Open these lines" },
  moreLines: { ja: "他", en: "more" },
  moreBlocks: { ja: "この先に", en: "continues into" },
  elidedUnit: { ja: "行省略", en: "skipped" },
  elidedHint: {
    ja: "この2行はブロックの中で隣り合っていません。間の行は順位で選ばれなかったもので、ALL LINES を押すと出ます。",
    en: "These two rows are not adjacent in the block. What is between them was ranked out; ALL LINES draws it.",
  },
  moreBlocksUnit: { ja: "ブロック", en: "more blocks" },
  moreBlocksHint: {
    ja: "図がここで終わっているのは DEPTH の設定によるもので、信号がここで終わるという意味ではありません。DEPTH を上げると続きが出ます。",
    en: "The picture stops here because of DEPTH, not because the signal path ends. Raise it to draw what follows.",
  },
  portsHidden: { ja: "表示しきれない入出力", en: "inputs/outputs not shown" },
  blocksHidden: { ja: "表示しきれない隣接ブロック", en: "neighbouring blocks not shown" },
  linksHidden: { ja: "引ききれなかった行どうしの関連", en: "row-to-row links the gutter had no room for" },
  loopsHidden: { ja: "引ききれなかった戻りの線", en: "return wires the lanes had no room for" },
  focusLabel: { ja: "FOCUS", en: "FOCUS" },
  focusClear: {
    ja: "この量の強調を解除します（同じ語をもう一度押すか Esc でも解除できます）。",
    en: "Clear this. Pressing the same word again, or Esc, does the same.",
  },
  codeHint: {
    ja: "if の入れ子は各文が持つ条件から組み直したものです。アドレス・ループ・goto・else は復元できません。条件にカーソルを乗せると逆コンパイラの原文が出ます。",
    en: "The if nesting is reconstructed from the condition each statement carries. Addresses, loops, gotos and else are not recovered. Hover a condition for the decompiler's own text.",
  },
  codeCounts: { ja: "ブロック / 文", en: "blocks / statements" },
  codeSourced: { ja: "ブロックは逆コンパイラの原文", en: "quoted from the decompiler" },
  sourceLineNoHint: {
    ja: "逆コンパイラ出力の行番号です。復元された文の通し番号とは違い、これは本文中の実際の位置です。",
    en: "The line number in the decompiler's output. Unlike the ordinal on a recovered statement, this is a real position in the text.",
  },
  sourceHint: {
    ja: "ここは逆コンパイラの出力そのものです。この関数からは式が取り込まれていないため、書き換えずに引用しています。色と選択は他のビューと同じで、FUN_ で始まる呼び先は押すと開きます。",
    en: "This is the decompiler's output itself. No statements were parsed from this function, so it is quoted rather than rewritten. Colours and selection work as everywhere else, and a FUN_ call site opens on a press.",
  },

  // The listing's rings. A walk outwards from the subject, and these say how
  // far out you are — explanations, so they switch language.
  ringSubject: { ja: "選んだもの", en: "What you picked" },
  ringUpstream: { ja: "これを作っているもの", en: "What builds it" },
  ringDownstream: { ja: "これを使っているもの", en: "Where it goes" },
  ringUnit: { ja: "ブロック", en: "blocks" },
  ringHint: {
    ja: "選んだものから外へ1段ずつ並べています。DEPTH を上げると外側に段が増えるだけで、いま読んでいる並びは動きません。",
    en: "Ordered outwards from what you picked. Raising DEPTH adds rings at the end; what you are reading does not move.",
  },
  xrefLabel: { ja: "他に", en: "also" },
  xrefHint: {
    ja: "この行が計算する量を、他に使っている関数です。押すとそこへ移ります。",
    en: "Other functions that touch what this line computes. Press one to go there.",
  },
  // Which processor's memory a quantity lives in. The two CPUs are separate
  // computers with no edge between them; a value crosses only through the
  // dual-port RAM, and these say which side of that you are looking at.
  sharedMemory: {
    ja: "共有メモリ（デュアルポート RAM）。両方の CPU が同じ1か所を見ています。",
    en: "Shared memory (dual-port RAM) — both processors see this one location.",
  },
  masterOnly: {
    ja: "マスター側のメモリです。スレーブの同名は別の場所で、dpr_sync がコピーします。",
    en: "The master's own memory. The slave's copy of this name is a different location; dpr_sync copies between them.",
  },
  slaveOnly: {
    ja: "スレーブ側のメモリです。マスターの同名は別の場所で、dpr_sync がコピーします。",
    en: "The slave's own memory. The master's copy of this name is a different location; dpr_sync copies between them.",
  },

  // Why a block box is empty. THREE different facts, and two of them the
  // reader can act on — so those two name the control, per
  // ui-copy-says-which-to-choose.
  //
// These used to be two, and the first of them was false for 110 functions:
  // it said the decompiler's output "was never parsed" over all 1,171 empty
  // boxes, when for 110 of them the text existed, shipped with the app, and
  // CODE could quote it.
  //
  // The exporter has since stopped filtering by name, so every function has a
  // body and the 1,061 became 0. What survives is 321 with a body and no
  // parsed statements. The numbers below are asserted by verify:cal-decomp,
  // which is why they are safe to write down.
  blockNoFormula: {
    ja: "この関数には逆コンパイラの出力がありません",
    en: "no decompiler output exists for this function",
  },
  blockSourceOnly: {
    ja: "式は未復元です。逆コンパイラの原文は CODE に出ます",
    en: "no formula parsed — CODE quotes the decompiler's own text",
  },
  blockAllPlumbing: {
    ja: "全ての行が機械の都合です。PLUMBING で出ます",
    en: "every row here is machine detail — PLUMBING draws them",
  },
  blockNoFormulaHint: {
    ja: "この状態の関数は現在 0 個です。以前はエクスポータが FUN_ で始まる名前を除外していたため 1,705 中 1,061 がここに入っていました。もしこの文が出ているなら、成果物の作り直しで何かが抜け落ちています。",
    en: "No function is in this state any more. 1,061 of the 1,705 used to be, because the exporter dropped every name still beginning FUN_. If you are reading this sentence, something went missing in a rebuild.",
  },
  blockSourceOnlyHint: {
    ja: "逆コンパイラの出力はこのアプリに入っていますが、式としては取り込まれていません。1,705 関数のうち 321 がこの状態です。CODE ビューで本文がそのまま読めます。",
    en: "The decompiler's output for this function ships with the app; it was simply never parsed into statements. 321 of the 1,705 are in that state, and the CODE view reads the body as it stands.",
  },
  blockSourceMissing: {
    ja: "逆コンパイラの原文をまだ読み込めていません",
    en: "the decompiler's text has not loaded yet",
  },
  blockAllPlumbingHint: {
    ja: "この関数の行はポインタやレジスタ操作だけで、既定では畳んであります。PLUMBING を押すと出ます。",
    en: "Every row this function has is pointer and register work, folded away by default. Press PLUMBING to draw them.",
  },

  // What a DARK control says. It is still there, in its place, and it answers.
  onlyInNetwork: { ja: "NETWORK ビューでだけ効きます。", en: "Works in the NETWORK view." },
  onlyInFunction: { ja: "FUNCTION ビューでだけ効きます。", en: "Works in the FUNCTION view." },
  notInCode: { ja: "CODE は本文なので、この設定は効きません。", en: "CODE is the text itself, so this setting does nothing here." },
  notInFunction: { ja: "FUNCTION は1つの関数の中なので、この設定は効きません。", en: "FUNCTION is inside one function, so this setting does nothing here." },
  alreadyAll: { ja: "ALL が点いている間は既に全部出ています。", en: "While ALL is lit everything is already drawn." },

  // The three views, and what each is for. Explanations, so bilingual.
  viewAxisHint: {
    ja: "外から内へ: NETWORK は関数どうしのつながり、FUNCTION はその関数の中、CODE は本文です。どれも同じ1つの対象について答えます。",
    en: "Outside in: NETWORK is how functions connect, FUNCTION is within one of them, CODE is the text. All three answer about the same one thing.",
  },
  insideFlowHint: {
    ja: "どの行の結果を、どの行が読むか。右が入口で左へ流れます。条件は各行の上に書いてあります。",
    en: "Which row's result which row reads. Inputs on the right, flowing left. Conditions ride on each box.",
  },
  insideBranchHint: {
    ja: "条件の入れ子です。else・ループ・goto は復元できないので、枠の外れ方までは分かりません。",
    en: "The nesting of the conditions. else, loops and gotos are not recoverable, so what happens when a frame is skipped is not shown.",
  },
  insideNoBranch: {
    ja: "この関数に条件分岐はありません。全ての行が必ず実行されます。",
    en: "This function has no branch. Every line runs, every time.",
  },
  insideNoCode: {
    ja: "この関数の計算式は復元されていません。",
    en: "No formula was recovered for this function.",
  },
  insidePick: {
    ja: "を使っている関数です。中を見たいものを選んでください。",
    en: "— the functions that use it. Pick one to look inside.",
  },
  insideBranchCount: { ja: "分岐", en: "branches" },
  statementsUnit: { ja: "文", en: "statements" },
  insideNesting: { ja: "最大入れ子", en: "deepest" },
  lineNoHint: {
    ja: "関数の中での通し番号です。アドレスは復元データに含まれていないため出せません。",
    en: "The ordinal within the function. Addresses are not in the recovered data, so none is shown.",
  },
  focusPrompt: {
    ja: "変数や表の名前を押すと、その量が通る道すじだけが光ります。",
    en: "Press a variable or table name to light the path that quantity takes.",
  },

  // diagram notes (bilingual)
  noDiagram: {
    ja: "この項目を計算に使っているブロックが見つかりませんでした。",
    en: "No block computing with this was found.",
  },
  diagramParamFocus: {
    ja: "を読むブロックを左に並べています。",
    en: "— the blocks that read it are shown to the left.",
  },
  /**
   * The return wires, counted in every NETWORK picture — including the ones
   * with none.
   *
   * Always drawn, never conditional: a count that appears only when it is
   * non-zero is a line of text arriving out of nowhere, which is the thing the
   * fixed row exists to stop. Zero is also the more useful answer of the two —
   * "nothing here loops" is worth reading.
   */
  openABlockFirst: {
    ja: "式の見え方を変える設定です。ブロックの + を押して開くと効きます。",
    en: "Changes how a drawn formula reads. Press + on a block to open one first.",
  },
  loopCount: { ja: "戻りの線", en: "return wires" },
  /**
   * Said when the picture has no loop in it but the next depth does.
   *
   * Names the control to press, because otherwise an empty result reads as
   * "this is not part of a loop" — and for the maps a tuner actually works in
   * that reading is wrong. `kf_rf_soll` shows nothing at DEPTH 1 and twelve
   * return wires at DEPTH 2; so do KF_RG_M, K_KVA_NORM and 273 others.
   */
  loopDeeper: { ja: "DEPTH %s で閉じます", en: "closes at DEPTH %s" },

  // ---- the ruler: where this picture sits between the two ends of the ECU --
  // Labels stay English, like every other control and readout on this screen.
  rulerIn: { ja: "IN", en: "IN" },
  rulerOut: { ja: "OUT", en: "OUT" },
  rulerSensor: { ja: "SENSOR", en: "SENSOR" },
  rulerActuator: { ja: "ACTUATOR", en: "ACTUATOR" },
  rulerLoop: { ja: "LOOP", en: "LOOP" },
  rulerBlocks: { ja: "BLOCKS", en: "BLOCKS" },
  rulerInHint: {
    ja: "この図に出ているセンサー入力の数と、ECU 全体の数です。入力はアナログ15本・クランク角4本・タイマー捕捉2本の計21本で、どれもECU側から書き込めません（＝ハードウェアからしか来ない）。",
    en: "Sensor inputs on this picture, against the whole ECU. The 21 are 15 analogue, 4 crank-angle and 2 timer captures — none of them writable by the ECU, so the value can only come from hardware.",
  },
  rulerOutHint: {
    ja: "この図に出ているアクチュエータ出力の数と、ECU 全体の数です。37本の内訳はインジェクタのパルス、VANOS バルブ、燃料ポンプ、PWM 出力です。",
    en: "Actuator outputs on this picture, against the whole ECU. The 37 are the injection pulses, the VANOS valves, the fuel pump and the PWM outputs.",
  },
  rulerSensorHint: {
    ja: "選んでいるブロックから、センサーを読むブロックまで何ブロックか。0 なら自分が読んでいます。DEPTH をこの数まで上げると、その経路が図に入ります。",
    en: "How many blocks from the subject to one that reads a sensor. 0 means it reads one itself. Raising DEPTH to this number brings the path into the picture.",
  },
  rulerActuatorHint: {
    ja: "選んでいるブロックから、アクチュエータを動かすブロックまで何ブロックか。0 なら自分が動かしています。",
    en: "How many blocks from the subject to one that drives an actuator. 0 means it drives one itself.",
  },
  rulerLoopHint: {
    ja: "互いに依存し合っているブロックの数です。1 なら輪の中にいません。この ECU は式を持つ 1,384 ブロックのうち 598 が輪の中にいて、最大の輪は 432 個ひとかたまりです。大部分が互いを参照し合っています。",
    en: "How many blocks are mutually reachable with this one. 1 means it is in no loop. Of the 1,384 blocks with formulas, 598 sit in a loop and the largest single circle holds 432 — most of the controller depends on itself.",
  },
  rulerBlocksHint: { ja: "この図に描かれているブロックの数です。", en: "Blocks drawn in this picture." },
  rulerNone: { ja: "—", en: "—" },
  rulerUnreachable: {
    ja: "この端には到達しません。経路が復元できていないか、本当につながっていないかのどちらかです。",
    en: "This end is not reachable from here — either the path was not recovered, or it genuinely does not connect.",
  },
  boundaryIn: {
    ja: "センサー入力。ECU 側から書き込めないので、値はハードウェアからしか来ません。",
    en: "A sensor input. The ECU cannot write it, so the value can only come from hardware.",
  },
  boundaryOut: {
    ja: "アクチュエータ出力。ECU がここに書いた値が engine を動かします。",
    en: "An actuator output. What the ECU writes here moves the engine.",
  },

  // ---- the map ------------------------------------------------------------
  mapOpen: { ja: "MAP", en: "MAP" },
  mapTitle: { ja: "エンジン制御全体のどこにいるか", en: "Where this sits in the whole controller" },
  mapHint: {
    ja: "BMW の Funktionsrahmen（機能仕様書）39章を、各ブロックが触るパラメータと信号から推定して割り当てたものです。直接文書化されている関数は12個しかないので（25 は参照の本数であって関数の数ではありません）、割り当ては推定です（枠が破線なのはそのため）。",
    en: "BMW's own Funktionsrahmen — 39 documented sections — assigned to blocks by the parameters and signals each one touches. Only 12 functions are documented directly (25 is the number of references, not of functions), so the assignment is an inference; that is what the dashed borders mean.",
  },
  mapUnplaced: { ja: "未分類", en: "unclassified" },
  mapUnplacedHint: {
    ja: "どの章にも結び付けられなかったブロックです。これが最大の領域であることが、この地図の精度そのものです。",
    en: "Blocks no section could be tied to. That this is the largest region IS the accuracy of this map.",
  },
  mapYouAreHere: { ja: "いまここ", en: "you are here" },
  mapClose: { ja: "CLOSE", en: "CLOSE" },
  mapCoverage: { ja: "%s / %s ブロックに章が付いています", en: "%s of %s blocks carry a section" },
  loopHint: {
    ja: "紫の線が、下を回って戻ってくる値です。エンジン制御は輪になっていて、計算した値が測り直されて同じ計算に戻ります。列の外を回すのは、途中の箱と交差させないためです。",
    en: "The violet lines are values coming back round underneath. Engine control is a loop: what is computed is measured again and returns to the same calculation. They run outside the columns so they cross nothing on the way.",
  },
  selectPrompt: {
    ja: "右のツリーからパラメータか関数を選んでください。",
    en: "Pick a parameter or a function in the tree to begin.",
  },
  noValuesForBlock: {
    ja: "ブロックには数表がありません。マップ・カーブ・定数を選ぶと出ます。",
    en: "A block has no table of its own. Pick a map, curve or constant.",
  },
  noChart: { ja: "図にできる値がありません。", en: "Nothing here to plot." },
  axesDiffer: {
    ja: "比較対象はこのテーブルの軸ブレークポイントが異なります。COPY REF は値のみコピーします。",
    en: "The reference stores different axis breakpoints for this table. COPY REF copies values only.",
  },
  legendNotation: {
    ja: "KF_X[A,B] = 2軸マップ補間、KL_X(A) = カーブ補間、÷256 等は元は右シフト。",
    en: "KF_X[A,B] interpolates a 2-axis map, KL_X(A) a curve; ÷256 was a right shift.",
  },
  legendInferred: {
    ja: "細い点線 = 式ではなく実測の相互参照から推定した接続",
    en: "thin dotted = wiring inferred from cross-references, not from a formula",
  },
  legendAlt: {
    ja: "破線 = 運転状態によって切り替わる入力（どれか1つが使われる）",
    en: "dashed = alternative input, one of them is used depending on state",
  },

  // info-pane section headings (English both sides, by rule — these are panel
  // headings, the exact case design-language-english-ui records as reverted once)
  description: { ja: "Description", en: "Description" },
  consumers: { ja: "Read by", en: "Read by" },
  producers: { ja: "Written by", en: "Written by" },
  mnemonicReading: { ja: "Glossary reading", en: "Glossary reading" },

  // description / info (bilingual)
  descriptionEnOnly: {
    ja: "（この説明はまだ和訳されていません。誤訳を避けるため機械翻訳では埋めていません）",
    en: "",
  },
  signed: { ja: "符号付き", en: "signed" },
  unsigned: { ja: "符号なし", en: "unsigned" },
  openGerman: { ja: "独語原本", en: "German original" },
  openEnglish: { ja: "英訳（機械翻訳）", en: "English (machine translated)" },
  noDocs: {
    ja: "この項目に言及する Funktionsrahmen は見つかりませんでした。",
    en: "No Funktionsrahmen page mentions this.",
  },
  noUpstreamForParam: {
    ja: "このパラメータはフラッシュ上の設定値なので、コードが書き込む上流はありません。ここが入力そのものです。",
    en: "This is a calibration value in flash, so no code writes it — it is the input.",
  },

  // reading a name against the glossary (explanations, bilingual)
  mnemonicTerms: { ja: "名前に含まれる用語", en: "Terms in the name" },
  mnemonicNote: {
    ja: "用語集からの機械的な読み下しです。バイナリ実測でも純正資料の記述でもありません。",
    en: "Composed mechanically from the glossary — neither measured from the binary nor stated by the factory documents.",
  },
  mnemonicUnknown: { ja: "用語集にない語", en: "not in the glossary" },
  mnemonicNoReading: {
    ja: "全ての語が揃わないため、通しの読みは出していません。",
    en: "Not every token is known, so no whole-name reading is composed.",
  },

  // node kinds (bilingual — these appear in tooltips and info lines)
  kParam: { ja: "パラメータ", en: "parameter" },
  kFunc: { ja: "関数", en: "function" },
  kRam: { ja: "RAM 変数", en: "RAM variable" },
  kFrpage: { ja: "仕様書ページ", en: "document page" },
  kUnknown: { ja: "仕様書のみに存在", en: "documents only" },
  kindConstant: { ja: "定数", en: "constant" },
  kindCurve: { ja: "カーブ (2D)", en: "curve (2-D)" },
  kindMap: { ja: "マップ (3D)", en: "map (3-D)" },

  // evidence origins (bilingual)
  originXref: { ja: "バイナリ実測", en: "Binary (measured)" },
  originScan: { ja: "推定スキャン（誤り含む可能性）", en: "Operand scan (inferred, may be wrong)" },
  originFr: { ja: "純正仕様書（同一ページ記載のみ・向きなし）", en: "Factory documents (same page, no direction)" },
  confDocumented: { ja: "確定情報", en: "documented source" },
  confDerived: { ja: "逆アセンブル由来", en: "from disassembly" },
} as const;

export type StringKey = keyof typeof STRINGS;

export function t(lang: Lang, key: StringKey): string {
  return STRINGS[key][lang];
}

export function pickLocalised(
  lang: Lang,
  value: { ja?: string | null; en?: string | null; de?: string | null } | undefined,
): string {
  if (!value) return "";
  if (lang === "ja" && value.ja) return value.ja;
  return value.en || value.de || value.ja || "";
}
