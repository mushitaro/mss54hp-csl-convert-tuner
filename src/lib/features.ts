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
 * ## Promoting a feature (the planned order: rfKorr → lowLoad + idle → inertia)
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
    | 'rfkorr' | 'warmup' | 'inertia' | 'lowload' | 'idle' | 'calibration';

export type FeatureStage = 'stable' | 'experimental' | 'preview-only';

export type FeatureName =
    | 've' | 'rfKorr' | 'lowLoad' | 'idle' | 'inertia' | 'calibration' | 'sessionSync';

export const FEATURES: Record<FeatureName, { stage: FeatureStage; tabs: readonly TabId[] }> = {
    // The trunk. WARMUP is inside it, not beside it: the warmup table is generated from the VE
    // result (`generateWarmupMap(newMap)`), so there is no state of the world where warmup is
    // promoted and VE is not. main ships exactly these tabs today.
    ve: { stage: 'stable', tabs: ['current', 'lambda', 'new', 'diff', 'log', 'warmup'] },
    // Promotion order when each is proven on the car: rfKorr first, then lowLoad and idle
    // together (they are two evidence sources for the same kf_rf_soll rows), then inertia.
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
     * It carries the LOW LOAD band of ALPHA-N with it, which is the same `kf_rf_soll` rows by the
     * other evidence rule. That is the whole feature, and shipping half of it would put a tab in
     * front of a contribution the WRITE menu could not name.
     */
    lowLoad: { stage: 'stable', tabs: ['lowload'] },
    idle: { stage: 'experimental', tabs: ['idle'] },
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

/** The tabs this variant may render, in no particular order — layout belongs to the page. */
export function enabledTabs(isPreview: boolean): ReadonlySet<TabId> {
    const out = new Set<TabId>(['startup']);
    for (const name of Object.keys(FEATURES) as FeatureName[]) {
        if (featureEnabled(name, isPreview)) FEATURES[name].tabs.forEach(t => out.add(t));
    }
    return out;
}
