'use client';

import React, { useEffect, useRef, useState } from 'react';
import { Download } from 'lucide-react';
import { DOWNLOAD_EVENT, type DownloadNotice } from '@/lib/download';

/**
 * The only confirmation a download gets on a phone.
 *
 * The manifest declares `display: standalone`, so an installed app has no browser chrome at all —
 * no download bubble, no shelf, no address bar. The file reaches the Downloads folder and Chrome
 * posts an OS notification, but with the instrument fullscreen the driver does not see it, so from
 * inside the app the tap produced nothing. Reported from the car as "downloading session data does
 * nothing, I cannot tell whether it saved".
 *
 * Driven by an event off `downloadBlob` rather than props, because the seven downloads are spread
 * across page.tsx and useBinaryFile and none of them should have to remember this exists.
 *
 * ## Why it is mounted even when idle
 *
 * A transition needs two committed styles to interpolate between. Mounting on the event and setting
 * the visible class in the same commit gives it one, and the box appears instantly instead of
 * fading — the standard fix is a double rAF, and an always-mounted empty box is cheaper than that
 * and cannot race. It is `pointer-events-none` in both states, so it never eats a tap meant for the
 * grid underneath.
 */

/** Long enough to read a filename standing next to the car, short enough not to sit over the map. */
const DWELL_MS = 4000;

export const DownloadToast: React.FC = () => {
    const [notice, setNotice] = useState<DownloadNotice | null>(null);
    const [shown, setShown] = useState(false);
    const timer = useRef<number | undefined>(undefined);

    useEffect(() => {
        const onDownload = (e: Event) => {
            clearTimeout(timer.current);
            // The text is NOT cleared when the dwell ends: it has to stay rendered through the
            // 150 ms fade, and there is nothing to gain by unmounting a box nobody can touch.
            setNotice((e as CustomEvent<DownloadNotice>).detail);
            setShown(true);
            timer.current = window.setTimeout(() => setShown(false), DWELL_MS);
        };
        window.addEventListener(DOWNLOAD_EVENT, onDownload);
        return () => {
            window.removeEventListener(DOWNLOAD_EVENT, onDownload);
            clearTimeout(timer.current);
        };
    }, []);

    return (
        <div
            role="status"
            aria-live="polite"
            /* z-[105]: above the menu sheet (z-[95]) and the session store panel (z-[100]), so a
               download started from either is still announced, and below DialogFrame (z-[110]),
               which is the one thing that must never be painted over.

               bottom-[60px] clears the footer — h-[52px] plus its top border, the same literal
               DropCensus floats at, so the two never sit on different lines. Above 900px the
               footer is `min-[900px]:hidden` and the toast comes down with it. */
            className={`fixed left-1/2 -translate-x-1/2 bottom-[60px] min-[900px]:bottom-4 z-[105]
                        pointer-events-none transition-opacity duration-150
                        ${shown ? 'opacity-100' : 'opacity-0'}`}
        >
            {notice && (
                <div className="flex items-center gap-2 rounded border border-slate-700 bg-slate-900/95 px-3 py-2 shadow-xl max-w-[calc(100vw-1.5rem)]">
                    {/* emerald-* is the DONE / PRESENT role in this palette, not a hue — see the
                        note beside the tokens in globals.css. */}
                    <Download className="w-3 h-3 shrink-0 text-emerald-400" />
                    <span className="shrink-0 text-[9px] font-bold uppercase tracking-widest text-emerald-400">
                        Saved to Downloads
                    </span>
                    {/* Rendered, not hung off a `title`: there is no hover on a phone, and the
                        filename is the half that says WHICH download this was. */}
                    <span className="min-w-0 truncate font-mono text-[10px] text-slate-400">
                        {notice.fileName}
                    </span>
                </div>
            )}
        </div>
    );
};
