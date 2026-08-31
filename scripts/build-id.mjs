/**
 * Stamps every exported document with a build id you can actually say out loud.
 *
 * ## Why this is not the service worker's cache name
 *
 * `gen-sw.mjs` names the cache after a hash of the built bytes, and its reasoning is right: the
 * cache must be invalidated exactly when the contents change, never on a commit that changed no
 * output. That makes `tuner-2e5ca880d950` a correct cache key and a useless build number — you
 * cannot tell whether it is newer than `tuner-7bedb7d1bbef`, and it points at no commit.
 *
 * Those are two different questions, so they get two different values. This one answers "which
 * build is this, and where did it come from", and it is what the diagnostics store records.
 *
 * ## The format: `<count>.<sha>`, e.g. `284.470f492`
 *
 * `git rev-list --count HEAD` is monotonic on a linear history, which this repo has, so a larger
 * number is a later build and the phone can be compared against the desk by eye. The short sha is
 * what turns the number back into a diff. A `+` suffix marks a build made with uncommitted changes —
 * which is most of them during development, and is exactly the thing you want to know before
 * trusting a number that looks like a commit.
 *
 * ## The comparison holds within a branch, and NOT across them
 *
 * Releases are squashed onto `main` — one commit per release, by decision, so that development
 * history stays local (docs/release-environments.md). So main counts releases and the development
 * branch counts commits, and the two numbers are different number lines entirely:
 *
 *   staging  112.8f65620   main, and NEWER
 *   preview  383.9068dac   feat/develop, and older
 *
 * Read the sha, or read the badge in the header, and never the number alone when the two builds
 * came from different branches. Comparing 383 against 112 by eye gives the wrong answer, which is
 * the exact failure this format was written to prevent — worth stating here rather than leaving
 * the earlier paragraph to be believed in a case it does not cover.
 *
 * Falls back to `dev` when git is unavailable rather than failing the build: a build id is a
 * convenience, and refusing to produce a deployable export because `git` is missing would not be.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';

const OUT = 'out';

function git(args) {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function buildId() {
    try {
        const count = git(['rev-list', '--count', 'HEAD']);
        const sha = git(['rev-parse', '--short', 'HEAD']);
        // `--porcelain` is empty exactly when the tree is clean. Untracked files count: a build can
        // depend on a file that was never added, and a number that hid that would be lying.
        const dirty = git(['status', '--porcelain']).length > 0 ? '+' : '';
        return `${count}.${sha}${dirty}`;
    } catch {
        return 'dev';
    }
}

function walk(dir) {
    return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? walk(path) : [path];
    });
}

const id = buildId();
// ISO to the minute. Seconds add noise to something read by a human comparing two phones.
const at = new Date().toISOString().slice(0, 16) + 'Z';

let patched = 0;
for (const path of walk(OUT)) {
    if (extname(path) !== '.html') continue;
    const html = readFileSync(path, 'utf8');
    if (!html.includes('</head>')) continue;
    // STRIP FIRST, then insert. `out/` is not guaranteed to be a fresh export — Next can leave an
    // unchanged document in place, and another session building in this checkout can leave one
    // behind entirely — so an insert-only stamp appends a SECOND tag to a document that already had
    // one. Measured on the preview deployment: two `build-id` metas, the stale one first, which is
    // the one every reader takes. `ship`'s own readback reported the previous build because of it.
    writeFileSync(path, html
        .replace(/<meta name="build-(?:id|at)" content="[^"]*">/g, '')
        .replace(
            /<\/head>/,
            `<meta name="build-id" content="${id}"><meta name="build-at" content="${at}"></head>`,
        ));
    patched++;
}

// Deliberately after the documents exist and BEFORE gen-sw.mjs runs — the same ordering rule as
// brand-preview.mjs and embed-sync-token.mjs. gen-sw hashes the bytes it is about to cache, so a
// stamp written after it would ship under the previous build's cache name and the device would keep
// serving the older HTML from disk.
console.log(`[build-id] ${id} (${at}) -> ${patched} document(s)`);
