/**
 * The experiment notebook: one per session, written by the driver, the assistant in the car, the
 * desk and the owner on the screen, and read by all of them.
 *
 * ## Why it exists
 *
 * A drive used to leave three things in three places: the log in the session, the plan in the
 * page's memory (gone on reload), and what the driver said and what was concluded in a Claude Docs
 * document tied to the session only by "#982" in its text. The desk read the log and not the rest,
 * and filled the gaps by inference — it called a 2nd→3rd shift "a fuel cut before the tip-in" and
 * compared a slow run that never reached the band with a fast one that did. Both were questions the
 * driver could have answered in a word. Here the plan, the driver's words and the findings sit with
 * the log, under the session's id, and every reader opens the same book.
 *
 * ## The rules, which this file enforces rather than describes
 *
 *   - Entries are only ever added. Nothing is rewritten or deleted; a finding is withdrawn by a
 *     `status` entry, and the original stays. That is also what lets the device and the desk write
 *     at the same time: two writers adding entries with their own ids cannot collide.
 *   - A `note` is the driver's own words (or the owner's, typed on the screen). The assistant and
 *     the desk cannot write one: what they think the driver did is a question, an `ask`.
 *   - A `fact` carries its evidence — run, time range, channels — or it is refused. A claim without
 *     a place in the data it rests on is a `read`, with how sure.
 *   - A reading that disagrees with another points at it (`re`) and stands beside it as DISPUTED;
 *     it does not replace it.
 *
 * Pure, and free of DOM and Node types: the tab, the bridge and the store's API (functions/) all run
 * the same rules, so a rule cannot hold in one place and not another.
 */

export type NotebookAuthor = 'driver' | 'chat' | 'desk' | 'owner';
export const NOTEBOOK_AUTHORS: readonly NotebookAuthor[] = ['driver', 'chat', 'desk', 'owner'];

/** Where in the data a fact or a reading rests: a run of this session, a time range in that run's
 *  log seconds, the channels looked at, and how raw bytes were read when that matters. */
export interface Evidence {
    run: number;
    from: number;
    to: number;
    channels: string[];
    decode?: string;
}

export interface PlanStep {
    n: number;
    do: string;
    gear?: string;
    rpm?: [number, number];
    ro?: [number, number];
    holdS?: number;
    times?: number;
}

/** An OBSERVE read, in the notebook's portable form: the address as six hex digits. */
export interface PlanWatch {
    address: string;
    bytes: number;
    every: 1 | 2 | 4 | 8;
    label?: string;
}

export type NotebookBody =
    | {
        kind: 'plan';
        /** 1, 2, 3 … in the order plans were written in this session. */
        v: number;
        /** The plan this one rewrites. Two plans rewriting the same one is a fork, which the tab
         *  puts to the driver before START rather than picking for them. */
        re?: string;
        /** The parent session's plan this was carried from by NEXT. */
        carriedFrom?: string;
        purpose: string;
        hypothesis?: string;
        criteria?: string;
        steps: PlanStep[];
        watch?: PlanWatch[];
    }
    | { kind: 'step'; run: number; t: number; n: number }
    | { kind: 'note'; run: number | null; t: number | null; text: string; via: 'voice' | 'screen' }
    | { kind: 'fact'; text: string; evidence: Evidence }
    | { kind: 'read'; text: string; sure: 'low' | 'mid' | 'high'; evidence?: Evidence; re?: string }
    | { kind: 'ask'; to: NotebookAuthor; text: string; about?: Evidence }
    | { kind: 'answer'; re: string; text: string }
    | { kind: 'status'; re: string; to: 'withdrawn' | 'agreed' | 'disputed' };

export type NotebookKind = NotebookBody['kind'];

export interface NotebookEntry {
    id: string;
    sessionId: string;
    /** When it was written, ms since the epoch, on the writer's clock. */
    at: number;
    by: NotebookAuthor;
    body: NotebookBody;
}

export const NOTEBOOK_LIMITS = {
    text: 2000,
    purpose: 300,
    steps: 12,
    stepText: 160,
    watch: 4,
    channels: 12,
    channel: 40,
    /** One entry as JSON. The store refuses anything larger. */
    entryBytes: 16_000,
} as const;

const ID = /^[0-9A-Za-z-]{8,64}$/;
const HEX6 = /^[0-9A-F]{6}$/;

const isInt = (n: unknown, min: number, max = Number.MAX_SAFE_INTEGER): n is number =>
    typeof n === 'number' && Number.isInteger(n) && n >= min && n <= max;
const isNum = (n: unknown, min = -Infinity): n is number =>
    typeof n === 'number' && Number.isFinite(n) && n >= min;
const text = (s: unknown, max: number): s is string =>
    typeof s === 'string' && s.trim().length > 0 && s.length <= max;
const range = (r: unknown): boolean =>
    Array.isArray(r) && r.length === 2 && isNum(r[0]) && isNum(r[1]) && r[0] <= r[1];

function evidenceProblem(e: unknown): string | null {
    if (!e || typeof e !== 'object') return 'evidence is required: run, from, to and channels';
    const v = e as Partial<Evidence>;
    if (!isInt(v.run, 1, 99)) return 'evidence.run must be the run number, from 1';
    if (!isNum(v.from, 0) || !isNum(v.to, 0) || v.from! > v.to!) return 'evidence.from and .to must be log seconds, from <= to';
    if (!Array.isArray(v.channels) || v.channels.length === 0 || v.channels.length > NOTEBOOK_LIMITS.channels
        || !v.channels.every(c => text(c, NOTEBOOK_LIMITS.channel))) {
        return `evidence.channels must name 1-${NOTEBOOK_LIMITS.channels} channels`;
    }
    if (v.decode !== undefined && !text(v.decode, 200)) return 'evidence.decode must be a short line';
    return null;
}

function planProblem(b: Extract<NotebookBody, { kind: 'plan' }>): string | null {
    if (!isInt(b.v, 1, 999)) return 'plan.v must be a version number, from 1';
    if (!text(b.purpose, NOTEBOOK_LIMITS.purpose)) return `plan.purpose is required (up to ${NOTEBOOK_LIMITS.purpose} characters)`;
    if (b.hypothesis !== undefined && !text(b.hypothesis, NOTEBOOK_LIMITS.text)) return 'plan.hypothesis is too long or empty';
    if (b.criteria !== undefined && !text(b.criteria, NOTEBOOK_LIMITS.text)) return 'plan.criteria is too long or empty';
    if (b.re !== undefined && !ID.test(b.re)) return 'plan.re must be an entry id';
    if (b.carriedFrom !== undefined && !ID.test(b.carriedFrom)) return 'plan.carriedFrom must be an entry id';
    if (!Array.isArray(b.steps) || b.steps.length > NOTEBOOK_LIMITS.steps) return `plan.steps must be a list of up to ${NOTEBOOK_LIMITS.steps}`;
    for (const [i, s] of b.steps.entries()) {
        if (!s || s.n !== i + 1) return 'plan.steps must be numbered 1, 2, 3 … in order';
        if (!text(s.do, NOTEBOOK_LIMITS.stepText)) return `step ${i + 1} must say what to do (up to ${NOTEBOOK_LIMITS.stepText} characters)`;
        if (s.rpm !== undefined && !range(s.rpm)) return `step ${i + 1}: rpm must be [from, to]`;
        if (s.ro !== undefined && !range(s.ro)) return `step ${i + 1}: ro must be [from, to]`;
        if (s.holdS !== undefined && !isNum(s.holdS, 0)) return `step ${i + 1}: holdS must be seconds`;
        if (s.times !== undefined && !isInt(s.times, 1, 99)) return `step ${i + 1}: times must be a count`;
        if (s.gear !== undefined && !text(s.gear, 20)) return `step ${i + 1}: gear must be short`;
    }
    if (b.watch !== undefined) {
        if (!Array.isArray(b.watch) || b.watch.length > NOTEBOOK_LIMITS.watch) return `plan.watch must be up to ${NOTEBOOK_LIMITS.watch} reads`;
        for (const w of b.watch) {
            if (!w || !HEX6.test(w.address)) return 'plan.watch addresses must be six hex digits, e.g. FFEBAC';
            if (!isInt(w.bytes, 1, 4)) return 'plan.watch bytes must be 1-4';
            if (![1, 2, 4, 8].includes(w.every)) return 'plan.watch every must be 1, 2, 4 or 8';
            if (w.label !== undefined && typeof w.label !== 'string') return 'plan.watch label must be text';
        }
    }
    return null;
}

/**
 * What is wrong with an entry, in a sentence the writer can act on — or null when it may be added.
 * The tab answers a tool with this, and the store refuses with it.
 */
export function entryProblem(e: unknown): string | null {
    if (!e || typeof e !== 'object') return 'not an entry';
    const x = e as Partial<NotebookEntry>;
    if (typeof x.id !== 'string' || !ID.test(x.id)) return 'id must be 8-64 letters, digits or dashes';
    if (typeof x.sessionId !== 'string' || !ID.test(x.sessionId)) return 'sessionId must be a session id';
    if (!isNum(x.at, 1)) return 'at must be a time in ms';
    if (!NOTEBOOK_AUTHORS.includes(x.by as NotebookAuthor)) return `by must be one of ${NOTEBOOK_AUTHORS.join(', ')}`;
    const b = x.body as NotebookBody | undefined;
    if (!b || typeof b !== 'object') return 'body is required';
    if (JSON.stringify(x).length > NOTEBOOK_LIMITS.entryBytes) return 'the entry is too long';
    switch (b.kind) {
        case 'plan':
            return planProblem(b);
        case 'step':
            if (!isInt(b.run, 1, 99) || !isNum(b.t, 0) || !isInt(b.n, 1, NOTEBOOK_LIMITS.steps)) return 'step needs run, t (log seconds) and n';
            return null;
        case 'note':
            // The rule the notebook exists for. What the assistant or the desk believes the driver
            // did is not the driver's word for it — it goes in as a question.
            if (x.by !== 'driver' && x.by !== 'owner') return 'a note is the driver\'s own words; the assistant and the desk ask instead (kind "ask")';
            if (!text(b.text, NOTEBOOK_LIMITS.text)) return 'note.text is required';
            if (b.via !== 'voice' && b.via !== 'screen') return 'note.via must be voice or screen';
            if (b.run !== null && !isInt(b.run, 1, 99)) return 'note.run must be a run number or null';
            if (b.t !== null && !isNum(b.t, 0)) return 'note.t must be log seconds or null';
            if ((b.run === null) !== (b.t === null)) return 'note.run and note.t go together';
            return null;
        case 'fact':
            if (x.by === 'driver') return 'what the driver says is a note; a fact is read from the data';
            if (!text(b.text, NOTEBOOK_LIMITS.text)) return 'fact.text is required';
            return evidenceProblem(b.evidence);
        case 'read':
            if (!text(b.text, NOTEBOOK_LIMITS.text)) return 'read.text is required';
            if (b.sure !== 'low' && b.sure !== 'mid' && b.sure !== 'high') return 'read.sure must be low, mid or high';
            if (b.re !== undefined && !ID.test(b.re)) return 'read.re must be an entry id';
            return b.evidence === undefined ? null : evidenceProblem(b.evidence);
        case 'ask':
            if (!NOTEBOOK_AUTHORS.includes(b.to)) return `ask.to must be one of ${NOTEBOOK_AUTHORS.join(', ')}`;
            if (!text(b.text, NOTEBOOK_LIMITS.text)) return 'ask.text is required';
            return b.about === undefined ? null : evidenceProblem(b.about);
        case 'answer':
            if (typeof b.re !== 'string' || !ID.test(b.re)) return 'answer.re must be the id of the ask';
            if (!text(b.text, NOTEBOOK_LIMITS.text)) return 'answer.text is required';
            return null;
        case 'status':
            if (typeof b.re !== 'string' || !ID.test(b.re)) return 'status.re must be an entry id';
            if (b.to !== 'withdrawn' && b.to !== 'agreed' && b.to !== 'disputed') return 'status.to must be withdrawn, agreed or disputed';
            return null;
        default:
            return 'body.kind must be plan, step, note, fact, read, ask, answer or status';
    }
}

/** Both sets, each entry once, in the order written. Entries never change, so which copy of an id
 *  is kept does not matter; the first is. */
export function mergeEntries(...sets: readonly (readonly NotebookEntry[])[]): NotebookEntry[] {
    const byId = new Map<string, NotebookEntry>();
    for (const set of sets) for (const e of set) if (!byId.has(e.id)) byId.set(e.id, e);
    return [...byId.values()].sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

type PlanEntry = NotebookEntry & { body: Extract<NotebookBody, { kind: 'plan' }> };
const isPlan = (e: NotebookEntry): e is PlanEntry => e.body.kind === 'plan';

/**
 * The plan to drive by, and whether there is more than one.
 *
 * A head is a plan no later plan rewrites. One head is the plan. Two or more is a fork — the
 * assistant and the desk each rewrote the same version — and `forked` says so: the tab asks the
 * driver which one before START, and never picks. `plan` is then the newest head, for display.
 */
export function currentPlan(entries: readonly NotebookEntry[]): { plan: PlanEntry | null; heads: PlanEntry[]; forked: boolean } {
    const plans = entries.filter(isPlan);
    const rewritten = new Set(plans.map(p => p.body.re).filter((x): x is string => !!x));
    // A head the driver set aside — the other half of a fork, chosen against — is no longer a head.
    const heads = plans.filter(p => !rewritten.has(p.id) && statusOf(entries, p.id) !== 'withdrawn')
        .sort((a, b) => a.at - b.at);
    return { plan: heads[heads.length - 1] ?? null, heads, forked: heads.length > 1 };
}

/** The steps marked done in one run: step number → the log time it was marked at (the first time). */
export function stepsDone(entries: readonly NotebookEntry[], run: number | null): Map<number, number> {
    const done = new Map<number, number>();
    if (run === null) return done;
    for (const e of entries) {
        if (e.body.kind === 'step' && e.body.run === run && !done.has(e.body.n)) done.set(e.body.n, e.body.t);
    }
    return done;
}

/** The latest note — what the driver last said, or the owner last typed. */
export function lastNote(entries: readonly NotebookEntry[]): NotebookEntry | null {
    let last: NotebookEntry | null = null;
    for (const e of entries) if (e.body.kind === 'note' && (!last || e.at >= last.at)) last = e;
    return last;
}

/**
 * The notebook in a line, for a readout that has one: `PLAN v3 · STEP 2/4 · ASK 2`. Each part only
 * when there is something to say; null when there is nothing at all.
 */
export function notebookLine(entries: readonly NotebookEntry[], run: number | null): string | null {
    const { plan, forked } = currentPlan(entries);
    const parts: string[] = [];
    if (plan) {
        parts.push(forked ? `PLAN v${plan.body.v} ×2` : `PLAN v${plan.body.v}`);
        const total = plan.body.steps.length;
        if (total) {
            const done = stepsDone(entries, run);
            const next = plan.body.steps.find(s => !done.has(s.n))?.n ?? total;
            parts.push(`STEP ${done.size >= total ? total : next}/${total}`);
        }
    }
    const asks = openAsks(entries).length;
    if (asks) parts.push(`ASK ${asks}`);
    return parts.length ? parts.join(' · ') : null;
}

/** The version the next plan written in this session takes. */
export function nextPlanVersion(entries: readonly NotebookEntry[]): number {
    return entries.filter(isPlan).reduce((v, p) => Math.max(v, p.body.v), 0) + 1;
}

/**
 * Where an entry stands: the latest `status` written about it; otherwise DISPUTED when a reading
 * points at it (`re`), because one that disagrees stands beside it rather than replacing it.
 */
export function statusOf(entries: readonly NotebookEntry[], id: string): 'withdrawn' | 'agreed' | 'disputed' | null {
    let latest: NotebookEntry | null = null;
    for (const e of entries) {
        if (e.body.kind === 'status' && e.body.re === id && (!latest || e.at >= latest.at)) latest = e;
    }
    if (latest && latest.body.kind === 'status') return latest.body.to;
    return entries.some(e => e.body.kind === 'read' && e.body.re === id) ? 'disputed' : null;
}

/** Questions still waiting: no answer points at them and none was withdrawn. Oldest first. */
export function openAsks(entries: readonly NotebookEntry[]): NotebookEntry[] {
    const answered = new Set(entries.flatMap(e => (e.body.kind === 'answer' ? [e.body.re] : [])));
    return entries.filter(e => e.body.kind === 'ask' && !answered.has(e.id) && statusOf(entries, e.id) !== 'withdrawn');
}
