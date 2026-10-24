/**
 * A whole run as the assistant reads it in one call: how long, where the drive spent its time on the
 * map, how the trims read there, and the events worth asking tuner_moment about.
 *
 * tuner_moment cuts at most 120 s. The operator asked (#984 notebook, 2026-10-24) for the assistant
 * to see the whole log while driving; this is the run half, veOverview.ts the map. A 67-minute VE
 * run (#984: 10,888 samples at 2.7 Hz) comes back as one answer under `maxBytes` — the timeline is
 * coarsened until it fits, and says so.
 *
 *   totals    duration, samples, rate, link gaps, time with the lambda loop closed (where the log
 *             says: LA_ST_EIN bit 0, one sample in eight), coolant range, counts of the events below
 *   timeline  one row per step (5 s unless the run is too long for 200 rows): median rpm, RO, pedal,
 *             throttle, speed; the gear; the mean trim; seconds in an overrun fuel cut; knock retards
 *   grid      rpm x RO bins (400 rpm x 2.5 %, or the VE map's own nodes): seconds spent, mean trim,
 *             and the share of measuring samples where the loop was LIMIT-CYCLING rather than
 *             walking (`lambdaCyclingFlags`, the flag the rf_korr tuner and the high-delta guard read)
 *   events    overrun fuel cuts and trims parked with the pedal down, gear changes, knock clusters,
 *             link gaps, marks — each at its time on the log's clock, which is the clock
 *             tuner_moment's `at_log_time` takes
 *
 * RO is the VE map's axis, `aq_rel_rf = rawLoad / interpolateFactor(rpm)` with the session's table —
 * the filter's own rule, zero factor read as 1 — or the sample's `correctedLoad` when it carries one.
 *
 * Pure: samples in, a plain object out. verify:bridge-overview pins it.
 */
import type { InterpolationPoint, LogDataPoint } from '@/lib/types';
import { interpolateFactor, timeScaleSeconds } from '@/lib/log-engine/filter';
import { isFuelCut } from '@/lib/log-engine/lambdaGates';
import { lambdaCyclingFlags, type LambdaRampParams } from '@/lib/ve-calculator/rampState';
import { KNOCK_AGE_NONE, type Moment } from './moment';

export const RUN_STEP_DEFAULT_S = 5;
/** Timeline rows at most, before the size budget is even asked. */
export const RUN_MAX_TIMELINE_ROWS = 200;
/** Steps the timeline coarsens through, seconds — round numbers a driver can count in. */
export const RUN_STEP_LADDER = [1, 2, 5, 6, 10, 15, 20, 30, 45, 60, 90, 120, 180, 300, 600] as const;
export const RUN_RPM_BIN = 400;
export const RUN_RO_BIN = 2.5;
/** The answer's size, characters of JSON: the ~12 KB set for one tool answer read on a phone in the
 *  car (2026-10-24). A longer one is coarsened, never cut off mid-table. */
export const RUN_MAX_BYTES = 12_000;
/** Events listed at most; the rest are counted by kind. */
export const RUN_MAX_EVENTS = 60;
/** A grid bin with less time than this is folded into `otherS`: a pass through a bin is not a place
 *  the drive was. */
export const GRID_MIN_S = 0.5;
/**
 * Pedal at or below this, %, makes a fuel cut an OVERRUN cut. Measured on #984: over the 869 samples
 * the filter's isFuelCut takes, PWG1 reads 0.2 % at the median and 2.8 % at p90. With the pedal down
 * the same parked trims are a shift or an intervention — the distinction moment.ts `trimsReset`
 * draws after a desk read a 2nd→3rd shift as a fuel cut (#982).
 */
export const PEDAL_UP_PCT = 5;
/** Knock retards closer together than this, seconds, are one cluster. */
export const KNOCK_CLUSTER_S = 2;
/** A knock counter that grew by less than this share of the combustions between two reads was
 *  restarted by a retard in between — see knockRetards for the measurement. */
export const KNOCK_GROWTH_MIN = 0.8;
/**
 * How long a slow-lane read stands for, seconds. GANG rides one sample in sixteen and LA_ST_EIN one in
 * eight — every ~6 s and ~3 s at #984's 2.7 Hz — so a step between reads carries the last one, but
 * not across a stall long enough for the state to have changed unseen.
 */
const SLOW_READ_HOLD_S = 10;

export interface RunOverviewInput {
    /** The run, oldest first: the live run's samples, the loaded log's raw samples, or a stored run. */
    samples: readonly LogDataPoint[];
    /** The session's opening → aq_rel_rf table, or null when the filter's correction is off (a CSV
     *  already corrected), in which case RO is the raw opening. */
    interpolationTable: InterpolationPoint[] | null;
    /** Where the samples came from, said back the way tuner_moment says it. */
    source?: Moment['source'];
    /** The lambda controller's P jumps and clamps from the as-run BIN (`EgtTables.lambda`); absent,
     *  the 0401 values (rampState.ts fallbacks). */
    rampParams?: LambdaRampParams | null;
}

export interface RunOverviewOptions {
    /** Seconds per timeline row; raised when the run would need more than 200 rows or bytes allow. */
    stepS?: number;
    /** A window on the log's clock, seconds. */
    from?: number;
    to?: number;
    rpmBin?: number;
    roBin?: number;
    /** Bin on the VE map's own nodes instead (nearest node on each axis), so a grid row is a cell
     *  veOverview lists. Wins over rpmBin / roBin. */
    axes?: { rpm: readonly number[]; ro: readonly number[] };
    maxBytes?: number;
}

type Cell = number | string | null;
export interface RunTable { columns: string[]; rows: Cell[][] }

export interface RunOverview {
    source: Moment['source'] | null;
    totals: {
        from: number; to: number; durationS: number; samples: number; hz: number;
        /** Seconds with nothing recorded (link gaps). */
        gapS: number;
        /** Seconds the loop read closed, of the seconds a LA_ST_EIN read covered; null without it. */
        closedLoopS: number | null; loopKnownS: number | null;
        coolant: [number, number] | null;
        rpmMax: number | null;
        fuelCutS: number; fuelCuts: number; trimsResets: number; gearChanges: number;
        knockRetards: number; knockClusters: number;
    } | null;
    timeline: RunTable & { stepS: number };
    /** `bins` says how rpm and RO were binned; a row's rpm and ro are the bin's lower edge, or the node. */
    grid: RunTable & { bins: string; otherS: number; otherCells: number };
    events: RunTable;
    legend: Record<string, string>;
    notes: string[];
}

const LEGEND: Record<string, string> = {
    t: 'log clock, s (a step\'s start, an event); tuner_moment at_log_time takes the same clock',
    ro: 'aq_rel_rf %, the VE map\'s RO axis',
    trim: 'mean stft x ltft over samples not in a fuel cut',
    cut: 'seconds in an overrun fuel cut',
    knock: 'knock retards, at the combustion each counter dates them to',
    s: 'seconds spent in the bin',
    cyc: 'share of the bin\'s measuring samples where the loop limit-cycled (0..1); the rest walked',
    'events.cut': 'overrun fuel cut: trims parked at 1.000, throttle shut, pedal up; the trims restart from 1.000 after it',
    'events.trimsReset': 'the same with the pedal down: a shift or an intervention',
};

const round = (v: number, digits: number) => Number(v.toFixed(digits));
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const r0 = (v: number | null | undefined) => (num(v) ? round(v, 0) : null);
const r1 = (v: number | null | undefined) => (num(v) ? round(v, 1) : null);

function median(xs: number[]): number | null {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

/** The trim the VE write reads — mean stft x mean ltft over the banks present (calculator.ts
 *  accumulatePoint); ltft absent reads 1.000 as it does there. Null without a stft. */
function trimOf(p: LogDataPoint): number | null {
    const st = [p.stft1, p.stft2].filter(num);
    if (!st.length) return null;
    const lt = [p.ltft1, p.ltft2].filter(num);
    return (st.reduce((a, b) => a + b, 0) / st.length) * (lt.length ? lt.reduce((a, b) => a + b, 0) / lt.length : 1);
}

/** Both trims parked at 1.000 with the throttle shut and the load at the floor (the filter's
 *  isFuelCut), split by the pedal: up is the overrun cut, down is a shift or an intervention. */
function parkedKind(p: LogDataPoint): 'cut' | 'trimsReset' | null {
    if (!isFuelCut(p.stft1, p.stft2, p.wdk1, p.rawLoad)) return null;
    return p.pwg1 !== undefined && p.pwg1 > PEDAL_UP_PCT ? 'trimsReset' : 'cut';
}

interface Retard { t: number; cyl: number; rpm: number; ro: number }

const KNOCK_KEYS = ['knockAge1', 'knockAge2', 'knockAge3', 'knockAge4', 'knockAge5', 'knockAge6'] as const;

/**
 * Every knock retard the counters show, at the time each dates it to.
 *
 * The counter is combustions of that cylinder since knock control last retarded it (1275 = none
 * remembered), so between two reads it either grew by the combustions in between or restarted:
 *
 *     C      = (t - t_prev) * mean(rpm_prev, rpm) / 120        combustions between the reads
 *     new    <=>  n < n_prev + 0.8 C  (and below by 2 at least)  (or n_prev was 1275 and n is not)
 *     when   = t - n * 120 / rpm, kept between the two reads
 *
 * 0.8 is measured, on #984's 5,248 pairs of unsaturated reads ~3 s apart: growth / C peaks at
 * 0.85-1.0 (median 0.96) where no retard came between, and from 0.6 to 0.8 it is flat at ~10 pairs
 * per 0.025 — the valley between that peak and the restarted counters spread below it. 0.85 cut into
 * the peak's shoulder (35 pairs in 0.825-0.85).
 *
 * NOT "does `when` fall after the previous read". `when` divides a combustion count by the rpm of the
 * read, so where rpm moved since the retard it lands seconds off — the counter can date a retard up
 * to ~60 s back — and a test on it counts one retard again at every read. The count test needs only
 * the ~3 s between reads to hold a steady-ish rpm. Across a link gap the engine may have stopped, so
 * there only a counter that went DOWN counts.
 *
 * Two retards of one cylinder between two reads are one here: the counter remembers only the last,
 * and at #984's one read in eight (~3 s) that undercounts a cylinder retarded every second. A retard
 * just after a read that followed another retard within a few combustions is inside the tolerance.
 */
function knockRetards(samples: readonly LogDataPoint[], t: readonly number[], ro: readonly number[]): Retard[] {
    const out: Retard[] = [];
    KNOCK_KEYS.forEach((key, cyl) => {
        let prev: { i: number; n: number } | null = null;
        let gapSince = false;
        for (let i = 0; i < samples.length; i++) {
            const p = samples[i];
            if (p.linkGapS !== undefined) gapSince = true;
            const n = p[key];
            if (n === undefined) continue;
            if (n < KNOCK_AGE_NONE && p.rpm > 0) {
                let fresh: boolean;
                if (!prev) fresh = t[i] - (n * 120) / p.rpm >= t[0];
                else if (prev.n >= KNOCK_AGE_NONE) fresh = true;
                else if (gapSince) fresh = n < prev.n;
                else {
                    const c = ((t[i] - t[prev.i]) * (samples[prev.i].rpm + p.rpm)) / 2 / 120;
                    fresh = n < prev.n + c - Math.max(2, (1 - KNOCK_GROWTH_MIN) * c);
                }
                if (fresh) {
                    const when = Math.min(t[i], Math.max(prev ? t[prev.i] : -Infinity, t[i] - (n * 120) / p.rpm));
                    out.push({ t: when, cyl: cyl + 1, rpm: p.rpm, ro: ro[i] });
                }
            }
            prev = { i, n };
            gapSince = false;
        }
    });
    return out.sort((a, b) => a.t - b.t);
}

type EvKind = 'mark' | 'gap' | 'knock' | 'cut' | 'trimsReset' | 'gear';
/** `rank` orders a kind's events when not all of them fit: the largest cluster, the longest cut. */
interface Ev { t: number; kind: EvKind; detail: string; rank: number }

/**
 * At most `cap` events, kept across kinds rather than by one kind's order.
 *
 * Marks and link gaps always (they are the driver's and the link's own words). The rest share what is
 * left evenly, each kind taking one more slot per pass until slots or events run out — on #984 there
 * were 327 knock clusters, 111 cuts, 80 gear changes and 52 parked-trim shifts, and a list ordered by
 * kind was 60 knock clusters from the first ten minutes. Within a kind: the largest clusters and the
 * longest cuts; gear changes evenly over the run. The timeline's knock and cut columns hold the rest.
 */
function pickEvents(evs: readonly Ev[], cap: number): { chosen: Ev[]; left: Map<EvKind, number> } {
    const byTime = (a: Ev, b: Ev) => a.t - b.t;
    const always = evs.filter(e => e.kind === 'mark' || e.kind === 'gap').sort(byTime).slice(0, cap);
    const kinds: EvKind[] = ['knock', 'cut', 'trimsReset', 'gear'];
    const pools = kinds.map(k => evs.filter(e => e.kind === k));
    const take = kinds.map(() => 0);
    let slots = cap - always.length;
    while (slots > 0 && pools.some((p, i) => take[i] < p.length)) {
        for (let i = 0; i < pools.length && slots > 0; i++) if (take[i] < pools[i].length) { take[i]++; slots--; }
    }
    const chosen = [...always];
    pools.forEach((pool, i) => {
        const k = take[i];
        if (!k) return;
        if (kinds[i] === 'gear') {
            const ordered = [...pool].sort(byTime);
            const at = new Set(Array.from({ length: k }, (_, j) => (k === 1 ? 0 : Math.round((j * (ordered.length - 1)) / (k - 1)))));
            chosen.push(...[...at].map(j => ordered[j]));
        } else {
            chosen.push(...[...pool].sort((a, b) => b.rank - a.rank || a.t - b.t).slice(0, k));
        }
    });
    const picked = new Set(chosen);
    const left = new Map<EvKind, number>();
    for (const e of evs) if (!picked.has(e)) left.set(e.kind, (left.get(e.kind) ?? 0) + 1);
    return { chosen: chosen.sort(byTime), left };
}

const nearest = (axis: readonly number[], v: number) => {
    let best = axis[0];
    for (const a of axis) if (Math.abs(a - v) < Math.abs(best - v)) best = a;
    return best;
};

export function runOverview(input: RunOverviewInput, opts: RunOverviewOptions = {}): RunOverview {
    const rpmBin =num(opts.rpmBin) && opts.rpmBin >= 50 ? opts.rpmBin : RUN_RPM_BIN;
    const roBin = num(opts.roBin) && opts.roBin >= 0.1 ? opts.roBin : RUN_RO_BIN;
    const axes = opts.axes && opts.axes.rpm.length && opts.axes.ro.length ? opts.axes : null;
    const bins = axes ? 'the VE map\'s nodes, nearest on each axis' : `rpm ${rpmBin} x RO ${roBin} %, lower edges`;
    const maxBytes = num(opts.maxBytes) && opts.maxBytes >= 2000 ? opts.maxBytes : RUN_MAX_BYTES;
    const all = input.samples;
    const blank = (note: string): RunOverview => ({
        source: input.source ?? null, totals: null,
        timeline: { stepS: RUN_STEP_DEFAULT_S, columns: [], rows: [] },
        grid: { bins, otherS: 0, otherCells: 0, columns: [], rows: [] },
        events: { columns: [], rows: [] }, legend: LEGEND, notes: [note],
    });
    if (!all.length) return blank('There is no log: no run is recording and none is loaded.');

    // A Testo CSV counts milliseconds; everything here is seconds on the log's own clock.
    const spu = timeScaleSeconds(all as LogDataPoint[]);
    const T = all.map(p => p.time * spu);
    const table = input.interpolationTable;
    const RO = all.map(p => {
        if (num(p.correctedLoad)) return p.correctedLoad;
        if (!table?.length) return p.rawLoad;
        const f = interpolateFactor(p.rpm, table);
        return p.rawLoad / (f === 0 ? 1 : f);
    });
    // Over the WHOLE run, before any window: a sample's half-cycle reaches past it both ways.
    const cycling = lambdaCyclingFlags(all, input.rampParams ?? null, spu);

    const first = T[0], last = T[T.length - 1];
    if (num(opts.from) && opts.from > last) return blank(`The run ends at ${round(last, 1)} s, before ${round(opts.from, 1)} s.`);
    if (num(opts.to) && opts.to < first) return blank(`The run starts at ${round(first, 1)} s, after ${round(opts.to, 1)} s.`);
    const from = Math.max(first, num(opts.from) ? opts.from : first);
    const to = Math.min(last, num(opts.to) ? opts.to : last);
    if (to < from) return blank('That window is empty: from is after to.');
    const idx: number[] = [];
    for (let i = 0; i < all.length; i++) if (T[i] >= from && T[i] <= to) idx.push(i);
    if (!idx.length) return blank('Nothing was recorded in that window.');

    // Each sample stands for the time to the next one. Not across a link gap — that stretch has
    // nothing in it — and not past the window, so the grid's seconds plus the gaps are the window.
    const dt = new Map<number, number>();
    let gapS = 0;
    for (let k = 0; k < idx.length; k++) {
        const i = idx[k];
        const j = idx[k + 1];
        if (j === undefined) { dt.set(i, 0); continue; }
        if (all[j].linkGapS !== undefined) { gapS += T[j] - T[i]; dt.set(i, 0); continue; }
        dt.set(i, T[j] - T[i]);
    }

    const parked = all.map(parkedKind);
    const trims = all.map(trimOf);

    // --- slow-lane state, walked from the run's start so the window opens on the last read ------
    const gearAt = new Array<number | null>(all.length).fill(null);
    const loopAt = new Array<boolean | null>(all.length).fill(null);
    const gearChanges: { t: number; from: number; to: number }[] = [];
    {
        let g: { t: number; v: number } | null = null;
        let la: { t: number; closed: boolean } | null = null;
        for (let i = 0; i < all.length; i++) {
            const p = all[i];
            if (p.gear !== undefined) {
                if (g && g.v !== p.gear && T[i] >= from && T[i] <= to) gearChanges.push({ t: T[i], from: g.v, to: p.gear });
                g = { t: T[i], v: p.gear };
            }
            const banks = [p.laStEin1, p.laStEin2].filter(num);
            if (banks.length) la = { t: T[i], closed: banks.every(b => (b & 1) === 1) };
            gearAt[i] = g && T[i] - g.t <= SLOW_READ_HOLD_S ? g.v : null;
            loopAt[i] = la && T[i] - la.t <= SLOW_READ_HOLD_S ? la.closed : null;
        }
    }

    const retards = knockRetards(all, T, RO).filter(r => r.t >= from && r.t <= to);

    // --- events -------------------------------------------------------------------------------------
    const evs: Ev[] = [];
    let fuelCuts = 0, trimsResets = 0;
    for (let k = 0; k < idx.length; k++) {
        const i = idx[k];
        const p = all[i];
        if (p.mark) evs.push({ t: T[i], kind: 'mark', detail: p.mark.slice(0, 80), rank: 0 });
        if (p.linkGapS !== undefined) evs.push({ t: T[i], kind: 'gap', detail: `${round(p.linkGapS, 1)} s with nothing recorded before this`, rank: 0 });
        // One event per stretch of parked trims, at its start, with how long it lasted and the pedal.
        const kind = parked[i];
        if (kind && (k === 0 || parked[idx[k - 1]] !== kind)) {
            let span = 0;
            const pedal: number[] = [];
            for (let m = k; m < idx.length && parked[idx[m]] === kind; m++) {
                span += dt.get(idx[m])!;
                if (num(all[idx[m]].pwg1)) pedal.push(all[idx[m]].pwg1!);
            }
            const pd = median(pedal);
            if (kind === 'cut') fuelCuts++; else trimsResets++;
            evs.push({ t: T[i], kind, rank: span, detail: `${round(span, 1)} s, ${pd === null ? 'pedal not logged' : `pedal ${round(pd, 1)} %`}` });
        }
    }
    for (const g of gearChanges) evs.push({ t: g.t, kind: 'gear', detail: `${g.from} → ${g.to}`, rank: 0 });
    let knockClusters = 0;
    for (let a = 0; a < retards.length;) {
        let b = a + 1;
        while (b < retards.length && retards[b].t - retards[b - 1].t <= KNOCK_CLUSTER_S) b++;
        const group = retards.slice(a, b);
        const cyls = [...new Set(group.map(r => r.cyl))].sort((x, y) => x - y);
        const where = `${round(median(group.map(r => r.rpm))!, 0)} rpm, RO ${round(median(group.map(r => r.ro))!, 1)} %`;
        knockClusters++;
        evs.push({
            t: group[0].t, kind: 'knock', rank: group.length,
            detail: group.length === 1
                ? `cyl ${cyls[0]}: 1 retard at ${where}`
                : `cyl ${cyls.join(',')}: ${group.length} retards in ${round(group[group.length - 1].t - group[0].t, 1)} s at ${where}`,
        });
        a = b;
    }

    // --- totals -----------------------------------------------------------------------------------
    let closedS = 0, knownS = 0, cutS = 0;
    let cMin = Infinity, cMax = -Infinity, rpmMax = -Infinity;
    for (const i of idx) {
        const d = dt.get(i)!;
        if (loopAt[i] !== null) { knownS += d; if (loopAt[i]) closedS += d; }
        if (parked[i] === 'cut') cutS += d;
        const c = all[i].coolantTemp;
        if (num(c)) { cMin = Math.min(cMin, c); cMax = Math.max(cMax, c); }
        if (num(all[i].rpm)) rpmMax = Math.max(rpmMax, all[i].rpm);
    }
    const durationS = T[idx[idx.length - 1]] - T[idx[0]];
    const totals: NonNullable<RunOverview['totals']> = {
        from: round(T[idx[0]], 1), to: round(T[idx[idx.length - 1]], 1),
        durationS: round(durationS, 1), samples: idx.length,
        hz: durationS > 0 ? round((idx.length - 1) / durationS, 1) : 0,
        gapS: round(gapS, 1),
        closedLoopS: knownS > 0 ? round(closedS, 0) : null, loopKnownS: knownS > 0 ? round(knownS, 0) : null,
        coolant: cMin <= cMax ? [round(cMin, 0), round(cMax, 0)] : null,
        rpmMax: rpmMax > -Infinity ? round(rpmMax, 0) : null,
        fuelCutS: round(cutS, 1), fuelCuts, trimsResets, gearChanges: gearChanges.length,
        knockRetards: retards.length, knockClusters,
    };

    // --- grid -----------------------------------------------------------------------------------------
    const gridAcc = new Map<string, { rpm: number; ro: number; s: number; trimSum: number; trimN: number; cyc: number }>();
    for (const i of idx) {
        const rpm = axes ? nearest(axes.rpm, all[i].rpm) : Math.floor(Math.max(0, all[i].rpm) / rpmBin) * rpmBin;
        const ro = axes ? nearest(axes.ro, RO[i]) : round(Math.floor(Math.max(0, RO[i]) / roBin) * roBin, 2);
        const key = `${rpm}|${ro}`;
        const g = gridAcc.get(key) ?? { rpm, ro, s: 0, trimSum: 0, trimN: 0, cyc: 0 };
        g.s += dt.get(i)!;
        const tr = trims[i];
        if (tr !== null && parked[i] === null) {
            g.trimSum += tr; g.trimN++;
            if (cycling[i]) g.cyc++;
        }
        gridAcc.set(key, g);
    }
    const gridCells = [...gridAcc.values()].sort((a, b) => a.ro - b.ro || a.rpm - b.rpm);
    const gridAt = (minS: number): RunOverview['grid'] => {
        const folded = gridCells.filter(g => g.s < minS);
        return {
            bins, otherS: round(folded.reduce((a, g) => a + g.s, 0), 1), otherCells: folded.length,
            columns: ['rpm', 'ro', 's', 'trim', 'cyc'],
            rows: gridCells.filter(g => g.s >= minS).map(g => [g.rpm, g.ro, round(g.s, 1),
                g.trimN ? round(g.trimSum / g.trimN, 3) : null,
                g.trimN ? round(g.cyc / g.trimN, 2) : null]),
        };
    };

    // --- the timeline at a given step ----------------------------------------------------------------
    // WHY A 5-s STEP NEED NOT MIND THE LOGGER'S STAMPS. The row just after the slow-lane read carries
    // fast-lane values read ~0.19 s after the previous row but stamped 0.6-0.8 s later (a known logger
    // timing defect, not fixed here). Inside a 5-s median that misplaces one sample by under a second;
    // it matters to tuner_moment's per-sample rows, not to these.
    const timelineAt = (stepS: number): RunOverview['timeline'] => {
        const cols = ['t', 'rpm', 'ro', 'pwg', 'wdk', 'kmh', 'gear', 'trim', 'cut', 'knock'];
        const rows: Cell[][] = [];
        let k = 0;
        let r = 0;
        while (k < idx.length) {
            const start = Math.floor(T[idx[k]] / stepS) * stepS;
            const end = start + stepS;
            const span: number[] = [];
            while (k < idx.length && T[idx[k]] < end) span.push(idx[k++]);
            const pick = (f: (p: LogDataPoint) => number | undefined) => median(span.map(i => f(all[i])).filter(num));
            const tr = span.map(i => (parked[i] === null ? trims[i] : null)).filter(num);
            let gear: number | null = null;
            for (let m = span.length - 1; m >= 0 && gear === null; m--) gear = gearAt[span[m]];
            while (r < retards.length && retards[r].t < start) r++;
            let knock = 0;
            for (let m = r; m < retards.length && retards[m].t < end; m++) knock++;
            const cut = span.reduce((a, i) => a + (parked[i] === 'cut' ? dt.get(i)! : 0), 0);
            rows.push([
                round(start, 1), r0(pick(p => p.rpm)), r1(median(span.map(i => RO[i]).filter(num))),
                r1(pick(p => p.pwg1)), r1(pick(p => p.wdk1)), r0(pick(p => p.vehicleSpeed)),
                gear, tr.length ? round(tr.reduce((a, b) => a + b, 0) / tr.length, 3) : null,
                round(cut, 1), knock,
            ]);
        }
        // A column no row has a value for (a CSV with no pedal) is not sent at all, as tuner_moment
        // sends only the columns present.
        const keep = cols.map((_, c) => c === 0 || rows.some(row => row[c] !== null));
        return { stepS, columns: cols.filter((_, c) => keep[c]), rows: rows.map(row => row.filter((_, c) => keep[c])) };
    };

    // --- fit: the step to 200 rows, then the size budget: step, then the grid's small bins, then events
    const asked = num(opts.stepS) ? Math.min(600, Math.max(1, opts.stepS)) : RUN_STEP_DEFAULT_S;
    const t0 = T[idx[0]], t1 = T[idx[idx.length - 1]];
    const rowsAt = (s: number) => Math.floor(t1 / s) - Math.floor(t0 / s) + 1;
    const coarser = (s: number) => RUN_STEP_LADDER.find(x => x > s);
    let step = asked;
    while (rowsAt(step) > RUN_MAX_TIMELINE_ROWS && coarser(step) !== undefined) step = coarser(step)!;
    const byRows = step;
    const gridSteps = [GRID_MIN_S, 1, 2, 5, 10, 30];
    let gi = 0;
    let evCap = RUN_MAX_EVENTS;
    // The notes are part of what is measured: they say what was coarsened, and they cost bytes too.
    const assemble = (): RunOverview => {
        const ev = pickEvents(evs, evCap);
        const grid = gridAt(gridSteps[gi]);
        const said: string[] = [];
        if (step !== asked) {
            said.push(step === byRows
                ? `Step raised from ${asked} to ${step} s so the timeline stays within ${RUN_MAX_TIMELINE_ROWS} rows; a from/to window gives finer steps.`
                : `Step raised from ${asked} to ${step} s to keep this answer short; a from/to window gives finer steps.`);
        }
        if (grid.otherCells) said.push(`${grid.otherCells} grid bins of under ${gridSteps[gi]} s each (${grid.otherS} s in all) are counted in otherS, not listed.`);
        if (ev.left.size) {
            said.push(`Events not listed: ${[...ev.left].map(([kind, n]) => `${n} ${kind}`).join(', ')} (kept: every mark and gap, the largest knock clusters, the longest cuts, gear changes spread over the run). A from/to window lists more.`);
        }
        if (totals.closedLoopS === null) said.push('This log does not carry LA_ST_EIN, so the time with the lambda loop closed is not known.');
        return {
            source: input.source ?? null, totals, timeline: timelineAt(step), grid,
            events: { columns: ['t', 'kind', 'detail'], rows: ev.chosen.map(e => [round(e.t, 1), e.kind, e.detail]) },
            legend: LEGEND, notes: said,
        };
    };
    let out = assemble();
    for (let guard = 0; guard < 40 && JSON.stringify(out).length > maxBytes; guard++) {
        const next = coarser(step);
        if (out.timeline.rows.length > 60 && next !== undefined) step = next;
        else if (gi < gridSteps.length - 1) gi++;
        else if (evCap > 20) evCap = 20;
        else if (next !== undefined) step = next;
        else break;
        out = assemble();
    }
    if (JSON.stringify(out).length > maxBytes) out.notes.push('Still longer than the size budget at the coarsest steps.');
    return out;
}
