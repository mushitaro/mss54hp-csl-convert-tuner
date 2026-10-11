import type { LogDataPoint, VEMap } from '@/lib/types';
import { BinaryParser } from '@/lib/binary-engine/parser';
import { axisBracket } from '@/lib/log-engine/axisBracket';
import { readDmeCalibration, type DmeCalibration } from './dmeResponse';
import { readMovingResponseSensorCalibration, type MovingResponseSensorCalibration } from './movingResponseSensor';

/** 0401 slave 01d6a2/01dc42; I runs on the 10 ms task, P adds table byte * 16. */
export const CONTROLLER_GAIN_TABLES = Object.freeze({
    positiveP: 0x493e, negativeP: 0x497c, positiveI: 0x49ba, negativeI: 0x49f8,
});
export interface ControllerGains {
    positiveI: number; negativeI: number; positiveP: number; negativeP: number; tickSec: number;
}
export type MovingResponseCalibration = DmeCalibration & {
    gains: ControllerGains;
    sensor: MovingResponseSensorCalibration;
    /** Exact VE basis in this recording image; used to reject a TUNED map reused as BASE. */
    recordedVe: VEMap;
    /** KF_TI_N_RF, slave ti_load_factor: actual final RF, not RO, is the load axis. */
    tiStat: { rpm: number[]; rf: number[]; values: number[][] };
};
export interface ReadWindow { start: number; end: number; mid: number }
export interface ValueRange { lower: number; upper: number }
export interface CellShare { index: number; share: number }
export interface ControllerRead {
    window: ReadWindow; trim: [number, number]; count: [number, number]; active: [boolean, boolean];
    oxygenMv: [number, number]; ba: number;
}
export interface InjectionRead {
    window: ReadWindow; commandMs: [number, number]; trim: [number, number];
    actualBlank: number; targetBlank: number;
}
export interface MovingResponseFrame {
    /** Original RAW index is kept even when a read is missing. Never sort or compact the log. */
    index: number; time: number; segment: number;
    standard: { window: ReadWindow; rpm: number; load: number; shares: CellShare[] } | null;
    controller: ControllerRead | null;
    injection: InjectionRead | null;
    rfSoll: { window: ReadWindow; value: number } | null;
    rfKorr: { window: ReadWindow; value: number } | null;
    /** This limits O2 evidence, not the preceding physical fuel/air history. */
    evidenceReason: 'eligible' | 'excluded' | 'read-missing' | 'operating-condition' | 'lambda-off' | 'controller-clamp';
}
export interface MovingResponseInputOptions {
    calibration: MovingResponseCalibration;
    secondsPerTimeUnit?: number;
    maxGapSec?: number;
    minCoolantTemp?: number;
    excludeTimeRanges?: ReadonlyArray<readonly [number, number]>;
}
const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const positive = (x: unknown): x is number => finite(x) && x > 0;
const byte = (x: unknown): x is number => finite(x) && Number.isInteger(x) && x >= 0 && x <= 255;

/** Read maximum gains from this recording BIN, never from a remembered stock calibration. */
export function readMovingResponseCalibration(buffer: ArrayBuffer | null): MovingResponseCalibration | null {
    const c = readDmeCalibration(buffer);
    const sensor = readMovingResponseSensorCalibration(buffer);
    if (!c || !sensor || !buffer) return null;
    try {
        const p = new BinaryParser(buffer);
        const recordedVe = p.getVETable();
        if (!validMap(recordedVe)) return null;
        const maximum = (offset: number) => Math.max(...Array.from({ length: 36 }, (_, i) => p.getUint8(offset + i)));
        const tickSec = .01;
        const gains = {
            positiveI: maximum(CONTROLLER_GAIN_TABLES.positiveI) / 32768 / tickSec,
            negativeI: maximum(CONTROLLER_GAIN_TABLES.negativeI) / 32768 / tickSec,
            positiveP: maximum(CONTROLLER_GAIN_TABLES.positiveP) * 16 / 32768,
            negativeP: maximum(CONTROLLER_GAIN_TABLES.negativeP) * 16 / 32768, tickSec,
        };
        const tiStat = {
            rpm: Array.from({ length: 18 }, (_, i) => p.getUint16(0x08be + i*2)),
            rf: Array.from({ length: 12 }, (_, i) => p.getUint16(0x08e2 + i*2)/1000),
            values: Array.from({ length: 12 }, (_, y) => Array.from({ length: 18 }, (_, x) => p.getUint8(0x08fa + y*18+x)/128)),
        };
        if (![tiStat.rpm,tiStat.rf].every(a => a.every((v,i) => v >= 0 && (i === 0 || v > a[i-1])))
            || !tiStat.values.every(r => r.every(positive))) return null;
        return { ...c, gains, tiStat, sensor, recordedVe };
    } catch { return null; }
}

function validMap(map: VEMap) {
    return [map.xAxis, map.yAxis].every(a => a.length > 0 && a.every((v, i) => finite(v) && (i === 0 || v > a[i-1])))
        && map.data.length === map.yAxis.length
        && map.data.every(r => r.length === map.xAxis.length && r.every(positive));
}

/** The sensitivity of the interpolated BASE to multiplicative cell changes.
 * Bilinear hit weights alone are wrong when neighbouring BASE values differ. */
export function veCellContributions(map: VEMap, rpm: number, load: number): CellShare[] | null {
    if (!validMap(map)) return null;
    return cellContributions(map, rpm, load);
}
function cellContributions(map: VEMap, rpm: number, load: number): CellShare[] | null {
    const x = axisBracket(map.xAxis, rpm), y = axisBracket(map.yAxis, load);
    if (!x || !y) return null;
    const cells = new Map<number, number>();
    for (const [r, wy] of [[y.i0, 1-y.w1], [y.i1, y.w1]]) {
        for (const [c, wx] of [[x.i0, 1-x.w1], [x.i1, x.w1]]) {
            const v = wx * wy * map.data[r][c], index = r * map.xAxis.length + c;
            if (v > 0) cells.set(index, (cells.get(index) ?? 0) + v);
        }
    }
    const total = [...cells.values()].reduce((s, v) => s + v, 0);
    return positive(total) ? [...cells].map(([index, value]) => ({ index, share: value / total })) : null;
}

function readWindow(mid: unknown, ms: unknown, row: number, previous: number): ReadWindow | null {
    if (!finite(mid) || !finite(ms) || ms < 0) return null;
    const start = mid - ms / 2000, end = mid + ms / 2000;
    return start >= Math.max(0, previous) - 1e-8 && end <= row + 1e-8 ? { start, end, mid } : null;
}

/** Separates concurrent blocks without pretending the whole row was atomic. Missing
 * exchanges stay missing. OFF, acceleration and cut rows remain in the chronology. */
export function prepareMovingResponseInputs(
    map: VEMap, raw: readonly LogDataPoint[], options: MovingResponseInputOptions,
): MovingResponseFrame[] {
    const scale = options.secondsPerTimeUnit ?? 1, gap = options.maxGapSec ?? 1.5;
    if (!validMap(map) || !positive(scale) || !positive(gap)) throw new Error('Invalid moving-response map or clock');
    const c = options.calibration;
    let previous = -Infinity, segment = 0;
    return raw.map((p, index) => {
        const time = p.time * scale, ordered = finite(time) && time > previous;
        const continuous = ordered && time - previous <= gap;
        if (!continuous) segment++;
        const prior = ordered ? previous : -Infinity;
        previous = finite(time) ? time : -Infinity;
        const window = (t: unknown, ms: unknown) => ordered ? readWindow(t, ms, time, prior) : null;
        const sw = window(p.standardReadTime, p.standardReadMs);
        const lw = window(p.lambdaReadTime, p.lambdaReadMs);
        const iw = window(p.injectionReadTime, p.injectionReadMs);
        const kw = window(p.rfKorrDirectTime, p.rfKorrDirectReadMs);
        const rw = window(p.rfSollDirectTime, p.rfSollDirectReadMs);
        const load = p.correctedLoad ?? p.rawLoad;
        const shares = sw && positive(p.rpm) && finite(load) ? cellContributions(map, p.rpm, load) : null;
        const standard = shares ? { window: sw!, rpm: p.rpm, load, shares } : null;
        const controller: ControllerRead | null = lw && p.lambdaReadSource === 'ram-response-0401-unverified'
            && [p.stft1, p.stft2, p.baFTi].every(positive)
            && [p.lambdaPSteps1, p.lambdaPSteps2, p.lambdaState1, p.lambdaState2].every(byte)
            && [p.o2Precat1Mv, p.o2Precat2Mv].every(v => finite(v) && v >= 0 && v <= 1500)
            ? { window: lw, trim: [p.stft1!, p.stft2!], count: [p.lambdaPSteps1!, p.lambdaPSteps2!],
                active: [!!(p.lambdaState1! & 1), !!(p.lambdaState2! & 1)],
                oxygenMv: [p.o2Precat1Mv!, p.o2Precat2Mv!], ba: p.baFTi! } : null;
        const ti = [p.injection1Ms, p.injection2Ms, p.injection3Ms, p.injection4Ms, p.injection5Ms, p.injection6Ms];
        const injection: InjectionRead | null = iw && p.injectionReadSource === 'block19-0401-unverified'
            && ti.every(v => finite(v) && v >= 0) && [p.injectionStft1, p.injectionStft2].every(positive)
            && [p.injectionBlankActual, p.injectionBlankTarget].every(v => byte(v) && v <= 6)
            ? { window: iw, commandMs: [(ti[0]!+ti[1]!+ti[2]!)/3, (ti[3]!+ti[4]!+ti[5]!)/3],
                trim: [p.injectionStft1!, p.injectionStft2!], actualBlank: p.injectionBlankActual!,
                targetBlank: p.injectionBlankTarget! } : null;
        const rfSoll = rw && p.rfDirectSource === 'ram-0401-unverified' && positive(p.rfSollDirect)
            ? { window: rw, value: p.rfSollDirect } : null;
        const rfKorr = kw && p.rfDirectSource === 'ram-0401-unverified' && positive(p.rfKorrDirect)
            ? { window: kw, value: p.rfKorrDirect } : null;
        const excluded = options.excludeTimeRanges?.some(([a,b]) => b > a && time >= a*scale
            && (time < b*scale || prior < b*scale));
        let evidenceReason: MovingResponseFrame['evidenceReason'] = 'eligible';
        if (excluded) evidenceReason = 'excluded';
        else if (!standard || !controller || !rfSoll || !rfKorr) evidenceReason = 'read-missing';
        else if (!controller.active.every(Boolean)) evidenceReason = 'lambda-off';
        else if (controller.trim.some(v => v <= c.trimMin + 1/32768 || v >= c.trimMax - 1/32768)) evidenceReason = 'controller-clamp';
        else if (!finite(p.coolantTemp) || p.coolantTemp < (options.minCoolantTemp ?? 65)
            || p.tankVent !== 0 || p.ltft1 !== 1 || p.ltft2 !== 1 || controller.ba !== 1
            || (injection && (injection.actualBlank !== 0 || injection.targetBlank !== 0))) evidenceReason = 'operating-condition';
        return { index, time, segment, standard, controller, injection, rfSoll, rfKorr, evidenceReason };
    });
}

/** Reachable outer bound for one reset-free I/P interval. A linear STFT interpolation
 * can miss executed P jumps; here their unknown signs/times share the recorded budget. */
export function controllerTrimEnvelope(
    query: ReadWindow, before: { window: ReadWindow; trim: number }, after: { window: ReadWindow; trim: number },
    steps: number, gains: ControllerGains,
): ValueRange | null {
    const validWindow = (w: ReadWindow) => [w.start,w.mid,w.end].every(finite) && w.start <= w.mid && w.mid <= w.end;
    if (![query,before.window,after.window].every(validWindow) || !positive(before.trim) || !positive(after.trim)
        || !byte(steps) || steps === 255 || after.window.mid <= before.window.mid
        || !Object.values(gains).every(v => finite(v) && v >= 0)
        || query.start < before.window.end || query.end > after.window.start) return null;
    const elapsed = query.end - before.window.start + gains.tickSec;
    const remaining = after.window.end - query.start + gains.tickSec;
    const lower = Math.max(before.trim - gains.negativeI*elapsed - steps*gains.negativeP,
        after.trim - gains.positiveI*remaining - steps*gains.positiveP);
    const upper = Math.min(before.trim + gains.positiveI*elapsed + steps*gains.positiveP,
        after.trim + gains.negativeI*remaining + steps*gains.negativeP);
    return lower <= upper + 1e-12 ? { lower, upper } : null;
}

/** TI can remain nonzero during complete cylinder blanking. A partial count does
 * not identify which bank lost fuel, so it cannot yield a bank-resolved flux. */
export function injectionCommandFuelMs(read: InjectionRead): [number, number] | null {
    return read.actualBlank === 0 ? [...read.commandMs] : read.actualBlank === 6 ? [0, 0] : null;
}

/** Surround an acquisition window by complete lambda reads, walking intact RAW.
 * A missing read, OFF/reset, saturated counter, clamp or clock gap breaks the bound. */
export function reconstructMovingController(
    frames: readonly MovingResponseFrame[], query: ReadWindow, bank: 0 | 1,
    calibration: MovingResponseCalibration, options: { segment: number; maxGapSec?: number },
): ValueRange | null {
    const maxGapSec = options.maxGapSec ?? 1.5;
    let left = -1, right = -1;
    for (let i = 0; i < frames.length; i++) {
        if (frames[i].segment !== options.segment) continue;
        const c = frames[i].controller;
        if (c && c.window.end <= query.start) left = i;
        if (c && c.window.start >= query.end) { right = i; break; }
    }
    if (left < 0 || right <= left || !positive(maxGapSec)) return null;
    const first = frames[left], last = frames[right];
    let previous: ControllerRead | null = null;
    for (let i = left; i <= right; i++) {
        const f = frames[i], c = f.controller;
        if (f.segment !== first.segment || !c || !c.active[bank] || c.count[bank] === 255
            || c.trim[bank] <= calibration.trimMin + 1/32768 || c.trim[bank] >= calibration.trimMax - 1/32768
            || (previous && (c.count[bank] < previous.count[bank] || c.window.mid <= previous.window.mid
                || c.window.mid - previous.window.mid > maxGapSec))) return null;
        previous = c;
    }
    return controllerTrimEnvelope(query,
        { window: first.controller!.window, trim: first.controller!.trim[bank] },
        { window: last.controller!.window, trim: last.controller!.trim[bank] },
        last.controller!.count[bank]-first.controller!.count[bank], calibration.gains);
}
