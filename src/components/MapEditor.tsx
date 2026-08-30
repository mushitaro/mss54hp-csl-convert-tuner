'use client';

import React from 'react';
import { VEMap } from '@/lib/types';
import clsx from 'clsx'; // Install clsx if not already
import { Info } from 'lucide-react';
import { useDialogLang } from '@/hooks/useDialogLang';

interface Props {
    mapData: VEMap;
    diffData?: number[][]; // Percentage diff
    hitData?: number[][]; // Hit counts
    weightData?: number[][]; // [NEW] Cell Weights
    className?: string;
    /**
     * Pixels of scroll room to keep BELOW the last row, for whatever overlays the foot of this box.
     *
     * The cell readout on LAMBDA and TUNED is `absolute bottom-0` over this grid, and scrolled to
     * the end it covered the last three rows — RO 65, 85 and 100, the top of the load axis and the
     * part of a CSL conversion actually being tuned. Room past the last row lets them scroll clear.
     *
     * Padding rather than a shorter box: shortening would move every row up the instant a cell was
     * tapped, which is exactly what the readout is an overlay to avoid.
     */
    bottomInset?: number;
    /** 1 is the size this grid has always been. See CELL/HEAD below. */
    zoom?: number;

    // --- What the numbers ARE ------------------------------------------------------------------
    // The grid itself has always been generic over xAxis.length / yAxis.length; only the labels
    // were pinned to the VE map. Defaults reproduce those strings exactly, so every existing call
    // site is unchanged. Supplied when the same grid shows a different table — KF_RF_KORR_DRREL is
    // 12 x 6 on rpm x exhaust-temperature delta, and calling its rows "RO %" would be a lie in the
    // one place a reader looks to find out what they are seeing.
    rowLabel?: string;
    colLabel?: string;
    valueLabel?: string;
    rowFormat?: (value: number) => string;
    valueFormat?: (value: number) => string;
    /** Per-cell text appended to the cell's tooltip. Used for coverage and rejection reasons. */
    cellNote?: (row: number, col: number) => string | undefined;
    /** Cells to render as inert — present, readable, and not part of the result. */
    mutedCells?: boolean[][];
    /**
     * Which cells the evidence gate accepted, straight from the calculation that made this map.
     *
     * When given it — and not a sample count — decides the faint/mid boundary, because that
     * boundary means "was this cell rewritten" and this is the answer to that question. A count
     * cannot be: the gate tests samples AND weight, and a cell reaching 10 samples usually carries
     * a weight near 2.5, so it is refused while a count-only test would paint it as written.
     */
    acceptedData?: boolean[][];
    /** The faint/mid edge for grids finalised somewhere else, with no accepted map to show — the
     *  correction table and the inertia pane. Ignored when `acceptedData` is given. */
    coverageThin?: number;
    /** Where the top band starts: enough samples that there is nothing left to gain by driving
     *  this cell again. A display threshold only; no calculation reads it. */
    coverageOk?: number;

    /**
     * Tap a cell to select it.
     *
     * The reason this exists: everything this grid knows about a cell beyond its value — the sample
     * count, the weight, the rejection reason — lives in the `title` attribute, and a `title` has no
     * hover on a touch screen. On the device this app is actually used on, in a car, that evidence
     * is unreachable. Selection moves it somewhere a finger can get to: the caller renders the
     * detail beside or below the grid and this only says which cell to render.
     *
     * Absent, the grid behaves exactly as it always has — no cursor change, no click target.
     */
    onCellSelect?: (row: number, col: number) => void;
    /** Which cell is selected, if any. Owned by the caller so it can survive a view switch. */
    selected?: { row: number; col: number } | null;
    /**
     * Override the text colour of one cell, as a Tailwind class.
     *
     * For grids whose signal is not coverage and not a diff. LOW LOAD's slope view is the case:
     * what matters there is a gain that has gone NEGATIVE (filling falling as the throttle opens)
     * or that steps by more than 1.6x against the interval below, and neither is a magnitude this
     * component could infer from the numbers it was handed. The background is left to the usual
     * rules, so a caller that passes no `hitData` and no `diffData` gets plain cells with its own
     * text colour on them — which is exactly what the slope table looked like before it moved here.
     */
    cellTint?: (row: number, col: number) => string | undefined;
    /**
     * Show only rows `[first, last]` INCLUSIVE, indexed into `mapData.yAxis`.
     *
     * For showing one band of a table that is one table — LOW LOAD is rows 1-12 of `kf_rf_soll`,
     * not a grid of its own. Row indices passed to `cellNote`, `onCellSelect` and every data array
     * stay indices into the FULL map, so a caller never has to translate between two coordinate
     * spaces. Out-of-range or inverted bounds are clamped rather than throwing.
     */
    rowRange?: [number, number];
}

/**
 * The grid's natural geometry at zoom 1, in px, and the only place these numbers live.
 *
 * Scaled by multiplication rather than by `transform: scale()`, which would be the obvious way and
 * is the wrong one here: this table's row and column headers are `position: sticky`, and a transform
 * on an ancestor becomes their containing block — the headers would stop sticking to the scroll port
 * and start sticking to the table, which is the one thing that makes a 20x24 grid readable on a
 * phone. Multiplying the widths keeps `table-fixed` intact too, so the 6.9s auto-layout pass this
 * grid was rescued from stays gone.
 */
const CELL = 50;   // per RPM column
const HEAD = 64;   // the RO % axis down the left
const FONT = 12;   // text-xs
const LINE = 16;   // …and its line-height, which has to scale with it or tall text clips
const PAD_HEAD = 8; // p-2 on the header cells
const PAD_CELL = 4; // p-1 on the data cells

// Coverage bands for the hit heat. These are ABSOLUTE sample counts, deliberately
// not a fraction of the busiest cell: the question this heat answers is "have I
// gathered enough here yet", which has a fixed answer per cell. Normalising by the
// max made the whole map fade as one cell filled up — the map got darker the longer
// you drove, which is backwards for spotting the gaps you still need to cover.
//
// Still a DISPLAY threshold, and still not the calculation's — but the relationship
// between the two changed on 2026-08-15. calculator.ts now has a real gate
// (minCellSamples, default 10) where before it had only `weightSum > 0.1`, i.e. none.
// So these bands sit ABOVE the gate on purpose: the gate answers "may this cell move",
// and the bands answer "should I go drive this area more", which is a higher bar. A
// cell can legitimately be tinted thin and still have been written.
//
// Defaults, overridable per session — see LogFilterConfig.coverageThin. Named constants
// rather than inline numbers because InertiaPanel shows the same bands over a different
// pipeline and the two must not drift apart.
//
// The numbers come from a measurement, not from taste. Session #902 — 657 s of driving,
// 1600 raw samples, 751 surviving the filters at 2.44 Hz — put 155 of the 480 cells above
// zero and produced this tail:
//
//     >= 10: 82 cells    >= 50: 16 cells    >= 150: 0 cells
//     >= 30: 33 cells    >= 100: 4 cells    (busiest cell: 130)
//
// So the old 10/30 pair painted a third of the map "covered" after one drive, which is the
// flattery karter16 was pointing at. 50/200 says what he meant instead: one good run gets a
// handful of cells to the middle band, and the top band is a multi-run target. Reachable —
// 200 samples is ~82 s of valid time in one cell at this rate — but not by accident.
export const COVERAGE_THIN_DEFAULT = 50;   // below this: some data, not enough to trust
export const COVERAGE_OK_DEFAULT = 200;    // at or above this: enough samples to act on

// One ice blue (#8FD8F2) over the table's slate-900, separated by lightness only —
// the palette rule in globals.css. Kept inside the original 0–0.30 alpha range: this
// is a dark instrument, and a filled cell has to stay a tint on the table rather than
// become a bright panel sitting on top of it. 0.30 is the ceiling the relative ramp
// already used, so the brightest cell here is no brighter than the brightest cell was.
const COVERAGE_ALPHA_THIN = 0.10;
const COVERAGE_ALPHA_OK = 0.20;
const COVERAGE_ALPHA_FULL = 0.30;
/** The ice blue itself, as channels, so the legend swatches below are the same paint as the cells
 *  rather than a second copy of it that can drift. */
const COVERAGE_RGB = '143, 216, 242';

/**
 * The diff fill's ramp, named because the legend has to quote it.
 *
 * A difference under the dead band is left transparent — the map is a 3-decimal table and 0.4 %
 * of a filling value is not a change anybody is going to act on. Above it the fill runs from
 * ALPHA_MIN to ALPHA_MAX, and the legend needs the point where it stops getting darker or it would
 * be describing a ramp that keeps going.
 */
const DIFF_DEAD_BAND = 0.5;   // %
const DIFF_SCALE = 5.0;       // % that would map to DIFF_GAIN before clamping
const DIFF_GAIN = 0.6;
const DIFF_ALPHA_MIN = 0.1;
const DIFF_ALPHA_MAX = 0.7;
/** Where the ramp reaches ALPHA_MAX and the colour stops saying anything more. */
const DIFF_SATURATES_AT = (DIFF_ALPHA_MAX * DIFF_SCALE) / DIFF_GAIN;
const DIFF_BLUE = '10, 155, 219';
const DIFF_RED = '241, 26, 34';

/**
 * What the fill means, in the reader's language — behind the ⓘ in the corner of every grid.
 *
 * The colour is the one thing on this screen that nobody can look up. A number has a header and a
 * unit; a 10 %-alpha tint has neither, and the operator asked outright what the faintest one meant
 * and why a LAMBDA cell reading 1.000 was tinted at all (2026-08-25). It was a fair question with
 * an answer that is not guessable: on a coverage grid the fill is not the value, it is HOW MUCH
 * EVIDENCE the cell has, so 1.000 tinted means "driven, and the trim came out at no correction"
 * while 1.000 untinted means "never driven, this is just the initial value".
 *
 * Two rules, one per grid, decided by what the caller passed — so the legend states the rule this
 * table is actually using rather than both. Band labels switch language; the axis names, the sample
 * counts and the percentages stay as they are, because they are the machine's own words.
 */
const LEGEND = {
    ja: {
        heading: 'CELL FILL',
        none: '未走行 — サンプル 0。値は初期値のまま',
        thinGate: 'データ不足 — 通ってはいるが、書き換えの根拠に足りない',
        thinCount: (n: number) => `${n} サンプル未満 — データはあるが足りない`,
        written: '書き換え対象',
        full: (n: number) => `${n} サンプル以上 — これ以上走っても得るものは少ない`,
        evidence: '濃さは値ではなく証拠の量です。同じタブの 3D 面は逆に、値そのもので塗ります。',
        deadBand: (p: string) => `${p}% 未満 — 無色。動かす意味のない差`,
        leaner: '減量側（値が下がった）',
        richer: '増量側（値が上がった）',
        ramp: (p: string) => `濃さは差の大きさで、${p}% で上限に達します。`,
        plain: 'このグリッドは塗りません。色は文字色だけが意味を持ちます。',
    },
    en: {
        heading: 'CELL FILL',
        none: 'not driven — 0 samples, the value is still the initial one',
        thinGate: 'not enough data — it has some, not enough to rewrite from',
        thinCount: (n: number) => `under ${n} samples — it has data, not enough of it`,
        written: 'written',
        full: (n: number) => `${n}+ samples — little left to gain by driving it again`,
        evidence: 'The fill is how much EVIDENCE a cell has, not its value. The 3D surface on the '
            + 'same tab is the other way round: it colours by the value.',
        deadBand: (p: string) => `under ${p}% — left unpainted, not a difference worth acting on`,
        leaner: 'less (the value came down)',
        richer: 'more (the value went up)',
        ramp: (p: string) => `Depth is the size of the difference, and stops deepening at ${p}%.`,
        plain: 'This grid is not filled. Only the text colour carries meaning here.',
    },
};

/**
 * Memoised. Every cell builds a clsx string and an inline style, and there are 480 of them; the
 * hidden pane still renders (it is `display:none`, not unmounted), so without this every unrelated
 * state change in the page rebuilt the whole grid twice over.
 */
export const MapEditor: React.FC<Props> = React.memo(function MapEditor({
    mapData, diffData, hitData, weightData, className, bottomInset, zoom = 1,
    rowLabel = 'RO %', colLabel = 'RPM', valueLabel = 'RF %',
    rowFormat = (v: number) => v.toFixed(2),
    valueFormat = (v: number) => v.toFixed(3),
    cellNote, mutedCells, acceptedData,
    coverageThin = COVERAGE_THIN_DEFAULT, coverageOk = COVERAGE_OK_DEFAULT,
    onCellSelect, selected, rowRange, cellTint,
}) {
    // Render a scrollable grid
    // Styles: Dark mode table
    const cell = Math.round(CELL * zoom);
    const head = Math.round(HEAD * zoom);
    const type = { fontSize: `${(FONT * zoom).toFixed(1)}px`, lineHeight: `${(LINE * zoom).toFixed(1)}px` };
    const padHead = `${Math.round(PAD_HEAD * zoom)}px`;
    const padCell = `${Math.round(PAD_CELL * zoom)}px`;

    const lg = LEGEND[useDialogLang()];
    const [legendOpen, setLegendOpen] = React.useState(false);
    /**
     * The bands this particular grid can actually show, in the order a reader meets them.
     *
     * Built from the same three inputs the fill above is: `diffData` wins where it exists, `hitData`
     * gives the coverage bands, and a grid with neither is not filled at all. A legend that listed
     * both rules would be describing a table that does not exist — every caller passes one.
     */
    const { bands, footer } = React.useMemo(() => {
        const swatch = (rgb: string, a: number) => `rgba(${rgb}, ${a})`;
        if (diffData) {
            return {
                bands: [
                    { fill: 'transparent', label: lg.deadBand(String(DIFF_DEAD_BAND)) },
                    { fill: swatch(DIFF_BLUE, 0.45), label: lg.leaner },
                    { fill: swatch(DIFF_RED, 0.45), label: lg.richer },
                ],
                footer: lg.ramp(DIFF_SATURATES_AT.toFixed(1)),
            };
        }
        if (hitData) {
            return {
                bands: [
                    { fill: 'transparent', label: lg.none },
                    {
                        fill: swatch(COVERAGE_RGB, COVERAGE_ALPHA_THIN),
                        label: acceptedData ? lg.thinGate : lg.thinCount(coverageThin),
                    },
                    { fill: swatch(COVERAGE_RGB, COVERAGE_ALPHA_OK), label: lg.written },
                    { fill: swatch(COVERAGE_RGB, COVERAGE_ALPHA_FULL), label: lg.full(coverageOk) },
                ],
                footer: lg.evidence,
            };
        }
        return { bands: [], footer: lg.plain };
    }, [diffData, hitData, acceptedData, coverageThin, coverageOk, lg]);

    // The rows to draw, as indices into the full map. Clamped rather than validated: a band that
    // runs off the end of a shorter table should show what there is, not throw in a render.
    const lastRow = mapData.yAxis.length - 1;
    const firstShown = rowRange ? Math.max(0, Math.min(rowRange[0], lastRow)) : 0;
    const lastShown = rowRange ? Math.max(firstShown, Math.min(rowRange[1], lastRow)) : lastRow;

    return (
        <div className={clsx('overflow-auto h-full', className)}
            style={bottomInset ? { paddingBottom: bottomInset } : undefined}>
            {/* `table-fixed` with a stated width, not `w-full` with automatic layout.
                Automatic layout has to measure every cell before it can settle a column, and there
                are 480 of them — so each time this pane came back from `display:none` the browser
                re-solved the whole grid. Measured on a 6x-throttled CPU: a single 6.9 s task on the
                first switch to the map and about 1.3 s on every one after it, which is the whole of
                the switching lag. Fixed layout reads the widths off the first row and stops.
                The width is stated rather than left at `w-full` because `table-fixed` would
                otherwise divide the container between the columns and collapse the horizontal
                scroll this grid depends on: 20 columns of 50px plus the 64px load axis. */}
            <table
                className="table-fixed text-right border-collapse bg-slate-900"
                style={{ width: `${mapData.xAxis.length * cell + head}px`, ...type }}
            >
                <thead className="sticky top-0 bg-slate-800 z-10">
                    <tr>
                        <th
                            className="text-slate-400 border-b border-r border-slate-700 sticky left-0 bg-slate-800 z-20 relative"
                            style={{ width: `${head}px`, padding: padHead }}
                        >
                            {/* The axes used to be a `title` here, which Chrome for Android shows on
                                neither tap nor long-press — so on the device this grid is read on,
                                in a car, the one place that said what the rows and columns were did
                                not exist. Same rule as the filter panel: the explanation lives
                                behind the ⓘ, never in a title. */}
                            <button
                                type="button"
                                onClick={() => setLegendOpen(v => !v)}
                                aria-expanded={legendOpen}
                                aria-label="What the colours mean"
                                className={`w-full flex items-center justify-center transition-colors ${legendOpen ? 'text-blue-400' : 'text-slate-400 hover:text-slate-200'}`}
                            >
                                <Info className="w-3.5 h-3.5" />
                            </button>
                            {/* Anchored to this cell, which is sticky in both directions — so the
                                panel rides with the corner and stays put while the grid scrolls
                                under it. Absolute, so it adds nothing to a `table-fixed` column
                                whose width is load-bearing, and z-30 to clear the header (z-10),
                                the corner itself (z-20) and the sticky row labels (z-5). */}
                            {legendOpen && (
                                <div
                                    className="absolute top-full left-0 mt-1 z-30 w-[248px] max-w-[80vw] text-left
                                               bg-slate-900 border border-slate-700 rounded shadow-xl p-2.5 space-y-2 font-sans"
                                    style={{ fontSize: '10px', lineHeight: '15px' }}
                                >
                                    <div className="flex items-baseline justify-between gap-2">
                                        <span className="text-[9px] text-slate-500 font-bold uppercase tracking-widest">
                                            {lg.heading}
                                        </span>
                                        <span className="text-[9px] text-slate-600 font-mono truncate">
                                            {rowLabel} · {colLabel} · {valueLabel}
                                        </span>
                                    </div>
                                    <div className="space-y-1">
                                        {bands.map(b => (
                                            <div key={b.label} className="flex items-start gap-2">
                                                <span
                                                    className="w-3.5 h-3.5 rounded-sm shrink-0 mt-px border border-slate-700"
                                                    style={{ backgroundColor: b.fill }}
                                                />
                                                <span className="text-slate-400">{b.label}</span>
                                            </div>
                                        ))}
                                    </div>
                                    <p className="text-slate-500 leading-relaxed">{footer}</p>
                                </div>
                            )}
                        </th>
                        {mapData.xAxis.map((rpm, i) => (
                            <th key={i} className="text-slate-300 font-mono border-b border-slate-700" style={{ width: `${cell}px`, padding: padHead }}>
                                {rpm}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {mapData.yAxis.slice(firstShown, lastShown + 1).map((load, i) => {
                        const rowIdx = firstShown + i;
                        return (
                        <tr key={rowIdx} className="hover:bg-slate-800/50">
                            <td className="text-slate-300 font-mono border-r border-slate-700 sticky left-0 z-[5] bg-slate-900 font-bold" style={{ padding: padHead }}>
                                {rowFormat(load)}
                            </td>
                            {mapData.data[rowIdx].map((val, colIdx) => {
                                const diff = diffData ? diffData[rowIdx][colIdx] : 0;
                                const hits = hitData ? hitData[rowIdx][colIdx] : 0;
                                const weight = weightData ? weightData[rowIdx][colIdx] : 0;

                                let textColor = 'text-slate-400';
                                let style = {};

                                // If hits exist and no diff (or low diff logic), apply heat map
                                // User asked to prioritize seeing hits by color
                                const hasHits = hits > 0;

                                if (hasHits && (!diffData)) {
                                    // Ice blue (#8FD8F2) = "the log actually visited this cell", the same
                                    // OK/present role emerald-* now carries. Safe to share the blue family
                                    // with the lean-diff fill below: the guard above means a cell can never
                                    // paint both, and diffData is all-or-nothing for the whole table.
                                    //
                                    // Three levels, one meaning each: the cell was driven and REFUSED,
                                    // it was driven and REWRITTEN, or it holds enough that there is no
                                    // more to gain by driving it. The first boundary is the gate's own
                                    // verdict where there is one, so the colour cannot disagree with
                                    // what was written; the second is a count, because "enough" is.
                                    const rewritten = acceptedData
                                        ? !!acceptedData[rowIdx]?.[colIdx]
                                        : hits >= coverageThin;
                                    const alpha =
                                        !rewritten ? COVERAGE_ALPHA_THIN
                                            : hits >= coverageOk ? COVERAGE_ALPHA_FULL
                                                : COVERAGE_ALPHA_OK;
                                    style = { backgroundColor: `rgba(${COVERAGE_RGB}, ${alpha})` };
                                    // Every band stays dark enough for the light text the rest of the
                                    // table uses, so the numbers do not change colour as coverage builds.
                                    textColor = 'text-slate-300';
                                }

                                // If diff exists, colorize (Overrides hit map or combines?)
                                // Diff is usually more critical for Tuning, so let's keep Diff priority if it exists
                                if (diffData) {
                                    // DiffData is passed as Percentage Difference (e.g. -9.5, +5.0) from page.tsx
                                    // So deviation is simply the value itself.
                                    const deviation = diff;
                                    const absDeviation = Math.abs(deviation);

                                    if (absDeviation >= DIFF_DEAD_BAND) {
                                        // The ramp the legend quotes: DEAD_BAND up to SATURATES_AT,
                                        // ALPHA_MIN to ALPHA_MAX. Named constants rather than inline
                                        // numbers so the explanation behind the ⓘ cannot describe a
                                        // ramp this stopped using.
                                        const intensity = Math.min(
                                            Math.max((absDeviation / DIFF_SCALE) * DIFF_GAIN, DIFF_ALPHA_MIN),
                                            DIFF_ALPHA_MAX);

                                        if (deviation > 0) {
                                            // Positive Diff (New > Old) -> Adding fuel -> RED (or customized)
                                            // Usually adding fuel = Richer map setting
                                            style = { backgroundColor: `rgba(${DIFF_RED}, ${intensity})` }; // M-red base
                                            textColor = 'text-red-100';
                                        } else {
                                            // Negative Diff (New < Old) -> Removing fuel -> BLUE
                                            style = { backgroundColor: `rgba(${DIFF_BLUE}, ${intensity})` }; // M-blue base
                                            textColor = 'text-blue-100';
                                        }
                                    }
                                }

                                const muted = mutedCells?.[rowIdx]?.[colIdx] ?? false;
                                const note = cellNote?.(rowIdx, colIdx);
                                // Last word on the text colour, after the coverage and diff rules
                                // have had theirs — a caller supplying this knows something about
                                // the cell the grid cannot see in the number.
                                const tint = cellTint?.(rowIdx, colIdx);
                                if (tint) textColor = tint;
                                const isSelected = selected?.row === rowIdx && selected?.col === colIdx;

                                return (
                                    <td
                                        key={colIdx}
                                        style={{
                                            ...style,
                                            padding: padCell,
                                            // An inset shadow rather than a ring or an outline: the
                                            // table is `border-collapse`, so a ring lands under the
                                            // neighbouring cell's border on two of the four sides.
                                            ...(isSelected ? { boxShadow: 'inset 0 0 0 2px #26AEE4' } : {}),
                                        }}
                                        onClick={onCellSelect ? () => onCellSelect(rowIdx, colIdx) : undefined}
                                        className={clsx(
                                            'border border-slate-800 font-mono transition-colors relative group',
                                            hasHits ? 'font-bold' : 'opacity-80',
                                            // Dimmed, not hidden. A cell that carries a measurement
                                            // the tune declined to use still has to be readable —
                                            // that is what tells you WHY it was declined.
                                            muted && 'opacity-40',
                                            onCellSelect && 'cursor-pointer',
                                            // Selection wins over the muted dimming: you selected it
                                            // BECAUSE it was refused, and reading it at 40 % while
                                            // the detail strip talks about it is the wrong way round.
                                            isSelected && 'opacity-100'
                                        )}
                                        title={`${colLabel}: ${mapData.xAxis[colIdx]}, ${rowLabel}: ${load}\n`
                                            + `${valueLabel}: ${val}\nHits: ${hits}\nWeight: ${weight.toFixed(2)}`
                                            + (note ? `\n${note}` : '')}
                                    >
                                        <span className={textColor}>
                                            {diffData ? `${val > 0 ? '+' : ''}${val.toFixed(1)}%` : valueFormat(val)}
                                        </span>
                                        {diff !== 0 && Math.abs(val - diff) > 0.001 && (!diffData) && ( /* Only show small diff tag if val != diff (i.e. not in Diff View) */
                                            <span className="absolute bottom-0 right-0 text-[8px] opacity-70 px-0.5">
                                                {diff.toFixed(1)}%
                                            </span>
                                        )}
                                    </td>
                                );
                            })}
                        </tr>
                        );
                    })}
                </tbody>
            </table>
        </div>
    );
});
