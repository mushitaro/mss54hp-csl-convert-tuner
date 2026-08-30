/**
 * The calibration edit path, at the byte level.
 *
 * What these checks pin:
 *  - an edit moves exactly its run's bytes — axes and the 2-byte size headers
 *    beside them never move;
 *  - signed raws round-trip two's-complement through the patcher;
 *  - arbitration holds at the byte boundary with the UI bypassed: an edit
 *    overlapping an armed writer's span is skipped and reported, managed and
 *    sealed spans are refused even when handed directly to apply;
 *  - reference copy is a raw byte copy, and copying identical bytes drops the
 *    edit entirely (the set is exactly "what will change");
 *  - bulk scale stays within one LSB of the ideal and counts its clamps;
 *  - the checksum correction afterwards yields a valid image, twice (idempotent).
 *
 * buildPatchedBuffer itself is a React hook closure; its calibration branch is
 * the same applyCalibrationEdits call sequenced last before the checksum, so
 * the sequencing property is pinned here against a manual patcher chain and
 * the hook wiring is exercised in the browser walk.
 *
 * Runner: node --experimental-strip-types --import ./scripts/ts-resolve.mjs
 */
import { readFileSync } from 'node:fs';
import { BinaryPatcher } from '../src/lib/binary-engine/patcher.ts';
import { analyzeDataChecksum } from '../src/lib/checksum/dmeDataChecksum.ts';
import { buildCatalog } from '../src/lib/calibration/catalog.ts';
import { decodeParam } from '../src/lib/calibration/decode.ts';
import {
    EMPTY_EDITS, withCellEdit, withCellRevert, withBulkOp, withReferenceCopy, withoutParam,
    editConflicts, changedCellCount, managedSpans,
} from '../src/lib/calibration/edits.ts';
import { applyCalibrationEdits } from '../src/lib/calibration/apply.ts';

let fails = 0;
const check = (n, c, d) => { console.log('  ' + (c ? 'PASS' : 'FAIL') + '  ' + n + (c ? '' : ' — ' + (d ?? ''))); if (!c) fails++; };

const graph = JSON.parse(readFileSync('public/data/calibration-graph.json', 'utf8'));
const cat = buildCatalog(graph);

/** A 64 KB image with recognisable filler, so any unintended write shows as a changed byte. */
const fresh = () => {
    const b = new Uint8Array(0x10000);
    for (let i = 0; i < b.length; i++) b[i] = i & 0xFF;
    return b;
};
const bufferOf = (bytes) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const diff = (a, b) => { const out = []; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) out.push(i); return out; };

// Representative parameters, picked from the real catalog by shape.
const unlockedOfKind = (pred) => cat.params.find(p => !p.lock.locked && p.run && pred(p));
const constant8 = unlockedOfKind(p => p.kind === 'constant' && p.run.bits === 8 && !p.run.signed && p.runMathOk);
const signed16 = unlockedOfKind(p => p.kind === 'constant' && p.run.bits === 16 && p.run.signed && p.runMathOk);
const curve = unlockedOfKind(p => p.kind === 'curve' && p.runMathOk && p.xAxis?.source === 'stored');
const map = unlockedOfKind(p => p.kind === 'map' && p.runMathOk && p.xAxis?.source === 'stored' && p.yAxis?.source === 'stored');
check('found representative params', !!constant8 && !!signed16 && !!curve && !!map,
    JSON.stringify({ constant8: constant8?.name, signed16: signed16?.name, curve: curve?.name, map: map?.name }));
console.log(`  using: ${constant8.name} · ${signed16.name} · ${curve.name} · ${map.name}`);

console.log('\n[a map edit moves exactly its run bytes; axes and headers do not]');
{
    const before = fresh();
    const base = decodeParam(bufferOf(before), map);
    const targetPhys = map.run.scaling.toPhysical(base.raw?.[0] ?? 0);
    // Edit two cells to fresh raw values via the physical path.
    let { set } = withCellEdit(EMPTY_EDITS, map, base.value, 0, map.run.scaling.toPhysical(1));
    ({ set } = withCellEdit(set, map, base.value, map.run.count - 1, map.run.scaling.toPhysical(2)));
    const p = new BinaryPatcher(bufferOf(before));
    const report = applyCalibrationEdits(p, [...set.values()], []);
    const after = new Uint8Array(p.getBuffer());
    const moved = diff(before, after);
    const bytes = map.run.bits / 8;
    const runStart = map.run.address;
    const runEnd = runStart + map.run.count * bytes;
    check('apply reports 1 applied, 0 skipped', report.applied.length === 1 && report.skipped.length === 0, JSON.stringify(report));
    check('every moved byte is inside the value run', moved.every(i => i >= runStart && i < runEnd),
        `moved ${JSON.stringify(moved.filter(i => i < runStart || i >= runEnd))} outside 0x${runStart.toString(16)}-0x${runEnd.toString(16)}`);
    const xStart = map.xAxis.def.address;
    check('x axis untouched', moved.every(i => i < xStart || i >= xStart + map.xAxis.def.n * (map.xAxis.def.bits / 8)));
    check('size header untouched', !moved.includes(xStart - 2) && !moved.includes(xStart - 1));
    check('cells changed count is 2', changedCellCount(set.get(map.id)) === 2);
    void targetPhys;
}

console.log('\n[signed 16-bit: two\'s-complement round trip]');
{
    const before = fresh();
    const base = decodeParam(bufferOf(before), signed16);
    const negPhys = signed16.run.scaling.toPhysical(-50);
    const { set, quantised } = withCellEdit(EMPTY_EDITS, signed16, base.value, 0, negPhys);
    check('quantised raw is -50', quantised.raw === -50, `got ${quantised.raw}`);
    const p = new BinaryPatcher(bufferOf(before));
    applyCalibrationEdits(p, [...set.values()], []);
    const after = new Uint8Array(p.getBuffer());
    check('bytes are 0xFF 0xCE', after[signed16.run.address] === 0xFF && after[signed16.run.address + 1] === 0xCE,
        `got ${after[signed16.run.address].toString(16)} ${after[signed16.run.address + 1].toString(16)}`);
    const decoded = decodeParam(p.getBuffer(), signed16);
    check('decodes back to raw -50', decoded.value.raw[0] === -50, `got ${decoded.value.raw[0]}`);
}

console.log('\n[arbitration holds with the UI bypassed]');
{
    const before = fresh();
    // A hand-built edit inside kf_rf_soll's span, with ALPHA-N armed.
    const veSpan = { address: 0xD356, length: 24 * 20 * 2, owner: 'ALPHA-N' };
    const rogue = {
        paramId: 'p:test', name: 'ROGUE_VE_EDIT', address: 0xD400, bits: 16, signed: false,
        count: 2, raw: [1, 2], baseRaw: [0, 0],
    };
    const p = new BinaryPatcher(bufferOf(before));
    const report = applyCalibrationEdits(p, [rogue], [veSpan]);
    check('edit overlapping an armed writer is skipped', report.skipped.length === 1 && report.skipped[0].reason === 'owned by ALPHA-N',
        JSON.stringify(report.skipped));
    check('no bytes moved', diff(before, new Uint8Array(p.getBuffer())).length === 0);

    // Managed bytes are refused even with NO conflict spans passed at all.
    const managed = managedSpans()[0];
    const rogue2 = { ...rogue, name: 'ROGUE_CFG', address: managed.address, bits: 8, count: 1, raw: [7], baseRaw: [1] };
    const p2 = new BinaryPatcher(bufferOf(before));
    const report2 = applyCalibrationEdits(p2, [rogue2], []);
    check('managed byte refused with apply called directly', report2.skipped.length === 1 && report2.skipped[0].reason.startsWith('owned by'),
        JSON.stringify(report2.skipped));

    // Sealed symbol refused by name.
    const sealedDef = cat.byName.get('KF_LLR_QVS_GRUND');
    const rogue3 = {
        paramId: sealedDef.id, name: sealedDef.name, address: sealedDef.run.address, bits: sealedDef.run.bits,
        signed: false, count: 1, raw: [1], baseRaw: [0],
    };
    const report3 = applyCalibrationEdits(new BinaryPatcher(bufferOf(before)), [rogue3], []);
    check('sealed symbol refused', report3.skipped.length === 1 && report3.skipped[0].reason === 'sealed', JSON.stringify(report3.skipped));

    // A checksum-slot edit is refused outright.
    const rogue4 = { ...rogue, name: 'ROGUE_SLOT', address: 0x3FFC, bits: 16, count: 1, raw: [1], baseRaw: [0] };
    const report4 = applyCalibrationEdits(new BinaryPatcher(bufferOf(before)), [rogue4], []);
    check('checksum slot refused', report4.skipped[0]?.reason === 'checksum slot', JSON.stringify(report4.skipped));

    // editConflicts flags the same rogue edit for the UI side.
    const conflicts = editConflicts(new Map([[rogue.paramId, rogue]]), [veSpan]);
    check('editConflicts names the owner', conflicts.get('p:test') === 'ALPHA-N');
}

console.log('\n[reference copy: raw byte copy, identical copy drops out]');
{
    const before = fresh();
    const refBytes = fresh();
    // Make the reference differ inside the curve's value run.
    const run = curve.run;
    const bytes = run.bits / 8;
    refBytes[run.address] = (refBytes[run.address] + 1) & 0xFF;
    const base = decodeParam(bufferOf(before), curve);
    const ref = decodeParam(bufferOf(refBytes), curve);
    const copied = withReferenceCopy(EMPTY_EDITS, curve, base.value, ref.value);
    check('copy accepted', copied.ok === true);
    const edit = copied.set.get(curve.id);
    check('copied raw equals the reference raw', JSON.stringify(edit.raw) === JSON.stringify(ref.value.raw));
    const p = new BinaryPatcher(bufferOf(before));
    applyCalibrationEdits(p, [edit], []);
    const after = new Uint8Array(p.getBuffer());
    const runBytesAfter = after.slice(run.address, run.address + run.count * bytes);
    const runBytesRef = refBytes.slice(run.address, run.address + run.count * bytes);
    check('run bytes byte-identical to the reference', JSON.stringify([...runBytesAfter]) === JSON.stringify([...runBytesRef]));

    // Copying a reference identical to base yields no edit at all.
    const same = withReferenceCopy(EMPTY_EDITS, curve, base.value, base.value);
    check('identical copy auto-drops', same.ok === true && same.set.size === 0);

    // A null reference refuses.
    const refuse = withReferenceCopy(EMPTY_EDITS, curve, base.value, null);
    check('null reference refused', refuse.ok === false && refuse.reason === 'undecodable');
}

console.log('\n[bulk scale: physical space, per-cell quantise, clamps counted]');
{
    const before = fresh();
    // The filler byte at this address may be 0, and 0 × anything is 0 — seed a
    // real mid-range value so the scale has something to move.
    before[constant8.run.address] = 100;
    const base = decodeParam(bufferOf(before), constant8);
    const scaling = constant8.run.scaling;
    const { set, clampedCells } = withBulkOp(EMPTY_EDITS, constant8, base.value, { kind: 'scale', amount: 1.02 });
    const edit = set.get(constant8.id);
    if (edit) {
        const idealPhys = base.value.phys[0] * 1.02;
        const gotPhys = scaling.toPhysical(edit.raw[0]);
        const step = Math.abs(scaling.toPhysical(edit.raw[0] + 1) - gotPhys) || 1;
        check('scaled cell within one LSB of ideal', Math.abs(gotPhys - idealPhys) <= step + 1e-9,
            `ideal ${idealPhys}, got ${gotPhys}, step ${step}`);
    } else {
        // ×1.02 rounded back onto the same raw — legal for a coarse field; then the set must be empty.
        check('no-op scale left no edit', set.size === 0);
    }
    check('no clamps at mid-range', clampedCells === 0, `${clampedCells}`);

    // At the rail: push far past the field maximum and count every clamp.
    // `add` rather than `scale`, so a zero base cannot make the test degenerate.
    const railed = withBulkOp(EMPTY_EDITS, constant8, base.value, { kind: 'add', amount: 1e12 });
    const railedEdit = railed.set.get(constant8.id);
    check('rail scale clamps the cell', railed.clampedCells === 1 && railedEdit?.raw[0] === 255,
        JSON.stringify({ clamped: railed.clampedCells, raw: railedEdit?.raw }));

    // Revert drops the entry.
    const reverted = withoutParam(railed.set, constant8.id);
    check('revert empties the set', reverted.size === 0);

    // Per-cell revert equals whole-param revert for a single-cell param.
    const cellReverted = withCellRevert(railed.set, constant8, base.value, 0);
    check('cell revert back to base drops the entry', cellReverted.size === 0);
}

console.log('\n[checksum correction after edits: valid image, idempotent rebuild]');
{
    const before = fresh();
    const base = decodeParam(bufferOf(before), map);
    const { set } = withCellEdit(EMPTY_EDITS, map, base.value, 3, map.run.scaling.toPhysical(5));
    const build = () => {
        const p = new BinaryPatcher(bufferOf(before));
        applyCalibrationEdits(p, [...set.values()], []);
        p.applyChecksumCorrection();
        return new Uint8Array(p.getBuffer());
    };
    const first = build();
    const second = build();
    const slots = analyzeDataChecksum(first);
    check('both checksum slots valid after correction', slots.every(s => s.isValid),
        JSON.stringify(slots.map(s => ({ name: s.name, valid: s.isValid }))));
    check('rebuild is byte-identical (idempotent)', diff(first, second).length === 0);
}

if (fails) { console.error(`\n${fails} check(s) failed`); process.exit(1); }
console.log('\nall checks passed');
