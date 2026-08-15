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

console.log(fails === 0 ? '\nALL PASS' : '\n' + fails + ' FAILURE(S)');
process.exit(fails ? 1 : 0);
