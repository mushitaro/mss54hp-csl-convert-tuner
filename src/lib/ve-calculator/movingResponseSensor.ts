/** 0401 slave 01e530 filters the ADC voltage before 01d6a2/01dc42 inspect USV.
 * This file recovers an enclosing time window for a raw threshold occurrence.
 * It never converts a narrowband voltage into a numerical AFR error. */
export const MOVING_RESPONSE_SENSOR_ADDRESSES = Object.freeze({
    offset: 0x4816, slope: 0x4818, rich: 0x4820, lean: 0x4822,
    rpmAxis: 0x4a4e, rfAxis: 0x4a56, filterValues: 0x4a5e,
});

export interface MovingResponseSensorCalibration {
    richMv: number;
    leanMv: number;
    /** ADC conversion is floor(K_LAS_M * adc / 1024) - K_LAS_NP. */
    inputMinMv: number;
    inputMaxMv: number;
    /** Maximum integer divisor in the recorded KF_LASV_TAU table. */
    maxFilterDivisor: number;
    tickSec: number;
}

const integer = (value: number) => Number.isSafeInteger(value);
const valid = (c: MovingResponseSensorCalibration) =>
    [c.richMv,c.leanMv,c.inputMinMv,c.inputMaxMv,c.maxFilterDivisor].every(integer)
    && c.inputMinMv < c.leanMv && c.leanMv < c.richMv && c.richMv < c.inputMaxMv
    && c.inputMinMv >= -32768 && c.inputMaxMv <= 32767
    && c.maxFilterDivisor >= 0 && c.maxFilterDivisor <= 65535
    && Number.isFinite(c.tickSec) && c.tickSec > 0;

/** The caller verifies that this is the BIN used for the 0401 recording.
 * QADC is a 10-bit conversion. Its complete range, not observed voltage extrema,
 * supplies the enclosing raw-voltage bounds. Reject signed conversion overflow.
 * MC68336/376 manual D.5.9: 0xFFF2CA/CC are in the right-justified unsigned
 * result window 0xFFF2B0..0xFFF2FE (bits 9:0, upper bits read zero).
 * https://www.nxp.com/docs/en/user-guide/MC68336376UM.pdf */
export function readMovingResponseSensorCalibration(buffer: ArrayBuffer | null): MovingResponseSensorCalibration | null {
    if (!buffer) return null;
    try {
        const v = new DataView(buffer), a = MOVING_RESPONSE_SENSOR_ADDRESSES;
        const word = (at: number) => v.getUint16(at,false);
        const axis = (at: number) => Array.from({length:4},(_,i) => word(at+2*i));
        const rpm = axis(a.rpmAxis), rf = axis(a.rfAxis);
        if (![rpm,rf].every(values => values.every((x,i) => x > 0 && (i === 0 || x > values[i-1])))) return null;
        const slope = word(a.slope), offset = word(a.offset);
        const convertedMaximum = Math.floor(slope*1023/1024);
        // The DME casts the converted ADC result to signed short BEFORE
        // subtracting NP. A positive NP cannot make that overflow safe.
        if (convertedMaximum > 32767) return null;
        const c: MovingResponseSensorCalibration = {
            richMv: word(a.rich), leanMv: word(a.lean),
            inputMinMv: offset === 0 ? 0 : -offset, inputMaxMv: convertedMaximum-offset,
            maxFilterDivisor: Math.max(...Array.from({length:16},(_,i) => word(a.filterValues+2*i))),
            tickSec: .01,
        };
        return valid(c) ? c : null;
    } catch { return null; }
}

/** Latest possible age of a raw rich/lean threshold occurrence, in seconds.
 *
 * Suppose no raw value crossed the requested threshold for N updates. Start
 * with the most extreme possible old filtered value and repeatedly apply the
 * closest integer input on the opposite side. Once this extremal trajectory
 * has passed the observed voltage, that supposition is impossible. At least
 * one requested-side raw value occurred in the enclosing N-tick window.
 *
 * slave011544: y += trunc((raw-y)/tau), with a minimum one-mV step. The largest
 * recorded tau retains the old sign longest, also covering interpolation of
 * nonuniform tables. One tick covers unknown phase within the task period.
 * The acquisition window is added by the caller; it must not be replaced by
 * this number. This is a necessary occurrence bound, not an exact delay. */
export function rawSignLookbackSeconds(mv: number, rich: boolean, cal: MovingResponseSensorCalibration): number | null {
    if (!valid(cal) || !integer(mv) || mv < cal.inputMinMv || mv > cal.inputMaxMv) return null;
    const threshold = rich ? cal.richMv : cal.leanMv;
    if (rich ? mv < threshold : mv > threshold) return null;
    if (cal.maxFilterDivisor <= 1) return cal.tickSec;
    let filtered = rich ? cal.inputMaxMv : cal.inputMinMv;
    const opposite = threshold + (rich ? -1 : 1);
    // Even the slowest valid filter changes by at least one mV each tick.
    const limit = cal.inputMaxMv-cal.inputMinMv+1;
    for (let ticks=1;ticks<=limit;ticks++) {
        const delta = opposite-filtered;
        filtered += Math.trunc(delta/cal.maxFilterDivisor) || Math.sign(delta);
        if (rich ? filtered < mv : filtered > mv) return ticks*cal.tickSec;
    }
    return null;
}

/** The first P update may have been armed before the observation interval.
 * Three executions require at least two subsequent re-arm transitions, hence
 * fresh crossings of both thresholds. Two executions prove both retained
 * controller signs, which is weaker in the hysteresis band. A caller must
 * separately prove active, reset-free acquisition and expand each sign window
 * with rawSignLookbackSeconds(threshold, side, calibration). I-duration is not
 * physical rich/lean duration after the voltage filter. */
export function hasFreshBothThresholdCrossings(previous: number, current: number): boolean {
    return integer(previous) && integer(current) && previous >= 0 && current < 255
        && current-previous >= 3;
}
