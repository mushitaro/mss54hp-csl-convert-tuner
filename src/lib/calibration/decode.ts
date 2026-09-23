import type { EcuNumericDef } from '@/lib/ecu-items/types';
import type { CalParamDef } from './types';

/**
 * Decoding calibration runs from a loaded buffer.
 *
 * Values ALWAYS come from the buffer the user loaded (or the reference buffer
 * they loaded to compare against) — never from the vendored graph, whose baked
 * numbers were stripped precisely because they decode a different car's image.
 *
 * A non-finite physical value (the reciprocal scalings at raw 0) is a per-cell
 * error, not a refusal: the raw integer is kept, `phys` holds null there, and
 * the rest of the run decodes normally. This is the same policy the notes
 * repo's pipeline uses (xdfmath.py's MathError handling).
 */

export interface DecodedRun {
    raw: number[];
    /** Physical per cell; null where the scaling produced a non-finite value. */
    phys: (number | null)[];
    errorCells: number;
}

export type DecodedAxis =
    | { kind: 'phys'; values: number[] }
    /** Stored axis whose scaling did not compile: raw counts, labelled RAW. */
    | { kind: 'raw'; values: number[] }
    | { kind: 'labels'; labels: string[] };

export interface DecodedParam {
    def: CalParamDef;
    value: DecodedRun | null;
    x: DecodedAxis | null;
    y: DecodedAxis | null;
}

/** One contiguous run, big-endian, same loop shape as BinaryParser.readRun. */
export function decodeRun(
    view: DataView,
    run: EcuNumericDef & { count: number },
): DecodedRun {
    const bytes = run.bits / 8;
    const raw: number[] = [];
    const phys: (number | null)[] = [];
    let errorCells = 0;
    for (let i = 0; i < run.count; i++) {
        const offset = run.address + i * bytes;
        const r = run.bits === 8
            ? (run.signed ? view.getInt8(offset) : view.getUint8(offset))
            : (run.signed ? view.getInt16(offset, false) : view.getUint16(offset, false));
        raw.push(r);
        const p = run.scaling.toPhysical(r);
        if (Number.isFinite(p)) {
            phys.push(p);
        } else {
            phys.push(null);
            errorCells += 1;
        }
    }
    return { raw, phys, errorCells };
}

function decodeAxis(
    view: DataView,
    axis: CalParamDef['xAxis'],
    fits: (address: number, bytes: number) => boolean,
): DecodedAxis | null {
    if (!axis) return null;
    if (axis.source === 'labels') return { kind: 'labels', labels: axis.labels };
    // Same guard as the value run: a truncated buffer must cost this one axis,
    // not a DataView RangeError thrown out of a page-level render.
    if (!fits(axis.def.address, axis.def.n * (axis.def.bits / 8))) return null;
    const run = decodeRun(view, { ...axis.def, count: axis.def.n });
    if (!axis.mathOk) return { kind: 'raw', values: run.raw };
    // An axis cell whose scaling blew up falls back to its raw count — an axis
    // with a hole in it would misplace every value beside it.
    return { kind: 'phys', values: run.phys.map((p, i) => p ?? run.raw[i]) };
}

export function decodeParam(buffer: ArrayBuffer, def: CalParamDef): DecodedParam {
    const view = new DataView(buffer);
    const fits = (address: number, bytes: number) => address >= 0 && address + bytes <= buffer.byteLength;
    const value =
        def.run && fits(def.run.address, def.run.count * (def.run.bits / 8))
            ? decodeRun(view, def.run)
            : null;
    return {
        def,
        value,
        x: decodeAxis(view, def.xAxis, fits),
        y: decodeAxis(view, def.yAxis, fits),
    };
}

/**
 * Per-(buffer, param) memo. A loaded buffer is immutable for the lifetime of a
 * load (useBinaryFile's contract; the reference loader keeps the same rule), so
 * buffer identity is a sound cache key.
 */
export function createDecodeCache(): (buffer: ArrayBuffer, def: CalParamDef) => DecodedParam {
    const cache = new WeakMap<ArrayBuffer, Map<string, DecodedParam>>();
    return (buffer, def) => {
        let perBuffer = cache.get(buffer);
        if (!perBuffer) {
            perBuffer = new Map();
            cache.set(buffer, perBuffer);
        }
        const hit = perBuffer.get(def.id);
        if (hit) return hit;
        const decoded = decodeParam(buffer, def);
        perBuffer.set(def.id, decoded);
        return decoded;
    };
}

/**
 * Which parameters differ between two images, at raw level — no math, so the
 * whole 2,529-parameter sweep is a few tens of KB of byte compares.
 */
export function compareCatalog(
    params: CalParamDef[],
    a: ArrayBuffer,
    b: ArrayBuffer,
): Map<string, { differs: boolean; cellsDiffering: number }> {
    const out = new Map<string, { differs: boolean; cellsDiffering: number }>();
    const va = new DataView(a);
    const vb = new DataView(b);
    for (const def of params) {
        const run = def.run;
        if (!run) continue;
        const bytes = run.bits / 8;
        const end = run.address + run.count * bytes;
        if (end > a.byteLength || end > b.byteLength) continue;
        let cells = 0;
        for (let i = 0; i < run.count; i++) {
            const offset = run.address + i * bytes;
            const ra = bytes === 1 ? va.getUint8(offset) : va.getUint16(offset, false);
            const rb = bytes === 1 ? vb.getUint8(offset) : vb.getUint16(offset, false);
            if (ra !== rb) cells += 1;
        }
        out.set(def.id, { differs: cells > 0, cellsDiffering: cells });
    }
    return out;
}
