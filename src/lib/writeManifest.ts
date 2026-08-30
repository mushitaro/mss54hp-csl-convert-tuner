/**
 * What the next write carries — the shapes and the two derivations, without any JSX.
 *
 * Separated from the component so it can be tested directly: `armedLabels` is what the hub row
 * SAYS, and `anythingArmed` is what the central ring's WRITE is GATED on, and those two must never
 * come apart. If the summary can list a table the gate does not count — or the reverse — the hub
 * is telling the driver one thing and doing another, which is the exact failure the manifest was
 * built to end.
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

/** Whether ANY group contributes something. The central ring's WRITE gates on this — an empty
 *  write produces a flash that reads back byte-identical to the BASE, which looks like a failure. */
export function anythingArmed(groups: ManifestGroup[]): boolean {
    return groups.some(g => armedLabels(g).length > 0);
}
