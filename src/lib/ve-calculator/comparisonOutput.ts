import type { VEMap } from '@/lib/types';

/** Policy state covers a stale, previously computed map while a new calculation is pending.
 * The map tag covers a copied/archived candidate even after the current UI mode changes. Both
 * travel to the byte boundary; disabling a checkbox cannot withdraw an already armed write. */
export interface ComparisonOutputContext {
    comparisonOnly?: boolean;
}

export function isComparisonOnlyOutput(
    map: VEMap | null, context?: ComparisonOutputContext,
): boolean {
    return map?.calibrationStatus === 'comparison-only' || context?.comparisonOnly === true;
}

export function comparisonOnlyOutputMessage(lang: 'ja' | 'en'): string {
    return lang === 'ja'
        ? 'この計算は比較・検証専用です。独立した実車検証が済んでいないため、BIN の保存・ダウンロード・ECU 書き込みはできません。'
        : 'This calculation is for comparison and validation only. BIN saving, download and ECU writing are unavailable until independent vehicle validation is complete.';
}
