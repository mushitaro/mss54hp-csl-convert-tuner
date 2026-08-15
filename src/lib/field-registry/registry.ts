// `import type`, not a plain import: this module is loaded directly by verify:field-registry under
// Node's type stripping, which erases annotations but cannot know that a value import resolves to a
// type-only export. The distinction is real anyway — nothing here uses LogDataPoint at runtime.
import type { LogDataPoint } from '@/lib/types';

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
    | 'exhaustTemp' | 'rf' | 'wdk1' | 'rfKorr'
    // The cross-check pair: each of the two measured channels above, re-derived from the OTHER
    // one through the DME's own tables. Instruments, not data — they exist to be laid against
    // their measured counterparts, and a residual is what they are for.
    | 'egtFromRfKorr' | 'rfKorrFromEgt'
    // Tank ventilation, out of the same block as the lambda pair. Not a tuning input — a
    // credibility check ON the tuning input, since purge moves the trims these channels sit
    // beside. See LogDataPoint for why that matters.
    | 'tankVent' | 'tankVentCheckState' | 'tankVentDiag'
    // Same block again, and deliberately NOT a gate — see its entry below.
    | 'lambdaFreeze';

/** Where a number came from: a DS2 block and byte offset, or this app's own arithmetic. */
export type FieldSource = { selection: number; offset: number } | 'derived';

export interface FieldMeta {
    key: FieldKey;
    /**
     * What the screen shows — and the rule is not cosmetic.
     *
     * For a channel the DME sent, this is the DME's own symbol, lowercase, spelled exactly as the
     * reference tool spells it (`la_f_regler1`, `aq_rel`, `tabg`). That convention comes from
     * karter16's `LiveValueRow`, which shows Symbol as the identifier and keeps the English
     * description beside it — and adopting it means a column here, a row in his tool and a line in
     * the Funktionsrahmen are all obviously the same quantity.
     *
     * For a number this app COMPUTED, it is a plain name and never a DME symbol. That distinction is
     * the whole point: `Lambda 1` used to head a column carrying `la_f_regler`, the lambda
     * controller's output factor, which is not a measured lambda at all. A label that claims to be
     * something the ECU said had better be something the ECU said.
     */
    symbol: string;
    /** The human-readable description, shown on hover. Same split as the reference tool's
     *  Symbol / Name pair. */
    name: string;
    /** Which DS2 block and byte this arrived in, so a channel on screen can be traced to the wire —
     *  and so the cost of having it is visible: fields sharing a selection are free once one of them
     *  is being read, and a new selection is a whole extra round trip. */
    source: FieldSource;
    unit: string;
    format: (value: number) => string;
    /** 'core' fields are always shown and cannot be hidden; 'optional' fields are user-toggleable. */
    relevance: 'core' | 'optional';
    /** Plotly y-axis this field is charted on, if it appears in LogTimeSeriesChart. */
    chartAxis?: 'y1' | 'y2' | 'y3';
    color?: string;
}

/**
 * `"13:la_f_regler1"` — selection in hex, then the symbol.
 *
 * Byte-for-byte the format of the reference tool's `LiveValueKeys.Create(selection, symbol)`, so a
 * log-set saved there and one saved here name the same channels. Computed fields get `calc:` in
 * place of a selection, because they have no selection to name and pretending otherwise would put
 * a wire address on something that never crossed the wire.
 */
/**
 * The hover text for a channel: what it is, and where it came from.
 *
 * The provenance half is not decoration. A symbol on its own cannot tell you whether having this
 * column costs a round trip, and that is the question the whole rate discussion turns on — two
 * channels sharing a selection are free together, a third selection is another exchange.
 */
export function describeField(meta: FieldMeta): string {
    return meta.source === 'derived'
        ? `${meta.name}\nComputed by this app — the DME never sent this.`
        : `${meta.name}\nDS2 selection 0x${meta.source.selection.toString(16).toUpperCase().padStart(2, '0')}`
        + `, payload offset ${meta.source.offset}`;
}

export function fieldValueKey(meta: FieldMeta): string {
    return meta.source === 'derived'
        ? `calc:${meta.symbol}`
        : `${meta.source.selection.toString(16).toUpperCase().padStart(2, '0')}:${meta.symbol}`;
}

export const LOG_FIELD_REGISTRY: Record<FieldKey, FieldMeta> = {
    rpm: {
        key: 'rpm', symbol: 'n', name: 'Engine speed', source: { selection: 3, offset: 0 },
        unit: 'rpm', format: v => v.toFixed(0),
        relevance: 'core', chartAxis: 'y1', color: '#9A9AA8', // slate-400 (cool charcoal)
    },
    rawLoad: {
        key: 'rawLoad', symbol: 'aq_rel', name: 'Relative opening cross-section',
        source: { selection: 3, offset: 20 }, unit: '%', format: v => v.toFixed(2),
        relevance: 'core', chartAxis: 'y3', color: '#70707E', // slate-500 (cool charcoal)
    },
    // Derived, so a plain name rather than a DME symbol. `aq_rel` corrected by the Alpha-N
    // interpolation table — see log-engine/filter.ts. The DME never sends this quantity.
    correctedLoad: {
        key: 'correctedLoad', symbol: 'Corr. RO', name: 'Corrected relative opening (Alpha-N)',
        source: 'derived', unit: '%', format: v => v.toFixed(2),
        relevance: 'core', chartAxis: 'y3', color: '#0A9BDB', // M-blue accent
    },
    // Plotly and the table's inline styles never see Tailwind tokens, so these are literals. They
    // are still M-palette steps: the lambda pair takes the two violet steps ABOVE the Factor
    // column's #9B84E8, which shares the table's header row with them and has to stay separable.
    /**
     * `la_f_regler1/2` — and the old label, "Lambda 1", was wrong in a way worth spelling out.
     *
     * Funktionsrahmen 5.01 (module LA, p5 and p11): the lambda controller is a two-point controller
     * of the PITV type — a PI controller with a one-sided delay — whose control variable is
     * `f_lax = 1.0 + f_la_kp + f_la_ki`. The DS2 channel carries `f_la1/2`, "Lambda controller factor
     * (control variable)". So it is neither a measured lambda (which is what "Lambda 1" promises)
     * nor, strictly, an integrator (which is what Testo's "Lambdaintegrator" promises — the actual
     * integrator is `f_la_ki`, one of its two terms). It is the whole multiplicative short-term
     * trim, which is why this app's arithmetic treats it as STFT and pairs it with `laa_f` as LTFT.
     *
     * Two consequences the name should keep in view. Because the controller is two-point, this
     * channel OSCILLATES by construction — the P term jumps by +/-`la_kp` at every sensor crossing —
     * so one sample is a point on a limit cycle, not "the trim". The DME low-passes it (`laa_regx`,
     * time constant `K_LAA_TAU`) before adapting, and the VE calculation averages it per cell for
     * the same reason. And the cycle runs at roughly 1-2 Hz warm, against a 2.4 Hz sample rate,
     * which is why rate is a precision question and not a convenience one.
     *
     * On the DS2 path `lambda1` holds the same number as `stft1`. That is not a duplicate by
     * accident: `stft1/stft2` are the values the CALCULATION uses, bank-filled when a CSV supplies
     * only one, while `lambda1/lambda2` record what the source physically carried. The CSV
     * round-trip depends on that distinction (see log-engine/serializer.ts), so only one of the two
     * is ever shown, and it is this one.
     */
    lambda1: {
        key: 'lambda1', symbol: 'la_f_regler1', name: 'Lambda controller factor, bank 1',
        source: { selection: 19, offset: 40 }, unit: '', format: v => v.toFixed(3),
        relevance: 'optional', chartAxis: 'y2', color: '#B9A6EE', // M-violet 300 (9.8:1)
    },
    lambda2: {
        key: 'lambda2', symbol: 'la_f_regler2', name: 'Lambda controller factor, bank 2',
        source: { selection: 19, offset: 42 }, unit: '', format: v => v.toFixed(3),
        relevance: 'optional', chartAxis: 'y2', color: '#CBBCF2', // lighter + dashed = 2nd sensor
    },
    coolantTemp: {
        key: 'coolantTemp', symbol: 'tmot', name: 'Engine temperature',
        source: { selection: 3, offset: 11 }, unit: '°C', format: v => v.toFixed(1),
        // Never charted (no chartAxis) — this only colors the table column and the live TEMP cell,
        // so it can hold the warm end of the M-red ramp without competing with a plotted series.
        relevance: 'optional', color: '#F87A7F', // M-red 300 (8.1:1)
    },
    exhaustTemp: {
        // The DME sends this at 16 °C per count, so a decimal place would be a lie about precision.
        key: 'exhaustTemp', symbol: 'tabg', name: 'Exhaust temperature',
        source: { selection: 3, offset: 14 }, unit: '°C', format: v => v.toFixed(0),
        // Shares y1 with RPM: both are large-magnitude, and keeping EGT off the lambda axis stops
        // it flattening the ~1.0 traces that matter most there.
        relevance: 'optional', chartAxis: 'y1', color: '#F64A50', // M-red 400 — hotter step than Temp's 300
    },
    rf: {
        key: 'rf', symbol: 'rf', name: 'Relative filling (after rf_korr)',
        source: { selection: 3, offset: 8 }, unit: '%', format: v => v.toFixed(1),
        // Blue like the other fill/load channels, one step lighter than correctedLoad's 500 so the
        // pair reads as "same family, this one is the DME's own number".
        relevance: 'optional', chartAxis: 'y3', color: '#6CCBEF', // M-blue 300
    },
    /** Throttle plate 1, actual position. Free — block 3 was already being read for rpm and load,
     *  and these two bytes were being discarded. Consumer: full-load detection against
     *  `KF_BZ_WDK_VL`, which is one of the lambda controller's own shutdown conditions (FR 5.01
     *  x.2.3.2) and which docs/ecu-logic/60 §9 listed as having no channel to detect it. */
    wdk1: {
        key: 'wdk1', symbol: 'wdk1', name: 'Throttle potentiometer 1 actual position',
        source: { selection: 3, offset: 27 }, unit: '%', format: v => v.toFixed(1),
        relevance: 'optional', chartAxis: 'y3', color: '#3FB3E0', // M-blue, between rf and correctedLoad
    },
    // Derived. `rf_korr` IS a DME variable name, but this column is not the DME's copy of it — it is
    // this app's measurement, (rf/100) / rf_soll, which only equals the DME's under the PATCH. So it
    // is named as a computed value like every other one.
    rfKorr: {
        key: 'rfKorr', symbol: 'RF KORR', name: 'EGT correction, measured from rf / rf_soll',
        source: 'derived', unit: '', format: v => v.toFixed(3),
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
        key: 'egtFromRfKorr', symbol: 'EGT (from RF KORR)', name: 'tabg re-derived through the DME tables',
        source: 'derived', unit: '°C', format: v => v.toFixed(0),
        relevance: 'optional', chartAxis: 'y1', color: '#B9A6EE', // M-violet 300
    },
    rfKorrFromEgt: {
        key: 'rfKorrFromEgt', symbol: 'RF KORR (from EGT)', name: 'rf_korr re-derived through the DME tables',
        source: 'derived', unit: '', format: v => v.toFixed(3),
        relevance: 'optional', chartAxis: 'y2', color: '#CBBCF2', // M-violet 200
    },
    tankVent: {
        key: 'tankVent', symbol: 'tetv', name: 'Tank ventilation valve pulse time',
        source: { selection: 19, offset: 38 }, unit: 'ms', format: v => v.toFixed(2),
        // On y2 with the lambda traces on purpose: purge duty is only interesting laid directly
        // against the trims it is disturbing, and the whole reason to log it is to see the two
        // move together. Amber because it is a warning channel, not a measurement — nothing else
        // in the registry uses that hue.
        relevance: 'optional', chartAxis: 'y2', color: '#F0A020',
    },
    tankVentCheckState: {
        key: 'tankVentCheckState', symbol: 'tefc_ll_st', name: 'Tank ventilation system test result',
        source: { selection: 19, offset: 62 }, unit: '', format: v => v.toFixed(0),
        // A state number, so it is charted as a step on the lambda axis where its range (0-0x15)
        // sits close enough to be readable beside a 1.0 trim without its own scale.
        relevance: 'optional', chartAxis: 'y2', color: '#C77A10',
    },
    tankVentDiag: {
        key: 'tankVentDiag', symbol: 'tefc_ed', name: 'TEV check diagnostic status',
        source: { selection: 19, offset: 88 }, unit: '', format: v => v.toFixed(0),
        // Never charted. It is a fault handle: what matters is whether it is non-zero, which the
        // table says better than a flat line at 0 says it.
        relevance: 'optional', color: '#A05E0C',
    },
    /**
     * OBSERVATION ONLY, and it must stay that way until a car says what it is.
     *
     * The symbol comes from the reference catalog (`DmeLiveValueCatalog.cs`, selection 19 offset 89)
     * and nowhere else: a search of the whole translated Funktionsrahmen finds no "freeze" anywhere
     * in the lambda module. "Freeze frame" in OBD usually means the snapshot stored with a fault
     * code, which is a different thing from "the controller is frozen" — and building a sample-
     * rejection gate on the second meaning when the byte might carry the first would silently throw
     * away good data.
     *
     * So it is logged and never acted on. The experiment it exists for: go to full load, where
     * FR 5.01 x.2.3.2 says the controller is definitely switched off, and see whether this changes.
     * If it does, it can be promoted to a gate and replaces four inferences with one fact.
     */
    lambdaFreeze: {
        key: 'lambdaFreeze', symbol: 'la_freeze_flag', name: 'Lambda freeze-frame status (meaning unverified)',
        source: { selection: 19, offset: 89 }, unit: '', format: v => v.toFixed(0),
        relevance: 'optional', color: '#8A6A2A',
    },
};

export const TOGGLEABLE_FIELDS: FieldKey[] = (Object.keys(LOG_FIELD_REGISTRY) as FieldKey[])
    .filter(key => LOG_FIELD_REGISTRY[key].relevance !== 'core');

export const DEFAULT_FIELD_VISIBILITY: Record<FieldKey, boolean> = {
    rpm: true, rawLoad: true, correctedLoad: true, lambda1: true, lambda2: true, coolantTemp: true,
    // On by default: the whole point of reading them is that the EGT correction is invisible
    // otherwise. They still only appear when the log actually carries them (isFieldPresent).
    exhaustTemp: true, rf: true, rfKorr: true,
    // Off by default. It is a gate input rather than something to watch while driving — what you
    // want to see is the SAMPLES it rejected, not the raw plate angle.
    wdk1: false,
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
    // Off until it means something. Turn it on for the full-load experiment described in its entry.
    lambdaFreeze: false,
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
