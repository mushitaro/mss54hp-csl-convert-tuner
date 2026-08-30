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
    | 'rpm' | 'rawLoad' | 'correctedLoad' | 'stft1' | 'stft2' | 'coolantTemp'
    // The LONG-term half of the lambda trim, out of the same telegram as the short-term pair.
    | 'ltft1' | 'ltft2'
    // The ADDITIVE long-term store — the one a stationary idle learns into. Its own RAM read.
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
    | 'lambdaFreeze'
    // Not from a block at all: a one-byte RAM read on the slow lane. See its entry.
    | 'intakeTemp' | 'ambientPressure' | 'chargeTemp' | 'altitude'
    | 'ambientTemp' | 'vehicleSpeed'
    // One byte of RAM on the slowest lane, and a bitfield rather than a quantity — see its entry.
    | 'llsSt'
    // The tip-in / dashpot slew limiter, on the same lane. Diagnostics for the drivability tables,
    // never an input to the VE derivation — see their entries.
    | 'mdDynSt' | 'mdFw' | 'mdFwFilter' | 'mdLsDelta' | 'mdDpDelta';

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
    /**
     * Which of the three lists this channel belongs to, and it decides both the panel's grouping
     * and the default view.
     *
     *   core     always drawn, never toggleable — where the engine was (rpm, opening, corrected)
     *   tuning   what a tune is read from. ON by default, and DEFAULTS is exactly this set
     *   debug    what you switch on to investigate something. OFF by default
     *
     * It replaced a flat 'optional', which made the panel twenty checkboxes in one list with the
     * eight that matter scattered through it (operator, 2026-08-25). The split is not a taste: the
     * question a channel answers is either "what is this tune doing" or "why is the tool/DME saying
     * that", and nothing in `debug` is read by the derivation.
     */
    relevance: 'core' | 'tuning' | 'debug';
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
     * There used to be a second copy of this pair called `lambda1/lambda2`, holding the same numbers
     * so the CSV round-trip could tell which banks the source physically carried. It is gone:
     * `undefined` says that directly now that the pair is optional, and one channel with one name is
     * what stops the next reader wondering which of the two is real.
     */
    stft1: {
        key: 'stft1', symbol: 'la_f_regler1', name: 'Lambda controller factor, bank 1',
        source: { selection: 19, offset: 40 }, unit: '', format: v => v.toFixed(3),
        relevance: 'tuning', chartAxis: 'y2', color: '#B9A6EE', // M-violet 300 (9.8:1)
    },
    stft2: {
        key: 'stft2', symbol: 'la_f_regler2', name: 'Lambda controller factor, bank 2',
        source: { selection: 19, offset: 42 }, unit: '', format: v => v.toFixed(3),
        relevance: 'tuning', chartAxis: 'y2', color: '#CBBCF2', // lighter + dashed = 2nd sensor
    },
    /**
     * `laa_f1` / `laa_f2` — the LONG-term lambda trim, per bank. 1.000 = nothing learned.
     *
     * The pair above (`la_f_regler`) is the SHORT-term controller: a two-point regulator that steps
     * every time the sensor crosses stoichiometric, so it oscillates whatever the mixture is doing.
     * This is the store the DME learns that oscillation's MEAN into, and Funktionsrahmen 7.2 says it
     * learns in exactly the warm, stationary, idle window.
     *
     * So at a settled warm idle the short-term trim comes back toward 1.000 because THIS took the
     * offset, not because the mixture is right. The standing error is the product of the two, which
     * is what the low-opening correction now multiplies.
     *
     * Named in CAPITALS like every other RAM channel here (`TAN`, `V`, `LLS_ST`): the lowercase
     * form is reserved for what arrives in a DS2 block, and block 19 carries `la_f_regler1/2` but
     * not this — it exists only in RAM at 0xFF80CE.
     *
     * `tuning`, not `debug`, and the test is the one that category states: the derivation reads it.
     * The low-opening correction multiplies by it. Showing the short-term trim without this beside
     * it is showing half a number, and the half that reads as good news.
     *
     * Free — the same eight-byte RAM read that already carried the short-term pair.
     */
    ltft1: {
        key: 'ltft1', symbol: 'LAA_F1', name: 'Lambda long-term trim, bank 1',
        source: 'derived', unit: '', format: v => v.toFixed(3),
        relevance: 'tuning', chartAxis: 'y2', color: '#9B84E8',
    },
    ltft2: {
        key: 'ltft2', symbol: 'LAA_F2', name: 'Lambda long-term trim, bank 2',
        source: 'derived', unit: '', format: v => v.toFixed(3),
        relevance: 'tuning', chartAxis: 'y2', color: '#B9A6EE',
    },
    coolantTemp: {
        key: 'coolantTemp', symbol: 'tmot', name: 'Engine temperature',
        source: { selection: 3, offset: 11 }, unit: '°C', format: v => v.toFixed(1),
        // Never charted (no chartAxis) — this only colors the table column and the live TEMP cell,
        // so it can hold the warm end of the M-red ramp without competing with a plotted series.
        relevance: 'tuning', color: '#F87A7F', // M-red 300 (8.1:1)
    },
    exhaustTemp: {
        // The DME sends this at 16 °C per count, so a decimal place would be a lie about precision.
        key: 'exhaustTemp', symbol: 'tabg', name: 'Exhaust temperature',
        source: { selection: 3, offset: 14 }, unit: '°C', format: v => v.toFixed(0),
        // Shares y1 with RPM: both are large-magnitude, and keeping EGT off the lambda axis stops
        // it flattening the ~1.0 traces that matter most there.
        relevance: 'tuning', chartAxis: 'y1', color: '#F64A50', // M-red 400 — hotter step than Temp's 300
    },
    rf: {
        key: 'rf', symbol: 'rf', name: 'Relative filling (after rf_korr)',
        source: { selection: 3, offset: 8 }, unit: '%', format: v => v.toFixed(1),
        // Blue like the other fill/load channels, one step lighter than correctedLoad's 500 so the
        // pair reads as "same family, this one is the DME's own number".
        relevance: 'tuning', chartAxis: 'y3', color: '#6CCBEF', // M-blue 300
    },
    /** Throttle plate 1, actual position. Free — block 3 was already being read for rpm and load,
     *  and these two bytes were being discarded. Consumer: full-load detection against
     *  `KF_BZ_WDK_VL`, which is one of the lambda controller's own shutdown conditions (FR 5.01
     *  x.2.3.2) and which docs/ecu-logic/60 §9 listed as having no channel to detect it. */
    wdk1: {
        key: 'wdk1', symbol: 'wdk1', name: 'Throttle potentiometer 1 actual position',
        source: { selection: 3, offset: 27 }, unit: '%', format: v => v.toFixed(1),
        relevance: 'debug', chartAxis: 'y3', color: '#3FB3E0', // M-blue, between rf and correctedLoad
    },
    // Derived. `rf_korr` IS a DME variable name, but this column is not the DME's copy of it — it is
    // this app's measurement, (rf/100) / rf_soll, which only equals the DME's under the PATCH. So it
    // is named as a computed value like every other one.
    rfKorr: {
        key: 'rfKorr', symbol: 'RF KORR', name: 'EGT correction, measured from rf / rf_soll',
        source: 'derived', unit: '', format: v => v.toFixed(3),
        // Violet = derived diagnostic, per globals.css. One step darker than the Factor column's
        // #9B84E8 so the two never collide in the same table row.
        relevance: 'tuning', chartAxis: 'y2', color: '#7E63DB', // M-violet (amber-600 alias)
    },
    // The cross-check pair. Each sits on its measured counterpart's axis, one violet step apart
    // from it, so a residual reads as a gap between two adjacent lines rather than as two
    // unrelated traces. Charted dashed — see LogTimeSeriesChart.
    egtFromRfKorr: {
        // No decimal, matching EGT: the sensor it is compared against arrives at 16 °C per count,
        // and claiming more resolution than the reference would misstate what the residual means.
        key: 'egtFromRfKorr', symbol: 'EGT (from RF KORR)', name: 'tabg re-derived through the DME tables',
        source: 'derived', unit: '°C', format: v => v.toFixed(0),
        relevance: 'debug', chartAxis: 'y1', color: '#B9A6EE', // M-violet 300
    },
    rfKorrFromEgt: {
        key: 'rfKorrFromEgt', symbol: 'RF KORR (from EGT)', name: 'rf_korr re-derived through the DME tables',
        source: 'derived', unit: '', format: v => v.toFixed(3),
        relevance: 'debug', chartAxis: 'y2', color: '#CBBCF2', // M-violet 200
    },
    tankVent: {
        key: 'tankVent', symbol: 'tetv', name: 'Tank ventilation valve pulse time',
        source: { selection: 19, offset: 38 }, unit: 'ms', format: v => v.toFixed(2),
        // On y2 with the lambda traces on purpose: purge duty is only interesting laid directly
        // against the trims it is disturbing, and the whole reason to log it is to see the two
        // move together. Amber because it is a warning channel, not a measurement — nothing else
        // in the registry uses that hue.
        relevance: 'tuning', chartAxis: 'y2', color: '#F0A020',
    },
    tankVentCheckState: {
        key: 'tankVentCheckState', symbol: 'tefc_ll_st', name: 'Tank ventilation system test result',
        source: { selection: 19, offset: 62 }, unit: '', format: v => v.toFixed(0),
        // A state number, so it is charted as a step on the lambda axis where its range (0-0x15)
        // sits close enough to be readable beside a 1.0 trim without its own scale.
        relevance: 'debug', chartAxis: 'y2', color: '#C77A10',
    },
    tankVentDiag: {
        key: 'tankVentDiag', symbol: 'tefc_ed', name: 'TEV check diagnostic status',
        source: { selection: 19, offset: 88 }, unit: '', format: v => v.toFixed(0),
        // Never charted. It is a fault handle: what matters is whether it is non-zero, which the
        // table says better than a flat line at 0 says it.
        relevance: 'debug', color: '#A05E0C',
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
        relevance: 'debug', color: '#8A6A2A',
    },
    /**
     * Intake air temperature — the density record, not a tuning input.
     *
     * The Alpha-N path DOES read a temperature, contrary to what this comment used to claim.
     * `rf_soll_calc` (master `0x01A9D2`) ends with `rf_soll = (rf_soll_filtered * RF_PT_KORR) >> 12`
     * and `RF_PT_KORR` is `KL_RF_TAN_KORR(TAN) * KL_RF_P_UMG_KORR(P_UMG)`. The tuning patch clears
     * `k_rf_cfg` bit 4, which removes the MAP integral and nothing else — this scaling runs on every
     * segment, patch or no patch.
     *
     * So a logged trim was measured THROUGH that curve, and this channel is the index into it. Read
     * at 0.25 degC from `tan_filter` rather than 1 degC from the `TAN` byte, because the word is
     * inside the cluster read anyway. See `chargeTemp` for the other half.
     */
    intakeTemp: {
        key: 'intakeTemp', symbol: 'TAN', name: 'Intake air temperature',
        source: 'derived', unit: '°C', format: v => v.toFixed(1),
        relevance: 'debug', color: '#7FB3D5',
    },
    /**
     * `tan_m` — the DME's own modelled charge temperature at the intake valve.
     *
     * `tan_m_adj_calc` (master `0x0212BE`) builds it as `TMOT - f*(TMOT - TAN)`, where `f` rises
     * with air mass flow and reaches 1 at 286 kg/h. Air through a hot port picks up wall heat, and
     * less of it the faster it goes — so at light load the charge sits near coolant temperature
     * whatever the weather is, and at high flow it is the sensor reading.
     *
     * That is the load dependence a one-dimensional `KL_RF_TAN_KORR` cannot express, and it is why
     * that curve is so much flatter than 1/T. It is also the whole basis of the density
     * normalisation: `factor = (tan_m / tan_m_ref) * KL_T(TAN)` needs no fitted constant, because
     * this channel already carries the model.
     */
    chargeTemp: {
        key: 'chargeTemp', symbol: 'TAN_M', name: 'Charge temperature (modelled)',
        source: 'derived', unit: '°C', format: v => v.toFixed(1),
        relevance: 'debug', color: '#A8CFE6',
    },
    /**
     * `P_UMG_FILTER` — ambient pressure, from a QADC channel of its own.
     *
     * Not the manifold sensor: `p_umg_ad` is RJURR entry 37, `p_saug_ad` is entry 28, they carry
     * different transfer functions and different sample rates, and the DME judges the manifold
     * sensor BY this one. Not latched at key-on either — scanned continuously, slew-limited to
     * 1.875 mbar/s.
     *
     * It does NOT enter the correction. `KL_RF_P_UMG_KORR` is linear in pressure to 0.24 % across
     * the range this car sees, so `actual air ∝ P` over `commanded ∝ P/960.5` cancels and the same
     * table comes out at 888 mbar as at 943. Recorded because that cancellation only holds while
     * the DME has a real reading, and because this is the one channel that can show it did.
     */
    ambientPressure: {
        key: 'ambientPressure', symbol: 'P_UMG', name: 'Ambient pressure',
        source: 'derived', unit: 'mbar', format: v => v.toFixed(0),
        relevance: 'debug', color: '#5E93B8',
    },
    /** `P_UMG_HOEHE` — the altitude the DME derives from ambient pressure. A restatement of the
     *  pressure through a curve, so off by default; it is here because it is legible at a glance in
     *  a way mbar is not, and because it is exactly what a GPS overlay would have been built to
     *  recover. */
    altitude: {
        key: 'altitude', symbol: 'P_UMG_HOEHE', name: 'Altitude (DME)',
        source: 'derived', unit: 'm', format: v => v.toFixed(0),
        relevance: 'debug', color: '#4C7A99',
    },
    /**
     * `T_UMG` — outside air temperature, off CAN 0x62F.
     *
     * The reference every other temperature in this app is checked against, and the reason it is on
     * by default. Cold-soaked overnight, this, `intakeTemp` and `coolantTemp` must agree; if they
     * do not, the intake reading is wrong and every density argument built on it is worthless.
     * That is a one-minute check that needs no driving, and it can only be done if the channel is
     * in the log.
     *
     * Its own trap: `can_rx_62f` substitutes `T_UMG_ERSATZ` when the bus is quiet, and `tan_calc`
     * maintains that as the running MINIMUM of `TAN`. A substituted reading is therefore derived
     * from the sensor it is supposed to check. The log carries the source flag beside it, and the
     * CSV only grows a column for it on a run where the substitution actually happened.
     */
    ambientTemp: {
        key: 'ambientTemp', symbol: 'T_UMG', name: 'Outside air temperature',
        source: 'derived', unit: '°C', format: v => v.toFixed(0),
        relevance: 'debug', color: '#CFE7F5',
    },
    /**
     * `V` — road speed.
     *
     * `rf_korr_calc` gates the EGT correction on `V > k_rf_korr_v_min` (stock 20 km/h) as well as
     * on the filling floor, and this app has never been able to evaluate that half — `EgtTables.vMin`
     * has been decoded and unused since it was added. A first-gear pull from rest is scored
     * gate-open when the DME had `rf_korr` pinned at 1.000.
     *
     * Recorded so the gap can be measured. NOT yet used as a gate: it arrives on the slowest lane,
     * and a stale reading would mis-score exactly the samples the gate exists to exclude.
     */
    vehicleSpeed: {
        key: 'vehicleSpeed', symbol: 'V', name: 'Road speed',
        source: 'derived', unit: 'km/h', format: v => v.toFixed(0),
        relevance: 'tuning', color: '#B0B0BE',
    },
    /**
     * `LLS_ST` — idle-valve status, and it is on this list for **bit 7** alone.
     *
     * `ti_load_factor` (slave 0x01C6CA) reads the idle curve `KL_TI_N_ZWD_LL` — 0.859 above
     * 800 rpm — only while `ZUSTAND_MOTOR`'s LL bit is set AND this bit is set. Otherwise it reads
     * `KF_TI_N_RF`, which is 1.000 everywhere except its lowest row. Bit 7 is set by the idle-valve
     * DIAGNOSIS (`lls_diag`, master 0x026142) and cleared at 0x026196, so a healthy valve leaves it
     * low and the 0.859 curve is the DME's substitute for a valve it has stopped believing.
     *
     * Which of those two runs decides `TI_F_STAT`, which the DME multiplies injection time by. It
     * is NOT a term in the LOW LOAD correction — session #920 measured that the lambda trim does
     * not move with the factor — so `requireTiBranchProven`, which once refused every idle cell
     * over this, is now OFF and neither branch changes a written byte. `TI_F_STAT` itself is slave
     * RAM (0xFFE70E) and unreachable from a DS2 session with the master; this byte is the entire
     * discriminator and it is master RAM.
     *
     * Formatted as HEX. It is a bitfield: `0x01` is what `lls_tv_init` leaves, `0x81` means the
     * diagnosis has latched, and rendering either as a decimal count would invite reading it as a
     * quantity. Off by default — most logs never need it, and it costs 0.7 % of the sample rate.
     */
    llsSt: {
        key: 'llsSt', symbol: 'LLS_ST', name: 'Idle valve status (bit 7 = diagnosis latched)',
        source: 'derived', unit: '', format: v => '0x' + (v & 0xFF).toString(16).toUpperCase().padStart(2, '0'),
        relevance: 'debug', color: '#B9A6EE',
    },
    /**
     * The slew limiter's own state, and the only channel that says it BOUND.
     *
     * `45-drivability-filters.md` §1: the tip-in path passes the driver's request through untouched
     * whenever it is inside the allowance, so the four maps that compute the allowance cannot tell
     * you whether any of it was ever spent. Bit 6 is set on the cycle the tip-in path clipped, bits
     * 4/5 when the dashpot did. Hex, like LLS_ST, because reading a bitfield as a count invites
     * treating it as a quantity.
     */
    mdDynSt: {
        key: 'mdDynSt', symbol: 'MD_DYN_ST', name: 'Slew limiter state (bit 6 = tip-in clipped)',
        source: 'derived', unit: '', format: v => '0x' + (v & 0xFF).toString(16).toUpperCase().padStart(2, '0'),
        relevance: 'debug', color: '#B9A6EE',
    },
    /**
     * The torque request either side of the limiter. `mdFwFilter - mdFw` is what it took.
     *
     * Measured rather than inferred: the alternative is multiplying `KF_MD_LS_KOMF` by three more
     * tables and hoping the axes were read right, which is how the load path was got wrong twice
     * (`66-tuning-methodology.md` §0). These two words settle it directly.
     */
    mdFw: {
        key: 'mdFw', symbol: 'MD_FW', name: 'Torque request, before the slew limiter',
        source: 'derived', unit: 'Nm', format: v => v.toFixed(1),
        relevance: 'debug', color: '#9B84E8',
    },
    mdFwFilter: {
        key: 'mdFwFilter', symbol: 'MD_FW_FILTER', name: 'Torque request, after the slew limiter',
        source: 'derived', unit: 'Nm', format: v => v.toFixed(1),
        relevance: 'debug', color: '#9B84E8',
    },
    /** The allowance each path had, 0.1 Nm per 10 ms. Written by the DME and read by nothing —
     *  observation-only values, which is why they are here rather than in a gate. */
    mdLsDelta: {
        key: 'mdLsDelta', symbol: 'MD_LS_DELTA', name: 'Tip-in allowance',
        source: 'derived', unit: 'Nm', format: v => v.toFixed(1),
        relevance: 'debug', color: '#9B84E8',
    },
    mdDpDelta: {
        key: 'mdDpDelta', symbol: 'MD_DP_DELTA', name: 'Dashpot allowance',
        source: 'derived', unit: 'Nm', format: v => v.toFixed(1),
        relevance: 'debug', color: '#9B84E8',
    },
};

export const TOGGLEABLE_FIELDS: FieldKey[] = (Object.keys(LOG_FIELD_REGISTRY) as FieldKey[])
    .filter(key => LOG_FIELD_REGISTRY[key].relevance !== 'core');

/**
 * The panel's two sections, in the order it draws them.
 *
 * Registry order within each — the list is grouped, not re-sorted, so a channel keeps the
 * neighbours it was written beside and the file stays the one place the order is decided.
 */
export const FIELD_GROUPS: { relevance: 'tuning' | 'debug'; title: string; hint: string }[] = [
    {
        relevance: 'tuning',
        title: 'TUNING',
        hint: 'What a tune is read from. These are the columns DEFAULTS switches on.',
    },
    {
        relevance: 'debug',
        title: 'DEBUG',
        hint: 'Switch one on to investigate something. Nothing here is read by the derivation.',
    },
];

/**
 * The sections THIS build draws — production stops at TUNING.
 *
 * Not cosmetic, and this is the half that makes the other half honest. From 2026-08-25 a production
 * run does not RECORD the debug channels (see `productionExchanges`): two of their reads are off the
 * wire entirely. Leaving the checkboxes up would offer twelve switches that turn on twelve empty
 * columns — a control that does nothing, which is worse than one that is absent, because the user
 * concludes the channel is broken rather than that this build does not carry it.
 *
 * The DEBUG hint lost the words "the channels are recorded either way" for the same reason. It was
 * true when every build recorded everything and only the view was filtered; it is not true now.
 */
export function fieldGroupsFor(isPreview: boolean): typeof FIELD_GROUPS {
    return isPreview ? FIELD_GROUPS : FIELD_GROUPS.filter(g => g.relevance !== 'debug');
}

/** The channels in one section, in registry order. */
export const fieldsIn = (relevance: 'tuning' | 'debug'): FieldKey[] =>
    TOGGLEABLE_FIELDS.filter(key => LOG_FIELD_REGISTRY[key].relevance === relevance);

/**
 * Groups where at least one member has to stay on screen.
 *
 * One group today, and it is the reason the rule exists: `la_f_regler1/2` is the ONLY input the VE
 * correction has (`parseLogFile` refuses a log carrying neither), so a log view with both banks
 * switched off is a view of everything except the number it is about. The panel let both be
 * unchecked, and CORE ONLY switched both off by itself.
 *
 * Which bank stays is the operator's choice — the two are different cylinders of one engine and
 * either can carry the reading — so this is "at least one", not "always bank 1".
 */
export const REQUIRED_FIELD_GROUPS: FieldKey[][] = [['stft1', 'stft2']];

/**
 * Would switching `key` off leave a required group empty?
 *
 * Pure, and asked by BOTH the hook that applies the change and the panel that draws the checkbox —
 * a rule enforced in one place and invisible in the other is a control that ignores the tap.
 */
export function isLastOfRequiredGroup(key: FieldKey, visible: Record<FieldKey, boolean>): boolean {
    if (!visible[key]) return false;
    const group = REQUIRED_FIELD_GROUPS.find(g => g.includes(key));
    return !!group && group.filter(k => visible[k]).length <= 1;
}

/**
 * CORE ONLY — the fewest columns this log can still be read from.
 *
 * The three core fields are not in here because they are not toggleable: rpm, the opening and the
 * corrected opening are always drawn. What this adds is the lambda controller factor, and that is
 * the whole correction to the previous behaviour — it switched every toggleable field off, which
 * left the table showing WHERE the engine was and nothing about what it was doing there. Every
 * checkbox in the panel went dark, which is what the operator reported (2026-08-24).
 *
 * Both banks rather than one: they are two measurements of the same engine and reading them
 * against each other is most of what this view is for. A fixed set, because it is a reset.
 */
export const CORE_ONLY_VISIBILITY: Record<FieldKey, boolean> = (() => {
    const off = {} as Record<FieldKey, boolean>;
    (Object.keys(LOG_FIELD_REGISTRY) as FieldKey[]).forEach(k => { off[k] = false; });
    return { ...off, rpm: true, rawLoad: true, correctedLoad: true, stft1: true, stft2: true };
})();

export const DEFAULT_FIELD_VISIBILITY: Record<FieldKey, boolean> = {
    rpm: true, rawLoad: true, correctedLoad: true, stft1: true, stft2: true, coolantTemp: true,
    // On, like the short-term pair above it: a settled short-term trim only means something next
    // to the long-term stores it drained into.
    ltft1: true, ltft2: true,
    // Off, like LLS_ST: recorded on the slow lane regardless, shown when the idle question is
    // being asked. Goes on by default when the fold into the low-opening correction lands.
    // OFF, and the argument that put them on was about the wrong thing. It said "a column nobody
    // has switched on is a column nobody checks" — true of RECORDING, which is not what this map
    // decides: these four are read on the slow lane and written into every log whether or not a
    // column shows them. What they are for is a deliberate check (TAN against TMOT against T_UMG
    // with the engine cold, the pressure against the altitude) and a correction that reads them
    // itself. Neither is done by watching four columns that move by a degree a minute, and four
    // columns is a third of the table.
    intakeTemp: false, chargeTemp: false, ambientPressure: false,
    // Off: a restatement of ambientPressure through a curve. Useful when reading a log by eye,
    // noise when watching one.
    altitude: false,
    // Off: a bitfield nobody needs until the idle band is being argued about, and it is read on
    // the slowest lane anyway — switching the column on is how you find out it was already there.
    llsSt: false,
    // Off, all five. They answer one question — did the slew limiter bind, and by how much — and
    // that question is asked after a drive, against the drivability tables, not watched from the
    // seat. On the same slowest lane as LLS_ST, so switching a column on is how you find out the
    // data was already recorded.
    mdDynSt: false, mdFw: false, mdFwFilter: false, mdLsDelta: false, mdDpDelta: false,
    // Ambient temperature off with the other three air channels — it is the reference the intake
    // sensor is checked against, and that check is a job, not a view.
    //
    // Road speed stays ON, and not only because every datalogger shows it: the DME's exhaust
    // correction is gated on 20 km/h, so this column is how a row that reads rf_korr = 1.000 is
    // told from one where the correction was running. It is also how you find the pull you were
    // driving when you read the row back.
    ambientTemp: false, vehicleSpeed: true,
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
