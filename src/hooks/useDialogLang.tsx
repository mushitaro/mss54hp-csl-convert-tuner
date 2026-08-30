import { useSyncExternalStore } from 'react';
import { DialogLang, detectDialogLang } from '@/lib/dialog-text';

export type { DialogLang };

/**
 * The language the dialogs and explanations are written in, from the browser's own setting.
 *
 * ## Why this is a store rather than `useState(detectDialogLang)`
 *
 * It used to be that, with a comment arguing that dialogs only mount client-side so the initial
 * state could be resolved during the first render without disagreeing with the prerendered HTML.
 * That was true when only dialogs used it. It is not true now: `FilterConfigPanel`,
 * `FieldVisibilityPanel`, `InterpolationTableEditor`, `RfKorrSourceControl` and `InertiaPanel` all
 * read it, and all five are on the screen this app exports statically. `detectDialogLang` answers
 * `'ja'` when there is no `navigator`, so the export is Japanese and an English browser hydrated
 * over the top of it — a mismatch React resolves by throwing the server tree away, which is both a
 * warning in the console and a visible flash of the wrong language.
 *
 * `useSyncExternalStore` says the two halves separately. `getServerSnapshot` answers `'ja'`, so the
 * static export is byte-identical to what it always was and the hydrating render agrees with it;
 * `getSnapshot` answers the browser's real setting, which arrives on the very next render. Same
 * pattern, and the same argument, as `useIsPreviewBuild` in build-variant.ts.
 *
 * The value cannot change while the page is open — `navigator.language` follows the browser's
 * setting, and changing that reloads nothing — so `subscribe` has nothing to subscribe to.
 *
 * The detection itself lives in lib/dialog-text because the native `alert`/`confirm` paths are
 * called from event handlers rather than during render, cannot use a hook, and have to follow the
 * same rule.
 */
const NO_SUBSCRIBERS = () => () => { };
/** Cached, because `getSnapshot` must return a stable value or React re-renders forever. */
let clientLang: DialogLang | null = null;
const readClient = (): DialogLang => (clientLang ??= detectDialogLang());
const readServer = (): DialogLang => 'ja';

export function useDialogLang(): DialogLang {
    return useSyncExternalStore(NO_SUBSCRIBERS, readClient, readServer);
}
