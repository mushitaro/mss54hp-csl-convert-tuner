import { useCallback, useSyncExternalStore } from 'react';
import { useIsPreviewBuild } from '@/lib/build-variant';
import {
    acknowledgePreviewNotice, firstRunDialogOpen, previewNoticeAcknowledged, subscribePreviewNotice,
} from '@/lib/session-sync/preview-notice';

// 免責同意の記録先。localStorage はこのアプリで唯一の同期・軽量な永続化で、セッション用の
// IndexedDB(useSessionDb)より免責フラグ 1 個の保存に適する。キーは他アプリと衝突しない接頭辞つき。
const STORAGE_KEY = 'e46m3csl:disclaimer-ack';
// 保存値はこのバージョン文字列。文面を実質的に更新したら上げると、既に同意済みの全員へ
// 自動的に再提示できる(保存値 !== 現行版 なら未同意として扱うため)。
const DISCLAIMER_VERSION = '1';

/**
 * Whether the disclaimer has to be shown, and the "don't show again" that stops it.
 *
 * ## Why a store rather than `useState` + an effect
 *
 * The answer lives in `localStorage`, which does not exist during the static prerender — so it was
 * read in a mount effect that called `setOpen(true)`. That is a setState synchronously inside an
 * effect: it renders once with the wrong answer, commits, then renders again. For this particular
 * flag the wrong answer is "no disclaimer", which is the one that must not be shown even for a
 * frame, and the second render is what the user sees flicker.
 *
 * `useSyncExternalStore` states the two halves separately. `getServerSnapshot` answers `false`, so
 * the export contains no dialog and the hydrating render agrees with it; `getSnapshot` reads the
 * real answer, which arrives on the first client render rather than after a commit. Same pattern,
 * and the same argument, as `useIsPreviewBuild` and `useDialogLang`.
 *
 * ## On the preview, the notice as well
 *
 * The preview build puts what it sends, and why, into this same dialog, and sends nothing until that
 * has been confirmed (lib/session-sync/preview-notice.ts). The confirmation is a key of its own, so
 * this "don't show again" — ticked by owners before the notice existed — cannot stand in for it: on
 * the preview the dialog is up while either is missing, and the one press writes the notice's.
 * Production and staging never read or write that key, and open exactly as they always did.
 *
 * ストレージが使えない場合(プライベートモード等)は必ず提示する。
 */
let acknowledged: boolean | null = null;
const listeners = new Set<() => void>();

function readStored(): boolean {
    try {
        return localStorage.getItem(STORAGE_KEY) === DISCLAIMER_VERSION;
    } catch {
        return false;
    }
}

/** Cached, because `getSnapshot` must return a stable value or React re-renders forever. */
const isOpen = (): boolean => !(acknowledged ??= readStored());
/** The prerender has no storage and must not put a dialog in the export. */
const isOpenOnServer = (): boolean => false;
/** Not confirmed, as far as the prerender knows — and `preview` is false there, so still no dialog. */
const noticeAcknowledgedOnServer = (): boolean => false;

function subscribe(fn: () => void) {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
}

export function useDisclaimer() {
    const disclaimerOpen = useSyncExternalStore(subscribe, isOpen, isOpenOnServer);
    const noticeAcknowledged = useSyncExternalStore(
        subscribePreviewNotice, previewNoticeAcknowledged, noticeAcknowledgedOnServer);
    // The bit the dialog reads to show the notice and the send guards read to hold the sends:
    // app-variant is `preview`. Not the scope switch — see DisclaimerDialog.
    const preview = useIsPreviewBuild();
    const open = firstRunDialogOpen({ preview, disclaimerAcknowledged: !disclaimerOpen, noticeAcknowledged });

    // ダイアログを閉じる唯一の経路。dontShowAgain が真のときだけ現行版を保存し、以後は非表示に
    // なる。チェックせず同意した場合は保存しないため、次回アクセスで再び表示される — so the
    // in-memory flag is set either way and only the WRITE is conditional.
    const accept = useCallback((dontShowAgain: boolean) => {
        if (dontShowAgain) {
            try {
                localStorage.setItem(STORAGE_KEY, DISCLAIMER_VERSION);
            } catch {
                // 保存に失敗しても同意操作自体は成立させる(次回また出るだけ)。
            }
        }
        // プレビュー版では、この押下がお知らせを確認したことの記録でもある(チェックの有無に関係なく)。
        // 本番と staging には何もしない。
        if (preview) acknowledgePreviewNotice();
        acknowledged = true;
        listeners.forEach(fn => fn());
    }, [preview]);

    return { open, accept };
}
