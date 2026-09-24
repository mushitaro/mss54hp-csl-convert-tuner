import { isPreviewBuild } from './owner-sync';

/**
 * Whether this browser has been shown what the preview sends — and the rule that nothing is sent
 * until it has.
 *
 * ## Where the notice lives
 *
 * In the first-run dialog (DisclaimerDialog), on the preview build only; the words are in
 * preview-notice-copy.ts. It used to be a page on m3 that every owner-gated preview routed a first
 * visit through. The operator dropped that page on 2026-09-24: the confirmation belongs in the app's
 * own first-run dialog, which this app already had. The privacy policy's preview section says the
 * same — sending starts only after the owner has seen the notice — and this module is what makes
 * that sentence true in code rather than only in layout.
 *
 * ## The rule
 *
 * On the preview, nothing goes to the store until `PREVIEW_NOTICE_KEY` has been written: not a saved
 * session (`client.ts` refuses every store request), not a diagnostic record (`diagnostics.ts` keeps
 * it in the outbox instead, where a record that cannot go yet already waits), and not the outbox
 * itself. The dialog is modal, so nothing a hand does can get there first; the guards are for what
 * no hand does — the flush when the gate says active, a record filed by a run as it ends.
 *
 * ## Why its own key, and not the disclaimer's
 *
 * Owners ticked the disclaimer's "don't show again" before this notice existed. Reading that as having
 * seen a notice they were never shown would be exactly the failure this prevents. So the notice has
 * its own versioned key: on the preview the dialog shows while the key is missing, whatever the old
 * flag says, and pressing its button writes it. If what the notice says changes in substance, bump
 * the version and every owner is shown it again.
 *
 * ## Storage that throws
 *
 * A private window, blocked site data. The notice then counts as not seen and the dialog shows — the
 * safe default is to show it, never to assume it. The press still holds for this page, so the app is
 * usable; the next load asks again.
 *
 * Framework-free, like owner-sync, so `verify:preview-notice` can drive it without React.
 */
export const PREVIEW_NOTICE_KEY = 'preview-notice:v1';

/** Cached, because `useSyncExternalStore` needs a stable snapshot and every send asks. */
let acknowledged: boolean | null = null;
const listeners = new Set<() => void>();

function readStored(): boolean {
    try {
        return localStorage.getItem(PREVIEW_NOTICE_KEY) !== null;
    } catch {
        return false;
    }
}

/** Whether the notice has been confirmed on this browser (or, where storage fails, on this page). */
export function previewNoticeAcknowledged(): boolean {
    return (acknowledged ??= readStored());
}

/**
 * The press that confirms it. Records when, and tells the subscribers — the gate status is one, so
 * that whatever waited in the outbox goes as soon as it may.
 *
 * Does nothing off the preview. Production and staging show no notice and have nothing to confirm,
 * and production's privacy policy names every localStorage key that build writes.
 */
export function acknowledgePreviewNotice(): void {
    if (!isPreviewBuild()) return;
    try {
        localStorage.setItem(PREVIEW_NOTICE_KEY, new Date().toISOString());
    } catch {
        // Held for this page only. The next load shows the notice again, which is the safe way round.
    }
    acknowledged = true;
    listeners.forEach(fn => fn());
}

export function subscribePreviewNotice(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

/**
 * Whether the first-run dialog has to be up.
 *
 * Production and staging: exactly as before the notice existed — only the disclaimer's own "don't
 * show again" decides. The preview: that, or the notice not yet confirmed, whatever that checkbox
 * said. Written out as a function because this one line is the whole of "the old flag must not
 * suppress the notice", and it is what `verify:preview-notice` holds to.
 */
export function firstRunDialogOpen(state: {
    preview: boolean;
    disclaimerAcknowledged: boolean;
    noticeAcknowledged: boolean;
}): boolean {
    return !state.disclaimerAcknowledged || (state.preview && !state.noticeAcknowledged);
}
