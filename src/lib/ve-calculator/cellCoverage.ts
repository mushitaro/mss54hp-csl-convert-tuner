/**
 * One verdict per cell of `kf_rf_soll`, in the vocabulary a reader can act on.
 *
 * The derivation refuses a cell in its own terms — `thin-count`, `shared-evidence`,
 * `not-significant`. A reader looking at the map does not care which gate said no; they care what
 * to do about it, and whether "do something" is even the right answer. This is the layer that
 * turns the one into the other.
 *
 * ## The four states, and why "never visited" is not a refusal
 *
 * The distinction that matters most is between a cell that was JUDGED and a cell that was never
 * REACHED, because the actions are opposites: one says drive this state differently, the other says
 * drive it at all. Session #920 is the case that proves it — rows 0 and 1 of the opening axis took
 * ZERO samples in 13,608, because idle already sits at 0.37 % opening and the only way below that
 * is a shut throttle, where the DME cuts fuel. Those rows are not badly measured. They are
 * unreachable with the lambda loop closed, and no amount of driving will change that.
 *
 * A map that paints both as "not written" tells the reader to keep trying at a cell that can never
 * answer.
 */

import type { VeReject } from './calculator';

export type CoverageState =
    /** The cell was rewritten from this log. */
    | 'written'
    /** Samples landed here and the evidence was judged insufficient. Actionable. */
    | 'refused'
    /** Measured, and the answer was "change nothing". A result, not a failure. */
    | 'settled'
    /** No sample landed here. Either never driven, or not drivable with the loop closed. */
    | 'unvisited';

export interface CellCoverage {
    row: number;
    col: number;
    state: CoverageState;
    /** Samples binned into this cell, whatever the verdict. */
    samples: number;
    /** Sum of bilinear corner weights. */
    weight?: number;
    /** The correction that was applied, or 1 where none was. */
    correction: number;
    /** The raw verdict, for the detail strip. */
    reason: VeReject | null;
    /**
     * This cell sits BELOW the lowest opening the drive ever reached — so "no sample" here is not
     * "you did not drive it", it is "the engine does not go there".
     *
     * A fact about the drive, not a constant: the floor is wherever this log's samples stopped.
     * On session #920 that is row 2, because idle already sits at 0.37 % opening and the only
     * state below it is a shut throttle with the injectors off. Without this the same sentence
     * would be printed over a cell at 5 % opening, where it is simply false and the reader is
     * left to work out that it does not apply.
     */
    belowReach?: boolean;
}

/**
 * What a cell's state is CALLED, and what colour says it — one place, both languages.
 *
 * There were two copies: a census behind the info panel and the strip that appears when a cell is
 * tapped. They drifted, which is the only thing two copies of a name ever do — the census said
 * 書き換えた / 変更なし / 却下 while the same four states rendered as WRITTEN / NO CHANGE / REFUSED
 * a tap away, so the Japanese reader met each state under two names and could not tell they were
 * the same four (operator, 2026-08-25).
 *
 * The Japanese says the CONDITION rather than the verdict, which is what the operator asked for and
 * is the more useful half: 却下 tells you the gate said no, データ不足 tells you what to fix. The
 * English follows the same rule, which is why REFUSED is gone from it too.
 *
 * The tone lives here with the word because a colour and a label are one statement — the census
 * and the strip both paint the state, and splitting the two is how they came apart the first time.
 */
export const COVERAGE_LABEL: Record<'ja' | 'en', Record<CoverageState, string>> = {
    ja: {
        written: '書き換え対象',
        settled: '変更不要',
        refused: 'データ不足',
        unvisited: '未走行',
    },
    en: {
        written: 'WRITTEN',
        settled: 'NO CHANGE',
        refused: 'NOT ENOUGH DATA',
        unvisited: 'NOT DRIVEN',
    },
};

/** One tone per state. Violet is this app's "armed / caution" role, and a cell short of evidence is
 *  exactly that: something to act on rather than something wrong. Ice blue reads as verified. */
export const COVERAGE_TONE: Record<CoverageState, string> = {
    written: 'text-blue-400',
    settled: 'text-emerald-400',
    refused: 'text-violet-300',
    unvisited: 'text-slate-600',
};

/** What the reader should DO. One line, naming an action, never restating the reason. */
const REMEDY: Record<string, { en: string; ja: string }> = {
    'no-evidence': { en: 'drive this state', ja: 'この状態を走る' },
    'thin-count': { en: 'hold this state longer', ja: 'この状態をもっと保持する' },
    'thin-weight': { en: 'drive nearer the middle of this cell, not across its edge', ja: 'セルの端ではなく中心寄りを走る' },
    'shared-evidence': { en: 'drive nearer the middle of this cell, not across its edge', ja: 'セルの端ではなく中心寄りを走る' },
    scatter: { en: 'the samples here are not one condition — split the run', ja: '同じ条件のサンプルになっていない' },
    spread: { en: 'the samples here are not one condition — split the run', ja: '同じ条件のサンプルになっていない' },
    imprecise: { en: 'hold this state longer — the mean is not pinned yet', ja: 'この状態をもっと保持する —— 平均がまだ定まっていない' },
    // The two the significance rule emits. 'thin-independent' is NOT the same instruction as
    // 'thin-count': more samples of the same dwell add almost nothing, because the lambda loop's
    // limit cycle makes them the same observation. Coming back later is what adds evidence.
    'thin-independent': {
        en: 'come back to this state on a separate occasion — more of the same dwell adds little',
        ja: '別の機会にもう一度この状態を走る —— 同じ滞在を伸ばしてもほとんど増えない',
    },
    'not-significant': {
        en: 'nothing — the correction here is smaller than what can be measured',
        ja: '何もしない —— ここの補正は測れる大きさを下回っている',
    },
    'trim-rigid': { en: 'the lambda loop was not correcting — check it was closed', ja: 'λ ループが閉じていたか確認する' },
    'no-ti-factor': { en: 'KF_TI_N_RF could not be read from this binary', ja: 'この BIN から KF_TI_N_RF を読めなかった' },
    'ti-branch-unproven': { en: 'log LLS_ST to settle which branch runs', ja: 'LLS_ST をログに入れて分岐を確定する' },
};

export function coverageRemedy(reason: string | null, lang: 'en' | 'ja'): string | undefined {
    if (!reason) return undefined;
    return REMEDY[reason]?.[lang];
}

export interface CoverageInputs {
    hitMap: number[][] | null;
    weightMap: number[][] | null;
    correctionMap: number[][] | null;
    rejectMap: (VeReject | null)[][] | null;
    rows: number;
    cols: number;
}

/**
 * The whole grid, one verdict per cell.
 *
 * Built in one pass rather than per cell on demand, because the map renders all 480 and a detail
 * strip reads one — and a function called 480 times per render that re-derives the same arrays is
 * the shape of the performance bug this component already fixed once for `coverageBands`.
 *
 * One verdict per cell and one set of bars behind it, so there is no branch here: every cell is
 * read out of the same `rejectMap` and judged by the same rules.
 */
export function buildCoverage(input: CoverageInputs): CellCoverage[][] {
    const { hitMap, weightMap, correctionMap, rejectMap, rows, cols } = input;
    const out: CellCoverage[][] = [];

    // The lowest opening row that took a sample anywhere across its rpm range. Everything under it
    // is under the engine's own floor for this drive, which is a different fact from "unvisited"
    // and carries a different answer. Infinity when the log touched nothing, so nothing claims it.
    let floorRow = Infinity;
    for (let r = 0; r < rows && floorRow === Infinity; r++) {
        for (let c = 0; c < cols; c++) {
            const n = hitMap?.[r]?.[c] ?? 0;
            if (n > 0) { floorRow = r; break; }
        }
    }

    for (let r = 0; r < rows; r++) {
        const row: CellCoverage[] = [];
        for (let c = 0; c < cols; c++) {
            const samples = hitMap?.[r]?.[c] ?? 0;
            const reason = rejectMap?.[r]?.[c] ?? null;
            const correction = correctionMap?.[r]?.[c] ?? 1;
            row.push({
                row: r, col: c, samples,
                weight: weightMap?.[r]?.[c],
                correction, reason,
                belowReach: samples === 0 && r < floorRow,
                // A written cell whose correction came out 1.000 IS the "nothing to change"
                // answer, and saying so is worth more than colouring it as a change of zero. The
                // cell is written either way, so the distinction has to be read off the number.
                state: reason === null
                    ? (correction === 1 ? 'settled' : 'written')
                    : samples === 0 ? 'unvisited' : 'refused',
            });
        }
        out.push(row);
    }
    return out;
}

/** How many cells sit in each state — the census the map's legend reports. */
export function coverageCensus(grid: CellCoverage[][]): Record<CoverageState, number> {
    const census: Record<CoverageState, number> = {
        written: 0, refused: 0, settled: 0, unvisited: 0,
    };
    for (const row of grid) for (const cell of row) census[cell.state]++;
    return census;
}
