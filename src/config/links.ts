/**
 * 姉妹サイト m3.tsunagi.app のプライバシーポリシー。
 *
 * スコープはサイトではなく `"M"/ TSUNAGI GARAGE`(サービス全体)と書かれており、個人情報の定義に
 * 車台番号(VIN)を含む — このツールが DME から読み出して表示している、まさにその値である。
 * だからサイト側のポリシーをここから指しても対象がずれない。
 *
 * 別ドメインなので、参照する側は必ず target="_blank" rel="noopener noreferrer" を付けること。
 * これは体裁ではなく安全策で、同タブ遷移は DME とのシリアルリンクを切り、SAVE までメモリ上の
 * liveSamplesRef にしか存在しない収録中のランを道連れにする。
 */
export const PRIVACY_POLICY_URL = 'https://m3.tsunagi.app/privacy-policy';

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
export const CREDIT_LINKS = {
    karter16Profile: 'https://nam3forum.com/forums/member/9797-karter16',
    bry5onProfile: 'https://nam3forum.com/forums/member/5503-bry5on',
    terraProfile: 'https://nam3forum.com/forums/member/1465-terra',
    ds2Tool: 'https://github.com/karter16/MSS54-DS2-Tool-Public',
    disassemblyRepo: 'https://github.com/karter16/CSL_0401_Binary_Disassembly_Notes',
    tuningThread: 'https://nam3forum.com/forums/forum/special-interests/coding-tuning/242281-a-quick-and-easy-way-to-street-tune-your-csl-conversion-for-drivability',
} as const;
