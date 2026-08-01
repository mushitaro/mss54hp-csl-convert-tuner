import React from 'react';

/**
 * The ///M mark from the app icon, as a control glyph.
 *
 * Same three parallelograms as public/icon.svg — bar 215 wide, gap 115, leaning 370 across a height
 * of 1068 — so the button that opens the app's own menu is wearing the app's own mark rather than a
 * generic hamburger. `currentColor`, so it takes the active/idle colour of whatever it sits in.
 */
export const MarkIcon: React.FC<{ className?: string }> = ({ className }) => (
    <svg viewBox="0 0 1245 1068" className={className} fill="currentColor" aria-hidden="true">
        <path d="M0,1068 L215,1068 L585,0 L370,0 Z" />
        <path d="M330,1068 L545,1068 L915,0 L700,0 Z" />
        <path d="M660,1068 L875,1068 L1245,0 L1030,0 Z" />
    </svg>
);
