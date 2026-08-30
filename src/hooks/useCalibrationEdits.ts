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
 * toggles in useBinaryFile: nothing may survive onto an unrelated binary. No
 * undo stack, deliberately; the two exact recovery targets (base bytes,
 * reference bytes) are always present, and a stack that survived a reload
 * would be the stale-state bug the reset lists exist to prevent.
 *
 * `heldBack` is the manifest's OFF state: the edit is kept on screen but the
 * write carries nothing for it. `conflicts` is derived from the spans the
 * caller passes — the SAME spans that go into PatchExtras, so the row lock and
 * the byte arbitration cannot disagree.
 *
 * Every callback is stable and the return object is memoised: the write
 * manifest depends on this object, and an identity that churned per render
 * would rebuild every row on any unrelated state change.
 */
export function useCalibrationEdits(baseBuffer: ArrayBuffer | null, conflictSpans: RunSpan[]) {
    const [edits, setEdits] = useState<CalEditSet>(EMPTY_EDITS);
    const [heldBack, setHeldBack] = useState<ReadonlySet<string>>(new Set());
    // Reset-on-new-buffer as a render-time adjustment (React's prior-render
    // pattern), not an effect: a stale edit set must never be observable,
    // even for one commit.
    const [prevBuffer, setPrevBuffer] = useState<ArrayBuffer | null>(baseBuffer);
    if (prevBuffer !== baseBuffer) {
        setPrevBuffer(baseBuffer);
        setEdits(EMPTY_EDITS);
        setHeldBack(new Set());
    }
    // heldBack must not outlive its edit: an edit that self-drops (cells put
    // back to base) would otherwise leave a stale OFF that silently disarms
    // the NEXT edit of the same parameter. Render-time adjustment again.
    if ([...heldBack].some(id => !edits.has(id))) {
        setHeldBack(new Set([...heldBack].filter(id => edits.has(id))));
    }

    const conflicts = useMemo(() => editConflicts(edits, conflictSpans), [edits, conflictSpans]);

    /** What the write path receives: every edit that is neither held back nor conflicted. */
    const armedEdits = useMemo<CalEdit[]>(
        () => [...edits.values()].filter(e => !heldBack.has(e.paramId) && !conflicts.has(e.paramId)),
        [edits, heldBack, conflicts],
    );

    const editCell = useCallback((def: CalParamDef, base: DecodedRun, index: number, physical: number) => {
        setEdits(prev => withCellEdit(prev, def, base, index, physical).set);
    }, []);

    const bulkOp = useCallback((
        def: CalParamDef, base: DecodedRun, op: BulkOp, indices?: readonly number[],
    ) => {
        setEdits(prev => withBulkOp(prev, def, base, op, indices).set);
    }, []);

    const copyFromReference = useCallback((def: CalParamDef, base: DecodedRun, ref: DecodedRun | null) => {
        setEdits(prev => {
            const result = withReferenceCopy(prev, def, base, ref);
            return result.ok ? result.set : prev;
        });
    }, []);

    const revertParam = useCallback((paramId: string) => {
        setEdits(prev => withoutParam(prev, paramId));
        setHeldBack(prev => {
            if (!prev.has(paramId)) return prev;
            const next = new Set(prev);
            next.delete(paramId);
            return next;
        });
    }, []);

    const setHeld = useCallback((paramId: string, held: boolean) => {
        setHeldBack(prev => {
            const next = new Set(prev);
            if (held) next.add(paramId);
            else next.delete(paramId);
            return next;
        });
    }, []);

    /**
     * Re-arm a saved session's edits against the CURRENT buffer. `baseRaw` is
     * re-read from these bytes — the stored copy described the session's base
     * at save time, and an edit whose raw already matches the loaded bytes has
     * nothing left to say (a WRITE has landed it) and drops out.
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
        setEdits(next);
        setHeldBack(new Set());
    }, [baseBuffer]);

    return useMemo(() => ({
        edits, heldBack, conflicts, armedEdits,
        editCell, bulkOp, copyFromReference, revertParam, setHeld, restoreEdits,
    }), [edits, heldBack, conflicts, armedEdits,
        editCell, bulkOp, copyFromReference, revertParam, setHeld, restoreEdits]);
}

export type CalibrationEditsState = ReturnType<typeof useCalibrationEdits>;
