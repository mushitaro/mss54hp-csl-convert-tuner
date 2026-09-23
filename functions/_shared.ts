/**
 * Shared pieces for the SYNC API.
 *
 * Four handlers over two tables; what lives here is the part that has to behave identically across
 * them, because "the owner check is slightly different on this route" is the shape of the bug
 * nobody finds.
 *
 * ## Who is asking
 *
 * Not a token any more. The whole origin sits behind the owner gate (`_middleware.ts`), which has
 * already confirmed with m3 that the browser holds `owner_preview` and put that account on
 * `context.data.owner`. The handlers read it through `ownerOf()` and nothing else — never an id the
 * client sent — and every query carries `owner = ?`. A request that reached a handler without one
 * is refused with 401: the gate is what makes a request authentic, so its absence is never "open".
 *
 * The shared UPLOAD_TOKEN, the `*` CORS headers that let a bench rig on another port use it, and
 * the preflight handlers are gone with it. Everything is same-origin now, with the gate's session
 * cookie, and the gate refuses a state-changing /api request from any other origin.
 */
export { ownerOf, rowBytes, MAX_ROW_BYTES, unauthorized, tooLarge, conflict } from './_owner-gate/owner';
import { json } from './_owner-gate/owner';

export interface Env {
    RUNS_DB: D1Database;
    /** The gate's client secret on m3. Read by `_middleware.ts`, never here. */
    M3_CLIENT_SECRET?: string;
}

/**
 * D1 refuses a single value over 1,000,000 bytes. Stop short of it and say so, rather than letting
 * the driver believe a run was saved: this endpoint's whole job is to be the place a log survives
 * the walk back from the car, and a row that failed to insert looks exactly like one that did.
 *
 * Per part — and the ROW as a whole is checked against MAX_ROW_BYTES as well: three parts each under
 * this still sum past D1's 2 MB row limit, and D1 says that only as a 500.
 */
export const MAX_GZ_BYTES = 900_000;

export const ok = (body: unknown) => json(body, 200);
export const bad = (message: string, status = 400) => json({ error: message }, status);
export const noContent = () => new Response(null, { status: 204, headers: { 'cache-control': 'private, no-store' } });

/**
 * A stored BLOB, back out as base64.
 *
 * D1 hands a BLOB back as a plain `number[]`, not an ArrayBuffer, and both shapes are declared in
 * the wild depending on version. Assuming the wrong one fails silently — the stream errors after the
 * headers are on the wire and the client gets 200 with an empty body — so all three are handled.
 *
 * Shared rather than copied per route: it is subtle in exactly the way that does not announce
 * itself, and a second copy is a second chance to get the 0x8000-byte chunking wrong on the payload
 * large enough for `String.fromCharCode(...bytes)` to throw.
 */
export function blobToBase64(value: ArrayBuffer | number[] | Uint8Array | null | undefined): string | null {
    if (value === null || value === undefined) return null;
    const bytes = value instanceof Uint8Array ? value
        : Array.isArray(value) ? Uint8Array.from(value)
            : new Uint8Array(value);
    const CHUNK = 0x8000;
    let binary = '';
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
}

/** base64 → bytes, with the gzip-magic check every upload route needs. */
export function decodeBase64(b64: string): Uint8Array {
    const binary = atob(b64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
}

/** gzip starts 1f 8b. Checked because a payload that will not inflate months from now is
 *  indistinguishable from one that was never uploaded. */
export const isGzip = (b: Uint8Array) => b.byteLength >= 3 && b[0] === 0x1f && b[1] === 0x8b;
