/**
 * kf_rf_soll has one writer, and this file is why that stays true.
 *
 * Three workflows own cells in the VE table. Before composeVeGrid, each wrote the whole 24x20 grid
 * itself and the arbitration was call order — which ran opposite to the comment describing it, so
 * arming LOW LOAD beside a VE tune quietly reverted every VE-corrected cell to BASE
 * (docs/ecu-logic/65-workflows.md, defect 1). The checks here are, in order of importance:
 *
 *   1. the invariant the composition RESTS on, asserted against the real tuner — not a mock;
 *   2. the exact bug: a VE cell far above the low-opening rows must survive a LOW LOAD arm;
 *   3. the ownership rule, cell by cell;
 *   4. the byte level: composing then writing touches exactly the cells that changed, nothing else.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { composeVeGrid } from '../src/lib/ve-calculator/composeVeGrid.ts';
import { tuneLowLoad } from '../src/lib/ve-calculator/lowLoadTuner.ts';
import { readAlphaNTables } from '../src/lib/ve-calculator/alphaNTable.ts';
import { BinaryPatcher } from '../src/lib/binary-engine/patcher.ts';
import { APP_CONFIG } from '../src/config/constants.ts';

let fails = 0;
const check = (n, c, d) => { console.log('  ' + (c ? 'PASS' : 'FAIL') + '  ' + n + (c ? '' : ' — ' + (d ?? ''))); if (!c) fails++; };

const { SIZE_X: COLS, SIZE_Y: ROWS, ADDRESS_DATA } = APP_CONFIG.MSS54HP.VE_TABLE;
const grid = (v) => Array.from({ length: ROWS }, () => Array.from({ length: COLS }, () => v));
const copy = (g) => g.map(r => [...r]);
const noOwnership = () => Array.from({ length: ROWS }, () => Array.from({ length: COLS }, () => false));

// ---------------------------------------------------------------------------------------------
console.log('\n[the invariant the composition rests on, against the REAL tuner]');
// composeVeGrid never sees the BASE grid. It does not need to, because the low-load tuner's
// non-owned cells are byte-identical to the stock it was seeded from. If that ever stops being
// true — someone adds smoothing, a normalisation pass, anything that brushes a non-owned cell —
// the composition silently starts writing that brush into the car. So the invariant is asserted
// against tuneLowLoad's actual output, every run, before anything else is worth checking.
{
    const b = fs.readFileSync(fileURLToPath(new URL('../public/mock/csl-0401-community-patch-v1.partial.bin', import.meta.url)));
    const t = readAlphaNTables(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
    const veMap = { xAxis: t.sollRpm, yAxis: t.sollOpening, data: t.sollOpening.map(() => t.sollRpm.map(() => 0.2)) };
    const LLROW = 5;                                    // 0.806 % opening, inside the low band
    const tiOver = [];
    for (let i = 0; i < 40; i++) {
        const wobble = 1 + (i % 2 ? 0.01 : -0.01);      // a live two-point controller, not a frozen trim
        tiOver.push({ time: i * 7, rpm: 870, rawLoad: t.sollOpening[LLROW], rf: 10, stft1: 0.82 * wobble, stft2: 0.82 * wobble, rfKorr: 1 });
    }
    const r = tuneLowLoad(tiOver, t, veMap, { requireTiBranchProven: false });
    check('the tuner produced at least one owned cell', r.owned.flat().some(Boolean));
    let clean = true;
    for (let row = 0; row < r.tuned.length; row++) {
        for (let col = 0; col < r.tuned[row].length; col++) {
            if (!r.owned[row][col] && r.tuned[row][col] !== r.stock[row][col]) clean = false;
        }
    }
    check('every non-owned cell is byte-identical to stock', clean,
        'the composition premise broke: tuneLowLoad brushed a cell it does not own');
    check('owned mirrors the per-cell origin', r.owned.every((rw, ri) => rw.every((o, ci) => o === (r.cells[ri][ci].origin !== 'stock'))));

    const composed = composeVeGrid(null, { grid: r.tuned, owned: r.owned });
    check('low-load alone composes to exactly its own grid', JSON.stringify(composed.grid) === JSON.stringify(r.tuned));
    check('and counts exactly its owned cells', composed.lowLoadCells === r.owned.flat().filter(Boolean).length, composed.lowLoadCells);
}

// ---------------------------------------------------------------------------------------------
console.log('\n[THE BUG: a VE cell above the low rows survives a LOW LOAD arm]');
{
    const base = grid(0.2);
    const ve = copy(base); ve[20][5] = 0.9;              // a VE-accepted cell, far above the low band
    const ll = copy(base); ll[5][1] = 0.15;              // a low-load measured cell
    const owned = noOwnership(); owned[5][1] = true;

    const c = composeVeGrid(ve, { grid: ll, owned });
    check('the VE cell keeps its VE value', c.grid[20][5] === 0.9, c.grid[20][5]);
    check('the low-load cell keeps its low-load value', c.grid[5][1] === 0.15, c.grid[5][1]);
    check('an untouched cell stays BASE', c.grid[0][0] === 0.2, c.grid[0][0]);
    check('one low-load cell is counted', c.lowLoadCells === 1, c.lowLoadCells);
}

console.log('\n[ownership on a contested cell: LOW LOAD wins where it measured]');
{
    // Both claim [5][1]. LOW LOAD holds the KF_TI_N_RF divisor there and VE does not, which is the
    // reason the rule exists rather than a preference.
    const base = grid(0.2);
    const ve = copy(base); ve[5][1] = 0.5;
    const ll = copy(base); ll[5][1] = 0.15;
    const owned = noOwnership(); owned[5][1] = true;
    check('the owned cell takes the LOW LOAD value', composeVeGrid(ve, { grid: ll, owned }).grid[5][1] === 0.15);
    check('with ownership withdrawn the VE value stands', composeVeGrid(ve, { grid: ll, owned: noOwnership() }).grid[5][1] === 0.5);
}

console.log('\n[nothing armed means the table is not touched]');
{
    check('null + null composes to null', composeVeGrid(null, null) === null);
    const ve = grid(0.3);
    check('VE alone composes to the VE grid untouched', JSON.stringify(composeVeGrid(ve, null).grid) === JSON.stringify(ve));
    check('...with zero low-load cells', composeVeGrid(ve, null).lowLoadCells === 0);
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
    const ve = copy(base); ve[20][5] = 0.9;
    const ll = copy(base); ll[5][1] = 0.15;
    const owned = noOwnership(); owned[5][1] = true;

    const a = writeGrid(base);
    const b = writeGrid(composeVeGrid(ve, { grid: ll, owned }).grid);
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
