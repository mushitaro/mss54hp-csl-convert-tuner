/**
 * A moment of the drive, cut out of the log for the assistant: "torque just dropped — what was it?"
 *
 * The driver asks seconds after the fact, by voice, through a phone, a relay and a model, so the
 * moment is never a timestamp. It is a WINDOW on this tab's own clock, counted back from when the
 * question arrived (`secondsAgo`, the assistant's estimate of that delay), wide enough to hold the
 * event and some of either side. Nothing here assumes the phone's clock or the head unit's agree.
 *
 * What comes back is meant to be read by a model and then spoken: a compact table (one row per
 * sample, columns named once, time relative to the moment) and the events this file can find in it
 * without guessing at causes —
 *
 *   accelLoss   rpm stopped climbing as fast while the throttle was held: the felt "loss"
 *   knock       a cylinder's knock counter says it was retarded, and WHEN — a counter of n read at
 *               r rpm means the last retard was n * 120 / r seconds before the read (one count is
 *               one combustion of that cylinder; 1275 means none for ~60 s; ramMap.ts KNOCK_AGE)
 *   angleLow    one cylinder fired well below the others on the same read
 *   gear        the gear changed
 *   fuelCut     both trims exactly 1.000 with the throttle shut: the injectors were off
 *   throttle    the pedal moved more than a few points between two samples
 *   linkGap     nothing was recorded for that long before this sample
 *
 * Pure: samples in, a plain object out. verify:assistant-bridge pins it.
 */
import type { LogDataPoint } from '@/lib/types';

/** Counter value meaning "no retard for as long as the counter can remember" (~60 s). */
export const KNOCK_AGE_NONE = 1275;
/** A cylinder this far below the median of the others on one read is "low", degrees. */
export const ANGLE_LOW_DEG = 1.5;
/** Throttle held: the pedal moved no more than this between two samples, points. */
export const THROTTLE_HELD_PTS = 3;
/** Pedal moved: more than this between two samples, points. */
export const THROTTLE_MOVED_PTS = 6;
/** The smallest drop in rpm rate counted as a loss, rpm/s — well above the noise of 40-rpm steps. */
export const ACCEL_LOSS_RPM_S = 400;
/** Rows handed to the assistant at most; slow-lane and gap rows are always kept. */
export const MAX_ROWS = 120;

export interface MomentEvent {
    /** Seconds relative to the moment (negative = before it). */
    t: number;
    kind: 'accelLoss' | 'knock' | 'angleLow' | 'gear' | 'fuelCut' | 'throttle' | 'linkGap';
    detail: string;
}

export interface Moment {
    /** Where the window came from. */
    source: 'live run' | 'loaded log';
    /** Seconds before the question the moment was taken to be. */
    secondsAgo: number;
    windowS: number;
    /** Log time of the moment, seconds, on the tab's clock. */
    at: number;
    /** How many samples the window held, and how many rows came back. */
    samples: number;
    columns: string[];
    rows: (number | null)[][];
    events: MomentEvent[];
    /** Said when the window could not be what was asked for. */
    notes: string[];
}

const COLUMNS: { name: string; get: (p: LogDataPoint) => number | undefined; digits: number }[] = [
    { name: 'rpm', get: p => p.rpm, digits: 0 },
    { name: 'aq_rel', get: p => p.rawLoad, digits: 2 },
    { name: 'wdk', get: p => p.wdk1, digits: 1 },
    { name: 'rf', get: p => p.rf, digits: 1 },
    { name: 'stft1', get: p => p.stft1, digits: 3 },
    { name: 'stft2', get: p => p.stft2, digits: 3 },
    { name: 'gear', get: p => p.gear, digits: 0 },
    { name: 'kmh', get: p => p.vehicleSpeed, digits: 0 },
    { name: 'egt', get: p => p.exhaustTemp, digits: 0 },
    ...[1, 2, 3, 4, 5, 6].map(n => ({ name: `tz${n}`, get: (p: LogDataPoint) => p[`ignitionAngle${n}` as keyof LogDataPoint] as number | undefined, digits: 1 })),
    ...[1, 2, 3, 4, 5, 6].map(n => ({ name: `knockAge${n}`, get: (p: LogDataPoint) => p[`knockAge${n}` as keyof LogDataPoint] as number | undefined, digits: 0 })),
    { name: 'krSum', get: p => p.krDtzSum, digits: 1 },
    { name: 'kaSum', get: p => p.kaDtzSum, digits: 1 },
    { name: 'linkGapS', get: p => p.linkGapS, digits: 1 },
];

const round = (v: number, digits: number) => Number(v.toFixed(digits));

const angles = (p: LogDataPoint): number[] | null => {
    const a = [p.ignitionAngle1, p.ignitionAngle2, p.ignitionAngle3, p.ignitionAngle4, p.ignitionAngle5, p.ignitionAngle6];
    return a.every(v => typeof v === 'number') ? a as number[] : null;
};
const ages = (p: LogDataPoint): (number | undefined)[] =>
    [p.knockAge1, p.knockAge2, p.knockAge3, p.knockAge4, p.knockAge5, p.knockAge6];

const median = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/**
 * The window around a moment.
 *
 * @param samples   the run (or loaded log), oldest first, time in seconds
 * @param nowLogTime the tab's clock "now", in the samples' time — for a live run, the last sample's
 *                   time plus how long ago it arrived; for a loaded log, its last sample's time
 */
export function cutMoment(input: {
    samples: readonly LogDataPoint[];
    nowLogTime: number;
    secondsAgo?: number;
    windowS?: number;
    source: Moment['source'];
}): Moment {
    const secondsAgo = clamp(input.secondsAgo ?? 8, 0, 900);
    const windowS = clamp(input.windowS ?? 20, 4, 120);
    const at = input.nowLogTime - secondsAgo;
    const from = at - windowS / 2;
    const to = at + windowS / 2;
    const notes: string[] = [];
    const all = input.samples;
    const inWin = all.filter(p => p.time >= from && p.time <= to);

    if (all.length === 0) notes.push('There is no log on this tab yet.');
    else if (inWin.length === 0) {
        const first = all[0].time;
        const last = all[all.length - 1].time;
        notes.push(at < first
            ? `The log starts ${round(first - at, 1)} s after that moment.`
            : `Nothing was recorded in that window; the last sample is ${round(at - last, 1)} s before it.`);
    }

    const events: MomentEvent[] = [];
    const rel = (t: number) => round(t - at, 2);

    // Events read from consecutive pairs. The sample just before the window counts as the first
    // predecessor, so an event on the window's first sample is not lost.
    const startIdx = inWin.length ? all.indexOf(inWin[0]) : -1;
    const span = startIdx > 0 ? all.slice(startIdx - 1, startIdx + inWin.length) : [...inWin];
    // The rpm rates of the last second that were taken with the throttle held and in one gear: the
    // baseline a loss is measured against. A median over a second, not the single previous pair, so
    // the spike as rpm catches up after a lift (or a 40-rpm quantisation step) is not a "loss".
    let recent: { t: number; rate: number }[] = [];
    let lossOpen = false;
    for (let i = 1; i < span.length; i++) {
        const a = span[i - 1];
        const b = span[i];
        const dt = b.time - a.time;
        if (b.linkGapS !== undefined) {
            events.push({ t: rel(b.time), kind: 'linkGap', detail: `nothing recorded for ${round(b.linkGapS, 1)} s before this sample: the link dropped and reconnected` });
            recent = [];
            continue;
        }
        if (!(dt > 0) || dt > 2) { recent = []; continue; }
        const rate = (b.rpm - a.rpm) / dt;
        const dWdk = (a.wdk1 !== undefined && b.wdk1 !== undefined) ? b.wdk1 - a.wdk1 : undefined;
        if (dWdk !== undefined && Math.abs(dWdk) > THROTTLE_MOVED_PTS) {
            events.push({ t: rel(b.time), kind: 'throttle', detail: `throttle ${round(a.wdk1!, 1)} → ${round(b.wdk1!, 1)} %` });
        }
        const held = dWdk !== undefined && Math.abs(dWdk) <= THROTTLE_HELD_PTS && (b.wdk1 ?? 0) >= 15;
        const sameGear = a.gear === undefined || b.gear === undefined || a.gear === b.gear;
        recent = recent.filter(r => b.time - r.t <= 1.0);
        if (held && sameGear) {
            const base = recent.length >= 2 ? median(recent.map(r => r.rate)) : null;
            const loss = base !== null && base > 0 && base - rate >= ACCEL_LOSS_RPM_S;
            // One event per loss, at its start: the samples that stay down are the same loss.
            if (loss && !lossOpen) {
                events.push({
                    t: rel(b.time), kind: 'accelLoss',
                    detail: `rpm rate fell from ${round(base, 0)} to ${round(rate, 0)} rpm/s at ${round(b.rpm, 0)} rpm with the throttle held at ${round(b.wdk1!, 1)} %`,
                });
            }
            lossOpen = loss;
            recent.push({ t: b.time, rate });
        } else {
            recent = [];
            lossOpen = false;
        }
        if (a.gear !== undefined && b.gear !== undefined && a.gear !== b.gear) {
            events.push({ t: rel(b.time), kind: 'gear', detail: `gear ${a.gear} → ${b.gear}` });
        }
        if (b.stft1 === 1 && b.stft2 === 1 && (b.wdk1 ?? 100) < 2 && !(a.stft1 === 1 && a.stft2 === 1 && (a.wdk1 ?? 100) < 2)) {
            events.push({ t: rel(b.time), kind: 'fuelCut', detail: 'both trims at exactly 1.000 with the throttle shut: overrun fuel cut' });
        }
    }

    // Knock: each read places a retard in time, which may fall between reads — or before the window
    // opened, in which case it is not this moment's.
    const seen = new Set<string>();
    for (const p of inWin) {
        const ag = ages(p);
        if (!(p.rpm > 0)) continue;
        ag.forEach((n, i) => {
            if (n === undefined || n >= KNOCK_AGE_NONE) return;
            const when = p.time - (n * 120) / p.rpm;
            if (when < from || when > to) return;
            const key = `${i}:${Math.round(when * 4)}`;
            if (seen.has(key)) return;
            seen.add(key);
            events.push({
                t: rel(when), kind: 'knock',
                detail: `cylinder ${i + 1} retarded by knock control (counter ${n} at ${round(p.rpm, 0)} rpm, read ${round(p.time - when, 1)} s later)`,
            });
        });
        const a = angles(p);
        if (a) {
            a.forEach((v, i) => {
                const others = median(a.filter((_, j) => j !== i));
                if (others - v >= ANGLE_LOW_DEG) {
                    events.push({ t: rel(p.time), kind: 'angleLow', detail: `cylinder ${i + 1} fired at ${round(v, 1)}°, ${round(others - v, 1)}° below the others` });
                }
            });
        }
    }
    events.sort((x, y) => x.t - y.t);

    // Rows: every slow-lane and gap row, the rest thinned evenly to fit.
    const keep = (p: LogDataPoint) => p.linkGapS !== undefined || p.knockAge1 !== undefined || p.ignitionAngle1 !== undefined || p.krDtzSum !== undefined;
    let rowsSrc = inWin;
    if (inWin.length > MAX_ROWS) {
        const pinned = inWin.filter(keep).length;
        const stride = Math.max(1, Math.ceil((inWin.length - pinned) / Math.max(1, MAX_ROWS - pinned)));
        let k = 0;
        rowsSrc = inWin.filter(p => keep(p) || (k++ % stride === 0));
        notes.push(`${inWin.length} samples thinned to ${rowsSrc.length} rows; every row carrying ignition, knock or a link gap is kept.`);
    }
    const used = COLUMNS.filter(c => rowsSrc.some(p => c.get(p) !== undefined));
    const columns = ['t', ...used.map(c => c.name)];
    const rows = rowsSrc.map(p => [rel(p.time), ...used.map(c => {
        const v = c.get(p);
        return typeof v === 'number' && Number.isFinite(v) ? round(v, c.digits) : null;
    })]);

    return {
        source: input.source, secondsAgo, windowS, at: round(at, 2),
        samples: inWin.length, columns, rows, events, notes,
    };
}

function clamp(v: number, lo: number, hi: number) {
    return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo;
}
