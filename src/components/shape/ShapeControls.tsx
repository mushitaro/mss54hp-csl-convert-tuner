'use client';

import React, { useState } from 'react';
import { Spline, X } from 'lucide-react';
import { Row, Slider, SubField } from '@/components/FilterPanelControls';
import type { ShapeRepairOptions, ShapeRepairResult } from '@/lib/ve-calculator/lowLoadShape';
import { LABEL, type ShapeWorkspace } from './shapeWorkspace';

/**
 * The repair's parameters, in the footer cluster — the slot LOG FIELDS holds on every other tab.
 *
 * It is here because of where it can be REACHED from, not to save room. Every one of these moves
 * the proposal, and what a proposal has to be judged against is either the grid or the profile
 * chart — which live on two different panes of a phone. A control docked to either one can only be
 * used while looking at that one. The footer is on screen from both (operator, 2026-08-26).
 *
 * It replaces LOG FIELDS rather than joining the row: that panel chooses which columns the log
 * table shows, which is nothing to do with this tab, and a fourth button would push the cluster
 * wider on the width where it already has the least to spare.
 *
 * ## Built from the panel vocabulary, not a second one
 *
 * Every control here is a `Row` from FilterPanelControls: a name, its live value, an explanation
 * behind its OWN ⓘ, and the control underneath. That is what RAW FILTER is made of, and this is
 * the same kind of thing — a set of thresholds that decide what happens to a map. One combined
 * help block at the top was the first attempt and it was wrong twice over: it is a wall of text
 * for whichever single rule you were asking about, and it is a second shape for a panel the app
 * already has one of (operator, 2026-08-26).
 *
 * ## No outside-click backdrop, and the open state is not held here
 *
 * The house popover catches outside clicks with a full-screen backdrop, and that is right for a
 * menu: you pick one thing and it goes away. This is a workbench — it is open BECAUSE you are
 * switching between the grid and the chart while moving a slider, and the pane switcher is an
 * outside click, so the backdrop shut the panel on the very gesture it exists to survive. It
 * closes on its own button or its X.
 *
 * `controlsOpen` lives in the workspace for the same reason plus one more: there are two of these
 * mounted, the wide cluster's and the footer's, and they must not disagree about whether the panel
 * is up.
 */
export const ShapeControls: React.FC<{
    shape: ShapeWorkspace;
    onApply: (r: ShapeRepairResult | null, opts: ShapeRepairOptions) => void;
    /** Footer placement, matching FieldVisibilityPanel — see its own note. */
    openUp?: boolean;
}> = ({ shape, onApply, openUp }) => {
    const {
        t, opts, set, applied, proposal, shownRepair, anchorCount, ready, shapeBlocked,
        controlsOpen, setControlsOpen, view, selected,
    } = shape;
    /**
     * Whether the 2-D cut's axis slider is on screen, and therefore whether this panel has to be
     * 24px SHORTER on a phone.
     *
     * Shorter, not higher, and the first attempt got that backwards. The panel is anchored to the
     * bottom of the viewport and grows UPWARD, so raising the anchor raises its TOP — straight into
     * the pane it is supposed to stay out of. Measured at 375x812: `bottom-[84px]` put the top at
     * 452 against a slider whose bottom was at 471, which is the overlap it was meant to prevent.
     *
     * The anchor was already right. What the slider costs is the CLEARANCE the max-height was
     * tuned for — it added 24px to the bottom of the graph pane, leaving 5px between the panel's
     * top and the pane's last control. So the height gives that back.
     *
     * Read from the workspace rather than passed in, because the workspace is already what both
     * halves share and a prop would be a second place for this to be true. Same condition as the
     * slider's own: 2-D, with a cell picked.
     */
    const clearsCutSlider = view === 'profile' && !!selected;
    /** Which rows have their explanation open. A set, so two can be. */
    const [infoFor, setInfoFor] = useState<ReadonlySet<string>>(() => new Set());
    const row = (id: string) => ({
        id,
        infoLabel: t.info,
        open: infoFor.has(id),
        onToggleInfo: () => setInfoFor(prev => {
            const next = new Set(prev);
            if (!next.delete(id)) next.add(id);
            return next;
        }),
    });

    /** Armed at a glance, without opening it: this is the one control on the tab whose state
     *  changes the bytes, and it is now behind a tap. Violet is this app's armed role. */
    const armed = !!applied;

    return (
        <div className="relative">
            <button
                onClick={() => setControlsOpen(!controlsOpen)}
                disabled={!ready}
                className={`p-2 rounded transition-colors disabled:opacity-40 disabled:cursor-default
                    ${controlsOpen ? 'text-blue-400 bg-slate-800'
                        : armed ? 'text-violet-300 hover:bg-slate-800'
                            : 'text-slate-400 hover:text-blue-400 hover:bg-slate-800'}`}
                title={LABEL.controlsTitle}
            >
                <Spline className="w-4 h-4" />
            </button>

            {controlsOpen && (
                /*
                 * No border: slate-900 on a slate-950 page plus shadow-xl separates it twice
                 * already (tsunagi-m-design → Popover panel).
                 *
                 * The height is capped well under the house's 453px, and that is not a style
                 * choice: this panel exists to be used WHILE watching the picture it changes, and
                 * at 453px on an 812px screen it stood in front of most of it.
                 *
                 * 45svh was the first answer and it came back a second time (operator,
                 * 2026-08-26): the rewritten option copy is three to four sentences per row
                 * instead of one, so opening two ⓘ now reaches the cap where it used to sit well
                 * under it, and the cap IS the coverage. 34svh keeps the top two thirds of the
                 * pane clear — where a surface and a profile both put their subject — and the
                 * panel scrolls for the rest. The wide layout has room beside the map, so it only
                 * comes down from 453 to 400.
                 */
                <div className={`${openUp
                    ? (clearsCutSlider
                        ? 'fixed inset-x-3 bottom-[60px] max-h-[min(31svh,276px)]'
                        : 'fixed inset-x-3 bottom-[60px] max-h-[min(34svh,300px)]')
                    : 'absolute right-0 top-10 w-[280px] max-h-[min(55dvh,400px)]'}
                    overflow-y-auto overscroll-contain bg-slate-900 rounded-lg shadow-xl z-50 p-4
                    animate-in fade-in zoom-in-95 duration-200`}>
                    <div className="flex justify-between items-center mb-3 border-b border-slate-800 pb-2">
                        <h3 className="text-[10px] font-bold text-slate-300 uppercase tracking-widest flex items-center gap-2">
                            <Spline className="w-3 h-3" />
                            {LABEL.controls}
                        </h3>
                        <button onClick={() => setControlsOpen(false)} className="text-slate-500 hover:text-slate-300">
                            <X className="w-4 h-4" />
                        </button>
                    </div>

                    {/* Every one is a physical rule; the two numbers are how far it may go. */}
                    <div className="space-y-4">
                        <Row {...row('monotone')} label={LABEL.monotone} hint={t.optMonotone}
                            toggle={{ checked: opts.monotone, onChange: v => set('monotone', v) }} />

                        <Row {...row('blend')} label={LABEL.blend} hint={t.optBlend}
                            toggle={{ checked: opts.blend, onChange: v => set('blend', v) }} />

                        {/* STEP CAP belongs to SMOOTH the way the gate thresholds belong to their
                            gate — one rule, one number, one row. */}
                        <Row {...row('smooth')} label={LABEL.smoothGain} hint={t.optSmooth}
                            toggle={{ checked: opts.smoothGain, onChange: v => set('smoothGain', v) }}>
                            <div className="pt-1">
                                <SubField label={LABEL.ratioCap} dim={!opts.smoothGain}
                                    value={`${opts.gainRatioMax.toFixed(1)}x`}>
                                    <Slider min={1.1} max={4} step={0.1} value={opts.gainRatioMax}
                                        disabled={!opts.smoothGain}
                                        onChange={v => set('gainRatioMax', v)} />
                                </SubField>
                            </div>
                        </Row>

                        {/* The one that carries a correction past its own evidence — the panel's
                            danger accent, which does not shout until it is on. */}
                        <Row {...row('extend')} label={LABEL.extrapolate} hint={t.optExtend}
                            toggle={{
                                checked: opts.extrapolate, accent: 'accent-red-500',
                                onChange: v => set('extrapolate', v),
                            }} />

                        <Row {...row('axis')} label={LABEL.axis} hint={t.optAxis}
                            value={opts.axis === 'opening' ? LABEL.axisOpening
                                : opts.axis === 'rpm' ? LABEL.axisRpm : LABEL.axisBoth}>
                            {/* The same button APPLY is, three times: this is a CHOICE that arms
                                the next proposal, not a view switch, and it sits four rows above a
                                filled button that means the same kind of thing (operator,
                                2026-08-26). The underline tab it used to be is the graph pane's
                                control, for choosing what to look at. */}
                            <div className="grid grid-cols-3 gap-1.5 pt-1">
                                {([['opening', LABEL.axisOpening], ['rpm', LABEL.axisRpm], ['both', LABEL.axisBoth]] as const)
                                    .map(([v, l]) => (
                                        <button key={v} type="button" onClick={() => set('axis', v)}
                                            className={`px-2 py-1.5 rounded text-[10px] font-bold uppercase tracking-widest transition-colors ${opts.axis === v
                                                ? 'bg-blue-600 text-white hover:bg-blue-500'
                                                : 'bg-slate-800 text-slate-500 hover:text-slate-300'}`}>
                                            {l}
                                        </button>
                                    ))}
                            </div>
                        </Row>

                        <Row {...row('maxMove')} label={LABEL.maxMove} hint={t.optMaxMove}
                            value={`${(opts.maxRepairFrac * 100).toFixed(0)} %`}>
                            <Slider min={0.01} max={0.30} step={0.01} value={opts.maxRepairFrac}
                                onChange={v => set('maxRepairFrac', v)} />
                        </Row>

                        <div className="pt-3 border-t border-slate-800 space-y-2">
                            <p className="text-[10px] text-slate-600 leading-relaxed">
                                {t.anchorsNote(anchorCount)}
                            </p>
                            {shownRepair && shownRepair.shapedCount > 0 && (
                                <p className="text-[10px] font-mono text-violet-300">
                                    {shownRepair.shapedCount} {LABEL.shapedCells}
                                    {shownRepair.refusedCount > 0
                                        ? ` · ${shownRepair.refusedCount} ${LABEL.refusedCells}` : ''}
                                </p>
                            )}
                            {/* The one filled button in this panel, because it is the one action —
                                the house reserves a fill for exactly that. */}
                            {/* REFUSED UNTIL THE MAP HAS SETTLED, and the reason is rendered
                                rather than left in a title: a `title` has no hover on a phone,
                                which is where this tab is read. REVERT is never blocked — undoing
                                a repair that is already on the map cannot be the unsafe direction. */}
                            {shapeBlocked && !applied && (
                                <p className="text-[9px] text-amber-400 leading-snug">{shapeBlocked}</p>
                            )}
                            <button
                                onClick={() => onApply(applied ? null : (proposal?.shapedCount ? proposal : null), opts)}
                                disabled={!applied && (!proposal?.shapedCount || !!shapeBlocked)}
                                title={!applied && shapeBlocked ? shapeBlocked : undefined}
                                className={`w-full px-3 py-2 rounded text-[10px] font-bold uppercase tracking-widest transition-colors
                                    ${applied ? 'bg-violet-900 text-violet-200 hover:bg-violet-800'
                                        : proposal?.shapedCount && !shapeBlocked ? 'bg-blue-600 text-white hover:bg-blue-500'
                                            : 'bg-slate-800 text-slate-600 cursor-not-allowed'}`}>
                                {applied ? LABEL.revert : LABEL.apply}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};
