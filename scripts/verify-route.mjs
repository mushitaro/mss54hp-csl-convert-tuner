/**
 * The campaign route, and the preflight that runs before a drive.
 *
 * Both are pure derivations rather than settings, which is the point worth defending: a stored
 * "route" would be a second answer to a question `rfKorrSource` and `writeRfKorr` already answer,
 * and two answers can disagree. Here the route is a NAME for a combination already chosen by other
 * means — so it cannot be picked, and it cannot be picked wrongly.
 *
 * What these assertions protect is the mapping being honest about consequences. Route B rests on
 * dividing the VE map by k_new, which no car has ever checked; if that combination ever stopped
 * being named B, the warning attached to B would silently stop appearing.
 */
import {
    LOG_PROFILES, expectedHz, missingPatches, deriveRoute, routeNeedsUnverifiedDivision,
    processesSupportedBy,
} from '../src/lib/log-engine/logProfile.ts';

let fails = 0;
const check = (n, c, d) => { console.log('  ' + (c ? 'PASS' : 'FAIL') + '  ' + n + (c ? '' : ' — ' + d)); if (!c) fails++; };

console.log('\n[the rate a profile can expect, from the blocks it reads]');
{
    const ve = expectedHz(LOG_PROFILES.VE.blocks);
    const egt = expectedHz(LOG_PROFILES.EGT.blocks);
    const inertia = expectedHz(LOG_PROFILES.INERTIA.blocks);
    console.log(`        VE ${ve.toFixed(1)} Hz · EGT ${egt.toFixed(1)} Hz · INERTIA ${inertia.toFixed(1)} Hz`);
    // The measured baseline, and the one assertion here that is anchored to a real drive rather
    // than to the arithmetic's own consistency.
    //
    // DME_TURNAROUND_MS is now measured directly (83 ms median, session #904) rather than derived
    // by subtraction, so these bound the model against two real drives instead of pinning it to
    // one. The model deliberately omits transport latency — see the constant's own comment — so it
    // is expected to sit ABOVE both measured rates, and the margin is bigger on the small block.
    //
    //     #904 VE  measured 2.95 Hz   #903 EGT measured 6.60 Hz
    //
    // A bound rather than an equality, because tightening either to a point would be fitting the
    // transport's cost into the DME's constant, which is exactly the error being corrected.
    check('VE brackets the 2.95 Hz of #904', ve >= 2.95 && ve < 3.2, ve.toFixed(2));
    check('EGT brackets the 6.60 Hz of #903', egt >= 6.6 && egt < 7.7, egt.toFixed(2));
    check('the model never predicts SLOWER than the car managed', ve >= 2.95 && egt >= 6.6);
    // The whole reason the EGT profile exists.
    check('EGT is more than twice VE', egt > ve * 2, `${egt.toFixed(1)} vs ${ve.toFixed(1)}`);
    check('dropping a block always helps', expectedHz([3]) > expectedHz([3, 19]));
    check('an unknown selection contributes nothing', expectedHz([3, 999]) === expectedHz([3]));
}

console.log('\n[preflight names what is missing, and nothing else]');
{
    const none = { patched: false, tankVentShut: false };
    const both = { patched: true, tankVentShut: true };
    check('VE wants PATCH', missingPatches(LOG_PROFILES.VE, none).join() === 'PATCH');
    check('VE is satisfied by PATCH alone',
        missingPatches(LOG_PROFILES.VE, { patched: true, tankVentShut: false }).length === 0);
    // EGT needs TANK VENT specifically because it drops block 19 and so cannot SEE purge happening.
    check('EGT wants both', missingPatches(LOG_PROFILES.EGT, none).join() === 'PATCH,TANK_VENT');
    check('EGT still wants TANK VENT with PATCH on',
        missingPatches(LOG_PROFILES.EGT, { patched: true, tankVentShut: false }).join() === 'TANK_VENT');
    check('nothing missing when both are armed', missingPatches(LOG_PROFILES.EGT, both).length === 0);
    // The inertia estimate reads torque and speed gradient; the patches do not touch either.
    check('INERTIA requires nothing', missingPatches(LOG_PROFILES.INERTIA, none).length === 0);
}

console.log('\n[the route is a name for a combination, not a setting]');
{
    const r = (o) => deriveRoute({ process: 'VE', writeRfKorr: false, hasVeMap: true, ...o });
    check('VE, table untouched          -> CONSERVATIVE', r({}) === 'CONSERVATIVE', r({}));
    check('VE, table armed              -> B', r({ writeRfKorr: true }) === 'B');
    check('VE on an EGT parent          -> A2', r({ parentProcess: 'EGT' }) === 'A2');
    // Arming the table on an EGT-derived base is B again, not A2: the write carries both, so it is
    // the combined shape whatever the base was.
    check('VE on an EGT parent, armed   -> B', r({ parentProcess: 'EGT', writeRfKorr: true }) === 'B');
    check('EGT, table armed             -> A1',
        deriveRoute({ process: 'EGT', writeRfKorr: true, hasVeMap: false }) === 'A1');
    check('EGT, nothing armed           -> NONE',
        deriveRoute({ process: 'EGT', writeRfKorr: false, hasVeMap: false }) === 'NONE');
    check('no VE map, nothing armed     -> NONE', r({ hasVeMap: false }) === 'NONE');
    check('INERTIA never writes         -> NONE',
        deriveRoute({ process: 'INERTIA', writeRfKorr: true, hasVeMap: true }) === 'NONE');
}

console.log('\n[only B rests on the division no car has checked]');
{
    check('B does', routeNeedsUnverifiedDivision('B'));
    for (const route of ['CONSERVATIVE', 'A1', 'A2', 'NONE']) {
        check(`${route} does not`, !routeNeedsUnverifiedDivision(route));
    }
}

console.log('\n[what a log can be used for is decided by the channels it has]');
{
    check('trim + rf  -> VE and EGT', processesSupportedBy(true, true).join() === 'VE,EGT');
    // An EGT run never reads block 19, so its log has no trim and cannot produce a VE map. Not a
    // rule — an absence.
    check('rf alone   -> EGT only', processesSupportedBy(false, true).join() === 'EGT');
    check('neither    -> nothing', processesSupportedBy(false, false).length === 0);
}

console.log(fails === 0 ? '\nALL PASS' : '\n' + fails + ' FAILURE(S)');
process.exit(fails ? 1 : 0);
