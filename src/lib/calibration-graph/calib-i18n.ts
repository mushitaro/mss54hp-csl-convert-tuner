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
  diagramDepth: { ja: "DEPTH", en: "DEPTH" },
  showEverything: { ja: "SHOW ALL", en: "SHOW ALL" },
  showKeyOnly: { ja: "KEY ONLY", en: "KEY ONLY" },
  showNoise: { ja: "SHOW PLUMBING", en: "SHOW PLUMBING" },
  hideNoise: { ja: "HIDE PLUMBING", en: "HIDE PLUMBING" },
  showAllLines: { ja: "ALL LINES", en: "ALL LINES" },
  plainForm: { ja: "PLAIN", en: "PLAIN" },
  decompiledForm: { ja: "AS DECOMPILED", en: "AS DECOMPILED" },
  showFewerLines: { ja: "KEY LINES", en: "KEY LINES" },
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
  plainFormHint: {
    ja: "逆コンパイラそのままの書き方に戻します。推定で付けた名前も出なくなります。",
    en: "Show the decompiler wording instead. Inferred names are withheld too.",
  },
  decompiledFormHint: {
    ja: "読みやすい書き方に戻します。元の C 言語の行は式にカーソルを乗せると出ます。",
    en: "Back to the readable wording. The original C stays on hover.",
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
  moreBlocksUnit: { ja: "ブロック", en: "more blocks" },
  moreBlocksHint: {
    ja: "図がここで終わっているのは DEPTH の設定によるもので、信号がここで終わるという意味ではありません。DEPTH を上げると続きが出ます。",
    en: "The picture stops here because of DEPTH, not because the signal path ends. Raise it to draw what follows.",
  },
  portsHidden: { ja: "表示しきれない入出力", en: "inputs/outputs not shown" },
  blocksHidden: { ja: "表示しきれない隣接ブロック", en: "neighbouring blocks not shown" },

  // diagram notes (bilingual)
  noDiagram: {
    ja: "この項目を計算に使っているブロックが見つかりませんでした。",
    en: "No block computing with this was found.",
  },
  diagramParamFocus: {
    ja: "を読むブロックを右に並べています。",
    en: "— the blocks that read it are shown to the right.",
  },
  selectPrompt: {
    ja: "左のツリーからパラメータか関数を選んでください。",
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
