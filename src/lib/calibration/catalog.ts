import type { EcuNumericDef } from '@/lib/ecu-items/types';
import { overlapsChecksumSlot, PARTIAL_BIN_LENGTH } from '@/lib/ecu-items/codec';
import type { Graph, GraphNode, Axis } from '@/lib/calibration-graph/types';
import { index, type Indexed } from '@/lib/calibration-graph/graph';
import { buildScaling, rawDomain } from './xdfMath';
import type { CalAxisDef, CalParamDef, EditLock } from './types';
import { managedSpans, SEALED_CAL_SYMBOLS } from './edits';

/**
 * The vendored graph, adapted into the calibration workbench's catalog.
 *
 * Loading is a lazy singleton: the artifact is ~4.5 MB of JSON and the tab is
 * experimental, so nothing is fetched or parsed until the tab first asks.
 * Adaptation problems are collected, never thrown — a bad node loses itself,
 * not the catalog (the same stance as EcuItemList's per-item try/catch).
 */

export interface IndexedCatalog {
    graph: Indexed;
    params: CalParamDef[];
    byId: Map<string, CalParamDef>;
    byName: Map<string, CalParamDef>;
    byCategory: Map<number, CalParamDef[]>;
    problems: string[];
}

// The slots and the half-open overlap rule live in ecu-items/codec — one table for the lock
// computation here AND the byte guard in apply.ts, so the two cannot diverge.

/** Scaling that shows the raw count unchanged, for runs whose math failed. */
function rawIdentity(math: string): EcuNumericDef['scaling'] {
    return { math, toPhysical: r => r, toRaw: v => v };
}

/**
 * The XDF's unit strings, made readable.
 *
 * They arrive as the TunerPro file wrote them and are not fit to print: 406 of
 * the 641 stored axes carry their unit wrapped in literal double quotes, and
 * the degree sign is mis-decoded on 79 of them — `"øC"` where 5 others say
 * `"°C"`, the same unit spelled two ways. Left alone, an axis reads
 * `"Upm" 3000` on screen, quotes and all.
 *
 * `Upm` is Umdrehungen pro Minute: the factory's abbreviation for the thing
 * this app calls rpm everywhere else, so it is said the app's way here too.
 * `-` is the XDF's "no unit", which is not a label at all.
 */
export function cleanUnits(raw: string | undefined): string {
    if (!raw) return '';
    const bare = raw.trim().replace(/^"+|"+$/g, '').trim()
        // ø / Â° — the degree sign as it survives the XDF's own encoding.
        .replace(/ø(?=C|F)/g, '°')
        .replace(/Â°/g, '°');
    if (!bare || bare === '-') return '';
    // A lone C or F is a temperature missing its degree sign — the same unit a
    // third spelling of this file already writes as °C. All three occurrences
    // are exhaust-gas temperature axes (kf_trg, kf_rf_tabg_modell,
    // KF_RF_KORR_DRREL), so one unit is spelled one way here.
    if (bare === 'C' || bare === 'F') return `°${bare}`;
    return bare === 'Upm' ? 'rpm' : bare;
}

function numericDef(
    address: number,
    bits: 8 | 16,
    signed: boolean,
    units: string,
    math: string,
): { def: EcuNumericDef; mathOk: boolean } {
    const scaling = buildScaling(math, rawDomain(bits, signed));
    return {
        def: { address, bits, signed, units: cleanUnits(units), scaling: scaling ?? rawIdentity(math) },
        mathOk: scaling !== null,
    };
}

function axisCount(axis: Axis): number {
    return axis.n ?? axis.cols ?? 0;
}

/** Breakpoint count of an adapted axis, across both variants. */
export function axisN(axis: CalAxisDef): number {
    return axis.source === 'labels' ? axis.n : axis.def.n;
}

function adaptAxis(axis: Axis | undefined, fallbackLabel: string): CalAxisDef | null {
    if (!axis) return null;
    const n = axisCount(axis);
    // The unit IS the name here — the graph carries no other, and a unit is
    // what TunerPro puts on an axis too. The fallback is the axis's own letter,
    // upper-cased to match the ALONG X / Y control rather than reading as a
    // stray variable.
    const label = cleanUnits(axis.units) || fallbackLabel;
    if (axis.addr === undefined) {
        const labels = axis.labels ?? Array.from({ length: n }, (_, i) => String(i));
        return { source: 'labels', labels, n: labels.length, label };
    }
    if (axis.bits !== 8 && axis.bits !== 16) return null;
    const { def, mathOk } = numericDef(
        axis.addr, axis.bits, axis.signed ?? false, axis.units ?? '', axis.math ?? 'X',
    );
    return { source: 'stored', def: { ...def, n }, mathOk, label };
}

function runSpanBytes(run: EcuNumericDef & { count: number }): [number, number] {
    return [run.address, run.address + run.count * (run.bits / 8)];
}

function lockFor(
    node: GraphNode,
    run: (EcuNumericDef & { count: number }) | null,
    runMathOk: boolean,
): EditLock {
    if (node.addr === undefined && !run) return { locked: true, reason: 'no-address' };
    if (!run) return { locked: true, reason: node.bits === 32 ? 'width-32' : 'no-address' };
    if (!runMathOk) {
        const usesK = /\bk\b/i.test((node.kind === 'constant' ? node.math : node.axes?.[node.kind === 'curve' ? 'y' : 'z']?.math) ?? '');
        return { locked: true, reason: usesK ? 'k-linked' : 'math-unsupported' };
    }
    const [start, end] = runSpanBytes(run);
    if (overlapsChecksumSlot(start, end)) return { locked: true, reason: 'checksum-slot' };
    for (const span of managedSpans()) {
        if (start < span.address + span.length && end > span.address) {
            return { locked: true, reason: 'app-managed' };
        }
    }
    if (SEALED_CAL_SYMBOLS.has(node.name)) return { locked: true, reason: 'idle-sealed' };
    return { locked: false };
}

/** Pure adaptation of one param node. Exported for the verify scripts. */
export function adaptParam(node: GraphNode, problems?: string[]): CalParamDef {
    const report = (msg: string) => problems?.push(`${node.name}: ${msg}`);
    const bank = node.bank ?? ((node.addr ?? 0) < 0x8000 ? 'slave' : 'master');
    if (node.addr !== undefined) {
        const expected = node.addr < 0x8000 ? 'slave' : 'master';
        if (bank !== expected) report(`bank says ${bank}, address 0x${node.addr.toString(16)} says ${expected}`);
    }

    let run: (EcuNumericDef & { count: number }) | null = null;
    let runMathOk = false;
    let rows: number | undefined;
    let cols: number | undefined;
    let xAxis: CalAxisDef | null = null;
    let yAxis: CalAxisDef | null = null;

    if (node.kind === 'constant') {
        if (node.addr !== undefined && (node.bits === 8 || node.bits === 16)) {
            const { def, mathOk } = numericDef(
                node.addr, node.bits, node.signed ?? false, node.units ?? '', node.math ?? 'X',
            );
            run = { ...def, count: 1 };
            runMathOk = mathOk;
        }
    } else if (node.kind === 'curve') {
        // Graph curves store breakpoints in axes.x and the value row in axes.y.
        const x = node.axes?.x;
        const y = node.axes?.y;
        xAxis = adaptAxis(x, 'X');
        if (y?.addr !== undefined && (y.bits === 8 || y.bits === 16)) {
            const n = axisCount(y);
            const { def, mathOk } = numericDef(y.addr, y.bits, y.signed ?? false, y.units ?? node.units ?? '', y.math ?? 'X');
            run = { ...def, count: n };
            runMathOk = mathOk;
            if (xAxis && axisN(xAxis) !== n) report(`${n} values against a ${axisN(xAxis)}-point axis`);
        }
    } else if (node.kind === 'map') {
        const z = node.axes?.z;
        xAxis = adaptAxis(node.axes?.x, 'X');
        yAxis = adaptAxis(node.axes?.y, 'Y');
        if (z?.addr !== undefined && (z.bits === 8 || z.bits === 16) && z.rows && z.cols) {
            rows = z.rows;
            cols = z.cols;
            const { def, mathOk } = numericDef(z.addr, z.bits, z.signed ?? false, z.units ?? node.units ?? '', z.math ?? 'X');
            run = { ...def, count: rows * cols };
            runMathOk = mathOk;
            // Geometry authority is the z block, matching the observed data;
            // stored axes must agree with it.
            if (xAxis && axisN(xAxis) !== cols) report(`${cols} columns against a ${axisN(xAxis)}-point x axis`);
            if (yAxis && axisN(yAxis) !== rows) report(`${rows} rows against a ${axisN(yAxis)}-point y axis`);
        }
    }

    if (run) {
        const [start, end] = runSpanBytes(run);
        if (start < 0 || end > PARTIAL_BIN_LENGTH) {
            report(`run 0x${start.toString(16)}-0x${end.toString(16)} is outside the partial BIN`);
            run = null;
        }
    }

    return {
        id: node.id,
        name: node.name,
        kind: node.kind ?? 'constant',
        conf: node.conf ?? 'derived',
        bank,
        cats: node.cats ?? [],
        desc: { en: node.desc?.en ?? '', ja: node.desc?.ja ?? '' },
        run,
        runMathOk,
        rows,
        cols,
        xAxis,
        yAxis,
        lock: lockFor(node, run, runMathOk),
    };
}

export function buildCatalog(raw: Graph): IndexedCatalog {
    const graph = index(raw);
    const problems: string[] = [];
    const params: CalParamDef[] = [];
    const byId = new Map<string, CalParamDef>();
    const byName = new Map<string, CalParamDef>();
    const byCategory = new Map<number, CalParamDef[]>();

    for (const node of graph.params) {
        const def = adaptParam(node, problems);
        params.push(def);
        byId.set(def.id, def);
        byName.set(def.name, def);
        for (const cat of def.cats) {
            const list = byCategory.get(cat) ?? [];
            list.push(def);
            byCategory.set(cat, list);
        }
    }
    params.sort((a, b) => a.name.localeCompare(b.name));
    for (const list of byCategory.values()) list.sort((a, b) => a.name.localeCompare(b.name));

    return { graph, params, byId, byName, byCategory, problems };
}

let catalogPromise: Promise<IndexedCatalog> | null = null;

/** Lazy singleton. First CALIBRATION activation pays the fetch+parse once. */
export function loadCalCatalog(): Promise<IndexedCatalog> {
    if (!catalogPromise) {
        catalogPromise = fetch('/data/calibration-graph.json')
            .then(res => {
                if (!res.ok) throw new Error(`calibration-graph.json: HTTP ${res.status}`);
                return res.json() as Promise<Graph>;
            })
            .then(buildCatalog)
            .catch(err => {
                // A failed fetch must not poison every later open.
                catalogPromise = null;
                throw err;
            });
    }
    return catalogPromise;
}
