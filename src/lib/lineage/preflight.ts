/**
 * The check that runs immediately before a flash: is the calibration in the ECU the one this tune
 * was actually built on?
 *
 * ## Why this exists
 *
 * `writePartialBinInner` refuses any buffer that is not exactly 65536 bytes, erases the whole data
 * area, and reprograms all of it. There is no such thing as writing part of a tune. So two sessions
 * branched from the same BASE do not combine — whichever is flashed second replaces the first
 * entirely.
 *
 * That failure is quiet in a way worth spelling out. Suppose a VE session changes only the Alpha-N
 * table and an inertia session changes only Momentenmanager and SMG constants. Their addresses do
 * not overlap at all. Both diffs are short and both look safe. Flash them in order and the second
 * one silently reverts every byte of the first, because both wrote a whole image built from a BASE
 * that predates the other. Nothing in either session's own view of itself can show this.
 *
 * The fix is not to make writes partial — the ECU does not offer that. It is to require that a
 * tune's BASE is what is in the car right now, which makes the workflow serial:
 *
 * ```
 * flash -> re-READ -> that read becomes the BASE of the next session
 * ```
 *
 * ## Why checksums and not the bytes
 *
 * A full read is ~123 s at 9600 baud. Doubling the wall time of every flash is how a safety check
 * ends up disabled, so this compares the two CRC-16/ARC values the calibration stores in itself —
 * eight bytes, two exchanges, imperceptible. The residual risk is a CRC collision between two
 * genuinely different calibrations, about one in 2^32 across the pair. That is the right side of
 * the trade for the question actually being asked, and it is not a defence against forgery.
 */

import { readStoredChecksums } from '../checksum/dmeDataChecksum';

export type LineageVerdict =
    /** The ECU holds the BASE this tune was built on. Safe to write. */
    | 'match'
    /** The ECU holds something else. Writing would discard whatever that is. */
    | 'diverged'
    /** The check could not run. Not a pass — see `LineagePreflight.blocking`. */
    | 'unknown';

export interface LineagePreflight {
    verdict: LineageVerdict;
    /** What the car reported. Null when the read failed. */
    inEcu: { slave: number; master: number } | null;
    /** What the session's BASE holds. */
    expected: { slave: number; master: number } | null;
    /**
     * Whether this result should stop the flash.
     *
     * `unknown` blocks by default and that is deliberate: "we could not tell" and "it is fine" are
     * different answers, and only one of them is safe to act on. The operator can still override —
     * the point is that overriding is a decision someone makes, not a default someone inherits.
     */
    blocking: boolean;
    /** Plain-language summary, ready to put in a confirmation dialog. */
    summary: string;
}

const hex = (n: number) => `0x${n.toString(16).toUpperCase().padStart(4, '0')}`;

/**
 * Compares what the ECU holds against the BASE a tune was derived from.
 *
 * `readFromEcu` is passed in rather than a link, so this stays testable without a transport and
 * cannot accidentally acquire the ability to write anything.
 */
export async function checkLineage(
    baseImage: ArrayBuffer | null,
    readFromEcu: () => Promise<{ slave: number; master: number }>,
): Promise<LineagePreflight> {
    if (!baseImage || baseImage.byteLength !== 65536) {
        return {
            verdict: 'unknown', inEcu: null, expected: null, blocking: true,
            summary: 'This session has no stored BASE image to compare against, so there is no way '
                + 'to tell what the flash would overwrite. Re-read the ECU and start a session from '
                + 'that read.',
        };
    }

    const expected = readStoredChecksums(new Uint8Array(baseImage));

    let inEcu: { slave: number; master: number };
    try {
        inEcu = await readFromEcu();
    } catch (e) {
        return {
            verdict: 'unknown', inEcu: null, expected, blocking: true,
            summary: `The ECU's stored checksums could not be read (${e instanceof Error ? e.message : String(e)}), `
                + 'so what the flash would overwrite is unknown. Not a pass — resolve the link first.',
        };
    }

    if (inEcu.slave === expected.slave && inEcu.master === expected.master) {
        return {
            verdict: 'match', inEcu, expected, blocking: false,
            summary: `The ECU holds the calibration this tune was built on `
                + `(slave ${hex(inEcu.slave)}, master ${hex(inEcu.master)}).`,
        };
    }

    const differing = [
        inEcu.slave !== expected.slave ? `slave ${hex(inEcu.slave)} vs ${hex(expected.slave)}` : null,
        inEcu.master !== expected.master ? `master ${hex(inEcu.master)} vs ${hex(expected.master)}` : null,
    ].filter(Boolean).join(', ');

    return {
        verdict: 'diverged', inEcu, expected, blocking: true,
        summary: `The ECU is NOT holding the calibration this tune was built on (${differing}). `
            + `A flash rewrites all 65536 bytes, so writing this would discard whatever is in the car `
            + `now — including changes made from a different session, even ones that touch completely `
            + `different addresses. Re-read the ECU and rebuild this tune on that read.`,
    };
}
