/**
 * Refuses unless what is about to be uploaded to the preview project is behind the owner gate.
 *
 *   node scripts/assert-gated.mjs <out-dir>
 *
 * Run by deploy-preview.mjs after the build and BEFORE wrangler. Each check is a way the preview
 * would go out open, or carrying the thing the gate replaced, without any step saying so:
 *
 *   - functions/_middleware.ts missing: wrangler uploads the static export with no gate at all —
 *     the state every preview was in until 2026-09-23;
 *   - the gate's copy drifted from tsunagi-m3/tools/owner-gate (gate:verify);
 *   - a `sync-token` meta in any document: the shared upload token, readable by anyone who could
 *     load the page, which is what this whole arrangement retired;
 *   - an icon the branded manifest or a document names that the gate does not serve anonymously:
 *     browsers fetch the manifest and its icons WITHOUT cookies, so an icon missing from
 *     `publicPaths` is a 401 where Chrome expects a PNG, and the install shows no icon.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const OUT = process.argv[2];
if (!OUT) {
    console.error('usage: node scripts/assert-gated.mjs <out-dir>');
    process.exit(1);
}

let failures = 0;
const fail = (m) => { failures++; console.log(`  FAIL  ${m}`); };
const ok = (m) => console.log(`  ok    ${m}`);

const MIDDLEWARE = join('functions', '_middleware.ts');
if (!existsSync(MIDDLEWARE)) fail(`${MIDDLEWARE} is missing — the preview would be served to anyone`);
else ok(`${MIDDLEWARE} present`);

try {
    execFileSync('node', ['scripts/gate-verify.mjs', '--functions', 'functions', '--client', 'src/lib/session-sync/owner-sync.ts'], { stdio: 'inherit' });
} catch {
    fail('gate:verify failed');
}

function files(dir, ext) {
    return readdirSync(dir).flatMap((e) => {
        const full = join(dir, e);
        return statSync(full).isDirectory() ? files(full, ext) : extname(full) === ext ? [full] : [];
    });
}

const docs = files(OUT, '.html');
const tokened = docs.filter((f) => readFileSync(f, 'utf8').includes('name="sync-token"'));
if (tokened.length) fail(`sync-token meta in ${tokened.join(', ')}`);
else ok(`no sync-token meta in ${docs.length} document(s)`);

// What the gate serves without a session, read out of the middleware's own source.
const mw = existsSync(MIDDLEWARE) ? readFileSync(MIDDLEWARE, 'utf8') : '';
const publicPaths = new Set([...mw.matchAll(/'(\/[^']+)'/g)].map((m) => m[1]));
const named = new Set(['/manifest.webmanifest']);
const manifest = JSON.parse(readFileSync(join(OUT, 'manifest.webmanifest'), 'utf8'));
for (const icon of manifest.icons ?? []) named.add(icon.src);
for (const f of docs) {
    const html = readFileSync(f, 'utf8');
    for (const m of html.matchAll(/<link[^>]+rel="(?:icon|shortcut icon|apple-touch-icon)"[^>]*>/g)) {
        const href = /href="([^"?]+)/.exec(m[0])?.[1];
        if (href?.startsWith('/')) named.add(href);
    }
}
const unserved = [...named].filter((p) => !publicPaths.has(p));
if (unserved.length) fail(`named by the manifest or a document but not in the gate's publicPaths: ${unserved.join(', ')}`);
else ok(`${named.size} anonymous path(s) — manifest and every icon it and the documents name — are public in the gate`);

console.log(failures ? `\n${failures} failure(s). Not deploying.` : '\ngated: ok');
process.exit(failures ? 1 : 0);
