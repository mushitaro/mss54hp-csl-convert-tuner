#!/usr/bin/env node
/**
 * The icons at the well-known paths: /favicon.ico, /apple-touch-icon.png and
 * /apple-touch-icon-precomposed.png — made from the M ICON `mapping` set already in public/icons.
 *
 *   npm run gen:root-icons
 *
 * ## Why they exist
 *
 * The head names its icons (layout.tsx: `icon` → /icons/mapping-32.png, `apple` →
 * /icons/mapping-256.png), and the manifest names the install icons. But some readers never look at
 * the page: iOS and Safari bookmarks ask for /apple-touch-icon.png and -precomposed by name, link
 * previews and QR scanners ask for /favicon.ico, and so do browsers rebuilding a bookmark or history
 * icon. Those paths were 404 (operator, 2026-10-23: 「Tunerのアイコンが古いまま」), so such a reader drew
 * a letter tile or kept whatever icon it had cached from before the mapping set (2026-09-22).
 * tsunagi-m3 closed the same gap in 79bba9b.
 *
 * ## What it writes
 *
 *     public/favicon.ico                      production, PNG entries 16 / 32 / 48 from mapping-256
 *     public/icons/mapping-dev-favicon.ico    the dev twin, from mapping-dev-256
 *     public/apple-touch-icon.png             production mapping-256, as is (tsunagi-m-release §4)
 *     public/apple-touch-icon-precomposed.png the same bytes
 *
 * Production (GitHub Pages) serves these as they are. staging and WORKS swap them for the dev set in
 * brand-preview.mjs, which copies mapping-dev-favicon.ico and mapping-dev-256.png over the three root
 * paths, and check-branding.mjs reads that back. WORKS also has to let them through its gate without
 * a session (functions/_middleware.ts `publicPaths`): a reader that asks by name sends no cookie.
 *
 * Re-run it after the icons in public/icons change (tsunagi-m3's `m-icons.mjs --word mapping`).
 * `verify:root-icons` fails when the outputs no longer match what this would write.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import sharp from 'sharp';

const PUBLIC = resolve(import.meta.dirname, '..', 'public');

/** An ICO whose entries are PNG images — read by every browser in use, and smaller than BMP ones. */
export function icoFromPngs(entries) {
    const header = Buffer.alloc(6);
    header.writeUInt16LE(0, 0); // reserved
    header.writeUInt16LE(1, 2); // type: icon
    header.writeUInt16LE(entries.length, 4);
    const dir = Buffer.alloc(16 * entries.length);
    let offset = 6 + dir.length;
    entries.forEach(({ size, png }, i) => {
        const at = i * 16;
        dir.writeUInt8(size >= 256 ? 0 : size, at);     // width (0 = 256)
        dir.writeUInt8(size >= 256 ? 0 : size, at + 1); // height
        dir.writeUInt8(0, at + 2);                       // palette colours
        dir.writeUInt8(0, at + 3);                       // reserved
        dir.writeUInt16LE(1, at + 4);                    // colour planes
        dir.writeUInt16LE(32, at + 6);                   // bits per pixel
        dir.writeUInt32LE(png.length, at + 8);
        dir.writeUInt32LE(offset, at + 12);
        offset += png.length;
    });
    return Buffer.concat([header, dir, ...entries.map(e => e.png)]);
}

export const ICO_SIZES = [16, 32, 48];

/** The favicon for one set, downscaled from its 256 px file. */
export async function faviconFor(png256) {
    const entries = [];
    for (const size of ICO_SIZES) {
        entries.push({ size, png: await sharp(png256).resize(size, size).png({ compressionLevel: 9 }).toBuffer() });
    }
    return icoFromPngs(entries);
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('gen-root-icons.mjs')) {
    const prod = readFileSync(resolve(PUBLIC, 'icons', 'mapping-256.png'));
    const dev = readFileSync(resolve(PUBLIC, 'icons', 'mapping-dev-256.png'));
    writeFileSync(resolve(PUBLIC, 'favicon.ico'), await faviconFor(prod));
    writeFileSync(resolve(PUBLIC, 'icons', 'mapping-dev-favicon.ico'), await faviconFor(dev));
    writeFileSync(resolve(PUBLIC, 'apple-touch-icon.png'), prod);
    writeFileSync(resolve(PUBLIC, 'apple-touch-icon-precomposed.png'), prod);
    console.log('wrote public/favicon.ico, public/icons/mapping-dev-favicon.ico, public/apple-touch-icon(.png, -precomposed.png)');
}
