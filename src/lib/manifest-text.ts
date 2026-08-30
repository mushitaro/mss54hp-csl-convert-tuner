/**
 * Every sentence the hub's WRITE / RESTORE / PATCH menus can say, in both languages.
 *
 * ## Why this is a module and not prose in page.tsx
 *
 * These used to be string literals built inside the manifest memo, in English only. Two problems,
 * and the second is the one that made a module the answer rather than a wrapper:
 *
 *   1. They are EXPLANATIONS, and explanations follow the reader's language in this app — the
 *      control names do not. `ALPHA-N`, `TRIM STORE`, `WOT FUEL` stay English wherever they appear,
 *      including inside these sentences, because they are the words on the switch the reader is
 *      being told about. So does every ECU symbol: `kf_rf_soll`, `LAA_F`, `K_TE_TVTE_GA` are the
 *      names in the binary and in the disassembly, and translating them would break the only link
 *      between this screen and the listing.
 *   2. A manifest memo carrying twenty paragraphs of prose in two languages is not a place anyone
 *      can find a sentence to correct. The memo's job is deciding WHICH sentence is true right now;
 *      the sentences themselves are copy.
 *
 * ## The shape
 *
 * Same as `TunedStatusBar`'s TEXT and `shapeWorkspace`'s: one object per language, identical keys,
 * functions where a number or a verdict is interpolated. The caller resolves `useDialogLang()` once
 * and indexes it — so a missing key is a compile error rather than a screen that silently falls
 * back to English.
 *
 * Every entry names the NEXT ACTION where there is one. A lock that only states a fact leaves the
 * reader to invent the remedy, which is how a disabled switch gets reported as broken.
 */

import type { DialogLang } from '@/lib/dialog-text';

/** Which condition is stopping RF KORR, in the order they are usually missing. */
export type RfKorrBlock =
    | 'noEgtTables' | 'needsPatch' | 'needsLog' | 'allDropped'
    | 'noEgt' | 'noTrim' | 'tooFewCells';

interface ManifestCopy {
    /** Accessible name for every row's ⓘ. */
    info: string;
    /** One line under each group's title, saying what membership means. */
    captionWrite: string;
    captionRestore: string;
    captionPatch: string;

    /** Both derived contributions to `kf_rf_soll`, blocked by the restore on the same bytes. */
    restoreVeLocksAlphaN: string;
    restoreVeLocksShape: string;
    restoreWarmupLocksWarmup: string;

    /** No map yet, for whichever reason. */
    derivedTablesLocked: string;
    alphaNEarnedNothing: string;
    /** SHAPE is a MODE on the ALPHA-N write, so both of its locks point back at that row. */
    shapeNothingApplied: string;
    shapeNeedsAlphaN: string;
    shapeReady: string;

    rfKorr: Record<RfKorrBlock, string>;

    /** TRIM STORE, the readout that licenses the two rows above it. */
    trimNeutral: string;
    trimLearned: (worst: string) => string;
    trimNoChannel: string;
    trimWindowOpen: (frozenUnread: boolean) => string;

    idleSealed: string;
    inertiaProposal: string;

    /** RESTORE. `n` is cells off the reference, out of 480. */
    restoreNeedsBinary: string;
    restoreVeLockedByTune: string;
    restoreWarmupLockedByWrite: string;
    restoreAlreadyStock: string;
    restoreVeDrift: (n: number) => string;
    restoreWarmupDrift: (n: number) => string;

    wotNeedsBinary: string;
    wotStock: string;
    wotDrift: (implied: string) => string;

    needBinary: string;
    tankVentNote: string;

    /** CALIBRATION tab edits riding the WRITE group. `owner` is the armed writer's row label. */
    calLockedByWriter: (owner: string) => string;
    calEditNote: string;
}

const EN: ManifestCopy = {
    info: 'Why',
    captionWrite: 'goes into the next download / flash',
    captionRestore: 'puts a table back to the CSL 0401 reference',
    captionPatch: 'changes DME logic in place',

    restoreVeLocksAlphaN: 'RESTORE VE is armed on this same table. It writes the whole stock '
        + 'kf_rf_soll — disarm it under RESTORE to write a tune into these bytes instead.',
    restoreVeLocksShape: 'RESTORE VE is armed on this same table. It writes the whole stock '
        + 'kf_rf_soll — disarm it under RESTORE to write these cells instead.',
    restoreWarmupLocksWarmup: 'RESTORE WARMUP is armed on this same table (kf_rf_soll_kath). '
        + 'Disarm it under RESTORE to write the derived table instead.',

    derivedTablesLocked: 'Needs a tuned map first. Load a log and run the tune — this table is '
        + 'generated from the result, not measured on its own.',
    alphaNEarnedNothing: 'A log was read, but no cell in either band met its evidence bar — the '
        + 'LOW LOAD tab names the gate that refused each one.',
    shapeNothingApplied: 'Chooses WHAT ALPHA-N writes: off, it writes the tuned map as measured; '
        + 'on, it writes the tuned map with the low-opening repair applied. Nothing is applied yet '
        + '— open the SHAPE tab, switch on a rule, and press APPLY.',
    shapeNeedsAlphaN: 'Needs ALPHA-N armed. This is not a separate table — it chooses which shape '
        + 'of the SAME grid goes into kf_rf_soll, and with ALPHA-N off nothing goes in at all.',
    shapeReady: 'Chooses WHAT ALPHA-N writes. Off, it writes the tuned map as measured. On, it '
        + 'writes the tuned map with the low-opening repair applied — the repaired cells are '
        + 'interpolated between measured ones, so they carry no measurement of their own.',

    rfKorr: {
        noEgtTables: 'Needs the binary\'s EGT tables — they did not decode from these bytes, so '
            + 'there is nothing to derive against.',
        needsPatch: 'Needs a log recorded with the PATCH on (k_rf_cfg = 0x02). With MAP '
            + 'compensation live, RF carries the integrator on top and rf_korr cannot be pinned to '
            + 'a few percent.',
        needsLog: 'Needs a log first — the table is back-calculated from one. Record a run '
            + '(START TUNE) or load one.',
        allDropped: 'Every sample was removed by the log filter before the table could see one. '
            + 'Loosen RAW FILTER — the drop census on the CORRECTED LOG tab says which test took them.',
        noEgt: 'This log carries no exhaust temperature (TABG). Δ picks the row of the table and '
            + 'has no other non-circular source.',
        noTrim: 'This log carries no lambda trim (la_f_regler). The record shows how much the DME '
            + 'corrected, but only the trim shows whether that correction was right.',
        tooFewCells: 'Too few cells cleared their evidence thresholds to be worth writing — see '
            + 'the RF KORR tab for the per-cell reasons.',
    },

    trimNeutral: 'LAA_F is bit-exact 1.0000 and the K_LAA_TMOT window in this binary is empty, so '
        + 'neither long-term store can have learned. The short-term trim is the whole standing '
        + 'error and the derivations may take it at face value.',
    trimLearned: (worst) => `The DME's long-term fuel store has learned (LAA_F ${worst} against `
        + '1.0000 at init). The additive store beside it learns at idle and cannot be read on this '
        + 'DME, so the derivation would under-read by an unknown amount — up to 20 % of an idle '
        + 'pulse. Clear the adaptations, arm PATCH so neither store can learn again, and drive again.',
    trimNoChannel: 'This log has no long-term trim: the car refused the RAM read and the run fell '
        + 'back to block 19, which carries the short-term pair alone. The derivation assumes both '
        + 'long-term stores sit at init and cannot check it here. Re-run the log to retry the RAM '
        + 'route, or accept the assumption knowingly.',
    trimWindowOpen: (frozenUnread) => 'The long-term store reads 1.0000, but this binary leaves the '
        + `learners enabled (K_LAA_TMOT_MIN ${frozenUnread ? 'unread' : 'below MAX'}), so it can `
        + 'move during a run. Arm PATCH to freeze both stores before recording the log this map is '
        + 'derived from.',

    idleSealed: 'Sealed. The target (KF_LLR_QVS_GRUND) has no consumer in this calibration — '
        + 'cfg_m.egas = 0 routes lls_tv_calc from the torque path, and LLR_QSOLL has one absolute '
        + 'reference in the whole image, its own write. Writing it changes nothing.',
    inertiaProposal: 'The inertia run proposes constants and writes nothing — apply them by hand '
        + 'from its panel.',

    restoreNeedsBinary: 'Load a binary first — this writes the reference table over what is in it.',
    restoreVeLockedByTune: 'ALPHA-N or SHAPE is armed on this same table. A tune and the stock '
        + 'table cannot both go into kf_rf_soll in one flash — disarm them to restore it.',
    restoreWarmupLockedByWrite: 'WRITE WARMUP is armed on this same table. Disarm it to restore '
        + 'the reference instead.',
    restoreAlreadyStock: 'All 480 cells already match the CSL 0401 reference. Nothing to restore; '
        + 'arming this writes the same bytes back.',
    restoreVeDrift: (n) => `${n} of 480 cells differ from the CSL 0401 reference. Arming this puts `
        + 'the whole table back — every campaign that ever wrote these bytes, not just this '
        + 'session. The reference is the community partial this app ships, checked cell for cell.',
    restoreWarmupDrift: (n) => `${n} of 480 cells differ from the CSL 0401 reference. This is the `
        + 'CATALYST-WARMUP table, on its own axes (600-4600 rpm) — a different table from the one '
        + 'above it, not a band of it.',

    wotNeedsBinary: 'Load a binary first — this compares the bytes against the community reference.',
    wotStock: 'KF_TI_N_RF_VL matches the community reference. Nothing to restore; arming this '
        + 'writes the same bytes back.',
    wotDrift: (implied) => 'KF_TI_N_RF_VL has DRIFTED from the community reference. Full-load '
        + 'mixture is lambda = 1 / (rf_korr x this table), so the loaded bytes imply '
        + `${implied} against the reference's 1.05 / 0.88 / 0.93 / 0.94 / 0.82 / 0.85 / 0.87 / `
        + '0.96 / 0.91 / 0.88 / 0.78 / 0.77 / 0.84 / 0.81 / 0.83 / 0.83 / 0.82 / 0.82 across '
        + '700-8000 rpm.\n\nNothing derives this table from a log. The VE correction is already '
        + 'the fuel correction — scaling this one by the same ratio applies it twice and the '
        + 'mixture goes lean by that ratio squared. Arm this to put the reference back.',

    needBinary: 'Load a binary first.',
    tankVentNote: 'Armed by PATCH. Holds the evaporative purge valve shut (K_TE_TVTE_GA = 0 at '
        + 'slave 0xBF1). Purged vapour is fuel the DME did not inject, so the lambda trim absorbs '
        + 'it — and that trim is the only input the VE correction has. TUNING ONLY: the canister '
        + 'saturates, and DTC 24 is the code for a valve that will not open. Turn PATCH off and '
        + 'write once more before driving the tune. The filename carries _TEVOFF while it is armed.',

    calLockedByWriter: owner => `${owner} is armed on these same bytes and writes the whole run. `
        + 'Disarm it, or revert this edit — writing both into one flash is not a request with an answer.',
    calEditNote: 'A CALIBRATION tab edit. ON: the next download / flash carries these cells. '
        + 'OFF: the edit is kept on screen and nothing is written. Revert it from the tab itself.',
};

const JA: ManifestCopy = {
    info: '説明',
    captionWrite: '次のダウンロード / フラッシュに入るもの',
    captionRestore: 'テーブルを CSL 0401 の参照値に戻す',
    captionPatch: 'DME のロジックそのものを書き換える',

    restoreVeLocksAlphaN: 'RESTORE VE が同じテーブルに arm されています。あちらは kf_rf_soll 全体を'
        + '純正値で書きます。このバイトにチューンを書くなら、RESTORE 側を外してください。',
    restoreVeLocksShape: 'RESTORE VE が同じテーブルに arm されています。あちらは kf_rf_soll 全体を'
        + '純正値で書きます。このセルを書くなら、RESTORE 側を外してください。',
    restoreWarmupLocksWarmup: 'RESTORE WARMUP が同じテーブル（kf_rf_soll_kath）に arm されています。'
        + '導出したテーブルを書くなら、RESTORE 側を外してください。',

    derivedTablesLocked: 'チューン後のマップが必要です。ログを読み込んでチューンを実行してください — '
        + 'このテーブルはその結果から生成されるもので、単独で測定されるものではありません。',
    alphaNEarnedNothing: 'ログは読めましたが、どちらの帯でも証拠のしきい値を満たしたセルがありません。'
        + 'どのゲートが各セルを弾いたかは LOW LOAD タブが挙げています。',
    shapeNothingApplied: 'ALPHA-N が何を書くかを選ぶスイッチです。OFF なら測定したままのチューン後マップ、'
        + 'ON なら低開度の補修を適用したチューン後マップを書きます。まだ何も適用されていません — '
        + 'SHAPE タブを開き、ルールを1つ有効にして APPLY を押してください。',
    shapeNeedsAlphaN: 'ALPHA-N を arm する必要があります。これは別のテーブルではなく、'
        + '同じグリッドのどちらの形を kf_rf_soll に入れるかを選ぶものです。ALPHA-N が OFF なら'
        + 'そもそも何も入りません。',
    shapeReady: 'ALPHA-N が何を書くかを選ぶスイッチです。OFF なら測定したままのチューン後マップ。'
        + 'ON なら低開度の補修を適用したチューン後マップ — 補修されたセルは測定済みのセルの間を'
        + '内挿した値なので、それ自体は測定を持ちません。',

    rfKorr: {
        noEgtTables: 'バイナリ内の EGT テーブルが必要です。このバイトからは復号できなかったので、'
            + '突き合わせる相手がありません。',
        needsPatch: 'PATCH を有効（k_rf_cfg = 0x02）にして録ったログが必要です。MAP 補償が生きていると '
            + 'RF に積分器が上乗せされ、rf_korr を数 % の精度で特定できません。',
        needsLog: 'まずログが必要です。このテーブルはログから逆算します。走行を記録（START TUNE）するか、'
            + 'ログを読み込んでください。',
        allDropped: 'テーブルが1サンプルも見ないうちに、ログフィルターが全サンプルを除外しました。'
            + 'RAW FILTER を緩めてください — どのテストが落としたかは CORRECTED LOG タブの drop census が'
            + '示します。',
        noEgt: 'このログには排気温度（TABG）がありません。Δ はテーブルの行を決める量で、'
            + 'これ以外に循環しない情報源がありません。',
        noTrim: 'このログにはラムダトリム（la_f_regler）がありません。記録は DME がどれだけ補正したかを'
            + '示しますが、その補正が正しかったかを示すのはトリムだけです。',
        tooFewCells: '証拠のしきい値を越えたセルが、書き込むに値するほどありません — '
            + 'セルごとの理由は RF KORR タブにあります。',
    },

    trimNeutral: 'LAA_F はビット完全に 1.0000 で、このバイナリの K_LAA_TMOT 窓は空です。つまり'
        + '長期学習はどちらも動けません。定常誤差は短期トリムがすべて背負っているので、'
        + '導出はそれをそのまま信用してかまいません。',
    trimLearned: (worst) => `DME の長期燃料補正が学習しています（LAA_F ${worst}、初期値は 1.0000）。`
        + '隣にある加算型の補正はアイドルで学習し、この DME からは読めません。したがって導出は'
        + '不明な量だけ過少に読みます — アイドル噴射パルスの最大 20 % です。'
        + 'アダプテーションをクリアし、どちらも再学習できないよう PATCH を arm して、走り直してください。',
    trimNoChannel: 'このログには長期トリムがありません。車が RAM 読みを拒否し、短期トリムだけを運ぶ'
        + 'ブロック 19 にフォールバックしています。導出は長期補正が2つとも初期値にあると仮定しますが、'
        + 'ここではそれを確認できません。ログを録り直して RAM ルートを再試行するか、'
        + '仮定を承知のうえで受け入れてください。',
    trimWindowOpen: (frozenUnread) => '長期補正は 1.0000 を示していますが、このバイナリは学習器を'
        + `有効なままにしています（K_LAA_TMOT_MIN が${frozenUnread ? '未読' : ' MAX を下回っています'}）。`
        + 'つまり走行中に動きえます。このマップを導出するログを録る前に、PATCH を arm して'
        + '両方の補正を凍結してください。',

    idleSealed: '封印されています。書き込み先（KF_LLR_QVS_GRUND）にはこのキャリブレーション内で'
        + '読み手がいません — cfg_m.egas = 0 が lls_tv_calc をトルク経路から回し、LLR_QSOLL への'
        + '絶対参照はイメージ全体で自身への書き込み1箇所だけです。書いても何も変わりません。',
    inertiaProposal: 'イナーシャ計測は定数を提案するだけで、何も書き込みません。'
        + '専用パネルから手作業で反映してください。',

    restoreNeedsBinary: 'まずバイナリを読み込んでください — これは今あるテーブルの上に参照値を'
        + '書き込みます。',
    restoreVeLockedByTune: 'ALPHA-N か SHAPE が同じテーブルに arm されています。1回のフラッシュで '
        + 'kf_rf_soll にチューンと純正値の両方を入れることはできません。戻すなら、そちらを外してください。',
    restoreWarmupLockedByWrite: 'WRITE WARMUP が同じテーブルに arm されています。'
        + '参照値に戻すなら、そちらを外してください。',
    restoreAlreadyStock: '480 セルすべてが既に CSL 0401 の参照値と一致しています。戻すものはありません。'
        + 'arm しても同じバイトを書き直すだけです。',
    restoreVeDrift: (n) => `480 セル中 ${n} セルが CSL 0401 の参照値と異なります。arm すると`
        + 'テーブル全体が戻ります — このセッションの分だけでなく、これまでにこのバイトを書いた'
        + 'すべてのキャンペーンの分が戻ります。参照値はこのアプリが同梱している community partial で、'
        + 'セル単位で照合済みです。',
    restoreWarmupDrift: (n) => `480 セル中 ${n} セルが CSL 0401 の参照値と異なります。これは`
        + '触媒暖機用のテーブルで、独自の軸（600〜4600 rpm）を持ちます — 上の行のテーブルの一部分ではなく、'
        + '別のテーブルです。',

    wotNeedsBinary: 'まずバイナリを読み込んでください — これはバイトを community の参照値と'
        + '突き合わせます。',
    wotStock: 'KF_TI_N_RF_VL は community の参照値と一致しています。戻すものはありません。'
        + 'arm しても同じバイトを書き直すだけです。',
    wotDrift: (implied) => 'KF_TI_N_RF_VL が community の参照値からずれています。全開時の混合比は '
        + 'lambda = 1 /（rf_korr × このテーブル）なので、読み込んだバイトが意味するのは '
        + `${implied} で、参照値は 700〜8000 rpm にわたって 1.05 / 0.88 / 0.93 / 0.94 / 0.82 / `
        + '0.85 / 0.87 / 0.96 / 0.91 / 0.88 / 0.78 / 0.77 / 0.84 / 0.81 / 0.83 / 0.83 / 0.82 / 0.82 '
        + 'です。\n\nこのテーブルをログから導出するものは何もありません。VE 補正が既に燃料補正そのもので、'
        + 'このテーブルを同じ比率でスケールすると補正が二重にかかり、その比率の2乗ぶん混合比が薄くなります。'
        + '参照値に戻すには、これを arm してください。',

    needBinary: 'まずバイナリを読み込んでください。',
    tankVentNote: 'PATCH と同時に arm されます。蒸発ガスのパージバルブを閉じたままにします'
        + '（slave 0xBF1 の K_TE_TVTE_GA = 0）。パージされた蒸気は DME が噴射していない燃料なので、'
        + 'ラムダトリムがそれを吸収します — そしてそのトリムが VE 補正の唯一の入力です。'
        + 'チューニング専用: キャニスターは飽和し、DTC 24 は「バルブが開かない」のコードです。'
        + 'チューンで走る前に PATCH を切ってもう一度書き込んでください。arm されている間、'
        + 'ファイル名に _TEVOFF が付きます。',

    calLockedByWriter: owner => `${owner} が同じバイトに arm されていて、ラン全体を書きます。`
        + 'あちらを外すか、この編集を revert してください — 両方を1回のフラッシュに書く、という'
        + '要求には答えがありません。',
    calEditNote: 'CALIBRATION タブの編集です。ON: 次のダウンロード / フラッシュにこのセルが'
        + '入ります。OFF: 編集は画面に残り、何も書かれません。取り消しはタブ側の REVERT から。',
};

export const MANIFEST_TEXT: Record<DialogLang, ManifestCopy> = { ja: JA, en: EN };
