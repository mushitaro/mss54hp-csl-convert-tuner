import { useCallback, useState } from 'react';
import type { Indexed } from '@/lib/calibration-graph/graph';
import { owningBlock } from '@/lib/calibration-graph/block-tree';
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
 * Selection and view state for the calibration workbench — the notes viewer's
 * model, ported: only a BLOCK moves the picture; a parameter lights up inside
 * it (or, with nothing rooted yet, roots its owning block). The trail is what
 * makes following a chain reversible.
 */
export function useCalibrationWorkspace(graph: Indexed | null) {
    const [selected, setSelected] = useState<string | null>(null);
    const [root, setRoot] = useState<string | null>(null);
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
        if (!graph) return;
        const picked = graph.byId.get(id);
        setTrail(prev => {
            const seen = prev.indexOf(id);
            return seen >= 0 ? prev.slice(0, seen + 1) : [...prev, id];
        });
        setSelected(id);
        // Only a block moves the picture. A parameter is found inside it.
        if (picked?.t === 'func') setRoot(id);
        else if (picked) setRoot(prev => prev ?? (owningBlock(graph, picked)?.id ?? null));
    }, [graph]);

    /**
     * Go to a parameter, wherever it lives.
     *
     * `select` deliberately leaves the picture where it is — inside the tree
     * you are reading one block, and a parameter is something found IN it, so
     * moving the diagram on every row would take the block away from you.
     *
     * A jump list is the opposite case. It names parameters you did not know
     * about, in blocks you are not looking at, and a row that changed the
     * numbers without moving the picture reads as a row that did nothing. So
     * this one re-roots: the block that owns the parameter becomes the picture.
     */
    const jump = useCallback((id: string) => {
        if (!graph) return;
        select(id);
        const picked = graph.byId.get(id);
        if (!picked || picked.t === 'func') return;
        const owner = owningBlock(graph, picked)?.id;
        if (owner) setRoot(owner);
    }, [graph, select]);

    const back = useCallback((id: string) => {
        if (!graph) return;
        const picked = graph.byId.get(id);
        setTrail(prev => {
            const seen = prev.indexOf(id);
            return seen >= 0 ? prev.slice(0, seen + 1) : prev;
        });
        setSelected(id);
        if (picked?.t === 'func') setRoot(id);
    }, [graph]);

    return {
        selected, root, trail, select, jump, back,
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
