/**
 * OBSERVE — watching addresses nobody has named yet.
 *
 * The loop this serves: a tune is chasing what the driver wants, the logic behind it runs through a
 * symbol the disassembly only knows as `DAT_00ffd1a2` or `FUN_0003c2e8`, and the tune cannot go on
 * honestly until that symbol means something. So tuning stops, the owner is asked for a short run —
 * a plan of what to do and which bytes to watch while they do it — and the run records those bytes
 * raw beside rpm, load and throttle. What moved with what is the evidence a name is made from
 * (decomp-naming: "observed" is the strongest rung). Then tuning resumes.
 *
 * ## Raw bytes, and why
 *
 * An unnamed address has no size, sign or scale — those are what the run is for. Decoding it as a
 * word at 2^-8 would print a plausible number and quietly answer the question before it was asked.
 * So a watched read is stored as the hex of the bytes the DME returned (`LogDataPoint.watch`), and
 * any reading of them — u8, u16, a bit — is done on screen, labelled as a reading.
 *
 * ## Limits, and what each one protects
 *
 * - Four reads. Each costs a K-line round trip (about 50 ms for two bytes, `exchangeMs`), and an
 *   observation run with the rate of a slideshow cannot show what moved first.
 * - One to four bytes each. Enough for a word and its neighbour; a bigger window is a survey, and a
 *   survey belongs to the disassembly, not to the car.
 * - Inside a declared window (`isRamReadInRange`), checked here, again when the link is handed the
 *   list, and again before every read. Outside one the DME answers 0xB0, twice a sample.
 * - One read per address. Two reads of one address with different lengths would land in one column.
 *
 * Nothing here can write. An observation run reads; naming is done afterwards, by a person.
 */
import { Mss54HpRamWindows, isRamReadInRange } from '@/lib/dme-link/ramMap';
import { expectedHz, type LogExchange, LOG_PROFILES } from '@/lib/log-engine/logProfile';

export const OBSERVE_MAX_READS = 4;
export const OBSERVE_MAX_BYTES = 4;
export const OBSERVE_MAX_STEPS = 12;
export const OBSERVE_LANES = [1, 2, 4, 8] as const;
export type ObserveLane = (typeof OBSERVE_LANES)[number];

export interface WatchRead {
    /** 24-bit address, e.g. 0xFFD1A2. The segment follows from the window it is in. NaN while a row
     *  has been added and not yet filled in — a problem, never a default address. */
    address: number;
    /** Bytes to read, 1..OBSERVE_MAX_BYTES. */
    count: number;
    /** Read on one sample in `every`. */
    every: ObserveLane;
    /** What the operator calls it while it has no name — "DAT_00ffd1a2", "the byte FUN_3c2e8 sets". */
    label: string;
}

export interface ObservePlan {
    /** The question, in a line: "what holds back torque on a 3rd-gear tip-in". */
    title: string;
    reads: WatchRead[];
    /** What to ask the owner to do, in order, as typed — blank lines included, so an editor can hold
     *  the line being written. `activeSteps` is the list that counts. */
    steps: string[];
}

/** The steps that are steps: trimmed, blanks dropped. Numbered from 1 in that order. */
export function activeSteps(plan: ObservePlan): string[] {
    return plan.steps.map(x => x.trim()).filter(Boolean);
}

export const EMPTY_PLAN: ObservePlan = { title: '', reads: [], steps: [] };

/** The window an address sits in, or null. Decides the DS2 segment. */
export function windowOf(address: number, count = 1): { segment: number } | null {
    for (const w of Object.values(Mss54HpRamWindows)) {
        if (isRamReadInRange(w.segment, address, count)) return { segment: w.segment };
    }
    return null;
}

/** The column key for an address: six upper-case hex digits, the same in the log, the CSV and on screen. */
export function watchKey(address: number): string {
    return (address >>> 0).toString(16).toUpperCase().padStart(6, '0');
}

/** `FFD1A2`, `0xffd1a2`, `DAT_00ffd1a2` — the three ways an address arrives — or null. */
export function parseAddress(text: string): number | null {
    const m = /^\s*(?:DAT_|0x)?0*([0-9a-f]{1,8})\s*$/i.exec(text);
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return Number.isFinite(n) && n <= 0xFFFFFF ? n : null;
}

/** Bytes as the hex the log stores: `[0x0a, 0x1b]` → `0A1B`. */
export function bytesToHex(bytes: ArrayLike<number>): string {
    let out = '';
    for (let i = 0; i < bytes.length; i++) out += (bytes[i] & 0xFF).toString(16).toUpperCase().padStart(2, '0');
    return out;
}

/** The stored hex back to bytes; null for anything that is not whole bytes of hex. */
export function hexToBytes(hex: string): number[] | null {
    if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) return null;
    const out: number[] = [];
    for (let i = 0; i < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
    return out;
}

const PROBLEM_TEXT = {
    en: {
        noTitle: 'Say what the run is for — the plan has no title.',
        noReads: 'Name at least one address to watch.',
        tooMany: `At most ${OBSERVE_MAX_READS} addresses: each one is a round trip on every sample it is due.`,
        unset: (n: number) => `Address ${n}: not filled in.`,
        bytes: (at: string) => `${at}: read 1 to ${OBSERVE_MAX_BYTES} bytes.`,
        outside: (at: string, count: number) => `${at} +${count}: outside the RAM the DME serves (0xFF8000-0xFF8FFF, 0xFFD000-0xFFEFFF).`,
        lane: (at: string) => `${at}: read every 1, 2, 4 or 8 samples.`,
        twice: (at: string) => `${at}: listed twice.`,
        steps: `At most ${OBSERVE_MAX_STEPS} steps.`,
    },
    ja: {
        noTitle: '何のための観察かを書いてください（題がありません）。',
        noReads: '観察するアドレスを一つ以上入れてください。',
        tooMany: `アドレスは ${OBSERVE_MAX_READS} つまでです。一つごとに、読む回のたびに往復が一回増えます。`,
        unset: (n: number) => `アドレス ${n}：まだ入っていません。`,
        bytes: (at: string) => `${at}：読むのは 1〜${OBSERVE_MAX_BYTES} バイトです。`,
        outside: (at: string, count: number) => `${at} +${count}：DME が読ませる RAM の外です（0xFF8000-0xFF8FFF、0xFFD000-0xFFEFFF）。`,
        lane: (at: string) => `${at}：読む間隔は 1、2、4、8 サンプルのどれかです。`,
        twice: (at: string) => `${at}：二度入っています。`,
        steps: `手順は ${OBSERVE_MAX_STEPS} 個までです。`,
    },
} as const;

/** Everything wrong with a plan, in the reader's language. Empty means it can run. English is what
 *  the assistant bridge hears; the panel passes the dialogs' language. */
export function planProblems(plan: ObservePlan, lang: 'en' | 'ja' = 'en'): string[] {
    const t = PROBLEM_TEXT[lang];
    const out: string[] = [];
    if (!plan.title.trim()) out.push(t.noTitle);
    if (plan.reads.length === 0) out.push(t.noReads);
    if (plan.reads.length > OBSERVE_MAX_READS) out.push(t.tooMany);
    const seen = new Set<number>();
    plan.reads.forEach((r, i) => { if (!Number.isInteger(r.address)) out.push(t.unset(i + 1)); });
    for (const r of plan.reads.filter(x => Number.isInteger(x.address))) {
        const at = watchKey(r.address);
        if (!Number.isInteger(r.count) || r.count < 1 || r.count > OBSERVE_MAX_BYTES) {
            out.push(t.bytes(at));
        } else if (!windowOf(r.address, r.count)) {
            out.push(t.outside(at, r.count));
        }
        if (!OBSERVE_LANES.includes(r.every)) out.push(t.lane(at));
        if (seen.has(r.address)) out.push(t.twice(at));
        seen.add(r.address);
    }
    if (activeSteps(plan).length > OBSERVE_MAX_STEPS) out.push(t.steps);
    return out;
}

/** The exchanges a plan adds to block 3. Throws on a plan with problems — check it first. */
export function watchExchanges(plan: ObservePlan): LogExchange[] {
    const problems = planProblems(plan);
    if (problems.length) throw new Error(problems.join(' '));
    return plan.reads.map(r => ({
        kind: 'ram' as const,
        name: `watch ${watchKey(r.address)}`,
        segment: windowOf(r.address, r.count)!.segment,
        address: r.address,
        count: r.count,
        every: r.every,
        watch: true as const,
    }));
}

/** The full list an OBSERVE run polls: the profile's block 3, then the plan's reads. */
export function observeExchanges(plan: ObservePlan): LogExchange[] {
    return [...LOG_PROFILES.OBSERVE.exchanges, ...watchExchanges(plan)];
}

/** Expected samples per second for a plan, on the same arithmetic the run's own rate is checked against. */
export function observeHz(plan: ObservePlan): number {
    try { return expectedHz(observeExchanges(plan)); } catch { return expectedHz(LOG_PROFILES.OBSERVE.exchanges); }
}

/** The mark the first sample of a run carries, so the log says what it was for without the plan beside it. */
export function planMark(plan: ObservePlan): string {
    const reads = plan.reads.filter(r => Number.isInteger(r.address)).map(r => `${watchKey(r.address)}+${r.count}/${r.every}${r.label ? ` ${r.label}` : ''}`).join(', ');
    return `OBSERVE: ${plan.title.trim()} [${reads}]`;
}

/** The mark a step leaves when the owner says it is done. Numbered from 1, as the panel shows it. */
export function stepMark(plan: ObservePlan, index: number): string {
    return `step ${index + 1}: ${activeSteps(plan)[index] ?? ''}`.trim();
}

/** Marks on a sample, one per label — a sample can carry two when they land between the same reads. */
export function marksOf(mark: string | undefined): string[] {
    return mark ? mark.split(' | ') : [];
}

/** What the run saw at one watched address, read off the log — never stored beside it. */
export interface WatchSummary {
    key: string;
    reads: number;
    last: string | null;
    /** Smallest and largest, as the widest reading the bytes allow (u16 for two or more, else u8). */
    min: number | null;
    max: number | null;
    /** How many times the bytes differed from the read before. A flag shows a few, a counter every one. */
    changes: number;
}

export function summariseWatch(points: readonly { watch?: Record<string, string> }[], key: string): WatchSummary {
    let reads = 0, changes = 0;
    let last: string | null = null;
    let min: number | null = null, max: number | null = null;
    for (const p of points) {
        const hex = p.watch?.[key];
        if (!hex) continue;
        reads++;
        if (last !== null && hex !== last) changes++;
        last = hex;
        const r = readings(hex);
        if (!r) continue;
        const v = r.u16 ?? r.u8;
        min = min === null ? v : Math.min(min, v);
        max = max === null ? v : Math.max(max, v);
    }
    return { key, reads, last, min, max, changes };
}

/** Readings of watched bytes, for the screen only — every one of them is a guess the run is testing. */
export function readings(hex: string): { u8: number; u16?: number; s16?: number } | null {
    const b = hexToBytes(hex);
    if (!b || b.length === 0) return null;
    if (b.length < 2) return { u8: b[0] };
    const u16 = (b[0] << 8) | b[1];
    return { u8: b[0], u16, s16: u16 > 0x7FFF ? u16 - 0x10000 : u16 };
}

/**
 * PRACTICE's made-up bytes for one watched read — see MockDmeLink.withWatch for why they are made up
 * and say so. One of four plainly synthetic shapes, picked by the address so it is stable across
 * runs: a word that is the rpm, a byte that follows load, a flag that sets with the throttle shut,
 * a free-running counter. Bytes past the meaningful ones are a constant. Here rather than in the
 * mock so the shapes can be checked without loading a link.
 */
export function practiceWatchBytes(
    address: number, count: number, sampleIndex: number,
    sample: { rpm: number; rawLoad: number; wdk1?: number },
): number[] {
    const bytes = new Array<number>(count).fill(0).map((_, i) => (address + i) & 0xFF);
    const rpm = Math.max(0, Math.round(sample.rpm));
    switch (practiceShape(address)) {
        case 'rpm': bytes[0] = (rpm >> 8) & 0xFF; if (count > 1) bytes[1] = rpm & 0xFF; break;
        case 'load': bytes[0] = Math.max(0, Math.min(255, Math.round(sample.rawLoad * 2))); break;
        case 'flag': bytes[0] = (sample.wdk1 ?? 0) < 2 ? 0x21 : 0x01; break;
        case 'counter': bytes[0] = sampleIndex & 0xFF; break;
    }
    return bytes;
}

/** Which made-up shape PRACTICE gives an address. */
export function practiceShape(address: number): 'rpm' | 'load' | 'flag' | 'counter' {
    return (['rpm', 'load', 'flag', 'counter'] as const)[((address >> 1) ^ (address >> 4)) & 3];
}
