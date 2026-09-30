/**
 * What "a dirty tree" means, in one place.
 *
 * build-id.mjs marks a build `+` when it was made from uncommitted changes, and the preview deploy
 * refuses such a tree outright. They must agree, or the deploy passes a tree the stamp calls dirty
 * (or refuses one it calls clean), and the build id stops being evidence of anything.
 *
 * Tracked files only (`--untracked-files=no`): the preview has to be something that can be pointed
 * at in git, so what matters is whether a committed file was changed. An untracked file that the
 * build really depends on fails `next build` on a fresh clone — which is where the published
 * `preview` branch gets built from — so it cannot hide there for long.
 *
 * And not `.claude/` or `CLAUDE.md`: agent configuration and notes that live in the working tree,
 * are edited by other sessions all day, and never reach the build. Counting them made every build
 * on this machine dirty, which is the same as never marking one.
 */
import { execFileSync } from 'node:child_process';

export const DIRTY_ARGS = ['status', '--porcelain', '--untracked-files=no', '--', '.', ':(exclude).claude', ':(exclude)CLAUDE.md'];

/** The changed paths, as `git status --porcelain` lines. Empty means clean. Throws without git. */
export function dirtyPaths(cwd = process.cwd()) {
    return execFileSync('git', DIRTY_ARGS, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
        .split('\n').filter(Boolean);
}
