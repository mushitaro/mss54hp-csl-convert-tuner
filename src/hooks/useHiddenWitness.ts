import { useCallback, useEffect, useRef } from 'react';

/**
 * Records whether the page was ever hidden while an operation was running.
 *
 * This buys a diagnosis, not a defence. Nothing here can stop Android from freezing a backgrounded
 * tab mid-write; what it can do is stop the resulting failure from being a mystery. "The write
 * failed" and "the write failed, and the app was backgrounded while it ran" are the same event and
 * completely different bug reports — the second one names the cause and the remedy, the first sends
 * someone looking at the cable.
 *
 * That is the same argument the link already makes for `classifyEchoMismatch` and the baud-switch
 * outcome: when a failure has several plausible causes, record which one actually happened rather
 * than making the next reader guess.
 *
 * A ref, not state: the flag is read at failure time, never rendered, and a setState during a
 * four-minute transfer is exactly the main-thread work the transport cannot afford. Latched on
 * `active` going true so each operation is judged on its own.
 */
export function useHiddenWitness(active: boolean): () => boolean {
    const wasHidden = useRef(false);

    useEffect(() => {
        if (!active) return;
        wasHidden.current = false;
        // Catches the case where the operation is started from an already-hidden page — rare, but
        // it would otherwise report a clean run.
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
            wasHidden.current = true;
        }
        const onVisibility = () => {
            if (document.visibilityState === 'hidden') wasHidden.current = true;
        };
        document.addEventListener('visibilitychange', onVisibility);
        return () => document.removeEventListener('visibilitychange', onVisibility);
    }, [active]);

    return useCallback(() => wasHidden.current, []);
}
