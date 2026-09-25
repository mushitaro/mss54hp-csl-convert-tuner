/**
 * What leaves this machine, and on which branch — declared once, as data.
 *
 * Two copies of the development tree are published, and each leaves different things behind:
 *
 *   main      the release (GitHub Pages). A static app, so it carries no backend, no gate, no
 *             infrastructure and no deploy tooling — see NOT_FOR_MAIN.
 *   preview   the source of what the preview project serves (tsunagi-m3's MESH page promises the
 *             tools' source is open, and the preview is one of the tools). It DOES carry functions/,
 *             migrations/ and wrangler.jsonc, because those are part of what is served. What it
 *             leaves behind is only what must never be public — see NOT_FOR_PUBLIC.
 *
 * Both are single-parent TREE COPIES of `feat/develop` (release-to-main.mjs, publish-preview.mjs),
 * never merges: feat/develop's history has carried real VINs and DME images, and a push carries
 * every object reachable from what is pushed.
 *
 * Imported by release-to-main.mjs, publish-preview.mjs, deploy-preview.mjs and verify-release-scope
 * rather than restated in each — a list kept in step by hand is a list that drifts. It is its own
 * module because release-to-main.mjs RUNS the release when it is imported.
 */

/** The development branch. Releases and previews are copied from its committed tree. */
export const SOURCE = 'feat/develop';

/** The branch the preview's source is published on, and the Pages project it is served from. */
export const PREVIEW_BRANCH = 'preview';
export const PREVIEW_PROJECT = 'mss54hp-csl-convert-tuner-preview';

/**
 * Paths that stay off main. Declared here rather than remembered, so that the exclusion is code a
 * future reader can argue with — and so `verify:release-scope` can check it.
 */
export const NOT_FOR_MAIN = [
    // The backend: the owner gate and the SYNC API. `sessionSync` is `preview-only` by decision —
    // production's privacy policy says sessions never leave the device — so its receiver is not
    // production's source, and a deploy that compiles functions from its working directory must
    // never find one in main's.
    'functions',
    'wrangler.jsonc',
    'migrations',
    // Cloudflare's routing file for Functions. Main has none to route.
    'public/_routes.json',
    // Deploy and publication tooling: main does not deploy itself and must not learn how.
    'scripts/deploy-staging.mjs',
    'scripts/deploy-preview.mjs',
    'scripts/publish-preview.mjs',
    'scripts/assert-gated.mjs',
    'scripts/gate-verify.mjs',
    'scripts/brand-preview.mjs',
    'scripts/brand-label.mjs',
    'scripts/check-branding.mjs',
    'scripts/release-to-main.mjs',
    'scripts/release-scope.mjs',
    'scripts/verify-release-scope.mjs',
    'scripts/ship.mjs',
    // They say where the VINs are, which is a signpost worth not putting up in public.
    'docs/release-environments.md',
    'docs/preview-deployment.md',
    // Ghidra's decompiled C of the 0401 program — text derived from BMW firmware, which no public
    // branch carries. Off main for the same reason it is off the preview (NOT_FOR_PUBLIC below);
    // production falls back to quoted names without it, and verify:cal-decomp / verify:cal-docs
    // SKIP on a tree that lacks it.
    'public/data/calibration-decomp.json',
];

/**
 * package.json entries that would name a file that is no longer there, or infrastructure main does
 * not have.
 *
 * Stripped rather than left to fail, because a script in a public repository is a claim that it
 * runs. Both halves of a `//comment` + entry pair go.
 */
export const NOT_FOR_MAIN_SCRIPTS = [
    'preview', 'deploy:preview', 'deploy:staging', 'build:preview', 'publish:preview', 'release', 'ship',
    'gate:verify', 'verify:release-scope',
    'db:migrate:local', 'db:migrate:remote', 'db:sessions', 'db:diagnostics',
];

/**
 * Paths that stay off the public `preview` branch. Much shorter than NOT_FOR_MAIN, because the
 * preview's backend is part of what is served and so is part of what is published.
 *
 *   archive/            D1 dumps: real VINs and DME images. Gitignored now, and in history.
 *   .claude/, CLAUDE.md  agent configuration and working notes, not the tool.
 *   the two docs        they say where the VINs are.
 *   calibration-decomp  Ghidra's decompiled C of the 0401 master/slave PROGRAM — text derived from
 *                       BMW firmware, which no public branch of these tools carries (tsunagi-m3's
 *                       plan, 2026-09-23). It is in NOT_FOR_MAIN too. It is not on origin/main, but
 *                       the LOCAL main (1d542df, 7 unpushed commits ahead of origin/main on
 *                       2026-09-23) does carry it: that main must be re-cut from origin/main with
 *                       this exclusion before the next push (docs/release-environments.md §6). The
 *                       preview SERVES it to signed-in owners, and the app falls back to quoted
 *                       names without it, which is what a clone of either public branch sees.
 *                       Whether it may be published at all (karter16 publishes the Ghidra output)
 *                       is the operator's decision, not this list's; until then it stays off.
 *   session-920-base    the 64 KB calibration partial of one recorded session on the developer's
 *                       own car (scripts/fixtures). Already on origin/main, which is the operator's
 *                       call; kept off the preview branch because being public once is no reason
 *                       to publish it on a second branch. verify:model-gate, verify:shape-repair
 *                       and verify:restore-tables SKIP without it.
 *
 * `*.sql` under archive/ is covered by `archive` itself; listed so the rule reads as written.
 */
export const NOT_FOR_PUBLIC = [
    'archive',
    'archive/*.sql',
    '.claude',
    'CLAUDE.md',
    'docs/release-environments.md',
    'docs/preview-deployment.md',
    'public/data/calibration-decomp.json',
    'scripts/fixtures/session-920-base.bin',
];

/** Whether `path` (a git path, forward slashes) falls under one of `list`. */
export function excluded(path, list) {
    return list.some((p) => {
        if (p.includes('*')) {
            const re = new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`);
            return re.test(path);
        }
        return path === p || path.startsWith(`${p}/`);
    });
}
