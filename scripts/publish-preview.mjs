/**
 * Publishes the SOURCE of the preview: feat/develop's committed tree, onto the local `preview`
 * branch, as one commit — and stops before pushing.
 *
 * ## Why the preview's source is published at all
 *
 * The preview is handed to owners now, not only run by its author, and tsunagi-m3's MESH page says
 * the tools are open source. A build served to people whose source is nowhere public would make
 * that sentence false for exactly the build they hold. So every deploy:preview has to serve a tree
 * that is on GitHub first — deploy-preview.mjs refuses otherwise — and this is how it gets there.
 *
 * ## Why not push feat/develop
 *
 * Its history has carried real VINs and DME images (archive/, commit f2ad2dd), and a push carries
 * every object reachable from what is pushed. The same answer as the release (release-to-main.mjs):
 * a SINGLE-PARENT commit whose only parent is the previous preview commit, holding the source tree
 * minus NOT_FOR_PUBLIC. Development history never becomes reachable from it.
 *
 * What it leaves behind is short (release-scope.mjs): archive/, the agent notes, and the two docs
 * that say where the VINs are. functions/, migrations/ and wrangler.jsonc ARE published — the owner
 * gate and the SYNC API are part of what the preview serves.
 *
 * ## The proof, separate from the removal
 *
 * The index the commit is written from is read back and must hold none of NOT_FOR_PUBLIC; then the
 * commit is checked out into a throwaway worktree and `check-public-tree` runs over it, as a fresh
 * clone would see it. Only then does the branch move.
 *
 * ## What it does not do
 *
 * Push. `git push origin preview` is the publication, and it is a person's act — the pre-push hook
 * allows exactly main and preview. The message names the source commit (`preview: <short sha>`),
 * which is how deploy-preview.mjs knows the tree it is about to serve has been published, and how
 * anyone can match a preview's build id to its public source.
 *
 * Usage: npm run publish:preview
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SOURCE, PREVIEW_BRANCH, NOT_FOR_PUBLIC, excluded } from './release-scope.mjs';
import { dirtyPaths } from './git-dirty.mjs';

const git = (args, opts = {}) => execFileSync('git', args, { encoding: 'utf8', ...opts }).trim();
/** Thrown rather than exiting, so the scratch index and the throwaway worktree are always removed. */
class Refusal extends Error {}
const fail = (lines) => { throw new Refusal([].concat(lines).join('\n')); };
/** Before anything exists to clean up, a refusal simply ends the run. */
const refuse = (lines) => {
    for (const l of [].concat(lines)) console.error(l);
    process.exit(1);
};
const ref = (name) => {
    try { return git(['rev-parse', '--verify', '-q', name], { stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return ''; }
};

const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
if (branch !== SOURCE) refuse(`On '${branch}', not ${SOURCE}. The preview is published from ${SOURCE} only.`);
const dirty = dirtyPaths();
if (dirty.length) {
    // The commit is made from the committed tree whatever the files say, but a deploy right after
    // would build the files — and publish one thing while serving another.
    refuse([`${SOURCE} has uncommitted changes to tracked files. Commit them first:`, ...dirty.map((l) => `  ${l}`)]);
}

const head = git(['rev-parse', 'HEAD']);
const short = git(['rev-parse', '--short', 'HEAD']);
const message = `preview: ${short}`;
const localTip = ref(`refs/heads/${PREVIEW_BRANCH}`);
/** The parent: the local branch, or — on a machine that has only fetched it — the published one, so
 *  the new commit fast-forwards what is on GitHub rather than starting a second history beside it. */
const parent = localTip || ref(`refs/remotes/origin/${PREVIEW_BRANCH}`);
if (localTip && git(['log', '-1', '--format=%s', localTip]) === message) {
    console.log(`${PREVIEW_BRANCH} already publishes ${SOURCE} @ ${short} (${localTip.slice(0, 7)}).`);
    console.log(`\nNext:  git push origin ${PREVIEW_BRANCH}     (if it has not been pushed)`);
    process.exit(0);
}

// --- the tree, in an index of its own ------------------------------------------------------------
// Never the real index: this must not disturb the checkout it runs in.
const scratch = mkdtempSync(join(tmpdir(), 'publish-preview-'));
const env = { ...process.env, GIT_INDEX_FILE: join(scratch, 'index') };
try {
    git(['read-tree', head], { env });
    // --ignore-unmatch: the list may describe more than any one tree carries.
    git(['rm', '-r', '--cached', '-q', '--ignore-unmatch', '--', ...NOT_FOR_PUBLIC], { env });

    const files = git(['ls-files'], { env }).split('\n').filter(Boolean);
    const leaked = files.filter((f) => excluded(f, NOT_FOR_PUBLIC));
    if (leaked.length) fail(['STILL IN THE INDEX, and must not be published:', ...leaked.map((f) => `  ${f}`)]);
    console.log(`${files.length} file(s) from ${SOURCE} @ ${short}, none from NOT_FOR_PUBLIC:`);
    for (const p of NOT_FOR_PUBLIC) console.log(`  - ${p}`);

    const tree = git(['write-tree'], { env });
    const commit = git(['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', message]);

    // --- read it back as a clone would ------------------------------------------------------------
    const checkout = join(scratch, 'tree');
    git(['worktree', 'add', '--detach', '-q', checkout, commit]);
    try {
        const present = NOT_FOR_PUBLIC.filter((p) => !p.includes('*') && existsSync(join(checkout, p)));
        if (present.length) fail(['Present in the checked-out preview tree:', ...present.map((p) => `  ${p}`)]);
        try {
            execFileSync('node', ['scripts/check-public-tree.mjs'], { cwd: checkout, stdio: 'inherit' });
        } catch {
            fail(`check-public-tree failed on the preview tree. ${PREVIEW_BRANCH} was not moved.`);
        }
    } finally {
        git(['worktree', 'remove', '--force', checkout]);
    }

    // Only now does the branch move — and only from the tip that was read above.
    git(['update-ref', `refs/heads/${PREVIEW_BRANCH}`, commit, localTip || '0'.repeat(40)]);
    console.log(`\n${PREVIEW_BRANCH}  ${commit.slice(0, 7)}  ${message}${parent ? `   (parent ${parent.slice(0, 7)})` : '   (first commit)'}`);
    console.log('\nNothing has been pushed. Publish it, then deploy:');
    console.log(`  git push origin ${PREVIEW_BRANCH}`);
    console.log('  npm run deploy:preview');
} catch (e) {
    if (!(e instanceof Refusal)) throw e;
    console.error(e.message);
    process.exitCode = 1;
} finally {
    rmSync(scratch, { recursive: true, force: true });
}
