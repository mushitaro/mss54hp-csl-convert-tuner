import React from 'react';
import { Heart } from 'lucide-react';
import { useDialogLang } from '@/hooks/useDialogLang';
import { DialogFrame } from './DialogFrame';
import { CREDIT_LINKS } from '@/config/links';

/**
 * Who this tool is built on, reachable from inside the app rather than only from the README.
 *
 * This exists because of a commitment made in public: karter16 noted on the forum that attribution
 * would be provided "in the code & app", and a line in a repository is only half of that. A user who
 * installs the PWA to a phone never sees the README.
 *
 * Named sources, not a thank-you. The point is that someone reading a number this tool printed can
 * find out whose work decided it — so each entry says what it supplied, and the per-claim map in
 * docs/ecu-logic/90-sources.md is linked for the rest.
 *
 * One shape for every entry, at one level of detail: **what the work was, then what in this
 * application rests on it.** Both halves, and no deeper. The entries had drifted apart — one was a
 * bare artefact with nothing resting on it, another named a specific table and a specific argument,
 * which reads as ranking the contributions rather than recording them.
 *
 * Two corrections of substance, from the operator and the docs (2026-08-24):
 *
 *   · The EGT correction, INCLUDING "do not chase λ = 1", is karter16's — 20-egt-correction.md §6
 *     attributes the rule to him and 90-sources.md dates it to thread 242281 p10-11. It had been
 *     credited to Bry5on here, which took it from the person who found it.
 *   · Bry5on's contribution is not a discussion. Every appearance of his name in these docs is a
 *     CAR: flattening KF_RF_KORR_DRREL to 1.0 and driving it, then publishing the result with a
 *     warning not to copy it (20-egt-correction.md:223); the control group for the FRA adaptation
 *     bug (40-fr-adaptation-bug.md:16); the CAN logging work and the knock-frame byte 0
 *     (90-sources.md:87-88). Evidence a disassembly cannot produce, at his own risk.
 *
 * The Japanese is written in 敬体 — 公開してくださった, 負っている, 拠ります — because a credit that
 * reads as a bibliography honours no one, and this is the one screen in the app whose whole purpose
 * is to honour someone.
 *
 * Deliberately NOT in DisclaimerDialog. That is a gate with a "don't show again" checkbox: putting
 * attribution behind it means attribution disappears the moment someone ticks the box.
 */
interface Props {
    onClose: () => void;
    /** The running build, so a bug report can name it. Already resolved by the caller. */
    buildLabel: string | null;
}

const TEXT = {
    ja: {
        title: 'CREDITS — 出典',
        close: '閉じる',
        intro: '本ツールは、先人が公開してくださった仕事の上に成り立っています。'
            + '以下に、その仕事と、本アプリのどこがそれに拠っているかを記します。',
        pavlo: 'この手順を最初に公開してくださった方です。本アプリは、その手順を自動化したものに'
            + 'すぎません —— 出発点がなければ、自動化するものもありませんでした。',
        karter16: '本ツールが最も多くを負っている方です。独立した 3 つの仕事を、'
            + 'いずれも公開の形で残してくださいました。',
        tool: 'DS2 プロトコルのリファレンス実装。本アプリの DS2 層（フレーム形式、制御バイト、'
            + 'プログラミングセグメント、ボーレート切替、適応マスク、フラッシュカウンタのレイアウト、'
            + '消去 → 書込 → 照合の手順）は、これを移植したものです。'
            + '該当する各ファイルの冒頭にその旨を記しています。',
        xdf: 'TunerPro 定義ファイル。本アプリが用いる較正アドレスとスケーリングは、'
            + 'すべてこれに由来します。',
        disasm: '0401 の逆アセンブル。排気温補正の経路、充填レギュレータ、アイドル制御、'
            + 'FRA 適応の不具合 — docs/ecu-logic/ に記した内容は、いずれもこれを根拠としています。'
            + '「この領域で λ=1 を追ってはならない」という指針も、ここから来ています。',
        bry5on: '自らの車両での実走検証と、その結果を注意喚起とともに公開してくださったこと。'
            + '逆アセンブルからは得られない、実車でしか出てこない裏付けであり、'
            + '本アプリが既定を安全側に置いているのは、こうした報告に拠ります。',
        terra: 'CSL 換装パーシャルの原型と、コミュニティがその上に重ねた初期の修正。'
            + '本アプリが読み書きする BASE は、この系譜にあるバイト列です。',
        thread: '手順が育った場所。最初の投稿のあとに積み上がった何年分もの報告と修正 —— '
            + 'その多くが、本アプリの既定値の根拠になっています。',
        fr: 'BMW / Bosch 機能仕様書 39 冊。逆アセンブルの読解は、これに拠っています。',
        sources: '各記述がどの出典に基づくかの対応表は docs/ecu-logic/90-sources.md にあります。'
            + '同文書では、コミュニティによる報告と、本解析による導出（未検証を含む）とを'
            + '区別しています。',
        build: 'ビルド',
    },
    en: {
        title: 'CREDITS',
        close: 'Close',
        intro: 'This tool is built on work that others published first. Each entry below names '
            + 'that work, and what in this application rests on it.',
        pavlo: 'Who published the method in the first place. This application is an automation '
            + 'of what he wrote and nothing more — without the starting point there would have been '
            + 'nothing to automate.',
        karter16: 'The source this tool owes the most to. Three distinct bodies of work, all of '
            + 'them published freely.',
        tool: 'The reference implementation of DS2 against this DME. This application\'s DS2 layer '
            + '— frame format, control bytes, programming segments, baud switching, adaptation '
            + 'masks, the flash-counter layout, and the erase → write → verify sequence — is a port '
            + 'of that work, and each file records this at its head.',
        xdf: 'The TunerPro definition. Every calibration address and scaling used in this '
            + 'application derives from it.',
        disasm: 'The 0401 disassembly. The exhaust-temperature correction path, the filling '
            + 'regulator, the idle controller, the FRA adaptation defect — the material in '
            + 'docs/ecu-logic/ rests upon it, as does the rule that λ = 1 must not be chased in the '
            + 'region that correction covers.',
        bry5on: 'Validation on their own car, and the publication of what it taught, warning '
            + 'included. It is evidence a disassembly cannot give, and the safe-side defaults in '
            + 'this application rest on reports of that kind.',
        terra: 'The original CSL-conversion partial, and the early fixes the community built upon '
            + 'it. The BASE this application reads and writes descends from them.',
        thread: 'The thread the methodology grew in. Years of reports and corrections are '
            + 'stacked on top of that first post, and much of what this application defaults '
            + 'to rests on them.',
        fr: 'BMW / Bosch: the 39 function specifications. Reading the disassembly rests on them.',
        sources: 'A per-claim map of which statement rests on which source is kept in '
            + 'docs/ecu-logic/90-sources.md, which distinguishes what was reported by the community '
            + 'from what was derived here and remains unverified.',
        build: 'Build',
    },
};

/** External, so every one of these needs the new-tab treatment — a same-tab navigation drops the
 *  serial link and takes an unsaved run with it. Same rule as the privacy link. */
const Link: React.FC<{ href: string; children: React.ReactNode }> = ({ href, children }) => (
    <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-blue-400 hover:text-blue-300 underline underline-offset-2 transition-colors"
    >
        {children}
    </a>
);

const Entry: React.FC<{ who: React.ReactNode; children: React.ReactNode }> = ({ who, children }) => (
    <div className="flex gap-2">
        <span className="text-slate-600 shrink-0">—</span>
        <p>
            <span className="text-slate-100 font-bold">{who}</span>
            {' — '}
            {children}
        </p>
    </div>
);

export const CreditsDialog: React.FC<Props> = ({ onClose, buildLabel }) => {
    const lang = useDialogLang();
    const t = TEXT[lang];

    return (
        <DialogFrame
            icon={<Heart className="w-3 h-3 text-red-400" />}
            title={t.title}
            closeLabel={t.close}
            onClose={onClose}
            autoHeight
        >
            <div className="flex-1 overflow-y-auto -mx-1 px-1 text-[12px] leading-relaxed text-slate-300 space-y-3">
                <p>{t.intro}</p>

                {/* FIRST, and the order is the point: this is the method the whole application
                    automates. Everything below is what made automating it possible. */}
                <p className="pt-1">
                    <span className="text-slate-100 font-bold">
                        <Link href={CREDIT_LINKS.pavloProfile}>Pavlo</Link>
                    </span>
                    {' — '}
                    {t.pavlo}
                </p>

                <p className="pt-1">
                    <span className="text-slate-100 font-bold">
                        <Link href={CREDIT_LINKS.karter16Profile}>karter16</Link>
                    </span>
                    {' — '}
                    {t.karter16}
                </p>
                <div className="space-y-2 pl-1">
                    <Entry who={<Link href={CREDIT_LINKS.ds2Tool}>MSS54 DS2 Tool</Link>}>{t.tool}</Entry>
                    <Entry who="CSL_0401_Karter16_v3_6_publish.xdf">{t.xdf}</Entry>
                    <Entry who={<Link href={CREDIT_LINKS.disassemblyRepo}>CSL 0401 Disassembly Notes</Link>}>
                        {t.disasm}
                    </Entry>
                </div>

                <div className="space-y-2 pt-1">
                    <Entry who={<Link href={CREDIT_LINKS.bry5onProfile}>Bry5on</Link>}>{t.bry5on}</Entry>
                    <Entry who={<Link href={CREDIT_LINKS.terraProfile}>terra</Link>}>{t.terra}</Entry>
                    <Entry who={<Link href={CREDIT_LINKS.tuningThread}>NA M3 Forums</Link>}>{t.thread}</Entry>
                    <Entry who="Funktionsrahmen">{t.fr}</Entry>
                </div>

                <p className="text-[11px] text-slate-500 pt-1">{t.sources}</p>

                {/* The build is here rather than only in the header because this is the dialog someone
                    opens when they are about to write to the author about something. */}
                {buildLabel && (
                    <p className="text-[10px] font-mono text-slate-600 pt-1 border-t border-slate-800">
                        {t.build} {buildLabel}
                    </p>
                )}
            </div>
        </DialogFrame>
    );
};
