/**
 * Windows of bytes a write MUST have changed — the evidence a quick verify can actually stand on.
 *
 * ## Why the checksum status byte is not enough
 *
 * On 2026-08-22 a real write ran end to end: LOGIN, ERASE acknowledged in 1166 ms, 330 write
 * telegrams each answered "programming OK", FINALIZE, encoding checksum clean (0x00). The next
 * drive's physics said the DME was still running the OLD table — the gate-shut rf_korr identity
 * read 1.000 against the pre-write image and 1.011 against what was "written". Every check the
 * quick verify made had passed, because every check it made was one the old image also satisfies:
 * the old image has valid checksums too. A hollow write — acknowledged, discarded — is invisible
 * to a status byte. (The same path, same code, had landed byte-perfect two days earlier at
 * 125000 baud: session #908's flash sha matched the next day's read exactly. The failure is not
 * the telegram format; it is that nothing ever LOOKED.)
 *
 * The only evidence that programming happened is reading back bytes that HAD TO change and
 * finding the new values. The caller is the one who knows what the car held before — the image it
 * read — and what it just sent, so the caller computes the windows and the link reads them back.
 * Full verify needs none of this: it reads back everything.
 */

export interface SpotWindow {
    /** Offset into the written partial (NOT a bus address — the link maps regions itself). */
    offset: number;
    length: number;
}

/**
 * Up to `maxWindows` windows, `width` bytes each, centred on bytes where `after` differs from
 * `before`: the first difference, the last, and the one nearest the midpoint between them.
 * Overlapping windows merge. No differences — a write that changes nothing — yields none, and the
 * caller should say so rather than pretend a spot check proved anything.
 */
export function diffWindows(before: Uint8Array, after: Uint8Array, width = 16, maxWindows = 3): SpotWindow[] {
    const n = Math.min(before.length, after.length);
    const diffs: number[] = [];
    // First and last by scanning from both ends; the middle needs the candidates, so collect all
    // diff indices only between the outer two (bounded, and 64 KB is trivial anyway).
    let first = -1, last = -1;
    for (let i = 0; i < n; i++) if (before[i] !== after[i]) { first = i; break; }
    if (first === -1) return [];
    for (let i = n - 1; i >= first; i--) if (before[i] !== after[i]) { last = i; break; }
    const mid = (first + last) >> 1;
    let nearest = first, best = Math.abs(first - mid);
    for (let i = first; i <= last; i++) {
        if (before[i] !== after[i]) {
            const d = Math.abs(i - mid);
            if (d < best) { best = d; nearest = i; }
            diffs.push(i);
            if (i >= mid && d > best) break; // past the midpoint and receding — nearest is found
        }
    }
    const anchors = [...new Set([first, nearest, last])].slice(0, maxWindows).sort((a, b) => a - b);
    const windows = anchors.map(i => {
        const start = Math.max(0, Math.min(i - (width >> 1), n - width));
        return { offset: start, length: Math.min(width, n - start) };
    });
    // Merge overlaps so the link never reads the same bytes twice.
    const merged: SpotWindow[] = [];
    for (const w of windows) {
        const prev = merged[merged.length - 1];
        if (prev && w.offset <= prev.offset + prev.length) {
            prev.length = Math.max(prev.length, w.offset + w.length - prev.offset);
        } else {
            merged.push({ ...w });
        }
    }
    return merged;
}
