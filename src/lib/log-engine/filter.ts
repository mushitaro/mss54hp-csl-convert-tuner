import type { LogDataPoint, ProcessedLog, LogFilterConfig, InterpolationPoint } from '@/lib/types';
import { APP_CONFIG } from '@/config/constants';
import {
    type LambdaLimits, type DropCensus, type DropReason, EMPTY_CENSUS,
    isFullLoad, isOverLoadThreshold, isAtControllerStop, isNearControllerClamp, isFuelCut,
} from './lambdaGates';
import {
    stepHighLoadClock, heldSeconds, type HighLoadClock,
} from './highLoadClock';

/**
 * What one pass over a log leaves behind, so the next pass can continue instead of starting again.
 *
 * Held by the caller and handed back — this module stays a pure function of (log, config, state),
 * which is what lets the batch path keep calling it with no state at all and get the answer it
 * always got.
 */
/**
 * Filling above which the high-load settle clock runs, %RF.
 *
 * 55 is the lowest node of `kl_rf_korr_rf_min` — the floor above which the DME's EGT correction can
 * engage at any rpm. Below it `rf_korr` is pinned at 1.000 and there is no step for the trim to
 * chase, so the settle question does not arise.
 */
export { HIGH_LOAD_SETTLE_RF_MIN } from './highLoadClock';

/* HIGH_LOAD_RESTEP_RF / HIGH_LOAD_REF_PERIOD_S moved to highLoadClock.ts, beside the state
   machine that uses them and the live readout that now shares it. */

export interface FilterResume {
    /** Raw samples already accounted for. The next call starts here. */
    consumed: number;
    /**
     * Which log this state describes, so it can never be resumed onto a different one.
     *
     * `consumed` alone is not enough and the failure is silent. Open a saved 900-sample log, start a
     * run: the new run's first flush hands in 5 raw samples and a resume that has "already accounted
     * for" 900 of them — the length check (`raw.length >= consumed`) fails and it happens to fall
     * back to a full pass. Now open a 3-sample log instead and the check PASSES, so the loop starts
     * at index 900 of a 3-element array, keeps the previous log's 900 filtered samples, and produces
     * a VE map built from two different drives with no sign that anything happened.
     *
     * Set by the caller to anything that identifies the log; compared for equality only.
     */
    logId: string;
    validData: LogDataPoint[];
    rfKorrData: LogDataPoint[];
    droppedCount: number;
    census: DropCensus;
    /** The cat-protection arming time — see where it is used. */
    lastKatsHotTime: number;
    /**
     * When the filling last rose above `HIGH_LOAD_SETTLE_RF_MIN`, or null while below it.
     *
     * Carried for the same reason `lastKatsHotTime` is: it depends on samples before the current
     * one, and a live flush landing mid-pull must not restart the settle clock — that would keep
     * early-pull samples a batch pass would have dropped, and `verify:settle` holds the two paths
     * to byte-identical output across exactly that boundary.
     */
    highLoadEnteredAt: number | null;
    /** The restep reference — where the filling stood up to ~2x HIGH_LOAD_REF_PERIOD_S ago — so a
     *  flush landing mid-stab cannot forget the level the stab rose from. Null below the floor. */
    highLoadRefTime: number | null;
    highLoadRefRf: number | null;
}

/**
 * The sample at least `settleSec` before `i`, or null if the log does not reach back that far.
 *
 * Walking backwards, the span grows, so the first sample that satisfies it is the nearest one that
 * is far enough — the least overshoot available. Never less than asked: undershooting would compare
 * against a sample the lambda trim had not finished moving away from, which is the whole thing being
 * avoided.
 *
 * Null at the start of a log is the same exemption the index-based path has: with nothing far enough
 * back there is no comparison to make, so the sample is kept. Those are the first couple of seconds
 * of a drive, which the temperature and idle gates have usually taken already.
 *
 * Linear, and deliberately not a two-pointer: `i` restarts at `resume.consumed` on every flush, so a
 * pointer carried across calls would have to be part of FilterResume to stay correct. The scan is
 * bounded by the window — about six samples at 3 Hz — and stops the moment the span is met.
 */
function findSettleReference(
    raw: LogDataPoint[], i: number, settleSec: number, secondsPerTimeUnit: number,
): LogDataPoint | null {
    const now = raw[i].time;
    for (let j = i - 1; j >= 0; j--) {
        if ((now - raw[j].time) * secondsPerTimeUnit >= settleSec) return raw[j];
    }
    return null;
}

/**
 * Has the operating point moved between `ref` and `now`?
 *
 * The whole of the transient test, and it is called TWICE with two different references — see the
 * two call sites. Pulled out of the loop when the settle moved to the rf_korr stream, because the
 * alternative was the same eight lines written twice and drifting apart at the first edit.
 *
 * `ref === null` is "there is nothing far enough back to compare against", which is the start of a
 * log, and it passes: the exemption the index path has always had.
 */
function isOperatingPointSteady(
    now: LogDataPoint, ref: LogDataPoint | null, cfg: LogFilterConfig,
): boolean {
    if (!ref) return true;
    // RPM Stability Check (Relative %)
    //
    // Guarded, because `ref.rpm` can be 0 — the idle filter is optional and a log may legitimately
    // start at a standstill. 0 made this NaN, and `NaN > threshold` is false, so the sample PASSED:
    // an engine going from stopped to 3000 rpm read as perfectly steady, and every sample of the
    // crank-up went into the map as steady-state evidence.
    const rpmDiffPct = ref.rpm > 0
        ? Math.abs((now.rpm - ref.rpm) / ref.rpm) * 100
        : (now.rpm > 0 ? Infinity : 0);
    if (rpmDiffPct > cfg.rpmStableThreshold) return false;
    // TPS Stability Check (Absolute Delta)
    return Math.abs(now.rawLoad - ref.rawLoad) <= cfg.tpsStableThreshold;
}

export const processLogData = (
    rawData: LogDataPoint[],
    fileName: string,
    config?: LogFilterConfig,
    customTable?: InterpolationPoint[],
    /**
     * The lambda-controller shutdown thresholds, read from the binary this log was captured
     * against. Optional, and absent means those gates simply do not run — a CSV from another tool
     * has no binary to read them from, and inventing thresholds would reject real samples for a
     * reason that came from nowhere.
     */
    lambdaLimits?: LambdaLimits | null,
    /**
     * Everything a previous call over the same log already worked out, so this one can start where
     * that one stopped.
     *
     * This is the whole of the incremental path, and it is a resume rather than a rewrite on
     * purpose. The loop below is unchanged, the rules are unchanged, and a resumed call visits
     * exactly the samples a fresh call would visit after the prefix — so "incremental agrees with
     * batch" is true by construction rather than by a second implementation being kept in step.
     * `verify:incremental` still checks it against a real drive, because "by construction" is a
     * claim and claims get tested.
     *
     * `rawData` must be the FULL log either way, not just the new tail: the transient test looks
     * back `transientWindow` samples INCLUDING ones earlier filters dropped, so the prefix has to
     * still be addressable even though it is not re-examined.
     */
    resume?: FilterResume,
): ProcessedLog => {
    // The log this pass is about. `fileName` is what every caller already uses to mean "which log",
    // and a live run keeps one name for its whole life, so it identifies exactly what `logId` has to
    // identify: an append that is a continuation, versus one that is a different log.
    const logId = fileName;
    // Reused, not copied. A live run appends to these arrays across hundreds of flushes and copying
    // them each time would put back the O(n) this exists to remove — so the caller gets the same
    // array objects it had last time, wrapped in a fresh ProcessedLog. Anything memoising on the
    // ARRAY identity would therefore miss an update; everything here keys on the wrapper.
    const validData: LogDataPoint[] = resume?.validData ?? [];
    // Same prerequisites as validData, but WITHOUT the transient test. See ProcessedLog.rfKorrData
    // for why the rf_korr table needs its own sample set, and rfKorrTuner for what it does with it.
    const rfKorrData: LogDataPoint[] = resume?.rfKorrData ?? [];
    /**
     * validData UNION the samples the idle gate dropped.
     *
     * A third set rather than a relaxed gate, using the same mechanism `rfKorrData` already
     * established: one filter pass, several audiences. The VE map genuinely needs the idle rows
     * gone -- at the lowest filling KF_TI_N_RF enriches by 15-30 %% and the trim falls to cancel
     * it -- so relaxing the gate would corrupt the map. Keeping them in a separate set is what
     * lets the low-load corrector divide that enrichment out instead of inheriting the problem.
     */
    let droppedCount = resume?.droppedCount ?? 0;
    /**
     * Not just how many samples were dropped, but why.
     *
     * A bare "751 of 1600" is the least actionable number in the app: it says half the drive was
     * thrown away and gives no hint whether the fix is to warm the engine up, hold a steadier
     * throttle, or write the tank-vent patch and go again. Each reason is separately fixable, and
     * counting them apart is the whole point — the census is what turns a filtered log into an
     * instruction for the next run.
     */
    const census: DropCensus = resume?.census ?? { ...EMPTY_CENSUS };
    const drop = (reason: DropReason) => { droppedCount++; census[reason]++; };

    // Use provided config or defaults
    const cfg: LogFilterConfig = config || {
        enableCorrection: true,
        enableMinTemp: true,
        minTemp: 65,
        enableTransient: true,
        transientWindow: 4,
        rpmStableThreshold: 10,
        tpsStableThreshold: 5,
    };

    // Helper: Get data point at index safely
    const getAt = (idx: number) => (idx >= 0 && idx < rawData.length) ? rawData[idx] : null;

    /**
     * The transient look-back as a DURATION, when the config states one.
     *
     * Converting seconds to a sample count was tried first and is wrong, because the count would
     * have to come from the log's measured rate — and a live flush has seen less of the log than a
     * batch pass, so it measures a different rate and converts to a different count. On a rate that
     * ramps 0.20 s to 0.40 s across a drive, `verify:incremental` caught it immediately: 37 valid
     * samples live against 41 batch. The live path has no full reprocess afterwards, so the map on
     * screen at STOP is the one that gets saved — a divergence there is not cosmetic.
     *
     * Walking back over TIME removes the rate from the question entirely. Timestamps are the same in
     * a prefix as in the whole log, so both paths look back to the same sample by construction, and
     * the wait is the duration the DME actually needs rather than a count that happens to mean that
     * duration at one link speed.
     *
     * Absent means an older session: it keeps the exact sample count it was built with. See
     * resolveTransientWindow, which is the same rule stated for the UI.
     */
    const settleSec = cfg.transientSettleSec;

    // --- Cat-protection (open-loop) exclusion setup ---------------------------------------------
    // `time` is NOT one unit across sources: the live DS2 logger emits seconds
    // ((performance.now() - startTime) / 1000) while a Testo CSV's first column is milliseconds.
    // Discriminate on the median sample interval rather than on total span — live polling runs at
    // ~6-7 Hz (delta ~0.15) and a Testo log at ~150-250 (ms), which is a 30x separation that holds
    // for a log of any length. Guessing wrong here would either disable the exclusion or swallow
    // the whole log, so it is worth measuring.
    const secondsPerTimeUnit = timeScaleSeconds(rawData);

    /**
     * The high-load settle, seconds. Absent means an older session's config: off, so an archived
     * session reproduces the map it recorded — the same rule transientSettleSec follows above.
     * DEFAULT_FILTER_CONFIG carries the measured default for every new session.
     */
    /** Stretches the operator took out. Absent = the whole drive, which is every older session. */
    const excluded = cfg.excludeTimeRanges ?? [];

    const highLoadSettleSec = cfg.highLoadSettleSec ?? 0;
    // ONE clock, shared with the live readout — see highLoadClock.ts for why that matters.
    // The resume fields keep their own names and shape: a stored resume has to replay identically,
    // and `verify:incremental` compares them field by field.
    let highLoad: HighLoadClock = {
        enteredAt: resume?.highLoadEnteredAt ?? null,
        refTime: resume?.highLoadRefTime ?? null,
        refRf: resume?.highLoadRefRf ?? null,
    };

    const katsOn = cfg.katsTabgOn ?? 850;
    // Derived from katsOn rather than fixed at 840, and clamped below it. The stock calibration
    // puts K_TI_KATS_TABG_AUS 10 °C under K_TI_KATS_TABG_EIN, and that ordering has to survive the
    // user dragging the threshold: an "off" above the "on" would make the release condition arm
    // the filter, which is the opposite of what the control says it does.
    const katsOff = Math.min(cfg.katsTabgOff ?? (katsOn - 10), katsOn);
    const katsTail = cfg.katsTailSec ?? 20;
    const katsExclusionOn = (cfg.enableOpenLoopExclusion ?? true);
    // Time of the last sample seen at or above the arming threshold; -Infinity = never armed.
    // Carried across a resume: it is the only scalar in this loop that depends on samples before
    // the current one, and losing it would re-arm the cat-protection window from scratch every
    // flush — quietly keeping samples that a batch pass would have dropped.
    let lastKatsHotTime = resume?.lastKatsHotTime ?? -Infinity;

    // Tank ventilation. Off by default — see LogFilterConfig for why this one is opt-in while the
    // cat-protection exclusion is not.

    // Use custom table or default
    const interpTable = customTable || APP_CONFIG.MSS54HP.INTERPOLATION_TABLE;

    for (let i = resume?.consumed ?? 0; i < rawData.length; i++) {
        const current = rawData[i];

        // 0. Stretches the operator excluded.
        //
        // Before every other gate, and it is a reporting choice as much as an arithmetic one: a
        // sample inside an excluded stretch was removed BY A PERSON, and that outranks any reason
        // the app would have found for it. Naming it anything else would hide a human decision
        // behind a machine one — and this is the one census entry whose cure is "put it back".
        //
        // `drop`, not `reject`: `reject` exists to stop a sample the idle gate already counted from
        // being counted twice, and nothing has counted anything yet at the top of the loop.
        if (excluded.length > 0 && excluded.some(([a, b]) => current.time >= a && current.time < b)) {
            drop('excluded');
            continue;
        }

        // 1. Temperature Filter
        // Only apply if coolantTemp is valid (custom logic: assume < -40 or undefined is invalid/missing)
        // Code defaults missing temp to 95 in parser, so it will pass if missing.
        // User requirement: "If temp exists > 65 AND stable approx 80".
        // The parser sets missing temp to 95. We can assume if it's 95 strictly it might be fallback,
        // but real data could be 95. However, since we set it to 95 if missing, filtering on > 65 will pass it.
        // If real data < 65, it drops.
        // 1. Temperature Filter
        // [UPDATED] Check for undefined. If undefined, we SKIP the filter (allow the row).
        // Only Drop if temp exists and is below threshold.
        if (cfg.enableMinTemp && current.coolantTemp !== undefined && current.coolantTemp < cfg.minTemp) {
            drop('coldEngine');
            continue;
        }

        // 2. Idle Filter
        // Exclude if TPS <= 1.0 (approx 0%) and RPM < IdleThreshold
        // rawLoad is 'relative opening' (0-100)
        //
        // It no longer `continue`s. The sample is still dropped from validData and rfKorrData and
        // still counted in the census exactly as before — but it keeps walking, because the LOW
        // LOAD corrector wants precisely these rows and there is no other way to get them: turning
        // the gate off would corrupt the VE map, which genuinely needs them gone.
        //
        // Every later rejection therefore goes through `reject` rather than `drop`, so a sample
        // that was already counted as `idle` cannot be counted a second time as something else.
        // The invariant this preserves is checked in verify-low-load-filter.mjs: validData,
        // rfKorrData, droppedCount and every census bucket come out byte-identical to before.

        // 2b. Cat-protection / open-loop filter.
        // The VE correction reads `stft` = la_f_regler, the DME's own lambda INTEGRATOR. Once the
        // cat-protection factor ti_f_kats leaves 1.0 the DME deactivates lambda control outright
        // (FR 4.01 §1.2.4), so the integrator freezes and the samples say nothing about mixture —
        // but they are collected at high load, exactly where they carry the most weight. Worse,
        // the enrichment itself is up to +35% (K_TI_F_KATS_MAX = 1.3496), so a frozen trim recorded
        // over an enriched region will pull the map the wrong way.
        //
        // The window has to outlive the threshold crossing: ti_f_kats unwinds at
        // KL_TI_KATS_DELTA_ML = 0.0195/s, so falling from the 1.3496 ceiling back to 1.0 takes
        // ~18 s, and lambda stays open for all of it. Hence arm at katsTabgOn and hold until TABG
        // is back under katsTabgOff AND katsTail seconds have passed.
        //
        // No EGT channel in the log (any Testo CSV, and any live log from before this shipped)
        // means this never engages — the condition below is simply never true.
        if (katsExclusionOn && current.exhaustTemp !== undefined) {
            if (current.exhaustTemp >= katsOn) lastKatsHotTime = current.time;
            // `armed` is load-bearing, not defensive. Without it the `>= katsOff` test fires on its
            // own, and katsOff is BELOW katsOn — so a sample sitting anywhere in the 840-850 °C band
            // is excluded even though the DME never entered cat protection and the lambda loop is
            // still closed. That is the release threshold being used as an entry threshold, which
            // is the opposite of what it is for. Only the unwind after a real crossing is excluded.
            const armed = lastKatsHotTime > -Infinity;
            const secondsSinceHot = (current.time - lastKatsHotTime) * secondsPerTimeUnit;
            if (armed && (current.exhaustTemp >= katsOff || secondsSinceHot < katsTail)) {
                drop('catProtect');
                continue;
            }
        }

        // 2c. Lambda controller shutdown — Funktionsrahmen 5.01.
        //
        // These sit apart from the four filters above because they are a different kind of claim.
        // Those are OUR choices about which samples are useful; these are the DME telling us it was
        // not controlling. `la_f_regler` with the loop open is not a mixture error, and averaging
        // more of it does not converge on anything — it moves the cell somewhere else entirely.
        //
        // Thresholds come from the binary the log was captured against, never from a constant here:
        // this app PATCHES the full-load threshold, so a log taken patch-on was taken with the
        // controller deliberately kept alive, and the gate has to read the same bytes the DME read
        // to know that. See lambdaGates.ts for what is checked, what is not, and why K_LA_N_VL is
        // deliberately left out of the full-load test.
        if (lambdaLimits) {
            // Both of the DME's load-side shutdowns report as one reason. They are the same
            // instruction to the driver — "you were past the point where the loop opens" — and
            // splitting them would put a distinction in the census that nobody can act on.
            if (isFullLoad(lambdaLimits, current.wdk1, current.rpm, current.coolantTemp)
                || isOverLoadThreshold(lambdaLimits, current.rf, current.rpm)) {
                drop('fullLoad');
                continue;
            }
            if (isAtControllerStop(lambdaLimits, current.stft1, current.stft2)) {
                drop('controllerStop');
                continue;
            }
        }

        // 2d. Overrun fuel cut. OUTSIDE the `lambdaLimits` block on purpose: the other three gates
        // read thresholds out of the binary, and this one needs nothing from it — a log imported as
        // a CSV, with no binary to compare against, is just as full of overrun as a live run. See
        // isFuelCut for the three conditions and for what 1,197 of these samples did to a map.
        if (isFuelCut(current.stft1, current.stft2, current.wdk1, current.rawLoad)) {
            drop('fuelCut');
            continue;
        }

        // 3. Correction (Interpolation)
        // Computed BEFORE the transient test, because both output sets carry it: the sample that is
        // too transient for the VE map is still a sample the rf_korr tuner has to be able to bin on
        // the load axis, and re-deriving the factor in a second place is how the two end up
        // disagreeing about which cell a sample belongs to.
        // If disabled (user supplied processed CSV), use raw directly.
        let corrected = current.rawLoad;
        // The factor the correction ACTUALLY used, held rather than re-derived below.
        //
        // `correctionFactor` used to be computed as `rawLoad / corrected`, which is the same number
        // right up until it is not: at `rawLoad = 0` — an idle sample at a closed throttle, which
        // every log is full of — that is 0/0, and the column reported NaN for a correction that had
        // in fact been applied perfectly. Reporting the divisor itself cannot do that.
        let usedFactor = 1.0;
        if (cfg.enableCorrection) {
            const factor = interpolateFactor(current.rpm, interpTable);
            // A zero factor means the table has a hole at this rpm, not that the load is infinite.
            usedFactor = factor === 0 ? 1.0 : factor;
            corrected = current.rawLoad / usedFactor;
        }

        const point: LogDataPoint = {
            ...current,
            correctedLoad: corrected,
            correctionFactor: usedFactor,
        };

        // 3b. High-load settle — stepped here, and charged to the stream it argues about.
        //
        // It used to sit BELOW this push and `continue`, which meant `rfKorrData` was already
        // collected and only `validData` ever paid it. That is backwards: every line of its
        // reasoning is about `rf_korr` stepping when filling crosses the EGT-correction floor, so
        // rf_korr is the derivation that should wait for the trim to cover the step. Measured on
        // session #931, moving it changes the rf_korr stream and leaves the VE stream alone —
        // which is what the argument always said it should do.
        //
        // The clock advances on EVERY sample, including the ones below the floor that reset it, so
        // it is stepped outside the test rather than inside it.
        //
        // Each exclusion counts ITSELF, rather than one trailing `else` counting whatever arrived
        // false. With two reasons now able to set the flag, a shared tally would charge a sample
        // refused by 3c to `highLoadSettle` as well and the census would exceed the drive.
        highLoad = stepHighLoadClock(highLoad, current.rf, current.time, secondsPerTimeUnit);
        let settledForRfKorr = true;
        if (highLoadSettleSec > 0 && highLoad.enteredAt !== null) {
            const held = heldSeconds(highLoad, current.time, secondsPerTimeUnit);
            if (held !== null && held < highLoadSettleSec) settledForRfKorr = false;
            // (b) a trim within TRIM_CLAMP_MARGIN of its clamp is a BOUND, not a reading — refused
            // regardless of age, and the driver's cure is the same: keep holding.
            else if (lambdaLimits && isNearControllerClamp(lambdaLimits, current.stft1, current.stft2)) {
                settledForRfKorr = false;
            }
            // Counted, not "dropped": the sample stays in the log and can still earn a VE cell.
            if (!settledForRfKorr) census.highLoadSettle++;
        }

        // 3c. The SETTLE, and it charges rf_korr now.
        //
        // It used to be the look-back distance of the transient test below, which meant it shaped
        // `validData` and nothing else — a wait for the lambda integrator, spent by the derivation
        // that does not need it. Measured on #933: the correction the VE map is reading is a
        // STANDING error, not an integrator still moving. Over the 4,030 samples carrying a moving
        // trim, |trim - 1| correlates +0.32 with filling and +0.29 with load while every clock is
        // at or below zero (-0.04 against seconds since the trim was last parked at 1.000, -0.10
        // against time since the drive began); holds of 8 s+ sit no closer to 1.000 than holds
        // under 5 s (2.29 % against 1.87 %); and the wait bought coverage rather than quality —
        // 74 cells at 1.0 s against 44 at 2.0 s, thirty appearing and none leaving. See
        // TRANSIENT_SETTLE_SEC_DEFAULT for why an earlier +0.132 here was withdrawn.
        //
        // rf_korr is the derivation that reads a RATIO of two things the DME did, so it is the one
        // that wants both of them settled. So the wait moves here, beside the high-load settle it
        // was always confused with, and the VE stream keeps the two thresholds that ask the
        // question it actually has: is the operating point moving.
        //
        // Sessions that stored 0 — the default, and every session from here — re-derive their VE
        // map byte for byte, because 0 already meant "compare against the sample before this one",
        // which is what the VE path below now always does. A session that stored a NON-ZERO settle
        // re-derives differently: its wait is now spent on rf_korr. That is a knowing behaviour
        // change on reopen, the same one `veMethod` documents and for the same reason.
        //
        // MARKED, NOT REMOVED. `rfKorrTuner.settledFlags` walks this array with a window bounded on
        // TIMESTAMPS, so a gap shorter than its own settle is spanned rather than seen — and the
        // comment at its call site licenses that shortcut precisely because the log filter's
        // removals were all longer than it. Taking these rows out would manufacture exactly the
        // short gaps that comment assumed away, and only ever in the loosening direction: the rows
        // removed are the unsteady ones, so their steady neighbours would have nothing left to look
        // at and would read as settled. The tuner skips the flag in pass 0 instead, after the flags
        // are computed over an intact series.
        let settleUnsteady = false;
        if (cfg.enableTransient && settleSec !== undefined && settleSec > 0 && settledForRfKorr) {
            const ref = findSettleReference(rawData, i, settleSec, secondsPerTimeUnit);
            if (!isOperatingPointSteady(current, ref, cfg)) {
                settleUnsteady = true;
                census.settle++;
            }
        }

        // Everything that got this far is rf_korr evidence, unless the pull has not been held long
        // enough for the trim to have covered rf_korr's step, or the operating point had not stopped
        // moving a settle ago — see ProcessedLog.rfKorrData.
        if (settledForRfKorr) rfKorrData.push(settleUnsteady ? { ...point, settleUnsteady } : point);

        // 4. Transient Filter
        //
        // One sample against one sample — not an average, and only ever backwards. Nothing looks
        // forward, so the sample at the instant a change begins passes (its own past is still
        // quiet) and the ones after it are the ones dropped.
        //
        // The comparison sample is found by TIME when the config states a settle duration, and by
        // index when it does not. Both walk the RAW array, which is why a resume must be handed the
        // whole log rather than the new tail: earlier filters have already dropped samples out of
        // `validData`, and the look-back has to be able to see them.
        // The reference is THE SAMPLE BEFORE THIS ONE. It used to be `settleSec` back, and that
        // wait now belongs to rf_korr (3c) — so what is left here is the pair of thresholds and
        // the shortest honest comparison they can be read against.
        //
        // A log at 4.4 Hz puts that reference 0.23 s back, so the test still catches a stab: the
        // thresholds are a raw difference over that interval, which is why they are named as a
        // rate of change of the operating point and not as a tolerance on it.
        //
        // The INDEX path stays for a session that stored no seconds at all. Those are the archived
        // ones, they kept a sample COUNT, and reproducing them means walking back that many frames
        // however long that turns out to be — the same exemption `resolveTransientWindow` states
        // for the panel.
        if (cfg.enableTransient) {
            const prev = settleSec === undefined
                ? (i >= cfg.transientWindow ? getAt(i - cfg.transientWindow) : null)
                : getAt(i - 1);
            if (!isOperatingPointSteady(current, prev, cfg)) {
                drop('transient');
                continue;
            }
        }

        // ONE dataset. Both correctors read it and each takes its own band of kf_rf_soll —
        // the VE calculator refuses everything at or below LOW_LOAD_TOP_ROW, the low-opening
        // corrector refuses everything above it. There is nothing left for a second array to hold.
        validData.push(point);
    }


    return {
        fileName,
        data: validData,
        validCount: validData.length,
        droppedCount,
        dropCensus: census,
        rfKorrData,
        resume: {
            consumed: rawData.length, logId, validData, rfKorrData, droppedCount,
            census, lastKatsHotTime,
            highLoadEnteredAt: highLoad.enteredAt,
            highLoadRefTime: highLoad.refTime,
            highLoadRefRf: highLoad.refRf,
        },
    };
};

/**
 * Seconds per unit of the `time` column: 1 for a live DS2 run, 0.001 for a Testo CSV.
 *
 * Exported because rfKorrTuner needs the same answer for its settling window, and two independent
 * guesses at the unit is exactly the bug this discrimination exists to avoid — one of them being
 * wrong would silently make a 3-second requirement into a 3-millisecond one, which every sample
 * passes.
 */
export const timeScaleSeconds = (data: LogDataPoint[]): number =>
    medianStep(data) >= 5 ? 0.001 : 1;

/**
 * Median gap between consecutive timestamps, used only to tell a seconds log from a milliseconds
 * one. Median rather than mean because a live run can contain a multi-second stall (a K-line
 * retry, a dropped block) that would drag an average across the decision boundary. Sampled rather
 * than exhaustive: 200 gaps settle the unit question and keep this O(1) on a long drive.
 */
function medianStep(data: LogDataPoint[]): number {
    const steps: number[] = [];
    const limit = Math.min(data.length, 201);
    for (let i = 1; i < limit; i++) {
        const d = data[i].time - data[i - 1].time;
        if (d > 0) steps.push(d);
    }
    if (steps.length === 0) return 0;
    steps.sort((a, b) => a - b);
    return steps[Math.floor(steps.length / 2)];
}

/**
 * Exported so the live drive readout indexes the map the SAME way the filter does.
 *
 * `aq_rel_rf = rawLoad / interpolateFactor(rpm)` is what every row of the table is binned on, and a
 * dashboard that showed the raw opening over a map indexed on the corrected one would point at the
 * wrong row in a confident font. See LiveDriveStrip.
 */
export function interpolateFactor(rpm: number, table: InterpolationPoint[]): number {
    // Table is sorted by RPM? Yes (0, 900, 1100...)
    // Find range
    if (rpm <= table[0].rpm) return table[0].factor;
    if (rpm >= table[table.length - 1].rpm) return table[table.length - 1].factor;

    for (let i = 0; i < table.length - 1; i++) {
        const p1 = table[i];
        const p2 = table[i + 1];

        if (rpm >= p1.rpm && rpm <= p2.rpm) {
            // Linear interpolation
            const ratio = (rpm - p1.rpm) / (p2.rpm - p1.rpm);
            return p1.factor + ratio * (p2.factor - p1.factor);
        }
    }

    return 1.0; // Should not reach here
}
