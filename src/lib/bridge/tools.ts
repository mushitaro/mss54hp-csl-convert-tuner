/**
 * What this tab answers when its owner's assistant asks — the tab's half of the assistant bridge.
 *
 * The bridge (TSUNAGI///Matrix, matrix-tsunagi/bridge) relays seven tools to here and nothing else;
 * any other name is refused. Each answer is built from what the page ALREADY holds — the samples the
 * run recorded, the link's state, the census — so a question never adds a request to the K-line and
 * a log in progress never waits on one. The page supplies a facade (page.tsx) and this file holds
 * the rules that do not depend on React, so verify:assistant-bridge can hold them.
 *
 * What the assistant can do here, and what it cannot, is the owner's decision (2026-10-19):
 *
 *   read          state, the run, a moment of the log
 *   start a log   only from where START TUNE itself would start without asking anything
 *   stop the log  only with `confirmed: true` — the assistant must read it back to the driver first
 *   show a view   the tabs this build has
 *   observe       set the OBSERVE plan (what the next observation run watches and asks for) and
 *                 switch the session to OBSERVE while its mode is still open — never during a run
 *   mark          put a label on the recording log: a step done, a "mark that" from the driver
 *
 *   NOT connect, write, flash or arm a write. A person does those on the screen. There is no tool,
 *   and the facade has no method that could reach them.
 */
import type { LogDataPoint } from '@/lib/types';
import { cutMoment } from './moment';
import {
    EMPTY_PLAN, OBSERVE_MAX_READS, OBSERVE_MAX_STEPS, activeSteps, observeHz, parseAddress, planProblems,
    stepMark, watchKey, type ObservePlan,
} from '@/lib/log-engine/observe';

export const TOOL_NAMES = [
    'tuner_status', 'tuner_moment', 'tuner_start_log', 'tuner_stop_log', 'tuner_show', 'tuner_observe', 'tuner_mark',
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export interface TabFacade {
    /** The tab right now, as the assistant should hear it. */
    status(): Record<string, unknown>;
    /** The live run's samples if one is recording, else the loaded log's; null when neither exists. */
    samples(): { points: readonly LogDataPoint[]; live: boolean; nowLogTime: number } | null;
    /** Why START TUNE would not start right now without asking, or null when it would. */
    startRefusal(): string | null;
    /** Presses START TUNE. Only called after startRefusal() said null. */
    startLog(): void;
    /** Whether a log is recording. */
    running(): boolean;
    /** Presses STOP. Does not wait for the "log finished" dialog the owner reads afterwards. */
    stopLog(): void;
    /** The views this build can show. */
    views(): readonly string[];
    /** Brings a view to the front. */
    show(view: string): void;
    /** The OBSERVE plan as the page holds it. */
    observePlan(): ObservePlan;
    /** Replaces it. Only called with a plan that has no problems, or with the empty plan. */
    setObservePlan(plan: ObservePlan): void;
    /** Switches the open session to OBSERVE if its mode is still open; else why not, in words. */
    enterObserve(): string | null;
    /** Puts a label on the log at the next sample. Only called while a log records. */
    mark(label: string): void;
}

export type Handler = (args: Record<string, unknown>) => Promise<unknown>;

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** A plan out of the assistant's arguments — addresses as the strings it will have read off the
 *  disassembly (`DAT_00ffd1a2`, `0xFFD1A2`), anything unreadable kept as NaN so planProblems names it. */
export function planFromArgs(args: Record<string, unknown>): ObservePlan {
    const reads = Array.isArray(args.reads) ? args.reads.slice(0, OBSERVE_MAX_READS + 1) : [];
    return {
        title: text(args.title, 120),
        reads: reads.map(r => {
            const o = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
            const address = typeof o.address === 'number' ? o.address : parseAddress(String(o.address ?? '')) ?? NaN;
            return { address, count: num(o.bytes) ?? 2, every: (num(o.every) ?? 2) as ObservePlan['reads'][number]['every'], label: text(o.label, 60) };
        }),
        steps: Array.isArray(args.steps) ? args.steps.slice(0, OBSERVE_MAX_STEPS + 1).map(x => text(x, 160)).filter(Boolean) : [],
    };
}

export function bridgeHandlers(f: TabFacade): Record<ToolName, Handler> {
    return {
        tuner_status: async () => f.status(),

        tuner_moment: async (args) => {
            const s = f.samples();
            if (!s) throw new Error('There is no log on this tab: no run is recording and none is loaded.');
            return cutMoment({
                samples: s.points,
                nowLogTime: s.nowLogTime,
                secondsAgo: num(args.seconds_ago),
                windowS: num(args.window_s),
                atLogTime: num(args.at_log_time),
                source: s.live ? 'live run' : 'loaded log',
            });
        },

        tuner_start_log: async () => {
            if (f.running()) return { started: false, reason: 'A log is already recording.' };
            const refusal = f.startRefusal();
            if (refusal) throw new Error(refusal);
            f.startLog();
            return { started: true, note: 'START TUNE pressed. The first samples arrive within a second or two; ask tuner_status to confirm.' };
        },

        tuner_stop_log: async (args) => {
            if (!f.running()) return { stopped: false, reason: 'No log is recording.' };
            if (args.confirmed !== true) {
                throw new Error('Not stopped. Read it back to the driver ("stop the log?") and call again with confirmed: true only after a clear yes.');
            }
            const observing = (f.status() as { mode?: unknown }).mode === 'OBSERVE';
            f.stopLog();
            return {
                stopped: true,
                note: observing
                    ? 'STOP pressed. The observation run is kept: tuner_status has its marks and what each watched address did, and tuner_moment reads any part of it. It made nothing to write.'
                    : 'STOP pressed. The run is kept; the screen shows the result and how to write it, which is done by a person.',
            };
        },

        tuner_show: async (args) => {
            const view = typeof args.view === 'string' ? args.view.trim().toLowerCase() : '';
            const views = f.views();
            if (!views.includes(view)) throw new Error(`No view "${view}" in this build. Views: ${views.join(', ')}.`);
            f.show(view);
            return { shown: view };
        },

        tuner_observe: async (args) => {
            // A plan is what a run is OF, so it is frozen for as long as one records — the same rule
            // the panel follows. Stopping is the driver's yes, through tuner_stop_log.
            if (f.running()) throw new Error('A log is recording, and its plan cannot change under it. Stop it first (read it back to the driver), then set the plan.');
            if (args.clear === true) {
                f.setObservePlan(EMPTY_PLAN);
                return { cleared: true };
            }
            const plan = planFromArgs(args);
            const problems = planProblems(plan);
            if (problems.length) throw new Error(`The plan was not set: ${problems.join(' ')}`);
            f.setObservePlan(plan);
            const modeRefusal = f.enterObserve();
            return {
                set: true,
                reads: plan.reads.map(r => ({ address: watchKey(r.address), bytes: r.count, every: r.every, label: r.label })),
                steps: activeSteps(plan),
                expectedHz: Number(observeHz(plan).toFixed(2)),
                mode: modeRefusal ? 'not OBSERVE' : 'OBSERVE',
                next: modeRefusal
                    ? `The plan is on the OBSERVE tab, but the session is not in OBSERVE mode: ${modeRefusal}`
                    : 'The session is in OBSERVE mode with this plan. Ask the owner whether they are ready, then tuner_start_log. The plan is written into the log as its first mark.',
            };
        },

        tuner_mark: async (args) => {
            if (!f.running()) return { marked: false, reason: 'No log is recording.' };
            const plan = f.observePlan();
            const step = num(args.step);
            const steps = activeSteps(plan);
            let label: string;
            if (step !== undefined) {
                if (!Number.isInteger(step) || step < 1 || step > steps.length) {
                    throw new Error(steps.length ? `No step ${step}: the plan has steps 1 to ${steps.length}.` : 'The plan has no steps; mark with a label instead.');
                }
                // The panel's own mark for that step, so its checklist ticks the step off.
                label = stepMark(plan, step - 1);
            } else {
                label = text(args.label, 120);
                if (!label) throw new Error('Say what to mark: a label, or step with the step number.');
            }
            f.mark(label);
            return { marked: true, label, note: 'On the next sample, which arrives within a quarter of a second.' };
        },
    };
}
