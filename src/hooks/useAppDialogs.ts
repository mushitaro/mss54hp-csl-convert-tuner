'use client';

import { useCallback, useState } from 'react';
import type { Message } from '@/components/MessageDialog';

/** The modals that are opened by name from somewhere else on the page, rather than by the control
 *  they sit next to. One key per dialog; the page renders each behind its own flag. */
export type AppDialog = 'adaptation' | 'flash' | 'credits';

/**
 * Every dialog the page can put up, in one place.
 *
 * Two different things live here because they are the same concern from the user's side — "is
 * something asking me a question right now" — and neither belongs to the pane it is triggered
 * from. Both were declared among the page's layout state, three hundred lines from the JSX that
 * reads them.
 *
 * ## `ask`, the app's own alert/confirm
 *
 * A native dialog grows with its text. On the head unit — about 683x400 — the post-log instructions
 * and the write confirmation are long enough that the buttons land under the fold, so the one
 * dialog standing between a tap and an ECU write was answered without being read. `MessageDialog`
 * puts the scroll in the body and keeps the buttons in the frame.
 *
 * Promise-shaped because every call site is mid-sequence and the ordering there is deliberate —
 * `finishLog` disconnects *before* it speaks, so a blocking dialog cannot freeze the read pump
 * behind it. `await ask(...)` reads the same as `confirm(...)` did and preserves that.
 *
 * ## The four named modals
 *
 * `open` / `close` rather than four setters, so adding a fifth is one union member instead of a
 * fifth `useState` and a fifth prop threaded through the menu.
 */
export function useAppDialogs() {
    const [message, setMessage] = useState<Message | null>(null);
    const [openDialog, setOpenDialog] = useState<AppDialog | null>(null);

    const ask = useCallback((m: Omit<Message, 'resolve'>) => new Promise<boolean>(resolve => {
        setMessage({ ...m, resolve: ok => { setMessage(null); resolve(ok); } });
    }), []);

    // Stable identities: these are passed to memoised children and read from async handlers, and a
    // fresh function each render is how a handler ends up holding last render's copy.
    const open = useCallback((which: AppDialog) => setOpenDialog(which), []);
    const close = useCallback(() => setOpenDialog(null), []);
    const isOpen = useCallback((which: AppDialog) => openDialog === which, [openDialog]);

    return { message, ask, openDialog, open, close, isOpen };
}
