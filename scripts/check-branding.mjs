/**
 * Reads a branded export back, and fails when it would not pass for what it claims to be.
 *
 *   node scripts/check-branding.mjs <out-dir> <LABEL>
 *
 * brand-preview.mjs WRITES the branding; this reads what landed, from the bytes, the way a phone
 * will. Separate on purpose (tsunagi-m-release §9.3): the loop that rewrites can be wrong in ways
 * it cannot see — a path it did not know about, a file it skipped — and only a reading of the
 * result catches those. Every failure below is one that ships quietly otherwise:
 *
 *   - a manifest icon still on the production set: a white icon beside a black one for one install;
 *   - a maskable entry pointing at an `any` file: the full-size mark cropped by the launcher's
 *     circle (tsunagi-m-release §4.1 — the reason the maskable files exist at all);
 *   - an icon the manifest or a document names that is not in the export: a blank tile;
 *   - a document with no, or two, `app-variant` tags: the experiments and SYNC silently shut, or
 *     the stale tag read first;
 *   - a `sync-token` meta: the shared upload token of the old store, which must never ship again.
 *
 * Not a `verify:*` script: those run against main's tree on every release, and main has no
 * branding step to check.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const [OUT, LABEL] = process.argv.slice(2);
if (!OUT || !LABEL) {
    console.error('usage: node scripts/check-branding.mjs <out-dir> <LABEL>');
    process.exit(1);
}

let failures = 0;
const fail = (m) => { failures++; console.log(`  FAIL  ${m}`); };
const ok = (m) => console.log(`  ok    ${m}`);

const manifest = JSON.parse(readFileSync(join(OUT, 'manifest.webmanifest'), 'utf8'));
const short = manifest.short_name ?? '';
if (!manifest.name?.endsWith(` — ${LABEL}`)) fail(`name "${manifest.name}" does not end in " — ${LABEL}"`);
else ok(`name ${manifest.name}`);
if (short.length > 12 || !short.startsWith(`${LABEL[0]} `)) fail(`short_name "${short}" is not "<${LABEL[0]}> …" within 12 characters`);
else ok(`short_name ${short}`);
if (!manifest.description?.endsWith(` — ${LABEL} BUILD, not the production tool.`)) fail('description carries no build suffix');

const icons = manifest.icons ?? [];
const anySrc = new Set(icons.filter(i => (i.purpose ?? 'any').split(/\s+/).includes('any')).map(i => i.src));
const maskable = icons.filter(i => (i.purpose ?? '').split(/\s+/).includes('maskable'));
if (!maskable.length) fail('no maskable icon');
for (const icon of icons) {
    if (!/-dev-/.test(icon.src)) fail(`manifest icon ${icon.src} is not from the dev set`);
    if (!existsSync(join(OUT, icon.src))) fail(`manifest icon ${icon.src} is not in ${OUT}`);
}
for (const icon of maskable) {
    if (anySrc.has(icon.src) || !/-maskable-/.test(icon.src)) fail(`maskable entry ${icon.src} reuses an "any" file`);
}
if (icons.every(i => /-dev-/.test(i.src) && existsSync(join(OUT, i.src)))) ok(`${icons.length} manifest icon(s), all dev, all present`);

function htmlFiles(dir) {
    return readdirSync(dir).flatMap(entry => {
        const full = join(dir, entry);
        return statSync(full).isDirectory() ? htmlFiles(full) : extname(full) === '.html' ? [full] : [];
    });
}
const variant = LABEL.toLowerCase();
let docs = 0;
for (const file of htmlFiles(OUT)) {
    const html = readFileSync(file, 'utf8');
    docs++;
    const variants = [...html.matchAll(/<meta name="app-variant" content="([^"]*)">/g)].map(m => m[1]);
    if (variants.length !== 1 || variants[0] !== variant) fail(`${file}: app-variant ${JSON.stringify(variants)}, want ["${variant}"]`);
    if (html.includes('name="sync-token"')) fail(`${file}: carries a sync-token meta`);
    for (const [src] of html.matchAll(/\/icons\/[a-z0-9-]+\.png/g)) {
        if (!/-dev-/.test(src)) fail(`${file}: names production icon ${src}`);
        else if (!existsSync(join(OUT, src))) fail(`${file}: names ${src}, which is not in ${OUT}`);
    }
    const title = /<meta name="apple-mobile-web-app-title" content="([^"]*)"/.exec(html)?.[1];
    if (title !== undefined && title !== short) fail(`${file}: apple-mobile-web-app-title "${title}", want "${short}"`);
}
if (!docs) fail(`no .html in ${OUT}`);
else if (!failures) ok(`${docs} document(s): one app-variant "${variant}", dev icons only, no sync-token`);

console.log(failures ? `\n${failures} failure(s) in the ${LABEL} branding.` : `\n${LABEL} branding: ok`);
process.exit(failures ? 1 : 0);
