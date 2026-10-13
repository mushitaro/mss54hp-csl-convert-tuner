/**
 * DS2 live-measurement block field layouts, ported from the reference Mss54Ds2Tool source
 * (Ds2StandardMeasurementBlock.cs, DmeLiveValueCatalog.cs, DmeLiveValueDecoder.cs). Byte offsets
 * and scaling formulas are confirmed against that source. The decoding itself lives in
 * blockDecoder.ts, shared with adaptationBlocks.ts.
 */

import { type FieldDef, decodeField } from './blockDecoder';

/** Selection 3 "Standard Measurements" (35 bytes) — RPM, coolant temp, and relative opening (RO). */
/** The band outside which `UB` is treated as a bad decode rather than a bad battery. The offset
 *  is single-source, so an implausible reading means "do not believe this channel". */
export const UB_PLAUSIBLE = { min: 11.0, max: 15.0 } as const;

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
        /**
         * WDK1 — throttle plate 1, actual position. Free: these two bytes were already arriving and
         * being discarded.
         *
         * Its consumer is a gate, not a gauge. FR 5.01 x.2.3.2 lists full load above `K_LA_N_VL`
         * among the conditions that switch the lambda controller OFF, and `KF_BZ_WDK_VL` is the
         * threshold this app already patches to keep the controller alive. Without a throttle
         * channel there was no way to tell whether a sample was taken above it — recorded in
         * docs/ecu-logic/60 §9 as "no means of detecting VL in the log", with this exact offset
         * named as the fix and nobody having taken it.
         */
        wdk1: { symbol: 'wdk1', offset: 27, format: 'int15', scale: 0.1, add: 0 } as FieldDef,
        /**
         * LLR_N_SOLL — the idle target the governor is actually using, after the PT1 and after
         * every MAX-select. Offset named in docs/ecu-logic/30-idle-control.md §3.
         *
         * Free: these two bytes were already arriving. It earns far more than it costs, because
         * watching it stand still is how the idle run detects the post-start ramp
         * (KL_LFR_NSOLL_OFFSET decays for up to 60 + 358 s and the app has no idea when the engine
         * started), the safety-concept target, the DS2 test target and the oil-temperature lift —
         * four separate lockouts replaced by one channel that shows the target moving.
         *
         * It does NOT reveal the A/C: K_LFR_NSOLL_AC is 870 rpm and so is the warm base target, so
         * the compressor engaging moves this by nothing. That is what KKOS_ST is for.
         */
        llrNSoll: { symbol: 'llr_n_soll', offset: 2, format: 'uint16', scale: 1.0, add: 0 } as FieldDef,
        /**
         * UB — battery terminal voltage. Single-source offset, so it is plausibility-gated before
         * it is believed (see the idle run's ubPlausible band) rather than trusted outright.
         *
         * The reason to want it is not voltage compensation, it is the absence of it:
         * KL_LLS_UB_KORR is all zeros in this calibration, so the idle valve duty does NOT correct
         * for voltage. A load step therefore really does change the air the valve passes at a fixed
         * duty — an electrical load is a disturbance the feedforward cannot see, and this is the
         * only channel that shows it happening.
         */
        ub: { symbol: 'ub', offset: 16, format: 'uint16', scale: 0.1, add: 0 } as FieldDef,
    },
};

/**
 * Selection 19 "Operating Measurements" (90 bytes) — lambda controller trim (STFT-equivalent), and
 * the tank-ventilation channels that ride along in the same response.
 */
export const OPERATING_MEASUREMENTS_BLOCK = {
    selection: 19,
    expectedLength: 90,
    fields: {
        stft1: { symbol: 'la_f_regler1', offset: 40, format: 'uint16', scale: 3.0517578125e-05, add: 0 } as FieldDef,
        stft2: { symbol: 'la_f_regler2', offset: 42, format: 'uint16', scale: 3.0517578125e-05, add: 0 } as FieldDef,

        // --- tank ventilation ---------------------------------------------------------------
        // Three more fields out of the SAME 90-byte response the two above already fetch. No extra
        // round trip, no cost to the sample rate — the bytes were being discarded.
        //
        // Worth having because evaporative purge is the largest known threat to the reproducibility
        // of a VE log, and until now this app had no way to see whether it was happening. karter16,
        // thread 242281 #161: "in my experience this makes a MASSIVE difference to reproducibility,
        // to the point that I personally wouldn't bother attempting tuning runs without it.
        // Occasionally you get a lucky run where it is mostly not active ... but most of the time it
        // has a significant impact on the end result."
        //
        // It reaches the numbers this app reads by two independent routes. Purged vapour is fuel the
        // DME did not inject, so the lambda controller trims for it and `la_f_regler` moves — the
        // one input the whole VE correction is derived from. And the DME's own purge estimate is
        // subtracted from the air mass in m_calc (decomp/master/0216e2.txt), so `rf_p_saug` and
        // therefore `rf` move as well. Stock KF_TE_N_RF_TVTE runs 94-99.6% duty above 2500 rpm at
        // mid load, which is exactly the region worth tuning.
        //
        // Offsets from the reference catalog (DmeLiveValueCatalog.cs:138, :152, :168). Same caveat
        // as `rf`/`tabg` in selection 3 above, and for the same reason: the master's responder
        // (decomp/master/030b84.txt case 0x18) zeroes payload 38..47 — but that identical loop also
        // zeroes 40 and 42, where la_f_regler1/2 are read successfully on a real car. The
        // "slave fills them in afterwards" reading covers all of them or none. If tetv reads a flat
        // zero on the car while the engine is clearly purging, that is evidence against the
        // interpretation of offsets 40/42 as well, which is worth knowing either way.

        /** TETV — tank-vent valve pulse time. 0 means the valve is commanded shut. */
        tankVent: { symbol: 'tetv', offset: 38, format: 'uint16', scale: 0.002, add: 0 } as FieldDef,
        /** TEFC_LL_ST — the idle functional-check state machine. Non-zero means the check is running,
         *  and states 0x10-0x15 are the one path that drives TETV from TEFC rather than from the
         *  duty map, i.e. the one path K_TE_TVTE_GA = 0 does NOT gate. Logged so that claim can be
         *  tested rather than assumed. */
        tankVentCheckState: { symbol: 'tefc_ll_st', offset: 62, format: 'uint8', scale: 1.0, add: 0 } as FieldDef,
        /** TEFC_ED — the tank-vent diagnostic handle. Watch this after disabling purge: DTC 24
         *  (tank-venting valve) is exactly the code a permanently-shut valve would set. */
        tankVentDiag: { symbol: 'tefc_ed', offset: 88, format: 'uint8', scale: 1.0, add: 0 } as FieldDef,
        /** LA_FREEZE_FLAG — logged, never acted on. The symbol exists only in the reference catalog;
         *  the translated Funktionsrahmen has no "freeze" anywhere in the lambda module, so what
         *  this byte means is genuinely unknown. See its registry entry for the experiment that
         *  would settle it. Reading it is free — the master zeroes offsets 84..89 and the slave
         *  fills them, exactly like tetv and the pair above. */
        lambdaFreeze: { symbol: 'la_freeze_flag', offset: 89, format: 'uint8', scale: 1.0, add: 0 } as FieldDef,
        /** LLS_TV — idle valve duty, %. 3.0 or 75.0 means the limp branch, not a normal rail. */
        llsTv: { symbol: 'lls_tv', offset: 75, format: 'int15', scale: 0.02, add: 0 } as FieldDef,
        /** MD_LLRI — the idle governor's I term, Nm, signed. The measurement the idle autotune is
         *  built on, and the reason this block still has a slow lane on an idle run: it is the
         *  cross-check that the RAM address is the same number. */
        mdLlri: { symbol: 'md_llri', offset: 77, format: 'int15', scale: 0.1, add: 0 } as FieldDef,
        /** FR_REGLER — the filling regulator's own output. Never an input to the estimate; logged
         *  because 40-fr-adaptation-bug.md makes it the confound of record for anything measured
         *  at idle, and a Terra-program DME leaves a standing error in exactly this region. */
        frRegler: { symbol: 'fr_regler', offset: 79, format: 'int15', scale: 0.1, add: 0 } as FieldDef,
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
        llrNSoll: decodeField(payload, f.llrNSoll),
        ub: decodeField(payload, f.ub),
        rpm: decodeField(payload, f.rpm),
        coolantTemp: decodeField(payload, f.coolantTemp),
        rawLoad: decodeField(payload, f.rawLoad),
        rf: decodeField(payload, f.rf),
        exhaustTemp: decodeField(payload, f.exhaustTemp),
        wdk1: decodeField(payload, f.wdk1),
    };
}

export function decodeOperatingMeasurementsBlock(payload: Uint8Array) {
    const f = OPERATING_MEASUREMENTS_BLOCK.fields;
    return {
        llsTv: decodeField(payload, f.llsTv),
        mdLlri: decodeField(payload, f.mdLlri),
        frRegler: decodeField(payload, f.frRegler),
        stft1: decodeField(payload, f.stft1),
        stft2: decodeField(payload, f.stft2),
        // Null when this DME's block is shorter than the offset — a different fact from a decoded 0,
        // and the distinction matters here more than usual: `tetv: 0` is "the valve is shut", which
        // is the reading a tuning run wants to see, while `tetv: null` is "we never found out".
        tankVent: decodeField(payload, f.tankVent),
        tankVentCheckState: decodeField(payload, f.tankVentCheckState),
        tankVentDiag: decodeField(payload, f.tankVentDiag),
        lambdaFreeze: decodeField(payload, f.lambdaFreeze),
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
