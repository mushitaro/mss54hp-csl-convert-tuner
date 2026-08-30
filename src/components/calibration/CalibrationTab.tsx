'use client';

import React from 'react';
import type { IndexedCatalog } from '@/lib/calibration/catalog';
import type { CalibrationDataState } from '@/hooks/useCalibrationData';
import type { CalibrationEditsState } from '@/hooks/useCalibrationEdits';
import type { CalibrationWorkspace } from './useCalibrationWorkspace';
import { CalibrationTree } from './CalibrationTree';
import { LogicDiagram } from './LogicDiagram';
import { t } from '@/lib/calibration-graph/calib-i18n';
import { useDialogLang } from '@/hooks/useDialogLang';
import { useWideLayout } from '@/hooks/useWideLayout';

/**
 * The CALIBRATION tab's left-pane body: the collapsible tree beside the logic
 * diagram, which is the whole of the main area — the differences list it used
 * to share this space with now hangs off the compare bar, where the question it
 * answers is asked.
 */
export function CalibrationTab({
    catalog,
    catalogError,
    data,
    edits,
    ws,
}: {
    catalog: IndexedCatalog | null;
    catalogError: string | null;
    data: CalibrationDataState;
    edits: CalibrationEditsState;
    ws: CalibrationWorkspace;
}) {
    const lang = useDialogLang();
    const wide = useWideLayout();

    if (catalogError) {
        return (
            <div className="h-full flex flex-col items-center justify-center gap-3">
                <p className="text-[11px] text-red-400 font-mono max-w-[80%] truncate">{catalogError}</p>
                <button
                    onClick={data.retryCatalog}
                    className="h-[24px] px-3 rounded bg-slate-800 text-[10px] font-bold tracking-widest text-blue-400 hover:text-blue-300 transition"
                >
                    RETRY
                </button>
            </div>
        );
    }
    if (!catalog) {
        return (
            <div className="h-full flex items-center justify-center">
                <p className="text-[10px] font-bold tracking-widest text-slate-600 animate-pulse">LOADING CATALOG…</p>
            </div>
        );
    }

    const graph = catalog.graph;
    const editedIds = new Set([...edits.edits.keys()]);

    /**
     * Below 900px the tree and the diagram take turns.
     *
     * Measured at 360x800: the tree's own `min-w-[240px]` took 240 of the 360
     * and left the diagram 88, with 1,867 of its 1,949px off screen — port
     * labels cut at both ends and the zoom controls past the right edge. Two
     * panes sharing a phone is two unusable panes, and the app already settles
     * that at the top level the same way. The way back is the rail the tree
     * collapses to, which is on screen the whole time.
     */
    const showDiagram = wide || ws.treeCollapsed;

    /** Picking something IS the request to look at it. */
    const select = (id: string) => {
        ws.select(id);
        if (!wide) ws.setTreeCollapsed(true);
    };

    return (
        <div className="h-full w-full min-h-0 flex">
            <CalibrationTree
                graph={graph}
                selectedId={ws.selected}
                editedIds={editedIds}
                onSelect={select}
                collapsed={ws.treeCollapsed}
                onToggleCollapse={() => ws.setTreeCollapsed(!ws.treeCollapsed)}
            />

            <div className={`flex-1 min-w-0 min-h-0 ${showDiagram ? '' : 'hidden'}`}>
                {ws.root || ws.selected ? (
                    <LogicDiagram
                        g={graph}
                        rootId={ws.root ?? ws.selected!}
                        selectedId={ws.selected ?? ws.root!}
                        trail={ws.trail}
                        onSelect={ws.select}
                        onBack={ws.back}
                    />
                ) : (
                    <p className="p-4 text-[11px] text-slate-500">{t(lang, 'selectPrompt')}</p>
                )}
            </div>
        </div>
    );
}
