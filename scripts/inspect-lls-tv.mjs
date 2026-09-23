/**
 * What KF_LLS_TV actually holds in this binary, and whether the write bounds can touch it.
 *
 * Written to settle the seal's SECOND reason with a measurement rather than an argument: the old
 * write clamped every cell of the table on the way past, and sixteen of the old target's thirty
 * cells were outside the bound. That has to be re-asked of the new target before anything is
 * unsealed, because `setEcuMapValues` writes all 130 cells whether the tuner moved them or not.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readIdleTables } from '../src/lib/idle/idleTables.ts';
import { findEcuItem } from '../src/lib/ecu-items/catalog/index.ts';

const binPath = fileURLToPath(new URL('../public/mock/csl-0401-community-patch-v1.partial.bin', import.meta.url));
const buf = fs.readFileSync(binPath);
const t = readIdleTables(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
if (!t) { console.log('readIdleTables returned null'); process.exit(1); }

const m = t.llsTv;
console.log('K_LLS_TV_MIN / MAX      ', t.tvMin, '/', t.tvMax, '%');
console.log('one raw step            ', t.llsTvStepPct, '%');
console.log('rpm axis (x, %d)'.replace('%d', m.x.length), m.x.join(' '));
console.log('air axis (y, %d) kg/h'.replace('%d', m.y.length), m.y.join(' '));
console.log('');
console.log('KF_LLS_TV duty %, rows = ml_ll, cols = rpm');
console.log('  ml_ll |', m.x.map(v => String(v).padStart(6)).join(''));
m.values.forEach((row, i) => {
    console.log(String(m.y[i]).padStart(7), '|', row.map(v => v.toFixed(1).padStart(6)).join(''));
});

const flat = m.values.flat();
console.log('');
console.log('cells                   ', flat.length);
console.log('min / max cell          ', Math.min(...flat), '/', Math.max(...flat), '%');
const below = flat.filter(v => v < t.tvMin).length;
const above = flat.filter(v => v > t.tvMax).length;
console.log(`cells below K_LLS_TV_MIN  ${below}`);
console.log(`cells above K_LLS_TV_MAX  ${above}`);
console.log(below + above === 0
    ? 'VERDICT: every stock cell is inside the rails — writing the whole table is byte-neutral'
    : 'VERDICT: the rails would MOVE untouched cells — a whole-table write is not safe');

// The operating point the car actually idles at, and where it lands on these axes.
const def = findEcuItem('KF_LLS_TV');
console.log('');
console.log('catalog def             ', def ? `${def.values.rows}x${def.values.cols} ${def.values.bits}-bit ${def.values.units}` : 'MISSING');

const bracket = (axis, v) => {
    if (v <= axis[0]) return { lo: 0, hi: 0, f: 0 };
    if (v >= axis[axis.length - 1]) return { lo: axis.length - 1, hi: axis.length - 1, f: 0 };
    let i = 0;
    while (i < axis.length - 2 && axis[i + 1] < v) i++;
    return { lo: i, hi: i + 1, f: (v - axis[i]) / (axis[i + 1] - axis[i]) };
};
for (const [rpm, air] of [[880, 14.0], [878, 14.0], [800, 11.0]]) {
    const c = bracket(m.x, rpm);
    const r = bracket(m.y, air);
    const w = [
        (1 - r.f) * (1 - c.f), (1 - r.f) * c.f,
        r.f * (1 - c.f), r.f * c.f,
    ];
    console.log(`n=${rpm} ml_ll=${air}: rpm between x[${c.lo}]=${m.x[c.lo]} and x[${c.hi}]=${m.x[c.hi]} (f=${c.f.toFixed(3)}), `
        + `air between y[${r.lo}]=${m.y[r.lo]} and y[${r.hi}]=${m.y[r.hi]} (f=${r.f.toFixed(3)})`);
    console.log(`   weights ${w.map(x => x.toFixed(3)).join(' ')}  sum ${w.reduce((a, b) => a + b, 0).toFixed(3)}  sum^2 ${w.reduce((a, b) => a + b * b, 0).toFixed(4)}`);
}
