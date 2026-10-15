import type { LogDataPoint, VEMap } from '@/lib/types';
import { timeScaleSeconds } from '@/lib/log-engine/filter';
import { axisBracket, type AxisBracket } from '@/lib/log-engine/axisBracket';
// `import type` for the interface: Node's type stripping cannot tell a type-only named import from
// a value one, so a harness that loads this module directly fails on the missing export.
import type { EgtTables } from './egtTables';
import { gateOpen, isRfKorrFloorHeld, rfKorrActive, tabgModelAt } from './egtTables';
import type { HighDeltaGuard } from './highDeltaGuard';
import { CSL_STOCK_RF_KORR_DRREL } from '@/config/constants';

/**
 * Back-calculates KF_RF_KORR_DRREL from a data log, anchored on the VE the drive ran on.
 *
 * ## The formula
 *
 *     trim   = mean(STFT1, STFT2) x mean(LTFT1, LTFT2)       the VE write's own trim
 *     D_i    = rfKorr_i x trim_i                            gate open, the lambda loop has taken
 *                                                           the last K step back (!kRamp), and it
 *                                                           is limit-cycling (lambdaCycling)
 *     DRREL(N, Δ) <- Σ w·D_i / Σ w                          bilinear on the table's (N, Δ) lattice,
 *                                                           -0.05 / +0.10 per log, [1.000, 1.40]
 *
 * Why D is what the table should hold. Stage 1 converges the VE under K HOLD, where the DME applies
 * K = 1.000 (the Δ 30 row) everywhere, so the map ends at rf_soll = VE_true · A(Δ_held), A being the
 * air the cylinder really takes at that exhaust state. On a drive with the gate open, once the loop
 * has settled on the trim that cancels whatever K the DME applied, the fuel matches the air:
 *
 *     rf_soll · K_i · trim_i = VE_true · A(Δ_i)   ->   D_i = K_i · trim_i = A(Δ_i) / A(Δ_held)
 *
 * rf_soll cancels, and so does the K the DME happened to apply. What is left is the correction this
 * Δ needs relative to the drive the VE was converged on. With α ≈ 0 — the post-switch seam slope is
 * β = -1.09 [-1.36, -0.75], the trim takes back all of K — A(Δ_held) is A(30) to within a few
 * percent, and D runs toward 1.000: the table comes down, by at most 0.05 a log.
 *
 * Mid-ramp samples say nothing: there the trim is ramping at the controller's fixed I slope and
 * `trim x K` reads K (1 - 0.0406 t), the time since the step (rampState.ts). They are counted
 * (`samplesKRamp`) and skipped. So are post-ramp samples whose trim is still WALKING — carrying the
 * last operating point's error at the same I slope, with no K step behind it (`samplesNotCycling`):
 * `D = K x trim` assumes the loop has settled on the trim that cancels K HERE, and a walk has not.
 *
 * ## Two refusals, each a table of nothing rather than a weak one
 *
 * - `kHeld` — the drive ran K HOLD, so the gate never opened and there is no K to measure.
 * - `veNotAnchored` — the gate-SHUT post-ramp, limit-cycling samples of the same drive, where K is
 *   1.000 and the trim is the VE's own error, have a median trim outside 1 ± `anchorTrimTolerance`.
 *   The formula above assumes the VE is converged; skip stage 1 and its error lands in every D.
 *
 * ## Rows above the highest measured one
 *
 *     s_c         = (k_new(r_top, c) - 1) / (k_stock(r_top, c) - 1)     r_top: highest written row
 *     k_new(r, c) = 1 + s_c · (k_stock(r, c) - 1)                       r > r_top, same step, range
 *
 * k_stock is BMW's table (`CSL_STOCK_RF_KORR_DRREL`), the step is taken from the loaded one.
 *
 * Post-ramp samples reach about Δ 200 and no further, WOT TH or not (highDeltaGuard.ts has the
 * numbers). So 300/400 cannot be measured; they follow the shrink of the highest measured row in
 * their column, and only when a K HOLD drive's guard saw no lean lock at Δ* >= 300. Without one
 * they stay stock, the rich side. The cells filled this way are flagged in `extrapolated`.
 *
 * See docs/ecu-logic/60-tuning-logic.md section 6.5 for the derivation and its conditions.
 */

export interface RfKorrTuneOptions {
    /** Widens the filling floor to skip the hysteresis band, where rf_korr is holding a value
     *  computed at a different operating point and so no longer corresponds to this sample's Δ. */
    gateMargin: number;

    /**
     * Seconds RF must have been steady before a sample's Δ means anything.
     *
     * kf_rf_tabg_modell is read at the INSTANTANEOUS RF, while TABG arrives through a Pt200's
     * thermal mass and the DME's own PT1. Step the load and the model jumps immediately while the
     * sensor has not moved, so Δ = model − TABG reads as a huge cold offset that is entirely lag.
     * Measured on a real drive: every sample where the gate was open sat in a 0.3-3.5 s throttle
     * stab, and Δ came out at 125-351 °C — "the exhaust is 300 °C colder than nominal at full
     * load", which is not a thing. Feeding those to the table is how a lag artefact becomes a
     * calibration.
     */
    settleSec: number;
    /** How far RF may drift across `settleSec` and still count as steady, in %RF. */
    maxRfDrift: number;
    /**
     * How fast TABG may still be moving, °C per second, averaged over `settleSec`.
     *
     * The channel quantises at 16 °C, so over a 3 s window the smallest observable non-zero rate is
     * 5.3 °C/s. 8 admits one LSB step per window and rejects two, which is the finest distinction
     * the channel can actually support — asking for less would just be asking for zero.
     */
    maxEgtRatePerSec: number;

    /**
     * How far the median trim of the gate-shut post-ramp samples may sit from 1.000 before the VE
     * is not an anchor. 0.02 is the plan's ±2 %: the band's VE error that α ≈ 0 already leaves
     * (0-8 % rich at α 0-0.3) is the next thing down, and a VE that is out by more than this would
     * put more error into D than the correction it is measuring at the low rows.
     */
    anchorTrimTolerance: number;
    /**
     * Gate-shut post-ramp samples the anchor check needs before it can pass. The limit cycle swings
     * the trim ±0.02-0.03; over 20 samples the median's standard error is ~0.004, a fifth of the
     * tolerance. Fewer, and "the VE is converged" would rest on a handful of readings.
     */
    anchorCheckMinSamples: number;

    /** Evidence a (rpm, Δ) grid cell needs before its value is written. */
    minCellSamples: number;
    minCellWeight: number;
    /** Distinct VE cells that must have contributed. One VE cell's residual error must not become a
     *  table entry on its own — with two, it has to be agreed with to survive. */
    minDistinctVeCells: number;
    /** max−min of the D values binned into one grid cell. The derivation assumes the air really
     *  does factor as g(rpm, load) x D(rpm, Δ); samples from different VE cells that disagree by
     *  more than this are saying it does not, here. */
    maxSpread: number;

    /**
     * How far a bin's evidence may sit from the breakpoint it writes, as a fraction of that row's
     * spacing to its nearest neighbour.
     *
     * Bilinear binning lets a sample vote on a breakpoint it is nowhere near, with a small weight.
     * `minCellWeight` is not a defence against that: a sample 90 °C away carries weight 0.1, so a
     * few hundred of them clear a threshold of 5.0 without one of them having been anywhere near
     * the row. What gets written is then an extrapolation wearing a measurement's clothes, and
     * because the correction is convex in Δ it extrapolates LOW — the lean direction.
     *
     * Caught in PRACTICE, where the answer is known: the Δ = 200 row at 2200 rpm was written to
     * 1.089 against a truth of 1.104, entirely from samples sitting near Δ = 110.
     */
    maxDeltaOffsetFrac: number;
    /**
     * Floor under that tolerance, in °C, whatever the axis spacing says.
     *
     * The Y axis opens 30, 40 — a 10 °C gap on a channel that arrives in 16 °C counts. A pure
     * fraction of the spacing asks for Δ to be known to ±3.5 °C there, which is finer than the
     * sensor can express, so the row could never be written by any drive however good. One TABG
     * count is the smallest tolerance that means anything.
     */
    minDeltaTolerance: number;

    /** Never below 1.000: a correction under 1 leans the mixture at exactly the condition BMW
     *  chose to enrich. Never above the ceiling: the stock peak is 1.371. */
    floor: number;
    ceiling: number;
    /** Per-run movement limits against the loaded table. Asymmetric because down is the lean
     *  direction. Convergence is iterative — one log does not get to swing a cell by 37 %. */
    maxStepUp: number;
    maxStepDown: number;

    /** Write the identity rpm columns (every Δ reads 1.000 in stock). Off: BMW pinned those to
     *  say "no correction outside this band", and moving an end column tilts the whole
     *  interpolation segment beside it. The measurement is still reported. */
    writeIdentityColumns: boolean;
    /** A column flatter than this across Δ is an identity column. Same number as the inverter's
     *  minSpan, and for the same reason. Also the least stock excess over 1.000 a measured row may
     *  have for its shrink ratio to be taken — below it `s` divides by a rounding error. */
    identitySpan: number;
    /**
     * Write the identity Δ ROW as well — the row every rpm column pins at 1.000, which is the
     * baseline the whole table is measured against. Off, and separately from the columns: a sample
     * at Δ = 35 still lands part of its bilinear weight on the Δ = 30 row, and on a real log that
     * wrote 1.009 into the 2200 rpm cell — a 0.9 % enrichment at zero delta, which shifts what every
     * other row is relative to. It is also the row K HOLD runs on, so it is the VE's own reference.
     */
    writeIdentityRow: boolean;

    /**
     * The high-Δ guard from the nearest K HOLD drive (highDeltaGuard.ts). `ok` lets the rows above
     * the highest measured one follow its shrink ratio; null, absent, or not ok leaves them stock —
     * and so does a guard without `skippedUnconverged`, which was stored by the rule before the VE had
     * to be shown converged: it counted cell-to-cell walks, and a rich VE could hide a lean need.
     */
    highDeltaGuard?: HighDeltaGuard | null;
}

export const RF_KORR_TUNE_DEFAULTS: RfKorrTuneOptions = {
    gateMargin: 0.05,
    settleSec: 3.0,
    maxRfDrift: 5.0,
    maxEgtRatePerSec: 8.0,
    anchorTrimTolerance: 0.02,
    anchorCheckMinSamples: 20,
    minCellSamples: 10,
    minCellWeight: 5.0,
    minDistinctVeCells: 2,
    maxSpread: 0.15,
    maxDeltaOffsetFrac: 0.35,
    minDeltaTolerance: 16,
    floor: 1.0,
    ceiling: 1.40,
    maxStepUp: 0.10,
    maxStepDown: 0.05,
    writeIdentityColumns: false,
    identitySpan: 0.010,
    writeIdentityRow: false,
};

/**
 * The defaults, with only the options the caller actually supplied laid over them.
 *
 * A plain `{ ...DEFAULTS, ...opts }` is what this replaces, and it was silently disabling both
 * evidence gates on every fresh session. Object spread copies own enumerable properties INCLUDING
 * the ones whose value is `undefined`, and the page assembles its options object unconditionally:
 *
 *     rfKorrThresholds: { minCellSamples: config.rfKorrMinCellSamples, ... }
 *
 * Those config fields are optional and absent from DEFAULT_FILTER_CONFIG, so on a session nobody
 * has touched they arrive as `{ minCellSamples: undefined, minCellWeight: undefined }` — and the
 * spread writes the undefined over the 10 and the 5.0. The comparisons downstream then read
 * `count < undefined`, which is `false`, so every cell passes. `tsconfig` has `strict` but not
 * `exactOptionalPropertyTypes`, so nothing complains.
 *
 * Fixed here rather than at the one call site on purpose: the next caller would open the same hole,
 * and this is the gate on a 72-cell table that gets flashed into an ECU.
 */
export function withDefaults(opts: Partial<RfKorrTuneOptions>): RfKorrTuneOptions {
    const out = { ...RF_KORR_TUNE_DEFAULTS } as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(opts)) {
        if (v !== undefined) out[k] = v;
    }
    return out as unknown as RfKorrTuneOptions;
}

export type RejectReason =
    | 'no-evidence'
    | 'thin-weight'
    | 'thin-count'
    | 'single-ve-cell'
    | 'spread'
    | 'identity-column'
    | 'identity-row'
    | 'off-breakpoint';

/** Why the whole table was declined — see the header. Null on a drive the tuner could read. */
export type RfKorrRefusal = 'kHeld' | 'veNotAnchored';

export interface RfKorrTuneReport {
    samplesTotal: number;
    /** Carried neither `rf` nor a usable rf_soll — nothing was measured. */
    samplesNoMeasurement: number;
    /** No exhaust-temperature channel on the row, so no Δ. */
    samplesNoDelta: number;
    /**
     * The DME's latch was SHUT, so it applied 1.000 no matter what the exhaust was doing. These
     * samples carry no information about this table, and on a normal road log they are almost all
     * of them — 1173 of 1176 on the drive this counter was added for. Their trims are what the
     * anchor check reads.
     */
    samplesGateShut: number;
    /** Latched, but inside the hysteresis band (or within `gateMargin` of the floor): the applied
     *  correction belongs to another operating point. */
    samplesHysteresis: number;
    /** Gate open, and the lambda loop still taking the last K step back (`kRamp`): the trim is the
     *  time since the step, not a measurement. */
    samplesKRamp: number;
    /** Gate open and post-ramp, but the trim was not limit-cycling (`lambdaCycling` not true): it was
     *  walking from the last operating point's error toward this one's, so `K x trim` is neither. */
    samplesNotCycling: number;
    /** RF or TABG was still moving, so Δ is sensor lag rather than a density signal. */
    samplesNotSettled: number;
    /** The operating point had moved within the log filter's Settle Time — `settleUnsteady`.
     *  Counted here rather than removed upstream so `settledFlags` keeps an intact series. */
    samplesUnsettledPoint: number;
    /**
     * Carried no lambda trim on either bank, so the closed loop's residual is unknown.
     *
     * `D = rfKorr x trim`, and `rfKorr` says what the DME DID; only the trim says whether it was
     * RIGHT. Drop the trim and D collapses to `rfKorr` — the table already in the ECU, handed back as
     * though the drive had derived it. An EGT-profile log has no trim on any row, so the whole of
     * one lands here — see `trimMissing`.
     */
    samplesNoTrim: number;
    /**
     * Gate open, post-ramp, settled, with a trim: the samples the table is built from.
     *
     * Counted by `rfKorrCensus`, which is what makes it true on a live run — the live path never
     * calls `tuneRfKorrTable`, and a figure counted only there would sit at zero for the whole of
     * every drive, including the ones that were going perfectly.
     */
    samplesUsed: number;
    /** The anchor check: gate-shut post-ramp, limit-cycling samples with a trim, and their median
     *  trim (null with none). See `anchorTrimTolerance`. */
    anchorTrimSamples: number;
    anchorTrimMedian: number | null;
    /** The table declined as a whole, and why. Decided here, so the live census and the final
     *  table say the same thing. */
    refused: RfKorrRefusal | null;
    gridCellsUpdated: number;
    /** Of `gridCellsUpdated`, the cells written by the shrink ratio rather than by measurement. */
    extrapolatedCells: number;
    rejectedByReason: Record<RejectReason, number>;
    /**
     * No log row carried an exhaust temperature. Without one nothing here can run.
     *
     * A fact about the CHANNEL, decided over the whole set up front — the same treatment
     * `trimMissing` needed and for the same reason. It used to be cleared inside the loop by the
     * first sample that survived the earlier tests, so a log whose rows were all removed by the
     * coolant, idle or cat-protection filters reported "no exhaust temperature" when what actually
     * happened was that the filter took everything. `samplesTotal` is the number that says so.
     */
    sensorMissing: boolean;
    /** No log row carried a lambda trim on either bank — the whole log, not some of it. True for
     *  every EGT-profile run by construction, since that profile does not read block 19. */
    trimMissing: boolean;
    /** Largest |tuned − stock| actually written, for a quick read on how far this log moved things. */
    largestChange: number;
}

export interface RfKorrTuneResult {
    /** Axes as read from the binary, never assumed — the bins depend on them. */
    rpm: number[];
    delta: number[];
    stock: number[][];
    tuned: number[][];
    countMap: number[][];
    weightMap: number[][];
    spreadMap: number[][];
    /** The raw weighted-mean D per grid cell, before any clamp. Shown so the difference between
     *  "the log said this" and "this is what will be written" stays visible. */
    measuredMap: number[][];
    updated: boolean[][];
    rejected: (RejectReason | null)[][];
    /** Written by the shrink ratio of the highest measured row in its column, not by evidence of
     *  its own. Always also `updated`. */
    extrapolated: boolean[][];
    /** Enough of the table moved to be worth writing. */
    acceptable: boolean;
    report: RfKorrTuneReport;
}

interface GridBin {
    sumDw: number; weight: number; count: number;
    min: number; max: number; veCells: Set<number>;
    /** Σ(Δ x w), so the bin can say where its evidence actually SAT — not merely how much of it
     *  there was. See maxDeltaOffsetFrac. */
    sumDeltaW: number;
}

const zeros = (rows: number, cols: number) =>
    Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
const flags = (rows: number, cols: number) =>
    Array.from({ length: rows }, () => new Array<boolean>(cols).fill(false));

/**
 * The trim the VE write uses, for the same sample — `calculator.ts accumulatePoint`, term for term.
 *
 * Whichever STFT banks are present, averaged over those alone; undefined with none. It used to read
 * `(p.stft1 ?? p.stft2 ?? 1)`, so a row with no trim at all silently became 1.000 — and then
 * `D = rfKorr x 1` is the table already in the ECU, returned as a derivation of it. The long-term
 * store multiplies in as it does there, and reads 1.0 where the log does not carry it.
 *
 * Exported for the high-Δ guard, whose "this cell's VE is converged" must mean what the anchor
 * check's does.
 */
export function trimOf(p: LogDataPoint): number | undefined {
    const stft = [p.stft1, p.stft2].filter((v): v is number => v !== undefined);
    if (!stft.length) return undefined;
    const ltft = [p.ltft1, p.ltft2].filter((v): v is number => v !== undefined);
    const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
    return mean(stft) * (ltft.length ? mean(ltft) : 1);
}

/**
 * Per sample: had RF been still, and TABG stopped chasing it, for `settleSec` beforehand?
 *
 * Both halves are needed and they are not the same question. Steady RF says the load step is over,
 * which is what gives the exhaust a chance to catch up; a bounded TABG rate says it actually has.
 * A long pull fails the second one for as long as the exhaust is genuinely still heating — which is
 * correct, because Δ is not a density measurement while the temperature is a moving target.
 *
 * A sample with less than `settleSec` of log behind it is not settled: there is no evidence either
 * way, and "no evidence" must not read as "steady". That alone disqualifies the first few seconds
 * of every log, which is the right answer for a car that has just been started.
 */
function settledFlags(log: LogDataPoint[], o: RfKorrTuneOptions): boolean[] {
    const out = new Array<boolean>(log.length).fill(false);
    if (log.length === 0) return out;
    const perUnit = timeScaleSeconds(log);
    const window = o.settleSec / perUnit;   // in the log's own time units

    // The window start only moves forward, so the inner scan below covers `settleSec` of samples
    // rather than the whole log — a few seconds at any realistic rate, and independent of how long
    // the drive was.
    let start = 0;
    for (let i = 0; i < log.length; i++) {
        while (start < i && (log[i].time - log[start].time) > window) start++;
        // `start` is now the oldest sample still inside the window. If it never fell behind, the
        // log does not reach back far enough to say anything.
        if (start === 0 && (log[i].time - log[0].time) < window) continue;

        let rfMin = Infinity, rfMax = -Infinity, egtMin = Infinity, egtMax = -Infinity;
        let ok = true;
        for (let j = start; j <= i; j++) {
            const rf = log[j].rf, egt = log[j].exhaustTemp;
            if (rf === undefined || egt === undefined) { ok = false; break; }
            if (rf < rfMin) rfMin = rf;
            if (rf > rfMax) rfMax = rf;
            if (egt < egtMin) egtMin = egt;
            if (egt > egtMax) egtMax = egt;
        }
        if (!ok) continue;

        const span = (log[i].time - log[start].time) * perUnit;
        if (!(span > 0)) continue;
        out[i] = (rfMax - rfMin) <= o.maxRfDrift
            && (egtMax - egtMin) / span <= o.maxEgtRatePerSec;
    }
    return out;
}

/** The four bilinear corners and their weights, skipping zero-weight ones. A null bracket — a
 *  sample whose rpm or load is not a number — contributes no corners, so the caller's existing
 *  "no corners means no sample" branch already handles it. See axisBracket. */
function corners(
    x: AxisBracket | null,
    y: AxisBracket | null,
): Array<{ r: number; c: number; w: number }> {
    const out: Array<{ r: number; c: number; w: number }> = [];
    if (!x || !y) return out;
    const push = (r: number, c: number, w: number) => { if (w > 0) out.push({ r, c, w }); };
    push(y.i0, x.i0, (1 - y.w1) * (1 - x.w1));
    push(y.i0, x.i1, (1 - y.w1) * x.w1);
    push(y.i1, x.i0, y.w1 * (1 - x.w1));
    push(y.i1, x.i1, y.w1 * x.w1);
    return out;
}

/** Everything one accepted sample contributes, computed once. */
export interface RfKorrPrepared {
    rpm: number;
    /** `rfKorr x trim` — what the table should hold at this sample's Δ. */
    d: number;
    delta: number;
    /** Index of the VE cell this sample sits closest to, used only to count how many distinct
     *  cells agreed on a grid entry. */
    veKey: number;
}

/**
 * Which samples of a log can contribute to the correction table, and why the rest cannot.
 *
 * Split out of `tuneRfKorrTable` so a run can show this WHILE IT IS HAPPENING, by calling the same
 * function the final verdict calls. Two runs were once driven to completion and thrown away because
 * the number that would have saved them existed only after the drive was over; the inertia side
 * learned the same lesson (see lib/inertia/liveCoverage.ts).
 *
 * A second implementation would drift, and the drift would be invisible until someone had already
 * driven. So there is one implementation, and the live display and the table are both downstream of
 * it — including the two refusals, which are decided here for that reason.
 *
 * Cheap enough to call on a throttle: O(n) over the log, n a few thousand, no allocation per cell.
 * It does NOT build the table — that stays in `tuneRfKorrTable`.
 */
export function rfKorrCensus(
    annotatedLog: LogDataPoint[],
    egt: EgtTables,
    veAxes: { rpm: number[]; load: number[] },
    opts: Partial<RfKorrTuneOptions> = {},
): { report: RfKorrTuneReport; prepared: RfKorrPrepared[] } {
    const o: RfKorrTuneOptions = withDefaults(opts);
    const veCols = veAxes.rpm.length;

    const report: RfKorrTuneReport = {
        samplesTotal: annotatedLog.length,
        samplesNoMeasurement: 0, samplesNoDelta: 0,
        samplesGateShut: 0, samplesHysteresis: 0, samplesKRamp: 0, samplesNotCycling: 0,
        samplesNotSettled: 0,
        samplesNoTrim: 0, samplesUnsettledPoint: 0,
        samplesUsed: 0,
        anchorTrimSamples: 0, anchorTrimMedian: null,
        refused: null,
        gridCellsUpdated: 0, extrapolatedCells: 0,
        rejectedByReason: {
            'no-evidence': 0, 'thin-weight': 0, 'thin-count': 0,
            'single-ve-cell': 0, 'spread': 0, 'identity-column': 0, 'identity-row': 0,
            'off-breakpoint': 0,
        },
        // Decided over the WHOLE log up front, not inside the loop — see the field's own comment.
        sensorMissing: !annotatedLog.some(p => p.exhaustTemp !== undefined),
        // Decided over the WHOLE log up front, not inside the loop.
        //
        // It has to be, because it is a fact about the CHANNEL and every other test in the loop is a
        // fact about an operating point. Cleared where `samplesNoTrim` is counted, it would only
        // ever be reached by samples that had already passed the gate, the hysteresis band and the
        // settle window — so a drive full of trim that simply never held sustained load reported
        // "this log has no lambda trim", which is both false and the exact misdiagnosis this flag
        // was added to prevent. Session #904 is that run: 1260 rows, all of them carrying both
        // banks, and the tuner refused claiming there were none.
        trimMissing: !annotatedLog.some(p => p.stft1 !== undefined || p.stft2 !== undefined),
        largestChange: 0,
    };

    // Which samples have had RF still and TABG caught up for long enough that Δ describes this
    // operating point. Precomputed over the whole array rather than tested inline, so the window
    // can reach backwards past samples the loop is about to reject: a sample is settled or not by
    // what the car was doing beforehand, not by what else survived this function.
    //
    // It cannot see rows the LOG FILTER already removed (coolant, idle, cat-protection). The window
    // is bounded on timestamps rather than on indices, so a removal longer than settleSec falls out
    // of the window rather than being silently spanned; a shorter one would be spanned, which needs
    // the car to have dropped below 1000 rpm at a closed throttle and come back inside three
    // seconds, between two samples that both cleared the 55-80 % filling gate. Not worth the second
    // array to defend against.
    const settled = settledFlags(annotatedLog, o);

    const prepared: RfKorrPrepared[] = [];
    const anchorTrims: number[] = [];

    for (let i = 0; i < annotatedLog.length; i++) {
        const p = annotatedLog[i];
        // The log filter's Settle Time, applied HERE rather than by deleting the row upstream.
        // `settledFlags` above has already walked the intact series; removing these rows before it
        // ran would have left short gaps it spans rather than sees, and every one of them would
        // have made an unsteady stretch read as steady. See LogDataPoint.settleUnsteady.
        if (p.settleUnsteady) {
            report.samplesUnsettledPoint++;
            continue;
        }
        const rfKorr = p.rfKorr;
        const rfSoll = p.rfSoll;
        if (rfKorr === undefined || rfSoll === undefined || !(rfSoll > 0)) {
            report.samplesNoMeasurement++;
            continue;
        }
        const trim = trimOf(p);

        // The DME's latch, as walked over the raw log. Shut means rf_korr = 1.000 whatever the
        // exhaust was doing, so the sample says nothing about THIS table — but with K = 1 and the
        // loop settled, its trim is the VE's own error, which is exactly what the anchor check
        // needs. `kRamp === false` keeps out the climb back after the gate shuts on a stepped K:
        // the exit is a K drop, and the tracker holds the bank until the rich switch that ends it
        // (rampState.ts). `lambdaCycling === true` keeps out the walk from one cell's error to the
        // next, which `kRamp` cannot see: a walk read as the error says the VE is off by whatever
        // the last cell was. The VE write excludes the first kind too (`isLambdaRampExcluded`,
        // gate open or shut) but takes the walk, which DIRECT converges away; this reader cannot
        // wait for that, so it is the one the walk is kept from.
        if (p.rfKorrGateOpen !== true) {
            report.samplesGateShut++;
            if (p.rfKorrGateOpen === false && p.kRamp === false && p.lambdaCycling === true
                && trim !== undefined && trim > 0) {
                anchorTrims.push(trim);
            }
            continue;
        }
        if (p.exhaustTemp === undefined || p.rf === undefined) {
            report.samplesNoDelta++;
            continue;
        }

        // Latched but not at the entry condition — the hysteresis band, where the DME holds a value
        // computed at another operating point and stops reading the table — or within `gateMargin`
        // above the floor. Both halves of the entry test (`rfKorrActive`), then the margin.
        // Excluded as a data-quality matter, not a safety one.
        if (!rfKorrActive(egt, p.rpm, rfSoll, p.vehicleSpeed)
            || !gateOpen(egt, p.rpm, rfSoll, o.gateMargin)) {
            report.samplesHysteresis++;
            continue;
        }

        // The loop still taking the last K step back. Undefined counts as a ramp, as it does for
        // the VE write (`isLambdaRampExcluded`): the alternative credits the time since the step.
        if (p.kRamp !== false) {
            report.samplesKRamp++;
            continue;
        }

        // Post-ramp, but the trim is still walking from the last operating point's error: `K x trim`
        // is part of that cell's answer and part of this one's. Undefined is not cycling, for the
        // reason undefined `kRamp` is a ramp. A sample with no trim at all has no cycle to judge —
        // the flag is false there by construction — and is left to `samplesNoTrim` below, where an
        // EGT-profile log has always been counted.
        if (trim !== undefined && p.lambdaCycling !== true) {
            report.samplesNotCycling++;
            continue;
        }

        // Δ has to be a temperature difference, not a sensor that has not caught up yet. See
        // RfKorrTuneOptions.settleSec.
        if (!settled[i]) {
            report.samplesNotSettled++;
            continue;
        }

        if (trim === undefined) { report.samplesNoTrim++; continue; }
        if (!(trim > 0)) { report.samplesNoMeasurement++; continue; }

        // annotateRfKorr already computed this against the same tables; taking its value rather
        // than recomputing is what keeps the tuner and the VE calculation on the same Δ.
        const delta = p.tabgDelta
            ?? Math.max(0, tabgModelAt(egt, p.rpm, p.rf / 100) - p.exhaustTemp);

        const load = p.correctedLoad ?? p.rawLoad;
        const veCorners = corners(axisBracket(veAxes.rpm, p.rpm), axisBracket(veAxes.load, load));
        if (veCorners.length === 0) { report.samplesNoMeasurement++; continue; }
        const dominant = veCorners.reduce((best, c) => (c.w > best.w ? c : best));

        prepared.push({ rpm: p.rpm, d: rfKorr * trim, delta, veKey: dominant.r * veCols + dominant.c });
        report.samplesUsed++;
    }

    // The anchor check, over the same drive. A median rather than a mean: the population is every
    // settled, cycling gate-shut sample from light cruise up to the floor, and a mean would let one
    // stretch near a trim clamp decide whether the whole map is converged.
    report.anchorTrimSamples = anchorTrims.length;
    if (anchorTrims.length) {
        const sorted = [...anchorTrims].sort((a, b) => a - b);
        const m = sorted.length >> 1;
        report.anchorTrimMedian = sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
    }

    // K HOLD first: under it every sample is gate-shut, the anchor check would pass on a converged
    // VE, and "nothing was measured" would be the true but useless thing to say. The tables are the
    // EFFECTIVE ones the hook resolves, so a hold that did not take has the stock floor back here
    // and is tuned as the stock-gate drive it was.
    if (isRfKorrFloorHeld(egt)) {
        report.refused = 'kHeld';
    } else if (anchorTrims.length < o.anchorCheckMinSamples
        || Math.abs((report.anchorTrimMedian ?? 0) - 1) > o.anchorTrimTolerance) {
        report.refused = 'veNotAnchored';
    }

    return { report, prepared };
}

export function tuneRfKorrTable(
    currentMap: VEMap,
    annotatedLog: LogDataPoint[],
    egt: EgtTables,
    veAxes: { rpm: number[]; load: number[] },
    opts: Partial<RfKorrTuneOptions> = {},
): RfKorrTuneResult | null {
    const o: RfKorrTuneOptions = withDefaults(opts);

    const rpmAxis = egt.rfKorr.rpm;
    const deltaAxis = egt.rfKorr.delta;
    const rows = deltaAxis.length, cols = rpmAxis.length;

    const { report, prepared } = rfKorrCensus(annotatedLog, egt, veAxes, o);

    // Both are "this log cannot answer the question", and both return nothing rather than something
    // weak: the caller shows a table when it gets one, and a table is a thing that gets flashed.
    //
    // The census above is still returned to a live caller in both cases — refusing to build a table
    // is not a reason to refuse to say why.
    if (report.sensorMissing || report.trimMissing) return null;

    const stock = egt.rfKorr.values.map(row => [...row]);
    const tuned = egt.rfKorr.values.map(row => [...row]);
    const countMap = zeros(rows, cols);
    const weightMap = zeros(rows, cols);
    const spreadMap = zeros(rows, cols);
    const measuredMap = zeros(rows, cols);
    const updated = flags(rows, cols);
    const extrapolated = flags(rows, cols);
    const rejected: (RejectReason | null)[][] =
        Array.from({ length: rows }, () => new Array<RejectReason | null>(cols).fill(null));

    // A refusal is a table, not a null, so the tab can carry the reason: the stock values, nothing
    // written, nothing measured — the D of an unanchored VE is not shown as though it meant
    // something — and `acceptable` false, so no write path can pick it up.
    if (report.refused) {
        return {
            rpm: [...rpmAxis], delta: [...deltaAxis],
            stock, tuned, countMap, weightMap, spreadMap, measuredMap, updated, rejected, extrapolated,
            acceptable: false,
            report,
        };
    }

    // --- Bin D on the correction's own grid -----------------------------------------------------
    const bins: GridBin[][] = Array.from({ length: rows }, () =>
        Array.from({ length: cols }, () => ({
            sumDw: 0, weight: 0, count: 0,
            min: Infinity, max: -Infinity, veCells: new Set<number>(),
            sumDeltaW: 0,
        })));

    for (const s of prepared) {
        for (const g of corners(axisBracket(rpmAxis, s.rpm), axisBracket(deltaAxis, s.delta))) {
            const bin = bins[g.r][g.c];
            bin.sumDw += s.d * g.w;
            bin.sumDeltaW += s.delta * g.w;
            bin.weight += g.w;
            bin.count++;
            if (s.d < bin.min) bin.min = s.d;
            if (s.d > bin.max) bin.max = s.d;
            bin.veCells.add(s.veKey);
        }
    }

    // A column BMW pinned at 1.000 across every Δ. Detected from the loaded bytes rather than by
    // rpm value, so a binary with a different calibration is judged on what it actually contains.
    const isIdentityColumn = (c: number) => {
        let lo = Infinity, hi = -Infinity;
        for (let r = 0; r < rows; r++) {
            lo = Math.min(lo, stock[r][c]);
            hi = Math.max(hi, stock[r][c]);
        }
        return hi - lo < o.identitySpan;
    };

    // The same test along the other axis, and read from the bytes for the same reason. In stock
    // this is the Δ = 30 row: 1.000 at every rpm, the zero of the whole table. Everything else is a
    // departure FROM it, so moving it moves all six rows at once relative to nothing.
    const isIdentityRow = (r: number) => {
        let lo = Infinity, hi = -Infinity;
        for (let c = 0; c < cols; c++) {
            lo = Math.min(lo, stock[r][c]);
            hi = Math.max(hi, stock[r][c]);
        }
        return hi - lo < o.identitySpan;
    };

    // How far a bin's weighted-mean Δ may sit from its own breakpoint, per row. Derived from the
    // axis rather than fixed, because the Y axis is far from uniform — 30/40/100/200/300/400, so
    // 10 °C is the whole gap at the bottom and a tenth of it further up.
    const deltaTolerance = deltaAxis.map((d, r) => {
        const gaps: number[] = [];
        if (r > 0) gaps.push(d - deltaAxis[r - 1]);
        if (r < rows - 1) gaps.push(deltaAxis[r + 1] - d);
        return Math.max(Math.min(...gaps) * o.maxDeltaOffsetFrac, o.minDeltaTolerance);
    });

    /** The loaded value moved toward `target` by at most one log's step, inside [floor, ceiling]. */
    const limited = (r: number, c: number, target: number) => {
        const stepped = Math.min(stock[r][c] + o.maxStepUp, Math.max(stock[r][c] - o.maxStepDown, target));
        return Math.min(o.ceiling, Math.max(o.floor, stepped));
    };

    // --- Decide each grid cell from its own evidence ---------------------------------------------
    for (let c = 0; c < cols; c++) {
        const identity = isIdentityColumn(c);
        for (let r = 0; r < rows; r++) {
            const identityRow = isIdentityRow(r);
            const bin = bins[r][c];
            countMap[r][c] = bin.count;
            weightMap[r][c] = bin.weight;
            if (bin.count > 0) {
                spreadMap[r][c] = bin.max - bin.min;
                measuredMap[r][c] = bin.weight > 0 ? bin.sumDw / bin.weight : 0;
            }

            const reason = rejectionFor(
                bin, identity, identityRow, deltaAxis[r], deltaTolerance[r], o);
            if (reason) { rejected[r][c] = reason; continue; }

            tuned[r][c] = limited(r, c, bin.sumDw / bin.weight);
            updated[r][c] = true;
        }
    }

    // --- Rows above the highest measured one: the shrink ratio, when the guard allows -------------
    //
    // Per column, from the highest row this log WROTE — its new value as a fraction of BMW's excess
    // over 1.000 there, applied to BMW's excess in each row above (`CSL_STOCK_RF_KORR_DRREL`, whose
    // doc says why not the loaded table's). Each row still steps from its LOADED value. Capped at 1
    // because the formula is a shrink: a top row that went up says the low Δ wanted more, which says
    // nothing about how much more 300/400 want, and an extrapolated increase would be the one write
    // here nothing measured at all. Not taken from a row whose stock excess is under `identitySpan`,
    // where `s` would divide by the table's own rounding. Identity columns are skipped by
    // construction: nothing in them is written.
    if (o.highDeltaGuard?.ok === true && o.highDeltaGuard.skippedUnconverged !== undefined) {
        const base = shrinkBase(rpmAxis, deltaAxis) ?? stock;
        for (let c = 0; c < cols; c++) {
            let top = -1;
            for (let r = 0; r < rows; r++) if (updated[r][c]) top = r;
            if (top < 0) continue;
            const excess = base[top][c] - 1;
            if (!(excess >= o.identitySpan)) continue;
            const s = Math.min(1, Math.max(0, (tuned[top][c] - 1) / excess));
            for (let r = top + 1; r < rows; r++) {
                const value = limited(r, c, 1 + s * (base[r][c] - 1));
                if (Math.abs(value - stock[r][c]) < 1e-12) continue;
                tuned[r][c] = value;
                updated[r][c] = true;
                extrapolated[r][c] = true;
                rejected[r][c] = null;
            }
        }
    }

    // Counted off the FINAL maps, so a cell refused on its own evidence and then filled by the
    // shrink is reported once, as written.
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        const reason = rejected[r][c];
        if (reason) report.rejectedByReason[reason]++;
        if (!updated[r][c]) continue;
        report.gridCellsUpdated++;
        if (extrapolated[r][c]) report.extrapolatedCells++;
        report.largestChange = Math.max(report.largestChange, Math.abs(tuned[r][c] - stock[r][c]));
    }

    return {
        rpm: [...rpmAxis], delta: [...deltaAxis],
        stock, tuned, countMap, weightMap, spreadMap, measuredMap, updated, rejected, extrapolated,
        // One updated cell is a curiosity, not a calibration. Requiring a handful keeps a log that
        // happened to clip one corner of the grid from presenting itself as a tune — and they are
        // MEASURED cells: the shrink only follows a measurement, so it cannot stand in for one.
        acceptable: report.gridCellsUpdated - report.extrapolatedCells >= 3
            && report.samplesUsed > 0,
        report,
    };
}

/** BMW's DRREL as physical values when the loaded table is on its axes, else null. */
function shrinkBase(rpmAxis: number[], deltaAxis: number[]): number[][] | null {
    const ref = CSL_STOCK_RF_KORR_DRREL;
    const same = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((v, i) => v === b[i]);
    if (!same(rpmAxis, ref.RPM) || !same(deltaAxis, ref.DELTA)) return null;
    return ref.RAW.map(row => row.map(v => v / 1024));
}

function rejectionFor(
    bin: GridBin, identity: boolean, identityRow: boolean,
    breakpoint: number, tolerance: number, o: RfKorrTuneOptions,
): RejectReason | null {
    if (bin.count === 0) return 'no-evidence';
    if (identity && !o.writeIdentityColumns) return 'identity-column';
    if (identityRow && !o.writeIdentityRow) return 'identity-row';
    if (bin.count < o.minCellSamples) return 'thin-count';
    if (bin.weight < o.minCellWeight) return 'thin-weight';
    if (bin.veCells.size < o.minDistinctVeCells) return 'single-ve-cell';
    // Where the evidence sat, not just how much of it there was.
    if (bin.weight > 0 && Math.abs(bin.sumDeltaW / bin.weight - breakpoint) > tolerance) {
        return 'off-breakpoint';
    }
    if (bin.max - bin.min > o.maxSpread) return 'spread';
    return null;
}
