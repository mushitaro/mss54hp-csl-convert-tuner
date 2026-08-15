import type { LogDataPoint, VEMap } from '@/lib/types';
import { timeScaleSeconds } from '@/lib/log-engine/filter';
// `import type` for the interface: Node's type stripping cannot tell a type-only named import from
// a value one, so a harness that loads this module directly fails on the missing export.
import type { EgtTables } from './egtTables';
import { gateOpen, tabgModelAt } from './egtTables';

/**
 * Back-calculates KF_RF_KORR_DRREL from a data log.
 *
 * ## What is being solved
 *
 * The DME injects on RF = rf_soll x rf_korr, and the closed loop moves STFT until lambda is 1.
 * At convergence, for one VE cell (one rf_soll):
 *
 *     rf_soll x k_applied(i) x STFT(i) = A(delta_i)
 *
 * where A is the air the cylinder actually got. Take the ratio of a cold-exhaust sample to a
 * warm-exhaust one in the SAME cell and rf_soll cancels:
 *
 *     A(delta) / A(0) = k_applied(delta) x STFT(delta) / STFT(0)
 *
 * The left side is what KF_RF_KORR_DRREL should hold. Two consequences follow, and both matter:
 *
 * 1. **The VE table need not be converged.** Its error is common to both samples and divides out.
 *    There is no "tune VE first, then the table" ordering.
 * 2. **The answer does not depend on what k the DME actually applied.** `k_applied` is measured
 *    (RF / rf_soll), so whether the correction's gate was open, shut, or holding a stale value
 *    through the hysteresis band, the equation is the same. This is why nothing here tries to
 *    evaluate the road-speed half of the gate, which DS2 selection 3 cannot report anyway.
 *
 * ## Where the gate DOES matter
 *
 * Identifying the anchor. `k_applied = 1.000` has three different causes — a genuinely warm
 * exhaust, a shut gate, and the identity rpm columns — and only the first is a nominal condition.
 * Using "k is about 1" as a proxy for "the exhaust is warm" lets a shut-gate sample at
 * delta = 300 degC into the anchor, which inflates it by the true density effect and pulls every
 * derived table entry DOWN. Understating this table leans the mixture under load at 2200-3500 rpm,
 * which is the one direction docs/ecu-logic/20-egt-correction.md says not to go.
 *
 * So the anchor is chosen on the SENSOR's delta, never on k. That is the whole reason the tuned
 * mode requires an exhaust-temperature channel.
 *
 * See docs/ecu-logic/60-tuning-logic.md section 6.5 for the derivation and its conditions.
 */

export interface RfKorrTuneOptions {
    /** Δ at or below which a sample counts as nominal — the table's first Y breakpoint, where
     *  every rpm column reads 1.000. Above it the DME is already correcting. */
    anchorDeltaMax: number;
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

    /** Evidence a VE cell needs before its anchor may be used as a DENOMINATOR. Far above the
     *  `weightSum > 0.1` the VE map itself runs on: that threshold is adequate for a mean, and a
     *  divisor built from one sample would propagate its noise into every entry it feeds. */
    minAnchorSamples: number;
    minAnchorWeight: number;

    /** Evidence a (rpm, Δ) grid cell needs before its value is written. */
    minCellSamples: number;
    minCellWeight: number;
    /** Distinct VE cells that must have contributed. One bad anchor must not become a table
     *  entry on its own — with two, a bad anchor has to be agreed with to survive. */
    minDistinctVeCells: number;
    /** max−min of the ratios binned into one grid cell. The derivation assumes the air really
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
     *  minSpan, and for the same reason. */
    identitySpan: number;
    /**
     * Write the identity Δ ROW as well — the row every rpm column pins at 1.000, which is the
     * baseline the whole table is measured against. Off, and separately from the columns, because
     * the failure mode is different: pass 2 skips anchors, but a sample at Δ = 35 still lands part
     * of its bilinear weight on the Δ = 30 row, so that row collects evidence from samples the
     * anchor logic deliberately excluded. On a real log this wrote 1.009 into the 2200 rpm cell —
     * a 0.9 % enrichment at zero delta, which shifts what every other row is relative to.
     */
    writeIdentityRow: boolean;
}

export const RF_KORR_TUNE_DEFAULTS: RfKorrTuneOptions = {
    anchorDeltaMax: 30,
    gateMargin: 0.05,
    settleSec: 3.0,
    maxRfDrift: 5.0,
    maxEgtRatePerSec: 8.0,
    minAnchorSamples: 5,
    minAnchorWeight: 3.0,
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

export type RejectReason =
    | 'no-evidence'
    | 'thin-weight'
    | 'thin-count'
    | 'single-ve-cell'
    | 'spread'
    | 'identity-column'
    | 'identity-row'
    | 'off-breakpoint';

export interface RfKorrTuneReport {
    samplesTotal: number;
    /** Carried neither `rf` nor a usable rf_soll — nothing was measured. */
    samplesNoMeasurement: number;
    /** No exhaust-temperature channel on the row, so no Δ. */
    samplesNoDelta: number;
    /**
     * Below the filling floor, so the DME's gate was SHUT and it applied 1.000 no matter what the
     * exhaust was doing. These samples carry no information about this table, and on a normal road
     * log they are almost all of them — 1173 of 1176 on the drive this counter was added for.
     */
    samplesGateShut: number;
    /** Inside the hysteresis band: the applied correction belongs to another operating point. */
    samplesHysteresis: number;
    /** RF or TABG was still moving, so Δ is sensor lag rather than a density signal. */
    samplesNotSettled: number;
    /**
     * Carried no lambda trim on either bank, so the closed loop's residual is unknown.
     *
     * The derivation is `A(Δ)/A(0) = k_applied × STFT(Δ) / STFT(0)`. `k_applied` says what the DME
     * DID; only STFT says whether it was RIGHT. Drop the trim and the ratio collapses to
     * `k_applied(Δ)/k_applied(0)` — which is the table already in the ECU, handed back as though the
     * drive had derived it.
     *
     * This counter exists because that used to happen silently: an absent trim was read as `1`, the
     * exact fabrication the VE calculator was fixed for. An EGT-profile log has no trim on any row,
     * so the whole of one lands here — see `trimMissing`.
     */
    samplesNoTrim: number;
    /** Qualified as nominal and went into an anchor. */
    anchorSamples: number;
    /** Carried a Δ above the anchor threshold and contributed a ratio. */
    ratioSamples: number;
    /** Had a Δ but no usable anchor in their own VE cell, so said nothing. */
    samplesNoAnchor: number;
    veCellsWithAnchor: number;
    gridCellsUpdated: number;
    rejectedByReason: Record<RejectReason, number>;
    /** No log row carried an exhaust temperature. Without one nothing here can run. */
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
    /** The raw weighted-mean ratio per grid cell, before any clamp. Shown so the difference
     *  between "the log said this" and "this is what will be written" stays visible. */
    measuredMap: number[][];
    updated: boolean[][];
    rejected: (RejectReason | null)[][];
    /** Per VE cell (load x rpm, matching the VE grid), the anchor and the weight behind it. */
    anchorMap: number[][];
    anchorWeightMap: number[][];
    /** Enough of the table moved to be worth writing. */
    acceptable: boolean;
    report: RfKorrTuneReport;
}

interface AnchorCell { sumQw: number; weight: number; count: number }
interface GridBin {
    sumDw: number; weight: number; count: number;
    min: number; max: number; veCells: Set<number>;
    /** Σ(Δ x w), so the bin can say where its evidence actually SAT — not merely how much of it
     *  there was. See maxDeltaOffsetFrac. */
    sumDeltaW: number;
}

const zeros = (rows: number, cols: number) =>
    Array.from({ length: rows }, () => new Array<number>(cols).fill(0));

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

/**
 * Bracketing weights on an ascending axis, clamped to the ends — the same rule as the DME's
 * kfu_wint and as VECalculator's own binning, so a sample lands in the same place here as it does
 * in the VE map.
 */
function bracket(axis: number[], q: number): { i0: number; i1: number; w1: number } {
    if (!(q > axis[0])) return { i0: 0, i1: 0, w1: 0 };
    const last = axis.length - 1;
    if (!(q < axis[last])) return { i0: last, i1: last, w1: 0 };
    for (let i = 0; i < last; i++) {
        if (q >= axis[i] && q <= axis[i + 1]) {
            const span = axis[i + 1] - axis[i];
            if (span === 0) return { i0: i, i1: i, w1: 0 };
            return { i0: i, i1: i + 1, w1: (q - axis[i]) / span };
        }
    }
    return { i0: last, i1: last, w1: 0 };
}

/** The four bilinear corners and their weights, skipping zero-weight ones. */
function corners(
    x: { i0: number; i1: number; w1: number },
    y: { i0: number; i1: number; w1: number },
): Array<{ r: number; c: number; w: number }> {
    const out: Array<{ r: number; c: number; w: number }> = [];
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
    q: number;                                   // k_applied x STFT
    delta: number;
    veCorners: Array<{ r: number; c: number; w: number }>;
    /** Index of the VE cell this sample sits closest to, used only to count how many distinct
     *  cells agreed on a grid entry. */
    veKey: number;
    isAnchor: boolean;
}

/**
 * Which samples of a log can contribute to the correction table, and why the rest cannot.
 *
 * Split out of `tuneRfKorrTable` so a run can show this WHILE IT IS HAPPENING, by calling the same
 * function the final verdict calls. That is the whole point and it is not tidying: two runs have now
 * been driven to completion and thrown away, and in both cases the number that would have saved them
 * — anchors, zero — existed only after the drive was over. The inertia side already learned this
 * (see lib/inertia/liveCoverage.ts); this is the same lesson on the side that needed it more.
 *
 * A second implementation would drift, and the drift would be invisible until someone had already
 * driven. So there is one implementation, and the live display and the table are both downstream of
 * it.
 *
 * Cheap enough to call on a throttle: O(n) over the log, n a few thousand, no allocation per cell.
 * It does NOT build the table — that stays in `tuneRfKorrTable`, because a table that changed
 * mid-run would feed back into the VE binning and make the grid a mixture of two calibrations.
 */
export function rfKorrCensus(
    annotatedLog: LogDataPoint[],
    egt: EgtTables,
    veAxes: { rpm: number[]; load: number[] },
    opts: Partial<RfKorrTuneOptions> = {},
): { report: RfKorrTuneReport; prepared: RfKorrPrepared[] } {
    const o: RfKorrTuneOptions = { ...RF_KORR_TUNE_DEFAULTS, ...opts };
    const veCols = veAxes.rpm.length;

    const report: RfKorrTuneReport = {
        samplesTotal: annotatedLog.length,
        samplesNoMeasurement: 0, samplesNoDelta: 0,
        samplesGateShut: 0, samplesHysteresis: 0, samplesNotSettled: 0, samplesNoTrim: 0,
        anchorSamples: 0, ratioSamples: 0, samplesNoAnchor: 0,
        veCellsWithAnchor: 0, gridCellsUpdated: 0,
        rejectedByReason: {
            'no-evidence': 0, 'thin-weight': 0, 'thin-count': 0,
            'single-ve-cell': 0, 'spread': 0, 'identity-column': 0, 'identity-row': 0,
            'off-breakpoint': 0,
        },
        sensorMissing: true,
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
    // can reach backwards past samples pass 0 is about to reject: a sample is settled or not by what
    // the car was doing beforehand, not by what else survived this function.
    //
    // It cannot see rows the LOG FILTER already removed (coolant, idle, cat-protection). The window
    // is bounded on timestamps rather than on indices, so a removal longer than settleSec falls out
    // of the window rather than being silently spanned; a shorter one would be spanned, which needs
    // the car to have dropped below 1000 rpm at a closed throttle and come back inside three
    // seconds, between two samples that both cleared the 55-80 % filling gate. Not worth the second
    // array to defend against.
    const settled = settledFlags(annotatedLog, o);

    // --- Pass 0: everything each sample contributes, computed once -----------------------------
    // Held rather than recomputed because pass 2 needs the same Δ, the same q and the same VE
    // corners pass 1 used. Deriving them twice is how the anchor and the ratio end up disagreeing
    // about which cell a sample belongs to.
    const prepared: RfKorrPrepared[] = [];

    for (let i = 0; i < annotatedLog.length; i++) {
        const p = annotatedLog[i];
        const rfKorr = p.rfKorr;
        const rfSoll = p.rfSoll;
        if (rfKorr === undefined || rfSoll === undefined || !(rfSoll > 0)) {
            report.samplesNoMeasurement++;
            continue;
        }
        if (p.exhaustTemp === undefined || p.rf === undefined) {
            report.samplesNoDelta++;
            continue;
        }
        report.sensorMissing = false;

        // The gate itself. Below kl_rf_korr_rf_min the DME applies rf_korr = 1.000 whatever the
        // exhaust is doing, so the sample says nothing about THIS table — it is a measurement of a
        // correction that was not running.
        //
        // The header above argues the derivation survives a shut gate because k_applied is measured
        // rather than assumed. That is true of the arithmetic and false of the experiment. Every
        // cell of KF_RF_KORR_DRREL is READ by the DME only above 55-80 % filling; deriving those
        // cells from samples taken at 13 % filling extrapolates a high-load density effect from
        // light-cruise data, and the answer it gives is "no effect" — which then clamps the stock
        // 1.019-1.161 down to 1.000, i.e. LEAN, at exactly the condition BMW chose to enrich.
        //
        // Ordered before the hysteresis test because it is the strictly stronger statement: shut is
        // shut, whereas the band below is about a value that is real but belongs to another point.
        if (!gateOpen(egt, p.rpm, rfSoll)) {
            report.samplesGateShut++;
            continue;
        }

        // The hysteresis band. The measurement of what was applied is still exact here — it is
        // the correspondence with THIS sample's Δ that is broken, because the held value was
        // computed somewhere else. Excluded as a data-quality matter, not a safety one.
        if (!gateOpen(egt, p.rpm, rfSoll, o.gateMargin)) {
            report.samplesHysteresis++;
            continue;
        }

        // Δ has to be a temperature difference, not a sensor that has not caught up yet. See
        // RfKorrTuneOptions.settleSec.
        if (!settled[i]) {
            report.samplesNotSettled++;
            continue;
        }

        // annotateRfKorr already computed this against the same tables; taking its value rather
        // than recomputing is what keeps the tuner and the VE calculation on the same Δ.
        const delta = p.tabgDelta
            ?? Math.max(0, tabgModelAt(egt, p.rpm, p.rf / 100) - p.exhaustTemp);
        // Whichever banks are present, averaged over those alone. It used to read
        // `(p.stft1 ?? p.stft2 ?? 1)`, so a row with no trim at all silently became 1.000 — the same
        // fabrication the VE calculator was fixed for, still live here.
        //
        // It is not a harmless default. `q = k_applied × STFT`, and STFT is the only term that says
        // whether the correction the DME applied was CORRECT. Pin it at 1 and every ratio becomes
        // `k_applied(Δ)/k_applied(0)`: the table already in the ECU, returned as a derivation of it.
        // A run would report a confident tuned table that is just the stock one plus interpolation
        // noise, and `largestChange` would say it barely moved — reading as agreement rather than as
        // the tautology it is.
        const banks: number[] = [];
        if (p.stft1 !== undefined) banks.push(p.stft1);
        if (p.stft2 !== undefined) banks.push(p.stft2);
        if (!banks.length) { report.samplesNoTrim++; continue; }
        const stft = banks.reduce((a, b) => a + b, 0) / banks.length;
        if (!(stft > 0)) { report.samplesNoMeasurement++; continue; }

        const load = p.correctedLoad ?? p.rawLoad;
        const veCorners = corners(bracket(veAxes.rpm, p.rpm), bracket(veAxes.load, load));
        if (veCorners.length === 0) { report.samplesNoMeasurement++; continue; }

        const dominant = veCorners.reduce((best, c) => (c.w > best.w ? c : best));
        prepared.push({
            rpm: p.rpm,
            q: rfKorr * stft,
            delta,
            veCorners,
            veKey: dominant.r * veCols + dominant.c,
            isAnchor: delta <= o.anchorDeltaMax,
        });
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
    const o: RfKorrTuneOptions = { ...RF_KORR_TUNE_DEFAULTS, ...opts };

    const rpmAxis = egt.rfKorr.rpm;
    const deltaAxis = egt.rfKorr.delta;
    const rows = deltaAxis.length, cols = rpmAxis.length;
    const veRows = veAxes.load.length, veCols = veAxes.rpm.length;

    const { report, prepared } = rfKorrCensus(annotatedLog, egt, veAxes, o);

    // Both are "this log cannot answer the question", and both return nothing rather than something
    // weak: the caller shows a table when it gets one, and a table is a thing that gets flashed.
    //
    // The census above is still returned to a live caller in both cases — refusing to build a table
    // is not a reason to refuse to say why.
    if (report.sensorMissing || report.trimMissing) return null;

    // --- Pass 1: the anchors, per VE cell ------------------------------------------------------
    const anchors: AnchorCell[][] = Array.from({ length: veRows }, () =>
        Array.from({ length: veCols }, () => ({ sumQw: 0, weight: 0, count: 0 })));

    for (const s of prepared) {
        if (!s.isAnchor) continue;
        report.anchorSamples++;
        for (const c of s.veCorners) {
            const cell = anchors[c.r][c.c];
            cell.sumQw += s.q * c.w;
            cell.weight += c.w;
            cell.count++;
        }
    }

    const anchorMap = zeros(veRows, veCols);
    const anchorWeightMap = zeros(veRows, veCols);
    for (let r = 0; r < veRows; r++) for (let c = 0; c < veCols; c++) {
        const a = anchors[r][c];
        anchorWeightMap[r][c] = a.weight;
        if (a.count >= o.minAnchorSamples && a.weight >= o.minAnchorWeight && a.sumQw > 0) {
            anchorMap[r][c] = a.sumQw / a.weight;
            report.veCellsWithAnchor++;
        }
    }

    // --- Pass 2: the ratios, binned on the correction's own grid --------------------------------
    const bins: GridBin[][] = Array.from({ length: rows }, () =>
        Array.from({ length: cols }, () => ({
            sumDw: 0, weight: 0, count: 0,
            min: Infinity, max: -Infinity, veCells: new Set<number>(),
            sumDeltaW: 0,
        })));

    for (const s of prepared) {
        if (s.isAnchor) continue;   // pinned at 1.000 by the table itself: carries no Δ information

        // The anchor for THIS sample's operating point, blended over the same VE corners it was
        // binned into. Using a single nearest cell would step the anchor discontinuously across a
        // cell boundary and put that step straight into the derived table.
        let anchorSum = 0, anchorW = 0;
        for (const c of s.veCorners) {
            const a = anchorMap[c.r][c.c];
            if (a > 0) { anchorSum += a * c.w; anchorW += c.w; }
        }
        if (!(anchorW > 0)) { report.samplesNoAnchor++; continue; }
        const anchor = anchorSum / anchorW;
        if (!(anchor > 0)) { report.samplesNoAnchor++; continue; }

        const ratio = s.q / anchor;
        if (!Number.isFinite(ratio) || ratio <= 0) { report.samplesNoAnchor++; continue; }
        report.ratioSamples++;

        // Weight the ratio by how much of the anchor it actually stands on, so a sample sitting
        // mostly over VE cells with no anchor counts for correspondingly less.
        const confidence = anchorW;

        for (const g of corners(bracket(rpmAxis, s.rpm), bracket(deltaAxis, s.delta))) {
            const bin = bins[g.r][g.c];
            const w = g.w * confidence;
            bin.sumDw += ratio * w;
            bin.sumDeltaW += s.delta * w;
            bin.weight += w;
            bin.count++;
            if (ratio < bin.min) bin.min = ratio;
            if (ratio > bin.max) bin.max = ratio;
            bin.veCells.add(s.veKey);
        }
    }

    // --- Pass 3: decide each grid cell ----------------------------------------------------------
    const stock = egt.rfKorr.values.map(row => [...row]);
    const tuned = egt.rfKorr.values.map(row => [...row]);
    const countMap = zeros(rows, cols);
    const weightMap = zeros(rows, cols);
    const spreadMap = zeros(rows, cols);
    const measuredMap = zeros(rows, cols);
    const updated = Array.from({ length: rows }, () => new Array<boolean>(cols).fill(false));
    const rejected: (RejectReason | null)[][] =
        Array.from({ length: rows }, () => new Array<RejectReason | null>(cols).fill(null));

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
            if (reason) { rejected[r][c] = reason; report.rejectedByReason[reason]++; continue; }

            const raw = bin.sumDw / bin.weight;
            const stepped = Math.min(stock[r][c] + o.maxStepUp,
                Math.max(stock[r][c] - o.maxStepDown, raw));
            const value = Math.min(o.ceiling, Math.max(o.floor, stepped));

            tuned[r][c] = value;
            updated[r][c] = true;
            report.gridCellsUpdated++;
            report.largestChange = Math.max(report.largestChange, Math.abs(value - stock[r][c]));
        }
    }

    return {
        rpm: [...rpmAxis], delta: [...deltaAxis],
        stock, tuned, countMap, weightMap, spreadMap, measuredMap, updated, rejected,
        anchorMap, anchorWeightMap,
        // One updated cell is a curiosity, not a calibration. Requiring a handful keeps a log that
        // happened to clip one corner of the grid from presenting itself as a tune.
        //
        // The two evidence terms are very nearly implied by the first now that pass 0 refuses shut
        // gates — no ratios means no bins means no updates. They are stated anyway because the
        // implication runs through three passes and one of them is a bilinear spread: this used to
        // return `acceptable: true` off a log that contained not one sample where the correction was
        // running, and the invariant that says why it cannot belongs where it is read.
        acceptable: report.gridCellsUpdated >= 3
            && report.ratioSamples > 0
            && report.veCellsWithAnchor > 0,
        report,
    };
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
