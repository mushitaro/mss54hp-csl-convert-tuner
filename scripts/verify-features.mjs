/**
 * The feature registry, pinned.
 *
 * Two of these checks are policy, not plumbing. The production tab set is stated as a literal so
 * that promoting a feature — one word in features.ts — necessarily shows up as a diff HERE, in a
 * test, where it reads as the deliberate act it is supposed to be. And sessionSync's stage is
 * asserted directly, because production's privacy policy says sessions never leave the device;
 * the stage is the code-side half of that sentence.
 */
import { FEATURES, featureEnabled, enabledTabs, DRIVE_TARGETS, enabledDriveViews,
    MODE_FEATURES, MODE_TABS, SHARED_TABS,
    MODE_WRITES, writeRowInMode } from '../src/lib/features.ts';
import { selectableModes, LOG_PROFILES } from '../src/lib/log-engine/logProfile.ts';
import { armedLabels, anythingArmed } from '../src/lib/writeManifest.ts';

let fails = 0;
const check = (n, c, d) => { console.log('  ' + (c ? 'PASS' : 'FAIL') + '  ' + n + (c ? '' : ' — ' + (d ?? ''))); if (!c) fails++; };

const ALL_TABS = ['startup', 'current', 'lambda', 'new', 'diff', 'log',
    'rfkorr', 'warmup', 'inertia', 'shape', 'idle', 'lls', 'calibration'];

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
    // 'shape' joined on 2026-08-26: SHAPE ships, and keeps its (EXP.) label for the reader.
    // It was called 'lowload' until 2026-09-09, when the low-opening derivation it was named
    // after went away and the tab was left holding a name for something it never showed.
    // The label and the stage answer different questions — whether it RENDERS, and how much to
    // trust it — so a shipped-but-experimental tab is not a contradiction.
    const production = [...enabledTabs(false)].sort();
    const expected = ['current', 'diff', 'lambda', 'log', 'shape', 'new', 'startup', 'warmup'].sort();
    check('production shows the VE workflow and nothing else',
        JSON.stringify(production) === JSON.stringify(expected), production.join(', '));
    const preview = enabledTabs(true);
    check('preview shows every tab', ALL_TABS.every(t => preview.has(t)),
        ALL_TABS.filter(t => !preview.has(t)).join(', '));
}

console.log('\n[MODE, which a tab set cannot speak for either]');
{
    // MODE HIDES tabs. A variant that offers a mode whose tab it closes therefore collapses the
    // strip to STARTUP alone, with the run's own panel unreachable and no way back but the corner
    // -- the exact trap the removed IDLE MODE switch sprang. Pinned as a literal for the reason
    // the tab set is: promoting `idle` is one word in features.ts, and it has to appear here as a
    // diff, where it reads as the decision it is.
    const production = selectableModes(false);
    check('production offers VE and nothing else',
        JSON.stringify(production) === JSON.stringify(['VE']), production.join(', '));
    const preview = selectableModes(true);
    check('preview offers all four',
        JSON.stringify(preview) === JSON.stringify(['VE', 'IDLE', 'LLS', 'INERTIA']), preview.join(', '));

    // Every mode names a real, runnable profile -- and every runnable profile is reachable. The
    // second half is the one that would otherwise rot: a profile could be marked runnable and
    // offered nowhere, which is how EGT would look if it were ever un-retired without an entry.
    const modes = Object.keys(MODE_FEATURES);
    check('every MODE names a real profile', modes.every(m => LOG_PROFILES[m] !== undefined),
        modes.filter(m => !LOG_PROFILES[m]).join(', '));
    check('every MODE is runnable', modes.every(m => LOG_PROFILES[m] && LOG_PROFILES[m].runnable),
        modes.filter(m => LOG_PROFILES[m] && !LOG_PROFILES[m].runnable).join(', '));
    const runnable = Object.keys(LOG_PROFILES).filter(id => LOG_PROFILES[id].runnable);
    check('every runnable profile is reachable from MODE',
        runnable.every(id => modes.includes(id)),
        runnable.filter(id => !modes.includes(id)).join(', '));

    // The invariant this whole section exists for: a mode that is OFFERED must have its tabs OPEN.
    // Asserted per variant rather than once, because the two answers differ and only one of them
    // is the one that ships.
    for (const isPreview of [false, true]) {
        const tabs = enabledTabs(isPreview);
        const bad = selectableModes(isPreview)
            .filter(m => !FEATURES[MODE_FEATURES[m]].tabs.every(t => tabs.has(t)));
        check('every offered mode has its tabs open (' + (isPreview ? 'preview' : 'production') + ')',
            bad.length === 0, bad.join(', '));
    }
}

console.log('\n[the tab arrangements MODE stands up]');
{
    // Every tab reachable from at least one mode. Without this, adding a tab to the union type and
    // to a feature makes it render NOWHERE -- the page walks the mode's list, so a tab nobody
    // listed is a tab nobody sees, and the failure is silent in exactly the way a missing tab is.
    const listed = new Set(Object.values(MODE_TABS).flat());
    const orphan = ALL_TABS.filter(t => !listed.has(t));
    check('every tab is reachable from some mode', orphan.length === 0, orphan.join(', '));

    // ...and nothing is listed that is not a tab.
    const unknown = [...listed].filter(t => !ALL_TABS.includes(t));
    check('no arrangement names a tab that does not exist', unknown.length === 0, unknown.join(', '));

    // Every mode's own tab is IN its arrangement, and no other mode's is. This is the check that
    // caught VE standing up IDLE and INERTIA: VE was 'everything this build offers', which put two
    // stationary runs inside the driving workflow (operator, 2026-09-03).
    for (const [mode, feature] of Object.entries(MODE_FEATURES)) {
        const own = FEATURES[feature].tabs;
        check(`${mode} stands up its own tabs`,
            own.every(t => MODE_TABS[mode].includes(t)),
            own.filter(t => !MODE_TABS[mode].includes(t)).join(', '));
        const foreign = Object.entries(MODE_FEATURES)
            .filter(([other]) => other !== mode)
            .flatMap(([, f]) => FEATURES[f].tabs)
            // Sharing is the answer, and it is DECLARED -- see SHARED_TABS. What this refuses is
            // an undeclared borrow, which is how VE came to stand up IDLE and INERTIA.
            .filter(t => !own.includes(t) && !SHARED_TABS.includes(t) && MODE_TABS[mode].includes(t));
        check(`${mode} stands up no other mode's`, foreign.length === 0, foreign.join(', '));
    }

    // A shared tab must be OWNED by a stable feature. It is stood up by a mode whose own feature
    // may be closed in production, so a shared tab gated on an experimental one would vanish from
    // an arrangement that had every right to it.
    for (const t of SHARED_TABS) {
        const owner = Object.entries(FEATURES).find(([, d]) => d.tabs.includes(t))?.[0];
        check(`shared tab '${t}' has an owner`, !!owner);
        check(`shared tab '${t}' is owned by a stable feature`,
            !!owner && FEATURES[owner].stage === 'stable', owner && FEATURES[owner].stage);
    }

    // STARTUP first in every arrangement: it owns the session, and every mode begins by choosing
    // one. Pinned because the ORDER is the thing the arrangement adds over a filter.
    const badFirst = Object.entries(MODE_TABS).filter(([, tabs]) => tabs[0] !== 'startup');
    check('every arrangement opens on STARTUP', badFirst.length === 0,
        badFirst.map(([m, t]) => m + ': ' + t[0]).join(', '));

    // ...and a mode's own tab comes SECOND, right after it. An idle run's first screen is the run.
    for (const [mode, feature] of Object.entries(MODE_FEATURES)) {
        const own = FEATURES[feature].tabs;
        if (own.length !== 1) continue;   // VE owns six; there is no single "its own" to place
        check(`${mode} puts its own tab second`, MODE_TABS[mode][1] === own[0],
            MODE_TABS[mode][1]);
    }
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

/**
 * WHICH WRITE ROWS EACH MODE OFFERS.
 *
 * The fourth surface this registry speaks for, and the one that leaked longest: MODE_TABS hid the
 * tabs an IDLE session does not use, and had nothing to say about the WRITE menu — so that session
 * was still offered ALPHA-N, SHAPE, WARMUP and RF KORR, four derivations of `kf_rf_soll` a
 * stationary idle produces no evidence for, listed above the one row it can actually arm.
 *
 * Pinned as literals for the reason the production tab set is: the sets are the deliberate act, and
 * a row moving between modes has to show up in this test's diff.
 */
console.log('\n[the WRITE rows each MODE offers]');
{
    const expect = {
        VE: ['alphan', 'shape', 'warmup', 'rfkorr'],
        EGT: ['alphan', 'shape', 'warmup', 'rfkorr'],
        IDLE: ['idle'],
        INERTIA: ['inertia'],
    };
    for (const [mode, rows] of Object.entries(expect)) {
        check(`${mode} offers exactly ${rows.join(' ')}`,
            JSON.stringify([...MODE_WRITES[mode]]) === JSON.stringify(rows),
            JSON.stringify(MODE_WRITES[mode]));
    }

    // THE LEAK ITSELF, as a test: an idle session is not offered the VE derivations.
    for (const row of ['alphan', 'shape', 'warmup', 'rfkorr']) {
        check(`IDLE does not offer ${row}`, writeRowInMode(row, 'IDLE') === false);
        check(`...and VE does`, writeRowInMode(row, 'VE') === true);
    }
    check('IDLE offers the idle row', writeRowInMode('idle', 'IDLE') === true);
    check('...and VE does not', writeRowInMode('idle', 'VE') === false);
    check('INERTIA offers the inertia row', writeRowInMode('inertia', 'INERTIA') === true);
    check('...and IDLE does not', writeRowInMode('inertia', 'IDLE') === false);

    // Rows no mode claims must survive every mode. The RESTORE and PATCH groups are not filtered at
    // all, but a typed value from the CALIBRATION tab sits in the WRITE group and is nobody's
    // derivation — hiding it in two of the three modes would lose an edit the operator made.
    for (const mode of Object.keys(expect)) {
        check(`${mode} keeps a calibration edit`, writeRowInMode('cal:0x9E10', mode) === true);
        check(`...and keeps an unclaimed row`, writeRowInMode('wotfuel', mode) === true);
    }

    // A reopened session naming a profile this registry has not heard of must show everything
    // rather than silently hide the row that would write it.
    check('an unknown mode hides nothing',
        ['alphan', 'idle', 'inertia', 'wotfuel'].every(r => writeRowInMode(r, 'SOMETHING_NEW')));

    // Every mode with an arrangement has a WRITE set, or a mode could be selectable with no row in
    // the menu that produced it — a session that can run and cannot write.
    const missing = Object.keys(MODE_TABS).filter(m => !MODE_WRITES[m]);
    check('every MODE_TABS arrangement has a WRITE set', missing.length === 0, missing.join(', '));
}

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
