/**
 * The preview says what it sends, and why, before it sends any of it — and production's first-run
 * dialog is exactly what it was.
 *
 * Until 2026-09-24 the notice was a page on m3 that a first visit to any owner preview passed
 * through. The operator moved it into the app's own first-run dialog, and the privacy policy's
 * preview section now says that sending starts only after the owner has seen it there. Four things
 * make that sentence true, and each breaks silently:
 *
 *   1. the dialog shows it — on the preview, in the reader's language, with the policy's #preview
 *      section one click away;
 *   2. the dialog is up until it has been confirmed, whatever the disclaimer's older "don't show
 *      again" says, and when storage cannot say (a private window), it is up;
 *   3. nothing is sent before the press — no session, no error record, no flush of the outbox. The
 *      dialog is modal, but a record filed as a run ends and the flush when the gate says active are
 *      not pressed by anybody, so each send path is driven here with the dialog out of the picture;
 *   4. production and staging render the dialog as they always did (pinned against markup captured
 *      from the dialog before the notice existed), write no new key, and send nothing at all.
 *
 * The browser is simulated: a meta tag for the build, a Map for localStorage, a recorder for fetch,
 * and just enough IndexedDB for the outbox. The dialog is rendered with react-dom/server from its
 * pure half, DisclaimerDialogView — outside a browser its hooks can only answer the prerender's
 * question (Japanese, production).
 *
 *   node --experimental-strip-types --import ./scripts/ts-resolve.mjs scripts/verify-preview-notice.mjs
 *   ... --update-fixtures   rewrite the production pins. Only when production's dialog is MEANT to
 *                           change; the diff of scripts/fixtures/disclaimer-production.*.html is
 *                           then the review.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

let fails = 0;
const check = (n, c, d) => { console.log('  ' + (c ? 'PASS' : 'FAIL') + '  ' + n + (c ? '' : ' — ' + (d ?? ''))); if (!c) fails++; };

// --- a browser, as far as these modules can tell ------------------------------------------------

/** Which build this is. Production carries no app-variant tag at all. */
let variant = '';
/** The app version every record carries (build-id.mjs writes it into each document). */
const BUILD_ID = '565.51f9eeb';
globalThis.document = {
    querySelector: (selector) =>
        selector === 'meta[name="app-variant"]' ? (variant ? { getAttribute: () => variant } : null)
            : selector === 'meta[name="build-id"]' ? { getAttribute: () => BUILD_ID }
                : null,
};

class MemoryStorage {
    #items = new Map();
    /** A private window, or site data blocked: every call throws, as Safari's and Chrome's do. */
    throwing = false;
    getItem(k) { if (this.throwing) throw new Error('SecurityError'); return this.#items.has(k) ? this.#items.get(k) : null; }
    setItem(k, v) { if (this.throwing) throw new Error('SecurityError'); this.#items.set(k, String(v)); }
    removeItem(k) { if (this.throwing) throw new Error('SecurityError'); this.#items.delete(k); }
    /** The test's own look, which never throws. */
    peek(k) { return this.#items.has(k) ? this.#items.get(k) : null; }
}
let storage = new MemoryStorage();
Object.defineProperty(globalThis, 'localStorage', { get: () => storage, configurable: true });

/** Every request any module makes. The gate answers active for one account; the API takes anything. */
const requests = [];
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    requests.push({ url: String(url), method, body: init.body ? JSON.parse(init.body) : undefined });
    if (url === '/_gate/status') return json(200, { state: 'active', account_label: '#TEST' });
    if (url === '/api/diagnostics' && method === 'POST') return json(200, { storedBytes: 321 });
    if (String(url).startsWith('/api/sessions') && method === 'GET') return json(200, { sessions: [] });
    return json(404, { error: 'not_found' });
};
const sendsSince = (mark) => requests.slice(mark).filter((r) => r.url.startsWith('/api/'));
/** Until no request has been made for a while: a successful send starts a flush it does not await. */
const settle = async () => {
    for (let quiet = 0, seen = -1; quiet < 3; quiet = requests.length === seen ? quiet + 1 : 0) {
        seen = requests.length;
        await new Promise((r) => setTimeout(r, 20));
    }
};

/**
 * Just enough IndexedDB for owner-sync's outbox: open, one auto-increment store, add/getAll/delete/count.
 * Any other database fails to open — the sessions' is only ever reached here by a SYNC that should
 * have been refused, and that has to read as a failed check rather than as a crash in a stand-in.
 */
const idbOpens = [];
globalThis.indexedDB = (() => {
    const dbs = new Map();
    const request = (run) => {
        const r = { result: undefined, error: null, onsuccess: null, onerror: null };
        queueMicrotask(() => {
            try { r.result = run(); r.onsuccess?.(); } catch (e) { r.error = e; r.onerror?.(); }
        });
        return r;
    };
    const storeApi = (s) => ({
        add: (value) => request(() => { const key = s.next++; s.rows.set(key, { ...value, [s.keyPath]: key }); return key; }),
        getAll: () => request(() => [...s.rows.values()]),
        getAllKeys: () => request(() => [...s.rows.keys()]),
        delete: (key) => request(() => { s.rows.delete(key); }),
        count: () => request(() => s.rows.size),
    });
    return {
        open(name) {
            idbOpens.push(name);
            const r = { result: undefined, error: null, onupgradeneeded: null, onsuccess: null, onerror: null };
            queueMicrotask(() => {
                if (name !== 'tuner-outbox') {
                    r.error = new Error(`${name} is not simulated`);
                    r.onerror?.();
                    return;
                }
                const fresh = !dbs.has(name);
                if (fresh) dbs.set(name, new Map());
                const stores = dbs.get(name);
                r.result = {
                    createObjectStore: (n, o) => { stores.set(n, { keyPath: o?.keyPath, rows: new Map(), next: 1 }); },
                    transaction: (n) => ({ objectStore: () => storeApi(stores.get(n)) }),
                    close: () => { },
                };
                if (fresh) r.onupgradeneeded?.();
                r.onsuccess?.();
            });
            return r;
        },
    };
})();

// --- the modules under test, imported once the browser above exists -----------------------------

const { PREVIEW_NOTICE } = await import('../src/lib/session-sync/preview-notice-copy.ts');
const notice = await import('../src/lib/session-sync/preview-notice.ts');
const { gateStatus, outbox } = await import('../src/lib/session-sync/owner-sync.ts');
const client = await import('../src/lib/session-sync/client.ts');
const diagnostics = await import('../src/lib/session-sync/diagnostics.ts');
const { DisclaimerDialogView } = await import('../src/components/DisclaimerDialog.tsx');
const { privacyPolicyUrl } = await import('../src/config/links.ts');

/** A fresh copy of the acknowledgement module: what a reload of the page would start from. */
let loads = 0;
const reload = () => import(`../src/lib/session-sync/preview-notice.ts?load=${++loads}`);

const LANGS = ['ja', 'en'];
const FIELDS = ['lead', 'sessionsTitle', 'sessions', 'sessionsWhen', 'recordsTitle', 'records', 'recordsWhen',
    'alsoSent', 'purposeTitle', 'purpose', 'whereTitle', 'where', 'deleteTitle', 'deleteBody', 'policy'];

/** React's text escaping, so an expected string can be looked for in rendered markup. */
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');

const render = (lang, preview) => renderToStaticMarkup(createElement(DisclaimerDialogView, { lang, preview, onAccept: () => { } }));

/**
 * One tag per line, so a pin that breaks says where; and an icon reduced to its name and classes.
 * The icon's path data is lucide's, not this dialog's — a lucide upgrade must not read as the dialog
 * changing, while swapping the icon or its classes still does.
 */
const normalize = (html) => html
    .replace(/<svg\b[^>]*\bclass="([^"]*)"[^>]*>.*?<\/svg>/gs, '<svg class="$1"/>')
    .replace(/></g, '>\n<')
    .trim() + '\n';
const fixture = (lang) => new URL(`./fixtures/disclaimer-production.${lang}.html`, import.meta.url);

if (process.argv.includes('--update-fixtures')) {
    for (const lang of LANGS) writeFileSync(fixture(lang), normalize(render(lang, false)));
    console.log('Wrote scripts/fixtures/disclaimer-production.{ja,en}.html from the current production render.');
    process.exit(0);
}

// --- 1. the words ------------------------------------------------------------------------------

console.log('\n[the notice has every part, in both languages]');
for (const lang of LANGS) {
    const copy = PREVIEW_NOTICE[lang];
    const missing = FIELDS.filter((f) => typeof copy?.[f] !== 'string' || !copy[f].trim());
    check(`${lang}: all ${FIELDS.length} parts are there`, missing.length === 0, `empty: ${missing.join(', ')}`);
    const extra = Object.keys(copy ?? {}).filter((f) => !FIELDS.includes(f));
    check(`${lang}: nothing the dialog does not show`, extra.length === 0, `unshown: ${extra.join(', ')}`);
}
// m3's shared line said both also carry the browser type. This app sends none (section 5 checks the
// record), so its notice must not say so — a notice that claims more than is sent is still untrue.
check('it claims no browser type', !/ブラウザ/.test(PREVIEW_NOTICE.ja.alsoSent) && !/browser/i.test(PREVIEW_NOTICE.en.alsoSent),
    `${PREVIEW_NOTICE.ja.alsoSent} / ${PREVIEW_NOTICE.en.alsoSent}`);

// --- 2. the dialog, in each build --------------------------------------------------------------

console.log('\n[production and staging: the dialog is exactly what it was]');
for (const lang of LANGS) {
    const now = normalize(render(lang, false));
    const pinned = readFileSync(fixture(lang), 'utf8').replace(/\r\n/g, '\n');
    const firstDiff = now.split('\n').findIndex((line, i) => line !== pinned.split('\n')[i]);
    check(`${lang}: markup equals the pin taken before the notice existed`, now === pinned,
        `first difference at line ${firstDiff + 1}: ${JSON.stringify(now.split('\n')[firstDiff])}`);
    check(`${lang}: no part of the notice`, !FIELDS.some((f) => f !== 'policy' && now.includes(esc(PREVIEW_NOTICE[lang][f]))),
        'a production build would be describing sends it never makes');
    check(`${lang}: its policy link is still #tuner`, now.includes(`href="${privacyPolicyUrl(lang, false)}"`));
}

console.log('\n[the preview: the dialog carries the notice]');
for (const lang of LANGS) {
    const html = render(lang, true);
    const copy = PREVIEW_NOTICE[lang];
    const absent = FIELDS.filter((f) => !html.includes(esc(copy[f])));
    check(`${lang}: every part of the notice is on the dialog`, absent.length === 0, `missing: ${absent.join(', ')}`);

    const link = [...html.matchAll(/<a\b([^>]*)>([^<]*)<\/a>/g)];
    const policy = link.find(([, , text]) => text === esc(copy.policy));
    check(`${lang}: the policy link reads as the notice's last line`, !!policy, `links: ${link.map((m) => m[2]).join(' | ')}`);
    check(`${lang}: ...and goes to the policy's preview section`, !!policy && policy[1].includes(`href="${privacyPolicyUrl(lang, true)}"`),
        policy?.[1]);
    check(`${lang}: ...in a new tab, without an opener`, !!policy && policy[1].includes('target="_blank"') && policy[1].includes('rel="noopener noreferrer"'),
        'a same-tab navigation drops the serial link and an unsaved run with it');
    check(`${lang}: one policy link, not two`, link.length === 1, `${link.length} links`);
    check(`${lang}: no #tuner anywhere`, !html.includes('#tuner'), 'the preview is not the build section 9 describes');

    // After the note that says what the press accepts: "the above" must stay the five disclaimer items.
    const agreeNote = { ja: '上記に同意したものとみなします', en: 'is taken as your acceptance of the above' }[lang];
    check(`${lang}: the notice comes after the agree note, not under it`,
        html.indexOf(agreeNote) >= 0 && html.indexOf(agreeNote) < html.indexOf(esc(copy.lead)),
        'placed above the note, the notice would become terms the button accepts');
    check(`${lang}: in the notice's own order`,
        FIELDS.map((f) => html.indexOf(esc(copy[f]))).every((at, i, all) => i === 0 || at > all[i - 1]));

    // The rest is production's dialog, untouched: every line of it but the link, in order.
    const production = normalize(render(lang, false)).split('\n').filter((l) => !l.startsWith('<a '));
    let matched = 0;
    for (const line of normalize(html).split('\n')) if (line === production[matched]) matched++;
    check(`${lang}: everything else is production's dialog, in order`, matched === production.length,
        `lost from line ${matched + 1}: ${production[matched]}`);
}

// --- 3. when the dialog is up --------------------------------------------------------------------

console.log('\n[when the dialog is up]');
{
    const open = (preview, d, n) => notice.firstRunDialogOpen({ preview, disclaimerAcknowledged: d, noticeAcknowledged: n });
    check('preview: an old "don\'t show again" does NOT hide a notice never confirmed', open(true, true, false) === true,
        'the one case this whole change exists for');
    check('preview: open while neither is recorded', open(true, false, false));
    check('preview: open while the disclaimer is not "don\'t show again", as it always was', open(true, false, true));
    check('preview: closed once both are', !open(true, true, true));
    for (const n of [false, true]) {
        check(`production: the notice's state changes nothing (notice ${n ? 'confirmed' : 'not confirmed'})`,
            open(false, false, n) === true && open(false, true, n) === false);
    }
}

// --- 4. the acknowledgement ----------------------------------------------------------------------

console.log('\n[the acknowledgement: its key, and what storage can do to it]');
{
    check("the key is 'preview-notice:v1'", notice.PREVIEW_NOTICE_KEY === 'preview-notice:v1', notice.PREVIEW_NOTICE_KEY);

    variant = 'preview';
    storage = new MemoryStorage();
    storage.setItem('e46m3csl:disclaimer-ack', '1');
    let page = await reload();
    check("an old \"don't show again\" is not the notice's acknowledgement", !page.previewNoticeAcknowledged());

    let told = 0;
    page.subscribePreviewNotice(() => told++);
    page.acknowledgePreviewNotice();
    const stored = storage.peek('preview-notice:v1');
    check('pressing the button writes the key', stored !== null && !Number.isNaN(Date.parse(stored)), `stored ${stored}`);
    check('...holds for this page', page.previewNoticeAcknowledged());
    check('...and tells its subscribers (the gate status asks again)', told === 1, `told ${told} time(s)`);
    page = await reload();
    check('...and for the next load', page.previewNoticeAcknowledged());

    storage = new MemoryStorage();
    storage.throwing = true;
    page = await reload();
    check('storage that throws reads as NOT confirmed — the dialog shows', !page.previewNoticeAcknowledged());
    let threw = null;
    try { page.acknowledgePreviewNotice(); } catch (e) { threw = e; }
    check('...the press does not throw', threw === null, threw?.message);
    check('...and holds for this page, so the app is usable', page.previewNoticeAcknowledged());
    page = await reload();
    check('...and the next load asks again', !page.previewNoticeAcknowledged());

    for (const build of ['', 'staging']) {
        variant = build;
        storage = new MemoryStorage();
        page = await reload();
        page.acknowledgePreviewNotice();
        check(`${build || 'production'}: the press writes no new key`, storage.peek('preview-notice:v1') === null,
            "production's privacy policy names every localStorage key that build writes");
    }
}

// --- 5. nothing is sent before the press -------------------------------------------------------------

console.log('\n[the preview sends nothing before the notice is confirmed]');
const record = (id) => ({
    id, kind: 'read', createdAt: 1_758_600_000_000, completed: false, error: 'verify: nothing was connected',
    vin: null, softwareVersion: null, transport: null, mock: true, sessionId: null, report: null, events: null,
});
const pending = outbox('tuner-outbox');
{
    variant = 'preview';
    storage = new MemoryStorage();
    // The page's own status check on load, which is allowed: it sends nothing of the owner's and is how
    // a record queued now learns whose it is (owner-sync stamps the outbox with this account).
    await gateStatus();
    const mark = requests.length;
    const opensBefore = idbOpens.length;

    check('not confirmed on a first visit', !notice.previewNoticeAcknowledged());

    const up = await diagnostics.uploadDiagnostic(record('before-1'));
    check('an error record is not sent...', sendsSince(mark).length === 0, JSON.stringify(sendsSince(mark)));
    check('...but kept in the outbox, where a record that cannot go yet waits', (await pending.count()) === 1);
    check('...and says why', !up.ok && /notice/.test(up.reason), JSON.stringify(up));

    check('the outbox flush sends nothing', (await diagnostics.flushDiagnostics()) === 0);
    check('...not even the gate check it opens with', requests.length === mark, JSON.stringify(requests.slice(mark)));

    let refusal = null;
    try { await client.syncSession({ id: 'session-under-test', label: 'x', createdAt: 0 }); } catch (e) { refusal = e; }
    check('SYNC refuses', refusal instanceof client.SyncError && refusal.kind === 'notice', String(refusal));
    check('...before reading the session to send it', idbOpens.slice(opensBefore).every((n) => n === 'tuner-outbox'),
        `opened ${idbOpens.slice(opensBefore).join(', ')}`);

    for (const [name, run] of [
        ['listing stored sessions', () => client.listStoredSessions()],
        ['restoring a session', () => client.restoreSession('x')],
        ['deleting a stored session', () => client.deleteStoredSession('x')],
        ['listing stored records', () => diagnostics.listStoredDiagnostics()],
        ['deleting a stored record', () => diagnostics.deleteStoredDiagnostic('x')],
    ]) {
        let e = null;
        try { await run(); } catch (err) { e = err; }
        check(`${name} refuses`, e instanceof client.SyncError && e.kind === 'notice', String(e));
    }
    check('no store request of any kind went out', sendsSince(mark).length === 0, JSON.stringify(sendsSince(mark)));

    console.log('\n[...and once it is, what waited goes]');
    notice.acknowledgePreviewNotice();
    const at = requests.length;
    check('the flush sends the kept record', (await diagnostics.flushDiagnostics()) === 1);
    const sent = sendsSince(at);
    check('...as the record it was', sent.length === 1 && sent[0].method === 'POST' && sent[0].body?.id === 'before-1',
        JSON.stringify(sent));
    check('...and the outbox is empty', (await pending.count()) === 0);

    const after = requests.length;
    const direct = await diagnostics.uploadDiagnostic(record('after-1'));
    const wire = sendsSince(after).find((r) => r.body?.id === 'after-1')?.body;
    check('a new record goes straight out', direct.ok && !!wire, JSON.stringify(direct));

    // What the notice says every record carries, and what it does not say — checked on the wire.
    check('...carrying the app version, as the notice says', wire?.appBuild === BUILD_ID, JSON.stringify(wire?.appBuild));
    const everything = wire ? JSON.stringify(wire) + JSON.stringify(await client.gunzipJson(client.fromBase64(wire.payloadGz))) : '';
    check('...and no user agent, which it does not say', !!navigator.userAgent && !everything.includes(navigator.userAgent)
        && !/user.?agent/i.test(everything), 'the notice would have to name the browser type');

    // The communication log the records line names: its timings and retries, and the DME's replies,
    // which the event log holds (linkEventLog.ts: "phase transitions and answers from the DME").
    const logAt = requests.length;
    const logged = {
        ...record('after-2'),
        report: { kind: 'read', completed: false, error: null, chunks: 3, elapsedMs: 120, baud: 125_000, requestedBaud: 125_000,
            retries: 2, median: { turnaround: 5, total: 9, hostGap: 1 } },
        events: { startedAt: 1_758_600_000_000, dropped: 0, events: [{ t: 0, message: 'verify: the DME answered 0x7F' }] },
    };
    await diagnostics.uploadDiagnostic(logged);
    const logWire = sendsSince(logAt).find((r) => r.body?.id === 'after-2')?.body;
    const logPayload = logWire ? await client.gunzipJson(client.fromBase64(logWire.payloadGz)) : null;
    check('...carrying the communication log, as the notice says: timings, retries, the DME\'s replies',
        logWire?.elapsedMs === 120 && logWire?.retries === 2
        && logPayload?.events?.events?.[0]?.message === logged.events.events[0].message,
        JSON.stringify({ elapsedMs: logWire?.elapsedMs, retries: logWire?.retries, events: logPayload?.events }));
    const listed = await client.listStoredSessions().then(() => true, (e) => String(e));
    check('store requests go through', listed === true, listed);
}

// --- 6. production and staging -------------------------------------------------------------------

console.log('\n[production and staging send nothing, confirmed or not]');
for (const build of ['', 'staging']) {
    variant = build;
    storage = new MemoryStorage();
    storage.setItem('preview-notice:v1', new Date().toISOString());   // even with a stray key
    await settle();                                                    // the preview's last flush first
    const mark = requests.length;
    const label = build || 'production';
    const before = await pending.count();
    const up = await diagnostics.uploadDiagnostic(record(`${label}-1`));
    check(`${label}: a record is neither sent nor kept`, !up.ok && up.reason === 'this build has no store' && (await pending.count()) === before,
        JSON.stringify(up));
    check(`${label}: the flush does nothing`, (await diagnostics.flushDiagnostics()) === 0);
    let e = null;
    try { await client.listStoredSessions(); } catch (err) { e = err; }
    check(`${label}: a store request refuses as "no store"`, e instanceof client.SyncError && e.kind === 'failed', String(e));
    check(`${label}: not one request`, requests.length === mark, JSON.stringify(requests.slice(mark)));
}

console.log(fails === 0 ? '\nAll preview-notice checks passed.\n' : `\n${fails} FAILED\n`);
process.exit(fails === 0 ? 0 : 1);
