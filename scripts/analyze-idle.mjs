/**
 * Replays a REAL idle run through the real tuner.
 *
 *     npm run analyze:idle -- <session.json>
 *
 * The argument is what EXPORT SESSION writes: one file holding the session record, its samples and
 * both images. That is the whole point of it — the derivation needs the samples AND the BASE they
 * were recorded against, because every threshold the tuner uses is read out of that binary rather
 * than written into the code. A log on its own cannot be replayed, which is why the CSV export it
 * replaced was never enough.
 *
 * NOT a verify:* script, and the distinction is the one the other analyze:* entries make: verify
 * answers a question about the code and runs on a fresh clone; this answers a question about one
 * drive and needs that drive as an argument.
 *
 * What it is for. The panel shows the answer on a phone, in a car park, at the moment the run ends.
 * This shows the same answer at a desk, with the census broken out and every dwell listed — and it
 * runs the derivation twice, once as the app does and once reading `md_llri` alone, because the
 * difference between those two numbers IS the confound. If they agree, the adaptation had not
 * started moving value yet and the run is short. If the second says "no correction needed" and the
 * first does not, that is the failure mode `verify-idle-practice.mjs` exists to prevent, observed
 * on a real car.
 *
 * `--practice` runs it against the simulated engine instead of a file. Not a test — verify:idle and
 * analyze:idle-practice are the tests — but it means this script can be exercised before the car
 * exists, and an analysis tool nobody has ever run is not one to reach for the first time with a
 * drive's worth of data at stake.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readIdleTables, qvsAt } from '../src/lib/idle/idleTables.ts';
import { idleCensus, tuneIdleFeedforward } from '../src/lib/idle/tuner.ts';

const path = process.argv[2];
if (!path) {
    console.error('usage: npm run analyze:idle -- <session.json>   (EXPORT SESSION writes this file)');
    console.error('       npm run analyze:idle -- --practice       (the simulated engine instead)');
    process.exit(2);
}

const bundle = path === '--practice' ? await practiceBundle() : JSON.parse(fs.readFileSync(path, 'utf8'));
if (bundle.format !== 1) {
    console.error(`This file says format ${bundle.format}; this script reads format 1.`);
    process.exit(2);
}

const samples = bundle.log?.idle ?? [];
if (samples.length === 0) {
    // Said rather than inferred: a session with a BASE and no run is an ordinary thing to have, and
    // "0 dwells" would read as a failed measurement rather than an absent one.
    console.error(`${bundle.session?.label ?? path} holds no idle samples. Nothing to replay.`);
    process.exit(1);
}
if (!bundle.binaries?.base) {
    console.error('This session has no stored BASE. Every threshold is read from it, so there is nothing to measure against.');
    process.exit(1);
}

const base = Uint8Array.from(Buffer.from(bundle.binaries.base, 'base64'));
const tables = readIdleTables(base.buffer.slice(base.byteOffset, base.byteOffset + base.byteLength));
if (!tables) {
    console.error('readIdleTables refused this BASE. Either it is not a 0401 partial BIN, or K_LLR_Q_MCS / K_LLR_QSOLL_MIN are non-zero — in which case LLR_QSOLL is not KF_LLR_QVS_GRUND alone and this derivation does not apply to it.');
    process.exit(1);
}

const span = samples[samples.length - 1].time - samples[0].time;
console.log(`\n${bundle.session?.label ?? path}`);
console.log(`  ${samples.length} samples over ${span.toFixed(0)} s (${(samples.length / Math.max(span, 1e-9)).toFixed(2)} Hz)`);
console.log(`  target ${tables.idleTargetNm.toFixed(1)} Nm · authority floor ${tables.qvsAuthorityFloorKgH.toFixed(1)} kg/h · map step ${tables.qvsStepKgH} kg/h`);

const census = idleCensus(samples, tables);
console.log(`
[census]  ${census.samplesAdmitted}/${census.samplesSeen} samples admitted`
    + ` · ${census.dwellsAccepted}/${census.dwellsFound} dwells accepted`
    + ` · worst error ${census.worstErrorNm.toFixed(2)} Nm`);
console.log(`          md_llri source: ${census.source}`
    + (census.limpSeen ? ' · LIMP BRANCH SEEN — nothing may be written from this run' : '')
    + (census.integratorRailed ? ' · an accepted dwell sat on a clamp' : ''));
const rejects = Object.entries(census.rejects).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
for (const [reason, n] of rejects) console.log(`          ${String(n).padStart(6)}  ${reason}`);

/** Both readings, side by side. The gap between them is what `lfra_adapt` moved. */
for (const [label, opts] of [
    ['md_llri + md_llra (what the app derives)', {}],
    ['md_llri alone (the confounded reading)', { useAdaptationSum: false }],
]) {
    const result = tuneIdleFeedforward(samples, tables, opts);
    console.log(`\n[${label}]`);
    if (!result) { console.log('  refused'); continue; }
    console.log(`  acceptable ${result.acceptable} · converged ${result.converged}`
        + ` · target ${result.targetNm.toFixed(2)} Nm`
        + ` · gain ${result.report.gainUsed.toFixed(3)} kg/h/Nm${result.report.gainLearned ? ' (learned)' : ''}`);
    // Only the cells this run could have written. `cold-row` and `stall-column` are structural
    // refusals — the corrector never touches a cold row or the 500 rpm stall catch, whatever the
    // log says — and printing thirty of them per mode buries the two lines that carry the answer.
    const structural = new Set(['cold-row', 'stall-column']);
    let moved = 0;
    const refusedBy = new Map();
    for (const row of result.cells) {
        for (const cell of row) {
            if (cell.rejected) {
                if (structural.has(cell.rejected)) continue;
                refusedBy.set(cell.rejected, (refusedBy.get(cell.rejected) ?? 0) + 1);
                continue;
            }
            if (cell.tuned === cell.stock) continue;
            moved++;
            console.log(`  ${`${cell.tmot} C / ${cell.rpm} rpm`.padEnd(20)}`
                + ` ${cell.stock.toFixed(1)} -> ${cell.tuned.toFixed(1)} kg/h`
                + `  (error ${cell.errorNm.toFixed(2)} Nm, ${cell.samples} samples / ${cell.dwells} dwells)`);
        }
    }
    console.log(`  ${moved} writable cell(s) would move`
        + (refusedBy.size ? `; refused: ${[...refusedBy].map(([r, n]) => `${r} x${n}`).join(', ')}` : ''));
}

// The model gate, where the run carried the channel for it. This is the strongest single check in
// the whole feature: if the DME's own live LLR_QVS matches the value interpolated out of the BASE,
// then the RAM address, the catalog's address and scaling, and the claim that LLR_QVS is pure
// feedforward are all confirmed at once — by one number, from the car.
const withQvs = samples.filter(s => s.llrQvs !== null && s.llrQvs !== undefined
    && s.rpm !== null && s.coolantTemp !== null);
if (withQvs.length === 0) {
    console.log('\n[model gate]  no LLR_QVS in this run — the fallback profile does not carry it');
} else {
    let worst = 0;
    for (const s of withQvs) {
        worst = Math.max(worst, Math.abs(s.llrQvs - qvsAt(tables, s.rpm, s.coolantTemp)));
    }
    console.log(`\n[model gate]  worst |RAM LLR_QVS - KF_LLR_QVS_GRUND(n, tmot)| = ${worst.toFixed(2)} kg/h`
        + ` over ${withQvs.length} samples`);
    console.log(worst <= tables.qvsStepKgH
        ? '              within one quantisation step — the chain is confirmed end to end'
        : '              WIDER THAN ONE STEP. Do not write from this run until it is understood.');
}
console.log();

/**
 * A run off the same bench PRACTICE mode uses, wrapped in the shape EXPORT SESSION writes.
 *
 * Dynamically imported so a real analysis never pays for the simulator, and shaped by the same rule
 * the mock link follows: the slow-lane channels are carried forward between reads, because a mock
 * that filled them in every sample would hide a consumer that forgot they can be absent.
 */
async function practiceBundle() {
    const { MockIdleBench, MOCK_IDLE_CYCLE_SECONDS } = await import('../src/lib/idle/bench.ts');
    const { LOG_PROFILES, sampleMs, IDLE_SLOW_LANE_EVERY } = await import('../src/lib/log-engine/logProfile.ts');
    const binPath = fileURLToPath(new URL('../public/mock/csl-0401-community-patch-v1.partial.bin', import.meta.url));
    const bytes = fs.readFileSync(binPath);
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const t0 = readIdleTables(buffer);
    if (!t0) throw new Error('the mock BIN did not decode');

    const bench = new MockIdleBench({ qvsAt: (rpm, tmot) => qvsAt(t0, rpm, tmot) });
    const dt = sampleMs(LOG_PROFILES.IDLE.exchanges) / 1000;
    const idle = [];
    let carried = { llsTv: null, llrQvs: null, engineState: null, kkosSt: null };
    for (let i = 0, t = 0; t < MOCK_IDLE_CYCLE_SECONDS; i++, t += dt) {
        const r = bench.read(t);
        if (i % IDLE_SLOW_LANE_EVERY === 0) {
            carried = { llsTv: r.llsTv, llrQvs: r.llrQvs, engineState: r.engineState, kkosSt: r.kkosSt };
        }
        idle.push({
            time: t, rpm: r.rpm, coolantTemp: r.tmot, wdk1: r.wdk1, rf: null,
            nSoll: r.nSoll, ub: r.ub,
            mdLlri: r.mdLlri, mdLlra: r.mdLlra, mdLlraKo: r.mdLlraKo,
            llsTv: carried.llsTv, llrQvs: carried.llrQvs, llrQsoll: carried.llrQvs,
            engineState: carried.engineState, kkosSt: carried.kkosSt,
            mdLlriSource: 'ram',
        });
    }
    return {
        format: 1,
        session: { id: 'practice', label: 'PRACTICE (simulated engine, feedforward wrong by a known amount)' },
        log: { sessionId: 'practice', data: [], idle },
        binaries: { base: Buffer.from(new Uint8Array(buffer)).toString('base64'), tuned: null },
    };
}
