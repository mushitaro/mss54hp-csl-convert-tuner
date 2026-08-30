/**
 * What the SAVE control says, and whether it can be pressed.
 *
 * There was no way back. With a tune derived, the phase was 'ready' for ever: the label read
 * "Save to session" before the save and "Save to session" after it, the cell stayed lit, and
 * pressing it again wrote the same bytes. A control whose only two outcomes look identical cannot
 * report success, and the operator asked the obvious question — did it save? (2026-08-24)
 *
 * Two properties are checked here because both were broken and each hid the other:
 *
 *   1. every state that means "your work is stored" is disabled AND wears the done tone, and every
 *      state that has something to write is pressable. A settled state that stays pressable is the
 *      original defect; a done state greyed like 'nothing yet' is the same defect wearing a
 *      different coat, because on a phone the colour is all that is left once the label is read.
 *   2. no label grows back into a sentence. This cell is 56px wide in the menu sheet and truncates,
 *      and `title` is a hover tooltip on a device with no hover — so a label that does not fit is a
 *      state the driver cannot read at all.
 *
 * The signature that decides 'saved' vs 'ready' lives in page.tsx and is not testable from here.
 * What IS testable is that the state exists and behaves, which is what was missing.
 */
import { describeSave } from '../src/lib/session-sync/status.ts';

let fails = 0;
const check = (n, c, d) => { console.log('  ' + (c ? 'PASS' : 'FAIL') + '  ' + n + (c ? '' : ' — ' + d)); if (!c) fails++; };

/** Every phase the type allows. A new one must be added here, which is the point. */
const PHASES = [
    'runRecorded', 'nothing', 'baseOnly', 'logOnly', 'archived', 'logging', 'busy', 'saved', 'ready',
];

/** The states in which the work IS on the device and there is nothing to press. */
const SETTLED = ['runRecorded', 'baseOnly', 'archived', 'saved'];
/** The states with something outstanding to write. */
const PRESSABLE = ['logOnly', 'ready'];

console.log('\n[a settled state says so, and cannot be pressed]');
for (const phase of SETTLED) {
    const look = describeSave({ phase });
    check(`${phase} is disabled`, look.disabled, 'a stored tune must not offer to store itself again');
    check(`${phase} wears the done tone`, look.tone === 'done',
        `got ${look.tone} — grey is what "nothing here" looks like, and this is a result`);
}

console.log('\n[an outstanding state can be pressed]');
for (const phase of PRESSABLE) {
    const look = describeSave({ phase });
    check(`${phase} is pressable`, !look.disabled, 'there is something unwritten and no way to write it');
    check(`${phase} is lit`, look.tone === 'ready', `got ${look.tone}`);
}

console.log('\n[the two words this control is allowed to say]');
check('ready says SAVE', describeSave({ phase: 'ready' }).label === 'Save',
    `got "${describeSave({ phase: 'ready' }).label}"`);
check('saved says SAVED', describeSave({ phase: 'saved' }).label === 'Saved',
    `got "${describeSave({ phase: 'saved' }).label}"`);
check('logOnly says SAVE too', describeSave({ phase: 'logOnly' }).label === 'Save',
    'a research run is still a save, and the cell is too narrow to explain the difference');
check('ready and saved differ', describeSave({ phase: 'ready' }).label !== describeSave({ phase: 'saved' }).label,
    'the whole defect: pressing it changed nothing on screen');

console.log('\n[every state fits the cell, and explains itself]');
for (const phase of PHASES) {
    const look = describeSave({ phase });
    const words = look.label.trim().split(/\s+/).length;
    check(`${phase} label is at most two words`, words <= 2, `"${look.label}" is ${words}`);
    check(`${phase} has a title`, look.title.length > 40,
        'a disabled control that cannot explain itself is the one that gets reported as broken');
}

console.log(fails === 0 ? '\nAll save-state checks passed.\n' : `\n${fails} FAILED\n`);
process.exit(fails === 0 ? 0 : 1);
