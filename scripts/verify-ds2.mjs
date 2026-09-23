/**
 * The DS2 wire format, and the judgements built on top of it.
 *
 * This is the layer every destructive operation goes through, and it was the only one with no test
 * at all — WP1 rearranges the link's retry, abort and baud handling above it, and "the framing still
 * works" was resting on a car being available to say so.
 *
 * Five things are checked, and they are the ones that can be checked without an ECU:
 *
 *   1. **Framing.** A telegram is `[addr][len][control][payload...][xor]`, `len` counts the WHOLE
 *      telegram including itself and the checksum, and the checksum is an XOR of everything before
 *      it. Round-tripping alone is not enough — an encoder and a decoder that share a mistake agree
 *      perfectly — so the byte layout is asserted against literals as well.
 *   2. **Seed/key.** The login the write path depends on. Wrong here means an ECU that refuses to be
 *      programmed, or one that accepts a key derived from the wrong seed.
 *   3. **Echo classification.** The K-line is half duplex, so every request comes back. When what
 *      comes back is NOT the request, `classifyEchoMismatch` decides between "something is pulling
 *      the line down" and "we are reading a stale response in the echo's place" — and the dialog
 *      offers a physical checklist for one and a retry for the other. Getting that backwards sends
 *      somebody to check a connector that is fine.
 *   4. **The verify byte.** What the DME says after a programming telegram: the last word on whether
 *      a flash landed.
 *   5. **The encoding checksum.** The reading a QUICK verify licenses a write on.
 */
import {
    buildDs2Frame, parseDs2Frame, frameToBytes, isPositiveResponse,
    buildReadMemoryPayload, buildWriteMemoryPayload, parseWriteResult, describeVerifyByte,
    buildSeedRequestPayload, buildKeyPayload, calculateLoginKey, isSeedResponse, isAlreadyUnlockedResponse,
    classifyEchoMismatch, Ds2Control, Ds2Status, DS2_DEFAULT_ADDRESS,
    faultedAreas, parseEncodingChecksum, DATA_TUNE_CHECKSUM_BITS,
} from '../src/lib/dme-link/ds2.ts';

let fails = 0;
const check = (n, c, d) => { console.log('  ' + (c ? 'PASS' : 'FAIL') + '  ' + n + (c ? '' : ' — ' + d)); if (!c) fails++; };
const hex = (b) => [...b].map(x => x.toString(16).padStart(2, '0')).join(' ');
/** A frame as it would arrive from the DME. */
const respond = (status, payload) => parseDs2Frame(buildDs2Frame(DS2_DEFAULT_ADDRESS, status, payload));

console.log('\n[framing: length counts itself, checksum is an XOR of everything before it]');
{
    const f = buildDs2Frame(DS2_DEFAULT_ADDRESS, Ds2Control.READ_IO_STATUS, new Uint8Array([3]));
    // [addr][len][0x0B][03][xor] — five bytes, and `len` is 5, not 1.
    check('a block request is exactly 5 bytes', f.length === 5, hex(f));
    check('byte 0 is the address', f[0] === DS2_DEFAULT_ADDRESS, hex(f));
    check('byte 1 is the WHOLE telegram length', f[1] === 5, hex(f));
    check('byte 2 is the control', f[2] === Ds2Control.READ_IO_STATUS, hex(f));
    check('byte 3 is the payload', f[3] === 3, hex(f));
    check('the last byte is the XOR of the rest', f[4] === (f[0] ^ f[1] ^ f[2] ^ f[3]), hex(f));

    // A RAM read: nine bytes, because buildReadMemoryPayload contributes five. This is the request
    // the fast VE profile sends several times a second, so its layout is worth pinning.
    const ram = buildDs2Frame(DS2_DEFAULT_ADDRESS, Ds2Control.READ_MEMORY,
        buildReadMemoryPayload(0x01, 0x00FF80CA, 4));
    check('a RAM read request is exactly 9 bytes', ram.length === 9, hex(ram));
    check('segment, then a 24-bit big-endian address, then the count',
        ram[3] === 0x01 && ram[4] === 0xFF && ram[5] === 0x80 && ram[6] === 0xCA && ram[7] === 0x04,
        hex(ram));
    check('the count is the byte before the checksum', ram[ram.length - 2] === 4, hex(ram));
    check('and the checksum still covers all of it',
        ram[ram.length - 1] === ram.subarray(0, ram.length - 1).reduce((a, b) => a ^ b, 0), hex(ram));
}

console.log('\n[framing: what goes out comes back]');
{
    for (const [name, control, payload] of [
        ['empty payload (keep-alive)', Ds2Control.KEEP_ALIVE, new Uint8Array(0)],
        ['one byte', Ds2Control.READ_IO_STATUS, new Uint8Array([19])],
        ['a write of 123 bytes', Ds2Control.WRITE_MEMORY,
            buildWriteMemoryPayload(0x00, 0x010000, new Uint8Array(123).fill(0xA5))],
    ]) {
        const bytes = buildDs2Frame(DS2_DEFAULT_ADDRESS, control, payload);
        const parsed = parseDs2Frame(bytes);
        check(`${name}: control survives`, parsed.controlOrStatus === control);
        check(`${name}: payload survives byte for byte`,
            parsed.payload.length === payload.length && [...parsed.payload].every((b, i) => b === payload[i]),
            `${parsed.payload.length} vs ${payload.length}`);
        const again = frameToBytes(parsed);
        check(`${name}: re-encoding gives the same bytes`,
            again.length === bytes.length && [...again].every((b, i) => b === bytes[i]), hex(again));
    }
    // buildWriteMemoryPayload's own limit: 123 bytes of data plus 5 of prefix plus 4 of framing is
    // 132, and one more overflows the single-byte length. A caller error, not a truncation.
    let threw = false;
    try { buildWriteMemoryPayload(0x00, 0, new Uint8Array(124)); } catch { threw = true; }
    check('a 124-byte write payload is refused rather than truncated', threw);
}

console.log('\n[framing: a corrupted telegram is rejected, not decoded]');
{
    const good = buildDs2Frame(DS2_DEFAULT_ADDRESS, Ds2Control.READ_IO_STATUS, new Uint8Array([3]));
    const bent = (fn) => { const b = Uint8Array.from(good); fn(b); let t = false; try { parseDs2Frame(b); } catch { t = true; } return t; };
    check('a wrong checksum throws', bent(b => { b[b.length - 1] ^= 0xFF; }));
    check('a length byte that disagrees with the buffer throws', bent(b => { b[1] = 9; }));
    let threw = false;
    try { parseDs2Frame(good.subarray(0, 3)); } catch { threw = true; }
    check('a truncated telegram throws', threw);
}

console.log('\n[positive and negative responses]');
{
    check('status 0xA0 is positive', isPositiveResponse(respond(Ds2Status.ACKNOWLEDGE, new Uint8Array([1, 2, 3]))));
    for (const [name, status] of Object.entries(Ds2Status)) {
        if (status === Ds2Status.ACKNOWLEDGE) continue;
        check(`${name} (0x${status.toString(16)}) is NOT positive`, !isPositiveResponse(respond(status, new Uint8Array(0))));
    }
}

console.log('\n[seed/key: the login the write path rests on]');
{
    const req = buildSeedRequestPayload();
    check('the seed request is ASCII "BMW" plus the access level',
        req.length === 4 && req[0] === 0x42 && req[1] === 0x4D && req[2] === 0x57 && req[3] === 5, hex(req));

    // A 46-byte telegram is the seed; a 5-byte one means the session was already unlocked. Telling
    // them apart is what stops a second login attempt from failing a flash that was fine.
    const seedPayload = Uint8Array.from({ length: 42 }, (_, i) => (i * 7 + 3) & 0xFF);
    const seedFrame = respond(Ds2Status.ACKNOWLEDGE, seedPayload);
    check('a 46-byte positive response is a seed', seedFrame.length === 46 && isSeedResponse(seedFrame), String(seedFrame.length));
    check('and is not mistaken for "already unlocked"', !isAlreadyUnlockedResponse(seedFrame));
    const unlocked = respond(Ds2Status.ACKNOWLEDGE, new Uint8Array([0x00]));
    check('a 5-byte positive response is "already unlocked"', isAlreadyUnlockedResponse(unlocked));
    check('and is not mistaken for a seed', !isSeedResponse(unlocked));
    check('a NEGATIVE 46-byte response is neither',
        !isSeedResponse(respond(Ds2Status.REJECTED, seedPayload))
        && !isAlreadyUnlockedResponse(respond(Ds2Status.REJECTED, new Uint8Array([0]))));

    // The key is a pure function of (access level, seed bytes): same input, same key, and a seed
    // that differs anywhere the algorithm reads must give a different one.
    const bytes = frameToBytes(seedFrame);
    const k1 = calculateLoginKey(5, bytes);
    const k2 = calculateLoginKey(5, bytes);
    check('the key is deterministic', k1 === k2, `${k1} vs ${k2}`);
    const other = Uint8Array.from(bytes); other[18] = (other[18] + 1) & 0xFF;
    check('a different seed gives a different key', calculateLoginKey(5, other) !== k1);
    check('a different access level gives a different key', calculateLoginKey(6, bytes) !== k1);
    check('the key is an unsigned 32-bit value', k1 >= 0 && k1 <= 0xFFFFFFFF, String(k1));
    // A wrong-length seed must throw rather than index past the end and produce a plausible key.
    let threw = false;
    try { calculateLoginKey(5, bytes.subarray(0, 45)); } catch { threw = true; }
    check('a seed of the wrong length is refused, not guessed at', threw);

    const payload = buildKeyPayload(k1);
    check('the key goes out as four big-endian bytes',
        payload.length === 4
        && payload[0] === ((k1 >>> 24) & 0xFF) && payload[1] === ((k1 >>> 16) & 0xFF)
        && payload[2] === ((k1 >>> 8) & 0xFF) && payload[3] === (k1 & 0xFF), hex(payload));
}

console.log('\n[echo classification: which failure is this]');
{
    const req = buildDs2Frame(DS2_DEFAULT_ADDRESS, Ds2Control.READ_IO_STATUS, new Uint8Array([3]));

    // Electrical: something pulls the line low, so bits go 1 -> 0 and the tail is zeros. Retrying
    // cannot help, and the dialog offers a physical checklist instead.
    const pulled = Uint8Array.from(req); pulled[2] = 0; pulled[3] = 0; pulled[4] = 0;
    const a = classifyEchoMismatch(req, pulled);
    check('a line pulled low reads as electrical', a.kind === 'electrical', `${a.kind}: ${a.verdict}`);
    check('and the flips are counted in the right direction', a.flips1to0 > 0 && a.flips0to1 === 0, JSON.stringify(a));
    check('and the zero tail is measured', a.trailingZeroRun > 0, String(a.trailingZeroRun));

    // Desync: what came back is a whole other telegram — a previous response still in the buffer.
    // That one IS worth retrying, after a resync.
    const stale = frameToBytes(respond(Ds2Status.ACKNOWLEDGE, new Uint8Array([0x55, 0x66, 0x77]))).subarray(0, req.length);
    const b = classifyEchoMismatch(req, stale);
    check('a stale response is not called electrical', b.kind !== 'electrical', `${b.kind}: ${b.verdict}`);

    // Every branch has to produce something a dialog can render and branch on.
    for (const [name, got] of [['pulled low', pulled], ['stale', stale], ['all 0xFF', new Uint8Array(req.length).fill(0xFF)]]) {
        const r = classifyEchoMismatch(req, got);
        check(`${name}: the verdict is a non-empty sentence`, typeof r.verdict === 'string' && r.verdict.length > 0);
        check(`${name}: the kind is one the UI branches on`,
            ['electrical', 'desync', 'unclassified'].includes(r.kind), r.kind);
    }
}

console.log('\n[the verify byte: the last word on whether a flash landed]');
{
    // Every value has to map to something a human can read, and only one may read as success.
    const seen = new Set();
    let missing = 0;
    let successes = 0;
    for (let b = 0; b <= 0xFF; b++) {
        const text = describeVerifyByte(b);
        if (typeof text !== 'string' || text.length === 0) missing++;
        seen.add(text);
        if (/^programming OK$/i.test(text)) successes++;
    }
    check('every one of the 256 verify bytes has a description', missing === 0, `${missing} without one`);
    check('exactly one verify byte means success', successes === 1, String(successes));
    check('the descriptions are not one repeated string', seen.size > 3, String(seen.size));

    // parseWriteResult: an empty payload means "no result reported", which is a different fact from
    // a failure and must not be read as one. A short-but-non-empty payload is malformed.
    check('an empty write response reports nothing rather than a failure',
        parseWriteResult(respond(Ds2Status.ACKNOWLEDGE, new Uint8Array(0))) === null);
    let threw = false;
    try { parseWriteResult(respond(Ds2Status.ACKNOWLEDGE, new Uint8Array(5))); } catch { threw = true; }
    check('a 5-byte write response is refused rather than decoded', threw);
    // The result carries the DME's verify byte verbatim rather than a boolean, so the caller can
    // report WHICH failure — see describeVerifyByte's twelve of them. Only 1 is success.
    const ok = parseWriteResult(respond(Ds2Status.ACKNOWLEDGE, Uint8Array.from([0, 0, 0, 0, 0, 1])));
    check('a verify byte of 1 comes back as 1', ok !== null && ok.verifyByte === 1, JSON.stringify(ok));
    const bad = parseWriteResult(respond(Ds2Status.ACKNOWLEDGE, Uint8Array.from([0, 0, 0, 0, 0, 2])));
    check('a verify byte of 2 comes back as 2', bad !== null && bad.verifyByte === 2, JSON.stringify(bad));
    check('and the two do not describe the same thing',
        describeVerifyByte(1) !== describeVerifyByte(2));
    // The address the DME says it will write NEXT, which is how the writer walks the image.
    const walked = parseWriteResult(respond(Ds2Status.ACKNOWLEDGE, Uint8Array.from([0x00, 0x01, 0x23, 0x45, 0x7A, 1])));
    check('the next address comes back big-endian', walked.nextAddress24 === 0x012345, String(walked.nextAddress24));
    check('and the written count with it', walked.writtenCount === 0x7A, String(walked.writtenCount));
}

console.log('\n[the encoding checksum: which areas the DME says are faulted]');
{
    // All bits clear = nothing faulted. This is the reading a QUICK verify licenses a write on, so
    // "no bits set" must never come back as a fault, and a set bit must never come back as clean.
    const clean = parseEncodingChecksum(respond(Ds2Status.ACKNOWLEDGE, Uint8Array.from([0x00, 0x00])));
    check('a clean answer reports no faulted areas', faultedAreas(clean, DATA_TUNE_CHECKSUM_BITS).length === 0);
    for (const bit of DATA_TUNE_CHECKSUM_BITS) {
        const raw = new Uint8Array(2);
        raw[bit >> 3] |= 1 << (bit & 7);
        const dirty = parseEncodingChecksum(respond(Ds2Status.ACKNOWLEDGE, raw));
        const found = faultedAreas(dirty, DATA_TUNE_CHECKSUM_BITS);
        check(`a fault in bit ${bit} is reported`, found.some(a => a.bit === bit),
            found.map(a => a.name).join() || '(none)');
        // ...and only that one. A fault reported in an area the write did not touch would send the
        // operator after the wrong thing.
        check(`and nothing else is`, found.length === 1, found.map(a => a.name).join());
    }
    // A negative response is not a clean bill of health.
    let threw = false;
    try { parseEncodingChecksum(respond(Ds2Status.REJECTED, Uint8Array.from([0x00]))); } catch { threw = true; }
    check('a rejected query throws rather than reading as clean', threw);
    threw = false;
    try { parseEncodingChecksum(respond(Ds2Status.ACKNOWLEDGE, new Uint8Array(3))); } catch { threw = true; }
    check('a 3-byte payload is refused', threw);
}

console.log(fails === 0 ? '\nALL PASS' : '\n' + fails + ' FAILURE(S)');
process.exit(fails ? 1 : 0);
