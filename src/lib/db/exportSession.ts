/**
 * A session, as one file, with no server in it.
 *
 * The `analyze:*` scripts replay a real run through the real code, and until now the only way to
 * get one off a device was the upload endpoint: query D1, decompress three columns, write three
 * files. That made a local check depend on a remote store — and on this build's token — for no
 * reason other than that the sync path happened to already assemble the pieces.
 *
 * This assembles the same pieces and hands them straight to the user. Deliberately in `lib/db`
 * rather than beside the sync client: it imports nothing from `session-sync`, so the analysis route
 * keeps working in a build that has no upload at all.
 *
 * ## The shape
 *
 * One object rather than three files. Three downloads in a row is a popup-blocker prompt on every
 * browser that has one, and the three pieces are only meaningful together — a log without the BASE
 * it was recorded against cannot be replayed, which is the whole point of exporting it.
 *
 * Binaries are base64 because JSON has no bytes. Same encoding the wire uses, so a bundle and an
 * uploaded row decode through identical code.
 */

import type { TuningSession, SessionLogRecord } from './schema';
import { getSessionLogRecord, getSessionBinaries } from './sessionRepository';

export interface SessionBundle {
    /** Bumped only for a change that an older reader would MISREAD, never for an added field. */
    format: 1;
    session: TuningSession;
    /** Null when the session holds no samples of either kind. */
    log: SessionLogRecord | null;
    /** Null when no BASE has been set yet. `tuned` is null until the session has one. */
    binaries: { base: string; tuned: string | null } | null;
}

function toBase64(bytes: Uint8Array): string {
    // Chunked: `String.fromCharCode(...bytes)` on a 64 KB image blows the argument limit on some
    // engines, and the failure is a RangeError at export time rather than anything a caller can see
    // coming.
    let out = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
        out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(out);
}

export async function buildSessionBundle(session: TuningSession): Promise<SessionBundle> {
    const [log, binaries] = await Promise.all([
        // The whole record, not the `LogDataPoint` projection: `idle` has no representation in that
        // projection, so exporting it would hand the analyser a run its own tuner cannot read.
        getSessionLogRecord(session.id),
        getSessionBinaries(session.id),
    ]);
    return {
        format: 1,
        session,
        log,
        binaries: binaries ? {
            base: toBase64(new Uint8Array(binaries.baseBinaryBuffer)),
            tuned: binaries.tunedBinaryBuffer ? toBase64(new Uint8Array(binaries.tunedBinaryBuffer)) : null,
        } : null,
    };
}
