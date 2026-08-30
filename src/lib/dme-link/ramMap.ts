/**
 * DS2 read access to the master's **live RAM**, via the same control 0x06 the tune read uses.
 *
 * ## Why this exists
 *
 * The eight predefined live-value blocks are the whole of what `READ_IO_STATUS` (0x0B) can give,
 * and every indicated-torque channel in that catalogue lives in selection 83 — which is not
 * telemetry at all. Selection 83 returns a 52-byte EGAS fault freeze-frame: master `0x024A66`
 * copies the signals in once and latches on byte 0 (`tst.b (a1) / bne.w $24b82`), and every later
 * event only increments that counter (`0x024B82: cmpi.b #$ff,(a1) / addq.b #$1,(a1)`). On a healthy
 * car it is 52 zero bytes forever. An inertia measurement that needs torque cannot be built on it,
 * and one was, and it produced nothing.
 *
 * Control 0x06 is a different mechanism and it does reach live RAM. The DME resolves a read through
 * a **region table** at master `0x3AD6` — 65 entries of `{ id, variant, lo, hi }`, 10 bytes each —
 * in `flash_req_parse` (master `0x00289C`). Four of those entries are RAM windows, and the torque
 * cluster is inside one of them.
 *
 * ## Why it is safe to send while the engine is running
 *
 * Three independent reasons, all recovered from the binary rather than assumed:
 *
 * 1. **The handler is a byte copy.** Segments 0x01/0x04 dispatch to `0x001FD8`, which after the
 *    region bounds check copies `count` bytes into the response buffer. No unlock, no programming
 *    mode, no state change. (Its one quirk: bytes in `0x4000`-`0x4018` come back as `0xFF`.)
 * 2. **The command gate is strictly weaker than the one live values already pass.** The application
 *    command table at master `0x3A1F0` admits a command when `mask & $ffd003 == 0`; selection reads
 *    (0x0B) carry mask `0xA0` and memory reads (0x06) carry `0x20`. `0xA0` clearing implies `0x20`
 *    clears, so anywhere `pollLiveMeasurement` works, this works.
 * 3. **The tune read already does it.** `readRange` sends 0x06 with no login at all.
 *
 * ## Reading the table
 *
 * A `variant` of `0xFF` means "no variant nibble" and the 24-bit address is used literally; other
 * entries take the top nibble of the address as a variant selector and mask it out. The RAM windows
 * are all `0xFF` entries, so the addresses below are the CPU's own addresses.
 *
 *   segment 0x01  ->  0x00FF8000 - 0x00FF8FFF   (4 KB)
 *   segment 0x04  ->  0x00FFD000 - 0x00FFEFFF   (8 KB)
 *
 * The interpretation is corroborated against three reads this app already performs: segment 0 with
 * address `0x200000`/`0xA00000` matches the table's 32 KB entries exactly, and the reference tool's
 * full read (segment 5, address 0, 512 KB) matches the 16 MB entry.
 *
 * **Slave RAM is not available on this calibration.** `0x001FD8` compares master `0x3FFC` against
 * `'M'`, and this image holds `4D 4D` ("MM"), which routes segments 0x08/0x0A/0x0B/0x0C to error
 * 0x07. Every signal here is master-side, so nothing needs it — but a probe must not read a failure
 * there as a broken link.
 */

/** One contiguous region the DME will serve a control-0x06 read from. `hi` is exclusive. */
export interface RamWindow {
    segment: number;
    lo: number;
    hi: number;
}

export const Mss54HpRamWindows = {
    /** `0x00FF8000`-`0x00FF8FFF`. Torque interventions, gear, overrun state, vehicle speed. */
    low: { segment: 0x01, lo: 0x00FF8000, hi: 0x00FF9000 },
    /** `0x00FFD000`-`0x00FFEFFF`. Momentenmanager torque chain, engine speed, temperatures. */
    high: { segment: 0x04, lo: 0x00FFD000, hi: 0x00FFF000 },
} as const satisfies Record<string, RamWindow>;

export const RAM_WINDOW_LIST: readonly RamWindow[] = Object.values(Mss54HpRamWindows);

/**
 * The DME's own clamp on a read count, from `flash_req_parse`: `cmpi.l #$80,(a3)` at `0x002A16`
 * truncates anything larger to 128. Asking for more does not error, it silently returns fewer bytes
 * — so this is enforced here rather than discovered as a short response.
 */
export const RAM_READ_MAX_COUNT = 0x80;

/**
 * Live RAM signals, with the sizes and scalings the block-83 catalogue already carried.
 *
 * **The addresses and the scalings come from the same place, which is what makes them trustworthy.**
 * `0x024A66` builds the EGAS freeze-frame by copying these exact RAM locations into exactly the
 * offsets the reference `DmeLiveValueCatalog` documents for selection 83:
 *
 *   0x024AD2:  move.b $ffedd0.l, $12(a1)     N40             -> block 83 offset 18
 *   0x024ADA:  move.b $ff805e.l, $13(a1)     D_N40           -> offset 19
 *   0x024B18:  move.w $ffd8be.l, $22(a1)     MD_IND_WUNSCH   -> offset 34
 *   0x024B28:  move.w $ff81a6.l, $26(a1)     MD_IND_NE       -> offset 38
 *   0x024B30:  move.w $ffd8e6.l, $28(a1)     MD_IND_OPT_KORR -> offset 40
 *   0x024B60:  move.b $ff8180.l, $30(a1)     MD_DYN_ST       -> offset 48
 *   0x024B68:  move.b $ff8250.l, $31(a1)     GANG            -> offset 49
 *   0x024B70:  move.b $ff80bb.l, $32(a1)     S_KRAFTSCHLUSS  -> offset 50
 *   0x024B78:  move.b $ff8247.l, $33(a1)     SA_WE_ST        -> offset 51
 *
 * Twenty fields, all verbatim `move.b`/`move.w`, no scaling applied on the way in. So a channel the
 * catalogue calls `uint16 x 0.1 Nm` at offset 40 is a `uint16 x 0.1 Nm` at `0xFFD8E6` — the one
 * thing the freeze-frame was ever good for is proving where its own contents live.
 */
export interface RamSignal {
    /** Which `Mss54HpRamWindows` segment serves this address. */
    segment: number;
    address: number;
    /** Bytes. The decode format follows from this and `signed`. */
    size: 1 | 2;
    signed: boolean;
    scale: number;
    unit: string;
}

export const Mss54HpRamSignals = {
    /**
     * Indicated torque **after intervention** (`nach Eingriff`) — the torque actually produced.
     *
     * This, and not `MD_IND_OPT_KORR`, is the channel an inertia regression wants. `md_eta_calc`
     * (slave `0x0155AA`) builds it through the ignition-efficiency term `ETA_NE`, so it follows a
     * retard; `MD_IND_OPT_KORR` is the optimal-timing value and therefore **overstates torque
     * exactly during the transients a pedal sweep is made of** — `KL_DYN_TZ_DBGR` pulls 3-12 degrees
     * out on a fast tip-in.
     *
     * Unsigned, so it cannot go below zero: under overrun cut it reads 0 rather than negative. That
     * is not a defect for this use, it is the anchor — zero indicated torque with a large negative
     * acceleration is the cleanest point on the line, and it is the point a pedal sweep alone never
     * reaches.
     */
    MD_IND_NE: { segment: 0x01, address: 0x00FF81A6, size: 2, signed: false, scale: 0.1, unit: 'Nm' },
    /** Slew-limiter state. Bits 4-6 mean the tip-in or dashpot limiter actually clipped this cycle. */
    MD_DYN_ST: { segment: 0x01, address: 0x00FF8180, size: 1, signed: false, scale: 1, unit: '' },
    /** Overrun fuel cut. Bit 3 = cut ACTIVE; bit 0 is only "armed" and bit 5 is sticky. */
    SA_WE_ST: { segment: 0x01, address: 0x00FF8247, size: 1, signed: false, scale: 1, unit: '' },
    /** Calculated gear; 0 is neutral. */
    GANG: { segment: 0x01, address: 0x00FF8250, size: 1, signed: false, scale: 1, unit: '' },
    /** Net crank torque as the DME models it: `MD_IND_NE - MD_IND_SCHLEPP - MD_IND_VERBRAUCHER`. */
    MD_MOTOR: { segment: 0x01, address: 0x00FF817E, size: 2, signed: false, scale: 0.1, unit: 'Nm' },
    /** Torque request before the tip-in/dashpot filter. */
    MD_FW: { segment: 0x04, address: 0x00FFD8B0, size: 2, signed: false, scale: 0.1, unit: 'Nm' },
    /** After it. `MD_FW_FILTER - MD_FW` is what `KF_MD_LS_KOMF` actually did, measured not inferred. */
    MD_FW_FILTER: { segment: 0x04, address: 0x00FFD8B2, size: 2, signed: false, scale: 0.1, unit: 'Nm' },
    /** Tip-in limiter delta. Previously recorded as unreadable over DS2; it is not. */
    MD_LS_DELTA: { segment: 0x04, address: 0x00FFD8B8, size: 2, signed: false, scale: 0.1, unit: 'Nm' },
    /** Dashpot limiter delta. */
    MD_DP_DELTA: { segment: 0x04, address: 0x00FFD8BA, size: 2, signed: false, scale: 0.1, unit: 'Nm' },
    /** Indicated torque at optimal ignition. Kept for the filter work; NOT for the inertia fit. */
    MD_IND_OPT_KORR: { segment: 0x04, address: 0x00FFD8E6, size: 2, signed: false, scale: 0.1, unit: 'Nm' },
    /**
     * Drag torque as the DME models it — and **not** a usable `M_loss(n)`.
     *
     * `MD_Minimum_Moment` (master `0x017542`) computes it as
     * `(MD_MIN_F_LLRA * (MD_LLRA_KO + MD_LLRA)) >> 10`, then floors it at zero. `MD_LLRA` is the
     * learned **idle** adaptation, so this tracks what the engine needs at idle rather than
     * resolving friction against engine speed. Dividing a coast-down gradient by it would import
     * that model's whole error into J multiplicatively. Exposed because it is worth *seeing* next to
     * the regression's own intercept, not because it can replace it.
     */
    MD_IND_SCHLEPP: { segment: 0x04, address: 0x00FFD886, size: 2, signed: false, scale: 0.1, unit: 'Nm' },
    /**
     * The lambda controller's multiplicative trim, bank 1 — the same number block 19 offset 40 is.
     *
     * Not a new channel. It is the ONE channel a VE log needs from block 19, and block 19 costs 90
     * bytes of payload plus the longest turnaround of any block on this ECU to deliver it: the
     * signal is written by the SLAVE, so the master waits for the overlay before it can answer.
     * Four bytes of master RAM carry both banks, and the master already has them.
     *
     * The address comes from the same kind of evidence the torque cluster above does — the 0401
     * master disassembly (`graph.json`, `r:master:*`) — and the ENCODING comes from the freeze-frame
     * argument this file is built on: the block-19 catalogue calls `la_f_regler1` a
     * `uint16 x 3.0517578125e-05` (that is 2^-15, so 1.000 is 0x8000), and nothing scales it on the
     * way into the block. So the raw word here is the raw word there.
     *
     * **Believed, not trusted.** The claim "these four bytes equal block 19 offsets 40-43" is
     * checked on the car before a run uses it and re-checked throughout — see `LAMBDA_TRIM_RAM_READ`
     * and the truth gate in `logProfile.ts`. An address that is right in a disassembly and wrong on
     * this particular calibration would otherwise produce a whole drive of plausible, wrong trim.
     */
    LA_F_REGLER1: { segment: 0x01, address: 0x00FF80CA, size: 2, signed: false, scale: 3.0517578125e-05, unit: '' },
    /** Bank 2. Adjacent to bank 1, so one four-byte read covers both. */
    LA_F_REGLER2: { segment: 0x01, address: 0x00FF80CC, size: 2, signed: false, scale: 3.0517578125e-05, unit: '' },
    /**
     * Intake air temperature — the one signal the Alpha-N fuel path does NOT have and the MAP path
     * cannot work without.
     *
     * `tan_calc` (master `0x01B3AA`) reads an NTC on an A/D channel, linearises it through
     * `KL_TAN_NTC` and filters it, then produces two things:
     *
     *     tan_m = (tan_filter * 5 / 2) + 0x8CC     absolute temperature, 0.1 K
     *     TAN   = (tan_filter + 2) >> 2            the byte this reads, degC + 48
     *
     * The offset is confirmed by the pair: raw 48 gives `tan_m` 2732 = 273.2 K = 0 degC, and raw 68
     * gives 2932 = 20 degC. Same encoding as `tmot` in block 3, which is why the scale and offset
     * below match that field exactly.
     *
     * **Why a VE log needs it.** `m_calc` (master `0x0216E2`) computes the MAP-derived filling as
     * `saug_m = p_saug_m * hubvolumen_r_verh / tan_m` — the ideal gas law, with this temperature as
     * the T. That is the DME's density compensation, it feeds `rf_p_saug_i`, and the tuning patch
     * (`k_rf_cfg` bit 4) switches it off. So a log taken patch-on carries the full seasonal density
     * difference in its lambda trim, with nothing recorded to say what the density was. A table
     * tuned in midwinter and re-measured in midsummer differs by 278/323 = 14 % for that reason
     * alone, and the app had no way to tell that apart from a real VE error.
     */
    TAN: { segment: 0x04, address: 0x00FFEDD9, size: 1, signed: false, scale: 1, unit: 'degC' },

    /**
     * The ambient-pressure and charge-temperature cluster, `0xFFED38`-`0xFFED47`.
     *
     * Ten bytes of contiguous RAM that answer, together, the question a VE log could not previously
     * ask: what air was this drive actually breathing, and how much of that had the DME already
     * taken out before the lambda trim saw anything?
     *
     * ## Why these, and why together
     *
     * `rf_soll_calc` (master `0x01A9D2`) ends with `rf_soll = (rf_soll_filtered * RF_PT_KORR) >> 12`,
     * and `rf_pt_korr_calc` (master `0x01A5D6`) builds that factor as
     * `KL_RF_TAN_KORR(TAN) * KL_RF_P_UMG_KORR(P_UMG) >> 12`. So the Alpha-N table is NOT density
     * blind — the DME scales it for ambient pressure and intake temperature on every segment, and
     * `k_rf_cfg` bit 4 (the tuning patch) does not touch that. Reproducing `RF_PT_KORR` is the only
     * way to know what the trim was measuring, and it needs both raw indices.
     *
     * `tan_m` is the other half. `k_tanm_cfg` = 1 on this calibration, so `tan_m = tan_m_adj + 2732`
     * and `tan_m_adj_calc` (master `0x0212BE`) makes it a MODELLED charge temperature —
     * `TMOT - f*(TMOT - TAN)` with `f` proportional to air mass flow — not the sensor reading. Air
     * through a hot port picks up wall heat, and less of it the faster it goes. That is the load
     * dependence a one-dimensional `KL_RF_TAN_KORR` cannot express, and it is why that curve is so
     * much flatter than the ideal gas law.
     *
     * ## Why the diagnostic bytes are not optional
     *
     * The pressure term cancels out of the measurement exactly — `actual air ∝ P` over
     * `commanded ∝ P/960.5` leaves a constant — but ONLY while the DME is using a real reading.
     * When the ambient channel faults, `p_umg_filter_calc` (master `0x01AF48`) substitutes
     * `P_UMG_ERSATZ`, which `p_umg_calc` re-learns at every key-on from the manifold sensor with the
     * engine stopped. **The substituted value is therefore a plausible number, and the fault cannot
     * be detected from the pressure itself.** `P_UMG_ED` bit 0x40 and `P_UMG_DIAG_ST` are the only
     * honest signal. And the channel does not recover until key-off with `N == 0`, so a fault that
     * appears mid-drive poisons every sample after it.
     */
    P_UMG_ED: { segment: 0x04, address: 0x00FFED39, size: 1, signed: false, scale: 1, unit: '' },
    /** `error_free` or `ersatz_value`. Non-zero means the pressure below is substituted, not measured. */
    P_UMG_DIAG_ST: { segment: 0x04, address: 0x00FFED3A, size: 1, signed: false, scale: 1, unit: '' },
    /**
     * Ambient pressure, slew-limited to 1.875 mbar/s (`K_P_UMG_MAX_GRAD`).
     *
     * A genuinely separate QADC channel from the manifold sensor: `p_umg_ad` is RJURR entry 37 at
     * `0xFFF2CA`, `p_saug_ad` is entry 28 at `0xFFF2B8`. Different transfer functions, different
     * sample rates (1 ms ring for the manifold, 100 ms task for this), separate DTCs, and the DME
     * judges the manifold sensor BY this one (`p_saug_no_filter_calc`), which would be meaningless
     * if they were the same input. It is not the MAP sensor latched at key-on.
     *
     * 1/32 mbar, which is 0.03 mbar of resolution — against 3 mbar for the `P_UMG` byte at
     * `0xFF8082`. Both are read: the byte once at run start, as a cross-check on this decode.
     */
    P_UMG_FILTER: { segment: 0x04, address: 0x00FFED3E, size: 2, signed: false, scale: 1 / 32, unit: 'mbar' },
    /** What the DME thinks the altitude is, through `KL_P_UMG_HOEHE`. Metres. */
    P_UMG_HOEHE: { segment: 0x04, address: 0x00FFED42, size: 2, signed: true, scale: 1, unit: 'm' },
    /**
     * Intake air temperature before the byte rounding — `(degC + 48) * 4`, so 0.25 degC.
     *
     * `TAN` at `0xFFEDD9` is `(tan_filter + 2) >> 2` of exactly this, so reading it here makes the
     * separate byte read redundant and gains two bits doing it.
     */
    TAN_FILTER: { segment: 0x04, address: 0x00FFED44, size: 2, signed: false, scale: 0.25, unit: 'degC' },
    /**
     * The DME's modelled charge temperature at the intake valve, 0.1 K absolute.
     *
     * The one input `m_calc` divides by: `saug_m = p_saug_m * hubvolumen_r_verh / tan_m` is the
     * ideal gas law and this is its T. NOT the sensor — see the cluster doc above.
     */
    TAN_M: { segment: 0x04, address: 0x00FFED46, size: 2, signed: true, scale: 0.1, unit: 'K' },
    /**
     * Ambient pressure as a single byte, `0xFF8082`, `mbar = 498.5 + 3 * raw`.
     *
     * **Unsigned.** The decompiler renders `P_UMG = (char)((P_UMG_FILTER - 0x3E50) / 0x60)`, and a
     * signed read looks fine on a bench: working pressures put the raw byte at 117-172, so anything
     * above 879 mbar comes back negative. The DME's own diagnostic range, 400-1150 mbar, maps to
     * -33..217, which no signed byte holds.
     *
     * Read once at run start to cross-check `P_UMG_FILTER`, not on the sample lane — it is in the
     * other window, so it cannot ride along with the cluster, and 3 mbar is too coarse to be worth
     * an exchange of its own per sample.
     */
    P_UMG_BYTE: { segment: 0x01, address: 0x00FF8082, size: 1, signed: false, scale: 3, unit: 'mbar' },
    /**
     * `T_UMG` — outside air temperature, degC + 48. **The reference the intake sensor is checked
     * against, and the one channel that can say the intake reading is right.**
     *
     * Not measured by the DME. `can_rx_62f` (master `0x03C708`) takes it off CAN message 0x62F,
     * byte 0, in sign-magnitude degrees, and stores it in the same `degC + 48` form as `TAN` and
     * `TMOT`:
     *
     *     if (byte == 0xFF)               -> fall back      // sensor/bus says "no value"
     *     if (byte & 0x80)  byte = -(byte & 0x7F)           // sign-magnitude, floored at -48
     *     T_UMG = byte + 0x30; T_UMG_ST = 0;
     *
     * **And when CAN does not deliver, it falls back to `T_UMG_ERSATZ` — which `tan_calc` maintains
     * as the running MINIMUM of `TAN`.** So on a car with no cluster on the bus, or a timed-out
     * frame, `T_UMG` is derived FROM the intake sensor and comparing the two proves nothing at all.
     * That is why `T_UMG_ST` is read beside it and why nothing here reports a temperature without
     * saying where it came from.
     */
    T_UMG: { segment: 0x01, address: 0x00FF808E, size: 1, signed: false, scale: 1, unit: 'degC' },
    /** `T_UMG_ST`. `can_rx_62f` zeroes it on a good frame and ORs in 0x80 on timeout or an invalid
     *  byte; bit 7 is the only bit whose meaning is established here. */
    T_UMG_ST: { segment: 0x01, address: 0x00FF808F, size: 1, signed: false, scale: 1, unit: '' },
    /**
     * `V` — road speed, km/h.
     *
     * One km/h per count, established by its use rather than by a scaling table: `rf_korr_calc`
     * (master `0x021A70`) tests `k_rf_korr_v_min < V` directly, and `k_rf_korr_v_min` is a byte the
     * XDF gives in km/h (stock 20).
     *
     * That comparison is the half of the EGT correction's gate this app has never been able to
     * evaluate — `EgtTables.vMin` has been decoded and unused since it was added, so a first-gear
     * pull from a standstill is scored as gate-open when the DME had `rf_korr` pinned at 1.000.
     * Logged here so the gap can be closed; USING it changes which samples become evidence, so it
     * is a separate decision from recording it. See the note on this read's cadence.
     */
    V: { segment: 0x01, address: 0x00FF8090, size: 2, signed: false, scale: 1, unit: 'km/h' },
    // --- the idle governor ---------------------------------------------------------------------
    //
    // Same argument as LA_F_REGLER1, and it lands harder here: MD_LLRI is on block 19 at offset 77,
    // so it can be truth-gated against the block exactly the way the lambda trim is — but the three
    // signals the idle measurement actually needs are three CONSECUTIVE WORDS, so one six-byte read
    // replaces a 90-byte block whose turnaround is the longest on this ECU.
    //
    // Addresses from `graph.json` `r:master:*`, and they check each other: 0xFFD8F0/F2/F4 being
    // contiguous is what a compiler does with three fields of one controller's state, and is not
    // what three unrelated coincidences look like.

    /**
     * The idle governor's integrator output, Nm — the measurement the whole idle autotune is built
     * on.
     *
     * **Its resting point is not zero.** `lfra_adapt` integrates against `K_LFR_MDADAPT_OFFSET`, so
     * a correctly calibrated warm engine parks this at MINUS that constant — -7.0 Nm on stock,
     * deliberately, to keep that much upward headroom in the feedforward. Read the offset out of
     * the binary before drawing any conclusion from this channel: treating 0 as the target would
     * call a healthy engine 7 Nm short, and at idle that is more air than the entire request.
     * See `src/lib/ecu-items/catalog/idle.ts`.
     *
     * Signed, unlike every torque channel above. Those are unsigned because they cannot go below
     * zero; this one crosses zero in normal running and spends most of its life negative.
     */
    MD_LLRI: { segment: 0x04, address: 0x00FFD8F0, size: 2, signed: true, scale: 0.1, unit: 'Nm' },
    /**
     * Idle demand adaptation, compressor OFF — and the confound MD_LLRI cannot be read without.
     *
     * `lfra_adapt` moves at most `K_LFR_DMDADAPT_MAX` (1.0 Nm) every `K_LFR_T_ADAPT` (3.0 s) above
     * 70 degC, and takes what it moves OUT of the I term (`LFR_MDI += sVar2 * -0x10`). So a warm,
     * settled car reads MD_LLRI near its resting point WHATEVER the feedforward error is: the
     * information has migrated here. Summing the two is what makes the estimate invariant to how
     * long the engine has been sitting there.
     */
    MD_LLRA: { segment: 0x04, address: 0x00FFD8F2, size: 2, signed: true, scale: 0.1, unit: 'Nm' },
    /** The same, compressor ON — a separate integrator, selected by `KKOS_ST` bit 0. Read so a
     *  dwell that straddles a compressor cycle is visibly excluded rather than quietly averaged. */
    MD_LLRA_KO: { segment: 0x04, address: 0x00FFD8F4, size: 2, signed: true, scale: 0.1, unit: 'Nm' },

    /**
     * Idle valve duty. Scale INFERRED from block 19 offset 75 (0.02 %/LSB, which is the XDF's own
     * `x/50`), so it compares against `K_LLS_TV_MIN`/`_MAX` with no conversion.
     *
     * Diagnostic, never a gate input on its own: 3.0 % or 75.0 % here is the limp branch
     * (`LLS_ST & 0x40`), not a normal rail, and reading it the other way round would turn a broken
     * idle valve into a tuning conclusion.
     */
    LLS_TV: { segment: 0x04, address: 0x00FFEF00, size: 2, signed: false, scale: 0.02, unit: '%' },
    /**
     * The idle air request the DME is actually running, kg/h — the output of
     * `KF_LLR_QVS_GRUND(N, TMOT)`.
     *
     * **This is the model gate.** Comparing it against the map interpolated out of the loaded
     * binary proves, in one exchange, that these RAM addresses are right, that the catalog's
     * addresses and scaling are right, and that the idle valve really is pure feedforward on this
     * car. After a write it proves the flash landed where it was aimed. Scale INFERRED from
     * `KF_LLS_TV`'s own y-axis encoding (`x/40`), so a disagreement of exactly 40x means the
     * inference is wrong rather than the address.
     */
    LLR_QVS: { segment: 0x04, address: 0x00FFEF16, size: 2, signed: false, scale: 1 / 40, unit: 'kg/h' },
    /** After the `K_LLR_Q_MCS` offset and the `K_LLR_QSOLL_MIN` clamp. Both are 0 on this
     *  calibration, so this should equal LLR_QVS exactly — and if it does not, the one-map premise
     *  the idle autotune rests on is false on this binary and it has to refuse rather than guess. */
    LLR_QSOLL: { segment: 0x04, address: 0x00FFEF1A, size: 2, signed: false, scale: 1 / 40, unit: 'kg/h' },

    /** Engine operating state; bit 2 (0x04) is LL. NOTE the address: `graph.json` carries this at
     *  master 0xFFE8E2 and slave 0xFFE8EC, and docs/ecu-logic/30-idle-control.md quotes the SLAVE
     *  one while discussing the master's `zustand_motor_calc`. Only the master address is inside a
     *  window this DME will serve, so that is the one read here. */
    ZUSTAND_MOTOR: { segment: 0x04, address: 0x00FFE8E2, size: 1, signed: false, scale: 1, unit: '' },
    /** A/C compressor state; bit 0 is `lfra_adapt`'s own test. Worth a whole exchange because
     *  `K_LFR_NSOLL_AC` equals the warm base target, so the compressor engaging moves `llr_n_soll`
     *  by nothing at all — the target-drift gate is blind to it, and this is the only way to see it. */
    KKOS_ST: { segment: 0x01, address: 0x00FF80B5, size: 1, signed: false, scale: 1, unit: '' },
    /**
     * Idle-valve status. **Bit 7 is the one that matters**, and it decides which table the fuelling
     * correction this app divides by comes from.
     *
     * `ti_load_factor` (slave `0x01C6CA`) picks `TI_F_STAT` like this:
     *
     *     (ZUSTAND_MOTOR & 0x1C) == 0        -> 0x80, i.e. 1.000
     *     LL bit set AND LLS_ST bit 7 set    -> KL_TI_N_ZWD_LL(N40)      the 0.859 curve
     *     VL bit set                         -> KF_TI_N_RF_VL(N, RF)
     *     otherwise                          -> KF_TI_N_RF(N, RF)
     *
     * Bit 7 is set only by the idle-valve DIAGNOSIS — `lls_diag` at master `0x026142` reads the
     * byte, masks it to bits 0-1, ORs in `0x80` and stores it, and clears it again at `0x026196`.
     * So at a healthy idle it is low and the branch that runs is `KF_TI_N_RF`, not the 0.859 curve.
     *
     * That distinction is the whole of `requireTiBranchProven`. It USED to refuse every idle cell
     * in the LOW LOAD corrector; it no longer refuses any, because `TI_F_STAT` left the correction
     * (session #920 — the trim does not move with the factor) and a branch that cannot change a
     * written byte is not worth a gate. The default is now OFF. The code says which branch runs;
     * this channel is how the CAR says it, which is still worth logging and no longer blocks
     * anything while it goes unlogged.
     *
     * `TI_F_STAT` itself (`0xFFE70E`) is slave RAM and cannot be reached over a DS2 session with
     * the master — which does not matter, because this byte is the entire discriminator.
     */
    LLS_ST: { segment: 0x01, address: 0x00FF823B, size: 1, signed: false, scale: 1, unit: '' },

    // --- The channels docs/csl_idle_control_from_code.md section 7.1 says to take FIRST ----------
    //
    // That document derives what actually controls warm idle from the disassembly, and its own
    // conclusion is that almost every number in it is a MODEL OUTPUT rather than a measurement.
    // These are the readings that replace the model. Two of them decide whether anything else in it
    // applies at all, so they are preconditions rather than data:
    //
    //   LFR_ZUSTAND != 2                        -> the governor is not in its idle state. Stop.
    //   |WDK_WORD - WDK_SOLL| > 1.0 %           -> KF_LFR_DQI integration and lfra_adapt are HALTED
    //   |WDK_WORD - WDK_SOLL| > 3.0 %           -> FR_REG_I is frozen at up to +/-20 % stale
    //
    // Neither is a calibration question. Both are throttle-body adaptation state, and neither image
    // contains the answer.

    /** Requested engine load, the input to the priority split in `egas_compute_throttle_target`.
     *  Scale INFERRED: the investigation derives ML raw = kg/h * 40 from `ml_mot` and `ml_norm`, and
     *  says so as an inference rather than a reading. A disagreement of exactly 40x means that
     *  inference is wrong rather than the address. */
    ML_SOLL: { segment: 0x04, address: 0x00FFD8FC, size: 2, signed: false, scale: 1 / 40, unit: 'kg/h' },
    /** The share of it the idle valve is given. Equal to ML_SOLL below the ceiling below, which is
     *  the whole content of the split — and reading them in ONE telegram is what makes that
     *  checkable rather than inferrable. */
    ML_SOLL_LLS: { segment: 0x04, address: 0x00FFD900, size: 2, signed: false, scale: 1 / 40, unit: 'kg/h' },
    /** The ceiling. `KL_LFR_SOLL_MAX_LLS(N)` via `FUN_00026FB6`, about 34 kg/h at 600 rpm against a
     *  warm idle demand near 14 — which is why the throttle plate is commanded to 0.0 % at idle and
     *  the valve carries everything. If this is ever seen BELOW ML_SOLL at settled idle, that claim
     *  is wrong and the whole authority ranking moves. */
    ML_SOLL_MAX_LLS: { segment: 0x04, address: 0x00FFD902, size: 2, signed: false, scale: 1 / 40, unit: 'kg/h' },
    /** Raw, deliberately. The filling request and the FR-corrected version of it ride in the same
     *  telegram as the torque cluster; their units were not recovered, so they are reported as the
     *  DME holds them rather than converted through a factor nobody has checked. */
    MD_RF_SOLL: { segment: 0x04, address: 0x00FFD8F8, size: 2, signed: false, scale: 1, unit: 'raw' },
    /** Raw, same reason. `MD_RF_KORR = (FR_REGLER * MD_RF_SOLL) >> 15`, so the ratio of these two
     *  IS the filling regulator's multiplicative authority, with no scaling needed to see it. */
    MD_RF_KORR: { segment: 0x04, address: 0x00FFD8FE, size: 2, signed: false, scale: 1, unit: 'raw' },

    /** Commanded throttle angle. Exactly 0.0 % at settled warm idle if the split behaves as the
     *  disassembly says; anything else is the finding. */
    WDK_SOLL: { segment: 0x04, address: 0x00FFE6FE, size: 2, signed: false, scale: 0.1, unit: '%' },
    /** The pedal-side target, one word before the ceiling below it. Free — it is inside the same
     *  six-byte read. */
    EGAS_SOLL: { segment: 0x04, address: 0x00FFE6FA, size: 2, signed: false, scale: 0.1, unit: '%' },
    /** `KF_EGAS_MAX_WDK` is 100.0 % in every cell and the code clamps to 1000 two instructions
     *  later, so this should read 100.0 always. Read as a cheap check that the decode is right. */
    EGAS_MAX_WDK: { segment: 0x04, address: 0x00FFE6FC, size: 2, signed: false, scale: 0.1, unit: '%' },
    /** Actual throttle position, the other half of the precondition test. Same 0.1 %/LSB the block-3
     *  `wdk1` channel uses. */
    WDK_WORD: { segment: 0x04, address: 0x00FFECF8, size: 2, signed: false, scale: 0.1, unit: '%' },

    /** The filling regulator's multiplicative output. `FR_REGLER = FR_REG_I - 0x8000` and
     *  `MD_RF_KORR = (FR_REGLER * MD_RF_SOLL) >> 15`, so 0x8000 is unity — hence 1/32768, the same
     *  convention `LA_F_REGLER1` already uses here. A PURE integrator on the same actuator as the
     *  idle governor: the investigation names it as the second of three integrators in series and
     *  the one whose time constant matches the reported 1-3 s hunt. */
    FR_REGLER: { segment: 0x04, address: 0x00FFE9F6, size: 2, signed: false, scale: 1 / 32768, unit: '' },
    /** The third integrator, and the one that survives key-off. Scale from `K_FR_MLADAPT_MAX`'s own
     *  encoding (raw 3840 = +3.0 kg/h, i.e. x/1280). */
    FRA_ML_ADAPTION: { segment: 0x04, address: 0x00FFEA06, size: 2, signed: true, scale: 1 / 1280, unit: 'kg/h' },
    /**
     * The idle governor's own I term, BEFORE the shift that makes MD_LLRI.
     *
     * `MD_LLRI = ((LFR_I_AFR + 0xF) >> 4) + ((LFR_MDI + 0xF) >> 4)`, so MD_LLRI is a SUM of two
     * integrators and reading it alone cannot say which one moved. Scale 1/160 follows from that
     * shift against MD_LLRI's 1/10 — which is itself the reading that makes the adaptation's fixed
     * point -7.0 Nm rather than -112.0, and is worth confirming on the car rather than assuming.
     */
    LFR_MDI: { segment: 0x04, address: 0x00FFEA32, size: 2, signed: true, scale: 1 / 160, unit: 'Nm' },
    /** The Anfahrregelung I term, the other half of MD_LLRI. */
    LFR_I_AFR: { segment: 0x04, address: 0x00FFEA54, size: 2, signed: true, scale: 1 / 160, unit: 'Nm' },
    /**
     * The governor's state machine, one-hot. State 2 is the settled idle regulator; outside it the
     * integrator does not integrate and the adaptation does not adapt.
     *
     * Size 1 because the recovered code compares it as a byte. If this reads 0 on an engine that is
     * plainly idling, try 0x00FFEA39 — the whole surrounding block arrives in one read, so both
     * bytes are on screen either way.
     */
    LFR_ZUSTAND: { segment: 0x04, address: 0x00FFEA38, size: 1, signed: false, scale: 1, unit: '' },

    /**
     * The MULTIPLICATIVE long-term store, per bank. Same 1/32768 convention as `la_f_regler`.
     *
     * Long-term learning is TWO stores in different zones, and which one a sample's error went to
     * is decided by `LAA_ST`'s zone bits (the enable function, slave `0x019B90`):
     *
     *   bit 5  ML > K_LAA_ML_SU2 (40 kg/h) AND rf > K_LAA_RF_SU2 (0.20)      -> learns LAA_F
     *   bit 6  ML < K_LAA_ML_SO1 (30 kg/h) AND N < 1200 AND V < 5 km/h      -> learns LAA_OFFSET
     *
     * So `laa_f` learns in DRIVEN part load (slave `0x019E26`: `laa_f += (la_f_regler-1)/202` per
     * cycle, clamped 0.75..1.25) and CANNOT learn at a stationary idle — there the error goes into
     * `LAA_OFFSET` instead, an ADDITIVE term on injection time (see TI_OFFSET_ADAPT1 below). An
     * earlier reading of Funktionsrahmen 5.01 had the factor learning at idle; the disassembly says
     * otherwise, and the disassembly wins. Both stores are APPLIED everywhere once learned.
     */
    LAA_F1: { segment: 0x01, address: 0x00FF80CE, size: 2, signed: false, scale: 3.0517578125e-05, unit: '' },
    LAA_F2: { segment: 0x01, address: 0x00FF80D0, size: 2, signed: false, scale: 3.0517578125e-05, unit: '' },
    LAA_REGLER1: { segment: 0x01, address: 0x00FF80D2, size: 2, signed: false, scale: 3.0517578125e-05, unit: '' },
    LAA_REGLER2: { segment: 0x01, address: 0x00FF80D4, size: 2, signed: false, scale: 3.0517578125e-05, unit: '' },

    // NO ADDITIVE-STORE CHANNEL. `TI_OFFSET_ADAPT1/2` live at 0xFFD922/24 in SLAVE RAM, and the
    // slave is not served on this image (see the header: 'MM' routes every slave segment to error
    // 0x07). The master's 0xFFD922 region is the rev limiter's (MD_NBEGR_T at 0xFFD926, master
    // 0x016D3A), which a session #923 read confirmed the hard way: a bit-constant -30720 'us',
    // sixty times the DME's own +/-0.5 ms clamp. The DS2 status dispatcher (master 0x037316)
    // serves USV/USN, la_f_regler and laa_f — no additive case — and no DS2 block carries it, so
    // there is nothing to point a read at.
    //
    // What stands instead is the coupled init: slave 0x019C3C clears LAA_OFFSET1/2 and sets
    // LAA_F1/2 to 0x8000 in the same function, and the PATCH freezes both learners
    // (K_LAA_TMOT_MIN = 100 degC empties the enable window). LAA_F reading a bit-exact 0x8000 on
    // the car therefore says both stores sit at init: factor 1.000, offset 0.

    // ---- The torque reserve, and the steering angle that arms it -------------------------------
    //
    // These exist because the investigation's central claim — that at warm idle the governor has NO
    // fast path, only a 74.9 ms air actuator — reduces to `MD_RES == 0`. `lfr_calc` at 0x026A4C does
    // `btst.b #$1, $FFD910`, and when that bit is down it falls through to 0x026A6A `clr.w $FF8240`,
    // wiping MD_LLR_TZ. The reserve is not a side topic: it is the switch on the ignition authority.
    //
    // The document listed the encoding of LWS_LRW as its single highest-priority unverified
    // conversion, because if the steering signal were offset-coded (centre near raw 12800) the
    // reserve would read 10 Nm going straight, the bit would be UP, and the fast ignition loop would
    // be alive — which moves the top of the authority ranking and turns two "do not touch" rows into
    // the first lever for hunting. It is settled in the listing now, four ways:
    //
    //   1. `can_rx_1f5` 0x03C82E-0x03C838: `tst.w d2 / bge / andi.w #$7fff,d2 / neg.w d2` — a
    //      sign-magnitude to two's-complement conversion. The result is signed and zero-centred.
    //   2. `can_rx_1f5` 0x03C884: on a sensor fault (LWS_STAT = 0x83) it writes `clr.w LWS_LRW`.
    //      Zero is the SAFE value, which it could not be if zero meant full lock.
    //   3. `md_res_calc` 0x017CAE-0x017CC0: `move.w LWS_LRW,d2 / bge / neg.w d2` then
    //      `klu_wint(KL_MD_RES_LRW, d2)` — the curve is indexed on |angle from centre|. klu_wint
    //      reads that index at `$14(a7)`, the LOW word of the pushed long, so the upper half of d2
    //      (which md_res_calc never initialises on this path) is not read; and 0x04098E
    //      `cmp.w $2(a0),d0 / bhi` returns y[0] for any index at or below x[0].
    //   4. The calibration's own shape: `KL_FZ_RADIUS_LRW` (master 0xB42A) uses the SAME
    //      `x * 0.04375 Grad` axis and maps 0.04375 deg -> 6553.5 m turn radius, 542.76 deg -> 4.0 m.
    //      Straight ahead is 0 and full lock is about 543 deg. The offset reading would have to claim
    //      a 6.5 km turn radius at full lock.
    //
    // So `KL_MD_RES_LRW`'s window (520.0 / 550.0 / 560.0 / 580.0 deg -> 0 / 5 / 10 / 15 Nm, re-read
    // from the CAR image and byte-identical to TERRA) is the last ~60 degrees before the steering
    // stop, and `K_MD_RES_LRW_V` = 25.0 km/h arms it only below that speed. The governor gets a fast
    // ignition path exactly while parking, where the power steering pump can load the engine, and
    // never at the settled idle this run measures.
    //
    // Logged anyway, on the survey lane, for two reasons. It confirms end to end what the listing
    // says. And `MD_RES != 0` during a dwell means that dwell was taken under a control structure
    // the investigation does not describe, which is a precondition in the same sense as section 7.1.

    /** Steering wheel angle off centre, signed, decoded from CAN 0x1F5. Straight ahead is 0 — see
     *  above. 0.04375 deg/LSB is the E46 sensor's resolution and is the axis scaling of both
     *  `KL_MD_RES_LRW` and `KL_FZ_RADIUS_LRW`. */
    LWS_LRW: { segment: 0x01, address: 0x00FF81B8, size: 2, signed: true, scale: 0.04375, unit: 'deg' },
    /** Catalyst-heating reserve. Zero outside catalyst heating: `KF_MD_RES_KATH` is all-zero in this
     *  image and `md_res_kath_roh_calc` returns 0 when `MD_RES_KATH_FAKTOR` is 0. Read so that
     *  `MD_RES` can be DERIVED as `max(MD_RES_KATH, MD_RES_LRW)` — which is what 0x017D44-0x017D5E
     *  computes, and which says WHICH reserve is up where reading 0xFFD8CA alone would not. */
    MD_RES_KATH: { segment: 0x04, address: 0x00FFD908, size: 2, signed: false, scale: 0.1, unit: 'Nm' },
    /** The steering reserve BEFORE the rate limit — the raw curve output, ramped toward at
     *  `K_MD_RES_LRW_DELTA` (raw 5 = 0.5 Nm per 10 ms call = 50 Nm/s, so 0 to 15 Nm in 0.3 s). */
    MD_RES_LRW_ROH: { segment: 0x04, address: 0x00FFD90E, size: 2, signed: false, scale: 0.1, unit: 'Nm' },
    /** bit0 = below `K_MD_RES_LRW_V` (25 km/h), so it is UP whenever the car is stopped. bit1 = the
     *  reserve is actually non-zero, and bit1 is the one `lfr_calc` gates MD_LLR_TZ on. Reading bit0
     *  as "the reserve is active" is the easy mistake here. */
    MD_RES_LRW_ST: { segment: 0x04, address: 0x00FFD910, size: 1, signed: false, scale: 1, unit: '' },
    /** The steering reserve after the ramp and the efficiency subtraction at 0x017D14. */
    MD_RES_LRW: { segment: 0x04, address: 0x00FFD912, size: 2, signed: false, scale: 0.1, unit: 'Nm' },

    // ---- VANOS: the cam positions, and the latch that decides whether they mean anything --------
    //
    // These come from RAM rather than a DS2 block ON PURPOSE, and the reason is worth recording
    // because the obvious route is a dead end.
    //
    // DS2 selection 0x23 (block 35) is named in the notes repo as carrying evan1_soll/evan1_ist. It
    // does not. Its responder is master 0x030FF4 (dispatch: selection byte table at 0x30C06 is
    // scanned with `dbls` from 29, so table index k gives case 29-k; 0x23 sits at k=8 -> case 21 ->
    // 0x030FF4 — the same arithmetic that puts selection 3 at case 0x1c, which is what the block-3
    // note in liveValueBlocks.ts already records). Reading all 274 bytes of it gives a 39-byte
    // payload carrying N, EVAN2/AVAN2, p_saug, aq_rel_rf and the rf_diag group. A byte scan for
    // absolute references to EVAN1_IST (0xFF81DC) and AVAN1_IST (0xFF81DA) across the whole
    // ds2_handler range returns ZERO hits: no DS2 block this ECU serves carries the bank-1 cams.
    //
    // The control-0x06 RAM read does, and better: 0xFF81DA-0xFF81F3 is one 26-byte telegram inside
    // the segment-0x01 window this link already uses, and it carries not just the positions but
    // EVAN1_ST itself — so the latch is READ rather than inferred from where the cam is sitting.

    /** Intake cam actual position, degKW. Scale from the constants that bound it: K_EVAN1_SOLL_MAX
     *  is raw 600 = 60.0 degKW and K_EVAN1_DRUCK raw 525 = 52.5, so raw is degKW x 10. Signed
     *  because the adaptation drives targets to -10.0 degKW on the exhaust side. */
    EVAN1_IST: { segment: 0x01, address: 0x00FF81DC, size: 2, signed: true, scale: 0.1, unit: '°KW' },
    /** Exhaust cam actual position. Free — it is two bytes below EVAN1_IST in the same read. */
    AVAN1_IST: { segment: 0x01, address: 0x00FF81DA, size: 2, signed: true, scale: 0.1, unit: '°KW' },
    /**
     * The intake VANOS status byte, and the reason this group exists.
     *
     * **bit 3 is the oil-pressure confirmation latch.** The slave sets it at runtime 0x0244C6
     * (`ori.b #$8,(a2)`, a2 loaded with 0xFF81F0 at 0x024340) and ONLY when `EVAN1_IST_FILT` is at
     * or below `K_EVAN1_DRUCK + K_EVAN1_DRUCK_HYS` = 55.0 degKW. Warm idle commands 60.0 — the
     * mechanical stop — so the only window in which it can ever arm is the 52.5 degKW command just
     * after start. On a car whose cam cannot get there it never arms, EVAN1_SOLL stays pinned at
     * 52.5, and cylinder-individual idle balance is blocked for as long as the engine runs.
     */
    EVAN1_ST: { segment: 0x01, address: 0x00FF81F0, size: 1, signed: false, scale: 1, unit: '' },
    /** The exhaust side's status byte, adjacent to the one above. */
    AVAN1_ST: { segment: 0x01, address: 0x00FF81F1, size: 1, signed: false, scale: 1, unit: '' },
    /** VANOS error status. **bit 4 is what actually blocks the idle balance** — it is set
     *  unconditionally when EVAN1_ST bit 3 is down, and feeds LLSYNC_AKTIV. */
    VAN_ED_ST: { segment: 0x01, address: 0x00FF81F2, size: 1, signed: false, scale: 1, unit: '' },
    /** VANOS adaptation status. In LLSYNC_AKTIV bit 3 as well, so a running adaptation and a failed
     *  latch produce the same blocked balance — this byte is how they are told apart. */
    VAN_ADAP_ST: { segment: 0x01, address: 0x00FF81F3, size: 1, signed: false, scale: 1, unit: '' },

    /** The FILTERED intake position — the exact quantity the latch compares, so it is the one to
     *  judge the threshold against rather than the raw position beside it. */
    EVAN1_IST_FILT: { segment: 0x04, address: 0x00FFEB6C, size: 2, signed: true, scale: 0.1, unit: '°KW' },
    /** The intake cam TARGET. Read next to the position because the two separate the two failures
     *  that look identical from the position alone: a target pinned at 52.5 (latch never armed) and
     *  a cam that cannot reach a target of 60.0 (mechanically stuck). */
    EVAN1_SOLL: { segment: 0x04, address: 0x00FFEB6E, size: 2, signed: true, scale: 0.1, unit: '°KW' },
} as const satisfies Record<string, RamSignal>;

/** `P_UMG_BYTE`'s zero point, in mbar. `mbar = raw * 3 + this`. */
export const P_UMG_BYTE_OFFSET_MBAR = 498.5;

/** `TAN_M` is absolute; subtract this to get degrees C. */
export const KELVIN_OFFSET_C = -273.15;

/** `P_UMG_ED` bit that means the pressure being reported is a substitute, not a measurement. */
export const P_UMG_ED_SUBSTITUTING = 0x40;

/** `TAN`'s zero point, in raw counts. Same convention as `tmot` — see the signal's own doc. */
export const TAN_OFFSET_C = -48;

export type Mss54HpRamSignalName = keyof typeof Mss54HpRamSignals;

/**
 * The single read the inertia run adds to its block-3 poll.
 *
 * 40 bytes spanning `MD_DYN_ST` (`0xFF8180`) through the end of `MD_IND_NE` (`0xFF81A7`) — one
 * telegram for both, where two separate two-byte reads would cost a whole extra round trip for a
 * channel that only ever acts as a guard.
 */
export const INERTIA_RAM_READ = {
    segment: Mss54HpRamSignals.MD_IND_NE.segment,
    address: Mss54HpRamSignals.MD_DYN_ST.address,
    count: (Mss54HpRamSignals.MD_IND_NE.address + Mss54HpRamSignals.MD_IND_NE.size)
        - Mss54HpRamSignals.MD_DYN_ST.address,
} as const;

/**
 * Both lambda trim banks in one four-byte read — the exchange that replaces block 19 in a VE log.
 *
 * Four bytes against ninety, and the smaller of the two turnarounds: the traces put a control-0x06
 * read at 18-48 ms and block 19 at 85-100, because block 19 waits for the slave's overlay and this
 * does not. Both terms fall, which is the whole reason this exists.
 *
 * What it does NOT carry is `tetv`, `tefc_ll_st`, `tefc_ed` and `la_freeze_flag` — the purge and
 * freeze channels, two of which live in slave-only RAM this calibration will not serve at all. So
 * block 19 does not go away; it moves to a slow lane. See `LAMBDA_SLOW_LANE_EVERY`.
 */
/**
 * The whole density story in one telegram, on the slow lane.
 *
 * Sixteen bytes from `0xFFED38` covering `P_UMG_ED`, `P_UMG_DIAG_ST`, `P_UMG_FILTER`,
 * `P_UMG_HOEHE`, `TAN_FILTER` and `TAN_M` — see the cluster doc on `P_UMG_ED` for what each is for.
 *
 * **This replaces the one-byte intake-air read it grew out of, and costs less than adding to it.**
 * `TAN` at `0xFFEDD9` is 155 bytes past `P_UMG_FILTER`, over the DME's 128-byte clamp, so the two
 * could never share a telegram — it would have been a second exchange, a second turnaround, ~35 ms.
 * Reading `tan_filter` from inside this window instead gives the same temperature at four times the
 * resolution for fifteen extra payload bytes (~17 ms once every eight samples, ~2 ms per sample),
 * and the exchange count does not move.
 *
 * None of it needs to be fast. Ambient pressure is slew-limited to 1.875 mbar/s by the DME itself,
 * air temperature moves in tens of seconds, and `tan_m` has an 11-second time constant. The `every`
 * that the profile puts on this is about cost, not about resolution.
 */
export const AMBIENT_CHARGE_RAM_READ = {
    segment: Mss54HpRamSignals.P_UMG_ED.segment,
    address: 0x00FFED38,
    count: (Mss54HpRamSignals.TAN_M.address + Mss54HpRamSignals.TAN_M.size) - 0x00FFED38,
} as const;

/**
 * The segment-0x01 half: outside air temperature, its source flag, road speed, and the `P_UMG` byte.
 *
 * A second read, and it has to be: `T_UMG` lives in the OTHER window from the density cluster, so
 * no single telegram can hold both. Sixteen bytes from `0xFF8082` is the smallest span that covers
 * all four, and it buys three things that were missing rather than one:
 *
 *   - **`T_UMG` + `T_UMG_ST`** — the only way to check the intake sensor. Cold-soaked overnight,
 *     `TAN`, `TMOT` and `T_UMG` must agree; if they do not, the intake reading is wrong and every
 *     density argument built on it is worthless. The status byte is what stops that check being
 *     circular when CAN is not delivering (see `T_UMG`).
 *   - **`V`** — the road-speed half of the `rf_korr` gate, decoded since the EGT work and never
 *     readable until now.
 *   - **`P_UMG` byte** — a second, independently-scaled decode of the same pressure the density
 *     cluster reads as a word, so a wrong address shows up as a disagreement instead of as a
 *     plausible number.
 *
 * **Cadence is a judgement, and only one of these four is happy on a slow lane.** Ambient
 * temperature moves over minutes and the pressure byte is a check rather than a signal, so both are
 * content at any rate. `V` is not: it crosses the 20 km/h gate threshold in about a second and a
 * half from a standstill, so a stale reading mis-scores exactly the samples the gate exists to
 * exclude. Reading it per sample is not affordable — `LA_F_REGLER1` is 58 bytes further on, and one
 * telegram covering both costs 66 ms a sample — so `V` is recorded for analysis and NOT yet wired
 * into the gate. Closing that properly is its own change with its own rate decision.
 */
export const AMBIENT_TEMP_RAM_READ = {
    segment: Mss54HpRamSignals.T_UMG.segment,
    address: Mss54HpRamSignals.P_UMG_BYTE.address,
    count: (Mss54HpRamSignals.V.address + Mss54HpRamSignals.V.size)
        - Mss54HpRamSignals.P_UMG_BYTE.address,
} as const;

/**
 * How far the byte and the word are allowed to disagree before the cluster is not believed.
 *
 * The byte quantises to 3 mbar and rounds by truncation, so a 3 mbar gap is expected and 6 is the
 * most two correct decodes of the same pressure can be apart. Wider than that means one of the two
 * addresses is not what this file says it is.
 */
export const AMBIENT_PRESSURE_AGREE_MBAR = 6;

export const LAMBDA_TRIM_RAM_READ = {
    segment: Mss54HpRamSignals.LA_F_REGLER1.segment,
    address: Mss54HpRamSignals.LA_F_REGLER1.address,
    // Eight bytes, not four: LA_F_REGLER1/2 and then LAA_F1/2, which sit immediately after them.
    //
    // `la_f_regler` is the SHORT-term lambda trim — the two-point controller's own output, which
    // oscillates by construction. `laa_f` is the long-term store its mean is learned into IN DRIVEN
    // PART LOAD (ML > 40 kg/h — see the declaration). At a STATIONARY idle the absorber is the
    // additive store LAA_OFFSET, which has no readable address on this image; `laa_f` reading a
    // bit-exact 0x8000 stands in for it, through the coupled init — see the note above the
    // signal declarations. Either way, `la_f_regler` returning toward 1.000 does not by itself
    // mean the mixture is right; on a car whose stores are proven at init, it does.
    //
    // Four more bytes in a telegram that was already being sent. No extra exchange, no rate cost.
    count: (Mss54HpRamSignals.LAA_F2.address + Mss54HpRamSignals.LAA_F2.size)
        - Mss54HpRamSignals.LA_F_REGLER1.address,
} as const;

/**
 * The two-byte read the probe sends. Deliberately the smallest legal request against the window the
 * inertia run depends on: a probe that asks for more than the thing it is proving can fail for a
 * reason the real read would not have hit.
 */
/**
 * The one read the idle run cannot do without: the LFR torque cluster and the air split it feeds,
 * twenty bytes, `MD_LLRI` (0xFFD8F0) through `ML_SOLL_MAX_LLS` (0xFFD902).
 *
 * `MD_LLRI`, `MD_LLRA` and `MD_LLRA_KO` are three consecutive words, so the integrator and the
 * adaptation that drains it arrive in the SAME telegram. That matters beyond the round trip saved:
 * the error statistic is their sum, and a sum of two numbers sampled 200 ms apart while one is
 * being moved into the other is not the quantity it looks like.
 *
 * Extended past them to `ML_SOLL` / `ML_SOLL_LLS` / `ML_SOLL_MAX_LLS` for the same reason, one step
 * further down the same chain. The governor's output becomes a load request becomes the split, and
 * the split is a COMPARISON between two of these words — read in different telegrams it is a
 * comparison between two moments. Fourteen extra bytes on a read whose turnaround already dominates
 * buys the whole causal chain, skew-free, in one exchange.
 */
export const IDLE_TORQUE_RAM_READ = {
    segment: Mss54HpRamSignals.MD_LLRI.segment,
    address: Mss54HpRamSignals.MD_LLRI.address,
    count: (Mss54HpRamSignals.ML_SOLL_MAX_LLS.address + Mss54HpRamSignals.ML_SOLL_MAX_LLS.size)
        - Mss54HpRamSignals.MD_LLRI.address,
} as const;

/**
 * The governor's internals, 96 bytes, `FR_REGLER` (0xFFE9F6) through `LFR_I_AFR` (0xFFEA54).
 *
 * One read for all three integrators the investigation names as being in series on one actuator —
 * `LFR_MDI`, `FR_REGLER` and `FRA_ML_ADAPTION` — plus `LFR_ZUSTAND`, which decides whether any of
 * them is running at all. Ninety-six bytes is most of a block-19 payload, but it is a RAM read: the
 * turnaround is 35 ms against 83, and the whole set arrives in one moment rather than four.
 */
export const IDLE_GOVERNOR_RAM_READ = {
    segment: Mss54HpRamSignals.FR_REGLER.segment,
    address: Mss54HpRamSignals.FR_REGLER.address,
    count: (Mss54HpRamSignals.LFR_I_AFR.address + Mss54HpRamSignals.LFR_I_AFR.size)
        - Mss54HpRamSignals.FR_REGLER.address,
} as const;

/** Six bytes: `EGAS_SOLL`, `EGAS_MAX_WDK`, `WDK_SOLL`. The commanded half of the precondition. */
export const IDLE_THROTTLE_RAM_READ = {
    segment: Mss54HpRamSignals.EGAS_SOLL.segment,
    address: Mss54HpRamSignals.EGAS_SOLL.address,
    count: (Mss54HpRamSignals.WDK_SOLL.address + Mss54HpRamSignals.WDK_SOLL.size)
        - Mss54HpRamSignals.EGAS_SOLL.address,
} as const;

/** Two bytes, 700 addresses away from the read above and therefore its own exchange: the ACTUAL
 *  throttle position. The precondition is the difference between the two, so neither read is
 *  optional and the pair has to be close in time — both ride the same slow lane. */
export const IDLE_WDK_RAM_READ = {
    segment: Mss54HpRamSignals.WDK_WORD.segment,
    address: Mss54HpRamSignals.WDK_WORD.address,
    count: Mss54HpRamSignals.WDK_WORD.size,
} as const;

/** Twelve bytes: both banks' multiplicative trim, additive learning and multiplicative learning.
 *  The survey lane — this settles a question about the calibration rather than about the sample, so
 *  it is read a few times a run rather than a few times a second. */
export const IDLE_LAMBDA_LEARN_RAM_READ = {
    segment: Mss54HpRamSignals.LA_F_REGLER1.segment,
    address: Mss54HpRamSignals.LA_F_REGLER1.address,
    count: (Mss54HpRamSignals.LAA_REGLER2.address + Mss54HpRamSignals.LAA_REGLER2.size)
        - Mss54HpRamSignals.LA_F_REGLER1.address,
} as const;

/**
 * The torque reserve, twelve bytes, `MD_RES_KATH` (0xFFD908) through `MD_RES_LRW` (0xFFD912).
 *
 * One read rather than two because the question is `max(MD_RES_KATH, MD_RES_LRW)` — a comparison,
 * so it has to come from one moment. Note what is NOT here: `MD_RES` itself, at 0xFFD8CA. Reaching
 * it would need a 74-byte span, and the two operands are strictly more informative than the maximum
 * they produce, since they say which reserve is up.
 *
 * Survey lane. The reserve ramps in 0.3 s, but nothing about a settled idle dwell makes it move —
 * on the reading in `Mss54HpRamSignals` it is identically zero unless the wheel is near the stop.
 * Sampling it every 2.7 s is enough to catch a dwell taken with a hand on the wheel, and enough for
 * the deliberate lock-to-lock check that confirms the reading.
 */
export const IDLE_RESERVE_RAM_READ = {
    segment: Mss54HpRamSignals.MD_RES_KATH.segment,
    address: Mss54HpRamSignals.MD_RES_KATH.address,
    count: (Mss54HpRamSignals.MD_RES_LRW.address + Mss54HpRamSignals.MD_RES_LRW.size)
        - Mss54HpRamSignals.MD_RES_KATH.address,
} as const;

/** Two bytes, and in the other window, so it cannot join the read above. Bought because the reserve
 *  alone cannot distinguish "the curve says zero" from "the signal is dead": `can_rx_1f5` writes 0
 *  to this address on a sensor fault too. With the angle beside it, the check is the honest one —
 *  turn the wheel, watch this cross raw 11886 (520.0 deg), and see bit1 of `MD_RES_LRW_ST` set. */
export const IDLE_STEERING_RAM_READ = {
    segment: Mss54HpRamSignals.LWS_LRW.segment,
    address: Mss54HpRamSignals.LWS_LRW.address,
    count: Mss54HpRamSignals.LWS_LRW.size,
} as const;

/**
 * The VANOS group, 26 bytes, `AVAN1_IST` (0xFF81DA) through `VAN_ADAP_ST` (0xFF81F3).
 *
 * One read rather than several because the diagnosis is a JOINT reading: the position says where
 * the cam is, `EVAN1_ST` bit 3 says whether the latch ever armed, and `VAN_ED_ST` bit 4 says
 * whether the idle balance is consequently blocked. Split across telegrams they would be three
 * facts about three moments, and the whole point is that they are one fact about one.
 *
 * Survey lane. Cam position at a settled idle is a steady-state fact — and on the failure this
 * exists to catch it is not merely steady but permanent, since the latch cannot arm again until
 * the next start.
 */
export const IDLE_VANOS_RAM_READ = {
    segment: Mss54HpRamSignals.AVAN1_IST.segment,
    address: Mss54HpRamSignals.AVAN1_IST.address,
    count: (Mss54HpRamSignals.VAN_ADAP_ST.address + Mss54HpRamSignals.VAN_ADAP_ST.size)
        - Mss54HpRamSignals.AVAN1_IST.address,
} as const;

/** Four bytes in the other window: the filtered position the latch actually compares, and the
 *  target beside it. Two exchanges rather than one only because the two halves of this diagnosis
 *  live in different RAM segments. */
export const IDLE_VANOS_TARGET_RAM_READ = {
    segment: Mss54HpRamSignals.EVAN1_IST_FILT.segment,
    address: Mss54HpRamSignals.EVAN1_IST_FILT.address,
    count: (Mss54HpRamSignals.EVAN1_SOLL.address + Mss54HpRamSignals.EVAN1_SOLL.size)
        - Mss54HpRamSignals.EVAN1_IST_FILT.address,
} as const;

/**
 * Duty and both air requests, 28 bytes — the model gate and the rail diagnosis in one exchange.
 *
 * Slow lane. Nothing here feeds the estimate; it decides whether the estimate is allowed to exist
 * (is the valve in limp? is it against a rail? does LLR_QVS agree with the map?), and those are
 * questions about the run rather than about the sample.
 */
export const IDLE_ACTUATOR_RAM_READ = {
    segment: Mss54HpRamSignals.LLS_TV.segment,
    address: Mss54HpRamSignals.LLS_TV.address,
    count: (Mss54HpRamSignals.LLR_QSOLL.address + Mss54HpRamSignals.LLR_QSOLL.size)
        - Mss54HpRamSignals.LLS_TV.address,
} as const;

/** One byte: is the DME in its own LL state? Preferred over inferring idle from the throttle,
 *  because it is the same bit the governor's state machine is gated on. */
export const ENGINE_STATE_RAM_READ = {
    segment: Mss54HpRamSignals.ZUSTAND_MOTOR.segment,
    address: Mss54HpRamSignals.ZUSTAND_MOTOR.address,
    count: Mss54HpRamSignals.ZUSTAND_MOTOR.size,
} as const;

/** One byte, and in the other window, so it cannot be merged with the read above. Bought anyway:
 *  see the note on `KKOS_ST` — the A/C is the one disturbance no other channel can reveal. */
export const COMPRESSOR_RAM_READ = {
    segment: Mss54HpRamSignals.KKOS_ST.segment,
    address: Mss54HpRamSignals.KKOS_ST.address,
    count: Mss54HpRamSignals.KKOS_ST.size,
} as const;

/** One byte, `LLS_ST`. On the survey lane rather than beside `KKOS_ST`: bit 7 is latched by a
 *  diagnosis, so it changes on the scale of a fault appearing, not on the scale of a dwell. Once
 *  every eight samples answers "is this car on the 0.859 branch" at no useful cost to the rate. */
export const IDLE_VALVE_STATE_RAM_READ = {
    segment: Mss54HpRamSignals.LLS_ST.segment,
    address: Mss54HpRamSignals.LLS_ST.address,
    count: Mss54HpRamSignals.LLS_ST.size,
} as const;

/**
 * One byte, `MD_DYN_ST` — the only channel that says the slew limiter ACTUALLY clipped.
 *
 * `45-drivability-filters.md` §1: the tip-in path passes the driver's torque request straight
 * through whenever it is inside the allowance, and clamps only when it is not — setting bit 6 when
 * it does. So the maps alone cannot tell you whether the limiter was in the way. Without this byte,
 * "the tip-in was cut short" and "the limiter never bound and the car is doing something else" look
 * identical in a log, and they carry opposite instructions about `KF_MD_LS_KOMF`.
 *
 * Segment 0x01, which is why it cannot share a telegram with the torque words below.
 */
export const SLEW_STATE_RAM_READ = {
    segment: Mss54HpRamSignals.MD_DYN_ST.segment,
    address: Mss54HpRamSignals.MD_DYN_ST.address,
    count: Mss54HpRamSignals.MD_DYN_ST.size,
} as const;

/**
 * Twelve bytes: `MD_FW`, `MD_FW_FILTER`, `MD_LS_DELTA`, `MD_DP_DELTA` — the limiter's whole state.
 *
 * `MD_FW_FILTER - MD_FW` is what the limiter DID, measured rather than inferred from four maps
 * multiplied together, and the two DELTAs are the allowance it had while doing it. They are
 * consecutive words at 0xFFD8B0-0xFFD8BB, so the two channels the question needs bring the two that
 * explain them for no extra turnaround.
 *
 * A `MD_LS_DELTA` of 0 is unambiguous on THIS calibration and would not be on another: the freeze
 * path needs `KF_MD_LS_WE > MD_SAWE_VERH`, and `KF_MD_LS_WE` is all zeroes here, so 0 means the
 * bypass — below `K_MD_DF_NMIN` (500 rpm), below `K_MD_DF_VMIN` (3 km/h), or no drive — rather
 * than an allowance of nothing.
 */
export const SLEW_TORQUE_RAM_READ = {
    segment: Mss54HpRamSignals.MD_FW.segment,
    address: Mss54HpRamSignals.MD_FW.address,
    count: (Mss54HpRamSignals.MD_DP_DELTA.address + Mss54HpRamSignals.MD_DP_DELTA.size)
        - Mss54HpRamSignals.MD_FW.address,
} as const;

export const RAM_PROBE_READS: readonly { name: string; segment: number; address: number; count: number }[] = [
    { name: 'MD_IND_NE', segment: Mss54HpRamSignals.MD_IND_NE.segment, address: Mss54HpRamSignals.MD_IND_NE.address, count: 2 },
    { name: 'MD_IND_OPT_KORR', segment: Mss54HpRamSignals.MD_IND_OPT_KORR.segment, address: Mss54HpRamSignals.MD_IND_OPT_KORR.address, count: 2 },
    // Same window as MD_IND_OPT_KORR, so this proves nothing about the window — it proves the
    // ADDRESS, which is the thing the idle run bets on and the thing static analysis cannot settle.
    { name: 'MD_LLRI', segment: Mss54HpRamSignals.MD_LLRI.segment, address: Mss54HpRamSignals.MD_LLRI.address, count: 2 },
];

/**
 * Load-time invariants, at module scope so `npm run build` catches a bad constant.
 *
 * These matter more than a usual range check because one of the failures they prevent is silent: an
 * address outside its window makes the DME answer `0xB0`, which at least shows up, but a `count`
 * over 128 is truncated **without an error** — the decoder would then read a signal out of a short
 * buffer and get whatever the previous telegram left behind.
 */
(function assertRamMapIsConsistent() {
    for (const [name, sig] of Object.entries(Mss54HpRamSignals) as [string, RamSignal][]) {
        const w = RAM_WINDOW_LIST.find(x => x.segment === sig.segment);
        if (!w) {
            throw new Error(`Mss54HpRamSignals.${name} names segment 0x${sig.segment.toString(16)}, `
                + `which is not a declared RAM window`);
        }
        if (sig.address < w.lo || sig.address + sig.size > w.hi) {
            throw new Error(`Mss54HpRamSignals.${name} at 0x${sig.address.toString(16)} (+${sig.size}) falls outside `
                + `segment 0x${sig.segment.toString(16)} [0x${w.lo.toString(16)}, 0x${w.hi.toString(16)})`);
        }
    }
    const reads = [
        { name: 'INERTIA_RAM_READ', ...INERTIA_RAM_READ },
        { name: 'LAMBDA_TRIM_RAM_READ', ...LAMBDA_TRIM_RAM_READ },
        { name: 'AMBIENT_CHARGE_RAM_READ', ...AMBIENT_CHARGE_RAM_READ },
        { name: 'AMBIENT_TEMP_RAM_READ', ...AMBIENT_TEMP_RAM_READ },
        { name: 'IDLE_TORQUE_RAM_READ', ...IDLE_TORQUE_RAM_READ },
        { name: 'IDLE_ACTUATOR_RAM_READ', ...IDLE_ACTUATOR_RAM_READ },
        { name: 'ENGINE_STATE_RAM_READ', ...ENGINE_STATE_RAM_READ },
        { name: 'COMPRESSOR_RAM_READ', ...COMPRESSOR_RAM_READ },
        { name: 'IDLE_VALVE_STATE_RAM_READ', ...IDLE_VALVE_STATE_RAM_READ },
        { name: 'IDLE_GOVERNOR_RAM_READ', ...IDLE_GOVERNOR_RAM_READ },
        { name: 'IDLE_THROTTLE_RAM_READ', ...IDLE_THROTTLE_RAM_READ },
        { name: 'IDLE_WDK_RAM_READ', ...IDLE_WDK_RAM_READ },
        { name: 'IDLE_LAMBDA_LEARN_RAM_READ', ...IDLE_LAMBDA_LEARN_RAM_READ },
        { name: 'IDLE_RESERVE_RAM_READ', ...IDLE_RESERVE_RAM_READ },
        { name: 'IDLE_STEERING_RAM_READ', ...IDLE_STEERING_RAM_READ },
        { name: 'IDLE_VANOS_RAM_READ', ...IDLE_VANOS_RAM_READ },
        { name: 'IDLE_VANOS_TARGET_RAM_READ', ...IDLE_VANOS_TARGET_RAM_READ },
        ...RAM_PROBE_READS.map(r => ({ name: `RAM_PROBE_READS.${r.name}`, segment: r.segment, address: r.address, count: r.count })),
    ];
    for (const r of reads) {
        if (r.count <= 0 || r.count > RAM_READ_MAX_COUNT) {
            throw new Error(`${r.name}.count ${r.count} must be 1..${RAM_READ_MAX_COUNT} `
                + `(the DME truncates above that without erroring)`);
        }
        const w = RAM_WINDOW_LIST.find(x => x.segment === r.segment);
        if (!w || r.address < w.lo || r.address + r.count > w.hi) {
            throw new Error(`${r.name} spans outside segment 0x${r.segment.toString(16)}`);
        }
    }
    const covers = (read: { segment: number; address: number; count: number }, sig: RamSignal) =>
        sig.segment === read.segment
        && sig.address >= read.address
        && sig.address + sig.size <= read.address + read.count;
    for (const sig of [Mss54HpRamSignals.MD_DYN_ST, Mss54HpRamSignals.MD_IND_NE] as RamSignal[]) {
        if (!covers(INERTIA_RAM_READ, sig)) throw new Error('INERTIA_RAM_READ does not cover a signal the inertia poll decodes from it');
    }
    for (const sig of [Mss54HpRamSignals.LA_F_REGLER1, Mss54HpRamSignals.LA_F_REGLER2] as RamSignal[]) {
        if (!covers(LAMBDA_TRIM_RAM_READ, sig)) throw new Error('LAMBDA_TRIM_RAM_READ does not cover a bank the VE poll decodes from it');
    }
    for (const [name, sig] of [
        ['P_UMG_BYTE', Mss54HpRamSignals.P_UMG_BYTE], ['T_UMG', Mss54HpRamSignals.T_UMG],
        ['T_UMG_ST', Mss54HpRamSignals.T_UMG_ST], ['V', Mss54HpRamSignals.V],
    ] as [string, RamSignal][]) {
        if (!covers(AMBIENT_TEMP_RAM_READ, sig)) {
            throw new Error(`AMBIENT_TEMP_RAM_READ does not cover ${name}, which the VE poll decodes from it`);
        }
    }
    for (const [name, sig] of [
        ['P_UMG_ED', Mss54HpRamSignals.P_UMG_ED], ['P_UMG_DIAG_ST', Mss54HpRamSignals.P_UMG_DIAG_ST],
        ['P_UMG_FILTER', Mss54HpRamSignals.P_UMG_FILTER], ['P_UMG_HOEHE', Mss54HpRamSignals.P_UMG_HOEHE],
        ['TAN_FILTER', Mss54HpRamSignals.TAN_FILTER], ['TAN_M', Mss54HpRamSignals.TAN_M],
    ] as [string, RamSignal][]) {
        if (!covers(AMBIENT_CHARGE_RAM_READ, sig)) {
            throw new Error(`AMBIENT_CHARGE_RAM_READ does not cover ${name}, which the VE poll decodes from it`);
        }
    }
    for (const sig of [Mss54HpRamSignals.MD_LLRI, Mss54HpRamSignals.MD_LLRA, Mss54HpRamSignals.MD_LLRA_KO] as RamSignal[]) {
        if (!covers(IDLE_TORQUE_RAM_READ, sig)) throw new Error('IDLE_TORQUE_RAM_READ does not cover a signal the idle poll decodes from it');
    }
    for (const sig of [Mss54HpRamSignals.LLS_TV, Mss54HpRamSignals.LLR_QVS, Mss54HpRamSignals.LLR_QSOLL] as RamSignal[]) {
        if (!covers(IDLE_ACTUATOR_RAM_READ, sig)) throw new Error('IDLE_ACTUATOR_RAM_READ does not cover a signal the idle poll decodes from it');
    }
    // The reads below exist BECAUSE their signals are contiguous. If someone moves an address and
    // they stop being, each read still passes every check above while quietly costing an extra
    // exchange's worth of skew on a comparison that is only meaningful within one moment. So the
    // coverage itself is the assertion: every signal a read promised has to still be inside it.
    const R = Mss54HpRamSignals;
    const mustCover = (
        read: { segment: number; address: number; count: number },
        readName: string,
        sigs: readonly (readonly [string, RamSignal])[],
    ) => {
        for (const [sigName, sig] of sigs) {
            if (!covers(read, sig)) {
                throw new Error(`${readName} (segment 0x${read.segment.toString(16)}, `
                    + `0x${read.address.toString(16)} +${read.count}) no longer covers ${sigName}: the signals `
                    + `it exists to read in ONE telegram have moved apart, and the comparison they feed is `
                    + `no longer skew-free`);
            }
        }
    };
    mustCover(IDLE_TORQUE_RAM_READ, 'IDLE_TORQUE_RAM_READ', [
        ['MD_RF_SOLL', R.MD_RF_SOLL], ['ML_SOLL', R.ML_SOLL], ['MD_RF_KORR', R.MD_RF_KORR],
        ['ML_SOLL_LLS', R.ML_SOLL_LLS], ['ML_SOLL_MAX_LLS', R.ML_SOLL_MAX_LLS],
    ]);
    mustCover(IDLE_GOVERNOR_RAM_READ, 'IDLE_GOVERNOR_RAM_READ', [
        ['FR_REGLER', R.FR_REGLER], ['FRA_ML_ADAPTION', R.FRA_ML_ADAPTION],
        ['LFR_MDI', R.LFR_MDI], ['LFR_ZUSTAND', R.LFR_ZUSTAND], ['LFR_I_AFR', R.LFR_I_AFR],
    ]);
    mustCover(IDLE_THROTTLE_RAM_READ, 'IDLE_THROTTLE_RAM_READ', [
        ['EGAS_SOLL', R.EGAS_SOLL], ['EGAS_MAX_WDK', R.EGAS_MAX_WDK], ['WDK_SOLL', R.WDK_SOLL],
    ]);
    mustCover(IDLE_WDK_RAM_READ, 'IDLE_WDK_RAM_READ', [['WDK_WORD', R.WDK_WORD]]);
    mustCover(IDLE_VALVE_STATE_RAM_READ, 'IDLE_VALVE_STATE_RAM_READ', [['LLS_ST', R.LLS_ST]]);
    mustCover(IDLE_LAMBDA_LEARN_RAM_READ, 'IDLE_LAMBDA_LEARN_RAM_READ', [
        ['LA_F_REGLER1', R.LA_F_REGLER1], ['LA_F_REGLER2', R.LA_F_REGLER2],
        ['LAA_F1', R.LAA_F1], ['LAA_F2', R.LAA_F2],
        ['LAA_REGLER1', R.LAA_REGLER1], ['LAA_REGLER2', R.LAA_REGLER2],
    ]);
    mustCover(IDLE_RESERVE_RAM_READ, 'IDLE_RESERVE_RAM_READ', [
        ['MD_RES_KATH', R.MD_RES_KATH], ['MD_RES_LRW_ROH', R.MD_RES_LRW_ROH],
        ['MD_RES_LRW_ST', R.MD_RES_LRW_ST], ['MD_RES_LRW', R.MD_RES_LRW],
    ]);
    mustCover(IDLE_STEERING_RAM_READ, 'IDLE_STEERING_RAM_READ', [['LWS_LRW', R.LWS_LRW]]);
    mustCover(IDLE_VANOS_RAM_READ, 'IDLE_VANOS_RAM_READ', [
        ['AVAN1_IST', R.AVAN1_IST], ['EVAN1_IST', R.EVAN1_IST], ['EVAN1_ST', R.EVAN1_ST],
        ['AVAN1_ST', R.AVAN1_ST], ['VAN_ED_ST', R.VAN_ED_ST], ['VAN_ADAP_ST', R.VAN_ADAP_ST],
    ]);
    mustCover(IDLE_VANOS_TARGET_RAM_READ, 'IDLE_VANOS_TARGET_RAM_READ', [
        ['EVAN1_IST_FILT', R.EVAN1_IST_FILT], ['EVAN1_SOLL', R.EVAN1_SOLL],
    ]);
})();

/**
 * Decodes one signal out of a buffer whose first byte is `bufferAddress`.
 *
 * Returns null rather than throwing when the signal is not covered, because the caller that hits
 * this is a poll loop: a short buffer should cost one sample, not the run.
 */
export function decodeRamSignal(
    signal: RamSignal,
    buffer: Uint8Array,
    bufferAddress: number,
): number | null {
    const at = signal.address - bufferAddress;
    if (at < 0 || at + signal.size > buffer.length) return null;
    let raw: number;
    if (signal.size === 1) {
        raw = buffer[at];
        if (signal.signed && raw > 0x7F) raw -= 0x100;
    } else {
        raw = (buffer[at] << 8) | buffer[at + 1];
        if (signal.signed && raw > 0x7FFF) raw -= 0x10000;
    }
    return raw * signal.scale;
}

/** True when `[address, address + count)` is entirely inside a declared window for that segment. */
export function isRamReadInRange(segment: number, address: number, count: number): boolean {
    if (count <= 0 || count > RAM_READ_MAX_COUNT) return false;
    const w = RAM_WINDOW_LIST.find(x => x.segment === segment);
    return !!w && address >= w.lo && address + count <= w.hi;
}
