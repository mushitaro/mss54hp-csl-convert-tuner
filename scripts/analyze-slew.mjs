/**
 * Did the tip-in slew limiter actually bind, where, and by how much — from a log already recorded.
 *
 * `45-drivability-filters.md` §1: the limiter passes the driver's torque request straight through
 * whenever it is inside the allowance and clamps only when it is not, setting `MD_DYN_ST` bit 6
 * when it does. So `KF_MD_LS_KOMF` tells you what the allowance WAS and nothing at all about
 * whether any of it was ever spent. Only this byte does, and it is the difference between "raise
 * that cell" and "leave it alone, the limiter is innocent".
 *
 * ## Reads, not samples
 *
 * The five channels ride the slowest lane. On logs recorded before 2026-08-30 they were also
 * CARRIED between reads, so one reading appears on up to sixty-four consecutive samples — and
 * counting samples then multiplies a few-hundred-millisecond event by sixty-four. Session #930
 * read `MD_DYN_ST` twenty-nine times and caught bit 6 three times; counted as samples that is 192
 * of 2082, which reads as "clipping for 9.2 % of the drive" and is wrong by the lane divisor.
 *
 * This collapses runs of identical readings back to one read, so both shapes of log give the same
 * answer. A drive whose values genuinely repeat across two adjacent reads is undercounted by one,
 * which is the safe direction for a "did it happen" question.
 *
 * ## What it cannot tell you
 *
 * How OFTEN. One read every `every / rate` seconds against an event of a few hundred milliseconds
 * is a lottery, and the ratio of the two is printed so the answer is read as the lower bound it is.
 * Catching it three times in twenty-nine tries means it is frequent; catching it zero times does
 * NOT mean it never happened.
 *
 *     node scripts/analyze-slew.mjs <session-dir>
 */
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
if (!dir) {
    console.error('usage: node scripts/analyze-slew.mjs <session-dir>');
    process.exit(2);
}
const read = (n) => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
const session = read('session.json');
const raw = read('log.json');
const L = Array.isArray(raw) ? raw : raw.data;

const NL = '\n';
console.log(NL + '='.repeat(92));
console.log('THE TIP-IN SLEW LIMITER — ' + session.label);
console.log('='.repeat(92));

const has = L.some(p => p.mdDynSt !== undefined && p.mdDynSt !== null);
if (!has) {
    console.log('  This log carries no MD_DYN_ST. The channel was added on 2026-08-30; a drive');
    console.log('  recorded before that cannot answer the question, and no amount of arithmetic');
    console.log('  over the maps can substitute for it.');
    process.exit(0);
}

const span = L[L.length - 1].time - L[0].time;
const rate = L.length / span;

/** One reading, however many samples it was stamped onto. */
const key = (p) => [p.mdDynSt, p.mdFw, p.mdFwFilter, p.mdLsDelta, p.mdDpDelta].join('|');
const reads = [];
let prev = null;
for (const p of L) {
    if (p.mdDynSt === undefined || p.mdDynSt === null) continue;
    const k = key(p);
    if (k !== prev) { reads.push({ p, n: 1 }); prev = k; } else reads[reads.length - 1].n++;
}

const bit = (p, m) => (p.mdDynSt & m) !== 0;
const clips = reads.filter(r => bit(r.p, 0x40));
const dash = reads.filter(r => bit(r.p, 0x30));

console.log('  drive        ' + (span / 60).toFixed(1) + ' min   ' + L.length + ' samples   '
    + rate.toFixed(2) + ' Hz');
console.log('  reads        ' + reads.length + '   one every ' + (span / reads.length).toFixed(1) + ' s');
console.log('  bit 6  tip-in limiter clipped      ' + clips.length + ' / ' + reads.length + ' reads');
console.log('  bit 4/5 dashpot limiter clipped    ' + dash.length + ' / ' + reads.length
    + ' reads');
console.log('  bit 0                              ' + reads.filter(r => bit(r.p, 0x01)).length
    + ' / ' + reads.length + ' reads');

if (!clips.length) {
    console.log(NL + '  NOT CAUGHT. That is not the same as "it never bound" — see the header: one');
    console.log('  read every ' + (span / reads.length).toFixed(0) + ' s against an event of a few hundred milliseconds.');
    console.log('  Raising KF_MD_LS_KOMF on this evidence would be raising it on nothing.');
}

/** The throttle either side of a read, because the read lands beside the stab, not on it. */
const around = (t, w = 3) => {
    const win = L.filter(q => q.time >= t - w && q.time <= t + w);
    return {
        wdk: win.length ? Math.max(...win.map(q => q.wdk1 ?? 0)) : null,
        rpmLo: win.length ? Math.min(...win.map(q => q.rpm)) : null,
        rpmHi: win.length ? Math.max(...win.map(q => q.rpm)) : null,
    };
};

if (clips.length) {
    console.log(NL + '  WHERE IT BOUND' + NL);
    console.log('     t(s)    rpm    MD_FW -> FILTER     held back   allowance   delay    wdk1 +-3s');
    for (const r of clips) {
        const p = r.p;
        const held = p.mdFw - p.mdFwFilter;
        // Nm/10ms -> how long the ramp needs to close the gap it is holding.
        const ms = p.mdLsDelta > 0 ? (held / p.mdLsDelta) * 10 : null;
        const a = around(p.time);
        console.log('   ' + p.time.toFixed(1).padStart(7) + String(p.rpm).padStart(7)
            + '  ' + p.mdFw.toFixed(1).padStart(7) + ' ->' + p.mdFwFilter.toFixed(1).padStart(8)
            + held.toFixed(1).padStart(12) + ' Nm'
            + p.mdLsDelta.toFixed(1).padStart(11)
            + (ms === null ? '      —' : (ms.toFixed(0) + ' ms').padStart(9))
            + (a.wdk === null ? '' : (a.wdk.toFixed(0) + ' %').padStart(12)));
    }
    console.log(NL + '  `held back` is MD_FW - MD_FW_FILTER at that instant — torque the driver asked');
    console.log('  for and did not get. `delay` is how long the ramp needs to deliver it at the');
    console.log('  allowance it had, which is the lag you feel rather than a permanent loss.');
}

// The corrective: the limiter is about RATE, and a big request is not automatically a clipped one.
const clean = reads.filter(r => !bit(r.p, 0x40) && r.p.mdFw > 0);
if (clean.length) {
    const biggest = clean.reduce((a, b) => (b.p.mdFw > a.p.mdFw ? b : a));
    console.log(NL + '  AND THE OTHER HALF OF THE PICTURE' + NL);
    console.log('  largest request that passed UNTOUCHED: ' + biggest.p.mdFw.toFixed(1) + ' Nm at '
        + biggest.p.rpm + ' rpm (t=' + biggest.p.time.toFixed(1) + ')');
    console.log('  The limiter bounds the RATE, not the size. A drive can ask for everything the');
    console.log('  engine has and never be clipped; what gets clipped is asking for it quickly at');
    console.log('  a low engine speed, which is the one cell KF_MD_LS_KOMF holds at its minimum.');
}
