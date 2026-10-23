/**
 * OBSERVE — watching addresses nobody has named — and the two holes in the RAM path it would have
 * fallen through.
 *
 *   the link      webSerialDmeLink.ts, read as source — the dme-link classes do not load under
 *                 --experimental-strip-types (parameter properties), which is why every check here
 *                 that touches them reads them: a watched read is handed to `watch` BEFORE the
 *                 address dispatch, so a window over LA_F_REGLER stays bytes; the trim decodes only
 *                 from LAMBDA_TRIM_RAM_READ's own address, where any unknown read used to fall
 *                 through to it; a read outside the DME's windows is refused when the list is set
 *                 and again at the read itself, in the mock as in the car;
 *   the map       every *_RAM_READ in ramMap.ts is in its load-time window check (five were not);
 *   the plan      observe.ts: what a plan may hold, the segment each address gets, the address
 *                 formats, the hex both ways, the rate a plan costs, the marks, the summary;
 *   PRACTICE      the made-up bytes follow the four shapes (practiceWatchBytes, which the mock calls);
 *   the CSV       `Watch FFD1A2` and `Mark` go out and come back — `1234` stays bytes, a mark keeps
 *                 its commas — and an OBSERVE log without a trim imports, while any other still
 *                 does not;
 *   the registry  OBSERVE is a WORKS-only mode with its own tab second and no WRITE rows.
 *
 * What a wrong answer costs: a plausible lambda trim invented from an operator's watched bytes and
 * carried into a VE map, or a 0xB0 on every sample of a drive. Synthetic data only.
 *
 *     node --experimental-strip-types --import ./scripts/ts-resolve.mjs scripts/verify-observe.mjs
 */
import { readFileSync } from 'node:fs';
import {
    planProblems, watchExchanges, observeExchanges, observeHz, windowOf, watchKey, parseAddress,
    bytesToHex, hexToBytes, planMark, stepMark, activeSteps, marksOf, summariseWatch, readings,
    EMPTY_PLAN, OBSERVE_MAX_READS, practiceWatchBytes, practiceShape,
} from '../src/lib/log-engine/observe.ts';
import { LOG_PROFILES, expectedHz, selectableModes } from '../src/lib/log-engine/logProfile.ts';
import { MODE_TABS, MODE_WRITES, FEATURES } from '../src/lib/features.ts';
import { serializeLogFile } from '../src/lib/log-engine/serializer.ts';
import { parseLogFile } from '../src/lib/log-engine/parser.ts';

let fails = 0;
const check = (n, c, d) => { console.log('  ' + (c ? 'PASS' : 'FAIL') + '  ' + n + (c ? '' : ' — ' + (d ?? ''))); if (!c) fails++; };

const plan = (over = {}) => ({
    title: 'what holds torque back on a 3rd-gear tip-in',
    reads: [{ address: 0xFFD1A2, count: 2, every: 2, label: 'DAT_00ffd1a2' }],
    steps: ['idle 30 s', '', 'blip to 3000 twice'],
    ...over,
});

// ---------------------------------------------------------------------------------------------
console.log('\n[the link, read as source]');
{
    const src = readFileSync(new URL('../src/lib/dme-link/webSerialDmeLink.ts', import.meta.url), 'utf8');
    const mock = readFileSync(new URL('../src/lib/dme-link/mockDmeLink.ts', import.meta.url), 'utf8');
    /** The body of the first method whose signature matches, by brace depth. The sanity check below
     *  proves each one was found and is the size of a real body, so a renamed method fails loudly. */
    const body = (text, signature) => {
        const at = text.search(signature);
        if (at < 0) return '';
        const open = text.indexOf('{', text.indexOf(')', at));
        let depth = 0;
        for (let i = open; i < text.length; i++) {
            if (text[i] === '{') depth++;
            else if (text[i] === '}' && --depth === 0) return text.slice(open, i + 1);
        }
        return '';
    };
    const poll = body(src, /private async pollLiveMeasurementInner\(/);
    const setList = body(src, /\n {4}setLiveExchanges\(exchanges/);
    const chunk = body(src, /private async pollRamChunk\(/);
    const mockSet = body(mock, /\n {4}setLiveExchanges\(exchanges/);
    check('found the poll, setLiveExchanges, pollRamChunk and the mock\'s setLiveExchanges',
        poll.length > 2000 && setList.length > 100 && chunk.length > 100 && mockSet.length > 50,
        [poll.length, setList.length, chunk.length, mockSet.length].join(' / '));

    const ramBranch = poll.slice(poll.indexOf("if (exchange.kind === 'ram')"));
    const watchAt = ramBranch.indexOf('if (exchange.watch)');
    const firstDispatch = ramBranch.indexOf('exchange.address ===');
    check('a watched read is handed to `watch` before any dispatch on the address', watchAt > 0 && firstDispatch > 0 && watchAt < firstDispatch, `${watchAt} vs ${firstDispatch}`);
    check('...as raw hex keyed by address, and the loop moves on', /\(watched \?\?= \{\}\)\[watchKey\(exchange\.address\)\] = bytesToHex\(bytes\);\s*continue;/.test(ramBranch));
    const trimGuard = ramBranch.search(/exchange\.segment !== LAMBDA_TRIM_RAM_READ\.segment \|\| exchange\.address !== LAMBDA_TRIM_RAM_READ\.address/);
    const trimDecode = ramBranch.indexOf('decodeRamSignal(Mss54HpRamSignals.LA_F_REGLER1');
    check('the trim decodes only from LAMBDA_TRIM_RAM_READ\'s own address — no fall-through', trimGuard > 0 && trimDecode > trimGuard, `${trimGuard} vs ${trimDecode}`);
    check('the sample returns its watched bytes', /\.\.\.\(watched \? \{ watch: watched \} : \{\}\)/.test(poll));
    check('setLiveExchanges checks every RAM read against the windows and throws', /isRamReadInRange\(x\.segment, x\.address, x\.count\)/.test(setList) && /throw new DmeLinkError/.test(setList));
    const guard = chunk.indexOf('isRamReadInRange(read.segment, read.address, read.count)');
    check('pollRamChunk checks the window before it touches the wire', guard > 0 && guard < chunk.indexOf('readMemoryChunk('), String(guard));
    check('the mock refuses what the car refuses', /isRamReadInRange\(x\.segment, x\.address, x\.count\)/.test(mockSet) && /throw new DmeLinkError/.test(mockSet));
    check('the mock\'s samples go through withWatch on both paths', (mock.match(/this\.withWatch\(this\.withIgnition\(/g) ?? []).length === 2);
}

// ---------------------------------------------------------------------------------------------
console.log('\n[the map: every RAM read in the load-time check]');
{
    const src = readFileSync(new URL('../src/lib/dme-link/ramMap.ts', import.meta.url), 'utf8');
    const declared = [...src.matchAll(/^export const ([A-Z0-9_]+_RAM_READ)\b/gm)].map(m => m[1]).sort();
    const block = src.slice(src.indexOf('function assertRamMapIsConsistent'));
    const listed = [...block.matchAll(/\{ name: '([A-Z0-9_]+_RAM_READ)'/g)].map(m => m[1]).sort();
    check(`the source declares RAM reads to check (${declared.length})`, declared.length >= 20, String(declared.length));
    const missing = declared.filter(n => !listed.includes(n));
    check('every *_RAM_READ is in assertRamMapIsConsistent', missing.length === 0, missing.join(', '));
}

// ---------------------------------------------------------------------------------------------
console.log('\n[the plan]');
{
    check('a good plan has no problems', planProblems(plan()).length === 0, planProblems(plan()).join(' | '));
    check('the empty plan says what is missing', planProblems(EMPTY_PLAN).length === 2, planProblems(EMPTY_PLAN).join(' | '));
    check('a blank title is refused', planProblems(plan({ title: '  ' })).some(p => /title/.test(p)));
    const five = Array.from({ length: OBSERVE_MAX_READS + 1 }, (_, i) => ({ address: 0xFFD100 + i * 4, count: 1, every: 1, label: '' }));
    check(`more than ${OBSERVE_MAX_READS} reads is refused`, planProblems(plan({ reads: five })).some(p => /At most 4/.test(p)));
    check('an address outside the windows is refused', planProblems(plan({ reads: [{ address: 0xFF0000, count: 2, every: 1, label: '' }] })).some(p => /outside/.test(p)));
    check('a read that runs off its window is refused', planProblems(plan({ reads: [{ address: 0xFFEFFF, count: 2, every: 1, label: '' }] })).some(p => /outside/.test(p)));
    check('5 bytes is refused', planProblems(plan({ reads: [{ address: 0xFFD1A2, count: 5, every: 1, label: '' }] })).some(p => /1 to 4 bytes/.test(p)));
    check('every: 3 is refused', planProblems(plan({ reads: [{ address: 0xFFD1A2, count: 2, every: 3, label: '' }] })).some(p => /every 1, 2, 4 or 8/.test(p)));
    check('the same address twice is refused', planProblems(plan({ reads: [plan().reads[0], plan().reads[0]] })).some(p => /twice/.test(p)));
    check('a row not filled in is a problem, never a default address', planProblems(plan({ reads: [{ address: NaN, count: 2, every: 2, label: '' }] })).some(p => /not filled in/.test(p)));
    check('13 steps is refused, blanks not counted', planProblems(plan({ steps: [...Array(13).fill('x'), '', ''] })).some(p => /12 steps/.test(p))
        && planProblems(plan({ steps: [...Array(12).fill('x'), '', ''] })).length === 0);
    check('a plan with problems makes no exchanges', (() => { try { watchExchanges(plan({ title: '' })); return false; } catch { return true; } })());

    const xs = watchExchanges(plan({ reads: [{ address: 0xFF8123, count: 1, every: 4, label: '' }, { address: 0xFFD1A2, count: 2, every: 2, label: '' }] }));
    check('an address in 0xFF8000.. reads from segment 1, one in 0xFFD000.. from segment 4', xs[0].segment === 0x01 && xs[1].segment === 0x04, JSON.stringify(xs.map(x => x.segment)));
    check('each watched exchange is flagged and named by address', xs.every(x => x.watch === true) && xs[1].name === 'watch FFD1A2', JSON.stringify(xs.map(x => x.name)));
    check('windowOf: inside, edge, outside', windowOf(0xFFD000, 2)?.segment === 4 && windowOf(0xFF8FFF, 1)?.segment === 1 && windowOf(0xFF8FFF, 2) === null && windowOf(0xFF9000) === null);
    check('observeExchanges is block 3 then the plan', observeExchanges(plan()).length === LOG_PROFILES.OBSERVE.exchanges.length + 1);
    const baseHz = expectedHz(LOG_PROFILES.OBSERVE.exchanges);
    const hz1 = observeHz(plan());
    const hz4 = observeHz(plan({ reads: [0xFFD100, 0xFFD110, 0xFFD120, 0xFFD130].map(a => ({ address: a, count: 2, every: 1, label: '' })) }));
    check(`watching costs rate: block 3 alone ${baseHz.toFixed(2)} Hz > one read on 1/2 ${hz1.toFixed(2)} > four every sample ${hz4.toFixed(2)}`, baseHz > hz1 && hz1 > hz4);

    check('parseAddress: FFD1A2, 0xffd1a2, DAT_00ffd1a2', parseAddress('FFD1A2') === 0xFFD1A2 && parseAddress('0xffd1a2') === 0xFFD1A2 && parseAddress('DAT_00ffd1a2') === 0xFFD1A2);
    check('parseAddress: not an address', parseAddress('FUN_0003c2e8 ') === null && parseAddress('FFD1G2') === null && parseAddress('') === null && parseAddress('1000000') === null);
    check('watchKey pads to six upper-case digits', watchKey(0xFF80CA) === 'FF80CA' && watchKey(0x1A) === '00001A');
    check('hex both ways', bytesToHex([0x0a, 0x1b, 0x00]) === '0A1B00' && JSON.stringify(hexToBytes('0A1B00')) === '[10,27,0]' && hexToBytes('ABC') === null);
    check('readings: u8, u16 big-endian, s16', JSON.stringify(readings('FF38')) === JSON.stringify({ u8: 255, u16: 65336, s16: -200 }) && readings('2A').u8 === 42 && readings('2A').u16 === undefined);
    check('activeSteps drops blanks; stepMark numbers them from 1', JSON.stringify(activeSteps(plan())) === '["idle 30 s","blip to 3000 twice"]'
        && stepMark(plan(), 1) === 'step 2: blip to 3000 twice');
    check('planMark says what the run is for and what it watched', planMark(plan()) === 'OBSERVE: what holds torque back on a 3rd-gear tip-in [FFD1A2+2/2 DAT_00ffd1a2]', planMark(plan()));
    check('marksOf splits the labels one sample carries', JSON.stringify(marksOf('a | step 1: x')) === '["a","step 1: x"]' && marksOf(undefined).length === 0);
    const pts = [{ watch: { FFD1A2: '0010' } }, {}, { watch: { FFD1A2: '0010' } }, { watch: { FFD1A2: '0200' } }, { watch: { FFD1A2: '0010' } }];
    const sum = summariseWatch(pts, 'FFD1A2');
    check('summariseWatch: reads, changes, range, last', sum.reads === 4 && sum.changes === 2 && sum.min === 16 && sum.max === 512 && sum.last === '0010', JSON.stringify(sum));
}

// ---------------------------------------------------------------------------------------------
console.log('\n[PRACTICE]');
{
    const pick = k => { for (let a = 0xFFD100; a < 0xFFD200; a++) if (practiceShape(a) === k) return a; return null; };
    const [aRpm, aLoad, aFlag, aCount] = ['rpm', 'load', 'flag', 'counter'].map(pick);
    check('all four shapes are reachable in one 256-byte stretch', [aRpm, aLoad, aFlag, aCount].every(a => a !== null));
    const shut = { rpm: 3000, rawLoad: 40, wdk1: 1 };
    const open = { rpm: 800, rawLoad: 40, wdk1: 30 };
    check('rpm shape: a word that is the rpm', bytesToHex(practiceWatchBytes(aRpm, 2, 0, shut)) === '0BB8' && bytesToHex(practiceWatchBytes(aRpm, 2, 0, open)) === '0320');
    check('load shape: a byte that follows load', practiceWatchBytes(aLoad, 1, 0, shut)[0] === 80);
    check('flag shape: 0x21 with the throttle shut, 0x01 open', practiceWatchBytes(aFlag, 1, 0, shut)[0] === 0x21 && practiceWatchBytes(aFlag, 1, 0, open)[0] === 0x01);
    check('counter shape: the sample index', practiceWatchBytes(aCount, 1, 7, shut)[0] === 7 && practiceWatchBytes(aCount, 1, 263, shut)[0] === 7);
    check('as many bytes as asked, the rest a constant', practiceWatchBytes(aLoad, 4, 0, shut).length === 4
        && practiceWatchBytes(aLoad, 4, 0, shut)[3] === ((aLoad + 3) & 0xFF));
}

// ---------------------------------------------------------------------------------------------
console.log('\n[the CSV]');
{
    const pts = [
        { time: 0, rpm: 800, rawLoad: 2, rf: 10, mark: 'OBSERVE: tip-in, 3rd [FFD1A2+2/2]', watch: { FFD1A2: '1234', FF80C8: '00FF' } },
        { time: 0.25, rpm: 820, rawLoad: 2.1, rf: 10.2 },
        { time: 0.5, rpm: 900, rawLoad: 3, rf: 11, watch: { FFD1A2: '1235' } },
        { time: 0.75, rpm: 950, rawLoad: 3.2, rf: 11.1, mark: 'step 1: idle, then blip | mark' },
    ];
    const csv = serializeLogFile(pts);
    const head = csv.split(/\r?\n/)[0];
    check('one `Watch` column per address, in address order, and a `Mark` column', /Mark/.test(head) && head.indexOf('Watch FF80C8') >= 0 && head.indexOf('Watch FF80C8') < head.indexOf('Watch FFD1A2'), head);
    let data = null;
    try { data = parseLogFile(csv); } catch (e) { data = String(e?.message ?? e); }
    check('an OBSERVE log with no trim column imports', Array.isArray(data) && data.length === 4, Array.isArray(data) ? String(data.length) : data);
    if (!Array.isArray(data)) data = [];
    check('`1234` comes back as the bytes 12 34, not the number', data[0]?.watch?.FFD1A2 === '1234' && data[0]?.watch?.FF80C8 === '00FF', JSON.stringify(data[0]?.watch));
    check('a row that did not read an address leaves it absent', data[1]?.watch === undefined && data[2]?.watch?.FF80C8 === undefined, JSON.stringify([data[1]?.watch, data[2]?.watch]));
    check('marks come back whole, commas and all', data[0]?.mark === pts[0].mark && data[3]?.mark === pts[3].mark && data[1]?.mark === undefined, JSON.stringify(data.map(d => d.mark)));
    const plain = serializeLogFile(pts.map(p => { const q = { ...p }; delete q.watch; delete q.mark; return q; }));
    check('a log with no watch and no marks has neither column', !/Watch |Mark/.test(plain.split(/\r?\n/)[0]));
    let refused = false;
    try { parseLogFile(plain); } catch (e) { refused = /lambda controller factor/.test(String(e?.message ?? e)); }
    check('any other log without a trim is still refused', refused);
}

// ---------------------------------------------------------------------------------------------
console.log('\n[the registry]');
{
    check('OBSERVE is offered in WORKS only', selectableModes(true).includes('OBSERVE') && !selectableModes(false).includes('OBSERVE'), JSON.stringify([selectableModes(true), selectableModes(false)]));
    check('...because its feature is experimental and owns the observe tab', FEATURES.observe.stage === 'experimental' && JSON.stringify(FEATURES.observe.tabs) === '["observe"]');
    check('its tabs: startup, its own panel second, the log, calibration, the notebook last', JSON.stringify(MODE_TABS.OBSERVE) === '["startup","observe","log","calibration","notebook"]');
    check('it offers no WRITE row — an observation names, it never derives', Array.isArray(MODE_WRITES.OBSERVE) && MODE_WRITES.OBSERVE.length === 0);
    check('its profile is block 3 alone, runnable, with nothing required', LOG_PROFILES.OBSERVE.exchanges.length === 1 && LOG_PROFILES.OBSERVE.exchanges[0].kind === 'block'
        && LOG_PROFILES.OBSERVE.runnable && LOG_PROFILES.OBSERVE.requires.length === 0);
}

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`);
process.exit(fails ? 1 : 0);
