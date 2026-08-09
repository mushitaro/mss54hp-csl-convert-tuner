#!/usr/bin/env node
/**
 * Does the installed app actually take a new build when told to?
 *
 * Written because the honest answer here was no, and nothing short of this found it. An offline
 * cache serves the navigation from disk, so `location.reload()` returns the build already
 * installed — the one the "Update available" row is offering to replace. Reading the code does not
 * show it. Loading the page does not show it. The only thing that shows it is having two builds and
 * a worker that has claimed the page.
 *
 *   node update-check.mjs --a ./out-old --b ./out-new
 *   node update-check.mjs --a ./out-old --b ./out-new --setup ./dismiss-disclaimer.mjs \
 *                         --open 'button[aria-label="Open menu"]' --tap 'button:has-text("Reload")'
 *
 *   --a / --b   two built output directories. Give them a real source difference, or their hashed
 *               chunk names come out identical and there is nothing to detect.
 *   --setup     module exporting `default async (page) => {}`; same convention as probe.mjs.
 *   --open      optional selector to click first (the menu the control lives behind).
 *   --tap       the control under test. Defaults to a button whose text mentions reload.
 *   --viewport  WxH, default 360x800.
 *
 * Reports four things, and the last two are the ones people skip:
 *
 *   control     a plain location.reload() — expected to come back STALE. If this says fresh, the
 *               cache is not in front of the navigation and the rest of the run proves nothing.
 *   the control under test — must come back FRESH.
 *   no-update   pressing it with nothing new on the server must still reload, not hang.
 *   offline     pressing it with the network cut must still reload, from cache.
 *
 * Requires Playwright. In this environment:
 *   PW=/opt/node22/lib/node_modules/playwright/index.mjs  CHROMIUM=/opt/pw-browsers/chromium
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { serve } from './serve-like-pages.mjs';

const PW = process.env.PW ?? '/opt/node22/lib/node_modules/playwright/index.mjs';
const CHROMIUM = process.env.CHROMIUM ?? '/opt/pw-browsers/chromium';
const { chromium } = await import(PW);

const argv = Object.fromEntries(
    process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1]]] : acc), []),
);
if (!argv.a || !argv.b) { console.error('usage: update-check.mjs --a <dir> --b <dir> [--setup m] [--open sel] [--tap sel]'); process.exit(1); }

const A = resolve(argv.a), B = resolve(argv.b);
const PORT = Number(argv.port ?? 8899);
const URL_ = `http://127.0.0.1:${PORT}/`;
const [W, H] = (argv.viewport ?? '360x800').split('x').map(Number);
const TAP = argv.tap ?? 'button:has-text("Reload")';
const setup = argv.setup ? (await import(new URL(argv.setup, `file://${process.cwd()}/`).href)).default : null;

/** A live directory the server points at, swapped under it between phases. Replaced by rename so
 *  there is no window in which the tree is half-copied. */
const LIVE = join(process.env.TMPDIR ?? '/tmp', `update-check-${process.pid}`);
const swap = (from) => execSync(`rm -rf ${LIVE}.new && cp -r ${from} ${LIVE}.new && rm -rf ${LIVE} && mv ${LIVE}.new ${LIVE}`);

/** Which build a page is running, by the script names only that build has. Hashed asset names are
 *  the one thing already guaranteed unique per build — no version file to keep in step. */
const scriptsOf = (dir) => [...readFileSync(join(dir, 'index.html'), 'utf8').matchAll(/<script[^>]+src="([^"]+)"/g)].map(m => m[1]);
const onlyA = scriptsOf(A).filter(s => !scriptsOf(B).includes(s))[0];
const onlyB = scriptsOf(B).filter(s => !scriptsOf(A).includes(s))[0];
if (!onlyA || !onlyB) {
    console.error('The two builds have identical script names — nothing to detect. Give them a real source difference.');
    process.exit(1);
}
const RUNNING = () => [...document.querySelectorAll('script[src]')].map(s => new URL(s.src, location.href).pathname).join(',');
const which = (list) => list.includes(onlyB) ? 'FRESH (build B)' : list.includes(onlyA) ? 'stale (build A)' : 'unrecognised';

swap(A);
const server = await serve(LIVE, PORT);
const browser = await chromium.launch({ executablePath: CHROMIUM });

/** Open the app and wait until the worker is *controlling* it — merely registered intercepts
 *  nothing, and a run that starts before that measures the network, not the cache. */
async function armed(ctx) {
    const page = await ctx.newPage();
    page.on('dialog', d => d.accept());
    await page.goto(URL_, { waitUntil: 'networkidle' });
    if (setup) await setup(page);
    await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 30000 })
        .catch(() => console.log('  ! no controlling service worker — this run measures nothing'));
    return page;
}

async function press(page) {
    if (argv.open && typeof argv.open === 'string') {
        await page.locator(argv.open).first().click({ force: true }).catch(() => { });
        await page.waitForTimeout(500);
    }
    await page.locator(TAP).first().click({ force: true }).catch(e => console.log('  ! tap:', e.message.split('\n')[0]));
    await page.waitForLoadState('domcontentloaded').catch(() => { });
    await page.waitForTimeout(2500);
}

const ctxOpts = { viewport: { width: W, height: H }, hasTouch: true, isMobile: W < 900 };
console.log(`\nmarker A ${onlyA}\nmarker B ${onlyB}\n`);

// 1. Control. A plain reload with a newer build on the server should come back STALE — that is the
//    bug this whole script is about, and if it does not reproduce, nothing below is meaningful.
{
    swap(A);
    const ctx = await browser.newContext(ctxOpts);
    const page = await armed(ctx);
    swap(B);
    await page.evaluate(() => location.reload());
    await page.waitForLoadState('domcontentloaded').catch(() => { });
    await page.waitForTimeout(2500);
    console.log(`control    plain location.reload()      → ${which(await page.evaluate(RUNNING))}`);
    await ctx.close();
}

// 2. The control under test, in the same situation.
{
    swap(A);
    const ctx = await browser.newContext(ctxOpts);
    const page = await armed(ctx);
    swap(B);
    await press(page);
    console.log(`update     ${TAP.slice(0, 28).padEnd(28)}  → ${which(await page.evaluate(RUNNING))}`);
    await ctx.close();
}

// 3. Degradation. Both of these are reloads the user asked for and must get: an update that turned
//    out not to exist, and no network at all. A button that hangs here is worse than the bug.
{
    swap(A);
    const ctx = await browser.newContext(ctxOpts);
    const page = await armed(ctx);
    const t0 = Date.now();
    await press(page);
    console.log(`no-update  nothing new on the server    → ${page.url() === URL_ ? 'reloaded' : 'LOST THE PAGE'}  ${Date.now() - t0}ms`);
    await ctx.close();
}
{
    swap(A);
    const ctx = await browser.newContext(ctxOpts);
    const page = await armed(ctx);
    await ctx.setOffline(true);
    const t0 = Date.now();
    await press(page);
    const body = await page.evaluate(() => document.body.innerText.length).catch(() => 0);
    console.log(`offline    network cut                  → ${body > 40 ? 'reloaded from cache' : 'BLANK'}  ${Date.now() - t0}ms`);
    await ctx.close();
}

await browser.close();
server.close();
execSync(`rm -rf ${LIVE} ${LIVE}.new`);
console.log('\nControl stale + update fresh + both degradations reloading is the passing shape.\n');
