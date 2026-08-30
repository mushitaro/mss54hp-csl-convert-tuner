import { useDialogLang } from '@/hooks/useDialogLang';
import { privacyPolicyUrl } from '@/config/links';

/**
 * プライバシーポリシーの URL を、ブラウザの言語設定に合わせて返す。
 *
 * ## 何を避ける必要があるか
 *
 * このリンクはヘッダーとメニューに常時出ている = 静的 HTML に焼き込まれている。素直に
 * `useState(detectDialogLang)` と書くと、サーバー側が 'ja' で描いた href をクライアント初回
 * 描画が 'en' で描き、href の不一致としてハイドレーションエラーになる。
 *
 * ## main から取り込んだ実装を、develop の答えに寄せてある
 *
 * main 版は `useState(既定値)` + `useEffect` で差し替える形だった。動作は正しいが、この
 * ブランチの lint が「effect 内での同期 setState は連鎖レンダーを生む」として弾く。そして
 * このブランチには同じ問題の答えが既にある —— `useDialogLang` は `useSyncExternalStore` で、
 * `getServerSnapshot` が 'ja'、`getSnapshot` がブラウザの実際の設定を返す。プリレンダーと
 * ハイドレーションが一致し、正しい値は次のレンダーで届く。
 *
 * つまり同じ結論に 2 つの機構を置く必要がなかった。ここは 1 行になり、ハイドレーションの
 * 議論は `useDialogLang` 側の 1 箇所に集約されている。
 *
 * ハイドレーション前にクリックされた場合は日本語版へ飛ぶが、サイト側にブラウザ言語による
 * 自動判定があるため英語ブラウザはそのまま /en へ送られる。取り違えたまま終わることはない。
 */
export function usePrivacyPolicyUrl(): string {
    return privacyPolicyUrl(useDialogLang());
}
