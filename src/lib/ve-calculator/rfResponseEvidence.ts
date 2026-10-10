import { BinaryParser } from '@/lib/binary-engine/parser';
import { LAMBDA_SHUTDOWN } from '@/config/constants';
import { interpolateFactor } from '@/lib/log-engine/filter';
import type { LogDataPoint } from '@/lib/types';

export const RF_RESPONSE_ANALYSIS_VERSION = 1;
// 0401 slave calibration, catalog p:04820 / p:04822; word values already in mV.
export const O2_SWITCH_ADDRESSES = { rich: 0x4820, lean: 0x4822 } as const;
export type ResponseCalibration = { richMv: number; leanMv: number; trimMin: number; trimMax: number };

/** Thresholds belong to the supplied recording BIN. Missing/invalid BIN means no classification. */
export function readResponseCalibration(base: ArrayBuffer | null): ResponseCalibration | null {
    if (!base) return null;
    try {
        const parser = new BinaryParser(base);
        const c = {
            richMv: parser.getUint16(O2_SWITCH_ADDRESSES.rich),
            leanMv: parser.getUint16(O2_SWITCH_ADDRESSES.lean),
            trimMin: parser.getUint16(LAMBDA_SHUTDOWN.F_MIN) / 32768,
            trimMax: parser.getUint16(LAMBDA_SHUTDOWN.F_MAX) / 32768,
        };
        return validCalibration(c) ? c : null;
    } catch { return null; }
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const byte = (v: unknown): v is number => finite(v) && Number.isInteger(v) && v >= 0 && v <= 255;
const validCalibration = (c: ResponseCalibration | null): c is ResponseCalibration => !!c
    && Object.values(c).every(finite) && c.leanMv > 0 && c.richMv > c.leanMv && c.richMv <= 1500
    && c.trimMin > 0 && c.trimMin < 1 && c.trimMax > 1 && c.trimMax < 2;

type Window = { start: number; end: number; mid: number };
function windowOf(mid: unknown, ms: unknown, rowSec: number): Window | null {
    if (!finite(mid) || !finite(ms) || ms < 0 || !finite(rowSec)) return null;
    const start = mid - ms / 2000, end = mid + ms / 2000;
    // The row is stamped AFTER the exchanges. Permit floating-point roundoff only.
    return start >= -1e-8 && end <= rowSec + 1e-8 ? { start, end, mid } : null;
}

type Side = 'rich' | 'lean';
export interface ResponseEvent {
    kind: 'o2-reversal' | 'rf-departed-unity' | 'rf-returned-unity';
    bank?: 1 | 2;
    index: number;
    /** Bound between two observed read windows, not a fitted or exact ECU event time. */
    windowSec: [number, number];
    from: Side | number;
    to: Side | number;
}
export interface ResponsePass {
    startIndex: number; endIndex: number; startSec: number; endSec: number;
    points: number; completeRows: number; activeBoth: number;
    kMin: number | null; kMax: number | null;
    trimStart: [number | null, number | null]; trimEnd: [number | null, number | null];
    observedReversals: [number, number]; maxCaptureSpanMs: number | null;
}
export interface ResponseOptions {
    calibration: ResponseCalibration | null;
    secondsPerTimeUnit?: number;
    correctLoad?: boolean;
    loadTable?: { rpm: number; factor: number }[];
    /** Break observation history across a gap. Does not impose an operating-point dwell. */
    maxGapSec?: number;
}

/** Complete, chronological RAW log only. No filtering into a tune, no interpolation of
 * missing sensor values, no delay estimate and no inferred steady trim. A sampled
 * narrowband reversal is a lower bound on switches: faster cycles can be missed. */
export function summarizeRfResponse(raw: readonly LogDataPoint[], options: ResponseOptions) {
    const calibration = validCalibration(options.calibration) ? options.calibration : null;
    const scale = finite(options.secondsPerTimeUnit) && options.secondsPerTimeUnit > 0 ? options.secondsPerTimeUnit : 1;
    const maxGapSec = finite(options.maxGapSec) && options.maxGapSec > 0 ? options.maxGapSec : 1.5;
    const coverage = { total: raw.length, lambdaReads: 0, wideReads: 0, standardReads: 0, rfReads: 0,
        completeRows: 0, activeBoth: 0, baChanged: 0, discontinuities: 0 };
    const banks = [1, 2].map(() => ({ active: 0, off: 0, invalid: 0, rich: 0, lean: 0,
        unclassified: 0, nearClamp: 0, reversals: 0 }));
    const events: ResponseEvent[] = [], passes: ResponsePass[] = [];
    let pass: ResponsePass | null = null;
    let priorSec: number | null = null;
    let priorRf: { value: number; nonunity: boolean; window: Window } | null = null;
    let priorO2: ({ side: Side; window: Window } | null)[] = [null, null];
    let maxCaptureSpanMs: number | null = null;
    const gaps: number[] = [];
    const trim = (p: LogDataPoint): [number | null, number | null] =>
        [finite(p.stft1) ? p.stft1 : null, finite(p.stft2) ? p.stft2 : null];
    raw.forEach((p, index) => {
        const sec = p.time * scale;
        const previousRowSec = priorSec;
        const ordered = finite(sec) && (priorSec === null || (sec > priorSec && sec - priorSec <= maxGapSec));
        if (!ordered) {
            coverage.discontinuities++;
            priorRf = null; priorO2 = [null, null]; pass = null;
        }
        if (ordered && priorSec !== null) gaps.push(sec - priorSec);
        priorSec = finite(sec) ? sec : null;
        const freshWindow = (time: unknown, ms: unknown) => {
            const w = windowOf(time, ms, sec);
            return w && (!ordered || previousRowSec === null || w.start >= previousRowSec - 1e-8) ? w : null;
        };
        const lambdaWindow = freshWindow(p.lambdaReadTime, p.lambdaReadMs);
        const standardWindow = freshWindow(p.standardReadTime, p.standardReadMs);
        const rfWindow = freshWindow(p.rfKorrDirectTime, p.rfKorrDirectReadMs);
        const wide = !!lambdaWindow && p.lambdaReadSource === 'ram-response-0401-unverified';
        const rf = !!rfWindow && p.rfDirectSource === 'ram-0401-unverified'
            && finite(p.rfKorrDirect) && p.rfKorrDirect > 0;
        const sensorValid = [p.o2Precat1Mv, p.o2Precat2Mv].every(v => finite(v) && v >= 0 && v <= 1500);
        const stateValid = byte(p.lambdaState1) && byte(p.lambdaState2);
        const activeBoth = wide && stateValid && !!((p.lambdaState1! & 1) && (p.lambdaState2! & 1));
        const complete = wide && !!standardWindow && rf && sensorValid && stateValid
            && finite(p.baFTi) && p.baFTi > 0 && finite(p.stft1) && finite(p.stft2);
        if (lambdaWindow && p.lambdaReadSource) coverage.lambdaReads++;
        if (wide) coverage.wideReads++;
        if (standardWindow) coverage.standardReads++;
        if (rf) coverage.rfReads++;
        if (complete) coverage.completeRows++;
        if (activeBoth) coverage.activeBoth++;
        if (wide && finite(p.baFTi) && Math.abs(p.baFTi - 1) >= 0.5 / 1024) coverage.baChanged++;
        const span = complete ? (Math.max(lambdaWindow!.end, standardWindow!.end, rfWindow!.end)
            - Math.min(lambdaWindow!.start, standardWindow!.start, rfWindow!.start)) * 1000 : null;
        if (span !== null) maxCaptureSpanMs = Math.max(maxCaptureSpanMs ?? 0, span);

        const factor = options.correctLoad && options.loadTable?.length ? interpolateFactor(p.rpm, options.loadTable) : 1;
        // A requested correction with no table is unknown, not raw RO relabelled as corrected.
        const ro = options.correctLoad && !options.loadTable?.length ? NaN : p.rawLoad / factor;
        const focus = finite(sec) && finite(ro) && p.rpm >= 2200 && p.rpm <= 2700 && ro >= 7.5 && ro <= 10;
        if (!focus) pass = null;
        else {
            if (!pass) {
                pass = { startIndex: index, endIndex: index, startSec: sec, endSec: sec,
                    points: 0, completeRows: 0, activeBoth: 0, kMin: null, kMax: null,
                    trimStart: trim(p), trimEnd: trim(p), observedReversals: [0, 0], maxCaptureSpanMs: null };
                passes.push(pass);
            }
            pass.endIndex = index; pass.endSec = sec; pass.points++;
            pass.trimEnd = trim(p);
            if (complete) pass.completeRows++;
            if (activeBoth) pass.activeBoth++;
            if (rf) {
                pass.kMin = Math.min(pass.kMin ?? Infinity, p.rfKorrDirect!);
                pass.kMax = Math.max(pass.kMax ?? -Infinity, p.rfKorrDirect!);
            }
            if (span !== null) pass.maxCaptureSpanMs = Math.max(pass.maxCaptureSpanMs ?? 0, span);
        }

        const continuous = (previous: Window, current: Window) => ordered
            && current.mid > previous.mid && current.start >= previous.end && current.mid - previous.mid <= maxGapSec;
        if (rf) {
            const value = p.rfKorrDirect!, nonunity = Math.abs(value - 1) >= 0.5 / 1024;
            if (priorRf && continuous(priorRf.window, rfWindow!) && priorRf.nonunity !== nonunity) events.push({
                kind: nonunity ? 'rf-departed-unity' : 'rf-returned-unity', index,
                windowSec: [priorRf.window.start, rfWindow!.end], from: priorRf.value, to: value,
            });
            priorRf = { value, nonunity, window: rfWindow! };
        } else priorRf = null;

        for (const b of [0, 1] as const) {
            const state = b ? p.lambdaState2 : p.lambdaState1;
            const mv = b ? p.o2Precat2Mv : p.o2Precat1Mv;
            const stft = b ? p.stft2 : p.stft1;
            const bank = banks[b];
            if (!wide || !byte(state) || !finite(mv) || mv < 0 || mv > 1500) {
                bank.invalid++; priorO2[b] = null; continue;
            }
            if (!(state & 1)) { bank.off++; priorO2[b] = null; continue; }
            bank.active++;
            if (calibration && finite(stft)
                && (stft <= calibration.trimMin + 1 / 32768 || stft >= calibration.trimMax - 1 / 32768)) bank.nearClamp++;
            const previous = priorO2[b] && continuous(priorO2[b]!.window, lambdaWindow!) ? priorO2[b] : null;
            const side = !calibration ? null : mv >= calibration.richMv ? 'rich'
                : mv <= calibration.leanMv ? 'lean' : previous?.side ?? null;
            if (!side) { bank.unclassified++; priorO2[b] = null; continue; }
            bank[side]++;
            if (previous && previous.side !== side) {
                bank.reversals++;
                // A boundary reversal need not belong to a newly entered focus pass.
                if (pass && pass.startIndex < index) pass.observedReversals[b]++;
                events.push({ kind: 'o2-reversal', bank: (b + 1) as 1 | 2, index,
                    windowSec: [previous.window.start, lambdaWindow!.end], from: previous.side, to: side });
            }
            priorO2[b] = { side, window: lambdaWindow! };
        }
    });
    gaps.sort((a, b) => a - b);
    return {
        version: RF_RESPONSE_ANALYSIS_VERSION, observationOnly: true as const,
        coverage, banks, passes, events, maxCaptureSpanMs,
        medianSampleMs: gaps.length ? gaps[Math.floor(gaps.length / 2)] * 1000 : null,
        settings: { calibration, calibrationSource: calibration ? 'supplied-recording-bin' : null,
            secondsPerTimeUnit: scale, maxGapSec, correctLoad: !!options.correctLoad, loadTable: options.loadTable ?? null },
        limitations: ['unverified-0401-ram', 'narrowband-not-afr', 'sampled-switches-only',
            'transport-windows-not-ecu-timestamps', 'no-identified-delay-or-steady-trim', 'no-tune-output'],
    };
}
