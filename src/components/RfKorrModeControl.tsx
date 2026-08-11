'use client';

import React from 'react';
import { RfKorrMode } from '@/lib/types';
import { useDialogLang } from '@/hooks/useDialogLang';

/**
 * The one question this control answers: **what exhaust temperature does the VE table you are about
 * to build assume?**
 *
 * ## Why the labels changed
 *
 * They were NOMINAL / AS-LOGGED / TUNED — the words the stored TuneSettings and the docs use, which
 * is a good reason to keep them somewhere and a bad reason to put them on the buttons. "AS-LOGGED"
 * describes the DERIVATION (the map was built as the log came) and the reader has to work backwards
 * from that to the thing they actually care about. Reported, fairly, as not being plain language.
 *
 * So the buttons name the ANSWER instead, and the three are parallel because the choice is one
 * variable with three settings:
 *
 *   NOMINAL EGT   the map holds filling at nominal exhaust temperature; the DME's own correction
 *                 supplies the rest at runtime. A map tuned on a cold drive stays right when hot.
 *   LOGGED EGT    the map holds filling at whatever exhaust temperature the log happened to be at,
 *                 baked in. The DME then applies its correction ON TOP of that, so the same effect
 *                 is counted twice once the exhaust moves away from where the log sat.
 *   MEASURED EGT  the correction table is back-calculated from this log, divided out, and written
 *                 into the binary. The map then rests on the measured density effect, not BMW's.
 *
 * The canonical mode name is still on every button's `title` and at the end of the prose, so the
 * link to docs/ecu-logic and to a stored session's settings survives the rename.
 *
 * ## Why it is a component rather than markup in one panel
 *
 * It is rendered twice — in the RF KORR tab, where a reader goes looking for anything RF KORR, and
 * in the filter popover, where the session's other reproducible settings live. Two mount points,
 * one definition and one piece of state, so they cannot come to disagree; and the second is not
 * redundant, because the choice between the first two modes is meaningful on a log with an RF
 * channel and no exhaust probe, which is exactly when the RF KORR tab does not exist.
 */

interface Choice {
    id: RfKorrMode;
    en: string;
    ja: string;
}

/** In the order they escalate: safe default, opt-out, opt-in-with-a-write. */
const CHOICES: Choice[] = [
    { id: 'nominal', en: 'NOMINAL EGT', ja: '公称排気温' },
    { id: 'as-logged', en: 'LOGGED EGT', ja: 'ログの排気温' },
    { id: 'tuned', en: 'MEASURED EGT', ja: '実測排気温' },
];

/** The word the settings, the docs and the ECU-logic notes use. Kept visible so the rename does not
 *  strand anyone who read those first. */
const CANONICAL: Record<RfKorrMode, string> = {
    nominal: 'NOMINAL',
    'as-logged': 'AS-LOGGED',
    tuned: 'TUNED + WRITE',
};

const TEXT = {
    ja: {
        heading: 'VE テーブルが前提とする排気温',
        nominal: 'VE テーブルは「公称排気温での充填」を持ちます。排気温の補正は DME 側が走行中に掛けるので、'
            + '排気が冷えたログで作ったマップが、温まった後も正しいままになります（推奨）。',
        asLogged: 'VE テーブルに「ログを取った時の排気温での充填」がそのまま焼き込まれます。'
            + 'DME はその上からさらに補正を掛けるので、排気温がログと違うと同じ効果を二重に数えます。'
            + 'BMW の密度モデルがこのエンジンに合っている場合のみ正しく、合っていないと排気が温まった時にリーン側に外れます。',
        tuned: 'ログから KF_RF_KORR_DRREL を逆算し、それで割ってから VE を更新し、'
            + 'その表を BIN にも書き込みます。VE テーブルは「純正の密度モデル」ではなく「実測した密度効果」を前提にした値になります。'
            + '片方だけでは成立しないため、書き込みは同時に行われます。',
        tunedWhy: '逆算した表を書かずに VE だけ更新すると、DME は元の表を掛け続けるので差分がそのまま残ります'
            + '（純正ピークで最大 −27 %、リーン側）。',
        locked: '実測排気温を選ぶには、BIN のテーブルが読めていること・ログに排気温(EGT)があること・'
            + '逆算が成立していること・ログが PATCH ON で取られていることが必要です。',
        canonical: '設定・ドキュメント上の名前',
    },
    en: {
        heading: 'Exhaust temperature the VE table assumes',
        nominal: 'The VE table holds filling at NOMINAL exhaust temperature, and the DME applies its own '
            + 'correction on top at runtime — so a map tuned on a cold-exhaust drive stays right once things '
            + 'heat up (recommended).',
        asLogged: 'The VE table bakes in the exhaust temperature the log happened to sit at. The DME still '
            + 'applies its correction on top, so the same effect is counted twice whenever the exhaust moves '
            + 'away from where the log was. Only correct if BMW\'s density model matches this engine; if it '
            + 'does not, the map goes lean under load once the exhaust warms up.',
        tuned: 'Back-calculate KF_RF_KORR_DRREL from this log, divide by it before updating the VE map, and '
            + 'write that table into the binary as well. The VE table then rests on the density effect '
            + 'actually measured rather than on BMW\'s model. The write is not separable — neither half is '
            + 'correct alone.',
        tunedWhy: 'Updating the VE map without writing the derived table leaves the DME applying the old one, '
            + 'so the difference survives intact — up to −27 % at the stock peak, on the lean side.',
        locked: 'MEASURED EGT needs the binary\'s tables to decode, an EGT channel in the log, a '
            + 'back-calculation that met its evidence thresholds, and a log recorded with the PATCH on.',
        canonical: 'name used in settings and docs',
    },
};

export const RfKorrModeControl: React.FC<{
    mode: RfKorrMode;
    onChange: (mode: RfKorrMode) => void;
    /** Whether MEASURED EGT may be chosen. False disables it and says why. */
    canTune: boolean;
    readOnly?: boolean;
    /** Drops the heading, for a host that already carries one. */
    compact?: boolean;
}> = ({ mode, onChange, canTune, readOnly = false, compact = false }) => {
    const lang = useDialogLang();
    const t = TEXT[lang];
    const prose = mode === 'as-logged' ? t.asLogged : mode === 'tuned' ? t.tuned : t.nominal;

    return (
        <div className="space-y-1">
            {!compact && (
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
            )}
            <div className="flex gap-1">
                {CHOICES.map(choice => {
                    const locked = choice.id === 'tuned' && !canTune;
                    return (
                        <button
                            key={choice.id}
                            type="button"
                            disabled={readOnly || locked}
                            onClick={() => onChange(choice.id)}
                            title={`${CANONICAL[choice.id]} — ${t.canonical}`}
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
            <p className="text-[9px] text-slate-600 leading-snug">{prose}</p>
            {mode === 'tuned' && <p className="text-[9px] text-amber-500/80 leading-snug">{t.tunedWhy}</p>}
            {!canTune && <p className="text-[9px] text-slate-700 leading-snug">{t.locked}</p>}
        </div>
    );
};
