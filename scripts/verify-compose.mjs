/**
 * kf_rf_soll has one writer, and this file is why that stays true.
 *
 * Two workflows put cells into this table — the measured derivation (`VECalculator`) and SHAPE, the
 * log-free geometric repair. Before composeVeGrid, each wrote the whole 24x20 grid itself and the
 * arbitration was call order — which ran opposite to the comment describing it, so arming one
 * beside the other quietly reverted every corrected cell to BASE (docs/ecu-logic/65-workflows.md,
 * defect 1). The checks here are, in order of importance:
 *
 *   1. the invariant the composition RESTS on, asserted against the real calculator — not a mock;
 *   2. nothing armed means the table is not touched at all;
 *   3. the byte level: composing then writing touches exactly the cells that changed, nothing else.
 *
 * There was a THIRD contributor until 2026-09-09: a separate derivation for the low-opening rows,
 * with its own evidence bars and a per-cell ownership rule to referee it against the calculator.
 * It is gone, and the checks that existed only to arbitrate between two measurements went with it —
 * there is one measurement now. What composeVeGrid still has to get right is everything above.
 */
import { composeVeGrid } from '../src/lib/ve-calculator/composeVeGrid.ts';
import { VECalculator } from '../src/lib/ve-calculator/calculator.ts';
import { BinaryPatcher } from '../src/lib/binary-engine/patcher.ts';
import { APP_CONFIG } from '../src/config/constants.ts';

let fails = 0;
const check = (n, c, d) => { console.log('  ' + (c ? 'PASS' : 'FAIL') + '  ' + n + (c ? '' : ' — ' + (d ?? ''))); if (!c) fails++; };

const { SIZE_X: COLS, SIZE_Y: ROWS, ADDRESS_DATA } = APP_CONFIG.MSS54HP.VE_TABLE;
const RPM = APP_CONFIG.MSS54HP.AXIS_RPM;
const LOAD = APP_CONFIG.MSS54HP.AXIS_LOAD;
const grid = (v) => Array.from({ length: ROWS }, () => Array.from({ length: COLS }, () => v));
const copy = (g) => g.map(r => [...r]);

// ---------------------------------------------------------------------------------------------
console.log('\n[the invariant the composition rests on, against the REAL calculator]');
// composeVeGrid never sees the BASE grid. It does not need to, because the calculator pushes
// `oldVal` for every cell that did not clear the evidence gate, so a cell it did not accept is
// byte-identical to the map it was seeded from. If that ever stops being true — someone adds
// smoothing, a normalisation pass, anything that brushes a non-accepted cell — the composition
// silently starts writing that brush into the car. So the invariant is asserted against
// calculateNewVEMap's actual output, every run, before anything else is worth checking.
{
    const base = { xAxis: RPM, yAxis: LOAD, data: LOAD.map(() => RPM.map(() => 50)) };
    // 400 samples on one axis intersection, at a real log's 0.2 s spacing, asking for +20 %.
    const log = Array.from({ length: 400 }, (_, i) => ({
        time: i * 0.2, rpm: 2700, rawLoad: 7.50, correctedLoad: 7.50, stft1: 1.20, stft2: 1.20, rf: 30,
    }));
    const r = new VECalculator().calculateNewVEMap(base, log, { applyRfKorr: false });
    check('the calculator accepted at least one cell', !!r.newMap && r.acceptedMap.flat().some(Boolean));
    let clean = true;
    for (let row = 0; row < r.newMap.data.length; row++) {
        for (let col = 0; col < r.newMap.data[row].length; col++) {
            if (!r.acceptedMap[row][col] && r.newMap.data[row][col] !== base.data[row][col]) clean = false;
        }
    }
    check('every non-accepted cell is byte-identical to BASE', clean,
        'the composition premise broke: the calculator brushed a cell it did not accept');

    const composed = composeVeGrid(r.newMap.data);
    check('the derivation composes to exactly its own grid',
        JSON.stringify(composed.grid) === JSON.stringify(r.newMap.data));
    check('...as a copy, so the SHAPE overlay cannot write back into the tuned map',
        composed.grid !== r.newMap.data && composed.grid[0] !== r.newMap.data[0]);
}

// ---------------------------------------------------------------------------------------------
console.log('\n[nothing armed means the table is not touched]');
{
    check('null composes to null', composeVeGrid(null) === null);
    const ve = grid(0.3);
    check('an armed derivation composes to its grid untouched',
        JSON.stringify(composeVeGrid(ve).grid) === JSON.stringify(ve));
}

// ---------------------------------------------------------------------------------------------
console.log('\n[the byte level: the composed write touches exactly the cells that changed]');
{
    const fresh = () => {
        const bytes = new Uint8Array(0x10000);
        for (let i = 0; i < bytes.length; i++) bytes[i] = i & 0xff;
        return bytes;
    };
    const writeGrid = (g) => {
        // The patcher CLONES its input, so the mutated image comes back from getPatchedBuffer.
        const p = new BinaryPatcher(fresh().buffer);
        p.setVETableData(g);
        return new Uint8Array(p.getPatchedBuffer());
    };
    const base = grid(0.2);
    // Two cells, far apart on both axes, so a writer that smeared into its neighbours or wrote the
    // whole run would be caught by the offsets rather than by the values.
    const ve = copy(base); ve[20][5] = 0.9; ve[5][1] = 0.15;

    const a = writeGrid(base);
    const b = writeGrid(composeVeGrid(ve).grid);
    const changed = [];
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) changed.push(i);
    const cellOffsets = (row, col) => [ADDRESS_DATA + (row * COLS + col) * 2, ADDRESS_DATA + (row * COLS + col) * 2 + 1];
    const expected = new Set([...cellOffsets(20, 5), ...cellOffsets(5, 1)]);
    check('every changed byte belongs to one of the two changed cells', changed.every(i => expected.has(i)),
        `unexpected offsets: ${changed.filter(i => !expected.has(i)).slice(0, 4).map(i => '0x' + i.toString(16)).join(', ')}`);
    check('and both cells actually changed', new Set(changed).size >= 3, changed.length);
}

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
