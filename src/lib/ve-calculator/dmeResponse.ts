import type { LogDataPoint } from '@/lib/types';
import { BinaryParser } from '@/lib/binary-engine/parser';
import { readResponseCalibration, type ResponseCalibration } from './rfResponseEvidence';

export const DME_RESPONSE_VERSION = 1;
/** Provisional comparison tolerances, not DME constants or a minimum time at one point. */
export const DME_RESPONSE_DEFAULTS = Object.freeze({ maxGapSec: 1.5, maxRpmRange: 500,
    maxLoadRange: 2.5, maxKRange: .02, maxCycleMeanDifference: .02, maxBankMeanDifference: .04 });
export type DmeCalibration = ResponseCalibration & { baOffPositive: number; baOffNegative: number };
/** 0401 slave 01ebea: BA bounds inhibit lambda; 01d6a2/01dc42 reset I and output on OFF. */
export function readDmeCalibration(base: ArrayBuffer | null): DmeCalibration | null {
    const c = readResponseCalibration(base);
    if (!c || !base) return null;
    try {
        const parser = new BinaryParser(base);
        const baOffPositive = parser.getUint16(0x484e) / 1024;
        const baOffNegative = parser.getUint16(0x4850) / 1024;
        return baOffPositive > 1 && baOffPositive < 2 && baOffNegative > 0 && baOffNegative < 1
            ? { ...c, baOffPositive, baOffNegative } : null;
    } catch { return null; }
}

export type DmeReason = 'calibration-unknown' | 'signals-unknown' | 'sample-gap' | 'excluded'
    | 'lambda-off' | 'ba-shutdown' | 'ba-active' | 'controller-reset' | 'rf-transition'
    | 'rf-timing-unknown' | 'operating-condition' | 'controller-clamp'
    | 'integrating-rich' | 'integrating-lean' | 'response-pending' | 'switches-unresolved'
    | 'trajectory-too-wide' | 'cycles-disagree' | 'cycle-candidate';
export interface DmeEvidence {
    version: number; reason: DmeReason; epoch: number;
    /** Actual read bracket, never an exact ECU timestamp or a reconstructed gate. */
    kApplied?: number; kRange?: [number, number];
    baShutdown?: boolean; resetObserved?: boolean;
    /** Only populated on a NEW completed pair of cycles in BOTH banks. No carried-forward vote. */
    trim?: number; bankTrim?: [number, number]; cycleStartIndex?: number;
    meanRpm?: number; meanLoad?: number;
}
export interface DmeOptions {
    calibration: DmeCalibration | null;
    secondsPerTimeUnit?: number;
    excludeTimeRanges?: ReadonlyArray<readonly [number, number]>;
    minCoolantTemp?: number;
    /** Acquisition / candidate-comparability bounds, not an ECU delay or required dwell. */
    maxGapSec?: number; maxRpmRange?: number; maxLoadRange?: number;
    maxKRange?: number; maxCycleMeanDifference?: number;
    maxBankMeanDifference?: number;
}
type Side = -1 | 1;
type Window = { start: number; end: number; mid: number };
type Frame = { index: number; time: number; rpm: number; load: number; k: number; lo: number; hi: number;
    trim: [number, number]; count: [number, number] };
type Bank = { side?: Side; turns: number[] };
const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const positive = (x: unknown): x is number => finite(x) && x > 0;
const byte = (x: unknown): x is number => finite(x) && Number.isInteger(x) && x >= 0 && x <= 255;
const unity = (v: number) => Math.abs(v - 1) < 0.5 / 1024;
function windowOf(mid: unknown, ms: unknown, row: number, previousRow: number | undefined): Window | null {
    if (!finite(mid) || !finite(ms) || ms < 0) return null;
    const start = mid - ms / 2000, end = mid + ms / 2000;
    return start >= 0 && end <= row + 1e-8 && (previousRow === undefined || start >= previousRow - 1e-8)
        ? { start, end, mid } : null;
}
function mean(frames: Frame[], field: (f: Frame) => number) {
    let area = 0;
    for (let i = 1; i < frames.length; i++) area += (field(frames[i-1]) + field(frames[i])) / 2 * (frames[i].time - frames[i-1].time);
    return area / (frames.at(-1)!.time - frames[0].time);
}

/** Causal, intact-RAW pass. No learned delay, fixed settle timer, invented AFR, or future row.
 * A candidate is a comparison under unchanged fuel/thermal calibration, NOT proven nominal VE.
 * Two observed cycles and P-counter agreement constrain aliasing; they cannot prove no hidden
 * switch or unlogged fuel term. Keep this route comparison-only until independently validated. */
export function annotateDmeResponse(raw: readonly LogDataPoint[], options: DmeOptions): LogDataPoint[] {
    const c = options.calibration, scale = options.secondsPerTimeUnit ?? 1;
    const gap = options.maxGapSec ?? DME_RESPONSE_DEFAULTS.maxGapSec, maxRpm = options.maxRpmRange ?? DME_RESPONSE_DEFAULTS.maxRpmRange;
    const maxLoad = options.maxLoadRange ?? DME_RESPONSE_DEFAULTS.maxLoadRange, maxK = options.maxKRange ?? DME_RESPONSE_DEFAULTS.maxKRange;
    const maxMean = options.maxCycleMeanDifference ?? DME_RESPONSE_DEFAULTS.maxCycleMeanDifference;
    const maxBankMean = options.maxBankMeanDifference ?? DME_RESPONSE_DEFAULTS.maxBankMeanDifference;
    let previousRow: number | undefined;
    let priorRf: { window: Window; value: number } | undefined;
    let priorFrame: Frame | undefined;
    let epoch = 0, frames: Frame[] = [], banks: [Bank, Bank] = [{ turns: [] }, { turns: [] }];
    let lastCandidateEnd = -1;
    const reset = () => { epoch++; frames = []; banks = [{ turns: [] }, { turns: [] }]; priorFrame = undefined; };
    const configValid = positive(scale) && positive(gap) && positive(maxRpm) && positive(maxLoad)
        && positive(maxK) && positive(maxMean) && positive(maxBankMean)
        && !!c && finite(c.richMv) && finite(c.leanMv) && c.richMv>c.leanMv && c.leanMv>0 && c.richMv<=1500
        && positive(c.trimMin) && c.trimMin<1 && finite(c.trimMax) && c.trimMax>1 && c.trimMax<2
        && positive(c.baOffNegative) && c.baOffNegative<1 && finite(c.baOffPositive) && c.baOffPositive>1 && c.baOffPositive<2
        && (!options.excludeTimeRanges || options.excludeTimeRanges.every(([a,b]) => finite(a) && finite(b) && b >= a));
    return raw.map((p, index) => {
        const out = (reason: DmeReason, extra: Partial<DmeEvidence> = {}): LogDataPoint => ({
            ...p, dmeResponse: { version: DME_RESPONSE_VERSION, reason, epoch, ...extra },
            veEvidenceEligible: reason === 'cycle-candidate', veEvidenceReason: reason,
            veSteadySeconds: 0,
        });
        const sec = p.time * scale, prevRow = previousRow;
        const ordered = finite(sec) && (prevRow === undefined || (sec > prevRow && sec-prevRow <= gap));
        previousRow = finite(sec) ? sec : undefined;
        if (!configValid || !c) { reset(); priorRf = undefined; return out('calibration-unknown'); }
        if (!ordered) { reset(); priorRf = undefined; return out('sample-gap'); }
        const lw = windowOf(p.lambdaReadTime, p.lambdaReadMs, sec, prevRow);
        const rw = windowOf(p.rfKorrDirectTime, p.rfKorrDirectReadMs, sec, prevRow);
        const sw = windowOf(p.standardReadTime, p.standardReadMs, sec, prevRow);
        const previousRf = priorRf;
        priorRf = rw && p.rfDirectSource === 'ram-0401-unverified' && positive(p.rfKorrDirect)
            ? { window: rw, value: p.rfKorrDirect } : undefined;
        if (!lw || !sw || !priorRf || p.lambdaReadSource !== 'ram-response-0401-unverified'
            || ![p.lambdaState1,p.lambdaState2,p.lambdaPSteps1,p.lambdaPSteps2].every(byte)
            || ![p.stft1,p.stft2,p.baFTi].every(positive)
            || ![p.o2Precat1Mv,p.o2Precat2Mv].every(v => finite(v) && v >= 0 && v <= 1500)) {
            reset(); return out('signals-unknown');
        }
        if (options.excludeTimeRanges?.some(([a,b]) => b>a && sec>=a*scale && (sec<b*scale || (prevRow!==undefined && prevRow<b*scale)))) {
            reset(); return out('excluded');
        }
        const shutdown = p.baFTi! > c.baOffPositive || p.baFTi! < c.baOffNegative;
        if (!(p.lambdaState1! & 1) || !(p.lambdaState2! & 1)) {
            reset(); return out(shutdown ? 'ba-shutdown' : 'lambda-off', { baShutdown: shutdown, resetObserved: true });
        }
        if (!unity(p.baFTi!)) { reset(); return out('ba-active', { baShutdown: shutdown }); }
        const load = p.correctedLoad ?? p.rawLoad;
        if (!positive(p.rpm) || !finite(load) || load<0 || !finite(p.coolantTemp)
            || p.coolantTemp < (options.minCoolantTemp ?? 65) || p.tankVent !== 0
            || p.ltft1 !== 1 || p.ltft2 !== 1) {
            reset(); return out('operating-condition');
        }
        if ([p.stft1!,p.stft2!].some(v => v<=c.trimMin+1/32768 || v>=c.trimMax-1/32768)) {
            reset(); return out('controller-clamp');
        }
        // The lambda read must be bracketed by two actual RF reads, including their durations.
        // Changed factors inside this bracket invalidate the point, rather than inventing onset.
        if (!previousRf || previousRf.window.end > lw.start || priorRf.window.start < lw.end
            || priorRf.window.mid-previousRf.window.mid > gap) {
            reset(); return out('rf-timing-unknown');
        }
        const lo = Math.min(previousRf.value,priorRf.value), hi = Math.max(previousRf.value,priorRf.value);
        if (unity(previousRf.value) !== unity(priorRf.value) || hi-lo>maxK) {
            reset(); return out('rf-transition', { kRange: [lo,hi] });
        }
        const k = (lo+hi)/2;
        const f: Frame = { index, time: lw.mid, rpm: p.rpm, load, k, lo, hi,
            trim: [p.stft1!,p.stft2!], count: [p.lambdaPSteps1!,p.lambdaPSteps2!] };
        const previous = priorFrame;
        if (previous && (f.time<=previous.time || f.time-previous.time>gap)) {
            reset(); return out('sample-gap');
        }
        if (previous && f.count.some((v,b) => v<previous.count[b])) {
            reset(); return out('controller-reset', { kApplied: k, kRange: [lo,hi], resetObserved: true });
        }
        priorFrame = f;
        frames.push(f);
        // A bank stuck on one side must not retain an unbounded drive while the other cycles.
        if (frames.length>2048) { reset(); return out('switches-unresolved'); }
        for (const b of [0,1] as const) {
            const mv = b ? p.o2Precat2Mv! : p.o2Precat1Mv!;
            const side: Side | undefined = mv>=c.richMv ? 1 : mv<=c.leanMv ? -1 : banks[b].side;
            if (side && banks[b].side && side !== banks[b].side) banks[b].turns.push(index);
            banks[b].side = side;
            if (banks[b].turns.length>5) banks[b].turns.shift();
        }
        // Keep a bounded observed trajectory. Long one-sided ramps earn no stationary estimate.
        const earliest = Math.min(...banks.map(b => b.turns[0] ?? index));
        frames = frames.filter(x => x.index>=earliest);
        const extra: Partial<DmeEvidence> = { kApplied: k, kRange: [lo,hi] };
        const integrating = previous && f.count.every((v,b) => v===previous.count[b]);
        const pending: DmeReason = integrating && banks.every(b=>b.side===1)
            && f.trim.every((v,b)=>v<previous!.trim[b]) ? 'integrating-rich'
            : integrating && banks.every(b=>b.side===-1) && f.trim.every((v,b)=>v>previous!.trim[b])
                ? 'integrating-lean' : 'response-pending';
        if (banks.some(b=>b.turns.length<5 || b.turns[4]<=lastCandidateEnd)) return out(pending,extra);
        const spans = banks.map(b => frames.filter(f=>f.index>=b.turns[0] && f.index<=b.turns[4]));
        if (spans.some((rr,b) => rr.length<5 || rr[0].count[b]===255 || rr.at(-1)!.count[b]===255
            || rr.at(-1)!.count[b]-rr[0].count[b]!==4)) return out('switches-unresolved',extra);
        const trajectory = frames.filter(f=>f.index>=Math.min(banks[0].turns[0],banks[1].turns[0]));
        const range = (fn: (f: Frame)=>number) => Math.max(...trajectory.map(fn))-Math.min(...trajectory.map(fn));
        const kLo = Math.min(...trajectory.map(f=>f.lo)), kHi = Math.max(...trajectory.map(f=>f.hi));
        if (range(f=>f.rpm)>maxRpm || range(f=>f.load)>maxLoad || kHi-kLo>maxK) return out('trajectory-too-wide',extra);
        const bankMeans = spans.map((rr,b) => {
            const mid = banks[b].turns[2];
            return [mean(rr.filter(f=>f.index<=mid),f=>f.trim[b]), mean(rr.filter(f=>f.index>=mid),f=>f.trim[b])];
        });
        if (bankMeans.some(m=>Math.abs(m[0]-m[1])>maxMean+1e-12)) return out('cycles-disagree',extra);
        const bankTrim = bankMeans.map(m=>(m[0]+m[1])/2) as [number,number];
        if (Math.abs(bankTrim[0]-bankTrim[1])>maxBankMean+1e-12) return out('cycles-disagree',extra);
        lastCandidateEnd = index;
        // Consume both cycles. Adjacent rows must never replicate this completed observation.
        banks.forEach(b=>{ b.turns=b.turns.slice(-1); });
        return out('cycle-candidate', { kApplied: mean(trajectory,f=>f.k), kRange: [kLo,kHi],
            bankTrim, trim: (bankTrim[0]+bankTrim[1])/2,
            meanRpm: mean(trajectory,f=>f.rpm), meanLoad: mean(trajectory,f=>f.load),
            cycleStartIndex: trajectory[0].index });
    });
}

export function summarizeDmeResponse(points: readonly LogDataPoint[]) {
    const reasons: Record<string,number> = {};
    for (const p of points) { const key=p.dmeResponse?.reason ?? 'signals-unknown'; reasons[key]=(reasons[key]??0)+1; }
    return { version: DME_RESPONSE_VERSION, comparisonBounds: DME_RESPONSE_DEFAULTS,
        total: points.length, candidates: reasons['cycle-candidate']??0, reasons };
}
