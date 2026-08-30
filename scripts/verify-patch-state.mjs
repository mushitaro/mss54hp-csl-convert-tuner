/**
 * What the app believes the CAR is holding, and what it therefore filters a log through.
 *
 * A session stores its BASE unpatched and rebuilds the tune from it — the safeguard against
 * correcting an already-corrected map (V0*C^2). But the log was recorded against the car AFTER
 * WRITE PATCH-ON, and one of the tables that write rewrites is `KF_BZ_WDK_VL`, which is exactly what
 * `readLambdaLimits` reads back to decide which samples were taken at full load. So "which bytes
 * were in the car" is not a labelling question: replay the same drive against the raw BASE and the
 * full-load gate rejects the pulls the patch exists to keep.
 *
 * Two claims are pinned here, both of which were false before:
 *
 *   1. `bytesAsRun` reconstructs the running calibration from BASE + armed toggles, and with nothing
 *      armed returns the BASE untouched — no reference-car constants leaked into a stock image.
 *   2. `armedPatchesFromHistory` can answer "what is armed" for the sessions `tuneSettings` cannot
 *      describe: a BASE flashed patch-on before the first log, and a research run.
 *
 * Run against the real community partial BIN, not a synthetic one: the thresholds being tested are
 * calibration, and a fabricated table would be testing the fabrication.
 */
import { readFileSync } from 'node:fs';
import { BinaryParser } from '../src/lib/binary-engine/parser.ts';
import { BinaryPatcher, bytesAsRun } from '../src/lib/binary-engine/patcher.ts';
import { isFullLoad } from '../src/lib/log-engine/lambdaGates.ts';
import { armedPatchesFromHistory } from '../src/lib/db/flashState.ts';

let fails = 0;
const check = (n, c, d) => { console.log('  ' + (c ? 'PASS' : 'FAIL') + '  ' + n + (c ? '' : ' — ' + d)); if (!c) fails++; };

const raw = readFileSync(new URL('../public/mock/csl-0401-community-patch-v1.partial.bin', import.meta.url));
const BASE = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
const bytes = (b) => new Uint8Array(b);
const same = (a, b) => {
    const x = bytes(a), y = bytes(b);
    if (x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
    return true;
};
const NONE = { applyPatch: false, applyWotDisable: false, applyTankVentDisable: false };

console.log('\n[nothing armed is a true no-op, not a rewrite with someone else\'s constants]');
{
    // The failure this guards: every OFF direction used to write a reference car's values, so
    // merely asking "what was running" would have replaced calibration the app was only reading.
    check('bytesAsRun(BASE, nothing armed) === BASE, byte for byte', same(bytesAsRun(BASE, NONE), BASE));
    // And it is not accidentally a no-op in the other direction.
    check('arming WOT DISABLE does change the bytes', !same(bytesAsRun(BASE, { ...NONE, applyWotDisable: true }), BASE));
}

console.log('\n[the full-load gate follows the patch, which is the whole point of the patch]');
{
    const stock = new BinaryParser(bytesAsRun(BASE, NONE)).readLambdaLimits();
    const patched = new BinaryParser(bytesAsRun(BASE, { ...NONE, applyWotDisable: true })).readLambdaLimits();
    check('the BASE is not already WOT-disabled (else this file tests nothing)',
        stock.wotThreshold.z.flat().every(v => v <= 100), `z = ${stock.wotThreshold.z[0]}`);
    check('armed, every threshold cell reads 102.3',
        patched.wotThreshold.z.flat().every(v => Math.abs(v - 102.3) < 0.05),
        `z = ${patched.wotThreshold.z[0]}`);

    // A pull the DME was controlling through because the patch was in: 76.5 % throttle at 3000 rpm.
    // Stock thresholds call it full load and throw the sample away; patched, the gate is inert.
    const pull = { wdk1: 76.5, rpm: 3000, tmot: 92 };
    check('a hard pull IS full load against the stock table',
        isFullLoad(stock, pull.wdk1, pull.rpm, pull.tmot));
    check('the same pull is NOT full load against the patched table — the samples survive',
        !isFullLoad(patched, pull.wdk1, pull.rpm, pull.tmot));
    // Part load must be kept either way, or the test above would pass for the wrong reason.
    check('a part-load cruise survives both', !isFullLoad(stock, 30, 2000, 92) && !isFullLoad(patched, 30, 2000, 92));
}

console.log('\n[the patched view is the one WRITE PATCH-ON actually produces]');
{
    // Not a second implementation: bytesAsRun must agree with the patcher the write path drives,
    // or the gate would describe a car nobody flashed.
    const p = new BinaryPatcher(BASE);
    p.disableMapCorrection();
    p.setWOTThreshold(true);
    const written = new BinaryParser(p.getBuffer()).readLambdaLimits();
    const asRun = new BinaryParser(bytesAsRun(BASE, { applyPatch: true, applyWotDisable: true, applyTankVentDisable: false }))
        .readLambdaLimits();
    check('thresholds match the write path cell for cell',
        JSON.stringify(written.wotThreshold) === JSON.stringify(asRun.wotThreshold));
    check('and so do the controller stops', written.fMax === asRun.fMax && written.fMin === asRun.fMin);
}

console.log('\n[a session with no tuneSettings can still say what is in the car]');
{
    const flash = (over = {}) => ({
        at: 1, sha256: 'x', tuned: false,
        settings: {
            applyPatch: false, applyWotDisable: false, applyTankVentDisable: false,
            writeWarmup: false, writeWot: false, ...(over.settings ?? {}),
        },
        ...over,
    });
    check('never flashed answers null, so the caller falls back to detection',
        armedPatchesFromHistory({ flashHistory: [] }) === null);

    const armed = armedPatchesFromHistory({
        flashHistory: [flash({ settings: { applyPatch: true, applyWotDisable: true, applyTankVentDisable: true } })],
    });
    check('a patch-on flash re-arms all three',
        armed.applyPatch && armed.applyWotDisable && armed.applyTankVentDisable, JSON.stringify(armed));
    // Tune CONTENT must not be re-armed from a flash record: warmup/WOT inject derived tables, and
    // a reopened workspace has not derived them.
    check('and re-arms nothing else',
        Object.keys(armed).sort().join(',') === 'applyPatch,applyTankVentDisable,applyWotDisable',
        Object.keys(armed).join(','));

    // The LAST flash is the state of the car — finalising has to take the patch back off.
    const after = armedPatchesFromHistory({
        flashHistory: [
            flash({ at: 1, settings: { applyPatch: true, applyWotDisable: true } }),
            flash({ at: 2, tuned: true }),
        ],
    });
    check('a later patch-off flash wins over the earlier patch-on',
        !after.applyPatch && !after.applyWotDisable);

    // An older record predates the field. Undefined must stay undefined so the load falls back to
    // detection for that one toggle rather than asserting an answer the record never held.
    const legacy = armedPatchesFromHistory({
        flashHistory: [{ at: 1, sha256: 'x', settings: { applyPatch: true, applyWotDisable: false, writeWarmup: false, writeWot: false } }],
    });
    check('a record written before applyTankVentDisable existed leaves it undefined',
        legacy.applyTankVentDisable === undefined && legacy.applyPatch === true);
}

console.log(fails === 0 ? '\nAll patch-state checks passed.\n' : `\n${fails} check(s) FAILED.\n`);
process.exit(fails === 0 ? 0 : 1);
