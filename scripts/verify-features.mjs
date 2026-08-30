/**
 * The feature registry, pinned.
 *
 * Two of these checks are policy, not plumbing. The production tab set is stated as a literal so
 * that promoting a feature — one word in features.ts — necessarily shows up as a diff HERE, in a
 * test, where it reads as the deliberate act it is supposed to be. And sessionSync's stage is
 * asserted directly, because production's privacy policy says sessions never leave the device;
 * the stage is the code-side half of that sentence.
 */
import { FEATURES, featureEnabled, enabledTabs, DRIVE_TARGETS, enabledDriveViews } from '../src/lib/features.ts';
import { armedLabels, anythingArmed } from '../src/lib/writeManifest.ts';

let fails = 0;
const check = (n, c, d) => { console.log('  ' + (c ? 'PASS' : 'FAIL') + '  ' + n + (c ? '' : ' — ' + (d ?? ''))); if (!c) fails++; };

const ALL_TABS = ['startup', 'current', 'lambda', 'new', 'diff', 'log',
    'rfkorr', 'warmup', 'inertia', 'lowload', 'idle', 'calibration'];

console.log('\n[every tab has exactly one owner]');
{
    const owners = new Map();
    for (const [name, def] of Object.entries(FEATURES)) {
        for (const tab of def.tabs) owners.set(tab, [...(owners.get(tab) ?? []), name]);
    }
    check("'startup' belongs to no feature — it always renders", !owners.has('startup'));
    const missing = ALL_TABS.filter(t => t !== 'startup' && !owners.has(t));
    check('no tab is unowned', missing.length === 0, `unowned: ${missing.join(', ')}`);
    const dup = [...owners.entries()].filter(([, v]) => v.length > 1);
    check('no tab has two owners', dup.length === 0, dup.map(([t, v]) => `${t}: ${v.join('+')}`).join('; '));
}

console.log('\n[sessionSync never reaches production — the privacy policy depends on it]');
check("sessionSync stage is 'preview-only'", FEATURES.sessionSync.stage === 'preview-only', FEATURES.sessionSync.stage);
check('...and it owns no tab', FEATURES.sessionSync.tabs.length === 0);

console.log('\n[featureEnabled truth table]');
{
    const byStage = (stage) => Object.entries(FEATURES).find(([, d]) => d.stage === stage)?.[0];
    const stable = byStage('stable'), exp = byStage('experimental'), pOnly = byStage('preview-only');
    check('a stable feature shows in production', featureEnabled(stable, false));
    check('a stable feature shows in preview', featureEnabled(stable, true));
    check('an experimental feature is CLOSED in production', !featureEnabled(exp, false));
    check('an experimental feature shows in preview', featureEnabled(exp, true));
    check('a preview-only feature is closed in production', !featureEnabled(pOnly, false));
    check('a preview-only feature shows in preview', featureEnabled(pOnly, true));
}

console.log('\n[the production tab set, as a literal]');
{
    // Promotion is one word in features.ts — and one line here, where it reads as a decision.
    // 'lowload' joined on 2026-08-26: SHAPE ships, and keeps its (EXP.) label for the reader.
    // The label and the stage answer different questions — whether it RENDERS, and how much to
    // trust it — so a shipped-but-experimental tab is not a contradiction.
    const production = [...enabledTabs(false)].sort();
    const expected = ['current', 'diff', 'lambda', 'log', 'lowload', 'new', 'startup', 'warmup'].sort();
    check('production shows the VE workflow and nothing else',
        JSON.stringify(production) === JSON.stringify(expected), production.join(', '));
    const preview = enabledTabs(true);
    check('preview shows every tab', ALL_TABS.every(t => preview.has(t)),
        ALL_TABS.filter(t => !preview.has(t)).join(', '));
}

console.log('\n' + '[the live drive targets, which a tab set cannot speak for]');
{
    // A tab is not the only surface a feature owns. LiveDriveStrip renders inside `lambda`, which
    // is STABLE, and one of its buttons used to switch the readout onto RF KORR's target -- so the
    // tab registry, which had already correctly closed the rfkorr TAB, said nothing about it. The
    // cues make it more than cosmetic: useDriveCues fires only in the RF KORR view, so a driver on
    // a production build who pressed that button got the cue behaviour of a feature that is not in
    // their build, at speed, with a phone on the dash.
    for (const [view, feature] of Object.entries(DRIVE_TARGETS)) {
        check(`'${view}' names a feature that exists`, feature in FEATURES, feature);
    }
    // Pinned as a literal for the same reason the tab set is: giving a live target to a second
    // feature has to show up as a diff here, where it reads as the decision it is.
    const production = enabledDriveViews(false).sort();
    check('production offers the VE target and nothing else',
        JSON.stringify(production) === JSON.stringify(['ve']), production.join(', '));
    check('preview offers every declared target',
        enabledDriveViews(true).length === Object.keys(DRIVE_TARGETS).length,
        enabledDriveViews(true).join(', '));
    // The clamp at the call site takes [0] with no null check, and the strip labels its three
    // readouts by the selected view. An empty list would render an undefined label.
    check('no variant is left with no target at all',
        enabledDriveViews(false).length > 0 && enabledDriveViews(true).length > 0);
}


console.log('\n[the hub summary and the WRITE gate are the same answer]');
{
    // These two must never come apart: the collapsed row SAYS armedLabels, the central ring is
    // GATED on anythingArmed. If a table can appear in one and not the other, the hub is telling
    // the driver one thing and doing another — the failure the manifest exists to end.
    const row = (o) => ({ id: o.label, kind: 'toggle', ...o });
    const g = (rows) => ({ id: 'g', title: 'WRITE', caption: '', rows });

    check('an armed, derivable toggle is listed',
        JSON.stringify(armedLabels(g([row({ label: 'VE', checked: true })]))) === '["VE"]');
    check('...and two are listed in row order',
        JSON.stringify(armedLabels(g([row({ label: 'VE', checked: true }), row({ label: 'RF KORR', checked: true })]))) === '["VE","RF KORR"]');
    check('an unchecked toggle is not listed', armedLabels(g([row({ label: 'VE' })])).length === 0);
    // The stored value outlives the evidence: a session reopened against another binary can carry
    // writeRfKorr = true with nothing derivable. The summary answers "what will happen".
    //
    // This is also what licenses ALPHA-N starting armed (useBinaryFile, 2026-08-30). A fresh BASE
    // with no drive has no derivation, so that row is disabled, so it contributes nothing here --
    // armed is not written. If this check ever fails, the VE default is no longer safe.
    check('a DISABLED toggle is not listed however it is stored',
        armedLabels(g([row({ label: 'VE', checked: true, disabled: true })])).length === 0);
    check('sealed, info and readout rows are never listed',
        armedLabels(g([{ id: 'i', label: 'IDLE', kind: 'sealed' }, { id: 'n', label: 'INERTIA', kind: 'info' },
            { id: 'r', label: 'MAP', kind: 'readout', status: 'OFF' }])).length === 0);

    check('the gate is false when nothing is armed anywhere',
        !anythingArmed([g([row({ label: 'VE' })]), g([row({ label: 'WOT FUEL', checked: true, disabled: true })])]));
    check('...and true as soon as any group contributes',
        anythingArmed([g([row({ label: 'VE' })]), g([row({ label: 'WOT FUEL', checked: true })])]));
    check('the gate agrees with the summaries it is built from',
        [[], [row({ label: 'A', checked: true })], [row({ label: 'B', disabled: true, checked: true })]]
            .every(rows => anythingArmed([g(rows)]) === (armedLabels(g(rows)).length > 0)));
}

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
