/**
 * What the next write carries — the shapes and the two derivations, without any JSX.
 *
 * Separated from the component so it can be tested directly: `armedLabels` is what the hub row
 * SAYS, and `anythingArmed` is the same question asked of every group at once, and those two must
 * never come apart. If the summary can list a table the count does not — or the reverse — the hub
 * is telling the driver one thing and doing another, which is the exact failure the manifest was
 * built to end.
 *
 * Neither is the WRITE gate any more. The ring is live when the BIN the write would send differs
 * from the BIN in the car, byte for byte (page.tsx `writeChangesCar`, lib/db/carImage.ts) — a
 * question about bytes, which "is any row ON" could never answer for a row switched OFF.
 */

/** A row inside one group's menu. */
export interface ManifestRow {
    id: string;
    label: string;
    /** 'toggle' rows switch; 'sealed' and 'info' rows only explain themselves; 'readout' rows are
     *  a consequence of another row rather than a decision (MAP off, LTFT floor). */
    kind: 'toggle' | 'sealed' | 'info' | 'readout';
    checked?: boolean;
    /** Toggle rows only: greyed out, with `lockReason` rendered as text AND kept as the tooltip —
     *  a `title` has no hover on a phone, which is where this is read. */
    disabled?: boolean;
    lockReason?: string;
    /** Short status beside the label: a cell count, 'derived', a drift mark, a readout's value. */
    status?: string;
    statusTone?: 'ok' | 'warn' | 'danger' | 'muted';
    /**
     * The ECU's own name for what this row writes, with its address and shape — e.g.
     * `kf_rf_soll · 0xD356 · 24x20`. Rendered under the label, in mono, always.
     *
     * Only RESTORE rows carry one, and that is the distinction rather than an oversight. A WRITE
     * row's subject is the derivation ("the cells this drive earned"), and the table it lands in is
     * the same one every time. A RESTORE row's subject IS the table: the question it answers is
     * "which bytes go back to what", and the answer is a definition name (operator, 2026-08-26).
     * Mono, because it is read off the ECU rather than being app furniture.
     */
    symbol?: string;
    /** Accessible name for the row's ⓘ. Follows the reader's language like the explanation does. */
    infoLabel?: string;
    onToggle?: (on: boolean) => void;
}

export interface ManifestGroup {
    id: string;
    /** The word on the hub row, and the word in the menu's header — say it once. */
    title: string;
    /** One line under the title IN THE MENU saying what membership means. Not on the hub row. */
    caption: string;
    rows: ManifestRow[];
}

/**
 * What a group currently contributes, as the names the reader recognises.
 *
 * Derived on every render from the same rows the menu switches, so the collapsed summary cannot
 * disagree with the open menu. A disabled row never counts however its toggle is stored: the
 * stored value can outlive the evidence that justified it (a session reopened against a different
 * binary), and the summary answers "what will happen", not "what was once switched on".
 */
export function armedLabels(group: ManifestGroup): string[] {
    return group.rows
        .filter(r => r.kind === 'toggle' && r.checked && !r.disabled)
        .map(r => r.label);
}

/** Whether ANY group contributes something. It used to gate the central ring's WRITE; the ring now
 *  asks the bytes instead (see the header), and this stays the summary's own consistency check. */
export function anythingArmed(groups: ManifestGroup[]): boolean {
    return groups.some(g => armedLabels(g).length > 0);
}
