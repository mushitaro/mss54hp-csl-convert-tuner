/**
 * The CAR IMAGE and the write gate that compares against it.
 *
 * The rule the hub runs on (lib/db/carImage.ts, lib/binary-engine/buildImage.ts, page.tsx):
 *
 *     car image      = the bytes of the session's last REAL flash  (stored, else resolved from the
 *                      flash history's sha256, else the BASE)
 *     pending build  = buildImage(source: car image, base: BASE, every armed row) + checksum
 *     WRITE offered  ⇔ pending build ≠ car image, byte for byte
 *
 * What these checks pin, none of it visible from the UI until it goes wrong in a car:
 *
 *   1. RESOLUTION — a stored car image wins; a record from before it is matched by sha256 against
 *      the three images the app could have sent (a tune write, a FINALIZE, a patch-only write) and
 *      falls back to a stated guess; no real flash means the BASE; PRACTICE never counts.
 *   2. IDEMPOTENCE — the property the gate stands on. An image built with the toggles its own bytes
 *      report, and nothing else armed, comes back byte for byte: stock, PATCH-ON, K HOLD, WOT TH. If
 *      any writer normalised a byte (a restore fallback, the checksum), the ring would offer writes
 *      that change nothing. The one image that must NOT come back is the pre-2026-10-18 TANK VENT
 *      car: the build adds the missing K_TE_TMOT, and that is the write the hub has to offer.
 *   3. THE GATE — OFF over a car that holds the patch is a change (it was not, under "is any toggle
 *      on"), the same toggles are not, and the old valve-only TANK VENT car is offered a write that
 *      carries 0x0BED = 0xFF and nothing else. The restore under a car image puts back the BASE's own
 *      bytes, not the community constants (BinaryPatcher.fallback).
 *   4. SEEDING — a draft's settings saved after its last real flash are its pending intent and are
 *      kept (the stage-2 tune with K HOLD off over a held car); older settings, archived sessions and
 *      sessions with none read the car image; an archived session opens with ALPHA-N off.
 *   5. NEXT — the child's BASE is the parent's car image, its switches and filters are the parent's,
 *      its origin points at the parent itself; the repository persists them without claiming a TUNED.
 *   6. PERSISTENCE AND SYNC — a real flash stores its bytes as the car image in the same write as its
 *      record, a PRACTICE flash stores nothing, a READ stores the bytes read, and the car image
 *      travels through the sync wire while a copy without one still restores.
 *
 * public/mock plus synthetic images only. The repository runs against a minimal in-memory
 * IndexedDB written below — enough of the API for sessionRepository.ts, nothing more.
 */
import { readFileSync } from 'node:fs';
import { buildImage, sameBytes } from '../src/lib/binary-engine/buildImage.ts';
import { BinaryPatcher, patchOnImage, readLogicPatches } from '../src/lib/binary-engine/patcher.ts';
import { BinaryParser } from '../src/lib/binary-engine/parser.ts';
import {
    resolveCarImage, settingsAreCurrent, seedToggles, sessionToggles, nextStart, storedWriteRfKorr,
} from '../src/lib/db/carImage.ts';
import { APP_CONFIG, EXPERIMENTAL_CONFIG, RF_KORR_GATE_FLOOR, TANK_VENT_GAIN, TANK_VENT_TMOT } from '../src/config/constants.ts';
import { analyzeDataChecksum, correctDataChecksum } from '../src/lib/checksum/dmeDataChecksum.ts';
import { DEFAULT_FILTER_CONFIG } from '../src/lib/log-engine/filterDefaults.ts';

let fails = 0;
const check = (n, c, d) => { console.log('  ' + (c ? 'PASS' : 'FAIL') + '  ' + n + (c ? '' : ' — ' + (d ?? ''))); if (!c) fails++; };

// ---- images ---------------------------------------------------------------------------------------

const raw = readFileSync(new URL('../public/mock/csl-0401-community-patch-v1.partial.bin', import.meta.url));
const MOCK = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
const u8 = (b) => new Uint8Array(b);
const diff = (a, b) => { const x = u8(a), y = u8(b), out = []; for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) out.push(i); return out; };
const inSlot = (i) => (i >= 0x3FFC && i <= 0x3FFF) || (i >= 0xBFFC && i <= 0xBFFF);
const hex = (xs) => xs.slice(0, 8).map(i => '0x' + i.toString(16).toUpperCase()).join(',') + (xs.length > 8 ? ` …(${xs.length})` : '');
const valid = (b) => analyzeDataChecksum(u8(b)).every(s => s.isValid);

const NONE = { applyPatch: false, applyWotDisable: false, applyTankVentDisable: false, applyRfKorrHold: false };
/** Every toggle a build reads, the logic patches as given and every derived row off. */
const toggles = (logic) => ({
    ...NONE, ...logic,
    writeWarmup: false, restoreWotFuel: false, restoreVe: false, restoreWarmup: false, writeVe: false,
});
/** The toggles an image's own bytes seed — what useBinaryFile.uploadBinary arms from it. */
const seeded = (image) => {
    const p = readLogicPatches(image);
    return toggles({
        applyPatch: p.applyPatch, applyWotDisable: p.applyWotDisable,
        applyTankVentDisable: p.applyTankVentDisable, applyRfKorrHold: !!p.applyRfKorrHold,
    });
};
const build = (source, base, t, newMap = null, extras = {}) => buildImage({ source, base, newMap, toggles: t, extras });

const PATCH_ON = { applyPatch: true, applyWotDisable: false, applyTankVentDisable: true, applyRfKorrHold: true };
const patchOn = patchOnImage(MOCK, PATCH_ON);
const kHold = patchOnImage(MOCK, { ...NONE, applyPatch: true, applyRfKorrHold: true });
const wotTh = patchOnImage(MOCK, { ...NONE, applyWotDisable: true });
/** The pre-2026-10-18 TANK VENT: the valve shut, K_TE_TMOT stock — what a READ off such a car gives. */
const oldValveOnly = (() => {
    const b = u8(MOCK).slice();
    b[TANK_VENT_GAIN.ADDRESS] = TANK_VENT_GAIN.DISABLED_RAW;
    correctDataChecksum(b);
    return b.buffer;
})();

console.log('\n[the images these checks stand on]');
check('the community partial validates (else nothing below tests anything)', valid(MOCK));
check('PATCH-ON, K HOLD and WOT TH images are built and valid', valid(patchOn) && valid(kHold) && valid(wotTh));
check('...and each reads back as what it is',
    readLogicPatches(patchOn).applyPatch && readLogicPatches(patchOn).applyRfKorrHold
    && readLogicPatches(kHold).applyRfKorrHold && readLogicPatches(wotTh).applyWotDisable);
check('the old valve-only car validates, valve shut, K_TE_TMOT stock',
    valid(oldValveOnly) && u8(oldValveOnly)[TANK_VENT_GAIN.ADDRESS] === 0x00
    && u8(oldValveOnly)[TANK_VENT_TMOT.ADDRESS] === TANK_VENT_TMOT.STOCK_RAW);

// ---- 2. idempotence -------------------------------------------------------------------------------

console.log('\n[idempotence: an image built with its own toggles and nothing else armed comes back unchanged]');
for (const [name, image] of [['stock', MOCK], ['PATCH-ON', patchOn], ['K HOLD', kHold], ['WOT TH', wotTh]]) {
    // Both ways a car image meets a build: a draft that never wrote (the car IS the BASE), and a
    // session whose car image moved on from a stock BASE.
    const asDraft = build(image, image, seeded(image));
    const overBase = build(image, MOCK, seeded(image));
    check(`${name}: built from itself as its own BASE — byte-identical`, sameBytes(asDraft, image), hex(diff(asDraft, image)));
    check(`${name}: built from itself over the stock BASE — byte-identical`, sameBytes(overBase, image), hex(diff(overBase, image)));
}
{
    // The one that must NOT come back: the toggle seeds ON from the valve byte, and the build adds
    // the second byte — so the gate offers WRITE PATCH-ON instead of calling this car done.
    const t = seeded(oldValveOnly);
    check('old valve-only TANK VENT: the toggle seeds ON from the valve byte', t.applyTankVentDisable === true);
    const b = build(oldValveOnly, oldValveOnly, t);
    check('...and the build is NOT identical — that difference is the write to offer', !sameBytes(b, oldValveOnly));
}

// ---- 3. the gate -----------------------------------------------------------------------------------

console.log('\n[the gate: build ≠ car image]');
{
    // PATCH-ON car, PATCH switched off (FINALIZE). Under "is any toggle on" this was nothing to write.
    const off = build(patchOn, MOCK, toggles(NONE));
    check('PATCH-ON car + every patch OFF: differs — an OFF is a change', !sameBytes(off, patchOn));
    check('...and the build is the stock BASE, byte for byte', sameBytes(off, MOCK), hex(diff(off, MOCK)));
    check('PATCH-ON car + the same toggles: identical — nothing to write', sameBytes(build(patchOn, MOCK, toggles(PATCH_ON)), patchOn));
    check('PATCH-ON car + K HOLD alone switched off: differs, and only in the floor and the checksum',
        (() => {
            const b = build(patchOn, MOCK, toggles({ ...PATCH_ON, applyRfKorrHold: false }));
            const moved = diff(b, patchOn).filter(i => !inSlot(i));
            const f = RF_KORR_GATE_FLOOR.VALUES_ADDRESS;
            return moved.length > 0 && moved.every(i => i >= f && i < f + RF_KORR_GATE_FLOOR.POINTS * 2);
        })());
}
{
    // The old valve-only car with TANK VENT armed — moved here from verify:tankvent-patch, where it
    // was asked of the retired `tankVentDrift`.
    const t = seeded(oldValveOnly);
    const b = build(oldValveOnly, oldValveOnly, t);
    const moved = diff(b, oldValveOnly).filter(i => !inSlot(i));
    check('old valve-only car + TANK VENT armed: the write carries 0x0BED = 0xFF', u8(b)[TANK_VENT_TMOT.ADDRESS] === 0xFF);
    check('...the valve still shut', u8(b)[TANK_VENT_GAIN.ADDRESS] === 0x00);
    check('...and nothing else outside the checksum moves', moved.length === 1 && moved[0] === TANK_VENT_TMOT.ADDRESS, hex(moved));
    check('...with a valid checksum', valid(b));
    check('written, it is the new car image: the same toggles now build it unchanged', sameBytes(build(b, oldValveOnly, t), b));
}
{
    // A draft that never wrote: the car is the BASE. Nothing armed is nothing to write; a derived map
    // armed is a write.
    check('fresh draft, nothing armed: identical — no write offered', sameBytes(build(MOCK, MOCK, seeded(MOCK)), MOCK));
    const map = new BinaryParser(MOCK).getVETable();
    const tuned = { ...map, data: map.data.map(r => [...r]) };
    tuned.data[5][5] = Math.round((tuned.data[5][5] * 1.03) * 1000) / 1000;
    const armed = build(MOCK, MOCK, { ...seeded(MOCK), writeVe: true }, tuned);
    check('fresh draft, a derived map armed: differs', !sameBytes(armed, MOCK));
    check('the same map NOT armed (ALPHA-N off): identical', sameBytes(build(MOCK, MOCK, seeded(MOCK), tuned), MOCK));
    // After that tune went out the car holds it; re-arming the same map is no change, which is what
    // keeps a re-derived but unchanged map from offering a phantom write.
    check('the car holding that map + the same map armed: identical', sameBytes(build(armed, MOCK, { ...seeded(armed), writeVe: true }, tuned), armed));
}
{
    // The restore under a car image goes back to the BASE's OWN bytes. A BASE with its own MAP
    // config, LTFT floor, WOT table, purge calibration and rf_korr floor — none of them this app's
    // patch values and none of them the community constants.
    const own = u8(MOCK).slice();
    const C = APP_CONFIG.MSS54HP;
    own[C.ADDRESS_MAP_CONFIG] = 0x01;
    own[C.ADDRESS_TEMP_LIMIT] = 80 + 48;
    own[TANK_VENT_GAIN.ADDRESS] = 0x40;
    own[TANK_VENT_TMOT.ADDRESS] = 0x70;
    const w = EXPERIMENTAL_CONFIG.ADDRESS_WOT_THRESHOLD_MAP;
    own[w] = 0x01; own[w + 1] = 0x68;   // 36.0 % in the first cell
    const f = RF_KORR_GATE_FLOOR.VALUES_ADDRESS;
    own[f] = 0x02; own[f + 1] = 0xD0;   // 720 in the first point
    correctDataChecksum(own);
    const OWN = own.buffer;
    const ALL = { applyPatch: true, applyWotDisable: true, applyTankVentDisable: true, applyRfKorrHold: true };
    const car = build(OWN, OWN, toggles(ALL));
    check('every patch written over a BASE of its own: all four read ON', (() => {
        const p = readLogicPatches(car);
        return p.applyPatch && p.applyWotDisable && p.applyTankVentDisable && p.applyRfKorrHold;
    })());
    const back = build(car, OWN, toggles(NONE));
    check('all OFF over that car image, the BASE as fallback: back to the BASE byte for byte',
        sameBytes(back, OWN), hex(diff(back, OWN)));
    // Control: the same restore with nothing beneath it lands on the community constants instead —
    // which is what a build from the car image alone would have shipped.
    const p = new BinaryPatcher(car);
    p.enableMapCorrection(); p.setWOTThreshold(false); p.setTankVentDisable(false); p.setRfKorrGateFloor('stock');
    p.applyChecksumCorrection();
    const alone = p.getBuffer();
    check('control: without the fallback the restore is the community values, not the car\'s own',
        u8(alone)[C.ADDRESS_MAP_CONFIG] === 0x12 && u8(alone)[TANK_VENT_TMOT.ADDRESS] === TANK_VENT_TMOT.STOCK_RAW
        && !sameBytes(alone, OWN));
}

// ---- 1. resolution ---------------------------------------------------------------------------------

const sha = async (b) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', b)))
    .map(x => x.toString(16).padStart(2, '0')).join('');
const flash = async (bytes, over = {}) => ({
    at: over.at ?? 1, sha256: over.sha256 ?? await sha(bytes), verifyMode: 'quick',
    tuned: over.tuned, practice: over.practice,
    settings: { ...NONE, writeWarmup: false, ...(over.settings ?? {}) },
});

console.log('\n[resolution: stored, then the last real flash by sha256, then the BASE]');
{
    const stored = await resolveCarImage({ flashHistory: [await flash(patchOn, { settings: PATCH_ON })], base: MOCK, stored: kHold });
    check('a stored car image wins outright', stored.source === 'stored' && sameBytes(stored.image, kHold));

    const none = await resolveCarImage({ flashHistory: [], base: MOCK });
    check('no flash at all: the BASE', none.source === 'base' && sameBytes(none.image, MOCK));

    // A tune written from a draft: the bytes sent are the stored TUNED.
    const map = new BinaryParser(MOCK).getVETable();
    map.data[3][3] = Math.round(map.data[3][3] * 1.05 * 1000) / 1000;
    const TUNED = build(MOCK, MOCK, toggles(PATCH_ON), map, {});
    const tuneFlash = await resolveCarImage({
        flashHistory: [await flash(TUNED, { tuned: true, settings: PATCH_ON })], base: MOCK, tuned: TUNED });
    check('legacy tune flash: matched to the stored TUNED', tuneFlash.source === 'flash' && sameBytes(tuneFlash.image, TUNED));

    // A FINALIZE: built from the stored TUNED with every patch off.
    const fin = patchOnImage(TUNED, NONE);
    const finFlash = await resolveCarImage({
        flashHistory: [await flash(TUNED, { at: 1, tuned: true, settings: PATCH_ON }), await flash(fin, { at: 2, tuned: true })],
        base: MOCK, tuned: TUNED });
    check('legacy FINALIZE flash: matched to patchOnImage(TUNED, off)', finFlash.source === 'flash' && sameBytes(finFlash.image, fin));

    // A patch-only write from the BASE (WRITE PATCH-ON before the first run).
    const pOnly = await resolveCarImage({ flashHistory: [await flash(patchOn, { tuned: false, settings: PATCH_ON })], base: MOCK });
    check('legacy patch-only flash: matched to patchOnImage(BASE, settings)', pOnly.source === 'flash' && sameBytes(pOnly.image, patchOn));

    // A hash nothing matches: the guess, stated as one.
    const guess = await resolveCarImage({
        flashHistory: [await flash(patchOn, { sha256: 'f'.repeat(64), settings: PATCH_ON })], base: MOCK, tuned: TUNED });
    check('no candidate matches: the guess patchOnImage(TUNED, settings), labelled a guess',
        guess.source === 'flash-guess' && sameBytes(guess.image, patchOnImage(TUNED, PATCH_ON)));

    // PRACTICE moved no bytes in any car.
    const practiceOnly = await resolveCarImage({ flashHistory: [await flash(patchOn, { practice: true, settings: PATCH_ON })], base: MOCK });
    check('a PRACTICE flash alone: still the BASE', practiceOnly.source === 'base' && sameBytes(practiceOnly.image, MOCK));
    const practiceAfter = await resolveCarImage({
        flashHistory: [await flash(patchOn, { at: 1, settings: PATCH_ON }), await flash(MOCK, { at: 2, practice: true })], base: MOCK });
    check('a PRACTICE finalize after a real PATCH-ON: the car still holds the patch', sameBytes(practiceAfter.image, patchOn));
}

// ---- 4. seeding ------------------------------------------------------------------------------------

console.log('\n[seeding: pending intent, or the car]');
{
    const settings = (over = {}) => ({
        filterConfig: DEFAULT_FILTER_CONFIG, interpolationTable: [],
        applyPatch: true, applyWotDisable: false, applyTankVentDisable: true, applyRfKorrHold: false,
        writeWarmup: false, writeVe: true, ...over,
    });
    const realHeld = await flash(kHold, { at: 100, settings: { applyPatch: true, applyRfKorrHold: true } });
    // Stage 2: the car holds K HOLD; the operator saved the next tune with it OFF after that flash.
    const stage2 = { status: 'draft', tuneSettings: settings(), settingsAt: 200, flashHistory: [realHeld] };
    check('a draft saved AFTER its last real flash keeps its settings', settingsAreCurrent(stage2));
    check('...so K HOLD stays OFF over a car that holds it', seedToggles(stage2)?.applyRfKorrHold === false
        && sessionToggles(stage2, kHold).applyRfKorrHold === false);
    const stale = { ...stage2, settingsAt: 50 };
    check('settings OLDER than the last flash are not current', !settingsAreCurrent(stale));
    check('...the logic patches are left to the car image', seedToggles(stale)?.applyRfKorrHold === undefined
        && sessionToggles(stale, kHold).applyRfKorrHold === true);
    check('...and the rest of the draft\'s arming is kept', seedToggles(stale)?.writeVe === true);
    const legacy = { status: 'draft', tuneSettings: settings(), flashHistory: [realHeld] };
    check('no settingsAt with a real flash behind it reads as older — the rule it reopened under before',
        !settingsAreCurrent(legacy));
    const neverWritten = { status: 'draft', tuneSettings: settings(), flashHistory: [] };
    check('a draft that never wrote keeps its settings', settingsAreCurrent(neverWritten)
        && seedToggles(neverWritten)?.applyPatch === true);
    const practiceAfter = { ...stage2, settingsAt: 150, flashHistory: [realHeld, await flash(MOCK, { at: 300, practice: true })] };
    check('a PRACTICE flash after the settings does not age them', settingsAreCurrent(practiceAfter));
    const archived = { status: 'archived', tuneSettings: settings({ writeRfKorr: true }), settingsAt: 999, flashHistory: [realHeld] };
    const a = seedToggles(archived);
    check('archived: never "current", whatever the dates say', !settingsAreCurrent(archived));
    check('archived: the logic patches come from the car', a?.applyPatch === undefined && sessionToggles(archived, kHold).applyRfKorrHold === true);
    check('archived: ALPHA-N and every derived row open OFF',
        a?.writeVe === false && a?.writeRfKorr === false && a?.writeWarmup === false
        && a?.restoreVe === false && a?.restoreWarmup === false && a?.restoreWotFuel === false);
    check('no settings, a draft: a fresh load (everything detected)', seedToggles({ status: 'draft', flashHistory: [] }) === undefined);
    check('stored writeRfKorr: the field, else the legacy mode', storedWriteRfKorr(settings({ writeRfKorr: true })) === true
        && storedWriteRfKorr(settings()) === false);
}

// ---- 5. NEXT ---------------------------------------------------------------------------------------

console.log('\n[NEXT: the parent\'s car, switches and filters]');
{
    const filters = { ...DEFAULT_FILTER_CONFIG, minTemp: 71 };
    const table = [{ input: 0, output: 0 }, { input: 100, output: 100 }];
    const start = nextStart({ id: 'parent-1' }, {
        carImage: kHold, toggles: { ...NONE, applyPatch: true, applyRfKorrHold: false },
        filterConfig: filters, interpolationTable: table,
    });
    check('the child\'s BASE is the parent\'s car image, byte for byte', sameBytes(start.base, kHold));
    check('...as a copy of its own', start.base !== kHold);
    check('the origin points at the parent itself, as the car',
        start.origin.kind === 'session' && start.origin.sessionId === 'parent-1' && start.origin.which === 'car');
    check('the switches are the parent\'s', start.settings.applyPatch === true && start.settings.applyRfKorrHold === false
        && start.settings.applyTankVentDisable === false && start.settings.applyWotDisable === false);
    check('the filters and the RO table are the parent\'s', start.settings.filterConfig.minTemp === 71 && start.settings.interpolationTable === table);
    check('ALPHA-N armed as on any fresh load; the derived rows are not carried',
        start.settings.writeVe === true && start.settings.writeRfKorr === false && start.settings.writeWarmup === false
        && start.settings.restoreVe === false && start.settings.highDeltaGuard === undefined && start.settings.calibrationEdits === undefined);
    // The parent switched K HOLD off and did not write it: the child offers that write at once.
    const childBuild = build(start.base, start.base, toggles({
        applyPatch: start.settings.applyPatch, applyWotDisable: start.settings.applyWotDisable,
        applyTankVentDisable: start.settings.applyTankVentDisable, applyRfKorrHold: start.settings.applyRfKorrHold }));
    check('inherited toggles that differ from the child\'s BASE: the child is offered the write', !sameBytes(childBuild, start.base));
    // ...and inherited toggles that match it offer nothing.
    const same = nextStart({ id: 'p' }, { carImage: kHold, toggles: { ...NONE, applyPatch: true, applyRfKorrHold: true },
        filterConfig: filters, interpolationTable: table });
    check('inherited toggles that match the car: nothing to write', sameBytes(build(same.base, same.base, toggles({
        applyPatch: true, applyWotDisable: false, applyTankVentDisable: false, applyRfKorrHold: true })), same.base));
}

// ---- 6. persistence and sync ----------------------------------------------------------------------

/**
 * Enough IndexedDB for sessionRepository.ts: open with an upgrade, object stores keyed by a path,
 * get / put / delete / getAll / index().getAll, transactions that complete once the microtasks
 * their requests queued have run. Values are structured-cloned in and out, as the real store does.
 */
globalThis.indexedDB = (() => {
    const dbs = new Map();
    const req = (fn) => {
        const r = { result: undefined, error: null, onsuccess: null, onerror: null };
        queueMicrotask(() => { try { r.result = fn(); r.onsuccess?.(); } catch (e) { r.error = e; r.onerror?.(); } });
        return r;
    };
    const storeApi = (st) => ({
        get: (k) => req(() => (st.rows.has(k) ? structuredClone(st.rows.get(k)) : undefined)),
        put: (v) => req(() => { const c = structuredClone(v); st.rows.set(c[st.keyPath], c); return c[st.keyPath]; }),
        delete: (k) => req(() => { st.rows.delete(k); }),
        getAll: () => req(() => [...st.rows.values()].map(v => structuredClone(v))),
        index: (field) => ({ getAll: () => req(() => [...st.rows.values()].map(v => structuredClone(v)).sort((a, b) => a[field] - b[field])) }),
        createIndex: () => { },
    });
    return {
        open(name, version) {
            const r = { result: undefined, error: null, onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null };
            queueMicrotask(() => {
                if (!dbs.has(name)) dbs.set(name, { version: 0, stores: new Map() });
                const db = dbs.get(name);
                r.result = {
                    objectStoreNames: { contains: (n) => db.stores.has(n) },
                    createObjectStore: (n, o) => { const st = { keyPath: o.keyPath, rows: new Map() }; db.stores.set(n, st); return storeApi(st); },
                    deleteObjectStore: (n) => { db.stores.delete(n); },
                    transaction: () => {
                        const tx = { error: null, onerror: null, onabort: null, objectStore: (n) => storeApi(db.stores.get(n)) };
                        Object.defineProperty(tx, 'oncomplete', { set(fn) { setTimeout(fn, 0); } });
                        return tx;
                    },
                    close() { },
                    onversionchange: null,
                };
                if (db.version < version) { const oldVersion = db.version; db.version = version; r.onupgradeneeded?.({ oldVersion }); }
                r.onsuccess?.();
            });
            return r;
        },
    };
})();

const repo = await import('../src/lib/db/sessionRepository.ts');
const wire = await import('../src/lib/session-sync/client.ts');

console.log('\n[the car image is stored by a real flash, never by a rehearsal]');
{
    const s = await repo.createDraft();
    await repo.setSessionBase({ sessionId: s.id, baseOrigin: { kind: 'upload', fileName: 'x.bin' }, baseBinaryBuffer: MOCK, baseFileName: 'x.bin' });
    let bins = await repo.getSessionBinaries(s.id);
    check('an upload stores no car image (the BASE is the car until something is written)', !bins.carBinaryBuffer);

    await repo.appendFlashRecord(s.id, await flash(patchOn, { at: 10, practice: true, settings: PATCH_ON }), patchOn);
    bins = await repo.getSessionBinaries(s.id);
    check('a PRACTICE flash is recorded and stores no car image', !bins.carBinaryBuffer
        && (await repo.listSessions()).find(x => x.id === s.id).flashHistory.length === 1);

    await repo.appendFlashRecord(s.id, await flash(patchOn, { at: 20, settings: PATCH_ON }), patchOn);
    bins = await repo.getSessionBinaries(s.id);
    check('a real flash stores its bytes as the car image', sameBytes(bins.carBinaryBuffer, patchOn));
    const session = (await repo.listSessions()).find(x => x.id === s.id);
    const car = await resolveCarImage({ flashHistory: session.flashHistory, base: bins.baseBinaryBuffer, tuned: bins.tunedBinaryBuffer, stored: bins.carBinaryBuffer });
    check('...which is what a reopen resolves', car.source === 'stored' && sameBytes(car.image, patchOn));
    // The BASE stays the BASE: the patch-only write no longer reloads the workspace onto the sent bytes.
    check('the BASE is untouched by the write', sameBytes(bins.baseBinaryBuffer, MOCK));

    // A tune saved later is dated, and a later save makes the settings current again.
    const saved = await repo.saveTune({ sessionId: s.id, binaryFileName: 't.bin', tunedBinaryBuffer: patchOn,
        tuneSettings: { filterConfig: DEFAULT_FILTER_CONFIG, interpolationTable: [], ...PATCH_ON, applyRfKorrHold: false, writeWarmup: false }, log: null });
    check('saveTune dates the settings', typeof saved.settingsAt === 'number' && saved.settingsAt >= 20);
    check('...so they read as the pending intent', settingsAreCurrent(saved));
    const pinned = await repo.saveTune({ sessionId: s.id, binaryFileName: 't.bin', tunedBinaryBuffer: patchOn,
        tuneSettings: saved.tuneSettings, log: null, settingsAt: 20 });
    check('settings pinned at the flash\'s own time are not newer than it', pinned.settingsAt === 20 && !settingsAreCurrent(pinned));
    bins = await repo.getSessionBinaries(s.id);
    check('a save keeps the stored car image', sameBytes(bins.carBinaryBuffer, patchOn));
}
{
    // A READ is the car, known.
    const s = await repo.createDraft();
    await repo.setSessionBase({ sessionId: s.id, baseOrigin: { kind: 'dme', readAt: 1 }, baseBinaryBuffer: kHold, baseFileName: 'r.bin', carBinaryBuffer: kHold });
    const bins = await repo.getSessionBinaries(s.id);
    check('a READ stores the bytes read as the car image', sameBytes(bins.carBinaryBuffer, kHold));
}
{
    // NEXT through the repository: the parent link, the settings, and no TUNED.
    const parent = await repo.createDraft();
    const start = nextStart(parent, { carImage: patchOn, toggles: { ...PATCH_ON }, filterConfig: DEFAULT_FILTER_CONFIG, interpolationTable: [] });
    const child = await repo.createDraft();
    const after = await repo.setSessionBase({ sessionId: child.id, baseOrigin: start.origin, baseBinaryBuffer: start.base,
        baseFileName: 'c.bin', tuneSettings: start.settings });
    check('NEXT child: parentSessionId is the parent', after.parentSessionId === parent.id);
    check('...its settings are persisted and dated', after.tuneSettings?.applyRfKorrHold === true && typeof after.settingsAt === 'number');
    check('...and it claims no TUNED', !after.sha256 && !(await repo.getSessionBinaries(child.id)).tunedBinaryBuffer);
    check('...so its reopen keeps them (no flash yet)', settingsAreCurrent(after) && seedToggles(after)?.applyPatch === true);
}

console.log('\n[the sync wire carries the car image, and an old copy without one still restores]');
{
    const rec = { sessionId: 's', baseBinaryBuffer: MOCK, tunedBinaryBuffer: null, carBinaryBuffer: patchOn };
    const w = wire.toWireBinaries(rec);
    const back = wire.fromWireBinaries(JSON.parse(JSON.stringify(w)), 's');
    check('round trip keeps the car image byte for byte', sameBytes(back.carBinaryBuffer, patchOn) && sameBytes(back.baseBinaryBuffer, MOCK));
    const noCar = wire.toWireBinaries({ ...rec, carBinaryBuffer: null });
    check('a record without one sends no `car` key', !('car' in noCar));
    const old = wire.fromWireBinaries({ base: noCar.base, tuned: null }, 's');
    check('a copy stored before the field restores with none', old.carBinaryBuffer === null && sameBytes(old.baseBinaryBuffer, MOCK));
}

console.log(fails === 0 ? '\nALL PASS' : '\n' + fails + ' FAILURE(S)');
process.exit(fails ? 1 : 0);
