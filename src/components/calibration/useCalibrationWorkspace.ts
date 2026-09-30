import { useCallback, useState } from 'react';
import type { Indexed } from '@/lib/calibration-graph/graph';
import type { CalVariant } from '@/lib/calibration/types';

/**
 * How the selected parameter is shown.
 *
 * `map` is the grid of numbers — a tuner's map IS its table, which is why it
 * carries that name and leads the row. `heat` is the same grid as colour seen
 * from above; `2d` one section through it; `3d` the surface.
 */
export type CalGraphMode = 'map' | '2d' | '3d' | 'heat';

/**
 * Selection and view state for the calibration workbench.
 *
 * ## One subject
 *
 * There is exactly one selection — the SUBJECT — and it is whatever the reader
 * last picked: a parameter, a signal, or a block. Every view answers a
 * different question about that same thing, and none of them may quietly
 * answer about something else.
 *
 * It was two: `root` (what the picture was drawn around) and `selected` (what
 * was lit inside it), with a rule that a parameter set the second and left the
 * first alone. The rule reads well and is wrong in use. Picking `kf_rf_soll`
 * rooted the picture on ONE of the two blocks that read it — `owningBlock`
 * ranks the candidates and takes the best — so the map you selected was not the
 * subject of anything on screen, the other block that reads it was nowhere, and
 * the listing, ordered from the picture's upstream edge, opened on a block six
 * columns away. 383 of the 2,236 referenced parameters have more than one user,
 * so that was not a corner.
 *
 * The substitution is gone. `select` sets the subject and nothing else; where
 * the picture goes is the picture's business, and it is told to go to the thing
 * that was picked. The trail is what makes following a chain reversible.
 */
export function useCalibrationWorkspace(graph: Indexed | null) {
    const [subject, setSubject] = useState<string | null>(null);
    const [trail, setTrail] = useState<string[]>([]);
    const [graphMode, setGraphMode] = useState<CalGraphMode>('map');
    /** Which axis runs along the bottom of the 2-D section: `x` draws the row
     *  through the selected cell, `y` its column. Meaningless for a curve,
     *  which has one axis — the control is hidden there rather than lying. */
    const [sectionAxis, setSectionAxis] = useState<'x' | 'y'>('x');
    const [treeCollapsed, setTreeCollapsed] = useState(false);

    // Stable callbacks — the tree hands `select` to ~700 memoised rows, and a fresh
    // identity per render would undo exactly the memoisation it exists to enable.
    const select = useCallback((id: string) => {
        if (!graph?.byId.has(id)) return;
        setTrail(prev => {
            const seen = prev.indexOf(id);
            return seen >= 0 ? prev.slice(0, seen + 1) : [...prev, id];
        });
        setSubject(id);
    }, [graph]);

    /** Step back to something already on the trail; the trail truncates there. */
    const back = useCallback((id: string) => {
        if (!graph?.byId.has(id)) return;
        setTrail(prev => {
            const seen = prev.indexOf(id);
            return seen >= 0 ? prev.slice(0, seen + 1) : prev;
        });
        setSubject(id);
    }, [graph]);

    return {
        subject, trail, select, back,
        graphMode, setGraphMode,
        sectionAxis, setSectionAxis,
        treeCollapsed, setTreeCollapsed,
    };
}

export type CalibrationWorkspace = ReturnType<typeof useCalibrationWorkspace>;

/**
 * Which two variants are being compared, and whether the visual shows their
 * difference.
 *
 * Its own hook, ahead of everything else, because the BYTES behind a variant
 * have to be fetched before the catalog can decode them — and the catalog is
 * what the workspace above is built from. Folding this in would make the two
 * hooks each other's input.
 */
/**
 * Which of the three readings the numbers are.
 *
 * It was a boolean — values or the difference — and that quietly settled a
 * question nobody had asked it to: WHOSE values. The answer was always the
 * subject's, so the reference's own numbers were the one thing the compare bar
 * named that could never be looked at.
 */
export type CalCompareView = 'subject' | 'delta' | 'reference';

export function useCalibrationCompare() {
    const [subject, setSubject] = useState<CalVariant>('tuned');
    const [reference, setReference] = useState<CalVariant>('base');
    const [view, setView] = useState<CalCompareView>('subject');
    return { subject, setSubject, reference, setReference, view, setView };
}
