import Papa from 'papaparse';
import { APP_CONFIG } from '@/config/constants';
import { LogDataPoint } from '@/lib/types';

type AliasKey = keyof typeof APP_CONFIG.CSV_ALIASES;

/**
 * First aliased header that carries a number on this row.
 *
 * Returns `undefined` rather than a default, because a missing column is information: the STFT
 * pair below and the whole EGT-correction path both branch on "was this channel physically
 * there", not on its value.
 */
const pick = (row: Record<string, unknown>, key: AliasKey): number | undefined => {
    for (const header of APP_CONFIG.CSV_ALIASES[key]) {
        const v = row[header];
        if (typeof v === 'number' && Number.isFinite(v)) return v;
    }
    return undefined;
};

/** Median of a sample, used only to decide a unit convention. See CSV_RF_FRACTION_THRESHOLD. */
const median = (values: number[]): number | null => {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
};

export const parseLogFile = (csvText: string): LogDataPoint[] => {
    const { data } = Papa.parse(csvText, {
        header: true,
        dynamicTyping: true,
        skipEmptyLines: true,
        delimiter: '', // Auto-detect delimiter (semicolon or comma)
        transformHeader: (h) => h.trim()
    });

    // Debug info
    if (data.length > 0) {
        console.log('CSV First Row Raw Keys:', Object.keys(data[0] as Record<string, unknown>));
        console.log('Full First Row:', data[0]);
    }

    // Normalize headers to lowercase to avoid case issues (Motor Temp vs temp).
    // CSV_ALIASES is lowercase for the same reason.
    const normalizedData = (data as Record<string, unknown>[]).map(row => {
        const newRow: Record<string, unknown> = {};
        Object.keys(row).forEach(k => {
            newRow[k.toLowerCase()] = row[k];
        });
        return newRow;
    });

    const results: LogDataPoint[] = [];

    for (const row of normalizedData) {
        const time = pick(row, 'time');
        const rpm = pick(row, 'rpm');
        if (time === undefined || rpm === undefined) continue;

        // [UPDATED] If missing, leave undefined. Do not default to 95.
        // The user intentionally wants to hide/skip temp if missing.
        const coolantTemp = pick(row, 'coolantTemp');

        // Handle Lambda Legacy: logic for 1 or 2 banks (STFT)
        const raw1 = pick(row, 'stft1');
        const raw2 = pick(row, 'stft2');

        // User Requirement: Use Lambda Integrator (STFT) values as "Lambda" for display.
        // HOWEVER, if the CSV only has 1 bank (STFT 1), STFT 2 is auto-filled with STFT 1 for
        // calculation safety. For DISPLAY (Lambda columns), the user wants to see "Empty" if
        // Bank 2 is missing, not a copy of Bank 1.
        let s1 = raw1;
        let s2 = raw2;
        if (s1 === undefined && s2 === undefined) {
            s1 = 1.0;
            s2 = 1.0;
        } else if (s1 === undefined) {
            s1 = s2;
        } else if (s2 === undefined) {
            s2 = s1;
        }

        const point: LogDataPoint = {
            time,
            rpm,
            rawLoad: pick(row, 'rawLoad') ?? 0,
            stft1: s1!, // Used for Calc (Auto-filled if missing)
            stft2: s2!, // Used for Calc (Auto-filled if missing)
            lambda1: raw1, // Display: Only if physically present
            lambda2: raw2, // Display: Only if physically present
            coolantTemp,
        };

        // The two EGT-correction channels. Both stay `undefined` unless the file really has them —
        // an empty alias list (which is how they ship until the headers are known) never matches,
        // and every consumer already handles their absence by falling back to the old behaviour.
        const rf = pick(row, 'rf');
        if (rf !== undefined) point.rf = rf;
        const exhaustTemp = pick(row, 'exhaustTemp');
        if (exhaustTemp !== undefined) point.exhaustTemp = exhaustTemp;

        results.push(point);
    }

    normalizeRfUnits(results);

    return results;
};

/**
 * Rescales a fraction-valued RF column to the percentage the rest of the app assumes.
 *
 * Decided once for the whole file rather than per row: RF genuinely does approach 0 at closed
 * throttle, so a per-row test would multiply the idle rows of a percentage log by 100 and leave
 * the rest alone, which is worse than either convention consistently applied. Rows at or below 0
 * are excluded from the vote for the same reason — they are common in both conventions and
 * distinguish nothing.
 */
const normalizeRfUnits = (points: LogDataPoint[]): void => {
    const observed = points.map(p => p.rf).filter((v): v is number => v !== undefined && v > 0);
    const mid = median(observed);
    if (mid === null || mid >= APP_CONFIG.CSV_RF_FRACTION_THRESHOLD) return;

    console.log(`[Parser] RF median ${mid.toFixed(3)} reads as a fraction; scaling the column by 100.`);
    for (const p of points) {
        if (p.rf !== undefined) p.rf *= 100;
    }
};
