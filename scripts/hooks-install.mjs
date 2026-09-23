/**
 * Points git at the hooks this repository carries in .githooks/.
 *
 *   pre-commit   check-public-tree over what is staged — nothing unpublishable enters a commit.
 *   pre-push     only `main` and `preview` may leave this machine.
 *
 * `core.hooksPath` is set to an ABSOLUTE path, not the relative `.githooks`, and that is the whole
 * reason this is a script rather than one `git config` line. The setting lives in the repository's
 * shared config, so every worktree reads it — and a relative path is resolved in each worktree's own
 * checkout. The release worktree and the older branches in the other worktrees have no .githooks/,
 * so a relative path would give them no hooks at all: the push guard, which until now lived in
 * .git/hooks and covered them, would silently stop covering them. An absolute path to this checkout
 * keeps one set of hooks for all of them.
 *
 * Usage: npm run hooks:install
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const dir = resolve('.githooks');
for (const hook of ['pre-commit', 'pre-push']) {
    if (!existsSync(resolve(dir, hook))) {
        console.error(`${dir} has no ${hook}. Refusing — pointing git here would drop that hook.`);
        process.exit(1);
    }
}
execFileSync('git', ['config', 'core.hooksPath', dir.replace(/\\/g, '/')], { stdio: 'inherit' });
console.log(`core.hooksPath = ${execFileSync('git', ['config', 'core.hooksPath'], { encoding: 'utf8' }).trim()}`);
