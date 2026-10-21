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
 *   sessions too  a new session, or a copy of one (NEXT: the car's bytes, the settings), and
 *                 throwing away unsaved edits — the owner could not start a clean session by voice
 *                 (driving test, 2026-10-21)
 *   RAM           look a RAM symbol up by name or address, so an OBSERVE plan is the assistant's to make
 *   save & sync   SAVE the open session, send what changed to the cloud store, list the cloud's
 *                 sessions and bring one back into this device (2026-10-21, the owner's request) —
 *                 the screen's own SAVE, SYNC and the store panel's restore, each only after the
 *                 owner heard it read back. The bytes go between the tab and the store directly;
 *                 the bridge carries counts and names. SAVE changes this device's record, never the
 *                 car: WRITE stays a person's, on the screen.
 *   evidence      with each parameter, how the DME code tests it, the XDF's own choices, and the
 *                 known recipes that touch it; and the recipes themselves, compared with the open
 *                 BIN (tuner_recipes) — so "what value makes it manual?" is answered from sources,
 *                 with how sure, instead of from the parameter's name.
 *
 *   NOT connect, write, flash or arm a write. A person does those on the screen. There is no tool,
 *   and the facade has no method that could reach them.
 */
import type { LogDataPoint } from '@/lib/types';
import type { CodeUses, ParamChoice, RamHit } from '@/lib/calibration/evidence';
import { findRecipes, recipeParams, type Recipe, type RecipeStep, type Words } from '@/lib/calibration/recipes';
import { cutMoment } from './moment';
import {
    EMPTY_PLAN, OBSERVE_MAX_READS, OBSERVE_MAX_STEPS, activeSteps, observeHz, parseAddress, planProblems,
    stepMark, watchKey, type ObservePlan,
} from '@/lib/log-engine/observe';

export const TOOL_NAMES = [
    'tuner_status', 'tuner_moment', 'tuner_start_log', 'tuner_stop_log', 'tuner_show', 'tuner_observe', 'tuner_mark',
    'tuner_sessions', 'tuner_open_session', 'tuner_calibration', 'tuner_calibration_edit', 'tuner_recipes',
    'tuner_save', 'tuner_sync_upload', 'tuner_cloud_sessions', 'tuner_cloud_restore',
    'tuner_new_session', 'tuner_discard_edits', 'tuner_ram',
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
    /** Width of one cell in the bytes, so a raw value is written at its width (0x01, 0x0032). */
    bits: number;
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
/** What SAVE would keep, said before it is pressed. */
export interface SaveSummary {
    session: string;
    name: string;
    /** Each thing that is only in memory now: "7 calibration edits (cfg_m.getriebetyp, …)". */
    items: string[];
}

/** A session in the cloud store, as the assistant hears it. No VIN and no file names: the store's
 *  listing carries a VIN, and the privacy policy says the assistant never gets one. */
export interface CloudSessionSummary {
    ref: string;
    name: string;
    createdAt: number;
    syncedAt: number;
    status: string | null;
    hasTune: boolean;
    logPoints: number;
    /** This device's number for it, when this device has it too. */
    local: number | null;
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
    /** Why opening another session would lose or break something right now, or null when it is safe.
     *  `discard`: the owner chose to drop the unsaved work, so that alone no longer refuses. */
    openRefusal?(discard?: boolean): string | null;
    /** Opens a saved session as its row's OPEN does. Resolves true when its BASE is now the workspace. */
    openSession?(id: string): Promise<boolean>;
    /** NEW SESSION (no parent), or NEXT on a session's row (a draft that starts from that session's
     *  car bytes and settings). Resolves with the new session, or why it could not. */
    newSession?(parentId: string | null): Promise<{ seq: number; label: string; inherited: boolean } | { refused: string }>;
    /** Drops every staged calibration edit, as one step the tab's Undo takes back. Returns how many. */
    discardEdits?(): number;
    /** RAM symbols by name or address (evidence.ts ramFind). */
    ramFind?(query: string, limit: number): Promise<readonly RamHit[]>;
    /** Why the calibration cannot be read or edited right now (no BIN, archived, link busy), or null. */
    calibrationRefusal?(forEdit: boolean): string | null;
    /** Parameters whose name (or, failing that, description) matches, best first. */
    calibrationFind?(query: string, limit: number): Promise<readonly CalibrationItem[]>;
    /** Stages a change on the CALIBRATION tab, as typing it there would, and shows it: one cell, or
     *  every cell of the run set to one value ('all'). */
    calibrationEdit?(name: string, cell: number | 'all', value: number): Promise<CalibrationChange>;
    /** The language the tab's dialogs speak, for answers written in both. */
    lang?(): 'ja' | 'en';
    /** Why SAVE cannot be pressed now (recording, archived, nothing open, busy link), or null. */
    saveRefusal?(): string | null;
    /** What SAVE would keep; empty items when everything is already on the device. */
    saveSummary?(): SaveSummary | null;
    /** Presses SAVE without its dialogs. */
    save?(): Promise<'saved' | 'nothing' | 'no-base'>;
    /** Why the cloud cannot be reached now (no store in this build, offline, busy), or null. */
    syncRefusal?(): string | null;
    /** The sessions SYNC would send: changed since they were last sent. */
    syncPending?(): readonly SessionSummary[];
    /** Presses SYNC. `overwrite`: session ids the owner chose to send over a newer cloud copy. */
    syncUpload?(overwrite?: readonly string[]): Promise<
        | { sent: number; failed: number; firstError: string | null; stale?: readonly { id: string; seq: number; label: string; storeSyncedAt?: number }[] }
        | { skipped: 'signed-out' | 'nothing' }>;
    /** The cloud store's sessions, newest first. */
    cloudSessions?(): Promise<readonly CloudSessionSummary[]>;
    /** Why bringing that one back would lose or break something now, or null. */
    cloudRestoreRefusal?(ref: string): string | null;
    /** The store panel's restore: the cloud copy replaces this device's copy of the same session. */
    cloudRestore?(ref: string): Promise<void>;
    /** What a value becomes in a parameter's bytes, without changing anything — so a read-back
     *  says the value the bytes will hold, in the same two forms as the value they hold now. */
    calibrationQuantise?(name: string, value: number): Promise<{ raw: number; value: number; exact: boolean; bits: number } | null>;
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
/** A raw cell at its width: 0x01 for a byte, 0x0032 for a word. Negative raws stay decimal. */
const rawHex = (v: number | undefined, bits = 8) =>
    (v === undefined ? null : v >= 0 ? `0x${v.toString(16).toUpperCase().padStart(Math.max(2, Math.ceil(bits / 4)), '0')}` : String(v));
/** A run's raws as the bytes read: "06 01 0A … FF", each cell at its width. */
const cellsHex = (vs: readonly number[], bits = 8) => vs.map(v => rawHex(v, bits)!.replace(/^0x/, '')).join(' ');
/** A value as the owner hears it and as the bytes hold it: "64 (0x40)", "5 s (0x0032)". */
const both = (phys: number | null | undefined, raw: number | undefined, bits: number, units: string) =>
    `${fmt(phys)}${units ? ` ${units}` : ''}${raw === undefined ? '' : ` (${rawHex(raw, bits)})`}`;

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
            ? { value: i.current[0], raw: rawHex(i.raw[0], i.bits), loaded: i.base[0], loadedRaw: rawHex(i.baseRaw[0], i.bits) }
            : small
                ? { values: i.current, loaded: changed.length ? i.base : 'same as values' }
                : { min: cur.length ? Math.min(...cur) : null, max: cur.length ? Math.max(...cur) : null }),
        edited: changed.length ? changed.slice(0, 40).map(k => ({ cell: k, loaded: i.base[k], now: i.current[k] })) : [],
        ...(i.choices ? { choices: i.choices.map(c => `${c.value === 'else' ? 'else' : rawHex(c.value, i.bits)} = ${c.label}`) } : {}),
        ...(i.code ? { code: codeBrief(i.code) } : {}),
        ...(recipesFor(i.name).length ? { recipes: recipesFor(i.name) } : {}),
    };
}

/** How the DME code uses it. None found is said as none found: a table reached through a pointer or
 *  an index (the fault-code rows are) has no direct reference, and is not unused for it. */
function codeBrief(c: CodeUses) {
    if (c.readBy.count === 0 && c.conditions.length === 0) {
        return { readBy: 0, note: 'No direct reference found in the decompiled code. That does not make it unused: a table can be reached through a pointer or an index.' };
    }
    return { readBy: c.readBy.count, tested: c.conditions.map(x => `${x.when}  (${x.in.join(', ')})`) };
}

const recipesFor = (name: string) => findRecipes('').filter(r => recipeParams(r).includes(name)).map(r => r.id);

const say = (w: Words, lang: 'ja' | 'en') => w[lang];

type Quantised = { raw: number; value: number; exact: boolean; bits: number } | null;

/**
 * One recipe step against the open BIN: what it changes, what the BIN holds now, whether it is done.
 * Before and after are written the same way — the value and the raw at its width, "64 (0x40) → 3
 * (0x03)" — because "0x40 → 3" read out loud is two numbers in two notations.
 */
function stepNow(s: RecipeStep, item: CalibrationItem | undefined, q: Quantised, lang: 'ja' | 'en') {
    const target = s.set ?? s.fill!;
    const bits = item?.bits ?? q?.bits ?? 8;
    const units = item?.units ?? '';
    const now = item?.current ?? [];
    const done = !!item && now.length > 0 && now.every(v => v !== null && Math.abs(v - target) < 1e-9);
    const asLoaded = !!item && item.baseRaw.length === s.from.length && item.baseRaw.every((r, k) => r === s.from[k]);
    // The recipe's "before" in physical terms is known only where this BIN holds exactly those raws.
    const fromPhys = item && item.count === 1 && item.baseRaw[0] === s.from[0] ? item.base[0] : undefined;
    const before = s.from.length === 1
        ? (fromPhys === undefined ? rawHex(s.from[0], bits)! : both(fromPhys, s.from[0], bits, units))
        : cellsHex(s.from, bits);
    const after = both(q?.value ?? target, q?.raw, bits, units);
    // Where the BIN differs from what the recipe's sources saw, cell by cell, so the owner hears what
    // is different rather than only that something is.
    const differsAt = item && !asLoaded && item.baseRaw.length === s.from.length
        ? item.baseRaw.flatMap((r, k) => (r === s.from[k] ? [] : [{ cell: k, expected: rawHex(s.from[k], bits), loaded: rawHex(r, bits) }])).slice(0, 8)
        : undefined;
    return {
        param: s.param,
        change: s.fill !== undefined ? `every cell (${before}) → ${after}` : `${before} → ${after}`,
        edit: s.fill !== undefined ? { name: s.param, fill: s.fill } : { name: s.param, value: s.set },
        now: !item ? 'not in this BIN' : item.count === 1 ? both(now[0], item.raw[0], bits, units) : cellsHex(item.raw, bits),
        done,
        // False means the open BIN did not hold, when loaded, what the recipe's sources saw before the
        // change: a different software, an earlier change, or a different car. Say so before going on.
        loadedAsExpected: asLoaded,
        ...(differsAt?.length ? { differsAt } : {}),
        ...(q && !q.exact ? { note: `The bytes cannot hold ${fmt(target)} exactly; the nearest is ${fmt(q.value)}.` } : {}),
        why: say(s.why, lang),
    };
}

/**
 * What an assistant is told when it called a change without `confirmed`. Two kinds of change:
 *
 *   asked     SAVE, a send, a new session, dropping staged edits (the tab's Undo takes them back).
 *             The owner's own words asking for exactly this ARE the yes — "保存して" is not asked
 *             again (driving test, 2026-10-21: two yeses for one save is what made it unusable by
 *             voice). Read back only when the assistant is the one offering it.
 *   read back Anything that loses something nobody can take back: unsaved work dropped by opening or
 *             starting another session, another device's newer cloud copy, the copy on this device
 *             replaced by the cloud's, the log stopped. The owner hears it and says yes, always.
 */
function askedOrReadBack(action: string, line: string): Error {
    return new Error(`Not ${action}. If the owner asked for exactly this in their own words, that is the yes: call again with confirmed: true. If you are the one offering it, read it back first — "${line}" — and call with confirmed: true after a clear yes.`);
}
function readBackFirst(action: string, line: string): Error {
    return new Error(`Not ${action}. This loses something, so read it back to the owner first — "${line}" — and call again with confirmed: true only after a clear yes.`);
}

/** A moment as the session list writes it: the tab's local day and minute. */
function localTime(ms: number): string {
    const d = new Date(ms);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
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
                // The value the bytes will hold, in the same two forms as the one they hold now.
                const q = await f.calibrationQuantise?.(item.name, value) ?? null;
                const after = both(q?.value ?? value, q?.raw, item.bits, item.units);
                const line = whole
                    ? `${item.name}: every one of its ${item.count} cells (${cellsHex(item.raw, item.bits)}) → ${after}`
                    : `${item.name}${item.count > 1 ? ` cell ${cell}` : ''}: ${both(from, item.raw[cell], item.bits, item.units)} → ${after}`;
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
            const quantised = new Map<string, Quantised>();
            for (const s of found.flatMap(r => [...r.steps, ...(r.choose?.options.flatMap(o => o.steps) ?? [])])) {
                const key = `${s.param}=${s.set ?? s.fill}`;
                if (!quantised.has(key)) quantised.set(key, (await f.calibrationQuantise?.(s.param, (s.set ?? s.fill)!)) ?? null);
            }
            const at = (s: RecipeStep) => stepNow(s, items.get(s.param), quantised.get(`${s.param}=${s.set ?? s.fill}`) ?? null, lang);
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
                    steps: r.steps.map(at),
                    ...(r.choose ? {
                        ask: say(r.choose.question, lang),
                        options: r.choose.options.map(o => ({ when: say(o.when, lang), steps: o.steps.map(at) })),
                    } : {}),
                    sources: r.sources.map(s => say(s, lang)),
                    unverified: say(r.unverified, lang),
                })),
                note: 'Each step is staged with tuner_calibration_edit (its `edit` arguments), one read-back and yes per step. Ask the owner the `ask` question; never pick an option for them. Say the grade and what is unverified with the recipe.',
            };
        },

        tuner_save: async (args) => {
            if (!f.save || !f.saveSummary) throw new Error('This build cannot save for the assistant.');
            const refusal = f.saveRefusal?.() ?? null;
            if (refusal) throw new Error(refusal);
            const what = f.saveSummary();
            if (!what) throw new Error('No session is open. tuner_sessions and tuner_open_session open one.');
            if (!what.items.length) return { saved: false, session: what.session, reason: 'Nothing to save: everything in this session is already on this device.' };
            if (args.confirmed !== true) {
                throw askedOrReadBack('saved', `Save ${what.session}${what.name && what.name !== `Session ${what.session}` ? ` (${what.name})` : ''}: ${what.items.join('; ')}?`);
            }
            const outcome = await f.save();
            if (outcome === 'no-base') throw new Error(`${what.session} has no BASE, so there is nothing to save a tune against. A BASE is read off the car or picked on the session's row, on the screen.`);
            if (outcome === 'nothing') return { saved: false, session: what.session, reason: 'The screen had nothing to write after all; nothing changed.' };
            return {
                saved: true, session: what.session, kept: what.items,
                note: 'Saved on this device. Say what was kept. The car is unchanged — WRITE is done by a person on the screen. tuner_sync_upload sends it to the cloud.',
            };
        },

        tuner_sync_upload: async (args) => {
            if (!f.syncUpload || !f.syncPending) throw new Error('This build has no cloud to send to.');
            if (f.running()) throw new Error('A log is recording. Send to the cloud parked, with the log stopped (read the stop back to the driver first).');
            const refusal = f.syncRefusal?.() ?? null;
            if (refusal) throw new Error(refusal);
            const pending = f.syncPending();
            if (!pending.length) return { sent: 0, note: 'Nothing to send: every session on this device matches its cloud copy.' };
            const label = (s: SessionSummary) => `#${s.seq}${s.label !== `Session #${s.seq}` ? ` ${s.label}` : ''}`;
            const list = pending.slice(0, 6).map(label).join(', ');
            // Sessions the owner chose to send over another device's newer copy, by number.
            const wanted = Array.isArray(args.overwrite) ? args.overwrite.map(x => String(x).replace(/^#/, '').trim()) : [];
            const overwrite = pending.filter(s => wanted.includes(String(s.seq)));
            if (wanted.length && overwrite.length !== wanted.length) {
                throw new Error(`overwrite names a session that is not waiting to be sent: ${wanted.filter(w => !overwrite.some(s => String(s.seq) === w)).map(w => `#${w}`).join(', ')}.`);
            }
            if (args.confirmed !== true) {
                const line = `Send ${pending.length} session${pending.length > 1 ? 's' : ''} to the cloud: ${list}${pending.length > 6 ? ', …' : ''}?`;
                throw overwrite.length
                    ? readBackFirst('sent', `${line} ${overwrite.map(label).join(', ')} replace${overwrite.length === 1 ? 's' : ''} the newer cloud copy another device sent, and that copy is gone.`)
                    : askedOrReadBack('sent', line);
            }
            const r = await f.syncUpload(overwrite.map(s => s.id));
            if ('skipped' in r) {
                return r.skipped === 'signed-out'
                    ? { sent: 0, note: 'Not sent: the sign-in for the cloud has expired on this device. On the screen, SYNC offers to sign in on m3 again.' }
                    : { sent: 0, note: 'Nothing to send: every session on this device matches its cloud copy.' };
            }
            const stale = r.stale ?? [];
            return {
                sent: r.sent, failed: r.failed,
                ...(r.firstError ? { error: r.firstError } : {}),
                ...(stale.length ? {
                    notSent: stale.map(s => ({ session: `#${s.seq}`, name: s.label, newerCopySent: s.storeSyncedAt ? localTime(s.storeSyncedAt) : 'since' })),
                } : {}),
                note: stale.length
                    ? 'Some were not sent: another device sent a newer copy since. Ask the owner which to keep — bring the cloud copy back (tuner_cloud_restore), or send this one over it (overwrite with its number, read back first).'
                    : r.failed ? 'Some did not land; they stay marked to send, and SYNC (or this tool) tries them again.' : 'Sent. The copies on this device are unchanged.',
            };
        },

        tuner_cloud_sessions: async (args) => {
            if (!f.cloudSessions) throw new Error('This build has no cloud.');
            const refusal = f.syncRefusal?.() ?? null;
            if (refusal) throw new Error(refusal);
            const all = [...await f.cloudSessions()].sort((a, b) => b.syncedAt - a.syncedAt);
            const query = text(args.query, 60).toLowerCase().replace(/^#/, '');
            const hits = query ? all.filter(s => s.name.toLowerCase().includes(query) || (s.local !== null && String(s.local) === query)) : all;
            const limit = Math.min(Math.max(Math.trunc(num(args.limit) ?? 15), 1), 50);
            return {
                total: all.length, shown: Math.min(hits.length, limit),
                sessions: hits.slice(0, limit).map(s => ({
                    ref: s.ref, name: s.name,
                    created: localTime(s.createdAt), synced: localTime(s.syncedAt),
                    state: s.status ?? 'unknown', tune: s.hasTune, log: s.logPoints,
                    onThisDevice: s.local !== null ? `#${s.local}` : false,
                })),
            };
        },

        tuner_cloud_restore: async (args) => {
            if (!f.cloudRestore || !f.cloudSessions) throw new Error('This build has no cloud.');
            if (f.running()) throw new Error('A log is recording. Bring a session back parked, with the log stopped.');
            const refusal = f.syncRefusal?.() ?? null;
            if (refusal) throw new Error(refusal);
            const ref = text(args.ref, 80);
            if (!ref) throw new Error('Say which cloud session: its ref from tuner_cloud_sessions.');
            const target = (await f.cloudSessions()).find(s => s.ref === ref);
            if (!target) throw new Error(`No cloud session with ref "${ref}". tuner_cloud_sessions lists them.`);
            const blocked = f.cloudRestoreRefusal?.(ref) ?? null;
            if (blocked) throw new Error(blocked);
            if (args.confirmed !== true) {
                const replaces = target.local !== null ? ` It replaces #${target.local} on this device with the cloud copy.` : ' This device does not have it yet.';
                throw new Error(`Not brought back. Read it back to the owner first — "Bring ${target.name} (sent ${localTime(target.syncedAt)}) from the cloud into this device?${replaces}" — and call again with confirmed: true only after a clear yes.`);
            }
            await f.cloudRestore(ref);
            return {
                restored: true, name: target.name,
                note: 'On this device now. tuner_sessions finds it and tuner_open_session opens it.',
            };
        },

        tuner_new_session: async (args) => {
            if (!f.newSession || !f.sessions) throw new Error('This build cannot start a session for the assistant.');
            if (f.running()) throw new Error('A log is recording. A new session comes after it stops (read the stop back to the driver first).');
            const all = f.sessions();
            const from = args.from === undefined || args.from === null || args.from === '' ? null
                : String(args.from).replace(/^#/, '').trim();
            const parent = from === null ? null : all.find(s => String(s.seq) === from) ?? null;
            if (from !== null && !parent) throw new Error(`No session #${from} on this device. tuner_sessions lists them.`);
            if (parent && !parent.hasBase) throw new Error(`#${parent.seq} has no BIN to start from. Without one, a new session starts empty (no from).`);
            const discard = args.discard === true;
            const refusal = f.openRefusal?.(discard) ?? null;
            if (refusal) throw new Error(refusal);
            const lost = discard ? (f.saveSummary?.()?.items ?? []) : [];
            const what = parent
                ? `Start a new session from #${parent.seq} (NEXT: the bytes in the car and its settings, none of its unsaved edits)`
                : 'Start a new, empty session (it needs a BIN: read off the car or picked, on the screen)';
            if (args.confirmed !== true) {
                throw lost.length
                    ? readBackFirst('started', `${what}? This drops what is not saved in the open session: ${lost.join('; ')}.`)
                    : askedOrReadBack('started', `${what}?`);
            }
            if (lost.length && !discard) throw new Error('The open session has unsaved work. Say discard: true (read back what is lost first), or save it first.');
            const r = await f.newSession(parent?.id ?? null);
            if ('refused' in r) throw new Error(r.refused);
            return {
                started: true, session: `#${r.seq}`, name: r.label, from: parent ? `#${parent.seq}` : null,
                note: r.inherited
                    ? 'Open on the screen, starting from that session: nothing of its unsaved work came with it. Changes made now are this session\'s.'
                    : 'Open on the screen, empty. Its BIN is read off the car or picked on the screen.',
            };
        },

        tuner_discard_edits: async (args) => {
            if (!f.discardEdits || !f.calibrationFind) throw new Error('This build cannot drop edits for the assistant.');
            if (f.running()) throw new Error('A log is recording. Edits are dropped parked, with the log stopped.');
            const refusal = f.calibrationRefusal?.(true) ?? null;
            if (refusal) throw new Error(refusal);
            const unsaved = f.saveSummary?.()?.items.filter(i => /calibration edit/.test(i)) ?? [];
            if (!unsaved.length) return { discarded: 0, note: 'No calibration edits are staged.' };
            if (args.confirmed !== true) throw askedOrReadBack('dropped', `Drop ${unsaved.join('; ')}?`);
            const n = f.discardEdits();
            return {
                discarded: n,
                note: 'Dropped from the CALIBRATION tab. Undo on that tab brings them back while this session stays open; the BIN was never changed by them.',
            };
        },

        tuner_ram: async (args) => {
            if (!f.ramFind) throw new Error('This build cannot look RAM up for the assistant.');
            const query = text(args.query, 60);
            if (!query) throw new Error('Say what to look for: part of a name (evan, p_saug) or an address (DAT_00ffd1a2, 0xFFD1A2).');
            const limit = Math.min(Math.max(Math.trunc(num(args.limit) ?? 10), 1), 30);
            const hits = await f.ramFind(query, limit);
            if (!hits.length) return { found: 0, note: `No RAM symbol named or at "${query}". Try part of the name.` };
            return {
                found: hits.length,
                ram: hits.map(h => ({
                    name: h.name,
                    address: `${h.bank} 0x${h.address.toString(16).toUpperCase()}`,
                    observe: h.observable
                        ? `DAT_00${h.address.toString(16).padStart(6, '0')}`
                        : (h.bank === 'slave' ? 'no: slave RAM cannot be read over DS2 on this calibration' : 'no: outside the RAM the DME serves (0xFF8000-0xFF8FFF, 0xFFD000-0xFFEFFF)'),
                    readers: h.readers,
                    ...(h.writes.length ? { setBy: h.writes.map(w => `${w.in}: ${w.value}`) } : {}),
                })),
                note: 'observe is the address to give tuner_observe. How wide it is (1, 2 or 4 bytes) comes from the code that sets it; when unsure, read 2 and say the reading is a guess.',
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
            const discard = args.discard === true;
            const refusal = f.openRefusal?.(discard) ?? null;
            if (refusal) throw new Error(refusal);
            const lost = discard ? (f.saveSummary?.()?.items ?? []) : [];
            if (lost.length && args.confirmed !== true) {
                throw readBackFirst('opened', `Open #${target.seq} without saving? This drops what is not saved in the open session: ${lost.join('; ')}.`);
            }
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
