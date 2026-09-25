/**
 * Puts feat/develop on the PREVIEW URL — behind the owner gate, from a published tree, or not at all.
 *
 * `mss54hp-csl-convert-tuner-preview.pages.dev` is handed to MILE buyers and past owners now. It
 * used to be `npm run build:preview && wrangler pages deploy …` in package.json, which would publish
 * whatever the checkout held: measured on 2026-09-23 it was serving a claude/* branch built from a
 * dirty tree, open to anyone, with the store's token in its HTML. Every refusal below closes one of
 * those, and each is checked BEFORE anything is uploaded:
 *
 *   1. wrangler.jsonc's `name` is the preview project. Bindings (the D1 store) apply only when the
 *      config names the project deployed to — a mismatch deploys "successfully" with no database
 *      (tsunagi-m-release §5.2) — so the project name is READ from the config, never restated.
 *   2. HEAD is feat/develop, and no tracked file is modified (git-dirty.mjs — the same definition
 *      build-id.mjs stamps `+` from). What is served must be a commit someone can point at.
 *   3. functions/_middleware.ts exists and `gate:verify` passes: the gate is there and is the
 *      canonical one.
 *   4. `check-public-tree` passes.
 *   5. That commit's source is PUBLIC: the local `preview` branch's latest commit is
 *      `preview: <HEAD short sha>` (publish-preview.mjs) and GitHub's `preview` is that same commit.
 *      If not, it prints the exact command and stops — pushing is a person's act.
 *   6. After the build: the branding reads back right (check-branding.mjs, inside build:preview),
 *      and assert-gated.mjs finds the gate, no sync-token, and every anonymous icon served.
 *
 * Then wrangler runs HERE, the directory whose functions/ is the one to ship (§5.1), with
 * `--branch main` — the project's production branch, so the deploy lands on the bare apex and no
 * alias is created that would serve this build for ever (§5.4).
 *
 * The project itself must be set to FAIL CLOSED (Settings → Runtime): when the Functions quota runs
 * out the middleware does not run, and a fail-open project serves every asset to anyone. That is a
 * project setting this script cannot see; docs/release-environments.md records it.
 *
 * Usage: npm run deploy:preview
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { SOURCE, PREVIEW_BRANCH, PREVIEW_PROJECT } from './release-scope.mjs';
import { dirtyPaths } from './git-dirty.mjs';
import { labelFor } from './brand-label.mjs';

const OUT = 'out';
/** What this build is called, for the last line of the log. The variant it deploys is `preview`. */
const LABEL = labelFor('preview');

const git = (args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const needsShell = (cmd) => process.platform === 'win32' && /^(npm|npx)$/.test(cmd);
const run = (cmd, args) => {
    console.log(`\n$ ${cmd} ${args.join(' ')}`);
    execFileSync(cmd, args, { stdio: 'inherit', shell: needsShell(cmd) });
};
const refuse = (...lines) => {
    console.error('');
    for (const l of lines) console.error(l);
    console.error('\nNothing was built or deployed.');
    process.exit(1);
};

// 1. The project, from the config that carries its bindings.
const config = JSON.parse(readFileSync('wrangler.jsonc', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, ''));
if (config.name !== PREVIEW_PROJECT) {
    refuse(`wrangler.jsonc names '${config.name}', not ${PREVIEW_PROJECT}.`,
        'Its D1 binding would not apply to the project deployed to. Refusing.');
}

// 2. What is being served, as a commit.
const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
if (branch !== SOURCE) refuse(`On '${branch}', not ${SOURCE}. The preview is ${SOURCE} and nothing else.`);
const dirty = dirtyPaths();
if (dirty.length) {
    refuse(`${dirty.length} tracked file(s) have uncommitted changes. The preview is served from a commit:`,
        ...dirty.map((l) => `  ${l}`));
}
const head = git(['rev-parse', 'HEAD']);
const short = git(['rev-parse', '--short', 'HEAD']);
console.log(`Publishing ${SOURCE} @ ${git(['log', '-1', '--format=%h %s'])}\n  -> https://${config.name}.pages.dev`);

// 3 and 4. The gate is here and canonical; the tree is fit to be public.
if (!existsSync('functions/_middleware.ts')) refuse('functions/_middleware.ts is missing — the preview would be served to anyone.');
try { run('npm', ['run', '-s', 'gate:verify']); } catch { refuse('gate:verify failed.'); }
try { run('node', ['scripts/check-public-tree.mjs']); } catch { refuse('check-public-tree failed.'); }

// 5. Published first.
const publishCommands = [`  npm run publish:preview`, `  git push origin ${PREVIEW_BRANCH}`, '  npm run deploy:preview'];
let localTip = '';
try { localTip = git(['rev-parse', '--verify', '-q', `refs/heads/${PREVIEW_BRANCH}`]); } catch { /* not yet */ }
const named = localTip ? /^preview: ([0-9a-f]{4,40})$/.exec(git(['log', '-1', '--format=%s', localTip]))?.[1] : undefined;
let namesHead = false;
try { namesHead = !!named && git(['rev-parse', `${named}^{commit}`]) === head; } catch { /* unknown sha */ }
if (!namesHead) {
    refuse(`The ${PREVIEW_BRANCH} branch does not publish ${SOURCE} @ ${short} yet. The preview serves only`,
        'source that is public. Publish it, push it, then deploy:', ...publishCommands);
}
let remoteTip = '';
try {
    remoteTip = git(['ls-remote', 'origin', `refs/heads/${PREVIEW_BRANCH}`]).split(/\s+/)[0] ?? '';
} catch (e) {
    refuse(`Could not read origin/${PREVIEW_BRANCH} (${e instanceof Error ? e.message.split('\n')[0] : e}).`,
        'Whether the source is public cannot be established, so nothing is served.');
}
if (remoteTip !== localTip) {
    refuse(`${PREVIEW_BRANCH} ${localTip.slice(0, 7)} ("preview: ${short}") is not on GitHub yet`
        + (remoteTip ? ` (origin has ${remoteTip.slice(0, 7)}).` : ' (origin has no such branch).'),
        'Push it, then deploy:', `  git push origin ${PREVIEW_BRANCH}`, '  npm run deploy:preview');
}
console.log(`\nsource public: origin/${PREVIEW_BRANCH} ${remoteTip.slice(0, 7)} = preview: ${short}`);

// 6. Build (branding is read back inside build:preview), then the gate over the result.
run('npm', ['run', 'build:preview']);
try { run('node', ['scripts/assert-gated.mjs', OUT]); } catch { refuse('assert-gated failed on the build.'); }
if (git(['rev-parse', 'HEAD']) !== head) refuse('HEAD moved during the build. Run it again.');

run('npx', ['wrangler', 'pages', 'deploy', OUT, '--project-name', config.name, '--branch', 'main']);
console.log(`\nDeployed ${LABEL} ${short}. Read it back with an owner session — see docs/release-environments.md.`);
