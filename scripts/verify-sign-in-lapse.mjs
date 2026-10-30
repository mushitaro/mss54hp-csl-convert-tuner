/**
 * WORKS hears that its sign-in has lapsed, goes through the gate again by itself only when that
 * loses nothing, and otherwise says so — and production behaves exactly as it did.
 *
 * On 2026-10-29 the head unit's sign-in cookies vanished when its clock was put right, and because
 * the service worker answers navigations from its cache, the gate's page never appeared: WORKS ran
 * an old build in silence, its update check got 401 and returned, and RELOAD reloaded the old build.
 * What has to hold now, and how each breaks silently:
 *
 *   1. the decision (lib/session-sync/sign-in-lapse): the trip is taken only lapsed, with the clock
 *      agreeing, no link, nothing unsaved, online, and the guard open; the clock being out wins over
 *      everything else; nothing at all happens while signed in;
 *   2. the guard: once in ten minutes per tab, and when storage cannot be read or written the trip
 *      is not taken — a trip that cannot be counted could loop;
 *   3. the canonical client the app calls (owner-sync, copied byte for byte from tsunagi-m3): the
 *      device's clock rides on /_gate/status and on the way back in, and clockAgrees reads the
 *      response's Date header to within a day;
 *   4. the wiring: the update check reads a 401 only behind the gate (production has none, and its
 *      check must stay what it was), the page spends the guard before it leaves, and no update is
 *      offered while signed out;
 *   5. the notice's words exist in both languages.
 *
 *   node --experimental-strip-types --import ./scripts/ts-resolve.mjs scripts/verify-sign-in-lapse.mjs
 */
import { readFileSync } from 'node:fs';

let fails = 0;
const check = (n, c, d) => { console.log('  ' + (c ? 'PASS' : 'FAIL') + '  ' + n + (c ? '' : ' — ' + (d ?? ''))); if (!c) fails++; };

class MemoryStorage {
    #items = new Map();
    /** A private window, or site data blocked: every call throws, as Safari's and Chrome's do. */
    throwing = false;
    getItem(k) { if (this.throwing) throw new Error('SecurityError'); return this.#items.has(k) ? this.#items.get(k) : null; }
    setItem(k, v) { if (this.throwing) throw new Error('SecurityError'); this.#items.set(k, String(v)); }
    removeItem(k) { if (this.throwing) throw new Error('SecurityError'); this.#items.delete(k); }
}
let storage = new MemoryStorage();
Object.defineProperty(globalThis, 'sessionStorage', { get: () => storage, configurable: true });

const { lapseAction, repassGuardOpen, spendRepass, REPASS_KEY, REPASS_EVERY_MS } = await import('../src/lib/session-sync/sign-in-lapse.ts');
const { reauthHref, gateStatus, clockAgrees } = await import('../src/lib/session-sync/owner-sync.ts');
const { DIALOG_TEXT } = await import('../src/lib/dialog-text.ts');

// --- 1. the decision ---------------------------------------------------------------------------

console.log('\n[the decision, over every combination of the facts]');
{
    const all = [];
    for (const lapsed of [false, true])
        for (const clockAgrees of [true, false, null])
            for (const linked of [false, true])
                for (const unsaved of [false, true])
                    for (const online of [false, true])
                        for (const guardOpen of [false, true])
                            all.push({ lapsed, clockAgrees, linked, unsaved, online, guardOpen });
    const at = (f) => lapseAction(f);
    check('signed in: nothing, whatever else holds', all.filter(f => !f.lapsed).every(f => at(f) === 'none'));
    check('the clock out: the clock notice, whatever else holds', all.filter(f => f.lapsed && f.clockAgrees === false).every(f => at(f) === 'notice-clock'));
    const safe = (f) => f.lapsed && f.clockAgrees === true && !f.linked && !f.unsaved && f.online && f.guardOpen;
    check('the trip, exactly when lapsed + clock agrees + no link + nothing unsaved + online + guard open',
        all.every(f => (at(f) === 'repass') === safe(f)),
        JSON.stringify(all.find(f => (at(f) === 'repass') !== safe(f))));
    check('everything else lapsed: the sign-in notice',
        all.filter(f => f.lapsed && f.clockAgrees !== false && !safe(f)).every(f => at(f) === 'notice-signin'));
    const base = { lapsed: true, clockAgrees: true, linked: false, unsaved: false, online: true, guardOpen: true };
    check('a cable in the socket keeps the page', at({ ...base, linked: true }) === 'notice-signin');
    check('an unsaved tune or log keeps the page', at({ ...base, unsaved: true }) === 'notice-signin');
    check('offline keeps the page', at({ ...base, online: false }) === 'notice-signin');
    check('a spent guard keeps the page', at({ ...base, guardOpen: false }) === 'notice-signin');
    check('a clock nobody has reported (the gate\'s status alone) keeps the page', at({ ...base, clockAgrees: null }) === 'notice-signin');
}

// --- 2. the guard ------------------------------------------------------------------------------

console.log('\n[once in ten minutes per tab, and never uncounted]');
{
    const T = 1_793_000_000_000; // 2026-10-27
    check('ten minutes', REPASS_EVERY_MS === 600_000);
    check('a fresh tab may go', repassGuardOpen(T));
    check('the trip is counted', spendRepass(T) && storage.getItem(REPASS_KEY) === String(T));
    check('...and not taken again a minute later', !repassGuardOpen(T + 60_000));
    check('...nor at 9:59', !repassGuardOpen(T + REPASS_EVERY_MS - 1000));
    check('...but at ten minutes', repassGuardOpen(T + REPASS_EVERY_MS));
    check('a clock moved back a few minutes does not reopen it', !repassGuardOpen(T - 60_000));
    storage.setItem(REPASS_KEY, 'not a number');
    check('an unreadable count is overwritten rather than kept forever', repassGuardOpen(T));

    storage = new MemoryStorage();
    storage.throwing = true;
    check('storage refused: the guard reads as spent', !repassGuardOpen(T));
    check('...and the trip cannot be counted, so it is not taken', !spendRepass(T));

    storage = undefined;
    check('no sessionStorage at all: the guard reads as spent', !repassGuardOpen(T));
    check('...and nothing is counted', !spendRepass(T));
    storage = new MemoryStorage();
}

// --- 3. the canonical client -------------------------------------------------------------------

console.log('\n[the device\'s clock rides along, and is read against the Date header]');
{
    globalThis.location = { pathname: '/', search: '?from=manifold' };
    const href = reauthHref();
    check('the way back in keeps where it was, and carries the clock',
        /^\/_gate\/start\?return=%2F%3Ffrom%3Dmanifold&t=\d{13}$/.test(href), href);
    delete globalThis.location;

    const asked = [];
    globalThis.fetch = async (url) => {
        asked.push(String(url));
        return new Response(JSON.stringify({ state: 'expired' }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const s = await gateStatus();
    check('/_gate/status carries the clock', asked.length === 1 && /^\/_gate\/status\?t=\d{13}$/.test(asked[0]), asked.join(' '));
    check('...and "expired" is read as expired', s.state === 'expired');

    const at = (ms) => new Response(null, { status: 401, headers: { date: new Date(ms).toUTCString() } });
    const now = Date.now();
    check('a clock that agrees', clockAgrees(at(now)));
    check('23 hours out still agrees (the gate\'s own tolerance is a day)', clockAgrees(at(now - 23 * 3_600_000)));
    check('25 hours behind does not', !clockAgrees(at(now - 25 * 3_600_000)));
    check('25 hours ahead does not', !clockAgrees(at(now + 25 * 3_600_000)));
    check('the head unit at boot — 2006-12-18 against today — does not', !clockAgrees(at(now + (now - Date.UTC(2006, 11, 18)))));
    check('no Date header: not agreed', !clockAgrees(new Response(null, { status: 401 })));
    check('a Date header that is not a date: not agreed', !clockAgrees(new Response(null, { status: 401, headers: { date: 'soon' } })));
}

// --- 4. the wiring -----------------------------------------------------------------------------

console.log('\n[a 401 is read only behind the gate; the guard is spent before leaving]');
{
    const hook = readFileSync('src/hooks/useAppUpdate.ts', 'utf8');
    check('the update check reads a 401 only when gated, and returns without comparing builds',
        /if \(gatedRef\.current\) \{\s*if \(res\.status === 401\) \{[\s\S]*?clockAgrees\(res\)[\s\S]*?return;\s*\}/.test(hook));
    check('...and ungated (production, staging) a failure stays what it was: silent',
        /\n\s*if \(!res\.ok\) return;\r?\n/.test(hook) && (hook.match(/res\.status === 401/g) ?? []).length === 1);
    check('gated defaults to false', /useAppUpdate\(pollMs = [^,]+, busy = false, gated = false\)/.test(hook));

    const page = readFileSync('src/app/page.tsx', 'utf8');
    check('the page says it is gated only on WORKS', /useAppUpdate\(undefined, dmeLink\.state !== 'disconnected', isPreviewBuild\)/.test(page));
    check('lapsed is WORKS-only', /const lapsed = isPreviewBuild && \(lapse !== null \|\| gate\.state === 'expired'\);/.test(page));
    check('the trip is counted before the page leaves, and not taken if it cannot be',
        /lapseAction\(\{ \.\.\.facts, guardOpen: repassGuardOpen\(\) \}\) === 'repass' && spendRepass\(\)\) \{\s*location\.assign\(reauthHref\(\)\);/.test(page));
    check('...and never while an update is being taken', /if \(!lapsed \|\| reloading\) return;/.test(page));
    check('the notice never decides the trip (guard read as spent)', /const lapseNotice = lapseAction\(\{[\s\S]*?guardOpen: false,?\s*\}\);/.test(page));
    check('no update is offered while signed out', /const updateOffered = updateAvailable && !lapsed;/.test(page));
    // Three mentions: the hook's answer, the line above, and the menu's prop of that name.
    check('...and nothing on screen reads updateAvailable directly',
        (page.match(/\bupdateAvailable\b/g) ?? []).length === 3 && /updateAvailable=\{updateOffered\}/.test(page));
    check('SIGN IN goes through the existing reauth, with its confirm', /onClick=\{reauth\}[\s\S]{0,200}title=\{lapseText\.reauthTitle\}/.test(page)
        && /if \(unsavedWork && !confirm\(dialogText\(\)\.reauthUnsaved\)\) return;/.test(page));
    check('...and is drawn only when pressing it is safe', /lapseNotice === 'notice-signin' && reauthAllowed \? \(/.test(page)
        && /const reauthAllowed = lapsed && online && dmeLink\.state === 'disconnected' && !reloading;/.test(page));
}

// --- 5. the words ------------------------------------------------------------------------------

console.log('\n[the notice in both languages]');
{
    const keys = ['lapseSignedOut', 'lapseSignedOutShort', 'lapseWaitTitle', 'lapseClock', 'lapseClockShort', 'lapseClockTitle', 'reauthTitle'];
    const kana = /[぀-ヿ]/;
    check('Japanese for every line', keys.every(k => typeof DIALOG_TEXT.ja[k] === 'string' && kana.test(DIALOG_TEXT.ja[k])), keys.filter(k => !kana.test(DIALOG_TEXT.ja[k] ?? '')).join(', '));
    check('English for every line', keys.every(k => typeof DIALOG_TEXT.en[k] === 'string' && DIALOG_TEXT.en[k].length > 0 && !kana.test(DIALOG_TEXT.en[k])));
    check('the sign-in notice says no update can arrive, in both',
        /更新/.test(DIALOG_TEXT.ja.lapseSignedOut) && /update/i.test(DIALOG_TEXT.en.lapseSignedOut));
    check('the clock notice says it carries on by itself, in both',
        /自動/.test(DIALOG_TEXT.ja.lapseClock) && /once it's right/.test(DIALOG_TEXT.en.lapseClock));
}

console.log(fails === 0 ? '\nAll sign-in-lapse checks passed.' : '\n' + fails + ' FAILED');
process.exit(fails ? 1 : 0);
