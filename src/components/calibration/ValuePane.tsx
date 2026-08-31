'use client';

import React, { useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { Scale } from 'lucide-react';
import type { CalParamDef, CalVariant } from '@/lib/calibration/types';
import type { DecodedAxis, DecodedParam, DecodedRun } from '@/lib/calibration/decode';
import type { BulkOp } from '@/lib/calibration/edits';
import type { CalGraphMode } from './useCalibrationWorkspace';
import { displayName } from '@/lib/calibration-graph/names';
import { t } from '@/lib/calibration-graph/calib-i18n';
import { useDialogLang } from '@/hooks/useDialogLang';
import { CompareBar, type CompareOption } from '@/components/CompareBar';
import { ChartLoading } from '@/components/ChartLoading';
import { HeatField, ScalarReadout, SectionChart } from './ValueChart';
import { CalibrationValueGrid } from './CalibrationValueGrid';

/** The same 3-D surface the tuning tabs use, so a map looks the same wherever
 *  it is opened. Dynamic + ssr:false for the reason every Plotly mount here is. */
const MapVisualizer = dynamic(
    () => import('@/components/MapVisualizer').then(m => m.MapVisualizer),
    { ssr: false, loading: () => <ChartLoading /> },
);

/**
 * The visualize-and-input surface.
 *
 * The compare bar on top is the DIFFERENCE tab's own control: SUBJECT is what
 * is drawn, REFERENCE is what it is drawn against, and both are chosen from the
 * app's own records — this session's bytes, the shipped reference, or a stored
 * session. The balance beside them switches the whole visual to the DIFFERENCE
 * between the two, which is the question those selectors exist to pose.
 *
 * Below it one row picks the FORM, and under the picture sit the two things
 * that act on it: the slider that walks the pinned axis, and the edit ops.
 */

const TEXT = {
    ja: {
        add: 'ADD',
        scale: '× SCALE',
        copyRef: 'COPY REF',
        revert: 'REVERT',
        list: 'LIST',
        modeDelta: 'Δ',
        modeValues: 'VALUES',
        bannerDelta: 'Δ SUBJECT − REFERENCE',
        bannerValues: 'SUBJECT VALUES',
        diffTitle: '差分そのものを表示します。押すと実値に戻ります。',
        valuesTitle: 'SUBJECT の実値を表示中です（色は REFERENCE との差）。押すと差分そのものに切り替わります。',
        sameVariant: '比較対象が同じです。REFERENCE を変えると差分が出ます。',
        copyRefHint: 'この項目の全セルを REFERENCE の値で置き換えます。',
        revertHint: 'この項目の編集を取り消し、読み込み時の値に戻します。',
        signHint: '符号を反転します。マイナスなら引き算・縮小になります。',
        addHint: '表示中のセルに、この値を足します（符号ぶん引きます）。',
        scaleHint: '表示中のセルに、この値を掛けます。',
        clearCell: '選択を解除して一括編集に戻ります。',
    },
    en: {
        add: 'ADD',
        scale: '× SCALE',
        copyRef: 'COPY REF',
        revert: 'REVERT',
        list: 'LIST',
        modeDelta: 'Δ',
        modeValues: 'VALUES',
        bannerDelta: 'Δ SUBJECT − REFERENCE',
        bannerValues: 'SUBJECT VALUES',
        diffTitle: 'Showing the differences themselves. Press for the values.',
        valuesTitle: 'Showing SUBJECT values, tinted by their distance from REFERENCE. Press for the differences themselves.',
        sameVariant: 'Both selectors name the same bytes — pick another REFERENCE to see a difference.',
        copyRefHint: 'Replace every cell of this item with the REFERENCE value.',
        revertHint: 'Drop this item\'s edits and go back to the values as loaded.',
        signHint: 'Flip the sign — a minus subtracts, and scales down.',
        addHint: 'Add this to every cell on screen (subtract, with the sign set to minus).',
        scaleHint: 'Multiply every cell on screen by this.',
        clearCell: 'Clear the selection and go back to editing the whole view.',
    },
} as const;

function ModeButton({ on, onClick, disabled, children }: {
    on: boolean; onClick: () => void; disabled?: boolean; children: React.ReactNode;
}) {
    return (
        <button
            onClick={onClick}
            disabled={disabled}
            className={`pb-0.5 text-[9px] font-bold uppercase tracking-widest border-b-2 transition disabled:opacity-30 ${on ? 'text-blue-400 border-blue-400' : 'text-slate-600 border-transparent hover:text-slate-300'}`}
        >
            {children}
        </button>
    );
}

/** Axis positions and their printed labels, for whichever axis a view runs along. */
function axisTicks(axis: DecodedAxis | null, n: number): { xs: number[]; label: (i: number) => string } {
    if (!axis) {
        return { xs: Array.from({ length: n }, (_, i) => i), label: i => String(i) };
    }
    if (axis.kind === 'labels') {
        return { xs: axis.labels.map((_, i) => i), label: i => axis.labels[i] ?? String(i) };
    }
    return { xs: axis.values, label: i => fmtTick(axis.values[i] ?? i) };
}

function fmtTick(v: number): string {
    if (!Number.isFinite(v)) return '—';
    return Number.isInteger(v) ? String(v) : v.toFixed(Math.abs(v) < 1 ? 2 : 1);
}

/** Same breakpoints in both images? Compared on the decoded arrays — the exact
 *  values both views label their cells with. */
function axesEqual(a: DecodedParam['x'], b: DecodedParam['x']): boolean {
    if (!a || !b) return a === b;
    if (a.kind === 'labels' || b.kind === 'labels') return true; // label axes have no bytes to differ
    return a.values.length === b.values.length && a.values.every((v, i) => v === b.values[i]);
}

export function ValuePane({
    def,
    subjectRun,
    referenceRun,
    subjectDecoded,
    referenceDecoded,
    editedMask,
    hasEdit,
    graphMode,
    onGraphMode,
    sectionAxis,
    onSectionAxis,
    subject,
    onSubject,
    reference,
    onReference,
    compareOptions,
    diffMode,
    onDiffMode,
    diffCount,
    onShowList,
    onEditCell,
    onBulkOp,
    onCopyRef,
    onRevert,
}: {
    def: CalParamDef | null;
    /** The values SUBJECT holds, and REFERENCE's — null when they are the same. */
    subjectRun: DecodedRun | null;
    referenceRun: DecodedRun | null;
    subjectDecoded: DecodedParam | null;
    referenceDecoded: DecodedParam | null;
    editedMask: boolean[] | null;
    hasEdit: boolean;
    graphMode: CalGraphMode;
    onGraphMode: (m: CalGraphMode) => void;
    sectionAxis: 'x' | 'y';
    onSectionAxis: (a: 'x' | 'y') => void;
    subject: CalVariant;
    onSubject: (v: CalVariant) => void;
    reference: CalVariant;
    onReference: (v: CalVariant) => void;
    compareOptions: CompareOption[];
    /** Draw the DIFFERENCE between the two variants instead of the values. */
    diffMode: boolean;
    onDiffMode: (on: boolean) => void;
    /** How many parameters differ, for the balance's badge. */
    diffCount: number | null;
    /** Ask for the list of them. It lives in the hub, which this pane does not
     *  own, so turning compare on says so rather than rendering it here. */
    onShowList?: () => void;
    onEditCell: (index: number, physical: number) => void;
    /** `indices` is what is currently on screen; omitted means the whole run. */
    onBulkOp: (op: BulkOp, indices?: readonly number[]) => void;
    onCopyRef: () => void;
    onRevert: () => void;
}) {
    const lang = useDialogLang();
    const text = TEXT[lang];
    const [selectedCell, setSelectedCell] = useState<number | null>(null);
    const [amount, setAmount] = useState('');
    /** The sign of a bulk step, as a control rather than as a character to
     *  type: a phone's decimal keypad has no minus key, and "subtract 0.05
     *  from this row" is half of what this bar is for. */
    const [amountSign, setAmountSign] = useState<1 | -1>(1);
    const [cellDraft, setCellDraft] = useState<string | null>(null);
    const paneRef = useRef<HTMLDivElement>(null);
    const [paneWidth, setPaneWidth] = useState(360);

    useEffect(() => {
        const el = paneRef.current;
        if (!el) return;
        const observer = new ResizeObserver(entries => {
            const w = entries[0]?.contentRect.width;
            if (w) setPaneWidth(w - 8);
        });
        observer.observe(el);
        return () => observer.disconnect();
    }, []);

    // A new selection is a new question; the cell cursor does not carry over.
    const [prevDefId, setPrevDefId] = useState<string | undefined>(def?.id);
    if (prevDefId !== def?.id) {
        setPrevDefId(def?.id);
        setSelectedCell(null);
    }

    const rows = def?.rows ?? 1;
    const cols = def?.cols ?? (def?.run ? def.run.count : 1);
    const isMap = def?.kind === 'map' && !!def.rows && !!def.cols;
    const isCurve = def?.kind === 'curve';

    // The three drawn forms only exist for the shapes that have them; the grid
    // always does. A mode that cannot draw is disabled rather than drawing
    // something else, and an impossible one falls back to the grid.
    const canHeat = isMap;
    const can3d = isMap;
    const can2d = isMap || isCurve;
    const effectiveMode: CalGraphMode =
        graphMode === 'heat' && canHeat ? 'heat'
            : graphMode === '3d' && can3d ? '3d'
                : graphMode === '2d' && can2d ? '2d'
                    : 'map';

    const selected = selectedCell === null ? null
        : { row: Math.floor(selectedCell / cols), col: selectedCell % cols };

    /** Whether there are two different images to subtract. A property of the
     *  SELECTORS, not of what happens to be selected — the balance is the
     *  compare bar's control, and it must not go dead because no parameter is
     *  open yet. */
    const comparing = subject !== reference && diffCount !== null;
    /** ...though drawing the difference still needs both runs for THIS item. */
    const showingDiff = diffMode && comparing && !!referenceRun;
    const editable = !!def && !def.lock.locked && def.runMathOk
        && subject === 'tuned' && !!subjectRun && !showingDiff;
    const amountNumber = Number(amount) * amountSign;
    const amountOk = amount.trim() !== '' && Number.isFinite(amountNumber);
    const canCopyRef = !!def && !def.lock.locked && def.runMathOk
        && subject === 'tuned' && comparing;

    const axesDiffer = !!referenceDecoded && !!subjectDecoded && (
        !axesEqual(subjectDecoded.x, referenceDecoded.x) || !axesEqual(subjectDecoded.y, referenceDecoded.y)
    );

    /** What the visual draws: the values, or subject minus reference. */
    const shownRun: DecodedRun | null = (() => {
        if (!subjectRun) return null;
        if (!showingDiff || !referenceRun) return subjectRun;
        return {
            raw: subjectRun.raw,
            phys: subjectRun.phys.map((p, i) => {
                const r = referenceRun.phys[i];
                return p === null || r === null || r === undefined ? null : p - r;
            }),
            errorCells: 0,
        };
    })();

    /** The grid, as rows of numbers, with an undecodable cell as NaN. */
    const gridOf = (run: DecodedRun | null): number[][] | null => {
        if (!run || !isMap) return null;
        const flat = run.phys.map(p => (p === null ? NaN : p));
        const out: number[][] = [];
        for (let r = 0; r < rows; r++) out.push(flat.slice(r * cols, (r + 1) * cols));
        return out;
    };

    const xTicks = axisTicks(subjectDecoded?.x ?? null, cols);
    const yTicks = axisTicks(subjectDecoded?.y ?? null, rows);
    const at = selected ?? { row: 0, col: 0 };

    /** In 2-D the section is drawn ALONG one axis and pinned at the other. */
    const fixed = sectionAxis === 'x'
        ? { index: at.row, count: rows, label: def?.yAxis?.label ?? 'Y', ticks: yTicks }
        : { index: at.col, count: cols, label: def?.xAxis?.label ?? 'X', ticks: xTicks };

    /**
     * WHICH cells a bulk step lands on: the ones on screen.
     *
     * In 2-D that is the one section being drawn, so "×0.98" moves the line
     * you are looking at and nothing else. Every other form shows the whole
     * run, so it stays the whole run. Null means "all".
     */
    const scopeIndices: number[] | null = effectiveMode === '2d' && isMap
        ? (sectionAxis === 'x'
            ? Array.from({ length: cols }, (_, c) => at.row * cols + c)
            : Array.from({ length: rows }, (_, r) => r * cols + at.col))
        : null;
    const scopeLabel = scopeIndices
        ? `${fixed.label} ${fixed.ticks.label(fixed.index)} · ${scopeIndices.length} CELLS`
        : `ALL ${def?.run?.count ?? 0} CELLS`;

    /**
     * The selected cell, as a number you can type and a slider you can drag.
     *
     * The slider spans this table's OWN range, widened a fifth either way and
     * clamped to what the field can hold — a slider across a 16-bit field's
     * whole domain moves thousands of counts per pixel and is no use for the
     * nudge this is for. Anything outside that goes in the box beside it.
     */
    const cellEdit = (() => {
        const run = def?.run;
        if (!run || selectedCell === null || !subjectRun || showingDiff) return null;
        const value = subjectRun.phys[selectedCell];
        if (value === null || value === undefined) return null;
        const finite = subjectRun.phys.filter((p): p is number => p !== null);
        const lo = Math.min(...finite, value);
        const hi = Math.max(...finite, value);
        const pad = (hi - lo || Math.abs(value) || 1) * 0.2;
        const limits = [run.scaling.toPhysical(run.signed ? (run.bits === 8 ? -128 : -32768) : 0),
        run.scaling.toPhysical(run.bits === 8 ? (run.signed ? 127 : 255) : (run.signed ? 32767 : 65535))]
            .filter(Number.isFinite)
            .sort((a, b) => a - b);
        const min = Math.max(lo - pad, limits[0] ?? lo - pad);
        const max = Math.min(hi + pad, limits[1] ?? hi + pad);
        // The step is what one raw count is worth HERE — measured, because a
        // reciprocal scaling's step varies by orders of magnitude across range.
        const raw = subjectRun.raw[selectedCell];
        const step = Math.abs(run.scaling.toPhysical(raw + 1) - value) || (max - min) / 100 || 1;
        const where = isMap
            ? `${def?.yAxis?.label ?? 'Y'} ${yTicks.label(at.row)} · ${def?.xAxis?.label ?? 'X'} ${xTicks.label(at.col)}`
            : `${def?.xAxis?.label ?? 'X'} ${xTicks.label(selectedCell)}`;
        return { value, min, max, step, where, index: selectedCell };
    })();

    const visual = (() => {
        if (!def || !shownRun) {
            return (
                <p className="text-[11px] text-slate-500 p-2">
                    {def ? t(lang, 'noValuesForBlock') : t(lang, 'selectPrompt')}
                </p>
            );
        }
        if (def.kind === 'constant') {
            return <ScalarReadout value={shownRun.phys[0]} raw={shownRun.raw[0]} units={def.run?.units} />;
        }

        if (effectiveMode === 'map') {
            return (
                <CalibrationValueGrid
                    def={def}
                    run={shownRun}
                    xAxis={subjectDecoded?.x ?? null}
                    yAxis={subjectDecoded?.y ?? null}
                    // In diff mode the cells ARE the difference, so colouring
                    // them against the reference a second time would be the
                    // same subtraction drawn twice.
                    diffAgainst={showingDiff ? null : referenceRun}
                    editedMask={subject === 'tuned' && !showingDiff ? editedMask : null}
                    mode={showingDiff ? 'signed' : referenceRun ? 'diff' : 'heat'}
                    selected={selectedCell}
                    onSelect={setSelectedCell}
                    onCommit={onEditCell}
                    readOnly={!editable}
                />
            );
        }

        if (effectiveMode === 'heat') {
            const grid = gridOf(shownRun);
            if (!grid) return null;
            return (
                <HeatField
                    grid={grid}
                    xLabel={def.xAxis?.label ?? 'X'}
                    yLabel={def.yAxis?.label ?? 'Y'}
                    xLabels={xTicks.label}
                    yLabels={yTicks.label}
                    selected={selected}
                    onSelectCell={(r, c) => setSelectedCell(r * cols + c)}
                    signed={showingDiff}
                    width={paneWidth}
                    height={280}
                />
            );
        }

        if (effectiveMode === '3d') {
            const grid = gridOf(shownRun);
            if (!grid) return null;
            return (
                <div className="h-[300px]">
                    <MapVisualizer
                        mapData={{ xAxis: xTicks.xs, yAxis: yTicks.xs, data: grid }}
                        title=""
                        xAxisLabel={def.xAxis?.label ?? 'X'}
                        yAxisLabel={def.yAxis?.label ?? 'Y'}
                        zAxisLabel={showingDiff ? 'Δ' : (def.run?.units && def.run.units !== '-' ? def.run.units : 'value')}
                        scale={showingDiff ? 'deviation' : 'magnitude'}
                        deviationMidpoint={0}
                    />
                </div>
            );
        }

        // 2-D: one section through the map, or the curve itself.
        const slice = (run: DecodedRun | null): number[] | null => {
            if (!run) return null;
            const phys = run.phys.map(p => (p === null ? NaN : p));
            if (!isMap) return phys;
            return sectionAxis === 'x'
                ? phys.slice(at.row * cols, (at.row + 1) * cols)
                : Array.from({ length: rows }, (_, r) => phys[r * cols + at.col]);
        };
        const along = !isMap || sectionAxis === 'x' ? xTicks : yTicks;
        const indexInSection = !isMap ? selectedCell : sectionAxis === 'x' ? at.col : at.row;
        return (
            <SectionChart
                xs={along.xs}
                xLabels={along.label}
                subject={slice(shownRun)!}
                // In diff mode the single line IS the difference; a reference
                // line beside it would be a second answer to one question.
                reference={showingDiff ? null : slice(referenceRun)}
                xLabel={(isMap && sectionAxis === 'y' ? def.yAxis?.label : def.xAxis?.label) ?? 'X'}
                yLabel={showingDiff ? 'Δ' : (def.run?.units && def.run.units !== '-' ? def.run.units : 'value')}
                selectedIndex={indexInSection}
                onSelectIndex={i => setSelectedCell(
                    !isMap ? i : sectionAxis === 'x' ? at.row * cols + i : i * cols + at.col,
                )}
                width={paneWidth}
                height={260}
            />
        );
    })();

    /** Enough digits to show a quantisation step without printing float noise. */
    const round = (v: number) => Number(v.toPrecision(8));

    const commitCell = () => {
        if (cellDraft === null) return;
        const parsed = Number(cellDraft);
        if (cellEdit && cellDraft.trim() !== '' && Number.isFinite(parsed)) {
            onEditCell(cellEdit.index, parsed);
        }
        setCellDraft(null);
    };

    const opButton = (label: string, enabled: boolean, onClick: () => void, title: string, tone = 'text-slate-300 hover:text-blue-400') => (
        <button
            onClick={onClick}
            disabled={!enabled}
            title={title}
            className={`h-[22px] px-2 rounded bg-slate-800 text-[9px] font-bold tracking-widest transition ${tone} disabled:opacity-30 disabled:pointer-events-none`}
        >
            {label}
        </button>
    );

    return (
        // `@container`, because what the rows below have to fit is THIS PANE,
        // not the viewport. The pane is 38.2% of a wide screen and the whole of
        // a narrow one, so a viewport breakpoint gets it wrong from both sides:
        // at 1000px wide the pane is 382px and overflows, at 360px it is 360px
        // and overflows, and the two would need different queries to say the
        // same thing.
        <div ref={paneRef} className="@container h-full min-h-0 flex flex-col">
            {/* SUBJECT vs REFERENCE, in the DIFFERENCE tab's own control and its
                own place: the first row of the visual, above everything it governs. */}
            <CompareBar
                options={compareOptions}
                subject={subject}
                onSubject={v => onSubject(v as CalVariant)}
                reference={reference}
                onReference={v => onReference(v as CalVariant)}
                trailing={
                    // The balance stays put. Two things used to move it: the
                    // list's trigger mounted beside it the moment this was
                    // pressed, which shoved the balance 45px left — a control
                    // that leaves when you press it — and the count is
                    // right-aligned at the end of the bar, so every digit it
                    // gained pushed the icon along too. The list lives in the
                    // hub now, and the count has a width whether it has a
                    // number in it or not.
                    <button
                        onClick={() => {
                            const next = !diffMode;
                            onDiffMode(next);
                            // Turning compare ON is the request to see WHICH
                            // ones differ, which is the list's whole job.
                            if (next) onShowList?.();
                        }}
                        disabled={!comparing}
                        title={!comparing ? text.sameVariant : showingDiff ? text.diffTitle : text.valuesTitle}
                        className={`shrink-0 flex items-center gap-1 h-[24px] px-2 rounded transition disabled:opacity-30 ${diffMode && comparing ? 'bg-slate-800 text-blue-400' : 'text-slate-400 hover:text-slate-200'}`}
                    >
                        <Scale className="w-3.5 h-3.5" />
                        {/* The mode is NOT named here. It was, and 46px of
                            label on a bar whose two selectors are already
                            `flex-1 min-w-0` took them to 32px and 21px at
                            360 — a switch made legible by making the controls
                            it sits beside unusable. It is named in the form
                            row instead, which is pinned rather than shared. */}
                        <span className="w-[28px] text-right tabular-nums text-[10px] font-mono">
                            {diffCount === null ? '—' : diffCount}
                        </span>
                    </button>
                }
            />

            {/* The form, and the axis a section runs along. Reserved height. */}
            <div className="h-[26px] flex-none flex items-center gap-3 px-1 overflow-x-auto no-scrollbar whitespace-nowrap">
                <span className="font-mono text-[11px] font-bold text-slate-100 truncate max-w-[38%]">
                    {def ? displayName(def.name) : '—'}
                </span>
                <div className="flex items-center gap-2">
                    <ModeButton on={effectiveMode === 'map'} onClick={() => onGraphMode('map')}>MAP</ModeButton>
                    <ModeButton on={effectiveMode === '2d'} disabled={!can2d} onClick={() => onGraphMode('2d')}>2D</ModeButton>
                    <ModeButton on={effectiveMode === '3d'} disabled={!can3d} onClick={() => onGraphMode('3d')}>3D</ModeButton>
                    <ModeButton on={effectiveMode === 'heat'} disabled={!canHeat} onClick={() => onGraphMode('heat')}>HEAT</ModeButton>
                </div>
                {/* What the numbers ARE, next to what shape they are drawn in,
                    and before the section controls so it survives a narrow
                    pane. It used to sit at the far end of this row — which
                    scrolls — and only appeared while they were differences, so
                    at 360 nothing on screen named either state. */}
                {comparing && (
                    <span className={`shrink-0 whitespace-nowrap text-[9px] font-bold uppercase tracking-widest ${showingDiff ? 'text-blue-400' : 'text-slate-400'}`}>
                        {showingDiff ? text.modeDelta : text.modeValues}
                    </span>
                )}
                {/* Only a map has two axes to section along; a curve has one, and
                    offering the choice there would be a control that does nothing. */}
                {effectiveMode === '2d' && isMap && (
                    <div className="flex items-center gap-2">
                        <span className="text-[8px] font-bold tracking-widest text-slate-600">ALONG</span>
                        <ModeButton on={sectionAxis === 'x'} onClick={() => onSectionAxis('x')}>X</ModeButton>
                        <ModeButton on={sectionAxis === 'y'} onClick={() => onSectionAxis('y')}>Y</ModeButton>
                    </div>
                )}
                {/* The long form of the same fact, for the room a desk has:
                    which way round the subtraction goes. The short form above
                    is the one that has to survive 360px. */}
                {comparing && (
                    <span className={`whitespace-nowrap text-[8px] font-bold tracking-widest ${showingDiff ? 'text-blue-400' : 'text-slate-500'}`}>
                        {showingDiff ? text.bannerDelta : text.bannerValues}
                    </span>
                )}
            </div>

            {/* One reserved caution line — it doubles as the empty spacer, so
                nothing below it moves when the caveat appears. */}
            <div className="h-[14px] flex-none px-1 text-[9px] text-amber-400 truncate">
                {axesDiffer ? t(lang, 'axesDiffer') : ''}
            </div>

            <div className="flex-1 min-h-0 overflow-auto px-1">{visual}</div>

            {/* UNDER the picture, because it moves the picture: the axis the
                2-D section is pinned at. Reserved so the ops bar never shifts. */}
            <div className="h-[20px] flex-none flex items-center gap-2 px-1">
                {effectiveMode === '2d' && isMap && def && (
                    <>
                        <span className="text-[9px] font-mono text-slate-400 whitespace-nowrap">
                            {fixed.label} = {fixed.ticks.label(fixed.index)}
                        </span>
                        <input
                            type="range"
                            min={0}
                            max={Math.max(0, fixed.count - 1)}
                            value={fixed.index}
                            onChange={e => {
                                const i = Number(e.target.value);
                                setSelectedCell(sectionAxis === 'x' ? i * cols + at.col : at.row * cols + i);
                            }}
                            className="flex-1 min-w-0 h-1 accent-blue-500"
                        />
                        <span className="text-[9px] font-mono text-slate-600 whitespace-nowrap">
                            {fixed.index + 1}/{fixed.count}
                        </span>
                    </>
                )}
            </div>

            {/* ONE editing row, and WHAT it edits is the selection.
                ────────────────────────────────────────────────────────────────
                A cell picked means you are working on that cell: a box for the
                value you know, a slider for the one you are looking for. None
                picked means you are working on the view: the same step applied
                to every cell the current form draws.

                They were two rows, and that asked the reader to notice which of
                two amount fields they were in. The selection already says which
                job is in front of you, so it chooses. The label on the left
                names the target either way, and clears the selection when the
                target is a cell. */}
            {/* Measured: the bulk-edit half needs 265px and COPY REF / REVERT
                131, so the row wants 406 and a phone gives it 360 — REVERT went
                off the right edge, which is exactly where a control that undoes
                an edit must not be. It wraps below 420 instead, and the taller
                height is RESERVED at that size rather than switched on by the
                wrap: selecting a cell swaps the left half for a narrower one,
                and a row that changed height on selection would jog the grid
                above it every time. */}
            <div className="h-[34px] @max-[420px]:h-[58px] flex-none flex flex-wrap content-center items-center gap-1.5 px-1 border-t border-slate-900">
                {cellEdit && editable ? (
                    <>
                        <button
                            onClick={() => setSelectedCell(null)}
                            title={text.clearCell}
                            className="shrink-0 flex items-center gap-1 max-w-[38%] text-[9px] font-mono text-slate-400 hover:text-slate-200 transition whitespace-nowrap"
                        >
                            <span className="truncate">{cellEdit.where}</span>
                            <span className="text-slate-600">✕</span>
                        </button>
                        <input
                            value={cellDraft ?? String(round(cellEdit.value))}
                            onChange={e => setCellDraft(e.target.value)}
                            onBlur={commitCell}
                            onKeyDown={e => {
                                if (e.key === 'Enter') { e.preventDefault(); commitCell(); }
                                else if (e.key === 'Escape') { e.preventDefault(); setCellDraft(null); }
                            }}
                            inputMode="decimal"
                            className="w-[72px] shrink-0 bg-slate-800 rounded px-2 h-[22px] text-[10px] font-mono text-right text-blue-400 outline-none focus:ring-1 focus:ring-blue-500"
                        />
                        <input
                            type="range"
                            min={cellEdit.min}
                            max={cellEdit.max}
                            step={cellEdit.step}
                            value={cellEdit.value}
                            onChange={e => { setCellDraft(null); onEditCell(cellEdit.index, Number(e.target.value)); }}
                            className="flex-1 min-w-0 h-1 accent-blue-500"
                        />
                    </>
                ) : (
                    <div className={`flex items-center gap-1.5 ${editable ? '' : 'opacity-40 pointer-events-none'}`}>
                        <span className="shrink-0 text-[9px] font-mono text-slate-400 whitespace-nowrap">{scopeLabel}</span>
                        <button
                            onClick={() => setAmountSign(s => (s === 1 ? -1 : 1))}
                            title={text.signHint}
                            className={`w-[22px] h-[22px] rounded bg-slate-800 text-[11px] font-bold transition ${amountSign === -1 ? 'text-red-400' : 'text-slate-300'}`}
                        >
                            {amountSign === -1 ? '−' : '+'}
                        </button>
                        <input
                            value={amount}
                            onChange={e => setAmount(e.target.value)}
                            inputMode="decimal"
                            placeholder="0.0"
                            className="w-[60px] bg-slate-800 rounded px-2 h-[22px] text-[10px] font-mono text-right text-slate-200 placeholder:text-slate-600 outline-none focus:ring-1 focus:ring-blue-500"
                        />
                        {opButton(text.add, amountOk, () => onBulkOp({ kind: 'add', amount: amountNumber }, scopeIndices ?? undefined), text.addHint)}
                        {opButton(text.scale, amountOk, () => onBulkOp({ kind: 'scale', amount: amountNumber }, scopeIndices ?? undefined), text.scaleHint)}
                    </div>
                )}
                {/* These act on the whole parameter either way, so they do not
                    move when the row's left half changes job. */}
                <div className="ml-auto shrink-0 flex items-center gap-1.5">
                    {opButton(text.copyRef, canCopyRef, onCopyRef, text.copyRefHint, 'text-indigo-400 hover:text-indigo-300')}
                    {opButton(text.revert, hasEdit, onRevert, text.revertHint, 'text-slate-400 hover:text-red-400')}
                </div>
            </div>
        </div>
    );
}
