/**
 * wrangler, signed in as this tool's Cloudflare account and not as whatever the machine last logged
 * into.
 *
 * wrangler keeps exactly one login per user, in `~/.wrangler/config/default.toml`, and has no flag or
 * variable that moves it (4.120: the legacy home directory wins over XDG_CONFIG_HOME whenever it
 * exists). Another project on this machine deploys to a different Cloudflare account, so every
 * `wrangler login` there signed this one out — and the next deploy here failed with "Authentication
 * error [code: 10000]" against an account the shared login could no longer see.
 *
 * So this tool's login lives in its own profile, `~/.wrangler-profiles/tuner`, shared by every
 * worktree of the repo. wrangler finds its config through `os.homedir()`, which on Windows reads
 * USERPROFILE (HOME elsewhere); that variable is pointed at the profile for wrangler's process only.
 * HOME is left alone on Windows, so the git that `pages deploy` runs for commit metadata still finds
 * the real ~/.gitconfig. The profile's `.wrangler/` is created before wrangler starts: without it
 * wrangler would fall back to the XDG directory every project on the machine shares.
 *
 * wrangler is this repo's own copy, resolved from this file rather than from the working directory —
 * deploy-staging.mjs runs it with MAIN as its cwd, and main carries no deploy tooling.
 *
 * Usage: npm run wrangler -- whoami | login | d1 list | …   (once: npm run wrangler -- login)
 * A bare `npx wrangler` here still uses the shared login, and fails against this account.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROFILE = join(homedir(), '.wrangler-profiles', 'tuner');

const bin = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
if (!existsSync(bin)) {
    console.error(`wrangler is not installed at ${bin}. Run npm install.`);
    process.exit(1);
}
mkdirSync(join(PROFILE, '.wrangler'), { recursive: true });

const home = process.platform === 'win32' ? { USERPROFILE: PROFILE } : { HOME: PROFILE };
const r = spawnSync(process.execPath, [bin, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, ...home },
});
if (r.error) {
    console.error(r.error.message);
    process.exit(1);
}
process.exit(r.status ?? 1);
