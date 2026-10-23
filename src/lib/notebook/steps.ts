/**
 * A plan's steps against a run: which are done, how often, and where the log shows a step's
 * conditions held.
 *
 * Steps are not cleared in order. The driver drives what the road allows, and the assistant marks
 * whichever step the driver's words or the data show done — so a step is "done" when it has been
 * marked as many times as it asks for, whatever came before it (operator, 2026-10-23). Nobody taps
 * the screen to mark one while driving.
 *
 * `stepHolds` is the tab's evidence for the assistant, not a verdict: the stretches of a run where a
 * step's gear, rpm band and RO band held for its hold time. The assistant decides whether that was
 * the step (the driver may have been doing something else in the same band) and marks it.
 *
 * Pure: the page, the bridge and the checks run the same functions.
 */
import type { LogDataPoint } from '../types';
import type { NotebookEntry, PlanStep } from './rules';

/** Relative opening as the VE map's axis reads it: the corrected (alpha-N) value where the log has
 *  it, the raw one otherwise — so "RO 6-8" in a plan means the cells the map has. */
export const roOf = (p: LogDataPoint): number => p.correctedLoad ?? p.rawLoad;

/** The gears a step allows: "4", "4/5", "3rd" → [4], [4, 5], [3]. None named → any gear. */
export function stepGears(step: PlanStep): number[] {
    return (step.gear ?? '').match(/\d/g)?.map(Number) ?? [];
}

/** Whether a step names anything the log can check. One that does not is done on the driver's word. */
export const checkable = (step: PlanStep): boolean => !!(step.rpm || step.ro || stepGears(step).length);

/** Whether one sample sits in a step's bands; `gear` is the last gear the log reported. */
export function inBand(p: LogDataPoint, step: PlanStep, gear: number | undefined): boolean {
    if (step.rpm && !(p.rpm >= step.rpm[0] && p.rpm <= step.rpm[1])) return false;
    if (step.ro) { const ro = roOf(p); if (!(ro >= step.ro[0] && ro <= step.ro[1])) return false; }
    const gears = stepGears(step);
    if (gears.length && (gear === undefined || !gears.includes(gear))) return false;
    return true;
}

export interface StepHold { from: number; to: number; seconds: number }

/** A gap longer than this between samples breaks a stretch: the link dropped, or samples were cut. */
const MAX_GAP_S = 1.5;

/**
 * The stretches of `samples` where a step's conditions held for at least its hold time (one second
 * when it names none). Gear is carried forward from the last sample that read it (the log reads it
 * one sample in 16). A step that names nothing checkable gives none.
 */
export function stepHolds(samples: readonly LogDataPoint[], step: PlanStep): StepHold[] {
    if (!checkable(step)) return [];
    const need = Math.max(step.holdS ?? 1, 0.5);
    const out: StepHold[] = [];
    let gear: number | undefined;
    let from: number | null = null;
    let last: number | null = null;
    const close = () => {
        if (from !== null && last !== null && last - from >= need) out.push({ from, to: last, seconds: Number((last - from).toFixed(1)) });
        from = null;
    };
    for (const p of samples) {
        if (typeof p.gear === 'number') gear = p.gear;
        if (last !== null && p.time - last > MAX_GAP_S) close();
        if (inBand(p, step, gear)) { if (from === null) from = p.time; }
        else close();
        last = p.time;
    }
    close();
    return out;
}

/** Where a recording stands against one step right now: the latest values, whether they sit in the
 *  bands, and for how long they have without a break. */
export function liveHold(samples: readonly LogDataPoint[], step: PlanStep): {
    rpm: number | null; ro: number | null; gear: number | null; inBand: boolean; seconds: number;
} {
    if (!samples.length) return { rpm: null, ro: null, gear: null, inBand: false, seconds: 0 };
    let gear: number | undefined;
    for (let i = samples.length - 1; i >= 0 && gear === undefined; i--) if (typeof samples[i].gear === 'number') gear = samples[i].gear;
    const lastP = samples[samples.length - 1];
    let seconds = 0;
    for (let i = samples.length - 1; i > 0; i--) {
        const p = samples[i], prev = samples[i - 1];
        if (!inBand(p, step, gear) || p.time - prev.time > MAX_GAP_S) break;
        if (!inBand(prev, step, gear)) break;
        seconds = lastP.time - prev.time;
    }
    return { rpm: lastP.rpm, ro: roOf(lastP), gear: gear ?? null, inBand: inBand(lastP, step, gear), seconds: Number(seconds.toFixed(1)) };
}

/** How often each step has been marked done in one run — any order, every mark counted. */
export function stepCounts(entries: readonly NotebookEntry[], run: number | null): Map<number, number> {
    const counts = new Map<number, number>();
    if (run === null) return counts;
    for (const e of entries) if (e.body.kind === 'step' && e.body.run === run) counts.set(e.body.n, (counts.get(e.body.n) ?? 0) + 1);
    return counts;
}

/** Whether a step is done in a run: marked as many times as it asks for (once when it names none). */
export const stepDone = (step: PlanStep, counts: Map<number, number>): boolean =>
    (counts.get(step.n) ?? 0) >= (step.times ?? 1);
