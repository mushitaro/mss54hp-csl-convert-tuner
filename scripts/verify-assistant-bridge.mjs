/**
 * The tab's half of the assistant bridge.
 *
 *   the moment   cutMoment finds the window on the tab's clock and the events in it: a loss of
 *                acceleration with the throttle held, a knock retard placed in time from its counter
 *                (n combustions at r rpm = n * 120 / r s before the read), a cylinder fired low, a
 *                gear change, an overrun fuel cut, a link gap; it thins long windows without dropping
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
 *
 * What a wrong answer costs: an assistant told "cylinder 3 knocked" about a knock that happened a
 * minute earlier, a log stopped by a misheard word, a head unit and a laptop trading the bridge
 * every few seconds, or a driver told "highLoadSettle" where the screen says "hold the pull longer".
 * Synthetic data only.
 */
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { cutMoment, KNOCK_AGE_NONE, MAX_ROWS } from '../src/lib/bridge/moment.ts';
import { bridgeHandlers, TOOL_NAMES } from '../src/lib/bridge/tools.ts';
import { BridgeClient, BRIDGE_PROTOCOL } from '../src/lib/bridge/bridgeClient.ts';
import { mintTicket } from '../functions/api/bridge/ticket.ts';
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
    check('the fuel cut, once at its start', kinds.filter(k => k === 'fuelCut').length === 1, JSON.stringify(kinds));
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
    check('the tab answers exactly the nine tools', TOOL_NAMES.length === 9 && JSON.stringify(Object.keys(h).sort()) === JSON.stringify([...TOOL_NAMES].sort()));
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

console.log('\n[OBSERVE through the bridge: the plan, the mode, the marks]');
{
    let running = false, plan = { title: '', reads: [], steps: [] }, modeRefusal = null, entered = 0;
    const marked = [];
    const f = {
        status: () => ({}), samples: () => null, startRefusal: () => null, startLog: () => {}, running: () => running,
        stopLog: () => {}, views: () => [], show: () => {},
        observePlan: () => plan,
        setObservePlan: p => { plan = p; },
        enterObserve: () => { entered++; return modeRefusal; },
        mark: label => { marked.push(label); },
    };
    const h = bridgeHandlers(f);
    const good = {
        title: 'what holds torque back on a 3rd-gear tip-in',
        reads: [{ address: 'DAT_00ffd1a2', bytes: 2, every: 2, label: 'DAT_00ffd1a2' }, { address: '0xFF8123', bytes: 1, every: 4 }],
        steps: ['idle 30 s', '  ', 'blip to 3000 twice'],
    };

    let err = null;
    try { await h.tuner_observe({ ...good, reads: [{ address: 'FF0000', bytes: 2, every: 2 }] }); } catch (e) { err = e.message; }
    check('a plan with a read outside the windows is refused, with the reason, and not set', /not set.*outside/.test(err ?? '') && plan.title === '', err);
    err = null;
    try { await h.tuner_observe({ ...good, reads: [{ address: 'FUN_0003c2e8', bytes: 2, every: 2 }] }); } catch (e) { err = e.message; }
    check('an address that is not an address is named as not filled in', /not filled in/.test(err ?? ''), err);

    const set = await h.tuner_observe(good);
    check('a good plan is set, addresses read as written in the disassembly', set.set === true && plan.reads[0].address === 0xFFD1A2 && plan.reads[1].address === 0xFF8123
        && JSON.stringify(set.reads.map(r => r.address)) === '["FFD1A2","FF8123"]', JSON.stringify(set));
    check('...blank steps dropped', JSON.stringify(set.steps) === '["idle 30 s","blip to 3000 twice"]', JSON.stringify(set.steps));
    check('...the session asked into OBSERVE, and the answer says to ask the owner before tuner_start_log', entered === 1 && set.mode === 'OBSERVE' && /tuner_start_log/.test(set.next));
    check('...with the rate it will run at', typeof set.expectedHz === 'number' && set.expectedHz > 0 && set.expectedHz < 8, String(set.expectedHz));
    modeRefusal = 'this session already holds a log, so its mode is fixed.';
    const fixed = await h.tuner_observe(good);
    check('a session whose mode is fixed: the plan is set and the answer says what the screen needs', fixed.mode === 'not OBSERVE' && /NEW SESSION|holds a log/.test(fixed.next), fixed.next);

    running = true;
    err = null;
    try { await h.tuner_observe(good); } catch (e) { err = e.message; }
    check('no plan change while a log records', /cannot change under it/.test(err ?? ''), err);
    const m1 = await h.tuner_mark({ label: '  driver: that hesitation  ' });
    check('a free mark lands as said, trimmed', m1.marked === true && marked.at(-1) === 'driver: that hesitation');
    const m2 = await h.tuner_mark({ step: 2 });
    check('a step mark is the panel\'s own label for it, so its checklist ticks', m2.label === 'step 2: blip to 3000 twice' && marked.at(-1) === m2.label, m2.label);
    err = null;
    try { await h.tuner_mark({ step: 3 }); } catch (e) { err = e.message; }
    check('a step the plan does not have is refused', /No step 3: the plan has steps 1 to 2/.test(err ?? ''), err);
    err = null;
    try { await h.tuner_mark({}); } catch (e) { err = e.message; }
    check('a mark with nothing to say is refused', /Say what to mark/.test(err ?? ''), err);
    running = false;
    const m3 = await h.tuner_mark({ label: 'x' });
    check('no mark without a recording log', m3.marked === false && marked.length === 2);
    const cleared = await h.tuner_observe({ clear: true });
    check('clear empties the plan', cleared.cleared === true && plan.reads.length === 0 && plan.title === '');
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
    check('taken over by another tab: stops, does not reconnect', states.at(-1) === 'stopped' && FakeWS.last === ws);
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
{
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
