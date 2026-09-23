import { useCallback, useSyncExternalStore } from 'react';

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

function subscribe(fn: () => void) {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
}

export function useDisclaimer() {
    const open = useSyncExternalStore(subscribe, isOpen, isOpenOnServer);

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
        acknowledged = true;
        listeners.forEach(fn => fn());
    }, []);

    return { open, accept };
}
