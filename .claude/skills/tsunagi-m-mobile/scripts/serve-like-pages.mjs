#!/usr/bin/env node
/**
 * A static server that behaves like the host, because the convenient ones do not.
 *
 * This exists because of one bug that cost an hour and looked nothing like its cause. `serve` has
 * cleanUrls on by default: `/index.html` 301s to `/index`, which then 200s with the document. A
 * service worker precaching `/index.html` therefore stores a response with `redirected: true` — and
 * a redirected response **may not satisfy a navigation**. Every reload under the worker failed with
 * `net::ERR_FAILED`, in the harness only, and read exactly like a broken worker.
 *
 * Anything that rewrites, redirects, or negotiates encoding can do something like this. Static
 * hosts (GitHub Pages and friends) serve the file at its own path, 200, no redirect. So does this.
 *
 *   node serve-like-pages.mjs ./out 8899
 *
 * Or as a module, which is what update-check.mjs does:
 *
 *   import { serve } from './serve-like-pages.mjs'
 *   const server = await serve('./out', 8899)   // → http.Server, close() when done
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';

const TYPES = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json',
    '.txt': 'text/plain; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
    '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff',
    '.webmanifest': 'application/manifest+json', '.map': 'application/json',
};

export function serve(root, port = 8899) {
    const server = createServer(async (req, res) => {
        const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
        // normalize + strip leading ../ so a crafted path cannot climb out of root.
        let file = join(root, normalize(path).replace(/^(\.\.[/\\])+/, ''));
        try {
            if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
            const body = await readFile(file);
            res.writeHead(200, {
                'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
                'content-length': body.length,
                // No compression and no validators: this is a measuring instrument, and a 304 or a
                // content-encoding is one more thing that can differ from the real host.
                'cache-control': 'no-cache',
            }).end(body);
        } catch {
            res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
        }
    });
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => resolve(server));
    });
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const root = process.argv[2];
    const port = Number(process.argv[3] ?? 8899);
    if (!root) { console.error('usage: serve-like-pages.mjs <dir> [port]'); process.exit(1); }
    await serve(root, port);
    console.log(`serving ${root} on http://127.0.0.1:${port}`);
}
