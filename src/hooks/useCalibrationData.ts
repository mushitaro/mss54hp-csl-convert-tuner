import { useEffect, useMemo, useState } from 'react';
import { loadCalCatalog, type IndexedCatalog } from '@/lib/calibration/catalog';
import type { CalParamDef, CalVariant } from '@/lib/calibration/types';
import { compareCatalog, createDecodeCache, type DecodedParam, type DecodedRun } from '@/lib/calibration/decode';
import { runDeltaStats, type CalEditSet } from '@/lib/calibration/edits';

/**
 * The data facade the calibration UI consumes: the catalog (lazy singleton,
 * fetched the first time the tab is active), a decode cache spanning every
 * image on screen, the values each comparison variant holds, and the
 * differences between the two the compare bar has selected.
 */

export interface CalDiffEntry {
    def: CalParamDef;
    cellsChanged: number;
    /** Largest |physical delta| across differing cells; null when not computable. */
    maxDelta: number | null;
}

/** Only a full partial BIN is decodable — the catalog's addresses assume all
 *  64 KB. A shorter buffer reads as "no bytes" here rather than as a RangeError
 *  somewhere inside a render. */
function fullPartial(buffer: ArrayBuffer | null): ArrayBuffer | null {
    return buffer && buffer.byteLength === 0x10000 ? buffer : null;
}

export function useCalibrationData(
    active: boolean,
    /** The bytes behind a variant — see useCalVariantBuffers. */
    bufferOf: (variant: CalVariant) => ArrayBuffer | null,
    edits: CalEditSet,
) {
    const [catalog, setCatalog] = useState<IndexedCatalog | null>(null);
    const [catalogError, setCatalogError] = useState<string | null>(null);
    /** Bumped by retryCatalog — the effect's guard would otherwise never re-run
     *  while the tab stays active, pinning one transient fetch failure forever. */
    const [catalogAttempt, setCatalogAttempt] = useState(0);

    useEffect(() => {
        if (!active || catalog) return;
        let cancelled = false;
        loadCalCatalog()
            .then(cat => { if (!cancelled) { setCatalog(cat); setCatalogError(null); } })
            .catch((err: unknown) => { if (!cancelled) setCatalogError(String(err)); });
        return () => { cancelled = true; };
    }, [active, catalog, catalogAttempt]);

    const retryCatalog = () => {
        setCatalogError(null);
        setCatalogAttempt(n => n + 1);
    };

    /** One cache across every image on screen: it is keyed by buffer identity,
     *  and a buffer never changes once loaded. */
    const decodeCached = useMemo(() => createDecodeCache(), []);

    const variantBuffer = useMemo(
        () => (variant: CalVariant): ArrayBuffer | null => fullPartial(bufferOf(variant)),
        [bufferOf],
    );

    /** The decode a variant's values and AXES come from. */
    const paramOf = useMemo(
        () => (variant: CalVariant, def: CalParamDef): DecodedParam | null => {
            const buffer = variantBuffer(variant);
            return buffer ? decodeCached(buffer, def) : null;
        },
        [variantBuffer, decodeCached],
    );

    /** The values a variant shows — `tuned` is the loaded image with this
     *  session's edits overlaid, which is what a WRITE would produce. */
    const runOf = useMemo(
        () => (variant: CalVariant, def: CalParamDef): DecodedRun | null => {
            const base = paramOf(variant, def)?.value ?? null;
            if (variant !== 'tuned') return base;
            const edit = edits.get(def.id);
            if (!base || !edit || !def.run) return base;
            const phys = edit.raw.map(r => {
                const p = def.run!.scaling.toPhysical(r);
                return Number.isFinite(p) ? p : null;
            });
            return { raw: [...edit.raw], phys, errorCells: phys.filter(p => p === null).length };
        },
        [paramOf, edits],
    );

    const variantAvailable = useMemo(
        () => (variant: CalVariant): boolean => !!variantBuffer(variant),
        [variantBuffer],
    );

    return {
        catalog, catalogError, retryCatalog,
        paramOf, runOf, variantAvailable, variantBuffer,
    };
}

export type CalibrationDataState = ReturnType<typeof useCalibrationData>;

/**
 * Every parameter that differs between the two selected variants.
 *
 * Its own hook, not a field of the one above, because the selection lives in
 * the workspace and the workspace is built FROM the catalog — folding this in
 * would make the two hooks each other's input.
 *
 * The candidate set is what keeps it cheap across 2,529 parameters: the raw
 * byte scan between the two IMAGES answers it for everything unedited, and an
 * edited parameter is always a candidate. Comparing `tuned` against `base` —
 * one image against itself — therefore decodes nothing but the edits.
 */
export function useCalibrationDiff(
    data: CalibrationDataState,
    edits: CalEditSet,
    subject: CalVariant,
    reference: CalVariant,
): CalDiffEntry[] | null {
    const { catalog, runOf, variantBuffer } = data;
    const subjectBuffer = variantBuffer(subject);
    const referenceBuffer = variantBuffer(reference);

    const imageScan = useMemo(
        () => (catalog && subjectBuffer && referenceBuffer && subjectBuffer !== referenceBuffer
            ? compareCatalog(catalog.params, subjectBuffer, referenceBuffer)
            : null),
        [catalog, subjectBuffer, referenceBuffer],
    );

    return useMemo(() => {
        if (!catalog || !subjectBuffer || !referenceBuffer) return null;
        if (subject === reference) return [];
        const out: CalDiffEntry[] = [];
        for (const def of catalog.params) {
            if (!def.run) continue;
            if (!edits.has(def.id) && !imageScan?.get(def.id)?.cellsDiffering) continue;
            const a = runOf(subject, def);
            const b = runOf(reference, def);
            if (!a || !b) continue;
            const { cells, maxDelta } = runDeltaStats(a.raw, b.raw, def.run.scaling);
            if (cells === 0) continue;
            out.push({ def, cellsChanged: cells, maxDelta });
        }
        return out.sort((a, b) => a.def.name.localeCompare(b.def.name));
    }, [catalog, subject, reference, subjectBuffer, referenceBuffer, edits, imageScan, runOf]);
}
