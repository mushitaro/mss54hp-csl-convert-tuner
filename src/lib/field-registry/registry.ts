import { LogDataPoint } from '@/lib/types';

/**
 * Registry of actual log DATA CHANNELS — values that are either logged/measured (rpm, rawLoad,
 * lambda, coolantTemp) or the direct corrected output (correctedLoad). It deliberately does NOT
 * include `correctionFactor`: that is an app-computed diagnostic derived per-row from the Alpha-N
 * interpolation table by RPM (see log-engine/filter.ts), not a channel that is logged or read from
 * the DME. It is rendered as a fixed computed column by LogDataTable rather than a toggleable field.
 */
export type FieldKey = 'rpm' | 'rawLoad' | 'correctedLoad' | 'lambda1' | 'lambda2' | 'coolantTemp';

export interface FieldMeta {
    key: FieldKey;
    label: string;
    unit: string;
    format: (value: number) => string;
    /** 'core' fields are always shown and cannot be hidden; 'optional' fields are user-toggleable. */
    relevance: 'core' | 'optional';
    /** Plotly y-axis this field is charted on, if it appears in LogTimeSeriesChart. */
    chartAxis?: 'y1' | 'y2' | 'y3';
    color?: string;
}

export const LOG_FIELD_REGISTRY: Record<FieldKey, FieldMeta> = {
    rpm: {
        key: 'rpm', label: 'RPM', unit: '', format: v => v.toFixed(0),
        relevance: 'core', chartAxis: 'y1', color: '#9A9AA8', // slate-400 (cool charcoal)
    },
    rawLoad: {
        key: 'rawLoad', label: 'Raw RO %', unit: '%', format: v => v.toFixed(2),
        relevance: 'core', chartAxis: 'y3', color: '#70707E', // slate-500 (cool charcoal)
    },
    correctedLoad: {
        key: 'correctedLoad', label: 'Corr. RO %', unit: '%', format: v => v.toFixed(2),
        relevance: 'core', chartAxis: 'y3', color: '#0A9BDB', // M-blue accent
    },
    lambda1: {
        key: 'lambda1', label: 'Lambda 1', unit: '', format: v => v.toFixed(3),
        relevance: 'optional', chartAxis: 'y2', color: '#4ade80',
    },
    lambda2: {
        key: 'lambda2', label: 'Lambda 2', unit: '', format: v => v.toFixed(3),
        relevance: 'optional', chartAxis: 'y2', color: '#86efac',
    },
    coolantTemp: {
        key: 'coolantTemp', label: 'Temp', unit: '°C', format: v => v.toFixed(1),
        relevance: 'optional', color: '#f59e0b',
    },
};

export const TOGGLEABLE_FIELDS: FieldKey[] = (Object.keys(LOG_FIELD_REGISTRY) as FieldKey[])
    .filter(key => LOG_FIELD_REGISTRY[key].relevance !== 'core');

export const DEFAULT_FIELD_VISIBILITY: Record<FieldKey, boolean> = {
    rpm: true, rawLoad: true, correctedLoad: true, lambda1: true, lambda2: true, coolantTemp: true,
};

/**
 * Whether a channel exists in this log SOURCE. Checked against the raw/full log — not the filtered
 * or windowed view — so the column set stays stable regardless of how many rows currently pass the
 * filters (e.g. engine-off logging where every row is filtered out still keeps its columns).
 */
export function isFieldPresent(key: FieldKey, data: LogDataPoint[]): boolean {
    if (LOG_FIELD_REGISTRY[key].relevance === 'core') return true;
    return data.length > 0 && data[0][key] !== undefined;
}
