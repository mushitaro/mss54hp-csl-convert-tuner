'use client';

import React from 'react';

/**
 * Grid zoom, as a pair of buttons that sit in a row rather than floating over it.
 *
 * ## It replaced a floating pair, and the point was to stop covering the map
 *
 * The old control sat at `bottom-3 right-3` over the grid. On this table the bottom right is high
 * rpm at high opening, so the one thing it hid was a corner worth reading — and it was the second
 * control on screen for a setting that only needs one.
 *
 * It lives on the drive band instead: the topmost line of the map pane, RATE / VALID / DROP. That
 * band is 20px of leading-none 9px text, so a control sharing it costs the map NO height. The
 * census strip one line further down was the wrong choice for the same reason a floating pair was
 * — it belongs to the TUNED tab alone, and the zoom belongs to every grid.
 *
 * ## Thin on purpose
 *
 * `self-stretch` and no height of its own. The band's height is set by its text, and anything with
 * a minimum here would push the band taller and take that back off the map — which is the whole
 * thing this move was for. So the glyphs are 9px like the readouts beside them, and the buttons
 * take their height from the row.
 *
 * The width is where the target comes from instead: `w-16` is 64px, well past the 44px guideline
 * on the axis that costs nothing. This band spans the pane and the numbers beside it are short.
 *
 * Disabled at the ends of the range rather than hidden — a control that vanishes at the limit
 * takes the way back with it.
 */
export function MapZoomButtons({ atMin, atMax, onNudge, className }: {
    atMin: boolean;
    atMax: boolean;
    onNudge: (direction: 1 | -1) => void;
    className?: string;
}) {
    return (
        <div className={`shrink-0 self-stretch flex items-stretch rounded overflow-hidden
                         bg-slate-800/70 ${className ?? ''}`}>
            {([['−', -1, atMin], ['＋', 1, atMax]] as const).map(([glyph, dir, at], i) => (
                <button
                    key={dir}
                    type="button"
                    onClick={() => onNudge(dir)}
                    disabled={at}
                    aria-label={dir > 0 ? 'Zoom the grid in' : 'Zoom the grid out'}
                    className={`w-16 flex items-center justify-center text-[11px] leading-none
                                transition-colors ${i === 1 ? 'border-l border-slate-900' : ''}
                                ${at ? 'text-slate-700 cursor-default' : 'text-slate-300 hover:text-slate-100 active:bg-slate-700 cursor-pointer'}`}
                >
                    {glyph}
                </button>
            ))}
        </div>
    );
}
