#!/usr/bin/env node
/**
 * The icons at the well-known paths (scripts/gen-root-icons.mjs) are there, are the M ICON mapping
 * set, and reach every place that serves them.
 *
 *   - public/favicon.ico and public/icons/mapping-dev-favicon.ico are ICO files whose entries are
 *     PNG images of 16, 32 and 48 px (the sizes gen-root-icons writes);
 *   - public/apple-touch-icon.png and -precomposed.png are production's mapping-256 byte for byte;
 *   - brand-preview.mjs and check-branding.mjs name the dev twins for all three root paths;
 *   - WORKS lets the three root paths through its gate without a session (functions/_middleware.ts),
 *     when functions/ is in this tree — main does not carry it (release-scope.mjs), and there the
 *     check is skipped and says so.
 *
 * Why: these paths were 404, and readers that ask for them by name (iOS, link previews, bookmark
 * rebuilds) showed a letter tile or an icon cached from before the mapping set (operator,
 * 2026-10-23).
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
let failures = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const fail = (m) => { failures++; console.log(`  FAIL  ${m}`); };
const read = (p) => readFileSync(resolve(ROOT, p));

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function checkIco(path) {
    if (!existsSync(resolve(ROOT, path))) { fail(`${path} is missing`); return; }
    const b = read(path);
    if (b.readUInt16LE(0) !== 0 || b.readUInt16LE(2) !== 1) { fail(`${path}: not an ICO header`); return; }
    const n = b.readUInt16LE(4);
    const sizes = [];
    for (let i = 0; i < n; i++) {
        const at = 6 + 16 * i;
        const w = b.readUInt8(at) || 256, h = b.readUInt8(at + 1) || 256;
        const len = b.readUInt32LE(at + 8), off = b.readUInt32LE(at + 12);
        const img = b.subarray(off, off + len);
        if (!img.subarray(0, 8).equals(PNG)) { fail(`${path}: entry ${i} is not a PNG`); return; }
        // IHDR width/height, big-endian, right after the signature and the chunk header.
        const pw = img.readUInt32BE(16), ph = img.readUInt32BE(20);
        if (pw !== w || ph !== h) { fail(`${path}: entry ${i} says ${w}x${h}, its PNG is ${pw}x${ph}`); return; }
        sizes.push(w);
    }
    if (sizes.join(',') !== '16,32,48') fail(`${path}: sizes ${sizes.join(',')}, want 16,32,48`);
    else ok(`${path}: ICO, PNG entries 16 / 32 / 48`);
}

console.log('[root icons — the well-known paths]');
checkIco('public/favicon.ico');
checkIco('public/icons/mapping-dev-favicon.ico');
if (read('public/favicon.ico').equals(read('public/icons/mapping-dev-favicon.ico'))) fail('production and dev favicons are the same bytes');
else ok('production and dev favicons differ');

const prod256 = read('public/icons/mapping-256.png');
for (const p of ['public/apple-touch-icon.png', 'public/apple-touch-icon-precomposed.png']) {
    if (!existsSync(resolve(ROOT, p))) fail(`${p} is missing`);
    else if (!read(p).equals(prod256)) fail(`${p} is not public/icons/mapping-256.png`);
    else ok(`${p}: production mapping-256`);
}

console.log('[root icons — branded builds and the gate]');
// The deploy tooling is not on main (release-scope.mjs), so on main there is nothing to read here.
if (!existsSync(resolve(ROOT, 'scripts', 'brand-preview.mjs')) || !existsSync(resolve(ROOT, 'scripts', 'check-branding.mjs'))) {
    ok('SKIP the branding: brand-preview.mjs / check-branding.mjs are not in this tree (main)');
} else {
    const brand = read('scripts/brand-preview.mjs').toString();
    const check = read('scripts/check-branding.mjs').toString();
    for (const [path, from] of [['favicon.ico', 'mapping-dev-favicon.ico'], ['apple-touch-icon.png', 'mapping-dev-256.png'], ['apple-touch-icon-precomposed.png', 'mapping-dev-256.png']]) {
        const pair = new RegExp(`\\['${path.replace(/\./g, '\\.')}',\\s*join\\('icons',\\s*'${from.replace(/\./g, '\\.')}'\\)\\]`);
        if (!pair.test(brand)) fail(`brand-preview.mjs does not put ${from} at /${path}`);
        else if (!pair.test(check)) fail(`check-branding.mjs does not read /${path} back against ${from}`);
        else ok(`/${path}: brand-preview writes ${from}, check-branding reads it back`);
    }
}
const middleware = resolve(ROOT, 'functions', '_middleware.ts');
if (!existsSync(middleware)) {
    ok('SKIP the gate: functions/ is not in this tree (main)');
} else {
    const gate = readFileSync(middleware, 'utf8');
    for (const p of ['/favicon.ico', '/apple-touch-icon.png', '/apple-touch-icon-precomposed.png']) {
        if (!gate.includes(`'${p}'`)) fail(`functions/_middleware.ts publicPaths lacks ${p}`);
        else ok(`gate lets ${p} through without a session`);
    }
}

console.log(failures ? `\n${failures} failure(s)` : '\nroot icons: ok');
process.exit(failures ? 1 : 0);
