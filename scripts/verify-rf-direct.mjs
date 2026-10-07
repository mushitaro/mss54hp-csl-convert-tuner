/** 0401 RAM diagnostics: source addresses, scaling, read windows, and poll failure isolation.
 *  Uses synthetic bytes only; passing does not establish the mapping on a physical DME. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');
const bundle = await build({
    stdin: {
        contents: `export * from './src/lib/dme-link/rfDirect';
export * from './src/lib/dme-link/ramMap';
export { WebSerialDmeLink } from './src/lib/dme-link/webSerialDmeLink';
export * from './src/lib/log-engine/logProfile';`,
        resolveDir: root, loader: 'ts',
    },
    bundle: true, platform: 'node', format: 'esm', write: false,
    alias: { '@': path.join(root, 'src') },
});
const bundledSource = `${bundle.outputFiles[0].text}\n//# sourceURL=rf-direct-test-bundle.mjs`;
const m = await import(`data:text/javascript;base64,${Buffer.from(bundledSource).toString('base64')}`);
const signals = m.Mss54HpRamSignals;
const graph = JSON.parse(fs.readFileSync(path.join(root, 'public/data/calibration-graph.json'), 'utf8'));
const decompPath = path.join(root, 'public/data/calibration-decomp.json');
// The public preview source deliberately excludes the firmware-derived corpus.
// Only the source-text cross-check needs it; wire decoding and poll tests still run.
const decomp = fs.existsSync(decompPath) ? JSON.parse(fs.readFileSync(decompPath, 'utf8')).texts : null;
for (const [name, symbol] of [
    ['RF_KORR_DIRECT', 'rf_korr'], ['RF_SOLL_DIRECT', 'rf_soll'], ['RF_MAP_INTEGRATOR_DIRECT', 'rf_p_saug_i'],
]) {
    const node = graph.nodes.find(n => n.t === 'ram' && n.bank === 'master' && n.name === symbol);
    assert.equal(signals[name].address, node?.addr, `${symbol} must match the 0401 RAM source`);
    assert.equal(signals[name].size, 2);
    assert(m.isRamReadInRange(signals[name].segment, signals[name].address, 2));
}
if (decomp) {
assert.match(decomp['f:master:021a70'], /rf_korr = 0x400/);
assert.match(decomp['f:master:0218d0'], /rf_soll \* \(uint\)rf_korr/);
assert.match(decomp['f:master:0218d0'], /rf_p_saug_i_temp >> 6/);
assert.match(decomp['f:master:01a9d2'], /rf_soll = \(uint16_t\)/);
assert.match(decomp['f:master:021f2c'], /rf_p_saug_i = \(int16_t\)/);
} else {
    console.log('SKIP firmware-text cross-check: private decompiler corpus is absent.');
}

const word = n => Uint8Array.of((n >> 8) & 255, n & 255);
const decode = (name, raw) => m.decodeRfDirect(word(raw), signals[name].segment,
    signals[name].address, 1100, 1150, 1000);
assert.deepEqual(decode('RF_KORR_DIRECT', 1024), {
    rfKorrDirect: 1, rfKorrDirectTime: .125, rfKorrDirectReadMs: 50,
    rfDirectSource: 'ram-0401-unverified',
});
assert.equal(decode('RF_KORR_DIRECT', 1280).rfKorrDirect, 1.25);
assert.equal(decode('RF_SOLL_DIRECT', 725).rfSollDirect, .725);
assert.equal(decode('RF_MAP_INTEGRATOR_DIRECT', -1600).rfMapIntegratorDirect, -.025);
assert.equal(decode('RF_MAP_INTEGRATOR_DIRECT', 1600).rfMapIntegratorDirect, .025);
assert.equal(decode('RF_MAP_INTEGRATOR_DIRECT', -1).rfMapIntegratorDirect, -1 / 64000,
    'store retains fractional resolution rather than claiming the applied integer contribution');
assert.equal(decode('RF_SOLL_DIRECT', 0).rfSollDirect, 0, 'a real zero remains a reading');
assert.deepEqual(m.decodeRfDirect(Uint8Array.of(4), 4, 0xffeea6, 1100, 1150, 1000), {});
assert.deepEqual(m.decodeRfDirect(word(1024), 1, 0xffeea6, 1100, 1150, 1000), {});
assert.deepEqual(m.decodeRfDirect(word(1024), 4, 0xffeea6, 1150, 1100, 1000), {});

const works = m.LOG_PROFILES.VE;
const direct = works.exchanges.filter(x => x.kind === 'ram' && m.isRfDirectRead(x.segment, x.address));
assert.equal(direct.length, 3);
assert.equal(direct.find(x => x.address === 0xffeea6).every ?? 1, 1);
assert.equal(direct.find(x => x.address === 0xffedee).every ?? 1, 1);
assert.equal(direct.find(x => x.address === 0xffeed8).every, 8);
assert.equal(m.productionExchanges(direct).length, 0, 'diagnostics must not slow the production VE profile');
assert(!works.fallback.some(x => x.kind === 'ram' && m.isRfDirectRead(x.segment, x.address)),
    'a failed RAM truth gate keeps the established block-only fallback');

// Exercise the actual polling method with successful bytes, then one rejected
// diagnostic read, then recovery. No real transport, BIN, or adaptation changes.
const link = new m.WebSerialDmeLink({ transport: {} });
link.connected = true;
link.setLiveExchanges([
    { kind: 'block', selection: 3 },
    { kind: 'ram', name: 'lambda', ...m.LAMBDA_TRIM_RAM_READ },
    ...direct,
]);
const standard = new Uint8Array(35);
standard.set(word(2400), 0);
standard.set(word(900), 8);
standard[11] = 128;
standard.set(word(2458), 20);
link.pollStandardBlock = async () => standard;
let failure = false;
let resyncs = 0;
link.resyncTransport = async () => { resyncs++; };
link.pollRamChunk = async read => {
    if (read.address === 0xff80ca) return Uint8Array.of(128, 0, 128, 0, 128, 0, 128, 0);
    if (read.address === 0xffeea6) {
        if (failure) throw new Error('synthetic diagnostic read failure');
        return word(1152);
    }
    if (read.address === 0xffedee) return word(800);
    if (read.address === 0xffeed8) return word(-1600);
    throw new Error('unexpected read');
};
const first = await link.pollLiveMeasurementInner();
assert.equal(first.rfKorrDirect, 1.125);
assert.equal(first.rfSollDirect, .8);
assert.equal(first.rfMapIntegratorDirect, -.025);
assert.equal(first.rfDirectSource, 'ram-0401-unverified');
assert(first.rfKorrDirectTime >= 0 && first.rfKorrDirectTime <= first.time);
assert(first.rfSollDirectTime >= first.rfKorrDirectTime && first.rfSollDirectTime <= first.time);
assert(!('rfKorrDirect' in link.lastSlowLane));
failure = true;
const second = await link.pollLiveMeasurementInner();
assert.equal(second.rpm, 2400);
assert.equal(second.stft1, 1);
assert.equal(second.rfSollDirect, .8);
assert.equal(second.rfKorrDirect, undefined, 'failure must not carry the previous k');
assert.equal(second.rfKorrDirectTime, undefined);
assert.equal(second.rfKorrDirectReadMs, undefined);
assert.equal(second.rfMapIntegratorDirect, undefined, 'a non-due MAP read must not carry a stale store');
assert.equal(second.rfMapIntegratorDirectTime, undefined);
assert.equal(resyncs, 1);
failure = false;
const third = await link.pollLiveMeasurementInner();
assert.equal(third.rfKorrDirect, 1.125, 'next successful read recovers without restarting the log');
assert(third.rfKorrDirectTime >= first.rfKorrDirectTime);
const addedMs = m.sampleMs(direct);
const beforeMs = m.sampleMs(works.exchanges) - addedMs;
console.log(`RF direct diagnostics passed: primary-source addresses, signed scaling, independent read windows, `
    + `failure isolation, no stale carry, recovery, WORKS/production separation.`);
console.log(`Rate model: +${addedMs.toFixed(1)} ms/sample; WORKS ${(1000 / beforeMs).toFixed(2)} `
    + `-> ${(1000 / (beforeMs + addedMs)).toFixed(2)} Hz (estimate, measure on car).`);
