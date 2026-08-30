/**
 * The idle feedforward corrector: from a run of `IdleSample` to a proposed `KF_LLR_QVS_GRUND`.
 *
 * Split the way `rfKorrTuner` is — a census that can be called live and cheaply, and a full tune
 * that runs at STOP — because the lesson `inertia/liveCoverage.ts` records applies here even more
 * sharply. There, "265 samples collected, 265 rejected, and nothing said so until the run had
 * already ended" cost a drive. Here the driver is sitting still in a car park holding a procedure
 * for three minutes, and finding out afterwards that the A/C cycled through all of it is worse.
 *
 * ## The three things that make this different from every other tuner in the app
 *
 * 1. **The target is not zero.** `lfra_adapt` integrates against `K_LFR_MDADAPT_OFFSET`, so the
 *    governor is designed to rest its I term at minus that — -7.0 Nm on stock. Read from the
 *    binary, never assumed, because assuming 0 would call a healthy engine 7 Nm short and 7 Nm of
 *    air at this operating point is more than the entire request.
 *
 * 2. **The measurement is a sum, not a reading.** Adaptation moves value out of `md_llri` and into
 *    `md_llra` at up to 0.333 Nm/s, so a warm settled car reads the resting point whatever the
 *    feedforward error is. `md_llri + md_llra` is invariant to how long it has been idling.
 *
 * 3. **The unit is a dwell, not a sample.** What is being estimated is where an integrator with a
 *    5.12 s time constant settles. Binning samples would count points on a ramp.
 */

import type { IdleSample } from '@/lib/dme-link/types';
import { findEcuItem } from '@/lib/ecu-items/catalog';
import { quantiseToward } from '@/lib/ecu-items/quantise';
import {
    type IdleTables, isLimpDuty, railedRailFor,
} from './idleTables';
import { defaultGainKgHPerNm } from './gain';
import { llsTvSlopePctPerKgH, modelAgreement } from './valveModel';
import {
    type IdleTuneOptions, type IdleDwell, type IdleRejectReason, type IdleRejectCounts,
    type IdleCellResult, type IdleTuneReport, type IdleTuneResult,
    EMPTY_IDLE_REJECTS, withDefaults,
} from './types';

// --- statistics ---------------------------------------------------------------------------------

function median(xs: number[]): number {
    if (!xs.length) return NaN;
    const s = [...xs].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * 20 %-trimmed mean.
 *
 * The headline statistic rather than the median, because a 20 s dwell is ~80 samples and the median
 * throws most of them away. The median is kept as an independent check: the two disagree when the
 * window contains an EVENT — a `K_LFR_NDIFF_RESET` zeroing, a split RAM read that survived the
 * clip — rather than a steady state, and that disagreement is worth rejecting on.
 */
function trimmedMean(xs: number[], frac = 0.2): number {
    if (!xs.length) return NaN;
    const s = [...xs].sort((a, b) => a - b);
    const drop = Math.floor(s.length * frac);
    const keep = s.slice(drop, s.length - drop);
    const use = keep.length ? keep : s;
    return use.reduce((a, b) => a + b, 0) / use.length;
}

function spread(xs: number[]): number {
    if (!xs.length) return 0;
    return Math.max(...xs) - Math.min(...xs);
}

// --- sample admission ---------------------------------------------------------------------------

/**
 * Why this sample cannot be part of a steady idle window, or null if it can.
 *
 * `hasLlBit` and `hasCompressor` say whether those channels EXIST on this run at all, because a
 * fallback-profile run has neither. A missing channel must not silently reject every sample, and it
 * must not silently pass either — it downgrades the check to a procedure, and the panel says so.
 */
export function rejectSample(
    s: IdleSample,
    o: IdleTuneOptions,
    ctx: { hasLlBit: boolean; hasCompressor: boolean },
): IdleRejectReason | null {
    if (s.mdLlri === null || s.rpm === null) return 'no-measurement';
    if (o.useAdaptationSum && s.mdLlra === null) return 'no-measurement';
    if (s.coolantTemp === null || s.coolantTemp < o.minCoolantC || s.coolantTemp > o.maxCoolantC) return 'not-warm';
    if (s.wdk1 !== null && s.wdk1 > o.maxThrottlePct) return 'throttle-open';
    if (s.nSoll === null) return 'no-measurement';
    if (Math.abs(s.rpm - s.nSoll) > o.maxSpeedErrorRpm) return 'off-target';
    // 0x04 is LL. Only checked when the run actually carries the channel.
    if (o.requireLlBit && ctx.hasLlBit && s.engineState !== null && (s.engineState & 0x04) === 0) return 'not-ll';
    if (o.excludeCompressor && ctx.hasCompressor && s.kkosSt !== null && (s.kkosSt & 0x01) !== 0) return 'compressor';
    return null;
}

// --- dwell detection ----------------------------------------------------------------------------

/**
 * Cut the run into maximal runs of admissible samples, then judge each as a whole.
 *
 * The compressor lockout is applied here rather than per sample, because the disturbance outlives
 * the flag: `K_MD_MIN_KKOS_FILTER` takes ~5.1 s to bring the load in and ~0.066 s to take it away,
 * so a window that merely starts after the flag clears is still riding the tail of it.
 */
export function findDwells(
    samples: readonly IdleSample[],
    tables: IdleTables,
    opts: Partial<IdleTuneOptions> | undefined,
    rejects: IdleRejectCounts,
): { dwells: IdleDwell[]; admitted: number; limpSeen: boolean } {
    const o = withDefaults(opts);
    const hasLlBit = samples.some(s => s.engineState !== null);
    const hasCompressor = samples.some(s => s.kkosSt !== null);
    const target = o.targetFromBinary ? tables.idleTargetNm : 0;

    let limpSeen = false;
    let admitted = 0;

    // Times at which the compressor was seen engaged, so a window near one can be pushed out.
    const compressorTimes: number[] = [];
    for (const s of samples) {
        if (s.kkosSt !== null && (s.kkosSt & 0x01) !== 0) compressorTimes.push(s.time);
        if (s.llsTv !== null && isLimpDuty(tables, s.llsTv, o.railToleranceDutyPct)) limpSeen = true;
    }
    const nearCompressor = (t: number) =>
        compressorTimes.some(ct => Math.abs(t - ct) <= o.compressorLockoutSec);

    // The run's own resting voltage. Spread inside a dwell catches a load being SWITCHED; it
    // cannot catch one that was on for the whole window, which reads perfectly steady and looks
    // exactly like a feedforward error. Comparing against the rest of the run is what separates
    // them, and it is the honest limit of this gate: a load left on for the ENTIRE session is
    // still invisible, which is why the procedure says to turn them off.
    const allUb = samples.map(s => s.ub).filter((v): v is number => v !== null);
    const refUb = allUb.length ? median(allUb) : null;

    const dwells: IdleDwell[] = [];
    let run: number[] = [];

    /**
     * The settled TAIL of an admissible window, not the window.
     *
     * A window begins the instant the throttle closes, and the governor then spends tens of seconds
     * recovering. Judging the whole thing means every real dwell fails `integrator-drifting` for a
     * transient that happened before anyone was measuring — which is not a steadiness test, it is a
     * test of how the driver arrived.
     *
     * So: walk back from the end while the integrator's spread stays inside the bound, and measure
     * what is left. That is what "wait for it to settle, then measure" actually means, and it is
     * the same shape as `transientSettleSec` in the VE filter — settle first, admit after.
     */
    const settledTail = (idx: number[], maxDrift: number): number[] => {
        let lo = Infinity;
        let hi = -Infinity;
        let start = idx.length;
        for (let k = idx.length - 1; k >= 0; k--) {
            const s = samples[idx[k]];
            // Settle on the quantity being MEASURED, not on md_llri alone. Once adaptation is
            // active it pins md_llri at the resting point by construction, so md_llri stops moving
            // long before the feedforward error has finished migrating into md_llra — watching it
            // would declare a window settled precisely while the number of interest was still in
            // flight.
            const v = o.useAdaptationSum
                ? (s.mdLlri !== null && s.mdLlra !== null ? s.mdLlri + s.mdLlra : null)
                : s.mdLlri;
            if (v === null) break;
            const nlo = Math.min(lo, v);
            const nhi = Math.max(hi, v);
            if (nhi - nlo > maxDrift) break;
            lo = nlo; hi = nhi; start = k;
        }
        return idx.slice(start);
    };

    const flush = (endIndex: number) => {
        if (!run.length) return;
        const full = run;
        run = [];
        const idx = settledTail(full, o.maxMdLlriDriftNm);
        if (!idx.length) return;
        const win = idx.map(i => samples[i]);
        const first = win[0];
        const last = win[win.length - 1];
        const durationSec = last.time - first.time;

        // Hard-clip against the binary's own clamps BEFORE any statistic. The 0x06 handler is a
        // byte copy and is not atomic, so a split word lands in the thousands at 0.1 Nm/LSB — one
        // of those in a mean is the whole dwell.
        const lli = win.map(s => s.mdLlri as number)
            .filter(v => v >= tables.mdLlriRange.min && v <= tables.mdLlriRange.max);
        const lla = win.map(s => (s.mdLlra ?? 0))
            .filter(v => v >= tables.mdLlriRange.min && v <= tables.mdLlriRange.max);
        if (!lli.length) return;

        const tm = trimmedMean(lli);
        const md = median(lli);
        const adaptMean = lla.length ? trimmedMean(lla) : 0;
        const duties = win.map(s => s.llsTv).filter((v): v is number => v !== null);
        // The row KF_LLS_TV is indexed on. Trimmed like every other window statistic, because a
        // split RAM read lands here exactly as it lands on md_llri.
        const airs = win.map(s => s.mlSollLls).filter((v): v is number => v !== null);
        const ubs = win.map(s => s.ub).filter((v): v is number => v !== null);
        const nSolls = win.map(s => s.nSoll).filter((v): v is number => v !== null);

        const dwell: IdleDwell = {
            startIndex: idx[0],
            endIndex,
            durationSec,
            samples: win.length,
            rpmMean: trimmedMean(win.map(s => s.rpm as number)),
            tmotMean: trimmedMean(win.map(s => s.coolantTemp as number)),
            mdLlriTrimmedMean: tm,
            mdLlriMedian: md,
            mdLlriDrift: spread(lli),
            errorDrift: spread(o.useAdaptationSum
                ? win.map(s => (s.mdLlri as number) + (s.mdLlra ?? 0))
                : lli),
            mdLlraMean: adaptMean,
            mdLlraDrift: spread(lla),
            llsTvMean: duties.length ? trimmedMean(duties) : null,
            mlSollLlsMean: airs.length ? trimmedMean(airs) : null,
            modelDeltaPct: null,
            error: tm + (o.useAdaptationSum ? adaptMean : 0) - target,
            rejected: null,
        };

        // Order matters, and it is cheapest-to-fix first — the same reporting choice
        // `lambdaGates.DropReason` documents. A driver told "hold it longer" can act on that; a
        // driver told "the integrator was railed" needs to fix the car first.
        const reject = (r: IdleRejectReason) => { dwell.rejected = r; rejects[r]++; };
        if (durationSec < o.dwellSec) reject('too-short');
        else if (win.length < o.minDwellSamples) reject('thin-count');
        else if (nearCompressor(first.time) || nearCompressor(last.time)) reject('compressor');
        else if (ubs.length > 1 && spread(ubs) > o.maxUbDriftV) reject('electrical-load');
        else if (refUb !== null && ubs.length && Math.abs(trimmedMean(ubs) - refUb) > o.maxUbDriftV) reject('electrical-load');
        else if (nSolls.length > 1 && spread(nSolls) > o.maxNSollDriftRpm) reject('target-moving');
        // Cannot fire after settledTail has done its work — kept because it is the invariant that
        // makes the tail meaningful, and an invariant that is never checked is an invariant that
        // quietly stops holding.
        else if (dwell.errorDrift > o.maxMdLlriDriftNm) reject('integrator-drifting');
        else if (Math.abs(tm - md) > o.maxStatDisagreeNm) reject('unsteady');
        // Only in mode 2. With the sum in use, redistribution between the two stores is exactly
        // what the statistic is invariant to, so rejecting a window for it would throw away the
        // evidence the invariance was built to keep. Mode 2 has no such invariance — it relies on
        // the adaptation being frozen — so there it is the gate that makes the mode sound.
        else if (!o.useAdaptationSum && dwell.mdLlraDrift > o.maxAdaptDriftNm) reject('adaptation-moved');
        // The row has to exist before anything can be binned onto it.
        else if (dwell.mlSollLlsMean === null) reject('no-air-request');
        else if (railedRailFor(tables, tm, o.railToleranceNm) !== null) reject('integrator-railed');
        else if (dwell.llsTvMean !== null && isLimpDuty(tables, dwell.llsTvMean, o.railToleranceDutyPct)) reject('limp-branch');
        else if (dwell.llsTvMean !== null && dwell.llsTvMean >= tables.tvMax - o.railToleranceDutyPct) reject('duty-railed-high');
        else if (dwell.llsTvMean !== null && dwell.llsTvMean <= tables.tvMin + o.railToleranceDutyPct) reject('duty-railed-low');

        // THE MODEL GATE, last, and computed even on a dwell that already failed — a rejected
        // window whose duty still matches the map is evidence the chain is right, and that is the
        // first capture's real deliverable. See valveModel.ts for every way it can disagree.
        const agree = modelAgreement(
            tables.llsTv, dwell.rpmMean, dwell.mlSollLlsMean, dwell.llsTvMean, o.maxModelDeltaPct);
        dwell.modelDeltaPct = agree ? agree.delta : null;
        if (!dwell.rejected && agree && !agree.agrees) reject('model-disagrees');

        dwells.push(dwell);
    };

    samples.forEach((s, i) => {
        const why = rejectSample(s, o, { hasLlBit, hasCompressor });
        if (why) { rejects[why]++; flush(i - 1); return; }
        admitted++;
        run.push(i);
    });
    flush(samples.length - 1);

    return { dwells, admitted, limpSeen };
}

// --- the live census ----------------------------------------------------------------------------

/**
 * What a run would keep, computed from scratch every time rather than accumulated.
 *
 * Recompute-don't-accumulate, for the reason `inertia/liveCoverage.ts` gives: an accumulator and a
 * final verdict are two implementations of one rule, and they drift. This calls the same
 * `findDwells` the tune calls, so what the strip says mid-drive is what the result will say.
 */
export function idleCensus(
    samples: readonly IdleSample[],
    tables: IdleTables | null,
    opts?: Partial<IdleTuneOptions>,
): IdleTuneReport {
    const rejects: IdleRejectCounts = { ...EMPTY_IDLE_REJECTS };
    const o = withDefaults(opts);
    const sources = new Set(samples.map(s => s.mdLlriSource).filter(Boolean));
    const source: IdleTuneReport['source'] =
        sources.size === 0 ? 'none' : sources.size > 1 ? 'mixed' : [...sources][0] as 'ram' | 'block19';

    if (!tables) {
        return {
            samplesSeen: samples.length, samplesAdmitted: 0, dwellsFound: 0, dwellsAccepted: 0,
            cellsUpdated: 0, cellsConverged: 0, rejects, worstErrorNm: 0,
            limpSeen: false, integratorRailed: false,
            gainUsed: o.gainKgHPerNm, gainLearned: false, source,
        };
    }

    const { dwells, admitted, limpSeen } = findDwells(samples, tables, opts, rejects);
    const accepted = dwells.filter(d => !d.rejected);
    return {
        samplesSeen: samples.length,
        samplesAdmitted: admitted,
        dwellsFound: dwells.length,
        dwellsAccepted: accepted.length,
        cellsUpdated: 0,
        cellsConverged: 0,
        rejects,
        worstErrorNm: accepted.reduce((m, d) => Math.max(m, Math.abs(d.error)), 0),
        limpSeen,
        integratorRailed: dwells.some(d => d.rejected === 'integrator-railed'),
        gainUsed: o.gainKgHPerNm,
        gainLearned: false,
        source,
    };
}

// --- the tune -----------------------------------------------------------------------------------

/** Nearest breakpoint, and how far off it the evidence sat as a fraction of the local span. */
function nearest(axis: number[], v: number): { i: number; offsetFrac: number; span: number } {
    let i = 0;
    let best = Infinity;
    axis.forEach((a, k) => { const d = Math.abs(a - v); if (d < best) { best = d; i = k; } });
    const lo = i > 0 ? axis[i] - axis[i - 1] : Infinity;
    const hi = i < axis.length - 1 ? axis[i + 1] - axis[i] : Infinity;
    const span = Math.min(lo, hi);
    return { i, offsetFrac: Number.isFinite(span) && span > 0 ? best / span : 0, span };
}

/**
 * The full derivation. `null` when the binary could not be read — never a correction built on
 * thresholds nobody read.
 */
export function tuneIdleFeedforward(
    samples: readonly IdleSample[],
    tables: IdleTables | null,
    opts?: Partial<IdleTuneOptions>,
    gainOverride?: { gain: number; learned: boolean },
): IdleTuneResult | null {
    if (!tables) return null;
    const o = withDefaults(opts);
    const def = findEcuItem('KF_LLR_QVS_GRUND');
    if (!def || def.kind !== 'map') return null;

    const rejects: IdleRejectCounts = { ...EMPTY_IDLE_REJECTS };
    const { dwells, admitted, limpSeen } = findDwells(samples, tables, opts, rejects);
    const accepted = dwells.filter(d => !d.rejected);

    /**
     * KF_LLS_TV's axes, not KF_LLR_QVS_GRUND's.
     *
     * x is rpm as before; y is `ml_ll` in kg/h — the air the torque path asked the valve for — and
     * the values are DUTY per cent. Coolant is not an axis of this map at all, and does not need to
     * be: a cold engine demands more air, which is a higher row, so the cold case separates itself
     * by the quantity that actually drives the valve rather than by a proxy for it. See seal.ts for
     * why the correction moved here, and valveModel.ts for how the map is read.
     */
    const rpmAxis = tables.llsTv.x;
    const airAxis = tables.llsTv.y;
    const stock = tables.llsTv.values.map(r => [...r]);
    const tuned = stock.map(r => [...r]);

    // Bin each dwell onto its nearest breakpoint. Nearest, not bilinear: a dwell is one operating
    // point held still, so smearing it across four cells would invent evidence for three of them.
    interface Bin { dwells: IdleDwell[]; samples: number; offsetOk: boolean }
    const bins = new Map<string, Bin>();
    for (const d of accepted) {
        if (d.mlSollLlsMean === null) continue;   // already rejected; belt and braces
        const r = nearest(airAxis, d.mlSollLlsMean);
        const c = nearest(rpmAxis, d.rpmMean);
        const rpmTolOk = c.offsetFrac <= o.maxOffsetFrac
            || Math.abs(rpmAxis[c.i] - d.rpmMean) <= o.minRpmTolerance;
        // The air axis is coarse at the bottom (11, 15, 20 kg/h) and a warm idle sits between the
        // first two, so the fractional test is the one that matters here; there is no absolute
        // tolerance to fall back on the way rpm has one, because a kg/h is not a small number on
        // this axis.
        const airTolOk = r.offsetFrac <= o.maxOffsetFrac;
        const key = `${r.i}:${c.i}`;
        const b = bins.get(key) ?? { dwells: [], samples: 0, offsetOk: true };
        b.dwells.push(d);
        b.samples += d.samples;
        b.offsetOk = b.offsetOk && rpmTolOk && airTolOk;
        bins.set(key, b);
    }

    const gain = gainOverride?.gain;
    let cellsUpdated = 0;
    let cellsConverged = 0;

    const cells: IdleCellResult[][] = airAxis.map((air, row) => rpmAxis.map((rpm, col) => {
        const b = bins.get(`${row}:${col}`);
        const base: IdleCellResult = {
            // `tmot` on the result keeps its name and now carries the AIR breakpoint, because the
            // panel reads it as "the other axis" and renaming it would touch every consumer for no
            // gain. The unit is on the axis, not on the field.
            row, col, rpm, tmot: air,
            stock: stock[row][col],
            tuned: stock[row][col],
            rawTarget: stock[row][col],
            dwells: b?.dwells.length ?? 0,
            samples: b?.samples ?? 0,
            errorNm: 0,
            rejected: null,
            converged: false,
        };
        const reject = (r: IdleRejectReason): IdleCellResult => {
            rejects[r]++;
            return { ...base, rejected: r };
        };

        // The 500 rpm column is the stall catch on this map too — its whole column sits at the
        // K_LLS_TV_MIN rail — and warm-idle evidence says nothing about it.
        if (!o.writeStallColumn && col === 0) return reject('stall-column');
        // Rows above the idle demand belong to states this evidence was not taken in. A warm idle
        // sits at 11-15 kg/h; anything above that is a load the run never held, and writing it from
        // here is the same mistake as writing a cold row from a warm measurement.
        if (!o.writeColdRows && row > 1) return reject('cold-row');
        if (!b || !b.dwells.length) return reject('no-evidence');
        if (b.dwells.length < o.minCellDwells) return reject('single-dwell');
        if (b.samples < o.minCellSamples) return reject('thin-count');
        if (!b.offsetOk) return reject('off-breakpoint');

        // Weighted by dwell length: a 90 s window says more than a 20 s one.
        const wsum = b.dwells.reduce((a, d) => a + d.samples, 0);
        const errorNm = b.dwells.reduce((a, d) => a + d.error * d.samples, 0) / wsum;

        /**
         * Nm of standing governor effort -> per cent of valve duty, in two steps that are each
         * separately defensible.
         *
         * `g_air` is the physics-bounded torque-to-air gain the old target used and is unchanged:
         * torque at idle IS air, whichever map is wrong. What is new is the second factor, and it
         * costs nothing to justify because it is not a new constant — it is the slope of the very
         * map being written, along the axis it is being written on. At the idle cell that is
         * 2.25 %/(kg/h), and the row above it reads 2.12, so the local linearisation holds.
         *
         * `gainOverride` still wins when a campaign has learned the combined figure, and it is in
         * %/Nm now: what the learner observes is duty written against error moved.
         */
        const gAir = defaultGainKgHPerNm(rpm, o);
        const slope = llsTvSlopePctPerKgH(tables.llsTv, rpm, air);
        if (slope === null || !(slope > 0)) return reject('below-authority-floor');
        const g = gain ?? slope * gAir;
        // The whole correction the evidence asks for, and the damped step actually taken.
        const full = g * errorNm;
        let step = Math.max(-o.maxStepPct, Math.min(o.maxStepPct, o.stepFraction * full));
        // stepFraction exists to stop an uncertain gain over-shooting. It must not be allowed to
        // stall the loop ABOVE the map's own resolution: with a 0.5 kg/h quantum, halving a
        // correction that is only two steps large rounds it to nothing, and the cell reports itself
        // converged while still visibly wrong. So once the FULL correction clears one quantum, at
        // least one quantum is taken — damping the approach, never freezing it short.
        // One raw step of an x/50 map: 0.02 % of duty. Far finer than the old 0.5 kg/h, so the
        // "damping must not freeze the loop below the quantum" rule below almost never fires here —
        // it is kept because it is the invariant, not because this map needs it.
        const quantum = tables.llsTvStepPct;
        if (Math.abs(step) < quantum && Math.abs(full) >= quantum) {
            step = Math.sign(full) * quantum;
        }
        const raw = base.stock + step;

        // The valve's own rails, from the binary. Not a fraction of stock: duty is an actuator
        // command with hard limits the DME itself applies, so those limits ARE the bounds, and a
        // proposal outside them would be silently clamped by the car rather than by this.
        const floor = tables.tvMin;
        const ceiling = tables.tvMax;
        const clamped = Math.min(ceiling, Math.max(floor, raw));
        if (raw < floor) {
            // Not a silent clamp: the request wanted to go below where the valve responds at all,
            // and that is a fact about the car worth reporting rather than a number worth rounding.
            return { ...reject('below-authority-floor'), errorNm, rawTarget: raw, tuned: base.stock };
        }

        const q = quantiseToward(def.values, clamped, base.stock);
        // Converged means the EVIDENCE cannot ask for a representable change — not that this pass's
        // damped step happened to round to nothing.
        if (Math.abs(full) < quantum || Math.abs(q.value - base.stock) < q.step * 0.5) {
            cellsConverged++;
            return { ...reject('sub-quantum'), errorNm, rawTarget: raw, tuned: base.stock, converged: true };
        }

        tuned[row][col] = q.value;
        cellsUpdated++;
        return { ...base, tuned: q.value, rawTarget: raw, errorNm };
    }));

    const integratorRailed = dwells.some(d => d.rejected === 'integrator-railed');
    const sources = new Set(samples.map(s => s.mdLlriSource).filter(Boolean));

    const report: IdleTuneReport = {
        samplesSeen: samples.length,
        samplesAdmitted: admitted,
        dwellsFound: dwells.length,
        dwellsAccepted: accepted.length,
        cellsUpdated,
        cellsConverged,
        rejects,
        worstErrorNm: accepted.reduce((m, d) => Math.max(m, Math.abs(d.error)), 0),
        limpSeen,
        integratorRailed,
        gainUsed: gain ?? o.gainKgHPerNm,
        gainLearned: !!gainOverride?.learned,
        source: sources.size === 0 ? 'none' : sources.size > 1 ? 'mixed' : [...sources][0] as 'ram' | 'block19',
    };

    // Every writable cell is within one step of where it wants to be — and at least one had enough
    // evidence to say so. "Nothing was measured" must not read as "converged".
    const writable = cells.flat().filter(c => c.rejected !== 'stall-column' && c.rejected !== 'cold-row');
    const converged = cellsUpdated === 0 && cellsConverged > 0;

    return {
        // `tmotAxis` keeps its name and carries the AIR breakpoints — see IdleCellResult.tmot.
        stock, tuned, rpmAxis, tmotAxis: airAxis, cells, dwells, report,
        targetNm: o.targetFromBinary ? tables.idleTargetNm : 0,
        converged,
        // One cell is enough, unlike rfKorr's three: the warm row is flat from 600 rpm up, so
        // 600/900/1350 are three names for one number and demanding three would demand evidence
        // the calibration's own shape says is redundant.
        acceptable: cellsUpdated >= 1
            && report.dwellsAccepted >= o.minCellDwells
            && !limpSeen
            && !integratorRailed
            && writable.length > 0,
    };
}
