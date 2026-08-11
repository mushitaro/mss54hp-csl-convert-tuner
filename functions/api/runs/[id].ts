import { Env, bad, corsHeaders, preflight, requireToken } from '../../_shared';

export const onRequestOptions = () => preflight();

/**
 * D1 hands a BLOB back as a plain `number[]`, not as an ArrayBuffer.
 *
 * Both shapes are declared in the wild depending on version, and the failure when you assume the
 * wrong one is silent: `new Blob([someArray])` stringifies it, gzip refuses the result, the stream
 * errors *after* the headers are already on the wire, and the client gets 200 with an empty body.
 * Normalising is one branch; finding that was not.
 */
function toBytes(value: ArrayBuffer | number[] | Uint8Array): Uint8Array {
    if (value instanceof Uint8Array) return value;
    if (Array.isArray(value)) return Uint8Array.from(value);
    return new Uint8Array(value);
}

/**
 * GET /api/runs/:id — the log itself, as the CSV it was uploaded as.
 *
 * Inflated fully before anything is sent, rather than streamed. That is the less obvious choice and
 * it is deliberate: a stream that fails halfway has already sent 200 and its headers, so a corrupt
 * row arrives as a **truncated CSV that parses perfectly** and is simply missing the end of the
 * drive. Everything else in this codebase is built to refuse rather than to quietly shorten, and a
 * download is no place to break that. Buffering costs nothing here — the row is capped below 1 MB
 * on the way in, against a 128 MB worker.
 *
 * (The other tempting shape — return the stored bytes untouched under `content-encoding: gzip` and
 * let the browser inflate — does not work at all. workerd owns that header; a Response built with
 * an already-compressed body and the header set by hand arrives with a zero-length body and a 200.)
 */
export const onRequestGet: PagesFunction<Env, 'id'> = async ({ request, env, params }) => {
    const denied = requireToken(request, env);
    if (denied) return denied;

    const id = String(params.id);
    const row = await env.RUNS_DB
        .prepare('SELECT label, csv_gz FROM runs WHERE id = ?')
        .bind(id)
        .first<{ label: string; csv_gz: ArrayBuffer | number[] }>();

    if (!row) return bad('No such run.', 404);

    let csv: ArrayBuffer;
    try {
        const gz = toBytes(row.csv_gz);
        const stream = new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip'));
        csv = await new Response(stream).arrayBuffer();
    } catch (e) {
        return bad(`Stored run could not be decompressed: ${(e as Error).message}`, 500);
    }

    // A filename the driver will recognise, reduced to what a filesystem will accept.
    const safe = row.label.replace(/[^\w.-]+/g, '_').slice(0, 60) || 'run';

    return new Response(csv, {
        headers: {
            ...corsHeaders(),
            'content-type': 'text/csv; charset=utf-8',
            'content-disposition': `attachment; filename="${safe}.csv"`,
        },
    });
};

/**
 * DELETE /api/runs/:id — for the run that was a false start.
 *
 * Present because the alternative is a list that only grows, and a driver who stops trusting it.
 * Same token as everything else: there is one user, and a second permission tier would be
 * ceremony rather than security.
 */
export const onRequestDelete: PagesFunction<Env, 'id'> = async ({ request, env, params }) => {
    const denied = requireToken(request, env);
    if (denied) return denied;

    const result = await env.RUNS_DB.prepare('DELETE FROM runs WHERE id = ?').bind(String(params.id)).run();
    if (!result.meta.changes) return bad('No such run.', 404);
    return new Response(null, { status: 204, headers: corsHeaders() });
};
