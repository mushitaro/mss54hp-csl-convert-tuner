/**
 * The tab's half of the assistant bridge.
 *
 *   the moment   cutMoment finds the window on the tab's clock and the events in it: a loss of
 *                acceleration with the throttle held, a knock retard placed in time from its counter
 *                (n combustions at r rpm = n * 120 / r s before the read), a cylinder fired low, a
 *                gear change, both trims reset with the throttle shut (and where the pedal was), a
 *                link gap; it thins long windows without dropping
 *                a slow-lane row, and says when there is nothing to cut
 *   the rules    stopping needs `confirmed: true`; starting refuses with the screen's own reason;
 *                only this build's views can be shown; an unknown tool is not answered
 *   left out     tuner_status says, for each reason samples were left out, how many, its name and
 *                what to do next time, in the dialogs' language — the census sheet's own sentences,
 *                from the one module both read
 *   the client   ticket → socket with the ticket in the subprotocols → hello → answers, a handler's
 *                throw as ok:false; signed out retries slowly; no bridge configured stops; another
 *                tab taking over (4000) stops instead of fighting for the socket
 *   the ticket   the function's format: v1.<payload>.<HMAC-SHA256>, sixty seconds, this owner
 *   save & sync  SAVE, sending to the cloud and bringing a session back, each only with
 *                `confirmed: true` after a read-back; no VIN in the cloud's listing
 *   notebook     the plan (written as the next version, refused while a log records, a fork never
 *                rewritten), the driver's own words on the run's clock, findings refused while
 *                recording and without evidence, a reading that disagrees standing beside the other,
 *                an answer as the driver's; the moment of an earlier run, and the words in a window
 *   calibration  reading a parameter (its value, its byte, the XDF's choices, how the code tests
 *                it); staging a change only with `confirmed: true`, a whole row as one fill; the
 *                recipes compared with the open BIN, step by step, with how sure each is
 *
 * What a wrong answer costs: an assistant told "cylinder 3 knocked" about a knock that happened a
 * minute earlier, a log stopped by a misheard word, a head unit and a laptop trading the bridge
 * every few seconds, or a driver told "highLoadSettle" where the screen says "hold the pull longer".
 * Synthetic data only.
 */
import crypto from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { cutMoment, KNOCK_AGE_NONE, MAX_ROWS } from '../src/lib/bridge/moment.ts';
import { bridgeHandlers, TOOL_NAMES } from '../src/lib/bridge/tools.ts';
import { entryProblem } from '../src/lib/notebook/rules.ts';
import { BridgeClient, BRIDGE_PROTOCOL, HELD_CLOSE_CODE } from '../src/lib/bridge/bridgeClient.ts';
// The ticket is minted by WORKS's backend, and functions/ is not on main (release-scope.mjs
// NOT_FOR_MAIN: main is static). Loaded only where the backend is, so this suite runs on main too —
// everything in it but the ticket is the tab's own code.
const TICKET = new URL('../functions/api/bridge/ticket.ts', import.meta.url);
const { mintTicket } = existsSync(TICKET) ? await import(TICKET.href) : { mintTicket: null };
import { DROP_LABEL, DROP_WHY, explainDrops } from '../src/lib/log-engine/dropReasons.ts';
import { EMPTY_CENSUS } from '../src/lib/log-engine/lambdaGates.ts';

let fails = 0;
const check = (n, c, d) => { console.log('  ' + (c ? 'PASS' : 'FAIL') + '  ' + n + (c ? '' : ' — ' + (d ?? ''))); if (!c) fails++; };
const near = (a, b, tol = 0.05) => Math.abs(a - b) <= tol;
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** A pull: 4 Hz, throttle held at 40 %, rpm climbing 600 rpm/s, 4th gear, knock counters saturated. */
function pull(t0, t1, over = () => ({})) {
    const out = [];
    for (let t = t0; t < t1 - 1e-9; t += 0.25) {
        const tt = Math.round(t * 100) / 100;
        out.push({
            time: tt, rpm: 2500 + (tt - t0) * 600, rawLoad: 30, wdk1: 40, rf: 60, stft1: 1.02, stft2: 1.01,
            gear: 4, vehicleSpeed: 90, coolantTemp: 88, exhaustTemp: 700, ...over(tt),
        });
    }
    return out;
}

console.log('\n[the window is cut on the tab\'s clock]');
{
    const s = pull(0, 60);
    const m = cutMoment({ samples: s, nowLogTime: 60, secondsAgo: 10, windowS: 20, source: 'live run' });
    check('the moment is 10 s before now', m.at === 50, String(m.at));
    // The pull ends at 59.75 s, so the window [40, 60] holds 40.00 … 59.75: 80 samples.
    check('the window holds 20 s of samples (4 Hz → 80, the last at 59.75)', m.samples === 80, String(m.samples));
    check('times are relative to the moment, from -10 to +9.75', m.rows[0][0] === -10 && m.rows.at(-1)[0] === 9.75, `${m.rows[0][0]} .. ${m.rows.at(-1)[0]}`);
    check('columns are named once, only those present', m.columns[0] === 't' && m.columns.includes('rpm') && !m.columns.includes('tz1'), m.columns.join(','));
    const empty = cutMoment({ samples: [], nowLogTime: 0, source: 'live run' });
    check('no log: said, not an empty success', empty.samples === 0 && /no log/i.test(empty.notes[0] ?? ''), JSON.stringify(empty.notes));
    const late = cutMoment({ samples: s, nowLogTime: 200, secondsAgo: 5, windowS: 10, source: 'live run' });
    check('a window after the last sample says how far after', late.samples === 0 && /last sample is/.test(late.notes[0] ?? ''), JSON.stringify(late.notes));
    const clamp = cutMoment({ samples: s, nowLogTime: 60, secondsAgo: -4, windowS: 1000, source: 'live run' });
    check('arguments out of range are clamped, not trusted', clamp.secondsAgo === 0 && clamp.windowS === 120);
}

console.log('\n[a loss of acceleration with the throttle held]');
{
    // At 30 s the climb stalls for a second: rpm flat while the pedal stays at 40 %.
    const s = pull(0, 40).map(p => (p.time >= 30 && p.time < 31) ? { ...p, rpm: 2500 + 30 * 600 } : p);
    const m = cutMoment({ samples: s, nowLogTime: 40, secondsAgo: 10, windowS: 10, source: 'live run' });
    const loss = m.events.filter(e => e.kind === 'accelLoss');
    check('found', loss.length >= 1, JSON.stringify(m.events));
    check('...at the stall (t = 0 relative to a moment at 30 s)', loss.length && near(loss[0].t, 0, 0.3), String(loss[0]?.t));
    check('...and it says the throttle was held', /throttle held at 40/.test(loss[0]?.detail ?? ''), loss[0]?.detail);
    const lift = pull(0, 40).map(p => (p.time >= 30 && p.time < 31) ? { ...p, rpm: 2500 + 30 * 600, wdk1: 10 } : p);
    const m2 = cutMoment({ samples: lift, nowLogTime: 40, secondsAgo: 10, windowS: 10, source: 'live run' });
    check('a stall with the pedal lifted is not a "loss" — it is the driver', !m2.events.some(e => e.kind === 'accelLoss'), JSON.stringify(m2.events.map(e => e.kind)));
    check('...the lift itself is reported as throttle', m2.events.some(e => e.kind === 'throttle'));
}

console.log('\n[a knock retard, placed in time from its counter]');
{
    // Slow lane every 8th sample (2 s). Cylinder 3 retarded at 30.0 s; the read at 31.0 s sees a
    // counter of 1.0 s * rpm / 120 combustions.
    const s = pull(0, 40, t => {
        const idx = Math.round(t * 4);
        if (idx % 8 !== 4) return {};
        const rpm = 2500 + t * 600;
        const since = t - 30;
        const ka = (cyl) => (cyl === 3 && since >= 0 && since * rpm / 120 < KNOCK_AGE_NONE) ? Math.round(since * rpm / 120) : KNOCK_AGE_NONE;
        const tz = (cyl) => (cyl === 3 && since >= 0 && since < 1.2) ? 18 : 22;
        return {
            knockAge1: ka(1), knockAge2: ka(2), knockAge3: ka(3), knockAge4: ka(4), knockAge5: ka(5), knockAge6: ka(6),
            ignitionAngle1: tz(1), ignitionAngle2: tz(2), ignitionAngle3: tz(3), ignitionAngle4: tz(4), ignitionAngle5: tz(5), ignitionAngle6: tz(6),
        };
    });
    const m = cutMoment({ samples: s, nowLogTime: 40, secondsAgo: 10, windowS: 10, source: 'live run' });
    const knock = m.events.filter(e => e.kind === 'knock');
    check('found once, though two reads saw it', knock.length === 1, JSON.stringify(knock));
    check('...on cylinder 3', /cylinder 3/.test(knock[0]?.detail ?? ''), knock[0]?.detail);
    check('...placed at the retard, not at the read', knock.length && near(knock[0].t, 0, 0.1), String(knock[0]?.t));
    const low = m.events.filter(e => e.kind === 'angleLow');
    check('the low angle on that read is reported for cylinder 3', low.length >= 1 && /cylinder 3/.test(low[0].detail), JSON.stringify(low));
    const before = cutMoment({ samples: s, nowLogTime: 40, secondsAgo: 2, windowS: 4, source: 'live run' });
    check('a retard from before the window is not this moment\'s', !before.events.some(e => e.kind === 'knock'), JSON.stringify(before.events));
}

console.log('\n[gear, fuel cut, link gap]');
{
    const s = [
        ...pull(0, 10),
        ...pull(10, 12, () => ({ gear: 5, rpm: 2600 })),
        ...pull(12, 14, () => ({ wdk1: 0, stft1: 1, stft2: 1 })),
    ];
    const afterGap = pull(20, 24);
    afterGap[0] = { ...afterGap[0], linkGapS: 6 };
    const m = cutMoment({ samples: [...s, ...afterGap], nowLogTime: 24, secondsAgo: 12, windowS: 24, source: 'live run' });
    const kinds = m.events.map(e => e.kind);
    check('the gear change', kinds.includes('gear') && m.events.find(e => e.kind === 'gear').detail === 'gear 4 → 5');
    check('trims reset with the throttle shut, once at its start (named for what was measured)', kinds.filter(k => k === 'trimsReset').length === 1, JSON.stringify(kinds));
    check('the link gap, with its length', m.events.some(e => e.kind === 'linkGap' && /6 s/.test(e.detail)), JSON.stringify(m.events.filter(e => e.kind === 'linkGap')));
    check('no acceleration is computed across the gap', !m.events.some(e => e.kind === 'accelLoss' && e.t > 7.5 && e.t < 8.5));
    check('the gap row carries linkGapS', m.columns.includes('linkGapS'));
}

console.log('\n[a long window is thinned, slow-lane rows kept]');
{
    const s = pull(0, 120, t => (Math.round(t * 4) % 8 === 0 ? { knockAge1: KNOCK_AGE_NONE, ignitionAngle1: 22, ignitionAngle2: 22, ignitionAngle3: 22, ignitionAngle4: 22, ignitionAngle5: 22, ignitionAngle6: 22 } : {}));
    const m = cutMoment({ samples: s, nowLogTime: 120, secondsAgo: 60, windowS: 120, source: 'loaded log' });
    const slowRows = s.filter(p => p.knockAge1 !== undefined).length;
    const tzCol = m.columns.indexOf('tz1');
    check(`at most ~${MAX_ROWS} rows`, m.rows.length <= MAX_ROWS + 2, String(m.rows.length));
    check('every slow-lane row survives', m.rows.filter(r => r[tzCol] !== null).length === slowRows, `${m.rows.filter(r => r[tzCol] !== null).length} of ${slowRows}`);
    check('...and the thinning is said', m.notes.some(n => /thinned/.test(n)));
}

console.log('\n[the rules a tool call meets]');
{
    let started = 0, stopped = 0, shown = null, running = true, refusal = null;
    const pts = pull(0, 30);
    const f = {
        status: () => ({ link: 'tuning' }),
        samples: () => ({ points: pts, live: true, nowLogTime: 30 }),
        startRefusal: () => refusal,
        startLog: () => { started++; },
        running: () => running,
        stopLog: () => { stopped++; },
        views: () => ['current', 'lambda', 'log'],
        show: v => { shown = v; },
        observePlan: () => ({ title: '', reads: [], steps: [] }), setObservePlan: () => {}, enterObserve: () => null, mark: () => {},
    };
    const h = bridgeHandlers(f);
    check('the tab answers exactly the twenty-two tools', TOOL_NAMES.length === 22 && JSON.stringify(Object.keys(h).sort()) === JSON.stringify([...TOOL_NAMES].sort()));
    let err = null;
    try { await h.tuner_stop_log({}); } catch (e) { err = e.message; }
    check('stop without confirmed: refused, nothing stopped', /confirmed: true/.test(err ?? '') && stopped === 0, err);
    err = null;
    try { await h.tuner_stop_log({ confirmed: 'yes' }); } catch (e) { err = e.message; }
    check('"yes" as a string is not a confirmation', err !== null && stopped === 0);
    const ok = await h.tuner_stop_log({ confirmed: true });
    check('stop with confirmed: true presses STOP once', ok.stopped === true && stopped === 1);
    const already = await h.tuner_start_log({});
    check('start while recording: says so, presses nothing', already.started === false && started === 0);
    running = false;
    refusal = 'The cable link is not connected.';
    err = null;
    try { await h.tuner_start_log({}); } catch (e) { err = e.message; }
    check('start refused with the screen\'s reason', err === refusal && started === 0, err);
    refusal = null;
    const go = await h.tuner_start_log({});
    check('start when the screen would start: presses START TUNE', go.started === true && started === 1);
    const noRun = await h.tuner_stop_log({ confirmed: true });
    check('stop with nothing recording: says so', noRun.stopped === false && stopped === 1);
    err = null;
    try { await h.tuner_show({ view: 'calibration' }); } catch (e) { err = e.message; }
    check('a view this build lacks is refused, with the list', /No view "calibration".*current, lambda, log/.test(err ?? '') && shown === null, err);
    await h.tuner_show({ view: ' LOG ' });
    check('a view is matched without case or spaces', shown === 'log');
    const m = await h.tuner_moment({ seconds_ago: 5, window_s: 10 });
    check('moment reads the facade\'s samples', m.source === 'live run' && m.at === 25, JSON.stringify({ s: m.source, at: m.at }));
}

console.log('\n[sessions: which is open, the list, opening one]');
{
    const at = new Date(2026, 9, 20, 21, 5).getTime();
    const rows = [
        { id: 'a', seq: 977, label: 'Session #977', status: 'archived', createdAt: at - 86_400_000, hasBase: true, hasLog: true, logPoints: 2230, mode: 'VE', open: false },
        { id: 'b', seq: 978, label: 'track day', status: 'draft', createdAt: at, hasBase: true, hasLog: true, logPoints: 5120, mode: 'VE', open: false },
        { id: 'c', seq: 979, label: 'Session #979', status: 'draft', createdAt: at + 60_000, hasBase: false, hasLog: false, logPoints: 0, mode: 'VE', open: true },
        { id: 'd', seq: 12, label: 'twin', status: 'draft', createdAt: at, hasBase: true, hasLog: false, logPoints: 0, mode: 'VE', open: false },
        { id: 'e', seq: 13, label: 'twin', status: 'draft', createdAt: at, hasBase: true, hasLog: false, logPoints: 0, mode: 'VE', open: false },
    ];
    let opened = [], refusal = null, shown = null;
    const f = {
        status: () => ({}), samples: () => null, startRefusal: () => null, startLog: () => {}, running: () => false, stopLog: () => {},
        views: () => ['startup'], closedViews: () => ['current', 'calibration'], show: v => { shown = v; },
        observePlan: () => ({ title: '', reads: [], steps: [] }), setObservePlan: () => {}, enterObserve: () => null, mark: () => {},
        sessions: () => rows,
        openRefusal: () => refusal,
        openSession: async id => { opened.push(id); return rows.find(r => r.id === id).hasBase; },
    };
    const h = bridgeHandlers(f);
    const list = await h.tuner_sessions({});
    check('the list names the open session', list.open?.session === '#979', JSON.stringify(list.open));
    check('...newest number first', list.sessions[0].session === '#979' && list.sessions[1].session === '#978', list.sessions.map(s => s.session).join(','));
    check('...with name, state, local date, BIN and log', list.sessions[1].name === 'track day' && /draft/.test(list.sessions[1].state)
        && list.sessions[1].created === '2026-10-20 21:05' && list.sessions[1].bin === true && list.sessions[1].log === 5120, JSON.stringify(list.sessions[1]));
    check('...and no file name anywhere (a BIN\'s name can carry a VIN)', !/fileName|\.bin/i.test(JSON.stringify(list)));
    const found = await h.tuner_sessions({ query: '978' });
    check('a query finds a session by its number', found.sessions.length === 1 && found.sessions[0].session === '#978', JSON.stringify(found.sessions));
    const named = await h.tuner_sessions({ query: 'TRACK' });
    check('...or by its name, without case', named.sessions.length === 1 && named.sessions[0].session === '#978');

    refusal = 'A log is recording. Opening another session would end it; stop it first (read it back to the driver).';
    let err = null;
    try { await h.tuner_open_session({ session: 978 }); } catch (e) { err = e.message; }
    check('open refused with the screen\'s reason, nothing opened', err === refusal && opened.length === 0, err);
    refusal = null;
    const ok = await h.tuner_open_session({ session: '#978' });
    check('open "#978": opens that session once', ok.opened === true && opened.join() === 'b' && ok.session.session === '#978', JSON.stringify(ok));
    check('...and says the BIN tabs are open now', /BASE loaded/.test(ok.note), ok.note);
    const byName = await h.tuner_open_session({ session: 'track day' });
    check('a session can be named instead of numbered', byName.opened === true && opened.at(-1) === 'b');
    const already = await h.tuner_open_session({ session: 979 });
    check('the open one: says so, opens nothing', already.opened === false && opened.length === 2, JSON.stringify(already));
    err = null;
    try { await h.tuner_open_session({ session: 'twin' }); } catch (e) { err = e.message; }
    check('two sessions with that name: asks for the number', /#12, #13/.test(err ?? '') && opened.length === 2, err);
    err = null;
    try { await h.tuner_open_session({ session: 4242 }); } catch (e) { err = e.message; }
    check('a number that does not exist: said, with where to look', /No session #4242/.test(err ?? '') && /tuner_sessions/.test(err ?? ''), err);
    err = null;
    try { await h.tuner_show({ view: 'calibration' }); } catch (e) { err = e.message; }
    check('a view that waits for a session says so, not "no such view"', /opens once a session with a BIN is open/.test(err ?? '') && shown === null, err);
    err = null;
    try { await h.tuner_show({ view: 'warp' }); } catch (e) { err = e.message; }
    check('a view the build does not have is still "no view"', /No view "warp"/.test(err ?? ''), err);
}

console.log('\n[calibration: reading a parameter, staging a change a person saves]');
{
    const constant = (name, bank, address, v, locked = null) => ({
        name, kind: 'constant', bank, address, units: '', description: 'gearbox type', locked, count: 1, bits: 8, dims: null,
        base: [v], current: [v], baseRaw: [v], raw: [v],
    });
    const items = [
        constant('cfg_m.getriebetyp', 'master', 0x8008, 64),
        constant('cfg_s.getriebetyp', 'slave', 0x8, 64),
        { name: 'K_SMALL_MAP', kind: 'map', bank: 'master', address: 0x9000, units: '%', description: 'a map', locked: null, count: 6,
            bits: 8, dims: { rows: 2, cols: 3 }, base: [1, 2, 3, 4, 5, 6], current: [1, 2, 9, 4, 5, 6], baseRaw: [1, 2, 3, 4, 5, 6], raw: [1, 2, 9, 4, 5, 6] },
        constant('K_SEALED', 'master', 0x7ffe, 0, 'Overlaps a checksum slot; not writable.'),
    ];
    let readRefusal = null, editRefusal = null, answer = {}, running = false;
    const edits = [];
    const f = {
        status: () => ({}), samples: () => null, startRefusal: () => null, startLog: () => {}, running: () => running, stopLog: () => {},
        views: () => ['calibration'], show: () => {},
        observePlan: () => ({ title: '', reads: [], steps: [] }), setObservePlan: () => {}, enterObserve: () => null, mark: () => {},
        calibrationRefusal: forEdit => (forEdit ? editRefusal : readRefusal),
        calibrationFind: async (q, limit) => {
            const ql = q.toLowerCase();
            const exact = items.filter(i => i.name.toLowerCase() === ql);
            return (exact.length ? exact : items.filter(i => i.name.toLowerCase().includes(ql))).slice(0, limit);
        },
        calibrationEdit: async (name, cell, value) => {
            edits.push([name, cell, value]);
            return { name, cell, from: 64, to: value, raw: value, exact: true, conflict: null, held: false, ...answer };
        },
    };
    const h = bridgeHandlers(f);
    const found = await h.tuner_calibration({ query: 'getriebetyp' });
    check('a name part finds both gearbox bytes', found.parameters?.length === 2 && found.parameters.map(p => p.name).join() === 'cfg_m.getriebetyp,cfg_s.getriebetyp', JSON.stringify(found.parameters?.map(p => p.name)));
    const m = found.parameters[0];
    check('...a constant says its value, its byte in hex, and where it is', m.value === 64 && m.raw === '0x40' && m.where === 'master 0x8008' && m.editable === 'yes', JSON.stringify(m));
    const map = (await h.tuner_calibration({ name: 'K_SMALL_MAP' })).parameters[0];
    check('a small map is read out whole, with what this session changed', map.values.join() === '1,2,9,4,5,6' && map.edited.length === 1 && map.edited[0].cell === 2 && map.edited[0].loaded === 3, JSON.stringify(map));
    const sealed = (await h.tuner_calibration({ name: 'K_SEALED' })).parameters[0];
    check('a locked parameter says why, in the screen\'s words', /^no: Overlaps a checksum slot/.test(sealed.editable), sealed.editable);
    const none = await h.tuner_calibration({ query: 'warp' });
    check('nothing found: said, not an empty list', none.found === 0 && /Nothing named/.test(none.note), JSON.stringify(none));
    readRefusal = 'No session with a BIN is open. tuner_sessions and tuner_open_session open one.';
    let err = null;
    try { await h.tuner_calibration({ query: 'getriebetyp' }); } catch (e) { err = e.message; }
    check('no BIN open: the read is refused with the reason', err === readRefusal, err);
    readRefusal = null;

    err = null;
    try { await h.tuner_calibration_edit({ name: 'cfg_m.getriebetyp', value: 3 }); } catch (e) { err = e.message; }
    check('a change without confirmed: refused, with the line to read back', /cfg_m\.getriebetyp: 64 \(0x40\) → 3/.test(err ?? '') && /confirmed: true/.test(err ?? '') && edits.length === 0, err);
    err = null;
    try { await h.tuner_calibration_edit({ name: 'cfg_m.getriebetyp', value: 3, confirmed: 'yes' }); } catch (e) { err = e.message; }
    check('"yes" as a string is not a confirmation', err !== null && edits.length === 0);
    err = null;
    try { await h.tuner_calibration_edit({ name: 'getriebe', value: 3, confirmed: true }); } catch (e) { err = e.message; }
    check('a change needs the exact name, not a part of it', /No parameter named "getriebe"/.test(err ?? '') && edits.length === 0, err);
    err = null;
    try { await h.tuner_calibration_edit({ name: 'K_SEALED', value: 1, confirmed: true }); } catch (e) { err = e.message; }
    check('a locked parameter is not changed', /cannot be edited: Overlaps a checksum slot/.test(err ?? '') && edits.length === 0, err);
    err = null;
    try { await h.tuner_calibration_edit({ name: 'K_SMALL_MAP', value: 7, confirmed: true }); } catch (e) { err = e.message; }
    check('a map without a cell: asks which, with the layout', /0 to 5, row-major, 3 per row/.test(err ?? '') && edits.length === 0, err);
    err = null;
    try { await h.tuner_calibration_edit({ name: 'K_SMALL_MAP', cell: 6, value: 7, confirmed: true }); } catch (e) { err = e.message; }
    check('...and a cell past its end is refused', err !== null && edits.length === 0, err);
    editRefusal = 'The open session is archived (read-only). Change values in a draft: NEXT on its row, on the screen, branches one.';
    err = null;
    try { await h.tuner_calibration_edit({ name: 'cfg_m.getriebetyp', value: 3, confirmed: true }); } catch (e) { err = e.message; }
    check('an archived session: refused with the screen\'s reason', err === editRefusal && edits.length === 0, err);
    editRefusal = null;
    running = true;
    err = null;
    try { await h.tuner_calibration_edit({ name: 'cfg_m.getriebetyp', value: 3, confirmed: true }); } catch (e) { err = e.message; }
    check('a log recording: refused (parked, log stopped), nothing staged', /A log is recording/.test(err ?? '') && edits.length === 0, err);
    const whileLogging = await h.tuner_calibration({ name: 'cfg_m.getriebetyp' });
    check('...though reading it is fine', whileLogging.parameters?.[0]?.value === 64);
    running = false;

    const ok = await h.tuner_calibration_edit({ name: 'CFG_M.GETRIEBETYP', value: 3, confirmed: true });
    check('confirmed: staged once, under the parameter\'s own name', ok.staged === true && edits.length === 1 && edits[0].join() === 'cfg_m.getriebetyp,0,3', JSON.stringify(edits));
    check('...and it says nothing is written until a person SAVEs and WRITEs', /Nothing is written/.test(ok.note) && /SAVE/.test(ok.note) && /WRITE/.test(ok.note), ok.note);
    answer = { to: 2.5, exact: false };
    const near = await h.tuner_calibration_edit({ name: 'K_SMALL_MAP', cell: 4, value: 2.4, confirmed: true });
    check('a value the bytes cannot hold: says the nearest it took', /nearest is 2\.5/.test(near.note) && edits.at(-1).join() === 'K_SMALL_MAP,4,2.4', near.note);
    answer = { conflict: 'PATCH: SMG', held: false };
    const clash = await h.tuner_calibration_edit({ name: 'cfg_s.getriebetyp', value: 3, confirmed: true });
    check('bytes a PATCH toggle also writes: says it will not be written', /will not be written as it stands: PATCH: SMG/.test(clash.note), clash.note);
}

console.log('\n[recipes: a known change, compared with the open BIN, staged step by step]');
{
    const one = (name, raw, extra = {}) => ({
        name, kind: 'constant', bank: 'master', address: 0x8000, units: '', description: '', locked: null, count: 1, bits: 8, dims: null,
        base: [raw], current: [raw], baseRaw: [raw], raw: [raw], choices: null, code: null, ...extra,
    });
    const row = (name, bytes) => ({
        name, kind: 'map', bank: 'slave', address: 0x6000, units: '', description: name, locked: null, count: bytes.length, bits: 8,
        dims: { rows: 1, cols: bytes.length }, base: [...bytes], current: [...bytes], baseRaw: [...bytes], raw: [...bytes], choices: null,
        code: { readBy: { count: 0, names: [] }, conditions: [] },
    });
    const items = [
        one('cfg_m.getriebetyp', 0x40, { code: { readBy: { count: 19, names: [] }, conditions: [{ when: 'cfg_m_getriebetyp == 0x40', in: ['s_kraftschluss_calc'] }] } }),
        one('cfg_s.getriebetyp', 0x40),
        row('DTC_06_SMG_CAN_TIMEOUT', [0x06, 0x01, 0x0A, 0x01, 0x01, 0x01, 0x0A, 0x00, 0x01, 0x02, 0x03, 0x28, 0x00, 0xFF]),
        row('DTC_7B_SMG_CAN_FAIL', [0x7B, 0x01, 0x0A, 0x01, 0x01, 0x01, 0x0A, 0x00, 0x01, 0x02, 0x03, 0x28, 0x23, 0xFF]),
        row('DTC_B1_SMG_MIL', [0xB1, 0x0A, 0x0A, 0x03, 0x02, 0x03, 0x02, 0x00, 0x01, 0x02, 0x03, 0x28, 0x01, 0xFF]),
        one('K_SKRAFTS_CONTROL', 1, { choices: [{ value: 0, label: 'aus V-Fz' }, { value: 1, label: 'aus S_Gang' }, { value: 2, label: 'aus S_Kuppl' }] }),
        { ...one('K_S_GANG_LL_ED', 0x32), base: [5], current: [5], bits: 16, units: 's' },
    ];
    let refusal = null;
    const edits = [];
    const f = {
        status: () => ({}), samples: () => null, startRefusal: () => null, startLog: () => {}, running: () => false, stopLog: () => {},
        views: () => ['calibration'], show: () => {},
        observePlan: () => ({ title: '', reads: [], steps: [] }), setObservePlan: () => {}, enterObserve: () => null, mark: () => {},
        lang: () => 'ja',
        // As the page's: the value through the item's own scaling (x/10 for the GPS time).
        calibrationQuantise: async (name, v) => (name === 'K_S_GANG_LL_ED'
            ? { raw: Math.round(v * 10), value: Math.round(v * 10) / 10, exact: true, bits: 16 }
            : { raw: v, value: v, exact: true, bits: 8 }),
        calibrationRefusal: () => refusal,
        calibrationFind: async (q, limit) => items.filter(i => i.name.toLowerCase() === q.toLowerCase()).slice(0, limit),
        calibrationEdit: async (name, cell, value) => {
            edits.push([name, cell, value]);
            const it = items.find(i => i.name === name);
            it.current = it.current.map(() => value); it.raw = it.raw.map(() => value);
            return { name, cell: 0, from: null, to: value, raw: value, exact: true, conflict: null, held: false, cells: cell === 'all' ? it.count : 1 };
        },
    };
    const h = bridgeHandlers(f);
    const got = await h.tuner_recipes({ query: 'SMG をマニュアルに' });
    const r = got.recipes?.[0];
    check('words find the recipe, in the tab\'s language', got.found === 1 && r.id === 'smg-to-manual' && /マニュアル/.test(r.title), JSON.stringify(got).slice(0, 300));
    check('...with how sure, why, the sources and what is unverified', r.grade === 'single' && !!r.gradeWhy && r.sources.length >= 2 && !!r.unverified);
    const m = r.steps.find(s => s.param === 'cfg_m.getriebetyp');
    check('a step says before and after the same way, what the BIN holds, and that it is not done', m.change === '64 (0x40) → 3 (0x03)' && m.now === '64 (0x40)' && m.done === false && m.loadedAsExpected === true && !m.differsAt, JSON.stringify(m));
    check('...and the exact arguments to stage it', JSON.stringify(m.edit) === JSON.stringify({ name: 'cfg_m.getriebetyp', value: 3 }));
    const d = r.steps.find(s => s.param === 'DTC_06_SMG_CAN_TIMEOUT');
    check('a fault-code row is a fill of every cell, after written as the bytes', JSON.stringify(d.edit) === JSON.stringify({ name: 'DTC_06_SMG_CAN_TIMEOUT', fill: 0 }) && d.change === 'every cell (06 01 0A 01 01 01 0A 00 01 02 03 28 23 FF) → 0 (0x00)', JSON.stringify(d));
    check('a BIN that differs from the recipe\'s before says where, cell by cell', d.loadedAsExpected === false
        && JSON.stringify(d.differsAt) === JSON.stringify([{ cell: 12, expected: '0x23', loaded: '0x00' }]), JSON.stringify(d.differsAt));
    const gps = r.options[1].steps.find(s => s.param === 'K_S_GANG_LL_ED');
    check('a 16-bit value: units, and its raw at its width, before and after', gps.change === '5 s (0x0032) → 6553.5 s (0xFFFF)' && gps.now === '5 s (0x0032)', JSON.stringify(gps));
    check('the wiring is asked, with both options and their steps', !!r.ask && r.options.length === 2 && r.options[1].steps.map(s => s.param).join() === 'K_SKRAFTS_CONTROL,K_S_GANG_LL_ED');
    check('...the stock-wired option is already done on an SMG BIN', r.options[0].steps[0].done === true);

    let err = null;
    try { await h.tuner_calibration_edit({ name: 'DTC_06_SMG_CAN_TIMEOUT', fill: 0 }); } catch (e) { err = e.message; }
    check('a fill without confirmed: one read-back line for the whole row, its bytes now and after', /every one of its 14 cells \(06 01 0A 01 01 01 0A 00 01 02 03 28 00 FF\) → 0 \(0x00\)/.test(err ?? '') && edits.length === 0, err);
    err = null;
    try { await h.tuner_calibration_edit({ name: 'cfg_m.getriebetyp', value: 3 }); } catch (e) { err = e.message; }
    check('a constant\'s read-back says both values in both forms', /cfg_m\.getriebetyp: 64 \(0x40\) → 3 \(0x03\)/.test(err ?? ''), err);
    const filled = await h.tuner_calibration_edit({ name: 'DTC_06_SMG_CAN_TIMEOUT', fill: 0, confirmed: true });
    check('confirmed: the whole row staged as one change', filled.staged === true && filled.cells === 14 && edits.at(-1).join() === 'DTC_06_SMG_CAN_TIMEOUT,all,0', JSON.stringify(edits));
    await h.tuner_calibration_edit({ name: 'cfg_m.getriebetyp', value: 3, confirmed: true });
    const again = (await h.tuner_recipes({ query: 'manual' })).recipes[0];
    check('staged steps read back as done', again.steps.find(s => s.param === 'cfg_m.getriebetyp').done === true
        && again.steps.find(s => s.param === 'DTC_06_SMG_CAN_TIMEOUT').done === true
        && again.steps.find(s => s.param === 'cfg_s.getriebetyp').done === false);

    const k = (await h.tuner_calibration({ name: 'K_SKRAFTS_CONTROL' })).parameters[0];
    check('a parameter carries the XDF\'s choices (at the byte\'s width) and the recipes that touch it', k.choices?.join(' | ') === '0x00 = aus V-Fz | 0x01 = aus S_Gang | 0x02 = aus S_Kuppl' && k.raw === '0x01' && k.recipes?.join() === 'smg-to-manual', JSON.stringify(k));
    const g = (await h.tuner_calibration({ name: 'cfg_m.getriebetyp' })).parameters[0];
    check('...and how the DME code tests it', g.code?.readBy === 19 && g.code.tested[0] === 'cfg_m_getriebetyp == 0x40  (s_kraftschluss_calc)', JSON.stringify(g.code));
    const t06 = (await h.tuner_calibration({ name: 'DTC_06_SMG_CAN_TIMEOUT' })).parameters[0];
    check('no direct reference is said as not found, not as unused', t06.code?.readBy === 0 && /No direct reference found/.test(t06.code.note) && /does not make it unused/.test(t06.code.note) && !t06.code.tested, JSON.stringify(t06.code));

    refusal = 'No session with a BIN is open. tuner_sessions and tuner_open_session open one.';
    const bare = await h.tuner_recipes({ query: 'manual' });
    check('no BIN open: the recipe alone, said as not compared', /^Not compared/.test(bare.openBin) && bare.recipes[0].steps[0].now === 'not in this BIN');
    refusal = null;
    const none = await h.tuner_recipes({ query: 'turbo' });
    check('no recipe: says so, and to work from the evidence, not a name', none.found === 0 && /never a value from a name alone/.test(none.note), JSON.stringify(none));
}

console.log('\n[save and sync: SAVE, sending to the cloud, bringing a session back — each read back first]');
{
    const at = new Date(2026, 9, 21, 9, 30).getTime();
    const row = (id, seq, label, open = false) => ({ id, seq, label, status: 'draft', createdAt: at, hasBase: true, hasLog: true, logPoints: 5830, mode: 'VE', open });
    let running = false, saveRefusal = null, summary = { session: '#978', name: 'Session #978', items: ['7 calibration edits (cfg_m.getriebetyp, cfg_s.getriebetyp, …)'] };
    let pending = [row('a', 978, 'Session #978', true), row('b', 979, 'track day')];
    let syncAnswer = { sent: 2, failed: 0, firstError: null }, syncRefusal = null, restoreBlock = null;
    const saves = [], uploads = [], restores = [];
    const cloud = [
        { ref: 'b', name: 'track day', createdAt: at, syncedAt: at + 60_000, status: 'draft', hasTune: true, logPoints: 5120, local: 979 },
        { ref: 'z', name: 'from the desk', createdAt: at - 86_400_000, syncedAt: at - 3_600_000, status: 'archived', hasTune: true, logPoints: 0, local: null },
    ];
    const f = {
        status: () => ({}), samples: () => null, startRefusal: () => null, startLog: () => {}, running: () => running, stopLog: () => {},
        views: () => [], show: () => {},
        observePlan: () => ({ title: '', reads: [], steps: [] }), setObservePlan: () => {}, enterObserve: () => null, mark: () => {},
        saveRefusal: () => saveRefusal,
        saveSummary: () => summary,
        save: async () => { saves.push(1); return 'saved'; },
        syncRefusal: () => syncRefusal,
        syncPending: () => pending,
        syncUpload: async () => { uploads.push(1); return syncAnswer; },
        cloudSessions: async () => cloud,
        cloudRestoreRefusal: ref => restoreBlock?.(ref) ?? null,
        cloudRestore: async ref => { restores.push(ref); },
    };
    const h = bridgeHandlers(f);

    let err = null;
    try { await h.tuner_save({}); } catch (e) { err = e.message; }
    check('save without confirmed: refused, with what would be kept to read back', /Save #978: 7 calibration edits/.test(err ?? '') && /confirmed: true/.test(err ?? '') && saves.length === 0, err);
    err = null;
    try { await h.tuner_save({ confirmed: 'yes' }); } catch (e) { err = e.message; }
    check('"yes" as a string is not a confirmation', err !== null && saves.length === 0);
    const saved = await h.tuner_save({ confirmed: true });
    check('confirmed: SAVE pressed once, and it says the car is unchanged', saved.saved === true && saves.length === 1 && /car is unchanged/.test(saved.note) && /WRITE/.test(saved.note), JSON.stringify(saved));
    summary = { session: '#978', name: 'Session #978', items: [] };
    const nothing = await h.tuner_save({ confirmed: true });
    check('nothing in memory: says so, presses nothing', nothing.saved === false && saves.length === 1, JSON.stringify(nothing));
    saveRefusal = 'The open session is archived (read-only): it is already what was flashed.';
    err = null;
    try { await h.tuner_save({ confirmed: true }); } catch (e) { err = e.message; }
    check('an archived session: refused with the screen\'s reason', err === saveRefusal && saves.length === 1, err);
    saveRefusal = null;

    err = null;
    try { await h.tuner_sync_upload({}); } catch (e) { err = e.message; }
    check('send without confirmed: refused, naming what would go', /Send 2 sessions to the cloud: #978, #979 track day/.test(err ?? '') && uploads.length === 0, err);
    const sent = await h.tuner_sync_upload({ confirmed: true });
    check('confirmed: SYNC pressed once, the count said back', sent.sent === 2 && sent.failed === 0 && uploads.length === 1, JSON.stringify(sent));
    syncAnswer = { skipped: 'signed-out' };
    const out = await h.tuner_sync_upload({ confirmed: true });
    check('signed out on the device: says to sign in again from SYNC', out.sent === 0 && /sign in on m3 again/.test(out.note), JSON.stringify(out));
    syncAnswer = { sent: 1, failed: 1, firstError: 'HTTP 503' };
    const half = await h.tuner_sync_upload({ confirmed: true });
    check('a send that half landed: both counts and the error', half.sent === 1 && half.failed === 1 && half.error === 'HTTP 503', JSON.stringify(half));
    running = true;
    err = null;
    try { await h.tuner_sync_upload({ confirmed: true }); } catch (e) { err = e.message; }
    check('a log recording: no send', /A log is recording/.test(err ?? '') && uploads.length === 3, err);
    running = false;
    pending = [];
    const clean = await h.tuner_sync_upload({ confirmed: true });
    check('nothing changed since the last send: says so', clean.sent === 0 && /Nothing to send/.test(clean.note) && uploads.length === 3);
    syncRefusal = 'This device is offline. The cloud is reached when it has a connection again.';
    err = null;
    try { await h.tuner_cloud_sessions({}); } catch (e) { err = e.message; }
    check('offline: the cloud is not listed, and why', err === syncRefusal, err);
    syncRefusal = null;

    const list = await h.tuner_cloud_sessions({});
    check('the cloud\'s sessions, newest send first, with whether this device has each', list.total === 2 && list.sessions[0].ref === 'b' && list.sessions[0].onThisDevice === '#979' && list.sessions[1].onThisDevice === false, JSON.stringify(list));
    check('...and no VIN or file name in the listing', !/vin|\.bin/i.test(JSON.stringify(list)));
    const q = await h.tuner_cloud_sessions({ query: 'desk' });
    check('a query finds one by its name', q.sessions.length === 1 && q.sessions[0].ref === 'z');
    err = null;
    try { await h.tuner_cloud_restore({ ref: 'z' }); } catch (e) { err = e.message; }
    check('bring back without confirmed: refused, said as new to this device', /Bring from the desk/.test(err ?? '') && /does not have it yet/.test(err ?? '') && restores.length === 0, err);
    err = null;
    try { await h.tuner_cloud_restore({ ref: 'b' }); } catch (e) { err = e.message; }
    check('...or as replacing the copy here', /replaces #979 on this device/.test(err ?? ''), err);
    restoreBlock = ref => (ref === 'b' ? 'That session is the one open on the screen.' : null);
    err = null;
    try { await h.tuner_cloud_restore({ ref: 'b', confirmed: true }); } catch (e) { err = e.message; }
    check('the open session: refused with the reason', err === 'That session is the one open on the screen.' && restores.length === 0, err);
    restoreBlock = null;
    const back = await h.tuner_cloud_restore({ ref: 'z', confirmed: true });
    check('confirmed: brought back once, and how to open it', back.restored === true && restores.join() === 'z' && /tuner_open_session/.test(back.note), JSON.stringify(back));
    err = null;
    try { await h.tuner_cloud_restore({ ref: 'nope', confirmed: true }); } catch (e) { err = e.message; }
    check('an unknown ref: said, with where to look', /No cloud session with ref "nope"/.test(err ?? '') && restores.length === 1, err);
}

console.log('\n[sessions by voice: a clean copy, dropping test edits, opening without saving; RAM; one yes]');
{
    const at = new Date(2026, 9, 21, 9, 30).getTime();
    const rows = [
        { id: 'a', seq: 978, label: 'Session #978', status: 'draft', createdAt: at, hasBase: true, hasLog: true, logPoints: 5830, mode: 'VE', open: false },
        { id: 'b', seq: 979, label: 'Session #979', status: 'draft', createdAt: at + 1, hasBase: true, hasLog: true, logPoints: 2316, mode: 'VE', open: true },
        { id: 'c', seq: 980, label: 'empty', status: 'draft', createdAt: at + 2, hasBase: false, hasLog: false, logPoints: 0, mode: 'VE', open: false },
    ];
    let unsaved = ['3 calibration edits (cfg_m.getriebetyp, K_SKRAFTS_CONTROL, DTC_06_SMG_CAN_TIMEOUT)'];
    const made = [], opened = [], dropped = [], saves = [];
    const f = {
        status: () => ({}), samples: () => null, startRefusal: () => null, startLog: () => {}, running: () => false, stopLog: () => {},
        views: () => ['startup', 'dash'], show: () => {},
        observePlan: () => ({ title: '', reads: [], steps: [] }), setObservePlan: () => {}, enterObserve: () => null, mark: () => {},
        sessions: () => rows,
        openRefusal: discard => (!discard && unsaved.length ? 'The open session has work that is not saved.' : null),
        openSession: async id => { opened.push(id); return true; },
        saveRefusal: () => null,
        saveSummary: () => ({ session: '#979', name: 'Session #979', items: unsaved }),
        save: async () => { saves.push(1); return 'saved'; },
        newSession: async parentId => { made.push(parentId); return { seq: 981, label: 'Session #981', inherited: !!parentId }; },
        calibrationRefusal: () => null,
        calibrationFind: async () => [],
        discardEdits: () => { dropped.push(1); const n = unsaved.length; unsaved = []; return n; },
        ramFind: async q => (q === 'evan' ? [
            { name: 'EVAN1_IST', bank: 'master', address: 0xFF81DC, observable: true, writes: [{ in: 'vanos_calc', value: 'nw_pos - 0x10' }], readers: 6 },
            { name: 'S_EVAN', bank: 'slave', address: 0xFFE100, observable: false, writes: [], readers: 2 },
        ] : []),
    };
    const h = bridgeHandlers(f);

    // One yes: the owner's own "保存して" is the confirmation.
    let err = null;
    try { await h.tuner_save({}); } catch (e) { err = e.message; }
    check('save without confirmed: says the owner\'s own words are the yes', /asked for exactly this in their own words, that is the yes/.test(err ?? '') && saves.length === 0, err);
    const saved = await h.tuner_save({ confirmed: true });
    check('...and one call with confirmed: true saves', saved.saved === true && saves.length === 1);

    err = null;
    try { await h.tuner_new_session({ from: 978, confirmed: true }); } catch (e) { err = e.message; }
    check('a new session over unsaved work: refused with the screen\'s reason', /not saved/.test(err ?? '') && made.length === 0, err);
    err = null;
    try { await h.tuner_new_session({ from: '#978', discard: true }); } catch (e) { err = e.message; }
    check('...with discard but no yes: a read-back naming what is lost (never "asked" for a loss)', /loses something/.test(err ?? '') && /3 calibration edits/.test(err ?? '') && made.length === 0, err);
    const copy = await h.tuner_new_session({ from: 978, discard: true, confirmed: true });
    check('discard read back and confirmed: NEXT from #978, a clean copy', copy.started === true && made.join() === 'a' && copy.from === '#978' && copy.session === '#981', JSON.stringify(copy));
    err = null;
    try { await h.tuner_new_session({ from: 980, confirmed: true }); } catch (e) { err = e.message; }
    check('a session without a BIN cannot be copied: said', /#980 has no BIN/.test(err ?? ''), err);
    unsaved = [];
    const fresh = await h.tuner_new_session({ confirmed: true });
    check('nothing unsaved: an empty new session on one yes', fresh.started === true && made.at(-1) === null && /empty/.test(fresh.note), JSON.stringify(fresh));

    unsaved = ['2 calibration edits (cfg_m.getriebetyp, cfg_s.getriebetyp)'];
    err = null;
    try { await h.tuner_discard_edits({}); } catch (e) { err = e.message; }
    check('dropping edits without confirmed: the line to read, or the owner\'s words as the yes', /Drop 2 calibration edits/.test(err ?? '') && dropped.length === 0, err);
    const gone = await h.tuner_discard_edits({ confirmed: true });
    check('...dropped as one step, with Undo said', gone.discarded === 1 && dropped.length === 1 && /Undo on that tab brings them back/.test(gone.note), JSON.stringify(gone));
    const none = await h.tuner_discard_edits({ confirmed: true });
    check('nothing staged: says so', none.discarded === 0 && dropped.length === 1);

    unsaved = ['the log (2316 samples)'];
    err = null;
    try { await h.tuner_open_session({ session: 978, discard: true }); } catch (e) { err = e.message; }
    check('open without saving: read back what is lost first', /Open #978 without saving/.test(err ?? '') && /the log \(2316 samples\)/.test(err ?? '') && opened.length === 0, err);
    const op = await h.tuner_open_session({ session: 978, discard: true, confirmed: true });
    check('...then opens', op.opened === true && opened.join() === 'a');

    const ram = await h.tuner_ram({ query: 'evan' });
    check('RAM by name: the address to watch, or why it cannot be', ram.found === 2 && ram.ram[0].observe === 'DAT_00ff81dc' && /slave RAM cannot be read/.test(ram.ram[1].observe), JSON.stringify(ram));
    check('...with where the code sets it', ram.ram[0].setBy?.[0] === 'vanos_calc: nw_pos - 0x10');
    const noRam = await h.tuner_ram({ query: 'nothing' });
    check('nothing found: said', noRam.found === 0);
}

console.log('\n[sending over a newer cloud copy: only when the owner chose it, read back]');
{
    const pending = [{ id: 'a', seq: 978, label: 'Session #978', status: 'draft', createdAt: 0, hasBase: true, hasLog: true, logPoints: 1, mode: 'VE', open: true }];
    let answer = { sent: 0, failed: 0, firstError: null, stale: [{ id: 'a', seq: 978, label: 'Session #978', storeSyncedAt: new Date(2026, 9, 21, 8, 0).getTime() }] };
    const calls = [];
    const f = {
        status: () => ({}), samples: () => null, startRefusal: () => null, startLog: () => {}, running: () => false, stopLog: () => {},
        views: () => [], show: () => {},
        observePlan: () => ({ title: '', reads: [], steps: [] }), setObservePlan: () => {}, enterObserve: () => null, mark: () => {},
        syncRefusal: () => null, syncPending: () => pending,
        syncUpload: async overwrite => { calls.push(overwrite ?? []); return answer; },
    };
    const h = bridgeHandlers(f);
    const first = await h.tuner_sync_upload({ confirmed: true });
    check('another device sent a newer copy: not sent, said as such', first.sent === 0 && first.notSent?.[0]?.session === '#978' && /2026-10-21 08:00/.test(first.notSent[0].newerCopySent) && /Ask the owner which to keep/.test(first.note), JSON.stringify(first));
    let err = null;
    try { await h.tuner_sync_upload({ overwrite: ['#978'] }); } catch (e) { err = e.message; }
    check('overwrite without a yes: always read back, the other copy named as lost', /loses something/.test(err ?? '') && /#978 replaces the newer cloud copy/.test(err ?? '') && calls.length === 1, err);
    answer = { sent: 1, failed: 0, firstError: null, stale: [] };
    const over = await h.tuner_sync_upload({ overwrite: ['#978'], confirmed: true });
    check('...confirmed: sent over it, by id', over.sent === 1 && calls.at(-1).join() === 'a', JSON.stringify(calls));
    err = null;
    try { await h.tuner_sync_upload({ overwrite: ['#977'], confirmed: true }); } catch (e) { err = e.message; }
    check('overwrite of a session not waiting to be sent: refused', /not waiting to be sent: #977/.test(err ?? ''), err);
}

console.log('\n[the moment: the air side and the cams]');
{
    const pts = Array.from({ length: 40 }, (_, i) => ({
        time: i * 0.25, rpm: 3000 + i * 10, rawLoad: 0.5, wdk1: 30, stft1: 1, stft2: 1, coolantTemp: 90,
        ...(i % 8 === 0 ? { pSaug: 950, pSaugM: 940, rfPSaug: 60.5, rfDiagF: -1.2, evan1Ist: 110, evanSoll: 118, avan1Ist: -100, avanSoll: -96 } : {}),
    }));
    const m = cutMoment({ samples: pts, nowLogTime: 10, secondsAgo: 5, windowS: 10 });
    for (const c of ['coolant', 'pSaug', 'pSaugM', 'rfPSaug', 'rfDiagF', 'evan', 'evanSoll', 'evanDev', 'avan', 'avanSoll', 'avanDev']) {
        if (!m.columns.includes(c)) check(`column ${c} is cut into the moment`, false, m.columns.join(','));
    }
    check('manifold pressure, manifold air and the cams are in the moment', ['pSaug', 'rfPSaug', 'evan', 'evanSoll', 'avanDev'].every(c => m.columns.includes(c)), m.columns.join(','));
    const row = m.rows.find(r => r[m.columns.indexOf('evan')] !== null);
    check('...and the cam gap is ist minus soll', row?.[m.columns.indexOf('evanDev')] === -8 && row?.[m.columns.indexOf('avanDev')] === -4, JSON.stringify(row));
}

console.log('\n[the plan through the bridge: OBSERVE addresses, the mode, the marks]');
{
    let running = false, plan = { title: '', reads: [], steps: [] }, modeRefusal = null, entered = 0;
    const marked = [];
    const book = [];
    const f = {
        status: () => ({}), samples: () => null, startRefusal: () => null, startLog: () => {}, running: () => running,
        stopLog: () => {}, views: () => [], show: () => {},
        observePlan: () => plan,
        setObservePlan: p => { plan = p; },
        enterObserve: () => { entered++; return modeRefusal; },
        mark: label => { marked.push(label); },
        notebook: async () => ({ entries: [...book], run: 1, runs: 1 }),
        notebookAdd: async items => {
            const made = items.map((x, i) => ({ id: `entry-${String(book.length + i + 1).padStart(4, '0')}`, sessionId: 'session-0001', at: 1000 + book.length + i, ...x }));
            for (const e of made) { const p = entryProblem(e); if (p) throw new Error(`Notebook entry refused: ${p}`); }
            book.push(...made);
            return made;
        },
    };
    const h = bridgeHandlers(f);
    const good = {
        purpose: 'what holds torque back on a 3rd-gear tip-in',
        watch: [{ address: 'DAT_00ffd1a2', bytes: 2, every: 2, label: 'DAT_00ffd1a2' }, { address: '0xFF8123', bytes: 1, every: 4 }],
        steps: ['idle 30 s', '  ', 'blip to 3000 twice'],
    };

    const empty = await h.tuner_plan({});
    check('with no purpose, tuner_plan reads — and says there is none yet', empty.plan === null && /No plan yet/.test(empty.note ?? ''), JSON.stringify(empty));
    let err = null;
    try { await h.tuner_plan({ ...good, watch: [{ address: 'FF0000', bytes: 2, every: 2 }] }); } catch (e) { err = e.message; }
    check('a plan with a read outside the windows is refused, with the reason, and not written', /not written.*outside/.test(err ?? '') && book.length === 0, err);
    err = null;
    try { await h.tuner_plan({ ...good, watch: [{ address: 'FUN_0003c2e8', bytes: 2, every: 2 }] }); } catch (e) { err = e.message; }
    check('an address that is not an address is named as not filled in', /not filled in/.test(err ?? ''), err);

    const set = await h.tuner_plan(good);
    check('a good plan is written as v1, by the assistant', set.written === 'plan v1' && book[0].by === 'chat' && book[0].body.v === 1, JSON.stringify(set));
    check('...its addresses as written in the disassembly, on the OBSERVE screen too',
        JSON.stringify(set.watch) === '["FFD1A2","FF8123"]' && plan.reads[0].address === 0xFFD1A2 && plan.reads[1].address === 0xFF8123, JSON.stringify(set.watch));
    check('...blank steps dropped, numbered', JSON.stringify(book[0].body.steps.map(s => `${s.n}:${s.do}`)) === '["1:idle 30 s","2:blip to 3000 twice"]');
    check('...the session asked into OBSERVE, with the rate it will run at', entered === 1 && set.mode === 'OBSERVE' && set.expectedHz > 0 && set.expectedHz < 8, JSON.stringify(set));
    check('...and the answer says to read it back before the drive', /Read it back/.test(set.next));
    modeRefusal = 'this session already holds a log, so its mode is fixed.';
    const fixed = await h.tuner_plan({ ...good, steps: ['idle 30 s'] });
    check('a rewrite is the next version, pointing at the one it rewrites', fixed.written === 'plan v2' && book[1].body.re === book[0].id && fixed.rewrites === 'v1', JSON.stringify(fixed));
    check('...and with the mode fixed, the answer says what the screen needs', fixed.mode === 'not OBSERVE' && /holds a log/.test(fixed.modeNote ?? ''), JSON.stringify(fixed));
    const noWatch = await h.tuner_plan({ purpose: 'same addresses, new steps', steps: ['idle 30 s', 'tip-in'] });
    check('addresses left out are kept from the plan it rewrites', JSON.stringify(book[2].body.watch?.map(w => w.address)) === '["FFD1A2","FF8123"]', JSON.stringify(noWatch));
    const read = await h.tuner_plan({});
    check('reading gives the current plan, who wrote it', read.plan?.version === 3 && read.plan?.by === 'chat', JSON.stringify(read.plan));

    running = true;
    err = null;
    try { await h.tuner_plan(good); } catch (e) { err = e.message; }
    check('no plan change while a log records', /cannot change under it/.test(err ?? ''), err);
    const m1 = await h.tuner_mark({ label: '  driver: that hesitation  ' });
    check('a free mark lands as said, trimmed', m1.marked === true && marked.at(-1) === 'driver: that hesitation');
    const m2 = await h.tuner_mark({ step: 2 });
    check('a step mark is the plan\'s own label for it, from the notebook\'s plan', m2.label === 'step 2: tip-in' && marked.at(-1) === m2.label, m2.label);
    err = null;
    try { await h.tuner_mark({ step: 3 }); } catch (e) { err = e.message; }
    check('a step the plan does not have is refused', /No step 3: the plan has steps 1 to 2/.test(err ?? ''), err);
    err = null;
    try { await h.tuner_mark({}); } catch (e) { err = e.message; }
    check('a mark with nothing to say is refused', /Say what to mark/.test(err ?? ''), err);
    running = false;
    const m3 = await h.tuner_mark({ label: 'x' });
    check('no mark without a recording log', m3.marked === false && marked.length === 2);
}

console.log('\n[the notebook through the bridge: the driver\'s words, findings, questions]');
{
    let running = false, now = 42.5;
    const book = [];
    const pts = Array.from({ length: 20 }, (_, i) => ({ time: i, rpm: 2000 + i * 20, rawLoad: 10, wdk1: 20, stft1: 1.02, stft2: 1.01 }));
    const f = {
        status: () => ({}), startRefusal: () => null, startLog: () => {}, running: () => running,
        samples: () => (running ? { points: pts, live: true, nowLogTime: now } : { points: pts, live: false, nowLogTime: 19 }),
        stopLog: () => {}, views: () => [], show: () => {},
        observePlan: () => ({ title: '', reads: [], steps: [] }), setObservePlan: () => {}, enterObserve: () => null, mark: () => {},
        notebook: async () => ({ entries: [...book], run: 2, runs: 2 }),
        notebookAdd: async items => {
            const made = items.map((x, i) => ({ id: `entry-${String(book.length + i + 1).padStart(4, '0')}`, sessionId: 'session-0001', at: 1000 + book.length + i, ...x }));
            for (const e of made) { const p = entryProblem(e); if (p) throw new Error(`Notebook entry refused: ${p}`); }
            book.push(...made);
            return made;
        },
        runSamples: async run => (run === 1 ? Array.from({ length: 30 }, (_, i) => ({ time: i, rpm: 1500, rawLoad: 5, wdk1: 0, stft1: 1, stft2: 1, pwg1: 44 })) : null),
    };
    const h = bridgeHandlers(f);

    running = true;
    const said = await h.tuner_note({ text: '2速から3速に上げて、そのまま踏んだ' });
    check('the driver\'s words are kept as theirs, on the run\'s clock, while a log records',
        said.kept && book[0].by === 'driver' && book[0].body.kind === 'note' && book[0].body.run === 2 && book[0].body.t === 42.5 && book[0].body.via === 'voice', JSON.stringify(book[0]));
    let err = null;
    try { await h.tuner_note({ text: '  ' }); } catch (e) { err = e.message; }
    check('a note with no words is refused', /driver's words/.test(err ?? ''), err);
    err = null;
    try { await h.tuner_finding({ kind: 'fact', text: 'x', evidence: { run: 2, from: 1, to: 2, channels: ['rpm'] } }); } catch (e) { err = e.message; }
    check('a finding is not written while a log records — the words are, by tuner_note', /written parked/.test(err ?? ''), err);
    running = false;

    const parked = await h.tuner_note({ text: '今のは下り坂だった', at_log_time: 12 });
    check('parked, a note can be put at a moment of the run on screen', /run 2, 12 s/.test(parked.at) && book[1].body.t === 12, JSON.stringify(parked));
    err = null;
    try { await h.tuner_finding({ kind: 'fact', text: 'trim 1.02 → 0.93 → 1.00' }); } catch (e) { err = e.message; }
    check('a fact without evidence is refused, in the rule\'s words', /evidence is required/.test(err ?? ''), err);
    const fact = await h.tuner_finding({ kind: 'fact', text: 'trim 1.02 → 0.93 → 1.00', evidence: { run: 2, from: 3, to: 9, channels: ['stft1'], decode: 'u16/32768' } });
    check('a fact with run, range and channels is written', fact.written === 'fact' && book[2].body.evidence.channels[0] === 'stft1', JSON.stringify(fact));
    const claim = await h.tuner_finding({ kind: 'read', text: 'a fuel cut before the tip-in', sure: 'mid' });
    const counter = await h.tuner_finding({ kind: 'read', text: 'pedal stayed at 44 %: a shift, not a lift', sure: 'high', re: claim.id });
    check('a reading that disagrees points at the other, which stays', /DISPUTED/.test(counter.note ?? '') && book.some(e => e.id === claim.id), JSON.stringify(counter));
    const q = await h.tuner_finding({ kind: 'ask', to: 'driver', text: 'アクセルは戻しましたか', about: { run: 1, from: 2, to: 4, channels: ['pwg1'] } });
    const nb = await h.tuner_notebook({});
    check('tuner_notebook lists the open question, and the disputed reading as disputed',
        nb.openQuestions.length === 1 && nb.openQuestions[0].id === q.id && nb.entries.find(e => e.id === claim.id)?.status === 'disputed', JSON.stringify(nb.openQuestions));
    check('...and which run is on screen out of how many', nb.runOnScreen === 2 && nb.runs === 2);
    const ans = await h.tuner_finding({ kind: 'answer', re: q.id, text: '戻していない。変速した' });
    check('the driver\'s answer to a question put to the driver is written as the driver\'s', ans.written === 'answer' && book.at(-1).by === 'driver', JSON.stringify(book.at(-1)));
    check('...and the question is no longer open', (await h.tuner_notebook({})).openQuestions.length === 0);
    err = null;
    try { await h.tuner_finding({ kind: 'answer', re: 'entry-9999', text: 'x' }); } catch (e) { err = e.message; }
    check('an answer to no question is refused', /No question/.test(err ?? ''), err);

    const m = await h.tuner_moment({ at_log_time: 12, window_s: 8 });
    check('a moment of the run on screen carries the driver\'s words in its window', m.notebook?.some(x => x.driver === '今のは下り坂だった' && x.t === 0), JSON.stringify(m.notebook));
    const earlier = await h.tuner_moment({ run: 1, at_log_time: 3, window_s: 6 });
    check('a moment of an earlier run is read from the device, and says so', earlier.source === 'stored run 1' && earlier.samples > 0, JSON.stringify({ source: earlier.source, samples: earlier.samples }));
    err = null;
    try { await h.tuner_moment({ run: 5 }); } catch (e) { err = e.message; }
    check('a run the session does not have is refused', /No run 5/.test(err ?? ''), err);
}

console.log('\n[a moment of an observation run]');
{
    // 60 s at 4 Hz; FFD1A2 a counter-like word on every other sample, FF8123 a flag that flips once at 33.0 s.
    const s = pull(0, 60, t => ({
        ...(Math.round(t * 4) % 2 === 0 ? { watch: { FFD1A2: (Math.round(t * 4) & 0xFFFF).toString(16).toUpperCase().padStart(4, '0'), FF8123: t >= 33 ? '21' : '01' } } : {}),
        ...(t === 10 ? { mark: 'OBSERVE: tip-in [FFD1A2+2/2, FF8123+1/2]' } : {}),
        ...(t === 33.5 ? { mark: 'step 2: blip to 3000 twice' } : {}),
    }));
    const m = cutMoment({ samples: s, nowLogTime: 60, secondsAgo: 50, atLogTime: 33, windowS: 10, source: 'loaded log' });
    check('at_log_time wins over seconds_ago, and secondsAgo reports where that was', m.at === 33 && m.secondsAgo === 27, JSON.stringify({ at: m.at, ago: m.secondsAgo }));
    const wi = m.columns.indexOf('w:FF8123');
    const mi = m.columns.indexOf('mark');
    check('watched addresses come back as w: columns of raw hex, with a mark column', wi > 0 && m.columns.includes('w:FFD1A2') && mi > wi, m.columns.join(','));
    const flip = m.rows.find(r => r[wi] === '21');
    check('...the raw hex as recorded, a string', typeof flip?.[wi] === 'string' && m.rows.some(r => r[wi] === '01'));
    check('a mark is an event and a row value', m.events.some(e => e.kind === 'mark' && e.detail === 'step 2: blip to 3000 twice' && e.t === 0.5)
        && m.rows.some(r => r[mi] === 'step 2: blip to 3000 twice'), JSON.stringify(m.events.filter(e => e.kind === 'mark')));
    check('...and the reading is called a reading', m.notes.some(n => /reading, not a value/.test(n)));

    const long = cutMoment({ samples: s, nowLogTime: 60, atLogTime: 30, windowS: 120, source: 'loaded log' });
    const lwi = long.columns.indexOf('w:FF8123');
    const firstOn = long.rows.find(r => r[lwi] === '21');
    check(`a thinned window (${long.samples} samples → ${long.rows.length} rows) keeps the row where a rarely-changing watched value changed`,
        long.rows.length <= 130 && long.rows.length < long.samples && firstOn?.[0] === 3, `first 21 at ${firstOn?.[0]}`);
    check('...while a value that changes on every read (FFD1A2) does not pin the whole window', long.rows.length <= 125, String(long.rows.length));
    check('...and every mark row', long.rows.filter(r => r[long.columns.indexOf('mark')]).length === 2);
    const plainM = cutMoment({ samples: pull(0, 20), nowLogTime: 20, secondsAgo: 5, windowS: 10, source: 'live run' });
    check('a log without watched bytes or marks has neither kind of column', !plainM.columns.some(c => c.startsWith('w:') || c === 'mark'), plainM.columns.join(','));
}

console.log('\n[why samples were left out: how many, the name, what to do — in the reader\'s language]');
{
    const census = { ...EMPTY_CENSUS, coldEngine: 40, highLoadSettle: 312, fuelCut: 95 };
    const en = explainDrops(census, 'en');
    const ja = explainDrops(census, 'ja');
    check('only the reasons that left something out, most first', JSON.stringify(Object.keys(en)) === JSON.stringify(['highLoadSettle', 'fuelCut', 'coldEngine']), Object.keys(en).join(','));
    const e = en.highLoadSettle;
    check('each is { samples, label, why }', JSON.stringify(Object.keys(e ?? {})) === JSON.stringify(['samples', 'label', 'why']), JSON.stringify(e));
    check('...samples is the census count', e?.samples === 312, String(e?.samples));
    check('...label is the sheet\'s name, not the key', e?.label === 'short pull', e?.label);
    check('...why is the sheet\'s sentence: what to do next time', e?.why === DROP_WHY.en.highLoadSettle && /Hold the pull longer/.test(e.why), e?.why);
    check('a Japanese reader: same reasons, counts and names, the Japanese sentence',
        JSON.stringify(Object.keys(ja)) === JSON.stringify(Object.keys(en)) && ja.highLoadSettle?.samples === 312
        && ja.highLoadSettle?.label === 'short pull' && /引きをもっと長く保持/.test(ja.highLoadSettle?.why ?? ''), ja.highLoadSettle?.why);
    check('nothing left out: an empty answer, not a list of zeros', JSON.stringify(explainDrops(EMPTY_CENSUS, 'en')) === '{}');
    const reasons = Object.keys(EMPTY_CENSUS).sort();
    const missing = reasons.filter(r => !DROP_LABEL[r] || !DROP_WHY.en[r] || !DROP_WHY.ja[r]);
    check('every reason the census counts has a name and a sentence in both languages',
        missing.length === 0 && JSON.stringify(Object.keys(DROP_LABEL).sort()) === JSON.stringify(reasons), missing.join(','));
    // One source: the sheet and the facade both read the module, and neither keeps a copy.
    const sheet = readFileSync(new URL('../src/components/DropCensus.tsx', import.meta.url), 'utf8');
    const page = readFileSync(new URL('../src/app/page.tsx', import.meta.url), 'utf8');
    check('the census sheet takes its names and sentences from dropReasons',
        sheet.includes("from '@/lib/log-engine/dropReasons'") && !/const (LABEL|WHY)\b/.test(sheet));
    check('tuner_status answers explainDrops in the dialogs\' language, beside valid and dropped',
        page.includes('explainDrops(dropCensus, detectDialogLang())') && page.includes('{ valid: processedLog.validCount, dropped: processedLog.droppedCount, leftOut }'));
}

console.log('\n[the client: ticket, socket, hello, answers]');
{
    class FakeWS {
        static last = null;
        constructor(url, protocols) { this.url = url; this.protocols = protocols; this.sent = []; FakeWS.last = this; setTimeout(() => this.onopen?.(), 5); }
        send(t) { this.sent.push(t); }
        close(code = 1000) { setTimeout(() => this.onclose?.({ code }), 1); }
        deliver(o) { this.onmessage?.({ data: JSON.stringify(o) }); }
    }
    const states = [];
    const calls = [];
    const fetchOk = async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify({ ticket: 'v1.abc.def', url: 'wss://bridge/tab' }), { status: 200 }); };
    const client = new BridgeClient({
        ticketUrl: '/api/bridge/ticket',
        handlers: () => ({
            tuner_status: async () => ({ link: 'connected' }),
            tuner_moment: async () => { throw new Error('There is no log on this tab.'); },
        }),
        hello: () => ({ build: 'b1', variant: 'preview', tools: TOOL_NAMES }),
        onStatus: s => states.push(s.state),
        fetch: fetchOk,
        WebSocket: FakeWS,
    });
    client.start();
    await sleep(30);
    const ws = FakeWS.last;
    check('the ticket is asked for with POST on this origin', calls[0]?.init?.method === 'POST' && calls[0]?.url === '/api/bridge/ticket');
    check('the socket offers the protocol and the ticket — not in the URL', ws?.url === 'wss://bridge/tab' && ws.protocols[0] === BRIDGE_PROTOCOL && ws.protocols[1] === 't.v1.abc.def', JSON.stringify(ws?.protocols));
    check('hello goes first, with the build and the tools', JSON.parse(ws.sent[0]).type === 'hello' && JSON.parse(ws.sent[0]).tools.length === TOOL_NAMES.length);
    check('state reads live', states.at(-1) === 'live', states.join(','));
    ws.deliver({ type: 'call', id: 'c1', tool: 'tuner_status', args: {} });
    ws.deliver({ type: 'call', id: 'c2', tool: 'tuner_moment', args: {} });
    ws.deliver({ type: 'call', id: 'c3', tool: 'tuner_write', args: {} });
    await sleep(20);
    const replies = ws.sent.slice(1).map(t => JSON.parse(t));
    const r = id => replies.find(x => x.id === id);
    check('an answer goes back with the call\'s id', r('c1')?.ok === true && r('c1').result.link === 'connected');
    check('a handler that throws answers ok:false with its message', r('c2')?.ok === false && /no log/.test(r('c2').error));
    check('a tool the tab does not have is not answered as success', r('c3')?.ok === false && /does not answer "tuner_write"/.test(r('c3').error));
    ws.onclose({ code: 4000 });
    await sleep(20);
    check('taken over by another device: held, and no fight for the socket (asks again in a minute)', states.at(-1) === 'held' && FakeWS.last === ws);
    client.stop();
}
{
    // Refused while another device's live tab has it (4002, holder in the reason); "switch here".
    class FakeWS {
        static all = [];
        constructor(url, protocols) { this.url = url; this.protocols = protocols; this.sent = []; FakeWS.all.push(this); setTimeout(() => this.onopen?.(), 2); }
        send(t) { this.sent.push(t); }
        close(code = 1000) { setTimeout(() => this.onclose?.({ code, reason: '' }), 1); }
    }
    const seen = [];
    const client = new BridgeClient({
        ticketUrl: '/api/bridge/ticket', handlers: () => ({}),
        hello: () => ({ build: 'b1', variant: 'preview', tools: [], device: 'PC' }),
        onStatus: s => seen.push(s),
        fetch: async () => new Response(JSON.stringify({ ticket: 'v1.abc.def', url: 'wss://bridge/tab' }), { status: 200 }),
        WebSocket: FakeWS,
    });
    client.start();
    await sleep(20);
    const first = FakeWS.all[0];
    check('hello carries this device\'s name', JSON.parse(first.sent[0]).device === 'PC', first.sent[0]);
    first.onclose({ code: HELD_CLOSE_CODE, reason: 'held:ナビ' });
    await sleep(10);
    check('held by another device: says which one, and waits', seen.at(-1).state === 'held' && seen.at(-1).holder === 'ナビ' && FakeWS.all.length === 1, JSON.stringify(seen.at(-1)));
    client.takeover();
    await sleep(20);
    check('switch here: a new socket asking to take over', FakeWS.all.length === 2 && FakeWS.all[1].url === 'wss://bridge/tab?takeover=1', FakeWS.all.at(-1)?.url);
    check('...and only once: the next one asks normally', (() => { FakeWS.all[1].onclose({ code: 1006 }); return true; })());
    await sleep(1200);
    check('...a reconnect after that does not take over again', FakeWS.all.length === 3 && FakeWS.all[2].url === 'wss://bridge/tab', FakeWS.all.map(w => w.url).join(' | '));
    client.stop();
}
{
    const states = [];
    const client = new BridgeClient({
        ticketUrl: '/api/bridge/ticket', handlers: () => ({}), hello: () => ({ build: null, variant: null, tools: [] }),
        onStatus: s => states.push(`${s.state}:${s.detail ?? ''}`),
        fetch: async () => new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }),
        WebSocket: class { constructor() { throw new Error('must not open'); } },
    });
    client.start();
    await sleep(20);
    check('signed out: retries, slowly, and says to sign in', /retrying:.*signed out.*60 s/.test(states.at(-1)), states.at(-1));
    client.stop();
    check('stop ends it', states.at(-1).startsWith('off'));
}
{
    const states = [];
    const client = new BridgeClient({
        ticketUrl: '/api/bridge/ticket', handlers: () => ({}), hello: () => ({ build: null, variant: null, tools: [] }),
        onStatus: s => states.push(`${s.state}:${s.detail ?? ''}`),
        fetch: async () => new Response(JSON.stringify({ error: 'bridge_unavailable' }), { status: 503 }),
        WebSocket: class { constructor() { throw new Error('must not open'); } },
    });
    client.start();
    await sleep(20);
    check('no bridge configured on this build: stops and says so', /stopped:.*no assistant bridge/.test(states.at(-1)), states.at(-1));
    client.stop();
}

console.log('\n[the ticket the function mints]');
if (!mintTicket) {
    console.log('  SKIP  functions/ is not in this tree (main has no backend); the ticket is checked where it is');
} else {
    const secret = 'x'.repeat(40);
    const t = await mintTicket(secret, 'owner-1234-abcd', 1_000_000);
    const [v, payload, sig] = t.split('.');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const expect = crypto.createHmac('sha256', secret).update(`v1.${payload}`).digest('base64url');
    check('v1, three parts', v === 'v1' && t.split('.').length === 3);
    check('for this owner and this app', claims.o === 'owner-1234-abcd' && claims.a === 'tuner');
    check('valid for sixty seconds', claims.e === 1_000_060, String(claims.e));
    check('signed with HMAC-SHA256 over "v1." + payload', sig === expect);
    check('two tickets in one second differ', (await mintTicket(secret, 'owner-1234-abcd', 1_000_000)) !== t);
    check('subprotocol-safe characters only', /^[A-Za-z0-9._-]+$/.test(t));
}

console.log(fails === 0 ? '\nALL PASS' : '\n' + fails + ' FAILURE(S)');
process.exit(fails ? 1 : 0);
