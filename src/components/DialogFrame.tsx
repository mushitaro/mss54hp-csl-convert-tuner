import React from 'react';
import { X } from 'lucide-react';

/**
 * The shared frame for the hardware dialogs, and the one place their geometry is decided.
 *
 * **The box is fixed for the dialog's whole lifetime.** It was previously sized by its content and
 * centred with `-translate-y-1/2`, which meant every phase change resized it *and* moved both edges
 * by half the delta — measured on the flash-counter dialog, walking viewing → confirming →
 * resetting moved the top edge 333 → 244 → 319 px and the height 234 → 412 → 261 px. On a tool that
 * is at that moment erasing a vehicle's identity records, a dialog that jumps around while it works
 * reads as something going wrong.
 *
 * So the height is stated here, not derived: `min(84dvh,560px)`, with the viewport cap kept so a short
 * laptop screen still fits. 560 is the tallest arrangement either dialog needs — the twelve-row
 * adaptation table under its confirmation warnings — measured at 0 px of overflow in Japanese and
 * 32 px in English, where the longer labels wrap. Content that outgrows it scrolls inside the body;
 * the frame does not react to it. Both dialogs share the number deliberately: they open from
 * adjacent header buttons, and one box in one place is easier to trust than two that nearly match.
 *
 * **The width cap does not weaken any of that.** `min(560px, 100vw-2rem)` still resolves to one
 * number for the dialog's whole lifetime — the viewport does not change while a dialog is open — so
 * the box is as fixed as it ever was. What it fixes is a phone: at 560 px flat, every portrait
 * handset clipped both edges off the dialog, including its buttons. `dvh` rather than `vh` for the
 * same reason as the app shell: on Android `vh` is the *largest* viewport, so 84vh could reach
 * under the browser's own chrome.
 */
interface FrameProps {
    /** Rendered at the title's left, sized by the caller (`w-3 h-3`). */
    icon: React.ReactNode;
    title: string;
    /** Localized `aria-label` for the close button. */
    closeLabel: string;
    /**
     * Omit to render no dismiss affordance at all — no X, no backdrop click. That is what the
     * point-of-no-return phases pass: once the DME has acknowledged an erase there is no honest way
     * to cancel, so the dialog must not appear to offer one.
     */
    onClose?: () => void;
    /**
     * Size the box to its content instead of stating 560px, keeping the same value as a cap.
     *
     * Only for dialogs that have no phases. The fixed height above exists so a phase change cannot
     * move the box mid-operation; a single-phase readout has no phase change to be stable against,
     * and padding five lines of identity out to 560px reads as a dialog that failed to load rather
     * than one that is deliberately calm. The box is still decided once and cannot move while open,
     * because the content it measures does not change either.
     */
    autoHeight?: boolean;
    children: React.ReactNode;
}

export const DialogFrame: React.FC<FrameProps> = ({ icon, title, closeLabel, onClose, autoHeight, children }) => (
    <>
        <div
            className="fixed inset-0 z-[100] bg-slate-950/70 backdrop-blur-sm"
            onClick={onClose}
        />
        <div className={`fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[min(560px,calc(100vw-2rem))] ${autoHeight ? 'max-h-[min(84dvh,560px)]' : 'h-[min(84dvh,560px)]'} flex flex-col bg-slate-900 border border-slate-700 rounded-lg shadow-xl z-[110] p-4 animate-in fade-in zoom-in-95 duration-200`}>
            <div className="flex justify-between items-center mb-4 border-b border-slate-800 pb-2 shrink-0">
                <h3 className="text-xs font-bold text-slate-300 uppercase tracking-widest flex items-center gap-2">
                    {icon}
                    {title}
                </h3>
                {onClose && (
                    <button onClick={onClose} aria-label={closeLabel} className="text-slate-500 hover:text-slate-300">
                        <X className="w-4 h-4" />
                    </button>
                )}
            </div>
            {children}
        </div>
    </>
);

/**
 * Holds a set of mutually-exclusive phase views in one grid cell, so the region is always as tall as
 * its tallest member and never changes height when the phase does.
 *
 * This is what keeps the rule above from merely relocating the problem. Fixing the panel stops the
 * *window* moving, but an action area that is one line in `viewing` and a five-line warning in
 * `confirming` still drags the divider — and the rows above it — up and down inside that panel.
 * Reserving the space costs nothing but the height of the largest variant, and unlike a hand-picked
 * `min-h-[…]` it stays correct when the copy changes or the dialog language switches.
 */
export const PhaseStack: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className = '' }) => (
    <div className={`grid ${className}`}>{children}</div>
);

/** One member of a PhaseStack. Inactive layers keep their space but are invisible — which also takes
 *  them out of the tab order and off the accessibility tree, so a hidden phase's buttons cannot be
 *  reached by keyboard the way `opacity-0` would allow.
 *
 *  A column, full height, so a DialogActions inside it can pin itself to the bottom of the reserved
 *  region rather than floating wherever its own message happens to end. */
export const PhaseLayer: React.FC<{ show: boolean; children: React.ReactNode }> = ({ show, children }) => (
    <div className={`[grid-area:1/1] h-full flex flex-col ${show ? '' : 'invisible'}`} aria-hidden={!show}>
        {children}
    </div>
);

/**
 * The action row: always the last child of a PhaseLayer, always at the bottom of the reserved region.
 *
 * `mt-auto` is the whole point. Reserving the region stopped the panel and the divider from moving,
 * but each phase still laid its buttons out directly under its own message — so a short phase put
 * them high and a wordy one put them low. Measured, the flash-counter dialog moved the button 178 px
 * down between `viewing` and `confirming`: you press RESET, and the confirmation's RUN RESET appears
 * far below the cursor. On the dialog that erases a car's identity records, "where the last button
 * was" must not be a place the next one can occupy by accident, and it must not be a place the
 * pointer has to hunt for either.
 *
 * `lead` is the message that shares the row (the question, the completion note). Styling stays at the
 * call site — it is amber in one phase, emerald in another, and that colour is carrying meaning.
 */
export const DialogActions: React.FC<{ lead?: React.ReactNode; children: React.ReactNode }> = ({ lead, children }) => (
    <div className="mt-auto pt-2 flex justify-between items-center gap-4">
        <div className="min-w-0 flex-1">{lead}</div>
        <div className="flex gap-4 shrink-0">{children}</div>
    </div>
);
