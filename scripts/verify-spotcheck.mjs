/**
 * The windows a QUICK verify reads back: bytes that MUST have changed, or nothing.
 *
 * These pins exist because of the 2026-08-22 hollow write — every telegram acknowledged, checksum
 * clean, flash unchanged (spotCheck.ts has the post-mortem). The function under test is the one
 * that decides WHERE the verify looks; if it ever returns a window of unchanged bytes, a hollow
 * write passes again, and if it returns none for a changed image, the verify silently degrades to
 * the checksum byte that already failed once.
 */
import { diffWindows } from '../src/lib/dme-link/spotCheck.ts';

let fails = 0;
const check = (n, c, d) => { console.log('  ' + (c ? 'PASS' : 'FAIL') + '  ' + n + (c ? '' : ' — ' + d)); if (!c) fails++; };
const buf = (n) => new Uint8Array(n);

console.log('\n[no difference, no windows]');
{
    const a = buf(1024); a.fill(7);
    check('identical images yield none', diffWindows(a, a.slice()).length === 0);
}

console.log('\n[every window covers a changed byte]');
{
    const a = buf(65536); const b = a.slice();
    b[100] = 1; b[30000] = 2; b[60000] = 3;
    const w = diffWindows(a, b);
    check('three spread diffs give three windows', w.length === 3, JSON.stringify(w));
    for (const win of w) {
        const covered = [100, 30000, 60000].some(i => i >= win.offset && i < win.offset + win.length);
        check(`window @${win.offset} covers a diff`, covered, JSON.stringify(win));
    }
}

console.log('\n[first, nearest-middle and last are the anchors]');
{
    const a = buf(65536); const b = a.slice();
    for (const i of [500, 501, 29900, 33000, 64000]) b[i] = 0xEE;
    const w = diffWindows(a, b);
    const covers = (i) => w.some(win => i >= win.offset && i < win.offset + win.length);
    check('first diff covered', covers(500));
    check('last diff covered', covers(64000));
    check('a middle diff covered', covers(29900) || covers(33000));
}

console.log('\n[adjacent diffs merge into one window]');
{
    const a = buf(1024); const b = a.slice();
    b[512] = 1; b[513] = 2; b[514] = 3;   // first, middle and last sit within one width
    const w = diffWindows(a, b);
    check('one window, not three overlapping', w.length === 1, JSON.stringify(w));
    check('and it covers all three bytes', w[0].offset <= 512 && w[0].offset + w[0].length >= 515, JSON.stringify(w));
}

console.log('\n[edges stay inside the buffer]');
{
    const a = buf(64); const b = a.slice();
    b[0] = 1; b[63] = 1;
    const w = diffWindows(a, b);
    check('windows clamp to [0, n)', w.every(win => win.offset >= 0 && win.offset + win.length <= 64), JSON.stringify(w));
    const covers = (i) => w.some(win => i >= win.offset && i < win.offset + win.length);
    check('byte 0 covered', covers(0));
    check('byte 63 covered', covers(63));
}

console.log('\n[length mismatch is bounded by the shorter image]');
{
    const a = buf(100); const b = buf(80); b[70] = 5;
    const w = diffWindows(a, b);
    check('diff found within the shared prefix', w.length === 1 && w[0].offset + w[0].length <= 80, JSON.stringify(w));
}

console.log(fails === 0 ? '\nAll spot-check pins hold.\n' : `\n${fails} check(s) FAILED.\n`);
process.exit(fails ? 1 : 0);
