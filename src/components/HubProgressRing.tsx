'use client';

import type { TransferPhase } from '@/lib/dme-link/types';

/** One phase, one color. The hub's progress arc, the percentage inside it and the phase label under
 *  it all read this table, so the three can never disagree about what stage the transfer is in.
 *  The two stages that behave unusually get the two colors furthest from the read/write blue: erase
 *  reports nothing and parks the percentage at 0 until it finishes (ERASE_TIMEOUT_MS allows it 65 s),
 *  and verify is a second full-length pass that is reading the ECU back, not writing to it. Since
 *  the palette collapsed to the M tricolor, `amber` is violet and `emerald` is a near-white ice blue
 *  — erase separates by hue, verify by lightness (15.4:1 against blue-400's 8.3:1) plus its label. */
export const TRANSFER_PHASE_STYLE: Record<TransferPhase, { label: string; text: string }> = {
    erasing: { label: 'Erasing…', text: 'text-amber-400' },
    reading: { label: 'Reading…', text: 'text-blue-400' },
    writing: { label: 'Writing…', text: 'text-blue-400' },
    verifying: { label: 'Verifying…', text: 'text-emerald-400' },
};

/**
 * Progress arc drawn on the hub button's circumference.
 *
 * Absolutely positioned, and rendered only while a transfer is in flight: the idle hub is left
 * exactly as it was, and — the rule the whole cluster follows — nothing here can change the
 * cluster's natural size and set the auto-fit rescaling the dial mid-read.
 *
 * The box is -inset-1 (88px around the 80px button) and the viewBox matches it 1:1, so every number
 * below is in real pixels: the 3px band sits in the gap between the button's own border (r=40) and
 * the decorative hairline bezel (r≈44). Rotated -90° so 0% starts at 12 o'clock and fills clockwise.
 * Last child of the wrapper so it paints over the button's outer ring rather than under it.
 *
 * `stroke-current` + a currentColor drop-shadow means the caller passes a single text-* class and
 * gets the arc, its glow and the percentage in one color.
 */
export function HubProgressRing({ percent, colorClass, pulse }: { percent: number; colorClass: string; pulse: boolean }) {
    const R = 42;
    const CIRCUMFERENCE = 2 * Math.PI * R;
    const clamped = Math.max(0, Math.min(100, percent));
    return (
        <svg viewBox="0 0 88 88" className="absolute -inset-1 w-[88px] h-[88px] -rotate-90 pointer-events-none" aria-hidden="true">
            {/* Track. Pulses only while erasing — that stage reports no percentage, so the arc alone would
          look like a stalled transfer for the whole erase. */}
            <circle cx="44" cy="44" r={R} fill="none" strokeWidth="3" className={`stroke-slate-800 ${pulse ? 'animate-pulse' : ''}`} />
            {/* Deliberately NOT transitioned. A `transition` on stroke-dashoffset freezes the *rendered*
          value at whatever it was when the first transition started — the inline style keeps
          updating, the computed style never does, and the arc sits at ~4% for the whole read.
          Measured in the browser: with the transition the computed offset never leaves its initial
          value; without it, it tracks exactly. The link already throttles progress to ~10 Hz, so
          stepping straight to each value is smooth on its own. */}
            <circle
                cx="44" cy="44" r={R} fill="none" strokeWidth="3" strokeLinecap="round"
                className={`${colorClass} stroke-current`}
                style={{
                    strokeDasharray: CIRCUMFERENCE,
                    strokeDashoffset: CIRCUMFERENCE * (1 - clamped / 100),
                    filter: 'drop-shadow(0 0 3px currentColor)',
                }}
            />
        </svg>
    );
}
