/**
 * The VE map as the assistant reads it in one call: which cells this derivation writes and by how
 * much, which it refused and why, and where the drive put no data at all.
 *
 * tuner_moment sees two minutes of log. The operator asked (#984 notebook, 2026-10-24) for the
 * assistant to see the whole VE map and the whole run while driving; this is the map half,
 * runOverview.ts the run.
 *
 * NOTHING HERE IS COMPUTED AGAIN. Every number is read off what the calculation returned and the page
 * holds (useVeCalculation):
 *
 *   state       buildCoverage — the verdict the TUNED MAP paints, one per cell, from `rejectMap`
 *   remedy      coverageRemedy — the sentence the cell's detail strip shows for that refusal
 *   veNow       currentMap — the BASE the drive was derived against
 *   veNew       newMap — what the write would put in the cell; null where the cell was refused
 *   changePct   (veNew / veNow - 1) x 100 — the move the write makes (anti-ratchet and authority
 *               already applied, because that is what newMap holds)
 *   askPct      (demandMap - 1) x 100 — the weighted mean of trim x rf_korr near the cell: what the
 *               evidence ASKED for, defined for refused cells too ("drive here again" needs it)
 *   samples     hitMap — samples binned to the cell at any corner share
 *   weight      weightMap — the sum of those shares, the number the weight bar tests
 *
 * The visit count and n_eff behind 'few-visits' are not on the result (they live in the
 * calculator's grid cells and end in the verdict), so they are not here either: the reason says the
 * gate refused, and the remedy says what to drive. Re-deriving them here would be a second
 * calculation that could disagree with the first.
 *
 * Compact on purpose — a model reads it on a phone in a car. The cells come back in tuner_moment's
 * shape (`columns` named once, `rows` of arrays), only the cells that were driven unless asked, and
 * at most `maxRows` of them; `largest` repeats the few that answer "where is it converging" and
 * "where is data missing" first. verify:bridge-overview pins it.
 */
import type { VEMap } from '@/lib/types';
import type { VeReject } from '@/lib/ve-calculator/calculator';
import { buildCoverage, coverageRemedy, type CellCoverage } from '@/lib/ve-calculator/cellCoverage';

/** Cells listed at most by default. 160 rows of nine short values are ~8 KB; a 67-minute drive
 *  (#984) touched far fewer. Past it the highest-weight cells are kept and the rest counted. */
export const VE_MAX_ROWS = 160;
/** How many cells each `largest` list holds. */
export const VE_TOP = 8;

/** The calculation's per-cell maps as the page holds them — useVeCalculation's state, or the object
 *  `calculateNewVEMap` / `finalizeGrid` returns (the same fields, never null there). */
export interface VeCalcMaps {
    hitMap: number[][] | null;
    weightMap: number[][] | null;
    correctionMap: number[][] | null;
    demandMap: number[][] | null;
    rejectMap: (VeReject | null)[][] | null;
    coverage?: { withEvidence: number; withAnyData: number; total: number } | null;
}

export interface VeOverviewInput {
    /** The BASE map the drive was derived against: xAxis rpm, yAxis RO %, data[ro][rpm]. */
    currentMap: VEMap | null;
    /** The derived map; null when no cell cleared the gate (the calculator withholds it then). */
    newMap: VEMap | null;
    calc: VeCalcMaps | null;
    /** Whether the derived map goes into the bytes on WRITE (page.tsx `veWriteArmed`). */
    veWriteArmed?: boolean;
    /** The WRITE rows armed on the hub, by their labels (ALPHA-N, WARMUP, RF KORR, …). */
    rowsArmed?: readonly string[];
}

export interface VeOverviewOptions {
    /** Only cells inside these axis ranges, inclusive, on the map's own axis values. */
    band?: { rpm?: readonly [number, number]; ro?: readonly [number, number] };
    /** List cells the drive never reached too (in a band, that is often the answer). */
    includeEmpty?: boolean;
    maxRows?: number;
    top?: number;
}

type Row = (number | string | null)[];

export interface VeOverview {
    map: { rpm: number[]; ro: number[]; cells: number } | null;
    tune: { derived: boolean; veWriteArmed: boolean | null; rowsArmed: string[] | null };
    /** Over the whole map, whatever the band. `refused` by the gate's own reason. */
    counts: {
        written: number; settled: number; refused: Record<string, number>; noData: number;
        /** No data, and below the lowest opening the drive reached: the engine does not go there. */
        noDataBelowReach: number;
    } | null;
    band: { rpm: [number, number] | null; ro: [number, number] | null; cells: number; withData: number } | null;
    columns: string[];
    rows: Row[];
    largest: { changed: Row[]; refused: Row[] };
    /** What to do about each refusal present, in the screen's words. */
    remedies: Record<string, string>;
    legend: Record<string, string>;
    notes: string[];
}

export const VE_COLUMNS = ['rpm', 'ro', 'veNow', 'veNew', 'changePct', 'askPct', 'samples', 'weight', 'state'] as const;

const LEGEND: Record<string, string> = {
    veNow: 'kf_rf_soll in the BASE, fraction of filling',
    veNew: 'what this derivation writes there; null where refused',
    changePct: '(veNew / veNow - 1) x 100',
    askPct: '(mean trim x rf_korr near the cell - 1) x 100: what the samples asked for, written or not',
    samples: 'samples binned to the cell. Samples taken while lambda was still recovering from an rf_korr step are not binned, so a lambda-ramp cell can read 0 here and still have been driven',
    weight: 'sum of their bilinear shares; the weight bar tests this',
    state: 'written | settled (written, no change) | the gate\'s refusal | no-data | below-reach. lambda-ramp: every sample near the cell was mid-ramp, none could be used',
};

const round = (v: number, digits: number) => Number(v.toFixed(digits));
const fin = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

/** One cell as a row of VE_COLUMNS. */
interface Cell { c: CellCoverage; rpm: number; ro: number; row: Row; changePct: number | null; driven: boolean }

export function veOverview(input: VeOverviewInput, opts: VeOverviewOptions = {}): VeOverview {
    const notes: string[] = [];
    const columns = [...VE_COLUMNS];
    const tune = {
        derived: !!input.newMap,
        veWriteArmed: input.veWriteArmed ?? null,
        rowsArmed: input.rowsArmed ? [...input.rowsArmed] : null,
    };
    const empty = (note: string): VeOverview => ({
        map: null, tune, counts: null, band: null, columns, rows: [], largest: { changed: [], refused: [] },
        remedies: {}, legend: LEGEND, notes: [note],
    });
    const base = input.currentMap;
    if (!base) return empty('No BIN is open, so there is no VE map to read.');
    const calc = input.calc;
    if (!calc || !calc.rejectMap || !calc.hitMap) {
        return { ...empty('No VE calculation on this tab yet: no log has been derived against this map.'), map: { rpm: [...base.xAxis], ro: [...base.yAxis], cells: base.xAxis.length * base.yAxis.length } };
    }

    const rows = base.yAxis.length;
    const cols = base.xAxis.length;
    // The verdict per cell is the TUNED MAP's own — one model, so the assistant cannot call a cell
    // written that the screen paints refused.
    const coverage = buildCoverage({
        hitMap: calc.hitMap, weightMap: calc.weightMap, correctionMap: calc.correctionMap,
        rejectMap: calc.rejectMap, rows, cols,
    });

    const cells: Cell[] = [];
    const counts = { written: 0, settled: 0, refused: {} as Record<string, number>, noData: 0, noDataBelowReach: 0 };
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const cov = coverage[r][c];
            const now = base.data[r]?.[c];
            const accepted = cov.state === 'written' || cov.state === 'settled';
            const next = accepted ? input.newMap?.data[r]?.[c] : undefined;
            const demand = calc.demandMap?.[r]?.[c];
            const driven = cov.state !== 'unvisited';
            const changePct = fin(now) && fin(next) && now > 0 ? (next / now - 1) * 100 : null;
            const state = cov.state === 'written' || cov.state === 'settled' ? cov.state
                : cov.state === 'refused' ? (cov.reason ?? 'refused')
                    : cov.belowReach ? 'below-reach' : 'no-data';
            if (cov.state === 'written') counts.written++;
            else if (cov.state === 'settled') counts.settled++;
            else if (cov.state === 'refused') counts.refused[state] = (counts.refused[state] ?? 0) + 1;
            else { counts.noData++; if (cov.belowReach) counts.noDataBelowReach++; }
            cells.push({
                c: cov, rpm: base.xAxis[c], ro: base.yAxis[r], driven, changePct,
                row: [
                    base.xAxis[c], base.yAxis[r],
                    fin(now) ? round(now, 3) : null,
                    fin(next) ? round(next, 3) : null,
                    changePct === null ? null : round(changePct, 1),
                    // The ask is only a reading where something was binned: an empty cell's demand
                    // is the calculator's 1.000 placeholder, not a measurement of "no change".
                    driven && cov.samples > 0 && fin(demand) ? round((demand - 1) * 100, 1) : null,
                    cov.samples,
                    fin(cov.weight) ? round(cov.weight, 1) : null,
                    state,
                ],
            });
        }
    }

    const within = (v: number, r?: readonly [number, number]) =>
        !r || (v >= Math.min(r[0], r[1]) && v <= Math.max(r[0], r[1]));
    const band = opts.band && (opts.band.rpm || opts.band.ro) ? opts.band : null;
    const inBand = band ? cells.filter(x => within(x.rpm, band.rpm) && within(x.ro, band.ro)) : cells;
    if (band && inBand.length === 0) {
        notes.push(`No cell of the map lies in that band. Its axes run ${base.xAxis[0]}–${base.xAxis[cols - 1]} rpm and ${base.yAxis[0]}–${base.yAxis[rows - 1]} % RO.`);
    }
    const listed = opts.includeEmpty ? inBand : inBand.filter(x => x.driven);

    // Over the cap, keep what the evidence is heaviest on — the cells the assistant can say most
    // about — and still print them in map order, so a row reads like the map.
    const maxRows = Math.max(1, Math.trunc(opts.maxRows ?? VE_MAX_ROWS));
    let shown = listed;
    if (listed.length > maxRows) {
        const keep = new Set([...listed]
            .sort((a, b) => (b.c.weight ?? 0) - (a.c.weight ?? 0) || b.c.samples - a.c.samples)
            .slice(0, maxRows));
        shown = listed.filter(x => keep.has(x));
        notes.push(`${listed.length - shown.length} of ${listed.length} cells left out (the lightest evidence first); ask for a band to read them.`);
    }

    const top = Math.max(0, Math.trunc(opts.top ?? VE_TOP));
    const changed = inBand.filter(x => x.c.state === 'written' && x.changePct !== null)
        .sort((a, b) => Math.abs(b.changePct!) - Math.abs(a.changePct!))
        .slice(0, top).map(x => x.row);
    const refused = inBand.filter(x => x.c.state === 'refused')
        .sort((a, b) => (b.c.weight ?? 0) - (a.c.weight ?? 0) || b.c.samples - a.c.samples)
        .slice(0, top).map(x => x.row);

    const remedies: Record<string, string> = {};
    for (const reason of Object.keys(counts.refused)) {
        const say = coverageRemedy(reason, 'en');
        if (say) remedies[reason] = say;
    }
    if (counts.noData - counts.noDataBelowReach > 0) remedies['no-data'] = coverageRemedy('no-evidence', 'en') ?? 'drive this state';

    if (!input.newMap) notes.push('No cell cleared the gate, so this drive derived no map to write.');
    // The calculator's own census beside this one, so a disagreement would show rather than hide.
    const accepted = counts.written + counts.settled;
    if (calc.coverage && calc.coverage.withEvidence !== accepted) {
        notes.push(`The calculation counted ${calc.coverage.withEvidence} cells written; the map's verdicts say ${accepted}.`);
    }

    return {
        map: { rpm: [...base.xAxis], ro: [...base.yAxis], cells: rows * cols },
        tune,
        counts,
        band: band ? {
            rpm: band.rpm ? [band.rpm[0], band.rpm[1]] : null,
            ro: band.ro ? [band.ro[0], band.ro[1]] : null,
            cells: inBand.length,
            withData: inBand.filter(x => x.driven).length,
        } : null,
        columns,
        rows: shown.map(x => x.row),
        largest: { changed, refused },
        remedies,
        legend: LEGEND,
        notes,
    };
}
