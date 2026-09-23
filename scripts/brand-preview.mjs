/**
 * Renames an exported build so a staging or preview install cannot be mistaken for production.
 *
 * The deployments are already separate installs — Chrome keys an installed app on its origin, and
 * nothing under `mss54hp-csl-convert-tuner-preview.pages.dev` is `mss54hp-csl-convert-tuner.tsunagi.app`.
 * What they shared was the *look*: icons on one home screen that all read CSL TUNER and all wore the
 * same mark, and no way to tell which one is about to talk to a car.
 *
 * ## What it changes (tsunagi-m-release §3.3 and §4.2)
 *
 *     name          MSS54HP CSL CONVERT /// TUNER — <LABEL>    install prompt, splash, switcher
 *     short_name    <L> CSL TUNER                              the home screen
 *     description   … — <LABEL> BUILD, not the production tool.
 *     icons         the M ICON dev set (white on black), maskable entries to the dev maskable files
 *     every .html   apple-mobile-web-app-title, app-variant, and the icon/apple-touch-icon links
 *
 *     CSL TUNER    production
 *     S CSL TUNER  main, unmodified — the release candidate
 *     P CSL TUNER  the development branch, behind the owner gate
 *
 * The three separate on the first letter, inside the ~12 characters Android keeps, and none of
 * them drops the product: the short name used to BE the label (`STAGING`, `PREVIEW`), and with
 * several tools on one home screen "the staging of what?" had no answer. `name` now says the
 * environment too, because the install prompt is the other place the choice is made.
 *
 * The icons change because a label is read and an icon is recognised. Production is black on white;
 * both non-production builds carry the same geometry inverted, so a thumb that has learnt the mark
 * still finds the app and still sees that it is not the release. Every reference moves together —
 * manifest `any`, manifest `maskable`, the favicon, the apple-touch-icon — because half a swap puts
 * a white icon and a black one side by side for the same install.
 *
 * `theme_color` and `background_color` are left alone: they are the app's own ground, not the icon's.
 *
 * ## Both arguments are required, and neither has a default
 *
 * The output directory, because this brands MAIN's export too — built in main's own worktree, so
 * that the release candidate can be looked at on a phone without being mistaken for the release.
 * main's source is never touched; this patches the bytes it produced.
 *
 * The label, because there are two non-production builds and they must not share one. A default
 * here would be the value one caller forgot to pass, and the symptom would be two identically
 * labelled icons — the exact failure this script exists to prevent.
 *
 * ## The label decides `app-variant`, and the short name no longer does
 *
 * `app-variant` is the lowercased LABEL: `preview` opens the experiments and the owner SYNC,
 * `staging` does not, because `useIsPreviewBuild` tests for that one word. It used to be derived
 * from the SHORT NAME, which was the label — so adopting `P CSL TUNER` through the old script would
 * have set the variant to `p csl tuner` and closed every experiment and the whole store without a
 * word. The two are separate values now, computed separately.
 *
 * ## Why a post-build patch and not a source edit
 *
 * The name lives in `public/manifest.webmanifest` and in `layout.tsx`'s metadata, both of which are
 * compiled into the same `out/` by the same `next build`. Editing either would rename production
 * too, which is the opposite of what is wanted. So this runs only on the non-production paths, and
 * production's build stays byte-for-byte what it was.
 *
 * ## Why it runs BEFORE gen-sw.mjs
 *
 * gen-sw derives the service worker's cache name from a hash of the built bytes. Patch after it and
 * the hash describes bytes that no longer exist: two deploys differing only in branding would share
 * a cache name, and the second would be served the first's assets. The order is not cosmetic.
 * `scripts/check-branding.mjs` reads the result back afterwards.
 */
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const [OUT, LABEL] = process.argv.slice(2);
if (!OUT || !LABEL) {
    console.error('usage: node scripts/brand-preview.mjs <out-dir> <LABEL>');
    process.exit(1);
}
if (LABEL.length > 12 || !/^[A-Z][A-Z0-9 ]*$/.test(LABEL)) {
    console.error(`LABEL "${LABEL}" must be upper-case and at most 12 characters.`);
    process.exit(1);
}
/** What the app reads back about itself. `preview` is the one value that opens the experiments. */
const VARIANT = LABEL.toLowerCase();

const fail = (message) => {
    console.error(`[brand-preview] ${message}`);
    process.exit(1);
};

/**
 * The dev twin of a production icon: `mapping-192.png` → `mapping-dev-192.png`,
 * `mapping-maskable-512.png` → `mapping-dev-maskable-512.png` — the names
 * tsunagi-m3's `m-icons.mjs` writes. Keyed on the shape of the name, not on the word: changing the
 * word touches the manifest, layout.tsx and the gate's publicPaths (functions/_middleware.ts), never
 * this.
 */
function devIcon(src) {
    const m = /^(\/icons\/[a-z0-9-]+?)(-maskable)?-(\d+)\.png$/.exec(src);
    if (!m || m[1].endsWith('-dev')) return null;
    return `${m[1]}-dev${m[2] ?? ''}-${m[3]}.png`;
}

// --- The manifest ------------------------------------------------------------------------------
const manifestPath = join(OUT, 'manifest.webmanifest');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
if (manifest.name.includes(' — ')) {
    // A second pass would stack a second suffix. `out/` is supposed to be a fresh export here.
    fail(`${manifestPath} is already branded ("${manifest.name}"). Rebuild before branding.`);
}
/** The production short name is the product's; the environment letter goes in front of it. */
const shortName = `${LABEL[0]} ${manifest.short_name}`;
if (shortName.length > 12) {
    // Not a style rule. Past this Android truncates, and a label that truncates is a label that
    // may collide with another build's.
    fail(`short_name "${shortName}" is ${shortName.length} characters; Android keeps ~12.`);
}
manifest.name = `${manifest.name} — ${LABEL}`;
manifest.short_name = shortName;
manifest.description = `${manifest.description} — ${LABEL} BUILD, not the production tool.`;

/** Every production path this rewrite moves, and where to. */
const moved = new Map();
for (const icon of manifest.icons ?? []) {
    const dev = devIcon(icon.src);
    if (!dev) fail(`manifest icon ${icon.src} has no dev twin by name.`);
    moved.set(icon.src, dev);
    icon.src = dev;
}
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

// --- Every exported document -------------------------------------------------------------------
// A walk rather than just index.html: the export has /usb-check as well, and a page that kept the
// production title would be the one place the distinction silently failed.
//
// `<title>` is NOT rewritten. It is the browser tab, which only exists in a tab — and in a tab the
// URL is already on screen saying which build this is.
function files(dir, exts) {
    return readdirSync(dir).flatMap(entry => {
        const full = join(dir, entry);
        return statSync(full).isDirectory() ? files(full, exts)
            : exts.includes(extname(full)) ? [full] : [];
    });
}

// The head's own icon links (favicon, apple-touch-icon) are whatever layout.tsx named; found here
// rather than listed, so a new one cannot be left on the production file.
const ICON_PATH = /\/icons\/[a-z0-9-]+\.png/g;
const documents = files(OUT, ['.html']);
for (const file of documents) {
    for (const [src] of readFileSync(file, 'utf8').matchAll(ICON_PATH)) {
        if (moved.has(src)) continue;
        const dev = devIcon(src);
        if (dev) moved.set(src, dev);
    }
}
for (const [src, dev] of moved) {
    if (!existsSync(join(OUT, dev))) fail(`${dev} (for ${src}) is not in ${OUT}. Is public/icons complete?`);
}

/** Every literal occurrence, in HTML and in the RSC payloads beside it. The payload carries the
 *  same head, and a hydrating page that read the production path back out of it would undo this. */
const swapIcons = (text) => text.replace(ICON_PATH, (src) => moved.get(src) ?? src);

let patched = 0;
for (const file of documents) {
    const before = readFileSync(file, 'utf8');
    const after = swapIcons(before)
        .replace(/(<meta name="apple-mobile-web-app-title" content=")[^"]*(")/g, `$1${shortName}$2`)
        // Read by the header so the app says which build it is once it is already open — the
        // manifest name only shows on the way in. Injected rather than compiled so that the
        // variant has exactly one definition, up there.
        // Stripped before it is written, for the reason build-id.mjs records: `out/` is not
        // guaranteed to be a fresh export, and an insert-only stamp leaves two tags on a document
        // that already had one — with the stale one first, where every reader looks.
        .replace(/<meta name="app-variant" content="[^"]*">/g, '')
        .replace(/<\/head>/, `<meta name="app-variant" content="${VARIANT}"><\/head>`);
    if (after !== before) { writeFileSync(file, after); patched++; }
}
let payloads = 0;
for (const file of files(OUT, ['.txt'])) {
    const before = readFileSync(file, 'utf8');
    const after = swapIcons(before);
    if (after !== before) { writeFileSync(file, after); payloads++; }
}

console.log(`[brand-preview] ${OUT}: "${manifest.name}" / ${shortName} / variant ${VARIANT}, `
    + `${moved.size} icon(s) to the dev set, manifest + ${patched} document(s) + ${payloads} payload(s)`);
