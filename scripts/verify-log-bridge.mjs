/**
 * Every channel an exchange claims to provide reaches the LOG.
 *
 * `page.tsx` turns each `LiveMeasurement` into a `LogDataPoint` with an explicit object literal,
 * and that literal is the only bridge between the two. A channel the link decodes but the literal
 * does not name is read from the DME on every sample, carried through `mergeSlowLane`, spread onto
 * the measurement — and then dropped on the floor. Nothing errors, no column appears, and the run
 * looks perfect until somebody asks the log a question it cannot answer.
 *
 * This has now happened twice:
 *
 *   #922  the long-term trim stores. `ram8` ran all run, the gate confirmed 3/3, the log had none.
 *   #930  MD_DYN_ST and the four slew-limiter torque words, one day after they were added to the
 *         RAM map, the registry, the profile and the CSV — every layer but this one.
 *
 * Both were found by reading a drive back and noticing a column that was not there, which costs a
 * drive. The invariant is cheap and mechanical, so it belongs here instead:
 *
 *     every FieldKey named in a VE exchange's `provides` is named in the bridge literal.
 *
 * Read from the SOURCE TEXT rather than by running the page, because the literal is inside a React
 * component inside a callback and there is no seam to call. That is a weakness — a refactor that
 * renames the variable defeats it — so the extraction fails loudly rather than silently finding
 * nothing, which is the failure mode that would make this file worthless.
 *
 *     node scripts/verify-log-bridge.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOG_PROFILES } from '../src/lib/log-engine/logProfile.ts';
import { LOG_FIELD_REGISTRY } from '../src/lib/field-registry/registry.ts';

const root = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
let fails = 0;
const check = (n, c, d) => { console.log('  ' + (c ? 'PASS' : 'FAIL') + '  ' + n + (c ? '' : ' — ' + (d ?? ''))); if (!c) fails++; };

const src = fs.readFileSync(path.join(root, 'src', 'app', 'page.tsx'), 'utf8');

/** The literal, from its declaration to the brace that closes it. */
const OPEN = 'const point: LogDataPoint = {';
const start = src.indexOf(OPEN);
if (start < 0) {
    console.log('  FAIL  the bridge literal could not be found');
    console.log(`        looked for ${JSON.stringify(OPEN)} in src/app/page.tsx.`);
    console.log('        If it was renamed, update this file — do not delete the check.');
    process.exit(1);
}
let depth = 0, end = -1;
for (let i = start + OPEN.length - 1; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
}
if (end < 0) { console.log('  FAIL  the bridge literal is not brace-balanced'); process.exit(1); }
const literal = src.slice(start, end + 1);

/** `key: sample.key` — the only shape this literal uses, and the check says so rather than
 *  accepting anything so that a computed or renamed field is noticed rather than absorbed. */
const named = new Set([...literal.matchAll(/(\w+)\s*:\s*sample\.(\w+)/g)].map(m => m[1]));
const mismatched = [...literal.matchAll(/(\w+)\s*:\s*sample\.(\w+)/g)]
    .filter(m => m[1] !== m[2]).map(m => `${m[1]} <- sample.${m[2]}`);

console.log('\n[the bridge literal was found and reads the way this check assumes]');
check('it names at least twenty channels', named.size >= 20, `${named.size}`);
check('every entry copies the field of the same name', mismatched.length === 0, mismatched.join(', '));

console.log('\n[every channel an exchange provides reaches the log]');
for (const which of ['exchanges', 'fallback']) {
    const list = LOG_PROFILES.VE[which] ?? [];
    const provided = [...new Set(list.flatMap(x => [...(x.provides ?? [])]))].sort();
    const missing = provided.filter(k => !named.has(k));
    check(`VE ${which}: ${provided.length} provided, all on the bridge`, missing.length === 0,
        `dropped between the link and the log: ${missing.join(', ')}`);
}

console.log('\n[and nothing on the bridge is a channel the registry does not know]');
{
    const unknown = [...named].filter(k => !(k in LOG_FIELD_REGISTRY));
    // Qualifiers on a channel rather than channels, so they have no registry entry by design —
    // logProfile's note on `provides` names the three explicitly. `time` is the sample clock, which
    // every row has and no exchange provides.
    const ALLOWED = [
        'ambientPressureSubstituted', 'ambientTempFromCan', 'pressureDecodeDisagreesMbar',
        'stftSource', 'time',
    ];
    const strays = unknown.filter(k => !ALLOWED.includes(k));
    check('no stray keys', strays.length === 0, strays.join(', '));
}

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
