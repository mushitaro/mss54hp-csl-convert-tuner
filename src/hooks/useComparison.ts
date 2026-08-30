import { useCallback, useMemo, useState } from 'react';
import { VEMap } from '@/lib/types';
import { CSL_STOCK_MAP_DATA } from '@/config/constants';
import { TuningSession } from '@/lib/db/schema';

export type MapVariant = 'tuned' | 'current' | 'stock' | `db:${string}`;

export function useComparison(newMap: VEMap | null, initialMapData: number[][], sessions: TuningSession[] = []) {
  const [diffSubject, setDiffSubject] = useState<MapVariant>('tuned');
  const [diffReference, setDiffReference] = useState<MapVariant>('current');

  /**
   * `useCallback` because the memo below depends on it.
   *
   * It was a plain function, so it changed identity every render — and it was left OUT of the memo's
   * dependency list to stop the memo recomputing every render. That works by accident and the React
   * Compiler refuses to compile it (it cannot preserve a memo whose deps are a lie), so this
   * component was silently opted out of compilation. Naming the real dependencies here means the
   * memo below can list one thing instead of restating them.
   */
  const getMapData = useCallback((type: MapVariant) => {
    if (type.startsWith('db:')) {
      const id = type.slice(3);
      // A draft that hasn't been tuned yet has no snapshot — nothing to compare against.
      return sessions.find(s => s.id === id)?.veMapSnapshot?.data ?? null;
    }
    switch (type) {
      case 'tuned': return newMap ? newMap.data : null;
      case 'current': return initialMapData; // Original loaded data
      case 'stock': return CSL_STOCK_MAP_DATA;
      default: return null;
    }
  }, [newMap, initialMapData, sessions]);

  const diffMapForVisualization = useMemo(() => {
    const subjectData = getMapData(diffSubject);
    const referenceData = getMapData(diffReference);

    if (!subjectData || !referenceData) return initialMapData.map(row => row.map(() => 0)); // Return zeros if data missing

    const diff = subjectData.map((row, rIdx) =>
      row.map((val, cIdx) => {
        // `?? 0`, not `|| 0`. A reference cell holding a genuine 0 is not a missing one, and the
        // next line already treats zero as "nothing to compare against" — with `||` the two cases
        // were indistinguishable, and a real 0 came through the same path as an absent row.
        const originalVal = referenceData[rIdx]?.[cIdx] ?? 0;
        // Percentage Difference: (Subject - Reference) / Reference * 100
        return Number.isFinite(originalVal) && originalVal !== 0 ? ((val - originalVal) / originalVal) * 100 : 0;
      })
    );
    return diff;
  }, [getMapData, initialMapData, diffSubject, diffReference]);

  const getMapLabel = (type: MapVariant) => {
    if (type.startsWith('db:')) {
      const id = type.slice(3);
      return sessions.find(s => s.id === id)?.label ?? 'SAVED SESSION';
    }
    switch (type) {
      case 'tuned': return 'TUNED MAP';
      case 'current': return 'CURRENT MAP';
      case 'stock': return 'CSL STOCK';
      default: return type;
    }
  };

  // Called after a new calculation runs, to pick sensible default subject/reference
  const applyDefaultsAfterCalculation = () => {
    if (diffSubject === 'current' && diffReference === 'stock') {
      setDiffSubject('tuned');
      setDiffReference('stock');
    } else {
      setDiffSubject('tuned');
      setDiffReference('current');
    }
  };

  return {
    diffSubject,
    setDiffSubject,
    diffReference,
    setDiffReference,
    diffMapForVisualization,
    getMapLabel,
    applyDefaultsAfterCalculation,
  };
}
