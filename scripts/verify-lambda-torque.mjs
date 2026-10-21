/**
 * What the VE log carries for the bucking at WDK 20-30 % and low rpm under load (2026-10-21).
 *
 * Two suspicions, each needing channels the log did not have:
 *
 *   - the MIXTURE. `la_f_regler` cannot answer it where it matters: with the loop open the slave
 *     pins it at exactly 1.000 (`FUN_0001d6a2`: `if ((LA_ST_EIN1 & 1) == 0) LA_F_REGLER1 = 0x8000`).
 *     The narrowband voltages still say rich or lean there, and LA_ST_EIN says whether the loop was
 *     closed. BA_F_TI is the tip-in enrichment beside them.
 *   - the TORQUE PATH. A request far above what the air delivers makes the DME open the throttle
 *     hard: the pedal (`pwg1`), the throttle target (`edk_soll`), the request after the limiter
 *     (`MD_IND_WUNSCH`) and the one the throttle is opened for (`MD_IND_WUNSCH_RED_KORR`), and
 *     FR_REGLER, which integrates the shortfall into more throttle.
 *
 * Pinned here, each from the DME's own code as the shipped calibration graph records it (function
 * statements and RAM nodes) and the two shipped images, never from a catalog alone:
 *
 *   1. Block 3: `pwg1` at 23 and `edk_soll` at 31 are the master responder's own PWG1 / EDK_SOLL
 *      writes, signed 0.1 %, the scale the constants they meet carry.
 *   2. Block 19: `fr_regler` at 79 is uint16 x 2^-15 (0x8000 = 1.000), not the int15 x 0.1 it was.
 *   3. The lambda telegram (0xFF80BE, 32 B): addresses, sizes, sign and scale; the K_LAS_M / K_LAS_NP
 *      range and the K_LA_FMIN / K_LA_FMAX clamp re-read out of both images; every LA_ST_EIN write
 *      in the graph keeps the sensor-ready nibble at one bit or none; all or none on the decode.
 *   4. The torque telegram (0xFFD8B0, 26 B): the identity MD_IND_WUNSCH = MD_FW_FILTER +
 *      MD_SAWE_FILTER from the one function that writes them, MD_DP_FAKTOR never 0; all or none.
 *   5. That a VE run reads both on block 19's lane, that the 12-byte slew read they replace is gone,
 *      that production drops both and pays nothing, and what WORKS pays (<= 8 % of the sample).
 *   6. The CSV round trip (plain numbers, blanks blank, the DME's symbols accepted), PRACTICE
 *      refusing both reads, and the live poll dispatching both and copying block 3's two fields.
 *
 *     node --experimental-strip-types --import ./scripts/ts-resolve.mjs scripts/verify-lambda-torque.mjs
 */
import { readFileSync } from 'node:fs';
import {
    Mss54HpRamSignals, Mss54HpRamWindows, isRamReadInRange, RAM_READ_MAX_COUNT,
    LAMBDA_SENSOR_RAM_READ, TORQUE_REQUEST_RAM_READ, LAMBDA_TRIM_RAM_READ, SLEW_STATE_RAM_READ,
    LA_F_RANGE_0401, LAMBDA_SENSOR_CONSTANTS_0401, LAMBDA_SENSOR_RANGE_MV_0401, lambdaSensorRangeMv,
} from '../src/lib/dme-link/ramMap.ts';
import {
    decodeLambdaSensors, decodeTorqueRequest, LAMBDA_SENSOR_ADDRESS, TORQUE_REQUEST_ADDRESS,
} from '../src/lib/dme-link/slowLane.ts';
import {
    STANDARD_MEASUREMENT_BLOCK, OPERATING_MEASUREMENTS_BLOCK,
    decodeStandardMeasurementBlock, decodeOperatingMeasurementsBlock,
} from '../src/lib/dme-link/liveValueBlocks.ts';
import {
    LOG_PROFILES, productionExchanges, sampleMs, exchangeMs, expectedHz, LAMBDA_SLOW_LANE_EVERY,
    LATCHED_BIT_LANE_EVERY, LAMBDA_TRUTH_GATE,
} from '../src/lib/log-engine/logProfile.ts';
import { LOG_FIELD_REGISTRY, DEFAULT_FIELD_VISIBILITY } from '../src/lib/field-registry/registry.ts';
import { APP_CONFIG } from '../src/config/constants.ts';
import { serializeLogFile } from '../src/lib/log-engine/serializer.ts';
import { parseLogFile } from '../src/lib/log-engine/parser.ts';
import { buildCatalog } from '../src/lib/calibration/catalog.ts';
import { decodeParam } from '../src/lib/calibration/decode.ts';

let fails = 0;
const check = (n, c, d) => { console.log('  ' + (c ? 'PASS' : 'FAIL') + '  ' + n + (c ? '' : ' — ' + (d ?? ''))); if (!c) fails++; };
const R = Mss54HpRamSignals;
const LAMBDA_KEYS = ['usv1', 'usv2', 'usn1', 'usn2', 'laStEin1', 'laStEin2', 'baFTi'];
const TORQUE_KEYS = ['mdFw', 'mdFwFilter', 'mdLsDelta', 'mdDpDelta', 'mdIndWunsch', 'mdIndWunschRedKorr'];
const BLOCK3_KEYS = ['pwg1', 'edkSoll'];

/** The shipped calibration graph — function statements and RAM nodes. NOT calibration-decomp.json,
 *  which main's tree does not carry. */
const graph = JSON.parse(readFileSync('public/data/calibration-graph.json', 'utf8'));
const node = (id) => graph.nodes.find(n => n.id === id);
const writes = (fnId, sym) => (node(fnId)?.stmts ?? []).filter(s => s.out === sym);
const allWrites = (sym) => graph.nodes.filter(n => n.t === 'func')
    .flatMap(n => (n.stmts ?? []).filter(s => s.out === sym).map(s => ({ fn: n.id, expr: s.expr, guards: s.guards })));
const ramName = (bank, addr) => node(`r:${bank}:${addr.toString(16)}`)?.name;

const cat = buildCatalog(graph);
const IMAGES = ['public/mock/csl-0401-community-patch-v1.partial.bin', 'scripts/fixtures/session-920-base.bin'];
const param = (path, name) => {
    const bin = readFileSync(path);
    return decodeParam(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength), cat.byName.get(name)).value;
};
const meta = (name) => graph.nodes.find(n => n.t === 'param' && n.name === name);

/** Write `raw` (two's complement for negatives) where `sig` sits, buffer starting at `base`. */
const put = (buf, base, sig, raw) => {
    const at = sig.address - base;
    const v = raw & (sig.size === 1 ? 0xFF : 0xFFFF);
    if (sig.size === 1) buf[at] = v;
    else { buf[at] = v >> 8; buf[at + 1] = v & 0xFF; }
};

console.log('\n[block 3: the pedal and the throttle target are the master\'s own writes]');
{
    // ds2_handler case 0x1c (12050B03) writes through puVar5 = rsp_ptr, and payload offset = index - 3
    // — the mapping wdk1 at 27 (WDK1 at puVar5[0x1e]) and rf at 8 (puVar5[0xb]) already prove.
    const responder = node('f:master:030b84')?.stmts ?? [];
    const at = (expr) => responder.filter(s => s.expr === expr).map(s => /^puVar5\[0x([0-9a-f]+)\]$/.exec(s.out)?.[1])
        .filter(Boolean).map(h => parseInt(h, 16) - 3);
    check('WDK1 high byte at payload 27 — the known field the mapping is checked on',
        at('WDK1 >> 8').includes(27) && STANDARD_MEASUREMENT_BLOCK.fields.wdk1.offset === 27, JSON.stringify(at('WDK1 >> 8')));
    check('PWG1 high/low bytes at payload 23/24', at('PWG1 >> 8').includes(23) && at('PWG1').includes(24),
        JSON.stringify([at('PWG1 >> 8'), at('PWG1')]));
    check('EDK_SOLL high/low bytes at payload 31/32', at('EDK_SOLL >> 8').includes(31) && at('EDK_SOLL').includes(32),
        JSON.stringify([at('EDK_SOLL >> 8'), at('EDK_SOLL')]));
    check('PWG1 and EDK_SOLL are master RAM (0xFFE6D6 / 0xFFE666) — no slave-fill question',
        ramName('master', 0xFFE6D6) === 'PWG1' && ramName('master', 0xFFE666) === 'EDK_SOLL');
    const f = STANDARD_MEASUREMENT_BLOCK.fields;
    check('pwg1: offset 23, int15, 0.1 %', f.pwg1.symbol === 'pwg1' && f.pwg1.offset === 23 && f.pwg1.format === 'int15'
        && f.pwg1.scale === 0.1 && f.pwg1.add === 0, JSON.stringify(f.pwg1));
    check('edkSoll: offset 31, int15, 0.1 %', f.edkSoll.symbol === 'edk_soll' && f.edkSoll.offset === 31
        && f.edkSoll.format === 'int15' && f.edkSoll.scale === 0.1 && f.edkSoll.add === 0, JSON.stringify(f.edkSoll));
    // The scale from what the words meet. pwg_calc: PWG1 is a shifted signed product, the selected
    // sensor is compared with K_PWG_KD and indexes KL_PWG_SOLL_*, both "%" x/10. EGAS_SOLL_BERECH:
    // EDK_SOLL takes EGAS_SOLL, which is WDK_SOLL (KF_EGAS_WDK, x/10) or K_PDR_SOLL_EDK (x/10, signed).
    check('pwg_calc writes PWG1 = (K_PWG1_NORM * (PWG1_ABS - PWG1_A0) + ..) >> 11',
        writes('f:master:022f98', 'PWG1').some(s => s.expr.includes('K_PWG1_NORM * (PWG1_ABS - PWG1_A0)') && s.expr.endsWith('>> 0xb')));
    check('K_PWG_KD and KL_PWG_SOLL_KOMFORT\'s axis are "%" x/10',
        meta('K_PWG_KD')?.math === 'x/10' && meta('KL_PWG_SOLL_KOMFORT')?.axes?.x?.math === 'x/10');
    check('EGAS_SOLL_BERECH: EGAS_SOLL = WDK_SOLL (normal), EDK_SOLL = EGAS_SOLL',
        writes('f:master:022934', 'EGAS_SOLL').some(s => s.expr === 'WDK_SOLL')
        && writes('f:master:022934', 'EDK_SOLL').some(s => s.expr === 'EGAS_SOLL'));
    check('KF_EGAS_WDK\'s cells and K_PDR_SOLL_EDK are x/10 %, the latter signed',
        meta('KF_EGAS_WDK')?.axes?.z?.math === 'x/10' && meta('K_PDR_SOLL_EDK')?.math === 'x/10' && meta('K_PDR_SOLL_EDK')?.signed === true);
    // PWG is PWG1 through a PT1 of K_PWG_TAU_NORM_UP on the way up: 0.02 s, so the same number at
    // this link's rate. Re-read, because the claim that pwg1 stands in for PWG rests on it.
    for (const path of IMAGES) {
        const tau = param(path, 'K_PWG_TAU_NORM_UP');
        check(`${path}: K_PWG_TAU_NORM_UP = 0.02 s`, Math.abs((tau?.phys?.[0] ?? 0) - 0.02) < 1e-9, JSON.stringify(tau));
    }
    // A decode: pedal 23.4 %, target 31.7 %, and a negative pedal sensor (below its learned zero).
    const payload = new Uint8Array(35);
    const w16 = (off, raw) => { payload[off] = (raw >> 8) & 0xFF; payload[off + 1] = raw & 0xFF; };
    w16(0, 2400); w16(23, 234); w16(27, 250); w16(31, 317);
    const d = decodeStandardMeasurementBlock(payload);
    check('decodes pedal 23.4, target 31.7 beside wdk1 25.0',
        Math.abs(d.pwg1 - 23.4) < 1e-9 && Math.abs(d.edkSoll - 31.7) < 1e-9 && Math.abs(d.wdk1 - 25) < 1e-9, JSON.stringify(d));
    w16(23, -5 & 0xFFFF);
    check('signed: a sensor 0.5 % below zero reads -0.5, not 6553.1', Math.abs(decodeStandardMeasurementBlock(payload).pwg1 + 0.5) < 1e-9);
    check('a short block leaves them null, not 0', decodeStandardMeasurementBlock(payload.subarray(0, 30)).edkSoll === null);
}

console.log('\n[block 19: fr_regler is uint16 x 2^-15]');
{
    const f = OPERATING_MEASUREMENTS_BLOCK.fields.frRegler;
    check('offset 79, uint16, 3.0517578125e-05', f.offset === 79 && f.format === 'uint16' && f.scale === 3.0517578125e-05,
        JSON.stringify(f));
    check('fr_calc stores FR_REGLER = FR_REG_I - 0x8000', writes('f:master:0253de', 'FR_REGLER').some(s => s.expr === 'FR_REG_I + -0x8000'));
    check('egas_compute_throttle_target: rf_rel_korr = FR_REGLER * MD_RF_SOLL, MD_RF_KORR = rf_rel_korr >> 15',
        writes('f:master:0270b0', 'rf_rel_korr').some(s => s.expr === 'FR_REGLER * MD_RF_SOLL')
        && writes('f:master:0270b0', 'MD_RF_KORR').some(s => s.expr === 'rf_rel_korr >> 0xf'));
    check('the same scale as the RAM word the LLS run reads', R.FR_REGLER.scale === f.scale && R.FR_REGLER.address === 0xFFE9F6);
    const payload = new Uint8Array(90);
    payload[79] = 0x80; payload[80] = 0x00;
    check('0x8000 reads 1.000 (it read -3276.8)', decodeOperatingMeasurementsBlock(payload).frRegler === 1);
    payload[79] = 0x8C; payload[80] = 0xCD;
    check('0x8CCD reads 1.100 — the regulator asking for 10 % more air',
        Math.abs(decodeOperatingMeasurementsBlock(payload).frRegler - 1.1) < 1e-4);
}

console.log('\n[the lambda telegram is where the slave writes it]');
{
    const want = [
        ['USV1', 0xFF80BE, 2, true, 0.001], ['USV2', 0xFF80C0, 2, true, 0.001],
        ['USN1', 0xFF80C2, 2, true, 0.001], ['USN2', 0xFF80C4, 2, true, 0.001],
        ['LA_ST_EIN1', 0xFF80C6, 1, false, 1], ['LA_ST_EIN2', 0xFF80C7, 1, false, 1],
        ['BA_F_TI', 0xFF80DC, 2, false, 1 / 1024],
    ];
    for (const [name, addr, size, signed, scale] of want) {
        const s = R[name];
        check(`${name}: segment 0x01, 0x${addr.toString(16)}, ${size} B, ${signed ? 'signed' : 'unsigned'}, x${scale}`,
            s.segment === 0x01 && s.address === addr && s.size === size && s.signed === signed && s.scale === scale
            && ramName('master', addr) === name && ramName('slave', addr) === name, JSON.stringify(s));
    }
    const r = LAMBDA_SENSOR_RAM_READ;
    check('the read: segment 0x01, 0xff80be, 32 bytes, USV1 through BA_F_TI',
        r.segment === 0x01 && r.address === 0xFF80BE && r.count === 32, JSON.stringify(r));
    check('...inside the window this DME serves, under its 128-byte clamp',
        isRamReadInRange(r.segment, r.address, r.count) && r.segment === Mss54HpRamWindows.low.segment && r.count <= RAM_READ_MAX_COUNT);
    check('...and it covers the per-sample trim read\'s eight bytes, which are its proof',
        LAMBDA_TRIM_RAM_READ.address >= r.address && LAMBDA_TRIM_RAM_READ.address + LAMBDA_TRIM_RAM_READ.count <= r.address + r.count);
    check('the link dispatches on that address', LAMBDA_SENSOR_ADDRESS === 0xFF80BE);
    // The writers, as the graph records them.
    const usv = writes('f:slave:01e530', 'USV1')[0]?.expr ?? '';
    check('FUN_0001e530: USV1 = IIR_Filter_SS(((K_LAS_M * adc) >> 10) - K_LAS_NP, USV1, ..)',
        usv.startsWith('IIR_Filter_SS((((K_LAS_M * ') && usv.includes('>> 10) - K_LAS_NP),USV1,'), usv);
    check('FUN_0001e5b8: USN1 the same way', (writes('f:slave:01e5b8', 'USN1')[0]?.expr ?? '').includes('>> 10) - K_LAS_NP),USN1,'));
    check('K_LAS_M is "mV/digit" x/1024 and K_LAS_NP "mV" x — so the words are millivolts',
        meta('K_LAS_M')?.math === 'x/1024' && meta('K_LAS_NP')?.math === 'x' && /mV/.test(meta('K_LAS_NP')?.units ?? ''));
    check('both inits put 475 mV in USV1 (0x1DB) and 1.000 in BA_F_TI (0x400)',
        writes('f:master:0110f2', 'USV1').some(s => s.expr === '0x1db') && writes('f:slave:02a2b6', 'USV1').some(s => s.expr === '0x1db')
        && writes('f:master:0110f2', 'BA_F_TI').some(s => s.expr === '0x400'));
    check('the loop open pins the trim: LA_F_REGLER1 = 0x8000 when (LA_ST_EIN1 & 1) == 0',
        writes('f:slave:01d6a2', 'LA_F_REGLER1').some(s => s.expr === '0x8000' && s.guards.includes('(LA_ST_EIN1 & 1) == 0')));
    check('bit 0 is set exactly when (LA_ST_AUS & 0xfd) == 0 and bit 1',
        writes('f:slave:01ebea', 'LA_ST_EIN1').some(s => s.expr === 'LA_ST_EIN1 | 1'
            && s.guards.includes('((LA_ST_AUS & 0xfd) == 0) && ((LA_ST_EIN1 & 2) != 0)')));
    check('BA_F_TI beyond K_LA_BA_OFF_NEG..POS opens the loop; both x/1024',
        meta('K_LA_BA_OFF_POS')?.math === 'x/1024' && meta('K_LA_BA_OFF_NEG')?.math === 'x/1024');
    // Every write to LA_ST_EIN1/2 in the graph that touches bits 4-7, against the state machine's
    // case structure in ramMap.ts. A writer this list does not know fails here, so the "one bit or
    // none" check in the decoder is re-argued rather than inherited.
    const NIBBLE_WRITES = new Set(['0', '0x10', 'X & 0xef | 0x20', 'X & 0xdf', 'X | 0x40', 'X & 0xbf | 0x80',
        'X & 0x7f', 'X & 0x7f | 0x10', 'X & 0x1f | 0x10']);
    for (const sym of ['LA_ST_EIN1', 'LA_ST_EIN2']) {
        const all = allWrites(sym).map(w => w.expr.replaceAll(sym, 'X'));
        const lowOnly = (e) => /^X (\| [1248]|& 0xf[3dfe]|& 0xfe)$/.test(e);
        const unknown = all.filter(e => !lowOnly(e) && !NIBBLE_WRITES.has(e));
        check(`${sym}: every top-nibble write is one the state machine argument covers (${all.length} writes)`,
            unknown.length === 0 && all.length === 17, unknown.join(' ; '));
    }
}

console.log('\n[the constants the lambda decode stands on, out of both images]');
{
    for (const path of IMAGES) {
        const m = param(path, 'K_LAS_M')?.raw?.[0], np = param(path, 'K_LAS_NP')?.raw?.[0];
        check(`${path}: K_LAS_M ${m}, K_LAS_NP ${np}`, m === LAMBDA_SENSOR_CONSTANTS_0401.lasMRaw && np === LAMBDA_SENSOR_CONSTANTS_0401.lasNpMv);
        // The trim words' range: K_LA_FMIN below; K_LA_FMAX above, or K_LAS_FMAX while the pre-cat
        // sensor test runs; LAA_F's own K_LAA_FMIN..K_LAA_FMAX inside both.
        const raw = (n) => param(path, n)?.raw?.[0];
        const [lo, hi, testHi, laaLo, laaHi] = ['K_LA_FMIN', 'K_LA_FMAX', 'K_LAS_FMAX', 'K_LAA_FMIN', 'K_LAA_FMAX'].map(raw);
        check(`${path}: K_LA_FMIN ${lo}, K_LAS_FMAX ${testHi} — the trim-word band`,
            lo === LA_F_RANGE_0401.min && testHi === LA_F_RANGE_0401.max);
        check(`${path}: K_LA_FMAX ${hi} and LAA_F's ${laaLo}..${laaHi} sit inside it`,
            hi <= testHi && laaLo >= lo && laaHi <= testHi && hi === 42598);
        const fett = param(path, 'K_LAS_R_FETT')?.raw?.[0], mager = param(path, 'K_LAS_R_MAGER')?.raw?.[0];
        check(`${path}: rich above ${fett} mV, lean below ${mager} mV — what the registry says`, fett === 510 && mager === 400);
        const dp = param(path, 'KF_MD_DASHPOT_FAKTOR')?.raw ?? [];
        check(`${path}: KF_MD_DASHPOT_FAKTOR has no zero cell (so MD_DP_FAKTOR is never 0)`, dp.length === 12 && Math.min(...dp) > 0,
            JSON.stringify(dp));
    }
    check('0 .. 1113 mV: (1115 * 1023) >> 10', LAMBDA_SENSOR_RANGE_MV_0401.min === 0 && LAMBDA_SENSOR_RANGE_MV_0401.max === 1113);
    check('...and a non-zero K_LAS_NP moves the floor below zero', lambdaSensorRangeMv(1115, 50).min === -50);
    // The truth gate's 0.7..1.3 is K_LA_FMIN..K_LA_FMAX in floats; this decode is wider by exactly
    // the sensor test's K_LAS_FMAX, so it never drops a telegram the gate would have believed.
    check('the decode\'s band contains the truth gate\'s',
        Math.abs(LAMBDA_TRUTH_GATE.plausible.min - LA_F_RANGE_0401.min / 32768) < 1e-4
        && LAMBDA_TRUTH_GATE.plausible.max <= LA_F_RANGE_0401.max / 32768);
    // Every writer of the four trim words in the graph is one of these: an init or reset to 0x8000,
    // a clamp constant, the controller's own sum, or LAA_F copied across banks.
    for (const sym of ['LA_F_REGLER1', 'LA_F_REGLER2', 'LAA_F1', 'LAA_F2']) {
        const odd = allWrites(sym).map(w => w.expr).filter(e => !(e === '0x8000' || /^K_LAA?S?_F(MIN|MAX)$/.test(e)
            || /^LAA_F[12]$/.test(e) || / \+ LA_F_KI[12] \+ 0x8000$/.test(e) || /^LAA_F[12] \+ \(LA_F_REGLER[12] \+ -0x8000\)/.test(e)));
        check(`${sym}: every writer is an init, a clamp or the controller's own step`, odd.length === 0, odd.join(' ; '));
    }
}

const lambdaTelegram = ({ mv = [475, 460, 600, 610], st = [0x8F, 0x8F], ba = 0x400, trims = [0x8000, 0x8000, 0x8000, 0x8000] } = {}) => {
    const base = LAMBDA_SENSOR_RAM_READ.address;
    const b = new Uint8Array(LAMBDA_SENSOR_RAM_READ.count);
    [R.USV1, R.USV2, R.USN1, R.USN2].forEach((s, i) => put(b, base, s, mv[i]));
    put(b, base, R.LA_ST_EIN1, st[0]); put(b, base, R.LA_ST_EIN2, st[1]);
    [R.LA_F_REGLER1, R.LA_F_REGLER2, R.LAA_F1, R.LAA_F2].forEach((s, i) => put(b, base, s, trims[i]));
    put(b, base, R.BA_F_TI, ba);
    return b;
};

console.log('\n[the lambda decode: volts, the loop, all or none]');
{
    const base = LAMBDA_SENSOR_RAM_READ.address;
    const d = decodeLambdaSensors(lambdaTelegram(), base);
    check('all seven decode', LAMBDA_KEYS.every(k => d[k] !== undefined), JSON.stringify(d));
    check('475 mV is 0.475 V, exactly', d.usv1 === 0.475 && d.usv2 === 0.46 && d.usn1 === 0.6 && d.usn2 === 0.61, JSON.stringify(d));
    check('0x8F: bank closed (bit 0) and readable off the decoded byte', d.laStEin1 === 0x8F && (d.laStEin1 & 1) === 1);
    check('BA_F_TI 0x400 is 1.000', d.baFTi === 1);
    const open = decodeLambdaSensors(lambdaTelegram({ mv: [850, 120, 700, 90], st: [0x4E, 0x8F], ba: 1100 }), base);
    check('an open bank 1 running rich at 0.85 V decodes — the reading the trim cannot give',
        open.usv1 === 0.85 && (open.laStEin1 & 1) === 0 && open.usv2 === 0.12, JSON.stringify(open));
    check('a tip-in enrichment of 1100/1024 reads 1.0742', Math.abs(open.baFTi - 1100 / 1024) < 1e-12);
    const none = (o) => Object.keys(decodeLambdaSensors(lambdaTelegram(o), base)).length === 0;
    check('a trim word below K_LA_FMIN drops everything', none({ trims: [LA_F_RANGE_0401.min - 1, 0x8000, 0x8000, 0x8000] }));
    check('...and one above K_LAS_FMAX', none({ trims: [0x8000, 0x8000, 0x8000, LA_F_RANGE_0401.max + 1] }));
    check('the limits themselves still decode, and 1.35 during the sensor test does',
        !none({ trims: [LA_F_RANGE_0401.min, LA_F_RANGE_0401.max, 0x8000, 0x8000] }) && !none({ trims: [44237, 0x8000, 0x8000, 0x8000] }));
    check('a voltage word of -1 mV drops everything (K_LAS_NP is 0 here)', none({ mv: [-1, 460, 600, 610] }));
    check('...and 1114 mV, past what a 10-bit count can produce', none({ mv: [475, 460, 600, 1114] }));
    check('1113 mV, the top of the range, still decodes', !none({ mv: [1113, 0, 600, 610] }));
    check('LA_ST_EIN with two sensor-state bits (0x30) drops everything', none({ st: [0x30, 0x8F] }));
    check('...the five legal nibbles all decode', [0x0F, 0x1F, 0x2C, 0x4E, 0x8F].every(s => !none({ st: [s, s] })));
    check('the zero buffer PRACTICE would serve decodes to nothing',
        Object.keys(decodeLambdaSensors(new Uint8Array(32), base)).length === 0);
    check('a short read that loses BA_F_TI drops everything',
        Object.keys(decodeLambdaSensors(lambdaTelegram().subarray(0, 31), base)).length === 0);
    check('two bytes off: nothing', Object.keys(decodeLambdaSensors(lambdaTelegram(), base + 2)).length === 0);
    check('another calibration\'s sensor range is a parameter, not a fork',
        decodeLambdaSensors(lambdaTelegram({ mv: [-40, 460, 600, 610] }), base, lambdaSensorRangeMv(1115, 50)).usv1 === -0.04);
}

console.log('\n[the torque telegram is where MD_Torque_Interventions writes it]');
{
    const want = [
        ['MD_FW', 0xFFD8B0], ['MD_FW_FILTER', 0xFFD8B2], ['MD_SAWE_FILTER', 0xFFD8B4], ['MD_LS_DELTA', 0xFFD8B8],
        ['MD_DP_DELTA', 0xFFD8BA], ['MD_DP_FAKTOR', 0xFFD8BC], ['MD_IND_WUNSCH', 0xFFD8BE], ['MD_IND_WUNSCH_RED_KORR', 0xFFD8C8],
    ];
    for (const [name, addr] of want) {
        const s = R[name];
        check(`${name}: segment 0x04, 0x${addr.toString(16)}, unsigned word`,
            s.segment === 0x04 && s.address === addr && s.size === 2 && s.signed === false && ramName('master', addr) === name,
            JSON.stringify(s));
    }
    check('the torques are 0.1 Nm', ['MD_FW', 'MD_FW_FILTER', 'MD_LS_DELTA', 'MD_DP_DELTA', 'MD_IND_WUNSCH', 'MD_IND_WUNSCH_RED_KORR']
        .every(n => R[n].scale === 0.1));
    check('KF_MD_MAX_MD_IND_OPT (MD_IND_MAX) and K_MD_SK_MAX are x/10 Nm — the clamps on the request',
        meta('KF_MD_MAX_MD_IND_OPT')?.axes?.z?.math === 'x/10' && meta('K_MD_SK_MAX')?.math === 'x/10');
    const r = TORQUE_REQUEST_RAM_READ;
    check('the read: segment 0x04, 0xffd8b0, 26 bytes, MD_FW through MD_IND_WUNSCH_RED_KORR',
        r.segment === 0x04 && r.address === 0xFFD8B0 && r.count === 26, JSON.stringify(r));
    check('...inside the window, under the clamp', isRamReadInRange(r.segment, r.address, r.count)
        && r.segment === Mss54HpRamWindows.high.segment);
    check('the link dispatches on that address — the old slew read\'s own', TORQUE_REQUEST_ADDRESS === 0xFFD8B0);
    // One writer each for the identity's three words once the engine runs, all in one function.
    const w = (sym) => allWrites(sym).map(x => `${x.fn} ${x.expr}`).sort();
    check('MD_IND_WUNSCH: written once, as _DAT_00ff816a + MD_SAWE_FILTER',
        JSON.stringify(w('MD_IND_WUNSCH')) === JSON.stringify(['f:master:0166f6 _DAT_00ff816a + MD_SAWE_FILTER']), w('MD_IND_WUNSCH').join(' ; '));
    check('MD_FW_FILTER: the same local, and 0 at init',
        JSON.stringify(w('MD_FW_FILTER')) === JSON.stringify(['f:master:01602c 0', 'f:master:0166f6 _DAT_00ff816a']), w('MD_FW_FILTER').join(' ; '));
    check('MD_SAWE_FILTER: init and the main function only', w('MD_SAWE_FILTER').length === 2
        && w('MD_SAWE_FILTER').every(x => x.startsWith('f:master:01602c') || x.startsWith('f:master:0166f6')));
    check('MD_DP_FAKTOR: 0x400 at init, else KF_MD_DASHPOT_FAKTOR', JSON.stringify(w('MD_DP_FAKTOR')) === JSON.stringify(
        ['f:master:01602c 0x400', 'f:master:017052 kfu_wint(KF_MD_DASHPOT_FAKTOR,N,param_1)']), w('MD_DP_FAKTOR').join(' ; '));
    check('MD_IND_WUNSCH_RED_KORR: written once, in the same function',
        w('MD_IND_WUNSCH_RED_KORR').length === 1 && w('MD_IND_WUNSCH_RED_KORR')[0].startsWith('f:master:0166f6'));
}

const torqueTelegram = ({ fw = 1234, filter = 1180, sawe = 95, ls = 40, dp = 0, dpFaktor = 0x400, wunsch, redKorr = 1301 } = {}) => {
    const base = TORQUE_REQUEST_RAM_READ.address;
    const b = new Uint8Array(TORQUE_REQUEST_RAM_READ.count);
    put(b, base, R.MD_FW, fw); put(b, base, R.MD_FW_FILTER, filter); put(b, base, R.MD_SAWE_FILTER, sawe);
    put(b, base, R.MD_LS_DELTA, ls); put(b, base, R.MD_DP_DELTA, dp); put(b, base, R.MD_DP_FAKTOR, dpFaktor);
    put(b, base, R.MD_IND_WUNSCH, wunsch ?? ((filter + sawe) & 0xFFFF)); put(b, base, R.MD_IND_WUNSCH_RED_KORR, redKorr);
    return b;
};

console.log('\n[the torque decode: the DME\'s own sum, all or none]');
{
    const base = TORQUE_REQUEST_RAM_READ.address;
    const d = decodeTorqueRequest(torqueTelegram(), base);
    check('all six decode', TORQUE_KEYS.every(k => d[k] !== undefined), JSON.stringify(d));
    check('tenths divided out: 123.4 / 118.0 / 127.5 / 130.1 Nm exactly',
        d.mdFw === 123.4 && d.mdFwFilter === 118 && d.mdIndWunsch === 127.5 && d.mdIndWunschRedKorr === 130.1, JSON.stringify(d));
    check('the slew words still come out of it: what the limiter took is mdFwFilter - mdFw',
        d.mdLsDelta === 4 && d.mdDpDelta === 0 && Math.abs(d.mdFw - d.mdFwFilter - 5.4) < 1e-9);
    const none = (o) => Object.keys(decodeTorqueRequest(torqueTelegram(o), base)).length === 0;
    check('MD_IND_WUNSCH one count off the sum drops everything (a torn or misplaced read)', none({ wunsch: 1180 + 95 + 1 }));
    check('MD_DP_FAKTOR 0 drops everything — nothing on a running DME writes it', none({ dpFaktor: 0 }));
    check('the zero buffer decodes to nothing although 0 == 0 + 0',
        Object.keys(decodeTorqueRequest(new Uint8Array(26), base)).length === 0);
    check('a short read that loses MD_IND_WUNSCH_RED_KORR drops everything',
        Object.keys(decodeTorqueRequest(torqueTelegram().subarray(0, 25), base)).length === 0);
    check('two bytes off: nothing', Object.keys(decodeTorqueRequest(torqueTelegram(), base + 2)).length === 0);
    check('the sum is 16-bit, as add.w stores it', !none({ filter: 0xFFF0, sawe: 0x20 }));
}

console.log('\n[a VE run records them, on block 19\'s lane]');
{
    const ve = LOG_PROFILES.VE.exchanges;
    const at = (pred) => ve.findIndex(pred);
    const iB3 = at(x => x.kind === 'block' && x.selection === 3);
    const iTrim = at(x => x.kind === 'ram' && x.address === LAMBDA_TRIM_RAM_READ.address);
    const iB19 = at(x => x.kind === 'block' && x.selection === 19);
    const iLam = at(x => x.kind === 'ram' && x.address === LAMBDA_SENSOR_RAM_READ.address);
    const iTq = at(x => x.kind === 'ram' && x.address === TORQUE_REQUEST_RAM_READ.address);
    const lam = ve[iLam], tq = ve[iTq];
    check('the fast list reads both', iLam >= 0 && iTq >= 0);
    check('the lambda read provides exactly its seven',
        JSON.stringify([...(lam?.provides ?? [])].sort()) === JSON.stringify([...LAMBDA_KEYS].sort()), lam?.provides?.join());
    check('the torque read provides exactly its six',
        JSON.stringify([...(tq?.provides ?? [])].sort()) === JSON.stringify([...TORQUE_KEYS].sort()), tq?.provides?.join());
    check('both every 8 samples — block 19\'s lane, so FR_REGLER and the angles share their rows',
        lam?.every === LAMBDA_SLOW_LANE_EVERY && tq?.every === LAMBDA_SLOW_LANE_EVERY && ve[iB19].every === LAMBDA_SLOW_LANE_EVERY);
    check('neither between the RAM trim and block 19 (the truth re-check\'s gap)',
        !(iTrim < iLam && iLam < iB19) && !(iTrim < iTq && iTq < iB19), `${iTrim} ${iB19} ${iLam} ${iTq}`);
    check('the 12-byte MD_FW/MD_FW_FILTER read at 1/64 is gone — the torque read replaced it',
        ve.filter(x => x.kind === 'ram' && x.address === TORQUE_REQUEST_RAM_READ.address).length === 1 && tq.count === 26);
    const dyn = ve.find(x => x.kind === 'ram' && x.address === SLEW_STATE_RAM_READ.address);
    check('every MD_DYN_ST read (1/64) lands on a torque-read sample', dyn?.every === LATCHED_BIT_LANE_EVERY
        && LATCHED_BIT_LANE_EVERY % LAMBDA_SLOW_LANE_EVERY === 0);
    check('block 3 provides pwg1 and edkSoll on every sample', BLOCK3_KEYS.every(k => ve[iB3].provides?.includes(k))
        && !ve[iB3].every);
    check('block 19 provides frRegler', ve[iB19].provides?.includes('frRegler'));
    const fb = LOG_PROFILES.VE.fallback;
    check('the fallback carries the free ones too, and still no RAM',
        BLOCK3_KEYS.every(k => fb[0].provides?.includes(k)) && fb[1].provides?.includes('frRegler') && !fb.some(x => x.kind === 'ram'));
    for (const k of [...LAMBDA_KEYS, ...TORQUE_KEYS.slice(4), ...BLOCK3_KEYS]) {
        const m = LOG_FIELD_REGISTRY[k];
        check(`${k}: '${m?.symbol}', debug, off by default`, m?.relevance === 'debug' && DEFAULT_FIELD_VISIBILITY[k] === false);
    }
    check('pwg1 / edkSoll name their block-3 offsets', LOG_FIELD_REGISTRY.pwg1.source?.offset === 23
        && LOG_FIELD_REGISTRY.edkSoll.source?.offset === 31 && LOG_FIELD_REGISTRY.pwg1.source?.selection === 3);
    check('frRegler is tuning (the LLS derivation reads it), so production keeps it',
        LOG_FIELD_REGISTRY.frRegler.relevance === 'tuning');
}

console.log('\n[production drops both and pays nothing; what WORKS pays]');
{
    const ve = LOG_PROFILES.VE.exchanges;
    const ours = (x) => x.kind === 'ram' && (x.address === LAMBDA_SENSOR_RAM_READ.address || x.address === TORQUE_REQUEST_RAM_READ.address);
    const prod = productionExchanges(ve);
    check('production drops the lambda and torque reads', !prod.some(ours), prod.map(x => x.name ?? x.selection).join());
    // Before this change: the same list without the two reads, and with the 12-byte slew read the
    // torque read replaced, at the slowest lane.
    const slew12 = { kind: 'ram', name: 'MD_FW/MD_FW_FILTER', segment: 0x04, address: 0xFFD8B0, count: 12,
        every: LATCHED_BIT_LANE_EVERY, provides: ['mdFw', 'mdFwFilter', 'mdLsDelta', 'mdDpDelta'] };
    const before = [...ve.filter(x => !ours(x)), slew12];
    check('the production rate is what it was before them',
        Math.abs(sampleMs(prod) - sampleMs(productionExchanges(before))) < 1e-9);
    const added = sampleMs(ve) - sampleMs(before);
    console.log(`        VE sample ${sampleMs(before).toFixed(1)} ms -> ${sampleMs(ve).toFixed(1)} ms (+${added.toFixed(1)} ms, `
        + `${(100 * added / sampleMs(before)).toFixed(1)} %); ${expectedHz(before).toFixed(3)} -> ${expectedHz(ve).toFixed(3)} Hz; `
        + `production ${expectedHz(prod).toFixed(3)} Hz`);
    // The budget was ~8 % of the WORKS sample, and this is 7.6 %. Pinned at 8 % so the next read on
    // this lane has to be priced, not slipped in.
    check('together they cost at most 8 % of the VE sample', added / sampleMs(before) <= 0.08,
        `${(100 * added / sampleMs(before)).toFixed(1)} %`);
    // Why the lambda words are their own exchange: stretching the per-sample trim read over them
    // (0xFF80BE..0xFF80DF) costs more on every sample than this read costs at one in eight.
    const widened = { ...ve.find(x => x.kind === 'ram' && x.address === LAMBDA_TRIM_RAM_READ.address), count: 34 };
    const widenCost = exchangeMs(widened) - exchangeMs({ ...widened, count: LAMBDA_TRIM_RAM_READ.count });
    const lamCost = exchangeMs(ve.find(x => x.kind === 'ram' && x.address === LAMBDA_SENSOR_RAM_READ.address)) / LAMBDA_SLOW_LANE_EVERY;
    check(`widening the trim read would cost ${widenCost.toFixed(1)} ms a sample, on production too; the 1/8 read costs ${lamCost.toFixed(1)}`,
        widenCost > 2.5 * lamCost);
}

console.log('\n[the CSV round trip keeps the gaps, in plain numbers]');
{
    const points = [0, 1, 2, 3].map(i => ({
        time: i * 0.25, rpm: 1800, rawLoad: 9.5, stft1: 1.0, stft2: 1.0, rf: 62.0,
        pwg1: 23.4 + i, edkSoll: 31.7 + i,
        ...(i % 2 === 0 ? { mdFw: 123.4, mdFwFilter: 118, mdLsDelta: 4, mdDpDelta: 0, mdIndWunsch: 127.5, mdIndWunschRedKorr: 130.1,
            frRegler: 1.0998 } : {}),
        ...(i === 0 ? { usv1: 0.85, usv2: 0.12, usn1: 0.7, usn2: 0.09, laStEin1: 0x4E, laStEin2: 0x8F, baFTi: 1100 / 1024 } : {}),
    }));
    const keys = [...BLOCK3_KEYS, ...TORQUE_KEYS, ...LAMBDA_KEYS, 'frRegler'];
    const csv = serializeLogFile(points);
    const back = parseLogFile(csv);
    check('four rows back', back.length === 4, back.length);
    check('every value survives, every blank stays undefined',
        back.every((p, i) => keys.every(k => p[k] === points[i][k])),
        JSON.stringify(back.map(p => keys.map(k => p[k] ?? '-').join(' '))));
    check('LA_ST_EIN goes out as a plain number and comes back', back[0].laStEin1 === 0x4E && /;78;/.test(csv.split('\n')[1] ?? ''),
        csv.split('\n')[1]);
    const head = csv.split('\n')[0];
    const M = APP_CONFIG.CSV_MAPPING;
    check('the headers are the app\'s own', [M.PEDAL, M.THROTTLE_TARGET, M.USV1, M.LA_ST_EIN1, M.MD_IND_WUNSCH_RED_KORR, M.FR_REGLER]
        .every(h => head.includes(h)), head);
    const bare = serializeLogFile(points.map(({ time, rpm, rawLoad, stft1, stft2, rf }) => ({ time, rpm, rawLoad, stft1, stft2, rf })));
    check('a run that never read them writes none of their columns',
        !/Pedal|Throttle Target|Lambda Sensor|Lambda Control|Tip-in|Torque Request|Filling/.test(bare.split('\n')[0]), bare.split('\n')[0]);
    // The DME's symbols, and Testo's two block-3 headers, read back into the same channels.
    const foreign = parseLogFile('time;rpm;relativer oeffnungsquerschnitt;lambdaintegrator 1;relative fuellung;'
        + 'tps 1;throttle pos. expected;usv1;la_st_ein1;ba_f_ti;md_ind_wunsch_red_korr;fr_regler\n'
        + '0;1800;9.5;1.0;62;23.4;31.7;0.85;78;1.074;130.1;1.1\n');
    const f = foreign[0] ?? {};
    check('tps 1 / throttle pos. expected / usv1 / la_st_ein1 / ba_f_ti / md_ind_wunsch_red_korr / fr_regler headers are accepted',
        f.pwg1 === 23.4 && f.edkSoll === 31.7 && f.usv1 === 0.85 && f.laStEin1 === 78 && f.baFTi === 1.074
        && f.mdIndWunschRedKorr === 130.1 && f.frRegler === 1.1, JSON.stringify(f));
}

console.log('\n[PRACTICE refuses both reads; the live poll decodes both]');
{
    // Read from the source rather than run, for verify:air-knock's reason (DmeLinkError's parameter
    // property does not load under Node's type stripping).
    const src = readFileSync('src/lib/dme-link/mockDmeLink.ts', 'utf8');
    const built = src.indexOf('const out = new Uint8Array(count);');
    for (const name of ['TORQUE_REQUEST_RAM_READ', 'LAMBDA_SENSOR_RAM_READ']) {
        const guard = src.indexOf(`if (address === ${name}.address) {`);
        const body = guard >= 0 ? src.slice(src.indexOf('{', guard) + 1) : '';
        check(`${name} is refused before the zero buffer is built`,
            guard >= 0 && guard < built && /^\s*throw new DmeLinkError\('PRACTICE/.test(body), `guard at ${guard}, buffer at ${built}`);
    }
    // No key of either name anywhere in the mock: a pedal or a target it cannot model would be the
    // answer to the question the columns are logged to ask.
    check('PRACTICE serves no pedal or throttle target', !/\b(pwg1|edkSoll)\s*:/.test(src));
    const link = readFileSync('src/lib/dme-link/webSerialDmeLink.ts', 'utf8');
    const trimGuard = link.indexOf('exchange.segment !== LAMBDA_TRIM_RAM_READ.segment');
    const lamAt = link.indexOf('exchange.address === LAMBDA_SENSOR_ADDRESS');
    const tqAt = link.indexOf('exchange.address === TORQUE_REQUEST_ADDRESS');
    check('both dispatched by address, before the trim\'s own guard', lamAt > 0 && tqAt > 0 && lamAt < trimGuard && tqAt < trimGuard,
        `${lamAt} ${tqAt} ${trimGuard}`);
    check('block 3\'s pedal and target are copied onto every sample',
        /pwg1: std\.pwg1 \?\? undefined/.test(link) && /edkSoll: std\.edkSoll \?\? undefined/.test(link));
    check('block 19\'s FR_REGLER is written on the sample that read it, not into the carry',
        /fillingRegulator = op\.frRegler === null \? \{\} : \{ frRegler: op\.frRegler \}/.test(link)
        && !/slowLane = \{[^}]*frRegler/.test(link));
}

console.log(fails === 0 ? '\nALL PASS' : '\n' + fails + ' FAILURE(S)');
process.exit(fails ? 1 : 0);
