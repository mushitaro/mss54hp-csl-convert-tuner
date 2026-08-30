/**
 * A stationary-neutral engine, simulated, with a known inertia.
 *
 * This exists because the inertia estimator has no other way to be checked. On a car the true J is
 * exactly the unknown being measured, so a plausible-looking answer and a correct one are
 * indistinguishable; here the answer is chosen in advance and the estimator either recovers it or
 * does not. `mockDrive.ts` cannot serve — it is a scripted rpm/load cycle with no rotational
 * dynamics and no torque model, so its samples have no relationship between torque and gradient for
 * a regression to find.
 *
 * The simulation is deliberately not a good engine model. It is a good *channel* model: what
 * matters for testing the estimator is that the sample carries the channels the car carries, at the
 * quantisation the car delivers them at, and no others.
 *
 * ## A fixture must not share the code's mistakes
 *
 * The previous version of this file encoded the DME's `d_n40` truncation so that the correction in
 * `gradient.ts` was tested against the thing it claimed to correct. That was the right instinct and
 * it still failed, twice over, for a reason worth keeping written down:
 *
 * - It hardcoded `engineState: 2` and `saWeSt: 1` — the same two wrong values the estimator's gates
 *   were written against. Forty-one checks passed over a workflow that could not have accepted a
 *   single real sample, because the fixture agreed with the bug.
 * - All of it was moot: the channels it modelled come from DS2 selection 83, which is a latched
 *   fault freeze-frame and never updates on a healthy car. The bench was a faithful simulation of a
 *   telegram the estimator would never receive.
 *
 * So this version models only what `pollInertiaSample` actually returns, and the sweeps below now
 * include the release as well as the pull — because the release is where the regression gets the
 * other end of its line.
 */

import type { InertiaSample } from '../dme-link/types';

export interface BenchOptions {
    /** The inertia the estimator is supposed to recover, Nms^2. */
    j: number;
    /** Sample interval, seconds. ~0.19 is the rate two telegrams reach at 9600 baud. */
    sampleIntervalS: number;
    /** Integration step, seconds. Much smaller than the sample interval so the plant is not itself
     *  a quantisation artefact. */
    stepS: number;
    /** Peak-to-peak noise added to the modelled torque before quantisation, Nm. */
    torqueNoiseNm: number;
    /** Coolant temperature the simulated engine reports, °C. Above the estimator's gate. */
    coolantTempC: number;
    /** Deterministic seed, so a failing case is reproducible. */
    seed: number;
}

export const DEFAULT_BENCH: BenchOptions = {
    j: 0.2100,
    // Measured expectation for selection 3 (44 bytes on the wire) plus a 49-byte RAM read, at the
    // ~45 ms per-exchange overhead this link shows at 9600. Deliberately pessimistic: if the
    // estimator only works at a rate the car cannot reach, the bench should say so.
    sampleIntervalS: 0.19,
    stepS: 0.002,
    torqueNoiseNm: 1.5,
    coolantTempC: 92,
    seed: 12345,
};

/**
 * Loss torque: friction plus pumping, Nm, rising with speed.
 *
 * Shaped to land where an S54 actually motors. Raised from the original curve (22 Nm at 2000,
 * 40 at 5000) after the free-deceleration rate was measured on the car at 2200-2400 rpm/s, which at
 * J ~ 0.22 implies ~50 Nm rather than ~30 — the original shape was a guess and the car disagreed
 * with it. Now ~35 Nm at 2000 and ~62 at 5000.
 */
export function benchLossTorque(rpm: number): number {
    return 20 + 0.0060 * rpm + 4.8e-7 * rpm * rpm;
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
 * `n` from selection 3 is an unsigned 16-bit count at 1 rpm. Rounding, because that is what a
 * counter does — and the whole reason this channel replaced `n40` is that it has nothing else
 * happening to it.
 */
export function encodeRpm(rpm: number): number {
    return Math.max(0, Math.min(65535, Math.round(rpm)));
}

/** `md_ind_ne` is uint16 x 0.1 Nm, and **unsigned** — so it floors at zero rather than going
 *  negative on the overrun. Reproduced, because the estimator's zero-torque anchor depends on it. */
export function encodeTorqueNm(nm: number): number {
    return Math.max(0, Math.round(nm * 10)) / 10;
}

/** One leg of the procedure: a pull to `toRpm` at a pedal fraction, then a release back to `fromRpm`. */
export interface BenchSweep {
    pedalFraction: number;
    fromRpm: number;
    toRpm: number;
}

/**
 * Runs the procedure and returns the samples the link would have produced.
 *
 * Each sweep is a pull **and** a release. The release is not decoration: it is emitted with zero
 * indicated torque and a shut throttle, which is both the free-deceleration cross-check's input and
 * the far end of every rpm bin's regression line. A bench that only pulled would let an estimator
 * pass that could never separate slope from intercept on a real run.
 */
export function runBench(
    sweeps: readonly BenchSweep[],
    options: Partial<BenchOptions> = {},
): InertiaSample[] {
    const opts: BenchOptions = { ...DEFAULT_BENCH, ...options };
    const rand = rng(opts.seed);
    const out: InertiaSample[] = [];
    let t = 0;

    const emit = (rpm: number, torqueNm: number, throttleOpen: boolean) => {
        out.push({
            time: t,
            rpm: encodeRpm(rpm),
            coolantTemp: opts.coolantTempC,
            wdk1: throttleOpen ? 12 : 0,
            rf: throttleOpen ? 45 : 12,
            mdIndNe: encodeTorqueNm(torqueNm),
            // Zero throughout: the limiters are bypassed below K_MD_DF_VMIN and this bench is
            // stationary. A non-zero value here would be modelling a car that was moving.
            mdDynSt: 0,
        });
    };

    const integrate = (
        startRpm: number,
        stopWhen: (rpm: number) => boolean,
        torqueAt: (rpm: number) => number,
        throttleOpen: boolean,
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
                emit(rpm, Math.max(0, mInd + (mInd > 0 ? noise : 0)), throttleOpen);
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
            true,
            30,
        );
        // The release. Zero combustion torque, throttle shut, all the way back down — this is the
        // overrun the driver is asked not to catch.
        integrate(sweep.toRpm, rpm => rpm <= sweep.fromRpm, () => 0, false, 30);
        // A beat at the bottom, so consecutive sweeps do not run together.
        t += 0.5;
    }

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
    private readonly samples: InertiaSample[];
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
    sample(t: number): InertiaSample {
        const cycle = this.cycleSeconds;
        const into = cycle > 0 ? ((t % cycle) + cycle) % cycle : 0;
        // Linear scan is fine: a pass is a few hundred samples and this is called at ~5 Hz.
        let index = 0;
        while (index + 1 < this.samples.length && this.samples[index + 1].time <= into) index++;
        // Restamped with the caller's clock — the estimator measures the sample interval from these
        // timestamps, so handing back the recording's own would report the recording's rate rather
        // than the rate this link is achieving.
        return { ...this.samples[index], time: t };
    }
}

/**
 * The procedure the InertiaPanel asks the driver to perform.
 *
 * Six pull-and-release cycles at four pedal openings, 2000 to 5000 rpm. The pedal spread is what
 * gives each rpm bin two well-separated torques; without it the fit cannot tell a slope from an
 * intercept no matter how many samples it has.
 */
export const STANDARD_BENCH_SWEEPS: readonly BenchSweep[] = [
    { pedalFraction: 0.15, fromRpm: 2000, toRpm: 5000 },
    { pedalFraction: 0.25, fromRpm: 2000, toRpm: 5000 },
    { pedalFraction: 0.35, fromRpm: 2000, toRpm: 5000 },
    { pedalFraction: 0.20, fromRpm: 2000, toRpm: 5000 },
    { pedalFraction: 0.30, fromRpm: 2000, toRpm: 5000 },
    { pedalFraction: 0.40, fromRpm: 2000, toRpm: 5000 },
];
