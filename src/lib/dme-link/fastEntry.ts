/**
 * FAST READ entry — deciding which bytes of the Free Identifiers sector must survive an erase.
 *
 * The DME accepts 125000 baud only from inside a programming session, and the only way into one
 * over DS2 is a valid flash erase. karter16's insight (journal #385) is that it does not have to be
 * the erase of anything you care about: the Free Identifiers sector is exactly one 8 KB erase block
 * — the smallest thing on the device that will trip the mode — so you can erase THAT, put its
 * contents straight back, and read the 64 KB data pair thirteen times faster.
 *
 * Everything here is pure. No serial, no DS2, no clock. That is the same rule flashCounter.ts
 * follows and for a stronger reason: this module decides what is allowed to be destroyed on a
 * customer's ECU, and that decision deserves to be checkable without a cable in the loop.
 *
 * ## What must survive
 *
 * The sector holds the ECU's identity — VIN, AIF service history, ZIF/BRIF program records — and
 * the flash counter. Two facts from the 0401 disassembly make the stakes concrete:
 *
 *  - `AIF_Flash_Counter` is at image `0x4800` (`decomp/master/000200.txt`, where the master build
 *    names the symbol the slave build leaves as `DAT_00004800`).
 *  - There is a **live function pointer at `0x4884`** (`decomp/master/0030be.txt`:
 *    `if ((*aif_entry == 0xf500) || (*aif_entry == 0xf5)) { (*DAT_00004884)(); }`). It is the
 *    boot-handoff vector consulted when the counter's marker says a programming session is open.
 *    Lose it and the bootloader has nowhere to jump.
 *
 * So the 256 bytes at `0x4800` are preserved unconditionally, not because a map said they were
 * non-erased but because losing them is unrecoverable.
 *
 * ## Why a cached map is safe
 *
 * The seed backup contributes only ADDRESSES. Every byte written back is read live from the DME
 * seconds before the erase — see the caller. A stale map can therefore only cause the tool to
 * preserve a range that has since become 0xFF, which costs a few milliseconds; it can never cause
 * it to write yesterday's bytes over today's.
 */

import { ServiceBlockLayout } from './flashCounter';
import { AIF_TOTAL_LENGTH } from './identity';
import type { ServiceBlockPointers } from './serviceBlockReport';

/** The Free Identifiers sector in FULL-IMAGE coordinates, which is how the reference names its
 *  spans and how the forum posts describe them. DS2 addressing is a separate space — see
 *  `toDs2Address`. */
export const FAST_ENTRY_WINDOW = { start: 0x4000, end: 0x6000 } as const;

/** The flash counter, and the boot-handoff vector that lives 0x84 into it. Preserved on BOTH
 *  processors on every run regardless of what any map says. */
export const ALWAYS_LIVE = { start: 0x4000 + ServiceBlockLayout.counterOffset, length: 256 } as const;

export type Processor = 'master' | 'slave';

/** A run of bytes on one processor, in full-image coordinates. */
export interface Span {
    processor: Processor;
    start: number;
    length: number;
}

export type PreservationPlan =
    | { safe: true; spans: Span[]; sources: string[] }
    | { safe: false; reason: string };

/** DS2 address for a full-image address on one processor. The sector base differs per CPU
 *  (`(nibble << 20) | offset`, slave = master + 8) but the offset within it does not. */
export function toDs2Address(processor: Processor, imageAddress: number): number {
    const offset = imageAddress - FAST_ENTRY_WINDOW.start;
    if (offset < 0 || offset >= ServiceBlockLayout.master.length) {
        throw new RangeError(
            `Fast-entry image address 0x${imageAddress.toString(16)} is outside `
            + `0x${FAST_ENTRY_WINDOW.start.toString(16)}-0x${(FAST_ENTRY_WINDOW.end - 1).toString(16)}`);
    }
    return ServiceBlockLayout[processor].address + offset;
}

/**
 * Byte-granular runs of non-0xFF in one processor's 8 KB image.
 *
 * No gap tolerance: two runs separated by a single 0xFF stay separate here and are merged later
 * only if they actually touch. Merging across gaps would be a size/round-trip trade, and the place
 * to make that trade is not the place that decides what is data.
 */
export function computeNonErasedSpans(image: Uint8Array, processor: Processor): Span[] {
    const spans: Span[] = [];
    let start = -1;
    for (let i = 0; i < image.length; i++) {
        const erased = image[i] === 0xFF;
        if (!erased && start < 0) start = i;
        else if (erased && start >= 0) {
            spans.push({ processor, start: FAST_ENTRY_WINDOW.start + start, length: i - start });
            start = -1;
        }
    }
    if (start >= 0) {
        spans.push({ processor, start: FAST_ENTRY_WINDOW.start + start, length: image.length - start });
    }
    return spans;
}

/** Clips a span to the sector, or drops it. Identity pointers are absolute addresses that may point
 *  anywhere in the DME's map; only the part inside this sector is ours to preserve. */
export function clipToWindow(span: Span): Span | null {
    if (span.length <= 0) return null;
    const start = Math.max(span.start, FAST_ENTRY_WINDOW.start);
    const end = Math.min(span.start + span.length, FAST_ENTRY_WINDOW.end);
    return start >= end ? null : { processor: span.processor, start, length: end - start };
}

/** Sorts and coalesces touching or overlapping spans, per processor. Adjacency only — see
 *  computeNonErasedSpans. */
export function mergeSpans(spans: Span[]): Span[] {
    if (!spans.length) return [];
    const sorted = [...spans].sort((a, b) =>
        a.processor === b.processor ? a.start - b.start : (a.processor === 'master' ? -1 : 1));
    const out: Span[] = [];
    let cur = { ...sorted[0] };
    for (let i = 1; i < sorted.length; i++) {
        const next = sorted[i];
        const curEnd = cur.start + cur.length;
        if (next.processor === cur.processor && next.start <= curEnd) {
            cur.length = Math.max(curEnd, next.start + next.length) - cur.start;
        } else {
            out.push(cur);
            cur = { ...next };
        }
    }
    out.push(cur);
    return out;
}

/** Which processor a DS2 address falls on, or null if it is in neither sector. */
function processorForDs2(address: number): Processor | null {
    for (const processor of ['master', 'slave'] as const) {
        const base = ServiceBlockLayout[processor].address;
        if (address >= base && address < base + ServiceBlockLayout[processor].length) return processor;
    }
    return null;
}

/** An identity pointer (a DS2 address) as a span in image coordinates, if it lands in the sector. */
function pointerSpan(address: number, length: number): Span | null {
    const processor = processorForDs2(address);
    if (!processor) return null;
    const offset = address - ServiceBlockLayout[processor].address;
    return clipToWindow({ processor, start: FAST_ENTRY_WINDOW.start + offset, length });
}

export interface SeedMap {
    /** Non-0xFF runs recorded when the seed backup was taken. Addresses only — never bytes. */
    spans: Span[];
    /** Both processors must be represented. A master-only seed is a legacy shape and is refused:
     *  it would silently fail to preserve the slave sector. */
    hasMaster: boolean;
    hasSlave: boolean;
}

/**
 * The union of everything that must survive, or a refusal.
 *
 * Four sources, deliberately overlapping — this is belt-and-braces on purpose, because the cost of
 * preserving a range twice is a few milliseconds and the cost of missing one is an ECU that will
 * not boot:
 *
 *  1. the seed backup's non-0xFF map (what was there last time),
 *  2. the flash counter + boot vector (always, on both CPUs),
 *  3. the AIF block at wherever the DME's own pointer table says it is, and
 *  4. every non-zero manufacturer/identity pointer target.
 *
 * The refusals mirror the reference's, plus this app's own `hasIntactAif` check at the call site.
 * Every one of them means "we cannot enumerate what must survive", and the honest response to that
 * is to read at 9600 rather than to guess.
 */
export function buildPreservationPlan(
    seed: SeedMap | null,
    pointers: ServiceBlockPointers | null,
): PreservationPlan {
    if (!seed) return { safe: false, reason: 'no seed backup for this DME yet' };
    if (!seed.hasMaster || !seed.hasSlave) {
        return { safe: false, reason: 'the seed backup covers only one processor, so the other would not be preserved' };
    }
    if (!pointers) return { safe: false, reason: 'the DME\'s system-address table was not read' };
    if (pointers.aif === null) return { safe: false, reason: 'the AIF pointer is unavailable' };

    const spans: Span[] = [];
    const sources: string[] = [];
    const add = (label: string, candidates: (Span | null)[]) => {
        const kept = candidates.filter((s): s is Span => s !== null);
        spans.push(...kept);
        sources.push(`${label}: ${kept.length} span(s)`);
    };

    add('seed non-0xFF map', seed.spans.map(clipToWindow));
    add('flash counter + boot vector', (['master', 'slave'] as const).map(processor =>
        clipToWindow({ processor, start: ALWAYS_LIVE.start, length: ALWAYS_LIVE.length })));
    add('current AIF block', [pointerSpan(pointers.aif, AIF_TOTAL_LENGTH)]);
    // The remaining identity records. Their lengths are not published by the DME, so each is
    // preserved as a page rather than as a measured run — the seed map is what actually covers
    // their real extent, and this exists so a record that GREW since the seed still survives.
    add('identity pointer targets', [pointers.dif, pointers.zif, pointers.zifBackup, pointers.brif]
        .filter((a): a is number => a !== null && a !== 0)
        .map(a => pointerSpan(a, IDENTITY_POINTER_PAGE)));

    const merged = mergeSpans(spans);
    if (!merged.length) {
        return { safe: false, reason: 'nothing to preserve was found, which cannot be right for a healthy DME' };
    }
    return { safe: true, spans: merged, sources };
}

/**
 * How much to keep around an identity pointer whose length the DME does not publish.
 *
 * 256 bytes, and the number is a guess bounded by the fact that it does not have to be right: the
 * seed map already covers whatever these records actually occupy, because they are non-0xFF. This
 * only has to catch growth since the seed was taken, and it costs two 122-byte write telegrams per
 * pointer to be generous.
 */
export const IDENTITY_POINTER_PAGE = 256;

/** Total bytes a plan will read live and write back — what decides whether entry costs 3 s or 15. */
export function planBytes(spans: Span[]): number {
    return spans.reduce((n, s) => n + s.length, 0);
}
