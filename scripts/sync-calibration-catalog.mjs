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

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const DEFAULT_SOURCE = 'C:/Users/kazuh/CSL_0401_Binary_Disassembly_Notes/app/public/data/graph.json';
const OUT_PATH = resolve('public/data/calibration-graph.json');

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

const json = JSON.stringify(out);
writeFileSync(OUT_PATH, json);

console.log(`source : ${sourcePath}`);
console.log(`output : ${OUT_PATH} (${(json.length / 1024 / 1024).toFixed(2)} MB)`);
console.log(
    `nodes  : param ${counts.param} · func ${counts.func} (stmts ${counts.funcWithStmts}) · ` +
    `ram ${counts.ram} · frpage ${counts.frpage} · unknown ${counts.unknown}`,
);
console.log(`edges  : ${out.edges.length} · categories ${out.categories.length} · frDocs ${out.frDocs.length}`);
