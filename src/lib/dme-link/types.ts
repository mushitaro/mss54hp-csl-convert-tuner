import { AdaptationSnapshot } from './adaptationBlocks';
import type { SpotWindow } from './spotCheck';
import { FlashCounterInfo } from './flashCounter';
import { ServiceBlockPointers } from './serviceBlockReport';
import type { Ds2EncodingChecksum, Ds2SupportedBaud } from './ds2';
import type { SeedMap } from './fastEntry';
import type { LinkEventLogSnapshot } from './linkEventLog';
import type { TransferTimingReport } from './transferTiming';
import type { LogExchange } from '@/lib/log-engine/logProfile';

export type { AdaptationSnapshot, FlashCounterInfo };

/** Raw service-block bytes plus the DME's own pointers, for buildServiceBlockReport to analyse. */
export interface ServiceBlockDump {
    master: Uint8Array;
    slave: Uint8Array;
    pointers: ServiceBlockPointers;
}

export interface DmeIdentity {
    vin: string;
    aif: string;
    softwareVersion: string;
    /**
     * Remaining programming headroom on both processors, read at connect alongside VIN/AIF/SW.
     *
     * `null` when it could not be read, which is a different fact from 0/30 and must not be shown
     * as one — the other three fields make the same distinction with 'UNKNOWN'. A failure here
     * never fails the connection.
     */
    flashCounter: FlashCounterInfo | null;
    /**
     * The DME's own encoding-checksum verdict, read once at connect. `null` when the query failed or
     * this DME does not answer control 0x0A.
     *
     * Read here — before anything is written — precisely so that a post-write reading has something
     * to be compared against. On its own, "bits 2 and 6 are clear after the flash" is only evidence
     * if the DME recomputes on demand; if it were answering from a cached value it would say the
     * same thing either way. A before-and-after pair settles that empirically, and costs one
     * 4-byte telegram on a path that already sends a dozen.
     */
    encodingChecksum: Ds2EncodingChecksum | null;
}

/** A single live-telemetry sample, using the same field names as LogDataPoint so it can feed
 * straight into the existing log-processing/VE-calculation pipeline. */
export interface LiveMeasurement {
    /** Seconds since the run started. Note the Testo CSV path uses milliseconds for the same
     *  field name on LogDataPoint — log-engine/filter.ts detects which it is holding. */
    time: number;
    rpm: number;
    rawLoad: number;
    /** `la_f_regler1/2` — the lambda controller's output factor, DS2 selection 19.
     *
     *  OPTIONAL, and undefined means "block 19 was not read", which is what the EGT profile does.
     *  It must never be defaulted to 1.0: that is a real measurement meaning "no correction wanted",
     *  and handing it back for a block nobody fetched is the same lie as calling this channel
     *  "Lambda". A log without it cannot produce a VE map, which is correct. */
    stft1?: number;
    stft2?: number;
    /**
     * `laa_f1` / `laa_f2` — the MULTIPLICATIVE long-term lambda trim, per bank. 1.000 = the DME
     * has learned no standing factor here.
     *
     * The pair above (`stft`, from `la_f_regler`) is the SHORT-term controller: a two-point
     * regulator that steps every time the sensor crosses stoichiometric, so it oscillates whatever
     * the mixture is doing. Long-term learning drains that oscillation's mean into TWO stores in
     * different zones (`laa_st_calc`, slave 0x019B90):
     *
     *   driven part load (ML > 40 kg/h, rf > 0.20)          -> this factor, `laa_f`
     *   stationary idle (ML < 30 kg/h, N < 1200, V < 5)     -> the ADDITIVE store, LAA_OFFSET
     *
     * Both are applied everywhere once learned. So a settled short-term trim near 1.000 means a
     * long-term store took the error — WHICH store depends on where the car was when it learned.
     * The standing error is `stft x ltft x (additive term as a ratio of ti)`, and reading only the
     * first is how a 5 % error reads as 0.9 %.
     *
     * Same 1/32768 encoding as the short-term pair (0x8000 = 1.000), and the same telegram.
     */
    ltft1?: number;
    ltft2?: number;
    // There is NO channel for the additive store: it lives in slave RAM, which this image does not
    // serve over DS2, and the master's 0xFFD922 region belongs to the rev limiter — session #923
    // read a bit-constant -30720 there. What settles it instead: slave 0x019C3C initialises
    // LAA_OFFSET (to 0) and LAA_F (to 0x8000) in the same function, so `ltft` reading a bit-exact
    // 1.000 with learning frozen by the PATCH says the additive store sits at 0 too. See ramMap.
    coolantTemp?: number;
    /** RF — the DME's relative filling AFTER the EGT correction. Same block as rpm/rawLoad. */
    rf?: number;
    /** TABG — exhaust gas temperature, 16 °C resolution. Same block as rpm/rawLoad. */
    exhaustTemp?: number;
    /** WDK1 — throttle plate position, %. Same block as rpm/rawLoad, so free. Exists to answer
     *  "was the lambda controller even running here", by comparing against the WOT threshold. */
    wdk1?: number;
    /**
     * TETV — tank-vent valve pulse time, ms. Same block as stft1/stft2, so it is free.
     *
     * Zero means the valve is shut and this sample's trim is the engine's own mixture error. Any
     * non-zero value means some of `stft1`/`stft2` is the DME compensating for fuel it did not
     * inject, and the sample is worth less than it looks. Undefined means this DME did not report
     * the field at all — which is not the same as zero and must not be filtered as if it were.
     */
    tankVent?: number;
    /** TEFC_LL_ST — tank-vent idle functional-check state. Non-zero while the check runs. */
    tankVentCheckState?: number;
    /** TEFC_ED — tank-vent diagnostic handle. Non-zero once the DME has faulted the valve. */
    tankVentDiag?: number;
    /** LA_FREEZE_FLAG — recorded, not interpreted. Its meaning is not in the Funktionsrahmen; see
     *  the registry entry for the experiment that would establish it. */
    lambdaFreeze?: number;
    /**
     * Intake air temperature, degC, from `tan_filter` — 0.25 degC rather than the byte's 1 degC.
     *
     * It IS a tuning input, contrary to what this comment used to say: `rf_soll_calc` scales the
     * Alpha-N table by `KL_RF_TAN_KORR(TAN)`, so the trim a log records was measured through that
     * curve. See AMBIENT_CHARGE_RAM_READ in ramMap.ts.
     */
    intakeTemp?: number;
    /** Ambient pressure, mbar, from `P_UMG_FILTER`. The other index into `RF_PT_KORR`. */
    ambientPressure?: number;
    /**
     * `tan_m` expressed in degC — the DME's MODELLED charge temperature at the intake valve.
     *
     * Not the sensor. `TMOT - f*(TMOT - TAN)` with `f` rising with air mass flow, because air
     * through a hot port picks up less wall heat the faster it goes. This is the temperature
     * `m_calc` divides by, and the one an honest density normalisation has to use.
     */
    chargeTemp?: number;
    /** `P_UMG_HOEHE` — the altitude the DME derives from ambient pressure, metres. */
    altitude?: number;
    /**
     * True when the DME is reporting a SUBSTITUTE ambient pressure rather than a measurement.
     *
     * Cannot be inferred from the pressure: the substitute is re-learned from the manifold sensor
     * at key-on, so it is a plausible number. `P_UMG_ED` bit 0x40 / `P_UMG_DIAG_ST` are the only
     * signal, and the channel does not recover until key-off.
     */
    ambientPressureSubstituted?: boolean;
    /**
     * `T_UMG` — outside air temperature, degC, off CAN 0x62F.
     *
     * The reference the intake sensor is checked against: cold-soaked overnight, this, `intakeTemp`
     * and `coolantTemp` must all agree. Read `ambientTempFromCan` before believing it.
     */
    ambientTemp?: number;
    /**
     * Whether `ambientTemp` came from the bus or from the DME's fallback.
     *
     * False means `can_rx_62f` substituted `T_UMG_ERSATZ`, which `tan_calc` maintains as the
     * running MINIMUM of `TAN` — so the outside temperature is then derived from the intake sensor
     * and checking one against the other cannot fail. Undefined means the status byte did not
     * arrive; "not from CAN" is a claim and a short read is not evidence for it.
     */
    ambientTempFromCan?: boolean;
    /**
     * `V` — road speed, km/h. One count per km/h.
     *
     * The half of the `rf_korr` gate this app has never evaluated: `rf_korr_calc` requires
     * `V > k_rf_korr_v_min` (stock 20 km/h) as well as the filling floor, so a first-gear pull from
     * rest is scored gate-open when the DME had the correction pinned at 1.000. Recorded, not yet
     * gated on — it arrives on a slow lane and a stale reading would mis-score exactly the samples
     * the gate exists to exclude. See AMBIENT_TEMP_RAM_READ.
     */
    vehicleSpeed?: number;
    /**
     * `LLS_ST` — idle-valve status. **Bit 7 says which table `ti_load_factor` reads.**
     *
     * The idle curve `KL_TI_N_ZWD_LL` (0.859) runs only while `ZUSTAND_MOTOR`'s LL bit is set AND
     * this bit is set; otherwise it is `KF_TI_N_RF`. Bit 7 is set by the idle-valve DIAGNOSIS
     * (`lls_diag`, master 0x026142) and cleared at 0x026196 — so at a healthy idle it is low, and
     * the 0.859 curve is what runs when the DME has decided the valve is faulty.
     *
     * That branch decides the divisor the LOW LOAD correction is built on. Slowest lane: a bit a
     * diagnosis latches does not move on a timescale a sample could catch.
     */
    llsSt?: number;
    /** `MD_DYN_ST`. Bitfield: bit 6 = the tip-in limiter clipped this cycle, bits 4/5 = the
     *  dashpot did. Read on the slow lane with the four torque words below. */
    mdDynSt?: number;
    /** `MD_FW` — the driver's torque request BEFORE the slew limiter. */
    mdFw?: number;
    /** `MD_FW_FILTER` — and after it. The difference is what the limiter took. */
    mdFwFilter?: number;
    /** `MD_LS_DELTA` / `MD_DP_DELTA` — the allowance the tip-in and dashpot paths had. */
    mdLsDelta?: number;
    mdDpDelta?: number;
    /**
     * How far the two ambient-pressure decodes disagree, mbar.
     *
     * `P_UMG_FILTER` (word, 1/32 mbar) and the `P_UMG` byte (3 mbar) are different scalings off
     * different addresses in different windows. Agreement is evidence that both are what this app
     * says they are; a gap wider than the byte's own step is evidence that one is not. Carried
     * rather than acted on — the log should say so rather than pick a winner.
     */
    pressureDecodeDisagreesMbar?: number;
    /**
     * Where `stft1`/`stft2` came from on THIS sample.
     *
     * The VE profile reads them out of four bytes of master RAM instead of the 90-byte block 19 they
     * used to come from, which is most of what makes it twice as fast. The two are the same number
     * by every piece of evidence there is — but "by every piece of evidence there is" is exactly the
     * claim that has to be recoverable afterwards. A log whose trim silently came from two different
     * places would be two measurements with one name.
     *
     * Undefined when there is no trim in the sample at all.
     */
    stftSource?: 'ram' | 'block19';
}

/**
 * One read of DS2 selection 83 (EGAS) — **a latched fault freeze-frame, not telemetry.**
 *
 * This block does not stream. Master `0x024A66` fills the 52-byte buffer at `0xFFDA48` on the first
 * EGAS event and latches immediately (`tst.b (a1) / bne.w $24b82`); every later event only bumps the
 * counter in byte 0 (`0x024B82: cmpi.b #$ff,(a1) / addq.b #$1,(a1)`). On a healthy car it reads 52
 * zero bytes for as long as you care to poll it, at whatever rate you like.
 *
 * The inertia measurement was built on this block and could not have worked. What it is good for is
 * the question it was designed to answer — *what was the throttle system doing when it faulted* —
 * and, incidentally, proving where its own contents live: the copy at `0x024A66` names the RAM
 * address of every field, which is what `ramMap.ts` is built from. Live values come from there now.
 *
 * **Deliberately not a `LiveMeasurement`, and deliberately not convertible to one.** The channels
 * are disjoint, and a run recorded for one purpose cannot answer the other's question; the cheapest
 * place to discover that is the compiler rather than a VE map quietly rebuilt from samples that
 * never carried a trim.
 *
 * Every channel is `number | null` because `decodeField` returns null on a short block and null is
 * a different fact from zero — see `decodeEgasMeasurementBlock`.
 */
export interface EgasMeasurement {
    /** Seconds since this run started. Host clock, taken after the single exchange returns. Because
     *  only one block is polled there is no inter-block skew for this stamp to hide. */
    time: number;
    engineState: number | null;
    wdk1: number | null;
    /** Engine speed, 40 rpm resolution. */
    n40: number | null;
    /** Speed gradient as the DME reports it, 40 rpm/s resolution, **uncorrected**. The truncation
     *  bias is left in deliberately: this is the wire value, and correcting on the way in would put
     *  a derived number into something named like a measurement. Correct it at use — `correctDN40`. */
    dN40: number | null;
    dPwg: number | null;
    dWdk: number | null;
    rf: number | null;
    mdIndWunsch: number | null;
    mdIndNe: number | null;
    mdIndOptKorr: number | null;
    vAntrieb: number | null;
    mdDynSt: number | null;
    gang: number | null;
    sKrafts: number | null;
    saWeSt: number | null;
}

/**
 * One sample of the inertia run: DS2 selection 3 plus one control-0x06 read of live RAM.
 *
 * ## Why two exchanges rather than one block
 *
 * Because no single block carries both halves. Selection 3 has engine speed at **1 rpm** — the best
 * speed channel the DME offers, better than the 40 rpm `n40` the EGAS block would have given — plus
 * coolant temperature and throttle. It has no torque. The torque lives in RAM, and after the
 * freeze-frame discovery RAM is the only place a *live* torque can be read from at all.
 *
 * The cost is one extra round trip and the benefit is that the measurement exists. Both stamps come
 * from the same `time`, taken after the second exchange returns; the skew between them is one
 * telegram (~20 ms at 9600) and is the same every sample, so it shifts the pairing rather than
 * scattering it.
 *
 * ## Why this is not `EgasMeasurement` with different sources
 *
 * Same reason `EgasMeasurement` is not `LiveMeasurement`: the channel sets differ, and a stale run
 * of the old shape must not silently satisfy the new estimator. There is no gear, no vehicle speed
 * and no engine-state channel here — see `estimateInertia` for what stands in for each.
 */
export interface InertiaSample {
    /** Seconds since this run started. Host clock, taken after the RAM read returns. */
    time: number;
    /** Engine speed, **1 rpm** resolution (selection 3 `n`). The measurement rests on this channel. */
    rpm: number | null;
    /** Coolant temperature, °C. The gate the EGAS block could never support — it carries no `tmot`. */
    coolantTemp: number | null;
    /** Throttle plate 1, %. Used to find the closed-throttle deceleration, not as a gate. */
    wdk1: number | null;
    /** Relative filling, %. Recorded for diagnosis; the fit does not read it. */
    rf: number | null;
    /** `MD_IND_NE` — indicated torque after intervention, Nm. Read from RAM `0xFF81A6`. */
    mdIndNe: number | null;
    /** `MD_DYN_ST` — slew-limiter state. Read from RAM `0xFF8180` in the same telegram. */
    mdDynSt: number | null;
}

/**
 * One sample of the idle run: DS2 selection 3, one six-byte control-0x06 read of the LFR torque
 * cluster, and slow-lane reads of the actuator, engine state and compressor.
 *
 * Its own type rather than more optional fields on `LiveMeasurement`, for the reason `InertiaSample`
 * is — plus a third that settles it. A VE log carries no `md_llri`; but more than that, the VE
 * filter DELETES the samples this run exists to collect (`filter.ts` drops `rawLoad <= 1.0 &&
 * rpm < idleRpm`), so a VE log could not contain an idle dwell no matter
 * what channels it has. Keeping the types apart makes a mismatched log a compile error rather than
 * a census of zero.
 *
 * Every channel is `number | null`, and null means "not read on this sample" or "the response was
 * short" — a different fact from a decoded 0, and the distinction matters more here than usual.
 * `mdLlri: 0` is a governor asking for nothing; `mdLlri: null` is a telegram we did not get.
 * `llsTv: 0` is neither: the duty cannot be below `K_LLS_TV_MIN` (14 %), so a decoded 0 is evidence
 * the offset is wrong.
 */
export interface IdleSample {
    /** Seconds since this run started. Host clock, taken after the torque read returns. */
    time: number;
    /** Engine speed, 1 rpm (selection 3 `n`). */
    rpm: number | null;
    /** Coolant temperature, °C. Gates the dwell, and picks the row that gets written. */
    coolantTemp: number | null;
    /** Throttle plate 1, %. The closed-throttle test — `KL_BZ_WDK_LL` is 1.2 % at every rpm. */
    wdk1: number | null;
    /** Relative filling, %. Diagnosis only; the estimate does not read it. */
    rf: number | null;
    /** `LLR_N_SOLL` — the target the governor is using, selection 3 offset 2. Watching this stand
     *  still is the post-start, safety-concept, DS2-test and oil-temperature lockout, all at once. */
    nSoll: number | null;
    /** `UB`, V. Null when it failed its plausibility band — the offset is single-source, so an
     *  implausible reading means "do not believe this channel", not "the battery is flat". */
    ub: number | null;
    /** `MD_LLRI` — the governor's I term, Nm, signed. THE measurement. Rests at
     *  `-K_LFR_MDADAPT_OFFSET`, not at 0. */
    mdLlri: number | null;
    /** `MD_LLRA` — idle demand adaptation, compressor off. Same telegram as `mdLlri`, which is what
     *  makes their sum meaningful: the adaptation drains one into the other while you watch. */
    mdLlra: number | null;
    /** `MD_LLRA_KO` — the compressor-on integrator. Never used by the estimate; read so a dwell
     *  that straddles a compressor cycle is visibly excluded. */
    mdLlraKo: number | null;
    /** `LLS_TV` — idle valve duty, %. Slow lane. 3.0 or 75.0 is the limp branch, not a rail. */
    llsTv: number | null;
    /** `LLR_QVS` — the air request the DME is running, kg/h. Slow lane. The model gate's left side. */
    llrQvs: number | null;
    /** `LLR_QSOLL` — after the offset and clamp. Should equal `llrQvs` exactly on this calibration. */
    llrQsoll: number | null;
    /** `ZUSTAND_MOTOR`; bit 2 (0x04) is LL. Null on the fallback profile, where it is not read —
     *  and there the throttle test stands in, which the panel has to say. */
    engineState: number | null;
    /** `KKOS_ST`; bit 0 is the compressor, `lfra_adapt`'s own test. Null on the fallback profile,
     *  where A/C exclusion stops being a gate and becomes a procedure. */
    kkosSt: number | null;
    /**
     * `LLS_ST` — idle-valve status. **Bit 7 decides which table `TI_F_STAT` comes from.**
     *
     * Set only by the idle-valve diagnosis (`lls_diag`, master 0x026142), so at a healthy idle it is
     * clear and `ti_load_factor` reads `KF_TI_N_RF` rather than the 0.859 `KL_TI_N_ZWD_LL` curve.
     * `requireTiBranchProven` used to refuse every idle cell over that question. It is OFF now:
     * `TI_F_STAT` is not a term in the correction any more, so neither branch changes a written
     * byte. This channel is how the car confirms the disassembly rather than something the tune
     * waits on. Survey lane — a latched diagnosis bit does not need a dwell's resolution.
     */
    llsSt: number | null;

    // --- The section 7.1 preconditions ------------------------------------------------------
    //
    // docs/csl_idle_control_from_code.md derives what controls warm idle from the disassembly and
    // then says, of its own numbers, that almost all of them are model outputs rather than
    // measurements. These replace them. Two decide whether the rest of that document applies to
    // this car at all, which is why they are read before anything is derived rather than after.

    /** `ML_SOLL` — the load request feeding the split, kg/h. Same telegram as `mdLlri`, so the
     *  governor's output and the request it becomes are one moment rather than two. */
    mlSoll: number | null;
    /** `ML_SOLL_LLS` — the share given to the idle valve. */
    mlSollLls: number | null;
    /** `ML_SOLL_MAX_LLS` — the ceiling. `mlSoll < mlSollMaxLls` is the whole content of the claim
     *  that the valve carries all the air at idle and the throttle plate is commanded shut. Read in
     *  the SAME telegram as `mlSoll`, because a comparison across two telegrams is a comparison
     *  across two moments. */
    mlSollMaxLls: number | null;
    /** `MD_RF_SOLL` and `MD_RF_KORR`, raw. Their ratio IS the filling regulator's multiplicative
     *  authority, with no scaling needed to read it. */
    mdRfSoll: number | null;
    mdRfKorr: number | null;

    /** `WDK_WORD` — actual throttle angle, %. Slow lane. */
    wdkWord: number | null;
    /** `WDK_SOLL` — commanded throttle angle, %. Slow lane. Expected to be exactly 0.0 at settled
     *  warm idle; the difference from `wdkWord` is the precondition test. */
    wdkSoll: number | null;
    /** `EGAS_SOLL` and `EGAS_MAX_WDK`, %. The second is expected to read 100.0 always, which makes
     *  it a free check that the decode is right. */
    egasSoll: number | null;
    egasMaxWdk: number | null;

    /** `LFR_ZUSTAND` — the governor's state machine, one-hot. **2 is the settled idle regulator.**
     *  Outside it the integrator does not integrate and the adaptation does not adapt, so a dwell
     *  taken outside it measures nothing. */
    lfrZustand: number | null;
    /** `LFR_MDI` — the idle I term BEFORE the shift that makes `mdLlri`, Nm. `mdLlri` is the sum of
     *  this and `lfrIAfr`, so reading it alone cannot say which moved. */
    lfrMdi: number | null;
    /** `LFR_I_AFR` — the Anfahrregelung I term, the other half of `mdLlri`, Nm. */
    lfrIAfr: number | null;
    /** `FR_REGLER` — the filling regulator's multiplicative output, 1.0 = neutral. A pure
     *  integrator on the same actuator as the idle governor. */
    frRegler: number | null;
    /** `FRA_ML_ADAPTION` — the third integrator, kg/h, and the one that survives key-off. */
    fraMlAdaption: number | null;

    /** The lambda trims, survey lane: short-term controller, multiplicative long-term store, and
     *  the filtered controller copy the learners integrate. `laaF` CANNOT learn at a stationary
     *  idle — its zone needs ML > 40 kg/h — so over an idle dwell it is a constant learned
     *  elsewhere. The store an idle DOES learn into (LAA_OFFSET) has no readable address on this
     *  image — see ramMap. */
    laFRegler1: number | null;
    laFRegler2: number | null;
    laaF1: number | null;
    laaF2: number | null;
    laaRegler1: number | null;
    laaRegler2: number | null;

    /**
     * The torque reserve, and the steering angle that arms it. Survey lane.
     *
     * The investigation's claim that the idle governor has NO fast path at warm idle reduces to
     * `max(mdResKath, mdResLrw) == 0`: `lfr_calc` gates MD_LLR_TZ on bit1 of `mdResLrwSt` and clears
     * MD_LLR_TZ when that bit is down. These channels are that claim, made checkable on the car.
     *
     * `lwsLrw` is signed with straight ahead at 0, and it is here because the reserve alone cannot
     * tell "the curve says zero" from "the steering signal is dead" — `can_rx_1f5` writes 0 to
     * LWS_LRW in both cases.
     */
    lwsLrw: number | null;
    mdResKath: number | null;
    mdResLrwRoh: number | null;
    mdResLrwSt: number | null;
    mdResLrw: number | null;

    /**
     * The VANOS cams, and the latch that decides whether the idle balance may run. Survey lane.
     *
     * `evan1St` bit 3 is the one that matters: it arms only while the intake cam is at or below
     * 55.0 degKW, warm idle commands 60.0, so its only chance is the moment just after a start. Down
     * means `evan1Soll` is pinned 7.5 degKW away and `TI_SYNCn` is blocked for the whole run — and
     * NO fault code is set, because the position diagnostic is gated off below 1300 rpm.
     *
     * `evan1IstFilt` rather than `evan1Ist` is what the latch compares, so it is the one to judge
     * the threshold against; both are here because the raw position is what a driver recognises.
     */
    evan1Ist: number | null;
    avan1Ist: number | null;
    evan1St: number | null;
    avan1St: number | null;
    vanEdSt: number | null;
    vanAdapSt: number | null;
    evan1IstFilt: number | null;
    evan1Soll: number | null;

    /**
     * The air of the day — the two indices into `RF_PT_KORR`. Survey lane.
     *
     * `rf_soll_calc` (master `0x01A9D2`) ends with
     * `rf_soll = (rf_soll_filtered * RF_PT_KORR) >> 12`, and
     * `RF_PT_KORR = KL_RF_TAN_KORR(TAN) * KL_RF_P_UMG_KORR(P_UMG)`. So the Alpha-N table's output
     * is scaled for intake temperature and ambient pressure on every segment, and a logged `rf`
     * cannot be checked against the map without them.
     *
     * That check is the reason these are here. Without them the chain
     * `LLS_TV -> KL_AQ_ABS_LLS -> AQ_REL -> kf_rf_soll -> rf` reproduces the car's own `rf` only up
     * to an unexplained constant, measured at 0.876 on one cold run and 0.739 on one warm one — a
     * gap wide enough to be a wrong scaling somewhere and impossible to tell apart from the density
     * correction while the density correction is unmeasured. With them the prediction is closed and
     * a disagreement means an address or a scaling is wrong, which is what a gate is for.
     *
     * `ambientPressureSubstituted` is not decoration: `p_umg_filter_calc` substitutes
     * `P_UMG_ERSATZ` when the channel faults, and `p_umg_calc` re-learns that from the manifold
     * sensor at key-on — so the substitute is a plausible number and the fault CANNOT be detected
     * from the pressure itself. A gate that trusted it would pass while comparing against fiction.
     */
    intakeTemp: number | null;
    ambientPressure: number | null;
    chargeTemp: number | null;
    altitude: number | null;
    ambientPressureSubstituted?: boolean;

    /** Where `mdLlri` came from on THIS sample. Same discipline as `LiveMeasurement.stftSource`:
     *  a log that changed source mid-run would otherwise be two measurements with one name. */
    mdLlriSource?: 'ram' | 'block19';
}

/** What one window of the RAM probe reported. */
export interface RamProbeWindow {
    /** The signal the probe read, for naming the window in a message. */
    name: string;
    segment: number;
    address: number;
    /** True when the DME answered with the requested bytes. */
    supported: boolean;
    /** The bytes it returned, when it did. Shown so a probe can be read as evidence, not a verdict. */
    bytes: number[] | null;
    /** Why not, when not. `parameter-error` is the DME's own `0xB0` — the region lookup refused the
     *  address, which is a different fact from the link being broken. */
    failure: 'parameter-error' | 'rejected' | 'transport' | null;
    detail: string | null;
}

/**
 * The result of asking the DME, without writing anything, whether it will serve live RAM reads.
 *
 * Exists as its own step because the whole inertia path now depends on an answer recovered from a
 * disassembly rather than observed on this car. The evidence is strong — see `ramMap.ts` — but
 * "strong" is not "checked", and the cheap way to check costs two telegrams and changes nothing.
 */
export interface RamProbeResult {
    /** Every declared window answered. */
    ok: boolean;
    windows: RamProbeWindow[];
}

/** Which stage a long transfer is in. Surfaced in the UI so a slow-but-working stage (notably a FULL
 *  post-write read-back, measured at 122.9 s at 9600 baud) doesn't look like a freeze. */
export type TransferPhase = 'erasing' | 'reading' | 'writing' | 'verifying';

export type TransferProgress = (donePercent: number, phase?: TransferPhase) => void;

/**
 * How a flash write proves it landed.
 *
 * Both modes keep the per-telegram verify byte, which is not optional and is not a mode: every
 * chunk's response is parsed and a verify byte other than 1 ("programming OK") throws. What the
 * mode chooses is what happens *after* the last chunk.
 *
 * - `quick` — ask the DME for its own encoding checksum (control 0x0A) and require the two data
 *   areas to be clean. One exchange, ~50 ms. This is the reference tool's default, and its
 *   authority is the CRC-16/ARC values the ECU stores in its own flash, covering 65528 of the
 *   pair's 65536 bytes. It cannot say *where* a mismatch is, and it cannot catch a corruption that
 *   preserves CRC-16.
 * - `full` — everything `quick` does, **and** read all 65536 bytes back and compare byte for byte.
 *   ~123 s at 9600. The only check that can name an offset.
 *
 * `full` is not "instead of" the checksum: the checksum runs in both modes, because one exchange is
 * not worth choosing between two independent authorities over.
 */
export type WriteVerifyMode = 'quick' | 'full';

export interface WriteOptions {
    /**
     * Deliberately required, with no default anywhere in the stack.
     *
     * A default here would be a silent decision about how strongly a flash was proven, made in a
     * layer that has no business making it — and the wrong half of that choice looks identical to
     * the right one until an ECU is wrong.
     */
    verifyMode: WriteVerifyMode;
    /**
     * Windows (offsets into the written partial) where the new image DIFFERS from the bytes the
     * car held, for QUICK verify to read back and compare — see spotCheck.ts for the hollow write
     * that made this mandatory evidence. Absent or empty, QUICK falls back to the checksum status
     * byte alone, which cannot tell "programmed" from "politely ignored".
     */
    spotCheck?: SpotWindow[];
}

/** What a completed write actually proved, so the UI can say it rather than imply it. */
export interface WriteVerification {
    mode: WriteVerifyMode;
    /** The DME's post-write verdict, or null when control 0x0A could not be asked. */
    encodingChecksum: Ds2EncodingChecksum | null;
    /** Why `encodingChecksum` is null, when it is. Never silently empty. */
    encodingChecksumError: string | null;
    /**
     * The DME's checksum reported NO fault in the data-tune areas.
     *
     * Computed in both modes, which QUICK's own guard already did and FULL did not. The difference
     * matters because of what the caller uses this for: the licence to offer QUICK on this ECU in
     * future rests on a read-back and the DME's own checksum having agreed, and the caller was
     * testing `encodingChecksum !== null` — the presence of an ANSWER, not the content of it. A FULL
     * write whose bytes read back perfectly while the DME reported a checksum fault would have
     * licensed exactly the mode that cannot see that fault.
     *
     * False when the query could not be asked at all: "not answered" is not "clean".
     */
    checksumClean: boolean;
    /** True when a byte-for-byte read-back ran — and therefore passed, since a mismatch throws. */
    readBack: boolean;
    /** How many changed-byte windows a QUICK verify read back and matched. 0 = none were checked. */
    spotWindows: number;
}

/** Abstraction the connection state machine (useDmeLink) depends on. Implemented by both
 * WebSerialDmeLink (real navigator.serial + DS2 protocol) and MockDmeLink (offline simulator). */
export interface DmeLink {
    connect(): Promise<DmeIdentity>;
    disconnect(): Promise<void>;
    readPartialBin(onProgress?: TransferProgress): Promise<ArrayBuffer>;
    /**
     * Erases and rewrites the DataTune pair, then verifies per `options.verifyMode`.
     *
     * Returns what it proved rather than resolving void, so the completion dialog, the session
     * record and the saved artifact can all state the same thing about the same write. A write
     * verified two different ways must not be describable by one word.
     */
    writePartialBin(buffer: ArrayBuffer, options: WriteOptions, onProgress?: TransferProgress): Promise<WriteVerification>;
    /**
     * Asks the DME for its own encoding-checksum status (DS2 control 0x0A).
     *
     * **Read-only and non-destructive** — it sends four bytes and asks a question. That is what
     * makes it usable at connect as well as after a write, and the before/after pair is what turns
     * a single post-write reading into evidence.
     */
    queryEncodingChecksum(): Promise<Ds2EncodingChecksum>;
    pollLiveMeasurement(): Promise<LiveMeasurement>;
    /**
     * Reads DS2 selection 83 (EGAS) — the latched fault freeze-frame. **Not a telemetry poll.**
     *
     * Kept, and kept named for what it is, because the block still answers the question it was
     * designed for. It is no longer on the inertia path; `pollInertiaSample` is. See
     * `EgasMeasurement` for why polling this in a loop returns the same bytes forever.
     */
    readEgasFreezeFrame(): Promise<EgasMeasurement>;
    /**
     * One sample of the inertia run: selection 3 plus one control-0x06 read of live RAM.
     *
     * Both exchanges are required — there is no useful degraded sample, because a speed without a
     * torque and a torque without a speed are each half of one point. So a failure in either is
     * fatal to the sample rather than something to paper over with a neutral default, which is the
     * opposite of what the VE datalog does with its second block and deliberately so.
     */
    pollInertiaSample(): Promise<InertiaSample>;
    /**
     * One sample of the idle run: selection 3, the six-byte LFR torque cluster, and whichever
     * slow-lane reads are due on this sample.
     *
     * Unlike `pollInertiaSample`, a slow-lane miss is NOT fatal: `llsTv`, `llrQvs`, `engineState`
     * and `kkosSt` come back null on the samples they are not scheduled for, and that is normal
     * rather than degraded. Selection 3 and the torque cluster ARE both required — a governor
     * integrator without the speed error it is responding to is half a point, the same argument
     * the inertia poll makes.
     */
    pollIdleSample(): Promise<IdleSample>;
    /**
     * Reads `count` bytes of the DME's live RAM (DS2 control 0x06).
     *
     * **Read-only.** Sends one telegram, asks for bytes, changes nothing. The address must lie
     * inside a declared window in `ramMap.ts`; the DME would answer `0xB0` otherwise, but a caller
     * should not need a car to find out it asked for the wrong thing.
     */
    readRam(segment: number, address: number, count: number): Promise<Uint8Array>;
    /**
     * Asks whether this DME serves live RAM reads, by trying the smallest legal read in each window.
     *
     * Sends nothing but control-0x06 reads and never throws on a refusal — a refusal is the answer,
     * reported per window with the DME's own status distinguished from a transport failure.
     */
    probeRam(): Promise<RamProbeResult>;
    /**
     * The two CRCs the calibration currently in the ECU stores, one per processor half.
     *
     * Exists so a flash can prove what it is about to overwrite. **Every write erases and rewrites
     * all 65536 bytes** — `writePartialBinInner` refuses any other length — so a TUNED built from a
     * stale BASE does not merge with what is in the car, it replaces it wholesale. Two tunes
     * branched from one BASE therefore silently revert each other, with no overlapping addresses
     * required and nothing in either one's own diff to hint at it.
     *
     * Eight bytes rather than a re-read of all 65536: a full read is ~123 s at 9600 and would
     * double the time every flash takes, which is the kind of cost that gets a safety check turned
     * off. Two four-byte reads are effectively free.
     *
     * The trade is honest and worth stating: a CRC-16 per half means two different calibrations
     * could collide, at roughly one in 2^32 for the pair. That is ample for the real question —
     * "did something else get flashed in between?" — and it is not a defence against a deliberate
     * forgery. Nothing here needs it to be.
     */
    readDataChecksums(): Promise<{ slave: number; master: number }>;
    /** Reads the DME's learned adaptation values (DS2 blocks 0x06 and 0x16). */
    readAdaptations(): Promise<AdaptationSnapshot>;
    /**
     * Clears the tune-relevant adaptations, waits for the DME to commit, and re-reads. Returns the
     * post-clear values.
     *
     * Takes no mask: which adaptations a tuning tool may clear is a product decision, not a caller's
     * (see TUNE_ADAPTATION_CLEAR in ds2.ts), so "clear all" is unreachable by construction. The
     * settle-then-re-read lives here because the wait is a property of the DME, not of the UI.
     */
    clearTuneAdaptations(): Promise<AdaptationSnapshot>;
    /** Re-reads the flash counter (2 x 256 bytes), so the header can refresh without a reconnect. */
    readFlashCounter(): Promise<FlashCounterInfo>;
    /**
     * Reads both 8 KB service blocks and the DME's system-address pointers. **Read-only** — it sends
     * no erase, no write, and no programming control of any kind.
     *
     * Diagnostic, and deliberately separate from the reset that also reads these bytes: the reset
     * reads them in order to overwrite them, this reads them in order to find out what is actually
     * there. Conflating the two is how a blank block came to be treated as damage to be repaired
     * rather than a fact to be explained.
     */
    readServiceBlocks(onProgress?: TransferProgress): Promise<ServiceBlockDump>;
    /**
     * Engine speed, for deciding whether a programming operation may run.
     *
     * Deliberately separate from pollLiveMeasurement even though the real link answers it with the
     * same DS2 block. The two ask different questions — "give me a telemetry sample to plot" versus
     * "is this engine turning?" — and only the second has a defensible answer offline: the mock has
     * no engine, so it reports 0, while its telemetry stays an idle pattern because a datalog with
     * a flat 0 rpm trace would rehearse nothing. One method could not honestly serve both.
     */
    readEngineRpm(): Promise<number>;
    /**
     * Resets the flash counter on both processors, and returns what the DME reads back afterwards.
     *
     * This is the most destructive operation this interface exposes. Clearing the counter means
     * erasing and rewriting the whole 8 KB service block on each processor — the block that also
     * holds AIF, ZIF and the VIN records — so a failure part-way through can leave the ECU without
     * its identity data. `onBackup` receives those 16384 bytes (master then slave) BEFORE anything
     * is erased, and is awaited: if it rejects, no erase is sent at all. That ordering is enforced
     * here rather than by the caller because this is the layer that issues the erase, and a rule
     * about "not until the backup is safe" is only worth anything where it can actually be obeyed.
     *
     * Not cancellable once the erase has gone out, for the same reason writePartialBin isn't.
     */
    resetFlashCounter(
        onBackup: (serviceBlockPair: ArrayBuffer) => Promise<void>,
        onProgress?: TransferProgress,
    ): Promise<FlashCounterInfo>;
    /**
     * Writes a previously saved service block back, for recovering from a reset that was interrupted
     * between its erase and its rewrite.
     *
     * The mirror image of resetFlashCounter: no read, no backup — the DME's current contents are the
     * damage being undone, so there is nothing there worth preserving — and none of the guards that
     * protect the reset. In particular it does NOT refuse an erased block: an erased block is
     * precisely what this exists to fill.
     */
    restoreServiceBlock(
        serviceBlockPair: ArrayBuffer,
        onProgress?: TransferProgress,
    ): Promise<FlashCounterInfo>;
    /**
     * Tester-present, to stop the DME dropping its diagnostic session while nothing is being asked of
     * it — the adaptation dialog can sit for minutes between reading the values and clearing them.
     *
     * Best effort: resolves false instead of throwing, and skips itself whenever a real operation is
     * in flight. Nothing should branch on the result beyond diagnostics; it is a heartbeat, not a
     * health check a caller can act on.
     */
    keepAlive(): Promise<boolean>;
    /** Requests cancellation of an in-progress readPartialBin. Safe to call any time; no-op if idle. */
    abort(): void;
    /**
     * The rate the last bulk read actually ran at, or null if none has run.
     *
     * Exists because a refused baud switch is deliberately not an error — the read just proceeds at
     * 9600 — and that silence is indistinguishable from a switch that worked but didn't help. Judging
     * it by how fast the read felt is guesswork, and guesswork already cost three rates being deleted
     * on a wrong conclusion. Optional: only the real link switches baud at all.
     */
    getLastReadBaud?(): number | null;
    /**
     * The DME's own published maximum DS2 telegram length (system address table index 21), or null
     * if the pointer was absent or unreadable.
     *
     * Diagnostic only — nothing branches on it yet. It exists because the 122-byte read chunk every
     * tool uses is an undocumented default, not a limit: DS2 framing allows 251, BMW's own SGBD uses
     * 120, and the ECU publishes its real ceiling here. The reference tool ships a decoder for this
     * value and never calls it, so this number has never been looked at on a car.
     */
    getMaxTelegramLength?(): number | null;
    /**
     * Per-exchange timing for the last instrumented operation, or null if timing was off or none has
     * run. One slot, and `kind` says which operation it describes.
     *
     * One slot rather than one per operation on purpose: the alternative is three getters, three
     * pieces of UI state, and the standing question of which one a save button is looking at. A
     * report is cleared at the *start* of the next operation, so "no report" always means this
     * operation produced none — it can never mean "here is the previous one's".
     */
    getLastTransferTiming?(): TransferTimingReport | null;
    /**
     * Arms the per-exchange instrument for a datalog run, and closes it again.
     *
     * Optional because only the real link has a wire to measure — the mock's timings are `delay()`
     * calls and reporting them as if they described a cable would be worse than reporting nothing.
     *
     * The log is the one path where `hostGap` is not ~0, because `flushLiveSamples` runs a full VE
     * recalculation synchronously inside the sample callback, and it is also the path whose rate
     * has only ever been asserted. `TransferKind` has carried `'log'` since the write instrument
     * was built and nothing armed it until now, so both questions were open.
     *
     * Sized from `getLiveExchanges()` — the exchanges one sample is really made of, which is what
     * the payload figures have to be taken from. It used to take a list of block selections, and
     * before that nothing at all: the inertia run was the only caller, so a VE sample of 35 + 90
     * bytes was reported as a 52-byte EGAS one.
     */
    beginLogTiming?(exchanges?: readonly LogExchange[]): void;
    endLogTiming?(error?: unknown): TransferTimingReport | null;
    /**
     * Phase-level narrative of the last instrumented operation: what was sent, in what order, and
     * what the DME answered. Paired with the timing report when a diagnostic record is uploaded.
     *
     * Separate from the timing report because they answer different questions and fail
     * independently — an operation that dies before the instrument is armed still has a story, and
     * that is exactly the operation worth having one for.
     */
    getEventLog?(): LinkEventLogSnapshot;
    /**
     * Turns per-exchange timing collection on or off.
     *
     * There is no user-facing switch behind this. It exists because a link that never collects is
     * the honest default for implementations with no transport to measure (the mock), and because
     * collection is armed per operation rather than globally — see TransferTiming's `collecting`.
     * The caller arms it once at connect.
     */
    setTimingEnabled?(enabled: boolean): void;
    /**
     * Arms (or disarms) the post-erase baud boost on the WRITE path. 9600 disarms it.
     *
     * Settable on a live link rather than fixed at construction, because the control that arms it
     * has to be on screen at the moment WRITE is pressed. A dangerous mode you cannot see is worse
     * than one you cannot change: the read rate can sit in a constructor option because a refused
     * read costs a read, but this one is only reachable after the erase, and the operator has to be
     * able to look at the panel and see whether it is armed. The link still owns the value — the
     * hook resets it to 9600 on every connect, so it can never be inherited from a past session.
     */
    setWriteBaud?(baud: Ds2SupportedBaud): void;
    /**
     * What the boost is actually armed at, which is not always what was asked for — see setWriteBaud.
     * The caller reads this back so the control can never show a rate the link declined to take.
     */
    getWriteBaud?(): Ds2SupportedBaud;

    /**
     * Arms FAST READ with the seed map it needs, or disarms with `null`.
     *
     * FAST READ erases and restores the DME's Free Identifiers sector to reach a programming
     * session, where 125000 baud is a rate this ECU actually implements — turning a 123-second read
     * into 15-30. The seed is a map of ADDRESSES, never bytes; every byte written back is read live
     * immediately before the erase. See fastEntry.ts.
     *
     * Optional on the interface so the mock does not have to implement it: PRACTICE has no sector to
     * erase and nothing to gain, and a mock that pretended otherwise would be teaching a procedure
     * that does not exist.
     */
    setFastRead?(seed: SeedMap | null): void;
    /** What one live sample is made of — see lib/log-engine/logProfile.ts. Optional so a mock link
     *  that only ever produces one shape of sample need not implement it. */
    setLiveExchanges?(exchanges: readonly LogExchange[]): void;
    /** What `setLiveExchanges` left in place, which is not always what the last caller asked for — a
     *  run started without a profile keeps the previous list, and block 3 is put back if it was
     *  omitted. The timing instrument sizes itself from this, so it has to read the link's answer
     *  rather than the request. */
    getLiveExchanges?(): LogExchange[];
    /**
     * Checks, on this car, that the lambda trim really is at the RAM address the profile reads it
     * from — and reports which list the run should therefore use.
     *
     * Two telegrams either side of one block-19 read, three times: ~1 s at the start of a drive, in
     * exchange for not spending the drive itself on an unchecked claim. See `LAMBDA_TRUTH_GATE`.
     *
     * Answers `null` when the profile makes no such claim (nothing to check), and the FALLBACK list
     * when the check fails — never an error. A car that will not serve the RAM read is a car that
     * logs the old way, not a failed drive.
     */
    verifyLambdaTrimSource?(profile: { exchanges: LogExchange[]; fallback?: LogExchange[] }): Promise<{
        exchanges: LogExchange[];
        /** True when the fast list survived. */
        proven: boolean;
        /** One line for the event log and the notice row. */
        detail: string;
    } | null>;
    /**
     * The same sandwich, for any channel a profile reads from RAM while a block also carries it.
     *
     * `verifyLambdaTrimSource` is now the `'lambda-trim'` case of this, kept as its own name because
     * every existing caller and every stored event log says that. The second channel is
     * `'idle-torque'`: MD_LLRI is at RAM 0xFFD8F0 and at block 19 offset 77, so the identical
     * RAM-block-RAM bracket applies — and it has to, because the idle address comes from the same
     * kind of static evidence the lambda one did, with the same failure mode of a whole run of
     * plausible wrong numbers.
     *
     * The arithmetic differs and cannot be shared: the lambda gate is relative with a fixed
     * plausibility band, which is meaningless for a signed torque that rests at -7 Nm and crosses
     * zero. `rails` carries the loaded binary's own clamps for that reason — this layer must not
     * invent a range for a channel whose range is calibration data. Required for `'idle-torque'`,
     * ignored for `'lambda-trim'`.
     */
    verifyRamChannelSource?(
        profile: { exchanges: LogExchange[]; fallback?: LogExchange[] },
        channel: 'lambda-trim' | 'idle-torque',
        rails?: { min: number; max: number },
    ): Promise<{
        exchanges: LogExchange[];
        proven: boolean;
        detail: string;
    } | null>;
    /** Whether the link actually armed it. Not the same as what was asked for — a transport that
     *  cannot change rate on the open handle refuses, and the UI must report the link's answer. */
    getFastReadArmed?(): boolean;
    /**
     * DS2 reboot (service 0x12), returning whether the DME acknowledged.
     *
     * The way back out of the state FAST READ leaves behind: at 125000 the DME will not serve live
     * values, adaptations or error memory until it is restarted or the session is reconnected.
     */
    rebootDme?(): Promise<boolean>;
}

export class DmeLinkError extends Error {
    constructor(message: string, public readonly cause?: unknown) {
        super(message);
        this.name = 'DmeLinkError';
    }
}

/**
 * Attached as a DmeLinkError's `cause` when a flash-counter reset is refused because the DME's
 * service block is already erased — i.e. an earlier attempt died between its erase and its rewrite.
 *
 * Carried as data rather than left inside the message so the UI can route to the recovery flow
 * instead of showing a dead end. It is the one failure here that has a specific, available remedy,
 * and telling the user to recover without giving them the control to do it is worse than not
 * mentioning it.
 */
export interface ServiceBlockErasedCause {
    kind: 'serviceBlockErased';
    processor: string;
}

export function isServiceBlockErasedCause(cause: unknown): cause is ServiceBlockErasedCause {
    return typeof cause === 'object' && cause !== null && (cause as ServiceBlockErasedCause).kind === 'serviceBlockErased';
}

/** What kind of failure the link could name, when it could name one. The echo-mismatch verdicts
 *  describe a cause; 'serviceBlockErased' names a remedy. */
export type DmeErrorKind = 'electrical' | 'desync' | 'unclassified' | 'serviceBlockErased';
