import { EcuItemDef, EcuScaling } from './types';

/** Checksum slots, from docs/implementation-notes.md §5. Nothing in the catalog may overlap them:
 *  they are rewritten by applyChecksumCorrection() after every other patch, so an item living
 *  there would read back as something other than what was written. */
const CHECKSUM_SLOTS: Array<[number, number]> = [
    [0x3FFC, 0x4000], // slave
    [0xBFFC, 0xC000], // master
];
const PARTIAL_BIN_LENGTH = 0x10000;

/** The identity scaling. Common enough (rpm, °C, plain counts) to be worth naming once. */
export const IDENTITY: EcuScaling = {
    math: 'X',
    toPhysical: raw => raw,
    toRaw: v => v,
};

/** `X / d`, the most common XDF form. */
export function divideBy(d: number): EcuScaling {
    return { math: `X/${d}`, toPhysical: raw => raw / d, toRaw: v => v * d };
}

/** `X - offset`, used by every temperature that stores °C + 48. */
export function minus(offset: number): EcuScaling {
    return { math: `X-${offset}`, toPhysical: raw => raw - offset, toRaw: v => v + offset };
}

/** `n / X` — non-affine, and the reason EcuScaling carries two functions instead of a factor. */
export function reciprocal(n: number): EcuScaling {
    return {
        math: `${n}/x`,
        toPhysical: raw => (raw === 0 ? 0 : n / raw),
        toRaw: v => (v === 0 ? 0 : n / v),
    };
}

/** Byte span an item occupies, per contiguous run. Used by validateCatalog. */
function runs(def: EcuItemDef): Array<[number, number]> {
    const span = (address: number, count: number, bits: 8 | 16): [number, number] =>
        [address, address + count * (bits / 8)];
    switch (def.kind) {
        case 'constant':
            return [span(def.address, 1, def.bits)];
        case 'curve':
            return [span(def.x.address, def.x.n, def.x.bits),
            span(def.values.address, def.values.n, def.values.bits)];
        case 'map':
            return [span(def.x.address, def.x.n, def.x.bits),
            span(def.y.address, def.y.n, def.y.bits),
            span(def.values.address, def.values.rows * def.values.cols, def.values.bits)];
    }
}

/**
 * Structural checks over a catalog. Run from a test, not at import time: a bad entry should fail a
 * build, not blank the app at runtime.
 *
 * Returns the problems rather than throwing, so a caller can report all of them at once instead of
 * one per run.
 */
export function validateCatalog(defs: EcuItemDef[]): string[] {
    const problems: string[] = [];
    const seen = new Set<string>();

    for (const def of defs) {
        const at = `${def.symbol} @0x${def.address.toString(16).toUpperCase()}`;

        if (seen.has(def.symbol)) problems.push(`${at}: duplicate symbol`);
        seen.add(def.symbol);

        const expectedBank = def.address < 0x8000 ? 'slave' : 'master';
        if (def.bank !== expectedBank) {
            problems.push(`${at}: bank says ${def.bank}, address says ${expectedBank}`);
        }

        if (def.kind === 'curve' && def.values.n !== def.x.n) {
            problems.push(`${at}: ${def.values.n} values against a ${def.x.n}-point axis`);
        }
        if (def.kind === 'map') {
            if (def.values.cols !== def.x.n) {
                problems.push(`${at}: ${def.values.cols} columns against a ${def.x.n}-point x axis`);
            }
            if (def.values.rows !== def.y.n) {
                problems.push(`${at}: ${def.values.rows} rows against a ${def.y.n}-point y axis`);
            }
        }

        for (const [start, end] of runs(def)) {
            if (start < 0 || end > PARTIAL_BIN_LENGTH) {
                problems.push(`${at}: run 0x${start.toString(16)}-0x${end.toString(16)} is outside the partial BIN`);
            }
            for (const [cs, ce] of CHECKSUM_SLOTS) {
                if (start < ce && end > cs) {
                    problems.push(`${at}: run 0x${start.toString(16)}-0x${end.toString(16)} overlaps the checksum slot at 0x${cs.toString(16)}`);
                }
            }
        }
    }
    return problems;
}
