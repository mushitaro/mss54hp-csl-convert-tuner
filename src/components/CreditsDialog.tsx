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
        intro: 'このツールは、他の人が先にやって公開してくれた仕事の上に成り立っています。'
            + '「コミュニティのおかげ」では出典になっていないので、名指しで書きます。',
        karter16: 'このツール最大の情報源。3 つの独立した仕事を使わせてもらっています。',
        tool: 'DS2 プロトコルのリファレンス実装。当アプリの DS2 まわり — フレーム形式・制御バイト・'
            + 'プログラミングセグメント・ボーレート切替・適応マスク・フラッシュカウンタのレイアウト・'
            + '消去→書込→照合の手順 — はこれの移植で、各ファイル冒頭にその旨を書いています。',
        xdf: 'TunerPro 定義。当アプリが持つ較正アドレスとスケーリングはすべてここに遡ります。',
        disasm: '0401 の逆アセンブル。docs/ecu-logic/ の記述 — EGT 補正・充填レギュレータ・'
            + 'アイドル制御・FRA 適応バグ — の根拠です。',
        bry5on: '`KF_RF_KORR_DRREL` の解説と「λ=1 を追うな」という指摘。'
            + 'このツールが補正テーブルをどう扱うかは、その議論で決まっています。',
        terra: 'CSL 換装パーシャルの原型と、コミュニティがその上に積んだ初期の修正。',
        thread: 'このアプリが自動化している、ストリートチューニングの手順そのもの。',
        fr: 'BMW / Bosch 機能仕様書 39 冊。逆アセンブルを読めるものにしている資料。',
        sources: 'どの記述がどの出典から来たかの対応表は docs/ecu-logic/90-sources.md にあります。'
            + '「コミュニティ由来」と「本解析による導出・未検証」を意図的に分けてあります。',
        build: 'ビルド',
    },
    en: {
        title: 'CREDITS',
        close: 'Close',
        intro: 'This tool stands on work that other people did first and gave away. '
            + '"Inspired by the community" is not attribution, so here it is by name.',
        karter16: 'The single largest source. Three distinct bodies of work are used here.',
        tool: 'The reference implementation of DS2 against this DME. This app\'s DS2 layer — frame '
            + 'format, control bytes, programming segments, baud switching, adaptation masks, the '
            + 'flash-counter layout, the erase → write → verify sequence — is a port of it, and each '
            + 'file says so at the top.',
        xdf: 'The TunerPro definition. Every calibration address and scaling in this app traces back to it.',
        disasm: 'The 0401 disassembly. Everything in docs/ecu-logic/ rests on it — the EGT correction '
            + 'path, the filling regulator, the idle controller, the FRA adaptation bug.',
        bry5on: 'The KF_RF_KORR_DRREL discussion and the "do not chase λ=1" argument, which is what '
            + 'shapes how this tool treats the correction table.',
        terra: 'The original CSL-conversion partial and the earlier fixes the community built on.',
        thread: 'The street-tuning methodology this whole application automates.',
        fr: 'BMW / Bosch Funktionsrahmen — the 39 function specifications that make the disassembly readable.',
        sources: 'A per-claim map of which statement came from which source is in '
            + 'docs/ecu-logic/90-sources.md, which deliberately separates community-reported from '
            + 'derived-here-and-unverified.',
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
