#!/usr/bin/env node
/**
 * TSUNAGI/M mobile probe — real numbers from a real browser, at phone sizes.
 *
 * Written because the same harness got rewritten a dozen times in one session and the interesting
 * part was never the harness. Everything it reports is something that has actually been wrong here:
 * a document that scrolls when it should not, a control that renders at a third of its designed
 * size, a panel whose action row is below the fold, a tap that blocks the main thread for seconds.
 *
 *   node probe.mjs --url http://127.0.0.1:8899/
 *   node probe.mjs --url … --setup ./drive-into-state.mjs --tap "button:has-text('DASH')"
 *   node probe.mjs --url … --viewports 851x393 --throttle 4 --tap-selector '[data-menu-key="tab:diff"]'
 *
 * --setup takes a module exporting `default async (page) => {}` — use it to dismiss a disclaimer,
 * load fixture data, or otherwise get the app into the state worth measuring. Without it you are
 * measuring an empty app, which is rarely the state that breaks.
 *
 * Requires Playwright. In this environment:
 *   PW=/opt/node22/lib/node_modules/playwright/index.mjs  CHROMIUM=/opt/pw-browsers/chromium
 */

const PW = process.env.PW ?? '/opt/node22/lib/node_modules/playwright/index.mjs';
const CHROMIUM = process.env.CHROMIUM ?? '/opt/pw-browsers/chromium';
const { chromium } = await import(PW);

const argv = Object.fromEntries(
    process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1]]] : acc), []),
);

const URL_ = argv.url ?? 'http://127.0.0.1:8899/';
/** The two that break first, plus a desktop control. Wide is not optional: every mobile change has
 *  to be shown not to have moved it. */
const VIEWPORTS = (argv.viewports ?? '360x800,851x393,1440x900')
    .split(',').map(v => v.trim().split('x').map(Number));
const THROTTLE = Number(argv.throttle ?? 0);
const MIN_TARGET = Number(argv['min-target'] ?? 40);

const setup = argv.setup ? (await import(new URL(argv.setup, `file://${process.cwd()}/`).href)).default : null;

/** Registered before any app code so it catches the tasks that block the very first interaction. */
const LONGTASK_INIT = () => {
    window.__lt = [];
    try {
        new PerformanceObserver(l => l.getEntries().forEach(e => window.__lt.push(Math.round(e.duration))))
            .observe({ entryTypes: ['longtask'] });
    } catch { /* not supported; the timings below still work */ }
};

/** Everything worth knowing about a laid-out page, in one pass. */
const AUDIT = (minTarget) => {
    const vw = window.innerWidth, vh = window.innerHeight;
    const de = document.documentElement;
    const rects = [...document.querySelectorAll('*')].map(el => [el, el.getBoundingClientRect()]);
    const shown = rects.filter(([, r]) => r.width > 0 && r.height > 0);

    const describe = el => {
        const id = el.id ? `#${el.id}` : '';
        const cls = (el.className?.toString?.() ?? '').split(/\s+/).filter(Boolean).slice(0, 2).join('.');
        const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 22);
        return `${el.tagName.toLowerCase()}${id}${cls ? '.' + cls : ''}${text ? ` "${text}"` : ''}`;
    };

    return {
        // A shell sized to fit must never scroll its own document. If it does, a swipe reaches the
        // browser instead of the app.
        documentScrolls: de.scrollHeight > de.clientHeight || de.scrollWidth > de.clientWidth,
        documentOverflowY: de.scrollHeight - de.clientHeight,
        documentOverflowX: de.scrollWidth - de.clientWidth,

        // Anything laid out past the fold is a thing the user cannot reach.
        pastFold: shown.filter(([, r]) => r.bottom > vh + 0.5 && r.top < vh)
            .slice(0, 8).map(([el, r]) => `${describe(el)} +${Math.round(r.bottom - vh)}px`),

        // Scrollers that are actually scrolling. An action row inside one is a bug, not a feature.
        activeScrollers: [...document.querySelectorAll('*')]
            .filter(el => el.scrollHeight > el.clientHeight + 1 && el.clientHeight > 0
                && /auto|scroll/.test(getComputedStyle(el).overflowY))
            .slice(0, 8).map(el => `${describe(el)} over=${el.scrollHeight - el.clientHeight}px`),

        // ON-SCREEN size, so anything inside a transform: scale() is caught. This is the check that
        // found arming toggles rendering at 14x8 against a designed 36x20.
        //
        // An input whose own <label> is already a big enough target is not a finding — that is the
        // padding-cancelled-by-margin pattern working. Reporting it buries the real ones.
        smallTargets: shown
            .filter(([el]) => /^(button|a|summary)$/.test(el.tagName.toLowerCase())
                || (el.tagName === 'INPUT' && /checkbox|radio|range/.test(el.type))
                || (el.tagName === 'LABEL' && el.querySelector('input')))
            .filter(([el, r]) => {
                if (Math.min(r.width, r.height) >= minTarget) return false;
                if (el.tagName === 'INPUT') {
                    const lab = el.closest('label') ?? (el.id && document.querySelector(`label[for="${el.id}"]`));
                    if (lab) {
                        const lr = lab.getBoundingClientRect();
                        if (Math.min(lr.width, lr.height) >= minTarget) return false;
                        return false;   // the label is the target and is reported on its own
                    }
                }
                return true;
            })
            .slice(0, 12)
            .map(([el, r]) => `${describe(el)} ${Math.round(r.width)}x${Math.round(r.height)}`),

        viewport: `${vw}x${vh}`,
    };
};

const b = await chromium.launch({ executablePath: CHROMIUM });

for (const [w, h] of VIEWPORTS) {
    const mobile = w < 900;
    const ctx = await b.newContext({ viewport: { width: w, height: h }, hasTouch: mobile, isMobile: mobile, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    if (THROTTLE) await (await ctx.newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
    await page.addInitScript(LONGTASK_INIT);

    const errors = [];
    page.on('pageerror', e => errors.push(e.message.split('\n')[0].slice(0, 120)));

    await page.goto(URL_, { waitUntil: 'networkidle' });
    if (setup) await setup(page);
    await page.waitForTimeout(400);

    const audit = await page.evaluate(AUDIT, MIN_TARGET);

    console.log(`\n━━ ${w}x${h}${THROTTLE ? `  (cpu /${THROTTLE})` : ''} ━━`);
    console.log(`  document scrolls : ${audit.documentScrolls ? `YES  y+${audit.documentOverflowY} x+${audit.documentOverflowX}` : 'no'}`);
    if (audit.pastFold.length) { console.log('  below the fold   :'); audit.pastFold.forEach(l => console.log('      ' + l)); }
    if (audit.activeScrollers.length) { console.log('  scrolling        :'); audit.activeScrollers.forEach(l => console.log('      ' + l)); }
    if (audit.smallTargets.length) {
        console.log(`  under ${MIN_TARGET}px         :`);
        audit.smallTargets.forEach(l => console.log('      ' + l));
    } else console.log(`  under ${MIN_TARGET}px         : none`);

    // Optional: time one interaction and attribute it. Two rAFs so the number includes the paint.
    const target = argv['tap-selector'] ?? argv.tap;
    if (target) {
        await page.evaluate(() => { window.__lt.length = 0; });
        const t0 = Date.now();
        await page.locator(target).first().click({ force: true }).catch(e => errors.push('tap: ' + e.message.slice(0, 80)));
        await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
        const ms = Date.now() - t0;
        const lt = await page.evaluate(() => window.__lt);
        console.log(`  tap ${JSON.stringify(target)} : ${ms}ms   longtasks ${lt.length ? lt.join(', ') + ' ms' : 'none'}`);
        if (lt.some(d => d > 200)) console.log('      ^ attribute this before changing anything — CDP Profiler, self time');
    }

    if (errors.length) { console.log('  page errors      :'); errors.forEach(e => console.log('      ' + e)); }
    await ctx.close();
}

await b.close();
console.log('\nWide viewport unchanged? Say so in the commit, with the numbers.\n');
