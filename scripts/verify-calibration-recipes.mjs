/**
 * The calibration recipes and the evidence that goes with each parameter.
 *
 *   the recipes   every step names a parameter the catalog has; a constant is `set`, a run is
 *                 `fill`ed; the new value is one the bytes can hold exactly; and the shipped CSL 0401
 *                 image (public/mock, the SMG car) decodes, at every step, to the `from` the recipe's
 *                 sources saw — which pins the address mapping a reference tool's offsets went
 *                 through. Words an owner would use find the recipe.
 *   the evidence  the DME code's own conditions on the gearbox byte (== 0x40, == 0x70,
 *                 (x & 0x30) == 0x30, and nothing comparing it with 0x03); the XDF's choices for the
 *                 clutch-switch source; a description without the find routine's bookkeeping.
 *
 * What a wrong answer costs: an assistant telling an owner to stage 0x03 at the wrong byte, or
 * calling a value certain that one tool alone gave. Real catalog, shipped image; nothing written.
 */
import { readFileSync } from 'node:fs';
import { buildCatalog } from '../src/lib/calibration/catalog.ts';
import { decodeParam } from '../src/lib/calibration/decode.ts';
import { codeUses, paramChoices, paramNote } from '../src/lib/calibration/evidence.ts';
import { findRecipes, recipeParams, RECIPES } from '../src/lib/calibration/recipes.ts';
import { quantise } from '../src/lib/ecu-items/quantise.ts';

let fails = 0;
const check = (n, c, d) => { console.log('  ' + (c ? 'PASS' : 'FAIL') + '  ' + n + (c ? '' : ' — ' + (d ?? ''))); if (!c) fails++; };

const cat = buildCatalog(JSON.parse(readFileSync('public/data/calibration-graph.json', 'utf8')));
const image = readFileSync('public/mock/csl-0401-community-patch-v1.partial.bin');
const buffer = image.buffer.slice(image.byteOffset, image.byteOffset + image.byteLength);

console.log('\n[recipes: names, kinds, values, and the image before]');
check('there is at least one recipe', RECIPES.length >= 1);
for (const r of RECIPES) {
    const steps = [...r.steps, ...(r.choose?.options.flatMap(o => o.steps) ?? [])];
    check(`${r.id}: says how sure it is, why, and what is unverified, in both languages`,
        !!r.grade && !!r.gradeWhy.ja && !!r.gradeWhy.en && !!r.unverified.ja && !!r.unverified.en && r.sources.length >= 2);
    for (const s of steps) {
        const def = cat.byName.get(s.param);
        check(`${r.id} / ${s.param}: in the catalog, decodable, not locked`, !!def?.run && !def.lock.locked, def ? JSON.stringify(def.lock) : 'missing');
        if (!def?.run) continue;
        const target = s.set ?? s.fill;
        check(`...${s.set !== undefined ? 'set on a constant' : 'fill on a run'}`,
            (s.set !== undefined) === (def.run.count === 1) && (s.set === undefined) !== (s.fill === undefined), `count ${def.run.count}`);
        const q = quantise(def.run, target);
        check(`...${target} is a value the bytes hold exactly`, q.exact && !q.clamped, JSON.stringify(q));
        const before = decodeParam(buffer, def).value;
        check(`...the shipped SMG image holds the recipe's "before" (${s.from.map(b => b.toString(16)).join(' ')})`,
            !!before && before.raw.length === s.from.length && before.raw.every((b, k) => b === s.from[k]),
            before ? before.raw.map(b => b.toString(16)).join(' ') : 'undecodable');
        check('...and has a reason in both languages', !!s.why.ja && !!s.why.en);
    }
}
const manual = RECIPES.find(r => r.id === 'smg-to-manual');
check('smg-to-manual: both gearbox bytes go to 0x03',
    manual.steps.filter(s => /getriebetyp$/.test(s.param)).map(s => `${s.param}=${s.set}`).join() === 'cfg_m.getriebetyp=3,cfg_s.getriebetyp=3');
check('...the three SMG fault-code rows are zeroed whole',
    manual.steps.filter(s => s.fill === 0).map(s => s.param).sort().join() === 'DTC_06_SMG_CAN_TIMEOUT,DTC_7B_SMG_CAN_FAIL,DTC_B1_SMG_MIL');
check('...the clutch-switch wiring is the owner\'s choice, not a step', manual.choose?.options.length === 2
    && !manual.steps.some(s => s.param === 'K_SKRAFTS_CONTROL'));
check('...and it does not claim two sources for values one tool gave', manual.grade === 'single');
check('words an owner uses find it: マニュアル', findRecipes('マニュアル').some(r => r.id === 'smg-to-manual'));
check('...SMG manual', findRecipes('SMG manual').some(r => r.id === 'smg-to-manual'));
check('...or a parameter it touches', findRecipes('K_SKRAFTS_CONTROL').some(r => r.id === 'smg-to-manual'));
check('unrelated words find nothing', findRecipes('lambda heater').length === 0);
check('recipeParams lists the options\' parameters too', recipeParams(manual).includes('K_S_GANG_LL_ED'));

console.log('\n[evidence: the code, the choices, the description]');
{
    const m = codeUses(cat.graph, cat.byName.get('cfg_m.getriebetyp'));
    const whens = m.conditions.map(c => c.when);
    check('cfg_m.getriebetyp is read by many functions', m.readBy.count >= 10, String(m.readBy.count));
    check('...tested == 0x40 (SMG)', whens.includes('cfg_m_getriebetyp == 0x40'), whens.join(' | '));
    check('...== 0x70', whens.includes('cfg_m_getriebetyp == 0x70'));
    check('...and (x & 0x30) == 0x30, the C character literals turned into hex', whens.includes('(cfg_m_getriebetyp & 0x30) == 0x30'));
    check('...and never against 0x03', !whens.some(w => /0x03\b/.test(w)));
    check('each condition says where, a few places at most', m.conditions.every(c => c.in.length >= 1 && c.in.length <= 4));
    const s = codeUses(cat.graph, cat.byName.get('cfg_s.getriebetyp'));
    check('cfg_s.getriebetyp (slave) is tested == 0x40 too', s.conditions.some(c => c.when === 'cfg_s_getriebetyp == 0x40'));
    const k = paramChoices(cat.byName.get('K_SKRAFTS_CONTROL').desc.en);
    check('K_SKRAFTS_CONTROL: the XDF\'s choices 0, 1, 2', JSON.stringify(k) === JSON.stringify([
        { value: 0, label: 'aus V-Fz' }, { value: 1, label: 'aus S_Gang' }, { value: 2, label: 'aus S_Kuppl' }]), JSON.stringify(k));
    const hexChoices = cat.params.map(d => paramChoices(d.desc.en)).find(c => c?.some(x => x.value === 0x20 && x.label === 'E46'));
    check('a $-hex choice list reads as hex, with its ELSE', !!hexChoices && hexChoices.some(x => x.value === 'else'));
    check('no choices where the XDF lists none', paramChoices(cat.byName.get('cfg_m.getriebetyp').desc.en) === null);
    check('the find routine\'s bookkeeping is not a description', paramNote(cat.byName.get('cfg_m.getriebetyp').desc.en) === '');
    check('...a real description is kept', paramNote(cat.byName.get('DTC_06_SMG_CAN_TIMEOUT').desc.en) === '06 DME: Timeout SMG-CAN');
    const none = codeUses(cat.graph, cat.byName.get('DTC_06_SMG_CAN_TIMEOUT'));
    check('a table no code reads says so (0 readers), not an error', none.readBy.count === 0 && none.conditions.length === 0);
}

console.log(fails === 0 ? '\nALL PASS' : '\n' + fails + ' FAILURE(S)');
process.exit(fails ? 1 : 0);
