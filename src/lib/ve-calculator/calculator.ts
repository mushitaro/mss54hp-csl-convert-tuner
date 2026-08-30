import { type LogDataPoint, type VEMap, type RfKorrMode, type RfKorrSource, resolveRfKorr } from '@/lib/types';
import { APP_CONFIG, CSL_STOCK_MAP_DATA, CSL_STOCK_WARMUP_MAP, CSL_STOCK_WARMUP_RPM, CSL_STOCK_WARMUP_LOAD } from '@/config/constants';
import { chargeTempFactor, rfPtKorrFor, type RfPtKorrCurves } from './chargeTemp';
import {
    type EgtTables, EGT_INVERSION_DEFAULTS, gateOpen, interpMap2d, invertRfKorrProfile, rfKorrAt,
    rfKorrProfileAt, tabgModelAt,
} from './egtTables';
import type { RfKorrTuneResult, RfKorrTuneOptions } from './rfKorrTuner';
import { LOW_LOAD_TOP_ROW, MAX_SAMPLE_SD } from './lowLoadTuner';
import { axisBracket } from '@/lib/log-engine/axisBracket';

interface GridCell {
    sumStftWeighted: number; // Sum(STFT * Weight)
    weightSum: number;       // Sum(Weight)
    rawCount: number;        // Count of samples (integer)

    // rf_korr is tracked on its own weight because it is present on fewer samples than STFT is:
    // a Testo CSV has no RF channel at all, and even on a live log a sample whose Alpha-N
    // interpolation comes out 0 yields no ratio. Dividing by `weightSum` would silently understate
    // the mean on any cell with a mixed set.
    sumRfKorrWeighted: number;
    weightSumRfKorr: number;
    minRfKorr: number;
    maxRfKorr: number;

    // The 'tuned' correction, accumulated alongside rather than instead of the nominal one. Both
    // are needed at the same time: the guard below compares them, and a cell that fails it falls
    // back to the nominal value, which has to still be there to fall back to.
    sumTunedWeighted: number;
    weightSumTuned: number;

    /**
     * Sum(Weight^2), which with `weightSum` gives the cell's SELF-SHARE, `Sum(w^2)/Sum(w)`.
     *
     * The weighted mean below answers "what correction did samples NEAR this cell demand". A
     * sample lands on four cells at once, so a cell can clear a weight threshold on evidence that
     * was mostly about its neighbours — twenty grazing samples at w = 0.25 reach weightSum 5.0
     * while three quarters of the signal came from next door. This is the statistic that tells
     * those apart, and it costs one multiply per corner.
     */
    sumWeightSq: number;

    /** Sum(Weight * correction^2) — the other half of a weighted variance, whose square root is
     *  the SCATTER of this cell's corrections and, divided by the effective sample count, the
     *  precision of their mean. See the gate in finalizeGrid. */
    sumStftSqWeighted: number;

    /**
     * The lag-1 cross-products, from which this cell's own autocorrelation is recovered.
     *
     * Stored as SUMS so the live path stays incremental: a mean cannot be subtracted before the
     * run is over, so the deviations are formed at the end from these six numbers instead.
     * `prevVal` / `prevTime` carry the previous sample so the pair can be closed; `prevTime` is
     * what enforces "consecutive in the log" rather than "consecutive among this cell's samples".
     */
    /**
     * Samples that were substantially INSIDE this cell — the same `w >= CLAMP_MIN_WEIGHT` test the
     * lag pairs use, and therefore the population the autocorrelation describes.
     *
     * With `lagPairs` this gives the run structure for nothing: a run of L consecutive samples
     * contributes L-1 pairs, so `runs = substantialCount - lagPairs` and the mean run length is
     * `substantialCount / runs`. That is what the exact AR(1) correction needs, and it is why
     * `rawCount` cannot be used for it — `rawCount` counts every sample at any weight, so
     * subtracting pairs from it invents visits out of samples that never entered the series.
     */
    substantialCount: number;
    lagPairs: number;
    sumLagAB: number;
    sumLagA: number;
    sumLagB: number;
    sumLagA2: number;
    sumLagB2: number;
    prevVal: number | null;
    prevTime: number | null;

    /**
     * The range of corrections demanded by samples that landed substantially INSIDE this cell.
     *
     * The clamp built from it is what stops the ratchet. The write realises less than it demands —
     * scaling one cell by `x` moves the DME's interpolated lookup by only its own share of it — so
     * a flash-and-relog cycle sees the remainder again and asks for it again, walking the cell past
     * anything any sample ever demanded and into a spike against its unwritten neighbours. Bounding
     * the result to what was actually observed here makes that fixed point unreachable.
     */
    minCorrectionNear: number;
    maxCorrectionNear: number;
    /** The same bounds for the TUNED correction. Separate because the clamp has to bound the
     *  quantity that is actually written: the tuned value is the nominal one divided by k_new, so
     *  the two ranges can be 20 % apart and clamping one against the other would drag a tuned cell
     *  back onto the nominal answer while `tunedUsedMap` still claimed the tuned path. */
    minTunedNear: number;
    maxTunedNear: number;
}

/**
 * How much of a cell's weight must be its OWN before it may be written.
 *
 * Not a round number, and not a guess. Evidence spread evenly through a cell's bracket has an
 * expected self-share of `E[w^2]/E[w] = (1/3)^2 / (1/4) = 0.444` for `w = u*v` with u, v uniform —
 * and session #920's 109 earned cells have a MEDIAN self-share of 0.432, which is that number.
 * So 0.444 is what "normal" looks like, not a bar to clear.
 *
 * This is two thirds of it. On #920 it refuses 10 of 109 cells, the worst at 0.065 — a cell whose
 * correction was 93 % a statement about its neighbours. Raising it to the 0.5 that sounds like a
 * natural threshold would refuse 98 of the 109, because a sample almost never lands dead centre in
 * two dimensions at once.
 */
export const MIN_SELF_SHARE = 0.30;

/**
 * The lag-1 autocorrelation a cell assumes when it cannot measure its own.
 *
 * Every precision test in this file divides by a sample count, and a count means what it says only
 * if the samples are independent draws. They are not: `la_f_regler` is a two-point controller that
 * oscillates by construction at 1-2 Hz, and the log runs at 4-5 Hz, so consecutive samples are two
 * to four points on ONE swing of the same limit cycle. Kish's `nEff` corrects for unequal WEIGHTS
 * and says nothing about time.
 *
 * Measured over sessions #1/#914/#917/#918/#919/#920 by `analyze:autocorrelation`, on pairs that
 * are consecutive in the log and deviations taken from the cell's own mean:
 *
 *     per drive   rho 0.796 to 0.912      correlation time tau 0.78 to 2.07 s
 *     per cell    p05 0.489  med 0.847  p95 0.954      (192 cells)
 *
 * `tau = -dt / ln(rho)` lands on the controller's own period, which is the cross-check that this
 * is measuring the limit cycle rather than something else.
 *
 * The constant is the per-cell MEDIAN, not the pooled value (0.894): pooling weights by pair count,
 * so it is dominated by long-dwell cells — and those are exactly the cells that can measure their
 * own rho and never reach this fallback. A cell that falls back is one traversed quickly, where the
 * true rho is likely LOWER, so this errs toward demanding more evidence.
 */
export const AUTOCORR_FALLBACK = 0.85;

/** Pairs a cell needs before its own rho is trusted over the fallback. Below this the estimate is
 *  noisier than the constant it would replace. */
export const AUTOCORR_MIN_PAIRS = 20;

/**
 * How far apart two samples may be and still count as consecutive, in seconds.
 *
 * A cell is visited, left and revisited; a pair straddling a gap of minutes is independent by
 * construction and would drag rho toward zero. A FIXED bound rather than a multiple of the log's
 * own median interval, because the live path has seen less of the log than a batch pass and would
 * compute a different median — `verify:incremental` requires the two to agree cell for cell.
 *
 * 0.6 s admits anything logged at 1.7 Hz or faster, which covers this app's DS2 rate (about 4-5 Hz)
 * and the 10 Hz Testo logs the older sessions came from. A slower log collects no pairs at all and
 * every cell falls back, which is the safe direction.
 */
export const AUTOCORR_MAX_GAP_SEC = 0.6;

/** Ceiling on rho. At 1.0 the variance inflation is infinite; a cell that measures higher than
 *  this is telling us it holds one observation, and this bounds what that costs. */
export const AUTOCORR_RHO_MAX = 0.98;

/**
 * Independent observations a cell needs before its scatter can be turned into a standard error.
 *
 * Three, so the Student dof is at least two and the critical value is finite. There is no need for
 * a larger floor: the t distribution already demands a proportionally bigger correction when the
 * evidence is thin, which is the job an arbitrary sample-count bar was doing badly.
 */
export const MIN_INDEPENDENT = 3;

/**
 * WHICH METHOD DECIDES A CELL. The axis of this whole path, and the default is the community's.
 *
 *   'direct'       write every cell that has evidence, move it by a fixed AUTHORITY, drive again.
 *   'statistical'  write only cells that can carry the correction alone, sized by shrinkage.
 *
 * DIRECT is named for what it does — writes the measurement straight through — rather than for the
 * tuning suite the approach is borrowed from. That is another company's product and this is not
 * their code; the one number genuinely inherited from them is credited at `minCellWeight` below.
 *
 * These are not "loose" and "strict". They answer DIFFERENT QUESTIONS, and only the first matches
 * how this table is actually tuned.
 *
 *   DIRECT asks:       given everything measured so far, what is the best next map?
 *   Statistical asks:  can THIS drive prove THIS cell on its own, at 95 %?
 *
 * The second is the question a paper asks, and it is the wrong one here for two reasons that are
 * both measurable rather than matters of taste.
 *
 * FIRST, the loop is what makes the answer accurate, not the single pass. A pass writes a
 * correction, the next drive measures what is left, and the error contracts geometrically. That is
 * a low-gain integrator, and it converges from estimates far too noisy to publish. Demanding
 * per-pass significance does not improve the fixed point; it only refuses to take the step.
 *
 * SECOND, the losses are not symmetric, and a significance test assumes they are. Leaving a cell
 * alone is not the neutral act it looks like — `kf_rf_soll` is the DME's load signal, so an
 * uncorrected cell feeds a wrong number to ignition, the torque model and every limiter. On session
 * #923 the cells the statistical gate refused were asking for a median 6.6 % and up to 16.8 %.
 * Writing a cell that turns out 2 % wrong costs one more lap of a loop that was going to run
 * anyway. Refusing 15 % of correction to avoid 2 % of noise is not conservative, it is backwards.
 *
 * MEASURED, session #923, same log and same base through both:
 *
 *     both methods write            10 cells   —  agreeing to within half a table step
 *     'direct' additionally writes     48 cells
 *     'statistical' additionally        0 cells
 *
 * Two separate measurements sit behind that, and they should not be conflated. Removing only the
 * HARD GATES — self-share, independence, the sample floor — while KEEPING shrinkage took the count
 * from 10 to 31 and changed no shared value at all (max delta 0.00e+0): proof that those gates were
 * a pure subtraction rather than a quality bar. Replacing shrinkage with a flat authority is the
 * second half of 'direct', and it takes the count to 58 while moving the shared cells by less than
 * half a writable step, since lambda approaches 1 without reaching it.
 *
 * Either way the statistical side adds nothing. Worse, it subtracts UNEVENLY: at 2200 rpm the
 * 100 %, 85 % and 65 % rows all asked for about -15 % and only the middle one was written, putting a 15 % step into a surface that had
 * none. A gate that refuses a whole neighbourhood is safe; one that refuses every second cell of it
 * is not.
 *
 * `statistical` is kept in full, because the question it asks is the right one to ask ONCE — at the
 * end, when the loop has converged and the remaining moves are small enough that signal and noise
 * are genuinely comparable. That is also when SHAPE is allowed to run. See
 * `docs/ecu-logic/61-cell-gate-review.md`.
 */
export type VeMethod = 'direct' | 'statistical';

/** The community's method, and this app's default. See VeMethod for the measurement behind it. */
export const VE_METHOD_DEFAULT: VeMethod = 'direct';

/**
 * How much of a cell's measured demand one DIRECT pass applies, as a fraction.
 *
 * 1.0 — take the whole step. The contraction does not need damping to converge here, because the
 * demand is already bounded twice before this multiplies it: by the range samples INSIDE the cell
 * actually asked for (the anti-ratchet, which is what stops a flash-and-relog loop walking a cell
 * past every correction ever seen), and by CORRECTION_MIN/MAX. Damping below 1.0 is for a live loop
 * correcting while it measures; this one measures a whole drive, stops, and applies once.
 *
 * Exposed as a setting because the operator, not this file, knows whether a given drive was clean
 * enough to take at face value.
 */
export const DIRECT_AUTHORITY_DEFAULT = 1.0;

/**
 * Samples a cell needs before DIRECT will write it.
 *
 * Three, the fewest that can carry a mean and a scatter at all. It is NOT a precision bar —
 * precision is what AUTHORITY and the next drive are for — it only keeps cells that a single
 * grazing sample would otherwise define out of the map. The statistical method keeps its own 10.
 */
export const DIRECT_MIN_SAMPLES = 3;

/**
 * Weight a cell needs before it is written — the sum of the shares it actually received.
 *
 * A COUNT AND A WEIGHT ANSWER DIFFERENT QUESTIONS, and this map needs both. The count above asks
 * "did enough separate moments visit this cell"; this asks "how much of the DME's own reading was
 * this cell". One sample sitting dead centre between four nodes gives each of them 0.25, so a cell
 * can be visited three times and still have been three quarters of a sample's worth of evidence.
 *
 * WHY IT IS BACK. This defaulted to 0 and was documented as retired: the value it carried then was
 * 5.0, copied from `RF_KORR_TUNE_DEFAULTS`, and measured over six drives it refused two cells while
 * admitting 43 the later gates refused anyway. That measurement was taken when the COUNT was
 * `rawCount` — which incremented on every corner a sample touched at any share above zero — so the
 * count was already admitting cells on grazes and the weight bar had nothing left to catch. With
 * the count now taken over samples at `w >= CLAMP_MIN_WEIGHT`, the two are no longer measuring the
 * same thing and the weight is the one that reads coverage rather than visits.
 *
 * 2.5, measured on #933 against 0 / 1.5 / 4.0. What decides it is not the cell count (83 -> 69) but
 * the SHAPE that survives: a weight bar drops a poorly covered NEIGHBOURHOOD together, where a
 * count bar punches one cell out of a row its neighbours still move. At 1400 rpm — the rpm the car
 * bucks at — 25/30/45 % opening leave together and the row comes out monotone in the opening axis,
 * where at 0 it dips 5.3 % at 65 %. 1.5 changes nothing on this drive (83 cells) and 4.0 costs 26
 * cells for no further shape.
 *
 * It is not free: 1600 rpm gains a 2.4 % dip at 65 %, whose cell falls just under the bar. A hole
 * beside written neighbours is its own step, which is why this is a tuning decision and has a
 * control rather than a constant.
 */
export const VE_MIN_WEIGHT_DEFAULT = 2.5;

/**
 * The variance-of-the-mean inflation for a run of `n` correlated samples, EXACTLY.
 *
 *     Var(mean) = (sigma^2 / n) * [ 1 + 2 * sum_{k=1..n-1} (1 - k/n) rho^k ]
 *
 * The familiar `(1 + rho) / (1 - rho)` is this in the limit of large `n`, and using it on a short
 * run over-charges badly: measured on six drives the mean run of consecutive substantially-inside
 * samples is 6.0 (p25 3.4, p75 10.3), and at rho = 0.85 the exact factor there is 4.5 against the
 * asymptotic 12.3. That is 2.7x on variance and 1.66x on the standard error — the difference
 * between writing a cell and refusing it, not a rounding.
 *
 * Closed form rather than a loop so a fractional mean run length is well defined:
 *
 *     sum_{k=1..n-1} rho^k       = rho (1 - rho^(n-1)) / (1 - rho)
 *     sum_{k=1..n-1} k rho^k     = rho (1 - n rho^(n-1) + (n-1) rho^n) / (1 - rho)^2
 */
export function autocorrInflation(rho: number, n: number): number {
    if (!(n > 1) || !(rho > 0)) return 1;
    if (rho >= 1) return n;                       // every sample the same observation
    const d = 1 - rho;
    const pn1 = Math.pow(rho, n - 1);
    const pn = pn1 * rho;
    const sumR = rho * (1 - pn1) / d;
    const sumKR = rho * (1 - n * pn1 + (n - 1) * pn) / (d * d);
    // Bounded by `n` at the top (a perfectly correlated run is one observation) and 1 at the
    // bottom (uncorrelated samples inflate nothing); floating point on a near-unity rho can
    // otherwise step outside both.
    return Math.min(n, Math.max(1, 1 + 2 * (sumR - sumKR / n)));
}

/**
 * Two-sided 95 % Student t critical values, interpolated in 1/dof.
 *
 * A table rather than an approximation formula because it is exact where it is tabulated and the
 * error between points is under half a percent — and because a wrong quantile here would silently
 * change every cell rather than fail. dof below 1 returns the dof = 1 value, which refuses almost
 * everything, and that is the right behaviour for a cell with no degrees of freedom.
 */
const T_TABLE: readonly (readonly [number, number])[] = [
    [1, 12.706], [2, 4.303], [3, 3.182], [4, 2.776], [5, 2.571], [6, 2.447], [8, 2.306],
    [10, 2.228], [15, 2.131], [20, 2.086], [30, 2.042], [60, 2.000], [1e9, 1.960],
];
export function tCritical95(dof: number): number {
    if (!(dof > 1)) return T_TABLE[0][1];
    for (let i = 1; i < T_TABLE.length; i++) {
        const [d0, v0] = T_TABLE[i - 1];
        const [d1, v1] = T_TABLE[i];
        if (dof <= d1) {
            // Linear in 1/dof, which is the shape the tail actually follows.
            const x = 1 / dof, x0 = 1 / d0, x1 = 1 / d1;
            return x0 === x1 ? v0 : v1 + ((x - x1) / (x0 - x1)) * (v0 - v1);
        }
    }
    return T_TABLE[T_TABLE.length - 1][1];
}

/** How much of a sample has to be in a cell for that sample's correction to bound the cell's
 *  clamp. A quarter is one corner's worth of a dead-centre sample; below it the sample is
 *  describing the neighbourhood, which is the thing the clamp exists to not be led by. */
const CLAMP_MIN_WEIGHT = 0.25;

/**
 * How far the 'tuned' correction may sit from the 'nominal' one before a cell gives up and takes
 * the nominal value.
 *
 * This is the load-bearing bound on the new path. 'nominal' is the behaviour that has shipped and
 * is known to fail rich; dividing by a measured quantity is new, and a cell whose k_new came from
 * thin evidence could otherwise move the map a long way on very little. 15 % means the tuned path
 * can refine the map but can never take it somewhere the existing path would not go.
 */
const TUNED_VS_NOMINAL_MAX = 0.15;

/**
 * Absolute bounds on any per-cell correction, either path.
 *
 * A catastrophe net rather than a tuning parameter: outside this range the lambda integrator is
 * pinned at its own clamp and the samples are not describing mixture any more. Nothing before this
 * commit could reach it — but nothing before this commit divided.
 */
const CORRECTION_MIN = 0.5;
const CORRECTION_MAX = 2.0;

/**
 * Why a cell was not written — one reason per gate, in the order they are tested.
 *
 * This path used to refuse cells silently: `acceptedMap` said no and nothing said why. The
 * low-opening tuner has named its refusals since it was written, and the difference showed the
 * moment anyone asked why an ordinary drive earned so little — the low band could answer per cell
 * and this one could only shrug. A refusal a reader cannot act on is indistinguishable from a bug.
 *
 * `null` means the cell was written.
 */
export type VeReject =
    /** Below the seam: the low-opening derivation owns this cell, and reports its own verdict. */
    | 'out-of-band'
    /** No sample landed here at all. The remedy is to drive this state, not to drive it better. */
    | 'no-evidence'
    /** Samples, but not enough of them. */
    | 'thin-count'
    /** Enough samples, but they landed at the edges — `weightSum` is what that costs. */
    | 'thin-weight'
    /** The evidence is mostly ABOUT THE NEIGHBOURS. See MIN_SELF_SHARE. */
    | 'shared-evidence'
    /** Too few INDEPENDENT observations for the scatter to become a standard error. Replaces the
     *  job the raw count and weight bars were doing badly — see MIN_INDEPENDENT. */
    | 'thin-independent'
    /** The correction is real but not distinguishable from "change nothing" at this precision.
     *  Replaces 'imprecise', which tested an absolute bound against a statistic that assumed
     *  independent samples. */
    | 'not-significant'
    /** The corrections scatter more than one condition can explain. */
    | 'scatter'
    /** One condition, but the mean is not pinned to a writable step yet. */
    | 'imprecise';

/**
 * What `annotateRfKorrPoint` needs to measure rf_korr honestly.
 *
 * Absent, or missing either half for a sample, and no rf_korr is produced at all — see the note at
 * the measurement itself for why that is the safe direction.
 */
/**
 * What the DME's own integer arithmetic loses between the table and the RF it reports, in %RF.
 *
 * `rf_soll = (kf_rf_soll * RF_PT_KORR) >> 12` and `RF = (rf_soll * rf_korr) >> 10` are both
 * TRUNCATIONS — the remainder is discarded, never rounded. Each drops a mean half of its own least
 * significant bit, and the half missing from `rf_soll` propagates through the second multiply, so
 * the reported RF sits about one full step below the exact arithmetic. RF's step is 0.1 %RF.
 *
 * It matters most exactly where the map is hardest to see: one step is 1.0 % at RF = 10, 0.25 % at
 * RF = 40, 0.13 % at RF = 80. Left alone it reads as "the engine took less air than the table
 * says", i.e. as a lean-leaning correction that grows toward idle.
 *
 * The size is not fitted. Regressing `1 - rfKorr` on `1 / RF` over samples where the DME's own
 * gate is shut — where rf_korr is 1.0000 by construction, so the ratio should be exactly 1 — gives
 * a slope of 1.01 and 0.94 against a model prediction of exactly 1.00, on two independent drives
 * (quasi-steady samples, |d rf/dt| < 0.5 %/s; the transient tail carries the rf_soll filter's own
 * opposing bias and pulls the all-sample estimate to ~0.7).
 *
 * Added to the numerator of the rf_korr measurement and NOT to the logged `rf` channel: the channel
 * is what the DME reported, and 22.9 is the truth about what it said.
 */
export const RF_TRUNCATION_MEAN_PERCENT = 0.1;

export interface RfKorrAirInput {
    /** `KL_RF_TAN_KORR` and `KL_RF_P_UMG_KORR` out of the binary the log was recorded against. */
    curves: RfPtKorrCurves | null;
    /** Ambient pressure for logs recorded before the channel existed, mbar. Operator-supplied. */
    assumedPressureMbar?: number;
}

export interface VeCalcOptions {
    /**
     * Fold the measured rf_korr into the correction: New = Old * STFT * rf_korr.
     * This is karter16's "Option 2", and the caller should normally pass it TRUE.
     *
     * What it decides is what kf_rf_soll is FOR, and the two answers differ by up to 37 % where
     * KF_RF_KORR_DRREL peaks:
     *
     *   ON  — the table holds filling at NOMINAL exhaust temperature; rf_korr adds the
     *         cold-exhaust enrichment on top. A map tuned on a cold-exhaust drive is still right
     *         once the exhaust heats up and rf_korr falls back to 1.0.
     *   OFF — the table holds filling at whatever rf_korr the log was taken under. Self-consistent
     *         at that condition, and correct at every condition IF BMW's density model exactly
     *         matches this engine — because then rf_korr cancels out of the derivation.
     *
     * They fail in opposite directions, and that is the whole argument: OFF, on a log taken with a
     * cold exhaust, writes a table that goes LEAN under load once things warm up. ON is rich-safe.
     * On an S54 that asymmetry is not a close call, which is why the config default is on.
     *
     * Whether the model actually matches cannot be settled from one log. It needs the same cell
     * sampled at different tabg_delta, and then STFT read against rf_korr: flat means the model
     * matches, sloped means it does not. `rfKorrMap` / `rfKorrSpreadMap` are what make that
     * comparison possible — see docs/ecu-logic/60-tuning-logic.md §6.3.
     */
    applyRfKorr?: boolean;

    /**
     * How much evidence a VE cell needs before it may move. Defaults 10 samples AND weight 5.0 —
     * the same discipline rfKorrTuner already applies to its own grid.
     *
     * There was no count threshold here at all until 2026-08-15. The only test was
     * `weightSum > 0.1`, and weightSum is a sum of bilinear corner weights, so ONE sample landing
     * squarely on a cell scores 1.0 and moved it. The 10/30 pair that looked like thresholds were
     * heatmap bands in MapEditor and gated nothing. karter16 (thread 242281 #161) suggested raising
     * the thresholds; the more useful half of that advice turned out to be that the map had none.
     *
     * Both conditions, not either: ten samples spread over four corners can carry very little
     * weight, and a big weight can come from very few samples sitting dead centre.
     */
    /**
     * State every sample at the air the VE table is defined for, using the loaded BASE's own curves.
     *
     * Null or undefined = off, and the numbers are whatever the day's air gave. Set, each sample is
     * multiplied by `chargeTempFactor` before binning and DROPPED if it cannot produce one, so a
     * summer log and a winter log of the same engine produce the same map.
     *
     * The reference is not a setting: it is where `KL_RF_TAN_KORR` and `KL_RF_P_UMG_KORR` are
     * exactly 1, which on this calibration is 20 degC and 960.5 mbar. Nor is there a pressure term
     * — ambient pressure cancels out of the measurement rather than needing correction. See
     * chargeTemp.ts for the derivation of both.
     */
    normaliseTo?: RfPtKorrCurves | null;

    /**
     * What the rf_korr MEASUREMENT needs, which is not the same question as the normalisation above.
     *
     * `normaliseTo` decides whether to restate a correction at a reference air. This decides whether
     * a correction can be measured at all: without it `annotateRfKorrPoint` produces no rf_korr and
     * the calculation falls back to the lambda trim alone. Separate fields because they are
     * separately switchable — the normalisation is off by default and this is not.
     */
    rfKorrAir?: RfKorrAirInput;
    /**
     * Which method decides each cell — see VeMethod. Absent means `VE_METHOD_DEFAULT`.
     *
     * Travels in the filter config like every other threshold, so a stored session re-derives under
     * the method it was built with rather than under whatever today's default is.
     */
    veMethod?: VeMethod;
    /** Fraction of the demand one DIRECT pass applies. Absent means `DIRECT_AUTHORITY_DEFAULT`. Ignored
     *  by the statistical method, which sizes the step from the evidence instead. */
    directAuthority?: number;
    minCellSamples?: number;
    minCellWeight?: number;

    /**
     * Overrides for the rf_korr tuner's own grid thresholds, forwarded untouched.
     *
     * Separate from the two above because they gate different tables with different economics: the
     * VE map has 480 cells and the correction table has 72, so one rf_korr cell carries far more of
     * the result and deserves to be harder to move. Not merged into one pair of numbers for exactly
     * that reason.
     */
    rfKorrThresholds?: Partial<RfKorrTuneOptions>;

    /**
     * The DME's own EGT tables, decoded from the loaded binary. Optional throughout: without them
     * every derived column is simply absent and the calculation behaves exactly as it did before
     * they existed. `null` means the binary could not be decoded — treated the same as absent,
     * deliberately, since the alternative would be to substitute a stock table this binary may
     * not have. See readEgtTables.
     */
    egt?: EgtTables | null;

    /** @deprecated Read only through `resolveRfKorr`, so old sessions replay unchanged. */
    rfKorrMode?: RfKorrMode;

    /** Which rf_korr the derivation divides out. See LogFilterConfig.rfKorrSource. */
    rfKorrSource?: RfKorrSource;

    /**
     * Whether the back-calculated KF_RF_KORR_DRREL is being written into the binary — and therefore
     * whether the VE derivation must divide by it.
     *
     * The same flag drives both because they are one decision. `TuneSettings.writeRfKorr` is where
     * it is stored, alongside writeWarmup and writeWot.
     */
    writeRfKorr?: boolean;

    /** The back-calculated correction table. Required when `writeRfKorr` is set and ignored
     *  otherwise. Absent or not acceptable leaves the divisor out per cell — the caller is expected
     *  to have disabled the toggle, and a calculation is not where to raise that. */
    tunedRfKorr?: RfKorrTuneResult | null;
}

export class VECalculator {
    private rpmAxis: number[];
    private loadAxis: number[];

    constructor() {
        this.rpmAxis = APP_CONFIG.MSS54HP.AXIS_RPM;
        this.loadAxis = APP_CONFIG.MSS54HP.AXIS_LOAD;
    }

    /**
     * Calculates the new VE map based on multiple log files and the current VE map.
     * Logic:
     * 1. Aggregate STFT data from all logs into the grid using BILINEAR INTERPOLATION (Weighted).
     * 2. Calculate Weighted Average STFT for each cell.
     * 3. Apply correction: NewVE = OldVE * AvgSTFT
     */
    public calculateNewVEMap(
        currentMap: VEMap,
        logData: LogDataPoint[],
        options: VeCalcOptions = {}
    ): {
        newMap: VEMap | null; diffMap: number[][]; hitMap: number[][]; correctionMap: number[][];
        weightMap: number[][]; rfKorrMap: number[][]; rfKorrSpreadMap: number[][];
        tunedUsedMap: boolean[][]; acceptedMap: boolean[][]; realisedMap: number[][];
        demandMap: number[][];
        rejectMap: (VeReject | null)[][];
        coverage: { withEvidence: number; withAnyData: number; total: number };
    } {
        // Defaults to RF ÷ rf_soll — the route that needs no sensor. A caller that forgets to pass
        // options lands on the same arithmetic the app has always done.
        const plan = resolveRfKorr(options);
        // Writing the derived table and dividing by it are one decision: a VE map built for k_new
        // while the DME still applies k_old leaves the residual k_new/k_old, which reaches -27 % at
        // the stock peak (2200-2350 rpm) and goes LEAN. So this reads the WRITE flag, not a mode.
        //
        // The table still has to have been derived and passed its own evidence thresholds. Without
        // one it degrades per cell to "no divisor" rather than failing — the UI gates the toggle
        // separately, and a calculation is not where to raise that.
        const tuned = options.writeRfKorr && options.tunedRfKorr?.acceptable
            ? options.tunedRfKorr : null;

        const grid = this.createGrid();

        // 1. Binning / Aggregation (Weighted)
        for (const point of logData) this.accumulatePoint(grid, point, plan, tuned, options.normaliseTo);

        return this.finalizeGrid(currentMap, grid, options);
    }

    /**
     * An empty accumulation grid.
     *
     * Split out of `calculateNewVEMap` so a live log can hold one across samples instead of building
     * a new one every flush. The batch path builds it, fills it and discards it exactly as before —
     * the point of the split is that the three steps are now separately callable, not that any of
     * them changed.
     */
    public createGrid(): GridCell[][] {
        return Array(this.loadAxis.length)
            .fill(null)
            .map(() =>
                Array(this.rpmAxis.length)
                    .fill(null)
                    .map(() => ({
                        sumStftWeighted: 0, weightSum: 0, rawCount: 0,
                        sumRfKorrWeighted: 0, weightSumRfKorr: 0,
                        minRfKorr: Infinity, maxRfKorr: -Infinity,
                        sumTunedWeighted: 0, weightSumTuned: 0,
                        sumWeightSq: 0, sumStftSqWeighted: 0,
                        substantialCount: 0, lagPairs: 0, sumLagAB: 0, sumLagA: 0, sumLagB: 0,
                        sumLagA2: 0, sumLagB2: 0, prevVal: null, prevTime: null,
                        minCorrectionNear: Infinity, maxCorrectionNear: -Infinity,
                        minTunedNear: Infinity, maxTunedNear: -Infinity,
                    }))
            );
    }

    /**
     * One sample into the grid.
     *
     * Every accumulator in a cell is a SUM, which is what makes a live log able to add samples one
     * at a time and get the same answer as a batch pass over all of them. That is not a coincidence
     * to rely on quietly — `verify:incremental` asserts the two agree cell for cell on a real drive.
     *
     * `tuned` is the one input that is not per-sample: it comes from the rf_korr tuner, which reads
     * the whole log. A live caller must therefore either hold it fixed or rebuild the grid when it
     * changes; see IncrementalRun for which of those it does and why.
     */
    public accumulatePoint(
        grid: GridCell[][], point: LogDataPoint,
        plan: ReturnType<typeof resolveRfKorr>, tuned: RfKorrTuneResult | null,
        /** The BASE's own RF_PT_KORR curves, to state each sample at the air the table is
         *  defined for. Null/undefined = leave it as the day's air gave it. Threaded in rather than
         *  read from a field so the live and batch paths cannot disagree about it — see
         *  `verify:incremental`. */
        normaliseTo?: RfPtKorrCurves | null,
    ): void {
        {
            // Use Corrected Load if available, else Raw Load
            const loadVal = point.correctedLoad ?? point.rawLoad;
            const rpmVal = point.rpm;
            // Whichever banks are present, not a fixed pair. A single-bank log weighs its one
            // measurement once instead of averaging it with a copy of itself, and a sample with no
            // trim at all — an EGT run, or a blank row — is not evidence of anything and is
            // skipped. It used to arrive here as 1.0 and quietly vote for "this cell is perfect".
            const banks = [point.stft1, point.stft2].filter((v): v is number => v !== undefined);
            if (!banks.length) return;
            const avgStft = banks.reduce((a, b) => a + b, 0) / banks.length;

            // THE LONG-TERM FACTOR, and why it is here even though it is almost always 1.000.
            //
            // The DME applies `la_f_regler x laa_f` to every injection (slave 0x01B2D0). The short
            // -term pair above is the controller's live output; `laa_f` is the multiplicative store
            // it learns into during driven part load, and whatever a previous drive taught it
            // multiplies this sample too. The standing error is the product.
            //
            // On a log recorded against a PATCHED image it IS 1.000: the PATCH sets
            // `K_LAA_TMOT_MIN` to 100 degC against a MAX of 100 degC, which empties the window
            // `laa_st_calc` needs to enable either learner. So this term changes no number on a
            // neutral log — it is what makes the expression CORRECT on a log that is not, and
            // what makes this formula literally the same one the low-opening path uses.
            //
            // WHAT THE APP ACTUALLY HOLDS, because this comment used to claim more:
            // `trimNeutrality` holds the write on the `learned` verdict ALONE — the channel
            // positively showing the store off init. `unknown` holds NOTHING, and `unknown` is
            // what a log with no `ltft` at all reads as: the RAM route refused, the run fell back
            // to block 19, and the fallback below then substitutes 1.0. That substitution is the
            // assumption this term was added to remove, and on such a log it is back, unproven,
            // with only the TRIM STORE readout saying so. See page.tsx `storeLockReason`.
            //
            // Absent — an old CSV, or a run that fell back to block 19 — reads as 1.0, which
            // reproduces the previous behaviour exactly rather than refusing the sample.
            const ltftBanks = [point.ltft1, point.ltft2].filter((v): v is number => v !== undefined);
            const avgLtft = ltftBanks.length
                ? ltftBanks.reduce((a, b) => a + b, 0) / ltftBanks.length : 1;
            const trim = avgStft * avgLtft;

            // Find 4 bounding cells
            const rpmInfo = this.findBoundingIndices(rpmVal, this.rpmAxis);
            const loadInfo = this.findBoundingIndices(loadVal, this.loadAxis);

            if (!rpmInfo || !loadInfo) return;

            // The chosen route. Both annotated in the same pass by annotateRfKorr, so switching
            // between them re-derives from the same log without re-reading anything.
            //   'rf-ratio'    RF ÷ rf_soll        — what the DME applied, from its own output
            //   'table-delta' KF_RF_KORR_DRREL(rpm, Δ) at the sensor's Δ
            // A sample the chosen route cannot supply carries no correction rather than silently
            // borrowing the other one: the two disagree exactly where the disagreement matters
            // (a shut gate, a missing sensor), and substituting would hide that.
            const rfKorr = plan.source === 'table-delta' ? point.rfKorrFromEgt : point.rfKorr;

            // WHY rf_korr IS MULTIPLIED IN, and what state the table is therefore written for.
            //
            // The DME computes RF = kf_rf_soll x RF_PT_KORR x rf_korr, and the trim says the air
            // really taken, in RF units, was RF x trim. Next drive the same cell will produce
            // kf_rf_soll_new x RF_PT_KORR x rf_korr'. Equating the two and cancelling RF_PT_KORR:
            //
            //     kf_rf_soll_new = kf_rf_soll_old x trim x (rf_korr / rf_korr')
            //
            // So the ONLY question is which rf_korr' the table is written for, and each shipped
            // path is one answer: rf_korr' = rf_korr gives `trim` alone (the retired 'as-logged'),
            // rf_korr' = 1.000 gives this line, rf_korr' = k_new gives `tunedCorrection` below.
            // This line therefore declares a MODE — write the table for the state in which the
            // EGT correction is inactive — and not, as it was once justified, a fuel argument.
            //
            // The mode is the right one because the trim really does fight rf_korr, and the car
            // says so at the seam. `kl_rf_korr_rf_min` is a filling threshold and nothing else:
            // the engine does not change across it, only what the DME does to its own load
            // signal. So the real air-model error must be continuous there. Measured over
            // sessions #914/#917/#918/#919/#920 — 1,017 samples just below the gate against 426
            // just above, where the median rf_korr is 1.0891:
            //
            //     trim alone       steps  -5.65 %  across the gate
            //     trim x rf_korr   steps  +0.33 %
            //
            // and three placebo seams at 0.80, 0.65 and 0.50 of the gate margin — where the DME
            // applies 1.000 on BOTH sides — separate the two expressions by 1.05, 0.26 and
            // 0.02 %, so the step is the gate and not load dependence. See
            // `scripts/analyze-rf-korr-mode.mjs`, which also carries the failed alternative
            // (rf_korr as a genuine density correction the trim leaves alone) and the regression
            // that agrees: -0.712 +/- 0.152 against -1 predicted, 0 for the alternative.
            //
            // What it costs: on 16 cells written by both modes the two tables sit a median 2.8 %
            // apart, p95 12.2 %, worst 30.3 % (session #917, 100 % opening at 2200 rpm, where the
            // exhaust was coldest). The multiply is not a rounding detail at high load.
            const measured = (plan.apply && rfKorr !== undefined) ? trim * rfKorr : trim;

            // Stated at the air the table is defined for, per sample, before it is binned.
            //
            // The DME already scales the Alpha-N target by `RF_PT_KORR` on every segment, so the
            // trim was measured through that curve; what is left over is the part `KL_RF_TAN_KORR`
            // cannot express, because the real temperature sensitivity of VE varies with load and
            // one curve can only hold its average. `chargeTempFactor` recovers it from the DME's own
            // charge-temperature model. There is no pressure term: ambient cancels out of the
            // measurement exactly. See chargeTemp.ts.
            //
            // Per sample rather than per drive, because a drive heat-soaks — this log spans 38 to
            // 72 degC — and because `f` itself moves with load. A single factor for the whole run
            // would move the LEVEL and leave the SHAPE alone, which is the half that does not need
            // moving.
            //
            // DROPPED, not passed through at 1.0, when the sample cannot answer. Mixing an
            // un-normalised sample into the same cell as normalised ones is the exact failure this
            // is here to prevent, and the first samples of every run are in that state until the
            // slow lane has run once. `summariseChargeTemp` reports how many.
            let correction = measured;
            if (normaliseTo) {
                const factor = chargeTempFactor(point, normaliseTo);
                if (factor === undefined) return;
                correction = measured * factor;
            }

            // The 'tuned' correction: divide the nominal one by what the CORRECTED table would
            // have applied at this operating point. What survives is the trim as it would read
            // with the exhaust at nominal temperature — which is what the VE table should hold.
            //
            // Per sample rather than per cell, because Δ varies within a cell and the ratio does
            // not survive being averaged first. A sample the tuner could not place gets no tuned
            // value at all, so its cell simply carries less evidence for that path.
            // `plan.apply` gates this as well as the multiply above, and it has to: the tuned form
            // is `New = Old × STFT × rf_korr ÷ k_new` (docs/ecu-logic/60 §6.4). With `apply` false —
            // reachable through a legacy 'as-logged' session — `correction` is STFT alone, so
            // dividing gives `STFT ÷ k_new`, which is neither documented derivation and is lean by
            // the whole size of the correction. Half of a two-term identity is not a compromise
            // between them.
            let tunedCorrection: number | undefined;
            if (tuned && plan.apply && rfKorr !== undefined) {
                const kNew = this.tunedRfKorrAt(tuned, point);
                if (kNew !== undefined && kNew > 0) tunedCorrection = correction / kNew;
            }

            // Distribute to up to 4 neighbors
            this.distributeWeight(grid, this.loadAxis.length, this.rpmAxis.length, rpmInfo, loadInfo,
                correction, rfKorr, tunedCorrection, point.time);
        }
    }

    /**
     * The grid to the maps — O(cells), not O(samples).
     *
     * This is the half a live log runs on every flush. 480 cells is a fixed cost whatever the drive
     * has cost so far, which is the whole reason the split exists: the old arrangement paid for the
     * entire log again twice a second, so the sample rate fell as the run went on.
     */
    public finalizeGrid(
        currentMap: VEMap, grid: GridCell[][], options: VeCalcOptions = {},
    ): {
        newMap: VEMap | null; diffMap: number[][]; hitMap: number[][]; correctionMap: number[][];
        weightMap: number[][]; rfKorrMap: number[][]; rfKorrSpreadMap: number[][];
        tunedUsedMap: boolean[][]; acceptedMap: boolean[][]; realisedMap: number[][];
        demandMap: number[][];
        rejectMap: (VeReject | null)[][];
        coverage: { withEvidence: number; withAnyData: number; total: number };
    } {
        const rows = this.loadAxis.length;
        const cols = this.rpmAxis.length;
        const method: VeMethod = options.veMethod ?? VE_METHOD_DEFAULT;
        const statistical = method === 'statistical';
        // Clamped rather than trusted: this arrives from a stored config, and a negative or absurd
        // authority would invert or amplify a correction instead of damping it.
        const authority = Math.min(1, Math.max(0, options.directAuthority ?? DIRECT_AUTHORITY_DEFAULT));
        // Ten is the statistical method's floor, three is DIRECT's. Each is the smallest count its own
        // decision rule can stand on, which is why they are not the same number.
        const minSamples = options.minCellSamples ?? (statistical ? 10 : DIRECT_MIN_SAMPLES);
        // See VE_MIN_WEIGHT_DEFAULT for why this is a live bar again and why 2.5. A session that
        // stored its own value still replays with it, and 0 is a value: it still means "no bar".
        const minWeight = options.minCellWeight ?? VE_MIN_WEIGHT_DEFAULT;
        // Counted so the UI can say how much of the map this log actually earned. A threshold the
        // user cannot see the cost of is a threshold they cannot choose.
        let cellsWithEvidence = 0;
        let cellsWithSomeData = 0;

        // 2. Calculation
        const newMapData: number[][] = [];
        const diffMap: number[][] = [];
        const hitMap: number[][] = [];
        const correctionMap: number[][] = [];
        const weightMap: number[][] = [];
        const rfKorrMap: number[][] = [];
        const rfKorrSpreadMap: number[][] = [];
        const tunedUsedMap: boolean[][] = [];
        const demandMap: number[][] = [];
        /**
         * Which cells this gate accepted — the decision itself, not a number to re-test it from.
         *
         * The heatmap's middle band means "this cell was rewritten", and it used to paint that from
         * `hitMap >= minCellSamples`, which is only half the gate. A cell reaching 10 samples
         * typically carries a weight near 2.5 (one sample is split across four cells), so it fails
         * `minCellWeight` and is NOT rewritten — and was painted as though it had been. Colour and
         * calculation disagreeing is exactly what tying the band to the gate was meant to end, and
         * the colour is what gets looked at.
         */
        const acceptedMap: boolean[][] = [];
        /** Per cell, the gain the DME's own interpolation will actually deliver at the samples
         *  that earned it — `1 + selfShare * (correction - 1)`. See the push site. */
        const realisedMap: number[][] = [];
        /** Per cell, which gate refused it — null where it was written. See VeReject. */
        const rejectMap: (VeReject | null)[][] = [];

        /**
         * One cell's lag-1 covariance and variances, each about THAT CELL's own mean.
         *
         * Returned rather than reduced to a correlation so the row can pool them: the deviations
         * have to be taken per cell, and a pooled estimate that demeans across cells measures the
         * difference BETWEEN cells instead — which is real structure, not serial correlation, and
         * on a row whose cells sit at different corrections it drives rho straight to 1.
         */
        const lagMoments = (c: GridCell) => {
            const m = c.lagPairs;
            if (m < 1) return null;
            const ma = c.sumLagA / m, mb = c.sumLagB / m;
            return {
                m,
                cov: c.sumLagAB / m - ma * mb,
                va: Math.max(0, c.sumLagA2 / m - ma * ma),
                vb: Math.max(0, c.sumLagB2 / m - mb * mb),
            };
        };
        /** One cell's own estimate, or null when it has too few pairs, or no variance to correlate. */
        const rhoOf = (c: GridCell): number | null => {
            if (c.lagPairs < AUTOCORR_MIN_PAIRS) return null;
            const q = lagMoments(c);
            if (!q || !(q.va > 0) || !(q.vb > 0)) return null;
            return q.cov / Math.sqrt(q.va * q.vb);
        };
        /**
         * The same statistic over a whole row, pooled ACROSS cells but demeaned WITHIN each.
         *
         * Pair-count weighted, so a row is not swung by a cell holding four pairs. Null when the
         * row as a whole is too thin, which drops the cell to the measured constant.
         */
        const rhoOfRow = (row: GridCell[]): number | null => {
            let m = 0, cov = 0, va = 0, vb = 0;
            for (const c of row) {
                const q = lagMoments(c);
                if (!q) continue;
                m += q.m; cov += q.m * q.cov; va += q.m * q.va; vb += q.m * q.vb;
            }
            if (m < AUTOCORR_MIN_PAIRS || !(va > 0) || !(vb > 0)) return null;
            return (cov / m) / Math.sqrt((va / m) * (vb / m));
        };

        for (let r = 0; r < rows; r++) {
            const rowRho = rhoOfRow(grid[r]);
            const newRow: number[] = [];
            const diffRow: number[] = [];
            const hitRow: number[] = [];
            const correctionRow: number[] = [];
            const weightRow: number[] = [];
            const rfKorrRow: number[] = [];
            const rfKorrSpreadRow: number[] = [];
            const tunedUsedRow: boolean[] = [];
            const demandRow: number[] = [];
            const acceptedRow: boolean[] = [];
            const realisedRow: number[] = [];
            const rejectRow: (VeReject | null)[] = [];

            for (let c = 0; c < cols; c++) {
                const cell = grid[r][c];
                const oldVal = currentMap.data[r][c];

                // 1.0 / 0.0 mean "this cell was built from samples that carried no rf_korr" — the
                // same reading as "the correction was inactive", which is what the DME does when
                // the gate is shut. Callers that need to tell the two apart use rawCount.
                if (cell.weightSumRfKorr > 0) {
                    rfKorrRow.push(cell.sumRfKorrWeighted / cell.weightSumRfKorr);
                    rfKorrSpreadRow.push(cell.maxRfKorr - cell.minRfKorr);
                } else {
                    rfKorrRow.push(1.0);
                    rfKorrSpreadRow.push(0);
                }

                // The evidence gate. Both conditions — see VeCalcOptions.minCellSamples for why,
                // and for what this replaced.
                //
                // Below the seam it does not get as far as the gate. `kf_rf_soll` is ONE table and
                // its bottom thirteen rows belong to LOW LOAD, for three reasons in order of
                // weight:
                //
                //   1. THE MEASURAND DEGENERATES. The correction is `Old x trim x rf_korr`
                //      with `trim = stft x ltft`, and it assumes the whole fuel-path error shows
                //      in that product. In this band it need not: at a stationary idle the DME
                //      ADDITIVE store (`LAA_OFFSET`, learner slave 0x019F80) absorbs the error,
                //      and neither `stft` nor `ltft` — which is the MULTIPLICATIVE store — carries
                //      it. The correction then returns "no change" precisely where the map is most
                //      wrong. The PATCH is what stops it, by emptying the learn window
                //      (`K_LAA_TMOT_MIN` = `K_LAA_TMOT_MAX` = 100 degC).
                //
                //      `trimNeutrality` REPORTS the store; it holds the write on `learned` only.
                //      A log with no `ltft` reads `unknown` and is not held. So THIS refusal — the
                //      band boundary below — is what keeps the degenerate measurand out of the
                //      correction, and it is not a second line of defence behind that one.
                //
                //      NOTE: the seam is NOT a formula boundary. LOW LOAD uses this same
                //      expression — `lowLoadTuner.ts` forms `q = trim x rf_korr` from the same two
                //      trims. What differs is reasons 2 and 3 below.
                //   2. THE EVIDENCE BAR IS SHAPED FOR SWEEPS. Ten samples is 2.2 s at 4.5 Hz; an
                //      idle parks on ONE cell for minutes and would pass instantly with samples
                //      that are the same limit cycle re-read. LOW LOAD's bar (30 samples across
                //      >=2 separate visits) is shaped for a dwell.
                //   3. OWNERSHIP MUST BE EXCLUSIVE. It used to be settled only at composition, in
                //      `composeVeGrid`, and that left a hole: where LOW LOAD refused a cell for
                //      thin evidence, `owned` came out false and VE's value — derived from the
                //      degenerate measurand above — was what reached the binary. Refusing here
                //      closes it, because a cell VE never accepts keeps the BASE value instead.
                //
                // The samples are still accumulated, so the coverage heat still shows the band was
                // driven; they are simply not evidence VE may act on. Counted out of the coverage
                // totals below for the same reason — "8 of 480" would be measuring VE against 260
                // cells it is not allowed to write.
                //
                //   4. THE EVIDENCE MUST BE ABOUT THIS CELL. A sample lands on four cells at
                //      once, so `weightSum` alone can be cleared by evidence that was mostly
                //      about the neighbours — and since a refused neighbour keeps BASE, that
                //      neighbour's error gets written here. See MIN_SELF_SHARE.
                const veOwnsRow = r > LOW_LOAD_TOP_ROW;
                if (cell.rawCount > 0 && veOwnsRow) cellsWithSomeData++;
                const selfShare = cell.weightSum > 0 ? cell.sumWeightSq / cell.weightSum : 0;

                //   5. THE MEAN MUST BE PINNED, AND THE SAMPLES MUST BE ONE CONDITION.
                //
                // `la_f_regler` is a two-point controller, so every cell's samples span its limit
                // cycle whatever the mixture is doing — measured sd 0.034 on session #920. Two
                // separate questions follow, and this path used to ask neither:
                //
                //   scatter  is this cell one condition, or two populations averaged together?
                //   precision is the MEAN determined finely enough to be worth writing?
                //
                // Both bounds are the low-opening path's, imported rather than copied: they are
                // facts about this car's trim and this table's quantisation, not about a band.
                // See MAX_SAMPLE_SD / MAX_STD_ERR. The effective sample count for the standard
                // error is Kish's `(Sum w)^2 / Sum w^2` — which is `weightSum / selfShare`, so the
                // statistic the previous gate already needed pays for this one too. A cell fed by
                // grazing samples is correctly treated as holding fewer of them than it counted.
                const wMean = cell.weightSum > 0 ? cell.sumStftWeighted / cell.weightSum : 0;
                const wVar = cell.weightSum > 0
                    ? Math.max(0, cell.sumStftSqWeighted / cell.weightSum - wMean * wMean) : 0;
                const wSd = Math.sqrt(wVar);
                const nEff = selfShare > 0 ? cell.weightSum / selfShare : 0;

                //   6. THE SAMPLES ARE NOT INDEPENDENT, AND EVERY COUNT ABOVE ASSUMED THEY WERE.
                //
                // `la_f_regler` is a two-point controller oscillating at 1-2 Hz against a 4-5 Hz
                // log, so consecutive samples are points on ONE swing. Kish's `nEff` corrects for
                // unequal weights and nothing else. For an AR(1) series the variance of the mean
                // is inflated by (1 + rho) / (1 - rho), so the honest count is
                //
                //     nIndep = nEff * (1 - rho) / (1 + rho)
                //
                // Measured on this car, rho is about 0.85 — so a cell carries roughly a TWELFTH of
                // the independent evidence its sample count claims. See AUTOCORR_FALLBACK for the
                // measurement and for why the fallback is the per-cell median.
                //
                // Preferring the cell's OWN rho matters: it varies p05 0.49 to p95 0.95 across
                // cells, and a cell traversed quickly genuinely holds more independent information
                // per sample than one parked at a traffic light.
                // Cell first, then its ROW, then the constant.
                //
                // rho is not uniform across the table and the constant cannot be right for all of
                // it: measured over six drives the low band (5-15 % opening) sits at 0.756 and the
                // high band (45-100 %) at 0.923. The direction is the opposite of what a fallback
                // was first justified by — a cell traversed quickly was assumed LESS correlated,
                // and a sustained pull is in fact MORE, because it parks in the cell for longer.
                //
                // The row is the pooling unit because that is the axis rho actually varies along:
                // it tracks dwell, and dwell tracks opening. Pooling by row needs no arbitrary band
                // boundary and degrades to the constant only where a whole row is thin.
                const rho = Math.min(AUTOCORR_RHO_MAX, Math.max(0,
                    rhoOf(cell) ?? rowRho ?? AUTOCORR_FALLBACK));

                // The EXACT inflation for this cell's own run length, not the asymptotic form.
                // `runs` is how many separate stretches of consecutive samples the cell holds; a
                // run of L contributes L-1 pairs, so the two counters give L for nothing.
                const runs = Math.max(1, cell.substantialCount - cell.lagPairs);
                const runLen = cell.substantialCount > 0 ? cell.substantialCount / runs : 1;
                const nIndep = nEff / autocorrInflation(rho, runLen);

                // The naive standard error — `wSd / sqrt(nEff)` — is NOT computed here any more.
                // It was what the old gate tested, it is wrong by a factor of about 3.2 on this
                // car, and keeping it beside the honest one only invites reaching for it.
                // `analyze:cell-gates` derives both from the grid when the two need comparing.

                // FLOORED AT HALF A TABLE STEP, and the floor is doing real work.
                //
                // `kf_rf_soll` stores raw/1000, so one writable step is `0.001 / oldVal` as a
                // fraction — 0.17 % on a 0.6 cell. Claiming to know the mean more finely than that
                // is claiming precision the table cannot express, and the significance test would
                // then be weighing a correction against an uncertainty smaller than the rounding it
                // is about to suffer.
                //
                // It also settles the degenerate case honestly. A cell whose samples all read the
                // same value has an observed scatter of exactly zero — which a quantised channel in
                // a steady state really does produce — and without a floor that is a t of 0/0,
                // which would refuse a perfectly determined cell as "not significant". The floor
                // says what is true: we know it to within one writable step and no better.
                const lsbFraction = oldVal > 0 ? 0.001 / oldVal : 0;
                const sigma = Math.max(
                    lsbFraction / 2,
                    nIndep > 0 ? wSd / Math.sqrt(nIndep) : Infinity,
                );

                //   7. IS THE CORRECTION BIGGER THAN OUR UNCERTAINTY ABOUT IT?
                //
                // Writing a cell removes |c - 1| of bias and injects `sigma` of noise, so the
                // question is a RATIO, not an absolute bound. That is a t statistic, and using the
                // Student critical value rather than a fixed 2 makes a thin cell demand a
                // proportionally larger correction instead of needing an arbitrary sample floor.
                //
                // dof is nIndep - 1, which is conservative: the scatter itself is estimated from
                // all the samples, so it has more degrees of freedom than the mean does. Charging
                // the mean's dof to both is the safe direction.
                const nominalMean = cell.weightSum > 0 ? cell.sumStftWeighted / cell.weightSum : 1;
                const tCrit = tCritical95(nIndep - 1);
                const tStat = sigma > 0 && Number.isFinite(sigma)
                    ? Math.abs(nominalMean - 1) / sigma : 0;

                // Tested in the order a reader would act on them: "you were never here" before
                // "you were not here long enough" before "the samples disagree".
                //
                // TWO TIERS, and which tier a refusal sits in is the whole of the method switch.
                //
                // STRUCTURAL refusals are about whether there is anything to compute at all. They
                // are not statistics and they run under both methods: a cell in the low-opening
                // band is not this path's to write, and a cell nothing landed in has nothing to say.
                //
                // STATISTICAL refusals are about whether ONE drive can carry the cell alone. They
                // run only under the statistical method, because under DIRECT that question is
                // answered by the next drive rather than by refusing this one. See VeMethod.
                const structural: VeReject | null = !veOwnsRow ? 'out-of-band'
                    : cell.rawCount === 0 ? 'no-evidence'
                        // SAMPLES COUNTS SAMPLES THAT WERE IN THE CELL, not ones that grazed it.
                        //
                        // `rawCount` is incremented by `distributeWeight` for every corner it
                        // touches at any weight above zero, so one sample lands on up to four
                        // cells and a cell can reach the threshold on evidence that belongs to
                        // its neighbours. Measured on #933: 236 cells cleared `rawCount >= 3` and
                        // 27 of them held not one sample at `w >= CLAMP_MIN_WEIGHT`. The worst,
                        // 0.2 % / 2100 rpm, counted 234 of them.
                        //
                        // That is also why the anti-ratchet clamp below was silently inoperative
                        // on exactly those cells: its bounds are written by the same
                        // `w >= CLAMP_MIN_WEIGHT` samples, so with none of them `lo`/`hi` stay at
                        // +/-Infinity, `lo <= hi` is false, and the cell is written with no bound
                        // at all. One counter said "enough evidence" while the other said "nothing
                        // to bound with", and that disagreement WAS the defect.
                        //
                        // Counting one population for both closes it: a cell is written only on
                        // samples substantially inside it, and any cell clearing that has, by
                        // construction, the samples the clamp needs. 236 -> 181 cells on #933.
                        : cell.substantialCount < minSamples ? 'thin-count'
                            : cell.weightSum < minWeight ? 'thin-weight'
                                : null;
                const reject: VeReject | null = structural ?? (!statistical ? null
                    : selfShare < MIN_SELF_SHARE ? 'shared-evidence'
                        : wSd > MAX_SAMPLE_SD ? 'scatter'
                            : nIndep < MIN_INDEPENDENT ? 'thin-independent'
                                : tStat <= tCrit ? 'not-significant'
                                    : null);
                const accepted = reject === null;
                acceptedRow.push(accepted);
                rejectRow.push(reject);

                // THE DEMAND, computed for every cell that has any evidence — not only the written
                // ones.
                //
                // This used to live inside the accept branch, which made two true things
                // unreportable: what a refused cell asked for, and which divisor it would have
                // used. Both are exactly what an operator needs in order to decide whether to go
                // and drive it again, and both are now on `demandMap` / `tunedUsedMap` whatever the
                // verdict was. It also separates the two questions the write answers — what the
                // evidence asked for, and how much of that the evidence supports — which the
                // shrinkage below would otherwise blur into one number.
                const nominal = cell.weightSum > 0 ? cell.sumStftWeighted / cell.weightSum : 1;

                // Take the tuned correction only if it stays close to the one that would have
                // been used anyway. Thin evidence behind k_new shows up here as a large
                // divergence, and a cell that diverges takes the nominal value and says so.
                let demand = nominal;
                let usedTuned = false;
                // `weightSumTuned` accumulates at ANY weight, while `minTunedNear`/`maxTunedNear`
                // are written only by samples at `w >= CLAMP_MIN_WEIGHT` — so this condition alone
                // could take the tuned branch on a cell whose tuned values all came from grazes,
                // and then `lo <= hi` below is `+Infinity <= -Infinity`, false, and the cell is
                // written with NO anti-ratchet bound. The nominal bounds that do exist sit
                // unconsulted, because the clamp reads whichever quantity was averaged.
                //
                // Reproduced through the real accumulatePoint/finalizeGrid: four samples inside a
                // cell at w 0.75 demanding +10 % with no tuned value, plus two grazing samples at
                // w 0.075 carrying a tuned 1.20, wrote +20.0 % — past everything its own samples
                // asked for. So the branch now requires the bounds it will be clamped against.
                const tunedBounded = cell.minTunedNear <= cell.maxTunedNear;
                if (cell.weightSumTuned > 0.1 && tunedBounded) {
                    const candidate = cell.sumTunedWeighted / cell.weightSumTuned;
                    if (nominal > 0 && Math.abs(candidate / nominal - 1) <= TUNED_VS_NOMINAL_MAX) {
                        demand = candidate;
                        usedTuned = true;
                    }
                }
                tunedUsedRow.push(usedTuned);
                demandRow.push(demand);

                if (accepted) {
                    cellsWithEvidence++;
                    let avgCorrection = demand;

                    // Bound to what samples INSIDE this cell actually demanded.
                    //
                    // This is the anti-ratchet. The write realises less than it demands: scaling
                    // one cell by `x` moves the DME's interpolated lookup at a nearby sample by
                    // only that cell's share of `x`, so a flash-and-relog cycle sees the remainder,
                    // asks for it again, and walks the cell past every correction ever observed
                    // here. With a mean demand of 1.08 at a typical 0.43 self-share the fixed point
                    // of that loop is about 1.19 — a cell 19 % away from unwritten neighbours, in a
                    // table that indexes ignition and the torque model.
                    //
                    // THE CLAMP MAY ONLY MOVE THE CORRECTION TOWARD 1.000, AND NEVER ACROSS IT.
                    //
                    // The mean and the bounds are taken over DIFFERENT populations. `demand` is the
                    // weighted mean of every sample whose bracket touched this cell; the bounds are
                    // the extremes of the ones that landed substantially inside it, `w >=
                    // CLAMP_MIN_WEIGHT`. So the mean does NOT necessarily sit inside the range, and
                    // a bare `min(hi, max(lo, .))` then moves the write onto a bound that can be
                    // FURTHER from 1.000 than the demand, or on the far side of it. Across sessions
                    // #924, #925 and #926 that clamp fired on 15 written cells and moved 8 of them
                    // the wrong way — 7.5 % at 2700 rpm went from a demanded +0.69 % to a written
                    // -2.52 %, reversing the sign of a cell that 39 samples had agreed on.
                    //
                    // AND THE BOUND IS USUALLY ONE OR TWO SAMPLES. `substantialCount` on those five
                    // #926 cells reads 2, 1, 1, 1, 2 — on the three where it is 1, `lo` and `hi` are
                    // the same number, so pushing the demand onto it writes that single sample.
                    // That is a max-of-a-subset estimator standing in for a mean, which is not the
                    // job the ratchet argument gave this clamp.
                    //
                    // Restricting it to the damping direction keeps the whole of the anti-ratchet:
                    // a re-derivation trying to go further than the evidence went is still cut back
                    // to the evidence. What it gives up is the amplification, which the ratchet
                    // argument never asked for.
                    //
                    // When the two populations disagree about the SIGN, neither number is written.
                    // The cell's own samples and its bracket's mean are pointing opposite ways, and
                    // the honest answer to that is to leave the cell alone; `demandMap` still
                    // reports what was asked for, so the disagreement stays visible.
                    // Bounds from whichever quantity was actually averaged — see minTunedNear.
                    const lo = usedTuned ? cell.minTunedNear : cell.minCorrectionNear;
                    const hi = usedTuned ? cell.maxTunedNear : cell.maxCorrectionNear;
                    if (lo <= hi) {
                        const bounded = Math.min(hi, Math.max(lo, avgCorrection));
                        if ((bounded - 1) * (avgCorrection - 1) < 0) avgCorrection = 1;
                        else if (Math.abs(bounded - 1) < Math.abs(avgCorrection - 1)) avgCorrection = bounded;
                    }

                    // Last line of defence, both paths. Nothing before the divide could reach it.
                    avgCorrection = Math.min(CORRECTION_MAX, Math.max(CORRECTION_MIN, avgCorrection));

                    // THE GAIN, and it is the second half of the method switch.
                    //
                    // Applied AFTER the anti-ratchet clamp in both methods, so what it scales is a
                    // demand already bounded by what samples inside this cell asked for.
                    //
                    // Statistical: shrinkage, so clearing the bar is not a cliff — a cell that
                    // clears it by a hair moves by a hair. It HAS to be continuous, because that
                    // method writes AT a threshold and a threshold with a step at it is arbitrary.
                    //
                    // DIRECT: a flat authority. Nothing here needs to taper, because nothing here sits
                    // at a boundary — a cell either had enough samples to mean something or it was
                    // refused structurally above. The taper that matters under DIRECT is across
                    // PASSES, not across cells, and the loop provides it.
                    const gain = statistical
                        ? (tStat > tCrit ? Math.max(0, 1 - (tCrit / tStat) ** 2) : 0)
                        : authority;
                    avgCorrection = 1 + gain * (avgCorrection - 1);

                    // Formula: New = Old * Correction
                    const newVal = oldVal * avgCorrection;

                    newRow.push(newVal);
                    // What the CAR will do, as opposed to what was asked for. The demanded factor
                    // reaches the DME's lookup attenuated by this cell's share of each sample's
                    // bracket, and an operator re-logging after a flash needs to expect the smaller
                    // number — otherwise the shortfall reads as "the tune did not take".
                    realisedRow.push(1 + selfShare * (avgCorrection - 1));
                    // Ratio % = (New / Old) * 100
                    // This is equivalent to Correction Factor * 100
                    diffRow.push(avgCorrection * 100);

                    // HitMap shows RAW Counts (matching MLV "Cell Hit Count")
                    hitRow.push(cell.rawCount);

                    // Correction itself (Lambda Deviation)
                    correctionRow.push(avgCorrection);

                    // Weight Sum (Cell Weight)
                    weightRow.push(cell.weightSum);
                } else {
                    newRow.push(oldVal); // No change
                    diffRow.push(100); // Ratio % (No change = 100%)
                    // The REAL count and weight, not zero. Before the gate existed these could only
                    // be reached with no samples at all, so zero was the truth; now a cell can hold
                    // nine samples and still be refused, and reporting that as 0 would erase the one
                    // signal that says "drive here again" rather than "you have never been here".
                    hitRow.push(cell.rawCount);
                    // WHAT IT MEASURED, not what it wrote.
                    //
                    // This pushed a flat 1.000, which made a refused cell indistinguishable on the
                    // LAMBDA FEEDBACK view from one measured at exactly no correction — and those
                    // are opposite facts. The gate decides what is WRITTEN; it was never a reason to
                    // discard the reading. A cell holding four samples at 0.91 is telling you the
                    // mixture there is 9 % rich, and that is worth seeing from the driver's seat
                    // while the colour beside it says how much evidence stands behind it.
                    //
                    // Display only: `acceptedMap` still says which cells were rewritten, the
                    // heatmap bands still come from that, and `newMap` is untouched. Clamped to the
                    // same catastrophe bounds the write path uses, so one wild cell cannot flatten
                    // the colour scale for every other cell on the map.
                    correctionRow.push(Math.min(CORRECTION_MAX, Math.max(CORRECTION_MIN, demand)));
                    weightRow.push(cell.weightSum);
                    // Realised stays 1.000, and that is not the same decision: nothing was written,
                    // so nothing reaches the car. This one really is "no change".
                    realisedRow.push(1.0);
                }
            }
            newMapData.push(newRow);
            diffMap.push(diffRow);
            hitMap.push(hitRow);
            correctionMap.push(correctionRow);
            weightMap.push(weightRow);
            rfKorrMap.push(rfKorrRow);
            rfKorrSpreadMap.push(rfKorrSpreadRow);
            tunedUsedMap.push(tunedUsedRow);
            demandMap.push(demandRow);
            acceptedMap.push(acceptedRow);
            realisedMap.push(realisedRow);
            rejectMap.push(rejectRow);
        }

        return {
            /**
             * Null when NOTHING cleared the gate — because then this is not a tune.
             *
             * Every refused cell keeps `oldVal`, so a log with no qualifying cell produces a map
             * that is byte-identical to the BASE. Returned as an object it was indistinguishable
             * from a real result: the app offered SAVE and WRITE, `Boolean(newMap)` recorded
             * `tuned: true`, and a flash slot went on writing the BASE back to the car under a
             * TUNED name. Session #903 — an EGT run, which carries no lambda trim at all and so can
             * never bin a single sample — did exactly that.
             *
             * The other maps stay populated on purpose. `hitMap` still holds the real counts, so
             * "you drove here but not enough" survives; it is only the ARTEFACT that is withheld.
             */
            newMap: cellsWithEvidence > 0 ? {
                xAxis: [...currentMap.xAxis], // Preserve axes
                yAxis: [...currentMap.yAxis],
                data: newMapData,
            } : null,
            diffMap,
            hitMap, // Returns Integer Hits
            correctionMap,
            weightMap, // Returns Weight Sum
            tunedUsedMap, // Which cells actually took the 'tuned' correction
            acceptedMap,  // Which cells cleared the gate, i.e. which ones were rewritten
            realisedMap,  // What the car will do, after interpolation attenuates the write
            // What each cell ASKED for, before the significance shrinkage damped it. Equal to
            // `correctionMap` on a cell the evidence fully supports, larger on a marginal one, and
            // defined even where the cell was refused — which is the case the operator needs.
            demandMap,
            rejectMap,    // Which gate refused each cell, so the map can say so per cell
            rfKorrMap, // Weighted-mean rf_korr the cell's samples were taken under
            rfKorrSpreadMap, // max-min rf_korr across those samples
            /** How many cells cleared the evidence gate, out of how many the log touched at all and
             *  how many exist. The three numbers together are what makes a threshold adjustable:
             *  raising it is only a decision you can make if you can see what it costs. */
            // `total` is VE's OWN band, not the whole table — the rows above the LOW LOAD seam.
            // The line this feeds reads "N of TOTAL cells met the evidence gate", and measuring
            // that against 480 would count 260 cells VE is not allowed to write as cells it failed
            // to earn. LOW LOAD reports its own band in its own census.
            coverage: {
                withEvidence: cellsWithEvidence,
                withAnyData: cellsWithSomeData,
                total: Math.max(0, rows - (LOW_LOAD_TOP_ROW + 1)) * cols,
            }
        };
    }

    /**
     * Measures rf_korr, the EGT density correction the DME applied, for every sample that carries
     * an RF reading, and returns a copy of the log with `rfKorr` filled in.
     *
     * With MAP compensation off (k_rf_cfg = 0x02, which is what this app's PATCH writes) the DME's
     * load path is exactly RF = (rf_soll * rf_korr) >> 10, where rf_soll is the Alpha-N lookup.
     * So dividing the DME's own RF by our interpolation of the same table recovers the multiplier
     * directly — no need to model TABG or read KF_RF_KORR_DRREL.
     *
     * `rf_soll * rf_korr` is what the DME computes either way — MAP compensation only ADDS
     * rf_p_saug_i on top of it. So the ratio is still rf_korr plus a bounded error, not a
     * different quantity: rf_p_saug_i is clamped to ±2.5 %RF (k_rf_p_saug_i_min/max @0xE5EE/F0),
     * and rf_korr only engages above 55–80 %RF, so the worst case is ~±4 % on a signal that runs
     * to +37 %. Measuring it anyway beats discarding it — not correcting at all is the larger
     * error, and it is the one that goes lean.
     *
     * (Tuning with MAP compensation still on is its own problem — it hides VE error from the
     * trim — but that invalidates the whole run, not this measurement.)
     *
     * `egt` is optional and additive. Given the DME's own tables it also fills the cross-check
     * pair — see LogDataPoint.egtFromRfKorr / rfKorrFromEgt — which is the same rf_korr reached
     * by karter16's TABG route, so the two can be laid side by side. Without it this behaves
     * exactly as it did before the tables existed, which is what every no-binary path relies on.
     */
    /**
     * What the CORRECTED table will apply at this sample's operating point, once flashed.
     *
     * Reads the tuned grid on its own axes, with the same clamped-bilinear rule the DME uses, so
     * the number divided out here is the number the DME will multiply back in.
     *
     * **The gate is half of that promise, and it used to be missing.** The DME reads
     * KF_RF_KORR_DRREL only when `rf_soll > kl_rf_korr_rf_min(N)`; below the floor it applies
     * 1.000 no matter how cold the exhaust is (docs/ecu-logic/20-egt-correction.md §1). Looking the
     * table up on Δ alone therefore divided gate-shut samples by a correction that was never
     * applied and never will be — and since the table's floor is 1.000 and Δ is clipped at 0, the
     * residual `1/k_new` could only ever go one way: LEAN.
     *
     * Measured on session #904: 12.3 % of samples had the gate open, but 39.9 % were gate-shut with
     * a divisor above 1 (median 1.023, p99 1.208, max 1.242), each pushing its cell 2-20 % lean.
     * `TUNED_VS_NOMINAL_MAX` bounded a whole cell to 15 %, which is a backstop and not a defence.
     *
     * Every other consumer of rf_korr in this file already reproduces the gate — the measured route
     * gets it for free (`rf` really does equal `rf_soll` when the correction is off) and the
     * table-delta route codes it explicitly in `annotateRfKorrPoint`. So did the tuner's own input
     * pass, which drops gate-shut samples with a comment about the lean direction. This was the one
     * place that did not.
     *
     * Returns undefined when the sample has no Δ — nothing can be said about it, and the cell just
     * carries less evidence for the tuned path.
     */
    private tunedRfKorrAt(tuned: RfKorrTuneResult, point: LogDataPoint): number | undefined {
        if (point.tabgDelta === undefined) return undefined;
        // Both fields are written together in annotateRfKorrPoint, so an undefined verdict beside a
        // defined Δ should not be reachable. Refuse rather than assume: guessing "open" is the
        // direction that leans the map out.
        if (point.rfKorrGateOpen === undefined) return undefined;
        // Shut: the DME will apply 1.000 here, so the cell must keep the whole trim-corrected
        // filling. Dividing by 1 is the honest no-op, not an absence of evidence — the sample says
        // something definite about this cell and should carry its weight.
        if (!point.rfKorrGateOpen) return 1.0;
        return interpMap2d(tuned.rpm, tuned.delta, tuned.tuned, point.rpm, point.tabgDelta);
    }

    public annotateRfKorr(
        currentMap: VEMap, logData: LogDataPoint[], egt?: EgtTables | null,
        air?: RfKorrAirInput,
    ): LogDataPoint[] {
        return logData.map(point => this.annotateRfKorrPoint(currentMap, point, egt, air));
    }

    /** One sample's worth of the above. Split out so a live run can annotate the samples that
     *  arrived rather than the whole drive again; the batch call is this in a `.map`, so the two
     *  cannot produce different numbers. */
    public annotateRfKorrPoint(
        currentMap: VEMap, point: LogDataPoint, egt?: EgtTables | null,
        air?: RfKorrAirInput,
    ): LogDataPoint {
        {
            if (point.rf === undefined) return point;

            const loadVal = point.correctedLoad ?? point.rawLoad;
            const rfSollTable = this.interpolateMap(currentMap, point.rpm, loadVal);
            // rfSoll is dimensionless (the table stores raw/1000, 1.0 = 100% fill); the DS2 RF
            // channel is a percentage. A zero or negative lookup means the operating point sits
            // outside anything the table describes, and a ratio there would be noise.
            if (!(rfSollTable > 0)) return point;

            // **The DME's rf_soll is the table TIMES RF_PT_KORR**, and for a long time this line
            // used the table alone.
            //
            // `rf_soll_calc` (master 0x01A9D2) ends with `rf_soll = (filtered * RF_PT_KORR) >> 12`,
            // so `RF / kf_rf_soll` is not rf_korr — it is `RF_PT_KORR * rf_korr`, with the day's
            // ambient pressure and intake temperature inside it. The correction the app writes is
            // `avgStft * rfKorr`, and the trim in front of it already carries `1 / RF_PT_KORR`; the
            // multiply cancelled the DME's own density compensation and left the RAW air of the
            // measurement day sitting in the table.
            //
            // Measured on this car: within one drive, VE cell held fixed, `d ln(correction)/d ln(P)`
            // = +1.10 ± 0.16 against +0.07 ± 0.06 for the trim alone. Two drives ten hours apart at
            // 969 and 994 mbar produced maps 2.9 % apart; two campaigns at 888 and 993 mbar, 12.9 %.
            // On samples where the DME's own gate is SHUT — where rf_korr is 1.0000 by construction
            // — the measured value read 0.90, 0.89, 0.99 and 1.015 on four drives, and 0.9957 /
            // 0.9952 once divided by RF_PT_KORR. Inverting the pressure curve on those samples
            // recovers the logged barometer to within 1 %.
            //
            // Multiplied into rfSoll rather than divided out of the ratio, because `gateOpen` below
            // reproduces `rf_korr_calc`'s `kl_rf_korr_rf_min < rf_soll` test and the DME compares
            // against ITS rf_soll. Both were wrong by the same factor; one line fixes both.
            const ptKorr = rfPtKorrFor(point, air?.curves ?? null, air?.assumedPressureMbar);
            // No air data, no rf_korr. Returning the contaminated ratio is what caused this, and
            // substituting 1.0 would be the same thing under a different name. Without it the
            // calculator falls back to the trim alone, which measurement shows is already
            // pressure-free (+0.07) — the honest answer for a log recorded before the channels
            // existed.
            if (ptKorr === undefined) return point;
            const rfSoll = rfSollTable * ptKorr;

            // `+ RF_TRUNCATION_MEAN_PERCENT`: the DME threw away two remainders on the way to
            // this number, and the ratio is against the exact arithmetic. See the constant.
            const rfKorr = ((point.rf + RF_TRUNCATION_MEAN_PERCENT) / 100) / rfSoll;
            const out: LogDataPoint = { ...point, rfKorr, rfSoll };
            if (!egt) return out;

            // The nominal exhaust temperature BMW measured for this operating point. Both derived
            // columns hang off it, and the DME's own Y axis for this table is the final RF — which
            // is the channel we logged, not rf_soll.
            const model = tabgModelAt(egt, point.rpm, point.rf / 100);

            // (a) rf_korr -> EGT. Sparse: refuses wherever the profile cannot be inverted honestly.
            //     The sensor's own delta is passed as a hint so the two non-monotone rpm bands
            //     (1600 / 1900) can still answer when there is a sensor to break the tie — that is
            //     not circular, because the hint only PICKS among exact roots of the measured k.
            // The DME's own Y-axis input. Computed once, here, so nothing downstream can arrive at
            // a different Δ for the same sample.
            const hint = point.exhaustTemp === undefined
                ? undefined : Math.max(0, model - point.exhaustTemp);
            if (hint !== undefined) out.tabgDelta = hint;
            const deltaInv = invertRfKorrProfile(
                rfKorrProfileAt(egt, point.rpm), egt.rfKorr.delta, rfKorr,
                { ...EGT_INVERSION_DEFAULTS, hint },
            );
            if (deltaInv !== undefined) out.egtFromRfKorr = model - deltaInv;

            // (b) EGT -> rf_korr. Reproduces the gate rather than ignoring it: below the filling
            //     floor the DME applies 1.000 regardless of how cold the exhaust is, so 1.000 is
            //     the right answer there and matching `rfKorr` is a clean pass on both offsets.
            //
            // The verdict is kept on the sample as well as consumed here. `tunedRfKorrAt` needs it
            // and cannot recover it from the number: 1.000 means "shut" or "open with Δ ≤ 30", and
            // those two want opposite treatment. Evaluated once, in the one place that already
            // knows this sample's rf_soll — the same rule tabgDelta follows two lines up.
            if (hint !== undefined) {
                const open = gateOpen(egt, point.rpm, rfSoll);
                out.rfKorrGateOpen = open;
                out.rfKorrFromEgt = open ? rfKorrAt(egt, point.rpm, hint) : 1.0;
            }

            return out;
        }
    }

    /**
     * Where this sample sits on the axis, in the two-weights shape `distributeWeight` wants.
     *
     * The bracketing itself is `axisBracket` — the same function the rf_korr tuner bins with, so a
     * sample lands in the same cell in both, which is what lets the tuner's anchors and the VE grid
     * be talked about as one thing. It used to be a private copy that differed from the tuner's on
     * NaN: outside the axis this clamped, but a NaN failed every comparison and fell out as `null`,
     * while the tuner's version put the same sample at index 0. See axisBracket.
     *
     * Still returns null, and that is still the "cannot bin this" answer the caller checks — it just
     * now means only what it says.
     */
    private findBoundingIndices(value: number, axis: number[]): { idx1: number; idx2: number; w1: number; w2: number } | null {
        const b = axisBracket(axis, value);
        if (!b) return null;
        return { idx1: b.i0, idx2: b.i1, w1: 1 - b.w1, w2: b.w1 };
    }

    private distributeWeight(
        grid: GridCell[][],
        rows: number,
        cols: number,
        rpm: { idx1: number; idx2: number; w1: number; w2: number },
        load: { idx1: number; idx2: number; w1: number; w2: number },
        val: number,
        rfKorr?: number,
        tunedVal?: number,
        time?: number
    ) {
        // 4 corners:
        // (r1, c1) weight: load.w1 * rpm.w1
        // (r1, c2) weight: load.w1 * rpm.w2
        // (r2, c1) weight: load.w2 * rpm.w1
        // (r2, c2) weight: load.w2 * rpm.w2

        const add = (r: number, c: number, w: number) => {
            if (r >= 0 && r < rows && c >= 0 && c < cols && w > 0) {
                const cell = grid[r][c];
                cell.sumStftWeighted += val * w; // Accumulate Weighted Value
                cell.weightSum += w;             // Accumulate Weight
                cell.rawCount++;                 // Increment Raw Count (Integer)
                // Both of D1's statistics, and both are SUMS/extrema, so the live path stays
                // incremental and `verify:incremental` still holds cell for cell.
                cell.sumWeightSq += w * w;
                cell.sumStftSqWeighted += val * val * w;
                if (w >= CLAMP_MIN_WEIGHT) {
                    cell.substantialCount++;
                    if (val < cell.minCorrectionNear) cell.minCorrectionNear = val;
                    if (val > cell.maxCorrectionNear) cell.maxCorrectionNear = val;

                    // The autocorrelation pair, on the same "substantially inside" test the clamp
                    // uses: a sample contributing 2 % of its weight here is not this cell's series.
                    if (time !== undefined) {
                        if (cell.prevVal !== null && cell.prevTime !== null
                            && time - cell.prevTime <= AUTOCORR_MAX_GAP_SEC
                            && time >= cell.prevTime) {
                            const a = cell.prevVal, b = val;
                            cell.lagPairs++;
                            cell.sumLagAB += a * b;
                            cell.sumLagA += a;
                            cell.sumLagB += b;
                            cell.sumLagA2 += a * a;
                            cell.sumLagB2 += b * b;
                        }
                        cell.prevVal = val;
                        cell.prevTime = time;
                    }
                }

                if (rfKorr !== undefined) {
                    cell.sumRfKorrWeighted += rfKorr * w;
                    cell.weightSumRfKorr += w;
                    if (rfKorr < cell.minRfKorr) cell.minRfKorr = rfKorr;
                    if (rfKorr > cell.maxRfKorr) cell.maxRfKorr = rfKorr;
                }

                // Its own weight, like rf_korr's: the tuned correction is available on strictly
                // fewer samples than the nominal one, and dividing by the shared weightSum would
                // understate it on any cell holding a mix.
                if (tunedVal !== undefined) {
                    cell.sumTunedWeighted += tunedVal * w;
                    cell.weightSumTuned += w;
                    if (w >= CLAMP_MIN_WEIGHT) {
                        if (tunedVal < cell.minTunedNear) cell.minTunedNear = tunedVal;
                        if (tunedVal > cell.maxTunedNear) cell.maxTunedNear = tunedVal;
                    }
                }
            }
        };

        add(load.idx1, rpm.idx1, load.w1 * rpm.w1);
        add(load.idx1, rpm.idx2, load.w1 * rpm.w2);
        add(load.idx2, rpm.idx1, load.w2 * rpm.w1);
        add(load.idx2, rpm.idx2, load.w2 * rpm.w2);
    }

    /**
     * [EXPERIMENTAL] Auto-generates a Warmup Map based on the Tuned VE Map.
     * Logic: NewWarmup = NewVE_Intep * (StockWarmup / StockVE_Interp)
     * Handles Axis Mismatch by interpolating Main VE maps to match Warmup Map axes.
     */
    public generateWarmupMap(newVEMap: VEMap): VEMap {
        const stockVE = { // Construct VEMap object for Stock Data
            xAxis: APP_CONFIG.MSS54HP.AXIS_RPM,
            yAxis: APP_CONFIG.MSS54HP.AXIS_LOAD,
            data: CSL_STOCK_MAP_DATA
        };
        const stockWarmup = CSL_STOCK_WARMUP_MAP;

        // Use the specific axes for Cold Map
        const targetRpmAxis = CSL_STOCK_WARMUP_RPM;
        const targetLoadAxis = CSL_STOCK_WARMUP_LOAD;

        // Validation - ensure dimensions match our constants
        if (stockWarmup.length !== targetLoadAxis.length || stockWarmup[0].length !== targetRpmAxis.length) {
            console.warn("Stock Warmup Map dimensions mismatch with defined Constants. Returning New VE Map fallback.");
            return newVEMap;
        }

        const newWarmupData: number[][] = [];

        for (let r = 0; r < targetLoadAxis.length; r++) {
            const rowArr: number[] = [];
            const load = targetLoadAxis[r];

            for (let c = 0; c < targetRpmAxis.length; c++) {
                const rpm = targetRpmAxis[c];

                const sWarm = stockWarmup[r][c];

                // Interpolate Main Maps at Cold Map (rpm, load)
                // We need the value of the Main Map at this specific operating point
                const sVE_Interp = this.interpolateMap(stockVE, rpm, load);
                const nVE_Interp = this.interpolateMap(newVEMap, rpm, load);

                // Calculate Ratio: Stock Warmup / Stock Main (Interpolated)
                const ratio = sVE_Interp !== 0 ? sWarm / sVE_Interp : 1.0;

                // New Warmup = New VE (Interpolated) * Ratio
                rowArr.push(nVE_Interp * ratio);
            }
            newWarmupData.push(rowArr);
        }

        return {
            xAxis: targetRpmAxis,    // Return map with ITS OWN axes
            yAxis: targetLoadAxis,
            data: newWarmupData
        };
    }

    /**
     * Bilinear Interpolation helper to get value from a Map at any (rpm, load)
     */
    private interpolateMap(map: VEMap, rpm: number, load: number): number {
        // Find bounding indices
        const rInfo = this.findBoundingIndices(load, map.yAxis); // Load is Y-axis
        const cInfo = this.findBoundingIndices(rpm, map.xAxis);  // RPM is X-axis

        if (!rInfo || !cInfo) return 0;

        // 4 Neighbors
        const v11 = map.data[rInfo.idx1][cInfo.idx1]; // Top-Left
        const v12 = map.data[rInfo.idx1][cInfo.idx2]; // Top-Right
        const v21 = map.data[rInfo.idx2][cInfo.idx1]; // Bottom-Left
        const v22 = map.data[rInfo.idx2][cInfo.idx2]; // Bottom-Right

        // Interpolate Logic
        // Val = w1*w1*v11 + w1*w2*v12 ... 
        // My weights are: w1 (lower index weight), w2 (higher index weight)
        // rInfo.w1 is weight for idx1 (lower). rInfo.w2 is weight for idx2 (higher).

        // Lerp Formula: V = V_low * w_low + V_high * w_high
        const valRow1 = v11 * cInfo.w1 + v12 * cInfo.w2; // Interpolate X at Row 1
        const valRow2 = v21 * cInfo.w1 + v22 * cInfo.w2; // Interpolate X at Row 2

        const res = valRow1 * rInfo.w1 + valRow2 * rInfo.w2; // Interpolate Y

        return res;
    }
}
