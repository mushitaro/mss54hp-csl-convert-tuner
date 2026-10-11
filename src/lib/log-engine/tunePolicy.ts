import type { LogFilterConfig } from '@/lib/types';
import { DEFAULT_FILTER_CONFIG } from './filterDefaults';

/** A new drive must not inherit the estimator used to view a historical record. */
export function freshTuneFilterConfig(config: LogFilterConfig = DEFAULT_FILTER_CONFIG): LogFilterConfig {
    return { ...config, veCorrectionPolicy: 'moving-response' };
}

/**
 * Replaying a saved log preserves its derivation. Before the policy field existed,
 * the calculator used multiply-back, so missing history must never inherit the
 * current workspace's estimator or the new-work default.
 */
export function replayTuneFilterConfig(
    saved: LogFilterConfig | undefined,
    fallback: LogFilterConfig = DEFAULT_FILTER_CONFIG,
): LogFilterConfig {
    return { ...(saved ?? fallback), veCorrectionPolicy: saved?.veCorrectionPolicy ?? 'legacy-nominal' };
}
