import type { LogDataPoint, ProcessedLog, LogFilterConfig, InterpolationPoint } from '@/lib/types';
import { APP_CONFIG } from '@/config/constants';
import {
    type LambdaLimits, type DropCensus, type DropReason, EMPTY_CENSUS,
    isFullLoad, isOverLoadThreshold, isAtControllerStop,
} from './lambdaGates';

/**
 * What one pass over a log leaves behind, so the next pass can continue instead of starting again.
 *
 * Held by the caller and handed back — this module stays a pure function of (log, config, state),
 * which is what lets the batch path keep calling it with no state at all and get the answer it
 * always got.
 */
export interface FilterResume {
    /** Raw samples already accounted for. The next call starts here. */
    consumed: number;
    validData: LogDataPoint[];
    rfKorrData: LogDataPoint[];
    droppedCount: number;
    census: DropCensus;
    /** The cat-protection arming time — see where it is used. */
    lastKatsHotTime: number;
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
    // Reused, not copied. A live run appends to these arrays across hundreds of flushes and copying
    // them each time would put back the O(n) this exists to remove — so the caller gets the same
    // array objects it had last time, wrapped in a fresh ProcessedLog. Anything memoising on the
    // ARRAY identity would therefore miss an update; everything here keys on the wrapper.
    const validData: LogDataPoint[] = resume?.validData ?? [];
    // Same prerequisites as validData, but WITHOUT the transient test. See ProcessedLog.rfKorrData
    // for why the rf_korr table needs its own sample set, and rfKorrTuner for what it does with it.
    const rfKorrData: LogDataPoint[] = resume?.rfKorrData ?? [];
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
        enableIdle: true,
        idleRpm: 1000,
        enableTransient: true,
        transientWindow: 4,
        rpmStableThreshold: 10,
        tpsStableThreshold: 5,
    };

    // Helper: Get data point at index safely
    const getAt = (idx: number) => (idx >= 0 && idx < rawData.length) ? rawData[idx] : null;

    // --- Cat-protection (open-loop) exclusion setup ---------------------------------------------
    // `time` is NOT one unit across sources: the live DS2 logger emits seconds
    // ((performance.now() - startTime) / 1000) while a Testo CSV's first column is milliseconds.
    // Discriminate on the median sample interval rather than on total span — live polling runs at
    // ~6-7 Hz (delta ~0.15) and a Testo log at ~150-250 (ms), which is a 30x separation that holds
    // for a log of any length. Guessing wrong here would either disable the exclusion or swallow
    // the whole log, so it is worth measuring.
    const secondsPerTimeUnit = timeScaleSeconds(rawData);

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
    const tankVentExclusionOn = cfg.enableTankVentExclusion ?? false;
    const tankVentMax = cfg.tankVentMaxMs ?? 0;

    // Use custom table or default
    const interpTable = customTable || APP_CONFIG.MSS54HP.INTERPOLATION_TABLE;

    for (let i = resume?.consumed ?? 0; i < rawData.length; i++) {
        const current = rawData[i];

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
        if (cfg.enableIdle && current.rawLoad <= 1.0 && current.rpm < cfg.idleRpm) {
            drop('idle');
            continue;
        }

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

        // 2c. Tank-ventilation filter.
        // Unlike cat protection this needs no arming and no tail. Purge is not a latched state the
        // DME unwinds out of — the valve is either passing vapour on this sample or it is not, and
        // TETV says which. The trim does lag the vapour, but modelling that lag would mean guessing
        // a time constant, and the honest answer to "how long after purge is the trim still dirty"
        // is to stop purging for the whole run instead.
        //
        // `!== undefined` rather than a truthiness test: a log with no TETV channel must pass
        // through untouched, and 0 is a real reading meaning the valve is shut.
        if (tankVentExclusionOn && current.tankVent !== undefined && current.tankVent > tankVentMax) {
            drop('tankVent');
            continue;
        }

        // 2d. Lambda controller shutdown — Funktionsrahmen 5.01.
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

        // 3. Correction (Interpolation)
        // Computed BEFORE the transient test, because both output sets carry it: the sample that is
        // too transient for the VE map is still a sample the rf_korr tuner has to be able to bin on
        // the load axis, and re-deriving the factor in a second place is how the two end up
        // disagreeing about which cell a sample belongs to.
        // If disabled (user supplied processed CSV), use raw directly.
        let corrected = current.rawLoad;
        if (cfg.enableCorrection) {
            const factor = interpolateFactor(current.rpm, interpTable);
            const f = factor === 0 ? 1.0 : factor;
            corrected = current.rawLoad / f;

            // DEBUG: Log first few corrections to verify
            if (i < 5) {
                console.log(`[Corrector] RPM:${current.rpm} Raw:${current.rawLoad} Factor:${factor} Corrected:${corrected}`);
            }
        } else {
            if (i < 5) console.log(`[Corrector] Correction DISABLED. RPM:${current.rpm}`);
        }

        const point: LogDataPoint = {
            ...current,
            correctedLoad: corrected,
            correctionFactor: cfg.enableCorrection ? (current.rawLoad / corrected) : 1.0 // Derive used factor for display
        };

        // Everything that got this far is rf_korr evidence. The transient test below is about the
        // lambda loop having converged, which the VE map needs and the rf_korr ratio does not ask
        // for in the same way — see ProcessedLog.rfKorrData.
        rfKorrData.push(point);

        // 4. Transient Filter
        // Check back N frames
        if (cfg.enableTransient && i >= cfg.transientWindow) {
            const prev = getAt(i - cfg.transientWindow);
            if (prev) {
                // RPM Stability Check (Relative %)
                const rpmDiffPct = Math.abs((current.rpm - prev.rpm) / prev.rpm) * 100;
                if (rpmDiffPct > cfg.rpmStableThreshold) {
                    drop('transient');
                    continue;
                }

                // TPS Stability Check (Absolute Delta)
                const tpsDiffAbs = Math.abs(current.rawLoad - prev.rawLoad);
                if (tpsDiffAbs > cfg.tpsStableThreshold) {
                    drop('transient');
                    continue;
                }
            }
        }

        validData.push(point);
    }

    return {
        fileName,
        data: validData,
        validCount: validData.length,
        droppedCount,
        dropCensus: census,
        rfKorrData,
        resume: { consumed: rawData.length, validData, rfKorrData, droppedCount, census, lastKatsHotTime },
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

function interpolateFactor(rpm: number, table: InterpolationPoint[]): number {
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
