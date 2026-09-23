'use client';

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

/**
 * Installing the app to the device, on a control this app owns.
 *
 * Nothing here used to handle `beforeinstallprompt`, so getting the tool onto a phone's home screen
 * depended entirely on Chrome offering it — and Chrome's own prompt is heuristic and its menu entry
 * is three taps deep behind an overflow icon. On the production origin that was masked by the
 * Trusted Web Activity, which installs from a link; on any other origin, including a preview
 * deployment, there was simply no way in that a user would find.
 *
 * That matters more here than for most apps. Installed, the tool has no browser chrome to lose room
 * to, keeps the screen awake through `useScreenWakeLock`, and — the actual point — survives a
 * garage with no signal, because the service worker has the whole build. In a tab it is a web page,
 * and a web page in a garage is a blank screen.
 *
 * ## The states, and why every one of them is reported
 *
 *   'installed'    already running standalone. Offering to install again would be a lie.
 *   'ready'        the browser fired the event; `promptInstall()` will show the real dialog.
 *   'ios'          Safari has no event and no API — the user must use Share -> Add to Home Screen.
 *                  Detected rather than guessed at, because there is nothing to click.
 *   'dismissed'    the dialog was shown and turned down. Distinguished from 'unavailable' because
 *                  telling someone the browser never offered it, seconds after they declined it,
 *                  is simply false.
 *   'unavailable'  no event has arrived. Either the browser does not support it, or it does not
 *                  consider the site installable yet.
 *
 * The last one is deliberately not silence. "Nothing happened when I looked for install" is exactly
 * the report this hook exists to answer, and a control that simply vanishes cannot answer it.
 */
export type InstallState = 'installed' | 'ready' | 'ios' | 'dismissed' | 'unavailable';

/** The event is still not in lib.dom. Only the two members that are actually used. */
interface BeforeInstallPromptEvent extends Event {
    prompt(): Promise<void>;
    userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

function runningStandalone(): boolean {
    if (typeof window === 'undefined') return false;
    if (window.matchMedia?.('(display-mode: standalone)').matches) return true;
    // iOS reports it here and nowhere else.
    return (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
}

function isIos(): boolean {
    if (typeof navigator === 'undefined') return false;
    return /iphone|ipad|ipod/i.test(navigator.userAgent)
        // iPadOS 13+ reports itself as a Mac; the touch points give it away.
        || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
}

/**
 * Both of these are read through useSyncExternalStore rather than set from an effect.
 *
 * They are browser capabilities, so they differ between the static prerender and the client — and
 * the two obvious ways to handle that are both wrong. A lazy `useState` initialiser reads `window`
 * during the hydrating render and produces markup that disagrees with the server's. Setting state
 * in an effect body is the cascading-render pattern the lint rule objects to, and it is right to:
 * this is not state that changes, it is state that is *read*. `getServerSnapshot` is the API for
 * exactly this — the server answers "not installed", the client answers truthfully, and React
 * reconciles the two without a mismatch.
 */
const subscribeDisplayMode = (onChange: () => void) => {
    const mq = window.matchMedia?.('(display-mode: standalone)');
    mq?.addEventListener('change', onChange);
    return () => mq?.removeEventListener('change', onChange);
};
/** iOS-ness never changes within a document, so there is nothing to subscribe to. */
const subscribeNever = () => () => { };

export function useInstallPrompt() {
    const standalone = useSyncExternalStore(subscribeDisplayMode, runningStandalone, () => false);
    const ios = useSyncExternalStore(subscribeNever, isIos, () => false);
    const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
    /** Set only when the user has been through the browser's dialog, so a dismissal is not
     *  mistaken for "this browser never offered it". */
    const [dismissed, setDismissed] = useState(false);

    useEffect(() => {
        const onPrompt = (e: Event) => {
            // Chrome shows its own mini-infobar unless this is prevented, and then there are two
            // install affordances saying different things in different places.
            e.preventDefault();
            setDeferred(e as BeforeInstallPromptEvent);
            setDismissed(false);
        };
        const onInstalled = () => setDeferred(null);
        window.addEventListener('beforeinstallprompt', onPrompt);
        window.addEventListener('appinstalled', onInstalled);
        return () => {
            window.removeEventListener('beforeinstallprompt', onPrompt);
            window.removeEventListener('appinstalled', onInstalled);
        };
    }, []);

    const state: InstallState = standalone ? 'installed'
        : deferred ? 'ready'
            : dismissed ? 'dismissed'
                : ios ? 'ios'
                    : 'unavailable';

    /** Shows the browser's own dialog. Resolves to what the user chose, or null if there was
     *  nothing to show — the caller decides whether that is worth saying. */
    const promptInstall = useCallback(async (): Promise<'accepted' | 'dismissed' | null> => {
        if (!deferred) return null;
        await deferred.prompt();
        const { outcome } = await deferred.userChoice;
        // The event is single-use. Chrome fires a fresh one if the site is still installable, which
        // is what makes a dismissal recoverable without a reload.
        setDeferred(null);
        setDismissed(outcome === 'dismissed');
        return outcome;
    }, [deferred]);

    return { state, promptInstall };
}
