// Vendors the calibration graph from the disassembly-notes repository into this app.
//
// The source is graph.json — the joined XDF + Ghidra + Funktionsrahmen graph the notes
// repo builds (8,289 nodes / 27,620 edges, ~5.1 MB). The CALIBRATION tab needs its
// structure (params, functions with recovered formulas, edges, RAM signals, name index,
// glossary) but must never display its baked values: those were decoded from the TERRA
// image, not the binary the user loads. So this script is strip-only — it removes the
// baked numbers and nothing else, keeping the Graph shape intact so the ported reader
// (src/lib/calibration-graph/graph.ts) consumes the artifact unchanged:
//
//   param nodes : drop `value`, `raw`; drop `values` from every axis
//   frpage nodes: drop `excerpt` (600-char page previews; the tab links out instead)
//
// Everything else passes through verbatim. Determinism comes from the source itself —
// no re-ordering, no re-formatting beyond JSON.stringify — so a re-sync diffs cleanly.
//
// Usage: node scripts/sync-calibration-catalog.mjs [--from <path-to-graph.json>]

import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const DEFAULT_SOURCE = 'C:/Users/kazuh/CSL_0401_Binary_Disassembly_Notes/app/public/data/graph.json';
const OUT_PATH = resolve('public/data/calibration-graph.json');
const DECOMP_OUT = resolve('public/data/calibration-decomp.json');

const fromIdx = process.argv.indexOf('--from');
const sourcePath = fromIdx >= 0 ? process.argv[fromIdx + 1] : DEFAULT_SOURCE;

const graph = JSON.parse(readFileSync(sourcePath, 'utf8'));

const counts = { param: 0, func: 0, funcWithStmts: 0, ram: 0, frpage: 0, unknown: 0 };

const nodes = graph.nodes.map((node) => {
    counts[node.t] = (counts[node.t] ?? 0) + 1;
    if (node.t === 'param') {
        const rest = { ...node };
        delete rest.value;
        delete rest.raw;
        if (rest.axes) {
            const stripped = {};
            for (const [key, axis] of Object.entries(rest.axes)) {
                const bare = { ...axis };
                delete bare.values;
                stripped[key] = bare;
            }
            rest.axes = stripped;
        }
        return rest;
    }
    if (node.t === 'frpage') {
        const rest = { ...node };
        delete rest.excerpt;
        return rest;
    }
    if (node.t === 'func' && node.stmts?.length) counts.funcWithStmts += 1;
    return node;
});

const out = {
    meta: graph.meta,
    categories: graph.categories,
    frDocs: graph.frDocs,
    nodes,
    edges: graph.edges,
    nameIndex: graph.nameIndex,
    glossary: graph.glossary,
};

/**
 * The decompiler's own text, for the 644 functions that have one.
 *
 * ## Why this is a second file and not a field on the node
 *
 * It is 891 KB beside a 4.75 MB catalog, and the catalog is on the critical
 * path: every CALIBRATION open pays for it before anything can be drawn. The
 * text is needed only once a reader is inside one function, which is a click
 * later and often never. So it ships as its own artifact, fetched when the
 * first function that needs it is opened, and the tab opens no slower than it
 * did before.
 *
 * ## Why one file and not 644
 *
 * Median 805 bytes, p90 2.8 KB — 644 requests for that is 644 round trips to
 * read a few hundred kilobytes, and 644 entries in the service worker's
 * precache list, which is the thing a car on a garage's WiFi installs. One
 * fetch of 169 KB gzipped, once, makes every function after the first
 * instant and offline.
 *
 * The keys are node ids, so the mapping is checked rather than recomputed:
 * `<bank>/<addr>.txt` becomes `f:<bank>:<addr>` and must land on a node that
 * says `hasCode`. Both directions are asserted below, because a corpus that
 * silently half-matched would show the wrong function's body under a name.
 */
const decompDir = resolve(dirname(sourcePath), 'decomp');
const texts = {};
let decompBytes = 0;
for (const bank of ['master', 'slave']) {
    for (const file of readdirSync(resolve(decompDir, bank))) {
        if (!file.endsWith('.txt')) continue;
        const body = readFileSync(resolve(decompDir, bank, file), 'utf8');
        decompBytes += body.length;
        texts[`f:${bank}:${file.slice(0, -4)}`] = body;
    }
}

const claimsCode = new Set(nodes.filter((n) => n.t === 'func' && n.hasCode).map((n) => n.id));
const orphans = Object.keys(texts).filter((id) => !claimsCode.has(id));
const missing = [...claimsCode].filter((id) => !texts[id]);
if (orphans.length || missing.length) {
    console.error(
        `refusing to write: decomp corpus does not match the graph — ` +
        `${orphans.length} texts with no node (${orphans.slice(0, 3).join(', ')}), ` +
        `${missing.length} nodes claiming hasCode with no text (${missing.slice(0, 3).join(', ')})`,
    );
    process.exit(1);
}

// A truncated or partial source must never silently shrink the shipped catalog.
if (existsSync(OUT_PATH)) {
    const prev = JSON.parse(readFileSync(OUT_PATH, 'utf8'));
    const prevParams = prev.nodes.filter((n) => n.t === 'param').length;
    const prevEdges = prev.edges.length;
    if (counts.param < prevParams || out.edges.length < prevEdges) {
        console.error(
            `refusing to write: source has ${counts.param} params / ${out.edges.length} edges, ` +
            `existing artifact has ${prevParams} / ${prevEdges}`,
        );
        process.exit(1);
    }
}

// The same guard for the corpus. It is a separate check because it is a
// separate artifact: a re-vendor that lost half the texts would leave the
// catalog untouched and pass the test above, and the only visible symptom
// would be functions quietly going back to saying nothing.
if (existsSync(DECOMP_OUT)) {
    const prev = JSON.parse(readFileSync(DECOMP_OUT, 'utf8'));
    const prevN = Object.keys(prev.texts).length;
    if (Object.keys(texts).length < prevN) {
        console.error(
            `refusing to write: decomp source has ${Object.keys(texts).length} texts, ` +
            `existing artifact has ${prevN}`,
        );
        process.exit(1);
    }
}

const json = JSON.stringify(out);
writeFileSync(OUT_PATH, json);

const decompJson = JSON.stringify({ meta: graph.meta, texts });
writeFileSync(DECOMP_OUT, decompJson);

console.log(`source : ${sourcePath}`);
console.log(`output : ${OUT_PATH} (${(json.length / 1024 / 1024).toFixed(2)} MB)`);
console.log(
    `nodes  : param ${counts.param} · func ${counts.func} (stmts ${counts.funcWithStmts}) · ` +
    `ram ${counts.ram} · frpage ${counts.frpage} · unknown ${counts.unknown}`,
);
console.log(`edges  : ${out.edges.length} · categories ${out.categories.length} · frDocs ${out.frDocs.length}`);
console.log(
    `decomp : ${DECOMP_OUT} (${(decompJson.length / 1024 / 1024).toFixed(2)} MB) · ` +
    `${Object.keys(texts).length} functions · ${(decompBytes / 1024).toFixed(0)} KB of C`,
);
