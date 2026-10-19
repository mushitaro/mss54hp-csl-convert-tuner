/**
 * A log written by DOWNLOAD and read back by UPLOAD is the same log: every column the serializer
 * writes is a column the parser reads, and every cell comes back as the number that went out.
 *
 * The defect this was written for (2026-10-19): `LLS_ST` and `MD_DYN_ST` go out as hex — `0x81`,
 * because one bit is the whole reading (LLS_ST bit 7: which table TI_F_STAT comes from; MD_DYN_ST
 * bit 6: did the slew limiter clip) — and Papa's `dynamicTyping` turns only decimal text into
 * numbers. The reader's `pick` takes numbers only, so both columns came back as nothing, on every
 * export ever made, with no error. The reader now takes hex for the columns the serializer writes
 * as hex (`HEX_CSV_KEYS`), and the cells stay hex for whoever opens the file.
 *
 * Pinned here:
 *
 *   1. LLS_ST and MD_DYN_ST survive the round trip — 0x00, 0x81, 0xFF, and a blank row stays
 *      undefined rather than becoming 0 (bit 7 clear is a claim; no reading is not).
 *   2. The cells are still written as hex, and a file from another MSS54 tool with `lls_st` /
 *      `md_dyn_st` headers and either case of hex reads too.
 *   3. The general form, so the next column cannot repeat it: a log carrying every channel the
 *      reader knows is written out, and every non-blank cell of every column is something the
 *      reader turns back into a number; then every channel comes back equal.
 *
 *     node --experimental-strip-types --import ./scripts/ts-resolve.mjs scripts/verify-csv-round-trip.mjs
 */
import Papa from 'papaparse';
import { APP_CONFIG } from '../src/config/constants.ts';
import { serializeLogFile } from '../src/lib/log-engine/serializer.ts';
import { parseLogFile, HEX_CSV_KEYS } from '../src/lib/log-engine/parser.ts';

let fails = 0;
const check = (n, c, d) => { console.log('  ' + (c ? 'PASS' : 'FAIL') + '  ' + n + (c ? '' : ' — ' + d)); if (!c) fails++; };
const M = APP_CONFIG.CSV_MAPPING;
const A = APP_CONFIG.CSV_ALIASES;
/** Rows as the reader's own Papa call sees them, before `pick` — what a cell IS on the way in. */
const cells = (csv) => Papa.parse(csv, { header: true, dynamicTyping: true, skipEmptyLines: true, delimiter: '' }).data;

/** The four columns every log needs to parse at all. */
const required = (i) => ({ time: i * 0.25, rpm: 2400, rawLoad: 8.5, stft1: 1.0, stft2: 1.0, rf: 74.0 });

console.log('\n[LLS_ST and MD_DYN_ST come back]');
{
    const points = [
        { ...required(0), llsSt: 0x81, mdDynSt: 0x40 },
        { ...required(1), llsSt: 0x00, mdDynSt: 0x00 },
        { ...required(2) },
        { ...required(3), llsSt: 0xFF, mdDynSt: 0xC0 },
    ];
    const csv = serializeLogFile(points);
    const back = parseLogFile(csv);
    check('four rows back', back.length === 4, back.length);
    check('LLS_ST: every value survives, the blank stays undefined',
        back.every((p, i) => p.llsSt === points[i].llsSt), JSON.stringify(back.map(p => p.llsSt)));
    check('MD_DYN_ST: every value survives, the blank stays undefined',
        back.every((p, i) => p.mdDynSt === points[i].mdDynSt), JSON.stringify(back.map(p => p.mdDynSt)));
    check('...so the bits anyone reads are the bits that went out',
        (back[0].llsSt & 0x80) !== 0 && (back[1].llsSt & 0x80) === 0
        && (back[0].mdDynSt & 0x40) !== 0 && (back[1].mdDynSt & 0x40) === 0);
    const raw = cells(csv);
    check('the cells are still hex for whoever opens the file',
        raw[0][M.LLS_ST] === '0x81' && raw[0][M.MD_DYN_ST] === '0x40' && raw[3][M.LLS_ST] === '0xFF',
        JSON.stringify(raw[0]));
}

console.log('\n[hex from another tool, under the DME\'s own symbols]');
{
    const back = parseLogFile('time;rpm;relativer oeffnungsquerschnitt;lambdaintegrator 1;relative fuellung;lls_st;md_dyn_st\n'
        + '0;800;1.2;1.0;20;0X8a;0x4\n0.25;800;1.2;1.0;20; 0x00 ;\n');
    check('lls_st / md_dyn_st headers, upper-case X, one digit, padding',
        back[0]?.llsSt === 0x8A && back[0]?.mdDynSt === 0x04 && back[1]?.llsSt === 0 && back[1]?.mdDynSt === undefined,
        JSON.stringify(back.map(p => [p.llsSt, p.mdDynSt])));
    const junk = parseLogFile('time;rpm;relativer oeffnungsquerschnitt;lambdaintegrator 1;relative fuellung;lls_st\n'
        + '0;800;1.2;1.0;20;0xZZ\n');
    check('...and a cell that is not hex is not read as anything', junk[0]?.llsSt === undefined, junk[0]?.llsSt);
}

console.log('\n[every column written is a column read]');
{
    // Every channel the reader has a header for, given a value. The three that are not plain
    // LogDataPoint numbers are set the way the serializer decides to write them.
    const special = new Set(['ambientPressureSubstituted', 'ambientTempSubstituted', 'pressureDecodeGap']);
    const full = { ...required(0) };
    let v = 3;
    for (const key of Object.keys(A)) {
        if (special.has(key) || key in full) continue;
        full[key] = HEX_CSV_KEYS.includes(key) ? 0x81 : (v += 1.5);
    }
    full.ambientPressureSubstituted = true;
    full.ambientTempFromCan = false;
    full.pressureDecodeDisagreesMbar = 50;
    const points = [full, { ...required(1) }];
    const csv = serializeLogFile(points);
    const raw = cells(csv);
    const headers = Object.keys(raw[0] ?? {});
    const known = new Set(Object.values(A).flat());
    const unread = headers.filter(h => !known.has(h.toLowerCase()));
    check('every header written is one the reader accepts', unread.length === 0, unread.join(', '));
    const hexHeaders = new Set(HEX_CSV_KEYS.flatMap(k => A[k]));
    const lost = [];
    for (const [i, row] of raw.entries()) {
        for (const h of headers) {
            const c = row[h];
            if (c === null || c === '' || c === undefined) continue;
            const readable = (typeof c === 'number' && Number.isFinite(c))
                || (hexHeaders.has(h.toLowerCase()) && /^\s*0x[0-9a-f]{1,8}\s*$/i.test(String(c)));
            if (!readable) lost.push(`row ${i} "${h}" = ${JSON.stringify(c)}`);
        }
    }
    check('every non-blank cell is one the reader turns into a number', lost.length === 0, lost.join('; '));
    const back = parseLogFile(csv);
    const keys = Object.keys(full).filter(k => typeof full[k] === 'number');
    const differ = keys.filter(k => back[0]?.[k] !== full[k]).map(k => `${k}: ${full[k]} -> ${back[0]?.[k]}`);
    check('every channel comes back equal', differ.length === 0, differ.join('; '));
    const optional = keys.filter(k => !(k in required(1)));
    const filled = optional.filter(k => back[1]?.[k] !== undefined).map(k => `${k} = ${back[1][k]}`);
    check('...and a row that carried none of them gets none back', filled.length === 0, filled.join('; '));
    check('the two flags come back as the flags they were',
        back[0]?.ambientPressureSubstituted === true && back[0]?.ambientTempFromCan === false,
        JSON.stringify([back[0]?.ambientPressureSubstituted, back[0]?.ambientTempFromCan]));
}

console.log(fails === 0 ? '\nALL PASS' : '\n' + fails + ' FAILURE(S)');
process.exit(fails ? 1 : 0);
