/**
 * What a PRODUCTION build records, pinned.
 *
 * The decision (2026-08-25, applied at the first production cut): production logs `core` + `tuning`
 * and not the twelve `debug` channels. It is implemented as a filter over `relevance` — see
 * `productionExchanges` — so that the rule lives in one place and cannot drift from the registry.
 *
 * Two of these checks are the ones that matter. The narrowing must never cost a tuning channel,
 * because that costs a drive; and the annotation the narrowing reads must be COMPLETE on the only
 * profile production can run, because an unannotated exchange is silently kept and the rule would
 * then be true of the code and false of the car.
 */
import { LOG_PROFILES, productionExchanges, expectedHz, describeExchanges } from '../src/lib/log-engine/logProfile.ts';
import { LOG_FIELD_REGISTRY, fieldGroupsFor } from '../src/lib/field-registry/registry.ts';
import { FEATURES } from '../src/lib/features.ts';

let fails = 0;
const check = (n, c, d) => { console.log('  ' + (c ? 'PASS' : 'FAIL') + '  ' + n + (c ? '' : ' — ' + (d ?? ''))); if (!c) fails++; };
const keys = Object.keys(LOG_FIELD_REGISTRY);
const rel = (k) => LOG_FIELD_REGISTRY[k].relevance;
const set = (a) => [...new Set(a)].sort();

/** Channels this app computes rather than reads. Everything else in core+tuning must be on a wire
 *  exchange, and the check below is what proves the list has not quietly grown. */
const COMPUTED = ['correctedLoad', 'rfKorr'];

console.log('\n[VE is the only profile a production build can run]');
{
    // The narrowing is only ever applied to VE, so this is the assumption it rests on. IDLE and
    // INERTIA are started from panels their own experimental feature gates; EGT cannot be chosen
    // for a new run at all. If any of that changes, the profile needs annotating before it ships.
    check("idle is not stable", FEATURES.idle.stage !== 'stable', FEATURES.idle.stage);
    check("inertia is not stable", FEATURES.inertia.stage !== 'stable', FEATURES.inertia.stage);
    check('EGT is not runnable', LOG_PROFILES.EGT.runnable === false);
    check('VE is runnable and belongs to a stable feature',
        LOG_PROFILES.VE.runnable === true && FEATURES.ve.stage === 'stable');
}

console.log('\n[the VE annotation is complete]');
for (const which of ['exchanges', 'fallback']) {
    const list = LOG_PROFILES.VE[which];
    const bare = list.filter(x => !x.provides?.length)
        .map(x => x.kind === 'block' ? `block ${x.selection}` : x.name);
    check(`every ${which} entry names what it provides`, bare.length === 0, `un-annotated: ${bare.join(', ')}`);
}

console.log('\n[narrowing costs no core or tuning channel]');
for (const which of ['exchanges', 'fallback']) {
    const full = LOG_PROFILES.VE[which];
    const prod = productionExchanges(full);
    const onWire = (l) => set(l.flatMap(x => [...(x.provides ?? [])]));
    const lost = onWire(full).filter(k => rel(k) !== 'debug' && !onWire(prod).includes(k));
    check(`${which}: no core/tuning channel is dropped`, lost.length === 0, lost.join(', '));
}

console.log('\n[the production channel set, as a literal]');
{
    const prod = productionExchanges(LOG_PROFILES.VE.exchanges);
    const recorded = set(prod.flatMap(x => [...(x.provides ?? [])]));
    // The debug channels that survive because they share a telegram with a tuning one. Stated
    // rather than hidden: they ARE in a production log, and a check claiming otherwise would be
    // the kind of tidy fiction this file exists to prevent.
    const ridingAlong = recorded.filter(k => rel(k) === 'debug');
    check('debug channels riding along on a kept exchange',
        JSON.stringify(ridingAlong) === JSON.stringify(
            ['ambientTemp', 'lambdaFreeze', 'tankVentCheckState', 'tankVentDiag', 'wdk1'].sort()),
        ridingAlong.join(', '));

    const wanted = keys.filter(k => rel(k) !== 'debug');
    const missing = wanted.filter(k => !recorded.includes(k) && !COMPUTED.includes(k));
    check('every core/tuning channel is either on a kept exchange or computed', missing.length === 0,
        `unaccounted: ${missing.join(', ')}`);
    const staleComputed = COMPUTED.filter(k => recorded.includes(k));
    check('nothing in COMPUTED is also claimed by an exchange', staleComputed.length === 0, staleComputed.join(', '));
}

console.log('\n[the exchanges a production run drops]');
{
    const full = LOG_PROFILES.VE.exchanges;
    const prod = productionExchanges(full);
    const gone = full.filter(x => !prod.includes(x)).map(x => x.name ?? `block ${x.selection}`);
    // Every exchange whose `provides` is debug THROUGHOUT. The slew-limiter pair joined the list
    // on 2026-08-30: MD_DYN_ST and the four torque words answer whether KF_MD_LS_KOMF ever bound,
    // which is a drivability question asked against the maps afterwards, not a tuning input. Named
    // one by one rather than counted, so adding an exchange has to state which side it is on.
    check('exactly the four debug-only exchanges',
        JSON.stringify(gone.sort()) === JSON.stringify(
            ['LLS_ST', 'MD_DYN_ST', 'MD_FW/MD_FW_FILTER', 'P_UMG/TAN_M'].sort()),
        gone.join(', '));
    console.log(`        preview  ${expectedHz(full).toFixed(3)} Hz  ${describeExchanges(full)}`);
    console.log(`        prod     ${expectedHz(prod).toFixed(3)} Hz  ${describeExchanges(prod)}`);
    // The rate is not the argument — 2.31 % would not justify removing a channel anyone reads.
    // Pinned only so that a future exchange added to the debug lane cannot make it one.
    check('production is not SLOWER than preview', expectedHz(prod) >= expectedHz(full));
}

console.log('\n[the panel offers no switch for a channel this build does not record]');
{
    const prodGroups = fieldGroupsFor(false).map(g => g.relevance);
    check('production draws TUNING only', JSON.stringify(prodGroups) === JSON.stringify(['tuning']), prodGroups.join(', '));
    const previewGroups = fieldGroupsFor(true).map(g => g.relevance);
    check('preview draws both', JSON.stringify(previewGroups) === JSON.stringify(['tuning', 'debug']), previewGroups.join(', '));
}

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
