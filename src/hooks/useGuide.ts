import { useCallback, useState } from 'react';

// 「使い方」を閉じたかどうかの記録先。免責の同意(e46m3csl:disclaimer-ack)とは別のキー — 免責は
// 「今後表示しない」を付けない限り毎回出るので、同じキーに乗せると使い方も毎回出てしまう。
// 値は版の文字列。使い方を実質的に書き直したら上げると、閉じた人にもう一度出せる。
// プライバシーポリシー第 9 条がこのキーを名指ししている(tsunagi-m3 content/privacy-policy.md)。
const STORAGE_KEY = 'e46m3csl:guide-seen';
const GUIDE_VERSION = '1';

/**
 * The guide carousel (GuideCarousel): offered when the disclaimer is agreed to, and opened only if
 * it has not been closed before.
 *
 * Plain state rather than a store like useDisclaimer's: the guide is never open on the first render
 * — it opens on a press — so there is no prerender answer that could disagree with the client's.
 * Storage that cannot be read or written (a private window) shows it after each agreement, the
 * same way the disclaimer fails: towards showing.
 */
export function useGuide() {
    const [open, setOpen] = useState(false);

    const offer = useCallback(() => {
        let seen = false;
        try {
            seen = localStorage.getItem(STORAGE_KEY) === GUIDE_VERSION;
        } catch {
            // Unreadable storage: show it.
        }
        if (!seen) setOpen(true);
    }, []);

    const close = useCallback(() => {
        try {
            localStorage.setItem(STORAGE_KEY, GUIDE_VERSION);
        } catch {
            // It closes anyway; it will be offered again after the next agreement.
        }
        setOpen(false);
    }, []);

    return { open, offer, close };
}
