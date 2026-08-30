/**
 * The log channel registry, checked against the rule that a label is a claim.
 *
 * "Lambda 1" headed a column carrying `la_f_regler` — the lambda controller's output factor, which
 * Funktionsrahmen 5.01 defines as `1.0 + f_la_kp + f_la_ki`. Not a measured lambda, and not (as
 * Testo's "Lambdaintegrator" would have it) an integrator either: the integrator is one of its two
 * terms. A column that names a quantity the ECU never reported is the kind of error that survives
 * for a year, because nothing downstream fails — it just makes every conversation about the data
 * slightly wrong.
 *
 * So the rule is mechanical and checkable: a channel the DME sent wears the DME's symbol and a
 * wire address; a channel this app computed wears neither.
 */
import {
    LOG_FIELD_REGISTRY, DEFAULT_FIELD_VISIBILITY, TOGGLEABLE_FIELDS,
    CORE_ONLY_VISIBILITY, REQUIRED_FIELD_GROUPS, isLastOfRequiredGroup, FIELD_GROUPS, fieldsIn,
    fieldValueKey, describeField,
} from '../src/lib/field-registry/registry.ts';
import { STANDARD_MEASUREMENT_BLOCK, OPERATING_MEASUREMENTS_BLOCK } from '../src/lib/dme-link/liveValueBlocks.ts';

let fails = 0;
const check = (n, c, d) => { console.log('  ' + (c ? 'PASS' : 'FAIL') + '  ' + n + (c ? '' : ' — ' + d)); if (!c) fails++; };

const entries = Object.entries(LOG_FIELD_REGISTRY);
const wire = entries.filter(([, m]) => m.source !== 'derived');
const calc = entries.filter(([, m]) => m.source === 'derived');

console.log('\n[every field declares where its number came from]');
{
    check('no field is missing `source`', entries.every(([, m]) => m.source !== undefined));
    check('no field is missing `symbol`', entries.every(([, m]) => !!m.symbol));
    check('no field is missing `name`', entries.every(([, m]) => !!m.name));
    check('key matches the record key', entries.every(([k, m]) => m.key === k));
    check('there are both kinds', wire.length > 0 && calc.length > 0, `${wire.length}/${calc.length}`);
}

console.log('\n[a wire channel wears the DME symbol its block actually decodes]');
{
    // The registry says "selection 19, offset 40, la_f_regler1". The block layout is what the
    // decoder really uses. If those two ever disagree, the screen is labelling the wrong bytes.
    const layouts = {
        3: STANDARD_MEASUREMENT_BLOCK,
        19: OPERATING_MEASUREMENTS_BLOCK,
    };
    for (const [key, m] of wire) {
        const block = layouts[m.source.selection];
        if (!block) { check(`${key}: selection ${m.source.selection} is a known block`, false); continue; }
        const match = Object.values(block.fields).find(f => f.offset === m.source.offset);
        check(`${key}: block ${m.source.selection} offset ${m.source.offset} decodes '${m.symbol}'`,
            !!match && match.symbol === m.symbol, match ? `block says '${match.symbol}'` : 'no field at that offset');
    }
}

console.log('\n[a computed field must not impersonate one]');
{
    // Lowercase-with-underscores is what a DME symbol looks like. A computed channel using that
    // shape is exactly the "Lambda 1" failure wearing better camouflage.
    const looksLikeSymbol = s => /^[a-z][a-z0-9_]*$/.test(s);
    for (const [key, m] of calc) {
        check(`${key}: '${m.symbol}' is not shaped like a DME symbol`, !looksLikeSymbol(m.symbol));
    }
    check('computed fields carry no wire address',
        calc.every(([, m]) => m.source === 'derived'));
    check('describeField says so out loud',
        calc.every(([, m]) => /never sent/.test(describeField(m))));
}

console.log('\n[value keys match the reference tool]');
{
    // LiveValueKeys.Create(selection, symbol) => "13:la_f_regler1". Two-digit uppercase hex.
    const la = LOG_FIELD_REGISTRY.stft1;
    check('la_f_regler1 keys as 13:la_f_regler1', fieldValueKey(la) === '13:la_f_regler1', fieldValueKey(la));
    check('rpm keys as 03:n', fieldValueKey(LOG_FIELD_REGISTRY.rpm) === '03:n', fieldValueKey(LOG_FIELD_REGISTRY.rpm));
    check('a computed field keys as calc:',
        fieldValueKey(LOG_FIELD_REGISTRY.rfKorr).startsWith('calc:'), fieldValueKey(LOG_FIELD_REGISTRY.rfKorr));
    const keys = entries.map(([, m]) => fieldValueKey(m));
    check('every key is unique', new Set(keys).size === keys.length,
        keys.filter((k, i) => keys.indexOf(k) !== i).join(', '));
}

console.log('\n[visibility stays in step with the field list]');
{
    const missing = entries.filter(([k]) => DEFAULT_FIELD_VISIBILITY[k] === undefined).map(([k]) => k);
    check('every field has a default', missing.length === 0, missing.join(', '));
    check('core fields are not toggleable',
        !TOGGLEABLE_FIELDS.some(k => LOG_FIELD_REGISTRY[k].relevance === 'core'));
    // A channel whose meaning is unknown must not be on by default — see its registry entry.
    check('la_freeze_flag is off by default', DEFAULT_FIELD_VISIBILITY.lambdaFreeze === false);
    // The one channel the VE correction cannot do without. Hiding it is fine; not having it is not,
    // and the parser now refuses such a log outright.
    check('the trim pair is on by default',
        DEFAULT_FIELD_VISIBILITY.stft1 === true && DEFAULT_FIELD_VISIBILITY.stft2 === true);
    check('wdk1 is off by default (it is a gate input, not a gauge)',
        DEFAULT_FIELD_VISIBILITY.wdk1 === false);
}

console.log('\n[the default view is the columns a tune is read from, and no more]');
{
    /**
     * The decision, written down so that changing it is deliberate.
     *
     *   stft1/2      the only input the correction has
     *   coolantTemp  the gate the first minutes of every log are judged against
     *   rf, rfKorr   what the DME metered and the correction it applied
     *   exhaustTemp  where that correction comes from, and the whole EGT workflow
     *   vehicleSpeed the 20 km/h gate — how a genuine 1.000 is told from a shut gate
     *   tankVent     a run spoiled by purge looks exactly like a run that disagrees
     *
     * What came OFF (2026-08-24, operator: too many columns checked): the four air channels
     * intakeTemp / chargeTemp / ambientPressure / ambientTemp. They were switched on after one of
     * them recorded nothing for a whole drive with nothing looking wrong — but that argument was
     * about RECORDING, which no longer depends on this map: they are read on the slow lane into
     * every log either way, the correction that consumes them is off by default, and their absence
     * is announced in red above the TUNED MAP ("TRIM ONLY — no air data, rf_korr not measurable")
     * rather than left to whether somebody had a column switched on.
     */
    const EXPECTED_ON = [
        'stft1', 'stft2', 'coolantTemp', 'exhaustTemp', 'rf', 'rfKorr', 'vehicleSpeed', 'tankVent',
        // The long-term lambda trim joins its short-term pair, and for the reason the pair is here:
        // at a settled warm idle `la_f_regler` returns toward 1.000 BECAUSE `laa_f` absorbed the
        // offset. Read on its own it says the mixture is fine at exactly the operating point where
        // that is least likely to be true, and the low-opening correction multiplies the two.
        'ltft1', 'ltft2',
    ].sort();
    const actualOn = TOGGLEABLE_FIELDS.filter(k => DEFAULT_FIELD_VISIBILITY[k]).sort();
    check('the default set is exactly the ten columns above',
        actualOn.join(',') === EXPECTED_ON.join(','),
        `on: ${actualOn.join(', ')}`);
    check('fewer than half the toggleable channels are on by default',
        actualOn.length * 2 < TOGGLEABLE_FIELDS.length,
        `${actualOn.length} of ${TOGGLEABLE_FIELDS.length}`);

    // The two are the same statement, and keeping them in step is what makes the panel's headings
    // true: the TUNING section IS the default view, and DEBUG is what you go and switch on. A
    // channel promoted to `tuning` without being switched on would put it under a heading that
    // says DEFAULTS turns it on, next to a DEFAULTS button that does not.
    check('the TUNING section is exactly the default set',
        fieldsIn('tuning').slice().sort().join(',') === actualOn.join(','),
        `tuning: ${fieldsIn('tuning').join(', ')}`);
    check('nothing in DEBUG is on by default',
        fieldsIn('debug').every(k => !DEFAULT_FIELD_VISIBILITY[k]),
        fieldsIn('debug').filter(k => DEFAULT_FIELD_VISIBILITY[k]).join(', '));
}

console.log('\n[every channel is in exactly one section of the panel]');
{
    const sections = FIELD_GROUPS.map(g => g.relevance);
    check('the panel draws both sections', sections.join(',') === 'tuning,debug', sections.join(','));
    const placed = FIELD_GROUPS.flatMap(g => fieldsIn(g.relevance));
    check('every toggleable field is in a section',
        placed.slice().sort().join(',') === TOGGLEABLE_FIELDS.slice().sort().join(','),
        `missing: ${TOGGLEABLE_FIELDS.filter(k => !placed.includes(k)).join(', ')}`);
    check('none is in two', new Set(placed).size === placed.length);
    check('core stays out of both',
        !placed.some(k => LOG_FIELD_REGISTRY[k].relevance === 'core'));
    check('every section says what it is for',
        FIELD_GROUPS.every(g => g.title.length > 0 && g.hint.length > 30));
}

console.log('\n[one lambda bank always stays, and CORE ONLY leaves something to read]');
{
    // Both banks could be unchecked, and CORE ONLY switched every toggleable field off by itself —
    // so the table showed WHERE the engine was and nothing about what it was doing there, with
    // every checkbox in the panel dark. Reported 2026-08-24.
    for (const group of REQUIRED_FIELD_GROUPS) {
        check(`a group survives the defaults: ${group.join('/')}`,
            group.some(k => DEFAULT_FIELD_VISIBILITY[k]));
        check(`a group survives CORE ONLY: ${group.join('/')}`,
            group.some(k => CORE_ONLY_VISIBILITY[k]));
    }

    const both = { ...DEFAULT_FIELD_VISIBILITY, stft1: true, stft2: true };
    check('with both banks on, either may be switched off',
        !isLastOfRequiredGroup('stft1', both) && !isLastOfRequiredGroup('stft2', both));
    const one = { ...both, stft2: false };
    check('with one bank left, that one is locked', isLastOfRequiredGroup('stft1', one));
    check('the bank that is already off is not locked', !isLastOfRequiredGroup('stft2', one));
    check('a field in no group is never locked', !isLastOfRequiredGroup('rf', both));

    check('CORE ONLY keeps the three core fields',
        CORE_ONLY_VISIBILITY.rpm && CORE_ONLY_VISIBILITY.rawLoad && CORE_ONLY_VISIBILITY.correctedLoad);
    check('CORE ONLY is smaller than the defaults',
        TOGGLEABLE_FIELDS.filter(k => CORE_ONLY_VISIBILITY[k]).length
        < TOGGLEABLE_FIELDS.filter(k => DEFAULT_FIELD_VISIBILITY[k]).length);
    // A button that says "fewer" must not turn anything ON that the defaults leave off.
    check('CORE ONLY turns nothing on that the defaults have off',
        TOGGLEABLE_FIELDS.every(k => !CORE_ONLY_VISIBILITY[k] || DEFAULT_FIELD_VISIBILITY[k]));
}

console.log(fails === 0 ? '\nALL PASS' : '\n' + fails + ' FAILURE(S)');
process.exit(fails ? 1 : 0);
