/**
 * Turning a physical value into one the calibration can actually hold.
 *
 * These live here, beside `EcuNumericDef`, because they are the encoding boundary and every writer
 * needs them — the flywheel proposal builder had them first, but they were never inertia logic.
 * Two copies existed for a while, one per tuner; a shared boundary with two implementations is a
 * sign inversion waiting to happen in exactly one of them.
 *
 * The pair exists because rounding direction is a decision, not a detail. See `quantiseToward`.
 */

import type { EcuNumericDef } from './types';

/** Field limits for a raw value. Exported: this rule was stated in four places once the
 *  calibration editor arrived, and four statements of one rule is a sign inversion waiting to
 *  happen in exactly one of them — the same argument as this file's own header. */
export function rawLimits(def: Pick<EcuNumericDef, 'bits' | 'signed'>): { min: number; max: number } {
    const max = def.bits === 8 ? (def.signed ? 127 : 255) : (def.signed ? 32767 : 65535);
    const min = def.bits === 8 ? (def.signed ? -128 : 0) : (def.signed ? -32768 : 0);
    return { min, max };
}

/**
 * The step at `raw`, measured rather than assumed. A reciprocal scaling (`5.12/x`) has a step that
 * varies by two orders of magnitude across its range, so a single constant would be a lie at one
 * end or the other.
 */
function stepAt(def: EcuNumericDef, raw: number, value: number): number {
    const { min, max } = rawLimits(def);
    const neighbour = def.scaling.toPhysical(Math.max(min, Math.min(max, raw + 1)));
    return Math.abs(neighbour - value);
}

/** Nearest writable value for a scaled field, plus how far away it was. `raw` and `clamped`
 *  ride along (additively) for the calibration editor, which writes the raw it shows. */
export function quantise(def: EcuNumericDef, physical: number): {
    value: number; exact: boolean; step: number; raw: number; clamped: boolean;
} {
    const { min, max } = rawLimits(def);

    const rawExact = def.scaling.toRaw(physical);
    const rounded = Math.round(rawExact);
    const raw = Math.max(min, Math.min(max, rounded));
    const value = def.scaling.toPhysical(raw);

    return {
        value, exact: Math.abs(value - physical) < 1e-9, step: stepAt(def, raw, value),
        raw, clamped: raw !== rounded,
    };
}

/**
 * Nearest writable value that is NO FURTHER from `toward` than the request was.
 *
 * `quantise` rounds to nearest, which can land a value further from the current calibration than
 * the caller asked to move it. For a one-off constant that is half an LSB of nothing. For a loop
 * that will be run again it is not: the same rounding bias applies every pass, in the same
 * direction, so a cell that has already converged can be walked away from its own answer one half
 * step at a time — and each pass looks individually reasonable while doing it.
 *
 * So the rounding direction is chosen rather than inherited. Round toward `toward` (the value the
 * cell currently holds), which can only ever under-shoot the request, never over-shoot it.
 */
export function quantiseToward(
    def: EcuNumericDef, physical: number, toward: number,
): { value: number; exact: boolean; step: number; steps: number } {
    const { min, max } = rawLimits(def);

    const rawExact = def.scaling.toRaw(physical);
    const rawToward = def.scaling.toRaw(toward);
    // Floor when moving up, ceil when moving down — either way, toward the value we came from.
    const rounded = rawExact >= rawToward ? Math.floor(rawExact) : Math.ceil(rawExact);
    const raw = Math.max(min, Math.min(max, rounded));
    const value = def.scaling.toPhysical(raw);

    return {
        value,
        exact: Math.abs(value - physical) < 1e-9,
        step: stepAt(def, raw, value),
        steps: Math.abs(raw - Math.round(rawToward)),
    };
}
