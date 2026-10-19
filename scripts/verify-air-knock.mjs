/**
 * Three RAM reads on the VE slow lanes: the DME's knock sums (with the gear and the drive-by-noise
 * cap from the same fifteen bytes), the two cams beside their map targets, and the manifold
 * sensor's air beside the Alpha-N air.
 *
 * Asked for on 2026-10-19, for questions the log could not answer:
 *
 *   - At matched rpm and RO, two drives whose RF differed by 10 % read the same lambda trim. Did
 *     the air really differ (the AIR side), or did something between RF and the injector move with
 *     it (the FUEL side)? `rf_p_saug` is the same filling from the manifold sensor, so it says which.
 *   - #978's knock counters showed cylinders being retarded (counter < 20 -> a median 1.4 deg below
 *     the top angle). How deep did it go? `KR_DTZ_SUM` is the DME's own running total.
 *   - Were the cams where KF_EVAN1_SOLL / KF_AVAN1_SOLL sent them? Two drives at matched rpm and RO
 *     with the cams elsewhere did not breathe the same air.
 *
 * Pinned here, and each from the DME's own code rather than a catalog — the sources are named in
 * ramMap.ts, every one a store this file replays as data:
 *
 *   1. The sums: where `knock_related_3_` / `_4_` write them, as signed 0.1 deg words obeying
 *      SUM = SUM1 + SUM2, and the checks that drop a read that is not them.
 *   2. The cam targets: where the slave's FUN_00024848 / FUN_00025aa0 store them, inside the
 *      26-byte group the idle run reads, as signed 0.1 degKW words like the positions beside them.
 *   3. The manifold telegram: offsets, sign and scale of each word, and the m_norm / m_norm_fakt
 *      gate, recomputed from K_RF_LUFTDICHTE and K_RF_HUBVOLUMEN out of both shipped images.
 *   4. That a VE run records them — cams and air one sample in eight, the sums one in sixteen, all on
 *      block-19 samples; that production drops all three reads and pays nothing; and what the three
 *      cost the preview sample (11.2 % against a ~10 % budget — see KNOCK_SUM_LANE_EVERY).
 *   5. The CSV round trip, blanks kept blank; and PRACTICE refusing all three reads.
 *
 *     node --experimental-strip-types --import ./scripts/ts-resolve.mjs scripts/verify-air-knock.mjs
 */
import { readFileSync } from 'node:fs';
import {
    Mss54HpRamSignals, KNOCK_SUM_RAM_READ, MANIFOLD_AIR_RAM_READ, KNOCK_AGE_RAM_READ,
    MANIFOLD_NORM_0401, RF_INIT_CONSTANTS_0401, expectedManifoldNorm, GANG_MAX, NOISE_ST_UNUSED_BITS,
    Mss54HpRamWindows, isRamReadInRange, RAM_READ_MAX_COUNT, IDLE_VANOS_RAM_READ,
} from '../src/lib/dme-link/ramMap.ts';
import {
    decodeKnockSums, decodeManifoldAir, decodeVanos, KNOCK_SUM_ADDRESS, MANIFOLD_AIR_ADDRESS, VANOS_ADDRESS,
} from '../src/lib/dme-link/slowLane.ts';
import {
    LOG_PROFILES, productionExchanges, sampleMs, exchangeMs, expectedHz, LAMBDA_SLOW_LANE_EVERY,
    KNOCK_SUM_LANE_EVERY,
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
const KNOCK_KEYS = ['noiseSt', 'gear', 'krDtzSum', 'krDtzSum1', 'kaDtzSum', 'kaDtzSum1'];
const AIR_KEYS = ['rfPSaug', 'rfDiagF', 'rfKorrDme', 'pSaug', 'pSaugM'];
const VANOS_KEYS = ['evan1Ist', 'evanSoll', 'avan1Ist', 'avanSoll', 'evan1St', 'avan1St', 'vanEdSt', 'vanAdapSt'];

/** Write `raw` (two's complement for negatives) into `buf` where `sig` sits, buffer starting at `base`. */
const put = (buf, base, sig, raw) => {
    const at = sig.address - base;
    const v = raw & (sig.size === 1 ? 0xFF : 0xFFFF);
    if (sig.size === 1) buf[at] = v;
    else { buf[at] = v >> 8; buf[at + 1] = v & 0xFF; }
};

/**
 * `knock_related_3_`'s six-cylinder tail (0x029C62) and `knock_related_4_`'s (0x02A2F0), as the
 * words they store: bank 1 = cylinders 1-3, bank 2 = 4-6, total = SUM1 + SUM2 — add.w, so 16-bit.
 * KR/KA in raw 0.1 deg counts, negative = retard.
 */
const dmeSums = (w) => {
    const s1 = (w[0] + w[1] + w[2]) & 0xFFFF;
    const s2 = (w[3] + w[4] + w[5]) & 0xFFFF;
    return { s: (s1 + s2) & 0xFFFF, s1, s2 };
};
const knockTelegram = ({ noise = 0, gang = 0, kr = [0, 0, 0, 0, 0, 0], ka = [0, 0, 0, 0, 0, 0], kaSums } = {}) => {
    const base = KNOCK_SUM_RAM_READ.address;
    const b = new Uint8Array(KNOCK_SUM_RAM_READ.count);
    const k = dmeSums(kr);
    const a = kaSums ?? dmeSums(ka);
    put(b, base, R.NOISE_ST, noise); put(b, base, R.GANG, gang);
    put(b, base, R.KR_DTZ_SUM, k.s); put(b, base, R.KR_DTZ_SUM1, k.s1); put(b, base, R.KR_DTZ_SUM2, k.s2);
    put(b, base, R.KA_DTZ_SUM, a.s); put(b, base, R.KA_DTZ_SUM1, a.s1); put(b, base, R.KA_DTZ_SUM2, a.s2);
    return b;
};

console.log('\n[the knock sums are where knock_related_3_ / _4_ store them]');
{
    // Each line is one store in the listing: the address a move.w / clr.w names, the width, the sign
    // the readers give it (the slave reads every one as `short`), and 0.1 deg per count.
    const words = [
        ['KR_DTZ_SUM', 0xFF8252], ['KR_DTZ_SUM1', 0xFF8254], ['KR_DTZ_SUM2', 0xFF8256],
        ['KA_DTZ_SUM', 0xFF8258], ['KA_DTZ_SUM1', 0xFF825A], ['KA_DTZ_SUM2', 0xFF825C],
    ];
    for (const [name, addr] of words) {
        const s = R[name];
        check(`${name}: segment 0x01, 0x${addr.toString(16)}, signed word, 0.1 deg`,
            s.segment === 0x01 && s.address === addr && s.size === 2 && s.signed === true && s.scale === 0.1,
            JSON.stringify(s));
    }
    // clr.b at gang_init 0x01DF7A/0x01DF88; the freeze-frame copies GANG (move.b $ff8250) to block 83
    // offset 49. One byte each, unsigned.
    check('NOISE_ST: segment 0x01, 0xff824f, unsigned byte',
        R.NOISE_ST.segment === 0x01 && R.NOISE_ST.address === 0xFF824F && R.NOISE_ST.size === 1 && !R.NOISE_ST.signed);
    check('GANG: segment 0x01, 0xff8250, unsigned byte',
        R.GANG.segment === 0x01 && R.GANG.address === 0xFF8250 && R.GANG.size === 1 && !R.GANG.signed);
    check('the read: segment 0x01, 0xff824f, fifteen bytes, NOISE_ST through KA_DTZ_SUM2',
        KNOCK_SUM_RAM_READ.segment === 0x01 && KNOCK_SUM_RAM_READ.address === 0xFF824F && KNOCK_SUM_RAM_READ.count === 15,
        JSON.stringify(KNOCK_SUM_RAM_READ));
    check('...inside the window this DME serves, under its 128-byte clamp',
        isRamReadInRange(KNOCK_SUM_RAM_READ.segment, KNOCK_SUM_RAM_READ.address, KNOCK_SUM_RAM_READ.count)
        && KNOCK_SUM_RAM_READ.segment === Mss54HpRamWindows.low.segment && KNOCK_SUM_RAM_READ.count <= RAM_READ_MAX_COUNT);
    check('the link dispatches on that address', KNOCK_SUM_ADDRESS === 0xFF824F);
    check('GANG_MAX is 7 (gang_calc writes 0..6, the CAN path byte & 7)', GANG_MAX === 7);
    check('NOISE_ST\'s unwritten bits are 2..6 (|0x80 &0x7F &0xFC |1 |2)', NOISE_ST_UNUSED_BITS === 0x7C);
}

console.log('\n[decode: sign, scale, banks]');
{
    // Cylinder 3 retarded 3.0 deg, cylinder 6 2.0 deg; a learned -0.5 on cylinders 1 and 4.
    const d = decodeKnockSums(knockTelegram({ noise: 0x82, gang: 5, kr: [0, 0, -30, 0, 0, -20], ka: [-5, 0, 0, -5, 0, 0] }),
        KNOCK_SUM_RAM_READ.address);
    check('all six channels decode', KNOCK_KEYS.every(k => d[k] !== undefined), JSON.stringify(d));
    check('KR_DTZ_SUM -5.0 deg, exactly (divided, not multiplied out of tenths)', d.krDtzSum === -5, d.krDtzSum);
    check('KR_DTZ_SUM1 -3.0 deg: cylinders 1-3 only', d.krDtzSum1 === -3, d.krDtzSum1);
    check('KA_DTZ_SUM -1.0, KA_DTZ_SUM1 -0.5', d.kaDtzSum === -1 && d.kaDtzSum1 === -0.5, `${d.kaDtzSum} ${d.kaDtzSum1}`);
    check('bank 2 is SUM - SUM1 (-2.0 deg on cylinder 6)', d.krDtzSum - d.krDtzSum1 === -2);
    check('gear 5, NOISE_ST 0x82 with bit 1 (the torque cap) set', d.gear === 5 && d.noiseSt === 0x82 && (d.noiseSt & 2) !== 0);
    // K_KR_DTZ_MAX is 10.0 deg: six cylinders fully retarded is -60.0, far inside a signed word.
    const deep = decodeKnockSums(knockTelegram({ kr: [-100, -100, -100, -100, -100, -100] }), KNOCK_SUM_RAM_READ.address);
    check('six cylinders at the 10 deg cap read -60.0, not +6493.6', deep.krDtzSum === -60 && deep.krDtzSum1 === -30, JSON.stringify(deep));
    // knock_related_4_'s fallback (status & 2): KA_DTZ_SUM = six copies of KA[0], SUM2 = SUM / 2
    // (rounded toward zero), SUM1 = SUM2. Six equal words are even, so the identity still holds.
    const s = (-7 * 6) & 0xFFFF;
    const half = (-21) & 0xFFFF;
    const fallback = decodeKnockSums(knockTelegram({ kaSums: { s, s1: half, s2: half } }), KNOCK_SUM_RAM_READ.address);
    check('the KA fallback path (SUM1 = SUM2 = SUM/2) still decodes', fallback.kaDtzSum === -4.2 && fallback.kaDtzSum1 === -2.1,
        JSON.stringify(fallback));
    const zero = decodeKnockSums(knockTelegram(), KNOCK_SUM_RAM_READ.address);
    check('a drive with no knock: all zero, neutral', zero.krDtzSum === 0 && zero.kaDtzSum === 0 && zero.gear === 0 && zero.noiseSt === 0);
}

console.log('\n[a read that is not these bytes decodes to nothing]');
{
    const base = KNOCK_SUM_RAM_READ.address;
    const good = knockTelegram({ gang: 4, kr: [0, -30, 0, 0, 0, 0] });
    const torn = good.slice(); put(torn, base, R.KR_DTZ_SUM, 0);   // SUM1/SUM2 rewritten, SUM not yet
    check('KR_DTZ_SUM != SUM1 + SUM2 drops the whole telegram', Object.keys(decodeKnockSums(torn, base)).length === 0);
    const tornKa = knockTelegram({ ka: [-5, 0, 0, 0, 0, 0] }); put(tornKa, base, R.KA_DTZ_SUM, 0);
    check('...and so does KA_DTZ_SUM != SUM1 + SUM2', Object.keys(decodeKnockSums(tornKa, base)).length === 0);
    check('GANG 8 drops it — nothing writes more than 7',
        Object.keys(decodeKnockSums(knockTelegram({ gang: GANG_MAX + 1 }), base)).length === 0);
    check('GANG 7 is still a gear', decodeKnockSums(knockTelegram({ gang: 7 }), base).gear === 7);
    check('NOISE_ST with bit 2 set drops it — nothing writes bits 2..6',
        Object.keys(decodeKnockSums(knockTelegram({ noise: 0x04 }), base)).length === 0);
    check('a short read drops all of it rather than most of it',
        Object.keys(decodeKnockSums(good.subarray(0, 14), base)).length === 0);
    // One byte off: GANG is read out of KR_DTZ_SUM's high byte, the sums out of their neighbours.
    const shifted = knockTelegram({ gang: 3, kr: [-30, 0, 0, -20, 0, 0], ka: [-3, 0, 0, 0, 0, 0] });
    check('the same bytes taken as if they started one address later decode to nothing',
        Object.keys(decodeKnockSums(shifted, base + 1)).length === 0, JSON.stringify(decodeKnockSums(shifted, base + 1)));
}

console.log('\n[the cam targets are where the slave stores them, in the group the idle run reads]');
{
    // FUN_00024848: a2 = #$ff81e4, t = (K_EVAN1_SOLL_OFFSET + KF_EVAN1_SOLL byte) * 10 (ext.w, lsl.w #2,
    // add.w, add.w), compared signed (ble/bge) with K_EVAN1_SOLL_MAX/MIN, move.w to (a2).
    // FUN_00025aa0: the same for the exhaust into #$ff81e8.
    for (const [name, addr] of [['EVAN_SOLL', 0xFF81E4], ['AVAN_SOLL', 0xFF81E8]]) {
        const s = R[name];
        check(`${name}: segment 0x01, 0x${addr.toString(16)}, signed word, 0.1 degKW — EVAN1_IST's own encoding`,
            s.segment === 0x01 && s.address === addr && s.size === 2 && s.signed === true
            && s.scale === 0.1 && s.scale === R.EVAN1_IST.scale && R.EVAN1_IST.signed,
            JSON.stringify(s));
    }
    const v = IDLE_VANOS_RAM_READ;
    check('the read is the idle run\'s own: segment 0x01, 0xff81da, 26 bytes',
        v.segment === 0x01 && v.address === 0xFF81DA && v.count === 26, JSON.stringify(v));
    check('...and it covers both targets', [R.EVAN_SOLL, R.AVAN_SOLL].every(s =>
        s.address >= v.address && s.address + s.size <= v.address + v.count));
    check('the link dispatches on that address', VANOS_ADDRESS === 0xFF81DA);
    // The constant the target is compared with directly, out of the shipped image: x/10 in the XDF,
    // so a target word of 600 is 60.0 degKW — the scale above, from a reader rather than a catalog.
    const cat = buildCatalog(JSON.parse(readFileSync('public/data/calibration-graph.json', 'utf8')));
    const bin = readFileSync('public/mock/csl-0401-community-patch-v1.partial.bin');
    const buf = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength);
    const max = decodeParam(buf, cat.byName.get('K_EVAN1_SOLL_MAX')).value;
    check('K_EVAN1_SOLL_MAX is raw 600 = 60.0 degKW, the clamp cmp.w makes against EVAN_SOLL',
        max?.raw?.[0] === 600 && max?.phys?.[0] === 60, JSON.stringify(max));

    // The slave's arithmetic, replayed: a map byte of 50 with no offset is 500 = 50.0 degKW.
    const slaveTarget = (offset, mapByte) => (offset + mapByte) * 10;
    const t = new Uint8Array(26);
    const base = v.address;
    put(t, base, R.AVAN1_IST, 25); put(t, base, R.EVAN1_IST, 498);
    put(t, base, R.EVAN_SOLL, slaveTarget(0, 50)); put(t, base, R.AVAN_SOLL, slaveTarget(0, -1));
    put(t, base, R.EVAN1_ST, 0x88); put(t, base, R.AVAN1_ST, 0x80); put(t, base, R.VAN_ED_ST, 0x00); put(t, base, R.VAN_ADAP_ST, 0x10);
    const d = decodeVanos(t, base);
    check('all eight decode', VANOS_KEYS.every(k => d[k] !== undefined), JSON.stringify(d));
    check('intake 49.8 against a target of 50.0', d.evan1Ist === 49.8 && d.evanSoll === 50, `${d.evan1Ist} ${d.evanSoll}`);
    check('exhaust 2.5 against a target of -1.0 (signed)', d.avan1Ist === 2.5 && d.avanSoll === -1, `${d.avan1Ist} ${d.avanSoll}`);
    check('the status bytes come through raw', d.evan1St === 0x88 && d.avan1St === 0x80 && d.vanEdSt === 0 && d.vanAdapSt === 0x10);
    check('EVAN1_ST bit 3 is readable off the decoded byte (target followed)', (d.evan1St & 0x08) !== 0);
    check('a short read drops all eight, not the status bytes alone',
        Object.keys(decodeVanos(t.subarray(0, 25), base)).length === 0);
}

console.log('\n[the manifold telegram is where rf_calc / p_saug_calc / rf_diag store it]');
{
    // address, unsigned/signed word, scale — each named against its writer in ramMap.ts:
    //   rf_korr    rf_init  move.w #$400,$ffeea6 (0x0218BC); rf_calc mulu.w it, >> 10
    //   p_saug_m   p_saug_init / p_saug_calc  move.w ...,$ffeeb0 (0x021684)
    //   p_saug     p_saug_init copies P_UMG_FILTER (1/32 mbar); compared bcc with K_P_UMG_ERSATZ x/32
    //   rf_p_saug  rf_calc  divu.l #$ffff / move.w ...,$ffeeca (0x021908); RF = rf_p_saug
    //   rf_diag_f  rf_diag  sub.w $ffeeca,d0 / move.w d0,$ffeecc (0x021DE6); bge/ble after it
    const want = [
        ['RF_KORR', 0xFFEEA6, false, 1 / 1024], ['P_SAUG_M', 0xFFEEB0, false, 1 / 32], ['P_SAUG', 0xFFEEB2, false, 1 / 32],
        ['M_NORM', 0xFFEEB4, false, 1], ['M_NORM_FAKT', 0xFFEEB6, false, 1],
        ['RF_P_SAUG', 0xFFEECA, false, 0.1], ['RF_DIAG_F', 0xFFEECC, true, 0.1],
    ];
    for (const [name, addr, signed, scale] of want) {
        const s = R[name];
        check(`${name}: segment 0x04, 0x${addr.toString(16)}, ${signed ? 'signed' : 'unsigned'} word, x${scale}`,
            s.segment === 0x04 && s.address === addr && s.size === 2 && s.signed === signed && s.scale === scale,
            JSON.stringify(s));
    }
    check('P_SAUG shares P_UMG_FILTER\'s scale — p_saug_init copies one into the other',
        R.P_SAUG.scale === R.P_UMG_FILTER.scale && R.P_SAUG_M.scale === R.P_UMG_FILTER.scale);
    check('the read: segment 0x04, 0xffeea6, forty bytes, rf_korr through rf_diag_f',
        MANIFOLD_AIR_RAM_READ.segment === 0x04 && MANIFOLD_AIR_RAM_READ.address === 0xFFEEA6 && MANIFOLD_AIR_RAM_READ.count === 40,
        JSON.stringify(MANIFOLD_AIR_RAM_READ));
    check('...inside the window this DME serves, under its 128-byte clamp',
        isRamReadInRange(MANIFOLD_AIR_RAM_READ.segment, MANIFOLD_AIR_RAM_READ.address, MANIFOLD_AIR_RAM_READ.count)
        && MANIFOLD_AIR_RAM_READ.segment === Mss54HpRamWindows.high.segment);
    check('the link dispatches on that address', MANIFOLD_AIR_ADDRESS === 0xFFEEA6);
}

console.log('\n[the address proof: what rf_init leaves in m_norm and m_norm_fakt]');
{
    // rf_init (0x02181C): roh = K_RF_LUFTDICHTE * K_RF_HUBVOLUMEN (mulu.w); m_norm = (roh divs 10000)
    // * 30; m_norm_fakt = 0x0927C000 divs (roh >> 8).
    const e = expectedManifoldNorm(1136, 3201);
    check('1136 x 3201 gives m_norm 10890 and m_norm_fakt 10813', e.mNorm === 10890 && e.mNormFakt === 10813, JSON.stringify(e));
    check('the gate the decoder uses is that pair',
        MANIFOLD_NORM_0401.mNorm === 10890 && MANIFOLD_NORM_0401.mNormFakt === 10813
        && RF_INIT_CONSTANTS_0401.luftdichteRaw === 1136 && RF_INIT_CONSTANTS_0401.hubvolumenRaw === 3201);
    // Re-read out of the images this repo ships, through the catalog — so a re-vendored catalog that
    // moved either constant, or an image that differs, fails here rather than on the car.
    const cat = buildCatalog(JSON.parse(readFileSync('public/data/calibration-graph.json', 'utf8')));
    for (const path of ['public/mock/csl-0401-community-patch-v1.partial.bin', 'scripts/fixtures/session-920-base.bin']) {
        const bin = readFileSync(path);
        const buf = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength);
        const raw = (name) => decodeParam(buf, cat.byName.get(name)).value?.raw?.[0];
        const l = raw('K_RF_LUFTDICHTE'), h = raw('K_RF_HUBVOLUMEN');
        check(`${path}: K_RF_LUFTDICHTE ${l}, K_RF_HUBVOLUMEN ${h} — the constants the gate assumes`,
            l === RF_INIT_CONSTANTS_0401.luftdichteRaw && h === RF_INIT_CONSTANTS_0401.hubvolumenRaw, `${l} / ${h}`);
    }
}

const airTelegram = ({ korr = 0x400, pm = 29000, p = 30160, rf = 742, diag = -50, norm = MANIFOLD_NORM_0401 } = {}) => {
    const base = MANIFOLD_AIR_RAM_READ.address;
    const b = new Uint8Array(MANIFOLD_AIR_RAM_READ.count);
    put(b, base, R.RF_KORR, korr); put(b, base, R.P_SAUG_M, pm); put(b, base, R.P_SAUG, p);
    put(b, base, R.M_NORM, norm.mNorm); put(b, base, R.M_NORM_FAKT, norm.mNormFakt);
    put(b, base, R.RF_P_SAUG, rf); put(b, base, R.RF_DIAG_F, diag);
    return b;
};

console.log('\n[the manifold decode]');
{
    const base = MANIFOLD_AIR_RAM_READ.address;
    const d = decodeManifoldAir(airTelegram(), base);
    check('all five channels decode', AIR_KEYS.every(k => d[k] !== undefined), JSON.stringify(d));
    check('rf_korr 0x400 is 1.000 — what K HOLD should read', d.rfKorrDme === 1);
    check('p_saug 30160 is 942.5 mbar, p_saug_m 29000 is 906.25', d.pSaug === 942.5 && d.pSaugM === 906.25, `${d.pSaug} ${d.pSaugM}`);
    check('rf_p_saug 742 is 74.2 %, in rf\'s own units', d.rfPSaug === 74.2, d.rfPSaug);
    check('rf_diag_f 0xFFCE is -5.0 %, signed', d.rfDiagF === -5, d.rfDiagF);
    check('rf_soll of the same instant is rf_diag_f + rf_p_saug (69.2 %)', Math.abs(d.rfDiagF + d.rfPSaug - 69.2) < 1e-9);
    const hi = decodeManifoldAir(airTelegram({ p: 40000, korr: 1229 }), base);
    check('pressure words are unsigned: 40000 is 1250 mbar, not negative', hi.pSaug === 1250, hi.pSaug);
    check('a correction above 1 reads above 1 (1229 -> 1.200)', Math.abs(hi.rfKorrDme - 1.2) < 1e-3, hi.rfKorrDme);

    check('m_norm_fakt one count off drops everything',
        Object.keys(decodeManifoldAir(airTelegram({ norm: { mNorm: 10890, mNormFakt: 10814 } }), base)).length === 0);
    check('m_norm and m_norm_fakt swapped drops everything',
        Object.keys(decodeManifoldAir(airTelegram({ norm: { mNorm: 10813, mNormFakt: 10890 } }), base)).length === 0);
    check('the zero buffer PRACTICE would have served decodes to nothing',
        Object.keys(decodeManifoldAir(new Uint8Array(40), base)).length === 0);
    check('two bytes off: nothing', Object.keys(decodeManifoldAir(airTelegram(), base + 2)).length === 0);
    check('a short read that loses rf_diag_f drops everything, not one channel',
        Object.keys(decodeManifoldAir(airTelegram().subarray(0, 38), base)).length === 0);
    const other = { mNorm: 12000, mNormFakt: 9000 };
    check('another calibration\'s constants are a parameter, not a fork',
        decodeManifoldAir(airTelegram({ norm: other }), base, other).rfPSaug === 74.2);
}

console.log('\n[a VE run records them, on block-19 samples]');
{
    const ve = LOG_PROFILES.VE.exchanges;
    const at = (pred) => ve.findIndex(pred);
    const iTrim = at(x => x.kind === 'ram' && x.name === 'LA_F_REGLER1/2');
    const iB19 = at(x => x.kind === 'block' && x.selection === 19);
    const iAge = at(x => x.kind === 'ram' && x.address === KNOCK_AGE_RAM_READ.address);
    const iSum = at(x => x.kind === 'ram' && x.address === KNOCK_SUM_RAM_READ.address);
    const iAir = at(x => x.kind === 'ram' && x.address === MANIFOLD_AIR_RAM_READ.address);
    const iCam = at(x => x.kind === 'ram' && x.address === IDLE_VANOS_RAM_READ.address);
    const sum = ve[iSum], air = ve[iAir], cam = ve[iCam];
    check('the fast list reads all three', iSum >= 0 && iAir >= 0 && iCam >= 0);
    check('the knock read provides exactly its six channels',
        JSON.stringify([...(sum?.provides ?? [])].sort()) === JSON.stringify([...KNOCK_KEYS].sort()), sum?.provides?.join());
    check('the manifold read provides exactly its five',
        JSON.stringify([...(air?.provides ?? [])].sort()) === JSON.stringify([...AIR_KEYS].sort()), air?.provides?.join());
    check('the cam read provides exactly its eight',
        JSON.stringify([...(cam?.provides ?? [])].sort()) === JSON.stringify([...VANOS_KEYS].sort()), cam?.provides?.join());
    check('cams and manifold air every 8 samples — block 19\'s lane',
        cam?.every === 8 && air?.every === 8 && LAMBDA_SLOW_LANE_EVERY === 8 && ve[iB19].every === LAMBDA_SLOW_LANE_EVERY,
        `${cam?.every} / ${air?.every}`);
    check('the knock sums every 16 — a multiple of block 19\'s, so every read lands on a block-19 sample',
        sum?.every === 16 && KNOCK_SUM_LANE_EVERY === 16 && KNOCK_SUM_LANE_EVERY % LAMBDA_SLOW_LANE_EVERY === 0,
        String(sum?.every));
    check('the sums come after the knock counters (#978: the counters trail block 19)', iAge < iSum, `${iAge} ${iSum}`);
    check('the manifold read is not between the RAM trim and block 19 (the truth re-check\'s gap)',
        !(iTrim < iAir && iAir < iB19), `${iTrim} ${iAir} ${iB19}`);
    check('the fallback still asks for no RAM', !LOG_PROFILES.VE.fallback.some(x => x.kind === 'ram'));
    for (const k of [...KNOCK_KEYS, ...AIR_KEYS, ...VANOS_KEYS]) {
        const m = LOG_FIELD_REGISTRY[k];
        check(`${k}: '${m?.symbol}', debug, off by default`, m?.relevance === 'debug' && DEFAULT_FIELD_VISIBILITY[k] === false);
    }
}

console.log('\n[production drops all three and pays nothing; what preview pays]');
{
    const ve = LOG_PROFILES.VE.exchanges;
    const OURS = [KNOCK_SUM_RAM_READ.address, MANIFOLD_AIR_RAM_READ.address, IDLE_VANOS_RAM_READ.address];
    const ours = (x) => x.kind === 'ram' && OURS.includes(x.address);
    const prod = productionExchanges(ve);
    check('production drops the knock, cam and manifold reads', !prod.some(ours), prod.map(x => x.name ?? x.selection).join());
    const without = ve.filter(x => !ours(x));
    check('the production rate is what it was without them',
        Math.abs(sampleMs(prod) - sampleMs(productionExchanges(without))) < 1e-9);
    const base = sampleMs(without);
    const added = ve.filter(ours).reduce((t, x) => t + exchangeMs(x) / x.every, 0);
    console.log(`        VE sample ${base.toFixed(1)} ms -> ${sampleMs(ve).toFixed(1)} ms (+${added.toFixed(1)} ms, `
        + `${(100 * added / base).toFixed(1)} %); ${expectedHz(without).toFixed(3)} -> ${expectedHz(ve).toFixed(3)} Hz; `
        + `production ${expectedHz(prod).toFixed(3)} Hz`);
    // The budget was ~10 %. All three at one in eight is 13 %; the knock read went to one in
    // sixteen first, as instructed, and the three now cost 11.2 %. Pinned at 11.5 % so the next read
    // added to this lane has to be priced rather than slipped in, and the overrun is reported.
    check('together they cost at most 11.5 % of the VE sample (budget ~10 %)', added / base <= 0.115,
        `${(100 * added / base).toFixed(1)} %`);
    const allAt8 = ve.filter(ours).reduce((t, x) => t + exchangeMs(x) / LAMBDA_SLOW_LANE_EVERY, 0);
    check('...which they would not with the knock read at one in eight too', allAt8 / base > 0.115,
        `${(100 * allAt8 / base).toFixed(1)} %`);
}

console.log('\n[the CSV round trip keeps the gaps]');
{
    const points = [0, 1, 2, 3].map(i => ({
        time: i * 0.25, rpm: 2400, rawLoad: 8.5, stft1: 1.0, stft2: 1.0, rf: 74.0,
        ...(i % 2 === 0 ? { gear: 5, noiseSt: 0x82, krDtzSum: -5, krDtzSum1: -3, kaDtzSum: -1, kaDtzSum1: -0.5 } : {}),
        ...(i === 0 ? { rfPSaug: 66.6, rfDiagF: 7.4, rfKorrDme: 1, pSaug: 942.5, pSaugM: 906.25 } : {}),
        ...(i === 2 ? { evan1Ist: 52.5, evanSoll: 60, avan1Ist: -0.5, avanSoll: 0, evan1St: 0x80, avan1St: 0x80, vanEdSt: 0x10, vanAdapSt: 0 } : {}),
    }));
    const csv = serializeLogFile(points);
    const back = parseLogFile(csv);
    const keys = [...KNOCK_KEYS, ...AIR_KEYS, ...VANOS_KEYS];
    check('four rows back', back.length === 4, back.length);
    check('every value survives, every blank stays undefined',
        back.every((p, i) => keys.every(k => p[k] === points[i][k])),
        JSON.stringify(back.map(p => keys.map(k => p[k] ?? '-').join(' '))));
    check('NOISE_ST survives as a number (a hex cell would not)', back[0].noiseSt === 0x82, back[0].noiseSt);
    check('so do the VANOS status bytes, and a negative cam', back[2].evan1St === 0x80 && back[2].vanEdSt === 0x10
        && back[2].avan1Ist === -0.5, JSON.stringify(back[2]));
    const head = csv.split('\n')[0];
    check('the headers are the app\'s own', [APP_CONFIG.CSV_MAPPING.KR_DTZ_SUM, APP_CONFIG.CSV_MAPPING.RF_P_SAUG,
        APP_CONFIG.CSV_MAPPING.GEAR].every(h => head.includes(h)), head);
    const bare = serializeLogFile(points.map(({ time, rpm, rawLoad, stft1, stft2, rf }) => ({ time, rpm, rawLoad, stft1, stft2, rf })));
    check('a run that never read them writes none of their columns',
        !/Knock Retard|Filling From MAP|Manifold Pressure|Gear|Noise Mode|Cam|VANOS/.test(bare.split('\n')[0]), bare.split('\n')[0]);
    // The DME's symbols read back too, so a CSV from another MSS54 tool lands in the same channels.
    const foreign = parseLogFile('time,rpm,relativer oeffnungsquerschnitt,lambdaintegrator 1,relative fuellung,rf_p_saug,kr_dtz_sum,gang\n0,2400,8.5,1.0,74,66.6,-5,5\n');
    check('rf_p_saug / kr_dtz_sum / gang headers are accepted',
        foreign[0]?.rfPSaug === 66.6 && foreign[0]?.krDtzSum === -5 && foreign[0]?.gear === 5, JSON.stringify(foreign[0]));
}

console.log('\n[PRACTICE refuses all three reads]');
{
    // Read from the source rather than run: the mock pulls in DmeLinkError, whose parameter property
    // Node's type stripping cannot load. The shape is the KNOCK AGE refusal's — an `if` on the read's
    // address that throws before the zero-filled buffer is built.
    const src = readFileSync('src/lib/dme-link/mockDmeLink.ts', 'utf8');
    const built = src.indexOf('const out = new Uint8Array(count);');
    for (const name of ['KNOCK_SUM_RAM_READ', 'MANIFOLD_AIR_RAM_READ', 'IDLE_VANOS_RAM_READ']) {
        const guard = src.indexOf(`if (address === ${name}.address) {`);
        const body = guard >= 0 ? src.slice(src.indexOf('{', guard) + 1) : '';
        check(`${name} is refused before the zero buffer is built`,
            guard >= 0 && guard < built && /^\s*throw new DmeLinkError\('PRACTICE/.test(body),
            `guard at ${guard}, buffer at ${built}`);
    }
}

console.log(fails === 0 ? '\nALL PASS' : '\n' + fails + ' FAILURE(S)');
process.exit(fails ? 1 : 0);
