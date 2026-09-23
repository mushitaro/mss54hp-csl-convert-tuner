import React from 'react';
import { Loader2 } from 'lucide-react';

/**
 * What a chart box says while there is nothing in it yet.
 *
 * Two separate waits need this and they are both invisible without it: the `dynamic()` chunk for
 * plotly.js arriving, and — after that — the surface actually being built, which blocks the main
 * thread for around a second on a phone. Either way the pane was a black rectangle that did not
 * respond, which reads as a crash rather than as work.
 *
 * Built only from what the app already ships: `Loader2 w-3 h-3 animate-spin` (the same spinner the
 * six hardware dialogs use) and `text-[11px] font-mono` at `opacity-50`, matching the AWAITING
 * BINARY FILE and LOADING SESSIONS placeholders. It fills its box rather than sizing to its
 * content, so swapping it for the chart cannot move anything around it — the same reserved-space
 * rule the notice line and the hub's sub-action row follow.
 */
export const ChartLoading: React.FC<{ label?: string }> = ({ label = 'Rendering…' }) => (
    <div className="h-full w-full flex items-center justify-center gap-2 text-slate-500 opacity-50">
        <Loader2 className="w-3 h-3 animate-spin" />
        <span className="text-[11px] font-mono uppercase tracking-widest">{label}</span>
    </div>
);
