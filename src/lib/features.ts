/**
 * Which features a build variant shows — the registry that closes experiments in production.
 *
 * One codebase serves two deployments: production (GitHub Pages, from main, plain `npm run build`)
 * and preview (Cloudflare Pages, `npm run build:preview`). They are the SAME compiled output — the
 * preview is distinguished only by a `<meta name="app-variant">` the branding script injects, read
 * at runtime by `useIsPreviewBuild()` (build-variant.ts). This registry rides on that: a feature
 * staged `experimental` exists in every bundle and renders only where the variant says preview.
 * No compile-time branching, so main and the experiment can never diverge in code — integrating a
 * tested module is a merge plus one word here, not a port.
 *
 * ## Stages
 *
 *   - `stable`        — shown in every variant. What main ships.
 *   - `experimental`  — shown in preview only. The tab keeps its position and its (EXP.) label;
 *                       production simply does not render it, or its WRITE-manifest rows.
 *   - `preview-only`  — shown in preview only, like experimental, but NOT awaiting promotion:
 *                       a deliberate decision that production never gets it.
 *
 * ## Promoting a feature (the planned order: rfKorr → idle → inertia)
 *
 *   1. Change its stage below to 'stable' — one word. verify:features pins the production tab set,
 *      so the promotion shows up in that test's diff and cannot happen by accident.
 *   2. Run every verify suite.
 *   3. At main-integration time (a separate, deliberate step — not part of any promotion):
 *      cherry-pick main's own c3db356, merge this branch into main, build the PRODUCTION variant
 *      locally and check the tab set before pushing — the push itself deploys.
 *
 * `sessionSync` is `preview-only` by decision, not by immaturity: production stays local-complete —
 * sessions live in IndexedDB on the device and are sent nowhere — and the production privacy policy
 * says so. Promoting it would falsify that sentence, which is why verify:features asserts the stage.
 */

/** Every tab the app can render. Declared here rather than in page.tsx because the registry below
 *  must name tabs, and the page already imports from lib. The ORDER of tabs is not stated here —
 *  the page owns layout; this file only answers "may this render in this variant". */
export type TabId =
    | 'startup' | 'current' | 'lambda' | 'new' | 'diff' | 'log'
    | 'rfkorr' | 'warmup' | 'inertia' | 'shape' | 'idle' | 'lls' | 'calibration';

export type FeatureStage = 'stable' | 'experimental' | 'preview-only';

export type FeatureName =
    | 've' | 'rfKorr' | 'shape' | 'idle' | 'lls' | 'inertia' | 'calibration' | 'sessionSync';

export const FEATURES: Record<FeatureName, { stage: FeatureStage; tabs: readonly TabId[] }> = {
    // The trunk. WARMUP is inside it, not beside it: the warmup table is generated from the VE
    // result (`generateWarmupMap(newMap)`), so there is no state of the world where warmup is
    // promoted and VE is not. main ships exactly these tabs today.
    ve: { stage: 'stable', tabs: ['current', 'lambda', 'new', 'diff', 'log', 'warmup'] },
    // Promotion order when each is proven on the car: rfKorr first, then idle, then inertia.
    rfKorr: { stage: 'experimental', tabs: ['rfkorr'] },
    /**
     * SHIPPED, and still marked experimental where the reader sees it (operator, 2026-08-26).
     *
     * The two are not in conflict. This stage decides whether the surfaces RENDER; the tab's own
     * label — `SHAPE (EXP.)` — is what tells the reader how much to trust them, and it stays.
     * Promoting it out of turn is deliberate: the SHAPE write is a MODE on the ALPHA-N write rather
     * than a table of its own, so it cannot reach the flash without the stable feature beside it
     * being armed first, and the manifest now locks it that way.
     *
     * The tab and the SHAPE row of the WRITE manifest travel together, because one stage decides
     * both. Shipping half of it would put a tab in front of a contribution the WRITE menu could
     * not name.
     */
    shape: { stage: 'stable', tabs: ['shape'] },
    idle: { stage: 'experimental', tabs: ['idle'] },
    /**
     * The micro-throttle ring. Experimental because the thing it claims — that flattening the ring
     * lifts the phase margin from 39 to 46 degrees — is COMPUTED and has never been read back off
     * the car. The direction was confirmed by feel on a hand-applied table; the number was not.
     *
     * It shares `KF_LLS_TV` with `idle`, and `composeLlsTv` is what keeps one owner per cell.
     */
    lls: { stage: 'experimental', tabs: ['lls'] },
    inertia: { stage: 'experimental', tabs: ['inertia'] },
    calibration: { stage: 'experimental', tabs: ['calibration'] },
    // Never promoted — see the header. Owns no tab; its surfaces (SYNC, the store panel) are
    // gated where they render, on the same variant bit this registry reads.
    sessionSync: { stage: 'preview-only', tabs: [] },
};

/**
 * The dev server counts as preview. The meta is injected post-build, so `next dev` never carries
 * it — and a dev session with the experiments hidden would be a dev session on the wrong app.
 * NODE_ENV is inlined by Next at compile time: 'production' in BOTH deployed variants (they come
 * out of the same `next build`), 'development' only under `next dev`. The same discrimination
 * OfflineCache already uses to skip the service worker in dev.
 */
export const DEV_VARIANT_IS_PREVIEW = process.env.NODE_ENV !== 'production';

/** Whether a feature may render in this variant. `startup` belongs to no feature and always shows. */
export function featureEnabled(name: FeatureName, isPreview: boolean): boolean {
    const stage = FEATURES[name].stage;
    return stage === 'stable' || isPreview;
}

/**
 * The LIVE DRIVE TARGETS — the per-run readout on LAMBDA that says what this drive still owes.
 *
 * ## Why this is here and not in the component
 *
 * A tab is not the only surface a feature owns. `lambda` is stable, `LiveDriveStrip` renders
 * unconditionally inside it, and until this existed one of its buttons switched the readout onto
 * RF KORR's target — a feature the production build cannot show or write. The registry above gates
 * TABS, so it had nothing to say about a control inside a stable one.
 *
 * That is not a small leak. `useDriveCues` fires the audio and haptic cues only in the RF KORR
 * view, so a driver on a production build who pressed that button got the cue behaviour of a
 * feature that is not in their build, at speed, with a phone on the dash.
 *
 * So the views are declared HERE, each naming the feature that owns it, and the list a variant may
 * offer is derived the same way the tab set is. `satisfies` makes the mapping total and checks
 * every value against a real `FeatureName`: a view whose feature was renamed stops compiling, and
 * a new view cannot be added without saying who owns it.
 *
 * `ve` maps to the trunk, so the list is never empty — a build with no drive target at all would
 * have no LAMBDA tab either.
 */
export const DRIVE_TARGETS = {
    /** Samples still needed in THIS cell of (rpm x aq_rel_rf). Clock is dwell in the cell. */
    ve: 've',
    /** Seconds still needed above the filling floor. Clock is the settle timer. */
    rfkorr: 'rfKorr',
} as const satisfies Record<string, FeatureName>;

/** Which drive target the strip is showing. Never two at once — see LiveDriveStrip. */
export type DriveView = keyof typeof DRIVE_TARGETS;

/**
 * The drive views this variant may offer, in declaration order.
 *
 * Always non-empty (see above), so callers can take `[0]` as the fallback without a null check —
 * which is what makes the clamp at the call site a derived value rather than an effect.
 */
export function enabledDriveViews(isPreview: boolean): DriveView[] {
    return (Object.keys(DRIVE_TARGETS) as DriveView[])
        .filter(view => featureEnabled(DRIVE_TARGETS[view], isPreview));
}

/**
 * MODE — which of the three runs a session can be started as, and who owns each.
 *
 * The third surface this registry has had to speak for, and it arrived by the same route as
 * DRIVE_TARGETS above: a tab is not the only thing a feature owns. MODE hides tabs, so a variant
 * that offered IDLE while the IDLE tab was closed would collapse the strip to STARTUP alone and
 * leave no way back except finding the corner again — which is exactly the trap the removed IDLE
 * MODE switch sprang, and it would have shipped to production.
 *
 * Keyed by `ProcessId`, deliberately not typed as one: `ProcessId` lives in log-engine, this file
 * imports nothing, and the page asserts the two agree by using this map to filter that union. What
 * `satisfies` pins here is the other half — every value is a real FeatureName, so renaming a
 * feature stops this compiling rather than silently opening a mode.
 */
export const MODE_FEATURES = {
    VE: 've',
    IDLE: 'idle',
    LLS: 'lls',
    INERTIA: 'inertia',
} as const satisfies Record<string, FeatureName>;

/** The MODE ids, as this registry knows them. */
export type ModeId = keyof typeof MODE_FEATURES;

/** Which modes this variant may offer, in declaration order. Never empty — `ve` is the trunk. */
export function enabledModes(isPreview: boolean): ModeId[] {
    return (Object.keys(MODE_FEATURES) as ModeId[])
        .filter(id => featureEnabled(MODE_FEATURES[id], isPreview));
}

/**
 * Which tabs each MODE stands up, IN THE ORDER IT STANDS THEM UP.
 *
 * The order is here and not in the page, which reverses what the note on `TabId` above says, and
 * the reversal is the point: there is no longer ONE reading order to be the page's. VE reads
 * current → measured → derived; an idle run reads run → evidence → bytes, and putting the run's own
 * panel fourth because that is where it sits in the VE list makes the mode's first screen the
 * hardest one to find. The page still owns LAYOUT — where the strip is, how it scrolls, what a tab
 * looks like — it just no longer owns the sequence.
 *
 * VE is listed rather than left as "everything", which it was for one build and which was wrong in
 * the obvious way: it stood up the IDLE and INERTIA tabs inside the VE workflow, where they belong
 * to no step of it (operator, 2026-09-03).
 *
 * `calibration` is in all three: the item browser is where any of these ends up when the question
 * becomes "what does the byte actually say". `log` is in two, wearing a different name in each —
 * see the tab's label.
 *
 * Typed against `string` rather than `ProcessId`, because that type lives in log-engine and this
 * file imports nothing. The real check is at the call site: the page indexes this with a
 * `ProcessId`, so a profile added without an entry here stops the page compiling. verify:features
 * covers the other direction — every tab must be reachable from at least one mode, or adding one
 * makes it invisible everywhere.
 */
const VE_TABS = [
    'startup', 'current', 'lambda', 'new', 'diff', 'log', 'shape', 'warmup', 'rfkorr', 'calibration',
] as const;

export const MODE_TABS = {
    VE: VE_TABS,
    // Retired, and reopened sessions still name it. An EGT log feeds the VE surfaces, so it reads
    // the VE workflow; what it cannot do is be started — see LogProfile.runnable.
    EGT: VE_TABS,
    // The run first. Standing beside a car with the bonnet up, IDLE is the screen; IDLE LOG is the
    // evidence behind what it just said, and CALIBRATION is the bytes every threshold came from.
    IDLE: ['startup', 'idle', 'log', 'calibration'],
    // Same shape as IDLE, for the same reason: the run is the screen, LOG is the evidence behind
    // it, CALIBRATION is the bytes. Unlike IDLE this one is driven, so the log tab is not optional
    // — Td and the operating band come out of the samples, not out of the map.
    LLS: ['startup', 'lls', 'log', 'calibration'],
    // No log tab: an inertia run has no per-sample view yet. The estimate and its regression are
    // the panel's, and a tab that opened on nothing would be a destination that does nothing.
    INERTIA: ['startup', 'inertia', 'calibration'],
} as const satisfies Record<string, readonly TabId[]>;

/**
 * WHICH WRITE-MANIFEST ROWS EACH MODE OFFERS — the fourth surface this registry has had to speak
 * for, and it arrived by exactly the route the two above it did.
 *
 * `MODE_TABS` hides the tabs a mode does not use. It had nothing to say about the WRITE menu, so an
 * IDLE session was still offered ALPHA-N, SHAPE, WARMUP and RF KORR: four derivations of
 * `kf_rf_soll` that a stationary idle run produces no evidence for, listed above the one row that
 * session can actually arm (operator, 2026-09-03).
 *
 * The line is WHAT THE SESSION PRODUCES. A WRITE row is a derivation — the mode decides which
 * derivation this run is making, so the mode owns the row. RESTORE and PATCH are not derivations:
 * putting a drifted table back to stock, or turning the MAP diagnostic off, is repair and
 * configuration, true whichever run you are on. Those groups are not filtered, and
 * `MODE_FREE_WRITE_ROWS` says so out loud rather than leaving it to the absence of an entry.
 *
 * Row ids, not features, because the mapping is not one-to-one in either direction: `shape` belongs
 * to the `shape` feature and to the VE mode, and `cal:*` rows belong to `calibration` — a feature
 * whose tab every mode stands up, because "what does the byte actually say" is a question from all
 * three.
 */
export const MODE_WRITES = {
    VE: ['alphan', 'shape', 'warmup', 'rfkorr'],
    // Retired, and reads the VE workflow — see MODE_TABS.
    EGT: ['alphan', 'shape', 'warmup', 'rfkorr'],
    IDLE: ['idle'],
    LLS: ['lls'],
    INERTIA: ['inertia'],
} as const satisfies Record<string, readonly string[]>;

/**
 * Rows in the WRITE group that no mode owns.
 *
 * `cal:*` is a value the operator typed on the CALIBRATION tab. It is not derived from a run, so no
 * run's mode can be its owner, and the tab it comes from is open in every mode.
 */
export const MODE_FREE_WRITE_ROWS = (id: string): boolean => id.startsWith('cal:');

/**
 * Whether a WRITE-group row belongs on screen in this mode.
 *
 * An unknown mode shows everything: a reopened session naming a profile this registry has not heard
 * of must not silently hide the row that would write it.
 */
export function writeRowInMode(rowId: string, mode: string): boolean {
    if (MODE_FREE_WRITE_ROWS(rowId)) return true;
    const owned = (MODE_WRITES as Record<string, readonly string[]>)[mode];
    if (!owned) return true;
    // A row no mode claims is a row this function must not hide — it would vanish everywhere.
    const claimed = Object.values(MODE_WRITES).some(rows => (rows as readonly string[]).includes(rowId));
    return claimed ? owned.includes(rowId) : true;
}

/**
 * Tabs a mode stands up WITHOUT owning, declared rather than tolerated.
 *
 * `log` is the evidence viewer, and both the driving run and the stationary one have evidence. It
 * wears a different name in each arrangement (CORRECTED LOG / IDLE LOG) and draws a different
 * table, but it is one tab in one slot, so it has one owner: `ve`, which is the trunk and always
 * stable, so the tab is open wherever any mode asks for it. Owning it twice is what the registry
 * forbids; sharing it is what this says out loud.
 *
 * `startup` needs no entry (it belongs to no feature) and neither does `calibration` (its owner is
 * not any mode's own feature, so no mode is borrowing another's).
 */
export const SHARED_TABS: readonly TabId[] = ['log'];

/** The tabs this variant may render, in no particular order — layout belongs to the page. */
export function enabledTabs(isPreview: boolean): ReadonlySet<TabId> {
    const out = new Set<TabId>(['startup']);
    for (const name of Object.keys(FEATURES) as FeatureName[]) {
        if (featureEnabled(name, isPreview)) FEATURES[name].tabs.forEach(t => out.add(t));
    }
    return out;
}
