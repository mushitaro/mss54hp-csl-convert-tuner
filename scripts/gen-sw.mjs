/**
 * Turns scripts/sw.template.js into out/sw.js, with this build's file list and
 * a cache name derived from this build's contents.
 *
 * Runs after `next build` (see package.json). It has to run after, not before,
 * because the thing it is listing is the export itself — the hashed chunk names
 * under `_next/static/` do not exist until the build has produced them.
 *
 * ## The cache name is a content hash, not a version or a git sha
 *
 * A git sha changes on every commit, including ones that do not change a single
 * byte of the output, and each change throws away a cache the car has already
 * downloaded over a garage's WiFi. A hand-maintained version number changes
 * when somebody remembers. Hashing the bytes that are actually being cached
 * makes the name change exactly when the contents do, which is the only rule
 * that is both automatic and correct.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const OUT = 'out';
const TEMPLATE = join('scripts', 'sw.template.js');

/**
 * Not precached, each for its own reason:
 *
 *   sw.js          the worker cannot be one of its own assets
 *   *.map          source maps are for a debugger on a desk, not for a car
 *   CNAME          an instruction to GitHub Pages, not a resource
 *   .well-known/*  Chrome fetches the asset link itself, outside this scope,
 *                  when it verifies the Trusted Web Activity
 */
const isAsset = (url) =>
    url !== '/sw.js' &&
    url !== '/CNAME' &&
    !url.endsWith('.map') &&
    !url.startsWith('/.well-known/');

function walk(dir) {
    return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? walk(path) : [path];
    });
}

const paths = walk(OUT).sort();
const assets = paths
    .map((p) => '/' + relative(OUT, p).split(sep).join('/'))
    .filter(isAsset);

if (!assets.includes('/index.html')) {
    // Without the document there is no offline app, only a cache. Fail here
    // rather than ship a worker that installs cleanly and serves nothing.
    throw new Error('gen-sw: out/index.html is missing — did next build run?');
}

// Hash the bytes, in a fixed order, with the name alongside the content so that
// moving a file to a new path counts as a change even if its bytes do not.
const digest = createHash('sha256');
for (const path of paths) {
    const url = '/' + relative(OUT, path).split(sep).join('/');
    if (!isAsset(url)) continue;
    digest.update(url);
    digest.update(readFileSync(path));
}
const cacheName = `tuner-${digest.digest('hex').slice(0, 12)}`;

const worker = readFileSync(TEMPLATE, 'utf8')
    .replace("'__CACHE_NAME__'", JSON.stringify(cacheName))
    .replace('__ASSETS__', JSON.stringify(assets, null, 4));

writeFileSync(join(OUT, 'sw.js'), worker);

const bytes = paths
    .filter((p) => isAsset('/' + relative(OUT, p).split(sep).join('/')))
    .reduce((sum, p) => sum + statSync(p).size, 0);

console.log(
    `gen-sw: ${assets.length} assets, ${(bytes / 1024 / 1024).toFixed(1)} MB, cache ${cacheName}`
);
