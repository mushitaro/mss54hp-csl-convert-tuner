/**
 * A stationary-neutral engine, simulated, with a known inertia.
 *
 * This exists because the inertia estimator has no other way to be checked. On a car the true J is
 * exactly the unknown being measured, so a plausible-looking answer and a correct one are
 * indistinguishable; here the answer is chosen in advance and the estimator either recovers it or
 * does not. `mockDrive.ts` cannot serve — it is a scripted rpm/load cycle with no rotational
 * dynamics and no torque model, so its samples have no relationship between torque and gradient
 * for a regression to find.
 *
 * The simulation is deliberately not a good engine model. It is a good *channel* model: what
 * matters for testing the estimator is that `n40` and `d_n40` are produced with the DME's own
 * quantisation — including the asymmetric truncation in `D_N40 = (D_N_SEGMENT + 0x14) / 0x28` — so
 * that the correction in `gradient.ts` is exercised against the thing it claims to correct rather
 * than against a restatement of itself.
 */

import type { EgasMeasurement } from '../dme-link/types';

export interface BenchOptions {
    /** The inertia the estimator is supposed to recover, Nms^2. */
    j: number;
    /** Sample interval, seconds. ~0.11 is the rate a single-block EGAS poll is expected to reach. */
    sampleIntervalS: number;
    /** Integration step, seconds. Much smaller than the sample interval so the plant is not itself
     *  a quantisation artefact. */
    stepS: number;
    /** Peak-to-peak noise added to the modelled torque before quantisation, Nm. */
    torqueNoiseNm: number;
    /** Deterministic seed, so a failing case is reproducible. */
    seed: number;
}

export const DEFAULT_BENCH: BenchOptions = {
    j: 0.2100,
    sampleIntervalS: 0.11,
    stepS: 0.002,
    torqueNoiseNm: 1.5,
    seed: 12345,
};

/**
 * Loss torque: friction plus pumping, Nm, rising with speed.
 *
 * Shaped to land where an S54 actually motors — around 22 Nm at 2000 rpm and 40 Nm at 5000 — so
 * that the estimator's plausibility rail on `M_loss` is exercised at a realistic value rather than
 * being trivially satisfied.
 */
export function benchLossTorque(rpm: number): number {
    return 12 + 0.0045 * rpm + 3.5e-7 * rpm * rpm;
}

/** Indicated torque for a pedal fraction, Nm. Smooth, monotonic, and peaked mid-range. */
export function benchIndicatedTorque(pedalFraction: number, rpm: number): number {
    const shape = 0.72 + 0.28 * Math.sin((Math.min(Math.max(rpm, 1000), 7000) - 1000) / 6000 * Math.PI);
    return Math.max(0, pedalFraction * 340 * shape);
}

/** Deterministic PRNG — mulberry32. Seeded so a failure can be re-run. */
function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * Applies the DME's own `d_n40` encoding, truncation and all.
 *
 * `D_N40 = (D_N_SEGMENT + 0x14) / 0x28` with integer division that truncates toward zero, then read
 * back at 40 rpm/s per LSB and clipped to a signed byte. Reproducing the truncation here rather
 * than rounding is the entire reason this bench can test `correctDN40`: round symmetrically and the
 * correction would look wrong, which is exactly the mistake the correction exists to fix.
 */
export function encodeDN40(trueRpmPerS: number): number {
    const lsb = Math.trunc((trueRpmPerS + 20) / 40);
    const clipped = Math.max(-128, Math.min(127, lsb));
    return clipped * 40;
}

/** `n40` is a plain unsigned byte at 40 rpm per count — truncating, not rounding. */
export function encodeN40(rpm: number): number {
    return Math.max(0, Math.min(255, Math.floor(rpm / 40))) * 40;
}

/** One leg of the procedure: hold a pedal fraction until the engine passes `toRpm`. */
export interface BenchSweep {
    pedalFraction: number;
    fromRpm: number;
    toRpm: number;
}

/**
 * Runs a set of sweeps and a closing coast-down, and returns the samples a DME would have sent.
 *
 * The coast-down is emitted with the overrun-cut bit set and zero indicated torque, which is what
 * the estimator's free-deceleration cross-check looks for.
 */
export function runBench(
    sweeps: readonly BenchSweep[],
    options: Partial<BenchOptions> = {},
): EgasMeasurement[] {
    const opts: BenchOptions = { ...DEFAULT_BENCH, ...options };
    const rand = rng(opts.seed);
    const out: EgasMeasurement[] = [];
    let t = 0;

    const emit = (rpm: number, trueRpmPerS: number, torqueNm: number, fuelCut: boolean) => {
        out.push({
            time: t,
            // What the DME really sends, not what the gate happened to expect. `zustand_motor` is a
            // one-hot bitfield: 0x08 = TL (part load) under throttle, 0x04 = LL (idle) on the
            // overrun. It was hardcoded to 2 — cranking — which is exactly the value the estimator's
            // gate was wrongly written against, so the bench agreed with the bug and forty checks
            // passed over a workflow that could not accept a single real sample. A fixture that
            // encodes the same misunderstanding as the code under test cannot fail with it.
            engineState: fuelCut ? 0x04 : 0x08,
            wdk1: 0,
            n40: encodeN40(rpm),
            dN40: encodeDN40(trueRpmPerS),
            dPwg: 0,
            dWdk: 0,
            rf: 20,
            mdIndWunsch: Math.round(torqueNm * 10) / 10,
            mdIndNe: Math.round(torqueNm * 10) / 10,
            // 0.1 Nm quantisation, exactly as the uint16 x 0.1 channel delivers it.
            mdIndOptKorr: Math.round(torqueNm * 10) / 10,
            vAntrieb: 0,
            mdDynSt: 0,
            gang: 0,
            sKrafts: 0,
            // bit0 armed + bit1 + bit3 active, which is what the ROM sets once fuel really stops.
            // Bit 3 is the one that means "cut", and bit 0 alone means only "conditions met" — the
            // estimator used to test bit 0, and this fixture used to set exactly bit 0.
            saWeSt: fuelCut ? 0b1011 : 0,
        });
    };

    const integrate = (
        startRpm: number,
        stopWhen: (rpm: number) => boolean,
        torqueAt: (rpm: number) => number,
        fuelCut: boolean,
        maxSeconds: number,
    ): number => {
        let rpm = startRpm;
        let sinceSample = 0;
        let elapsed = 0;
        while (!stopWhen(rpm) && elapsed < maxSeconds) {
            const mInd = torqueAt(rpm);
            const net = mInd - benchLossTorque(rpm);
            const alpha = net / opts.j;                  // rad/s^2
            const rpmPerS = (alpha * 60) / (2 * Math.PI);
            if (sinceSample <= 0) {
                const noise = (rand() - 0.5) * opts.torqueNoiseNm;
                emit(rpm, rpmPerS, Math.max(0, mInd + noise), fuelCut);
                sinceSample = opts.sampleIntervalS;
            }
            rpm += rpmPerS * opts.stepS;
            t += opts.stepS;
            elapsed += opts.stepS;
            sinceSample -= opts.stepS;
            if (rpm < 500) break;
        }
        return rpm;
    };

    for (const sweep of sweeps) {
        integrate(
            sweep.fromRpm,
            rpm => rpm >= sweep.toRpm,
            rpm => benchIndicatedTorque(sweep.pedalFraction, rpm),
            false,
            30,
        );
        // A beat at the top with the throttle shut, so consecutive sweeps do not run together.
        t += 0.5;
    }

    // Coast-down for the cross-check: no combustion torque, overrun cut flagged.
    integrate(5000, rpm => rpm <= 3000, () => 0, true, 30);

    return out;
}

/**
 * A replayable bench run, for PRACTICE mode.
 *
 * Precomputes one pass of the standard procedure and plays it back against wall-clock time,
 * looping. Replaying a recorded run rather than integrating live is deliberate: it is the same code
 * path `verify-inertia.mjs` asserts against, so what the offline mode rehearses is exactly what the
 * checks cover. A second, subtly different simulator would rehearse something nobody tested.
 */
export class MockInertiaBench {
    private readonly samples: EgasMeasurement[];
    readonly trueJ: number;

    constructor(j = DEFAULT_BENCH.j) {
        this.trueJ = j;
        this.samples = runBench(STANDARD_BENCH_SWEEPS, { j });
    }

    /** Total length of one pass, seconds. */
    get cycleSeconds(): number {
        return this.samples.length > 0 ? this.samples[this.samples.length - 1].time : 0;
    }

    /** The sample this run would have produced `t` seconds in, looping. */
    sample(t: number): EgasMeasurement {
        const cycle = this.cycleSeconds;
        const into = cycle > 0 ? ((t % cycle) + cycle) % cycle : 0;
        // Linear scan is fine: a pass is a few hundred samples and this is called at ~9 Hz.
        let index = 0;
        while (index + 1 < this.samples.length && this.samples[index + 1].time <= into) index++;
        // Restamped with the caller's clock — the estimator measures the sample interval from these
        // timestamps, so handing back the recording's own would report the recording's rate rather
        // than the rate this link is achieving.
        return { ...this.samples[index], time: t };
    }
}

/** The procedure the InertiaPanel asks the driver to perform: three pedal steps, twice each. */
export const STANDARD_BENCH_SWEEPS: readonly BenchSweep[] = [
    { pedalFraction: 0.15, fromRpm: 1800, toRpm: 4800 },
    { pedalFraction: 0.25, fromRpm: 1800, toRpm: 4800 },
    { pedalFraction: 0.35, fromRpm: 1800, toRpm: 4800 },
    { pedalFraction: 0.18, fromRpm: 1800, toRpm: 4800 },
    { pedalFraction: 0.28, fromRpm: 1800, toRpm: 4800 },
    { pedalFraction: 0.33, fromRpm: 1800, toRpm: 4800 },
];
