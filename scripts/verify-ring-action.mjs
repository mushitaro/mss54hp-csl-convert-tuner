/**
 * What the hub's ring offers after a run — START TUNE, until a tune is ARMED.
 *
 * The defect (operator, 2026-10-24): 「同じセッションで2個以上（2本目のラン）取れるようにしてあるはずなのに、
 * 画面がWRITEを要求していてSTART TUNEできない」. The VE chain's first test was `newMap ? 'write'`, so the
 * first run that derived a map held the ring on WRITE for good, while a session has kept several runs
 * since 7b1ebc5. Option A, approved: after a run the ring is START TUNE, and writing the tune is the
 * explicit arm of a row that writes it. ALPHA-N loads OFF for it.
 *
 * Pinned here, as a pure function and against real bytes:
 *
 *   1. THE CHAIN — `veRingAction` (lib/hub/ringAction.ts). A derived map with nothing armed is START
 *      TUNE in a draft and READ in an archived session; ALPHA-N or WARMUP armed is WRITE (SHAPE rides
 *      on ALPHA-N, so it is not an input); a stored arm with no map is not; RF KORR, CALIBRATION and the
 *      patch gate keep their rungs and their archived rules.
 *   2. THE GATE STILL HOLDS — the inputs computed from `buildImage` on public/mock, as the page
 *      computes them: ALPHA-N armed over a tune the car lacks is a live WRITE; nothing armed with the
 *      build equal to the car offers no write at all; a patch-only change is WRITE PATCH and live; an
 *      armed tune the car already holds is WRITE, dead, under "the car holds exactly these bytes".
 *   3. THE NOTICE — `tuneAwaitsArm`: said exactly when START TUNE stands over an unarmed map and the
 *      ALPHA-N row can be thrown, and the copy names ALPHA-N and START TUNE in both languages.
 *   4. THE DEFAULT AND ITS CALLERS — read off the source: the hook loads ALPHA-N OFF (and nothing in
 *      src sets it ON by default), the page asks `veRingAction` with the toggles the build reads,
 *      ranks the notice under the faults, and offers DOWNLOAD TUNED only when the build carries a
 *      tune; `writeClaimsTune` counts an armed WARMUP, so a WRITE ring never confirms as "no tune".
 *
 * Seeding (a current draft keeps its saved arm, NEXT does not carry it ON) is verify:car-image's.
 */
import { readFileSync } from 'node:fs';
import { veRingAction, tuneArmed, tuneAwaitsArm } from '../src/lib/hub/ringAction.ts';
import { buildImage, sameBytes } from '../src/lib/binary-engine/buildImage.ts';
import { readLogicPatches } from '../src/lib/binary-engine/patcher.ts';
import { BinaryParser } from '../src/lib/binary-engine/parser.ts';
import { writeClaimsTune } from '../src/hooks/useBinaryFile.ts';
import { MANIFEST_TEXT } from '../src/lib/manifest-text.ts';
import { DIALOG_TEXT } from '../src/lib/dialog-text.ts';

let fails = 0;
const check = (n, c, d) => { console.log('  ' + (c ? 'PASS' : 'FAIL') + '  ' + n + (c ? '' : ' — ' + (d ?? ''))); if (!c) fails++; };

/** A connected draft with a BASE: the state the operator was standing in. Override per case. */
const DRAFT = {
    tuneDerived: false, writeVe: false, writeWarmup: false, rfKorrArmed: false, calEditsArmed: false,
    writeChangesCar: false, hasBase: true, hasSession: true, archived: false,
};
const ring = (over) => veRingAction({ ...DRAFT, ...over });

// ---- 1. the chain ----------------------------------------------------------------------------------

console.log('\n[the chain: an armed tune is WRITE, a derived one is not]');
check('derived map, nothing armed, draft: START TUNE — the second run can start',
    ring({ tuneDerived: true }) === 'tune', ring({ tuneDerived: true }));
check('derived map, ALPHA-N armed: WRITE', ring({ tuneDerived: true, writeVe: true, writeChangesCar: true }) === 'write');
check('derived map, WARMUP armed alone: WRITE — it builds kf_rf_soll_kath from the map',
    ring({ tuneDerived: true, writeWarmup: true, writeChangesCar: true }) === 'write');
check('a stored ALPHA-N arm with no map derived: not WRITE (nothing to write from)',
    ring({ writeVe: true }) === 'tune' && !tuneArmed({ tuneDerived: false, writeVe: true, writeWarmup: true }));
check('archived, derived map, nothing armed: READ', ring({ tuneDerived: true, archived: true }) === 'read');
check('archived, derived map, ALPHA-N armed by hand: WRITE (the arm is the decision)',
    ring({ tuneDerived: true, archived: true, writeVe: true, writeChangesCar: true }) === 'write');

console.log('\n[the rungs below it are the chain as it was]');
check('patch change only (no map): WRITE PATCH', ring({ writeChangesCar: true }) === 'writePatch');
check('derived map, nothing armed, a patch change: WRITE PATCH outranks START TUNE',
    ring({ tuneDerived: true, writeChangesCar: true }) === 'writePatch');
check('archived + a patch change: WRITE PATCH (finalising is an archived session\'s job)',
    ring({ archived: true, writeChangesCar: true }) === 'writePatch');
check('RF KORR armed in a draft: WRITE PATCH', ring({ rfKorrArmed: true }) === 'writePatch');
check('...not in an archived session', ring({ rfKorrArmed: true, archived: true }) === 'read');
check('CALIBRATION edit armed in a draft: WRITE PATCH', ring({ calEditsArmed: true }) === 'writePatch');
check('...not in an archived session', ring({ calEditsArmed: true, archived: true }) === 'read');
check('no session: READ', ring({ hasSession: false }) === 'read' && ring({ hasSession: false, writeChangesCar: true }) === 'read');
check('no BASE: READ', ring({ hasBase: false }) === 'read');

// ---- 2. the gate, on real bytes ---------------------------------------------------------------------

console.log('\n[the write gate still holds — inputs built from public/mock, as the page builds them]');
{
    const raw = readFileSync(new URL('../public/mock/csl-0401-community-patch-v1.partial.bin', import.meta.url));
    const MOCK = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
    const p = readLogicPatches(MOCK);
    /** What uploadBinary seeds from these bytes: the logic patches as they read, every write row OFF. */
    const seeded = {
        applyPatch: p.applyPatch, applyWotDisable: p.applyWotDisable,
        applyTankVentDisable: p.applyTankVentDisable, applyRfKorrHold: !!p.applyRfKorrHold,
        writeWarmup: false, restoreWotFuel: false, restoreVe: false, restoreWarmup: false, writeVe: false,
    };
    const map = new BinaryParser(MOCK).getVETable();
    const tuned = { ...map, data: map.data.map(r => [...r]) };
    tuned.data[5][5] = Math.round((tuned.data[5][5] * 1.03) * 1000) / 1000;

    /** page.tsx in miniature: pendingBuild → writeChangesCar → veRingAction → the ring's enabled state. */
    const hub = ({ car = MOCK, toggles = {}, newMap = tuned, archived = false }) => {
        const t = { ...seeded, ...toggles };
        const pending = buildImage({ source: car, base: MOCK, newMap, toggles: t, extras: {} });
        const writeChangesCar = !sameBytes(pending, car);
        const action = veRingAction({
            ...DRAFT, archived, writeChangesCar,
            tuneDerived: !!newMap, writeVe: t.writeVe, writeWarmup: t.writeWarmup,
        });
        // dmeButtonConfig: WRITE and WRITE PATCH are disabled exactly when the build equals the car.
        const live = action === 'write' || action === 'writePatch' ? writeChangesCar : true;
        return { action, live, pending, writeChangesCar };
    };

    const idle = hub({});
    check('a run derived a map, nothing armed, build == car: START TUNE, and no WRITE anywhere',
        idle.action === 'tune' && !idle.writeChangesCar, JSON.stringify({ a: idle.action, w: idle.writeChangesCar }));
    const armed = hub({ toggles: { writeVe: true } });
    check('ALPHA-N armed over a tune the car lacks: WRITE, enabled', armed.action === 'write' && armed.live);
    const warm = hub({ toggles: { writeWarmup: true } });
    check('WARMUP armed alone: WRITE, enabled', warm.action === 'write' && warm.live);
    const patchOnly = hub({ newMap: null, toggles: { applyPatch: !seeded.applyPatch } });
    check('a patch-only change: WRITE PATCH, enabled', patchOnly.action === 'writePatch' && patchOnly.live);
    const patchOverTune = hub({ toggles: { applyPatch: !seeded.applyPatch } });
    check('...and the same with a map waiting unarmed: still WRITE PATCH, and the map is not in it',
        patchOverTune.action === 'writePatch' && patchOverTune.live
        && sameBytes(patchOverTune.pending, buildImage({ source: MOCK, base: MOCK, newMap: null,
            toggles: { ...seeded, applyPatch: !seeded.applyPatch }, extras: {} })));
    const holds = hub({ car: armed.pending, toggles: { writeVe: true } });
    check('an armed tune the car already holds: WRITE, disabled (the carHoldsThis line)',
        holds.action === 'write' && !holds.live);
    const archived = hub({ archived: true });
    check('archived, map re-derived, nothing armed, build == car: READ', archived.action === 'read');
}

// ---- 3. the notice --------------------------------------------------------------------------------

console.log('\n[the notice under the ring]');
check('START TUNE over an unarmed map with ALPHA-N throwable: said',
    tuneAwaitsArm({ action: ring({ tuneDerived: true }), tuneDerived: true, alphaNArmable: true }));
check('...not when ALPHA-N is locked (store, RESTORE VE, RF KORR) — it would name an unreachable row',
    !tuneAwaitsArm({ action: 'tune', tuneDerived: true, alphaNArmable: false }));
check('...not with no map derived', !tuneAwaitsArm({ action: 'tune', tuneDerived: false, alphaNArmable: true }));
check('...not on WRITE or WRITE PATCH or READ',
    ['write', 'writePatch', 'read'].every(action => !tuneAwaitsArm({ action, tuneDerived: true, alphaNArmable: true })));
for (const lang of ['en', 'ja']) {
    const t = MANIFEST_TEXT[lang];
    check(`${lang}: the line names ALPHA-N, WRITE and START TUNE — which to choose for either next step`,
        /ALPHA-N/.test(t.tuneReady) && /WRITE/.test(t.tuneReady) && /START TUNE/.test(t.tuneReady), t.tuneReady);
    check(`${lang}: off the cable it names ALPHA-N and not START TUNE, which is not on screen there`,
        /ALPHA-N/.test(t.tuneReadyOffline) && !/START TUNE/.test(t.tuneReadyOffline), t.tuneReadyOffline);
}

// ---- 4. the default and its callers -------------------------------------------------------------------

console.log('\n[ALPHA-N loads OFF, and the page asks the chain with the build\'s own toggles]');
{
    const hook = readFileSync(new URL('../src/hooks/useBinaryFile.ts', import.meta.url), 'utf8');
    const page = readFileSync(new URL('../src/app/page.tsx', import.meta.url), 'utf8');
    check('the hook\'s initial state is OFF', /const \[writeVe, setWriteVe\] = useState<boolean>\(false\)/.test(hook));
    check('...a load without an override leaves it OFF', hook.includes('setWriteVe(overrides?.writeVe ?? false)'));
    check('...and clear() resets it to OFF', /setWriteVe\(false\);/.test(hook.slice(hook.indexOf('const clear = '))));
    check('nothing in the hook sets it ON', !/setWriteVe\(true\)|writeVe \?\? true/.test(hook));
    const carImage = readFileSync(new URL('../src/lib/db/carImage.ts', import.meta.url), 'utf8');
    const next = carImage.slice(carImage.indexOf('export function nextStart'));
    check('seeding never defaults it ON: a current draft\'s saved arm, absent read as OFF',
        carImage.includes('writeVe: s.writeVe ?? false') && !/writeVe \?\? true/.test(carImage));
    check('NEXT stores it OFF in the child', /writeVe: false,/.test(next) && !/writeVe: true/.test(next));

    const start = page.indexOf('const idleAction');
    const call = page.slice(page.indexOf('veRingAction({', start), page.indexOf('});', page.indexOf('veRingAction({', start)));
    check('the ring is veRingAction', start >= 0 && call.length > 0);
    check('...asked with the toggles the build reads (ALPHA-N and WARMUP), not with the manifest\'s view',
        call.includes('writeVe: binaryFileState.writeVe') && /\bwriteWarmup\b/.test(call) && call.includes('writeChangesCar'));
    check('...and with the derived map as "derived", never as "armed"', call.includes('tuneDerived: !!newMap'));
    check('the notice ranks below the faults and below "car holds this"',
        page.indexOf('?? tuneReady') > page.indexOf('?? carHoldsThis') && page.indexOf('?? carHoldsThis') > page.indexOf('?? warning'));
    check('...and reads the ALPHA-N row the wing draws', /rows\.find\(r => r\.id === 'alphan'\)/.test(page)
        && /alphaNArmable: alphaNRow\?\.kind === 'toggle' && !alphaNRow\.disabled/.test(page));
    check('DOWNLOAD TUNED is offered only when the build carries a tune',
        /binaryBuffer && newMap && downloadCarriesTune && dmeLink\.state !== 'tuning'/.test(page));
    check('WRITE asks writeClaimsTune with WARMUP too',
        page.includes('writeClaimsTune(newMap, binaryFileState.writeVe, writeExtras, writeWarmup)'));

    // The second run must start from the wheel: a clean STOP leaves the link up and asks nothing.
    const finish = page.slice(page.indexOf('const finishLog = async'), page.indexOf('const finishLogRef'));
    const cleanExit = finish.indexOf('if (!failure) return;');
    check('a clean STOP returns before the disconnect and before any dialog',
        cleanExit > 0 && cleanExit < finish.indexOf('dmeLink.disconnect()') && cleanExit < finish.indexOf('await ask('));
    check('...after the run is flushed and the tab move armed',
        finish.indexOf('await liveRun.finish()') < cleanExit && finish.indexOf('pendingTabRef.current =') < cleanExit);
    check('a lost link is still torn down and explained', /dmeLink\.disconnect\(\)[\s\S]*t\.logLost\(failure\)/.test(finish));
    for (const [lang, t] of Object.entries(DIALOG_TEXT)) {
        const s = t.logLost('x');
        check(`${lang}: the lost-link steps arm ALPHA-N before WRITE`, s.indexOf('ALPHA-N') >= 0 && s.indexOf('ALPHA-N') < s.lastIndexOf('WRITE'), s);
    }
}

console.log('\n[a WRITE ring never confirms as "no tune"]');
{
    const m = { xAxis: [], yAxis: [], data: [] };
    check('ALPHA-N armed over a map claims a tune', writeClaimsTune(m, true, {}, false));
    check('WARMUP armed alone over a map claims a tune', writeClaimsTune(m, false, {}, true));
    check('neither armed: configuration', !writeClaimsTune(m, false, {}, false));
    check('WARMUP armed with no map: configuration (buildImage writes nothing for it)', !writeClaimsTune(null, false, {}, true));
    // Every state the ring calls WRITE is one the write confirms as a tune.
    for (const writeVe of [false, true]) for (const writeWarmup of [false, true]) {
        const action = ring({ tuneDerived: true, writeVe, writeWarmup, writeChangesCar: true });
        check(`ring ${action} with ALPHA-N ${writeVe ? 'ON' : 'OFF'}, WARMUP ${writeWarmup ? 'ON' : 'OFF'} agrees with writeClaimsTune`,
            (action === 'write') === writeClaimsTune(m, writeVe, {}, writeWarmup));
    }
}

console.log(fails === 0 ? '\nALL PASS' : '\n' + fails + ' FAILURE(S)');
process.exit(fails ? 1 : 0);
