/**
 * One fix, both environments, in one command.
 *
 * ## The problem it removes
 *
 * Checking a change happened on staging, because staging is what production will show. But staging
 * is `main`, so it only moves when a release is cut — and preview moves whenever anything is built.
 * Every fix after a look therefore needed two deploys and, worse, a DECISION about which: preview
 * only, staging only, or both. That decision kept being got wrong, in both directions (operator,
 * 2026-08-31).
 *
 * A decision nobody makes cannot be got wrong. This runs the whole sequence:
 *
 *   on feat/develop, clean, preview source published → preview → release onto main → every verify
 *   suite → tsc → commit → staging → read both URLs back and check what they actually served
 *
 * The scope switch on the build badge is the other half of the same answer, and it is the half that
 * should get used first: preview read AS PRODUCTION renders the release's surface set, so most
 * checks no longer need staging at all. This is for when the release itself is the thing to move.
 *
 * ## What it will not do for you
 *
 * It will not write the release note. `-m` is required and there is no default, because the one
 * line that says what a release IS should be written by whoever decided to cut it — the same reason
 * release-to-main.mjs stops before committing. Pass `--body` for the long form.
 *
 * It will not run over a dirty worktree any more. Preview is built from the FILES and the release
 * from the COMMITTED tree, so uncommitted work used to reach one environment and not the other, and
 * that was reported rather than refused. The preview is handed to owners now and must be a commit
 * whose source is public, so uncommitted changes to tracked files stop the run before anything is
 * built (`.claude/` and CLAUDE.md, which never reach a build, do not count — git-dirty.mjs).
 *
 * It will not push, and it will not publish the preview's source for you: if GitHub's `preview`
 * branch does not yet hold this commit it stops and prints `npm run publish:preview` and
 * `git push origin preview`. And it reads the preview back only with an owner session
 * (GATE_SESSION_FILE); without one the preview is reported NOT VERIFIED and the exit code is 2.
 *
 * Usage:
 *   npm run ship -- -m "2.2.0 — what this release is"
 *   npm run ship -- -m "…" --body notes.md
 *   npm run ship -- -m "…" --no-preview        # staging only, when preview is already current
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { SOURCE, PREVIEW_BRANCH } from './release-scope.mjs';
import { dirtyPaths } from './git-dirty.mjs';

const MAIN = resolve(process.cwd(), '..', 'E46M3CSL_TuningTool-main');
const PREVIEW_URL = 'https://mss54hp-csl-convert-tuner-preview.pages.dev';
const STAGING_URL = 'https://mss54hp-csl-convert-tuner-staging.pages.dev';
/**
 * NO NEXT_DIST_DIR HERE, and this is the note that stops it coming back.
 *
 * It was set, to dodge the `<distDir>/dev/lock` that `next dev` holds — a build into `.next` is
 * refused outright while anyone has a dev server on this checkout, which on this machine is most of
 * the time. It worked, and it silently broke the deploy: with `output: 'export'`, moving distDir
 * MOVES THE EXPORT with it. The site landed in `.next-dev-ship/`, `out/` was never rewritten, and
 * the branding and stamping steps then dressed the PREVIOUS export in the current build id and
 * uploaded it. Measured: preview served `width:6px` under a build id of 474.46b2bf9 while the
 * commit in that id had made it 3px (operator noticed; 2026-08-31).
 *
 * So the build goes where the rest of the pipeline looks. If a dev server holds the lock, the build
 * fails loudly and this command stops — which is the correct outcome, and the one that was traded
 * away for a green run that shipped nothing.
 */
const OUT = resolve(process.cwd(), 'out');

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

const subject = value('-m') ?? value('--message');
if (!subject) {
    console.error('A release note is required:  npm run ship -- -m "what this release is"');
    console.error('Nothing has been built or deployed.');
    process.exit(1);
}
const bodyFile = value('--body');
if (bodyFile && !existsSync(bodyFile)) {
    console.error(`--body ${bodyFile} does not exist.`);
    process.exit(1);
}
const message = subject + (bodyFile ? `\n\n${readFileSync(bodyFile, 'utf8').trim()}` : '')
    + '\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>\n';

/**
 * A shell ONLY where Windows needs one, which is for `npm`/`npx` — they are `.cmd` shims there
 * and cannot be spawned directly. Everything else is a real binary, and handing its arguments to
 * a shell re-splits them on spaces: `git log --format=%h %s` became two arguments and git read
 * `%s` as a revision, and the release commit's multi-line message would have gone the same way.
 */
const needsShell = (cmd) => process.platform === 'win32' && /^(npm|npx|yarn|pnpm)$/.test(cmd);

const run = (cmd, cmdArgs, cwd = process.cwd(), env) => {
    console.log(`\n$ ${cmd} ${cmdArgs.join(' ')}${cwd === process.cwd() ? '' : `    (in ${cwd})`}`);
    execFileSync(cmd, cmdArgs, {
        cwd, stdio: 'inherit', shell: needsShell(cmd),
        env: { ...process.env, ...env },
    });
};
const capture = (cmd, cmdArgs, cwd = process.cwd()) =>
    execFileSync(cmd, cmdArgs, { cwd, encoding: 'utf8', shell: needsShell(cmd) }).trim();

const step = (n, of, what) => console.log(`\n${'='.repeat(78)}\n[${n}/${of}] ${what}\n${'='.repeat(78)}`);

/**
 * The preview is behind the owner gate, so reading it back needs an owner session: a short-lived one
 * issued for this check (tsunagi-m3's `access-session.mjs`), handed over as a file — never on the
 * command line, never printed — named by GATE_SESSION_FILE and holding `{"token": "..."}`.
 *
 * Without it the preview cannot be read back, and that is said as exactly that: "not verified" is a
 * different outcome from "wrong" (tsunagi-m-release §8), so it ends in exit 2 rather than 1, and
 * only after staging — which needs no session — has been checked in full.
 */
const previewCookie = (() => {
    const file = process.env.GATE_SESSION_FILE;
    if (!file) return null;
    try {
        const token = JSON.parse(readFileSync(file, 'utf8')).token;
        return typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token) ? `__Host-owner=${token}` : null;
    } catch {
        return null;
    }
})();

/**
 * Read a deployed page, past every cache between here and the origin.
 *
 * `cache: 'no-store'` only speaks for THIS process's cache; Cloudflare's edge has its own and will
 * happily serve the build that was there a minute ago. The first run of this script reported
 * staging as 115.69c86c7 in the same breath as its own build log said it had just stamped and
 * uploaded 116.d56811c. A unique query string is what actually defeats it.
 *
 * A gated answer (401 with no session, 302 towards m3) throws: it is not the page, and reading its
 * missing meta tags as "(absent)" would report a build that was never looked at.
 */
const readDeployed = async (url, cookie = null) => {
    const bust = `cb=${process.hrtime.bigint()}`;
    const headers = cookie ? { cookie } : {};
    const page = await fetch(`${url}/?${bust}`, { cache: 'no-store', headers, redirect: 'manual' });
    if (page.status !== 200) throw new Error(`HTTP ${page.status} for / — ${cookie ? 'the session was refused' : 'gated'}`);
    const html = await page.text();
    const meta = (name) => html.match(new RegExp(`<meta name="${name}" content="([^"]*)"`))?.[1] ?? '(absent)';
    const api = await fetch(`${url}/api/sessions?${bust}`, { cache: 'no-store', headers, redirect: 'manual' })
        .then(r => r.status).catch(() => 0);
    return { buildId: meta('build-id'), variant: meta('app-variant'), api };
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

if (!existsSync(MAIN)) {
    console.error(`No worktree at ${MAIN}.`);
    process.exit(1);
}

// The release is a copy of SOURCE's tree (release-to-main.mjs) and the preview is SOURCE's commit
// (deploy-preview.mjs). Run from anywhere else, the preview would refuse and the release would copy
// a branch nobody meant — so it is refused here, before anything else happens.
const onBranch = capture('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
if (onBranch !== SOURCE) {
    console.error(`On '${onBranch}', not ${SOURCE}. ship releases ${SOURCE} and nothing else.`);
    process.exit(1);
}

const TOTAL = 7;

// ---- 1. say what is uncommitted, before anything is built -------------------------------------
step(1, TOTAL, 'What is committed, and what is not');
const head = capture('git', ['log', '-1', '--format=%h %s']);
console.log(`develop HEAD  ${head}`);
// The same definition deploy:preview refuses on and build-id.mjs stamps from (git-dirty.mjs).
const dirty = dirtyPaths();
if (dirty.length) {
    // It used to report and carry on: preview built from the files, the release from the commit.
    // The preview is handed to owners now and must be a published commit, so a dirty tree stops
    // everything here rather than half-way through.
    console.error(`\n${dirty.length} tracked file(s) have uncommitted changes. Commit them first:`);
    for (const line of dirty) console.error(`  ${line}`);
    process.exit(1);
}
console.log('worktree clean — both environments get the same tree.');

// deploy:preview serves only a commit whose source is already on GitHub's preview branch. Checked
// here too, so that an unpublished tree stops the run before a single step, with the commands.
if (!flag('--no-preview')) {
    const short = capture('git', ['rev-parse', '--short', 'HEAD']);
    let published = false;
    try {
        const tip = capture('git', ['rev-parse', '--verify', '-q', `refs/heads/${PREVIEW_BRANCH}`]);
        const remote = capture('git', ['ls-remote', 'origin', `refs/heads/${PREVIEW_BRANCH}`]).split(/\s+/)[0];
        const named = /^preview: ([0-9a-f]+)$/.exec(capture('git', ['log', '-1', '--format=%s', tip]))?.[1];
        published = remote === tip && !!named
            && capture('git', ['rev-parse', `${named}^{commit}`]) === capture('git', ['rev-parse', 'HEAD']);
    } catch { /* no branch, no network: not established */ }
    if (!published) {
        console.error(`\nThe preview's source (${SOURCE} @ ${short}) is not on GitHub's ${PREVIEW_BRANCH} branch yet.`);
        console.error('Publish it and push it, then ship again:');
        console.error('  npm run publish:preview');
        console.error(`  git push origin ${PREVIEW_BRANCH}`);
        process.exit(1);
    }
}

// ---- 2. preview ------------------------------------------------------------------------------
// What it serves NOW, so that "did the deploy land" is a comparison rather than a hope. Preview's
// own build id cannot simply be predicted from HEAD: another session committing during the build
// moves it, which has happened.
let previewWas = null;
if (flag('--no-preview')) {
    step(2, TOTAL, 'Preview — SKIPPED (--no-preview)');
} else {
    step(2, TOTAL, 'Preview');
    previewWas = await readDeployed(PREVIEW_URL, previewCookie).then(r => r.buildId).catch(() => null);
    console.log(`serving now: ${previewWas ?? `(could not read${previewCookie ? '' : ' — no GATE_SESSION_FILE'})`}`);
    // The moment the build starts, so that "did the export actually get rewritten" is answerable
    // afterwards rather than assumed. The failure this catches produced a correct-looking build id
    // over the previous build's bytes, which no downstream check could have told apart.
    const startedAt = Date.now();
    run('npm', ['run', 'deploy:preview']);
    const exported = statSync(resolve(OUT, 'index.html')).mtimeMs;
    if (exported < startedAt) {
        console.error(`
out/index.html was not rewritten by that build (last written ${new Date(exported).toISOString()}).`);
        console.error('Whatever was uploaded is the PREVIOUS export wearing the current build id.');
        console.error('Check where `next build` put its export — `output: export` follows distDir.');
        process.exit(1);
    }
}

// ---- 3. the release tree ---------------------------------------------------------------------
step(3, TOTAL, 'Copying the tree onto main');
run('node', ['scripts/release-to-main.mjs']);
const staged = capture('git', ['-C', MAIN, 'diff', '--cached', '--name-only']).split('\n').filter(Boolean);
if (!staged.length) {
    console.log('\nNothing staged on main — it already holds this tree. No release to cut.');
    console.log('Preview is up to date; staging already matches. Stopping here.');
    process.exit(0);
}

// ---- 4/5. the release tree has to pass on its own terms ---------------------------------------
step(4, TOTAL, `Verifying main's tree — every verify:* suite`);
const suites = Object.keys(JSON.parse(readFileSync(resolve(MAIN, 'package.json'), 'utf8')).scripts)
    .filter(k => k.startsWith('verify:'));
if (!suites.length) {
    console.error("main's package.json declares no verify:* scripts. Refusing to ship a tree nothing checked.");
    process.exit(1);
}
const failed = [];
for (const suite of suites) {
    try {
        execFileSync('npm', ['run', suite], { cwd: MAIN, stdio: 'pipe', shell: needsShell('npm') });
        process.stdout.write('.');
    } catch {
        process.stdout.write('x');
        failed.push(suite);
    }
}
console.log(`\n${suites.length - failed.length}/${suites.length} passed`);
if (failed.length) {
    console.error(`\nFAILED: ${failed.join(', ')}`);
    console.error(`Run it there to see why:  npm run ${failed[0]}    (in ${MAIN})`);
    console.error('main is left staged and uncommitted. Nothing was deployed to staging.');
    process.exit(1);
}

step(5, TOTAL, 'Typechecking main\'s tree');
run('npx', ['tsc', '--noEmit'], MAIN);

// ---- 6. one commit = one release ---------------------------------------------------------------
step(6, TOTAL, 'Committing the release');
run('git', ['-C', MAIN, 'commit', '-m', message]);
console.log(`\nmain  ${capture('git', ['-C', MAIN, 'log', '-1', '--format=%h %s'])}`);

// ---- 7. staging, then read both back -----------------------------------------------------------
step(7, TOTAL, 'Staging');
run('npm', ['run', 'deploy:staging']);

console.log(`\n${'='.repeat(78)}\nWhat the two URLs are actually serving\n${'='.repeat(78)}`);

// Staging must carry the commit written one step ago — the build id is `<count>.<sha>`, so this is
// the strongest statement available: not "a deploy succeeded" but "the bytes I just committed are
// what that URL answers with".
const mainSha = capture('git', ['-C', MAIN, 'rev-parse', '--short', 'HEAD']);
const developSha = capture('git', ['rev-parse', '--short', 'HEAD']);
// The preview carries develop's commit, stamped by build-id.mjs from a clean tree — so the same
// strong statement as staging's is available, instead of "it is not what it was before".
const landed = (label, r) => label === 'staging'
    ? r.buildId.includes(mainSha)
    : r.buildId === `${r.buildId.split('.')[0]}.${developSha}`;

let bad = 0;
let unverified = 0;
// Staging first: it needs no session, so its verdict never waits on the preview's.
for (const [label, url, apiShouldBe] of [['staging', STAGING_URL, '404'], ['preview', PREVIEW_URL, 'alive']]) {
    if (label === 'preview' && flag('--no-preview')) continue;
    if (label === 'preview' && !previewCookie) {
        console.log(`${'preview'.padEnd(8)} NOT VERIFIED — behind the owner gate, and GATE_SESSION_FILE names no session.`);
        console.log('         Issue one (tsunagi-m3: node scripts/access-session.mjs --client tuner-preview), put');
        console.log('         {"token":"..."} in a file outside the repo, and read it back with GATE_SESSION_FILE set.');
        unverified++;
        continue;
    }
    let r = null;
    // The edge serves the previous build for a while after an upload, so a single read can report
    // the deploy that came before this one as though nothing had happened. 18 seconds was not
    // enough — staging was still answering with the previous release when the check gave up, and
    // was correct a minute later. Two minutes, and it says what it is waiting for so that waiting
    // does not read as a hang.
    const ATTEMPTS = 24;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
        try { r = await readDeployed(url, label === 'preview' ? previewCookie : null); } catch (err) {
            console.error(`${label.padEnd(8)} could not be read back: ${err.message}`);
            break;
        }
        if (landed(label, r)) break;
        if (attempt === 2) process.stdout.write(`${label.padEnd(8)} waiting for the edge to serve it`);
        if (attempt >= 2) process.stdout.write('.');
        if (attempt < ATTEMPTS) await sleep(5000);
        else console.log('');   // close the row of dots before the verdict prints
    }
    if (!r) { bad++; continue; }
    console.log(`${label.padEnd(8)} ${r.buildId.padEnd(18)} variant ${r.variant.padEnd(8)} /api ${r.api}`);
    if (!landed(label, r)) {
        console.error(label === 'staging'
            ? `  ^ does not carry main ${mainSha}. The upload succeeded and this URL is answering with something else.`
            : `  ^ does not carry ${SOURCE} ${developSha} from a clean tree (was ${previewWas ?? 'unread'} before the deploy).`);
        bad++;
    }
    // A release candidate must not have grown a backend. A static site answers 404; anything else
    // means functions were compiled from the wrong directory, which is the mistake that put
    // development's sync API on staging once already.
    if (apiShouldBe === '404' && r.api !== 404) {
        console.error(`  ^ staging answered ${r.api} on /api/sessions, and a static site answers 404.`);
        bad++;
    }
    if (label === 'staging' && r.variant !== 'staging') { console.error(`  ^ variant should be 'staging'`); bad++; }
    if (label === 'preview' && r.variant !== 'preview') { console.error(`  ^ variant should be 'preview'`); bad++; }
    // With a session, the store answers 200 — the gate let the owner through and the D1 binding
    // is live. 401 would mean the session was refused; 5xx that the binding did not arrive.
    if (apiShouldBe === 'alive' && r.api !== 200) { console.error(`  ^ /api/sessions answered ${r.api} with an owner session; expected 200`); bad++; }
}
if (bad) {
    console.error('\nDeployed, but the artifacts do not read back the way they should. Look before trusting it.');
    process.exit(1);
}
if (unverified) {
    console.error('\nStaging reads back correctly. The preview was NOT verified — see above. Exit 2: not checked, not failed.');
    process.exit(2);
}
console.log('\nBoth environments carry this change. `git -C "' + MAIN + '" push origin main` IS the release.');
