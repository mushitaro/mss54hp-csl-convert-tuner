import type { LiveMeasurement } from './types';
import {
    AMBIENT_CHARGE_RAM_READ, AMBIENT_PRESSURE_AGREE_MBAR, AMBIENT_TEMP_RAM_READ,
    IDLE_VALVE_STATE_RAM_READ, KELVIN_OFFSET_C,
    SLEW_STATE_RAM_READ, SLEW_TORQUE_RAM_READ,
    Mss54HpRamSignals, P_UMG_BYTE_OFFSET_MBAR, P_UMG_ED_SUBSTITUTING, TAN_OFFSET_C, decodeRamSignal,
    type RamSignal,
} from './ramMap';

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

/** `T_UMG_ST` bit set by `can_rx_62f` on a timed-out or invalid frame. */
export const T_UMG_ST_STALE = 0x80;

/** How far the two pressure decodes may differ before the cluster is not believed, mbar. */
export const PRESSURE_DECODE_TOLERANCE_MBAR = AMBIENT_PRESSURE_AGREE_MBAR;

/** Where each cluster is read from, re-exported so the poll loop can dispatch on them. */
export const AMBIENT_CHARGE_ADDRESS = AMBIENT_CHARGE_RAM_READ.address;
export const AMBIENT_TEMP_ADDRESS = AMBIENT_TEMP_RAM_READ.address;
export const IDLE_VALVE_STATE_ADDRESS = IDLE_VALVE_STATE_RAM_READ.address;
export const SLEW_STATE_ADDRESS = SLEW_STATE_RAM_READ.address;
export const SLEW_TORQUE_ADDRESS = SLEW_TORQUE_RAM_READ.address;

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
 * The four torque words the slew limiter runs on.
 *
 * No plausibility band on these either, and that is deliberate. `MD_FW_FILTER - MD_FW` is the
 * measurement; clamping either side to a band of somebody's choosing would quietly change the one
 * number this exchange exists to produce. They are torque in 0.1 Nm from the DME's own model, and
 * the DME's own bounds (`K_MD_SK_MAX` = 800 Nm) are already far outside anything an engine reaches.
 */
export function decodeSlewTorque(bytes: Uint8Array, address: number): Partial<SlewChannels> {
    const out: Partial<SlewChannels> = {};
    const put = (key: 'mdFw' | 'mdFwFilter' | 'mdLsDelta' | 'mdDpDelta', sig: RamSignal) => {
        const v = decodeRamSignal(sig, bytes, address);
        if (v !== null) out[key] = v;
    };
    put('mdFw', Mss54HpRamSignals.MD_FW);
    put('mdFwFilter', Mss54HpRamSignals.MD_FW_FILTER);
    put('mdLsDelta', Mss54HpRamSignals.MD_LS_DELTA);
    put('mdDpDelta', Mss54HpRamSignals.MD_DP_DELTA);
    return out;
}
