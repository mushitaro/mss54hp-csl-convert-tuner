import { useCallback, useMemo, useState } from 'react';
import type { CalParamDef } from '@/lib/calibration/types';
import type { DecodedRun } from '@/lib/calibration/decode';
import {
    type BulkOp, type CalEdit, type CalEditSet, type RunSpan,
    EMPTY_EDITS, editConflicts,
    withBulkOp, withCellEdit, withReferenceCopy, withoutParam,
} from '@/lib/calibration/edits';

/**
 * React wrapper over the pure edit set.
 *
 * The set clears on base-buffer IDENTITY change — the same rule as the patch
 * toggles in useBinaryFile: nothing may survive onto an unrelated binary.
 *
 * `heldBack` is the manifest's OFF state: the edit is kept on screen but the
 * write carries nothing for it. `conflicts` is derived from the spans the
 * caller passes — the SAME spans that go into PatchExtras, so the row lock and
 * the byte arbitration cannot disagree.
 *
 * Every callback is stable and the return object is memoised: the write
 * manifest depends on this object, and an identity that churned per render
 * would rebuild every row on any unrelated state change.
 *
 * ## Undo
 *
 * There was deliberately no undo here, on the grounds that the two exact
 * recovery targets — base bytes and reference bytes — are always present. That
 * holds for a FINISHED edit and does not help during one: REVERT throws away
 * everything done to a parameter in order to take back one keystroke, so the
 * working way to undo a wrong step was to remember the old number.
 *
 * The objection that note raised is still right, and it is why the history
 * lives in this state and nowhere else: **a stack that outlived its buffer
 * would be the stale-state bug the reset lists exist to prevent.** It is
 * cleared by the same identity check that clears the edits, it is never
 * persisted, and `restoreEdits` starts a fresh one rather than letting a saved
 * session be undone into a state it was never in.
 *
 * Value and history live in ONE state object. Pushing a snapshot from inside
 * `setEdits(prev => …)` while writing a separate `setPast` beside it would let
 * a render land between the two, and a history that disagrees with the value it
 * describes is worse than no history at all.
 */

/** How many steps back. Snapshots share their CalEdit objects, so this is cheap. */
const DEPTH = 200;

interface Snapshot {
    edits: CalEditSet;
    heldBack: ReadonlySet<string>;
}

interface EditState extends Snapshot {
    past: Snapshot[];
    future: Snapshot[];
    /**
     * What the last step acted on, so that dragging a slider is ONE step.
     *
     * The cell slider fires on every pixel of travel. Without this a drag
     * becomes two hundred history entries and undo stops being usable — it
     * would take two hundred presses to take back one movement. Consecutive
     * steps naming the same target replace each other; moving to a different
     * cell, or doing anything else, starts a new one.
     */
    lastTouch: string | null;
}

const EMPTY_STATE: EditState = {
    edits: EMPTY_EDITS,
    heldBack: new Set(),
    past: [],
    future: [],
    lastTouch: null,
};

export function useCalibrationEdits(baseBuffer: ArrayBuffer | null, conflictSpans: RunSpan[]) {
    const [state, setState] = useState<EditState>(EMPTY_STATE);
    const { edits, heldBack } = state;

    // Reset-on-new-buffer as a render-time adjustment (React's prior-render
    // pattern), not an effect: a stale edit set must never be observable, even
    // for one commit. The history goes with it.
    const [prevBuffer, setPrevBuffer] = useState<ArrayBuffer | null>(baseBuffer);
    if (prevBuffer !== baseBuffer) {
        setPrevBuffer(baseBuffer);
        setState(EMPTY_STATE);
    }
    // heldBack must not outlive its edit: an edit that self-drops (cells put
    // back to base) would otherwise leave a stale OFF that silently disarms
    // the NEXT edit of the same parameter. Render-time adjustment again.
    if ([...heldBack].some(id => !edits.has(id))) {
        setState(prev => ({
            ...prev,
            heldBack: new Set([...prev.heldBack].filter(id => prev.edits.has(id))),
        }));
    }

    const conflicts = useMemo(() => editConflicts(edits, conflictSpans), [edits, conflictSpans]);

    /** What the write path receives: every edit that is neither held back nor conflicted. */
    const armedEdits = useMemo<CalEdit[]>(
        () => [...edits.values()].filter(e => !heldBack.has(e.paramId) && !conflicts.has(e.paramId)),
        [edits, heldBack, conflicts],
    );

    /**
     * One user action: apply it, and record what it replaced.
     *
     * A step that changes nothing records nothing — putting a cell back to the
     * value it already holds must not cost an undo press.
     */
    const step = useCallback((touch: string | null, apply: (s: Snapshot) => Snapshot) => {
        setState(prev => {
            const next = apply(prev);
            if (next.edits === prev.edits && next.heldBack === prev.heldBack) return prev;
            const coalesce = touch !== null && touch === prev.lastTouch;
            return {
                ...next,
                past: coalesce
                    ? prev.past
                    : [...prev.past, { edits: prev.edits, heldBack: prev.heldBack }].slice(-DEPTH),
                future: [],
                lastTouch: touch,
            };
        });
    }, []);

    const editCell = useCallback((def: CalParamDef, base: DecodedRun, index: number, physical: number) => {
        step(`cell:${def.id}:${index}`, s => ({
            ...s, edits: withCellEdit(s.edits, def, base, index, physical).set,
        }));
    }, [step]);

    const bulkOp = useCallback((
        def: CalParamDef, base: DecodedRun, op: BulkOp, indices?: readonly number[],
    ) => {
        // Not coalesced: every press of ADD is a step the reader chose to take.
        step(null, s => ({ ...s, edits: withBulkOp(s.edits, def, base, op, indices).set }));
    }, [step]);

    const copyFromReference = useCallback((def: CalParamDef, base: DecodedRun, ref: DecodedRun | null) => {
        step(null, s => {
            const result = withReferenceCopy(s.edits, def, base, ref);
            return result.ok ? { ...s, edits: result.set } : s;
        });
    }, [step]);

    const revertParam = useCallback((paramId: string) => {
        step(null, s => {
            const held = new Set(s.heldBack);
            held.delete(paramId);
            return {
                edits: withoutParam(s.edits, paramId),
                heldBack: held.size === s.heldBack.size ? s.heldBack : held,
            };
        });
    }, [step]);

    const setHeld = useCallback((paramId: string, held: boolean) => {
        step(null, s => {
            const next = new Set(s.heldBack);
            if (held) next.add(paramId);
            else next.delete(paramId);
            return { ...s, heldBack: next };
        });
    }, [step]);

    const undo = useCallback(() => {
        setState(prev => {
            const snap = prev.past[prev.past.length - 1];
            if (!snap) return prev;
            return {
                ...snap,
                past: prev.past.slice(0, -1),
                future: [{ edits: prev.edits, heldBack: prev.heldBack }, ...prev.future].slice(0, DEPTH),
                // A step taken after an undo must not merge into the one it
                // just took back.
                lastTouch: null,
            };
        });
    }, []);

    const redo = useCallback(() => {
        setState(prev => {
            const [snap, ...rest] = prev.future;
            if (!snap) return prev;
            return {
                ...snap,
                past: [...prev.past, { edits: prev.edits, heldBack: prev.heldBack }].slice(-DEPTH),
                future: rest,
                lastTouch: null,
            };
        });
    }, []);

    /**
     * Re-arm a saved session's edits against the CURRENT buffer. `baseRaw` is
     * re-read from these bytes — the stored copy described the session's base
     * at save time, and an edit whose raw already matches the loaded bytes has
     * nothing left to say (a WRITE has landed it) and drops out.
     *
     * This starts a fresh history rather than becoming a step in the old one:
     * undoing a load would put the session into a state it was never in.
     */
    const restoreEdits = useCallback((stored: CalEdit[]) => {
        if (!baseBuffer) return;
        const view = new DataView(baseBuffer);
        const next = new Map<string, CalEdit>();
        for (const e of stored) {
            const bytes = e.bits / 8;
            if (e.raw.length !== e.count) continue;
            if (e.address < 0 || e.address + e.count * bytes > baseBuffer.byteLength) continue;
            const baseRaw: number[] = [];
            for (let i = 0; i < e.count; i++) {
                const off = e.address + i * bytes;
                baseRaw.push(e.bits === 8
                    ? (e.signed ? view.getInt8(off) : view.getUint8(off))
                    : (e.signed ? view.getInt16(off, false) : view.getUint16(off, false)));
            }
            if (e.raw.every((r, i) => r === baseRaw[i])) continue;
            next.set(e.paramId, { ...e, raw: [...e.raw], baseRaw });
        }
        setState({ ...EMPTY_STATE, edits: next });
    }, [baseBuffer]);

    const canUndo = state.past.length > 0;
    const canRedo = state.future.length > 0;

    return useMemo(() => ({
        edits, heldBack, conflicts, armedEdits,
        editCell, bulkOp, copyFromReference, revertParam, setHeld, restoreEdits,
        undo, redo, canUndo, canRedo,
    }), [edits, heldBack, conflicts, armedEdits,
        editCell, bulkOp, copyFromReference, revertParam, setHeld, restoreEdits,
        undo, redo, canUndo, canRedo]);
}

export type CalibrationEditsState = ReturnType<typeof useCalibrationEdits>;
