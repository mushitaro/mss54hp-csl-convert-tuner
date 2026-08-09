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
