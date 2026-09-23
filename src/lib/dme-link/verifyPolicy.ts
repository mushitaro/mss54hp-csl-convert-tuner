/**
 * Which verification mode to OFFER first, per DME.
 *
 * QUICK is the default mode, and it rests on one assumption that no amount of reading the reference
 * tool can settle: that the DME recomputes its encoding checksum when asked, rather than answering
 * from a value cached at boot. If it cached, a post-write "all areas clean" would be the same answer
 * it would give for a botched write, and QUICK would be a check that always passes.
 *
 * The experiment that settles it costs one flash and can only be run on a car: write with FULL, so
 * the byte-for-byte read-back is the authority, and see whether the checksum agrees. Once those two
 * have agreed on a given ECU, the checksum has demonstrated it tracks reality on that ECU and QUICK
 * has earned its place there.
 *
 * So this is not a preference store. It records, per VIN, that the licence has been earned — and
 * until it has, the selector opens on FULL. The user can still choose QUICK; the point is that the
 * first write to an unfamiliar DME does not silently take the cheaper proof.
 *
 * Keyed by VIN because the question is about a physical ECU, not about a person or a browser. A VIN
 * we could not read is never recorded and never matched: 'UNKNOWN' is not an identity.
 */

import type { WriteVerifyMode } from './types';

const STORAGE_KEY = 'mss54hp.verifyPolicy.v1';

function load(): string[] {
    if (typeof localStorage === 'undefined') return [];
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        const parsed = raw ? JSON.parse(raw) : null;
        return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
    } catch {
        return [];
    }
}

const usable = (vin: string | null | undefined): vin is string =>
    typeof vin === 'string' && vin.length > 0 && vin !== 'UNKNOWN';

/** True once a FULL write has completed on this DME and its checksum agreed with the read-back. */
export function hasProvenQuickVerify(vin: string | null | undefined): boolean {
    return usable(vin) && load().includes(vin);
}

/**
 * Records that this DME has had a FULL write whose read-back passed AND whose encoding checksum
 * came back clean. Both halves are required by the caller — a FULL write on a DME that will not
 * answer 0x0A proves the bytes but proves nothing about the checksum, which is the thing being
 * licensed here.
 */
export function recordQuickVerifyProven(vin: string | null | undefined): void {
    if (!usable(vin) || typeof localStorage === 'undefined') return;
    const known = load();
    if (known.includes(vin)) return;
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify([...known, vin]));
    } catch { /* a full or blocked localStorage costs a repeated FULL write, which is the safe way to fail */ }
}

/** What the selector should open on for this DME. */
export function initialVerifyMode(vin: string | null | undefined): WriteVerifyMode {
    return hasProvenQuickVerify(vin) ? 'quick' : 'full';
}
