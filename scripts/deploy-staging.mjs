/**
 * Puts MAIN on the STAGING URL, without main knowing anything about it.
 *
 * `mss54hp-csl-convert-tuner-staging.pages.dev` — its own Pages project, so that its URL, its
 * install and its home-screen label are all separate from the development build's. What lands
 * there is the release candidate: whatever `main` holds right now, byte for byte, so it can be
 * opened on a phone before it becomes the release.
 *
 * It needs no D1 and no secret: the project is a static host and creating one is the whole setup.
 *
 * ## The cwd is load-bearing, and it was wrong
 *
 * This script used to run the final `wrangler pages deploy` from ITS OWN directory — the development
 * worktree. `wrangler pages deploy <dir>` uploads the directory you name, but it compiles Pages
 * Functions from `./functions` relative to its CWD, which is somewhere else entirely. So every
 * staging deploy shipped main's static export together with DEVELOPMENT's sync API.
 *
 * That was not theoretical. Measured 2026-08-27, before the fix:
 *
 *   503  https://mss54hp-csl-convert-tuner-staging.pages.dev/api/sessions
 *   401  https://mss54hp-csl-convert-tuner-preview.pages.dev/api/sessions
 *
 * Preview's 401 is the endpoint working — it wants its upload token. Staging's 503 is the same
 * endpoint deployed onto a project with no D1 bound, failing at the first query. A static site with
 * no functions would have answered 404.
 *
 * Two things were wrong with that, and the smaller one is the broken endpoint. `sessionSync` is
 * `preview-only` BY DECISION, not by immaturity: production's privacy policy says sessions never
 * leave the device, and `verify:features` asserts the stage because that sentence depends on it.
 * The release candidate was carrying the half of the feature that sentence is about.
 *
 * The header's old claim — "main has no functions/, so there is nothing to bind" — was reasoning
 * about the wrong directory. It never mattered what main had.
 *
 * So: wrangler runs in MAIN, and the check below refuses outright if a `functions/` ever appears
 * there. A release candidate that quietly grows a backend is exactly what this URL exists to catch.
 *
 * ## Why this script exists rather than a line in package.json
 *
 * Because main cannot deploy itself and must not learn how. It has no `wrangler.jsonc`, no deploy
 * script and no branding step — it is the production source and the operator asked for it to stay
 * exactly that. So the tooling lives HERE, on the development branch, and reaches across into
 * main's worktree to build it.
 *
 * ## The three steps, and why they are three
 *
 * main's own `build` is `next build && build-id && gen-sw`. This runs it with the branding inserted
 * before the last step, and the order is not cosmetic:
 *
 *   1. `next build`      in main's worktree — main's own toolchain, main's own dependencies.
 *   2. `build-id`        in main's worktree — stamps `<count>.<sha>` into every document.
 *   3. `brand-preview`   over that export — S CSL TUNER, "— STAGING", the M ICON dev set, variant
 *                        `staging` — then `check-branding` reads it back.
 *   4. `gen-sw`          in main's worktree — LAST, because it names the service worker's cache
 *                        after a hash of the export. Brand after it and the cache name describes
 *                        bytes that no longer exist: the next deploy differing only in branding
 *                        would share a cache name and be served the previous one's assets.
 *
 * Step 2 was missing until 2026-08-27, and the header is why: it said main's build was
 * `next build && gen-sw`, which was true of the main this script was written against and stopped
 * being true the moment `build-id.mjs` shipped. The decomposition then quietly dropped a step.
 *
 * Measured before the fix: preview carried `383.9068dac` and staging carried no build id at all.
 * On the RELEASE CANDIDATE that is the worst place to lose it — the whole purpose of the URL is to
 * look at a specific commit on a phone, and without the stamp the phone cannot say which one it
 * has. Steps are read out of main's own `build` script rather than restated here for exactly this
 * reason: a decomposition that has to be kept in sync by hand will not be.
 *
 * Nothing is written into main's tree except `out/`, which is gitignored.
 *
 * ## What it does NOT do
 *
 * It does not touch `mss54hp-csl-convert-tuner.tsunagi.app`. That is GitHub Pages, deployed from
 * main by `.github/workflows/deploy.yml` on push, and this script has no path to it.
 *
 * Usage: npm run deploy:staging
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** main's worktree. `git worktree add ../E46M3CSL_TuningTool-main main` if it is not there. */
const MAIN = resolve(process.cwd(), '..', 'E46M3CSL_TuningTool-main');
const PROJECT = 'mss54hp-csl-convert-tuner-staging';
/** The project's production branch, so the deploy lands on the bare apex rather than an alias. */
const BRANCH = 'main';
/** The environment's label (brand-preview.mjs makes S CSL TUNER of it). Not PREVIEW: that one belongs
 *  to the development build. */
const LABEL = 'STAGING';

const run = (cmd, args, cwd) => {
    console.log(`\n$ ${cmd} ${args.join(' ')}${cwd === process.cwd() ? '' : `    (in ${cwd})`}`);
    execFileSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
};

if (!existsSync(MAIN)) {
    console.error(`No worktree at ${MAIN}.\n`
        + `Create one with:  git worktree add "${MAIN}" main && cd "${MAIN}" && npm ci`);
    process.exit(1);
}
if (!existsSync(resolve(MAIN, 'node_modules'))) {
    console.error(`${MAIN} has no node_modules. Run \`npm ci\` there first.`);
    process.exit(1);
}

// What is actually about to be published, said out loud. A release candidate deployed from a stale
// worktree is the failure this line exists to make visible.
const head = execFileSync('git', ['-C', MAIN, 'log', '-1', '--format=%h %s'], { encoding: 'utf8' }).trim();
const branch = execFileSync('git', ['-C', MAIN, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();
console.log(`Publishing ${branch} @ ${head}\n  -> https://${PROJECT}.pages.dev`);
if (branch !== 'main') {
    console.error(`\nThat worktree is on '${branch}', not main. Refusing.`);
    process.exit(1);
}

// A release candidate must be static. If main ever carries a `functions/`, wrangler would compile
// and publish it onto a project with no bindings — which is how the 503 above came to exist, only
// this time it would be main's own doing and would survive to production's repository.
if (existsSync(resolve(MAIN, 'functions'))) {
    console.error('');
    console.error(`${MAIN} carries a functions/ directory.`);
    console.error('Staging is main, unmodified, and main is a static export — Pages Functions');
    console.error('there would publish an API onto a project with no D1 bound. Take it out of');
    console.error('main, or change this script deliberately. Refusing.');
    process.exit(1);
}

// Everything main's own `build` runs after `next build`, taken FROM that script rather than
// listed here — see the header. Branding goes in front of the last of them, which is gen-sw.
const buildScript = JSON.parse(readFileSync(resolve(MAIN, 'package.json'), 'utf8')).scripts.build;
const steps = buildScript.split('&&').map(part => part.trim())
    .filter(part => part.startsWith('node '))
    .map(part => part.replace(/^node\s+/, ''));
if (!steps.length) {
    console.error(`main's build script runs no node steps: ${buildScript}`);
    console.error('That is either a real change to how main builds, or a parse failure here.');
    console.error('Either way this script cannot reproduce it. Refusing.');
    process.exit(1);
}
// The branding must land between the second-to-last step and the last one, and that only works
// while the last one is the cache-namer. If main ever reorders its build, the failure would be
// silent and would ship: a service worker whose cache name describes bytes that were rewritten
// after it was computed, serving the previous deploy's assets to everyone who already had it.
if (!steps[steps.length - 1].endsWith('gen-sw.mjs')) {
    console.error(`main's build ends with ${steps[steps.length - 1]}, not gen-sw.mjs.`);
    console.error('Branding has to happen before the step that hashes the export. Refusing.');
    process.exit(1);
}
console.log(`main's build adds: ${steps.join(', ')}`);

run('npx', ['next', 'build'], MAIN);
for (const step of steps.slice(0, -1)) run('node', [resolve(MAIN, step)], MAIN);
run('node', [resolve('scripts', 'brand-preview.mjs'), resolve(MAIN, 'out'), LABEL], process.cwd());
run('node', [resolve('scripts', 'check-branding.mjs'), resolve(MAIN, 'out'), LABEL], process.cwd());
run('node', [resolve(MAIN, steps[steps.length - 1])], MAIN);
// In MAIN, not here — see the header. Everything wrangler needs is on the command line, so it
// wants no `wrangler.jsonc`, and finding none is the correct outcome rather than a missing step.
run('npx', ['wrangler', 'pages', 'deploy', resolve(MAIN, 'out'),
    '--project-name', PROJECT, '--branch', BRANCH], MAIN);
