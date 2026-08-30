import type { DialogLang } from '@/lib/dialog-text';

/**
 * 姉妹サイト m3.tsunagi.app のプライバシーポリシー。
 *
 * スコープはサイトではなく `"M"/ TSUNAGI GARAGE`(サービス全体)と書かれており、個人情報の定義に
 * 車台番号(VIN)を含む — このツールが DME から読み出して表示している、まさにその値である。
 * だからサイト側のポリシーをここから指しても対象がずれない。
 *
 * `#tuner` は飾りではなく、ポリシー第 9 条「チューニングツールにおける情報の取り扱い」への
 * 明示アンカーである。IndexedDB の 3 つの DB 名、DME から読む値、VIN を含むダウンロード、
 * 「送信は自オリジンへの更新確認 1 本のみ」——このツールを使う人が自分に関係する条項へ
 * 一息で着地できるようにするためのもの。ポリシー全体が適用される旨は同条の冒頭に書いてある。
 * アンカーはサイト側で手書き固定されており、節番号を振り直しても文言を変えても壊れない
 * (自動生成 slug ではない。tsunagi-m3 の lib/pages.ts を参照)。
 *
 * 日英 2 版がある。UI と同じ `detectDialogLang()` の結果で出し分けるので、英語 UI の利用者が
 * 日本語のポリシーに着地することはない。サイト側にもブラウザ言語による自動判定があるため、
 * 仮にここが取り違えても最終的には正しい方へ落ちる — が、それは保険であって、
 * 一度で正しい URL を指すのがこちらの責任である。
 *
 * 別ドメインなので、参照する側は必ず target="_blank" rel="noopener noreferrer" を付けること。
 * これは体裁ではなく安全策で、同タブ遷移は DME とのシリアルリンクを切り、SAVE までメモリ上の
 * liveSamplesRef にしか存在しない収録中のランを道連れにする。
 *
 * 直接は使わず、`usePrivacyPolicyUrl()` 経由で読むこと(ハイドレーション不一致を避けるため)。
 */
export function privacyPolicyUrl(lang: DialogLang): string {
    return lang === 'ja'
        ? 'https://m3.tsunagi.app/privacy-policy#tuner'
        : 'https://m3.tsunagi.app/en/privacy-policy#tuner';
}

/**
 * プリレンダー時に埋まる値。`detectDialogLang()` が navigator の無い環境で 'ja' を返すのと
 * 同じ既定で、静的 HTML と最初のクライアント描画を一致させるためにここに固定してある。
 */
export const PRIVACY_POLICY_URL_DEFAULT = privacyPolicyUrl('ja');

/**
 * Where the work this tool is built on actually lives.
 *
 * Kept here rather than inline in CreditsDialog for the same reason the privacy URL is: these are
 * cross-origin destinations, and the rule that every one of them opens in a new tab is easier to
 * hold when they are all declared in one place. A same-tab navigation drops the serial link and
 * takes an unsaved run with it.
 *
 * The forum profile URLs carry the member id as well as the name, which is how vBulletin resolves
 * them — a renamed account still lands correctly.
 */
/** This tool's own source. Declared here with the rest for the same new-tab reason, and because the
 *  desktop header and the menu sheet now both point at it — inline in two places is one place too
 *  many for a URL that has to stay the same in both. */
export const PROJECT_REPO_URL = 'https://github.com/mushitaro/mss54hp-csl-convert-tuner';

export const CREDIT_LINKS = {
    karter16Profile: 'https://nam3forum.com/forums/member/9797-karter16',
    bry5onProfile: 'https://nam3forum.com/forums/member/5503-bry5on',
    terraProfile: 'https://nam3forum.com/forums/member/1465-terra',
    ds2Tool: 'https://github.com/karter16/MSS54-DS2-Tool-Public',
    disassemblyRepo: 'https://github.com/karter16/CSL_0401_Binary_Disassembly_Notes',
    tuningThread: 'https://nam3forum.com/forums/forum/special-interests/coding-tuning/242281-a-quick-and-easy-way-to-street-tune-your-csl-conversion-for-drivability',
} as const;
