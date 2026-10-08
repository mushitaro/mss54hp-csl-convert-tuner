import type { LogDataPoint, VEMap } from '@/lib/types';
import { timeScaleSeconds } from '@/lib/log-engine/filter';
import type { VeCalcOptions } from './calculator';
import { operatingEvidenceOptions, prepareOperatingTimeline } from './operatingEvidence';
import { annotateSteadyEvidence } from './steadyEvidence';

const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const reasons = (points: LogDataPoint[]) => {
    const counts: Record<string, number> = {};
    for (const p of points) if (!p.veEvidenceEligible) {
        const reason = p.veEvidenceReason ?? 'pending';
        counts[reason] = (counts[reason] ?? 0) + 1;
    }
    return Object.entries(counts).sort((a, b) => b[1] - a[1]);
};

/** Observation-only summary of the COMPLETE acquisition. Counterfactual purge bypass
 * never returns samples to the calculator, nor makes a calibration eligible. */
export function summarizeAcquisition(map: VEMap, raw: LogDataPoint[], options: VeCalcOptions) {
    const timeline = prepareOperatingTimeline(map, raw, options);
    const withoutPurge = annotateSteadyEvidence(timeline, {
        ...operatingEvidenceOptions(options, timeScaleSeconds(timeline)),
        purgeMaxMs: Number.MAX_VALUE,
    });
    const band = (low: number, high: number, includeHigh: boolean) => {
        const inside = (p: LogDataPoint) => p.rpm >= 2200 && p.rpm <= 2700
            && finite(p.correctedLoad) && p.correctedLoad >= low
            && (includeHigh ? p.correctedLoad <= high : p.correctedLoad < high);
        const points = timeline.filter(inside);
        const diagnostic = withoutPurge.filter(inside);
        return {
            total: points.length,
            steady: points.filter(p => p.veEvidenceEligible).length,
            neutral: points.filter(p => p.veEvidenceEligible && p.ltft1 === 1 && p.ltft2 === 1).length,
            purge: points.filter(p => finite(p.tankVent) && p.tankVent > 0).length,
            reasons: reasons(points),
            withoutPurgeSteady: diagnostic.filter(p => p.veEvidenceEligible).length,
            withoutPurgeReasons: reasons(diagnostic),
        };
    };
    return {
        total: raw.length,
        focus: band(7.5, 10, true), adjacent: band(5, 7.5, false),
        direct: {
            korr: raw.filter(p => finite(p.rfKorrDirect)).length,
            soll: raw.filter(p => finite(p.rfSollDirect)).length,
            map: raw.filter(p => finite(p.rfMapIntegratorDirect)).length,
        },
    };
}
