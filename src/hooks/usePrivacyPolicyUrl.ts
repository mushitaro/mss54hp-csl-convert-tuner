import { useEffect, useState } from 'react';
import { detectDialogLang } from '@/lib/dialog-text';
import { privacyPolicyUrl, PRIVACY_POLICY_URL_DEFAULT } from '@/config/links';

/**
 * プライバシーポリシーの URL を、ブラウザの言語設定に合わせて返す。
 *
 * `useDialogLang` と違い、初期値を判定結果ではなく既定値(日本語)に固定し、マウント後の effect で
 * 差し替える。理由はハイドレーションで、useDialogLang の方が間違っているわけではない:
 * あちらが `useState(detectDialogLang)` で済むのは、ダイアログが初期状態で閉じており
 * プリレンダーされた HTML に一切現れないためで、突き合わせる相手がそもそも無い。
 *
 * こちらのリンクはヘッダーとメニューに常時出ている = 静的 HTML に焼き込まれている。
 * 同じ書き方をすると、サーバー側が 'ja' で描いた href をクライアント初回描画が 'en' で描き、
 * href の不一致としてハイドレーションエラーになる。
 *
 * ハイドレーション前にクリックされた場合は日本語版へ飛ぶが、サイト側にブラウザ言語による
 * 自動判定があるため英語ブラウザはそのまま /en へ送られる。取り違えたまま終わることはない。
 */
export function usePrivacyPolicyUrl(): string {
    const [url, setUrl] = useState(PRIVACY_POLICY_URL_DEFAULT);

    useEffect(() => {
        setUrl(privacyPolicyUrl(detectDialogLang()));
    }, []);

    return url;
}
