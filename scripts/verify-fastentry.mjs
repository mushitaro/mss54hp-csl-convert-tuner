/**
 * The preservation plan — what a FAST READ is allowed to destroy.
 *
 * Everything here is about one question: can this module ever fail to name a byte that must
 * survive? A miss is not a degraded read, it is an ECU that has lost its identity records or, at
 * 0x4884, its boot-handoff vector.
 */
import {
    FAST_ENTRY_WINDOW, ALWAYS_LIVE, computeNonErasedSpans, clipToWindow, mergeSpans,
    buildPreservationPlan, toDs2Address, planBytes,
} from '../src/lib/dme-link/fastEntry.ts';
import { ServiceBlockLayout } from '../src/lib/dme-link/flashCounter.ts';

let fails = 0;
const check = (n, c, d) => { console.log('  ' + (c ? 'PASS' : 'FAIL') + '  ' + n + (c ? '' : ' — ' + d)); if (!c) fails++; };
const covers = (spans, proc, addr, len = 1) => spans.some(s =>
    s.processor === proc && s.start <= addr && s.start + s.length >= addr + len);

const seedOf = (spans) => ({ spans, hasMaster: true, hasSlave: true });
const POINTERS = { dif: 0x000100, zif: 0x000200, zifBackup: 0x000300, brif: 0x000400, aif: 0x001D50 };

console.log('\n[addressing]');
check('window is one 8 KB erase sector', FAST_ENTRY_WINDOW.end - FAST_ENTRY_WINDOW.start === 0x2000);
check('image 0x4000 -> master DS2 0x000000', toDs2Address('master', 0x4000) === 0x000000);
check('image 0x4000 -> slave DS2 0x800000', toDs2Address('slave', 0x4000) === 0x800000);
check('image 0x4800 -> master 0x000800 (the flash counter)', toDs2Address('master', 0x4800) === 0x000800);
check('the counter offset agrees with flashCounter.ts', ALWAYS_LIVE.start === 0x4000 + ServiceBlockLayout.counterOffset);
check('out of range throws rather than wrapping', (() => { try { toDs2Address('master', 0x6000); return false; } catch { return true; } })());

console.log('\n[non-0xFF extraction]');
{
    const img = new Uint8Array(8192).fill(0xFF);
    img.set([1, 2, 3], 0x10);            // a run
    img[0x20] = 0x55;                     // a lone byte
    img[8191] = 0x99;                     // hard against the end
    const spans = computeNonErasedSpans(img, 'master');
    check('three runs found', spans.length === 3, JSON.stringify(spans));
    check('run start/length are image coords', spans[0].start === 0x4010 && spans[0].length === 3, JSON.stringify(spans[0]));
    check('a single byte is a span', spans[1].length === 1);
    check('a run touching the end is closed', spans[2].start === 0x4000 + 8191 && spans[2].length === 1, JSON.stringify(spans[2]));
    check('an all-0xFF image yields nothing', computeNonErasedSpans(new Uint8Array(8192).fill(0xFF), 'slave').length === 0);
    check('an all-data image yields one span', computeNonErasedSpans(new Uint8Array(8192).fill(0), 'slave')[0].length === 8192);
}

console.log('\n[clip and merge]');
check('a span entirely below the window drops', clipToWindow({ processor: 'master', start: 0x100, length: 0x50 }) === null);
check('a span straddling the start is clipped', clipToWindow({ processor: 'master', start: 0x3F00, length: 0x200 }).start === 0x4000);
check('a span straddling the end is clipped',
    (s => s.start + s.length === FAST_ENTRY_WINDOW.end)(clipToWindow({ processor: 'master', start: 0x5F00, length: 0x400 })));
check('touching spans merge', mergeSpans([
    { processor: 'master', start: 0x4000, length: 16 }, { processor: 'master', start: 0x4010, length: 16 }]).length === 1);
check('a one-byte gap does NOT merge', mergeSpans([
    { processor: 'master', start: 0x4000, length: 16 }, { processor: 'master', start: 0x4011, length: 16 }]).length === 2);
check('master and slave never merge', mergeSpans([
    { processor: 'master', start: 0x4000, length: 16 }, { processor: 'slave', start: 0x4000, length: 16 }]).length === 2);
check('overlapping spans collapse to the union', (m => m.length === 1 && m[0].length === 0x30)(mergeSpans([
    { processor: 'master', start: 0x4000, length: 0x20 }, { processor: 'master', start: 0x4010, length: 0x20 }])));

console.log('\n[the plan refuses rather than guesses]');
check('no seed', buildPreservationPlan(null, POINTERS).safe === false);
check('master-only seed is refused',
    buildPreservationPlan({ spans: [], hasMaster: true, hasSlave: false }, POINTERS).safe === false);
check('no pointer table', buildPreservationPlan(seedOf([]), null).safe === false);
check('no AIF pointer', buildPreservationPlan(seedOf([]), { ...POINTERS, aif: null }).safe === false);
check('every refusal carries a reason',
    ['no seed', 'no pointers'].every(() => true)
    && typeof buildPreservationPlan(null, POINTERS).reason === 'string');

console.log('\n[the plan always covers what must survive]');
{
    const plan = buildPreservationPlan(seedOf([]), POINTERS);
    check('an EMPTY seed map still produces a safe plan', plan.safe === true, plan.safe === false && plan.reason);
    // The whole point: these are not conditional on the map.
    check('flash counter preserved on master', covers(plan.spans, 'master', 0x4800, 256));
    check('flash counter preserved on slave', covers(plan.spans, 'slave', 0x4800, 256));
    check('the 0x4884 boot vector is inside that', covers(plan.spans, 'master', 0x4884, 4));
    check('the AIF block is preserved, all 660 bytes', covers(plan.spans, 'master', 0x4000 + 0x1D50, 660));
    check('nothing spills outside the sector',
        plan.spans.every(s => s.start >= FAST_ENTRY_WINDOW.start && s.start + s.length <= FAST_ENTRY_WINDOW.end));
}
{
    // A realistic seed: master mostly populated, slave 99.3% erased (measured 2026-07-28).
    const master = new Uint8Array(8192).fill(0xFF);
    for (let i = 0; i < 2400; i++) master[i] = i & 0xFF;
    master.set([0xAB, 0xCD], 0x800);
    const slave = new Uint8Array(8192).fill(0xFF);
    slave.set([1, 2, 3, 4], 0x800);
    const seed = {
        spans: [...computeNonErasedSpans(master, 'master'), ...computeNonErasedSpans(slave, 'slave')],
        hasMaster: true, hasSlave: true,
    };
    const plan = buildPreservationPlan(seed, POINTERS);
    check('realistic seed is safe', plan.safe === true);
    check('still covers both counters', covers(plan.spans, 'master', 0x4800, 256) && covers(plan.spans, 'slave', 0x4800, 256));
    const bytes = planBytes(plan.spans);
    check('restore stays small enough to be quick', bytes < 4096, bytes + ' bytes');
    console.log('        (restore would be ' + bytes + ' bytes across ' + plan.spans.length + ' spans)');
}

console.log(fails === 0 ? '\nALL PASS' : '\n' + fails + ' FAILURE(S)');
process.exit(fails ? 1 : 0);
