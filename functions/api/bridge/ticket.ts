import { ownerOf, unauthorized } from '../../_shared';

/**
 * POST /api/bridge/ticket — sixty seconds' admission to the assistant bridge, for the owner the
 * gate just verified.
 *
 * The bridge (TSUNAGI///Matrix, matrix-tsunagi/bridge) is a Worker on another origin, so the tab's
 * socket cannot carry this origin's HttpOnly cookie — and it should not go through the gate anyway:
 * the gate rewraps every response it passes, which is not something a WebSocket upgrade survives.
 * So the gate's side vouches for the owner here, and the tab hands what it gets to the bridge in
 * the WebSocket subprotocol list (never the URL).
 *
 *     v1.<base64url(JSON {o: owner id, a: 'tuner', e: expiry, n: nonce})>.<base64url(HMAC-SHA256)>
 *
 * The copy of this format that VERIFIES is matrix-tsunagi/bridge/src/ticket.ts; change both.
 * BRIDGE_TICKET_SECRET is set on this project and on the bridge, piped, never printed.
 *
 * POST rather than GET so the gate's own-origin rule for writes applies: another site cannot mint
 * a ticket with the owner's cookie by putting this URL in an <img>.
 */

interface BridgeEnv {
    BRIDGE_TICKET_SECRET?: string;
    /** wss://…/tab on the bridge. A var in wrangler.jsonc, so the client needs no build-time URL. */
    BRIDGE_TAB_URL?: string;
}

const TTL_S = 60;

const enc = new TextEncoder();
const b64url = (bytes: Uint8Array) => {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export async function mintTicket(secret: string, owner: string, nowSec: number): Promise<string> {
    const n = b64url(crypto.getRandomValues(new Uint8Array(9)));
    const payload = b64url(enc.encode(JSON.stringify({ o: owner, a: 'tuner', e: Math.floor(nowSec) + TTL_S, n })));
    const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`v1.${payload}`)));
    return `v1.${payload}.${b64url(sig)}`;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' },
});

export const onRequestPost: PagesFunction<BridgeEnv> = async ({ env, data }) => {
    const owner = ownerOf(data as Record<string, unknown>);
    if (!owner) return unauthorized();
    const secret = env.BRIDGE_TICKET_SECRET;
    const url = env.BRIDGE_TAB_URL;
    // Not configured is said as such, so the panel can tell "this build has no bridge" from "down".
    if (!secret || secret.length < 32 || !url) return json({ error: 'bridge_unavailable' }, 503);
    return json({ ticket: await mintTicket(secret, owner.id, Date.now() / 1000), url, ttl: TTL_S });
};
