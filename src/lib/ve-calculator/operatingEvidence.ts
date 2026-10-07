import type { LogDataPoint, ProcessedLog, VEMap } from '@/lib/types';
import { interpolateFactor, timeScaleSeconds } from '@/lib/log-engine/filter';
import { APP_CONFIG } from '@/config/constants';
import { VECalculator, type VeCalcOptions } from './calculator';
import { annotateSteadyEvidence } from './steadyEvidence';
import { RfKorrLatch } from './egtTables';

/** Shared batch/live pass. Discarding raw rows before this pass would erase gate transitions. */
export function prepareOperatingEvidence(
    map: VEMap, processed: ProcessedLog, options: VeCalcOptions,
): LogDataPoint[] {
    const cfg = options.steadyFilterConfig;
    const table = options.steadyLoadTable ?? APP_CONFIG.MSS54HP.INTERPOLATION_TABLE;
    const timeline = processed.rawData.map((p, i) => {
        const factor = cfg?.enableCorrection ? interpolateFactor(p.rpm, table) : 1;
        return { ...p, rawSampleIndex: i, correctedLoad: p.rawLoad / (factor || 1) };
    });
    const calc = new VECalculator();
    const scale = timeScaleSeconds(timeline);
    let latch = new RfKorrLatch();
    let previousTime = -Infinity;
    // Index-aligned replay, never a timestamp Map: a reset clock may repeat an earlier time.
    const annotated = timeline.map(p => {
        if (!Number.isFinite(p.time) || p.time <= previousTime) latch = new RfKorrLatch();
        previousTime = p.time;
        const track = options.egt
            ? calc.stepRfKorrLatch(latch, map, p, options.egt, scale, options.rfKorrAir) : null;
        const point = calc.annotateRfKorrPoint(map, p, options.egt, options.rfKorrAir, track?.open ?? null);
        return point.rfKorrGateOpen && track ? { ...point, rfKorrDwellSec: track.dwellSec } : point;
    });
    const katsOn = cfg?.katsTabgOn ?? 850;
    const evidence = annotateSteadyEvidence(annotated, {
        lambdaLimits: options.steadyLambdaLimits ?? undefined,
        secondsPerTimeUnit: scale,
        minCoolantTemp: Math.max(65, cfg?.enableMinTemp ? cfg.minTemp : 65),
        katsTabgOn: katsOn,
        katsTabgOff: Math.min(cfg?.katsTabgOff ?? (katsOn - 10), katsOn),
        katsTailSec: cfg?.katsTailSec ?? 20,
        excludeTimeRanges: cfg?.excludeTimeRanges,
    });
    // Preserve the displayed/filtered array's order. Missing or uncheckable samples remain
    // visible, explicitly ineligible; they cannot fall through to a different correction.
    return processed.data.map(p => {
        const i = p.rawSampleIndex;
        const match = i === undefined ? undefined : evidence[i];
        return match?.time === p.time ? match : {
            ...p, veEvidenceEligible: false, veEvidenceReason: 'history-missing', veSteadySeconds: 0,
        };
    });
}
