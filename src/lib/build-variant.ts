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
    return featureEnabled(name, useIsPreviewBuild() || DEV_VARIANT_IS_PREVIEW);
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
