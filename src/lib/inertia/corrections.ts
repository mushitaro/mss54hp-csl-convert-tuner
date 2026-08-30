/**
 * Turns a measured inertia into a list of proposed calibration changes.
 *
 * Proposes only. Nothing here writes a byte, and nothing here talks to a car — the output is a
 * table for an operator to read, group by group, and decide on.
 *
 * ## The classification is the whole idea
 *
 * A single ratio applied to everything is wrong, and wrong by a factor of up to twenty. Each
 * parameter is corrected by the inertia **it actually sees**:
 *
 * | Class | Sees | Factor |
 * |---|---|---|
 * | A | the engine alone — clutch-out, neutral, idle | `r` |
 * | B | engine + car, because the slew limiters only act in gear | `r_eff(gear)` |
 * | C | J is literally the divisor in the ECU's own expression | set from J directly |
 * | D | not an inertia effect at all — the DMF damper, misfire thresholds | nothing |
 *
 * Class B is the one that catches people out. `KF_MD_LS_KOMF` is bypassed below `K_MD_DF_VMIN`
 * (3 km/h), so it only ever runs with a gear engaged, and there the plant is `J_eng + J_fz(gear)`
 * with `J_fz` between 0.70 and 12.0 Nms² against an engine's 0.27. A 20 % lighter flywheel is a
 * 5 % change in first gear and 0.4 % in sixth. Correcting those by `r` would be a five- to
 * fiftyfold over-correction, and it would be applied to a map that has no gear axis to undo it on.
 *
 * ## What is deliberately NOT proposed
 *
 * - `KL_SMG_MOT_J_MOTOR` — the observer's use of it was never recovered, so the sign of a change
 *   is unknown. An unknown sign is not a small risk, it is no information.
 * - `K_WE_DN40_HARD` — already one step off the floor its signed-byte encoding allows.
 * - Misfire thresholds — a real misfire's segment-time deviation scales with 1/J exactly like the
 *   healthy scatter does, so "raise them by the inertia ratio" is not an argument.
 * - Anything on the DMF damper. There is no coefficient for a spring that was removed.
 */

import type { EcuItemDef, EcuBank, EcuNumericDef } from '../ecu-items/types';
import type { InertiaEstimate } from './types';
import { BinaryParser } from '../binary-engine/parser';
import { findEcuItem } from '../ecu-items/catalog';

/**
 * `K_SMG_J_MOTOR` in an untouched 0401 calibration.
 *
 * Hard-coded because it cannot be read: the BASE image is the operator's CURRENT calibration, which
 * on any car that has already been touched no longer holds the factory value. Everything else in
 * this module reads from the image; this one number is the exception and is flagged as such in the
 * proposal it produces.
 */
export const STOCK_K_SMG_J_MOTOR = 0.25;

/** Which flash a change belongs to. One group per flash, and a flash is all 65536 bytes. */
export type FlashGroup = 'F1' | 'F2' | 'F3' | 'F4' | 'F5';

export type EvidenceGrade = 'code-confirmed' | 'xref-only' | 'funktionsrahmen-only' | 'inference';

export interface Proposal {
    group: FlashGroup;
    /** A / B / C / D per the table above. */
    klass: 'A' | 'B' | 'C' | 'D';
    symbol: string;
    /** Byte offset in the partial BIN — the XDF address, unchanged. */
    address: number;
    bank: EcuBank;
    /** Which element: a gear name, a cell, or null for a plain constant. */
    at: string | null;
    units: string;
    current: number;
    /** What the physics asks for, before the encoding gets a say. */
    target: number;
    /** What can actually be written. This is the number to act on. */
    proposed: number;
    /** False when `target` is not representable and `proposed` is the nearest thing that is. */
    exact: boolean;
    /** Quantisation step at this point on the scale. Non-constant for reciprocal scalings. */
    step: number;
    reason: string;
    risk: string;
    evidence: EvidenceGrade;
}

export interface CorrectionPlan {
    /** Measured engine inertia, Nms². */
    jNew: number;
    /** `K_SMG_J_MOTOR` as read from the BASE image — the operator's current value, not stock. */
    jSmgCurrent: number;
    /** `K_MD_J_MOTOR` as read from the BASE image. */
    jMdCurrent: number;
    /** `jNew / STOCK_K_SMG_J_MOTOR`, in the SMG unit system. */
    r: number;
    /** Effective ratio per gear index 0-7, from the image's own `KL_MD_JFZ_GANG`. */
    rEff: { gear: number; label: string; jFz: number; rEff: number }[];
    proposals: Proposal[];
    /** Items that could not be proposed, and why. Load-bearing: a silently absent row reads as
     *  "nothing needed here", which is a different claim from "this could not be computed". */
    blocked: { symbol: string; why: string }[];
}

// `quantise` moved to the encoding boundary it belongs to, beside EcuNumericDef, when the idle
// tuner turned out to need the same function. Re-exported here so existing callers and
// `verify:inertia` keep their import path.
import { quantise } from '../ecu-items/quantise';
export { quantise };

function numericOf(def: EcuItemDef): EcuNumericDef {
    return def.kind === 'constant' ? def : def.values;
}

/**
 * Effective inertia ratio in a given gear.
 *
 * `r_eff = (J_new + J_fz) / (J_old + J_fz)`. Both engine terms are taken in the Momentenmanager's
 * unit system, because `KL_MD_JFZ_GANG` and `K_MD_J_MOTOR` share the `X/268` scaling and mixing
 * that with `K_SMG_J_MOTOR`'s `X/128` would be a 7 % error dressed as physics.
 */
export function effectiveRatio(jNewMdUnits: number, jOldMdUnits: number, jFz: number): number {
    return (jNewMdUnits + jFz) / (jOldMdUnits + jFz);
}

interface ProposeOptions {
    /**
     * Largest change to `K_SMG_J_MOTOR` in raw steps per flash.
     *
     * Stepped rather than jumped because this constant is not being set to a physical value — it is
     * being searched for the point where re-engagement is smooth without the blip going lazy, and
     * that point is found by walking toward it and driving between each step.
     */
    maxJRawStepsPerFlash: number;
    /** Include the class-B gear-factor proposals, which are direct patches to XDF-undefined
     *  addresses. Off by default: they belong to a later flash and need their own confirmation. */
    includeGearFactors: boolean;
}

const DEFAULTS: ProposeOptions = {
    maxJRawStepsPerFlash: 4,
    includeGearFactors: false,
};

/**
 * Builds the proposal list.
 *
 * `baseImage` must be the 65536-byte partial BIN currently in the car. Every current value is read
 * from it — nothing in this module trusts the numbers in the catalog comments, which describe a
 * reference binary and not necessarily this one.
 */
export function proposeCorrections(
    estimate: InertiaEstimate,
    baseImage: ArrayBuffer,
    options: Partial<ProposeOptions> = {},
): CorrectionPlan | null {
    if (!estimate.acceptable || estimate.j === null) return null;
    const opts = { ...DEFAULTS, ...options };

    const parser = new BinaryParser(baseImage);
    const proposals: Proposal[] = [];
    const blocked: { symbol: string; why: string }[] = [];

    const read = (symbol: string) => {
        const def = findEcuItem(symbol);
        if (!def) { blocked.push({ symbol, why: 'not in the item catalog' }); return null; }
        try {
            return { def, value: parser.readItem(def) };
        } catch (e) {
            blocked.push({ symbol, why: e instanceof Error ? e.message : String(e) });
            return null;
        }
    };

    const jNew = estimate.j;

    // --- Anchor everything to what the image actually holds -------------------------------------
    const smgJ = read('K_SMG_J_MOTOR');
    const mdJ = read('K_MD_J_MOTOR');
    const jfz = read('KL_MD_JFZ_GANG');
    if (!smgJ || smgJ.value.kind !== 'constant') return null;
    if (!mdJ || mdJ.value.kind !== 'constant') return null;

    const jSmgCurrent = smgJ.value.value;
    const jMdCurrent = mdJ.value.value;
    const r = jNew / STOCK_K_SMG_J_MOTOR;

    // A zero or absurd inertia here is not a value to compute with. It would drive
    // `effectiveRatio` to exactly 1.0 for every gear, which is indistinguishable from a correct
    // "no correction needed" answer — the failure would present as a clean, confident no-op. That
    // is precisely the shape of mistake this whole module is arranged to make impossible, so it
    // refuses instead. The way to arrive here is a wrong address or a wrong field width.
    if (!(jMdCurrent > 0.05) || jMdCurrent > 1.0) {
        blocked.push({
            symbol: 'K_MD_J_MOTOR',
            why: `read back as ${jMdCurrent} Nms², which is not a possible engine inertia. Suspect the `
                + `address or the field width before the binary. No in-gear correction can be computed `
                + `without it.`,
        });
        return { jNew, jSmgCurrent, jMdCurrent, r, rEff: [], proposals, blocked };
    }

    // The measured J is in physical units; expressing it in the Momentenmanager's system is just
    // the same number. What differs between the two constants is their ENCODING, not their unit —
    // both are Nms². The 0.25 / 0.2687 discrepancy is BMW disagreeing with itself, so each is
    // scaled against its own stock value rather than against the other's.
    const jNewMdUnits = r * jMdCurrent;

    const rEff: CorrectionPlan['rEff'] = [];
    if (jfz && jfz.value.kind === 'curve') {
        const gearLabels = ['N', '1st', '2nd', '3rd', '4th', '5th', '6th', 'idx7'];
        jfz.value.values.forEach((jFz, gear) => {
            rEff.push({
                gear,
                label: gearLabels[gear] ?? `idx${gear}`,
                jFz,
                rEff: effectiveRatio(jNewMdUnits, jMdCurrent, jFz),
            });
        });
    } else {
        blocked.push({
            symbol: 'KL_MD_JFZ_GANG',
            why: 'could not be read, so no in-gear (class B) correction can be computed — '
                + 'without the vehicle inertia per gear, the effective ratio is a guess',
        });
    }

    // --- F1 / class C: put K_SMG_J_MOTOR back to stock ------------------------------------------
    //
    // First, before the measurement is even used, because it is a diagnostic rather than a
    // correction: both of the reported symptoms sit on the clutch re-engagement path this constant
    // clamps, and a one-line revert answers whether that is where they come from.
    if (Math.abs(jSmgCurrent - STOCK_K_SMG_J_MOTOR) > 1e-6) {
        const q = quantise(numericOf(smgJ.def), STOCK_K_SMG_J_MOTOR);
        proposals.push({
            group: 'F1', klass: 'C', symbol: 'K_SMG_J_MOTOR',
            address: smgJ.def.address, bank: smgJ.def.bank, at: null, units: 'Nms²',
            current: jSmgCurrent, target: STOCK_K_SMG_J_MOTOR, proposed: q.value,
            exact: q.exact, step: q.step,
            reason: `Revert to the factory value and drive it. This constant clamps the SMG speed `
                + `regulator's commanded slew rate to torque / J, and its consumer is called from `
                + `the phase-3 clutch re-engagement regulator — so lowering it from ${STOCK_K_SMG_J_MOTOR} `
                + `to ${jSmgCurrent.toFixed(4)} gave that regulator `
                + `${((STOCK_K_SMG_J_MOTOR / jSmgCurrent - 1) * 100).toFixed(0)} % more authority on every `
                + `launch and every shift. Both reported symptoms are re-engagement events. Note the `
                + `stock value is taken from the reference binary, not from your image — confirm it `
                + `against an untouched BASE if you have one.`,
            risk: 'Blips become lazier again. If the jerk goes away, this was the cause and the '
                + 'final value is somewhere between — walk it back down a step at a time.',
            evidence: 'code-confirmed',
        });
    }

    // --- F2 / class C: the Momentenmanager's inertia --------------------------------------------
    {
        const q = quantise(numericOf(mdJ.def), jNewMdUnits);
        proposals.push({
            group: 'F2', klass: 'C', symbol: 'K_MD_J_MOTOR',
            address: mdJ.def.address, bank: mdJ.def.bank, at: null, units: 'Nms²',
            current: jMdCurrent, target: jNewMdUnits, proposed: q.value, exact: q.exact, step: q.step,
            reason: `J appears here as a real inertia rather than as a tuning constant, so it takes `
                + `the measured value directly. Only the soft rev limiter's integrator target reads `
                + `it — the md_max_begr path is inert — so the effect is confined to how the limiter `
                + `is approached.`,
            risk: 'Changes how the rev limiter is approached. Nothing below redline.',
            evidence: 'code-confirmed',
        });
    }

    // --- F2 / class A: engine-alone items -------------------------------------------------------
    const classA: Array<{
        symbol: string; at: string | null; index?: number;
        target: (current: number) => number; reason: string; risk: string; evidence: EvidenceGrade;
    }> = [
            {
                symbol: 'K_LFR_TAU_IA1', at: null,
                target: () => 1.707,
                reason: 'Stock sits at raw 1 — the slowest value the reciprocal encoding can express — '
                    + 'which leaves integrator torque standing for seconds after a lift. This is not an '
                    + 'inertia correction; it is at a rail and should be moved whatever J turns out to be. '
                    + 'Reciprocal scaling, so only 5.12 / 2.56 / 1.707 / 1.28 exist near here.',
                risk: 'Too fast and idle hunts. If 1.707 is not enough, 1.024 (raw 5) is the next stop.',
                evidence: 'code-confirmed',
            },
            {
                symbol: 'K_LFR_TAU_IA2_KKS', at: null,
                target: () => 0.256,
                reason: 'Stock raw 255 is the fastest writable value: a 20 ms time constant on a 20 ms '
                    + 'task throws the whole integrator away every cycle, which is what produces the dip '
                    + 'when the clutch goes in. Lower inertia deepens that dip for the same torque error.',
                risk: 'Slower recovery from the dip if taken too far.',
                evidence: 'code-confirmed',
            },
            {
                symbol: 'K_N_TAU_DN', at: null,
                target: current => current * r,
                reason: 'Loop gain rises as 1/J while every lag in the loop stays exactly where it was, '
                    + 'so phase margin is what a lighter flywheel spends. Shortening this filter buys some '
                    + 'of it back. Does not touch D_N40, which the fuel-cut logic uses.',
                risk: 'Too short and gradient noise enters the control path.',
                evidence: 'code-confirmed',
            },
            {
                symbol: 'KL_SA_N40_GANG', at: 'index 0 (clutch-out / N)', index: 0,
                target: current => current / r,
                reason: 'Clutch-out is the one case where the engine\'s own inertia is the entire plant, '
                    + 'so the rev-drop through this band speeds up by the full inertia ratio and the band '
                    + 'has to widen to keep the same transit time. The in-gear entries are deliberately '
                    + 'left alone — there the vehicle inertia dominates and the rate barely moves.',
                risk: 'Fuel cut releases earlier, costing a little economy. 40 rpm quantised.',
                evidence: 'code-confirmed',
            },
            {
                symbol: 'KL_SA_N40_HYS_GANG', at: 'index 0 (clutch-out / N)', index: 0,
                target: current => current / r,
                reason: 'Hysteresis on the threshold above; moved with it so the band keeps its shape.',
                risk: 'Same as above. 40 rpm quantised.',
                evidence: 'code-confirmed',
            },
            {
                symbol: 'K_SMG_N_ZIEL_ABWUERG', at: null,
                target: current => current / Math.sqrt(r),
                reason: 'Stall margin is stored kinetic energy, 0.5*J*omega^2. Holding that constant '
                    + 'through an inertia change means raising the target speed by 1/sqrt(r), not by 1/r — '
                    + 'the square is why. 40 rpm quantised.',
                risk: 'Launch happens at a higher idle. Noticeable before it is a problem.',
                evidence: 'funktionsrahmen-only',
            },
        ];

    for (const spec of classA) {
        const item = read(spec.symbol);
        if (!item) continue;
        const def = numericOf(item.def);

        let current: number;
        if (item.value.kind === 'constant') {
            current = item.value.value;
        } else if (item.value.kind === 'curve' && spec.index !== undefined) {
            current = item.value.values[spec.index];
        } else {
            blocked.push({ symbol: spec.symbol, why: `unexpected item kind ${item.value.kind}` });
            continue;
        }

        const target = spec.target(current);
        const q = quantise(def, target);
        if (Math.abs(q.value - current) < q.step / 2) {
            blocked.push({
                symbol: spec.symbol,
                why: `already at the nearest writable value (${current} ${def.units}); the correction `
                    + `is smaller than the ${q.step.toPrecision(3)} ${def.units} quantisation step`,
            });
            continue;
        }

        proposals.push({
            group: 'F2', klass: 'A', symbol: spec.symbol,
            address: spec.index !== undefined ? def.address + spec.index * (def.bits / 8) : item.def.address,
            bank: item.def.bank, at: spec.at, units: def.units,
            current, target, proposed: q.value, exact: q.exact, step: q.step,
            reason: spec.reason, risk: spec.risk, evidence: spec.evidence,
        });
    }

    // --- F3 / class A: the down-authority pair, alone -------------------------------------------
    //
    // Its own flash, for two reasons that both matter. It is xref-only, so if it does nothing the
    // question "was the mechanism understood?" has to be separable from "was it drowned out?". And
    // the two items are useless apart: KL_MD_RES_LRW is the gate, and KL_LFR_TZ_NEG behind a shut
    // gate is sixteen zeros that stay sixteen zeros.
    const resLrw = read('KL_MD_RES_LRW');
    const tzNeg = read('KL_LFR_TZ_NEG');
    if (resLrw && tzNeg && resLrw.value.kind === 'curve' && tzNeg.value.kind === 'curve') {
        const gateCurrent = resLrw.value.values[0];
        const allZero = tzNeg.value.values.every(v => v === 0);
        if (gateCurrent === 0 && allZero) {
            const gateDef = numericOf(resLrw.def);
            const q = quantise(gateDef, 3.0);
            proposals.push({
                group: 'F3', klass: 'A', symbol: 'KL_MD_RES_LRW',
                address: gateDef.address, bank: resLrw.def.bank, at: 'y[0]', units: gateDef.units,
                current: gateCurrent, target: 3.0, proposed: q.value, exact: q.exact, step: q.step,
                reason: 'Opens the gate. Without this, KL_LFR_TZ_NEG cannot act at all, which is why '
                    + 'the two must go in the same flash and no others should go with them.',
                risk: 'A standing reserve is a standing ignition retard: fuel economy, exhaust '
                    + 'temperature and launch crispness all pay for it. Do not exceed ~3 Nm.',
                evidence: 'xref-only',
            });
            const rampDef = numericOf(tzNeg.def);
            const ramp = [0, 1.0, 2.0, 3.5, 6.0, 7.0, 8.0, 8.5];
            tzNeg.value.values.forEach((current, i) => {
                const target = i < ramp.length ? ramp[i] : 9.0;
                const qq = quantise(rampDef, target);
                proposals.push({
                    group: 'F3', klass: 'A', symbol: 'KL_LFR_TZ_NEG',
                    address: rampDef.address + i * (rampDef.bits / 8),
                    bank: tzNeg.def.bank, at: `y[${i}]`, units: rampDef.units,
                    current, target, proposed: qq.value, exact: qq.exact, step: qq.step,
                    reason: 'Creates a rev-down ignition authority the calibration does not currently '
                        + 'have. All sixteen points are zero in stock 0401.',
                    risk: 'See the gate above. Verify with a log before believing it worked — the '
                        + 'mechanism is xref-only.',
                    evidence: 'xref-only',
                });
            });
        }
    }

    // --- F4 / class B: the gear factors ---------------------------------------------------------
    if (opts.includeGearFactors && rEff.length > 0) {
        for (const symbol of ['KF_MD_LS_GANG_FAKTOR', 'KF_MD_DASHPOT_GANG_FAKTOR'] as const) {
            const item = read(symbol);
            if (!item || item.value.kind !== 'series') continue;
            const def = item.value ? numericOf(item.def) : null;
            if (!def) continue;
            item.value.values.forEach((current, i) => {
                // Index 0 is the out-of-range fallback, not a gear, and index 7 is unidentified.
                const gear = rEff.find(g => g.gear === i);
                if (i === 0 || i === 7 || !gear || gear.jFz === 0) return;
                const target = current * gear.rEff;
                const q = quantise(def, target);
                if (Math.abs(q.value - current) < q.step / 2) return;
                proposals.push({
                    group: 'F4', klass: 'B', symbol,
                    address: def.address + i * (def.bits / 8), bank: item.def.bank,
                    at: `${gear.label} (index ${i})`, units: def.units,
                    current, target, proposed: q.value, exact: q.exact, step: q.step,
                    reason: `In gear the plant is J_engine + J_vehicle(${gear.label}) = `
                        + `${(jMdCurrent + gear.jFz).toFixed(3)} Nms², so the effective ratio here is `
                        + `${gear.rEff.toFixed(4)} — not ${r.toFixed(4)}. This table is the only place in `
                        + `the tip-in chain with a gear axis, which is why the correction belongs here `
                        + `and not on KF_MD_LS_KOMF.`,
                    risk: 'XDF-undefined address — this is a direct patch. Check the byte count and '
                        + 'the address twice before writing.',
                    evidence: 'code-confirmed',
                });
            });
        }
    } else if (rEff.length > 0) {
        blocked.push({
            symbol: 'KF_MD_LS_GANG_FAKTOR / KF_MD_DASHPOT_GANG_FAKTOR',
            why: 'held back for a later flash — these are direct patches to XDF-undefined addresses, '
                + 'and the in-gear correction they carry is 0.95-1.00, small enough to be worth '
                + 'confirming the class-A changes first',
        });
    }

    return { jNew, jSmgCurrent, jMdCurrent, r, rEff, proposals, blocked };
}
