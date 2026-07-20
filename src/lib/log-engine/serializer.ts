import Papa from 'papaparse';
import { APP_CONFIG } from '@/config/constants';
import { LogDataPoint } from '@/lib/types';

/**
 * Writes a log back out as the Testo-style CSV parseLogFile reads, so an exported log re-imports to
 * the same data it was exported from.
 *
 * Optional columns are emitted only if the source actually had them. That matters because the parser
 * treats a *missing* column as information: with no Lambdaintegrator 2 it copies bank 1 into stft2
 * for the calculation but leaves lambda2 undefined, which is why lambda1/lambda2 — not stft1/stft2 —
 * are what say whether a column was physically there. Writing the filled-in stft values back would
 * hand a re-import two banks where the original had one.
 *
 * Only source columns are written. correctedLoad is derived from rawLoad by the app and the parser
 * ignores it, so exporting it would just be a column that reads back as nothing.
 */
export const serializeLogFile = (points: LogDataPoint[]): string => {
    const M = APP_CONFIG.CSV_MAPPING;

    const hasBank1 = points.some(p => p.lambda1 !== undefined);
    const hasBank2 = points.some(p => p.lambda2 !== undefined);
    const hasTemp = points.some(p => p.coolantTemp !== undefined);

    const rows = points.map(p => {
        const row: Record<string, number | string> = {
            [M.TIME]: p.time,
            [M.RPM]: p.rpm,
            [M.RAW_LOAD]: p.rawLoad,
        };
        if (hasBank1) row[M.STFT_1] = p.lambda1 ?? '';
        if (hasBank2) row[M.STFT_2] = p.lambda2 ?? '';
        if (hasTemp) row[M.COOLANT_TEMP] = p.coolantTemp ?? '';
        return row;
    });

    return Papa.unparse(rows, { delimiter: APP_CONFIG.CSV_DELIMITER });
};
