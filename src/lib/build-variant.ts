'use client';

import { useSyncExternalStore } from 'react';
import { featureEnabled, DEV_VARIANT_IS_PREVIEW, type FeatureName } from '@/lib/features';

/**
 * Whether this is a preview build rather than production.
 *
 * Read from a `<meta name="app-variant">` that `scripts/brand-preview.mjs` injects into the export.
 * Deliberately NOT a compiled constant or an env var: both deployments come out of the same
 * `next build`, so anything baked at compile time would have to be baked differently per target and
 * the variant would end up with two definitions to keep in step. The branding script already owns
 * the name; it owns this too.
 *
 * ## Why a hook and not a module constant
 *
 * The obvious `export const isPreviewBuild = document.querySelector(...)` is wrong, and quietly:
 * it evaluates to false during the static prerender and true on the client, so the hydrating render
 * disagrees with the markup it is hydrating. `getServerSnapshot` is the API for exactly this — the
 * prerender answers "production", the client answers truthfully, and React reconciles the two
 * without a mismatch. (The same reasoning as useInstallPrompt.)
 *
 * Nothing to subscribe to: the tag cannot change while the document is alive.
 */
const subscribeNever = () => () => { };

const readTag = (): string =>
    document.querySelector('meta[name="app-variant"]')?.getAttribute('content') ?? '';

/**
 * What this build calls itself: `preview`, `staging`, or empty for production.
 *
 * Empty is the honest answer for production rather than the string 'production', because nothing
 * writes that tag — production is the build nobody branded, and inventing a name for the absence
 * would be a value no code path can produce.
 */
export function useBuildVariant(): string {
    return useSyncExternalStore(subscribeNever, readTag, () => '');
}

/**
 * Whether the EXPERIMENTS are open. Only `preview` opens them.
 *
 * Staging must answer false here. It is the release candidate — main, unmodified — and a candidate
 * that renders more than the release would be testing something that is not going out.
 */
export function useIsPreviewBuild(): boolean {
    return useBuildVariant() === 'preview';
}

/**
 * THE SCOPE SWITCH — preview, rendering the set of surfaces production renders.
 *
 * ## Why it exists
 *
 * Checking a change meant looking at staging, because staging is what production will show. But
 * staging is `main`, so every look cost a release cut, and every fix after a look meant deploying
 * two environments and deciding which — a decision that kept being got wrong (operator, 2026-08-31).
 *
 * Nothing about the feature gate is compiled. `featureEnabled` takes a boolean, and that boolean
 * comes from a meta tag read at runtime. So the preview build can answer the production question
 * without being a different build, and the second environment stops being on the path.
 *
 * ## It can only CLOSE, never open
 *
 * That is structural, not a rule to remember. This flag is only ever ANDed with `!` into a variant
 * that is already preview: production carries no `app-variant` tag, so `useBuildVariant()` returns
 * `''` there and no value of this can make it 'preview'. The worst a tampered localStorage entry
 * can do to a production build is close experiments that were never open.
 *
 * ## What it does NOT prove
 *
 * The two deployments differ by their TREE as well as their variant — `main` carries no
 * `functions/`, so staging has no `/api` and preview does. That difference cannot be simulated here
 * and this switch does not claim to: it answers "what does production RENDER", which is the
 * question the last dozen checks were actually asking. Anything about the backend still needs the
 * environment it lives in.
 *
 * Entered by `?scope=production` on the URL or by clicking the build badge, and remembered in
 * localStorage so a reload does not silently put the experiments back.
 */
const SCOPE_KEY = 'mss54hp.scope';
const SCOPE_PRODUCTION = 'production';

/** Read once and cached: `getSnapshot` runs on every render and must not touch storage each time,
 *  and must return a stable value or React re-renders forever. */
let scopeCache: boolean | null = null;
const scopeListeners = new Set<() => void>();

function readScope(): boolean {
    try {
        // The URL wins on this load — a link is how the mode gets handed to someone else — and is
        // written through to storage so the reload after it stays in the mode.
        if (new URLSearchParams(window.location.search).get('scope') === SCOPE_PRODUCTION) {
            window.localStorage.setItem(SCOPE_KEY, SCOPE_PRODUCTION);
            return true;
        }
        return window.localStorage.getItem(SCOPE_KEY) === SCOPE_PRODUCTION;
    } catch {
        // Private mode, blocked storage, a prerender. The safe answer is the app's own variant.
        return false;
    }
}

const subscribeScope = (onChange: () => void) => {
    scopeListeners.add(onChange);
    return () => { scopeListeners.delete(onChange); };
};
const getScope = () => (scopeCache ??= readScope());
const getScopeOnServer = () => false;

/** Turn the switch. Exported for the badge, which is both the readout and the control. */
export function setProductionScope(on: boolean): void {
    scopeCache = on;
    try {
        if (on) window.localStorage.setItem(SCOPE_KEY, SCOPE_PRODUCTION);
        else window.localStorage.removeItem(SCOPE_KEY);
    } catch { /* the mode still holds for this page; it just will not survive a reload */ }
    scopeListeners.forEach(fn => fn());
}

/** Whether this session is being read AS PRODUCTION. Always false on a production build. */
export function useProductionScope(): boolean {
    return useSyncExternalStore(subscribeScope, getScope, getScopeOnServer);
}

/**
 * Whether PREVIEW SURFACES render — the one answer every feature gate should read.
 *
 * Folds in all three parts so no call site has to remember them: the deployed variant, the dev
 * server (the experiments must be visible where they are developed), and the scope switch. The
 * `useIsPreviewBuild() || DEV_VARIANT_IS_PREVIEW` that used to be written out at each call site is
 * what this replaces — forgetting the second half gave a dev session the wrong app, and forgetting
 * the third would give the scope switch a surface it does not close.
 */
export function usePreviewSurfaces(): boolean {
    // Both hooks called before either is used: `&&` would short-circuit past the second one, and a
    // hook that is skipped on some renders is the one rule React has no recovery from.
    const tagged = useIsPreviewBuild();
    const asProduction = useProductionScope();
    return (tagged || DEV_VARIANT_IS_PREVIEW) && !asProduction;
}

/**
 * Whether a FEATURE may render here — the registry's answer, for components that gate themselves.
 *
 * A tab is not the only surface a feature owns, and `enabledTabs` cannot speak for a control that
 * lives inside a stable tab: the RF KORR cell gate in the filter panel, the drive-target selector
 * on LAMBDA. Those surfaces have to ask, and this is the one place that knows both halves of the
 * question — which variant this is, and what that variant may show.
 *
 * `DEV_VARIANT_IS_PREVIEW` is folded in for the same reason `page.tsx` folds it in: the meta tag is
 * injected post-build, so `next dev` never carries it, and a dev session with the experiments shut
 * would be a dev session on the wrong app.
 *
 * Prefer this over reading the variant and comparing strings at the call site. The variant is a
 * deployment fact; whether a feature renders is a decision, and the decision lives in the registry.
 */
export function useFeatureEnabled(name: FeatureName): boolean {
    return featureEnabled(name, usePreviewSurfaces());
}

/*
 * `usePreviewTitle` USED TO LIVE HERE, and it is gone with the thing it defended.
 *
 * It fought Next's compiled metadata for the `<title>` element: the branding script rewrote the
 * exported HTML, Next put the production name back during hydration, and a MutationObserver put
 * the preview name back after that. Correct, and measured — but the whole contest only existed
 * because the two builds had different titles.
 *
 * They do not any more (operator, 2026-08-27). The full name is the app's identity and does not
 * change with where it is hosted; only the home-screen label does, and a manifest is not something
 * Next overwrites at runtime. So there is nothing left to enforce.
 */
