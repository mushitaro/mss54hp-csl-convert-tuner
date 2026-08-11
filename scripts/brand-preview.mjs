/**
 * Renames the exported build so a preview install cannot be mistaken for production.
 *
 * The two deployments are already separate installs — Chrome keys an installed app on its origin,
 * and `rf-korr.mss54hp-tuner-preview.pages.dev` is not `mss54hp-csl-convert-tuner.tsunagi.app`. What
 * they shared was the *label*: two icons on one home screen, both reading CSL TUNER, and no way to
 * tell which one is about to talk to a car.
 *
 * ## Why a post-build patch and not a source edit
 *
 * The name lives in `public/manifest.webmanifest` and in `layout.tsx`'s metadata, both of which are
 * compiled into the same `out/` by the same `next build`. Editing either would rename production
 * too, which is the opposite of what is wanted. So this runs only on the preview path — see
 * `build:preview` — and production's build stays byte-for-byte what it was.
 *
 * ## Why it runs BEFORE gen-sw.mjs
 *
 * gen-sw derives the service worker's cache name from a hash of the built bytes. Patch after it and
 * the hash describes bytes that no longer exist: two deploys differing only in branding would share
 * a cache name, and the second would be served the first's assets. The order in `build:preview` is
 * not cosmetic.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const OUT = 'out';

/** One source of truth for what this build calls itself. */
const NAME = 'MSS54HP CSL PREVIEW /// TUNER';
/** What sits under the icon on a home screen. Android truncates past ~12 characters, and a label
 *  that truncates to the same prefix as production would defeat the whole exercise. */
const SHORT_NAME = 'CSL PREVIEW';

// --- The manifest: the home-screen label and the task switcher ------------------------------
const manifestPath = join(OUT, 'manifest.webmanifest');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
manifest.name = NAME;
manifest.short_name = SHORT_NAME;
manifest.description = `${manifest.description} — PREVIEW BUILD, not the production tool.`;
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

// --- Every exported document: the browser tab, and iOS's home-screen title -------------------
// A walk rather than just index.html: the export has /usb-check as well, and a page that kept the
// production title would be the one place the distinction silently failed.
function htmlFiles(dir) {
    return readdirSync(dir).flatMap(entry => {
        const full = join(dir, entry);
        return statSync(full).isDirectory() ? htmlFiles(full)
            : extname(full) === '.html' ? [full] : [];
    });
}

let patched = 0;
for (const file of htmlFiles(OUT)) {
    const before = readFileSync(file, 'utf8');
    const after = before
        .replace(/<title>([^<]*)<\/title>/g, () => `<title>${NAME}</title>`)
        .replace(/(<meta name="apple-mobile-web-app-title" content=")[^"]*(")/g, `$1${SHORT_NAME}$2`)
        // Read by the header so the app says which build it is once it is already open — the
        // manifest name only shows on the way in. Injected rather than compiled so that the
        // variant has exactly one definition, up there.
        .replace(/<\/head>/, `<meta name="app-variant" content="preview"><\/head>`);
    if (after !== before) { writeFileSync(file, after); patched++; }
}

console.log(`[brand-preview] ${SHORT_NAME}: manifest + ${patched} document(s)`);
