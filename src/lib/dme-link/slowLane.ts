import type { LiveMeasurement } from './types';
import {
    AMBIENT_CHARGE_RAM_READ, AMBIENT_PRESSURE_AGREE_MBAR, AMBIENT_TEMP_RAM_READ,
    IDLE_VALVE_STATE_RAM_READ, KELVIN_OFFSET_C,
    SLEW_STATE_RAM_READ, TORQUE_REQUEST_RAM_READ,
    LLS_AIR_RAM_READ, LLS_INTEGRATOR_RAM_READ, LLS_DUTY_RAM_READ,
    KNOCK_AGE_RAM_READ, KNOCK_AGE_SATURATED,
    KNOCK_SUM_RAM_READ, MANIFOLD_AIR_RAM_READ, MANIFOLD_NORM_0401, GANG_MAX, NOISE_ST_UNUSED_BITS,
    IDLE_VANOS_RAM_READ,
    LAMBDA_SENSOR_RAM_READ, LA_F_RANGE_0401, LAMBDA_SENSOR_RANGE_MV_0401,
    Mss54HpRamSignals, P_UMG_BYTE_OFFSET_MBAR, P_UMG_ED_SUBSTITUTING, TAN_OFFSET_C, decodeRamSignal,
    type RamSignal,
} from './ramMap';
import { IGNITION_ANGLE_KEYS } from './liveValueBlocks';

/**
 * The channels a VE sample carries forward between slow-lane reads.
 *
 * A VE profile polls block 3 and the lambda-trim RAM read every sample, and two more exchanges once
 * every eighth: block 19, for the purge and freeze channels that exist nowhere else, and a 16-byte
 * RAM read for the ambient pressure and charge temperature cluster. Those two run at one eighth of the rate but their values
 * belong on every sample — a log where seven rows in eight have no purge state is a log nobody can
 * filter — so the link holds the last reading and stamps it onto each sample.
 */
export type SlowLaneChannels = Pick<
    LiveMeasurement,
    'tankVent' | 'tankVentCheckState' | 'tankVentDiag' | 'lambdaFreeze'
    | 'intakeTemp' | 'ambientPressure' | 'chargeTemp' | 'altitude' | 'ambientPressureSubstituted'
    | 'ambientTemp' | 'ambientTempFromCan' | 'vehicleSpeed' | 'pressureDecodeDisagreesMbar'
    | 'llsSt'
>;

/**
 * The slew-limiter channels, and why they are NOT in the carry above.
 *
 * Everything in `SlowLaneChannels` is STATE: a purge duty, an air temperature, a latched diagnosis
 * bit. Holding the last reading across the samples between reads is right for those, because the
 * quantity really did have that value the whole time and a log with seven rows in eight blank is a
 * log nobody can filter.
 *
 * A tip-in clip is not state. It is an EVENT that lasts a few hundred milliseconds, and stamping
 * one read onto the next sixty-four samples does not describe the drive — it multiplies the event
 * by sixty-four. Measured on session #930: three reads caught `MD_DYN_ST` bit 6, and carried
 * forward they became 192 samples, which reads as "the limiter was clipping for 9.2 % of the
 * drive". The true statement is "3 of 29 reads caught it". A number that wrong is worse than a gap.
 *
 * So these are written on the sample that read them and nowhere else. An absent value here means
 * "not looked at on this sample", which is what actually happened, and any analysis that counts
 * them is counting reads.
 */
export type SlewChannels = Pick<
    LiveMeasurement,
    'mdDynSt' | 'mdFw' | 'mdFwFilter' | 'mdLsDelta' | 'mdDpDelta'
>;

/**
 * The ring's four direct channels.
 *
 * Not in `SlowLaneChannels` and not carried, for the reason the slew channels are not: these are
 * the signals that OSCILLATE. Holding one across the samples between reads would flatten the very
 * 0.3 Hz the run exists to measure — the failure mode is not a gap, it is a plausible straight line.
 */
export type LlsRingChannels = Pick<
    LiveMeasurement,
    'frRegler' | 'llsTv' | 'mlSoll' | 'mlSollLls'
>;

/**
 * Fold this sample's slow-lane readings into the carry.
 *
 * **Merge, never replace.** The lane has more than one exchange on it and they are independent: a
 * block and a RAM byte, decoded in different branches of the poll loop, arriving in whatever order
 * the profile lists them. Assigning the whole carry from one of them drops everything the other
 * just read.
 *
 * That is not a hypothetical. The intake-temperature read was added on the same `every: 8` lane as
 * block 19 and written straight into the carry, and the post-loop assignment then replaced the whole
 * object with block 19's — so the channel was lost on every sample of the first drive recorded with
 * it, 4,836 of 4,836, while every other channel looked perfect. The failure is silent by
 * construction: an absent channel is indistinguishable from a channel the car does not have.
 *
 * `undefined` values are dropped rather than written, so a read that failed this sample leaves the
 * previous value standing instead of blanking it — and a channel this run has never seen stays
 * absent, because the carry starts empty and nothing here invents a key.
 */
export function mergeSlowLane(
    carry: SlowLaneChannels,
    ...parts: readonly (Partial<SlowLaneChannels> | null | undefined)[]
): SlowLaneChannels {
    const out: SlowLaneChannels = { ...carry };
    for (const part of parts) {
        if (!part) continue;
        for (const [key, value] of Object.entries(part)) {
            if (value !== undefined) (out as Record<string, unknown>)[key] = value;
        }
    }
    return out;
}


/**
 * Plausibility bands, from the DME's own diagnostic limits where it has them.
 *
 * A garbled telegram must not become a density. `K_P_UMG_DIAG_MIN/MAX` are 400/1150 mbar and
 * `K_TAN_DIAG_MIN/MAX` are -46/136 degC, which is exactly the question being asked here: is this
 * a reading the DME itself would accept? The charge-temperature band is wider because `tan_m`
 * tracks coolant at low flow and there is no published limit on it.
 */
const PLAUSIBLE = {
    pressureMbar: [400, 1150],
    intakeTempC: [-46, 136],
    speedKmh: [0, 400],
    chargeTempC: [-50, 200],
    altitudeM: [-500, 6000],
} as const;

const within = (v: number | null, [lo, hi]: readonly [number, number]) =>
    v !== null && Number.isFinite(v) && v >= lo && v <= hi ? v : undefined;

/**
 * The 16-byte ambient/charge telegram, decoded into the channels a sample carries.
 *
 * One read at `0xFFED38` covers ambient pressure, its substitution flag, the DME's altitude, the
 * intake air temperature at 0.25 degC, and `tan_m` — the modelled charge temperature that
 * `m_calc` divides by. See `AMBIENT_CHARGE_RAM_READ` for why they belong in one exchange.
 *
 * **`ambientPressureSubstituted` keys on `P_UMG_ED` bit 0x40 and not on `P_UMG_DIAG_ST`.** The bit
 * is explicit in `p_umg_filter_calc` (`if ((P_UMG_ED & 0x40) != 0) P_UMG_DIAG_ST = ersatz_value`),
 * whereas the numeric value the decompiler prints as `error_free` is not established — gating on
 * "diag status is non-zero" would flag every healthy sample if that enum is not zero. The byte is
 * inside the window either way; it is simply not believed yet.
 *
 * Every channel is dropped rather than clamped when it falls outside a band the DME itself would
 * accept: an absent channel makes the normalisation refuse, and a clamped one makes it lie.
 */
export function decodeAmbientCharge(
    bytes: Uint8Array, bufferAddress: number,
): Partial<SlowLaneChannels> {
    const sig = Mss54HpRamSignals;
    const raw = (name: keyof typeof sig) => decodeRamSignal(sig[name], bytes, bufferAddress);

    const tanC = raw('TAN_FILTER');
    const chargeK = raw('TAN_M');
    const ed = raw('P_UMG_ED');

    return {
        ambientPressure: within(raw('P_UMG_FILTER'), PLAUSIBLE.pressureMbar),
        intakeTemp: within(tanC === null ? null : tanC + TAN_OFFSET_C, PLAUSIBLE.intakeTempC),
        chargeTemp: within(chargeK === null ? null : chargeK + KELVIN_OFFSET_C, PLAUSIBLE.chargeTempC),
        altitude: within(raw('P_UMG_HOEHE'), PLAUSIBLE.altitudeM),
        // Only ever set to true. Left undefined on a healthy sample so the CSV column appears only
        // on a run where it actually happened.
        ambientPressureSubstituted:
            ed !== null && (ed & P_UMG_ED_SUBSTITUTING) !== 0 ? true : undefined,
    };
}

/**
 * The segment-0x01 telegram: outside air temperature, where it came from, road speed, and a second
 * decode of the ambient pressure.
 *
 * `ambientTempFromCan` is the whole reason the status byte is read. `can_rx_62f` falls back to
 * `T_UMG_ERSATZ` — the running minimum of `TAN` — whenever CAN 0x62F is absent or invalid, so a
 * reported outside temperature can be a restatement of the intake sensor. Checking one against the
 * other would then always pass. False here means the number is present but proves nothing.
 *
 * `pressureDecodeDisagreesMbar` is carried rather than acted on: the two pressure decodes have
 * different scalings off different addresses, so a gap wider than the byte's own 3 mbar step means
 * one of the two is not the address this file says it is, and the log should say so rather than
 * pick a winner. Undefined when either half is missing (the two reads are on the same lane but
 * they are separate telegrams, and one can fail alone).
 */
export function decodeAmbientTemp(
    bytes: Uint8Array, bufferAddress: number, pressureFromWord?: number,
): Partial<SlowLaneChannels> {
    const sig = Mss54HpRamSignals;
    const raw = (name: keyof typeof sig) => decodeRamSignal(sig[name], bytes, bufferAddress);

    const tUmg = raw('T_UMG');
    const st = raw('T_UMG_ST');
    const byte = raw('P_UMG_BYTE');
    const pressureFromByte = byte === null ? undefined
        : within(byte + P_UMG_BYTE_OFFSET_MBAR, PLAUSIBLE.pressureMbar);

    return {
        ambientTemp: within(tUmg === null ? null : tUmg + TAN_OFFSET_C, PLAUSIBLE.intakeTempC),
        // Bit 7 is the only bit `can_rx_62f` establishes. Undefined rather than false when the
        // status byte itself did not arrive: "not from CAN" is a claim, and a short read is not
        // evidence for it.
        ambientTempFromCan: st === null ? undefined : (st & T_UMG_ST_STALE) === 0,
        vehicleSpeed: within(raw('V'), PLAUSIBLE.speedKmh),
        pressureDecodeDisagreesMbar:
            pressureFromByte === undefined || pressureFromWord === undefined
                ? undefined
                : Math.abs(pressureFromWord - pressureFromByte),
    };
}

/** `ML_SOLL` and `ML_SOLL_LLS`, six bytes — the split the throttle target made, both halves of it. */
export function decodeLlsAir(bytes: Uint8Array, address: number): Partial<LlsRingChannels> {
    const out: Partial<LlsRingChannels> = {};
    const total = decodeRamSignal(Mss54HpRamSignals.ML_SOLL, bytes, address);
    const toValve = decodeRamSignal(Mss54HpRamSignals.ML_SOLL_LLS, bytes, address);
    if (total !== null) out.mlSoll = total;
    if (toValve !== null) out.mlSollLls = toValve;
    return out;
}

/** `FR_REGLER`, two bytes. 1.0 is neutral; this is the integrator the surge argument turns on. */
export function decodeLlsIntegrator(bytes: Uint8Array, address: number): Partial<LlsRingChannels> {
    const v = decodeRamSignal(Mss54HpRamSignals.FR_REGLER, bytes, address);
    return v === null ? {} : { frRegler: v };
}

/** `LLS_TV`, two bytes — the duty as commanded, not as inferred back through two map inversions. */
export function decodeLlsDuty(bytes: Uint8Array, address: number): Partial<LlsRingChannels> {
    const v = decodeRamSignal(Mss54HpRamSignals.LLS_TV, bytes, address);
    return v === null ? {} : { llsTv: v };
}

/** `T_UMG_ST` bit set by `can_rx_62f` on a timed-out or invalid frame. */
export const T_UMG_ST_STALE = 0x80;

/** How far the two pressure decodes may differ before the cluster is not believed, mbar. */
export const PRESSURE_DECODE_TOLERANCE_MBAR = AMBIENT_PRESSURE_AGREE_MBAR;

/** Where each cluster is read from, re-exported so the poll loop can dispatch on them. */
export const AMBIENT_CHARGE_ADDRESS = AMBIENT_CHARGE_RAM_READ.address;
export const AMBIENT_TEMP_ADDRESS = AMBIENT_TEMP_RAM_READ.address;
export const IDLE_VALVE_STATE_ADDRESS = IDLE_VALVE_STATE_RAM_READ.address;
export const SLEW_STATE_ADDRESS = SLEW_STATE_RAM_READ.address;
export const TORQUE_REQUEST_ADDRESS = TORQUE_REQUEST_RAM_READ.address;
export const LLS_AIR_ADDRESS = LLS_AIR_RAM_READ.address;
export const LLS_INTEGRATOR_ADDRESS = LLS_INTEGRATOR_RAM_READ.address;
export const LLS_DUTY_ADDRESS = LLS_DUTY_RAM_READ.address;

/**
 * `LLS_ST`, one byte, straight through — no scaling, because it is a bitfield.
 *
 * Returns `{}` rather than a null field when the read did not decode, so `mergeSlowLane` leaves the
 * previous value standing instead of blanking it. A channel this run has never seen stays absent.
 */
export function decodeIdleValveState(bytes: Uint8Array, address: number): Partial<SlowLaneChannels> {
    const v = decodeRamSignal(Mss54HpRamSignals.LLS_ST, bytes, address);
    return v === null ? {} : { llsSt: v };
}

/**
 * `MD_DYN_ST`, one byte, straight through — a bitfield, so no scaling and no plausibility band.
 *
 * Same `{}`-on-failure rule as the idle valve state: a read that did not decode leaves the previous
 * value standing rather than blanking a channel that was fine a sample ago.
 */
export function decodeSlewState(bytes: Uint8Array, address: number): Partial<SlewChannels> {
    const v = decodeRamSignal(Mss54HpRamSignals.MD_DYN_ST, bytes, address);
    return v === null ? {} : { mdDynSt: v };
}

/**
 * The torque request telegram's six channels: the slew limiter's four words and the request after
 * it, as far as the throttle sees it.
 *
 * Not carried, for `SlewChannels`' reason and the knock sums': a request read at a tip-in is not the
 * request seven samples later, and a count of them is a count of reads.
 */
export type TorqueRequestChannels = Pick<
    LiveMeasurement,
    'mdFw' | 'mdFwFilter' | 'mdLsDelta' | 'mdDpDelta' | 'mdIndWunsch' | 'mdIndWunschRedKorr'
>;

/**
 * The twenty-six-byte torque telegram, decoded — all six channels or none.
 *
 * The proof that the read landed is the DME's own arithmetic, not a band. `MD_Torque_Interventions`
 * (master 0x0166F6) stores, from one local, `MD_IND_WUNSCH = t + MD_SAWE_FILTER` and then
 * `MD_FW_FILTER = t` (16-bit words, nothing else writes either once the engine runs), so
 *
 *     MD_IND_WUNSCH == MD_FW_FILTER + MD_SAWE_FILTER        (mod 2^16)
 *
 * on every reading of the real bytes — and on a read torn between those two stores, which is worth
 * one read. Because `0 == 0 + 0` holds in any zero-filled window, `MD_DP_FAKTOR` must also be
 * non-zero: `md_interventions_init` writes 0x400 and only a lookup in KF_MD_DASHPOT_FAKTOR (no zero
 * cell here) rewrites it.
 *
 * No plausibility band on the torques themselves, for the reason there never was one on the slew
 * words: `MD_FW_FILTER - MD_FW` is the measurement, and the DME's own bound (`K_MD_SK_MAX`, 800 Nm)
 * is far outside anything an engine reaches. Tenths divided out, so 123.4 is 123.4 in a CSV.
 */
export function decodeTorqueRequest(bytes: Uint8Array, address: number): Partial<TorqueRequestChannels> {
    const R = Mss54HpRamSignals;
    const fw = rawOf(R.MD_FW, bytes, address);
    const filter = rawOf(R.MD_FW_FILTER, bytes, address);
    const sawe = rawOf(R.MD_SAWE_FILTER, bytes, address);
    const ls = rawOf(R.MD_LS_DELTA, bytes, address);
    const dp = rawOf(R.MD_DP_DELTA, bytes, address);
    const dpFaktor = rawOf(R.MD_DP_FAKTOR, bytes, address);
    const wunsch = rawOf(R.MD_IND_WUNSCH, bytes, address);
    const redKorr = rawOf(R.MD_IND_WUNSCH_RED_KORR, bytes, address);
    if (fw === null || filter === null || sawe === null || ls === null || dp === null
        || dpFaktor === null || wunsch === null || redKorr === null) return {};
    if (((filter + sawe) & 0xFFFF) !== wunsch || dpFaktor === 0) return {};
    return {
        mdFw: fw / 10,
        mdFwFilter: filter / 10,
        mdLsDelta: ls / 10,
        mdDpDelta: dp / 10,
        mdIndWunsch: wunsch / 10,
        mdIndWunschRedKorr: redKorr / 10,
    };
}

/**
 * The ignition side of a sample: the six final angles block 19 carries, and the six knock counters
 * the RAM read beside it carries.
 *
 * Not in `SlowLaneChannels` and not carried, for the slew channels' reason and one of their own.
 * An angle is not state that holds still between reads: a knock retard on this calibration is
 * gone in about a second, so a reading stamped onto the next seven samples would report a
 * one-second event as two. And a knock counter grows by one every combustion — the value it held
 * at the last read is wrong on every sample after it, by an amount nothing here knows. So both are
 * written on the sample that read them and nowhere else, and an absent value means "not read on
 * this sample".
 */
export type IgnitionChannels = Pick<
    LiveMeasurement,
    | 'ignitionAngle1' | 'ignitionAngle2' | 'ignitionAngle3'
    | 'ignitionAngle4' | 'ignitionAngle5' | 'ignitionAngle6'
    | 'knockAge1' | 'knockAge2' | 'knockAge3' | 'knockAge4' | 'knockAge5' | 'knockAge6'
>;

/** The six angles out of a decoded block 19, keeping only the ones the block was long enough to
 *  hold — a short block leaves the cylinder absent rather than at 0 degrees, which is an angle. */
export function ignitionFromBlock19(
    op: Partial<Record<(typeof IGNITION_ANGLE_KEYS)[number], number | null>>,
): Partial<IgnitionChannels> {
    const out: Partial<IgnitionChannels> = {};
    for (const key of IGNITION_ANGLE_KEYS) {
        const v = op[key];
        if (v !== null && v !== undefined) out[key] = v;
    }
    return out;
}

const KNOCK_AGE_SIGNALS = [
    ['knockAge1', Mss54HpRamSignals.KNOCK_AGE_1], ['knockAge2', Mss54HpRamSignals.KNOCK_AGE_2],
    ['knockAge3', Mss54HpRamSignals.KNOCK_AGE_3], ['knockAge4', Mss54HpRamSignals.KNOCK_AGE_4],
    ['knockAge5', Mss54HpRamSignals.KNOCK_AGE_5], ['knockAge6', Mss54HpRamSignals.KNOCK_AGE_6],
] as const;

/**
 * The twelve-byte knock telegram, decoded — all six or none.
 *
 * The counter cannot exceed `KNOCK_AGE_SATURATED` (the DME stops it there and initialises it
 * there), so a word above it is not this counter, and one impossible word is evidence against the
 * other five being it either: the six are one array at one address. Dropping the whole telegram
 * keeps a wrong address from leaving five plausible-looking columns behind. A short read drops
 * the same way, so a cylinder is never silently missing from a reading that claims the others.
 */
export function decodeKnockAge(bytes: Uint8Array, address: number): Partial<IgnitionChannels> {
    const out: Partial<IgnitionChannels> = {};
    for (const [key, sig] of KNOCK_AGE_SIGNALS) {
        const v = decodeRamSignal(sig, bytes, address);
        if (v === null || !Number.isInteger(v) || v < 0 || v > KNOCK_AGE_SATURATED) return {};
        out[key] = v;
    }
    return out;
}

export const KNOCK_AGE_ADDRESS = KNOCK_AGE_RAM_READ.address;

/**
 * The knock read beside KNOCK AGE: gear, the drive-by-noise cap, and the DME's knock sums.
 *
 * Not carried, for `IgnitionChannels`' reason: `KR_DTZ_SUM` is the retard applied at the moment of
 * the read, and on this calibration a retard is given back within about a second, so stamping it
 * onto the fifteen samples before the next read would report a one-second event as four. The gear and the noise bit
 * ride in the same telegram and follow the same rule rather than splitting one read into two
 * policies.
 */
export type KnockSumChannels = Pick<
    LiveMeasurement,
    'gear' | 'noiseSt' | 'krDtzSum' | 'krDtzSum1' | 'kaDtzSum' | 'kaDtzSum1'
>;

/**
 * The manifold sensor's air beside the Alpha-N air, from one telegram.
 *
 * Not carried either. `rf_p_saug` follows the throttle within a segment; held across seven samples
 * it would be compared with an RF from a different moment, which is the one comparison it exists to
 * make without skew.
 */
export type ManifoldAirChannels = Pick<
    LiveMeasurement,
    'rfPSaug' | 'rfDiagF' | 'rfKorrDme' | 'pSaug' | 'pSaugM'
>;

/** The raw unsigned contents of one signal, or null when the buffer does not cover it. */
function rawOf(sig: RamSignal, bytes: Uint8Array, address: number): number | null {
    const at = sig.address - address;
    if (at < 0 || at + sig.size > bytes.length) return null;
    return sig.size === 1 ? bytes[at] : (bytes[at] << 8) | bytes[at + 1];
}

const signed16 = (raw: number) => (raw > 0x7FFF ? raw - 0x10000 : raw);

/**
 * The fifteen-byte knock telegram, decoded — all of it or none of it.
 *
 * Three checks, each a fact about how the DME writes these bytes rather than a band somebody chose:
 *
 *   - `KR_DTZ_SUM == KR_DTZ_SUM1 + KR_DTZ_SUM2` and the same for KA, in 16-bit arithmetic. That is
 *     how `knock_related_3_` / `_4_` store them (add.w), on every path they take on six cylinders.
 *     A read that landed elsewhere fails it, and so does the rare read torn by the segment task
 *     rewriting the sums mid-copy — both are worth one read.
 *   - `GANG <= 7`: nothing writes more (see GANG_MAX).
 *   - `NOISE_ST & 0x7C == 0`: nothing writes those bits (see NOISE_ST_UNUSED_BITS).
 *
 * The last two matter because the first proves nothing on a drive with no knock, when all six sums
 * are 0 and `0 == 0 + 0` holds at any address full of zeroes.
 *
 * Degrees are divided rather than multiplied out of tenths, so -30 reads -3 and not
 * -3.0000000000000004 in a CSV.
 */
export function decodeKnockSums(bytes: Uint8Array, address: number): Partial<KnockSumChannels> {
    const R = Mss54HpRamSignals;
    const noise = rawOf(R.NOISE_ST, bytes, address);
    const gang = rawOf(R.GANG, bytes, address);
    const kr = rawOf(R.KR_DTZ_SUM, bytes, address);
    const kr1 = rawOf(R.KR_DTZ_SUM1, bytes, address);
    const kr2 = rawOf(R.KR_DTZ_SUM2, bytes, address);
    const ka = rawOf(R.KA_DTZ_SUM, bytes, address);
    const ka1 = rawOf(R.KA_DTZ_SUM1, bytes, address);
    const ka2 = rawOf(R.KA_DTZ_SUM2, bytes, address);
    if (noise === null || gang === null || kr === null || kr1 === null || kr2 === null
        || ka === null || ka1 === null || ka2 === null) return {};
    if ((noise & NOISE_ST_UNUSED_BITS) !== 0 || gang > GANG_MAX) return {};
    if (((kr1 + kr2) & 0xFFFF) !== kr || ((ka1 + ka2) & 0xFFFF) !== ka) return {};
    return {
        gear: gang,
        noiseSt: noise,
        krDtzSum: signed16(kr) / 10,
        krDtzSum1: signed16(kr1) / 10,
        kaDtzSum: signed16(ka) / 10,
        kaDtzSum1: signed16(ka1) / 10,
    };
}

/**
 * The forty-byte manifold telegram, decoded — only when `m_norm` and `m_norm_fakt` read exactly what
 * `rf_init` computed from this calibration (10890 and 10813 on 0401; see `expectedManifoldNorm`).
 *
 * Two words that never change for the whole key cycle, sitting between the channels, are a better
 * proof that the read landed where it was aimed than any band on the channels themselves: a manifold
 * pressure of 950 mbar or a filling of 74 % is plausible at many addresses, 10890 followed by 10813
 * is not. A different calibration of those two constants fails it, and loses the channels rather
 * than mis-scaling them — the right way round. `norm` is a parameter so that can be shown.
 */
export function decodeManifoldAir(
    bytes: Uint8Array,
    address: number,
    norm: { mNorm: number; mNormFakt: number } = MANIFOLD_NORM_0401,
): Partial<ManifoldAirChannels> {
    const R = Mss54HpRamSignals;
    if (rawOf(R.M_NORM, bytes, address) !== norm.mNorm
        || rawOf(R.M_NORM_FAKT, bytes, address) !== norm.mNormFakt) return {};
    const korr = rawOf(R.RF_KORR, bytes, address);
    const pm = rawOf(R.P_SAUG_M, bytes, address);
    const p = rawOf(R.P_SAUG, bytes, address);
    const rf = rawOf(R.RF_P_SAUG, bytes, address);
    const diag = rawOf(R.RF_DIAG_F, bytes, address);
    if (korr === null || pm === null || p === null || rf === null || diag === null) return {};
    return {
        rfPSaug: rf / 10,
        rfDiagF: signed16(diag) / 10,
        rfKorrDme: korr / 1024,
        pSaug: p / 32,
        pSaugM: pm / 32,
    };
}

export const KNOCK_SUM_ADDRESS = KNOCK_SUM_RAM_READ.address;
export const MANIFOLD_AIR_ADDRESS = MANIFOLD_AIR_RAM_READ.address;

/**
 * The two cams beside their targets, and the four status bytes that say which target the
 * controller was actually following. Out of the 26-byte VANOS group the idle run already reads.
 *
 * Not carried: a cam position at one sample says nothing about the next seven at a different rpm.
 */
export type VanosChannels = Pick<
    LiveMeasurement,
    'evan1Ist' | 'evanSoll' | 'avan1Ist' | 'avanSoll' | 'evan1St' | 'avan1St' | 'vanEdSt' | 'vanAdapSt'
>;

/**
 * The VANOS telegram, decoded — all eight or none, so a short read never leaves a target without
 * the position it is judged against. No band on the values: the DME's own limits are calibration
 * (0..60 and 0..45 degKW here) and the adaptation drives the targets past them on purpose, so any
 * band chosen here would drop exactly the readings worth having.
 */
export function decodeVanos(bytes: Uint8Array, address: number): Partial<VanosChannels> {
    const R = Mss54HpRamSignals;
    const pairs = [
        ['evan1Ist', R.EVAN1_IST], ['evanSoll', R.EVAN_SOLL], ['avan1Ist', R.AVAN1_IST], ['avanSoll', R.AVAN_SOLL],
        ['evan1St', R.EVAN1_ST], ['avan1St', R.AVAN1_ST], ['vanEdSt', R.VAN_ED_ST], ['vanAdapSt', R.VAN_ADAP_ST],
    ] as const;
    const out: Partial<VanosChannels> = {};
    for (const [key, sig] of pairs) {
        const raw = rawOf(sig, bytes, address);
        if (raw === null) return {};
        // Tenths divided out, as for the knock sums, so 52.5 is 52.5 in a CSV.
        out[key] = sig.size === 2 ? signed16(raw) / 10 : raw;
    }
    return out;
}

export const VANOS_ADDRESS = IDLE_VANOS_RAM_READ.address;

/**
 * The lambda sensors, the controller's switch-on state and the transient enrichment, from one
 * telegram. Not carried: a narrowband voltage swings every half second in the closed loop, and in
 * the open loop the sample it was read on is the only one it describes.
 */
export type LambdaSensorChannels = Pick<
    LiveMeasurement,
    'usv1' | 'usv2' | 'usn1' | 'usn2' | 'laStEin1' | 'laStEin2' | 'baFTi'
>;

/** The top nibble of LA_ST_EIN is the sensor-ready machine, and it only ever holds one bit or none. */
const oneStateAtMost = (st: number) => {
    const machine = st >> 4;
    return (machine & (machine - 1)) === 0;
};

/**
 * The thirty-two-byte lambda telegram, decoded — all seven channels or none.
 *
 * Three facts about how the slave writes these bytes, rather than bands somebody chose:
 *
 *   - LA_F_REGLER1/2 and LAA_F1/2, which sit inside this telegram, within K_LA_FMIN..K_LAS_FMAX —
 *     the controllers' own clamps (see LA_F_RANGE_0401). Four words each within -30..+40 % of
 *     0x8000 are not what a wrong address holds.
 *   - every sensor word within what `((K_LAS_M * adc) >> 10) - K_LAS_NP` can produce from a 10-bit
 *     count (0..1113 mV on 0401) — the filter after it cannot leave that range.
 *   - LA_ST_EIN's sensor-ready nibble is 0 or one bit (see the signal).
 *
 * `range` is a parameter for the reason `decodeManifoldAir`'s `norm` is: another calibration's
 * K_LAS_M / K_LAS_NP must be stated, not silently assumed. Volts and the enrichment factor are
 * divided out rather than multiplied, so 0.475 is 0.475 in a CSV.
 */
export function decodeLambdaSensors(
    bytes: Uint8Array,
    address: number,
    range: { min: number; max: number } = LAMBDA_SENSOR_RANGE_MV_0401,
): Partial<LambdaSensorChannels> {
    const R = Mss54HpRamSignals;
    const trims = [R.LA_F_REGLER1, R.LA_F_REGLER2, R.LAA_F1, R.LAA_F2].map(s => rawOf(s, bytes, address));
    const volts = [R.USV1, R.USV2, R.USN1, R.USN2].map(s => rawOf(s, bytes, address));
    const st1 = rawOf(R.LA_ST_EIN1, bytes, address);
    const st2 = rawOf(R.LA_ST_EIN2, bytes, address);
    const ba = rawOf(R.BA_F_TI, bytes, address);
    if (trims.some(t => t === null) || volts.some(v => v === null)
        || st1 === null || st2 === null || ba === null) return {};
    if (trims.some(t => (t as number) < LA_F_RANGE_0401.min || (t as number) > LA_F_RANGE_0401.max)) return {};
    const mv = volts.map(v => signed16(v as number));
    if (mv.some(v => v < range.min || v > range.max)) return {};
    if (!oneStateAtMost(st1) || !oneStateAtMost(st2)) return {};
    return {
        usv1: mv[0] / 1000,
        usv2: mv[1] / 1000,
        usn1: mv[2] / 1000,
        usn2: mv[3] / 1000,
        laStEin1: st1,
        laStEin2: st2,
        baFTi: ba / 1024,
    };
}

export const LAMBDA_SENSOR_ADDRESS = LAMBDA_SENSOR_RAM_READ.address;
