import { APP_CONFIG } from '@/config/constants';
import type { LogDataPoint, VEMap } from '@/lib/types';
import { interpolateFactor, timeScaleSeconds } from '@/lib/log-engine/filter';
import { isFullLoad } from '@/lib/log-engine/lambdaGates';
import type { VeCalcOptions } from './calculator';
import { prepareMovingResponseInputs, veCellContributions, type MovingResponseFrame } from './movingResponseInputs';
import { hasFreshBothThresholdCrossings, rawSignLookbackSeconds } from './movingResponseSensor';

/** Acquisition reasons, not the final estimator's acceptance or rejection. */
export type MovingLiveReason = 'calibration-held' | 'excluded' | 'read-missing' | 'injection-missing'
    | 'warming-up' | 'purge-active' | 'adaptation-active' | 'acceleration-active' | 'fuel-cut'
    | 'lambda-off' | 'controller-clamp' | 'unsupported-ti-stat' | 'oxygen-pending';
export interface MovingLiveCell {
    recorded: number;
    candidates: number;
    /** Independent visits to this cell with candidate observations, separated by >5 s. */
    passes: number;
    state: 'unvisited' | 'blocked' | 'collecting' | 'revisited';
    reasons: Partial<Record<MovingLiveReason, number>>;
}
export interface MovingLiveCoverage {
    cells: MovingLiveCell[][];
    observedRows: number;
    candidateRows: number;
}
export interface MovingLiveAccumulator extends MovingLiveCoverage {
    map: VEMap;
    options: VeCalcOptions;
    consumed: number;
    secondsPerTimeUnit: number;
    calibrationReady: boolean;
    lastCandidateTimes: number[][];
}

const labels: Record<MovingLiveReason, readonly [string, string]> = {
    'calibration-held': ['記録時BINの照合待ち', 'Recording BIN not verified'],
    excluded: ['除外時間帯', 'Excluded time range'],
    'read-missing': ['計測項目・時刻が不足', 'Required reading or timing missing'],
    'injection-missing': ['噴射指令の計測が不足', 'Injection command missing'],
    'warming-up': ['暖機中', 'Warming up'],
    'purge-active': ['パージ作動中', 'Purge active'],
    'adaptation-active': ['学習補正が作動中', 'Adaptation active'],
    'acceleration-active': ['加速補正が作動中', 'Acceleration correction active'],
    'fuel-cut': ['燃料カット・噴射停止', 'Fuel cut or injection stopped'],
    'lambda-off': ['空燃比制御が停止中', 'Lambda control inactive'],
    'controller-clamp': ['空燃比補正が上下限', 'Lambda correction at its limit'],
    'unsupported-ti-stat': ['噴射補正の別領域', 'Another injection correction region'],
    'oxygen-pending': ['空燃比の応答待ち', 'Waiting for oxygen response'],
};
export const movingLiveReasonLabel = (reason: MovingLiveReason, language: 'ja' | 'en' = 'ja'): string =>
    labels[reason][language === 'en' ? 1 : 0];

const emptyCell = (): MovingLiveCell => ({ recorded: 0, candidates: 0, passes: 0, state: 'unvisited', reasons: {} });

/** A separate census for LIVE: no estimator, worker, correction map or writable result. */
export function createMovingLiveAccumulator(map: VEMap, options: VeCalcOptions = {}): MovingLiveAccumulator {
    const cal = options.movingCalibration;
    const calibrationReady = !!cal && !!options.egt && options.steadyCalibrationHold === null
        && !options.writeRfKorr && !!options.steadyLambdaLimits
        && JSON.stringify([map.xAxis, map.yAxis, map.data])
            === JSON.stringify([cal.recordedVe.xAxis, cal.recordedVe.yAxis, cal.recordedVe.data]);
    return { map, options, consumed: 0, secondsPerTimeUnit: 1, calibrationReady,
        cells: map.yAxis.map(() => map.xAxis.map(emptyCell)), observedRows: 0, candidateRows: 0,
        lastCandidateTimes: map.yAxis.map(() => map.xAxis.map(() => -Infinity)) };
}

function corrected(p: LogDataPoint, index: number, options: VeCalcOptions): LogDataPoint {
    // Identical to the final worker's input route. A prior processed correctedLoad
    // is intentionally not reused after a filter/calibration change.
    const factor = options.steadyFilterConfig?.enableCorrection
        ? interpolateFactor(p.rpm, options.steadyLoadTable ?? APP_CONFIG.MSS54HP.INTERPOLATION_TABLE) : 1;
    return { ...p, rawSampleIndex: index, correctedLoad: factor > 0 ? p.rawLoad / factor : NaN };
}

function reasonFor(p: LogDataPoint, frame: MovingResponseFrame, previous: MovingResponseFrame | undefined,
    options: VeCalcOptions): MovingLiveReason | null {
    const c = frame.controller, cal = options.movingCalibration!;
    if (frame.evidenceReason === 'excluded') return 'excluded';
    if (!frame.standard || !c || !frame.rfSoll || !frame.rfKorr
        || ![p.coolantTemp, p.tankVent, p.ltft1, p.ltft2, p.vehicleSpeed, p.exhaustTemp].every(Number.isFinite)) return 'read-missing';
    if (!frame.injection) return 'injection-missing';
    if (p.coolantTemp! < (options.steadyFilterConfig?.minTemp ?? 65)) return 'warming-up';
    if (p.tankVent !== 0) return 'purge-active';
    if (p.ltft1 !== 1 || p.ltft2 !== 1) return 'adaptation-active';
    if (c.ba !== 1) return 'acceleration-active';
    if (frame.injection.actualBlank !== 0 || frame.injection.targetBlank !== 0
        || frame.injection.commandMs.some(v => v <= 0)) return 'fuel-cut';
    if (!c.active.every(Boolean)) return 'lambda-off';
    if (frame.evidenceReason === 'controller-clamp') return 'controller-clamp';
    if (p.llsSt === undefined || !Number.isFinite(p.wdk1)) return 'read-missing';
    if ((p.llsSt & 0x80) !== 0 || isFullLoad(options.steadyLambdaLimits!, p.wdk1, p.rpm, p.coolantTemp)) return 'unsupported-ti-stat';
    if (frame.evidenceReason !== 'eligible') return 'read-missing';
    // The final calculation handles each bank's O2 sign separately. A neutral
    // voltage on one bank must not conceal a valid point from the other bank.
    const pointSign = c.oxygenMv.some(mv => {
        const rich = mv >= cal.richMv;
        return (rich || mv <= cal.leanMv) && rawSignLookbackSeconds(mv, rich, cal.sensor) !== null;
    });
    const pc = previous?.controller;
    const freshCrossing = previous?.evidenceReason === 'eligible' && previous.segment === frame.segment && !!pc
        && c.window.mid - pc.window.mid <= 1.5
        && c.count.some((count, bank) => hasFreshBothThresholdCrossings(pc.count[bank], count))
        && [true, false].every(rich => rawSignLookbackSeconds(rich ? cal.richMv : cal.leanMv, rich, cal.sensor) !== null);
    return pointSign || freshCrossing ? null : 'oxygen-pending';
}

/** Consume only newly appended RAW rows. Two overlapping rows preserve the
 * acquisition windows and fresh P-transition check across append boundaries.
 * Every finite position is visible, including warm-up, OFF, cut and missing TI.
 * Candidate means a usable local observation was recorded. Transport, command
 * cones, both-bank support and held-out validation still run after STOP. */
export function appendMovingLive(acc: MovingLiveAccumulator, raw: readonly LogDataPoint[]): MovingLiveCoverage {
    const scale = timeScaleSeconds(raw as LogDataPoint[]);
    if (raw.length < acc.consumed || scale !== acc.secondsPerTimeUnit) {
        Object.assign(acc, createMovingLiveAccumulator(acc.map, acc.options));
        acc.secondsPerTimeUnit = scale;
    }
    const start = Math.max(0, acc.consumed - 2);
    const suffix = raw.slice(start).map((p, i) => corrected(p, start + i, acc.options));
    const frames = acc.calibrationReady ? prepareMovingResponseInputs(acc.map, suffix, {
        calibration: acc.options.movingCalibration!, secondsPerTimeUnit: scale,
        minCoolantTemp: acc.options.steadyFilterConfig?.minTemp ?? 65,
        excludeTimeRanges: acc.options.steadyFilterConfig?.excludeTimeRanges,
    }) : null;
    // Match the final estimator's eligibility override before fresh-crossing
    // checks, including an overlapping predecessor from the prior append.
    if (frames) for (let i = 0; i < frames.length; i++) {
        const p = suffix[i];
        if (p.llsSt === undefined || (p.llsSt & 0x80) !== 0 || !Number.isFinite(p.wdk1)
            || isFullLoad(acc.options.steadyLambdaLimits!, p.wdk1, p.rpm, p.coolantTemp)) {
            frames[i].evidenceReason = 'operating-condition';
        }
    }
    for (let index = acc.consumed; index < raw.length; index++) {
        const i = index - start, p = suffix[i];
        const shares = veCellContributions(acc.map, p.rpm, p.correctedLoad!);
        if (!shares?.length) continue;
        acc.observedRows++;
        const reason = frames ? reasonFor(p, frames[i], frames[i-1], acc.options) : 'calibration-held';
        if (reason === null) acc.candidateRows++;
        for (const share of shares) {
            if (share.share <= .001) continue;
            const r = Math.floor(share.index / acc.map.xAxis.length), c = share.index % acc.map.xAxis.length;
            const cell = acc.cells[r][c];
            cell.recorded++;
            if (reason !== null) cell.reasons[reason] = (cell.reasons[reason] ?? 0) + 1;
            else {
                cell.candidates++;
                const time = p.time * scale;
                if (time - acc.lastCandidateTimes[r][c] > 5) cell.passes++;
                acc.lastCandidateTimes[r][c] = time;
            }
            cell.state = cell.passes >= 2 ? 'revisited' : cell.candidates ? 'collecting' : 'blocked';
        }
    }
    acc.consumed = raw.length;
    // React callers keep previous snapshots. Do not mutate their cells later.
    return { cells: acc.cells.map(row => row.map(cell => ({ ...cell, reasons: { ...cell.reasons } }))),
        observedRows: acc.observedRows, candidateRows: acc.candidateRows };
}
