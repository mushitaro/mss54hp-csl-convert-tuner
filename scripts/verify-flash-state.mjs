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
import { isRoadState, isTuneOnTheRoad } from '../src/lib/db/flashState.ts';

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

console.log(fails === 0 ? '\nALL PASS' : '\n' + fails + ' FAILURE(S)');
process.exit(fails ? 1 : 0);
