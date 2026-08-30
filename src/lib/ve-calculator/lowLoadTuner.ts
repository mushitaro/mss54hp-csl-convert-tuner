/**
 * The LOW LOAD corrector: `kf_rf_soll`'s low-opening rows, from the lambda trim.
 *
 * Not a new table. `APP_CONFIG.MSS54HP.VE_TABLE` already IS `kf_rf_soll (CSL Alpha-N)`, so this is
 * the existing VE map's bottom thirteen rows, derived with the SAME correction the VE path uses
 * but on evidence shaped for a dwell rather than a sweep.
 *
 * ## The arithmetic, and the thing it is allowed to conclude
 *
 *     correction = trim x rf_korr,    trim = mean(stft1, stft2) x mean(ltft1, ltft2)
 *
 * A MULTIPLY, and the identical expression `accumulatePoint` applies above the seam
 * (calculator.ts). What differs here is which rows this path owns, how it bins them, and how much
 * evidence it demands — NOT the correction. The row-12 seam is an evidence boundary, not an
 * arithmetic one, and anything that describes it as two different formulas is out of date.
 *
 * **TI_F_STAT is not a term.** It used to be, and the car refused it; the measurement is at the
 * accumulation site below, next to the line that would have applied it.
 *
 * The conclusion that matters most is still the negative one: when a cell's mean correction sits
 * within `noChangeBand` of 1.000, the air model is already right there and the correct action is
 * none. That is reported as the `no-change-needed` rejection rather than as an absence, so a
 * converged table and a drive that gathered nothing do not look alike.
 *
 * ## Why the evidence bar is higher here than for the VE map
 *
 * `la_f_regler` is a two-point controller: it oscillates by construction at 1-2 Hz against a
 * ~3-5 Hz sample rate, so ten samples can be ten points on one limit cycle. And a cell is 0.05 %
 * of throttle opening wide at the bottom of the axis. So: three times the VE map's sample gate,
 * and independent VISITS rather than sample count, because thirty samples from one traffic light
 * is one observation repeated thirty times.
 */

import type { LogDataPoint, VEMap } from '@/lib/types';
import { type AlphaNTables, tiLoadFactorAt, tiBranchAmbiguous } from './alphaNTable';
import { repairLowLoadShape, type LowLoadShapeOptions } from './lowLoadShape';

export type LowLoadReject =
    | 'out-of-band'
    | 'no-evidence'
    | 'thin-count'
    | 'few-visits'
    | 'spread'
    | 'imprecise'
    | 'trim-rigid'
    | 'no-ti-factor'
    | 'ti-branch-unproven'
    | 'no-change-needed';

export type LowLoadRejectCounts = Record<LowLoadReject, number>;

const EMPTY_REJECTS: LowLoadRejectCounts = {
    'out-of-band': 0, 'no-evidence': 0, 'thin-count': 0, 'few-visits': 0, spread: 0,
    imprecise: 0, 'trim-rigid': 0, 'no-ti-factor': 0, 'ti-branch-unproven': 0, 'no-change-needed': 0,
};

/**
 * The last `kf_rf_soll` row this corrector owns — and, by the same token, the last row the VE
 * correction must NOT own.
 *
 * There is one table. LOW LOAD and VE are two derivation rules over different bands of it, and this
 * is the seam. It lives here, exported, because a boundary held in two places is a boundary that
 * eventually disagrees with itself: the VE calculator reads this constant to refuse the band rather
 * than carrying its own copy of the number.
 *
 * Row 12 is 3.198 %, the last row the notes name; by row 13 (5.00 %) the slope has already
 * flattened to 0.020-0.062 RF/%. Both axes — the app's `AXIS_LOAD` and the binary's own y axis —
 * put 3.2 % at index 12, so the two correctors mean the same rows by the same numbers.
 */
export const LOW_LOAD_TOP_ROW = 12;

export interface LowLoadTuneOptions {
    /** Last opening row the correction may touch. Defaults to `LOW_LOAD_TOP_ROW`. */
    maxOpeningRow: number;
    minCellSamples: number;
    minVisits: number;
    visitGapSec: number;
    /**
     * How far a cell's per-sample corrections may SCATTER before the cell is read as more than one
     * condition. A standard deviation, and it used to be the full range.
     *
     * `max - min > 0.12` refused 64 of the 66 cells session #920 earned. Two things were wrong
     * with it, and the second is the worse one:
     *
     *   The threshold sat below the normal value. `la_f_regler` is a two-point controller that
     *   oscillates by construction, so every cell's samples span its limit cycle: measured sd on
     *   #920 is 0.034 (median), and the median RANGE is 0.161 — the gate was set at 0.12.
     *   The statistic grows with evidence. A range is an extreme, so more samples means a wider
     *   one: median range is 0.161 at n >= 30 and 0.253 at n >= 900. A better-measured cell was
     *   MORE likely to be refused, which is the opposite of what a confidence test should do.
     *
     * An sd does neither. 0.08 is about 2.3x the measured median and above its p90 of 0.043, so it
     * passes an ordinary limit cycle and still catches a cell whose samples are two populations —
     * which is the inhomogeneity this test exists to find.
     */
    maxSampleSd: number;
    /**
     * How precisely the cell's MEAN has to be pinned: `sd / sqrt(n)`.
     *
     * This is the half of the old range test that was worth keeping, done with a statistic that
     * improves as evidence accumulates instead of degrading. 0.005 is one quantisation step of
     * `kf_rf_soll` against this car's idle cell — the table stores raw/1000, so 1 LSB on a cell
     * holding 0.200 is 0.5 %. A mean pinned tighter than the smallest writable change is pinned
     * well enough; asking for more precision than the format can express is asking for nothing.
     *
     * On #920: median standard error 0.0035, and 57 of 66 cells clear this.
     */
    maxStdErr: number;
    /** Variance floor on the trim within a cell. A FROZEN trim and a converged one read the same
     *  number, and the DME opens the loop at idle when the idle valve has a fault latched. The
     *  channel quantises at 2^-15 = 3.05e-5, so this is ~100 counts: far above quantisation, far
     *  below the limit cycle's own amplitude. */
    minTrimVariance: number;
    correctionMin: number;
    correctionMax: number;
    /** Relative, unlike rf_korr's absolute steps, because cell values here run 0.05-0.6 RF rather
     *  than sitting near 1.0. Asymmetric with down smaller: lean at idle is a stall. */
    maxStepUpFrac: number;
    maxStepDownFrac: number;
    absoluteMin: number;
    absoluteMax: number;
    /**
     * Refuse cells whose evidence sits where the two candidate `TI_F_STAT` tables disagree.
     *
     * `TI_F_STAT` is the factor the DME multiplies INJECTION TIME by at this operating point —
     * small-pulse injector compensation, not deliberate enrichment, and NOT a term in this
     * correction (session #920; see the note at the accumulation site). `ti_load_factor` (slave
     * 0x01C6CA) picks it from one of two tables at idle and they disagree by 14 %, so which one
     * the DME reads was ambiguous — which is what this gate refuses cells over.
     *
     * Since the factor left the correction the gate cannot change a single written byte, which is
     * why it now defaults to OFF. It is kept because the ambiguity is real and a future derivation
     * that needs the factor would need this back.
     *
     * DEFAULT OFF now, because the branch is settled. The disassembly reads:
     *
     *     LL bit set AND LLS_ST bit 7 set  ->  KL_TI_N_ZWD_LL(N40)      the 0.859 curve
     *     otherwise                        ->  KF_TI_N_RF(N, RF)        1.000 above rf 0.15
     *
     * `LLS_ST` is the idle-valve status byte and bit 7 is set only by the valve's DIAGNOSIS
     * (`lls_diag`, master 0x026142, cleared at 0x026196). A healthy valve leaves it low, so
     * `KF_TI_N_RF` is what runs and the 0.859 curve is the DME's substitute for a valve it has
     * stopped believing. The byte is on the log now — switch `LLS_ST` on in Log Fields to confirm
     * it on your own car, and turn this back on if bit 7 is ever set.
     */
    requireTiBranchProven: boolean;
    /**
     * Below this the correction is within the noise and the honest answer is "nothing to do".
     *
     * In units of the correction, so 0.01 is 1 %. The floor that matters underneath it is
     * QUANTISATION: `kf_rf_soll` stores `raw/1000`, so one least-significant bit is 0.001, which
     * against this car's idle cell value of 0.200 is 0.5 %. A correction smaller than that cannot
     * be expressed at all.
     */
    noChangeBand: number;
    repairShape: boolean;
    shape?: Partial<LowLoadShapeOptions>;
}

/**
 * The two scatter bounds, exported because the VE path needs the SAME ones.
 *
 * They are not properties of the low-opening band — they are properties of `la_f_regler` on this
 * car: how wide its limit cycle is (so how much scatter a single well-behaved condition produces)
 * and how finely `kf_rf_soll` can express an answer. Both derivations read the same trim through
 * the same table, so both must apply the same two tests, and a number that means "this car's
 * lambda dither" must not exist twice.
 */
export const MAX_SAMPLE_SD = 0.08;
export const MAX_STD_ERR = 0.005;

export const LOW_LOAD_TUNE_DEFAULTS: LowLoadTuneOptions = {
    maxOpeningRow: LOW_LOAD_TOP_ROW,
    minCellSamples: 30,
    // Two, not three.
    //
    // A "visit" is a separate occasion in the same cell — samples more than `visitGapSec` apart.
    // The bar was three because the SHORT-term trim (`la_f_regler`) oscillates at 1-2 Hz against a
    // 3-5 Hz sample rate, so thirty samples from one traffic light can be thirty points on one
    // limit cycle rather than thirty observations, and repeated visits were the only defence.
    //
    // The correction now carries `ltft` (`laa_f`) as well — the DME's OWN long-term average of that
    // oscillation, learned over minutes in exactly this window. The averaging the visit count was
    // standing in for is already done, by the ECU, better. Two visits still guards against a single
    // freak occasion; three was buying a second copy of something now measured directly.
    minVisits: 2,
    visitGapSec: 5.0,
    maxSampleSd: MAX_SAMPLE_SD,
    maxStdErr: MAX_STD_ERR,
    minTrimVariance: 1e-5,
    correctionMin: 0.70,
    correctionMax: 1.40,
    maxStepUpFrac: 0.08,
    maxStepDownFrac: 0.05,
    absoluteMin: 0.030,
    absoluteMax: 1.500,
    // Off: the branch is settled by disassembly and the car can confirm it. See the field's note.
    requireTiBranchProven: false,
    // 1 %, which is two quantisation steps at the idle cell. It was 2 % — four steps — while the
    // correction was built from the short-term trim alone and therefore understated the error;
    // now that `ltft` is in the product there is no reason to throw away a two-step result.
    noChangeBand: 0.01,
    repairShape: false,
};

export function withLowLoadDefaults(partial?: Partial<LowLoadTuneOptions>): LowLoadTuneOptions {
    const out = { ...LOW_LOAD_TUNE_DEFAULTS };
    if (!partial) return out;
    for (const [k, v] of Object.entries(partial)) {
        if (v !== undefined) (out as Record<string, unknown>)[k] = v;
    }
    return out;
}

export type CellOrigin = 'stock' | 'measured' | 'repaired';

export interface LowLoadCell {
    row: number;
    col: number;
    opening: number;
    rpm: number;
    stock: number;
    tuned: number;
    correction: number;
    samples: number;
    visits: number;
    origin: CellOrigin;
    rejected: LowLoadReject | null;
}

export interface LowLoadReport {
    samplesSeen: number;
    samplesUsed: number;
    cellsMeasured: number;
    cellsRepaired: number;
    cellsRefusedByShape: number;
    rejects: LowLoadRejectCounts;
    /** How many samples carried a `TI_F_STAT` other than 1.0 — i.e. how often the DME was
     *  compensating short pulses. Reported only; the factor is not a term in the correction. */
    samplesWithEnrichment: number;
    /** The rf the log actually spent its idle time at. Reported rather than asserted, because the
     *  repository's own documents disagree about whether idle lands on the enriched row and only a
     *  real log settles it. */
    medianIdleRf: number | null;
}

export interface LowLoadResult {
    stock: number[][];
    tuned: number[][];
    /** 24x20, true where this tuner measured or repaired the cell — the cells it OWNS. The single
     *  input `composeVeGrid` needs to give this workflow its rows without handing it the table:
     *  every non-owned cell of `tuned` is byte-identical to `stock`, and the composition rests on
     *  that (verify:compose re-checks it against this function on every run). */
    owned: boolean[][];
    rpmAxis: number[];
    openingAxis: number[];
    cells: LowLoadCell[][];
    report: LowLoadReport;
    acceptable: boolean;
}

interface Acc {
    q: number[];
    trims: number[];
    times: number[];
    ambiguous: number;
}

function mean(xs: number[]): number { return xs.reduce((a, b) => a + b, 0) / xs.length; }
function variance(xs: number[]): number {
    if (xs.length < 2) return 0;
    const m = mean(xs);
    return xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
}
/** Distinct occasions, not samples: a gap longer than `gap` starts a new one. */
function visits(times: number[], gap: number): number {
    if (!times.length) return 0;
    const s = [...times].sort((a, b) => a - b);
    let n = 1;
    for (let i = 1; i < s.length; i++) if (s[i] - s[i - 1] > gap) n++;
    return n;
}

/** Nearest breakpoint. Nearest rather than bilinear: at the bottom of this axis the rows are
 *  0.05 % apart, and smearing one sample across four cells invents evidence for three of them. */
function nearestIndex(axis: number[], v: number): number {
    let best = 0;
    let d = Infinity;
    axis.forEach((a, i) => { const x = Math.abs(a - v); if (x < d) { d = x; best = i; } });
    return best;
}

/**
 * Derive the low-opening block. `null` when the tables could not be read — `sollRpm` / `sollOpening`
 * are this grid's own axes and an axis is never guessed.
 */
export function tuneLowLoad(
    samples: readonly LogDataPoint[],
    tables: AlphaNTables | null,
    currentMap: VEMap,
    opts?: Partial<LowLoadTuneOptions>,
): LowLoadResult | null {
    if (!tables) return null;
    const o = withLowLoadDefaults(opts);

    const rpmAxis = tables.sollRpm;
    const openingAxis = tables.sollOpening;
    const stock = currentMap.data.map(r => [...r]);
    const rejects: LowLoadRejectCounts = { ...EMPTY_REJECTS };
    const maxRow = Math.min(o.maxOpeningRow, openingAxis.length - 1);

    const bins = new Map<string, Acc>();
    let samplesUsed = 0;
    let samplesWithEnrichment = 0;
    const idleRfs: number[] = [];

    for (const s of samples) {
        // THE STANDING ERROR IS EVERY TRIM THE DME APPLIES, NOT THE ONE IT SHOWS.
        //
        // `stft` is `la_f_regler`, the SHORT-term lambda controller's output. It is a two-point
        // regulator — it steps by +/-`la_kp` every time the sensor crosses stoichiometric — so it
        // oscillates whatever the mixture is doing, and its MEAN is what carries information.
        //
        // `ltft` is `laa_f`, the MULTIPLICATIVE long-term store. The disassembly (laa_st_calc,
        // slave 0x019B90) puts its learning zone at ML > 40 kg/h AND rf > 0.20 — driven part load,
        // NOT this band. It still belongs in the product because it is APPLIED here: the injection
        // path is `ti x (stft x ltft x ...) + TI_OFFSET_ADAPT`, and whatever part load taught it
        // multiplies every idle injection too.
        //
        // The store a stationary idle actually learns into is the ADDITIVE one, LAA_OFFSET
        // (applied as TI_OFFSET_ADAPT, us of ti, clamp +/-0.5 ms). It has NO readable address on
        // this image — slave RAM is not served, the master's 0xFFD922 is the rev limiter's — so
        // there is no term for it here. What licenses leaving it out: session #923 read `laa_f`
        // at a bit-exact 0x8000, and slave 0x019C3C initialises both stores in one function, so
        // a factor exactly at init means the offset sits at its init of 0 as well. On a car
        // where `ltft` reads anything other than exactly 1.000, that inference is void and this
        // correction under-reads by the unread offset — which is the one channel it cannot have.
        //
        // `ltft` absent — an old log, or a source that never carried it — falls back to 1.0, which
        // reproduces the previous behaviour exactly rather than refusing the sample.
        const shortTerm = s.stft1 !== undefined && s.stft2 !== undefined
            ? (s.stft1 + s.stft2) / 2
            : (s.stft1 ?? s.stft2);
        const longTerm = s.ltft1 !== undefined && s.ltft2 !== undefined
            ? (s.ltft1 + s.ltft2) / 2
            : (s.ltft1 ?? s.ltft2 ?? 1);
        const trim = shortTerm === undefined ? undefined : shortTerm * longTerm;
        if (trim === undefined || s.rf === undefined) continue;
        const row = nearestIndex(openingAxis, s.rawLoad);
        if (row > maxRow) continue;
        const col = nearestIndex(rpmAxis, s.rpm);

        const rfFraction = s.rf / 100;
        if (s.rawLoad <= 1.0 && s.rpm < 1000) idleRfs.push(rfFraction);

        // TI_F_STAT IS NOT IN THE CORRECTION, AND THE CAR IS WHY.
        //
        // It used to be: `q = trim x rf_korr x TI_F_STAT`, on the reading that `KF_TI_N_RF` is a
        // deliberate low-filling enrichment which a lambda-1 loop takes straight back out — so a
        // perfect air model would show a standing trim of 1/TI_F_STAT, and multiplying by the
        // factor was how you recovered "change nothing".
        //
        // Session #920 says the loop does no such thing. Walking RF across the table's y = 0.15
        // breakpoint, where the factor steps from 1.115 to exactly 1.000, with rpm held inside one
        // band (1,479 warm closed-loop samples):
        //
        //     median trim                0.9685 below  ->  0.9699 above   (+0.1 %)
        //     median trim x TI_F_STAT    1.0728 below  ->  0.9699 above   (-9.6 %)
        //     regression of (trim - 1) on (TI_F_STAT - 1):  slope -0.025
        //
        // The enrichment reading predicts that slope is -1 and that the TRIM carries the step. The
        // trim is continuous and the PRODUCT is the discontinuous one, so the factor is not
        // something the loop removes — it is part of the air-to-fuel conversion already, which is
        // also what its shape says (unity everywhere, rising only at the shortest pulses and
        // rising further with rpm: small-pulse injector compensation).
        //
        // Multiplying by it therefore INVENTED up to +15 % of correction in precisely the cells an
        // ordinary drive covers best — 17 of the 109 cells #920 earns sit below 0.15 filling with
        // the loop closed, at 1100-2900 rpm. verify:ti-factor holds this measurement, and its last
        // assertion fails if any derivation puts the factor back.
        //
        // It is still COMPUTED, because the panel says how many samples were taken where the DME
        // was compensating — that is worth seeing, it is just not worth multiplying by.
        const tiFactor = tiLoadFactorAt(tables, s.rpm, rfFraction);
        if (!Number.isFinite(tiFactor)) { rejects['no-ti-factor']++; continue; }
        if (Math.abs(tiFactor - 1) > 1e-9) samplesWithEnrichment++;

        // THE OPERATOR. rf_korr is 1.000 throughout this band by construction — the correction
        // needs 55-80 % filling AND 20 km/h — so it is carried explicitly rather than assumed, and
        // a session that switches route re-derives consistently.
        const q = trim * (s.rfKorr ?? 1);   // trim = stft x ltft, see above

        const key = `${row}:${col}`;
        const acc = bins.get(key) ?? { q: [], trims: [], times: [], ambiguous: 0 };
        acc.q.push(q);
        // The rigidity test below asks whether the lambda loop was correcting at all, and the
        // only channel that answers that is the short-term one — `laa_f` is SUPPOSED to sit
        // still, so feeding the product here would read a healthy run as a frozen one.
        acc.trims.push(shortTerm!);
        acc.times.push(s.time);
        if (tiBranchAmbiguous(tables, s.rpm, rfFraction)) acc.ambiguous++;
        bins.set(key, acc);
        samplesUsed++;
    }

    const tuned = stock.map(r => [...r]);
    const origin: CellOrigin[][] = stock.map(r => r.map(() => 'stock' as CellOrigin));
    let cellsMeasured = 0;

    const cells: LowLoadCell[][] = openingAxis.map((opening, row) => rpmAxis.map((rpm, col) => {
        const base: LowLoadCell = {
            row, col, opening, rpm,
            stock: stock[row]?.[col] ?? 0,
            tuned: stock[row]?.[col] ?? 0,
            correction: 1,
            samples: 0, visits: 0,
            origin: 'stock',
            rejected: null,
        };
        const reject = (r: LowLoadReject): LowLoadCell => { rejects[r]++; return { ...base, rejected: r }; };

        if (row > maxRow) return reject('out-of-band');
        const acc = bins.get(`${row}:${col}`);
        if (!acc || !acc.q.length) return reject('no-evidence');

        const nVisits = visits(acc.times, o.visitGapSec);
        /**
         * WHAT THE CELL MEASURED, carried onto every verdict below — including the refusals.
         *
         * It used to be computed only after each gate had been passed, so a cell refused for
         * `thin-count`, `few-visits`, `spread` or `imprecise` reported `correction: 1` and was
         * indistinguishable on the map from one measured at no correction at all. Those are
         * opposite facts, and the refused cells are precisely the ones a driver is deciding whether
         * to go back to (operator, 2026-08-28).
         *
         * Not a write signal: `owned` comes from `origin`, which only a kept cell sets, and the
         * bytes come from `tuned`. This is the reading, and the sample count beside it says how
         * much to trust it.
         */
        const measured = Math.min(o.correctionMax, Math.max(o.correctionMin, mean(acc.q)));
        const withCounts = {
            ...base, samples: acc.q.length, visits: nVisits, correction: measured,
        };
        if (acc.q.length < o.minCellSamples) { rejects['thin-count']++; return { ...withCounts, rejected: 'thin-count' }; }
        if (nVisits < o.minVisits) { rejects['few-visits']++; return { ...withCounts, rejected: 'few-visits' }; }
        const qMean = acc.q.reduce((a, b) => a + b, 0) / acc.q.length;
        const qSd = Math.sqrt(acc.q.reduce((a, b) => a + (b - qMean) ** 2, 0) / acc.q.length);
        // Two different failures with two different remedies, so two different verdicts: a wide
        // SCATTER says the cell is not one condition and wants the run split; a wide standard
        // ERROR says the same condition simply has not been held long enough yet.
        if (qSd > o.maxSampleSd) { rejects.spread++; return { ...withCounts, rejected: 'spread' }; }
        if (qSd / Math.sqrt(acc.q.length) > o.maxStdErr) { rejects.imprecise++; return { ...withCounts, rejected: 'imprecise' }; }
        if (variance(acc.trims) < o.minTrimVariance) { rejects['trim-rigid']++; return { ...withCounts, rejected: 'trim-rigid' }; }
        if (o.requireTiBranchProven && acc.ambiguous > acc.q.length / 2) {
            rejects['ti-branch-unproven']++;
            return { ...withCounts, rejected: 'ti-branch-unproven' };
        }

        const correction = measured;
        // The negative conclusion, stated as a rejection so it is visible rather than absent: the
        // model is right here and the correct action is none.
        if (Math.abs(correction - 1) < o.noChangeBand) {
            rejects['no-change-needed']++;
            return { ...withCounts, correction, rejected: 'no-change-needed' };
        }

        const want = base.stock * correction;
        const up = base.stock * (1 + o.maxStepUpFrac);
        const down = base.stock * (1 - o.maxStepDownFrac);
        const stepped = Math.min(up, Math.max(down, want));
        const value = Math.min(o.absoluteMax, Math.max(o.absoluteMin, stepped));

        tuned[row][col] = value;
        origin[row][col] = 'measured';
        cellsMeasured++;
        return { ...withCounts, tuned: value, correction, origin: 'measured' };
    }));

    let cellsRepaired = 0;
    let cellsRefusedByShape = 0;
    if (o.repairShape) {
        // AFTER the measurement, never instead of it, and never at a cell the log never reached
        // unless a measured neighbour pulls it: unmeasured cells enter the fit at `stockWeight`.
        const weight = tuned.map((r, ri) => r.map((_, ci) => (origin[ri][ci] === 'measured' ? 5 : 1)));
        const rep = repairLowLoadShape(tuned, openingAxis, weight, maxRow, o.shape);
        for (let r = 0; r <= maxRow; r++) {
            for (let c = 0; c < rpmAxis.length; c++) {
                if (rep.refused[r][c]) { cellsRefusedByShape++; continue; }
                if (!rep.repaired[r][c]) continue;
                tuned[r][c] = rep.values[r][c];
                origin[r][c] = 'repaired';
                cells[r][c].tuned = rep.values[r][c];
                cells[r][c].origin = 'repaired';
                cellsRepaired++;
            }
        }
    }

    const sortedIdle = idleRfs.sort((a, b) => a - b);
    const report: LowLoadReport = {
        samplesSeen: samples.length,
        samplesUsed,
        cellsMeasured,
        cellsRepaired,
        cellsRefusedByShape,
        rejects,
        samplesWithEnrichment,
        medianIdleRf: sortedIdle.length ? sortedIdle[sortedIdle.length >> 1] : null,
    };

    return {
        stock, tuned,
        owned: origin.map(r => r.map(o => o !== 'stock')),
        rpmAxis, openingAxis, cells, report,
        // Six rather than rf_korr's three: this block has 260 cells to that table's 72, and one
        // corner clipped is not a calibration.
        acceptable: cellsMeasured + cellsRepaired >= 6,
    };
}
