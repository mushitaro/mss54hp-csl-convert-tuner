import type { LogDataPoint } from '@/lib/types';

/** Canonical CSV headers for raw response diagnostics. Values retain their native units;
 * rfSollDirect is a fraction even though the older RF column uses percent. */
export const DIAGNOSTIC_NUMERIC_COLUMNS = [
    'o2Precat1Mv',
    'o2Precat2Mv',
    'lambdaState1',
    'lambdaState2',
    'lambdaPSteps1',
    'lambdaPSteps2',
    'baFTi',
    'lambdaReadTime',
    'lambdaReadMs',
    'standardReadTime',
    'standardReadMs',
    'rfKorrDirect',
    'rfSollDirect',
    'rfMapIntegratorDirect',
    'rfKorrDirectTime',
    'rfSollDirectTime',
    'rfMapIntegratorDirectTime',
    'rfKorrDirectReadMs',
    'rfSollDirectReadMs',
    'rfMapIntegratorDirectReadMs',
] as const satisfies readonly (keyof LogDataPoint)[];

export const DIAGNOSTIC_SOURCE_COLUMNS = ['rfDirectSource', 'lambdaReadSource'] as const;

export function parseDiagnosticColumns(row: Record<string, unknown>, point: LogDataPoint): void {
    for (const key of DIAGNOSTIC_NUMERIC_COLUMNS) {
        const value = row[key.toLowerCase()];
        if (typeof value === 'number' && Number.isFinite(value)) point[key] = value;
    }
    if (row.rfdirectsource === 'ram-0401-unverified') point.rfDirectSource = row.rfdirectsource;
    const source = row.lambdareadsource;
    if (source === 'ram-trim' || source === 'block19' || source === 'ram-response-0401-unverified') {
        point.lambdaReadSource = source;
    }
}
