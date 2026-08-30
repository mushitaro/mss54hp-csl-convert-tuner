/**
 * A closed-loop idle engine with a known feedforward error, for PRACTICE mode and for the
 * known-answer test.
 *
 * `mockDrive.ts` cannot serve here, for the same reason `inertia/bench.ts` says it could not serve
 * there: the drive is a scripted rpm/load trace with no rotational dynamics, so nothing in it
 * responds to a governor. An idle corrector measures what a controller was forced to do, which
 * means the rig has to contain a controller, a plant, and a disagreement between them.
 *
 * ## What is modelled, and what each piece is for
 *
 * `J dw/dt = M_air + M_gov - M_loss(w)`, integrated at 2 ms.
 *
 * `M_air` comes from the idle valve: the air the map asks for, PLUS a deliberate error, divided by
 * the true torque-per-airflow gain. That error is the answer the estimator has to find.
 *
 * `M_gov` is the LFR governor, and it is reproduced **asymmetrically on purpose**. The real
 * calibration evaluates `KL_LFR_DQP_POS` only when the engine is BELOW target, and `KL_LFR_TZ_NEG`
 * is sixteen zeros, so there is no fast authority at all on the overshoot side — the only way down
 * is the I term at `K_LFR_TAU_IA1` = 5.12 s. Reproducing that is what makes an over-correction
 * rehearse as a slow hunt rather than as a symmetric error, and an over-correction is the failure
 * this whole feature is biased against.
 *
 * `lfra_adapt` is modelled too, and defaults ON. It is the confound the estimator has to survive:
 * it drains the I term into `MD_LLRA` at 1.0 Nm per 3.0 s, so a warm settled engine reads
 * `md_llri` near its resting point whatever the feedforward error is. A bench without it would let
 * a broken estimator pass.
 *
 * ## What is NOT modelled
 *
 * Combustion, the throttle path, VANOS, and every transport lag. `M_air` appears instantly. The
 * consequence is that this rig cannot say anything about phase margin or about how a correction
 * changes the loop's stability — see the plan's open items. It answers one question: given a
 * feedforward that is wrong by a known amount, does the estimator recover that amount?
 */

/**
 * The feedforward error, kg/h, as an offset ON the map value.
 *
 * NEGATIVE means the engine actually receives less air than the map asks for, so the engine needs
 * MORE than the map delivers and the corrector must ADD. That is the safe direction to rehearse:
 * over-correcting upward is the failure mode this DME recovers from worst, so the default drive
 * exercises the direction a real campaign will spend most of its time in.
 */
export const MOCK_IDLE_QVS_ERROR_KGH = -1.6;

/**
 * The true torque-per-airflow gain, kg/h per Nm.
 *
 * Deliberately NOT `IDLE_GAIN_DEFAULT_KGH_PER_NM` (0.40). The tool starts from a low default on
 * purpose, so pass 1 must under-correct and the gain learner must have something to learn. A bench
 * that used the tool's own default would make the learner look right while testing nothing.
 */
export const MOCK_IDLE_GAIN_KGH_PER_NM = 0.52;

/** Whether `lfra_adapt` runs. On by default — see the header. */
export const MOCK_IDLE_ADAPT_ENABLED = true;

/** Warm idle target, rpm. `KL_LFR_NSOLL_GRUND` at 80 degC. */
const N_SOLL_WARM = 870;
/** Coolant the bench holds. Sits on KF_LLR_QVS_GRUND's y[4] breakpoint, which is where a dwell has
 *  to be for its evidence to bin onto the row that gets written. */
const TMOT_WARM = 85;
/** Crank inertia, kg m^2. A stock S54 dual-mass assembly; the absolute value only sets how fast the
 *  transients settle, and every gate in the estimator is about steady state. */
const J = 0.18;

const TASK_MS = 20;
const STEP_MS = 2;

/** `KL_LFR_DQP_POS`: 0..9 Nm, and evaluated ONLY when the engine is below target. */
const P_MAX_NM = 9;
const P_PER_RPM = 9 / 60;
/** `KL_LFR_TZ_POS`: saturates at 15 Nm by 30 rpm of error. No negative counterpart exists. */
const TZ_MAX_NM = 15;
const TZ_PER_RPM = 15 / 30;
/** `KF_LFR_DQI`, as a single rate. Nm per second per rpm of error. */
const I_PER_RPM_PER_S = 0.06;

/** `K_LFR_DMDADAPT_MAX` / `K_LFR_T_ADAPT` / `K_LFR_TMOT_ADAPT`. */
const ADAPT_STEP_NM = 1.0;
const ADAPT_PERIOD_S = 3.0;
const ADAPT_TMOT_MIN = 70;
/** `K_LFR_MDADAPT_OFFSET`. The bench reproduces the sign convention the real thing has: adaptation
 *  integrates `md_llri + offset` toward zero, so it parks the I term at MINUS the offset. */
const ADAPT_OFFSET_NM = 7.0;

/** `K_LFR_MD_REG_MIN` / `_MAX`, the outer pair. */
const I_MIN_NM = -80;
const I_MAX_NM = 120;

export interface IdleBenchOptions {
    /** The air the map asks for at this operating point, kg/h. Defaults to the stock warm cell so
     *  the bench runs standalone; the mock link and the practice script pass the real lookup, which
     *  is what makes the assertion "it converged on the value in THIS binary" mean something. */
    qvsAt?: (rpm: number, tmot: number) => number;
    /**
     * The map value the engine's PHYSICAL loss is anchored to, kg/h. Defaults to the current map,
     * which is right for a standalone bench and wrong for an iteration: an engine's friction does
     * not change when its ECU is rewritten. Without this the loss moved with every pass, the
     * equilibrium moved with it, and the measured error sat at exactly 3.07 Nm forever while the
     * correction climbed — a loop that looked like it was working and was chasing its own tail.
     */
    lossAnchorKgH?: number;
    errorKgH?: number;
    gainKgHPerNm?: number;
    adaptEnabled?: boolean;
}

/** One segment of the scripted session. */
interface Segment {
    kind: 'idle' | 'rev' | 'ac' | 'load';
    seconds: number;
}

/**
 * The default session: three idle dwells long enough to satisfy `minCellDwells` with one spare,
 * separated by revs, then a compressor cycle and an electrical load so the exclusion gates have
 * something real to exclude.
 *
 * 90 s dwells rather than the 20 s minimum: the estimator needs the dwell to be steady for its
 * whole length, and a rig that only just clears the gate cannot show the difference between a gate
 * that works and one that never fires.
 */
const DEFAULT_SCRIPT: Segment[] = [
    { kind: 'idle', seconds: 90 },
    { kind: 'rev', seconds: 30 },
    { kind: 'idle', seconds: 90 },
    { kind: 'rev', seconds: 30 },
    { kind: 'idle', seconds: 90 },
    { kind: 'ac', seconds: 40 },
    { kind: 'idle', seconds: 60 },
    { kind: 'load', seconds: 30 },
    { kind: 'idle', seconds: 60 },
];

export const MOCK_IDLE_CYCLE_SECONDS = DEFAULT_SCRIPT.reduce((a, s) => a + s.seconds, 0);

/** What the bench reports at one instant — the raw physical quantities, before any DS2 encoding. */
export interface IdleBenchReading {
    rpm: number;
    nSoll: number;
    tmot: number;
    wdk1: number;
    mdLlri: number;
    mdLlra: number;
    mdLlraKo: number;
    /** The air the map asked for, kg/h — what LLR_QVS reads. NOT what the engine received. */
    llrQvs: number;
    llsTv: number;
    /** `LLS_ST`. Bit 7 is the idle-valve diagnosis latch, and this rig models a healthy valve, so
     *  it stays clear — meaning `ti_load_factor` reads KF_TI_N_RF, not the 0.859 curve. */
    llsSt: number;
    ub: number;
    /** `ZUSTAND_MOTOR`: 4 = LL, 8 = TL. */
    engineState: number;
    /** `KKOS_ST` bit 0. */
    kkosSt: number;

    // --- The section 7.1 preconditions, simulated -----------------------------------------------
    //
    // Simulated HEALTHY at idle, and that is a real limitation to state rather than a feature: this
    // rig can show the preflight passing, and it can show it failing during the scripted rev
    // segments, but it cannot say anything about whether the CAR passes. The whole reason section
    // 7.1 exists is that neither binary image contains the answer — so neither does a simulator
    // built from those images. PRACTICE exercises the panel; only the car answers the question.

    /** `LFR_ZUSTAND`, one-hot. 2 is the settled idle regulator. */
    lfrZustand: number;
    /** `WDK_WORD` / `WDK_SOLL`, %. The precondition is their difference. */
    wdkWord: number;
    wdkSoll: number;
    egasSoll: number;
    egasMaxWdk: number;
    /** `ML_SOLL` and the ceiling it is compared against, kg/h. */
    mlSoll: number;
    mlSollLls: number;
    mlSollMaxLls: number;
    /** The LFR integrators before the shift, and the other two integrators on the same actuator. */
    lfrMdi: number;
    lfrIAfr: number;
    frRegler: number;
    fraMlAdaption: number;
}

export class MockIdleBench {
    private readonly qvsAt: (rpm: number, tmot: number) => number;
    private readonly errorKgH: number;
    private readonly gain: number;
    private readonly adaptEnabled: boolean;
    private readonly lossAnchorKgH: number | null;

    private rpm = N_SOLL_WARM;
    private mdi = 0;
    private mdLlra = 0;
    private mdLlraKo = 0;
    private simulatedS = 0;
    private taskAccumMs = 0;
    private adaptAccumS = 0;
    /** Set on the first integration step so the plant starts in equilibrium for a CORRECT map, and
     *  the only thing pushing it away is the injected error. Derived rather than tuned: anything
     *  else would let the bench pass or fail for a reason that is not the error under test. */
    private lossAtIdle: number | null = null;

    constructor(opts: IdleBenchOptions = {}) {
        this.qvsAt = opts.qvsAt ?? (() => 14.0);
        this.errorKgH = opts.errorKgH ?? MOCK_IDLE_QVS_ERROR_KGH;
        this.gain = opts.gainKgHPerNm ?? MOCK_IDLE_GAIN_KGH_PER_NM;
        this.adaptEnabled = opts.adaptEnabled ?? MOCK_IDLE_ADAPT_ENABLED;
        this.lossAnchorKgH = opts.lossAnchorKgH ?? null;
    }

    /** Which segment the script is in at `t` seconds, and how far into it. */
    private segmentAt(t: number): Segment {
        let acc = 0;
        const cycle = t % MOCK_IDLE_CYCLE_SECONDS;
        for (const s of DEFAULT_SCRIPT) {
            acc += s.seconds;
            if (cycle < acc) return s;
        }
        return DEFAULT_SCRIPT[DEFAULT_SCRIPT.length - 1];
    }

    /** Friction plus accessories, Nm. Anchored so that a CORRECT map sits in equilibrium with the
     *  I term at exactly its designed resting point, and mildly speed-dependent above that. */
    private loss(rpm: number): number {
        if (this.lossAtIdle === null) {
            const anchor = this.lossAnchorKgH ?? this.qvsAt(N_SOLL_WARM, TMOT_WARM);
            const airNm = anchor / this.gain;
            this.lossAtIdle = airNm - ADAPT_OFFSET_NM;
        }
        // Square law, and the exponent is load-bearing rather than decorative. With a linear loss
        // the closed loop damps at zeta ~= 0.14 and rings for tens of seconds, because the I term
        // is the only thing acting above target — so the rig never settles inside the +/-25 rpm the
        // estimator calls steady, and every dwell fragments. A real engine damps harder than
        // linear: pumping and friction rise with speed and the accessory load rises faster. The
        // square is a stand-in for all of that, chosen because it puts zeta near 0.7, and it is
        // exact at the idle point so the equilibrium above is untouched.
        return this.lossAtIdle * Math.pow(rpm / N_SOLL_WARM, 2);
    }

    /** Advance the plant to `t` seconds. Idempotent for a `t` already passed. */
    private advanceTo(t: number): void {
        while (this.simulatedS < t) {
            const seg = this.segmentAt(this.simulatedS);
            const dt = STEP_MS / 1000;

            // --- the governor, at its own 20 ms task rate -------------------------------------
            //
            // Gated on being in idle at all, which is what `lfr_calc`'s own state machine does:
            // outside B_LFR the governor is not controlling, so its integrator does not wind. Not
            // modelling that made a 30 s rev slam the I term into K_LFR_MD_REG_MIN and left the
            // following minute of idle unwinding it, which the adaptation then chased — a
            // 13 Nm excursion in md_llra that no real car performs, rejecting every dwell for a
            // disturbance the rig had invented.
            const governing = seg.kind !== 'rev';
            this.taskAccumMs += STEP_MS;
            if (governing && this.taskAccumMs >= TASK_MS) {
                this.taskAccumMs -= TASK_MS;
                const dn = N_SOLL_WARM - this.rpm;
                // Integrator: the one branch that acts in both directions, and slowly.
                this.mdi = Math.min(I_MAX_NM, Math.max(I_MIN_NM,
                    this.mdi + dn * I_PER_RPM_PER_S * (TASK_MS / 1000)));

                if (this.adaptEnabled && TMOT_WARM > ADAPT_TMOT_MIN) {
                    this.adaptAccumS += TASK_MS / 1000;
                    if (this.adaptAccumS >= ADAPT_PERIOD_S) {
                        this.adaptAccumS -= ADAPT_PERIOD_S;
                        // Integrates md_llri + offset toward zero, taking what it moves OUT of the
                        // I term. This is the whole confound: the information does not vanish, it
                        // migrates, which is why the estimator's statistic is the SUM.
                        const want = this.mdi + ADAPT_OFFSET_NM;
                        const move = Math.sign(want) * Math.min(ADAPT_STEP_NM, Math.abs(want));
                        if (seg.kind === 'ac') this.mdLlraKo += move; else this.mdLlra += move;
                        this.mdi -= move;
                    }
                }
            }

            const dn = N_SOLL_WARM - this.rpm;
            // P and ignition: positive side only, and only while governing. This asymmetry is the
            // point — there is no counterpart on the overshoot side in the real calibration.
            const p = governing && dn > 0 ? Math.min(P_MAX_NM, dn * P_PER_RPM) : 0;
            const tz = governing && dn >= 1 ? Math.min(TZ_MAX_NM, dn * TZ_PER_RPM) : 0;

            const airKgH = this.qvsAt(this.rpm, TMOT_WARM) + this.errorKgH;
            let mAir = airKgH / this.gain;
            // A rev is the driver's foot, not the governor's doing: extra torque straight into the
            // plant, and the LL bit drops out. Every gate that keys off idle has to see this leave.
            if (seg.kind === 'rev') mAir += 40;
            // The compressor is a load step; an electrical load is a smaller one, and it also moves
            // the terminal voltage, which is the only trace of it any channel carries.
            const extraLoad = seg.kind === 'ac' ? 12 : seg.kind === 'load' ? 4 : 0;

            // MD_LLRA is in the sum, and it has to be. In the real DME the adaptation does not
            // destroy torque, it MOVES it out of the I term and into a slower store that still
            // reaches the plant — which is precisely why md_llri + md_llra is invariant and why the
            // estimator measures the sum. A bench that drained the I term without putting the
            // torque back would make adaptation a leak: rpm would sag, the I term would wind back
            // up, and the loop would fight itself forever instead of settling.
            // Only the ACTIVE adaptation integrator reaches the plant, selected the way lfra_adapt
            // selects it. Applying both at once broke the conservation this whole measurement rests
            // on: torque moved into the compressor-ON store during an A/C cycle stayed applied
            // after the compressor left, so md_llri + md_llra was no longer invariant and every
            // post-A/C dwell reported an error that was really an artefact of the rig.
            const adaptApplied = seg.kind === 'ac' ? this.mdLlraKo : this.mdLlra;
            const net = mAir + this.mdi + adaptApplied + p + tz - this.loss(this.rpm) - extraLoad;
            // w = rpm * 2pi/60; dn/dt = (60/2pi) * M/J
            this.rpm = Math.max(200, this.rpm + (60 / (2 * Math.PI)) * (net / J) * dt);
            this.simulatedS += dt;
        }
    }

    read(t: number): IdleBenchReading {
        this.advanceTo(t);
        const seg = this.segmentAt(t);
        const qvs = this.qvsAt(this.rpm, TMOT_WARM);
        return {
            rpm: this.rpm,
            nSoll: N_SOLL_WARM,
            tmot: TMOT_WARM,
            wdk1: seg.kind === 'rev' ? 6.5 : 0.4,
            mdLlri: this.mdi,
            mdLlra: this.mdLlra,
            mdLlraKo: this.mdLlraKo,
            llrQvs: qvs,
            // Straight off the actuator map's own shape near the operating point: ~2.35 %/(kg/h)
            // through 14 kg/h -> ~21 %. Enough for the rail tests to have something to not hit.
            llsTv: Math.min(97, Math.max(14, 21 + (qvs - 14) * 2.35)),
            llsSt: 0x01,   // bit 0 only: lls_tv_init's value, no diagnosis latched
            ub: seg.kind === 'load' ? 13.0 : 14.1,
            engineState: seg.kind === 'rev' ? 8 : 4,
            kkosSt: seg.kind === 'ac' ? 1 : 0,

            // State 2 only while actually idling. During the rev segments the governor leaves it,
            // which is exactly the condition the preflight refuses on — so PRACTICE shows the panel
            // going red and coming back rather than only ever showing green.
            lfrZustand: seg.kind === 'rev' ? 4 : 2,
            // The plate is commanded shut at idle and the actual angle sits at its learned rest
            // position. 0.4 % against a commanded 0.0 is inside the 1.0 % gate, deliberately: a rig
            // that put it outside would make every simulated run refuse.
            wdkSoll: seg.kind === 'rev' ? 6.2 : 0.0,
            wdkWord: seg.kind === 'rev' ? 6.5 : 0.4,
            egasSoll: seg.kind === 'rev' ? 6.2 : 0.0,
            // KF_EGAS_MAX_WDK is 100.0 % in every cell and the code clamps to 1000 anyway.
            egasMaxWdk: 100.0,

            // ML_SOLL is the air demand in the DME's own currency; the bench works in kg/h, so this
            // is the same number. The ceiling comes from KL_LFR_SOLL_MAX_LLS, ~34 kg/h at 600 rpm —
            // far above idle demand, which is why the valve carries everything.
            mlSoll: qvs,
            mlSollLls: Math.min(qvs, 34),
            mlSollMaxLls: 34,

            // MD_LLRI = (LFR_I_AFR >> 4) + (LFR_MDI >> 4). The bench has one integrator, so it is
            // all in LFR_MDI and LFR_I_AFR stays empty — which is itself a thing the panel can show
            // and the car may contradict.
            lfrMdi: this.mdi,
            lfrIAfr: 0,
            frRegler: 1.0,
            fraMlAdaption: 0,
        };
    }
}
