/**
 * The ignition side of a VE log: the six final angles out of block 19, and the six knock counters
 * out of RAM beside them.
 *
 * Asked for on 2026-10-19. Under K HOLD the 7.5-10 % x 2200-2700 rpm band runs at RF ~0.74, so the
 * ignition map reads a lighter, more advanced row, and the driver feels a sudden loss and recovery
 * at WDK 20-30 %. Whether knock control is doing that is a question for the log, and the log had no
 * ignition channel at all.
 *
 * Four things are pinned, and the first is the one a previous analysis got right by luck rather
 * than by evidence:
 *
 *   1. WHERE the angles are. Not "the catalog says 22..32" but the master's own responder for
 *      selection 19 (decomp/master/030b84.txt case 0x18), replayed below as data: it copies TZ[0..7]
 *      into payload 22..37 itself, and every other field it writes sits where the app already reads
 *      it. Signed, 0.1 deg, positive before TDC.
 *   2. The decode: offsets, sign, scale, and null — never 0 — past the end of a short block.
 *   3. The knock counters: twelve bytes, all six or none, nothing above the DME's own 1275.
 *   4. That the runs RECORD them: the angles ride on block 19 in every VE list and survive the
 *      production narrowing; the counters share block 19's lane and cost under a tenth of the sample,
 *      where the same read on every sample would not.
 *
 *     node --experimental-strip-types --import ./scripts/ts-resolve.mjs scripts/verify-ignition.mjs
 */
import {
    OPERATING_MEASUREMENTS_BLOCK, decodeOperatingMeasurementsBlock, IGNITION_ANGLE_KEYS,
} from '../src/lib/dme-link/liveValueBlocks.ts';
import { decodeKnockAge, ignitionFromBlock19 } from '../src/lib/dme-link/slowLane.ts';
import {
    KNOCK_AGE_RAM_READ, KNOCK_AGE_SATURATED, Mss54HpRamWindows, isRamReadInRange,
} from '../src/lib/dme-link/ramMap.ts';
import {
    LOG_PROFILES, productionExchanges, sampleMs, exchangeMs, LAMBDA_SLOW_LANE_EVERY,
} from '../src/lib/log-engine/logProfile.ts';
import { LOG_FIELD_REGISTRY, DEFAULT_FIELD_VISIBILITY } from '../src/lib/field-registry/registry.ts';
import { serializeLogFile } from '../src/lib/log-engine/serializer.ts';
import { parseLogFile } from '../src/lib/log-engine/parser.ts';

let fails = 0;
const check = (n, c, d) => { console.log('  ' + (c ? 'PASS' : 'FAIL') + '  ' + n + (c ? '' : ' — ' + (d ?? ''))); if (!c) fails++; };

const f = OPERATING_MEASUREMENTS_BLOCK.fields;
const KNOCK_KEYS = ['knockAge1', 'knockAge2', 'knockAge3', 'knockAge4', 'knockAge5', 'knockAge6'];

console.log('\n[the angles are where the master writes TZ[0..5]]');
{
    /*
     * decomp/master/030b84.txt, `case 0x18`, as the bytes it produces. `rsp_ptr + 3` is payload 0;
     * each entry is one store or one zero-fill loop, in order. The response length the case reports
     * (`pbVar10 - peVar9`) is 90, which is selection 19's.
     *
     *   V            0..1      V_ASC        2..3       zero x18     4..21
     *   TZ[0..7]     22..37    zero x10     38..47     SERVO_I_IST  48..49
     *   SERVO_TAST   50..51    SERVO_I_SOLL 52..53     zero x6      54..59
     *   ASC_AY       60        ASC_AX       61         zero         62       SLS_ST_BANDENDE 63
     *   zero x11     64..74    LLS_TV       75..76     MD_LLRI      77..78   FR_REGLER 79..80
     *   EDK_AUS      81..82    CAN_FST      83         zero x6      84..89
     */
    const master = [
        ['V', 0, 2], ['V_ASC', 2, 2], [null, 4, 18],
        ...[0, 1, 2, 3, 4, 5, 6, 7].map(i => [`TZ[${i}]`, 22 + 2 * i, 2]),
        [null, 38, 10], ['SERVO_I_IST', 48, 2], ['SERVO_TAST', 50, 2], ['SERVO_I_SOLL', 52, 2],
        [null, 54, 6], ['ASC_AY', 60, 1], ['ASC_AX', 61, 1], [null, 62, 1], ['SLS_ST_BANDENDE', 63, 1],
        [null, 64, 11], ['LLS_TV', 75, 2], ['MD_LLRI', 77, 2], ['FR_REGLER', 79, 2],
        ['EDK_AUS', 81, 2], ['CAN_FST', 83, 1], [null, 84, 6],
    ];
    const end = master.reduce((at, [, off, len]) => (off === at ? at + len : NaN), 0);
    check('the transcription is contiguous and 90 bytes long, like the block', end === 90
        && OPERATING_MEASUREMENTS_BLOCK.expectedLength === 90, String(end));

    const writerAt = (offset) => master.find(([, off, len]) => offset >= off && offset < off + len);
    // Every field the app reads that the master writes itself must sit on that write exactly —
    // this is what ties the catalog's offsets to the binary, and it has to hold for the old fields
    // as well as the new, or the transcription above is wrong rather than the angles right.
    const ownedByMaster = { llsTv: 'LLS_TV', mdLlri: 'MD_LLRI', frRegler: 'FR_REGLER' };
    for (const [key, sym] of Object.entries(ownedByMaster)) {
        const w = writerAt(f[key].offset);
        check(`${key} @ ${f[key].offset} is the master's ${sym}`, w?.[0] === sym && w[1] === f[key].offset, w?.[0]);
    }
    // And the slave-filled ones sit in a range the master zeroes — the existing reading of 38..47
    // and 84..89, restated here so the new fields are judged by the same rule.
    for (const key of ['tankVent', 'stft1', 'stft2', 'tankVentCheckState', 'tankVentDiag', 'lambdaFreeze']) {
        const w = writerAt(f[key].offset);
        check(`${key} @ ${f[key].offset} is a byte the master zeroes (slave-filled)`, w?.[0] === null, w?.[0]);
    }
    IGNITION_ANGLE_KEYS.forEach((key, c) => {
        const w = writerAt(f[key].offset);
        check(`${key} (${f[key].symbol}) @ ${f[key].offset} is TZ[${c}], written by the master itself`,
            w?.[0] === `TZ[${c}]` && w[1] === f[key].offset && w[2] === 2, w?.[0]);
    });
    check('TZ[6]/TZ[7] at 34..37 are not read — a six-cylinder car never writes them',
        !Object.values(f).some(x => x.offset >= 34 && x.offset < 38));
}

console.log('\n[format, sign and scale]');
{
    IGNITION_ANGLE_KEYS.forEach((key, c) => {
        const x = f[key];
        check(`${key}: tz${c + 1}, int15, 0.1 deg, no offset`,
            x.symbol === `tz${c + 1}` && x.format === 'int15' && x.scale === 0.1 && x.add === 0,
            JSON.stringify(x));
    });
    check('the six keys are in cylinder order, two bytes apart from 22',
        IGNITION_ANGLE_KEYS.every((k, i) => f[k].offset === 22 + 2 * i));

    // 24.0, 23.5, one cylinder 3 deg down, 24.0, a cat-heating angle past TDC, the K_TZ_MAX clamp.
    const angles = [24.0, 23.5, 21.0, 24.0, -2.5, 60.0];
    const payload = new Uint8Array(90);
    angles.forEach((deg, c) => {
        const raw = Math.round(deg * 10) & 0xFFFF;
        payload[22 + 2 * c] = raw >> 8; payload[23 + 2 * c] = raw & 0xFF;
    });
    payload[38] = 0x0E; payload[39] = 0x74;   // tetv 7.4 ms
    payload[40] = 0x80; payload[41] = 0x00;   // la_f_regler1 = 1.000
    const d = decodeOperatingMeasurementsBlock(payload);
    IGNITION_ANGLE_KEYS.forEach((key, c) => {
        check(`${key} decodes to ${angles[c]} deg`, Math.abs(d[key] - angles[c]) < 1e-9, d[key]);
    });
    check('-2.5 deg is negative, not a 6551-degree advance', d.ignitionAngle5 < 0, d.ignitionAngle5);
    check('the neighbours did not move (tetv 7.4, stft1 1.000)',
        Math.abs(d.tankVent - 7.4) < 1e-9 && Math.abs(d.stft1 - 1) < 1e-9, `${d.tankVent} ${d.stft1}`);
}

console.log('\n[a short block: absent, not zero]');
{
    const s30 = decodeOperatingMeasurementsBlock(new Uint8Array(30));
    check('tz1..tz4 fit in 30 bytes', IGNITION_ANGLE_KEYS.slice(0, 4).every(k => s30[k] === 0));
    check('tz5 (30..31) and tz6 (32..33) are null past the end',
        s30.ignitionAngle5 === null && s30.ignitionAngle6 === null, `${s30.ignitionAngle5} ${s30.ignitionAngle6}`);
    const s33 = decodeOperatingMeasurementsBlock(new Uint8Array(33));
    check('one byte short of tz6 is still null, not half a word', s33.ignitionAngle6 === null && s33.ignitionAngle5 === 0);
    const none = decodeOperatingMeasurementsBlock(new Uint8Array(0));
    check('an empty block decodes no angle at all', IGNITION_ANGLE_KEYS.every(k => none[k] === null));

    const ch = ignitionFromBlock19(s30);
    check('the sample carries tz1..tz4 and NO key for tz5/tz6',
        Object.keys(ch).sort().join() === IGNITION_ANGLE_KEYS.slice(0, 4).join() && !('ignitionAngle5' in ch),
        Object.keys(ch).join());
    check('a genuine 0.0 deg survives (it is an angle)', ch.ignitionAngle1 === 0);
}

console.log('\n[the knock counters]');
{
    check('twelve bytes at 0xFFE874, segment 0x04',
        KNOCK_AGE_RAM_READ.segment === 0x04 && KNOCK_AGE_RAM_READ.address === 0xFFE874 && KNOCK_AGE_RAM_READ.count === 12,
        JSON.stringify(KNOCK_AGE_RAM_READ));
    check('inside the window this DME serves', isRamReadInRange(KNOCK_AGE_RAM_READ.segment, KNOCK_AGE_RAM_READ.address, KNOCK_AGE_RAM_READ.count)
        && KNOCK_AGE_RAM_READ.segment === Mss54HpRamWindows.high.segment);
    // FUN_000297fe initialises to 0x4FB and FUN_00029670 stops there; KL_KR_ANZ_AB = 255 on this
    // car makes 255 * 5 the same number, which is why every reset is a retard here.
    check('saturation is 0x4FB = 1275 = 255 * 5', KNOCK_AGE_SATURATED === 0x4FB && KNOCK_AGE_SATURATED === 255 * 5);

    const telegram = (words) => {
        const b = new Uint8Array(12);
        words.forEach((w, i) => { b[2 * i] = (w >> 8) & 0xFF; b[2 * i + 1] = w & 0xFF; });
        return b;
    };
    const k = decodeKnockAge(telegram([1275, 1275, 12, 1275, 0, 1275]), KNOCK_AGE_RAM_READ.address);
    check('cylinder order, big-endian words', KNOCK_KEYS.map(x => k[x]).join() === '1275,1275,12,1275,0,1275', JSON.stringify(k));
    check('0 survives: retarded on the very combustion before the read', k.knockAge5 === 0);
    const bad = decodeKnockAge(telegram([1275, 1275, 1276, 1275, 1275, 1275]), KNOCK_AGE_RAM_READ.address);
    check('one word above 1275 drops all six — that is not this counter', Object.keys(bad).length === 0, JSON.stringify(bad));
    const short = decodeKnockAge(telegram([5, 5, 5, 5, 5, 5]).subarray(0, 10), KNOCK_AGE_RAM_READ.address);
    check('a short read drops all six rather than five', Object.keys(short).length === 0, JSON.stringify(short));
    const elsewhere = decodeKnockAge(telegram([5, 5, 5, 5, 5, 5]), KNOCK_AGE_RAM_READ.address + 2);
    check('a buffer from the wrong address decodes nothing', Object.keys(elsewhere).length === 0);
}

console.log('\n[a VE run records them]');
{
    const isB19 = x => x.kind === 'block' && x.selection === 19;
    const isKnock = x => x.kind === 'ram' && x.address === KNOCK_AGE_RAM_READ.address;
    const ve = LOG_PROFILES.VE;
    for (const which of ['exchanges', 'fallback']) {
        const b19 = ve[which].find(isB19);
        check(`${which}: block 19 provides tz1..tz6`,
            IGNITION_ANGLE_KEYS.every(k => b19?.provides?.includes(k)), b19?.provides?.join());
        check(`${which}: and production keeps it`, productionExchanges(ve[which]).some(isB19));
    }
    const knock = ve.exchanges.find(isKnock);
    const b19 = ve.exchanges.find(isB19);
    check('the fast list reads the knock counters', !!knock, ve.exchanges.map(x => x.name ?? x.selection).join());
    check('...providing knockAge1..6', KNOCK_KEYS.every(k => knock?.provides?.includes(k)), knock?.provides?.join());
    check('...on block 19\'s own lane, so one sample carries both',
        knock?.every === b19?.every && b19?.every === LAMBDA_SLOW_LANE_EVERY, `${knock?.every} / ${b19?.every}`);
    check('the fallback still asks for no RAM', !ve.fallback.some(x => x.kind === 'ram'));
    check('production drops the knock read (debug throughout)', !productionExchanges(ve.exchanges).some(isKnock));

    for (const k of [...IGNITION_ANGLE_KEYS, ...KNOCK_KEYS]) {
        const m = LOG_FIELD_REGISTRY[k];
        if (!m) { check(`${k} is in the registry`, false); continue; }
        check(`${k}: '${m.symbol}', debug, off by default`, m.relevance === 'debug' && DEFAULT_FIELD_VISIBILITY[k] === false);
    }
    IGNITION_ANGLE_KEYS.forEach((k, c) => {
        const src = LOG_FIELD_REGISTRY[k].source;
        check(`${k} names selection 19 offset ${22 + 2 * c}`, src.selection === 19 && src.offset === 22 + 2 * c, JSON.stringify(src));
    });
}

console.log('\n[the knock read is cheap because of its lane, and only because of it]');
{
    const knock = LOG_PROFILES.VE.exchanges.find(x => x.kind === 'ram' && x.address === KNOCK_AGE_RAM_READ.address);
    const without = LOG_PROFILES.VE.exchanges.filter(x => x !== knock);
    const base = sampleMs(without);
    const laneCost = exchangeMs(knock) / knock.every;
    const everySample = exchangeMs(knock);
    const smallest = exchangeMs({ kind: 'ram', name: 'two bytes', segment: 4, address: 0xFFE836, count: 2 });
    console.log(`        VE sample ${base.toFixed(1)} ms; knock read ${everySample.toFixed(1)} ms, `
        + `${laneCost.toFixed(1)} ms a sample on the lane (${(100 * laneCost / base).toFixed(1)} %)`);
    check('on the block-19 lane it costs at most a tenth of the VE sample', laneCost / base <= 0.10,
        `${(100 * laneCost / base).toFixed(1)} %`);
    check('on every sample it would not', everySample / base > 0.10, `${(100 * everySample / base).toFixed(1)} %`);
    check('...and neither would the smallest per-sample RAM read there is (2 bytes of KR)',
        smallest / base > 0.10, `${(100 * smallest / base).toFixed(1)} %`);
    const prodBase = sampleMs(productionExchanges(LOG_PROFILES.VE.exchanges));
    check('production pays nothing for it', Math.abs(prodBase - sampleMs(productionExchanges(without))) < 1e-9);
}

console.log('\n[the CSV round trip keeps the gaps]');
{
    const points = [0, 1, 2, 3].map(i => ({
        time: i * 0.25, rpm: 2400, rawLoad: 8.5, stft1: 1.0, stft2: 1.0, rf: 74.0,
        ...(i % 2 === 0 ? {
            ignitionAngle1: 23.0, ignitionAngle2: 23.0, ignitionAngle3: 20.0,
            ignitionAngle4: 23.0, ignitionAngle5: -1.5, ignitionAngle6: 23.0,
        } : {}),
        ...(i === 0 ? { knockAge1: 1275, knockAge2: 1275, knockAge3: 12, knockAge4: 1275, knockAge5: 0, knockAge6: 1275 } : {}),
    }));
    const back = parseLogFile(serializeLogFile(points));
    check('four rows back', back.length === 4, back.length);
    const keys = [...IGNITION_ANGLE_KEYS, ...KNOCK_KEYS];
    const same = back.every((p, i) => keys.every(k => p[k] === points[i][k]));
    check('every angle and counter survives, and every blank stays undefined', same,
        JSON.stringify(back.map(p => keys.map(k => p[k] ?? '-').join(' '))));
    const csv = serializeLogFile(points.map(({ knockAge1, knockAge2, knockAge3, knockAge4, knockAge5, knockAge6, ...rest }) => rest));
    check('a run that never read the counters writes no counter columns', !/Knock Age/i.test(csv.split('\n')[0]), csv.split('\n')[0]);
    check('the angle columns wear Testo\'s own header', csv.split('\n')[0].includes('Ignition angle cyl. 1'));
}

console.log(fails === 0 ? '\nALL PASS' : '\n' + fails + ' FAILURE(S)');
process.exit(fails ? 1 : 0);
