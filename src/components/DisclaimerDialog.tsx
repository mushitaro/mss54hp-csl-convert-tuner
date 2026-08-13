import React, { useState } from 'react';
import { AlertTriangle, Check } from 'lucide-react';
import { useDialogLang } from '@/hooks/useDialogLang';
import { privacyPolicyUrl } from '@/config/links';

interface Props {
    /** 「同意して続ける」を押した時に呼ばれる。dontShowAgain が真なら次回以降は非表示にする。 */
    onAccept: (dontShowAgain: boolean) => void;
}

// 表示言語ごとの文言。強調キーワードは span で色付けするため、本文は文字列ではなく JSX で保持する。
const TEXT = {
    ja: {
        title: '免責事項',
        intro: '本ソフトウェア(以下「本ツール」)は、BMW E46 M3 / S54 系エンジンの DME(エンジン制御ユニット) データを解析・編集・書き込みする実験的なツールです。ご利用の前に、以下すべてにご同意ください。',
        bullets: [
            <>本ツールによる DME データの変更・書き込みは、エンジン・駆動系・車両その他に<span className="text-slate-100 font-bold">重大な損傷</span>を与える可能性があります。すべて<span className="text-red-400 font-bold">自己責任</span>でご利用ください。</>,
            <>本ツールは<span className="text-slate-100 font-bold">現状有姿・無保証</span>で提供されます。作者および貢献者は、本ツールの使用または使用不能に起因するいかなる損害についても<span className="text-red-400 font-bold">一切責任を負いません</span>。</>,
            <>チューニングは競技・オフロード等、<span className="text-slate-100 font-bold">法令で認められた用途</span>に限られます。公道走行・排出ガス・保安基準その他の<span className="text-slate-100 font-bold">法令適合は利用者の責任</span>です。</>,
            <>書き込み前に必ず純正データ(BASE)の<span className="text-slate-100 font-bold">バックアップ</span>を保管してください。</>,
            <><span className="text-slate-100 font-bold">バッテリー電圧と通信が安定した環境</span>で作業してください。書き込み中の中断は DME を破損させる恐れがあります。</>,
        ],
        agreeNote: '「同意して続ける」を押した場合、上記に同意したものとみなします。',
        privacy: 'プライバシーポリシー',
        dontShow: '今後表示しない',
        agree: '同意して続ける',
    },
    en: {
        title: 'DISCLAIMER',
        intro: 'This software (the "Tool") is an experimental utility for reading, editing, and writing the DME (engine control unit) data of the BMW E46 M3 / S54 engine. Before using it, you must agree to all of the following.',
        bullets: [
            <>Changing or writing DME data with this Tool may cause <span className="text-slate-100 font-bold">serious damage</span> to the engine, drivetrain, vehicle, and beyond. Use it entirely <span className="text-red-400 font-bold">at your own risk</span>.</>,
            <>This Tool is provided <span className="text-slate-100 font-bold">as-is, without warranty</span>. The author and contributors accept <span className="text-red-400 font-bold">no liability whatsoever</span> for any damage arising from its use or inability to be used.</>,
            <>Tuning is limited to <span className="text-slate-100 font-bold">legally permitted uses</span> such as competition and off-road. <span className="text-slate-100 font-bold">Legal compliance</span> for public-road use, emissions, and safety standards is the user's responsibility.</>,
            <>Always keep a <span className="text-slate-100 font-bold">backup</span> of the stock data (BASE) before writing.</>,
            <>Work only with <span className="text-slate-100 font-bold">stable battery voltage and a stable connection</span>. Interrupting a write can damage the DME.</>,
        ],
        agreeNote: 'Clicking "Agree & Continue" is taken as your acceptance of the above.',
        privacy: 'Privacy Policy',
        dontShow: "Don't show again",
        agree: 'Agree & Continue',
    },
};

/**
 * アクセス時に一度だけ提示する免責事項ダイアログ。
 *
 * 明示的同意を必須とするため、AdaptationResetDialog と違い背景クリック・× ・ESC では閉じない
 * (背景 div に onClick を付けず、閉じるボタンも置かない)。閉じる経路は「同意して続ける」のみ。
 * 表示可否と「今後表示しない」の永続化は useDisclaimer フックが持ち、ここは UI と同意操作だけを担う。
 * 表示言語(JA/EN)は useDialogLang で全ダイアログ共有。
 */
export const DisclaimerDialog: React.FC<Props> = ({ onAccept }) => {
    const [dontShowAgain, setDontShowAgain] = useState(false);
    const lang = useDialogLang();
    const t = TEXT[lang];

    return (
        <>
            {/* 背景: onClick なし = クリックしても閉じない。操作を確実にブロックする。 */}
            <div className="fixed inset-0 z-[100] bg-slate-950/70 backdrop-blur-sm" />
            <div
                role="dialog"
                aria-modal="true"
                aria-labelledby="disclaimer-title"
                // Same geometry rule as DialogFrame: capped to the viewport so a portrait phone does
                // not lose the ACCEPT button off the edge, and dvh so Android's browser chrome does
                // not sit on top of it. This is the gate to the whole app — if it does not fit, the
                // app does not open.
                className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[min(560px,calc(100vw-2rem))] max-h-[85dvh] flex flex-col bg-slate-900 border border-slate-700 rounded-lg shadow-xl z-[110] p-4 animate-in fade-in zoom-in-95 duration-200"
            >
                <div className="flex items-center gap-2 mb-4 border-b border-slate-800 pb-2 shrink-0">
                    <AlertTriangle className="w-3.5 h-3.5 text-red-400" />
                    <h3 id="disclaimer-title" className="text-xs font-bold text-slate-300 uppercase tracking-widest">
                        {t.title}
                    </h3>
                </div>

                <div className="flex-1 overflow-y-auto -mx-1 px-1 text-[12px] leading-relaxed text-slate-300 space-y-3">
                    <p>{t.intro}</p>
                    <ul className="space-y-2">
                        {t.bullets.map((bullet, i) => (
                            <li key={i} className="flex gap-2">
                                <span className="text-slate-600 shrink-0">—</span>
                                <span>{bullet}</span>
                            </li>
                        ))}
                    </ul>
                    <p className="text-[11px] text-slate-500">{t.agreeNote}</p>
                    {/* リンク名だけを置き、「同意したものとみなします」の類は書き足さない。この
                        ダイアログの同意対象はあくまで上の免責 5 項目であり、ポリシーへの同意まで
                        黙って増やさないため。読みたい人のための導線であって、同意の一部ではない。
                        別タブで開くのは、書き込み中や収録中にここへ来た場合に現在のタブを
                        遷移させないため。 */}
                    <p>
                        <a
                            href={privacyPolicyUrl(lang)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[11px] text-blue-400 hover:text-blue-300 underline underline-offset-2 transition-colors"
                        >
                            {t.privacy}
                        </a>
                    </p>
                </div>

                <div className="shrink-0 pt-3 mt-3 border-t border-slate-800 flex items-center justify-between gap-4">
                    <label className="py-3 -my-3 flex items-center gap-2 cursor-pointer text-[11px] text-slate-400 uppercase tracking-wider select-none">
                        <input
                            type="checkbox"
                            checked={dontShowAgain}
                            onChange={e => setDontShowAgain(e.target.checked)}
                            className="w-3 h-3 accent-blue-500 rounded bg-slate-700 border-none"
                        />
                        <span>{t.dontShow}</span>
                    </label>
                    <button
                        onClick={() => onAccept(dontShowAgain)}
                        className="bg-blue-600 hover:bg-blue-500 text-white text-[11px] font-bold uppercase tracking-widest px-4 py-2 rounded flex items-center gap-1.5 transition-colors"
                    >
                        <Check className="w-3 h-3" />
                        {t.agree}
                    </button>
                </div>
            </div>
        </>
    );
};
