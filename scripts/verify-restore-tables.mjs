/**
 * Do the two Alpha-N restores put the tables back BYTE for byte?
 *
 * `restoreVeTable` / `restoreWarmupTable` write a shipped reference through the same encoders the
 * derivations use (uint16, x/1000, VE_MAX clamp). That round trip is where a restore can quietly
 * stop being one: a clamp that bites, a rounding step that lands a count away, an address that is
 * right for reading and wrong for writing. None of it shows up in the UI, which only ever reports
 * the count this script is checking.
 *
 * The oracle is the community partial the repo ships. It is not the reference restated in another
 * form — it is the bytes the constants were transcribed from, so agreement here means the constant,
 * the encoder and the address all agree with a real image at once.
 *
 * Run: npm run verify:restore-tables
 */
import { readFileSync } from 'node:fs';
import { BinaryPatcher } from '../src/lib/binary-engine/patcher.ts';
import { BinaryParser } from '../src/lib/binary-engine/parser.ts';
import { APP_CONFIG, EXPERIMENTAL_CONFIG } from '../src/config/constants.ts';

const REFERENCE = 'public/mock/csl-0401-community-patch-v1.partial.bin';
const DRIFTED = 'scripts/fixtures/session-920-base.bin';

const bytes = (path) => {
    const b = readFileSync(path);
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};

/** The two Z blocks, as raw bytes. 24 x 20 uint16 each. */
const BLOCKS = [
    { name: 'kf_rf_soll     ', addr: APP_CONFIG.MSS54HP.VE_TABLE.ADDRESS_DATA, len: 24 * 20 * 2 },
    { name: 'kf_rf_soll_kath', addr: EXPERIMENTAL_CONFIG.ADDRESS_WARMUP_MAP, len: 24 * 20 * 2 },
];

const slice = (buf, { addr, len }) => new Uint8Array(buf, addr, len);
const differing = (a, b) => {
    let n = 0;
    for (let i = 0; i < a.length; i += 2) if (a[i] !== b[i] || a[i + 1] !== b[i + 1]) n++;
    return n;
};

let failed = 0;
const check = (label, ok, detail) => {
    console.log(`${ok ? '  ok  ' : '  FAIL'}  ${label}${detail ? `   ${detail}` : ''}`);
    if (!ok) failed++;
};

const ref = bytes(REFERENCE);

console.log('\nBEFORE — what the drifted image holds\n');
{
    const p = new BinaryParser(bytes(DRIFTED));
    const ve = p.veCellsOffStock();
    const wu = p.warmupCellsOffStock();
    console.log(`  kf_rf_soll        ${ve} / 480 cells off the reference`);
    console.log(`  kf_rf_soll_kath   ${wu} / 480 cells off the reference`);
    // The counts the RESTORE rows show. Asserted so a silent change to either reference — or to the
    // fixture — is a failed run rather than a differently-worded screen.
    check('VE drift count is 363', ve === 363, `got ${ve}`);
    check('WARMUP drift count is 443', wu === 443, `got ${wu}`);

    const q = new BinaryParser(ref);
    check('reference image reports zero drift on both',
        q.veCellsOffStock() === 0 && q.warmupCellsOffStock() === 0,
        `ve=${q.veCellsOffStock()} warmup=${q.warmupCellsOffStock()}`);
}

console.log('\nAFTER — restore the drifted image and compare against the reference IMAGE\n');
{
    const patcher = new BinaryPatcher(bytes(DRIFTED));
    patcher.restoreVeTable();
    patcher.restoreWarmupTable();
    const out = patcher.getPatchedBuffer();

    for (const block of BLOCKS) {
        const n = differing(slice(out, block), slice(ref, block));
        console.log(`  ${block.name}  ${n} / 480 cells differ from ${REFERENCE}`);
        check(`${block.name.trim()} restored byte for byte`, n === 0, `${n} cells differ`);
    }

    const p = new BinaryParser(out);
    check('parser now reports zero drift on both',
        p.veCellsOffStock() === 0 && p.warmupCellsOffStock() === 0,
        `ve=${p.veCellsOffStock()} warmup=${p.warmupCellsOffStock()}`);
}

console.log('\nISOLATION — one restore must not touch the other table\n');
{
    const drifted = bytes(DRIFTED);
    const onlyVe = new BinaryPatcher(bytes(DRIFTED));
    onlyVe.restoreVeTable();
    const a = onlyVe.getPatchedBuffer();
    check('VE restore leaves kf_rf_soll_kath alone',
        differing(slice(a, BLOCKS[1]), slice(drifted, BLOCKS[1])) === 0);

    const onlyWu = new BinaryPatcher(bytes(DRIFTED));
    onlyWu.restoreWarmupTable();
    const b = onlyWu.getPatchedBuffer();
    check('WARMUP restore leaves kf_rf_soll alone',
        differing(slice(b, BLOCKS[0]), slice(drifted, BLOCKS[0])) === 0);
}

console.log(failed ? `\n${failed} check(s) FAILED\n` : '\nall checks passed\n');
process.exit(failed ? 1 : 0);
