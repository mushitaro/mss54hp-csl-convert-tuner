/**
 * verify:supporters — the CREDITS names are written into the build, in the right place.
 *
 * The names in CREDITS (the people who bought MILE for this tool on MESH and agreed to be named)
 * are baked into every page by scripts/inject-supporters.mjs — a copy of
 * tsunagi-m3/tools/credits/inject-supporters.mjs — so the app never fetches them and production
 * still makes its one kind of request. This checks the parts that fail quietly:
 *
 *   - package.json names this tool's MESH line (`meshProject`);
 *   - both builds run the step, and run it immediately before gen-sw: after it, the service
 *     worker's cache name would describe bytes that no longer exist;
 *   - the step writes exactly one block per page from a local fixture, and a second run replaces
 *     rather than stacks it.
 *
 * Offline: the fixture stands in for m3.
 */
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { injectDir, readSupporters, meshProject } from './inject-supporters.mjs';

let failures = 0;
const check = (label, ok, detail) => {
    if (!ok) failures++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${!ok && detail ? ` — ${detail}` : ''}`);
};

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
let project = null;
try {
    project = meshProject();
} catch (e) {
    check('package.json names the MESH line', false, e.message);
}
if (project) check('package.json names the MESH line', project === 'dme-mapping', project);

for (const name of ['build', 'build:preview']) {
    const steps = (pkg.scripts[name] ?? '').split('&&').map(s => s.trim());
    const at = steps.indexOf('node scripts/inject-supporters.mjs');
    check(`${name} writes the names`, at >= 0, pkg.scripts[name]);
    check(`${name} writes them just before gen-sw`, at >= 0 && steps[at + 1] === 'node scripts/gen-sw.mjs', steps.join(' → '));
}

const dir = mkdtempSync(join(tmpdir(), 'tuner-supporters-'));
mkdirSync(join(dir, 'en'));
const page = '<!DOCTYPE html><html><head><title>t</title></head><body></body></html>';
writeFileSync(join(dir, 'index.html'), page);
writeFileSync(join(dir, 'en', 'index.html'), page);
const fixture = join(dir, 'list.json');
writeFileSync(fixture, JSON.stringify({ project: 'dme-mapping', names: ['A', 'B'], others: true }));

const { names, others } = await readSupporters('dme-mapping', { M_SUPPORTERS_FILE: fixture });
const payload = { v: 1, project: 'dme-mapping', names, others, asOf: '2026-09-28' };
const first = injectDir(dir, payload);
const second = injectDir(dir, payload);
check('every page gets the list', first.files === 2 && first.written === 2, JSON.stringify(first));
const html = readFileSync(join(dir, 'index.html'), 'utf8');
check('a second run replaces rather than stacks', second.written === 2 && html.match(/id="m-supporters"/g)?.length === 1);
check('the block sits in <head>', html.indexOf('m-supporters') < html.indexOf('</head>'));

console.log(failures ? `\n${failures} failure(s)` : '\nall ok');
process.exit(failures ? 1 : 0);
