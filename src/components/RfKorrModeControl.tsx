'use client';

import React from 'react';
import { RfKorrMode } from '@/lib/types';
import { useDialogLang } from '@/hooks/useDialogLang';

/**
 * The one question this control answers: **which rf_korr does the VE derivation divide out, and
 * does a new table get written to the binary?**
 *
 * ## Two wrong framings, and why the second was worse than the first
 *
 * It shipped as NOMINAL / AS-LOGGED / TUNED — the words `LogFilterConfig` stores and the ECU-logic
 * notes are written in. Fair complaint: `AS-LOGGED` names the DERIVATION ("built as the log came")
 * and the reader has to work backwards from that.
 *
 * The fix made it worse. Relabelling to NOMINAL EGT / LOGGED EGT / MEASURED EGT forced three
 * options onto one axis — "what exhaust temperature does the table assume" — and that axis does not
 * exist. **TUNED also produces a nominal-EGT table**: it converges on `old × anchor`, and the anchor
 * is the trim at nominal exhaust temperature, which is exactly what NOMINAL produces. So "MEASURED
 * EGT" named a difference that is not the difference, and the words stopped matching the thing.
 *
 * What actually separates them is which rf_korr comes out of the log on the way into the VE table:
 *
 *     DME TABLE          new = old x STFT x rf_korr            table NOT written
 *     LEAVE IN           new = old x STFT                      table NOT written
 *     DERIVED + WRITE    new = old x STFT x rf_korr / k_new     table WRITTEN
 *
 * NOMINAL and DERIVED differ in *whose* correction is trusted — BMW's, as it sits in the binary,
 * versus one back-calculated from this log and written back over it. That is the choice, and it is
 * the one thing the old labels never said out loud.
 *
 * ## This is NOT about where ΔTABG comes from
 *
 * Reasonable guess, and no. Δ for everything that reaches the binary is the **sensor**:
 * `rfKorrTuner` takes `tabgDelta`, which `annotateRfKorr` computes as
 * `tabgModel(rpm, RF) - exhaustTemp`. The inversion of the correction curve is display-only — it is
 * defined over 45 % of the rpm axis, which is why it is a diagnostic column and never an input.
 *
 * ## Why the canonical names stay
 *
 * `NOMINAL` / `AS-LOGGED` / `TUNED` are what a saved session stores in `rfKorrMode` and what
 * docs/ecu-logic is written in. Renaming those would strand anyone who read the notes first, so
 * they are shown beside the selection and on every button's title instead.
 */

interface Choice {
    id: RfKorrMode;
    en: string;
    ja: string;
    /** The update the choice actually performs. Shown under the buttons, because a formula is the
     *  one description of this that cannot drift away from what the code does. */
    formula: string;
}

/** In the order they escalate: safe default, opt-out, opt-in-with-a-write. */
const CHOICES: Choice[] = [
    { id: 'nominal', en: 'DME TABLE', ja: 'DME の表', formula: 'VE′ = VE × STFT × rf_korr' },
    { id: 'as-logged', en: 'LEAVE IN', ja: '外さない', formula: 'VE′ = VE × STFT' },
    { id: 'tuned', en: 'DERIVED + WRITE', ja: '逆算＋書込', formula: 'VE′ = VE × STFT × rf_korr ÷ k_new' },
];

/** The word the settings, the docs and the ECU-logic notes use. */
const CANONICAL: Record<RfKorrMode, string> = {
    nominal: 'NOMINAL',
    'as-logged': 'AS-LOGGED',
    tuned: 'TUNED + WRITE',
};

const TEXT = {
    ja: {
        heading: 'VE の導出で rf_korr をどう扱うか',
        nominal: 'BIN にある KF_RF_KORR_DRREL をそのまま信用し、その分を VE から外します。'
            + 'VE テーブルは「補正が掛かる前の充填」を持ち、走行中の補正は DME 側が受け持ちます。'
            + '**表は書き換えません。DME の補正は今のままです。**（推奨）',
        asLogged: 'rf_korr を VE から外しません。ログを取った時の排気温での充填が、そのまま VE に焼き込まれます。'
            + 'DME はその上からさらに補正を掛けるので、排気温がログと違えば同じ効果を二重に数えます。'
            + 'BMW の密度モデルがこのエンジンに合っていない、と判断したときだけの選択肢です。**表は書き換えません。**',
        tuned: 'このセッションのログから KF_RF_KORR_DRREL を逆算し、**DME の表ではなくそちら**で VE から外します。'
            + 'そして **逆算した表を BIN に書き込みます**。VE テーブルは BMW の密度モデルではなく、'
            + 'この車で実測した密度効果の上に乗ります。',
        tunedWhy: '書き込みと VE 反映は分けられません。逆算した表を書かずに VE だけ更新すると、'
            + 'DME は元の表を掛け続けるので差分がそのまま残ります（純正ピークで最大 −27 %、リーン側）。',
        locked: '「逆算＋書込」を選ぶには、BIN のテーブルが読めていること・ログに排気温(EGT)があること・'
            + '逆算が成立していること・ログが PATCH ON で取られていることが必要です。',
        writes: 'BIN の KF_RF_KORR_DRREL',
        writesNo: '書き換えない',
        writesYes: '書き換える',
        canonical: '設定・ドキュメント上の名前',
        delta: 'Δ は常にセンサ実測（モデル温度 − 実測 TABG）です。この 3 択は Δ の出どころではなく、'
            + '「どの rf_korr で割るか」と「表を書くか」を選びます。',
    },
    en: {
        heading: 'What the VE derivation does with rf_korr',
        nominal: 'Trust the KF_RF_KORR_DRREL already in the binary and divide its effect out of the VE '
            + 'table. The table then holds filling before any correction, and the DME supplies the '
            + 'correction at runtime. **The table is not rewritten — the DME\'s correction stays as it '
            + 'is.** (recommended)',
        asLogged: 'Do not divide rf_korr out. Filling at the exhaust temperature the log happened to sit '
            + 'at is baked straight into the VE table, and the DME still applies its correction on top — '
            + 'so the same effect is counted twice whenever the exhaust moves away from where the log '
            + 'was. Only worth choosing if BMW\'s density model does not match this engine. **The table '
            + 'is not rewritten.**',
        tuned: 'Back-calculate KF_RF_KORR_DRREL from this session\'s log and divide by **that** instead of '
            + 'the DME\'s table — then **write the derived table into the binary**. The VE table ends up '
            + 'resting on the density effect measured on this car rather than on BMW\'s model.',
        tunedWhy: 'The write and the VE update are not separable. Updating the VE map without writing the '
            + 'derived table leaves the DME applying the old one, so the difference survives intact — up '
            + 'to −27 % at the stock peak, on the lean side.',
        locked: 'DERIVED + WRITE needs the binary\'s tables to decode, an EGT channel in the log, a '
            + 'back-calculation that met its evidence thresholds, and a log recorded with the PATCH on.',
        writes: 'KF_RF_KORR_DRREL in the binary',
        writesNo: 'left alone',
        writesYes: 'rewritten',
        canonical: 'name used in settings and docs',
        delta: 'Δ is always the sensor\'s (model temperature minus measured TABG). This choice is not about '
            + 'where Δ comes from — it is which rf_korr to divide by, and whether to write a table.',
    },
};

export const RfKorrModeControl: React.FC<{
    mode: RfKorrMode;
    onChange: (mode: RfKorrMode) => void;
    /** Whether DERIVED + WRITE may be chosen. False disables it and says why. */
    canTune: boolean;
    readOnly?: boolean;
}> = ({ mode, onChange, canTune, readOnly = false }) => {
    const lang = useDialogLang();
    const t = TEXT[lang];
    const prose = mode === 'as-logged' ? t.asLogged : mode === 'tuned' ? t.tuned : t.nominal;
    const selected = CHOICES.find(c => c.id === mode)!;
    const writes = mode === 'tuned';

    /** `**bold**` in the prose above, so the one clause that says whether the ECU's own table
     *  changes is not buried mid-paragraph. Cheaper than splitting every string in two. */
    const render = (text: string) => text.split(/\*\*(.+?)\*\*/g).map((part, i) => (
        i % 2 === 1 ? <strong key={i} className="text-slate-400 font-bold">{part}</strong> : part
    ));

    return (
        <div className="space-y-1">
            <div className="flex justify-between items-center gap-2 text-[10px] text-slate-500 uppercase tracking-wider">
                <span>{t.heading}</span>
                {/* The canonical word, small and to one side. It is what a saved session stores and
                    what the ECU-logic notes are written in, so it has to stay findable — but it is
                    not what the buttons should be teaching. */}
                <span
                    title={t.canonical}
                    className={`font-mono shrink-0 ${mode === 'as-logged' ? 'text-red-400'
                        : mode === 'tuned' ? 'text-amber-400' : 'text-slate-400'}`}
                >
                    {CANONICAL[mode]}
                </span>
            </div>
            <div className="flex gap-1">
                {CHOICES.map(choice => {
                    const locked = choice.id === 'tuned' && !canTune;
                    return (
                        <button
                            key={choice.id}
                            type="button"
                            disabled={readOnly || locked}
                            onClick={() => onChange(choice.id)}
                            title={`${choice.formula}\n${CANONICAL[choice.id]} — ${t.canonical}`}
                            // min-h-10, not padding alone. The checkboxes around this reach a 38px
                            // target with `py-3 -my-3` — a big hit area behind a small mark — but a
                            // segmented control has no separate mark to keep small, so it just gets
                            // the height. Measured at 26px before this.
                            className={`flex-1 min-h-10 px-1 text-[9px] font-bold tracking-wider rounded ${mode === choice.id
                                ? 'bg-blue-600 text-white'
                                : locked
                                    ? 'bg-slate-900 text-slate-700 cursor-not-allowed'
                                    : 'bg-slate-800 text-slate-400 hover:text-slate-200'}`}
                        >
                            {choice[lang]}
                        </button>
                    );
                })}
            </div>

            {/* The update itself. A label can drift away from what the code does; this cannot, and
                it is the shortest complete answer to "what does this option actually mean". */}
            <p className="font-mono text-[9px] text-slate-500 pt-0.5">{selected.formula}</p>

            {/* Does the ECU's own table change? That is the half of this choice the previous labels
                never mentioned, and it is the half that reaches the car. */}
            <p className="text-[9px]">
                <span className="text-slate-600">{t.writes}: </span>
                <span className={writes ? 'text-amber-400 font-bold' : 'text-slate-500'}>
                    {writes ? t.writesYes : t.writesNo}
                </span>
            </p>

            <p className="text-[9px] text-slate-600 leading-snug">{render(prose)}</p>
            {mode === 'tuned' && <p className="text-[9px] text-amber-500/80 leading-snug">{t.tunedWhy}</p>}
            {!canTune && <p className="text-[9px] text-slate-700 leading-snug">{t.locked}</p>}
            <p className="text-[9px] text-slate-700 leading-snug">{t.delta}</p>
        </div>
    );
};
