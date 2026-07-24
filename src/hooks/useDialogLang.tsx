import { useState } from 'react';

export type DialogLang = 'ja' | 'en';

// ブラウザの言語設定から表示言語を判定する。日本語(ja / ja-JP 等)なら日本語、それ以外はすべて英語。
// navigator が無い環境(サーバープリレンダー)では既定の日本語を返すが、ダイアログは開いた時に
// クライアントでのみマウントされるため、実際の判定は常にクライアントで行われる。
function detectDialogLang(): DialogLang {
    if (typeof navigator === 'undefined') return 'ja';
    const primary = (navigator.language || navigator.languages?.[0] || '').toLowerCase();
    return primary.startsWith('ja') ? 'ja' : 'en';
}

/**
 * ダイアログ(免責事項・学習値リセット等)の表示言語(JA/EN)を、ブラウザの言語設定から自動判定して返す。
 *
 * ダイアログは開いた時にクライアント側でのみマウントされる(open 系の state が初期 false)ため、
 * 初期 state をこの判定で確定させても、サーバー描画済み HTML との不一致は起きず、初回描画から
 * 正しい言語で表示される(ちらつき無し)。手動の言語トグルは不要。
 */
export function useDialogLang(): DialogLang {
    const [lang] = useState<DialogLang>(detectDialogLang);
    return lang;
}
