/**
 * What the hub's ring offers next in the VE chain, as a pure function of the workspace.
 *
 * ## Why it left page.tsx
 *
 * The decision lived inline in the page as a nested ternary, and the defect it carried could not be
 * tested from anywhere: its first test was `newMap ? 'write'`, so the moment a run derived a map the
 * ring said WRITE for good and START TUNE was unreachable. That was the right ring while a session
 * held one run. Since 7b1ebc5 a session keeps several (SessionLogRecord.runs) — and the operator,
 * standing at the car with a second run to record, found the screen demanding a WRITE instead:
 * 「同じセッションで2個以上取れるようにしてあるはずなのに、画面がWRITEを要求していてSTART TUNEできない」
 * (2026-10-24). The cure was approved as option A: after a run the ring is START TUNE, and writing
 * the tune is an explicit ARM on the WRITE wing.
 *
 * The IDLE and LLS chains stay in page.tsx untouched: their first test is already an ARMED
 * proposal (`idleTunedCells`, `llsMovedCells`), which is the shape this chain now has too.
 *
 * ## The chain
 *
 *     armed tune                          -> WRITE        (the ring is the write gate's button)
 *     RF KORR armed            (draft)    -> WRITE PATCH  (route A step 1: a table, no VE map)
 *     CALIBRATION edit armed   (draft)    -> WRITE PATCH
 *     build != car image                  -> WRITE PATCH  (a patch ON/OFF, archived included)
 *     a BASE in a session      (draft)    -> START TUNE   (a derived map waiting unarmed lands here)
 *     otherwise                           -> READ
 *
 * Every rung but the first is the chain as it was. The first used to be "a derived map exists"; it
 * is now "a derived map exists AND a row that writes it is armed". With nothing armed the chain
 * falls through exactly as it does for a session with no run yet — which is the point: an unarmed
 * tune is not a write, so it must not hold the ring the way an armed one does.
 *
 * ## Which rows count as "armed for the tune"
 *
 * The WRITE rows whose bytes are built FROM the derived map — read off `buildImage`, not off the
 * manifest's labels:
 *
 *   - ALPHA-N (`writeVe`)      -> `kf_rf_soll`, through `writtenVeGrid(writeVe ? newMap : null, …)`
 *   - WARMUP  (`writeWarmup`)  -> `kf_rf_soll_kath`, `generateWarmupMap(newMap …)` inside
 *                                 `if (newMap && writeWarmup)`; arming it without ALPHA-N is
 *                                 legitimate and writes a table, so it counts on its own.
 *
 * SHAPE is NOT a third. It is a mode on the ALPHA-N write: `writtenVeGrid` overlays its cells onto
 * the composed grid, and with ALPHA-N off there is no grid to overlay onto, so SHAPE alone writes
 * nothing (the manifest row cannot even read ON without ALPHA-N). RF KORR, IDLE, LLS and the
 * calibration edits are not derived from the VE map and have their own rungs.
 *
 * The toggles are the RAW ones the build reads, not the manifest's displayed state, so this cannot
 * disagree with `pendingBuild`: a `writeVe` left on under a lock still puts the map in the bytes,
 * and then WRITE is the true answer.
 */

export type RingAction = 'read' | 'tune' | 'write' | 'writePatch';

export interface VeRingInputs {
    /** A VE map derived from this session's run — page.tsx's `newMap`. */
    tuneDerived: boolean;
    /** ALPHA-N, the toggle `buildImage` reads (`writeVe`). */
    writeVe: boolean;
    /** WARMUP, the toggle `buildImage` reads (`writeWarmup`). */
    writeWarmup: boolean;
    /** The back-calculated KF_RF_KORR_DRREL, as armed (page.tsx's `rfKorrArmed`). */
    rfKorrArmed: boolean;
    /** At least one CALIBRATION tab edit armed. */
    calEditsArmed: boolean;
    /** THE WRITE GATE: the pending build differs from the car image (or failed to build). */
    writeChangesCar: boolean;
    /** A BASE is loaded (`currentMap`). */
    hasBase: boolean;
    /** A session is open (`currentSession`). */
    hasSession: boolean;
    /** The open session is archived — a record of what was flashed, never re-derived. */
    archived: boolean;
}

/** Is a row that writes the derived map armed? ALPHA-N or WARMUP, over a map that exists. */
export function tuneArmed(i: Pick<VeRingInputs, 'tuneDerived' | 'writeVe' | 'writeWarmup'>): boolean {
    return i.tuneDerived && (i.writeVe || i.writeWarmup);
}

/** The ring's next step in the VE chain (every mode but IDLE and LLS). See the file header. */
export function veRingAction(i: VeRingInputs): RingAction {
    if (tuneArmed(i)) return 'write';
    const open = i.hasBase && i.hasSession;
    // Route A step 1: a correction table with no VE map behind it. An EGT run produces exactly
    // that — its log has no trim, so no map is derived — and without this rung there would be no
    // way to send it. Draft-only, like every derivation.
    if (i.rfKorrArmed && open && !i.archived) return 'writePatch';
    // CALIBRATION edits — bytes worth sending with no VE derivation, the same shape as RF KORR.
    if (i.calEditsArmed && open && !i.archived) return 'writePatch';
    // The gate itself, and NOT draft-only: finalising is exactly an archived session's job, and any
    // patch change on a written session is a change to its car.
    if (i.writeChangesCar && open) return 'writePatch';
    // Tuning is a draft-only act: an archived session must never re-derive its own map.
    if (open && !i.archived) return 'tune';
    return 'read';
}

/**
 * Is the ring offering START TUNE over a tune that is waiting to be armed?
 *
 * The one state this change creates, and the one the notice line under the ring has to explain —
 * a derived map with START TUNE on the ring reads as "the run was lost" unless something says the
 * tune is there and which switch writes it. Only when that switch can actually be thrown
 * (`alphaNArmable`: the ALPHA-N row is on screen and not locked), so the line never names a row the
 * operator cannot reach.
 */
export function tuneAwaitsArm(i: {
    action: RingAction;
    tuneDerived: boolean;
    alphaNArmable: boolean;
}): boolean {
    return i.action === 'tune' && i.tuneDerived && i.alphaNArmable;
}
