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
    LOG_PROFILES, expectedHz, exchangeMs, sampleMs, blocksOf, describeExchanges,
    LAMBDA_SLOW_LANE_EVERY, LAMBDA_TRUTH_GATE, lambdaTrimAgrees,
    missingPatches, deriveRoute, routeNeedsUnverifiedDivision, processesSupportedBy,
} from '../src/lib/log-engine/logProfile.ts';
import { LAMBDA_TRIM_RAM_READ } from '../src/lib/dme-link/ramMap.ts';

let fails = 0;
const check = (n, c, d) => { console.log('  ' + (c ? 'PASS' : 'FAIL') + '  ' + n + (c ? '' : ' — ' + d)); if (!c) fails++; };

console.log('\n[what a sample costs, from the exchanges it is made of]');
{
    const only = (...x) => x;
    const b3 = { kind: 'block', selection: 3 };
    const b19 = { kind: 'block', selection: 19 };
    const ram4 = { kind: 'ram', name: 'trim', segment: 1, address: 0xFF80CA, count: 4 };

    const ve = expectedHz(LOG_PROFILES.VE.exchanges);
    const veSlow = expectedHz(LOG_PROFILES.VE.fallback);
    const egt = expectedHz(LOG_PROFILES.EGT.exchanges);
    const inertia = expectedHz(LOG_PROFILES.INERTIA.exchanges);
    console.log(`        VE ${ve.toFixed(1)} Hz (${describeExchanges(LOG_PROFILES.VE.exchanges)})`);
    console.log(`        VE fallback ${veSlow.toFixed(1)} Hz · EGT ${egt.toFixed(1)} Hz · INERTIA ${inertia.toFixed(1)} Hz`);

    // The two measured drives, and the only assertions here anchored to a car rather than to the
    // arithmetic's own consistency. The model deliberately omits transport latency — see
    // DME_TURNAROUND_MS — so it sits ABOVE both, and by more on the small block.
    //
    //     #904 VE [3,19] measured 2.95 Hz     #903 EGT [3] measured 6.60 Hz
    //
    // Bounds rather than equalities: tightening either to a point would be fitting the transport's
    // cost into the DME's constant, which is the error the constant's comment exists to name.
    check('the both-blocks VE list brackets the 2.95 Hz of #904', veSlow >= 2.95 && veSlow < 3.2, veSlow.toFixed(2));
    check('EGT brackets the 6.60 Hz of #903', egt >= 6.6 && egt < 7.7, egt.toFixed(2));
    check('the model never predicts SLOWER than the car managed', veSlow >= 2.95 && egt >= 6.6);

    // The whole reason for the RAM read. Eight bytes against ninety, and 35 ms of turnaround against
    // 83 — so this has to be a large win or it is not worth the claim it rests on.
    //
    // Measured on the SUBSTITUTION, not on the two whole profiles. The old form compared all of VE
    // against all of the fallback, which shrinks every time a channel the fallback never carried is
    // added — LLS_ST, the density cluster — and would have failed for reasons that have nothing to
    // do with the trim read. Here the fallback's own list is rebuilt with the RAM read swapped in
    // for block 19, so the only difference between the two numbers is the thing being claimed.
    const trimByBlock = LOG_PROFILES.VE.fallback;
    const trimByRam = [
        ...trimByBlock.filter(e => e.selection !== 19),
        { kind: 'ram', name: 'LA_F_REGLER/LAA_F', ...LAMBDA_TRIM_RAM_READ },
    ];
    const swapped = expectedHz(trimByRam);
    check('reading the trim from RAM instead of block 19 is at least 1.5x faster',
        swapped > veSlow * 1.5, `${swapped.toFixed(2)} vs ${veSlow.toFixed(2)}`);
    // And the profile as shipped still beats the fallback outright, carrying more channels than it.
    check('...and the VE profile as shipped is still faster than the fallback', ve > veSlow,
        `${ve.toFixed(2)} vs ${veSlow.toFixed(2)}`);
    // ...and it must still be slower than dropping the trim altogether, or something is wrong with
    // the model: EGT reads strictly fewer bytes for strictly fewer channels.
    check('and still slower than reading block 3 alone', ve < egt, `${ve.toFixed(2)} vs ${egt.toFixed(2)}`);

    check('a RAM read costs less than the block it replaces', exchangeMs(ram4) < exchangeMs(b19));
    check('dropping an exchange always helps', expectedHz(only(b3)) > expectedHz(only(b3, b19)));
    check('an unknown selection contributes nothing',
        expectedHz(only(b3, { kind: 'block', selection: 999 })) === expectedHz(only(b3)));

    // `every` is an amortisation, not a skip: eight samples of the fast list plus one block 19.
    const slow = { ...b19, every: 8 };
    check('a 1/8 lane costs an eighth of its exchange',
        Math.abs(sampleMs(only(b3, slow)) - (exchangeMs(b3) + exchangeMs(b19) / 8)) < 1e-9);
    check('every: 1 is the same as no every', sampleMs(only({ ...b19, every: 1 })) === sampleMs(only(b19)));
    check('the VE profile puts block 19 on the slow lane',
        LOG_PROFILES.VE.exchanges.some(x => x.kind === 'block' && x.selection === 19 && x.every === LAMBDA_SLOW_LANE_EVERY));
    // The fallback is what a VE log has always been, and it must claim nothing.
    check('the fallback reads both blocks every sample',
        blocksOf(LOG_PROFILES.VE.fallback).join() === '3,19'
        && LOG_PROFILES.VE.fallback.every(x => (x.every ?? 1) === 1));
    check('the fallback asks for no RAM at all', !LOG_PROFILES.VE.fallback.some(x => x.kind === 'ram'));

    // The inertia run reads block 3 plus a RAM chunk, and has since block 83 turned out to be a
    // latched fault frame. Naming 83 here overstated its rate by about 1.8x.
    check('INERTIA does not claim to read the EGAS block', !blocksOf(LOG_PROFILES.INERTIA.exchanges).includes(83));
    check('INERTIA reads block 3 and one RAM chunk',
        blocksOf(LOG_PROFILES.INERTIA.exchanges).join() === '3'
        && LOG_PROFILES.INERTIA.exchanges.filter(x => x.kind === 'ram').length === 1);
}

console.log('\n[the RAM lambda trim is believed, not trusted]');
{
    const T = LAMBDA_TRUTH_GATE;
    // A real agreement: two readings a fifth of a second apart, both near 1.
    check('two close readings near 1.0 agree', lambdaTrimAgrees(1.0000, 1.0100));
    // Just inside and just outside, rather than exactly on: `1 + 0.05` is 1.05000000000000004 in
    // binary, so an equality at the boundary would be testing IEEE-754 rather than the gate.
    check('just inside the tolerance still agrees', lambdaTrimAgrees(1 + T.tolerance * 0.99, 1.0));
    check('past the tolerance does not', !lambdaTrimAgrees(1 + T.tolerance * 1.01, 1.0));
    // The failure the tolerance cannot catch: a channel that never moves. Two zeroes agree
    // perfectly, which is why the plausibility band is the second half of the test.
    check('two zeroes do NOT agree', !lambdaTrimAgrees(0, 0));
    check('a stuck 0xFFFF does not agree', !lambdaTrimAgrees(2.0, 2.0));
    check('outside the band on either side fails',
        !lambdaTrimAgrees(T.plausible.min - 0.01, T.plausible.min - 0.01)
        && !lambdaTrimAgrees(T.plausible.max + 0.01, T.plausible.max + 0.01));
    // "Could not check" must never read as "checked and fine" — that is the whole reason the gate
    // exists, and a silent pass would hand back an entire drive from an unverified address.
    check('a missing RAM reading is a failure, not a pass', !lambdaTrimAgrees(undefined, 1.0));
    check('a missing block-19 reading is a failure too', !lambdaTrimAgrees(1.0, undefined));
    check('NaN is a failure', !lambdaTrimAgrees(NaN, 1.0));
    // Two of three, so one sample landing on a transient does not cost the profile — but it can
    // never be "one of three", which would let a single lucky agreement license the whole drive.
    check('the gate needs a majority of its pairs', T.pairsRequired > T.pairsTaken / 2);
    check('the gate takes more than one pair', T.pairsTaken > 1);
}

console.log('\n[EGT is retired, and retired means unstartable rather than deleted]');
{
    check('VE can be run', LOG_PROFILES.VE.runnable);
    check('INERTIA can be run', LOG_PROFILES.INERTIA.runnable);
    // The whole point. Block 3 carries no la_f_regler, so `A(d)/A(0) = k_applied x STFT(d)/STFT(0)`
    // has no STFT term and the profile can only produce a drive that has to be driven again. It
    // did exactly that once (#903), which is why this is a hard flag and not a note in a tooltip.
    check('EGT cannot be run', !LOG_PROFILES.EGT.runnable);
    // Kept in the type on purpose: sessions recorded before it was retired still name it, and a log
    // with rf but no trim is still honestly DESCRIBED by it even though it cannot be started.
    check('EGT still names what an rf-only log is', processesSupportedBy(false, true).join() === 'EGT');
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
