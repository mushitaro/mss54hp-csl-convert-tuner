import { useMemo, useState } from 'react';
import { VEMap } from '@/lib/types';
import { CSL_STOCK_MAP_DATA } from '@/config/constants';
import { TuningSession } from '@/lib/db/schema';

export type MapVariant = 'tuned' | 'current' | 'stock' | `db:${string}`;

export function useComparison(newMap: VEMap | null, initialMapData: number[][], sessions: TuningSession[] = []) {
  const [diffSubject, setDiffSubject] = useState<MapVariant>('tuned');
  const [diffReference, setDiffReference] = useState<MapVariant>('current');

  const getMapData = (type: MapVariant) => {
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
  };

  const diffMapForVisualization = useMemo(() => {
    const subjectData = getMapData(diffSubject);
    const referenceData = getMapData(diffReference);

    if (!subjectData || !referenceData) return initialMapData.map(row => row.map(() => 0)); // Return zeros if data missing

    const diff = subjectData.map((row, rIdx) =>
      row.map((val, cIdx) => {
        const originalVal = referenceData[rIdx]?.[cIdx] || 0;
        // Percentage Difference: (Subject - Reference) / Reference * 100
        return originalVal !== 0 ? ((val - originalVal) / originalVal) * 100 : 0;
      })
    );
    return diff;
  }, [newMap, initialMapData, diffSubject, diffReference, sessions]);

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
