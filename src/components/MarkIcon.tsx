import React from 'react';

/**
 * The family's plain ///M silhouette (M ICON BASE), as a control glyph — the same mark m3's own M button wears.
 *
 * NOT the app icon: the launcher icon is M ICON `mapping` (public/icons, operator's decision of 2026-09-22).
 * Same three parallelograms the old public/icon.svg carried — bar 215 wide, gap 115, leaning 370 across a height
 * of 1068 — so the button that opens the app's own menu wears the family's mark rather than a generic hamburger.
 * `currentColor`, so it takes the active/idle colour of whatever it sits in.
 */
export const MarkIcon: React.FC<{ className?: string }> = ({ className }) => (
    <svg viewBox="0 0 1245 1068" className={className} fill="currentColor" aria-hidden="true">
        <path d="M0,1068 L215,1068 L585,0 L370,0 Z" />
        <path d="M330,1068 L545,1068 L915,0 L700,0 Z" />
        <path d="M660,1068 L875,1068 L1245,0 L1030,0 Z" />
    </svg>
);
