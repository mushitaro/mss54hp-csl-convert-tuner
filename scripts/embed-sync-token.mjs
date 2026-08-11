/**
 * Puts the sync token into the preview build, so nobody has to type it.
 *
 * ## The problem this fixes
 *
 * The token was generated locally and set with `wrangler pages secret put UPLOAD_TOKEN`. It was
 * never shown to anybody — which was the right instinct about secrets and the wrong outcome here,
 * because the app then asked the driver to type a 32-character string that no screen had ever
 * displayed. The store was, in practice, unreachable: a feature gated on knowledge that did not
 * exist. Typing it on a phone keyboard, in a garage, would not have been much better.
 *
 * ## What this trades away, stated plainly
 *
 * A token inside a public bundle is not a secret from anyone who can load the page. This stops
 * scanners that hit `/api` without ever fetching the HTML, and it stops nothing else. Call it a
 * lock on a door that is standing open.
 *
 * That is an acceptable trade for THIS deployment and would not be for another: the preview holds
 * one car's drive logs and a Community Patch BIN that is already public, on an unlinked subdomain.
 * What the token still does buy is that the DELETE and POST routes are not open to a passing
 * crawler, which is the half that could actually destroy something.
 *
 * PRODUCTION IS NOT AFFECTED. `npm run build` never runs this — production is static, has no
 * functions and no `/api` at all. Only `build:preview` calls it.
 *
 * Rotating: `wrangler pages secret put UPLOAD_TOKEN` (both the default and `--env preview`), write
 * the new value to `.upload-token.local`, redeploy. The old bundle stops working at that moment,
 * which is what rotation is supposed to mean.
 *
 * ## Why it runs BEFORE gen-sw.mjs
 *
 * Same reason as brand-preview.mjs: gen-sw hashes the built bytes for the cache name. Patch after
 * it and a rotated token would ship under the cache name of the build that had the old one, and the
 * device would keep serving the old HTML from disk. Rotation has to change the cache name, and it
 * does — because it changes the bytes this script writes.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const OUT = 'out';

/** The environment wins, so CI can supply it without a file on disk. */
const TOKEN_FILE = '.upload-token.local';

function readToken() {
    const fromEnv = (process.env.UPLOAD_TOKEN ?? '').trim();
    if (fromEnv) return { token: fromEnv, source: '$UPLOAD_TOKEN' };
    try {
        const fromFile = readFileSync(TOKEN_FILE, 'utf8').trim();
        if (fromFile) return { token: fromFile, source: TOKEN_FILE };
    } catch {
        // Absent is a normal state on a machine that has never deployed. Fall through.
    }
    return null;
}

const found = readToken();

if (!found) {
    // Not fatal. A build without a token is a working app whose store asks to be configured by
    // hand, which is exactly what it did before this script existed — and failing the build would
    // make the token a requirement for producing a bundle that does not need one.
    console.warn(
        `[embed-sync-token] no token in $UPLOAD_TOKEN or ${TOKEN_FILE} — building without one.\n`
        + '                   The session store will ask for it to be entered by hand.'
    );
    process.exit(0);
}

// HTML-escaped even though the token is url-safe base64 today: the escaping costs nothing, and the
// day somebody generates one with a quote in it is not the day to discover this assumed otherwise.
const escaped = found.token.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

function htmlFiles(dir) {
    return readdirSync(dir).flatMap(entry => {
        const full = join(dir, entry);
        return statSync(full).isDirectory() ? htmlFiles(full)
            : extname(full) === '.html' ? [full] : [];
    });
}

let patched = 0;
for (const file of htmlFiles(OUT)) {
    const before = readFileSync(file, 'utf8');
    if (before.includes('name="sync-token"')) continue;   // idempotent: a re-run must not stack tags
    const after = before.replace(/<\/head>/, `<meta name="sync-token" content="${escaped}"></head>`);
    if (after !== before) { writeFileSync(file, after); patched++; }
}

// The value is never printed. Its length is, because "did the right file get read" is the question
// this line exists to answer and the length answers it without putting the secret in a build log.
console.log(`[embed-sync-token] ${found.token.length} chars from ${found.source} -> ${patched} document(s)`);
