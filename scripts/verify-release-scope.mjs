/**
 * verify:release-scope — the exclusion lists in release-scope.mjs hold what they must.
 *
 * Two published copies of this tree (main, the release; preview, the preview's source) each leave
 * things behind by a list. A list is only as good as the day it was last read, and the failures are
 * silent — a new deploy tool that reaches main, a package script left naming a file main does not
 * have, a VIN-bearing doc on the public preview branch. This reads the lists against the tree:
 *
 *   - every deploy/publication tool in scripts/ and the backend are in NOT_FOR_MAIN;
 *   - every package script whose command names a NOT_FOR_MAIN path, or runs wrangler, is stripped;
 *   - nothing main keeps imports a file main drops (build-id.mjs imports git-dirty.mjs — that one
 *     has to stay);
 *   - the preview branch publishes the backend (functions/, migrations/, wrangler.jsonc) and leaves
 *     behind archive/, the agent notes, the two docs that say where the VINs are, and the recorded
 *     session-920 BASE fixture;
 *   - text derived from BMW firmware (the Ghidra corpus, public/data/calibration-decomp.json) is
 *     left behind by BOTH lists — main and preview are both public.
 *
 * Not run on main — it is in NOT_FOR_MAIN itself; main has no lists to check.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { NOT_FOR_MAIN, NOT_FOR_MAIN_SCRIPTS, NOT_FOR_PUBLIC, excluded } from './release-scope.mjs';

let failures = 0;
const check = (label, ok, detail) => {
    if (!ok) failures++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${!ok && detail ? ` — ${detail}` : ''}`);
};

console.log('\n[main carries no backend and no deploy tooling]');
for (const p of ['functions', 'wrangler.jsonc', 'migrations', 'public/_routes.json']) {
    check(`${p} is in NOT_FOR_MAIN`, NOT_FOR_MAIN.includes(p));
}
const TOOL = /^(deploy-|publish-|release-|ship|brand-|assert-gated|gate-verify|check-branding|verify-release-scope)/;
const tools = readdirSync('scripts').filter((f) => f.endsWith('.mjs') && TOOL.test(f)).map((f) => `scripts/${f}`);
const missingTools = tools.filter((t) => !NOT_FOR_MAIN.includes(t));
check(`all ${tools.length} deploy/publication tools in scripts/ are in NOT_FOR_MAIN`, !missingTools.length, missingTools.join(', '));

console.log('\n[no script left on main names what main does not have]');
const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts;
const naming = Object.entries(scripts)
    .filter(([k]) => !k.startsWith('//'))
    .filter(([, cmd]) => NOT_FOR_MAIN.some((p) => cmd.includes(p)) || /\bwrangler\b/.test(cmd))
    .map(([k]) => k);
const unstripped = naming.filter((k) => !NOT_FOR_MAIN_SCRIPTS.includes(k));
check(`${naming.length} script(s) naming dropped paths or wrangler are all stripped`, !unstripped.length, unstripped.join(', '));
const dangling = NOT_FOR_MAIN_SCRIPTS.filter((k) => !(k in scripts));
check('every stripped script exists (a stale entry hides a renamed one)', !dangling.length, dangling.join(', '));

console.log('\n[nothing main keeps imports a file main drops]');
function walk(dir) {
    return readdirSync(dir).flatMap((e) => {
        const full = join(dir, e).replace(/\\/g, '/');
        if (['node_modules', '.next', 'out'].includes(e)) return [];
        return statSync(full).isDirectory() ? walk(full) : [full];
    });
}
const kept = [...walk('scripts'), ...walk('src')]
    .filter((f) => ['.mjs', '.ts', '.tsx', '.js'].includes(extname(f)) && !excluded(f, NOT_FOR_MAIN));
const droppedScripts = NOT_FOR_MAIN.filter((p) => p.startsWith('scripts/')).map((p) => p.slice('scripts/'.length));
const reaching = kept.filter((f) => {
    const text = readFileSync(f, 'utf8');
    return droppedScripts.some((d) => new RegExp(`from\\s+['"][^'"]*/${d.replace('.', '\\.')}['"]`).test(text));
});
check(`${kept.length} kept file(s) import nothing dropped`, !reaching.length, reaching.join(', '));
check('git-dirty.mjs (imported by build-id.mjs) stays on main', !excluded('scripts/git-dirty.mjs', NOT_FOR_MAIN));
check('the gate client (compiled into every build) stays on main', !excluded('src/lib/session-sync/owner-sync.ts', NOT_FOR_MAIN));

console.log('\n[the preview branch publishes what it serves, and nothing that points at a VIN]');
for (const p of ['functions/_middleware.ts', 'migrations/0006_owner.sql', 'wrangler.jsonc', 'scripts/check-public-tree.mjs']) {
    check(`${p} is published on preview`, existsSync(p) && !excluded(p, NOT_FOR_PUBLIC));
}
for (const p of ['archive/idle.sql', '.claude/settings.json', 'CLAUDE.md', 'docs/release-environments.md', 'docs/preview-deployment.md', 'scripts/fixtures/session-920-base.bin']) {
    check(`${p} is left behind`, excluded(p, NOT_FOR_PUBLIC));
}

console.log('\n[no public branch carries text derived from BMW firmware]');
for (const p of ['public/data/calibration-decomp.json']) {
    check(`${p} is left off main (NOT_FOR_MAIN)`, excluded(p, NOT_FOR_MAIN));
    check(`${p} is left off preview (NOT_FOR_PUBLIC)`, excluded(p, NOT_FOR_PUBLIC));
}

console.log(failures ? `\n${failures} failure(s).` : '\nrelease scope: ok');
process.exit(failures ? 1 : 0);
