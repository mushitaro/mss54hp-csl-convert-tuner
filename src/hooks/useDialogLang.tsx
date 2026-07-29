import { useState } from 'react';
import { DialogLang, detectDialogLang } from '@/lib/dialog-text';

export type { DialogLang };

/**
 * ダイアログ(免責事項・学習値リセット等)の表示言語(JA/EN)を、ブラウザの言語設定から自動判定して返す。
 *
 * ダイアログは開いた時にクライアント側でのみマウントされる(open 系の state が初期 false)ため、
 * 初期 state をこの判定で確定させても、サーバー描画済み HTML との不一致は起きず、初回描画から
 * 正しい言語で表示される(ちらつき無し)。手動の言語トグルは不要。
 *
 * 判定そのものは lib/dialog-text に置いてある。ネイティブの alert/confirm はレンダー中ではなく
 * イベントハンドラから呼ばれるためフックを使えず、両者が同じ規則で動く必要があるからである。
 */
export function useDialogLang(): DialogLang {
    const [lang] = useState<DialogLang>(detectDialogLang);
    return lang;
}
