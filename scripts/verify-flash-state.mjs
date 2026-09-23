/**
 * The FINAL verdict — "this session's tune is in the ECU, in its road state".
 *
 * It got two things wrong at once, and each hid the other. It never asked whether the flash carried
 * a tune, so arming a bare BASE with the toggles off badged a session that had never tuned anything;
 * and it never asked about TANK VENT, so a tune flashed with the evaporative system held shut was
 * reported as road state. The second is the one with a legal dimension.
 *
 * These are cheap questions with an expensive wrong answer, which is why they are asked of a pure
 * module rather than of a React tree.
 */
import { isRoadState, isTuneOnTheRoad, flashCounts, armedPatchesFromHistory, patchOnFlash, wroteTune } from '../src/lib/db/flashState.ts';

let fails = 0;
const check = (n, c, d) => { console.log('  ' + (c ? 'PASS' : 'FAIL') + '  ' + n + (c ? '' : ' — ' + d)); if (!c) fails++; };

/** A flash record. `settings` defaults to everything off, i.e. road state. */
const flash = (over = {}) => ({
    at: 1, sha256: 'deadbeef', verifyMode: 'quick',
    ...over,
    settings: {
        applyPatch: false, applyWotDisable: false, applyTankVentDisable: false,
        writeWarmup: false, writeWot: false,
        ...(over.settings ?? {}),
    },
});
const session = (...history) => ({ flashHistory: history });

console.log('\n[road state is every tuning-only patch, not two of them]');
{
    check('all off is road state', isRoadState(flash()));
    check('PATCH on is not', !isRoadState(flash({ settings: { applyPatch: true } })));
    check('WOT TH on is not', !isRoadState(flash({ settings: { applyWotDisable: true } })));
    // The regression this file exists for.
    check('TANK VENT shut is NOT road state',
        !isRoadState(flash({ settings: { applyTankVentDisable: true } })));
    // Tune content, not a diagnostic switch — these must not withhold FINAL.
    check('WRITE WARMUP does not make it un-roadworthy', isRoadState(flash({ settings: { writeWarmup: true } })));
    check('WRITE WOT does not either', isRoadState(flash({ settings: { writeWot: true } })));
}

console.log('\n[FINAL needs the tune to have gone to the ECU]');
{
    check('never flashed is not final', !isTuneOnTheRoad(session()));
    check('a tune flashed patch-off IS final', isTuneOnTheRoad(session(flash({ tuned: true }))));
    // The other half of the bug: a patch write carries no map, so it cannot put a tune on the road.
    check('a patch-only write patch-off is NOT final',
        !isTuneOnTheRoad(session(flash({ tuned: false }))));
    check('a patch-only write patch-ON is not final either',
        !isTuneOnTheRoad(session(flash({ tuned: false, settings: { applyPatch: true } }))));
    // Records written before `tuned` existed are all tunes: flashing without a derived map had no
    // way to happen then, so absent must read as true or every historic FINAL disappears.
    check('a record with no `tuned` field reads as a tune', isTuneOnTheRoad(session(flash())));
}

console.log('\n[the LAST flash, not any of them]');
{
    const armed = flash({ at: 1, tuned: false, settings: { applyPatch: true } });
    const tune = flash({ at: 2, tuned: true, settings: { applyPatch: true } });
    const done = flash({ at: 3, tuned: true });
    check('mid-campaign, patch still on: not final', !isTuneOnTheRoad(session(armed, tune)));
    check('after the finalize: final', isTuneOnTheRoad(session(armed, tune, done)));
    // Going back to logging has to take the badge away again.
    check('re-armed patch-on afterwards: not final any more',
        !isTuneOnTheRoad(session(armed, tune, done, flash({ at: 4, tuned: false, settings: { applyPatch: true } }))));
    check('a tune flashed with TANK VENT still shut is not final',
        !isTuneOnTheRoad(session(tune, flash({ at: 3, tuned: true, settings: { applyTankVentDisable: true } }))));
}

console.log('\n[a PRACTICE write moved no bytes and answers no question about a car]');
{
    // The case that produced this: a full tune written in PRACTICE put a `tuned: true` record in
    // the history. Three days later a fresh read came back byte-identical, and the only readings
    // available were "the write failed" and "someone reflashed the original" — both wrong.
    const practiceTune = flash({ at: 1, tuned: true, practice: true });
    check('a tune flashed in PRACTICE is NOT final', !isTuneOnTheRoad(session(practiceTune)));
    check('and it does not count as a flash',
        flashCounts(session(practiceTune)).real === 0 && flashCounts(session(practiceTune)).practice === 1,
        JSON.stringify(flashCounts(session(practiceTune))));
    check('it tells the load nothing about which patches the ECU holds',
        armedPatchesFromHistory(session(practiceTune)) === null);

    // Absent means REAL: older records come from a build whose practice writes left no trace, so
    // reclassifying them would invent a fact. Every historic FINAL has to survive this change.
    check('a record with no `practice` field still reads as a real flash',
        isTuneOnTheRoad(session(flash({ tuned: true }))));

    // The interleaving case, which is why realFlashes filters instead of testing the tail.
    const realArm = flash({ at: 1, tuned: false, practice: false, settings: { applyPatch: true } });
    const rehearse = flash({ at: 2, tuned: true, practice: true });
    const finalize = flash({ at: 3, tuned: true });
    check('a practice run after a real patch-on does not erase what the car is holding',
        armedPatchesFromHistory(session(realArm, rehearse))?.applyPatch === true);
    check('...and the session is still not final',
        !isTuneOnTheRoad(session(realArm, rehearse)));
    check('a real finalize after a rehearsal IS final',
        isTuneOnTheRoad(session(realArm, rehearse, finalize)));
    check('counts split correctly across the three',
        JSON.stringify(flashCounts(session(realArm, rehearse, finalize)))
        === '{"real":2,"practice":1,"tuned":1,"patchOnly":1}',
        JSON.stringify(flashCounts(session(realArm, rehearse, finalize))));
}

console.log('\n[a patch-on write is a real write and is NOT a tune]');
{
    // The list showed one tick over `real`, so a session that was patched, driven and logged with
    // no tune ever written claimed a tune in the car. The difference was in the tooltip only, which
    // a phone cannot show. Reported by the operator 2026-08-24.
    const patchOn = flash({ at: 1, tuned: false, practice: false, settings: { applyPatch: true } });
    const c = flashCounts(session(patchOn));
    check('it counts as a real write', c.real === 1, JSON.stringify(c));
    check('...and as PATCH ONLY, not as a tune', c.tuned === 0 && c.patchOnly === 1, JSON.stringify(c));
    check('so the session is not final either', !isTuneOnTheRoad(session(patchOn)));

    const tuneAfter = flashCounts(session(patchOn, flash({ at: 2, tuned: true })));
    check('a tune written afterwards is counted apart from the patch',
        tuneAfter.tuned === 1 && tuneAfter.patchOnly === 1, JSON.stringify(tuneAfter));

    // Records from before the field existed: a write was a tune then, and every historic tick has
    // to survive this change rather than silently demote itself to PATCH.
    const legacy = flashCounts(session(flash({ at: 1 })));
    check('a record with no `tuned` field still counts as a tune',
        legacy.tuned === 1 && legacy.patchOnly === 0, JSON.stringify(legacy));

    const none = flashCounts(session());
    check('a session that never wrote counts nothing',
        none.real === 0 && none.tuned === 0 && none.patchOnly === 0, JSON.stringify(none));
}

console.log('\n[what the session list says a session DID]');
{
    // The strip's PATCH and TUNED are about writes, not about stored bytes. TUNED used to be keyed
    // on a tune EXISTING - and a map is derived the moment a log meets a BASE, so it lit on 15 of
    // the 20 sessions in the store, including every one that had only been driven. Reported by the
    // operator: "sessions I never tuned have the TUNED flag".
    check('a session that only holds a log wrote no tune', !wroteTune(session()));

    const armed = session(flash({ at: 1, tuned: false, settings: { applyPatch: true } }));
    check('a patch-on write is not a tune', !wroteTune(armed));
    check('...though it is what the ECU is holding, which PATCH reads',
        armedPatchesFromHistory(armed)?.applyPatch === true);

    const tuned = session(flash({ at: 1, tuned: true, settings: { applyPatch: true } }));
    check('a tuned write counts as a tune written', wroteTune(tuned));

    const rehearsed = session(flash({ at: 1, tuned: true, practice: true, settings: { applyPatch: true } }));
    check('a PRACTICE write wrote no tune', !wroteTune(rehearsed));

    // Written, then patched over: the tune left this session either way, and TUNED says what
    // happened. Whether it is STILL in there is isTuneOnTheRoad, which is the check beside it.
    const overwritten = session(flash({ at: 1, tuned: true }), flash({ at: 2, tuned: false, settings: { applyPatch: true } }));
    check('a tune written and later patched over still counts as written', wroteTune(overwritten));
    check('...but is no longer what the ECU holds', !isTuneOnTheRoad(overwritten));

    const legacy = session(flash({ at: 1 }));
    check('a record with no `tuned` field counts as a tune written', wroteTune(legacy));
}

console.log('\n[the PATCH-ON image a session actually wrote]');
{
    // Not `tuneSettings`. A session commonly writes PATCH-ON, drives, derives a tune and later
    // writes it patch-off — so the tune's own settings are all-false while the session did put
    // patches in the car. That is the case the download exists for.
    check('a session that never flashed wrote no image', patchOnFlash(session()) === null);
    check('a patch-off flash is not one',
        patchOnFlash(session(flash())) === null);
    check('a patch-on flash is',
        patchOnFlash(session(flash({ settings: { applyPatch: true } })))?.applyPatch === true);
    check('TANK VENT alone counts — it is a patch like the others',
        patchOnFlash(session(flash({ settings: { applyTankVentDisable: true } })))?.applyTankVentDisable === true);
    check('a PRACTICE write wrote nothing',
        patchOnFlash(session(flash({ practice: true, settings: { applyPatch: true } }))) === null);
    // The LAST one: if the patches changed between runs, the file offered is the most recent thing
    // the car was given.
    const twice = session(
        flash({ settings: { applyPatch: true } }),
        flash({ settings: { applyWotDisable: true } }),
    );
    check('the last patch-on flash wins',
        patchOnFlash(twice)?.applyWotDisable === true && patchOnFlash(twice)?.applyPatch === false,
        JSON.stringify(patchOnFlash(twice)));
    // A finalize afterwards does not erase the fact that a patched image was written.
    check('a later patch-off flash does not take it away',
        patchOnFlash(session(flash({ settings: { applyPatch: true } }), flash()))?.applyPatch === true);
}

console.log(fails === 0 ? '\nALL PASS' : '\n' + fails + ' FAILURE(S)');
process.exit(fails ? 1 : 0);
