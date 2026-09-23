// `import type`: Node's type stripping cannot tell a type-only named import from a value one, so a
// harness that loads this module directly fails on the missing export.
import type { LogDataPoint } from '@/lib/types';
import { timeScaleSeconds } from './filter';

/**
 * Sample rate a run of log points implies, in Hz.
 *
 * `n - 1` intervals over the span they cover — never `n / last`. The origin of `time` is the link's
 * own `startTime`, not the first sample: WebSerialDmeLink sets it lazily on the first poll, and
 * MockDmeLink sets it back at connect(), so a first sample can carry a large `time` under PRACTICE.
 * Measuring against zero would report a rate that depends on how long the cable sat idle.
 *
 * Returns `undefined` rather than 0 or NaN when there is nothing to measure, so a caller can tell
 * "no rate" apart from "a rate of zero". `!(span > 0)` is deliberate — it rejects NaN as well as a
 * zero or reversed span, which `span <= 0` would let through.
 *
 * Shared by the live HUD (applied to a trailing window) and saveTune (applied to a whole log), so
 * the number on screen during a run and the number stored on the session mean the same thing.
 */
export function sampleRateHz(points: readonly LogDataPoint[]): number | undefined {
    if (points.length < 2) return undefined;
    // In SECONDS, whatever the column is in. A live DS2 run stamps seconds and a Testo CSV stamps
    // milliseconds, and this used to divide by the raw span either way — so an imported CSV reported
    // a thousandth of its real rate. Nothing crashed; the RATE cell just said 0.00, and every count
    // that reads "at this rate" was a thousand times out. `timeScaleSeconds` is the same
    // discrimination the filter and the rf_korr settling window already make, so all three agree.
    const span = (points[points.length - 1].time - points[0].time) * timeScaleSeconds(points as LogDataPoint[]);
    if (!(span > 0)) return undefined;
    const hz = (points.length - 1) / span;
    return Number.isFinite(hz) ? hz : undefined;
}

/**
 * Same maths over bare timestamps, for the live path — it keeps a rolling window of `time` values
 * rather than whole points, so it never has to copy a LogDataPoint per sample.
 *
 * No unit discrimination here, and it needs none: this is only ever fed by the DS2 poll, which
 * stamps `(performance.now() - startTime) / 1000`. Seconds, by construction.
 */
export function sampleRateHzFromTimes(times: readonly number[]): number | undefined {
    if (times.length < 2) return undefined;
    const span = times[times.length - 1] - times[0];
    if (!(span > 0)) return undefined;
    const hz = (times.length - 1) / span;
    return Number.isFinite(hz) ? hz : undefined;
}
