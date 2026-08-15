/**
 * DS2 live-measurement block field layouts, ported from the reference Mss54Ds2Tool source
 * (Ds2StandardMeasurementBlock.cs, DmeLiveValueCatalog.cs, DmeLiveValueDecoder.cs). Byte offsets
 * and scaling formulas are confirmed against that source. The decoding itself lives in
 * blockDecoder.ts, shared with adaptationBlocks.ts.
 */

import { FieldDef, decodeField } from './blockDecoder';

/** Selection 3 "Standard Measurements" (35 bytes) — RPM, coolant temp, and relative opening (RO). */
export const STANDARD_MEASUREMENT_BLOCK = {
    selection: 3,
    expectedLength: 35,
    fields: {
        rpm: { symbol: 'n', offset: 0, format: 'uint16', scale: 1.0, add: 0 } as FieldDef,
        coolantTemp: { symbol: 'tmot', offset: 11, format: 'uint8', scale: 1.0, add: -48 } as FieldDef,
        // aq_rel = "relativer Oeffnungsquerschnitt" — the same quantity the Testo CSV pipeline calls
        // rawLoad, and the tuning table's load axis is in these units.
        //
        // SCALE is 200/65536, NOT the Mss54Ds2Tool catalog's 0.46511627906976744. The offset is
        // right — RPM (0) and tmot (11) decode correctly and this raw matches — but that tool scales
        // aq_rel to its own % convention, ~150x larger than Testo's, which put idle at 38% and cruise
        // over 200%. Confirmed against a real Testo log: every relativer Oeffnungsquerschnitt value
        // there is exactly raw*200/65536 (0.241089 = 79*, 0.67749 = 222*, 63.3575 = 20763*), so idle
        // reads ~0.25 and cruise ~1, matching the axis instead of overflowing it.
        rawLoad: { symbol: 'aq_rel', offset: 20, format: 'uint16', scale: 0.0030517578125, add: 0 } as FieldDef,
        // rf and tabg come out of the SAME 35-byte response the three fields above already fetch,
        // so reading them costs no extra round trip and does not slow the live sample rate.
        //
        // Offsets derived from the 0401 disassembly: master ds2_handler case 0x1c, annotated
        // /* 12050B03 */ (addr 12, len 05, cmd 0B, selection 03) in the CSL_0401 notes repo,
        // decomp/master/030b84.txt. It writes through puVar5 = rsp_ptr and puts N's high byte at
        // rsp_ptr+3, so payload offset = array index - 3. Two independent cross-checks on that
        // mapping: TMOT is written at index 0x0E -> offset 11, which is the offset already proven
        // on the car above; and RF at index 0x0B -> offset 8, which is where the reference
        // Mss54Ds2Tool catalog also puts `rf` (u16, 0.1).
        //
        // CAVEAT, unresolved: the same listing writes 0 at payload 13/16/20/21, yet offset 20 is
        // where aq_rel is read successfully on a real car. Those four positions are exactly the
        // ones the reference catalog assigns to slave-owned signals, so "the slave fills them in
        // afterwards" reconciles it — but confirm both fields against a real DME before trusting
        // them (see docs/ecu-logic/20-egt-correction.md).

        /** RF, the DME's final relative filling — rf_soll AFTER rf_korr. `puVar5[0xb..0xc] = RF`. */
        rf: { symbol: 'rf', offset: 8, format: 'uint16', scale: 0.1, add: 0 } as FieldDef,
        /** TABG. The DME emits `puVar5[0x11] = (char)(TABG >> 4)` — a SIGNED byte carrying degC/16,
         *  so the channel resolves 16 degC and spans the sensor's -55..1250 degC range. `int7` is
         *  this decoder's signed-byte format (see blockDecoder.ts). */
        exhaustTemp: { symbol: 'tabg', offset: 14, format: 'int7', scale: 16, add: 0 } as FieldDef,
    },
};

/** Selection 19 "Operating Measurements" (90 bytes) — lambda controller trim (STFT-equivalent). */
export const OPERATING_MEASUREMENTS_BLOCK = {
    selection: 19,
    expectedLength: 90,
    fields: {
        stft1: { symbol: 'la_f_regler1', offset: 40, format: 'uint16', scale: 3.0517578125e-05, add: 0 } as FieldDef,
        stft2: { symbol: 'la_f_regler2', offset: 42, format: 'uint16', scale: 3.0517578125e-05, add: 0 } as FieldDef,
    },
};

/**
 * Selection 83 (0x53) "EGAS Measurements" (52 bytes) — the drivability block.
 *
 * This block exists for the inertia workflow, and it is polled ALONE rather than added to the
 * {3, 19} pair the VE datalog uses. Two reasons, and both are load-bearing:
 *
 * 1. **Rate.** Every selected block is its own DS2 round trip, so adding this one to the existing
 *    pair would take the VE sample from ~4 Hz to ~2 Hz. Polled by itself it is one exchange, which
 *    is the fastest this link can produce anything at all.
 * 2. **Skew.** DS2 is request/response, so signals from different blocks are sampled at different
 *    instants but land in one timestamped sample. Fitting torque against a speed gradient is
 *    exactly the calculation that skew corrupts: at 2000 rpm/s, a 110 ms inter-block gap is 220 rpm
 *    of drift between the two numbers being regressed. Inside one block there is no gap.
 *
 * The consequence is that this block cannot feed the VE pipeline — it carries no `aq_rel`, no
 * `tabg`, no `la_f_regler` — and the VE blocks cannot feed the inertia estimator. That is why
 * `EgasMeasurement` below is a separate type from `LiveMeasurement` rather than more optional
 * fields on it: the two runs are not interchangeable, and a type error is a better place to find
 * that out than a plausible wrong answer.
 *
 * Offsets and scalings are from the reference catalog (DmeLiveValueCatalog.cs, selection 83).
 */
export const EGAS_MEASUREMENT_BLOCK = {
    selection: 83,
    expectedLength: 52,
    fields: {
        /** Engine operating state. */
        engineState: { symbol: 'zustand_motor', offset: 3, format: 'uint8', scale: 1, add: 0 } as FieldDef,
        /** Throttle plate 1 position. */
        wdk1: { symbol: 'wdk1', offset: 4, format: 'uint16', scale: 0.1, add: 0 } as FieldDef,
        /** Engine speed, 40 rpm/LSB. Coarse next to block 3's `n` (1 rpm), and that is the price of
         *  having it in the same frame as the torque. The estimator differences it over a window
         *  rather than per sample, which is what makes 40 rpm tolerable. */
        n40: { symbol: 'n40', offset: 18, format: 'uint8', scale: 40, add: 0 } as FieldDef,
        /**
         * Engine speed gradient, 40 rpm/s per LSB, signed, saturating at +/-5080 rpm/s.
         *
         * **This channel is biased and the bias is not symmetric.** The DME computes
         * `D_N40 = (D_N_SEGMENT + 0x14) / 0x28` with a division that truncates toward zero, so
         * rounding is half-up on the positive side and lands a whole extra step short on the
         * negative side: a true -139 rpm/s is reported as -80. See `correctDN40` in
         * `src/lib/inertia/gradient.ts` for the correction and its residual.
         */
        dN40: { symbol: 'd_n40', offset: 19, format: 'int7', scale: 40, add: 0 } as FieldDef,
        /** Pedal gradient, %/20 ms (note: not %/s — this is the raw two-sample difference). */
        dPwg: { symbol: 'd_pwg', offset: 20, format: 'int15', scale: 0.1, add: 0 } as FieldDef,
        /** Throttle gradient, %/s. */
        dWdk: { symbol: 'd_wdk', offset: 22, format: 'int15', scale: 5.0, add: 0 } as FieldDef,
        /** Relative filling (%). Same quantity as block 3's `rf`, different block. */
        rf: { symbol: 'rf', offset: 30, format: 'uint16', scale: 0.1, add: 0 } as FieldDef,
        /** Driver torque request after the tip-in/tip-out slew limiter, Nm. */
        mdIndWunsch: { symbol: 'md_ind_wunsch', offset: 34, format: 'uint16', scale: 0.1, add: 0 } as FieldDef,
        /** Torque after intervention (ASC/SMG/limiter), Nm. */
        mdIndNe: { symbol: 'md_ind_ne', offset: 38, format: 'uint16', scale: 0.1, add: 0 } as FieldDef,
        /** Actual indicated torque, Nm — the DME's own torque model output. This is the regressand
         *  the inertia estimate is built on, so its absolute accuracy is the estimate's absolute
         *  accuracy; see the bias discussion in `src/lib/inertia/estimator.ts`. */
        mdIndOptKorr: { symbol: 'md_ind_opt_korr', offset: 40, format: 'uint16', scale: 0.1, add: 0 } as FieldDef,
        /** Rear-axle average speed, km/h. Present in this same block, which is what lets the
         *  estimator check the "stationary" precondition without a second round trip. */
        vAntrieb: { symbol: 'v_antrieb', offset: 42, format: 'uint16', scale: 0.0625, add: 0 } as FieldDef,
        /** Dynamic filter status. bit6 = the tip-in limiter actually clipped this cycle, bit4/5 =
         *  the dashpot did. The only direct evidence available over DS2 that the slew limiter was
         *  the thing shaping the torque — `MD_LS_DELTA` itself is written and never read, so it is
         *  not on any block. */
        mdDynSt: { symbol: 'md_dyn_st', offset: 48, format: 'uint8', scale: 1, add: 0 } as FieldDef,
        /** Calculated gear. 0 = neutral. */
        gang: { symbol: 'gang', offset: 49, format: 'uint8', scale: 1, add: 0 } as FieldDef,
        /** Powertrain engaged. Note this is decided by road speed alone on a 0x40 gearbox —
         *  `s_kraftschluss_calc` compares against K_LLR_V_MAX (2 km/h) and has no clutch input, so
         *  it does NOT mean "clutch is out". */
        sKrafts: { symbol: 's_krafts', offset: 50, format: 'uint8', scale: 1, add: 0 } as FieldDef,
        /** Overrun fuel cutoff state — how the estimator knows combustion torque is zero during a
         *  free deceleration. */
        saWeSt: { symbol: 'sa_we_st', offset: 51, format: 'uint8', scale: 1, add: 0 } as FieldDef,
    },
};

export function decodeStandardMeasurementBlock(payload: Uint8Array) {
    const f = STANDARD_MEASUREMENT_BLOCK.fields;
    return {
        rpm: decodeField(payload, f.rpm),
        coolantTemp: decodeField(payload, f.coolantTemp),
        rawLoad: decodeField(payload, f.rawLoad),
        rf: decodeField(payload, f.rf),
        exhaustTemp: decodeField(payload, f.exhaustTemp),
    };
}

export function decodeOperatingMeasurementsBlock(payload: Uint8Array) {
    const f = OPERATING_MEASUREMENTS_BLOCK.fields;
    return {
        stft1: decodeField(payload, f.stft1),
        stft2: decodeField(payload, f.stft2),
    };
}

/**
 * Every field of selection 83, each `number | null`.
 *
 * Null means "the block was shorter than this offset", which a DME on a different software version
 * can legitimately produce. Callers must keep that distinct from a decoded 0 — `gang: 0` is
 * neutral, `gang: null` is "this DME did not tell us", and treating the second as the first would
 * silently admit in-gear samples into a measurement that requires neutral.
 */
export function decodeEgasMeasurementBlock(payload: Uint8Array) {
    const f = EGAS_MEASUREMENT_BLOCK.fields;
    return {
        engineState: decodeField(payload, f.engineState),
        wdk1: decodeField(payload, f.wdk1),
        n40: decodeField(payload, f.n40),
        dN40: decodeField(payload, f.dN40),
        dPwg: decodeField(payload, f.dPwg),
        dWdk: decodeField(payload, f.dWdk),
        rf: decodeField(payload, f.rf),
        mdIndWunsch: decodeField(payload, f.mdIndWunsch),
        mdIndNe: decodeField(payload, f.mdIndNe),
        mdIndOptKorr: decodeField(payload, f.mdIndOptKorr),
        vAntrieb: decodeField(payload, f.vAntrieb),
        mdDynSt: decodeField(payload, f.mdDynSt),
        gang: decodeField(payload, f.gang),
        sKrafts: decodeField(payload, f.sKrafts),
        saWeSt: decodeField(payload, f.saWeSt),
    };
}
