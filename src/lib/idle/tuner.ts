/**
 * The idle corrector: from a run of `IdleSample` to a proposed `KF_LLS_TV`.
 *
 * The full derivation, in one place, is docs/ecu-logic/70-idle-write.md. What follows is the
 * reasoning that belongs with the code.
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
    type IdleTables, type IdleMap2d, isLimpDuty, railedRailFor,
} from './idleTables';
import { defaultGainKgHPerNm } from './gain';
import { llsTvSlopePctPerKgH, lookupNodes, modelAgreement } from './valveModel';
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
 * One admission test on one sample, as a thing that can be DRAWN as well as counted.
 *
 * `ok` is three-valued because a channel can be absent: a fallback-profile run carries neither the
 * LL bit nor the compressor flag, and "not checked" is a different fact from "checked and passed".
 * The panel has said so in prose since the first version; the point of this shape is that the
 * picture can say it too.
 */
export interface IdleSampleGate {
    /** Instrument shorthand, as the DME names the channel. Does not translate. */
    id: string;
    /** What a failure counts as, so one list drives both the chips and the census. */
    reason: IdleRejectReason;
    /** true = holds, false = fails, null = this run does not carry the channel. */
    ok: boolean | null;
    /** The reading, formatted. Dash when there is nothing to read. */
    value: string;
    /** The rule, with the option's own number in it. */
    rule: string;
}

/**
 * Every admission test, in the order `rejectSample` applies them.
 *
 * ONE list with two consumers, which is the reason it exists. `rejectSample` returns the first
 * failure and the census counts it; the trace lights a chip per entry. Written twice, the two would
 * disagree the first time a threshold moved — and they would disagree on the screen a driver is
 * watching to decide whether the last three minutes counted.
 *
 * `MD_LLRI` and `N_SOLL` are separate entries even though both fail as `no-measurement`, because
 * the ORDER is load-bearing (`N_SOLL` is tested after the throttle, so a blipped throttle reports
 * `throttle-open` rather than a missing channel) and because "which channel is missing" is exactly
 * what a driver needs in order to act.
 */
export function sampleGates(
    s: IdleSample,
    o: IdleTuneOptions,
    ctx: { hasLlBit: boolean; hasCompressor: boolean },
): IdleSampleGate[] {
    const num = (v: number | null, d: number, unit = '') =>
        v === null ? '—' : `${v.toFixed(d)}${unit}`;
    const llBit = ctx.hasLlBit && s.engineState !== null;
    const kkos = ctx.hasCompressor && s.kkosSt !== null;
    return [
        {
            id: 'MD_LLRI', reason: 'no-measurement',
            ok: s.mdLlri !== null && s.rpm !== null && (!o.useAdaptationSum || s.mdLlra !== null),
            value: num(s.mdLlri, 2), rule: 'present',
        },
        {
            id: 'TMOT', reason: 'not-warm',
            ok: s.coolantTemp !== null
                && s.coolantTemp >= o.minCoolantC && s.coolantTemp <= o.maxCoolantC,
            value: num(s.coolantTemp, 0, '°'), rule: `${o.minCoolantC}–${o.maxCoolantC}`,
        },
        {
            id: 'WDK', reason: 'throttle-open',
            ok: s.wdk1 === null || s.wdk1 <= o.maxThrottlePct,
            value: num(s.wdk1, 1), rule: `<= ${o.maxThrottlePct}`,
        },
        {
            id: 'N_SOLL', reason: 'no-measurement',
            ok: s.nSoll !== null,
            value: num(s.nSoll, 0), rule: 'present',
        },
        {
            id: 'N−N_SOLL', reason: 'off-target',
            ok: s.nSoll !== null && s.rpm !== null
                && Math.abs(s.rpm - s.nSoll) <= o.maxSpeedErrorRpm,
            value: s.rpm !== null && s.nSoll !== null
                ? `${s.rpm - s.nSoll >= 0 ? '+' : ''}${(s.rpm - s.nSoll).toFixed(0)}` : '—',
            rule: `|Δ| <= ${o.maxSpeedErrorRpm}`,
        },
        {
            id: 'LL', reason: 'not-ll',
            ok: !o.requireLlBit ? true : !llBit ? null : ((s.engineState as number) & 0x04) !== 0,
            value: llBit ? `0x${Math.round(s.engineState as number).toString(16)}` : '—',
            rule: 'bit2 set',
        },
        {
            id: 'A/C', reason: 'compressor',
            ok: !o.excludeCompressor ? true : !kkos ? null : ((s.kkosSt as number) & 0x01) === 0,
            value: kkos ? `0x${Math.round(s.kkosSt as number).toString(16)}` : '—',
            rule: 'bit0 clear',
        },
    ];
}

/**
 * Why this sample cannot be part of a steady idle window, or null if it can.
 *
 * `hasLlBit` and `hasCompressor` say whether those channels EXIST on this run at all, because a
 * fallback-profile run has neither. A missing channel must not silently reject every sample, and it
 * must not silently pass either — it downgrades the check to a procedure, and the panel says so.
 * That downgrade is the `null` in `IdleSampleGate.ok`, and it admits the sample.
 */
export function rejectSample(
    s: IdleSample,
    o: IdleTuneOptions,
    ctx: { hasLlBit: boolean; hasCompressor: boolean },
): IdleRejectReason | null {
    for (const g of sampleGates(s, o, ctx)) if (g.ok === false) return g.reason;
    return null;
}

// --- dwell detection ----------------------------------------------------------------------------

/**
 * The settled TAIL of an admissible window, not the window.
 *
 * A window begins the instant the throttle closes, and the governor then spends tens of seconds
 * recovering. Judging the whole thing means every real dwell fails `integrator-drifting` for a
 * transient that happened before anyone was measuring — which is not a steadiness test, it is a
 * test of how the driver arrived.
 *
 * So: walk back from the end while the integrator's spread stays inside the bound, and measure what
 * is left. That is what "wait for it to settle, then measure" actually means, and it is the same
 * shape as `transientSettleSec` in the VE filter — settle first, admit after.
 *
 * At module scope rather than inside `findDwells` because the LIVE gate needs the same walk on the
 * window that is still open. A driver being told "hold it another 8 seconds" is being told what
 * this function will decide at the end, and computing that two ways is how the countdown comes to
 * disagree with the verdict it was counting down to.
 */
function settledTail(
    samples: readonly IdleSample[],
    idx: readonly number[],
    maxDrift: number,
    useAdaptationSum: boolean,
): number[] {
    let lo = Infinity;
    let hi = -Infinity;
    let start = idx.length;
    for (let k = idx.length - 1; k >= 0; k--) {
        const s = samples[idx[k]];
        // Settle on the quantity being MEASURED, not on md_llri alone. Once adaptation is active it
        // pins md_llri at the resting point by construction, so md_llri stops moving long before the
        // feedforward error has finished migrating into md_llra — watching it would declare a window
        // settled precisely while the number of interest was still in flight.
        const v = useAdaptationSum
            ? (s.mdLlri !== null && s.mdLlra !== null ? s.mdLlri + s.mdLlra : null)
            : s.mdLlri;
        if (v === null) break;
        const nlo = Math.min(lo, v);
        const nhi = Math.max(hi, v);
        if (nhi - nlo > maxDrift) break;
        lo = nlo; hi = nhi; start = k;
    }
    return idx.slice(start);
}

/**
 * WHAT THE RUN IS DOING RIGHT NOW — the conditions, judged, while the engine is still running.
 *
 * The census answers "what did this run keep"; a driver holding a procedure in a car park needs the
 * other question answered first: **am I being recorded at this moment, and how much longer.**
 * Without it the three minutes are blind, and the only feedback is a rejection count that arrives
 * after the chance to fix anything has gone.
 *
 * Everything here is recomputed from the samples through the same functions the verdict uses —
 * `sampleGates` for admission, `settledTail` for steadiness — rather than accumulated as the run
 * goes. That is the rule `inertia/liveCoverage.ts` records, and it matters more here: this number
 * is a countdown, and a countdown that reaches zero without the dwell being accepted is worse than
 * no countdown at all.
 *
 * Cost is the OPEN window, not the run: both walks start at the newest sample and stop at the first
 * inadmissible one. A run that has been sitting outside the gates costs two comparisons.
 */
export interface IdleGateNow {
    /** Each admission test on the newest sample. */
    gates: IdleSampleGate[];
    /** Why the newest sample is not admissible, or null when it is. */
    blocking: IdleRejectReason | null;
    /** Seconds the settled tail has held, and what `dwellSec` asks for. */
    heldSec: number;
    needSec: number;
    /** Samples in that tail, against `minDwellSamples` — the other half of the same gate. */
    heldSamples: number;
    needSamples: number;
    /** Where the settled tail begins, so the picture can mark it. Null when nothing is open. */
    startTime: number | null;
    /**
     * The open window put through `judgeWindow` — the same call the census makes.
     *
     * Null until there is a settled tail with a usable reading in it. Everything the gauge rack
     * draws for the WINDOW group comes off this: `ubDrift`, `nSollDrift`, `statDisagree`,
     * `modelDeltaPct`, `llsTvMean`, and which gate `rejected` names. The point is that a bar cannot
     * disagree with the verdict, because there is only one verdict.
     */
    window: IdleDwell | null;
    /** The options the bands come from, so the drawing does not restate them. */
    opts: IdleTuneOptions;
}

export function idleGateNow(
    samples: readonly IdleSample[],
    tables: IdleTables | null,
    opts?: Partial<IdleTuneOptions>,
): IdleGateNow | null {
    if (!samples.length) return null;
    const o = withDefaults(tables ? { minCoolantC: tables.adaptTmotC, ...opts } : opts);
    const ctx = {
        hasLlBit: samples.some(s => s.engineState !== null),
        hasCompressor: samples.some(s => s.kkosSt !== null),
    };
    const gates = sampleGates(samples[samples.length - 1], o, ctx);
    const blocking = gates.find(g => g.ok === false)?.reason ?? null;

    // The open admissible window: back from the end until a sample fails.
    const open: number[] = [];
    for (let i = samples.length - 1; i >= 0; i--) {
        if (rejectSample(samples[i], o, ctx)) break;
        open.push(i);
    }
    open.reverse();
    const tail = open.length ? settledTail(samples, open, o.maxMdLlriDriftNm, o.useAdaptationSum) : [];

    // The compressor lockout and the run's resting voltage both need the WHOLE run, exactly as the
    // census computes them — a window is refused for a compressor engagement twelve seconds either
    // side of it, and for sitting away from a resting voltage it can only know from the rest.
    let window: IdleDwell | null = null;
    if (tables && tail.length) {
        const compressorTimes: number[] = [];
        for (const s of samples) if (s.kkosSt !== null && (s.kkosSt & 0x01) !== 0) compressorTimes.push(s.time);
        const nearCompressor = (t: number) =>
            compressorTimes.some(ct => Math.abs(t - ct) <= o.compressorLockoutSec);
        const allUb = samples.map(s => s.ub).filter((v): v is number => v !== null);
        const refUb = allUb.length ? median(allUb) : null;
        window = judgeWindow(samples, tail, samples.length - 1, tables, o, refUb, nearCompressor);
    }

    return {
        gates,
        blocking,
        heldSec: tail.length ? samples[tail[tail.length - 1]].time - samples[tail[0]].time : 0,
        needSec: o.dwellSec,
        heldSamples: tail.length,
        needSamples: o.minDwellSamples,
        startTime: tail.length ? samples[tail[0]].time : null,
        window,
        opts: o,
    };
}

/**
 * Whether a cell of `KF_LLS_TV` may be written from warm idle evidence.
 *
 * Three structural exclusions, and each is a fact about the map rather than about the run:
 *
 *   col 0    the 500 rpm column is the stall catch — 30.0 kg/h against the warm row's 14.0. Warm
 *            idle evidence says nothing about it.
 *   row 0    y = 11 kg/h is flat `K_LLS_TV_MIN`: the authority floor, not a calibration.
 *   row > 1  cold rows. Writing one from a warm measurement is how a warm tune becomes a
 *            cold-morning stall, and it is also `KF_LLS_TV_KATH`'s shared request.
 *
 * Exported because the PANEL needs the same answer the tuner does — it draws the map with the
 * writable region picked out, and a second copy of this rule is a picture of cells the writer will
 * refuse.
 */
/**
 * The three exclusions that are facts about the MAP rather than about the run.
 *
 * They fire on the same cells every time — 99 cold, 13 stall column, 9 floor row on this
 * binary — so they carry no information about a drive, and in a census sorted by count they
 * bury the reasons that do. The panel's map already says which cells they are, by drawing them
 * dim; the reject list exists for the reasons a driver can act on.
 */
export const STRUCTURAL_EXCLUSIONS: ReadonlySet<IdleRejectReason> =
    new Set(['stall-column', 'authority-floor-row']);

/**
 * Earlier runs laid end to end in front of this one, so one tune sees every observation.
 *
 * The pool is already shifted to occupy its own stretch of the timeline; this puts the current run
 * after it with the same seam width, wider than `compressorLockoutSec`, so `findDwells` can neither
 * merge a window across two drives nor reach a compressor engagement in one from the other.
 *
 * Exported because the page derives a stored run's proposal and `IdleWorkflow` derives the live one:
 * two layouts of the same timeline would rebuild different bytes from the same evidence.
 */
export function withPool(pool: readonly IdleSample[], run: readonly IdleSample[]): IdleSample[] {
    if (!pool.length) return [...run];
    if (!run.length) return [...pool];
    const o = withDefaults(undefined);
    const after = pool[pool.length - 1].time + o.compressorLockoutSec * 4;
    const t0 = run[0].time;
    return [...pool, ...run.map(s => ({ ...s, time: s.time - t0 + after }))];
}

export function isWritableCell(row: number, col: number, opts?: Partial<IdleTuneOptions>): boolean {
    const o = withDefaults(opts);
    return (o.writeStallColumn || col > 0) && row > 0;
}

/**
 * The air rows this run's accepted dwells actually sat on.
 *
 * `row > 1` used to be a third exclusion inside `isWritableCell`, called "cold rows", and it was an
 * ASSUMPTION rather than a fact: it came from an expected warm idle of about 14 kg/h, which would
 * sit on rows 0-1. The car settled it. Session #936 idles warm at 18.15 kg/h, so the DME reads the
 * 15 and 20 kg/h rows and puts 63 % of its own lookup weight on the 20 one — and refusing that row
 * meant the correction could reach 37 % of the operating point, was scaled up to compensate, and
 * saturated the per-pass cap for ever. The map could not converge on this car.
 *
 * Every dwell reaching here is already warm: `not-warm` drops anything outside
 * `minCoolantC..maxCoolantC` before a window can form. So these ARE the rows warm evidence reaches,
 * whatever their index — a car idling at 13 kg/h writes 11 and 15, this one writes 15 and 20.
 *
 * The axis is AIR DEMAND, not coolant. What belongs in a cell is how far the valve must open for
 * that much air, and a warm measurement at 18 kg/h is evidence about exactly that. Cold's own extra
 * request is a different map — `KF_LLS_TV_KATH`, which nothing here touches.
 */
export function rowsWithWarmEvidence(
    map: IdleMap2d,
    accepted: readonly IdleDwell[],
): ReadonlySet<number> {
    const rows = new Set<number>();
    for (const d of accepted) {
        if (d.mlSollLlsMean === null) continue;
        for (const n of lookupNodes(map, d.rpmMean, d.mlSollLlsMean)) rows.add(n.row);
    }
    return rows;
}

/**
 * Which samples were admissible, as a flat array parallel to `samples`.
 *
 * For the ribbon under the trace: the run's whole admission history, so "did I actually hold it"
 * is answerable by looking rather than by counting rejections in a list. Same `rejectSample`, so a
 * lit pixel means exactly what an admitted sample means.
 */
export function admissionMask(
    samples: readonly IdleSample[],
    tables: IdleTables | null,
    opts?: Partial<IdleTuneOptions>,
): boolean[] {
    const o = withDefaults(tables ? { minCoolantC: tables.adaptTmotC, ...opts } : opts);
    const ctx = {
        hasLlBit: samples.some(s => s.engineState !== null),
        hasCompressor: samples.some(s => s.kkosSt !== null),
    };
    return samples.map(s => rejectSample(s, o, ctx) === null);
}

/**
 * ONE settled window, measured and judged — the only place a dwell is decided.
 *
 * At module scope rather than inside `findDwells` because the LIVE rack needs the same verdict on
 * the window that is still open. The gauge pane draws a bar per gate with the reading's position on
 * it, and every one of those readings is a statistic computed here: the voltage spread, the target
 * spread, the two robust means' disagreement, the duty against the map. Computing them a second
 * time for the picture is how a bar comes to say "inside" while the census says the window was
 * refused for exactly that gate.
 *
 * Returns null when the window is not measurable at all — no settled tail, or no usable `md_llri`
 * after the clamps. `rejected` carries the verdict; the caller counts it.
 */
export function judgeWindow(
    samples: readonly IdleSample[],
    idx: readonly number[],
    endIndex: number,
    tables: IdleTables,
    o: IdleTuneOptions,
    /** The run's own resting voltage, so a load left on for one window is separable from the rest. */
    refUb: number | null,
    nearCompressor: (t: number) => boolean,
): IdleDwell | null {
    if (!idx.length) return null;
    const target = o.targetFromBinary ? tables.idleTargetNm : 0;
    const win = idx.map(i => samples[i]);
    const first = win[0];
    const last = win[win.length - 1];
    const durationSec = last.time - first.time;

    // Hard-clip against the binary's own clamps BEFORE any statistic. The 0x06 handler is a byte
    // copy and is not atomic, so a split word lands in the thousands at 0.1 Nm/LSB — one of those
    // in a mean is the whole dwell.
    const lli = win.map(s => s.mdLlri as number)
        .filter(v => v >= tables.mdLlriRange.min && v <= tables.mdLlriRange.max);
    const lla = win.map(s => (s.mdLlra ?? 0))
        .filter(v => v >= tables.mdLlriRange.min && v <= tables.mdLlriRange.max);
    if (!lli.length) return null;

    const tm = trimmedMean(lli);
    const md = median(lli);
    const adaptMean = lla.length ? trimmedMean(lla) : 0;
    const duties = win.map(s => s.llsTv).filter((v): v is number => v !== null);
    // The row KF_LLS_TV is indexed on. Trimmed like every other window statistic, because a split
    // RAM read lands here exactly as it lands on md_llri.
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
        ubDrift: ubs.length > 1 ? spread(ubs) : 0,
        ubOffset: refUb !== null && ubs.length ? Math.abs(trimmedMean(ubs) - refUb) : 0,
        nSollDrift: nSolls.length > 1 ? spread(nSolls) : 0,
        statDisagree: Math.abs(tm - md),
        error: tm + (o.useAdaptationSum ? adaptMean : 0) - target,
        rejected: null,
    };

    // Order matters, and it is cheapest-to-fix first — the same reporting choice
    // `lambdaGates.DropReason` documents. A driver told "hold it longer" can act on that; a driver
    // told "the integrator was railed" needs to fix the car first.
    const reject = (r: IdleRejectReason) => { dwell.rejected = r; };
    if (durationSec < o.dwellSec) reject('too-short');
    else if (win.length < o.minDwellSamples) reject('thin-count');
    else if (nearCompressor(first.time) || nearCompressor(last.time)) reject('compressor');
    else if (dwell.ubDrift > o.maxUbDriftV) reject('electrical-load');
    else if (dwell.ubOffset > o.maxUbDriftV) reject('electrical-load');
    else if (dwell.nSollDrift > o.maxNSollDriftRpm) reject('target-moving');
    // Cannot fire after settledTail has done its work — kept because it is the invariant that makes
    // the tail meaningful, and an invariant that is never checked is an invariant that quietly stops
    // holding.
    else if (dwell.errorDrift > o.maxMdLlriDriftNm) reject('integrator-drifting');
    else if (dwell.statDisagree > o.maxStatDisagreeNm) reject('unsteady');
    // Only in mode 2. With the sum in use, redistribution between the two stores is exactly what the
    // statistic is invariant to, so rejecting a window for it would throw away the evidence the
    // invariance was built to keep. Mode 2 has no such invariance — it relies on the adaptation
    // being frozen — so there it is the gate that makes the mode sound.
    else if (!o.useAdaptationSum && dwell.mdLlraDrift > o.maxAdaptDriftNm) reject('adaptation-moved');
    // The row has to exist before anything can be binned onto it.
    else if (dwell.mlSollLlsMean === null) reject('no-air-request');
    else if (railedRailFor(tables, tm, o.railToleranceNm) !== null) reject('integrator-railed');
    else if (dwell.llsTvMean !== null && isLimpDuty(tables, dwell.llsTvMean, o.railToleranceDutyPct)) reject('limp-branch');
    else if (dwell.llsTvMean !== null && dwell.llsTvMean >= tables.tvMax - o.railToleranceDutyPct) reject('duty-railed-high');
    else if (dwell.llsTvMean !== null && dwell.llsTvMean <= tables.tvMin + o.railToleranceDutyPct) reject('duty-railed-low');

    // THE MODEL GATE, last, and computed even on a dwell that already failed — a rejected window
    // whose duty still matches the map is evidence the chain is right, and that is the first
    // capture's real deliverable. See valveModel.ts for every way it can disagree.
    const agree = modelAgreement(
        tables.llsTv, dwell.rpmMean, dwell.mlSollLlsMean, dwell.llsTvMean, o.maxModelDeltaPct);
    dwell.modelDeltaPct = agree ? agree.delta : null;
    if (!dwell.rejected && agree && !agree.agrees) reject('model-disagrees');

    return dwell;
}

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
    // The warm gate comes from the BINARY — `K_LFR_TMOT_ADAPT`, the coolant above which adaptation
    // runs — with an explicit option still winning. See `IdleTables.adaptTmotC` for why 80 was wrong.
    const o = withDefaults({ minCoolantC: tables.adaptTmotC, ...opts });
    const hasLlBit = samples.some(s => s.engineState !== null);
    const hasCompressor = samples.some(s => s.kkosSt !== null);

    let limpSeen = false;
    let admitted = 0;

    // Times at which the compressor was seen engaged, so a window near one can be pushed out.
    const compressorTimes: number[] = [];
    for (const s of samples) {
        if (s.kkosSt !== null && (s.kkosSt & 0x01) !== 0) compressorTimes.push(s.time);
        /**
         * LIMP-HOME IS A STATE THE VALVE SITS IN, not a duty a run passes through.
         *
         * This scanned EVERY sample, and `isLimpDuty` is `|duty - 3.0| <= 1` or `|duty - 75.0| <= 1`.
         * On a log with any driving in it the valve sweeps the whole range as the throttle opens, so
         * it crosses 75 % every time — and one crossing set a flag that is fatal to the entire run.
         * Sessions #937 and #938 are ordinary drives with idles in them, their accepted dwells sat at
         * 35.8-36.4 % duty, and both were refused on the strength of a sample taken at 2400 rpm.
         *
         * So the scan is restricted to samples that are otherwise ADMISSIBLE — warm, settled, closed
         * throttle. A genuinely limp valve parks at a rail and stays there, so it is still caught at
         * idle, which is the only place the claim "the maps are not being consulted" means anything.
         * The per-dwell test on `llsTvMean` is unchanged and independent.
         */
        if (s.llsTv !== null && isLimpDuty(tables, s.llsTv, o.railToleranceDutyPct)
            && rejectSample(s, o, { hasLlBit, hasCompressor }) === null) limpSeen = true;
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

    const flush = (endIndex: number) => {
        if (!run.length) return;
        const full = run;
        run = [];
        const idx = settledTail(samples, full, o.maxMdLlriDriftNm, o.useAdaptationSum);
        const dwell = judgeWindow(samples, idx, endIndex, tables, o, refUb, nearCompressor);
        if (!dwell) return;
        if (dwell.rejected) rejects[dwell.rejected]++;
        dwells.push(dwell);
    };

    /**
     * A BRIEF EXCURSION DOES NOT END A WINDOW — it is left out of the statistics instead.
     *
     * Every rejection used to cut the run in two. Session #936 is 169 s of unbroken warm idle, and
     * 12 samples of ordinary governor wander — 832 to 921 rpm against an 870 target and a +/-25
     * gate — chopped it into EIGHT windows, five of which were then too short to count. Three
     * survived. A driver who held idle perfectly for three minutes was told most of it did not
     * happen.
     *
     * So a gap shorter than `maxExcursionSec` is skipped rather than flushed: those samples never
     * enter the dwell's statistics, and the window they sit inside stays one window. It is only
     * allowed for the two reasons that are not disturbances — the governor moving off target, which
     * is the governor doing its job, and a dropped RAM read, which is the link rather than the
     * engine. A blipped throttle or an A/C engagement still cuts, because those put air or load
     * into the engine and the window either side of them is a different steady state.
     *
     * Seconds, not samples, because the rate varies with the profile. 2.0 s is under half of
     * the ~5 s settle heuristic (not K_LFR_TAU_IA1 — see idle/bench.ts), and the whole-window drift
     * bound still applies either way — so this
     * decides whether to CUT, never whether the result is steady.
     */
    const bridgeable = new Set<IdleRejectReason>(['off-target', 'no-measurement']);
    let gapStart: number | null = null;

    samples.forEach((s, i) => {
        const why = rejectSample(s, o, { hasLlBit, hasCompressor });
        if (why) {
            rejects[why]++;
            if (!run.length || !bridgeable.has(why)) { flush(i - 1); gapStart = null; return; }
            if (gapStart === null) gapStart = s.time;
            if (s.time - gapStart > o.maxExcursionSec) { flush(i - 1); gapStart = null; }
            return;
        }
        gapStart = null;
        admitted++;
        run.push(i);
    });
    flush(samples.length - 1);

    return { dwells, admitted, limpSeen };
}

/**
 * The gain to REPORT, in the unit the correction is written in.
 *
 * Shared by the live census and the final tune, and that sharing is the point rather than tidiness.
 * It was `gain ?? o.gainKgHPerNm` in both, which printed 0.400 — the physics-bounded AIR gain,
 * (kg/h)/Nm, from when this wrote kg/h into a different map. The tuner has not used that number
 * alone since the retarget: every cell uses `slope * g_air`, about 1.0 %/Nm here. Fixing it in the
 * tune and not in the census left the WRONG number on the readout a driver watches while the car is
 * running, and the right one on the panel they read afterwards.
 *
 * Evaluated at the accepted dwells' own operating point, because that is where the slope is taken.
 * With nothing accepted there is no operating point and no honest conversion, so it falls back to
 * the raw constant — the only case where the old number is still the true answer, since no
 * correction is being derived at all.
 */
function reportedGain(
    accepted: readonly IdleDwell[],
    tables: IdleTables,
    o: IdleTuneOptions,
    override?: number,
): number {
    if (override !== undefined) return override;
    const w = accepted.reduce((a, d) => a + d.samples, 0);
    if (!accepted.length || w <= 0) return o.gainKgHPerNm;
    const rpm = accepted.reduce((a, d) => a + d.rpmMean * d.samples, 0) / w;
    const air = accepted.reduce((a, d) => a + (d.mlSollLlsMean ?? 0) * d.samples, 0) / w;
    const slope = llsTvSlopePctPerKgH(tables.llsTv, rpm, air);
    return slope !== null && slope > 0 ? slope * defaultGainKgHPerNm(rpm, o) : o.gainKgHPerNm;
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
    /** The campaign's learned gain, so the live readout names the number STOP will actually use. */
    gainOverride?: { gain: number; learned: boolean },
): IdleTuneReport & { dwells: IdleDwell[] } {
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
            gainUsed: gainOverride?.gain ?? o.gainKgHPerNm,
            gainLearned: !!gainOverride?.learned, source,
            dwells: [],
        };
    }

    const { dwells, admitted, limpSeen } = findDwells(samples, tables, opts, rejects);
    const accepted = dwells.filter(d => !d.rejected);
    return {
        /**
         * The windows themselves, alongside the counts.
         *
         * Additive rather than a second function: `findDwells` has already run by the time the
         * counts exist, and the picture needs the WINDOWS — where they sat in time, which ones were
         * kept — while the run is still going. Returning only the tally meant the live trace drew no
         * bands at all until STOP, so the one screen a driver watches for three minutes showed the
         * judgement of nothing. Every existing caller reads `IdleTuneReport` fields and is unaffected.
         */
        dwells,
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
        gainUsed: reportedGain(accepted, tables, o, gainOverride?.gain),
        gainLearned: !!gainOverride?.learned,
        source,
    };
}

// --- the tune -----------------------------------------------------------------------------------

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
    /**
     * `KF_LLS_TV`, and this line was the retarget's last loose end.
     *
     * The estimator moved to the live map in 2026-08; this call did not, so the proposal was being
     * quantised against `KF_LLR_QVS_GRUND`'s encoding — 8-bit `x/2`, 0.5 kg/h a step — while the
     * values it was rounding were 16-bit `x/50` duty per cent. Every proposal was rounded to the
     * wrong grid, by a factor of 25, in the units of a different quantity.
     *
     * It could not reach a byte (the seal, and a 13x10 array handed to a 5x6 writer throws), which
     * is the only reason it cost nothing. Named once, here, and used for both the quantisation and
     * the write — see useBinaryFile.
     */
    const def = findEcuItem('KF_LLS_TV');
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

    /**
     * WHICH CELLS A DWELL IS EVIDENCE FOR — the four the DME reads, not the one it is nearest.
     *
     * This car idles at 880 rpm and the axis has breakpoints at 800 and 950. There is no "the"
     * cell: `lls_tv_calc` reads a bilinear blend, measured here at
     *
     *          n=800   n=950
     *   ml=11  0.117   0.133
     *   ml=15  0.350   0.400
     *
     * The old code binned onto the NEAREST breakpoint and refused anything further than
     * `maxOffsetFrac` from it, which at 0.467 refused every dwell this car can produce —
     * `off-breakpoint`, on a car that cannot idle anywhere else. Loosening that tolerance would
     * have been the wrong fix twice over: writing the whole correction into the 950 cell moves the
     * operating point by only 0.400 of it, and drags the 950 breakpoint 2.5x further than the
     * physics asked for, bending the surface at an rpm the run never held.
     *
     * So a dwell contributes to every node it is read from, WITH ITS WEIGHT, and the correction is
     * divided among them in §4 of the doc. Nothing is invented for the other three: their weight IS
     * the evidence, and a node that only ever appears with weight 0.117 accumulates authority
     * accordingly.
     */
    interface Bin { dwells: IdleDwell[]; samples: number; weight: number }
    const bins = new Map<string, Bin>();
    /** Per dwell, the writable nodes and the normaliser `sum(w^2)` over them. */
    const dwellNodes = new Map<IdleDwell, { row: number; col: number; weight: number }[]>();

    /**
     * May a correction be written into this cell at all?
     *
     * Three exclusions, and each is a statement about what the evidence covers rather than caution:
     *
     *   col 0    the 500 rpm stall catch. Warm-idle evidence says nothing about it.
     *   row 0    y = 11.0 kg/h, which is a flat `K_LLS_TV_MIN` at every rpm. That row IS the
     *            calibration's declaration of where the valve stops having authority, and it is the
     *            floor this whole feature reasons from (`qvsAuthorityFloorKgH` is literally y[0]).
     *   row > 1  20 kg/h and up: a load a warm idle never held. Writing it from this evidence is
     *            the same mistake as writing a cold row from a warm measurement.
     */
    // Structural first, then the evidence. `writeColdRows` survives as the override that lifts the
    // second half — it is what `verify:idle` uses to exercise a row nothing measured.
    const warmRows = rowsWithWarmEvidence(tables.llsTv, accepted);
    const writableCell = (row: number, col: number): boolean =>
        isWritableCell(row, col, o) && (o.writeColdRows || warmRows.has(row));

    for (const d of accepted) {
        if (d.mlSollLlsMean === null) continue;   // already rejected; belt and braces
        const nodes = lookupNodes(tables.llsTv, d.rpmMean, d.mlSollLlsMean)
            .filter(n => writableCell(n.row, n.col));
        if (!nodes.length) continue;   // every corner is off-limits; the cell loop reports it
        dwellNodes.set(d, nodes);
        for (const n of nodes) {
            const key = `${n.row}:${n.col}`;
            const b = bins.get(key) ?? { dwells: [], samples: 0, weight: 0 };
            b.dwells.push(d);
            b.samples += d.samples;
            b.weight += n.weight;
            bins.set(key, b);
        }
    }

    /**
     * What this cell should move by, given every dwell that reads it.
     *
     * Minimum-norm distribution. For one dwell with writable nodes `W` and weights `w`, setting
     *
     *     s_i = s * w_i / sum_{j in W} w_j^2
     *
     * makes the change AT THE OPERATING POINT exactly `s`, because the DME computes
     * `sum_i w_i * s_i = s * sum w_i^2 / sum w_j^2`. It degenerates correctly at both ends: all the
     * weight on one node moves that node by `s` and nothing else; equal weights move every node by
     * `s`. Excluding the floor row costs nothing in exactness and shows up as amplification — at
     * this car's operating point `W` is the two 15 kg/h cells with weights 0.350 and 0.400, so
     * `sum w^2` is 0.2825 and the nodes move by 1.24x and 1.42x `s`. That is bounded by
     * `maxStepPct` per cell and reported, not hidden.
     *
     * Several dwells on one cell are pooled by dwell length, as before: a 90 s window says more
     * than a 20 s one.
     */
    const cellStepPct = (row: number, col: number, stepFor: (d: IdleDwell) => number): number => {
        const b = bins.get(`${row}:${col}`);
        if (!b) return 0;
        let num = 0;
        let den = 0;
        for (const d of b.dwells) {
            const nodes = dwellNodes.get(d);
            if (!nodes) continue;
            const norm = nodes.reduce((a, n) => a + n.weight * n.weight, 0);
            const mine = nodes.find(n => n.row === row && n.col === col);
            if (!mine || norm <= 0) continue;
            num += stepFor(d) * (mine.weight / norm) * d.samples;
            den += d.samples;
        }
        return den > 0 ? num / den : 0;
    };

    const gain = gainOverride?.gain;

    const gainShown = reportedGain(accepted, tables, o, gain);

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

        // The three exclusions, restated at the cell so each one is REPORTED rather than merely
        // skipped — the same predicate `writableCell` applies when the nodes are collected, so a
        // cell can never be fed evidence it is then refused for. See it for why each is excluded.
        if (!o.writeStallColumn && col === 0) return reject('stall-column');
        // The row IS the floor — flat `K_LLS_TV_MIN`, never a calibration. A structural exclusion
        // like the two around it, and it needs its own name: sharing `below-authority-floor` with
        // the real clamp below made the census say 'the request wanted to go under the floor' nine
        // times on every run there has ever been, about cells no request ever reached.
        if (row === 0) return reject('authority-floor-row');
        // Not "this row is cold" — "no warm dwell in this run reached this row". The test was
        // `row > 1`, an assumption about where warm idle sits that this car does not satisfy.
        if (!o.writeColdRows && !warmRows.has(row)) return reject('no-evidence');
        if (!b || !b.dwells.length) return reject('no-evidence');
        if (b.dwells.length < o.minCellDwells) return reject('single-dwell');
        if (b.samples < o.minCellSamples) return reject('thin-count');

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
         * Evaluated AT THE DWELL, not at the breakpoint, because that is where the measurement was
         * taken: this car idles between two rpm columns, and the slope is a property of the
         * operating point rather than of the cell the correction happens to land in.
         *
         * `gainOverride` still wins when a campaign has learned the combined figure, and it is in
         * %/Nm now: what the learner observes is duty written against error moved.
         */
        const stepForDwell = (d: IdleDwell): number => {
            const gAir = defaultGainKgHPerNm(d.rpmMean, o);
            const slope = llsTvSlopePctPerKgH(tables.llsTv, d.rpmMean, d.mlSollLlsMean ?? air);
            if (slope === null || !(slope > 0)) return 0;
            const g = gain ?? slope * gAir;
            // The whole correction the evidence asks for, and the damped step actually taken.
            const full = g * d.error;
            let step = Math.max(-o.maxStepPct, Math.min(o.maxStepPct, o.stepFraction * full));
            // stepFraction exists to stop an uncertain gain over-shooting. It must not be allowed to
            // stall the loop ABOVE the map's own resolution: halving a correction that is only two
            // steps large rounds it to nothing, and the cell reports itself converged while still
            // visibly wrong. So once the FULL correction clears one quantum, at least one quantum is
            // taken — damping the approach, never freezing it short. One raw step of this x/50 map
            // is 0.02 % of duty, so it almost never fires here; it is kept because it is the
            // invariant, not because this map needs it.
            const qm = tables.llsTvStepPct;
            if (Math.abs(step) < qm && Math.abs(full) >= qm) step = Math.sign(full) * qm;
            return step;
        };

        // What the evidence asks OF THIS CELL: each dwell's damped step, divided among the cells
        // that dwell is actually read from. See cellStepPct.
        const quantum = tables.llsTvStepPct;
        const distributed = cellStepPct(row, col, stepForDwell);
        // The per-cell cap applies to what is WRITTEN, after the distribution has amplified it.
        // Excluding the floor row raises each surviving node's share above the operating point's
        // own step (1.24x and 1.42x on this car), and maxStepPct is what bounds that.
        const step = Math.max(-o.maxStepPct, Math.min(o.maxStepPct, distributed));
        // Only for the convergence test below: the undamped correction at this cell, so a cell is
        // called converged when the EVIDENCE cannot ask for a representable change rather than when
        // this pass's damping happened to round to nothing.
        const full = o.stepFraction > 0 ? distributed / o.stepFraction : distributed;
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
        gainUsed: gainShown,
        gainLearned: !!gainOverride?.learned,
        source: sources.size === 0 ? 'none' : sources.size > 1 ? 'mixed' : [...sources][0] as 'ram' | 'block19',
    };

    // Every writable cell is within one step of where it wants to be — and at least one had enough
    // evidence to say so. "Nothing was measured" must not read as "converged".
    const writable = cells.flat().filter(c => !STRUCTURAL_EXCLUSIONS.has(c.rejected as IdleRejectReason));
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
