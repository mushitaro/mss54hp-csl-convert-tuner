/**
 * `next dev` on a port AND a build directory of its own.
 *
 * ## Why this exists
 *
 * Two agent sessions on this one checkout both want a dev server, and moving the port is not enough:
 * Next 16 takes a lock at `<distDir>/dev/lock`, so a second `next dev` against the same directory
 * exits with "Unable to acquire lock" whatever port it was given. The port collision was the symptom
 * that got reported; the lock is what actually refuses.
 *
 * So the second server gets its own `distDir` as well as its own port, and the two stop being aware
 * of each other. `next dev` has no `--dist-dir` flag, which is why this is a launcher rather than an
 * argument: `next.config.ts` reads `NEXT_DIST_DIR`, and this sets it.
 *
 * ## What it deliberately does not touch
 *
 * `package.json`'s `dev` script stays `next dev -p 5054` on the default `.next`. That script is what
 * `dev.cmd` runs — a double-click launcher whose own window prints `127.0.0.1:5054` — and what the
 * browser testing is done against. A harness-side port conflict is not a reason to move somebody's
 * documented workflow.
 *
 * ## It edits tsconfig.json, and that is why the entries are committed
 *
 * `next dev` appends `<distDir>/types/**` and `<distDir>/dev/types/**` to `include` on startup, and
 * reformats the file while it is there. Left uncommitted those two lines would make tsconfig.json
 * dirty for as long as this server runs — and `scripts/build-id.mjs` stamps a `+` on any build made
 * against a dirty tree, so a permanently-dirty file would put a `+` on every build id from now on
 * and the mark would stop meaning "built with uncommitted changes". They are checked in instead. An
 * `include` path that does not exist costs nothing on a checkout that never runs this.
 *
 * Changing the port here therefore has a second cost: Next appends a fresh pair of entries for the
 * new directory. Prefer keeping 5055.
 *
 * Usage: `node scripts/dev-alt.mjs [port] [distDir]`
 */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';

const port = process.argv[2] || '5055';
// Keyed on the port so two alternates cannot collide either, and so the directory says on sight
// which server made it. Ignored by `.gitignore`'s `/.next-dev-*/`.
const distDir = process.argv[3] || `.next-dev-${port}`;

// Resolved rather than shelled out to: `npx` on Windows needs `shell: true`, and a shell in the
// middle swallows the signal that stops the server.
const nextBin = createRequire(import.meta.url).resolve('next/dist/bin/next');

const child = spawn(process.execPath, [nextBin, 'dev', '-p', port], {
    stdio: 'inherit',
    env: { ...process.env, NEXT_DIST_DIR: distDir },
});

// Pass the child's ending through as our own, so the harness sees a crash as a crash rather than as
// this wrapper exiting 0 over the top of it.
child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
});
child.on('error', (error) => {
    console.error(`[dev-alt] could not start next dev: ${error.message}`);
    process.exit(1);
});
