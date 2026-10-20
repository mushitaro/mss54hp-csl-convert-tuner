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
 *   sessions      list the sessions saved on this device, and open one (2026-10-21) — the same
 *                 open the session list's row does, refused while anything is in flight on the link
 *                 or the workspace holds work that is not saved, because opening replaces it
 *   calibration   read a calibration parameter of the open session's BIN, and stage a change to one
 *                 (2026-10-21) — the CALIBRATION tab's own edit, made in front of whoever is at the
 *                 screen and only after the owner heard the old and new value read back. Staging is
 *                 not writing: the BIN changes when a person saves, and the car when a person
 *                 WRITEs, on the screen.
 *   evidence      with each parameter, how the DME code tests it, the XDF's own choices, and the
 *                 known recipes that touch it; and the recipes themselves, compared with the open
 *                 BIN (tuner_recipes) — so "what value makes it manual?" is answered from sources,
 *                 with how sure, instead of from the parameter's name.
 *
 *   NOT connect, write, flash or arm a write. A person does those on the screen. There is no tool,
 *   and the facade has no method that could reach them.
 */
import type { LogDataPoint } from '@/lib/types';
import type { CodeUses, ParamChoice } from '@/lib/calibration/evidence';
import { findRecipes, recipeParams, type Recipe, type RecipeStep, type Words } from '@/lib/calibration/recipes';
import { cutMoment } from './moment';
import {
    EMPTY_PLAN, OBSERVE_MAX_READS, OBSERVE_MAX_STEPS, activeSteps, observeHz, parseAddress, planProblems,
    stepMark, watchKey, type ObservePlan,
} from '@/lib/log-engine/observe';

export const TOOL_NAMES = [
    'tuner_status', 'tuner_moment', 'tuner_start_log', 'tuner_stop_log', 'tuner_show', 'tuner_observe', 'tuner_mark',
    'tuner_sessions', 'tuner_open_session', 'tuner_calibration', 'tuner_calibration_edit', 'tuner_recipes',
] as const;

/** A calibration parameter as the tab reads it off the open session's BASE and its edits. */
export interface CalibrationItem {
    name: string;
    kind: 'constant' | 'curve' | 'map';
    bank: string;
    address: number;
    units: string;
    description: string;
    /** Why it cannot be edited, in words; null when it can. */
    locked: string | null;
    count: number;
    dims: { rows: number; cols: number } | null;
    /** Physical values as loaded (BASE), and with this session's edits. Null cells did not scale. */
    base: readonly (number | null)[];
    current: readonly (number | null)[];
    /** The integers in the bytes, loaded and now. A switch byte (cfg_m.getriebetyp = 0x40) is
     *  talked about in hex, and its scaled value alone hides that. */
    baseRaw: readonly number[];
    raw: readonly number[];
    /** The XDF's own list of what each value selects, when it has one. */
    choices: readonly ParamChoice[] | null;
    /** Which DME functions read it, and the conditions they test it in. */
    code: CodeUses | null;
}

export interface CalibrationChange {
    name: string;
    cell: number;
    from: number | null;
    to: number;
    raw: number;
    /** False when the value asked for was rounded to the nearest one the bytes can hold. */
    exact: boolean;
    /** What else writes these bytes on every build (a PATCH toggle), when one does: the edit is
     *  kept on the tab but not written while that is on. */
    conflict: string | null;
    /** True when the parameter's edits are switched OFF on the tab (kept, not written). */
    held: boolean;
    /** How many cells this change set: 1, or the whole run for a fill. */
    cells: number;
}
export type ToolName = (typeof TOOL_NAMES)[number];

/** A saved session as the assistant hears it. No file names: a BIN's name can carry a VIN, and the
 *  privacy policy says the VIN is never sent. */
export interface SessionSummary {
    id: string;
    seq: number;
    label: string;
    status: 'draft' | 'archived';
    createdAt: number;
    hasBase: boolean;
    hasLog: boolean;
    logPoints: number;
    mode: string;
    open: boolean;
}

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
    /** Views this build has that are closed for now, because nothing they show is loaded yet. */
    closedViews?(): readonly string[];
    /** Brings a view to the front. */
    show(view: string): void;
    /** The sessions saved on this device. */
    sessions?(): readonly SessionSummary[];
    /** Why opening another session would lose or break something right now, or null when it is safe. */
    openRefusal?(): string | null;
    /** Opens a saved session as its row's OPEN does. Resolves true when its BASE is now the workspace. */
    openSession?(id: string): Promise<boolean>;
    /** Why the calibration cannot be read or edited right now (no BIN, archived, link busy), or null. */
    calibrationRefusal?(forEdit: boolean): string | null;
    /** Parameters whose name (or, failing that, description) matches, best first. */
    calibrationFind?(query: string, limit: number): Promise<readonly CalibrationItem[]>;
    /** Stages a change on the CALIBRATION tab, as typing it there would, and shows it: one cell, or
     *  every cell of the run set to one value ('all'). */
    calibrationEdit?(name: string, cell: number | 'all', value: number): Promise<CalibrationChange>;
    /** The language the tab's dialogs speak, for answers written in both. */
    lang?(): 'ja' | 'en';
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

const fmt = (v: number | null | undefined) => (v === null || v === undefined ? 'unreadable' : String(Math.round(v * 1e6) / 1e6));
const hex = (v: number) => `0x${v.toString(16).toUpperCase()}`;
const rawHex = (v: number | undefined) => (v === undefined ? null : v >= 0 ? hex(v) : String(v));

/** A parameter as the assistant hears it: every value of a constant or a small run, and only the
 *  range and the edited cells of a large one — a 20×24 map read out cell by cell is not an answer. */
function calBrief(i: CalibrationItem) {
    const changed = i.current.flatMap((v, k) => (v !== i.base[k] ? [k] : []));
    const finite = (xs: readonly (number | null)[]) => xs.filter((v): v is number => v !== null);
    const small = i.count <= 32;
    const cur = finite(i.current);
    return {
        name: i.name,
        kind: i.kind,
        where: `${i.bank} ${hex(i.address)}`,
        units: i.units || null,
        description: i.description || null,
        editable: i.locked ? `no: ${i.locked}` : 'yes',
        cells: i.count,
        dims: i.dims,
        ...(i.count === 1
            ? { value: i.current[0], raw: rawHex(i.raw[0]), loaded: i.base[0], loadedRaw: rawHex(i.baseRaw[0]) }
            : small
                ? { values: i.current, loaded: changed.length ? i.base : 'same as values' }
                : { min: cur.length ? Math.min(...cur) : null, max: cur.length ? Math.max(...cur) : null }),
        edited: changed.length ? changed.slice(0, 40).map(k => ({ cell: k, loaded: i.base[k], now: i.current[k] })) : [],
        ...(i.choices ? { choices: i.choices.map(c => `${c.value === 'else' ? 'else' : hex(c.value)} = ${c.label}`) } : {}),
        ...(i.code ? { code: { readBy: i.code.readBy.count, tested: i.code.conditions.map(c => `${c.when}  (${c.in.join(', ')})`) } } : {}),
        ...(recipesFor(i.name).length ? { recipes: recipesFor(i.name) } : {}),
    };
}

const recipesFor = (name: string) => findRecipes('').filter(r => recipeParams(r).includes(name)).map(r => r.id);

const say = (w: Words, lang: 'ja' | 'en') => w[lang];

/** One recipe step against the open BIN: what it changes, what the BIN holds now, whether it is done. */
function stepNow(s: RecipeStep, item: CalibrationItem | undefined, lang: 'ja' | 'en') {
    const target = s.set ?? s.fill!;
    const now = item?.current ?? [];
    const done = !!item && now.length > 0 && now.every(v => v !== null && Math.abs(v - target) < 1e-9);
    const asLoaded = !!item && item.baseRaw.length === s.from.length && item.baseRaw.every((r, k) => r === s.from[k]);
    const before = s.from.length === 1 ? rawHex(s.from[0]) : s.from.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
    return {
        param: s.param,
        change: s.fill !== undefined ? `every cell (${before}) → ${fmt(s.fill)}` : `${before} → ${fmt(s.set)}${item?.units ? ` ${item.units}` : ''}`,
        edit: s.fill !== undefined ? { name: s.param, fill: s.fill } : { name: s.param, value: s.set },
        now: !item ? 'not in this BIN' : item.count === 1 ? `${fmt(now[0])} (${rawHex(item.raw[0])})` : item.raw.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' '),
        done,
        // False means the open BIN did not hold, when loaded, what the recipe's sources saw before the
        // change: a different software, an earlier change, or a different car. Say so before going on.
        loadedAsExpected: asLoaded,
        why: say(s.why, lang),
    };
}

/** A session in a line: what the owner calls it and what it holds. The date is the tab's local day,
 *  the way the session list writes it. */
function brief(s: SessionSummary) {
    const d = new Date(s.createdAt);
    const pad = (n: number) => String(n).padStart(2, '0');
    return {
        session: `#${s.seq}`,
        name: s.label,
        state: s.status === 'archived' ? 'archived (read-only: look and flash)' : 'draft (can be tuned)',
        created: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`,
        mode: s.mode,
        bin: s.hasBase,
        log: s.hasLog ? s.logPoints : null,
    };
}

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
            if (!views.includes(view)) {
                // Two different answers: a view the build has that waits for a session, and one it
                // does not have at all. "No view calibration" over a closed tab sent an assistant
                // looking for a build that would have it.
                if (f.closedViews?.().includes(view)) {
                    throw new Error(`"${view}" opens once a session with a BIN is open. Find one with tuner_sessions and open it with tuner_open_session. Open now: ${views.join(', ')}.`);
                }
                throw new Error(`No view "${view}" in this build. Views: ${views.join(', ')}.`);
            }
            f.show(view);
            return { shown: view };
        },

        tuner_sessions: async (args) => {
            if (!f.sessions) throw new Error('This build cannot list its sessions to the assistant.');
            const all = [...f.sessions()].sort((a, b) => b.seq - a.seq);
            const query = text(args.query, 60).toLowerCase();
            const limit = Math.min(Math.max(Math.trunc(num(args.limit) ?? 15), 1), 50);
            const hits = query ? all.filter(s => String(s.seq) === query.replace(/^#/, '') || s.label.toLowerCase().includes(query)) : all;
            const open = all.find(s => s.open);
            return {
                open: open ? brief(open) : null,
                total: all.length,
                shown: Math.min(hits.length, limit),
                sessions: hits.slice(0, limit).map(brief),
            };
        },

        tuner_calibration: async (args) => {
            if (!f.calibrationFind) throw new Error('This build cannot read its calibration to the assistant.');
            const refusal = f.calibrationRefusal?.(false) ?? null;
            if (refusal) throw new Error(refusal);
            const query = text(args.name, 80) || text(args.query, 80);
            if (!query) throw new Error('Say which parameter: its name (K_PWG_SOLL_ANF_2_FAK, cfg_m.getriebetyp) or words to look for.');
            const limit = Math.min(Math.max(Math.trunc(num(args.limit) ?? 8), 1), 20);
            const items = await f.calibrationFind(query, limit);
            if (!items.length) return { found: 0, note: `Nothing named or described as "${query}". Try part of the name.` };
            return { found: items.length, parameters: items.map(calBrief) };
        },

        tuner_calibration_edit: async (args) => {
            if (!f.calibrationFind || !f.calibrationEdit) throw new Error('This build cannot change its calibration for the assistant.');
            // A recording log means the car is likely moving, and this brings the CALIBRATION tab to
            // the front: parked, with the log stopped, like every other look at the screen.
            if (f.running()) throw new Error('A log is recording. Calibration is changed parked, with the log stopped (read the stop back to the driver first).');
            const refusal = f.calibrationRefusal?.(true) ?? null;
            if (refusal) throw new Error(refusal);
            const name = text(args.name, 80);
            const fill = num(args.fill);
            const value = fill ?? num(args.value);
            if (!name) throw new Error('Say which parameter, by its exact name.');
            if (value === undefined) throw new Error('Say the new value (value, or fill for every cell), as a number in the parameter\'s units.');
            const [item] = (await f.calibrationFind(name, 1)).filter(i => i.name.toLowerCase() === name.toLowerCase());
            if (!item) throw new Error(`No parameter named "${name}". tuner_calibration finds it.`);
            if (item.locked) throw new Error(`${item.name} cannot be edited: ${item.locked}`);
            const whole = fill !== undefined && item.count > 1;
            const cell = item.count === 1 ? 0 : whole ? 0 : num(args.cell);
            if (cell === undefined || !Number.isInteger(cell) || cell < 0 || cell >= item.count) {
                throw new Error(`${item.name} is a ${item.kind} of ${item.count} cells: say which one with cell (0 to ${item.count - 1}${item.dims ? `, row-major, ${item.dims.cols} per row` : ''}), or fill to set every cell.`);
            }
            const from = item.current[cell];
            // The same rule as stopping the log: the owner hears the change before it is made — one
            // read-back per parameter, a whole row included.
            if (args.confirmed !== true) {
                const line = whole
                    ? `${item.name}: every one of its ${item.count} cells → ${value}${item.units ? ` ${item.units}` : ''}`
                    : `${item.name}${item.count > 1 ? ` cell ${cell}` : ''}: ${fmt(from)}${item.count === 1 ? ` (${rawHex(item.raw[0])})` : ''} → ${value}${item.units ? ` ${item.units}` : ''}`;
                throw new Error(`Not changed. Read it back to the owner first — "${line}" — and call again with confirmed: true only after a clear yes.`);
            }
            const change = await f.calibrationEdit(item.name, whole ? 'all' : cell, value);
            return {
                staged: true,
                ...change,
                units: item.units,
                note: (change.exact ? '' : `The bytes cannot hold ${value} exactly; the nearest is ${change.to}. `)
                    + 'It is on the CALIBRATION tab now, marked as edited. Nothing is written: the BIN changes when a person presses SAVE, and the car when a person WRITEs, on the screen. Undo on that tab takes it back.'
                    + (change.conflict ? ` It will not be written as it stands: ${change.conflict} writes the same bytes on every build. Say so; the owner settles it on the screen.` : '')
                    + (change.held ? ' Its edits are switched OFF on the tab, so it is kept but not written until a person turns it back on.' : ''),
            };
        },

        tuner_recipes: async (args) => {
            const query = text(args.query, 80);
            const found = findRecipes(query);
            const lang = f.lang?.() ?? 'en';
            if (!found.length) {
                return {
                    found: 0,
                    note: `No known recipe for "${query}". Work it out from tuner_calibration (code, choices, description) and say how sure that is — never a value from a name alone.`,
                };
            }
            // The open BIN's values for every step, when one is open; the recipe alone otherwise.
            const refusal = f.calibrationRefusal?.(false) ?? null;
            const items = new Map<string, CalibrationItem>();
            if (!refusal && f.calibrationFind) {
                for (const name of new Set(found.flatMap(recipeParams))) {
                    const [it] = (await f.calibrationFind(name, 1)).filter(i => i.name === name);
                    if (it) items.set(name, it);
                }
            }
            return {
                found: found.length,
                openBin: refusal ? `Not compared: ${refusal}` : 'Compared with the open session\'s BIN.',
                recipes: found.map((r: Recipe) => ({
                    id: r.id,
                    title: say(r.title, lang),
                    summary: say(r.summary, lang),
                    checkedOn: r.software,
                    grade: r.grade,
                    gradeWhy: say(r.gradeWhy, lang),
                    steps: r.steps.map(s => stepNow(s, items.get(s.param), lang)),
                    ...(r.choose ? {
                        ask: say(r.choose.question, lang),
                        options: r.choose.options.map(o => ({ when: say(o.when, lang), steps: o.steps.map(s => stepNow(s, items.get(s.param), lang)) })),
                    } : {}),
                    sources: r.sources.map(s => say(s, lang)),
                    unverified: say(r.unverified, lang),
                })),
                note: 'Each step is staged with tuner_calibration_edit (its `edit` arguments), one read-back and yes per step. Ask the owner the `ask` question; never pick an option for them. Say the grade and what is unverified with the recipe.',
            };
        },

        tuner_open_session: async (args) => {
            if (!f.sessions || !f.openSession) throw new Error('This build cannot open a session for the assistant.');
            const all = f.sessions();
            const wanted = typeof args.session === 'number' ? String(args.session) : text(args.session, 60);
            const key = wanted.replace(/^#/, '').trim();
            if (!key) throw new Error('Say which session: its number (978 or #978) or its name.');
            const bySeq = /^\d+$/.test(key) ? all.find(s => s.seq === Number(key)) : undefined;
            const byLabel = bySeq ? [] : all.filter(s => s.label.toLowerCase() === key.toLowerCase());
            if (!bySeq && byLabel.length > 1) throw new Error(`${byLabel.length} sessions are named "${key}": #${byLabel.map(s => s.seq).join(', #')}. Say the number.`);
            const target = bySeq ?? byLabel[0];
            if (!target) throw new Error(`No session ${/^\d+$/.test(key) ? `#${key}` : `"${key}"`} on this device. tuner_sessions lists them.`);
            if (target.open) return { opened: false, reason: 'It is already the open session.', session: brief(target) };
            const refusal = f.openRefusal?.() ?? null;
            if (refusal) throw new Error(refusal);
            const withBase = await f.openSession(target.id);
            return {
                opened: true,
                session: brief(target),
                note: withBase
                    ? 'Open on the screen, its BASE loaded (and its log, if it has one). The tabs that need a BIN are open now; tuner_show brings one forward, tuner_status says which.'
                    : 'Open on the screen, but it has no BASE yet, so only STARTUP is open. A BIN is picked on its row, on the screen.',
            };
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
