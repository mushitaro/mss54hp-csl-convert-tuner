import { LogDataPoint } from '@/lib/types';

/**
 * Registry of actual log DATA CHANNELS — values that are either logged/measured (rpm, rawLoad,
 * lambda, coolantTemp) or the direct corrected output (correctedLoad). It deliberately does NOT
 * include `correctionFactor`: that is an app-computed diagnostic derived per-row from the Alpha-N
 * interpolation table by RPM (see log-engine/filter.ts), not a channel that is logged or read from
 * the DME. It is rendered as a fixed computed column by LogDataTable rather than a toggleable field.
 */
export type FieldKey =
    | 'rpm' | 'rawLoad' | 'correctedLoad' | 'lambda1' | 'lambda2' | 'coolantTemp'
    // Read out of the same DS2 block as rpm/tmot/aq_rel, so they cost nothing extra to log.
    // `rfKorr` is the one derived member of the set — see calculator.ts for how it is measured.
    | 'exhaustTemp' | 'rf' | 'rfKorr'
    // The cross-check pair: each of the two measured channels above, re-derived from the OTHER
    // one through the DME's own tables. Instruments, not data — they exist to be laid against
    // their measured counterparts, and a residual is what they are for.
    | 'egtFromRfKorr' | 'rfKorrFromEgt'
    // Tank ventilation, out of the same block as the lambda pair. Not a tuning input — a
    // credibility check ON the tuning input, since purge moves the trims these channels sit
    // beside. See LogDataPoint for why that matters.
    | 'tankVent' | 'tankVentCheckState' | 'tankVentDiag';

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
    // Plotly and the table's inline styles never see Tailwind tokens, so these are literals. They
    // are still M-palette steps: the lambda pair takes the two violet steps ABOVE the Factor
    // column's #9B84E8, which shares the table's header row with them and has to stay separable.
    lambda1: {
        key: 'lambda1', label: 'Lambda 1', unit: '', format: v => v.toFixed(3),
        relevance: 'optional', chartAxis: 'y2', color: '#B9A6EE', // M-violet 300 (9.8:1)
    },
    lambda2: {
        key: 'lambda2', label: 'Lambda 2', unit: '', format: v => v.toFixed(3),
        relevance: 'optional', chartAxis: 'y2', color: '#CBBCF2', // lighter + dashed = 2nd sensor
    },
    coolantTemp: {
        key: 'coolantTemp', label: 'Temp', unit: '°C', format: v => v.toFixed(1),
        // Never charted (no chartAxis) — this only colors the table column and the live TEMP cell,
        // so it can hold the warm end of the M-red ramp without competing with a plotted series.
        relevance: 'optional', color: '#F87A7F', // M-red 300 (8.1:1)
    },
    exhaustTemp: {
        // The DME sends this at 16 °C per count, so a decimal place would be a lie about precision.
        key: 'exhaustTemp', label: 'EGT', unit: '°C', format: v => v.toFixed(0),
        // Shares y1 with RPM: both are large-magnitude, and keeping EGT off the lambda axis stops
        // it flattening the ~1.0 traces that matter most there.
        relevance: 'optional', chartAxis: 'y1', color: '#F64A50', // M-red 400 — hotter step than Temp's 300
    },
    rf: {
        key: 'rf', label: 'RF', unit: '%', format: v => v.toFixed(1),
        // Blue like the other fill/load channels, one step lighter than correctedLoad's 500 so the
        // pair reads as "same family, this one is the DME's own number".
        relevance: 'optional', chartAxis: 'y3', color: '#6CCBEF', // M-blue 300
    },
    rfKorr: {
        key: 'rfKorr', label: 'RF KORR', unit: '', format: v => v.toFixed(3),
        // Violet = derived diagnostic, per globals.css. One step darker than the Factor column's
        // #9B84E8 so the two never collide in the same table row.
        relevance: 'optional', chartAxis: 'y2', color: '#7E63DB', // M-violet (amber-600 alias)
    },
    // The cross-check pair. Each sits on its measured counterpart's axis, one violet step apart
    // from it, so a residual reads as a gap between two adjacent lines rather than as two
    // unrelated traces. Charted dashed — see LogTimeSeriesChart.
    egtFromRfKorr: {
        // No decimal, matching EGT: the sensor it is compared against arrives at 16 °C per count,
        // and claiming more resolution than the reference would misstate what the residual means.
        key: 'egtFromRfKorr', label: 'EGT (RF KORR)', unit: '°C', format: v => v.toFixed(0),
        relevance: 'optional', chartAxis: 'y1', color: '#B9A6EE', // M-violet 300
    },
    rfKorrFromEgt: {
        key: 'rfKorrFromEgt', label: 'RF KORR (EGT)', unit: '', format: v => v.toFixed(3),
        relevance: 'optional', chartAxis: 'y2', color: '#CBBCF2', // M-violet 200
    },
    tankVent: {
        key: 'tankVent', label: 'TANK VENT', unit: 'ms', format: v => v.toFixed(2),
        // On y2 with the lambda traces on purpose: purge duty is only interesting laid directly
        // against the trims it is disturbing, and the whole reason to log it is to see the two
        // move together. Amber because it is a warning channel, not a measurement — nothing else
        // in the registry uses that hue.
        relevance: 'optional', chartAxis: 'y2', color: '#F0A020',
    },
    tankVentCheckState: {
        key: 'tankVentCheckState', label: 'TEFC ST', unit: '', format: v => v.toFixed(0),
        // A state number, so it is charted as a step on the lambda axis where its range (0-0x15)
        // sits close enough to be readable beside a 1.0 trim without its own scale.
        relevance: 'optional', chartAxis: 'y2', color: '#C77A10',
    },
    tankVentDiag: {
        key: 'tankVentDiag', label: 'TEFC ED', unit: '', format: v => v.toFixed(0),
        // Never charted. It is a fault handle: what matters is whether it is non-zero, which the
        // table says better than a flat line at 0 says it.
        relevance: 'optional', color: '#A05E0C',
    },
};

export const TOGGLEABLE_FIELDS: FieldKey[] = (Object.keys(LOG_FIELD_REGISTRY) as FieldKey[])
    .filter(key => LOG_FIELD_REGISTRY[key].relevance !== 'core');

export const DEFAULT_FIELD_VISIBILITY: Record<FieldKey, boolean> = {
    rpm: true, rawLoad: true, correctedLoad: true, lambda1: true, lambda2: true, coolantTemp: true,
    // On by default: the whole point of reading them is that the EGT correction is invisible
    // otherwise. They still only appear when the log actually carries them (isFieldPresent).
    exhaustTemp: true, rf: true, rfKorr: true,
    // Off by default, unlike the pair above. These are verification instruments rather than
    // channels: EGT (RF KORR) is blank on most rows by construction (only ~45 % of the rpm axis
    // has an invertible correction profile), and a mostly-empty column shown by default reads as
    // a broken feature. Turn them on when checking a log against the DME, not while tuning.
    egtFromRfKorr: false, rfKorrFromEgt: false,
    // Purge duty is ON by default wherever the log carries it, for the same reason EGT and RF are:
    // the failure it describes is invisible otherwise, and a run spoiled by tank ventilation looks
    // exactly like a run that simply disagrees with the last one. The two TEFC state bytes stay
    // off — they answer a question you go looking for (did the functional check run? did the valve
    // fault?) rather than one you want on screen while driving.
    tankVent: true, tankVentCheckState: false, tankVentDiag: false,
};

/** For a derived channel, the logged channel whose presence decides whether the column belongs. */
const PRESENCE_PROBE: Partial<Record<FieldKey, FieldKey>> = {
    rfKorr: 'rf',
    egtFromRfKorr: 'rf',
    rfKorrFromEgt: 'exhaustTemp',
};

/**
 * Whether a channel exists in this log SOURCE. Checked against the raw/full log — not the filtered
 * or windowed view — so the column set stays stable regardless of how many rows currently pass the
 * filters (e.g. engine-off logging where every row is filtered out still keeps its columns).
 */
export function isFieldPresent(key: FieldKey, data: LogDataPoint[]): boolean {
    if (LOG_FIELD_REGISTRY[key].relevance === 'core') return true;
    // Scan rather than test row 0 alone. `rfKorr` is derived per row and is legitimately absent on
    // some of them (an Alpha-N interpolation of 0 leaves it undefined), so a row-0 test would hide
    // a column the log really does carry. Capped because this runs on the full unfiltered log:
    // 2000 rows is the same window LogTimeSeriesChart plots, and a channel that appears only after
    // that is a broken log, not a column worth revealing.
    // The derived channels are all measured during the VE calculation, so they are absent from
    // the RAW log this is normally asked about. Their real precondition is the channel each is
    // derived from: if the log carries that, the column belongs, and the rows fill in as soon as
    // a calculation runs. rfKorrFromEgt probes exhaustTemp rather than rf because the sensor is
    // the scarce half of that pair — rf alone cannot produce it.
    const probe = PRESENCE_PROBE[key] ?? key;
    const limit = Math.min(data.length, 2000);
    for (let i = 0; i < limit; i++) {
        if (data[i][probe] !== undefined) return true;
    }
    return false;
}
