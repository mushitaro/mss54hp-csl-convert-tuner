import { BinaryParser } from '@/lib/binary-engine/parser';
import { APP_CONFIG } from '@/config/constants';
import {
    EgtTables, gateOpen, interpCurve, interpMap2d, rfKorrAt, readEgtTables, tabgModelAt,
} from '@/lib/ve-calculator/egtTables';
import { VEMap } from '@/lib/types';
import { LiveMeasurement } from './types';

/**
 * A simulated drive, computed from the simulated DME's own binary.
 *
 * ## Why this is not four oscillators
 *
 * The mock used to hold ~800 rpm and ~2.5 % throttle with a little noise on top. That is enough to
 * rehearse the connection state machine, and it is enough to rehearse nothing else: every sample
 * lands in one cell of a 20x24 map, `rf_korr` never leaves 1.000 because the correction's gate needs
 * 55-80 %RF, and TABG is a free-running sine that has no relationship to what the engine is doing.
 * You cannot see the EGT correction work, because in that log it never works.
 *
 * ## What this does instead
 *
 * It reads the binary the mock is serving and produces telemetry that binary would actually cause:
 *
 *   rf_soll  = kf_rf_soll(rpm, aq_rel_rf)         the Alpha-N table, from the loaded bytes
 *   rf_korr  = KF_RF_KORR_DRREL(rpm, tabg_delta)  the correction, from the loaded bytes
 *   RF       = rf_soll x rf_korr                  what the DME publishes
 *
 * So when the app measures `rf_korr = RF / rf_soll` it gets back exactly what the binary says, and
 * the RF KORR tab has something real to recover. This is the same closed loop the car provides —
 * it just runs on the desk.
 *
 * ## The physics that makes tabg_delta move
 *
 * `tabg_delta` is `model(rpm, RF) - TABG`. The model jumps the instant load is applied; the exhaust
 * takes tens of seconds to catch up. So a roll-on from cruise produces a large delta that decays to
 * zero as the exhaust heats — which is not a scripted sweep, it is the reason the correction exists.
 * One held pull therefore yields the whole delta range AND, at its end, the warm-exhaust anchor the
 * back-calculation needs. See docs/ecu-logic/20-egt-correction.md §2.
 *
 * ## The answer it hides
 *
 * Two deliberate errors are baked in so a PRACTICE tune has a knowable right answer:
 *
 *   VE_ERROR_*        the Alpha-N table is a few percent low, varying with rpm and load
 *   DENSITY_TRUTH     the real density effect is 75 % of what KF_RF_KORR_DRREL claims
 *
 * A correct run should therefore drive the trim toward the VE error and pull the correction table
 * down toward 75 % of its excess — bounded by the per-run step limit, so it takes several passes.
 * If PRACTICE ever stops showing that, something in the chain has broken.
 *
 * ## What it does NOT model
 *
 * The MAP compensation branch (`k_rf_cfg` bit 4). The mock publishes the PATCH-ON load path,
 * `RF = rf_soll x rf_korr`, exactly. Modelling `rf_p_saug_i` would add a bounded ±2.5 %RF wobble
 * that teaches nothing here — and a log worth tuning from is taken with the patch on anyway.
 */

/** Peak-to-peak of the Alpha-N error, as a fraction. The table reads low by this much at worst. */
const VE_ERROR_BASE = 0.055;
const VE_ERROR_RPM_SWING = 0.025;
/** The real density effect, as a fraction of what the correction table claims. Under 1.0 means
 *  BMW's model over-enriches on this engine — the case §6.2 says one log cannot distinguish. */
const DENSITY_TRUTH = 0.75;
/**
 * Exhaust thermal time constants, seconds — heating and cooling, and they are NOT the same number.
 *
 * A symmetric lag does not work here, and the reason is the whole point of the drive. `tabg_delta`
 * only gets large when the exhaust is COLD relative to what the model expects at the new load, so
 * the coast between pulls has to actually cool it. With one 11 s constant the exhaust barely fell
 * during a 7 s lift and every pull after the first started from 500 °C — measured rf_korr peaked at
 * 1.17 instead of the 1.29 those tables can reach, and 78 % of the run came back as anchors.
 *
 * Asymmetry is also the physical answer: the mass flow carrying heat into the manifold under load
 * is several times what passes through it on a closed throttle, and the pipe sheds heat to ambient
 * either way.
 */
const TABG_TAU_HEAT_S = 14;
const TABG_TAU_COOL_S = 6;
/** The DME reports TABG at 16 °C per count. Quantising here means the app sees the same coarse
 *  channel it will see on the car, rather than a smooth curve that flatters the derived columns. */
const TABG_STEP = 16;

interface Segment {
    rpm: number;
    /** Throttle opening as the app's `Raw RO %` — NOT the Alpha-N axis. See `rawLoadFor`. */
    rawLoad: number;
    seconds: number;
    label: string;
}

/**
 * The drive. Idle, then a series of held pulls, each preceded by an overrun that cools the exhaust.
 *
 * Two throttle openings per rpm, always adjacent, because a grid cell needs samples from at least
 * two distinct VE cells before the tuner will write it — one anchor cannot become a table entry on
 * its own. Keeping the pair together is what lets a short run produce anything at all: 75 s covers
 * the first pair and yields 3 cells, the full 223 s cycle yields 22.
 *
 * The rpm points sit on KF_RF_KORR_DRREL's own axis so a sample lands in one column rather than
 * smearing across two.
 *
 * Ordered by what a pull can reach, not by where the correction peaks. Those are different
 * questions: the correction is largest at 2200 (1.325 at delta 400 against 1.045 at 1600), but the
 * delta a pull can actually reach is capped by how far the temperature model sits above a cooled
 * exhaust — and the model is hottest at 3000. So 3000 leads.
 */
const DRIVE: Segment[] = [
    // Idle sits under the app's own idle filter (`rawLoad <= 1.0 && rpm < 1000`) on purpose: it is
    // there so a PRACTICE run starts where a real one does, not so it reaches the tune.
    { rpm: 800, rawLoad: 0.8, seconds: 5, label: 'idle' },

    // The model runs to ~650 °C here against ~570 at 2200, so this is the pair that reaches the
    // top delta rows of KF_RF_KORR_DRREL at all — and it goes first so a short run reaches them.
    { rpm: 3000, rawLoad: 85, seconds: 26, label: 'pull 3000 / 85' },
    { rpm: 1200, rawLoad: 2, seconds: 14, label: 'overrun' },
    { rpm: 3000, rawLoad: 65, seconds: 26, label: 'pull 3000 / 65' },
    { rpm: 1200, rawLoad: 2, seconds: 14, label: 'overrun' },

    // 2200 is where the correction itself peaks (1.325 at delta 400 against 1.045 at 1600).
    { rpm: 2200, rawLoad: 85, seconds: 26, label: 'pull 2200 / 85' },
    { rpm: 1200, rawLoad: 2, seconds: 14, label: 'overrun' },
    { rpm: 2200, rawLoad: 65, seconds: 26, label: 'pull 2200 / 65' },
    { rpm: 1200, rawLoad: 2, seconds: 14, label: 'overrun' },

    // 1600 is the flat end of the correction. Included so the tab shows a column that barely moves
    // next to ones that do — "nothing happened here" is a result, and it should be visible.
    { rpm: 1600, rawLoad: 85, seconds: 22, label: 'pull 1600 / 85' },
    { rpm: 1200, rawLoad: 2, seconds: 14, label: 'overrun' },
    { rpm: 1600, rawLoad: 65, seconds: 22, label: 'pull 1600 / 65' },
];
const CYCLE_SECONDS = DRIVE.reduce((s, seg) => s + seg.seconds, 0);
/** Ramp between segments. Long enough that the transient filter drops the transition rather than
 *  the whole pull — which is what it would do on a real tip-in too. */
const RAMP_S = 1.6;

/** Deterministic value noise. `Math.random()` would make two PRACTICE runs incomparable, and the
 *  first thing anyone does with a rehearsal is run it twice. */
function wobble(t: number, phase: number): number {
    const x = Math.sin(t * 12.9898 + phase) * 43758.5453;
    return (x - Math.floor(x)) - 0.5;
}

const lerp = (a: number, b: number, w: number) => a + (b - a) * w;

/** The app's AQ_REL -> aq_rel_rf factor, applied as a divisor. See docs/ecu-logic 60 §2.4. */
function aqFactor(rpm: number): number {
    const t = APP_CONFIG.MSS54HP.INTERPOLATION_TABLE;
    return interpCurve(t.map(p => p.rpm), t.map(p => p.factor), rpm);
}

/** Bilinear on the VE table, matching VECalculator.interpolateMap's clamped-edge rule. */
function interpVe(map: VEMap, rpm: number, load: number): number {
    return interpMap2d(map.xAxis, map.yAxis, map.data, rpm, load);
}

/**
 * How wrong the Alpha-N table is here, as a multiplier the trim will have to make up.
 *
 * Exported, along with DENSITY_TRUTH, because the whole point of a rehearsal is that the answer is
 * knowable — and an answer only the mock can see is not knowable, it is just hidden. A check that
 * has to guess the expected range ends up asserting the guess: two of these were written against a
 * hand-listed set of operating points and failed on samples from the ramps and the overrun, where
 * the error runs to 1.080 rather than the 1.059 those points suggested. The code was right both
 * times.
 */
export function mockVeError(rpm: number, aqRelRf: number): number {
    return 1 + VE_ERROR_BASE + VE_ERROR_RPM_SWING * Math.sin(rpm / 700) - 0.0002 * aqRelRf;
}

/** The real density effect as a fraction of what KF_RF_KORR_DRREL claims. See DENSITY_TRUTH. */
export const MOCK_DENSITY_TRUTH = DENSITY_TRUTH;

/** The Alpha-N axis a given throttle opening lands on, so a check can reproduce the binning. */
export const mockAqRelRf = (rpm: number, rawLoad: number) => rawLoad / aqFactor(rpm);

export class MockDrive {
    private egt: EgtTables | null = null;
    private veMap: VEMap | null = null;
    /** Exhaust temperature, °C, carried between polls. This lag IS the feature being rehearsed. */
    private tabg = 210;
    private lastT = 0;
    /** The RF published last cycle. The DME feeds the previous cycle's RF to the temperature model,
     *  and so does this — otherwise RF and the model that consumes it are mutually defined. */
    private lastRf = 0.1;

    /**
     * Reads the tables out of the binary the mock is serving.
     *
     * Returns false when they are not there — an all-zero placeholder image, or any binary whose
     * bytes do not match what the catalog describes. The caller then falls back to the old idle
     * pattern rather than inventing numbers: a drive computed from tables that do not exist would
     * be a confident rehearsal of nothing.
     */
    load(buffer: ArrayBuffer): boolean {
        try {
            const egt = readEgtTables(buffer);
            if (!egt) return false;
            const veMap = new BinaryParser(buffer).getVETable();
            if (!veMap.data?.length) return false;
            this.egt = egt;
            this.veMap = veMap;
            return true;
        } catch {
            return false;
        }
    }

    get ready(): boolean {
        return this.egt !== null && this.veMap !== null;
    }

    /** Where in the drive `t` seconds falls, with the ramp between segments already applied. */
    private operatingPoint(t: number): { rpm: number; rawLoad: number } {
        const cycleT = ((t % CYCLE_SECONDS) + CYCLE_SECONDS) % CYCLE_SECONDS;
        let start = 0;
        for (let i = 0; i < DRIVE.length; i++) {
            const seg = DRIVE[i];
            if (cycleT < start + seg.seconds) {
                const into = cycleT - start;
                if (into >= RAMP_S) return { rpm: seg.rpm, rawLoad: seg.rawLoad };
                const prev = DRIVE[(i - 1 + DRIVE.length) % DRIVE.length];
                const w = into / RAMP_S;
                return { rpm: lerp(prev.rpm, seg.rpm, w), rawLoad: lerp(prev.rawLoad, seg.rawLoad, w) };
            }
            start += seg.seconds;
        }
        const last = DRIVE[DRIVE.length - 1];
        return { rpm: last.rpm, rawLoad: last.rawLoad };
    }

    /** The label of the segment `t` falls in. For the console, when a run looks wrong. */
    segmentAt(t: number): string {
        const cycleT = ((t % CYCLE_SECONDS) + CYCLE_SECONDS) % CYCLE_SECONDS;
        let start = 0;
        for (const seg of DRIVE) {
            if (cycleT < start + seg.seconds) return seg.label;
            start += seg.seconds;
        }
        return DRIVE[DRIVE.length - 1].label;
    }

    /**
     * One sample, `t` seconds into the run.
     *
     * Must be called in increasing `t` — the exhaust temperature is integrated, not evaluated.
     */
    sample(t: number): LiveMeasurement {
        if (!this.egt || !this.veMap) throw new Error('MockDrive has no tables loaded');
        const dt = Math.max(0, Math.min(1, t - this.lastT));
        this.lastT = t;

        const op = this.operatingPoint(t);
        const rpm = op.rpm + wobble(t, 1.7) * 6;
        const rawLoad = Math.max(0, op.rawLoad + wobble(t, 4.1) * 0.3);

        // The app divides by this factor to recover the Alpha-N axis, so the mock multiplies by it:
        // whatever cell this lands in is the cell the app will decide it landed in.
        const aqRelRf = rawLoad / aqFactor(rpm);
        const rfSoll = interpVe(this.veMap, rpm, aqRelRf);

        // Last cycle's RF drives the temperature model, exactly as the DME's task order does.
        const model = tabgModelAt(this.egt, rpm, this.lastRf);
        const tau = model > this.tabg ? TABG_TAU_HEAT_S : TABG_TAU_COOL_S;
        this.tabg += (model - this.tabg) * (1 - Math.exp(-dt / tau));

        const delta = Math.max(0, model - this.tabg);
        const open = gateOpen(this.egt, rpm, rfSoll);
        const kApplied = open ? rfKorrAt(this.egt, rpm, delta) : 1;

        const rf = rfSoll * kApplied;
        this.lastRf = rf;

        // The trim is what the closed loop must hold to reach lambda 1 given the two baked-in
        // errors. At the anchor (delta ~ 0, k = 1) it reduces to the VE error alone, which is what
        // makes the VE map converge on something knowable.
        const kTruth = 1 + DENSITY_TRUTH * (kApplied - 1);
        const stft = mockVeError(rpm, aqRelRf) * kTruth / kApplied;
        const split = wobble(t, 8.3) * 0.012;

        return {
            time: t,
            rpm: Math.max(0, rpm),
            rawLoad,
            stft1: stft + split,
            stft2: stft - split,
            // Warm from the start: a cold-start warm-up is its own rehearsal, and starting below the
            // 65 °C filter would throw away the first minute of every PRACTICE run.
            coolantTemp: 92 + wobble(t, 2.2) * 0.6,
            rf: rf * 100,
            exhaustTemp: Math.round(this.tabg / TABG_STEP) * TABG_STEP,
        };
    }
}

export const MOCK_DRIVE_CYCLE_SECONDS = CYCLE_SECONDS;
