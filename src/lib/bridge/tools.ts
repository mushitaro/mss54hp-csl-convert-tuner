/**
 * What this tab answers when its owner's assistant asks — the tab's half of the assistant bridge.
 *
 * The bridge (TSUNAGI///Matrix, matrix-tsunagi/bridge) relays five tools to here and nothing else;
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
 *
 *   NOT connect, write, flash or arm a write. A person does those on the screen. There is no tool,
 *   and the facade has no method that could reach them.
 */
import type { LogDataPoint } from '@/lib/types';
import { cutMoment } from './moment';

export const TOOL_NAMES = ['tuner_status', 'tuner_moment', 'tuner_start_log', 'tuner_stop_log', 'tuner_show'] as const;
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
}

export type Handler = (args: Record<string, unknown>) => Promise<unknown>;

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

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
            f.stopLog();
            return { stopped: true, note: 'STOP pressed. The run is kept; the screen shows the result and how to write it, which is done by a person.' };
        },

        tuner_show: async (args) => {
            const view = typeof args.view === 'string' ? args.view.trim().toLowerCase() : '';
            const views = f.views();
            if (!views.includes(view)) throw new Error(`No view "${view}" in this build. Views: ${views.join(', ')}.`);
            f.show(view);
            return { shown: view };
        },
    };
}
