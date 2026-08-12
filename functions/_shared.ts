/**
 * Shared pieces for the run-upload API.
 *
 * The whole API is four handlers over one table; what lives here is the part that has to behave
 * identically across them, because "the token check is slightly different on this route" is the
 * shape of the bug nobody finds.
 */

export interface Env {
    RUNS_DB: D1Database;
    /** Shared secret. Set with `wrangler pages secret put UPLOAD_TOKEN`. */
    UPLOAD_TOKEN?: string;
}

/**
 * D1 refuses a single value over 1,000,000 bytes. Stop short of it and say so, rather than letting
 * the driver believe a run was saved: this endpoint's whole job is to be the place a log survives
 * the walk back from the car, and a row that failed to insert looks exactly like one that did.
 */
export const MAX_GZ_BYTES = 900_000;

const json = (body: unknown, status: number, extra: HeadersInit = {}) =>
    new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json; charset=utf-8', ...corsHeaders(), ...extra },
    });

export const ok = (body: unknown) => json(body, 200);
export const bad = (message: string, status = 400) => json({ error: message }, status);

/**
 * `*`, and safe here because authentication is a bearer token rather than a cookie.
 *
 * A wildcard origin only becomes dangerous when the browser attaches ambient credentials on the
 * caller's behalf — there are none: no cookies are set, and the token has to be typed into this
 * app and put in a header by its own code. What the wildcard buys is the local bench rig, where
 * the Next dev server is on :5054 and the functions on :8788, and the thing being tested is the
 * upload path rather than the origin policy.
 */
export function corsHeaders(): Record<string, string> {
    return {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'authorization, content-type',
        'access-control-max-age': '86400',
    };
}

export const preflight = () => new Response(null, { status: 204, headers: corsHeaders() });

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

/**
 * Length-independent comparison.
 *
 * Timing attacks over the public internet against a token this short are not a realistic threat,
 * and this still costs nothing. The reason it is written out rather than using `===` is the length
 * check: comparing lengths first leaks the token's length to anyone who can measure, and the
 * obvious fix (`a.length !== b.length && return false`) is exactly that leak.
 */
function constantTimeEqual(a: string, b: string): boolean {
    const enc = new TextEncoder();
    const x = enc.encode(a);
    const y = enc.encode(b);
    let diff = x.length ^ y.length;
    const n = Math.max(x.length, y.length);
    for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
    return diff === 0;
}

/**
 * `null` when the caller is authorised; a Response to return otherwise.
 *
 * Reads on this API are gated too. A run carries a VIN, a software version and where the car was
 * driven hard enough to reach 80 % filling — none of it catastrophic, none of it something to hand
 * to anyone who guesses the project name either.
 */
export function requireToken(request: Request, env: Env): Response | null {
    if (!env.UPLOAD_TOKEN) {
        // Refuse rather than fall open. A deployment that forgot the secret would otherwise be an
        // unauthenticated write endpoint that looks like it is working.
        return bad('This deployment has no UPLOAD_TOKEN configured.', 503);
    }
    const header = request.headers.get('authorization') ?? '';
    const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
    return constantTimeEqual(presented, env.UPLOAD_TOKEN) ? null : bad('Unauthorized.', 401);
}
