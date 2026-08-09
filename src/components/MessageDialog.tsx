'use client';

import React from 'react';
import { DialogFrame } from './DialogFrame';

/**
 * The app's own `alert` and `confirm`, for the messages too long to trust the browser's with.
 *
 * On the head unit the viewport is about 683x400, and the native dialog sizes itself to the text:
 * the post-log instructions are nine lines and the write confirmation longer still, so both opened
 * as a scrolling box with the buttons under the fold. A dialog whose choices cannot be read without
 * scrolling is worst exactly where it matters most — the last thing between a tap and an ECU write.
 *
 * `DialogFrame` already solves the geometry, and solves it the right way round: the frame is
 * `min(84dvh,560px)` and the *body* scrolls inside it, so the buttons are part of the frame and
 * cannot leave the screen no matter how long the message is.
 *
 * Promise-shaped rather than callback-shaped because the call sites are mid-sequence and their
 * ordering is deliberate — `finishLog` disconnects before it speaks, precisely so the blocking
 * dialog cannot freeze the read pump behind itself. `await ask(...)` preserves that reading; a
 * callback would not.
 *
 * Only the long ones move here. A one-line "no stored binary" is a fine use of the browser's own.
 */
export interface Message {
    title: string;
    icon: React.ReactNode;
    body: string;
    confirmLabel: string;
    /** Present ⇒ this is a confirm and resolves false on cancel. Absent ⇒ an alert. */
    cancelLabel?: string;
    /** Marks the confirm button as the dangerous one — a write, a discard. */
    danger?: boolean;
    resolve: (ok: boolean) => void;
}

export const MessageDialog: React.FC<{ message: Message; closeLabel: string }> = ({ message, closeLabel }) => {
    const { title, icon, body, confirmLabel, cancelLabel, danger, resolve } = message;
    // An alert has one way out and it is the button, so the X and the backdrop resolve it the same
    // way. A confirm must not be dismissable by missing it: there is no honest default for "write
    // this to the ECU", so the only exits are the two labelled ones.
    const dismiss = cancelLabel === undefined ? () => resolve(true) : undefined;

    return (
        <DialogFrame icon={icon} title={title} closeLabel={closeLabel} onClose={dismiss} autoHeight>
            {/* The one scrolling region, and it is the text — never the buttons below it. */}
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1">
                {body.split('\n').map((line, i) => (
                    <p key={i} className={`text-[11px] leading-relaxed text-slate-300 whitespace-pre-wrap ${line.trim() === '' ? 'h-2' : ''}`}>
                        {line}
                    </p>
                ))}
            </div>
            <div className="shrink-0 flex justify-end gap-2 pt-3 mt-3 border-t border-slate-800">
                {cancelLabel !== undefined && (
                    <button
                        type="button"
                        onClick={() => resolve(false)}
                        className="px-4 py-3 rounded text-[10px] font-bold uppercase tracking-widest text-slate-400 hover:text-slate-200 cursor-pointer"
                    >
                        {cancelLabel}
                    </button>
                )}
                <button
                    type="button"
                    autoFocus
                    onClick={() => resolve(true)}
                    className={`px-4 py-3 rounded text-[10px] font-bold uppercase tracking-widest cursor-pointer ${danger
                        ? 'bg-red-500/15 text-red-300 hover:bg-red-500/25'
                        : 'bg-blue-500/15 text-blue-300 hover:bg-blue-500/25'}`}
                >
                    {confirmLabel}
                </button>
            </div>
        </DialogFrame>
    );
};
