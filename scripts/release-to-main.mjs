/**
 * Copies the development branch onto `main` as ONE commit, minus the things main must not carry.
 *
 * Run this instead of doing the merge by hand. It exists because both halves are easy to get wrong
 * and neither announces the mistake:
 *
 *   - `git merge --squash` is what keeps development history out of a PUBLIC repository. A normal
 *     merge commit has feat/develop as a parent, and pushing main would carry every object
 *     reachable from it. Squash produces a single-parent commit holding only the tree diff.
 *   - The squash then copies the WHOLE tree, deployment layer included, and that layer has no
 *     business on main. Excluding it by memory works until the release someone is in a hurry.
 *
 * ## What is left behind, and why (operator, 2026-08-27)
 *
 * `functions/` is the one that matters. It is the server side of SYNC, and SYNC is `preview-only`
 * BY DECISION: production's privacy policy says sessions never leave the device, and
 * `verify:features` asserts the stage because that sentence depends on it. The button is already
 * gated — it renders in preview alone — but the RECEIVER would have been published as production's
 * own source, and worse, deployed: `deploy-staging.mjs` compiles Pages Functions from its working
 * directory, so a `functions/` in main would put a live API on the release candidate. Measured on
 * 2026-08-27, before that was fixed: staging answered 503 on /api/sessions, which is that endpoint
 * running with no database bound. A static site answers 404.
 *
 * `docs/release-environments.md` is left behind for a smaller but real reason: it says in plain
 * words that a real VIN sits in a comment at flashCounter.ts:98. The VIN is already public and this
 * does not change that — it declines to erect a signpost to it.
 *
 * The rest — wrangler.jsonc, migrations/, the owner gate and the deploy scripts — are simply not
 * production's. They describe a Cloudflare account, a database and an access gate that main has no
 * relationship with. (The PREVIEW branch does carry them: it publishes what the preview serves.
 * See release-scope.mjs.)
 *
 * The verify suite and docs/ecu-logic DO go to main. They are the reason to read this repository.
 *
 * ## What it does not do
 *
 * It does not commit, and it does not push. It leaves the result staged in main's worktree and
 * prints what is there, because a release note is written by a person and `git push origin main` IS
 * the release. Run it, read the summary, then commit and follow docs/release-environments.md.
 *
 * Usage: npm run release
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SOURCE, NOT_FOR_MAIN, NOT_FOR_MAIN_SCRIPTS } from './release-scope.mjs';

const MAIN = resolve(process.cwd(), '..', 'E46M3CSL_TuningTool-main');

/**
 * The lists live in release-scope.mjs, beside the preview's own (NOT_FOR_PUBLIC), so that
 * `verify:release-scope` can read them without running a release — importing THIS file does.
 * Re-exported here because this is where a reader of the release looks for them.
 */
export { NOT_FOR_MAIN, NOT_FOR_MAIN_SCRIPTS };

const git = (...args) => execFileSync('git', ['-C', MAIN, ...args], { encoding: 'utf8' });

if (!existsSync(MAIN)) {
    console.error(`No worktree at ${MAIN}.`);
    console.error(`Create one with:  git worktree add "${MAIN}" main`);
    process.exit(1);
}
if (git('rev-parse', '--abbrev-ref', 'HEAD').trim() !== 'main') {
    console.error(`${MAIN} is not on main. Refusing.`);
    process.exit(1);
}
if (git('status', '--porcelain').trim()) {
    console.error(`${MAIN} has uncommitted changes. Sort them out first, or reset:`);
    console.error(`  git -C "${MAIN}" reset --hard`);
    process.exit(1);
}

/**
 * A TREE COPY, not a merge, and this was `git merge --squash` until 2026-08-31.
 *
 * A merge needs a common ancestor to reason from. A squash release destroys exactly that: the
 * commit it writes has main as its only parent and no link to the branch it copied, so git's merge
 * base stays pinned at the last REAL merge and drifts a release further back every time. Everything
 * the merge then decided was decided from the wrong place, and it went wrong in three ways, none of
 * which announced itself:
 *
 *   - CONFLICTS in files two consecutive releases both touched, which are not disagreements at all
 *     — the answer is always the source branch — but which stopped the script mid-merge.
 *   - A file DELETED on the development branch read as "added by ours" and was kept. A renamed
 *     component was about to ship under both its names.
 *   - A block MOVED within a file read as an addition on one side with no matching removal on the
 *     other, and was kept in both places. The header was about to ship two CREDITS buttons.
 *
 * `read-tree --reset -u` states the actual intent in one line: main's index and worktree become the
 * source's tree, HEAD stays on main, and the commit that follows is the single-parent release
 * commit. There is nothing left to resolve, because there was never a question.
 *
 * THE PRECONDITION, which is now the only one: anything committed directly to main is overwritten.
 * The workflow already assumes it goes the other way — merge main into the development branch, then
 * release — and the summary below prints every file the release changes so that a direct edit about
 * to be overwritten is visible rather than silent.
 */
console.log(`Copying ${SOURCE}'s tree onto main in ${MAIN}`);
const changing = git('diff', '--name-only', 'HEAD', SOURCE).split('\n').filter(Boolean);
execFileSync('git', ['-C', MAIN, 'read-tree', '--reset', '-u', SOURCE], { stdio: 'inherit' });
console.log(`${changing.length} file(s) differ from the release standing now.`);

console.log('');
console.log('Left on the development branch:');
for (const path of NOT_FOR_MAIN) {
    // -r for directories, --ignore-unmatch so a path that was never there is not an error: this
    // list is allowed to describe more than any one release happens to carry.
    const before = git('status', '--porcelain', '--', path).trim();
    execFileSync('git', ['-C', MAIN, 'rm', '-r', '-f', '-q', '--ignore-unmatch', '--', path],
        { stdio: 'ignore' });
    console.log(`  ${before ? '-' : '(absent)'} ${path}`);
}

// package.json: drop the entries whose files just left.
const pkgPath = resolve(MAIN, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const dropped = [];
for (const name of NOT_FOR_MAIN_SCRIPTS) {
    for (const key of [name, `//${name}`]) {
        if (key in pkg.scripts) { delete pkg.scripts[key]; dropped.push(key); }
    }
}
if (dropped.length) {
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    execFileSync('git', ['-C', MAIN, 'add', 'package.json'], { stdio: 'ignore' });
}
console.log('');
console.log(`package.json scripts dropped: ${dropped.length ? dropped.join(', ') : 'none'}`);

// Prove it, rather than trusting the loop above. The index is what gets committed.
const staged = git('diff', '--cached', '--name-only').split('\n').filter(Boolean);
const leaked = NOT_FOR_MAIN.filter(p => staged.some(f => f === p || f.startsWith(`${p}/`)));
console.log('');
if (leaked.length) {
    console.error(`STILL STAGED, and must not be: ${leaked.join(', ')}`);
    process.exit(1);
}
console.log(`${staged.length} file(s) staged, none from the exclusion list.`);

/**
 * The release tree IS the source tree, minus what was declared.
 *
 * True by construction after the tree copy, which is the point of proving it: what this now guards
 * is the `git rm` loop and the package.json rewrite above. A pathspec that matched more than it
 * meant to shows up here, in the file it removed.
 */
const drift = git('diff', '--cached', '--name-only', SOURCE).split('\n').filter(Boolean)
    .filter(f => f !== 'package.json'
        && !NOT_FOR_MAIN.some(p => f === p || f.startsWith(`${p}/`)));
if (drift.length) {
    console.error(`The staged tree does not match ${SOURCE}, and these are not declared exclusions:`);
    for (const f of drift) console.error(`  ${f}`);
    console.error('');
    console.error('The tree was copied wholesale, so this can only be the removal steps above:');
    console.error('a NOT_FOR_MAIN entry matching more than it means to.');
    process.exit(1);
}

// package.json is the one file that legitimately differs, and only by the entries stripped above.
// Compared parsed, so the rewrite's formatting is not mistaken for a change.
const sourcePkg = JSON.parse(git('show', `${SOURCE}:package.json`));
for (const key of dropped) delete sourcePkg.scripts[key];
if (JSON.stringify(sourcePkg) !== JSON.stringify(JSON.parse(readFileSync(pkgPath, 'utf8')))) {
    console.error(`package.json differs from ${SOURCE} by more than the stripped scripts.`);
    process.exit(1);
}
console.log(`tree matches ${SOURCE}, minus the exclusions and ${dropped.length} package script(s).`);

// And nothing in it that a public repository must not hold — the release's own copy of the check,
// run over the tree about to be committed (git ls-files reads the index read-tree just wrote).
try {
    execFileSync('node', ['scripts/check-public-tree.mjs'], { cwd: MAIN, stdio: 'inherit' });
} catch {
    console.error('');
    console.error('The release tree holds something that must not be published. main is left staged');
    console.error('and uncommitted; fix it on the development branch and release again.');
    process.exit(1);
}
console.log('');
console.log('Next:');
console.log(`  git -C "${MAIN}" commit          # one commit = one release`);
console.log('  npm run deploy:staging          # try it on a phone');
console.log(`  git -C "${MAIN}" push origin main  # this IS the release`);
