import { useEffect, useMemo, useRef, useState } from 'react';
import type { CalVariant } from '@/lib/calibration/types';
import type { SessionBinariesRecord } from '@/lib/db/schema';

/**
 * The bytes behind each comparison variant.
 *
 * `tuned` and `base` are the loaded image, already in memory. `stock` is the
 * CSL 0401 reference the app ships, and `db:<id>` is a stored session's own
 * binary — both are fetched on demand and kept, because a comparison is
 * switched back and forth and re-reading IndexedDB for every toggle would put
 * a stall between the selector and the picture.
 *
 * A session is compared through its TUNED bytes when it has them and its BASE
 * otherwise, and the option label says which — "#3 TUNED" against "#3 BASE" are
 * different claims about a car.
 */

/** The shipped reference image. It is the community-patch partial the mock DME
 *  serves: a real, byte-verified calibration, NOT an OEM-stock image. */
const STOCK_URL = '/mock/csl-0401-community-patch-v1.partial.bin';

export interface VariantBuffers {
    /** The bytes for a variant, or null while they are still being fetched. */
    bufferOf: (variant: CalVariant) => ArrayBuffer | null;
    /** True while any requested variant is still loading. */
    loading: boolean;
    error: string | null;
}

export function useCalVariantBuffers(
    binaryBuffer: ArrayBuffer | null,
    wanted: CalVariant[],
    loadBinaries: (id: string) => Promise<SessionBinariesRecord | null>,
): VariantBuffers {
    const [cache, setCache] = useState<ReadonlyMap<string, ArrayBuffer>>(new Map());
    const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
    const [error, setError] = useState<string | null>(null);
    /** Variants already asked for, so a failed or empty load is not retried on
     *  every render — the selector would spin forever on a session with no
     *  stored binary. */
    const asked = useRef(new Set<string>());

    useEffect(() => {
        // Only 'stock' and 'db:' need fetching; the other two are already in
        // memory. Filtered HERE rather than in a memo, because `asked` is a ref
        // and a ref read during render is a render that depends on when it ran.
        const toLoad = wanted.filter(v => (v === 'stock' || v.startsWith('db:')) && !asked.current.has(v));
        if (!toLoad.length) return;
        let cancelled = false;
        for (const variant of toLoad) {
            asked.current.add(variant);
            setPending(prev => new Set([...prev, variant]));
            const done = (buffer: ArrayBuffer | null) => {
                if (cancelled) return;
                if (buffer) setCache(prev => new Map(prev).set(variant, buffer));
                setPending(prev => {
                    const next = new Set(prev);
                    next.delete(variant);
                    return next;
                });
            };
            const fail = (err: unknown) => {
                if (!cancelled) { setError(String(err)); done(null); }
            };
            if (variant === 'stock') {
                fetch(STOCK_URL)
                    .then(res => (res.ok ? res.arrayBuffer() : Promise.reject(new Error(`stock: HTTP ${res.status}`))))
                    .then(done)
                    .catch(fail);
            } else {
                loadBinaries(variant.slice(3))
                    // TUNED when the session has it — that is what went to the car.
                    .then(rec => done(rec?.tunedBinaryBuffer ?? rec?.baseBinaryBuffer ?? null))
                    .catch(fail);
            }
        }
        return () => { cancelled = true; };
    }, [wanted, loadBinaries]);

    const bufferOf = useMemo(
        () => (variant: CalVariant): ArrayBuffer | null => (
            variant === 'tuned' || variant === 'base' ? binaryBuffer : cache.get(variant) ?? null
        ),
        [binaryBuffer, cache],
    );

    return { bufferOf, loading: pending.size > 0, error };
}
