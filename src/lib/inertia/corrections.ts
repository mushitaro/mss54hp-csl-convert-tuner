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

/**
 * `K_MD_J_MOTOR` in an untouched 0401 calibration.
 *
 * Hard-coded for the same reason as `STOCK_K_SMG_J_MOTOR`, and the omission of it was a real bug:
 * the measured ratio used to be applied to whatever the image already held, so on a car whose
 * `K_MD_J_MOTOR` had been lowered once the next proposal lowered it again from there. Measured
 * J = 0.205 against a stock image proposes 0.2203; against an image already at 0.2463 the same
 * measurement proposed 0.2019, and a third pass would have said 0.1652. A correction that moves
 * every time you re-run it with unchanged evidence is not a correction.
 *
 * `r` is defined against stock, so the value it multiplies has to be stock too. The image's own
 * value is still read — it is what the proposal reports as `current`, and its plausibility is the
 * check that the address and field width are right — but it is not the base of the arithmetic.
 */
export const STOCK_K_MD_J_MOTOR = 0.268657;

/**
 * `K_N_TAU_DN` in an untouched 0401 calibration.
 *
 * The third instance of the same bug, found after the first two were fixed: this one still
 * multiplied `r` into whatever the image held, so raw 26 -> 32 -> 39 -> 48 -> 59 on successive
 * runs with unchanged evidence, and the quantisation step gets FINER as it falls (0.0037 s at
 * raw 26, 0.0007 s at raw 59) so the display looks more precise the further it drifts.
 *
 * The deeper problem is that scaling it by `r` at all is wrong — see the note on the proposal.
 */
export const STOCK_K_N_TAU_DN = 0.0985;

/**
 * `K_MD_DELTA_SA_SOFT` as a raw byte, for the truncation check on the gear factors.
 *
 * Not read from the image on purpose: this is used to predict an integer cliff in the DME's own
 * arithmetic, and the prediction has to be made against the value that will be in the ECU when the
 * gear factor lands. If someone has retuned it, the check below is the wrong check — which is why
 * the proposal says so rather than silently assuming.
 */
const K_MD_DELTA_SA_SOFT_RAW = 5;

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
    // Against STOCK, never against the image. See STOCK_K_MD_J_MOTOR for what going the other way
    // cost. `jMdCurrent` is still read and reported, and its plausibility is still the check that
    // the address is right — it just is not the base of this multiplication.
    const jNewMdUnits = r * STOCK_K_MD_J_MOTOR;

    const rEff: CorrectionPlan['rEff'] = [];
    if (jfz && jfz.value.kind === 'curve') {
        const gearLabels = ['N', '1st', '2nd', '3rd', '4th', '5th', '6th', 'idx7'];
        jfz.value.values.forEach((jFz, gear) => {
            rEff.push({
                gear,
                label: gearLabels[gear] ?? `idx${gear}`,
                jFz,
                // Stock on both sides of the ratio, for the same reason. Using the image's current
                // value here pulled every gear's r_eff toward 1 — 1st read 0.9532 where the truth
                // was 0.9502 — which is small, wrong, and grows with every pass.
                rEff: effectiveRatio(jNewMdUnits, STOCK_K_MD_J_MOTOR, jFz),
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
            reason: `Revert to the factory value and drive it. This constant is the CEILING on the SMG `
                + `speed regulator's commanded slew rate — min(demand, torque / J) — and lowering it `
                + `from ${STOCK_K_SMG_J_MOTOR} to ${jSmgCurrent.toFixed(4)} raised that ceiling by `
                + `${((STOCK_K_SMG_J_MOTOR / jSmgCurrent - 1) * 100).toFixed(0)} %. It acts in the CLUTCH `
                + `RE-ENGAGEMENT PHASE ONLY (shift phases 3-4): not on a launch, not during the blip, `
                + `and not on a Zug downshift. Note what was NOT changed with it: KL_SMG_MOT_J_MOTOR `
                + `(slave 0x2ACC) is the inertia that prices that gradient into feedforward torque, and `
                + `it is still at stock — so the larger gradient is converted at an unchanged inertia `
                + `and arrives undiluted. That pairing is the likeliest reason the change was felt. The `
                + `stock value here is taken from the reference binary, not from your image — confirm `
                + `it against an untouched BASE if you have one.`,
            risk: 'Re-engagement becomes softer and slower in both directions — the sign flips between '
                + 'up- and downshifts, so only the magnitude claim holds. Expect roughly 13-16 Nm less '
                + 'feedforward torque at the re-match. Intermediate steps are not measurable on this '
                + 'link (one raw step is about 2.5 Nm, under the noise of d_n40); test 0.2031 against '
                + '0.25 as a single A/B rather than walking it.',
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
                + `the measured value directly: r x ${STOCK_K_MD_J_MOTOR} (the FACTORY value, not the `
                + `${jMdCurrent.toFixed(4)} in your image — otherwise re-running the measurement would `
                + `ratchet this down every time). Two consumers, not one: md_max_begr ADDS the term `
                + `and is inert behind KL_MD_BEGR_GANG's flat 1000 Nm rail, while Torque_Limitation `
                + `SUBTRACTS it from the soft rev limiter's integrator target and does execute. Expect `
                + `to feel nothing: that path arms only within 100 rpm of the cut and the seed is then `
                + `clamped up by K_MD_NBEGR_MIN = 90 Nm, which the load torque rarely clears.`,
            risk: 'Changes how the rev limiter is approached. Nothing below redline.',
            evidence: 'code-confirmed',
        });
    }

    // --- Withdrawn: proposed until the mechanisms were traced, then found to do nothing ---------
    //
    // Reported rather than deleted. A row that silently disappears reads as "nothing needed here",
    // which is a different claim from "this was proposed and is now known not to work".
    for (const [symbol, why] of [
        ['K_LFR_TAU_IA1',
            'withdrawn. It is not the idle controller integrator constant — that rate lives in '
            + 'KF_LFR_DQI. This decays the I term in LFR_ZUSTAND 8 only, and every path into that '
            + 'state first zeroes LFR_MDI (lfr_calc 0x026C90, 0x026D0C), so the filter drives zero '
            + 'toward zero. It is also not correctable by an inertia ratio: at raw 1 the reciprocal '
            + '5.12/x step is 2.56 s, 50 %, so an 18 % change is not representable.'],
        ['K_LFR_TAU_IA2_KKS',
            'withdrawn. Stock raw 255 is ALREADY the fastest writable value, so the proposed 0.256 s '
            + 'was a move in the wrong direction. The selector is also not the clutch: S_KRAFTSCHLUSS '
            + 'on an SMG car is a 2 km/h speed test (s_kraftschluss_calc 0x01D558). And it does not '
            + 'discard the integrator — the PT1 target is the value held at handover, clamped to '
            + 'K_LFR_UEW_MAX = 5.0 Nm, so it is a one-shot transfer that RAISES demand from a warm '
            + 'idle equilibrium of about -7 Nm.'],
    ] as const) {
        blocked.push({ symbol, why });
    }

    // --- F2 / class A: engine-alone items -------------------------------------------------------
    const classA: Array<{
        symbol: string; at: string | null; index?: number;
        target: (current: number) => number; reason: string; risk: string; evidence: EvidenceGrade;
        /** Set where the item is not actually class A. Reported as written rather than as filed —
         *  a parameter in the wrong class is a parameter whose correction rule is wrong. */
        klassOverride?: Proposal['klass'];
    }> = [
            {
                symbol: 'K_N_TAU_DN', at: null,
                // Anchored to stock, not to the image — see STOCK_K_N_TAU_DN. And note the class
                // is D, not A: this is a filter time constant, and no lag in the loop it sits in
                // scales with J. The 10 ms task, the 20 ms task, K_LLS_TAU2's valve lag and the
                // inlet transport delay are all where they were before the flywheel changed.
                target: () => STOCK_K_N_TAU_DN * r,
                klassOverride: 'D',
                reason: 'PT1 on D_N_GEFILTERT. Loop gain rises as 1/J while every lag in the loop stays '
                    + 'exactly where it was, so phase margin is what a lighter flywheel spends and '
                    + 'shortening this filter buys a little back. Two things to be honest about: this is '
                    + 'NOT an inertia term (nothing in the filter contains J, which is why it is class D), '
                    + 'and the measured effect is about 8-13 rpm of extra idle dip recovery against a '
                    + '870 rpm target, roughly 0.7 % of the idle controller authority of +/-60 Nm. '
                    + 'Does not touch D_N40, which the fuel-cut logic derives separately from D_N_SEGMENT.',
                risk: 'Too short and gradient noise enters the control path. Realistically you will not '
                    + 'feel this change; log D_N_GEFILTERT (RAM 0x00FFEC9E) if you want to see it at all.',
                evidence: 'code-confirmed',
            },
            {
                symbol: 'KL_SA_N40_GANG', at: 'index 0 (clutch-out / N)', index: 0,
                target: current => current / r,
                reason: 'Clutch-out is the one case where the engine\'s own inertia is the entire plant, '
                    + 'so the rev-drop through this band speeds up by the full inertia ratio. Be clear '
                    + 'what this moves: 320 rpm is ONE TERM of four (KL_SA_N40_TMOT contributes 1200 at '
                    + 'operating temperature and K_SA_N40_HYS another 400), and because it sits inside '
                    + 'SA_N40_WIEDEREINSETZEN, which is itself a term of SA_N40, moving it shifts BOTH '
                    + 'thresholds equally and does NOT widen the band. Only KL_SA_N40_HYS_GANG does '
                    + 'that. The in-gear entries are deliberately left alone — there the vehicle inertia '
                    + 'dominates and the rate barely moves. Index 7 is reverse.',
                risk: 'Fuel returns about 38 ms earlier on a 2100 rpm/s coast, costing a little economy. '
                    + 'You will not feel it; log SA_WE_ST bit3 against N to see it. 40 rpm quantised.',
                evidence: 'code-confirmed',
            },
            {
                symbol: 'KL_SA_N40_HYS_GANG', at: 'index 0 (clutch-out / N)', index: 0,
                target: current => current / r,
                reason: 'The only term that changes the BAND WIDTH: the band is K_SA_N40_HYS (400 rpm, '
                    + 'fixed) plus this, so 120 gives 520 rpm. Note the quantisation dominates the '
                    + 'intent — 120 to 160 is a factor of 1.077, not the 1/r = 1.22 the correction asks '
                    + 'for; reaching 1/r would need 240 rpm (raw 6).',
                risk: 'Same as above, and the rounding boundary is close: above about J = 0.2143 the '
                    + 'target rounds back to the current value and this proposal disappears. '
                    + '40 rpm quantised.',
                evidence: 'code-confirmed',
            },
            {
                symbol: 'K_SMG_N_ZIEL_ABWUERG', at: null,
                target: current => current / Math.sqrt(r),
                reason: 'The closed-loop target smg_engine_speed_controller_step holds after the SMG has '
                    + 'pulled the gear. The 1/sqrt(r) figure comes from holding stored kinetic energy '
                    + '0.5*J*omega^2 constant — and that derivation does NOT apply here, because with '
                    + 'the gear out a PID is holding the speed with 30+ Nm of authority and no event is '
                    + 'drawing energy out of the flywheel. The number survives only because 40 rpm '
                    + 'quantisation lands it inside the same band a defensible derivation would. Treat '
                    + 'it as a small deliberate raise, not as a computed correction.',
                risk: 'NOT a higher launch — a launch is a different handler. The real cost is that '
                    + 're-engagement after the SMG neutral starts 120 rpm higher, so more clutch slip '
                    + 'energy, and that speed steps above 150 rpm reset the regulator integrator.',
                evidence: 'code-confirmed',
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
            group: 'F2', klass: spec.klassOverride ?? 'A', symbol: spec.symbol,
            address: spec.index !== undefined ? def.address + spec.index * (def.bits / 8) : item.def.address,
            bank: item.def.bank, at: spec.at, units: def.units,
            current, target, proposed: q.value, exact: q.exact, step: q.step,
            reason: spec.reason, risk: spec.risk, evidence: spec.evidence,
        });
    }

    // --- F3 / class A: the down-authority pair, alone -------------------------------------------
    //
    // Its own flash — but for a different reason than this comment used to give.
    //
    // It said the pair was xref-only and that the two items were useless apart. Neither holds. The
    // mechanism is code-confirmed end to end (lfr_calc 0x026A4C/0x026A6A gates MD_LLR_TZ on
    // MD_RES_LRW_ST bit1; md_res_calc 0x017CAE-C8 does the KL_MD_RES_LRW lookup on |LWS_LRW|), and
    // the gate is NOT useless alone: it also switches on KL_LFR_TZ_POS, which is fully calibrated at
    // up to 15 Nm and dead today for exactly this reason.
    //
    // The reason to keep it alone is what that second fact implies: writing the gate turns on a
    // TWO-SIDED control law, and the up side arrives already calibrated while the down side arrives
    // as whatever ramp is written here. Those are two different changes and they want two different
    // logs. Writing the gate first, alone, is the cheaper and more informative order.
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
                reason: 'Opens the gate on MD_LLR_TZ, the idle governor\'s fast (ignition) actuator. '
                    + 'Two things the earlier note here got wrong. First, this is NOT a no-op on its '
                    + 'own: it also enables KL_LFR_TZ_POS, which is fully calibrated at up to 15 Nm and '
                    + 'is dead today for exactly this reason — so writing the gate alone is a real, '
                    + 'self-contained first step, and it separates "did the gate open" from "is the ramp '
                    + 'right" in the log. Second, the reserve SIZE is the upward authority: MD_RES is '
                    + 'added to the air request but not to MD_TZ_RED, so ignition can only claw back '
                    + 'what the reserve gave. 3.0 Nm buys 3.0 Nm up; the down direction is uncapped.',
                risk: 'NOT a standing cost. K_MD_RES_LRW_V gates it to below 25 km/h (off again above '
                    + '30), so above 30 km/h it costs nothing and does nothing — which also means it '
                    + 'cannot help any in-gear drivability symptom. Below that, about 3.6 % of an ~81 Nm '
                    + 'warm idle request and 0.9 % at WOT. The real cost is light-load crawl. If you '
                    + 'only want to prove the gate opens, raw 1 (0.1 Nm) sets the same bit for a '
                    + 'thirtieth of the cost.',
                evidence: 'code-confirmed',
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
                        + 'have. All sixteen points are zero in stock 0401. Two conditions beyond the '
                        + 'gate: the NEG branch needs LFR_DN < 1 AND the engine in the LL (idle) state, '
                        + 'so it does nothing with the pedal down. y[0] stays 0 deliberately — the '
                        + 'branch boundary is LFR_DN < 1, so exactly-zero error reads y[0] and a '
                        + 'non-zero value there would retard permanently.',
                    risk: 'See the gate above. Verify with a log before believing it worked: '
                        + 'MD_RES_LRW_ST bit1 (RAM 0x00FFD910) says the gate opened, and MD_LLR_TZ '
                        + '(RAM 0x00FF8240) says by how much.',
                    evidence: 'code-confirmed',
                });
            });
        }
    }

    // --- F4 / class B: the gear factors ---------------------------------------------------------
    if (opts.includeGearFactors && rEff.length > 0) {
        for (const symbol of ['KL_MD_LS_W_GANG', 'KL_MD_W_GANG_DASHPOT'] as const) {
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

                // What the DME will ACTUALLY do with this byte, in its own integer arithmetic.
                //
                // Two facts the inertia model did not have. First, the limiter product is
                // `(rate * factor) >> 10` with a truncating shift, so a sub-count change to the
                // factor moves nothing at all — and r_eff is 0.95-1.00, which is exactly the size
                // that vanishes. Second, this table has a SECOND consumer: `Torque_Limitation`
                // latches it to RAM 0xFFD8FA every 10 ms (0x0160F6) and `FUN_00017400` multiplies
                // it into the overrun fuel-cut entry and resumption ramps (0x1746C, 0x174C6).
                // There the multiplicand is K_MD_DELTA_SA_SOFT = raw 5, so the same shift lands on
                // a cliff: factor 1024 gives 5, factor 1015 gives 4. A nominal -0.4 % write becomes
                // a -20 % change to how fast torque leaves on a lift-off, in 4th, 5th and 6th.
                //
                // Verified in the image: exactly two 32-bit references to 0x0008927C (0x160F2 and
                // 0x17256) and three to 0x00FFD8FA (one write, two reads), each read followed by
                // `asr.l #8; asr.l #2`.
                const rawNow = Math.round(current * 1024);
                const rawNew = Math.round(q.value * 1024);
                const trunc = (raw: number, mult: number) => Math.floor((mult * raw) / 1024);
                // The tip-in limiter itself: rates run from 1.7 to 30 Nm/10ms, i.e. raw 17..300.
                // If no rate in that span changes count, the intended effect is nil.
                const tipInVisible = [17, 30, 50, 100, 200, 300]
                    .some(m => trunc(rawNow, m) !== trunc(rawNew, m));
                const saBefore = trunc(rawNow, K_MD_DELTA_SA_SOFT_RAW);
                const saAfter = trunc(rawNew, K_MD_DELTA_SA_SOFT_RAW);
                const saCliff = saBefore !== saAfter;

                proposals.push({
                    group: 'F4', klass: 'B', symbol,
                    address: def.address + i * (def.bits / 8), bank: item.def.bank,
                    at: `${gear.label} (index ${i})`, units: def.units,
                    current, target, proposed: q.value, exact: q.exact, step: q.step,
                    reason: `In gear the plant is J_engine + J_vehicle(${gear.label}) = `
                        + `${(STOCK_K_MD_J_MOTOR + gear.jFz).toFixed(3)} Nms², so the effective ratio here `
                        + `is ${gear.rEff.toFixed(4)} — not ${r.toFixed(4)}. This table is the only place `
                        + `in the tip-in chain with a gear axis, which is why the correction belongs here `
                        + `and not on KF_MD_LS_KOMF.`
                        + (tipInVisible
                            ? ''
                            : ` BUT the tip-in effect of this particular write is ZERO: the DME computes `
                              + `the limiter as an integer, and ${current.toFixed(4)} and `
                              + `${q.value.toFixed(4)} both truncate to the same count.`)
                        + (saCliff
                            ? ` AND it has a SIDE EFFECT nowhere in the inertia model: the same byte is `
                              + `latched to RAM 0xFFD8FA every 10 ms by Torque_Limitation (0x0160F6) and `
                              + `multiplied into the overrun fuel-cut ramps at 0x1746C and 0x174C6. `
                              + `K_MD_DELTA_SA_SOFT goes ${saBefore} -> ${saAfter} counts here, a `
                              + `${(100 * (saAfter - saBefore) / saBefore).toFixed(0)} % change to how fast `
                              + `torque is pulled out on a lift-off. That is not an inertia correction and `
                              + `nobody asked for it.`
                            : ''),
                    risk: (saCliff
                        ? 'DO NOT WRITE AS-IS. This value crosses an integer cliff in the fuel-cut ramp '
                          + 'that shares this table. '
                        : '')
                        + 'XDF-defined as KL_MD_LS_W_GANG (0x926C) / KL_MD_W_GANG_DASHPOT (0x928E) — '
                        + 'editable in TunerPro, not a blind patch. The truncation prediction assumes '
                        + 'K_MD_DELTA_SA_SOFT is still raw 5; re-check it if that has been retuned.',
                    evidence: 'code-confirmed',
                });
            });
        }
    } else if (rEff.length > 0) {
        blocked.push({
            symbol: 'KL_MD_LS_W_GANG / KL_MD_W_GANG_DASHPOT',
            why: 'held back for a later flash — these are direct patches to XDF-undefined addresses, '
                + 'and the in-gear correction they carry is 0.95-1.00, small enough to be worth '
                + 'confirming the class-A changes first',
        });
    }

    return { jNew, jSmgCurrent, jMdCurrent, r, rEff, proposals, blocked };
}
