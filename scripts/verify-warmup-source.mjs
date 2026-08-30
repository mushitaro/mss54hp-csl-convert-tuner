/**
 * Does the WARMUP table follow the grid that is actually written?
 *
 * `kf_rf_soll_kath` is interpolated from `kf_rf_soll`, and its own load axis starts at 0.10 % with
 * its first fourteen rows at or below the SHAPE seam — so it is derived almost entirely from the
 * band the repair exists to fix. It used to be generated once, from the tuned map, at the moment
 * the VE calculation finished, and never revisited: applying a repair changed the main table in the
 * flash and left this one interpolated from the unrepaired grid, with the WARMUP tab rendering that
 * third answer.
 *
 * What this checks is the property, not the wiring: that the two grids DO produce different warmup
 * tables, and by how much. A test that only asserted "the same function was called" would pass on
 * the day the repair stopped reaching it.
 *
 * Run: npm run verify:warmup-source
 */
import { readFileSync } from 'node:fs';
import { BinaryParser } from '../src/lib/binary-engine/parser.ts';
import { VECalculator } from '../src/lib/ve-calculator/calculator.ts';
import { writtenVeGrid } from '../src/lib/ve-calculator/composeVeGrid.ts';
import { repairLowLoadShape } from '../src/lib/ve-calculator/lowLoadShape.ts';
import { LOW_LOAD_TOP_ROW } from '../src/lib/ve-calculator/lowLoadTuner.ts';
import { APP_CONFIG, CSL_STOCK_WARMUP_LOAD } from '../src/config/constants.ts';

let failed = 0;
const check = (label, ok, detail) => {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `   ${detail}` : ''}`);
    if (!ok) failed++;
};

const b = readFileSync('scripts/fixtures/session-920-base.bin');
const tuned = new BinaryParser(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)).getVETable();

// No log here, so every cell is unweighted: this measures what the REPAIR does to the cold table,
// not what one drive's evidence would have anchored.
const weight = tuned.data.map(r => r.map(() => 0));
const repair = repairLowLoadShape(tuned.data, APP_CONFIG.MSS54HP.AXIS_LOAD, weight, LOW_LOAD_TOP_ROW);
const shaped = repair.repaired.flat().filter(Boolean).length;
console.log(`\nSHAPE moves ${shaped} cells of kf_rf_soll\n`);
check('the fixture gives the repair something to do', shaped > 0, `${shaped} cells`);

const shapeArm = { grid: repair.values, shaped: repair.repaired };
const calc = new VECalculator();

// The two states of the WRITE SHAPE toggle, through the one call both the flash path and the
// WARMUP tab now make.
const off = writtenVeGrid(tuned.data, null, null);
const on = writtenVeGrid(tuned.data, null, shapeArm);
check('SHAPE off writes the tuned grid unchanged',
    off.flat().every((v, i) => v === tuned.data.flat()[i]));
check('SHAPE on writes a different grid',
    on.flat().some((v, i) => v !== tuned.data.flat()[i]));
check('...and only where the repair moved a cell',
    on.flat().filter((v, i) => v !== tuned.data.flat()[i]).length === shaped);
check('SHAPE armed without a composition contributes nothing',
    writtenVeGrid(null, null, shapeArm) === null);

const wOff = calc.generateWarmupMap({ ...tuned, data: off });
const wOn = calc.generateWarmupMap({ ...tuned, data: on });

let moved = 0, worst = 0, at = null;
for (let r = 0; r < wOff.data.length; r++) {
    for (let c = 0; c < wOff.data[r].length; c++) {
        const a = wOff.data[r][c], d = wOn.data[r][c];
        if (Math.abs(a - d) > 1e-9) moved++;
        const pct = a !== 0 ? Math.abs(d / a - 1) * 100 : 0;
        if (pct > worst) { worst = pct; at = [wOff.yAxis[r], wOff.xAxis[c]]; }
    }
}
const total = wOff.data.length * wOff.data[0].length;
console.log(`\nkf_rf_soll_kath: ${moved} / ${total} cells move, worst ${worst.toFixed(2)} % `
    + `at opening ${at?.[0]} %, ${at?.[1]} rpm\n`);
check('the toggle reaches the warmup table at all', moved > 0, `${moved} cells`);
check('it is not a rounding difference', worst > 1, `${worst.toFixed(2)} %`);

// Why the effect is this large: the cold table is mostly derived from the repaired band.
const below = CSL_STOCK_WARMUP_LOAD.filter(y => y <= APP_CONFIG.MSS54HP.AXIS_LOAD[LOW_LOAD_TOP_ROW]).length;
console.log(`  (${below} of ${CSL_STOCK_WARMUP_LOAD.length} warmup rows sit at or below the `
    + `${APP_CONFIG.MSS54HP.AXIS_LOAD[LOW_LOAD_TOP_ROW]} % seam)\n`);
check('the warmup axis really does live in the repaired band', below >= 10, `${below} rows`);

console.log(failed ? `${failed} check(s) FAILED\n` : 'ALL PASS\n');
process.exit(failed ? 1 : 0);
